"""Weekday prop-firm replay for the fade run and two continuation runs.

Reaching $4,600, or that day's 4% floor, blows the account.
The sl50 run is 0.10 lot: 50 index points = $100.
The sl100 runs are 0.09 lot: 100 index points = $180, so a stop from $5,000 ends at $4,820.
"""

from __future__ import annotations

import json
from datetime import date, datetime, timezone
from heapq import heappop, heappush
from pathlib import Path

import numpy as np
import pandas as pd

import backtest as b
import continue_report as cont
import prop_sim

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "results" / "prop_weekday_accounts.html"
DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]
ASOF = np.datetime64("2026-10-26")
START = 500_000
FLOOR = 460_000
POINT = 200
PHASE1 = 40_000
PHASE2 = 25_000
QUALIFY = 2_500
MIN_PAY = 2_000
FEE = 2_200


def cents(points: float, point: int = POINT) -> int:
    return int(round(float(points) * point))


def band(ref: int, pct: int) -> int:
    return (ref * pct + 50) // 100


def day_floor(ref: int, pct: int) -> int:
    return ref - band(ref, pct)


def dd_floor(hwm: int, pct: int) -> int:
    return hwm - band(hwm, pct)


# 2-step keeps the checked rules. 1-step and 3-step follow the firm's other schedules.
# A payout returns the balance to $5,000. On the trailing account that also starts the floor again.
SPECS = (
    {
        "id": "2step",
        "name": "2-step",
        "fee": 2_200,
        "price": 22,
        "daily_pct": 4,
        "dd_mode": "static",
        "dd_pct": 8,
        "targets": (40_000, 25_000),
        "min_green": 3,
        "summary": (
            "$22. Phase 1 needs $400 and 3 days of at least $25. Phase 2 needs $250 and 3 such days. "
            "Daily loss is 4%. The static floor is $4,600."
        ),
    },
    {
        "id": "1step",
        "name": "1-step",
        "fee": 1_900,
        "price": 19,
        "daily_pct": 3,
        "dd_mode": "trail",
        "dd_pct": 5,
        "targets": (40_000,),
        "min_green": 0,
        "summary": (
            "$19. One phase needs $400. There is no minimum number of days. Daily loss is 3%. "
            "The maximum drawdown is 5% of the highest equity, including open profit, and it only moves up. "
            "It starts at $4,750. A payout returns the balance to $5,000 and starts that trail again."
        ),
    },
    {
        "id": "3step",
        "name": "3-step",
        "fee": 1_700,
        "price": 17,
        "daily_pct": 2,
        "dd_mode": "static",
        "dd_pct": 3,
        "targets": (15_000, 15_000, 15_000),
        "min_green": 0,
        "summary": (
            "$17. Each of the three phases needs $150. There is no minimum number of days. "
            "Daily loss is 2%, so a flat $5,000 day breaches at $4,900. The static floor is $4,850."
        ),
    },
)
PHASE_INDEX = {"p1": 0, "p2": 1, "p3": 2}
FAIL_KEY = {"p1": "fail_p1", "p2": "fail_p2", "p3": "fail_p3", "funded": "fail_funded"}


def initial_floor(spec) -> int:
    return dd_floor(START, spec["dd_pct"])


