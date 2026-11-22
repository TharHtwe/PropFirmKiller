"""Backtest runner for the level-retrace strategy.

    python run.py --all                 every combination (9,216 on US100, 6,144 otherwise)
    python run.py --all --workers 4     split those combinations across 4 processes
    python run.py --ids <id,id,...>     just those combinations
    python run.py --audit <id>          the audit-day touch table for one run
    python run.py --export-trades <id>  the trade list of one run as CSV
    python run.py --file <name.csv>     read another CSV from ../data
                                        (default: the US100 file)

Every CSV file keeps its own results under results/<csv-stem>/ so switching
instruments never recomputes or overwrites anything.  The runner is resumable:
summary.json is written as runs finish, and a second --all skips the runs
already in it.  --force recomputes them.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import queue as queue_mod
import sys
import time
import traceback
from datetime import datetime, timezone
from multiprocessing import get_context
from pathlib import Path

import numpy as np

import config
import data
import events
import levels
import metrics

SESSION_CODE = {"london": 0, "ny": 1, "rth": 2, "all": 3}
ENTRY_CODE = {"touch": 0, "confirm": 1}
TYPE_CODE = {"rev": -1, "cont": 1}

# The instrument the current process works on.  One process only ever reads one
# CSV file: SCALE is 10^decimals integer steps per price unit (100 for US100,
# 100,000 for GBPUSD) and SPREAD_C is the 1.3 point spread in those steps.
CSV_FILE = config.DEFAULT_CSV
STEM = CSV_FILE.stem
INST = config.instrument_for(STEM)
SCALE = 10 ** INST["decimals"]
STEPS_PER_POINT = INST["point"] * SCALE
SPREAD_C = int(round(config.SPREAD * INST["point"] * SCALE))


def pts_c(points):
    """Strategy points (the SL/TP numbers in a run id) as integer price steps."""
    return int(round(float(points) * STEPS_PER_POINT))

REASON = {
    "taken": "taken",
    "session": "outside the trading session",
    "open_min": "the first minute of the cash open",
    "look": "level older than the lookback",
    "type": "crossing is the other trade type",
    "flat": "close finished exactly on the level",
    "level": "level already traded today",
    "open": "a trade is still open",
    "one": "one trade a day already taken",
    "cap": "day target already reached",
}


def use_file(name):
    """Point the runner at one CSV from the data dir and adopt its instrument."""
    global CSV_FILE, STEM, INST, SCALE, SPREAD_C, STEPS_PER_POINT
    path = Path(name)
    if not path.is_absolute():
        path = config.DATA_DIR / name
    if not path.exists():
        raise SystemExit(f"missing minute file: {path}")
    CSV_FILE = path
    STEM = path.stem
    INST = config.instrument_for(STEM)
    SCALE = 10 ** INST["decimals"]
    STEPS_PER_POINT = INST["point"] * SCALE
    SPREAD_C = int(round(config.SPREAD * INST["point"] * SCALE))
    events.set_scale(SCALE, INST["point"])
    levels.set_scale(SCALE, INST["decimals"])
    return path


def results_paths():
    base = config.results_dir(STEM)
    return {
        "dir": base,
        "summary": base / "summary.json",
        "progress": base / "progress.json",
        "queue": base / "queue.txt",
        "favourites": base / "favourites.json",
        "audit": base / "audit",
        "trades": base / "trades",
    }


def _atomic_json(path, obj):
    # Windows can refuse os.replace while a scanner or reader briefly holds the
    # target open (WinError 5/32), so retry instead of aborting a long sweep.
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, separators=(",", ":"))
    for attempt in range(40):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            if attempt == 39:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
                raise
            time.sleep(0.05)


def data_sig():
    st = os.stat(CSV_FILE)
    return {
        "file": CSV_FILE.name,
        "stem": STEM,
        "size": int(st.st_size),
        "mtime": int(st.st_mtime),
        "version": config.CACHE_VERSION,
        "rules": config.RULES_VERSION,
    }


def rule_affected(run):
    """Whether a stored run's result depends on a rule that just changed.

    Rules live in the per-run filter, so the events stay valid and only the runs
    that read the changed rule are recomputed.
    """
    cfg = run.get("cfg", {})
    return cfg.get("session") == "rth" and INST["rth_skip_open"]


def event_path(lvl, sig):
    name = f"events_{sig['stem']}_{lvl}_{sig['size']}_{sig['mtime']}_{sig['version']}.npz"
    return config.CACHE_DIR / name


def drop_stale_cache(sig):
    # Only this file's event caches are dropped, the other instrument's stay.
    keep = {event_path(lvl, sig).name for lvl in config.LEVEL_SESSIONS}
    prefix = f"events_{sig['stem']}_"
    for name in os.listdir(config.CACHE_DIR):
        if name.startswith(prefix) and name.endswith(".npz") and name not in keep:
            try:
                os.remove(config.CACHE_DIR / name)
            except OSError:
                pass


class Engine:
    """Bars, clocks and per-level-session events for one data file."""

    def __init__(self, bars, clocks, sig, progress=None):
        self.bars = bars
        self.clocks = clocks
        self.sig = sig
        self.progress = progress
        self.oc, self.oh, self.ol, self.occ = events.bar_cents(bars)
        self.blo, self.bhi = events.prepare_blocks(self.oh, self.ol)
        self.bar_day = clocks["ny_day"]
        self.hour = ((bars["ts"] // 3600) % 24).astype(np.int8)
        self.weekday = ((self.bar_day + 3) % 7).astype(np.int8)
        # The 09:30 New York bar is the first minute of the cash open. A run
        # applies it only when its cash-open option is "skip" and its session
        # is New York RTH. The events stay shared.
        self.open_bars = clocks["in_rth"] & (clocks["ny_min"] == config.NY_RTH[1])
        # 08:30 and 08:31 New York. ny_min is already America/New_York local
        # time, so the same two minutes apply in EST and EDT.
        ny_lo, ny_hi = config.NY_OPEN
        self.ny_open_bars = (
            (clocks["ny_min"] >= ny_lo) & (clocks["ny_min"] < ny_hi) & (clocks["ny_wd"] < 5)
        )
        self._lvl = None
        self._ev = None
        self._side = {}
        self._masks = {}
        self._picks = {}

    def events(self, lvl):
        if self._lvl == lvl:
            return self._ev
        self._lvl = None
        self._ev = None
        self._side = {}
        self._masks = {}
        self._picks = {}
        path = event_path(lvl, self.sig)
        if path.exists():
            with np.load(path) as z:
                ev = {k: z[k] for k in z.files}
            if self.progress:
                self.progress(lvl, 0, 0, cached=True)
        else:
            if self.progress:
                self.progress(lvl, 0, 1, cached=False)
            records = levels.build_records(self.bars, self.clocks, lvl)
            cb = None
            if self.progress:
                cb = lambda done, total: self.progress(lvl, done, total, cached=False)
            ev = events.generate(self.bars, self.clocks, records, lvl, cb)
            np.savez(path, **ev)
            del records
        self._lvl = lvl
        self._ev = ev
        return ev

    def release(self):
        self._lvl = None
        self._ev = None
        self._side = {}
        self._masks = {}
        self._picks = {}

    def sides(self, entry):
        ev = self._ev
        if entry not in self._side:
            if entry == 0:
                side = np.where(ev["variant"] == 1, 1, -1).astype(np.int8)
            else:
                close = self.occ[ev["bar"]]
                side = np.where(close > ev["cents"], 1, -1).astype(np.int8)
            self._side[entry] = side
        return self._side[entry]

    def resolve(self, entry, sl, tp):
        ev = self._ev
        n = ev["bar"].size
        out = (
            np.empty(n, np.float64), np.empty(n, np.int8), np.empty(n, np.int32),
            np.empty(n, np.int32), np.empty(n, np.float64), np.empty(n, np.float64),
        )
        events.resolve(
            entry, ev["bar"], ev["seg"], ev["variant"], ev["cents"], ev["fill"], self.occ,
            self.oc, self.oh, self.ol, self.occ, SPREAD_C, pts_c(sl), pts_c(tp),
            self.blo, self.bhi, *out,
        )
        return out

    def mask(self, entry, typ, sess, look, open_mode, ny_open="keep"):
        key = (entry, typ, sess, look, open_mode, ny_open)
        if key in self._masks:
            return self._masks[key]
        ev = self._ev
        days = config.LOOK_DAYS[look]
        look_days = -1 if days is None else int(days)
        code = SESSION_CODE[sess]
        skip = None
        if code == 2 and open_mode == "skip":
            skip = self.open_bars
        elif code == 1 and ny_open == "skip":
            skip = self.ny_open_bars
        sel = events.base_mask(
            ev["bar"], ev["dir"], ev["variant"], ev["cents"], ev["lday"], self.occ, self.oc, ev["day"],
            self.clocks["in_lon"], self.clocks["in_ny"], self.clocks["in_rth"],
            ENTRY_CODE[entry], TYPE_CODE[typ], look_days, code,
            skip,
        ).astype(np.int32)
        self._masks[key] = sel
        return sel

    def picks(self, entry, typ, sess, look, how, open_mode, ny_open="keep"):
        key = (entry, typ, sess, look, how, open_mode, ny_open)
        if key in self._picks:
            return self._picks[key]
        ev = self._ev
        sel = self.mask(entry, typ, sess, look, open_mode, ny_open)
        out = np.empty(sel.size, np.int32)
        if how == "every":
            n = events.pick_first_per_level(sel, ev["cents"], ev["day"], out)
        else:
            n = events.pick_first_per_day(sel, ev["day"], out)
        idx = out[:n].astype(np.int64)
        self._picks[key] = idx
        return idx


def empty_trades():
    return {k: np.empty(0, dtype=d) for k, d in (
        ("idx", np.int64), ("pnl", np.float64), ("kind", np.int8), ("ebar", np.int32),
        ("esub", np.int32), ("mae", np.float64), ("mfe", np.float64),
    )}


def open_mode(cfg):
    """skip drops the 09:30 bar; keep includes it.

    An id with no suffix keeps the historical rule: US100 New York RTH skipped
    that bar, and every other run included it.
    """
    mode = cfg.get("open")
    if mode in ("skip", "keep"):
        return mode
    if cfg.get("session") == "rth" and INST["rth_skip_open"]:
        return "skip"
    return "keep"


def ny_open_mode(cfg):
    """skip drops 08:30 and 08:31 New York; keep includes them.

    Only a New York-only id ending in ``_skip`` drops the window. Every stored
    id without that suffix already included it.
    """
    mode = cfg.get("nyopen")
    if mode in ("skip", "keep"):
        return mode
    return "keep"


def ensure_open(cfg):
    cfg["open"] = open_mode(cfg)
    cfg["nyopen"] = ny_open_mode(cfg)
    return cfg


def fill_cents(entry, side, close_c, touch_fill):
    """Price the trade is measured from, in price-steps.

    Touch keeps the trigger bid (the level, or the open of a gap). A 1-minute
    close uses that bar's close. A buy is one spread above the bid, and the
    stop and target are distances from this price.
    """
    base = int(touch_fill if int(entry) == 0 else close_c)
    return base + SPREAD_C if int(side) > 0 else base


def fill_array(entry, side, close_c, touch_fill):
    """Same reference as ``fill_cents``, for a whole trade list."""
    base = touch_fill if int(entry) == 0 else close_c
    base = np.asarray(base, dtype=np.int64)
    return np.where(np.asarray(side) > 0, base + SPREAD_C, base)


def trades_for(eng, ev, ex, cfg):
    tpd = cfg["tpd"]
    mode = open_mode(cfg)
    ny = ny_open_mode(cfg)
    if tpd in ("every", "one"):
        idx = eng.picks(cfg["entry"], cfg["typ"], cfg["session"], cfg["look"], tpd, mode, ny)
        return {
            "idx": idx,
            "pnl": ex[0][idx], "kind": ex[1][idx], "ebar": ex[2][idx],
            "esub": ex[3][idx], "mae": ex[4][idx], "mfe": ex[5][idx],
        }
    sel = eng.mask(cfg["entry"], cfg["typ"], cfg["session"], cfg["look"], mode, ny).astype(np.int64)
    n = sel.size
    outs = (
        np.empty(n, np.int64), np.empty(n, np.float64), np.empty(n, np.int8),
        np.empty(n, np.int32), np.empty(n, np.int32), np.empty(n, np.float64),
        np.empty(n, np.float64),
    )
    until = tpd == "until"
    count = events.simulate_serial(
        sel, ev["bar"][sel], ev["rank"][sel], ev["cents"][sel], ev["day"][sel], eng.bar_day,
        ex[2][sel], ex[3][sel], ex[0][sel], ex[1][sel], ex[4][sel], ex[5][sel],
        until, pts_c(cfg["tp"]), *outs,
    )
    return {
        "idx": outs[0][:count], "pnl": outs[1][:count], "kind": outs[2][:count],
        "ebar": outs[3][:count], "esub": outs[4][:count], "mae": outs[5][:count],
        "mfe": outs[6][:count],
    }


def run_metrics(eng, trades, cfg):
    ev = eng._ev
    idx = trades["idx"]
    if idx.size == 0:
        return metrics.compute(
            np.empty(0, np.float64), np.empty(0, np.int8), np.empty(0, np.int32),
            np.empty(0, np.int32), np.empty(0, np.float64), np.empty(0, np.float64),
            np.empty(0, np.int8), np.empty(0, np.int32), np.empty(0, np.int32),
            np.empty(0, np.int8), np.empty(0, np.int8), int(cfg["sl"]), STEPS_PER_POINT,
        )
    side = eng.sides(ENTRY_CODE[cfg["entry"]])[idx]
    return metrics.compute(
        trades["pnl"], trades["kind"], trades["ebar"], trades["esub"], trades["mae"],
        trades["mfe"], side, ev["day"][idx], ev["bar"][idx], eng.hour[ev["bar"][idx]],
        eng.weekday[ev["bar"][idx]], int(cfg["sl"]), STEPS_PER_POINT,
    )


def group_key(cfg):
    return (cfg["lvl"], cfg["entry"], cfg["sl"], cfg["tp"])


def ordered_groups(cfgs):
    groups = {}
    order = []
    for cfg in cfgs:
        key = group_key(cfg)
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(cfg)
    return [(key, groups[key]) for key in order]


def clamp_workers(workers):
    """1 keeps the original one-process loop. 4 is the machine's processor count."""
    try:
        n = int(workers)
    except (TypeError, ValueError):
        return 1
    return max(1, min(4, n))


