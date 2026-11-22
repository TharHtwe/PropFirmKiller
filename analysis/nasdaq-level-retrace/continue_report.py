"""Continuation report: buy a cross up, sell a cross down.

Touch enters on the cross. Close beyond waits for the minute to close strictly
beyond the level and enters at that close.

Run: python -u continue_report.py
"""

from __future__ import annotations

import gc
import json

import numpy as np

import backtest as b

OUT = b.OUT / "report_continue.html"
TRIGGERS = ("touch", "close")


def slots_for(side, fill, bar, seg, points, o, h, l, c, block_low, block_high):
    slots = [None] * (len(b.STOPS) * len(b.TARGETS))
    for sl in b.STOPS:
        by_tp = b.resolve_one_stop(side, fill, sl, int(bar), seg, points, o, h, l, c, block_low, block_high)
        for tp in b.TARGETS:
            slots[b.EXIT_INDEX[(int(sl), int(tp))]] = by_tp[int(tp)]
    return tuple(slots)


def build(records, look_days, ts, o, h, l, c, clock, block_low, block_high):
    for i, row in enumerate(records):
        row["cents_id"] = i
    expire_i = np.array([b.expire_index(ts, row["close_ts"], look_days) for row in records], dtype=np.int32)
    tradable = clock["in_ny"] | clock["in_lon"]
    slices = b.day_slices(clock["ny_ymd"], tradable)
    touch_rows = []
    close_rows = []
    audit_levels = []
    cursor = 0
    for ymd, day_start, bars in slices:
        while cursor < len(records) and records[cursor]["ready_i"] <= day_start:
            cursor += 1
        prices, cents, labels, kinds = b.active_book(records[:cursor], day_start, expire_i)
        if ymd == b.AUDIT_YMD:
            for k, price in zip(cents, prices):
                kind = kinds[int(k)]
                if kind == {"D", "W"}:
                    color = "both"
                elif "W" in kind:
                    color = "weekly"
                else:
                    color = "daily"
                audit_levels.append({"price": float(price), "color": color, "sources": labels[int(k)]})
        if len(prices) == 0:
            continue
        for bar in bars:
            prev = None if bar == 0 else c[bar - 1]
            points = b.bar_points(prev, o[bar], h[bar], l[bar], c[bar])
            if len(points) < 2:
                continue
            close_cache = {}
            close_n = 0
            bar_close = float(c[bar])
            for seg, a, bend, price, cent, side in b.crosses(points, prices, cents):
                fill = bend if (seg == 0 and prev is not None and prev != o[bar] and price != bend) else price
                if fill == bend and price != bend:
                    entry_rank = b.pos_rank(bar, seg, a, bend, bend) - (abs(bend - price) * 1e-6)
                else:
                    entry_rank = b.pos_rank(bar, seg, a, bend, price)
                cont = -side
                common = {
                    "ymd": ymd,
                    "bar": int(bar),
                    "ts": int(ts[bar]),
                    "cent": cent,
                    "price": price,
                    "in_ny": bool(clock["in_ny"][bar]),
                    "in_rth": bool(clock["in_rth"][bar]),
                    "in_lon": bool(clock["in_lon"][bar]),
                    "sources": labels.get(cent, []),
                }
                touch_rows.append(
                    {
                        **common,
                        "rank": entry_rank,
                        "side": cont,
                        "fill": fill,
                        "exits": slots_for(cont, fill, int(bar), seg, points, o, h, l, c, block_low, block_high),
                    }
                )
                beyond = (cont == 1 and bar_close > price) or (cont == -1 and bar_close < price)
                if not beyond:
                    continue
                if cont not in close_cache:
                    close_cache[cont] = slots_for(
                        cont,
                        bar_close,
                        int(bar),
                        0,
                        [bar_close, bar_close],
                        o,
                        h,
                        l,
                        c,
                        block_low,
                        block_high,
                    )
                close_rows.append(
                    {
                        **common,
                        "rank": bar * 10.0 + 9.0 + close_n * 1e-6,
                        "side": cont,
                        "fill": bar_close,
                        "exits": close_cache[cont],
                    }
                )
                close_n += 1
    return {"touch": touch_rows, "close": close_rows}, audit_levels


def audit_items(touches):
    rows = []
    for touch in touches:
        if touch["ymd"] != b.AUDIT_YMD:
            continue
        item = {
            "time": b.iso(touch["ts"]),
            "level": touch["price"],
            "sources": touch["sources"],
            "side": "buy" if touch["side"] == 1 else "sell",
            "fill": round(float(touch["fill"]), 2),
            "in_ny": touch["in_ny"],
            "in_rth": touch["in_rth"],
            "in_lon": touch["in_lon"],
            "by_sl": {},
        }
        for sl in b.STOPS:
            item["by_sl"][str(int(sl))] = {}
            for tp in b.TARGETS:
                pnl, kind, _rank, _bar = touch["exits"][b.EXIT_INDEX[(int(sl), int(tp))]]
                item["by_sl"][str(int(sl))][str(int(tp))] = {
                    "pnl": round(float(pnl), 2),
                    "exit_kind": kind,
                    "exit": round(float(touch["fill"]) + float(pnl) * touch["side"], 2),
                    "stop": round(float(touch["fill"]) - sl * touch["side"], 2),
                    "target": round(float(touch["fill"]) + tp * touch["side"], 2),
                }
        rows.append(item)
    return rows