def ymd_weekday(ymd: int) -> int:
    return date(ymd // 10000, (ymd // 100) % 100, ymd % 100).weekday()


def day_of_ms(ms: int) -> np.datetime64:
    text = datetime.fromtimestamp(ms / 1000.0, timezone.utc).strftime("%Y-%m-%d")
    return np.datetime64(text)


def stamp(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000.0, timezone.utc).strftime("%Y-%m-%d %H:%M")


def build_touch(records, look_days, ts, o, h, l, c, clock, block_low, block_high):
    for i, row in enumerate(records):
        row["cents_id"] = i
    expire_i = np.array([b.expire_index(ts, row["close_ts"], look_days) for row in records], dtype=np.int32)
    tradable = clock["in_ny"] | clock["in_lon"]
    slices = b.day_slices(clock["ny_ymd"], tradable)
    touches = []
    cursor = 0
    for ymd, day_start, bars in slices:
        while cursor < len(records) and records[cursor]["ready_i"] <= day_start:
            cursor += 1
        prices, cents_book, labels, _kinds = b.active_book(records[:cursor], day_start, expire_i)
        if len(prices) == 0:
            continue
        for bar in bars:
            prev = None if bar == 0 else c[bar - 1]
            points = b.bar_points(prev, o[bar], h[bar], l[bar], c[bar])
            if len(points) < 2:
                continue
            for seg, left, right, price, cent, side in b.crosses(points, prices, cents_book):
                fill = right if (seg == 0 and prev is not None and prev != o[bar] and price != right) else price
                if fill == right and price != right:
                    entry_rank = b.pos_rank(bar, seg, left, right, right) - (abs(right - price) * 1e-6)
                else:
                    entry_rank = b.pos_rank(bar, seg, left, right, price)
                cont_side = -side
                touches.append(
                    {
                        "ymd": ymd,
                        "bar": int(bar),
                        "ts": int(ts[bar]),
                        "rank": entry_rank,
                        "cent": cent,
                        "price": price,
                        "side": cont_side,
                        "fill": fill,
                        "in_ny": bool(clock["in_ny"][bar]),
                        "in_rth": bool(clock["in_rth"][bar]),
                        "in_lon": bool(clock["in_lon"][bar]),
                        "sources": labels.get(cent, []),
                        "exits": cont.slots_for(
                            cont_side, fill, int(bar), seg, points, o, h, l, c, block_low, block_high
                        ),
                    }
                )
    return touches


def entry_segment(bar, entry_rank, o, h, l, c):
    """The touch rank encodes the segment. Continuation entries run against the cross."""
    prev = None if bar == 0 else float(c[bar - 1])
    points = b.bar_points(prev, float(o[bar]), float(h[bar]), float(l[bar]), float(c[bar]))
    if len(points) < 2:
        return points, 0
    seg = int(np.floor(entry_rank - bar * 10.0 + 1e-6))
    seg = min(max(seg, 0), len(points) - 2)
    return points, seg


def walk_vertices(bar0, points, seg, fill, side, sl, tp, entry_rank, o, h, l, c):
    stop = fill - sl * side
    target = fill + tp * side
    verts = [(float(entry_rank), 0.0, False, int(bar0))]

    def add(bar, seg_i, left, right, price, is_exit):
        rank = b.pos_rank(bar, seg_i, left, right, price)
        verts.append((float(rank), side * (price - fill), is_exit, int(bar)))

    def traverse(left, right, bar, seg_i):
        hit = b.first_hit(left, right, stop, target)
        end = hit[1] if hit else right
        add(bar, seg_i, left, right, end, hit is not None)
        return hit[0] if hit else None

    right = points[seg + 1]
    if fill != right:
        kind = traverse(fill, right, bar0, seg)
        if kind:
            return kind, bar0, verts
    local = seg + 1
    last = right
    for price in points[seg + 2 :]:
        kind = traverse(last, price, bar0, local)
        if kind:
            return kind, bar0, verts
        local += 1
        last = price
    prev_close = float(c[bar0])
    j = bar0 + 1
    while j < len(o):
        oj, hj, lj, cj = (float(o[j]), float(h[j]), float(l[j]), float(c[j]))
        seg_i = 0
        if prev_close != oj:
            kind = traverse(prev_close, oj, j, seg_i)
            if kind:
                return kind, j, verts
            seg_i = 1
        seq = (oj, lj, hj, cj) if cj >= oj else (oj, hj, lj, cj)
        left = oj
        for price in seq[1:]:
            if price != left:
                kind = traverse(left, price, j, seg_i)
                if kind:
                    return kind, j, verts
                seg_i += 1
                left = price
        prev_close = cj
        j += 1
    return "end of data", len(o) - 1, verts


def pack_trades(pairs, sl, tp, ts, o, h, l, c):
    """pairs are (touch, done) from backtest.simulate."""
    out = []
    bad = 0
    for touch, done in pairs:
        side = int(touch["side"])
        fill = float(touch["fill"])
        i0 = int(touch["bar"])
        i1 = int(done["bar"])
        points, seg = entry_segment(i0, float(touch["rank"]), o, h, l, c)
        kind, bar, verts = walk_vertices(
            i0, points, seg, fill, side, sl, tp, touch["rank"], o, h, l, c
        )
        won = float(done["pnl"]) > 0
        matched = None
        if bar == i1 and ((kind == "target" and won) or (kind == "stop" and not won)):
            matched = verts
        if matched is None:
            bad += 1
            if bad == 1:
                print(
                    "  first mismatch",
                    "side", side,
                    "fill", fill,
                    "seg", seg,
                    "walk", kind, bar,
                    "done", int(done["bar"]), float(done["pnl"]),
                    "points", points,
                )
            matched = [
                (float(touch["rank"]), 0.0, False, i0),
                (float(done["rank"]), float(done["pnl"]), True, i1),
            ]
        held = (int(ts[i1]) - int(ts[i0])) / 1000.0
        out.append(
            {
                "weekday": ymd_weekday(int(touch["ymd"])),
                "entry_day": str(day_of_ms(int(ts[i0]))),
                "exit_day": str(day_of_ms(int(ts[i1]))),
                "entry_rank": float(touch["rank"]),
                "pnl": float(done["pnl"]),
                "hold_ok": held >= 60.0,
                "verts": matched,
            }
        )
    overlaps = 0
    by_day = {}
    for trade in out:
        by_day.setdefault(trade["weekday"], []).append(trade)
    for group in by_day.values():
        group.sort(key=lambda item: item["entry_rank"])
        for left, right in zip(group, group[1:]):
            exit_bar = left["verts"][-1][3]
            entry_bar = right["verts"][0][3]
            if exit_bar > entry_bar:
                overlaps += 1
    return out, bad, overlaps


def fresh(spec):
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
        "floor": initial_floor(spec),
    }


def ratio_ok(acct) -> bool:
    return acct["hold_n"] == 0 or acct["hold_ok"] * 2 >= acct["hold_n"]


def payout(acct, asof, cushion, stats, spec, min_green):
    if not acct["alive"] or acct["phase"] != "funded" or acct["due"] is None or acct["open"]:
        return
    if np.datetime64(asof) < np.datetime64(acct["due"]):
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
    acct["floor"] = initial_floor(spec)
    acct["ref"] = START
    stats["payouts"] += 1
    stats["gross"] += withdraw
    stats["received"] += received
    stats["events"].append({"date": str(asof)[:10], "kind": "payout", "gross": withdraw, "received": received})


def equity(acct, point: int) -> int:
    return acct["balance"] + cents(sum(acct["open"].values()), point)


def die(acct, stats, reason):
    if not acct["alive"]:
        return
    stats[reason] += 1
    stats[FAIL_KEY[acct["phase"]]] += 1
    acct["alive"] = False
    acct["open"].clear()
    acct["heap"].clear()


def touch_hwm(acct, eq, spec):
    if spec["dd_mode"] == "trail" and eq > acct["hwm"]:
        acct["hwm"] = eq
        acct["floor"] = dd_floor(eq, spec["dd_pct"])


