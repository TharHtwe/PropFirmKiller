"""Risk-factor analysis of the level-retrace runs, one month of 2026 at a time.

    python risk.py --file US100_M1_...csv --all
    python risk.py --file ... --ids sl50_tp50_ny_lveth_cont_touch_1m_serial
    python risk.py --file ... --ids-file queue.txt --max-lot 20

For every run and every month the script opens a fresh 5,000 USD account, takes
the run's trades for that month, and marks the account to the minute.  It then
raises the lot from the broker minimum until the Risk Factor stops rounding to
5, and records the largest lot that holds for the whole month.  A run is safe
at a lot when *every* month of the year is safe at that lot.

Only read access is needed to the strategy package: trades are rebuilt with the
same engine, so the P&L matches the strategy report trade for trade.  Results
are written under ``results/<csv-stem>/risk.json`` and never touch the strategy
results.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import traceback
from pathlib import Path

import numpy as np

BASE = Path(__file__).resolve().parent
STRATEGY_DIR = BASE.parent / "nasdaq-level-retrace-v2"
sys.path.insert(0, str(STRATEGY_DIR))

import config as sc          # noqa: E402
import data as sd            # noqa: E402
import run as sr             # noqa: E402

import rfspec                # noqa: E402

RISK_VERSION = 1
RESULTS_DIR = BASE / "results"
DEFAULT_CSV = "US100_M1_202001020105_202610291406.csv"


# --------------------------------------------------------------------------- #
# small helpers


def _atomic_json(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, separators=(",", ":"))
    for attempt in range(40):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            if attempt == 39:
                raise
            time.sleep(0.05)


def yday(text):
    return int(np.datetime64(text, "D").astype("int64"))


def month_ranges(year):
    out = []
    for month in range(1, 13):
        start = f"{year}-{month:02d}-01"
        end = f"{year + 1}-01-01" if month == 12 else f"{year}-{month + 1:02d}-01"
        out.append((start[:7], yday(start), yday(end)))
    return out


def now():
    return time.time()


# --------------------------------------------------------------------------- #
# one month of one run, at every volume


def month_account(eng, trades, y0, y1, spec, spp, bidx):
    """Per-lot dollar curves for one month, built as difference arrays.

    Every open position contributes a linear function of the bar close
    (side * close - side * value) and one margin unit per bar, so a month is
    assembled with six scalar updates per trade and a handful of cumsums.
    """
    lo, hi = int(bidx[0]), int(bidx[-1])
    nm = bidx.size
    sd = np.zeros(nm + 1)      # sum of sides of the open positions
    cd = np.zeros(nm + 1)      # sum of side * entry value, in price steps
    cn = np.zeros(nm + 1)      # number of open positions
    real = np.zeros(nm)        # realised points, booked on the exit bar
    comm = np.zeros(nm)        # commission dollars, booked on the entry bar

    day = trades["day"]
    sel = np.flatnonzero((day >= y0) & (day < y1))
    b0 = trades["b0"]
    b1 = trades["b1"]
    side = trades["side"]
    value = trades["value"]
    pnl = trades["pnl"]
    for k in sel:
        a = int(b0[k])
        z = int(b1[k])
        if a < lo or a > hi:
            continue
        ia = a - lo
        closed = z <= hi
        iz = (z - lo) if closed else nm
        if iz > ia:
            s = float(side[k])
            v = s * float(value[k])
            sd[ia] += s
            sd[iz] -= s
            cd[ia] += v
            cd[iz] -= v
            cn[ia] += 1.0
            cn[iz] -= 1.0
        if closed:
            real[z - lo] += float(pnl[k])
        comm[ia] -= spec["commission"]

    return {
        "ss": np.cumsum(sd[:nm]),
        "cs": np.cumsum(cd[:nm]),
        "count": np.cumsum(cn[:nm]),
        "real": np.cumsum(real),
        "comm": np.cumsum(comm),
        "occ": eng.occ[lo:hi + 1],
        "price": eng.bars["c"][lo:hi + 1].astype(np.float64),
        "trades": int(sel.size),
    }


def evaluate(acc, lot, spec, spp, start):
    """Equity, relative drawdown, utilisation and Risk Factor at one lot."""
    per_lot = (acc["real"] * spec["usd_per_point"]
               + (acc["occ"] * acc["ss"] - acc["cs"]) / spp * spec["usd_per_point"]
               + acc["comm"])
    eq = start + lot * per_lot
    if eq.size == 0 or not np.all(np.isfinite(eq)) or np.any(eq <= 0.0):
        return None
    peak = np.maximum.accumulate(np.concatenate(([start], eq)))[1:]
    dd = float(np.max((peak - eq) / peak) * 100.0)
    margin = lot * spec["margin_rate"] * acc["price"] * acc["count"]
    util = float(np.max(np.where(margin > 0.0, margin / eq * 100.0, 0.0)))
    rf = rfspec.risk_factor(dd, util)
    return {
        "lot": lot,
        "rf": rf,
        "dd": dd,
        "util": util,
        "gain": float(lot * per_lot[-1]),
        "ok": rfspec.passes(rf),
    }


def search_lot(acc, spec, spp, start, cap):
    """Largest lot that survives the month, and the first one that does not.

    Risk Factor is monotone in the lot: P&L, commission and margin all scale
    with it, and relative drawdown cannot fall as the position grows, so a
    bisection over the broker's volume steps is exact.
    """
    levels = rfspec.lot_levels(spec, cap)
    if not levels:
        return None, None
    first = evaluate(acc, levels[0], spec, spp, start)
    if first is None or not first["ok"]:
        return None, first
    lo, hi = 0, len(levels) - 1
    best = first
    while lo < hi:
        mid = (lo + hi + 1) // 2
        trial = evaluate(acc, levels[mid], spec, spp, start)
        if trial is not None and trial["ok"]:
            best = trial
            lo = mid
        else:
            hi = mid - 1
    nxt = levels[lo + 1] if lo + 1 < len(levels) else None
    return best, (evaluate(acc, nxt, spec, spp, start) if nxt is not None else None)


def analyse_run(eng, ev, trades, cfg, spec, spp, months, start, cap):
    rows = []
    accounts = []
    for name, y0, y1, bidx in months:
        if bidx.size == 0:
            rows.append({"month": name, "nodata": True})
            accounts.append(None)
            continue
        acc = month_account(eng, trades, y0, y1, spec, spp, bidx)
        best, fail = search_lot(acc, spec, spp, start, cap)
        rows.append({
            "month": name,
            "trades": acc["trades"],
            "lot_max": None if best is None else best["lot"],
            "rf_max": None if best is None else best["rf"],
            "dd_max": None if best is None else best["dd"],
            "util_max": None if best is None else best["util"],
            "gain_max": None if best is None else best["gain"],
            "rf_next": None if fail is None else fail["rf"],
            "lot_next": None if fail is None else fail["lot"],
        })
        accounts.append(acc)

    used = [(rows[i], accounts[i]) for i in range(len(rows)) if accounts[i] is not None]
    row_out = {"id": cfg["id"], "cfg": {k: cfg[k] for k in
               ("sl", "tp", "session", "lvl", "typ", "entry", "look", "tpd")}}

    if not used:
        row_out.update({"safe_lot": None, "reason": "no data", "months": rows})
        return row_out

    tradable = [(row, acc) for row, acc in used if row["trades"] > 0]
    if not tradable:
        row_out.update({"safe_lot": None, "reason": "no trades", "months": rows})
        return row_out

    if any(row["lot_max"] is None for row, _ in tradable):
        fails = [row for row, _ in tradable if row["lot_max"] is None]
        worst = max(fails, key=lambda r: r["rf_next"] or 0.0)
        row_out.update({
            "safe_lot": None,
            "reason": "risk factor over 5 at the minimum lot",
            "fail_month": worst["month"],
            "rf_at_min": worst["rf_next"],
            "dd_at_min": worst["dd_max"],
            "months": rows,
        })
        return row_out

    safe = min(row["lot_max"] for row, _ in tradable)
    for row, acc in used:
        at = evaluate(acc, safe, spec, spp, start)
        row["lot"] = safe
        row["rf"] = at["rf"]
        row["dd"] = at["dd"]
        row["util"] = at["util"]
        row["gain"] = at["gain"]
        row["return_pct"] = at["gain"] / start * 100.0

    done = [row for row, _ in tradable]
    gains = [r["gain"] for r in done]
    rfs = [r["rf"] for r in done]
    best = max(done, key=lambda r: r["gain"])
    worst = min(done, key=lambda r: r["gain"])
    row_out.update({
        "safe_lot": safe,
        "reason": "ok",
        "trades": int(sum(r["trades"] for r in done)),
        "months_used": len(done),
        "min_gain": min(gains),
        "max_gain": max(gains),
        "total_gain": float(sum(gains)),
        "avg_gain": float(sum(gains) / len(gains)),
        "min_rf": min(rfs),
        "max_rf": max(rfs),
        "max_dd": max(r["dd"] for r in done),
        "max_util": max(r["util"] for r in done),
        "avg_return_pct": float(sum(r["return_pct"] for r in done) / len(done)),
        "total_return_pct": float(sum(gains) / start * 100.0),
        "best_month": best["month"],
        "worst_month": worst["month"],
        "months": rows,
    })
    return row_out


# --------------------------------------------------------------------------- #
# trades


def trade_arrays(eng, ev, ex, cfg):
    trades = sr.trades_for(eng, ev, ex, cfg)
    idx = trades["idx"].astype(np.int64)
    if idx.size == 0:
        empty = np.empty(0)
        return {"idx": idx, "b0": idx, "b1": idx, "side": idx, "value": idx,
                "pnl": empty, "day": idx}
    side = eng.sides(sr.ENTRY_CODE[cfg["entry"]])[idx].astype(np.int64)
    value = sr.fill_array(
        sr.ENTRY_CODE[cfg["entry"]], side, eng.occ[ev["bar"][idx]], ev["fill"][idx],
    )
    return {
        "idx": idx,
        "b0": ev["bar"][idx].astype(np.int64),
        "b1": trades["ebar"].astype(np.int64),
        "side": side,
        "value": value.astype(np.float64),
        # resolve() reports price steps; the risk model works in strategy points.
        "pnl": trades["pnl"].astype(np.float64) / float(sr.STEPS_PER_POINT),
        "day": ev["day"][idx].astype(np.int64),
    }


def _risk_worker(csv_name, groups, year, balance, max_lot, result_queue):
    batch = []

    def flush():
        if batch:
            result_queue.put(("batch", batch[:]))
            batch.clear()

    try:
        sr.use_file(csv_name)
        spec = rfspec.spec_for(sr.STEM)
        spp = float(sr.STEPS_PER_POINT)
        bars, clocks = sd.load(sr.CSV_FILE)
        eng = sr.Engine(bars, clocks, sr.data_sig())
        months = []
        for name, y0, y1 in month_ranges(year):
            bidx = np.flatnonzero((eng.bar_day >= y0) & (eng.bar_day < y1))
            months.append((name, y0, y1, bidx))
        for (lvl, entry, sl, tp), group in groups:
            ev = eng.events(lvl)
            ex = eng.resolve(sr.ENTRY_CODE[entry], sl, tp)
            for cfg in group:
                trades = trade_arrays(eng, ev, ex, cfg)
                batch.append(analyse_run(eng, ev, trades, cfg, spec, spp, months, balance, max_lot))
                if len(batch) >= 5:
                    flush()
            del ex
        flush()
        result_queue.put(("done", None))
    except Exception:
        flush()
        result_queue.put(("error", traceback.format_exc()))


def group_configs(cfgs):
    """Group by (lvl, entry, sl, tp) so each event file and exit walk is built
    once; the order keeps the three level sessions contiguous."""
    order = []
    groups = {}
    for cfg in cfgs:
        key = (cfg["lvl"], cfg["entry"], cfg["sl"], cfg["tp"])
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(cfg)
    order.sort(key=lambda k: ("all", "eth", "rth").index(k[0]))
    return [(key, groups[key]) for key in order]


# --------------------------------------------------------------------------- #
# CLI


def configs_from(args):
    if args.all:
        return list(sc.iter_configs(sr.INST["rth_skip_open"], sr.INST.get("ny_skip_open", False)))
    ids = []
    for chunk in (args.ids or "").split(","):
        chunk = chunk.strip()
        if chunk:
            ids.append(chunk)
    if args.ids_file:
        with open(args.ids_file, encoding="utf-8") as fh:
            ids.extend(line.strip() for line in fh if line.strip())
    cfgs = []
    seen = set()
    for run_id in ids:
        if run_id in seen:
            continue
        seen.add(run_id)
        cfg = sr.ensure_open(sc.parse_id(run_id))
        cfg["id"] = run_id
        cfgs.append(cfg)
    if not cfgs:
        raise SystemExit("give --all, --ids or --ids-file")
    return cfgs


def signature(csv_name, spec, spp, params):
    st = os.stat(sr.CSV_FILE)
    return {
        "file": csv_name,
        "stem": sr.STEM,
        "size": int(st.st_size),
        "mtime": int(st.st_mtime),
        "cache_version": sc.CACHE_VERSION,
        "rules_version": sc.RULES_VERSION,
        "risk_version": RISK_VERSION,
        "spec": spec,
        "params": params,
        "spp": spp,
    }


def same_signature(old, new):
    if not isinstance(old, dict):
        return False
    for key in ("file", "size", "mtime", "cache_version", "rules_version",
                "risk_version", "spp"):
        if old.get(key) != new.get(key):
            return False
    return old.get("spec") == new.get("spec") and old.get("params") == new.get("params")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--file", default=DEFAULT_CSV)
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--ids")
    parser.add_argument("--ids-file")
    parser.add_argument("--year", type=int, default=2026)
    parser.add_argument("--max-lot", type=float, default=100.0)
    parser.add_argument("--balance", type=float, default=rfspec.RISK["start_balance"])
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--workers", type=int, default=1, help="processes, 1 to 4")
    parser.add_argument("--limit", type=int, help="debug: stop after N runs")
    args = parser.parse_args(argv)

    csv_name = args.file
    sr.use_file(csv_name)
    spec = rfspec.spec_for(sr.STEM)
    if spec is None:
        raise SystemExit(f"no broker spec for {sr.STEM}; add it to rfspec.SPECS")

    cfgs = configs_from(args)
    if args.limit:
        cfgs = cfgs[:args.limit]
    params = {"year": args.year, "max_lot": args.max_lot, "balance": args.balance}
    out_dir = RESULTS_DIR / sr.STEM
    out_path = out_dir / "risk.json"
    progress_path = out_dir / "progress.json"

    spp = float(sr.STEPS_PER_POINT)
    sig = signature(csv_name, spec, spp, params)

    previous = {}
    if out_path.exists() and not args.force:
        try:
            old = json.loads(out_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            old = {}
        if same_signature(old.get("meta", {}).get("sig"), sig):
            previous = {r["id"]: r for r in old.get("runs", [])}
        else:
            print("data, spec or parameters changed: previous risk results discarded")
    todo = [cfg for cfg in cfgs if cfg["id"] not in previous]
    if not todo:
        print("nothing to do, every requested run is already in risk.json")
        return 0

    started = now()
    total = len(todo)
    done = 0
    _atomic_json(progress_path, {"running": True, "done": 0, "total": total,
                                 "elapsed": 0.0, "eta_seconds": None,
                                 "updated": int(now()), "phase": "loading bars"})
    groups = group_configs(todo)
    buckets = sr.assign_groups(groups, args.workers)
    n_workers = 1 if buckets is None else len(buckets)
    print(f"{total} runs · {n_workers} processor{'s' if n_workers != 1 else ''} · "
          f"{sr.STEM} · {params['year']} · max {args.max_lot} lots")

    bars, clocks = sd.load(sr.CSV_FILE)
    eng = sr.Engine(bars, clocks, sr.data_sig())
    months = []
    for name, y0, y1 in month_ranges(args.year):
        bidx = np.flatnonzero((eng.bar_day >= y0) & (eng.bar_day < y1))
        months.append((name, y0, y1, bidx))
    usable = [m[0] for m in months if m[3].size]
    print(f"{len(bars['ts'])} bars · months with data: {', '.join(usable) or 'none'}")
    if buckets is not None:
        eng.release()
        del eng, bars, clocks

    runs = dict(previous)
    last_write = now()
    last_progress = 0.0
    error = None

    def accept(row):
        nonlocal done, last_write, last_progress
        runs[row["id"]] = row
        done += 1
        if done % 100 == 0:
            elapsed = now() - started
            print(f"  {done}/{total} · {elapsed:.0f}s · eta {elapsed / done * (total - done):.0f}s")
        if now() - last_progress > 5:
            elapsed = now() - started
            _atomic_json(progress_path, {
                "running": True, "done": done, "total": total,
                "elapsed": round(elapsed, 1),
                "eta_seconds": round(elapsed / done * (total - done), 1) if done else None,
                "updated": int(now()), "phase": row["id"], "workers": n_workers,
            })
            last_progress = now()
        if now() - last_write > 60:
            _atomic_json(out_path, {"meta": {"sig": sig, "built": int(now()),
                                             "runs": len(runs), "months": usable},
                                    "runs": list(runs.values())})
            last_write = now()

    try:
        if buckets is None:
            for (lvl, entry, sl, tp), group in groups:
                ev = eng.events(lvl)
                ex = eng.resolve(sr.ENTRY_CODE[entry], sl, tp)
                for cfg in group:
                    trades = trade_arrays(eng, ev, ex, cfg)
                    accept(analyse_run(
                        eng, ev, trades, cfg, spec, spp, months, args.balance, args.max_lot))
                del ex
        else:
            sr.prepare_levels([key[0] for key, _group in groups])
            from multiprocessing import get_context
            ctx = get_context("spawn")
            result_queue = ctx.Queue()
            procs = [
                ctx.Process(
                    target=_risk_worker,
                    args=(csv_name, bucket, args.year, args.balance, args.max_lot, result_queue),
                )
                for bucket in buckets
            ]
            for proc in procs:
                proc.start()
            sr.collect_workers(procs, result_queue, lambda batch: [accept(row) for row in batch])
    except BaseException as exc:
        error = f"{type(exc).__name__}: {exc}"
        raise
    finally:
        _atomic_json(out_path, {"meta": {"sig": sig, "built": int(now()),
                                         "runs": len(runs), "months": usable},
                                "runs": list(runs.values())})
        _atomic_json(progress_path, {"running": False, "done": done, "total": total,
                                     "elapsed": round(now() - started, 1),
                                     "eta_seconds": 0, "updated": int(now()),
                                     "phase": "done", "error": error})

    safe = sum(1 for r in runs.values() if r.get("safe_lot") is not None)
    print(f"wrote {out_path} · {len(runs)} runs · {safe} with a safe lot")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception:
        traceback.print_exc()
        raise SystemExit(1)