def assign_groups(groups, workers):
    """Split whole level/entry/stop/target groups across processes.

    A group shares one exit walk, so it stays on one process. Returns None when
    the job should stay in this process.
    """
    n = clamp_workers(workers)
    if n == 1 or len(groups) < 2:
        return None
    n = min(n, len(groups))
    buckets = [[] for _ in range(n)]
    for i, group in enumerate(groups):
        buckets[i % n].append(group)
    return buckets


def prepare_levels(levels):
    """Build any missing level cache, and compile the exit walk, before workers start.

    Workers then only read the cache. Two of them writing the same cache file
    would corrupt it.
    """
    uniq = []
    for lvl in levels:
        if lvl not in uniq:
            uniq.append(lvl)
    if not uniq:
        return
    bars, clocks = data.load(CSV_FILE)
    eng = Engine(bars, clocks, data_sig())
    for lvl in uniq:
        eng.events(lvl)
    eng.resolve(0, 50, 50)
    eng.release()
    del eng, bars, clocks


def collect_workers(procs, result_queue, on_batch):
    """Read worker batches until every process has finished. The caller writes files."""
    pending = len(procs)
    error = None
    try:
        while pending:
            try:
                kind, payload = result_queue.get(timeout=2)
            except queue_mod.Empty:
                crashed = [p for p in procs if (not p.is_alive()) and p.exitcode not in (None, 0)]
                if crashed:
                    error = RuntimeError(f"a worker stopped with code {crashed[0].exitcode}")
                    break
                continue
            if kind == "batch":
                on_batch(payload)
            elif kind == "done":
                pending -= 1
            elif kind == "error":
                error = RuntimeError(payload)
                break
    finally:
        for proc in procs:
            if proc.is_alive():
                proc.terminate()
        for proc in procs:
            proc.join(timeout=15)
    if error:
        raise error