def breached(acct, stats, spec, eq) -> bool:
    """Reaching the daily line or the maximum-drawdown line blows the account."""
    daily = day_floor(acct["ref"], spec["daily_pct"])
    floor = acct["floor"]
    if eq > floor and eq > daily:
        return False
    if eq <= floor and floor >= daily:
        die(acct, stats, "maxdd")
    else:
        die(acct, stats, "daily")
    return True


def roll(acct, stats, new_day, point: int, spec):
    if acct["day"] is None:
        acct["day"] = new_day
        acct["ref"] = acct["balance"]
        return
    if new_day <= acct["day"]:
        return
    eq = equity(acct, point)
    day = acct["day"] + np.timedelta64(1, "D")
    while day <= new_day:
        touch_hwm(acct, eq, spec)
        ref = eq if eq > acct["balance"] else acct["balance"]
        acct["ref"] = ref
        if breached(acct, stats, spec, eq):
            return
        day = day + np.timedelta64(1, "D")
    acct["day"] = new_day


def book(acct, trade, stats, cushion, min_green, bar_day, point: int, spec):
    acct["balance"] += cents(trade["pnl"], point)
    acct["open"].pop(trade["id"], None)
    acct["max_profit"] = max(acct["max_profit"], acct["balance"] - START)
    exit_day = str(bar_day)[:10]
    acct["day_pnl"][exit_day] = acct["day_pnl"].get(exit_day, 0) + cents(trade["pnl"], point)
    if acct["day_pnl"][exit_day] >= QUALIFY and exit_day not in acct["green_days"]:
        acct["green"] += 1
        acct["green_days"].add(exit_day)
    acct["phase_trades"] += 1
    phase_at_entry = trade["phase"]
    # A still-open trade from last week belongs to this account. The next phase
    # starts only once that position has closed and the target is still met.
    if acct["open"]:
        if phase_ready(acct, spec, min_green):
            stats["held_flat"] += 1
        return
    idx = PHASE_INDEX.get(acct["phase"])
    if idx is not None and phase_ready(acct, spec, min_green):
        remember_pass(acct, stats, f"p{idx + 1}_days", exit_day)
        nxt = "funded" if idx + 1 == len(spec["targets"]) else ("p2", "p3")[idx]
        reset_phase(acct, nxt, spec)
        stats[f"p{idx + 1}_pass"] += 1
    elif phase_at_entry == "funded" and acct["phase"] == "funded":
        payout(acct, exit_day, cushion, stats, spec, min_green)


def remember_pass(acct, stats, key, exit_day):
    start = np.datetime64(acct["phase_start"])
    end = np.datetime64(str(exit_day)[:10])
    calendar = int((end - start) / np.timedelta64(1, "D")) + 1
    stats[key].append({"calendar": calendar, "trades": acct["phase_trades"]})


def phase_ready(acct, spec, min_green) -> bool:
    idx = PHASE_INDEX.get(acct["phase"])
    if idx is None or idx >= len(spec["targets"]):
        return False
    if not ratio_ok(acct) or acct["green"] < min_green:
        return False
    return acct["balance"] - START >= spec["targets"][idx]


def reset_phase(acct, phase, spec):
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
    acct["floor"] = initial_floor(spec)


def simulate_week(trades, stats, cushion, min_green, bar_day, point: int, spec):
    trades = sorted(trades, key=lambda item: item["entry_rank"])
    acct = fresh(spec)
    acct["alive"] = False

    def drain_until(limit):
        while acct["alive"] and acct["heap"] and acct["heap"][0][0] < limit:
            _rank, _n, trade, unreal, is_exit, bar = heappop(acct["heap"])
            if not acct["alive"]:
                return
            roll(acct, stats, bar_day[bar], point, spec)
            if not acct["alive"]:
                return
            acct["open"][trade["id"]] = unreal
            eq = equity(acct, point)
            touch_hwm(acct, eq, spec)
            if breached(acct, stats, spec, eq):
                return
            if is_exit:
                book(acct, trade, stats, cushion, min_green, bar_day[bar], point, spec)

    for trade in trades:
        if acct["alive"]:
            drain_until(trade["entry_rank"])
        if not acct["alive"]:
            acct = fresh(spec)
            stats["challenges"] += 1
            stats["fees"] += spec["fee"]
            stats["events"].append({"date": trade["entry_day"], "kind": "fee", "fee": spec["fee"]})
        if acct["phase"] == "funded" and acct["due"] is None:
            acct["due"] = str(np.busday_offset(np.datetime64(trade["entry_day"]), 10))
        elif acct["phase"] == "funded" and acct["due"] is not None and not acct["open"]:
            if np.datetime64(acct["due"]) < np.datetime64(trade["entry_day"]):
                payout(acct, acct["due"], cushion, stats, spec, min_green)
        acct["hold_n"] += 1
        if trade["hold_ok"]:
            acct["hold_ok"] += 1
        if acct["phase_start"] is None:
            acct["phase_start"] = trade["entry_day"]
        trade["phase"] = acct["phase"]
        trade["id"] = stats["seq"]
        stats["seq"] += 1
        for rank, unreal, is_exit, bar in trade["verts"]:
            acct["seq"] += 1
            heappush(acct["heap"], (rank, acct["seq"], trade, unreal, is_exit, bar))
    if acct["alive"]:
        drain_until(1e18)
    if acct["alive"] and acct["phase"] == "funded":
        payout(acct, str(ASOF), cushion, stats, spec, min_green)
    return acct


