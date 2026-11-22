"""Prop-firm replay of sl50_tp50_all_serial_one_month.

Touching the drawdown floor breaches. Equity of $4,600 on a $5,000 account
is a blown account, and the same rule applies to that day's 4% floor.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

import backtest as b

ROOT = Path(__file__).resolve().parent
HTML = ROOT / "results" / "positive_runs.html"
OUT = ROOT / "results" / "_prop_touch.json"
DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]
ASOF = np.datetime64("2026-10-26")
START = 500_000
FLOOR = 460_000
POINT = 200
WIN = 10_000
PHASE1 = 40_000
PHASE2 = 25_000
QUALIFY = 2_500
MIN_PAY = 2_000
FEE = 2_200
NEEDLE = b'"id":"sl50_tp50_all_serial_one_month"'


def cents(points: float) -> int:
    return int(round(points * POINT))


def day_floor(ref: int) -> int:
    return ref - (ref * 4 + 50) // 100


def load_run():
    data = HTML.read_bytes()
    i = data.find(NEEDLE)
    j = data.rfind(b"{", 0, i)
    depth = 0
    k = j
    in_str = False
    esc = False
    while k < len(data):
        c = data[k]
        if in_str:
            if esc:
                esc = False
            elif c == 92:
                esc = True
            elif c == 34:
                in_str = False
        else:
            if c == 34:
                in_str = True
            elif c == 123:
                depth += 1
            elif c == 125:
                depth -= 1
                if depth == 0:
                    k += 1
                    break
        k += 1
    return json.loads(data[j:k])["trades"]


def load_prices():
    frame = pd.read_csv(b.CSV, usecols=["timestamp", "open", "high", "low", "close"])
    ts = frame["timestamp"].to_numpy(np.int64)
    order = np.argsort(ts, kind="mergesort")
    return (
        ts[order],
        frame["open"].to_numpy(np.float64)[order],
        frame["high"].to_numpy(np.float64)[order],
        frame["low"].to_numpy(np.float64)[order],
        frame["close"].to_numpy(np.float64)[order],
    )


def bar_index(ts, text):
    ms = int(pd.Timestamp(text, tz="UTC").value // 1_000_000)
    i = int(np.searchsorted(ts, ms))
    if i >= len(ts) or int(ts[i]) != ms:
        raise SystemExit(f"no bar for {text}")
    return i


def day_of_ms(ms: int) -> np.datetime64:
    text = datetime.fromtimestamp(ms / 1000.0, timezone.utc).strftime("%Y-%m-%d")
    return np.datetime64(text)


def candidates(bar, fill, side, o, h, l, c):
    prev = None if bar == 0 else float(c[bar - 1])
    points = b.bar_points(prev, float(o[bar]), float(h[bar]), float(l[bar]), float(c[bar]))
    found = []
    for seg, (left, right) in enumerate(zip(points, points[1:])):
        if side == 1 and right < left and right <= fill < left:
            found.append(seg)
        elif side == -1 and right > left and left < fill <= right:
            found.append(seg)
    return points, found


def walk(bar0, points, seg, fill, side, ts, o, h, l, c):
    stop = fill - 50.0 * side
    target = fill + 50.0 * side
    entry_day = day_of_ms(int(ts[bar0]))
    current = entry_day
    last_price = fill
    entry_min = 0.0
    later = {}

    def note(price, day):
        nonlocal entry_min
        u = side * (price - fill)
        if day == entry_day:
            entry_min = min(entry_min, u)
        else:
            opened, low = later[day]
            later[day] = (opened, min(low, u))

    def roll(new_day):
        nonlocal current
        if new_day <= current:
            return
        u = side * (last_price - fill)
        day = current + np.timedelta64(1, "D")
        while day <= new_day:
            later[day] = (u, u)
            day = day + np.timedelta64(1, "D")
        current = new_day

    def traverse(left, right, day):
        nonlocal last_price
        hit = b.first_hit(left, right, stop, target)
        end = hit[1] if hit else right
        note(left, day)
        note(end, day)
        last_price = end
        return hit[0] if hit else None

    right = points[seg + 1]
    if fill != right:
        kind = traverse(fill, right, entry_day)
        if kind:
            return kind, bar0, entry_min, later
    for price in points[seg + 2 :]:
        kind = traverse(last_price, price, entry_day)
        if kind:
            return kind, bar0, entry_min, later
    prev_close = float(c[bar0])
    j = bar0 + 1
    while j < len(o):
        day = day_of_ms(int(ts[j]))
        roll(day)
        oj, hj, lj, cj = (float(o[j]), float(h[j]), float(l[j]), float(c[j]))
        if prev_close != oj:
            kind = traverse(prev_close, oj, day)
            if kind:
                return kind, j, entry_min, later
        seq = (oj, lj, hj, cj) if cj >= oj else (oj, hj, lj, cj)
        left = seq[0]
        for price in seq[1:]:
            if price != left:
                kind = traverse(left, price, day)
                if kind:
                    return kind, j, entry_min, later
                left = price
        prev_close = cj
        j += 1
    return "end of data", len(o) - 1, entry_min, later


def features(rows, ts, o, h, l, c):
    out = []
    bad = 0
    for row in rows:
        side = 1 if row[7] else -1
        fill = float(row[9])
        i0 = bar_index(ts, row[1])
        i1 = bar_index(ts, row[2])
        points, segs = candidates(i0, fill, side, o, h, l, c)
        matched = None
        for seg in segs:
            kind, bar, entry_min, later = walk(i0, points, seg, fill, side, ts, o, h, l, c)
            won = row[14] > 0
            if bar == i1 and ((kind == "target" and won) or (kind == "stop" and not won)):
                matched = (entry_min, later)
                break
        if matched is None:
            bad += 1
            entry_min, later = -50.0, {}
        else:
            entry_min, later = matched
        held = (
            datetime.strptime(row[2], "%Y-%m-%d %H:%M") - datetime.strptime(row[1], "%Y-%m-%d %H:%M")
        ).total_seconds()
        out.append(
            {
                "weekday": int(row[3]),
                "entry_day": row[1][:10],
                "exit_day": row[2][:10],
                "pnl": WIN if row[14] > 0 else -WIN,
                "hold_ok": held >= 60.0,
                "entry_min": entry_min,
                "later": [{"open": opened, "low": low} for _day, (opened, low) in sorted(later.items())],
            }
        )
    return out, bad


def hit(balance: int, unreal: float, ref: int):
    equity = balance + cents(unreal)
    if equity <= FLOOR:
        return "static"
    if equity <= day_floor(ref):
        return "daily"
    return None


def fresh():
    return {
        "phase": "p1",
        "balance": START,
        "green": 0,
        "hold_ok": 0,
        "hold_n": 0,
        "due": None,
        "alive": True,
        "max_profit": 0,
        "phase_start": None,
        "phase_trades": 0,
    }


def reset(acct, phase):
    acct["phase"] = phase
    acct["balance"] = START
    acct["green"] = 0
    acct["due"] = None
    acct["max_profit"] = 0
    acct["phase_start"] = None
    acct["phase_trades"] = 0


def remember_pass(acct, stats, key, exit_day):
    start = np.datetime64(acct["phase_start"])
    end = np.datetime64(exit_day)
    calendar = int((end - start) / np.timedelta64(1, "D")) + 1
    stats[key].append({"calendar": calendar, "trades": acct["phase_trades"]})


def ratio_ok(acct) -> bool:
    return acct["hold_n"] == 0 or acct["hold_ok"] * 2 >= acct["hold_n"]


def payout(acct, asof, cushion, stats, min_green):
    if acct["phase"] != "funded" or acct["due"] is None:
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
    acct["due"] = None
    stats["payouts"] += 1
    stats["gross"] += withdraw
    stats["received"] += received
    stats["events"].append({"date": str(asof), "kind": "payout", "gross": withdraw, "received": received})


def apply_trade(acct, trade, stats):
    balance = acct["balance"]
    reason = hit(balance, trade["entry_min"], balance)
    if reason:
        stats[reason] += 1
        acct["alive"] = False
        return reason
    for day in trade["later"]:
        equity_open = balance + cents(day["open"])
        ref = equity_open if equity_open > balance else balance
        reason = hit(balance, day["low"], ref)
        if reason:
            stats[reason] += 1
            acct["alive"] = False
            return reason
    acct["balance"] = balance + trade["pnl"]
    if acct["balance"] <= FLOOR:
        stats["static"] += 1
        acct["alive"] = False
        return "close"
    acct["hold_n"] += 1
    if trade["hold_ok"]:
        acct["hold_ok"] += 1
    if trade["pnl"] >= QUALIFY:
        acct["green"] += 1
    acct["max_profit"] = max(acct["max_profit"], acct["balance"] - START)
    acct["phase_trades"] += 1
    if acct["phase"] == "p1" and acct["balance"] - START >= PHASE1 and acct["green"] >= 3 and ratio_ok(acct):
        remember_pass(acct, stats, "p1_days", trade["exit_day"])
        reset(acct, "p2")
        stats["p1_pass"] += 1
    elif acct["phase"] == "p2" and acct["balance"] - START >= PHASE2 and acct["green"] >= 3 and ratio_ok(acct):
        remember_pass(acct, stats, "p2_days", trade["exit_day"])
        reset(acct, "funded")
        stats["p2_pass"] += 1
    return None


def simulate(trades, cushion, min_green=3):
    report = []
    for weekday in range(5):
        mine = [t for t in trades if t["weekday"] == weekday]
        acct = None
        stats = {
            "weekday": DAYS[weekday],
            "trades": len(mine),
            "points": sum(50 if t["pnl"] > 0 else -50 for t in mine),
            "challenges": 0,
            "fees": 0,
            "p1_pass": 0,
            "p2_pass": 0,
            "fail_p1": 0,
            "fail_p2": 0,
            "fail_funded": 0,
            "static": 0,
            "daily": 0,
            "payouts": 0,
            "gross": 0,
            "received": 0,
            "events": [],
            "hold_short": sum(1 for t in mine if not t["hold_ok"]),
            "p1_days": [],
            "p2_days": [],
        }
        for trade in mine:
            if acct is None or not acct["alive"]:
                acct = fresh()
                stats["challenges"] += 1
                stats["fees"] += FEE
                stats["events"].append({"date": trade["entry_day"], "kind": "fee"})
            if acct["phase_start"] is None:
                acct["phase_start"] = trade["entry_day"]
            funded = acct["phase"] == "funded"
            if funded and acct["due"] is not None and np.datetime64(acct["due"]) < np.datetime64(trade["entry_day"]):
                payout(acct, acct["due"], cushion, stats, min_green)
            phase = acct["phase"]
            reason = apply_trade(acct, trade, stats)
            if reason:
                key = {"p1": "fail_p1", "p2": "fail_p2", "funded": "fail_funded"}[phase]
                stats[key] += 1
                continue
            if funded and acct["phase"] == "funded":
                if acct["due"] is None:
                    acct["due"] = str(np.busday_offset(np.datetime64(trade["entry_day"]), 10))
                payout(acct, trade["exit_day"], cushion, stats, min_green)
        if acct and acct["alive"] and acct["phase"] == "funded":
            payout(acct, str(ASOF), cushion, stats, min_green)
        profit = 0 if not acct else acct["balance"] - START
        stats["end"] = {
            "alive": bool(acct and acct["alive"]),
            "phase": None if not acct else acct["phase"],
            "balance": None if not acct else round(acct["balance"] / 100, 2),
            "green": 0 if not acct else acct["green"],
            "due": None if not acct else acct["due"],
            "profit": round(profit / 100, 2),
            "max_profit": 0 if not acct else round(acct["max_profit"] / 100, 2),
        }
        stats["net"] = stats["received"] - stats["fees"]
        report.append(stats)
    return report


def dollars(cents_value):
    return round(cents_value / 100, 2)


def pack(report):
    yearly = {}
    for row in report:
        for event in row["events"]:
            year = event["date"][:4]
            bucket = yearly.setdefault(year, {"fees": 0, "received": 0, "payouts": 0, "gross": 0})
            if event["kind"] == "fee":
                bucket["fees"] += FEE
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
    rows = []
    for row in report:
        rows.append(
            {
                "weekday": row["weekday"],
                "trades": row["trades"],
                "points": row["points"],
                "challenges": row["challenges"],
                "fees": dollars(row["fees"]),
                "p1_pass": row["p1_pass"],
                "p2_pass": row["p2_pass"],
                "fail_p1": row["fail_p1"],
                "fail_p2": row["fail_p2"],
                "fail_funded": row["fail_funded"],
                "static": row["static"],
                "daily": row["daily"],
                "payouts": row["payouts"],
                "gross": dollars(row["gross"]),
                "received": dollars(row["received"]),
                "net": dollars(row["net"]),
                "hold_short": row["hold_short"],
                "end": row["end"],
            }
        )

    def tot(key):
        return sum(row[key] for row in report)

    return {
        "challenges": tot("challenges"),
        "fees": dollars(tot("fees")),
        "received": dollars(tot("received")),
        "gross": dollars(tot("gross")),
        "net": dollars(tot("received") - tot("fees")),
        "payouts": tot("payouts"),
        "p1_pass": tot("p1_pass"),
        "p2_pass": tot("p2_pass"),
        "fail_p1": tot("fail_p1"),
        "fail_p2": tot("fail_p2"),
        "fail_funded": tot("fail_funded"),
        "static": tot("static"),
        "daily": tot("daily"),
        "pass": summarize_pass(report),
        "weekdays": rows,
        "years": years,
    }


def summarize_pass(report):
    def pack(items):
        if not items:
            return {"n": 0, "calendar": None, "trading": None}
        calendar = [item["calendar"] for item in items]
        trading = [item["trades"] for item in items]

        def agg(vals):
            return {"min": int(min(vals)), "max": int(max(vals)), "avg": round(sum(vals) / len(vals), 1)}

        return {"n": len(items), "calendar": agg(calendar), "trading": agg(trading)}

    return {
        "p1": pack([item for row in report for item in row["p1_days"]]),
        "p2": pack([item for row in report for item in row["p2_days"]]),
    }


def sl50_pass():
    """Calendar and trading days for phases that passed. Cash must stay at the checked result."""
    rows = load_run()
    ts, o, h, l, c = load_prices()
    trades, bad = features(rows, ts, o, h, l, c)
    if bad:
        raise SystemExit(f"sl50 path mismatches {bad}")
    full = pack(simulate(trades, 0))
    if abs(full["net"] - 4978) > 0.01:
        raise SystemExit(f"sl50 net drifted to {full['net']}")
    return full["pass"]


def main():
    rows = load_run()
    print(len(rows), "trades", flush=True)
    ts, o, h, l, c = load_prices()
    trades, bad = features(rows, ts, o, h, l, c)
    print("mismatches", bad, flush=True)
    full = pack(simulate(trades, 0))
    cushion = pack(simulate(trades, 40_000))
    no_green = pack(simulate(trades, 0, min_green=0))
    OUT.write_text(json.dumps({"full": full, "cushion": cushion, "no_green": no_green}, indent=1), encoding="utf-8")
    print(json.dumps({k: {kk: full[kk] for kk in full if kk not in ("weekdays", "years")} for k in ("x",)}, indent=1))
    print("FULL", full["net"], full["fees"], full["received"], full["payouts"], full["challenges"], "daily", full["daily"])
    print("PASS", json.dumps(full["pass"]))
    print("CUSHION", cushion["net"], cushion["fees"], cushion["received"], cushion["payouts"], cushion["challenges"])
    print("NOGREEN", no_green["net"], no_green["fees"], no_green["received"], no_green["payouts"])
    for row in full["weekdays"]:
        print(row["weekday"], row["net"], row["challenges"], row["payouts"], row["end"])
    for year in full["years"]:
        print(year)


if __name__ == "__main__":
    main()