def score_groups(eng, groups, emit):
    """Score every run in these groups and hand each stored row to ``emit``."""
    for (lvl, entry, sl, tp), group in groups:
        ev = eng.events(lvl)
        ex = eng.resolve(ENTRY_CODE[entry], sl, tp)
        for cfg in group:
            trades = trades_for(eng, ev, ex, cfg)
            metrics_row = run_metrics(eng, trades, cfg)
            ensure_open(cfg)
            emit({
                "id": cfg["id"],
                "cfg": {k: cfg[k] for k in ("sl", "tp", "session", "open", "nyopen", "lvl", "typ", "entry", "look", "tpd")},
                "metrics": metrics_row,
            })
        del ex


def _strategy_worker(csv_name, groups, result_queue):
    batch = []

    def flush():
        if batch:
            result_queue.put(("batch", batch[:]))
            batch.clear()

    try:
        use_file(csv_name)
        bars, clocks = data.load(CSV_FILE)
        eng = Engine(bars, clocks, data_sig())

        def emit(row):
            batch.append(row)
            if len(batch) >= 10:
                flush()

        score_groups(eng, groups, emit)
        flush()
        result_queue.put(("done", None))
    except Exception:
        flush()
        result_queue.put(("error", traceback.format_exc()))


def execute(cfgs, force=False, log=print, workers=1):
    paths = results_paths()
    config.ensure_dirs(STEM)
    sig = data_sig()
    previous = {}
    if paths["summary"].exists():
        try:
            with open(paths["summary"], encoding="utf-8") as fh:
                old = json.load(fh)
        except (OSError, ValueError):
            old = {}
        if old.get("meta", {}).get("sig", {}).get("file") == sig["file"] \
                and old.get("meta", {}).get("sig", {}).get("mtime") == sig["mtime"]:
            previous = {r["id"]: r for r in old.get("runs", [])}
            for stored in previous.values():
                ensure_open(stored.setdefault("cfg", {}))
            if old.get("meta", {}).get("sig", {}).get("rules") != sig["rules"]:
                stale = [rid for rid, r in previous.items() if rule_affected(r)]
                for rid in stale:
                    del previous[rid]
                if stale:
                    log(f"rules {old['meta']['sig'].get('rules')} -> {sig['rules']}: "
                        f"{len(stale)} runs will be recomputed")
        else:
            log("data file changed, previous results were discarded")
    if not force:
        cfgs = [c for c in cfgs if c["id"] not in previous]
    if not cfgs:
        log("nothing to do, every requested run is already in summary.json")
        return previous

    drop_stale_cache(sig)
    started = time.time()
    total = len(cfgs)
    _atomic_json(paths["progress"], {"running": True, "done": 0, "total": total,
                                     "elapsed": 0.0, "eta_seconds": None,
                                     "updated": int(time.time())})
    level_order = {name: i for i, name in enumerate(config.LEVEL_SESSIONS)}
    cfgs = sorted(cfgs, key=lambda c: (level_order[c["lvl"]], ENTRY_CODE[c["entry"]],
                                       c["sl"], c["tp"], c["session"], c["typ"],
                                       c["look"], c["tpd"]))
    groups = ordered_groups(cfgs)
    buckets = assign_groups(groups, workers)
    n_workers = 1 if buckets is None else len(buckets)
    log(f"{total} runs, {n_workers} processor{'s' if n_workers != 1 else ''}, levels are cached")

    def progress(lvl, done_days, tot, cached=False):
        if cached:
            log(f"levels {lvl}: using cached events")
        elif tot and (done_days == 0 or done_days % 400 == 0 or done_days == tot):
            log(f"levels {lvl}: {done_days}/{tot} days")

    # The default audit day is the last one with New York bars: a day that only
    # reached the London session has no session trades to audit, and every
    # session filter the report offers is a subset of the New York window.
    bars, clocks = data.load(CSV_FILE)
    in_session = clocks["in_ny"] if clocks["in_ny"].any() else clocks["in_all"]
    audit_day = str(np.datetime64(int(np.unique(clocks["ny_day"][in_session])[-1]), "D"))
    log(f"data: {len(bars['ts'])} bars, {sig['file']}")
    del bars, clocks

    done = 0
    last_write = time.time()

    def accept(row):
        nonlocal done, last_write
        previous[row["id"]] = row
        done += 1
        if done % 10 == 0 or done == total or total <= 25:
            elapsed = time.time() - started
            rate = elapsed / done
            _atomic_json(paths["progress"], {
                "running": True, "done": done, "total": total,
                "run": row["id"], "elapsed": round(elapsed, 1),
                "seconds_per_run": round(rate, 3),
                "eta_seconds": round(rate * (total - done), 1),
                "workers": n_workers,
                "updated": int(time.time()),
            })
            if done % 100 == 0 or done == total:
                log(f"{done}/{total} runs, {rate:.2f}s each, eta {rate * (total - done) / 60:.1f} min")
        if time.time() - last_write > 60:
            write_summary(previous, sig, paths, audit_day)
            last_write = time.time()

    try:
        if buckets is None:
            bars, clocks = data.load(CSV_FILE)
            eng = Engine(bars, clocks, sig, progress)
            score_groups(eng, groups, accept)
            eng.release()
        else:
            prepare_levels([key[0] for key, _group in groups])
            ctx = get_context("spawn")
            result_queue = ctx.Queue()
            procs = [
                ctx.Process(target=_strategy_worker, args=(CSV_FILE.name, bucket, result_queue))
                for bucket in buckets
            ]
            for proc in procs:
                proc.start()
            collect_workers(procs, result_queue, lambda batch: [accept(row) for row in batch])
    except KeyboardInterrupt:
        log("interrupted, saving what is finished")
    finally:
        write_summary(previous, sig, paths, audit_day)
        _atomic_json(paths["progress"], {
            "running": False, "done": done, "total": total,
            "elapsed": round(time.time() - started, 1), "workers": n_workers,
            "updated": int(time.time()),
        })
    return previous