def run_prop(trades, cushion, min_green, bar_day, point: int, spec):
    by_day = {i: [dict(trade) for trade in trades if trade["weekday"] == i] for i in range(5)}
    rows = []
    for weekday in range(5):
        mine = by_day[weekday]
        stats = {
            "weekday": DAYS[weekday],
            "trades": len(mine),
            "points": round(sum(trade["pnl"] for trade in mine), 1),
            "challenges": 0,
            "fees": 0,
            "p1_pass": 0,
            "p2_pass": 0,
            "p3_pass": 0,
            "fail_p1": 0,
            "fail_p2": 0,
            "fail_p3": 0,
            "fail_funded": 0,
            "maxdd": 0,
            "daily": 0,
            "payouts": 0,
            "gross": 0,
            "received": 0,
            "events": [],
            "seq": weekday * 100000,
            "hold_short": sum(1 for trade in mine if not trade["hold_ok"]),
            "held_flat": 0,
            "p1_days": [],
            "p2_days": [],
            "p3_days": [],
        }
        # copy verts so heap tags don't alias across cushion variants
        cloned = []
        for trade in mine:
            cloned.append({key: trade[key] for key in trade})
        acct = simulate_week(cloned, stats, cushion, min_green, bar_day, point, spec)
        profit = 0 if not acct["alive"] else acct["balance"] - START
        stats["end"] = {
            "alive": bool(acct["alive"]),
            "phase": acct["phase"] if acct["alive"] else "blown",
            "balance": round((acct["balance"] if acct["alive"] else acct["floor"]) / 100, 2),
            "green": 0 if not acct["alive"] else acct["green"],
            "due": None if not acct["alive"] else acct["due"],
            "profit": round(profit / 100, 2),
            "max_profit": round((0 if not acct["alive"] else acct["max_profit"]) / 100, 2),
            "floor": round(acct["floor"] / 100, 2),
            "hwm": round(acct["hwm"] / 100, 2),
        }
        stats["net"] = stats["received"] - stats["fees"]
        rows.append(stats)
    if cushion == 0 and min_green == spec["min_green"]:
        held = sum(row["held_flat"] for row in rows)
        if held:
            print(f"  phase pass waited for a flat account {held} times", flush=True)
    return rows


def dollars(value):
    return round(value / 100, 2)


def pack(rows):
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
        years.append(
            {
                "year": year,
                "fees": dollars(yearly[year]["fees"]),
                "payouts": yearly[year]["payouts"],
                "gross": dollars(yearly[year]["gross"]),
                "received": dollars(yearly[year]["received"]),
                "net": dollars(net),
                "cumulative": dollars(cum),
            }
        )

    def tot(key):
        return sum(row[key] for row in rows)

    weekdays = []
    for row in rows:
        weekdays.append(
            {
                "weekday": row["weekday"],
                "trades": row["trades"],
                "points": row["points"],
                "challenges": row["challenges"],
                "p1": row["p1_pass"],
                "p2": row["p2_pass"],
                "p3": row["p3_pass"],
                "funded": row["fail_funded"],
                "fees": dollars(row["fees"]),
                "payouts": row["payouts"],
                "received": dollars(row["received"]),
                "net": dollars(row["net"]),
                "maxdd": row["maxdd"],
                "daily": row["daily"],
                "end": row["end"],
            }
        )
    return {
        "challenges": tot("challenges"),
        "fees": dollars(tot("fees")),
        "received": dollars(tot("received")),
        "gross": dollars(tot("gross")),
        "net": dollars(tot("received") - tot("fees")),
        "payouts": tot("payouts"),
        "p1": tot("p1_pass"),
        "p2": tot("p2_pass"),
        "p3": tot("p3_pass"),
        "funded": tot("fail_funded"),
        "maxdd": tot("maxdd"),
        "daily": tot("daily"),
        "pass": summarize_pass(rows),
        "years": years,
        "weekdays": weekdays,
    }


def summarize_pass(rows):
    def pack_span(items):
        if not items:
            return {"n": 0, "calendar": None, "trading": None}
        calendar = [item["calendar"] for item in items]
        trading = [item["trades"] for item in items]

        def agg(vals):
            return {"min": int(min(vals)), "max": int(max(vals)), "avg": round(sum(vals) / len(vals), 1)}

        return {"n": len(items), "calendar": agg(calendar), "trading": agg(trading)}

    def gather(key):
        return [item for row in rows for item in row[key]]

    return {"p1": pack_span(gather("p1_days")), "p2": pack_span(gather("p2_days")), "p3": pack_span(gather("p3_days"))}


def load_sl50(ts, o, h, l, c):
    """Stored fade trades, walked on the same path the continuation runs use."""
    rows = prop_sim.load_run()
    out = []
    bad = 0
    for row in rows:
        side = 1 if row[7] else -1
        fill = float(row[9])
        i0 = prop_sim.bar_index(ts, row[1])
        i1 = prop_sim.bar_index(ts, row[2])
        points, segs = prop_sim.candidates(i0, fill, side, o, h, l, c)
        matched = None
        entry_rank = i0 * 10.0
        for seg in segs:
            entry_rank = i0 * 10.0 + seg
            kind, bar, verts = walk_vertices(i0, points, seg, fill, side, 50.0, 50.0, entry_rank, o, h, l, c)
            won = row[14] > 0
            if bar == i1 and ((kind == "target" and won) or (kind == "stop" and not won)):
                matched = verts
                break
        if matched is None:
            bad += 1
            pnl = 50.0 if row[14] > 0 else -50.0
            matched = [(entry_rank, 0.0, False, i0), (i1 * 10.0 + 9.0, pnl, True, i1)]
        held = (
            datetime.strptime(row[2], "%Y-%m-%d %H:%M") - datetime.strptime(row[1], "%Y-%m-%d %H:%M")
        ).total_seconds()
        out.append(
            {
                "weekday": int(row[3]),
                "entry_day": row[1][:10],
                "entry_rank": float(matched[0][0]),
                "pnl": 50.0 if row[14] > 0 else -50.0,
                "hold_ok": held >= 60.0,
                "verts": matched,
            }
        )
    return out, bad


