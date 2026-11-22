"""2-step prop-firm replay of strategy favourite runs.

Reads the trade CSV the strategy page already saved. If that file is missing,
exports it with the strategy engine first. Results stay in this folder.

    python prop.py --file US100_M1_....csv --ids id1,id2
    python prop.py --file US100_M1_....csv --ids-file queue.txt
    python prop.py --file US100_M1_....csv --ids-file queue.txt --force

A 50-point stop uses 0.10 lot. A 100-point stop uses 0.05 lot.
On US100, one full lot is $20 per index point, so those lots are $2 and $1
a point. Other instruments use the broker's one-lot value from the risk spec.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import sys
import time
import traceback
from datetime import date, datetime, timedelta, timezone
from heapq import heappop, heappush
from pathlib import Path

import numpy as np

BASE = Path(__file__).resolve().parent
STRATEGY_DIR = BASE.parent / "nasdaq-level-retrace-v2"
RISK_DIR = BASE.parent / "risk-factor"
sys.path.insert(0, str(STRATEGY_DIR))
sys.path.insert(0, str(RISK_DIR))

import config as sc  # noqa: E402
import data as sd  # noqa: E402
import rfspec  # noqa: E402
import run as sr  # noqa: E402

VERSION = 1
RESULTS = BASE / "results"
START = 500_000
FEE = 2_200
QUALIFY = 2_500
MIN_PAY = 2_000
DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]
# One full lot on the prop US100 contract. 0.10 lot is $2 a point, 0.05 lot is $1.
US100_USD_PER_LOT = 20.0
LOTS = {50: 0.10, 100: 0.05}
SPEC = {
    "fee": FEE,
    "daily_pct": 4,
    "dd_pct": 8,
    "targets": (40_000, 25_000),
    "min_green": 3,
}


def cents(points, point):
    return int(round(float(points) * point))


def dollars(value):
    return round(value / 100, 2)


def band(ref, pct):
    return (ref * pct + 50) // 100


def day_floor(ref, pct):
    return ref - band(ref, pct)


def dd_floor(hwm, pct):
    return hwm - band(hwm, pct)


def initial_floor():
    return dd_floor(START, SPEC["dd_pct"])


def lot_for(sl):
    if sl not in LOTS:
        raise SystemExit(f"stop {sl} has no lot; expected 50 or 100")
    return LOTS[sl]


def usd_per_lot(stem):
    prefix = stem.upper().split("_")[0]
    if prefix == "US100":
        return US100_USD_PER_LOT
    spec = rfspec.spec_for(stem)
    if spec is None:
        raise SystemExit(f"no point value for {prefix}")
    return float(spec["usd_per_point"])


def point_cents(stem, sl):
    return int(round(lot_for(sl) * usd_per_lot(stem) * 100))


def atomic_json(path, obj):
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


def parse_utc(text):
    return datetime.strptime(text, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)


def fresh():
    return {
        "phase": "p1",
        "balance": START,
        "green": 0,
        "green_days": set(),
        "day_pnl": {},
        "hold_ok": 0,
        "hold_n": 0,
        "due": None,
        "max_profit": 0,
        "alive": True,
        "open": {},
        "day": None,
        "ref": START,
        "heap": [],
        "seq": 0,
        "phase_start": None,
        "phase_trades": 0,
        "hwm": START,
        "floor": initial_floor(),
    }


def ratio_ok(acct):
    return acct["hold_n"] == 0 or acct["hold_ok"] * 2 >= acct["hold_n"]


def equity(acct, point):
    return acct["balance"] + cents(sum(acct["open"].values()), point)


def die(acct, stats, reason, on_day=None):
    if not acct["alive"]:
        return
    stats[reason] += 1
    key = {"p1": "fail_p1", "p2": "fail_p2", "funded": "fail_funded"}[acct["phase"]]
    stats[key] += 1
    acct["alive"] = False
    acct["death_day"] = on_day or acct.get("day")
    acct["open"].clear()
    acct["heap"].clear()


def touch_hwm(acct, eq):
    return


def breached(acct, stats, eq, on_day=None):
    daily = day_floor(acct["ref"], SPEC["daily_pct"])
    floor = acct["floor"]
    if eq > floor and eq > daily:
        return False
    if eq <= floor and floor >= daily:
        die(acct, stats, "maxdd", on_day)
    else:
        die(acct, stats, "daily", on_day)
    return True


def roll(acct, stats, new_day, point):
    if acct["day"] is None:
        acct["day"] = new_day
        acct["ref"] = acct["balance"]
        return
    if new_day <= acct["day"]:
        return
    eq = equity(acct, point)
    day = acct["day"] + timedelta(days=1)
    while day <= new_day:
        ref = eq if eq > acct["balance"] else acct["balance"]
        acct["ref"] = ref
        if breached(acct, stats, eq, day):
            return
        day += timedelta(days=1)
    acct["day"] = new_day


def payout(acct, asof, cushion, stats, min_green):
    if not acct["alive"] or acct["phase"] != "funded" or acct["due"] is None or acct["open"]:
        return
    if asof < acct["due"]:
        return
    if acct["green"] < min_green or not ratio_ok(acct):
        return
    withdraw = acct["balance"] - (START + cushion)
    if withdraw < MIN_PAY:
        return
    received = withdraw * 80 // 100
    acct["balance"] -= withdraw
    acct["green"] = 0
    acct["green_days"] = set()
    acct["day_pnl"] = {}
    acct["due"] = None
    acct["hwm"] = START
    acct["floor"] = initial_floor()
    acct["ref"] = START
    stats["payouts"] += 1
    stats["gross"] += withdraw
    stats["received"] += received
    stats["events"].append({"date": asof.isoformat(), "kind": "payout", "gross": withdraw, "received": received})


def phase_ready(acct, min_green):
    idx = {"p1": 0, "p2": 1}.get(acct["phase"])
    if idx is None:
        return False
    if not ratio_ok(acct) or acct["green"] < min_green:
        return False
    return acct["balance"] - START >= SPEC["targets"][idx]


def reset_phase(acct, phase):
    acct["phase"] = phase
    acct["balance"] = START
    acct["green"] = 0
    acct["green_days"] = set()
    acct["day_pnl"] = {}
    acct["due"] = None
    acct["max_profit"] = 0
    acct["ref"] = START
    acct["phase_start"] = None
    acct["phase_trades"] = 0
    acct["hwm"] = START
    acct["floor"] = initial_floor()


def remember_pass(acct, stats, key, exit_day):
    # A phase can be completed by trades whose entry was queued before the
    # previous phase reset phase_start. Fall back to the exit day so the run
    # still finishes; the entry vertex normally sets the start first.
    start = acct["phase_start"] or exit_day
    calendar = (exit_day - start).days + 1
    stats[key].append({"calendar": calendar, "trades": acct["phase_trades"]})


def book(acct, trade, stats, cushion, min_green, exit_day, point):
    acct["balance"] += cents(trade["pnl"], point)
    acct["open"].pop(trade["id"], None)
    acct["max_profit"] = max(acct["max_profit"], acct["balance"] - START)
    key = exit_day.isoformat()
    acct["day_pnl"][key] = acct["day_pnl"].get(key, 0) + cents(trade["pnl"], point)
    if acct["day_pnl"][key] >= QUALIFY and key not in acct["green_days"]:
        acct["green"] += 1
        acct["green_days"].add(key)
    acct["phase_trades"] += 1
    phase_at_entry = trade["phase"]
    if acct["open"]:
        return
    idx = {"p1": 0, "p2": 1}.get(acct["phase"])
    if idx is not None and phase_ready(acct, min_green):
        remember_pass(acct, stats, f"p{idx + 1}_days", exit_day)
        if idx == 1 and stats.get("first_funded") is None:
            stats["first_funded"] = exit_day
        reset_phase(acct, "funded" if idx == 1 else "p2")
        stats[f"p{idx + 1}_pass"] += 1
    elif phase_at_entry == "funded" and acct["phase"] == "funded":
        payout(acct, exit_day, cushion, stats, min_green)


def simulate_week(trades, stats, cushion, min_green, point, asof, until=None):
    trades = sorted(trades, key=lambda item: item["entry_rank"])
    acct = fresh()
    acct["alive"] = False
    started = False

    def drain_until(limit):
        while acct["alive"] and acct["heap"] and acct["heap"][0][0] < limit:
            _rank, _n, trade, unreal, is_exit, day = heappop(acct["heap"])
            if not acct["alive"]:
                return
            roll(acct, stats, day, point)
            if not acct["alive"]:
                return
            acct["open"][trade["id"]] = unreal
            # Entry of a trade that starts the phase after a reset. The
            # schedule loop may already have passed, so this is the start.
            if not is_exit and unreal == 0 and acct["phase_start"] is None:
                acct["phase_start"] = day
            eq = equity(acct, point)
            if breached(acct, stats, eq, day):
                return
            if is_exit:
                book(acct, trade, stats, cushion, min_green, day, point)

    for trade in trades:
        if acct["alive"]:
            drain_until(trade["entry_rank"])
        # A decision run keeps the first account only. Stop when it blows
        # or when phase 2 has just been passed. Do not buy a replacement.
        if until == "decision" and started and (not acct["alive"] or acct["phase"] == "funded"):
            break
        if not acct["alive"]:
            acct = fresh()
            started = True
            if stats.get("first_start") is None:
                stats["first_start"] = trade["entry_day"]
            stats["challenges"] += 1
            stats["fees"] += SPEC["fee"]
            stats["events"].append({"date": trade["entry_day"].isoformat(), "kind": "fee", "fee": SPEC["fee"]})
        if acct["phase"] == "funded" and acct["due"] is None:
            acct["due"] = date.fromisoformat(str(np.busday_offset(np.datetime64(trade["entry_day"]), 10)))
        elif acct["phase"] == "funded" and acct["due"] is not None and not acct["open"]:
            if acct["due"] < trade["entry_day"]:
                payout(acct, acct["due"], cushion, stats, min_green)
        acct["hold_n"] += 1
        if trade["hold_ok"]:
            acct["hold_ok"] += 1
        if acct["phase_start"] is None:
            acct["phase_start"] = trade["entry_day"]
        trade["phase"] = acct["phase"]
        trade["id"] = stats["seq"]
        stats["seq"] += 1
        for rank, unreal, is_exit, day in trade["verts"]:
            acct["seq"] += 1
            heappush(acct["heap"], (rank, acct["seq"], trade, unreal, is_exit, day))
    else:
        if acct["alive"]:
            drain_until(1e30)
    if until != "decision" and acct["alive"] and acct["phase"] == "funded":
        payout(acct, asof, cushion, stats, min_green)
    return acct


def pack_rows(rows):
    yearly = {}
    for row in rows:
        for event in row["events"]:
            year = event["date"][:4]
            bucket = yearly.setdefault(year, {"fees": 0, "received": 0, "payouts": 0, "gross": 0})
            if event["kind"] == "fee":
                bucket["fees"] += event["fee"]
            else:
                bucket["received"] += event["received"]
                bucket["gross"] += event["gross"]
                bucket["payouts"] += 1
    years = []
    cum = 0
    for year in sorted(yearly):
        net = yearly[year]["received"] - yearly[year]["fees"]
        cum += net
        years.append({
            "year": year,
            "fees": dollars(yearly[year]["fees"]),
            "payouts": yearly[year]["payouts"],
            "gross": dollars(yearly[year]["gross"]),
            "received": dollars(yearly[year]["received"]),
            "net": dollars(net),
            "cumulative": dollars(cum),
        })

    def tot(key):
        return sum(row[key] for row in rows)

    def span(items):
        if not items:
            return {"n": 0, "calendar": None, "trading": None}
        calendar = [item["calendar"] for item in items]
        trading = [item["trades"] for item in items]

        def agg(vals):
            return {"min": int(min(vals)), "max": int(max(vals)), "avg": round(sum(vals) / len(vals), 1)}

        return {"n": len(items), "calendar": agg(calendar), "trading": agg(trading)}

    weekdays = []
    for row in rows:
        profit = 0 if not row["end_alive"] else row["end_profit"]
        weekdays.append({
            "weekday": row["weekday"],
            "trades": row["trades"],
            "points": row["points"],
            "challenges": row["challenges"],
            "p1": row["p1_pass"],
            "p2": row["p2_pass"],
            "funded_blow": row["fail_funded"],
            "fees": dollars(row["fees"]),
            "payouts": row["payouts"],
            "received": dollars(row["received"]),
            "net": dollars(row["net"]),
            "maxdd": row["maxdd"],
            "daily": row["daily"],
            "end_phase": row["end_phase"],
            "end_profit": dollars(profit),
            "first_days": row.get("first_days"),
        })
    known = [row["first_days"] for row in rows if row.get("first_days")]
    return {
        "challenges": tot("challenges"),
        "fees": dollars(tot("fees")),
        "received": dollars(tot("received")),
        "gross": dollars(tot("gross")),
        "net": dollars(tot("received") - tot("fees")),
        "payouts": tot("payouts"),
        "p1": tot("p1_pass"),
        "p2": tot("p2_pass"),
        "funded_blow": tot("fail_funded"),
        "maxdd": tot("maxdd"),
        "daily": tot("daily"),
        "pass": {
            "p1": span([item for row in rows for item in row["p1_days"]]),
            "p2": span([item for row in rows for item in row["p2_days"]]),
        },
        "years": years,
        "weekdays": weekdays,
        "left": dollars(sum(0 if not row["end_alive"] else row["end_profit"] for row in rows)),
        "end_phase": rows[0]["end_phase"] if len(rows) == 1 else None,
        "first_days": known[0] if len(rows) == 1 and known else median_days(known),
        "funded_weekdays": None if len(rows) == 1 else len(known),
    }


def run_accounts(trades, point, asof, min_green, cushion):
    rows = []
    for weekday in range(5):
        mine = [dict(trade) for trade in trades if trade["weekday"] == weekday]
        for trade in mine:
            trade["verts"] = list(trade["verts"])
        stats = {
            "weekday": DAYS[weekday],
            "trades": len(mine),
            "points": round(sum(trade["pnl"] for trade in mine), 2),
            "challenges": 0, "fees": 0, "p1_pass": 0, "p2_pass": 0,
            "fail_p1": 0, "fail_p2": 0, "fail_funded": 0,
            "maxdd": 0, "daily": 0, "payouts": 0, "gross": 0, "received": 0,
            "events": [], "seq": weekday * 100000,
            "p1_days": [], "p2_days": [],
            "first_start": None, "first_funded": None,
        }
        acct = simulate_week(mine, stats, cushion, min_green, point, asof)
        stats["net"] = stats["received"] - stats["fees"]
        stats["end_alive"] = bool(acct["alive"])
        stats["end_phase"] = acct["phase"] if acct["alive"] else "blown"
        stats["end_profit"] = 0 if not acct["alive"] else acct["balance"] - START
        note_first_days(stats)
        rows.append(stats)
    return pack_rows(rows)


def load_trades(path):
    out = []
    with open(path, newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            entry = parse_utc(row["entry_utc"])
            exit_at = parse_utc(row["exit_utc"])
            ny = date.fromisoformat(row["ny_date"])
            weekday = ny.weekday()
            if weekday > 4:
                weekday = 4
            pnl = float(row["points"])
            mae = float(row.get("mae_pts") or 0)
            hold = int(float(row.get("bars_held") or 0))
            entry_rank = entry.timestamp()
            exit_rank = max(exit_at.timestamp(), entry_rank + 2)
            verts = [(entry_rank, 0.0, False, ny)]
            if mae > 0:
                verts.append((entry_rank + 1, -mae, False, ny))
            verts.append((exit_rank, pnl, True, exit_at.date()))
            out.append({
                "weekday": weekday,
                "entry_day": ny,
                "entry_rank": entry_rank,
                "pnl": pnl,
                "hold_ok": hold >= 1 or (exit_at - entry).total_seconds() >= 60,
                "verts": verts,
            })
    return out


def trades_from_engine(eng, ev, ex, cfg):
    """Taken trades for one run, from the strategy engine already in memory."""
    packed = sr.trades_for(eng, ev, ex, cfg)
    idx = packed["idx"]
    n = int(idx.size)
    if n == 0:
        return []
    b0 = ev["bar"][idx].astype(np.int64)
    b1 = packed["ebar"].astype(np.int64)
    pnl = packed["pnl"].astype(np.float64) / float(sr.STEPS_PER_POINT)
    mae = packed["mae"].astype(np.float64) / float(sr.STEPS_PER_POINT)
    day_ord = ev["day"][idx].astype(np.int64)
    ts = eng.bars["ts"]
    out = []
    for i in range(n):
        ny = date.fromisoformat(str(np.datetime64(int(day_ord[i]), "D")))
        weekday = ny.weekday()
        if weekday > 4:
            weekday = 4
        entry_ts = float(ts[int(b0[i])])
        exit_ts = float(ts[int(b1[i])])
        exit_day = datetime.fromtimestamp(exit_ts, timezone.utc).date()
        entry_rank = entry_ts
        exit_rank = exit_ts if exit_ts > entry_rank + 2 else entry_rank + 2
        points = float(pnl[i])
        adverse = float(mae[i])
        verts = [(entry_rank, 0.0, False, ny)]
        if adverse > 0:
            verts.append((entry_rank + 1, -adverse, False, ny))
        verts.append((exit_rank, points, True, exit_day))
        out.append({
            "weekday": weekday,
            "entry_day": ny,
            "entry_rank": entry_rank,
            "pnl": points,
            "hold_ok": int(b1[i]) - int(b0[i]) >= 1 or exit_ts - entry_ts >= 60,
            "verts": verts,
        })
    return out


def analyse_trades(stem, cfg, trades, mode="week"):
    sl = int(cfg["sl"])
    lot = lot_for(sl)
    point = point_cents(stem, sl)
    if trades:
        asof = max(vert[3] for trade in trades for vert in trade["verts"])
    else:
        asof = date.today()
    runner = run_one_account if mode == "one" else run_accounts
    full = runner(trades, point, asof, SPEC["min_green"], 0)
    cushion = runner(trades, point, asof, SPEC["min_green"], 40_000)
    no_green = runner(trades, point, asof, 0, 0)
    if mode == "one":
        starts = month_study(trades, point, SPEC["min_green"])
    else:
        starts = month_study_accounts(trades, point, SPEC["min_green"])
    wins = sum(1 for trade in trades if trade["pnl"] > 0)
    return {
        "id": cfg["id"],
        "sl": sl,
        "tp": int(cfg["tp"]),
        "lot": lot,
        "usd_per_point": round(point / 100, 2),
        "stop_dollars": int(sl) * point // 100,
        "target_dollars": int(cfg["tp"]) * point // 100,
        "trades": len(trades),
        "wins": wins,
        "win_rate": round(100.0 * wins / len(trades), 1) if trades else 0,
        "net_points": round(sum(trade["pnl"] for trade in trades), 2),
        "asof": asof.isoformat(),
        "analyzed": time.time(),
        "account": full,
        "cushion_net": cushion["net"],
        "no_green_net": no_green["net"],
        "starts": starts,
        "mode": mode,
    }


def _prop_worker(csv_name, groups, result_queue, mode="week"):
    batch = []

    def flush():
        if batch:
            result_queue.put(("batch", batch[:]))
            batch.clear()

    try:
        sr.use_file(csv_name)
        stem = sr.STEM
        bars, clocks = sd.load(sr.CSV_FILE)
        eng = sr.Engine(bars, clocks, sr.data_sig())
        for (lvl, entry, sl, tp), group in groups:
            ev = eng.events(lvl)
            ex = eng.resolve(sr.ENTRY_CODE[entry], sl, tp)
            for cfg in group:
                try:
                    trades = trades_from_engine(eng, ev, ex, cfg)
                    batch.append(analyse_trades(stem, cfg, trades, mode))
                except Exception as exc:
                    batch.append({
                        "id": cfg["id"],
                        "sl": int(cfg["sl"]),
                        "tp": int(cfg["tp"]),
                        "error": f"{type(exc).__name__}: {exc}",
                        "analyzed": time.time(),
                    })
                if len(batch) >= 5:
                    flush()
            del ex
        flush()
        result_queue.put(("done", None))
    except Exception:
        flush()
        result_queue.put(("error", traceback.format_exc()))


def group_configs(cfgs):
    order = []
    groups = {}
    for cfg in cfgs:
        key = (cfg["lvl"], cfg["entry"], int(cfg["sl"]), int(cfg["tp"]))
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(cfg)
    order.sort(key=lambda key: ("all", "eth", "rth").index(key[0]))
    return [(key, groups[key]) for key in order]


def agg_days(vals):
    if not vals:
        return None
    return {"min": int(min(vals)), "max": int(max(vals)), "avg": round(sum(vals) / len(vals), 1)}


def iter_months(last):
    """First of each month from 1 Jan 2020 through the month of the last trade."""
    year, month = 2020, 1
    while True:
        origin = date(year, month, 1)
        if origin > last:
            return
        yield origin
        if month == 12:
            year += 1
            month = 1
        else:
            month += 1


def blank_stats(trades):
    return {
        "weekday": "Account",
        "trades": len(trades),
        "points": round(sum(trade["pnl"] for trade in trades), 2),
        "challenges": 0, "fees": 0, "p1_pass": 0, "p2_pass": 0,
        "fail_p1": 0, "fail_p2": 0, "fail_funded": 0,
        "maxdd": 0, "daily": 0, "payouts": 0, "gross": 0, "received": 0,
        "events": [], "seq": 0,
        "p1_days": [], "p2_days": [],
        "first_start": None, "first_funded": None,
    }


def calendar_days(origin, end):
    return (end - origin).days + 1


def note_first_days(stats):
    if stats.get("first_start") and stats.get("first_funded"):
        stats["first_days"] = calendar_days(stats["first_start"], stats["first_funded"])
    else:
        stats["first_days"] = None


def median_days(vals):
    if not vals:
        return None
    ordered = sorted(vals)
    mid = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[mid]
    return round((ordered[mid - 1] + ordered[mid]) / 2, 1)


def first_decision(trades, point, min_green, origin):
    """One fresh account, trades on or after origin, until it funds or blows."""
    stats = blank_stats(trades)
    acct = simulate_week(trades, stats, 0, min_green, point, origin, until="decision")
    if stats.get("first_funded") is not None:
        return "funded", calendar_days(origin, stats["first_funded"])
    if not acct["alive"] and stats["challenges"]:
        end = acct.get("death_day") or stats.get("first_start") or origin
        return "blown", calendar_days(origin, end)
    return "open", None


def month_study(trades, point, min_green):
    """From each month start, record only the first funded-or-blown result."""
    if not trades:
        return {"funded": 0, "blown": 0, "open": 0, "funded_days": None, "blown_days": None, "rows": []}
    last = max(trade["entry_day"] for trade in trades)
    rows = []
    funded_days = []
    blown_days = []
    for origin in iter_months(last):
        mine = [trade for trade in trades if trade["entry_day"] >= origin]
        if not mine:
            continue
        result, days = first_decision(mine, point, min_green, origin)
        rows.append([origin.isoformat(), result, days])
        if result == "funded":
            funded_days.append(days)
        elif result == "blown":
            blown_days.append(days)
    return {
        "funded": len(funded_days),
        "blown": len(blown_days),
        "open": sum(1 for row in rows if row[1] == "open"),
        "funded_days": agg_days(funded_days),
        "blown_days": agg_days(blown_days),
        "rows": rows,
        "layout": "one",
    }


def month_study_accounts(trades, point, min_green):
    """Five weekday accounts. Each month starts them again and stops each one
    at its own first funded or blown result."""
    if not trades:
        return {"layout": "week", "funded": 0, "blown": 0, "open": 0, "funded_days": None, "blown_days": None, "rows": []}
    last = max(trade["entry_day"] for trade in trades)
    rows = []
    funded_days = []
    blown_days = []
    for origin in iter_months(last):
        cells = []
        any_trade = False
        for weekday in range(5):
            mine = [trade for trade in trades if trade["weekday"] == weekday and trade["entry_day"] >= origin]
            if not mine:
                cells.append(None)
                continue
            any_trade = True
            result, days = first_decision(mine, point, min_green, origin)
            cells.append([result, days])
            if result == "funded":
                funded_days.append(days)
            elif result == "blown":
                blown_days.append(days)
        if not any_trade:
            continue
        rows.append([
            origin.isoformat(),
            sum(1 for cell in cells if cell and cell[0] == "funded"),
            sum(1 for cell in cells if cell and cell[0] == "blown"),
            sum(1 for cell in cells if cell and cell[0] == "open"),
            cells,
        ])
    return {
        "layout": "week",
        "funded": len(funded_days),
        "blown": len(blown_days),
        "open": sum(row[3] for row in rows),
        "funded_days": agg_days(funded_days),
        "blown_days": agg_days(blown_days),
        "rows": rows,
    }


def run_one_account(trades, point, asof, min_green, cushion):
    """One account, every weekday, in trade order.

    A blow ends that account. The next trade buys another and starts again at
    phase 1. A pass or a payout stays on the same account.
    """
    mine = [dict(trade) for trade in trades]
    for trade in mine:
        trade["verts"] = list(trade["verts"])
    stats = {
        "weekday": "Account",
        "trades": len(mine),
        "points": round(sum(trade["pnl"] for trade in mine), 2),
        "challenges": 0, "fees": 0, "p1_pass": 0, "p2_pass": 0,
        "fail_p1": 0, "fail_p2": 0, "fail_funded": 0,
        "maxdd": 0, "daily": 0, "payouts": 0, "gross": 0, "received": 0,
        "events": [], "seq": 0,
        "p1_days": [], "p2_days": [],
        "first_start": None, "first_funded": None,
    }
    acct = simulate_week(mine, stats, cushion, min_green, point, asof)
    stats["net"] = stats["received"] - stats["fees"]
    stats["end_alive"] = bool(acct["alive"])
    stats["end_phase"] = acct["phase"] if acct["alive"] else "blown"
    stats["end_profit"] = 0 if not acct["alive"] else acct["balance"] - START
    note_first_days(stats)
    return pack_rows([stats])


def paths_for(stem, mode="week"):
    base = RESULTS / stem
    if mode == "one":
        return base / "prop2.json", base / "progress2.json"
    return base / "prop.json", base / "progress.json"


def load_store(path):
    if not path.exists():
        return {"version": VERSION, "runs": {}}
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    data.setdefault("runs", {})
    return data


def write_progress(path, done, total, current, phase, running):
    atomic_json(path, {
        "running": running,
        "done": done,
        "total": total,
        "current": current,
        "phase": phase,
        "updated": time.time(),
    })


def main(mode="week"):
    if mode not in ("week", "one"):
        raise SystemExit(f"unknown account mode {mode}")
    parser = argparse.ArgumentParser()
    parser.add_argument("--file", required=True)
    parser.add_argument("--ids", default="")
    parser.add_argument("--ids-file")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--workers", type=int, default=1, help="processes, 1 to 4")
    args = parser.parse_args()
    csv_name = Path(args.file).name
    stem = Path(csv_name).stem
    sr.use_file(csv_name)
    ids = [part.strip() for part in args.ids.split(",") if part.strip()]
    if args.ids_file:
        ids.extend(line.strip() for line in open(args.ids_file, encoding="utf-8") if line.strip())
    if not ids:
        raise SystemExit("give --ids or --ids-file")
    store_path, progress_path = paths_for(stem, mode)
    store = load_store(store_path)
    store["version"] = VERSION
    store["file"] = csv_name
    cfgs = []
    seen = set()
    for run_id in ids:
        if run_id in seen:
            continue
        seen.add(run_id)
        cfg = sr.ensure_open(sc.parse_id(run_id))
        cfg["id"] = run_id
        cached = store["runs"].get(run_id)
        if not args.force and cached and not cached.get("error") and cached.get("lot") == lot_for(int(cfg["sl"])):
            continue
        cfgs.append(cfg)
    total = len(cfgs)
    if total == 0:
        write_progress(progress_path, 0, 0, "", "nothing to do", False)
        print("nothing to do", flush=True)
        return
    groups = group_configs(cfgs)
    buckets = sr.assign_groups(groups, args.workers)
    n_workers = 1 if buckets is None else len(buckets)
    write_progress(progress_path, 0, total, "", "loading bars", True)
    print(f"loading {csv_name} · {total} runs · {n_workers} processors", flush=True)
    tick = {"done": 0}
    done = 0
    failed = 0

    def hook(lvl, step, steps, cached):
        if cached:
            phase = f"{lvl} levels cached"
        elif steps:
            phase = f"building {lvl} levels {step}/{steps}"
        else:
            phase = f"building {lvl} levels"
        write_progress(progress_path, tick["done"], total, "", phase, True)

    def accept(row):
        nonlocal done, failed
        store["runs"][row["id"]] = row
        done += 1
        tick["done"] = done
        if row.get("error"):
            failed += 1
            print(f"analyse {done}/{total} {row['id']} failed {row['error']}", flush=True)
        elif done % 10 == 0 or done == total:
            print(f"analyse {done}/{total} {row['id']} net {row['account']['net']}", flush=True)
        if done % 10 == 0 or done == total:
            store["built"] = time.time()
            atomic_json(store_path, store)
            write_progress(progress_path, done, total, row["id"], f"{n_workers} processors", True)

    try:
        if buckets is None:
            bars, clocks = sd.load(sr.CSV_FILE)
            eng = sr.Engine(bars, clocks, sr.data_sig(), progress=hook)
            print(f"{len(bars['ts'])} bars · {total} runs", flush=True)
            for (lvl, entry, sl, tp), group in groups:
                ev = eng.events(lvl)
                ex = eng.resolve(sr.ENTRY_CODE[entry], sl, tp)
                for cfg in group:
                    try:
                        trades = trades_from_engine(eng, ev, ex, cfg)
                        accept(analyse_trades(stem, cfg, trades, mode))
                    except Exception as exc:
                        accept({
                            "id": cfg["id"],
                            "sl": int(cfg["sl"]),
                            "tp": int(cfg["tp"]),
                            "error": f"{type(exc).__name__}: {exc}",
                            "analyzed": time.time(),
                        })
                del ex
        else:
            sr.prepare_levels([key[0] for key, _group in groups])
            from multiprocessing import get_context
            ctx = get_context("spawn")
            result_queue = ctx.Queue()
            procs = [
                ctx.Process(target=_prop_worker, args=(csv_name, bucket, result_queue, mode))
                for bucket in buckets
            ]
            for proc in procs:
                proc.start()
            sr.collect_workers(procs, result_queue, lambda batch: [accept(row) for row in batch])
    except Exception as exc:
        write_progress(progress_path, done, total, "", f"failed: {exc}", False)
        store["built"] = time.time()
        atomic_json(store_path, store)
        raise
    write_progress(progress_path, total, total, "", "done", False)
    print(f"wrote {store_path} · analysed {total} · stored {len(store['runs'])} · {failed} failed", flush=True)


def _self_check():
    trades = []
    start = date(2020, 1, 6)
    for i in range(40):
        day = start + timedelta(days=7 * i)
        rank = i * 10
        trades.append({
            "weekday": 0,
            "entry_day": day,
            "entry_rank": rank,
            "pnl": 50.0,
            "hold_ok": True,
            "verts": [(rank, 0.0, False, day), (rank + 1, 50.0, True, day)],
        })
    packed = run_accounts(trades, 100, date(2021, 1, 1), 3, 0)
    assert packed["p1"] >= 1 and packed["p2"] >= 1 and packed["received"] > 0, packed
    assert packed["funded_weekdays"] == 1 and packed["first_days"], packed
    blow = [{
        "weekday": 0,
        "entry_day": date(2020, 1, 6),
        "entry_rank": 1,
        "pnl": -50.0,
        "hold_ok": True,
        "verts": [(1, 0.0, False, date(2020, 1, 6)), (2, -400.0, False, date(2020, 1, 6)), (3, -50.0, True, date(2020, 1, 6))],
    }]
    dead = run_accounts(blow, 100, date(2020, 2, 1), 3, 0)
    assert dead["daily"] + dead["maxdd"] == 1, dead
    one = run_one_account(trades, 100, date(2021, 1, 1), 3, 0)
    assert one["net"] == packed["net"] and one["payouts"] == packed["payouts"], one
    assert one["challenges"] == packed["challenges"], one
    pair = []
    for weekday, day in ((0, date(2020, 1, 6)), (1, date(2020, 1, 7))):
        pair.append({
            "weekday": weekday,
            "entry_day": day,
            "entry_rank": weekday + 1,
            "pnl": 10.0,
            "hold_ok": True,
            "verts": [(weekday + 1, 0.0, False, day), (weekday + 2, 10.0, True, day)],
        })
    split = run_accounts(pair, 100, date(2020, 2, 1), 3, 0)
    single = run_one_account(pair, 100, date(2020, 2, 1), 3, 0)
    assert split["challenges"] == 2 and split["fees"] == 44, split
    assert single["challenges"] == 1 and single["fees"] == 22, single
    assert single["end_phase"] == "p1", single
    blow_day = date(2020, 1, 6)
    winners = []
    funded_day = date(2020, 2, 3) + timedelta(days=7 * 12)
    for i in range(13):
        day = date(2020, 2, 3) + timedelta(days=7 * i)
        rank = 100 + i
        winners.append({
            "weekday": day.weekday(),
            "entry_day": day,
            "entry_rank": rank,
            "pnl": 50.0,
            "hold_ok": True,
            "verts": [(rank, 0.0, False, day), (rank + 0.5, 50.0, True, day)],
        })
    series = [{
        "weekday": 0,
        "entry_day": blow_day,
        "entry_rank": 1,
        "pnl": -50.0,
        "hold_ok": True,
        "verts": [(1, 0.0, False, blow_day), (1.2, -400.0, False, blow_day), (1.4, -50.0, True, blow_day)],
    }] + winners
    joined = run_one_account(series, 100, date(2020, 6, 1), 3, 0)
    assert joined["challenges"] == 2, joined
    assert joined["first_days"] == calendar_days(blow_day, funded_day), joined
    study = month_study(series, 100, 3)
    by_month = {row[0]: row for row in study["rows"]}
    assert by_month["2020-01-01"] == ["2020-01-01", "blown", calendar_days(date(2020, 1, 1), blow_day)], by_month
    assert by_month["2020-02-01"] == ["2020-02-01", "funded", calendar_days(date(2020, 2, 1), funded_day)], by_month
    assert study["funded"] >= 1 and study["blown"] == 1, study
    quiet = [{
        "weekday": 0,
        "entry_day": date(2020, 3, 2),
        "entry_rank": 1,
        "pnl": 10.0,
        "hold_ok": True,
        "verts": [(1, 0.0, False, date(2020, 3, 2)), (2, 10.0, True, date(2020, 3, 2))],
    }]
    quiet_study = month_study(quiet, 100, 3)
    assert quiet_study["rows"] == [
        ["2020-01-01", "open", None],
        ["2020-02-01", "open", None],
        ["2020-03-01", "open", None],
    ], quiet_study
    assert quiet_study["funded"] == 0 and quiet_study["blown"] == 0, quiet_study
    monday = [dict(trade, weekday=0) for trade in winners]
    tuesday = {
        "weekday": 1,
        "entry_day": date(2020, 1, 7),
        "entry_rank": 2,
        "pnl": -50.0,
        "hold_ok": True,
        "verts": [(2, 0.0, False, date(2020, 1, 7)), (2.2, -400.0, False, date(2020, 1, 7)), (2.4, -50.0, True, date(2020, 1, 7))],
    }
    split_days = run_accounts(monday + [tuesday], 100, date(2020, 6, 1), 3, 0)
    assert split_days["funded_weekdays"] == 1, split_days
    assert split_days["first_days"] == calendar_days(date(2020, 2, 3), funded_day), split_days
    week_study = month_study_accounts(monday + [tuesday], 100, 3)
    january = next(row for row in week_study["rows"] if row[0] == "2020-01-01")
    assert january[4][0][0] == "funded" and january[4][1] == ["blown", calendar_days(date(2020, 1, 1), date(2020, 1, 7))], january
    assert week_study["funded"] >= 1 and week_study["blown"] >= 1, week_study
    print("self-check ok", packed["net"], packed["payouts"], single["fees"], joined["first_days"])


if __name__ == "__main__":
    if len(sys.argv) == 1:
        _self_check()
    else:
        main()