def write_summary(runs, sig, paths=None, audit_day=None):
    paths = paths or results_paths()
    items = sorted(runs.values(), key=lambda r: r["id"])
    payload = {
        "meta": {
            "sig": sig,
            "instrument": INST,
            "spread": config.SPREAD,
            "audit_day": audit_day or config.AUDIT_DAY.isoformat(),
            "configs": config.combo_count(INST["rth_skip_open"], INST.get("ny_skip_open", False)),
            "built": int(time.time()),
            "runs": len(items),
        },
        "runs": items,
        "factors": metrics.factor_table(items, [
            {"key": key, "options": options} for key, _title, options in config.FACTORS
        ]),
    }
    _atomic_json(paths["summary"], payload)


def load_for_run(cfg):
    bars, clocks = data.load(CSV_FILE)
    sig = data_sig()
    eng = Engine(bars, clocks, sig)
    ev = eng.events(cfg["lvl"])
    ex = eng.resolve(ENTRY_CODE[cfg["entry"]], cfg["sl"], cfg["tp"])
    return eng, ev, ex


def px(cents_value, digits=None):
    """Integer price-steps -> float price, rounded for display."""
    return round(float(cents_value) / SCALE, INST["decimals"] if digits is None else digits)


def px_text(cents_value):
    """Integer price-steps -> price text with every instrument decimal shown.

    A float cannot carry 1565.50 (it writes 1565.5), which reads as a broken
    quote on a 2-decimal instrument, so the CSV exports use text.
    """
    return f"{float(cents_value) / SCALE:.{INST['decimals']}f}"