def finish_account(trades, bar_day, point, spec, loss):
    full = pack(run_prop(trades, 0, spec["min_green"], bar_day, point, spec))
    cushion = pack(run_prop(trades, 40_000, spec["min_green"], bar_day, point, spec))
    if spec["min_green"]:
        no_green = pack(run_prop(trades, 0, 0, bar_day, point, spec))["net"]
    else:
        no_green = full["net"]
    for row in full["weekdays"]:
        row["loss"] = loss
    full.update(
        {
            "id": spec["id"],
            "name": spec["name"],
            "price": spec["price"],
            "summary": spec["summary"],
            "dd_mode": spec["dd_mode"],
            "floor0": round(initial_floor(spec) / 100, 2),
            "nphase": len(spec["targets"]),
            "min_green": spec["min_green"],
            "daily_pct": spec["daily_pct"],
            "cushion": {
                "challenges": cushion["challenges"],
                "fees": cushion["fees"],
                "payouts": cushion["payouts"],
                "received": cushion["received"],
                "net": cushion["net"],
            },
            "no_green_net": no_green,
        }
    )
    return full


def build_run(name, label, blurb, trades, bar_day, point, loss, min_win):
    print(name, flush=True)
    accounts = []
    for spec in SPECS:
        account = finish_account(trades, bar_day, point, spec, loss)
        accounts.append(account)
        print(
            f"  {spec['name']}: net {account['net']} fees {account['fees']} received {account['received']} "
            f"ch {account['challenges']} maxdd {account['maxdd']} daily {account['daily']} "
            f"p1 {account['p1']} p2 {account['p2']} p3 {account['p3']} cushion {account['cushion']['net']}",
            flush=True,
        )
        show_pass(account)
    return {
        "id": name,
        "label": label,
        "blurb": blurb,
        "loss": loss,
        "min_win": min_win,
        "accounts": accounts,
    }