def page(data):
    html = b.REPORT_PAGE.replace("__DATA__", data)
    html = html.replace("<title>Nasdaq level retrace</title>", "<title>Nasdaq continuation</title>", 1)
    html = html.replace("<h1>Nasdaq level retrace</h1>", "<h1>Nasdaq continuation</h1>", 1)
    old_cross = "Crossing up sells. Crossing down buys. "
    new_cross = (
        "Buy when price crosses up through a level. Sell when price crosses down through a level. "
        "Touch enters on that cross, including a wick. Close beyond waits until the one-minute bar "
        "finishes strictly beyond the level and enters at the close. A wick that closes back is not "
        "a close-beyond trade. "
    )
    if html.count(old_cross) != 1:
        raise SystemExit("cross sentence missing")
    html = html.replace(old_cross, new_cross, 1)
    html = html.replace(
        '<p><a href="definitions.html">How these numbers are calculated</a></p>',
        '<p><a href="definitions.html#continuation">How these numbers are calculated</a>. '
        'The fade book, which sells a cross up and buys a cross down, is <a href="report.html">report.html</a>.</p>',
        1,
    )
    old_look = '{key: "look", title: "Lookback", options: [["month", "1 month"], ["6month", "6 months"], ["year", "1 year"], ["all", "All history"]]}'
    new_look = (
        '{key: "trigger", title: "Trigger", options: [["touch", "Touch"], ["close", "Close beyond"]]},\n  '
        + old_look
    )
    if html.count(old_look) != 1:
        raise SystemExit("lookback filter missing")
    html = html.replace(old_look, new_look, 1)
    html = html.replace(
        'const nameLook = {month: "1 month", "6month": "6 months", year: "1 year", all: "All history"};',
        'const nameLook = {month: "1 month", "6month": "6 months", year: "1 year", all: "All history"};\n'
        'const nameTrigger = {touch: "Touch", close: "Close beyond"};',
        1,
    )
    html = html.replace(
        '["Lookback", "look", (v) => nameLook[v]]',
        '["Trigger", "trigger", (v) => nameTrigger[v]],\n    ["Lookback", "look", (v) => nameLook[v]]',
        1,
    )
    html = html.replace(
        "Stop ${run.sl} points, target ${run.tp} points.",
        "${nameTrigger[run.trigger]}. Stop ${run.sl} points, target ${run.tp} points.",
        1,
    )
    html = html.replace("const pack = DATA.audit[run.look];", "const pack = DATA.audit[run.look][run.trigger];", 1)
    return html


def main():
    print("Loading", b.CSV, flush=True)
    ts, o, h, l, c = b.load()
    clock = b.clocks(ts)
    records = b.build_levels(ts, o, c, clock)
    block_low, block_high = b.prepare_blocks(h, l, c)
    bars = b.audit_bars(ts, o, h, l, c, clock)
    summaries = []
    audit = {}
    for look, days in b.LOOKBACKS:
        print(f"Lookback {look}", flush=True)
        bundles, levels = build(records, days, ts, o, h, l, c, clock, block_low, block_high)
        print(f"  touch {len(bundles['touch'])} close {len(bundles['close'])}", flush=True)
        audit[look] = {}
        for trigger in TRIGGERS:
            touches = bundles[trigger]
            pack = {"levels": levels, "decisions": {}}
            for sl in b.STOPS:
                for tp in b.TARGETS:
                    for session in b.SESSIONS:
                        for concurrency in b.CONCURRENCY:
                            for manage in b.MANAGE:
                                cid = f"sl{int(sl)}_tp{int(tp)}_{session}_{concurrency}_{manage}_{look}_{trigger}"
                                trades, decisions = b.simulate(touches, sl, tp, session, concurrency, manage)
                                stats = b.metrics(trades, sl)
                                stats.update(
                                    {
                                        "id": cid,
                                        "sl": int(sl),
                                        "tp": int(tp),
                                        "session": session,
                                        "concurrency": concurrency,
                                        "manage": manage,
                                        "look": look,
                                        "trigger": trigger,
                                    }
                                )
                                summaries.append(stats)
                                pack["decisions"][cid] = decisions
                                print(f"  {cid}: {stats['trades']} trades, net {stats['net_points']}", flush=True)
                                if cid == "sl50_tp50_all_every_one_month_touch":
                                    if stats["trades"] != 1668 or abs(stats["net_points"] + 3600.0) > 0.15:
                                        raise SystemExit(
                                            f"month reverse drifted: {stats['trades']} {stats['net_points']}"
                                        )
                                if cid == "sl50_tp50_ny_serial_greedy_all_touch":
                                    if stats["trades"] != 17757 or abs(stats["net_points"] - 48126.8) > 0.15:
                                        raise SystemExit(
                                            f"reverse benchmark drifted: {stats['trades']} {stats['net_points']}"
                                        )
            pack["touches"] = audit_items(touches)
            audit[look][trigger] = pack
            print(f"  audit {trigger} touches {len(pack['touches'])}", flush=True)
        del bundles
        gc.collect()
    data = json.dumps({"summaries": summaries, "factors": [], "audit": audit, "bars": bars}).replace("<", "\\u003c")
    OUT.write_text(page(data), encoding="utf-8")
    ranked = sorted(summaries, key=lambda row: row["net_points"], reverse=True)
    positive = sum(row["net_points"] > 0 for row in summaries)
    print(f"{positive}/{len(summaries)} positive", flush=True)
    print("Top 10", flush=True)
    for row in ranked[:10]:
        print(
            f"  {row['id']}: {row['trades']} trades, win {row['win_rate']}%, "
            f"net {row['net_points']}, pf {row['profit_factor']}, dd {row['max_drawdown']}",
            flush=True,
        )
    print("Wrote", OUT, flush=True)


if __name__ == "__main__":
    main()