def day_levels(records, day, lo, hi, limit=600):
    rows = levels.level_rows(records, day, None, lo, hi, limit)
    return [{"price": r["price"], "color": r["color"], "sources": r["sources"]} for r in rows]


def label_index(records):
    """cents -> [(candle day, kind, label)] sorted by candle day."""
    out = {}
    for i in range(len(records["cents"])):
        c = int(records["cents"][i])
        out.setdefault(c, []).append(
            (int(records["day"][i]), int(records["kind"][i]), records["label"][i])
        )
    for rows in out.values():
        rows.sort()
    return out


def label_of(index, cents, day):
    """Kind and sources of a level as they stood on one trade day."""
    rows = index.get(int(cents))
    if not rows:
        return "level", "", []
    day = int(day)
    lo, hi = 0, len(rows)
    while lo < hi:
        mid = (lo + hi) // 2
        if rows[mid][0] <= day:
            lo = mid + 1
        else:
            hi = mid
    if lo == 0:
        return "level", "", []
    known = rows[:lo]
    kinds = 0
    for _d, k, _l in known:
        kinds |= k
    kind = "daily+weekly" if kinds == 3 else ("weekly" if kinds == 2 else "daily")
    newest = known[-1][2]
    return kind, newest, [r[2] for r in reversed(known)]