PAGE = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Weekday prop accounts</title>
<style>
  body { margin: 0; font: 15px/1.5 Georgia, "Times New Roman", serif; background: #f4f1ea; color: #1c1a17; }
  main { max-width: 1080px; margin: 0 auto; padding: 28px 20px 80px; }
  h1 { font-size: 28px; margin: 0 0 8px; }
  h2 { font-size: 20px; margin: 32px 0 8px; }
  p, li { max-width: 78ch; }
  label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
  select { font: 15px Consolas, monospace; padding: 8px; max-width: 100%; }
  .filters { display: grid; grid-template-columns: 1.4fr 0.8fr; gap: 12px; margin: 14px 0; }
  .note, .risk { background: #fff6e8; border: 1px solid #e6d3b0; padding: 12px 14px; }
  .risk { margin-top: 12px; }
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin: 16px 0; }
  .card { background: white; border: 1px solid #ddd6c8; padding: 12px; }
  .card b { display: block; font-size: 26px; line-height: 1.2; }
  .card span { display: block; color: #5c564c; font-size: 13px; }
  table { width: 100%; border-collapse: collapse; background: white; font: 13px/1.4 Consolas, monospace; margin: 8px 0 18px; }
  th, td { border-bottom: 1px solid #e4dccb; text-align: right; padding: 7px 8px; vertical-align: top; }
  th:first-child, td:first-child, .left { text-align: left; }
  .pos { color: #1b7f3a; }
  .neg { color: #8a2b2b; }
  .chart { background: white; border: 1px solid #ddd6c8; padding: 12px 12px 4px; margin: 8px 0 18px; }
  .chart svg { width: 100%; height: auto; display: block; }
  .caption { color: #5c564c; font-size: 13px; margin: 0 0 8px; }
  @media (max-width: 800px) { .grid, .filters { grid-template-columns: 1fr 1fr; } }
</style>
</head>
<body>
<main>
  <h1>Five weekday prop accounts</h1>
  <div class="note">
    <p>One $5,000 account per New York weekday. The account type sets the fee, the profit targets, and the loss lines. Reaching a loss line blows the account. Cash is settled on 26 Oct 2026. Trades run from 2020 through 23 Oct 2026.</p>
  </div>
  <div class="filters">
    <label>Run
      <select id="run"></select>
    </label>
    <label>Account
      <select id="account"></select>
    </label>
  </div>
  <p id="blurb"></p>
  <div class="risk" id="risk"></div>
  <div class="grid" id="cards"></div>
  <h2>Days to pass</h2>
  <p class="caption" id="passnote"></p>
  <div class="grid" id="pass-cards"></div>
  <table id="pass"></table>
  <h2>Cash by year</h2>
  <p class="caption">A fee is charged on the first trade of a new challenge. Received is the 80% you keep.</p>
  <div class="chart" id="chart"></div>
  <table id="years"></table>
  <h2>One account per weekday</h2>
  <p class="caption">Points are that weekday's trades. Net is payouts you received minus challenge fees.</p>
  <table id="days"></table>
  <p id="daynote"></p>
  <h2>Where each account stands on 26 Oct 2026</h2>
  <table id="now"></table>
  <h2>What ended the accounts</h2>
  <p id="ended"></p>
  <h2>Minimum trading days</h2>
  <p id="rules"></p>
  <h2>Leaving a $400 cushion</h2>
  <p id="cushion"></p>
  <table id="cushion-table"></table>
  <h2>How the simulation was run</h2>
  <ul>
    <li>Each weekday has its own account. Monday trades never mix with Tuesday trades. A blown account is replaced on the next trade for that weekday.</li>
    <li>Targets, the daily loss, the maximum drawdown, and the fee depend on the account type. Reaching either loss line blows the account. One fee covers every phase of that challenge. Each phase, and the funded account, starts again at $5,000.</li>
    <li>A payout needs at least $20 of closed profit and 10 Monday–Friday days after the first funded trade of that cycle. You keep 80%. The balance then returns to $5,000. The 2-step account also needs 3 new days of at least $25. The 1-step and 3-step accounts have no minimum number of days.</li>
    <li>The sl50 fade run is 0.10 lot, $2 a point. The sl100 continuation runs are 0.09 lot, $1.80 a point. The fade run sells a cross up and buys a cross down. The continuation runs buy a cross up and sell a cross down. Touch means a wick through the level is enough. Prices are the bid series, with no spread.</li>
    <li>A new phase starts only when the account is flat. If last week's trade is still open when the same weekday signals again, that position stays on the same account until it closes.</li>
  </ul>
</main>
<script>
const RUNS = __DATA__;
const runSelect = document.getElementById("run");
const accountSelect = document.getElementById("account");
runSelect.innerHTML = RUNS.map((run, i) => `<option value="${i}">${run.id}</option>`).join("");
accountSelect.innerHTML = RUNS[0].accounts.map((account, i) => `<option value="${i}">${account.name} · $${account.price}</option>`).join("");

function money(value) {
  const sign = value < 0 ? "−" : "";
  return sign + "$" + Math.abs(value).toLocaleString("en-US");
}
function points(value) {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return sign + Math.abs(value).toLocaleString("en-US");
}
function cls(value) { return value > 0 ? "pos" : value < 0 ? "neg" : ""; }
function stage(end) {
  if (!end.alive) return "Blown";
  if (end.phase === "funded") return "Funded";
  if (end.phase === "p3") return "Phase 3";
  if (end.phase === "p2") return "Phase 2";
  return "Phase 1";
}
function targetOf(account, phase) {
  if (account.id === "3step") return 150;
  return phase === "p1" ? 400 : 250;
}
function nextText(row, account) {
  const end = row.end;
  const loss = row.loss;
  if (!end.alive) return `Blown on the last trade. The next trade for this weekday needs a new $${account.price} challenge.`;
  if (end.phase === "funded") {
    if (end.due && end.due <= "2026-10-26") {
      return `Payout window opened ${end.due}. This cycle has ${end.green} winning day${end.green === 1 ? "" : "s"} and ${money(end.profit)} of closed profit.`;
    }
    if (end.due) return `Payout date is ${end.due}. Closed profit is ${money(end.profit)}.`;
    return "Flat. The next trade starts a new 10-business-day clock.";
  }
  const target = targetOf(account, end.phase);
  if (account.dd_mode === "trail") {
    return `${stage(end)}. Open profit ${money(end.profit)}. Best this phase ${money(end.max_profit)}. Target is ${money(target)}. Trailing floor is ${money(end.floor)} under a peak of ${money(end.hwm)}.`;
  }
  const stops = Math.ceil((end.balance - account.floor0) / loss);
  const stopWord = stops === 1 ? "stop" : "stops";
  return `${stage(end)}. Open profit ${money(end.profit)}. Best this phase ${money(end.max_profit)}. Target is ${money(target)}. The next ${stops} full ${stopWord} of ${money(loss)} reach ${money(account.floor0)}.`;
}

function chart(years) {
  const vals = years.map((year) => year.cumulative);
  const max = Math.max(1000, ...vals);
  const min = Math.min(0, ...vals);
  const span = max - min || 1;
  const x0 = 56, y0 = 16, w = 640, h = 150;
  const x = (i) => x0 + (years.length === 1 ? w / 2 : (i * w) / (years.length - 1));
  const y = (v) => y0 + h * (1 - (v - min) / span);
  const pts = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const labels = years.map((year, i) => `<text x="${x(i).toFixed(1)}" y="186" text-anchor="middle">${year.year}</text>`).join("");
  document.getElementById("chart").innerHTML = `<svg viewBox="0 0 720 210" role="img">
    <line x1="${x0}" y1="${y(0)}" x2="${x0 + w}" y2="${y(0)}" stroke="#e4dccb"/>
    <line x1="${x0}" y1="${y0}" x2="${x0}" y2="${y0 + h}" stroke="#e4dccb"/>
    <polyline fill="none" stroke="#1b7f3a" stroke-width="2.5" points="${pts}"/>
    <g fill="#1c1a17" font-family="Consolas, monospace" font-size="11">
      ${labels}
      <text x="48" y="20" text-anchor="end">${money(Math.round(max))}</text>
      <text x="48" y="${(y(min) + 4).toFixed(0)}" text-anchor="end">${money(Math.round(min))}</text>
    </g>
  </svg>`;
}

function render() {
  const run = RUNS[Number(runSelect.value)];
  const account = run.accounts[Number(accountSelect.value)];
  document.getElementById("blurb").textContent = run.blurb;
  document.getElementById("risk").textContent = account.summary;
  document.getElementById("cards").innerHTML = [
    ["Net cash", account.net],
    [`Fees, ${account.challenges} challenges`, account.fees],
    ["Received after 80%", account.received],
    ["Withdrawn before the split", account.gross],
  ].map(([label, value]) => `<div class="card"><b class="${cls(value)}">${money(value)}</b><span>${label}</span></div>`).join("");
  chart(account.years);
  const head = (cells) => "<tr>" + cells.map((cell, i) => `<th class="${i ? "" : "left"}">${cell}</th>`).join("") + "</tr>";
  const phaseNames = ["Phase 1 passes", "Phase 2 passes", "Phase 3 passes"].slice(0, account.nphase);
  const phaseKeys = ["p1", "p2", "p3"].slice(0, account.nphase);
  document.getElementById("years").innerHTML = head(["Year", "Fees", "Payouts", "Gross withdrawn", "Received", "Net", "Cumulative"])
    + account.years.map((year) => `<tr><td class="left">${year.year}</td><td>${money(year.fees)}</td><td>${year.payouts}</td><td>${money(year.gross)}</td><td class="${cls(year.received)}">${money(year.received)}</td><td class="${cls(year.net)}">${money(year.net)}</td><td class="${cls(year.cumulative)}">${money(year.cumulative)}</td></tr>`).join("");
  const dayHead = ["Weekday", "Trades", "Points", "Challenges", ...phaseNames, "Funded blowups", "Fees", "Payouts", "Received", "Net"];
  const dayRow = (row) => `<tr><td class="left">${row.weekday}</td><td>${row.trades}</td><td class="${cls(row.points)}">${points(row.points)}</td><td>${row.challenges}</td>`
    + phaseKeys.map((key) => `<td>${row[key]}</td>`).join("")
    + `<td>${row.funded}</td><td>${money(row.fees)}</td><td>${row.payouts}</td><td class="${cls(row.received)}">${money(row.received)}</td><td class="${cls(row.net)}">${money(row.net)}</td></tr>`;
  const sum = (key) => account.weekdays.reduce((s, row) => s + row[key], 0);
  document.getElementById("days").innerHTML = head(dayHead)
    + account.weekdays.map(dayRow).join("")
    + `<tr><td class="left">All five</td><td>${sum("trades")}</td><td class="${cls(sum("points"))}">${points(sum("points"))}</td><td>${account.challenges}</td>`
    + phaseKeys.map((key) => `<td>${account[key]}</td>`).join("")
    + `<td>${account.funded}</td><td>${money(account.fees)}</td><td>${account.payouts}</td><td class="${cls(account.received)}">${money(account.received)}</td><td class="${cls(account.net)}">${money(account.net)}</td></tr>`;
  document.getElementById("now").innerHTML = head(["Weekday", "Stage", "Balance", "What happens next"])
    + account.weekdays.map((row) => `<tr><td class="left">${row.weekday}</td><td class="left">${stage(row.end)}</td><td>${money(row.end.balance)}</td><td class="left">${nextText(row, account)}</td></tr>`).join("");
  const ddName = account.dd_mode === "trail" ? "trailing floor" : `${money(account.floor0)} static floor`;
  const passed = phaseKeys.map((key, i) => `${account[key]} passed phase ${i + 1}`).join(", ");
  document.getElementById("ended").textContent = `${account.maxdd} accounts died on the ${ddName}. ${account.daily} died on the ${account.daily_pct}% daily floor. Of ${account.challenges} challenges, ${passed}. ${account.funded} funded accounts later blew up.`;
  document.getElementById("rules").textContent = account.min_green
    ? `Requiring 3 profitable days changes this result from ${money(account.net)} to ${money(account.no_green_net)} when the rule is removed. A winning trade adds at least ${money(run.min_win)}, so the $20 minimum never blocks a payout.`
    : `This account has no minimum number of days, so a phase can pass on the day the target is hit. A winning trade adds at least ${money(run.min_win)}, so the $20 minimum never blocks a payout.`;
  const c = account.cushion;
  document.getElementById("cushion").textContent = `The figures above withdraw every dollar of closed profit above $5,000. Leaving $400 in the funded account nets ${money(c.net)}. That path buys ${c.challenges} challenges (${money(c.fees)} of fees) and receives ${money(c.received)}.`;
  document.getElementById("cushion-table").innerHTML = head(["Withdrawal", "Challenges", "Fees", "Payouts", "Received", "Net"])
    + `<tr><td class="left">All profit above $5,000</td><td>${account.challenges}</td><td>${money(account.fees)}</td><td>${account.payouts}</td><td class="pos">${money(account.received)}</td><td class="${cls(account.net)}">${money(account.net)}</td></tr>`
    + `<tr><td class="left">Leave a $400 cushion</td><td>${c.challenges}</td><td>${money(c.fees)}</td><td>${c.payouts}</td><td class="pos">${money(c.received)}</td><td class="${cls(c.net)}">${money(c.net)}</td></tr>`;
  const worst = account.weekdays.reduce((a, b) => a.net < b.net ? a : b);
  document.getElementById("daynote").textContent = worst.net < 0
    ? `${worst.weekday} is the one that loses cash. A blown challenge loses the firm's $5,000. The cost to you is the fee, plus any funded profit that had not been withdrawn.`
    : "Every weekday account is net positive after fees.";
  const dayCard = (title, span) => span
    ? `<div class="card"><b>${span.avg}</b><span>${title}</span><span>min ${span.min} · max ${span.max}</span></div>`
    : `<div class="card"><b>—</b><span>${title}</span></div>`;
  const phaseLabels = ["Phase 1", "Phase 2", "Phase 3"];
  document.getElementById("pass-cards").innerHTML = phaseKeys.flatMap((key, i) => [
    dayCard(`${phaseLabels[i]} calendar days, ${account.pass[key].n} passes`, account.pass[key].calendar),
    dayCard(`${phaseLabels[i]} trading days, ${account.pass[key].n} passes`, account.pass[key].trading),
  ]).join("");
  const passHead = head(["Phase", "Passed", "Calendar min", "Calendar average", "Calendar max", "Trading min", "Trading average", "Trading max"]);
  const passRow = (label, block) => {
    const cells = (span) => span
      ? `<td>${span.min}</td><td>${span.avg}</td><td>${span.max}</td>`
      : "<td>—</td><td>—</td><td>—</td>";
    return `<tr><td class="left">${label}</td><td>${block.n}</td>${cells(block.calendar)}${cells(block.trading)}</tr>`;
  };
  document.getElementById("pass").innerHTML = passHead + phaseKeys.map((key, i) => passRow(phaseLabels[i], account.pass[key])).join("");
  document.getElementById("passnote").textContent = "Only phases that passed are counted. The large number is the average. Calendar days run from the entry date of that phase's first trade through the day the target was hit, and both of those days count. Trading days are the trades opened during the phase. A blown challenge is left out. Each account trades only its own weekday, so the calendar count includes the days in between.";
}

runSelect.addEventListener("change", render);
accountSelect.addEventListener("change", render);
render();
</script>
</body>
</html>
"""


def write_page(runs):
    text = PAGE.replace("__DATA__", json.dumps(runs).replace("<", "\\u003c"))
    OUT.write_text(text, encoding="utf-8")
    print("wrote", OUT, flush=True)


def check_rules():
    assert day_floor(1_030_000, 3) == 999_100
    assert day_floor(1_010_000, 2) == 989_800
    assert dd_floor(1_100_000, 5) == 1_045_000
    assert dd_floor(1_000_000, 5) == 950_000
    assert dd_floor(1_000_000, 3) == 970_000
    assert dd_floor(START, 8) == 460_000
    assert dd_floor(START, 3) == 485_000
    assert dd_floor(START, 5) == 475_000
    assert day_floor(START, 4) == 480_000
    assert day_floor(START, 3) == 485_000
    assert day_floor(START, 2) == 490_000


def main():
    check_rules()
    print("loading", flush=True)
    ts, o, h, l, c = b.load()
    bar_day = np.array([day_of_ms(int(ms)) for ms in ts])
    print("sl50 path", flush=True)
    sl50_trades, bad = load_sl50(ts, o, h, l, c)
    print(f"  {len(sl50_trades)} trades, path mismatches {bad}", flush=True)
    if bad:
        raise SystemExit("sl50 path did not match the stored trades")
    sl50 = build_run(
        "sl50_tp50_all_serial_one_month",
        "sl50 tp50, fade, all sessions, one at a time",
        "Fade, lot 0.10. A cross down is a buy and a cross up is a sell. Stop and target are 50 points ($100). "
        "London or New York, one trade at a time, one trade per New York day, levels from the previous 30 days. "
        "1,666 trades, 52.2% wins, net +3,600 points.",
        sl50_trades,
        bar_day,
        200,
        100,
        100,
    )
    if abs(sl50["accounts"][0]["net"] - 4978) > 0.01:
        raise SystemExit(f"2-step sl50 drifted to {sl50['accounts'][0]['net']}")
    clock = b.clocks(ts)
    records = b.build_levels(ts, o, c, clock)
    block_low, block_high = b.prepare_blocks(h, l, c)
    print("building month continuation touches", flush=True)
    touches = build_touch(records, 30, ts, o, h, l, c, clock, block_low, block_high)
    print(f"  {len(touches)} touches", flush=True)
    configs = (
        (
            "sl100_tp50_rth_every_one_month_touch_continuation",
            "sl100 tp50, continuation, New York RTH, one trade a day",
            100.0,
            50.0,
            8000.0,
            70.0,
        ),
        (
            "sl100_tp150_rth_every_one_month_touch_continuation",
            "sl100 tp150, continuation, New York RTH, one trade a day",
            100.0,
            150.0,
            16600.0,
            44.2,
        ),
    )
    runs = [sl50]
    point = 180
    for name, label, sl, tp, expect_net, win_rate in configs:
        print("simulate", name, flush=True)
        pairs, _decisions = b.simulate(touches, sl, tp, "rth", "every", "one")
        net = round(sum(done["pnl"] for _touch, done in pairs), 1)
        print(f"  {len(pairs)} trades, net {net}", flush=True)
        if abs(net - expect_net) > 0.2:
            raise SystemExit(f"{name} drifted: {net} expected {expect_net}")
        packed, mismatches, overlaps = pack_trades(pairs, sl, tp, ts, o, h, l, c)
        print(f"  path mismatches {mismatches}, weekday overlaps {overlaps}", flush=True)
        if mismatches:
            raise SystemExit(f"{name} path mismatches {mismatches}")
        win_dollars = int(tp) * point // 100
        loss_dollars = int(sl) * point // 100
        overlap_note = ""
        if overlaps:
            overlap_note = (
                f" {overlaps} trades were still open when the same weekday traded again;"
                f" that position stays on the same account until it closes."
            )
        blurb = (
            f"Continuation, lot 0.09. Buy a cross up and sell a cross down. Touch enters on the wick. "
            f"Stop {int(sl)} points (${loss_dollars}) and target {int(tp)} points (${win_dollars}). "
            f"New York RTH only, one trade per New York day, levels from the previous 30 days. "
            f"{len(pairs)} trades, {win_rate}% wins, net {points_text(net)} points.{overlap_note}"
        )
        runs.append(build_run(name, label, blurb, packed, bar_day, point, loss_dollars, win_dollars))
    write_page(runs)


def show_pass(account):
    labels = ("phase 1", "phase 2", "phase 3")
    for label, key in zip(labels, ("p1", "p2", "p3")[: account["nphase"]]):
        block = account["pass"][key]
        calendar, trading = block["calendar"], block["trading"]
        if not calendar:
            print(f"    {label}: no passes", flush=True)
            continue
        print(
            f"    {label}: {block['n']} passes, calendar min/avg/max {calendar['min']}/{calendar['avg']}/{calendar['max']}, "
            f"trading min/avg/max {trading['min']}/{trading['avg']}/{trading['max']}",
            flush=True,
        )


def points_text(net):
    sign = "+" if net > 0 else ""
    return f"{sign}{net:,.0f}" if float(net).is_integer() else f"{sign}{net}"


if __name__ == "__main__":
    main()