def audit(cfg, day, out_path):
    eng, ev, ex = load_for_run(cfg)
    records = levels.build_records(eng.bars, eng.clocks, cfg["lvl"])
    sel = eng.mask(cfg["entry"], cfg["typ"], cfg["session"], cfg["look"], open_mode(cfg), ny_open_mode(cfg))
    side = eng.sides(ENTRY_CODE[cfg["entry"]])

    lo = int(np.datetime64(day.isoformat(), "D").astype("int64"))
    mask_day = ev["day"] == lo
    ev_idx = np.flatnonzero(mask_day)
    sel_set = np.zeros(ev["bar"].size, dtype=bool)
    sel_set[sel] = True

    taken_rows, decisions = replay_day(eng, ev, ex, cfg, sel, side, lo)
    fast = trades_for(eng, ev, ex, cfg)
    taken_fast = set(int(i) for i in fast["idx"][ev["day"][fast["idx"]] == lo])
    taken_py = set(int(i) for i in taken_rows)
    consistent = taken_fast == taken_py

    index = label_index(records)
    day_bars = np.flatnonzero(eng.bar_day == lo)
    bars = []
    if day_bars.size:
        for b in day_bars:
            bars.append([
                int(eng.bars["ts"][b]),
                round(float(eng.bars["o"][b]), INST["decimals"]),
                round(float(eng.bars["h"][b]), INST["decimals"]),
                round(float(eng.bars["l"][b]), INST["decimals"]),
                round(float(eng.bars["c"][b]), INST["decimals"]),
            ])
    if bars:
        lows = min(b[3] for b in bars)
        highs = max(b[2] for b in bars)
    else:
        lows, highs = 0.0, 0.0
    pad = max(40.0 * INST["point"], (highs - lows) * 0.08)
    lv = levels.level_rows(records, lo, None,
                           int(np.rint((lows - pad) * SCALE)), int(np.rint((highs + pad) * SCALE)), 800)

    rows = []
    for i in ev_idx:
        b = int(ev["bar"][i])
        s = int(side[i])
        d = int(ev["dir"][i])
        row = {
            "t": int(eng.bars["ts"][b]),
            "bar": b,
            "side": s,
            "level": px(ev["cents"][i]),
            "rank": int(ev["rank"][i]),
            "seg": int(ev["seg"][i]),
            "variant": int(ev["variant"][i]),
            "dir": d,
            "look_days": int(lo - int(ev["lday"][i])),
            "in_lon": bool(eng.clocks["in_lon"][b]),
            "in_ny": bool(eng.clocks["in_ny"][b]),
            "in_rth": bool(eng.clocks["in_rth"][b]),
        }
        kind_txt, source, sources = label_of(index, ev["cents"][i], lo)
        row["kind"] = kind_txt
        row["source"] = source
        row["sources"] = sources
        reason = decisions.get(int(i))
        if reason is None:
            reason = mask_reason(eng, ev, cfg, i)
        row["decision"] = reason
        if int(i) in taken_py:
            t = taken_rows[int(i)]
            row.update({
                "fill": t["fill"], "stop": t["stop"], "target": t["target"],
                "exit_t": t["exit_t"], "exit": t["exit"], "points": t["points"],
                "exit_kind": t["exit_kind"], "mae": t["mae"], "mfe": t["mfe"],
                "bars": t["bars"],
            })
        rows.append(row)

    payload = {
        "run": cfg["id"],
        "cfg": cfg,
        "day": day.isoformat(),
        "consistent": consistent,
        "bars": bars,
        "levels": lv,
        "rows": rows,
        "counts": {
            "events": len(rows),
            "taken": len(taken_py),
            "skipped": len(rows) - len(taken_py),
        },
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    _atomic_json(out_path, payload)
    return payload


def mask_reason(eng, ev, cfg, i):
    b = int(ev["bar"][i])
    sess = SESSION_CODE[cfg["session"]]
    if sess == 2 and open_mode(cfg) == "skip" and bool(eng.open_bars[b]):
        return "open_min"
    if sess == 1 and ny_open_mode(cfg) == "skip" and bool(eng.ny_open_bars[b]):
        return "ny_open"
    if sess == 0:
        ok = bool(eng.clocks["in_lon"][b])
    elif sess == 1:
        ok = bool(eng.clocks["in_ny"][b])
    elif sess == 2:
        ok = bool(eng.clocks["in_rth"][b])
    else:
        ok = bool(eng.clocks["in_lon"][b] or eng.clocks["in_ny"][b])
    if not ok:
        return "session"
    days = config.LOOK_DAYS[cfg["look"]]
    if days is not None and int(ev["day"][i]) - int(ev["lday"][i]) > days:
        return "look"
    if cfg["entry"] == "confirm":
        level = int(ev["cents"][i])
        close = int(eng.occ[b])
        opened = int(eng.oc[b])
        prev = int(eng.occ[b - 1]) if b > 0 else close
        side = events.confirm_side(
            TYPE_CODE[cfg["typ"]], opened, prev, close, level, b > 0,
        )
        if side == 0:
            return "flat" if close == level else "body"
        return "taken"
    side = 1 if int(ev["variant"][i]) == 1 else -1
    implied = 1 if (side == 1) == (int(ev["dir"][i]) == 1) else -1
    if implied != TYPE_CODE[cfg["typ"]]:
        return "type"
    return "taken"


def replay_day(eng, ev, ex, cfg, sel, side, day):
    """Replay this run's rules and mark every selected event of one day."""
    tpd = cfg["tpd"]
    upto = int(np.searchsorted(ev["day"], day, side="left"))
    in_day = int(np.searchsorted(ev["day"], day + 1, side="left"))
    bar = ev["bar"]
    rank = ev["rank"]
    cents = ev["cents"]
    ebar = ex[2]
    esub = ex[3]
    pnl = ex[0]
    used = set()
    day_pnl = 0.0
    one_done = False
    capped = False
    open_bar = -1
    open_sub = -1
    taken = {}
    decisions = {}
    prev_day = None
    stop_at = sel.size
    for a in range(sel.size):
        i = int(sel[a])
        d = int(ev["day"][i])
        if d > day:
            break
        if prev_day is not None and d != prev_day:
            used = set()
            day_pnl = 0.0
            one_done = False
            capped = False
        prev_day = d
        # The gates run on every day, not just the audited one: a serial or
        # capped run carries its state into the day, and only the decisions of
        # the audited day are reported.
        if capped:
            if d == day:
                decisions[i] = "cap"
            continue
        if tpd in ("serial", "until") and (bar[i], rank[i]) <= (open_bar, open_sub):
            if d == day:
                decisions[i] = "open"
            continue
        if tpd == "one" and one_done:
            if d == day:
                decisions[i] = "one"
            continue
        if cents[i] in used:
            if d == day:
                decisions[i] = "level"
            continue
        b = int(bar[i])
        xb = int(ebar[i])
        xs = int(esub[i])
        used.add(int(cents[i]))
        one_done = True
        if d == day:
            decisions[i] = "taken"
            s_i = int(side[i])
            value = fill_cents(ENTRY_CODE[cfg["entry"]], s_i, eng.occ[b], ev["fill"][i])
            taken[i] = {
                "fill": px(value),
                "stop": px(value - s_i * pts_c(cfg["sl"])),
                "target": px(value + s_i * pts_c(cfg["tp"])),
                "exit_t": int(eng.bars["ts"][xb]),
                "exit": px(value + float(pnl[i]) * s_i),
                "points": round(float(pnl[i]) / STEPS_PER_POINT, 2),
                "exit_kind": {0: "stop", 1: "target", 2: "end of data"}[int(ex[1][i])],
                "mae": round(float(ex[4][i]) / STEPS_PER_POINT, 1),
                "mfe": round(float(ex[5][i]) / STEPS_PER_POINT, 1),
                "bars": xb - b,
            }
        if int(eng.bar_day[xb]) == d:
            day_pnl += float(pnl[i])
        if tpd == "until" and day_pnl >= pts_c(cfg["tp"]):
            capped = True
        if tpd in ("serial", "until"):
            open_bar, open_sub = xb, xs
    del upto, in_day
    return taken, decisions


CSV_COLUMNS = [
    "seq", "entry_utc", "ny_date", "side", "trade_type", "entry_mode", "level_price",
    "level_kind", "level_source", "fill", "stop", "target", "exit_utc", "exit_kind",
    "points", "mae_pts", "mfe_pts", "bars_held", "retrace_of_stop_pct",
]


def utc(ts):
    return time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(int(ts)))


def day_text(ordinal):
    return str(np.datetime64(int(ordinal), "D"))


def export_trades(cfg, out_path):
    eng, ev, ex = load_for_run(cfg)
    records = levels.build_records(eng.bars, eng.clocks, cfg["lvl"])
    trades = trades_for(eng, ev, ex, cfg)
    idx = trades["idx"]
    side = eng.sides(ENTRY_CODE[cfg["entry"]])
    index = label_index(records)
    rows = []
    for seq, i in enumerate(idx):
        i = int(i)
        d = int(ev["day"][i])
        lab = label_of(index, ev["cents"][i], d)
        b = int(ev["bar"][i])
        xb = int(trades["ebar"][seq])
        s_i = int(side[i])
        value = fill_cents(ENTRY_CODE[cfg["entry"]], s_i, eng.occ[b], ev["fill"][i])
        pnl = float(trades["pnl"][seq])
        rows.append({
            "seq": seq + 1,
            "entry_utc": utc(eng.bars["ts"][b]),
            "ny_date": day_text(d),
            "side": "buy" if s_i > 0 else "sell",
            "trade_type": config.LABELS["typ"][cfg["typ"]],
            "entry_mode": config.LABELS["entry"][cfg["entry"]],
            "level_price": px_text(ev["cents"][i]),
            "level_kind": lab[0],
            "level_source": lab[1],
            "fill": px_text(value),
            "stop": px_text(value - s_i * pts_c(cfg["sl"])),
            "target": px_text(value + s_i * pts_c(cfg["tp"])),
            "exit_utc": utc(eng.bars["ts"][xb]),
            "exit_kind": {0: "stop", 1: "target", 2: "end of data"}[int(trades["kind"][seq])],
            "points": round(pnl / STEPS_PER_POINT, 2),
            "mae_pts": round(float(trades["mae"][seq]) / STEPS_PER_POINT, 1),
            "mfe_pts": round(float(trades["mfe"][seq]) / STEPS_PER_POINT, 1),
            "bars_held": xb - b,
            "retrace_of_stop_pct": round(float(trades["mae"][seq]) / pts_c(cfg["sl"]) * 100, 1),
        })
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=CSV_COLUMNS)
        writer.writeheader()
        writer.writerows(rows)
    return len(rows)


def configs_for(args):
    if args.all:
        return list(config.iter_configs(INST["rth_skip_open"], INST.get("ny_skip_open", False)))
    ids = []
    for chunk in (args.ids or "").split(","):
        chunk = chunk.strip()
        if chunk:
            ids.append(chunk)
    if args.ids_file:
        with open(args.ids_file, encoding="utf-8") as fh:
            ids.extend(line.strip() for line in fh if line.strip())
    if args.run:
        ids.append(args.run)
    if not ids:
        raise SystemExit("give --all, --ids, --ids-file or --run")
    cfgs = []
    for run_id in ids:
        cfg = ensure_open(config.parse_id(run_id))
        cfg["id"] = run_id
        cfgs.append(cfg)
    return cfgs


def default_audit_day():
    """Last New York day of the file, from summary.json when it exists."""
    path = results_paths()["summary"]
    if path.exists():
        try:
            with open(path, encoding="utf-8") as fh:
                day = json.load(fh).get("meta", {}).get("audit_day")
            if day:
                return datetime.strptime(day, "%Y-%m-%d").date()
        except (OSError, ValueError):
            pass
    return config.AUDIT_DAY


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--all", action="store_true", help="every combination")
    parser.add_argument("--ids", help="comma separated run ids")
    parser.add_argument("--ids-file", help="a file with one run id per line")
    parser.add_argument("--run", help="a single run id")
    parser.add_argument("--force", action="store_true", help="recompute runs already in summary.json")
    parser.add_argument("--workers", type=int, default=1, help="processes, 1 to 4")
    parser.add_argument("--audit", help="write the audit day table for one run")
    parser.add_argument("--export-trades", help="write the trade CSV for one run")
    parser.add_argument("--day", help="audit day, YYYY-MM-DD")
    parser.add_argument("--file", help="CSV file name from ../data (default: the US100 file)")
    args = parser.parse_args(argv)

    if args.file:
        use_file(args.file)
    paths = results_paths()
    config.ensure_dirs(STEM)
    if args.audit:
        cfg = ensure_open(config.parse_id(args.audit))
        cfg["id"] = args.audit
        day = (datetime.strptime(args.day, "%Y-%m-%d").date() if args.day else default_audit_day())
        out = paths["audit"] / f"{args.audit}_{day.isoformat()}.json"
        try:
            payload = audit(cfg, day, out)
        except Exception:
            traceback.print_exc()
            return 1
        print(f"{out}  {payload['counts']['events']} touches, {payload['counts']['taken']} taken, "
              f"consistent={payload['consistent']}")
        return 0
    if args.export_trades:
        cfg = ensure_open(config.parse_id(args.export_trades))
        cfg["id"] = args.export_trades
        out = paths["trades"] / f"{args.export_trades}.csv"
        try:
            n = export_trades(cfg, out)
        except Exception:
            traceback.print_exc()
            return 1
        print(f"{out}  {n} trades")
        return 0

    cfgs = configs_for(args)
    execute(cfgs, force=args.force, workers=args.workers)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except Exception:
        traceback.print_exc()
        try:
            _atomic_json(results_paths()["progress"],
                         {"running": False, "error": traceback.format_exc(), "updated": int(time.time())})
        except Exception:
            pass
        raise SystemExit(1)
