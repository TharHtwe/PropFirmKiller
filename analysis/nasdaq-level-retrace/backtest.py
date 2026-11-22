"""Nasdaq open/close level retrace.

Levels are the open and the close of every completed daily and weekly candle.
Daily and weekly candles use the DMC/CME clock: 17:00 to 16:00 America/Chicago.
Weekly is yellow and daily is #2962ff, the same colors as DMCChartRead.

Entry is a cross of any such level during the chosen session.
Crossing up is a sell. Crossing down is a buy.
Targets are 50, 100, 150, and 200 index points. Stops are 50 or 100.
One contract, scored in points. Bid prices, no spread.

Run: python backtest.py
"""

from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path

import numpy as np
import pandas as pd
from numba import njit

ROOT = Path(__file__).resolve().parent
CSV = ROOT.parent / "data" / "usatechidxusd-m1-bid-2020-01-01-2026-10-25.csv"
OUT = ROOT / "results"
TARGETS = (50.0, 100.0, 150.0, 200.0)
DAY_CAP = 50.0
AUDIT_YMD = 20261023
BLOCK = 64

SESSIONS = ("london", "ny", "rth", "all")
CONCURRENCY = ("every", "serial")
MANAGE = ("one", "until", "greedy")
LOOKBACKS = (("month", 30), ("6month", 182), ("year", 365), ("all", None))
STOPS = (50.0, 100.0)
EXIT_INDEX = {
    (int(sl), int(tp)): si * len(TARGETS) + ti
    for si, sl in enumerate(STOPS)
    for ti, tp in enumerate(TARGETS)
}

# New York is the business day, 08:00-17:00 ET. RTH is the cash session inside it, 09:30-16:00.
# All is London plus that New York day. RTH needs no extra minutes.
SESSION_NAME = {
    "london": "London only",
    "ny": "New York only",
    "rth": "New York RTH only",
    "all": "All",
}
CONCURRENCY_NAME = {
    "every": "Every level, even if another trade is open",
    "serial": "One trade at a time",
}
MANAGE_NAME = {
    "one": "One trade per day",
    "until": "Keep going until the day is up 50 points",
    "greedy": "No daily profit cap",
}
LOOK_NAME = {"month": "1 month", "6month": "6 months", "year": "1 year", "all": "All history"}


def config_id(sl, tp, session, concurrency, manage, look):
    return f"sl{int(sl)}_tp{int(tp)}_{session}_{concurrency}_{manage}_{look}"


def first_hit(a, b, stop, tp):
    span = b - a
    hits = []
    if span == 0:
        if a == stop:
            hits.append(("stop", stop, 0.0))
        if a == tp:
            hits.append(("target", tp, 0.0))
    else:
        for kind, price in (("stop", stop), ("target", tp)):
            frac = (price - a) / span
            if 0.0 <= frac <= 1.0:
                hits.append((kind, price, frac))
    if not hits:
        return None
    hits.sort(key=lambda item: item[2])
    # A tie on the same price is a stop. The two prices differ in normal use.
    if len(hits) == 2 and abs(hits[0][2] - hits[1][2]) < 1e-12:
        hits.sort(key=lambda item: 0 if item[0] == "stop" else 1)
    return hits[0]


def pos_rank(bar_i, seg, a, b, price):
    span = b - a
    frac = 0.0 if span == 0 else (price - a) / span
    frac = min(max(frac, 0.0), 1.0)
    return bar_i * 10.0 + seg + frac * 0.999


def bar_points(prev, o, h, l, c):
    points = []
    if prev is not None and prev != o:
        points.append(prev)
    if c >= o:
        points.extend((o, l, h, c))
    else:
        points.extend((o, h, l, c))
    # Drop zero-length joins so a level is not tested twice on a flat print.
    cleaned = [points[0]]
    for price in points[1:]:
        if price != cleaned[-1]:
            cleaned.append(price)
    return cleaned


def self_check():
    # Rising through 110 and on to 160. Sell 110, stop 50 is 160, and that bar hits it.
    hit = first_hit(110.0, 160.0, 160.0, 60.0)
    assert hit is not None and hit[0] == "stop" and hit[1] == 160.0
    # Falling 200 to 140 does not reach a buy stop at 130 or a target at 230.
    assert first_hit(180.0, 140.0, 130.0, 230.0) is None
    # Closer target wins when both sit on the same segment.
    hit = first_hit(0.0, 100.0, 80.0, 40.0)
    assert hit[0] == "target" and hit[1] == 40.0
    # Path order: down first on a bullish bar, so support is traded before resistance.
    pts = bar_points(None, 100.0, 120.0, 90.0, 110.0)
    assert pts == [100.0, 90.0, 120.0, 110.0]
    # Buy at 0. Next bar runs through 50, 100, 150, and 200. Every target wins.
    o = np.array([0.0, 0.0])
    h = np.array([0.0, 220.0])
    l = np.array([0.0, 0.0])
    c = np.array([0.0, 210.0])
    block_low, block_high = prepare_blocks(h, l, c)
    done = resolve_one_stop(1, 0.0, 50.0, 0, 0, [0.0, 0.0], o, h, l, c, block_low, block_high)
    assert [done[tp][1] for tp in (50, 100, 150, 200)] == ["target"] * 4
    assert [done[tp][0] for tp in (50, 100, 150, 200)] == [50.0, 100.0, 150.0, 200.0]
    # Same buy, but the next bar only reaches 120 and the one after hits the stop.
    o = np.array([0.0, 0.0, 120.0])
    h = np.array([0.0, 120.0, 120.0])
    l = np.array([0.0, 0.0, -80.0])
    c = np.array([0.0, 120.0, -80.0])
    block_low, block_high = prepare_blocks(h, l, c)
    done = resolve_one_stop(1, 0.0, 50.0, 0, 0, [0.0, 0.0], o, h, l, c, block_low, block_high)
    assert done[50][1] == "target" and done[100][1] == "target"
    assert done[150][1] == "stop" and done[200][1] == "stop"
    assert done[150][0] == -50.0
    # One target at a time matches the single-target walk, both sides and both stops.
    rng = np.random.default_rng(7)
    n = 80
    o = 15000 + np.cumsum(rng.normal(0, 6, n))
    c = o + rng.normal(0, 4, n)
    h = np.maximum(o, c) + rng.random(n) * 12
    l = np.minimum(o, c) - rng.random(n) * 12
    block_low, block_high = prepare_blocks(h, l, c)
    for bar in (3, 10, 25):
        points = bar_points(c[bar - 1], o[bar], h[bar], l[bar], c[bar])
        fill = (points[0] + points[1]) / 2.0
        for side in (1, -1):
            for sl in STOPS:
                multi = resolve_one_stop(side, fill, sl, bar, 0, points, o, h, l, c, block_low, block_high)
                for tp in TARGETS:
                    single = resolve(side, fill, sl, bar, 0, points, o, h, l, c, block_low, block_high, tp)
                    got = multi[int(tp)]
                    assert got[1] == single["kind"]
                    assert abs(got[0] - single["pnl"]) < 1e-6
                    assert abs(got[2] - single["rank"]) < 1e-6
                    assert got[3] == single["bar"]


def load():
    frame = pd.read_csv(CSV, usecols=["timestamp", "open", "high", "low", "close"])
    ts = frame["timestamp"].to_numpy(np.int64)
    o = frame["open"].to_numpy(np.float64)
    h = frame["high"].to_numpy(np.float64)
    l = frame["low"].to_numpy(np.float64)
    c = frame["close"].to_numpy(np.float64)
    order = np.argsort(ts, kind="mergesort")
    return ts[order], o[order], h[order], l[order], c[order]


def clocks(ts):
    utc = pd.to_datetime(ts, unit="ms", utc=True)
    ct = utc.tz_convert("America/Chicago")
    ny = utc.tz_convert("America/New_York")
    lon = utc.tz_convert("Europe/London")
    ct_mins = (np.asarray(ct.hour, dtype=np.int32) * 60 + np.asarray(ct.minute, dtype=np.int32))
    ny_mins = (np.asarray(ny.hour, dtype=np.int32) * 60 + np.asarray(ny.minute, dtype=np.int32))
    lon_mins = (np.asarray(lon.hour, dtype=np.int32) * 60 + np.asarray(lon.minute, dtype=np.int32))
    ct_days = ct.tz_localize(None).to_numpy().astype("datetime64[D]")
    ny_ymd = (
        np.asarray(ny.year, dtype=np.int32) * 10000
        + np.asarray(ny.month, dtype=np.int32) * 100
        + np.asarray(ny.day, dtype=np.int32)
    )
    in_candle = (ct_mins >= 17 * 60) | (ct_mins < 16 * 60)
    open_days = ct_days.copy()
    open_days[ct_mins < 16 * 60] = open_days[ct_mins < 16 * 60] - np.timedelta64(1, "D")
    # numpy weekday with Monday=0: 1970-01-01 was a Thursday.
    weekday = (open_days.view("int64") + 3) % 7
    week_sunday = open_days - ((weekday + 1) % 7).astype("timedelta64[D]")
    in_rth = (ny_mins >= 9 * 60 + 30) & (ny_mins < 16 * 60)
    in_ny = (ny_mins >= 8 * 60) & (ny_mins < 17 * 60)
    in_lon = (lon_mins >= 8 * 60) & (lon_mins < 16 * 60 + 30)
    return {
        "ct_mins": ct_mins,
        "ct_days": ct_days,
        "ny_ymd": ny_ymd,
        "in_candle": in_candle,
        "open_days": open_days,
        "week_sunday": week_sunday,
        "in_ny": in_ny,
        "in_rth": in_rth,
        "in_lon": in_lon,
    }


def candle_table(index, key, o, c, n):
    frame = pd.DataFrame({"i": index, "key": key, "open": o[index], "close": c[index]})
    grouped = frame.groupby("key", sort=True).agg(
        start=("i", "first"), end=("i", "last"), open=("open", "first"), close=("close", "last")
    )
    grouped = grouped[grouped["end"] < n - 1]
    return grouped


def build_levels(ts, o, c, clock):
    n = len(ts)
    valid = np.flatnonzero(clock["in_candle"])
    daily = candle_table(valid, clock["open_days"][valid], o, c, n)
    weekly = candle_table(valid, clock["week_sunday"][valid], o, c, n)
    records = []

    def add(table, kind):
        for key, row in table.iterrows():
            start = int(row["start"])
            end = int(row["end"])
            started = clock["ct_days"][start] == np.datetime64(key, "D") and clock["ct_mins"][start] >= 17 * 60
            if not started:
                continue
            label = str(clock["ct_days"][end])
            for part, price in (("open", float(row["open"])), ("close", float(row["close"]))):
                cents = int(round(price * 100))
                records.append(
                    {
                        "cents": cents,
                        "price": cents / 100.0,
                        "ready_i": end + 1,
                        "close_ts": int(ts[end]),
                        "kind": kind,
                        "part": part,
                        "label": label,
                    }
                )

    add(daily, "D")
    add(weekly, "W")
    records.sort(key=lambda row: row["ready_i"])
    return records


def expire_index(ts, close_ts, days):
    if days is None:
        return len(ts)
    return int(np.searchsorted(ts, close_ts + days * 86_400_000, side="left"))


def day_slices(ny_ymd, tradable):
    idx = np.flatnonzero(tradable)
    if len(idx) == 0:
        return []
    ymd = ny_ymd[idx]
    cuts = np.flatnonzero(np.diff(ymd)) + 1
    bounds = np.r_[0, cuts, len(idx)]
    slices = []
    for a, b in zip(bounds[:-1], bounds[1:]):
        bars = idx[a:b]
        slices.append((int(ymd[a]), int(bars[0]), bars))
    return slices


def active_book(records, day_start, expire_i):
    prices = {}
    labels = defaultdict(list)
    kinds = defaultdict(set)
    for row in records:
        if row["ready_i"] > day_start:
            break
        if expire_i[row["cents_id"]] <= day_start:
            continue
        prices[row["cents"]] = row["price"]
        text = f"{'Daily' if row['kind'] == 'D' else 'Weekly'} {row['part']} {row['label']}"
        if text not in labels[row["cents"]]:
            labels[row["cents"]].append(text)
            kinds[row["cents"]].add(row["kind"])
    if not prices:
        return np.empty(0, np.float64), np.empty(0, np.int32), {}, {}
    cents = np.fromiter(prices.keys(), dtype=np.int32, count=len(prices))
    order = np.argsort(cents)
    cents = cents[order]
    vals = np.array([prices[int(k)] for k in cents], dtype=np.float64)
    label_map = {int(k): labels[int(k)] for k in cents}
    kind_map = {int(k): kinds[int(k)] for k in cents}
    return vals, cents, label_map, kind_map


def prepare_blocks(h, l, c):
    range_low = l.copy()
    range_high = h.copy()
    range_low[1:] = np.minimum(range_low[1:], c[:-1])
    range_high[1:] = np.maximum(range_high[1:], c[:-1])
    pad = (BLOCK - len(h) % BLOCK) % BLOCK
    low_pad = np.pad(range_low, (0, pad), constant_values=np.inf)
    high_pad = np.pad(range_high, (0, pad), constant_values=-np.inf)
    return low_pad.reshape(-1, BLOCK).min(axis=1), high_pad.reshape(-1, BLOCK).max(axis=1)


def scan_forward(bar_i, stop, tp, o, h, l, c, block_low, block_high):
    n = len(o)
    prev = c[bar_i]
    j = bar_i + 1
    limit = n
    while j < limit:
        if j % BLOCK == 0:
            k = j // BLOCK
            if k < len(block_low) and not (
                (block_low[k] <= stop <= block_high[k]) or (block_low[k] <= tp <= block_high[k])
            ):
                j += BLOCK
                if j > n:
                    break
                prev = c[min(j, n) - 1]
                continue
        if j >= n:
            break
        oj, hj, lj, cj = o[j], h[j], l[j], c[j]
        if prev != oj:
            hit = first_hit(prev, oj, stop, tp)
            if hit:
                return hit, j, 0, prev, oj
        if cj >= oj:
            pts = (oj, lj, hj, cj)
        else:
            pts = (oj, hj, lj, cj)
        seg = 1
        a = pts[0]
        for price in pts[1:]:
            if price != a:
                hit = first_hit(a, price, stop, tp)
                if hit:
                    return hit, j, seg, a, price
                seg += 1
                a = price
        prev = cj
        j += 1
    return ("end of data", c[-1], 1.0), n - 1, 9, c[-1], c[-1]


def resolve(side, fill, sl, bar_i, seg_i, points, o, h, l, c, block_low, block_high, target):
    stop = fill - sl * side
    tp = fill + target * side
    # Remainder of the entry segment, then the rest of this bar.
    flat = points[seg_i]
    end = points[seg_i + 1]
    hit = first_hit(fill, end, stop, tp)
    if hit:
        return outcome(side, fill, hit, bar_i, seg_i, fill, end)
    seg = seg_i + 1
    a = end
    for price in points[seg_i + 2 :]:
        hit = first_hit(a, price, stop, tp)
        if hit:
            return outcome(side, fill, hit, bar_i, seg, a, price)
        seg += 1
        a = price
    hit, j, seg, a, b = scan_forward(bar_i, stop, tp, o, h, l, c, block_low, block_high)
    if hit[0] == "end of data":
        pnl = side * (c[-1] - fill)
        return {
            "pnl": pnl,
            "kind": "end of data",
            "exit": c[-1],
            "rank": (len(c) - 1) * 10.0 + 9.0,
            "bar": len(c) - 1,
        }
    return outcome(side, fill, hit, j, seg, a, b)


def outcome(side, fill, hit, bar_i, seg, a, b):
    kind, price, _frac = hit
    pnl = side * (price - fill)
    return {
        "pnl": pnl,
        "kind": kind,
        "exit": price,
        "rank": pos_rank(bar_i, seg, a, b, price),
        "bar": bar_i,
    }


_KIND_NAME = ("stop", "target", "end of data")


@njit(cache=True)
def _consume_segment(
    a, b, bar, seg, stop_px, tp_px, found, found_rank, found_bar, found_price,
    n_found, stop_on, stop_rank, stop_bar, stop_price, fracs, ties, names, prices,
):
    if stop_on != 0 or n_found == 4:
        return n_found, stop_on, stop_rank, stop_bar, stop_price, 1
    span = b - a
    nh = 0
    if stop_on == 0:
        take = 0
        frac = 0.0
        if span == 0.0:
            take = 1 if a == stop_px else 0
        else:
            frac = (stop_px - a) / span
            take = 1 if 0.0 <= frac <= 1.0 else 0
        if take:
            fracs[nh] = 0.0 if span == 0.0 else frac
            ties[nh] = 0
            names[nh] = -1
            prices[nh] = stop_px
            nh += 1
    for i in range(4):
        if found[i] != 0:
            continue
        price = tp_px[i]
        take = 0
        frac = 0.0
        if span == 0.0:
            take = 1 if a == price else 0
        else:
            frac = (price - a) / span
            take = 1 if 0.0 <= frac <= 1.0 else 0
        if take:
            fracs[nh] = 0.0 if span == 0.0 else frac
            ties[nh] = 1
            names[nh] = i
            prices[nh] = price
            nh += 1
    if nh == 0:
        return n_found, stop_on, stop_rank, stop_bar, stop_price, 0
    for i in range(1, nh):
        fr = fracs[i]
        ti = ties[i]
        nm = names[i]
        pr = prices[i]
        j = i
        while j > 0 and (fracs[j - 1] > fr or (fracs[j - 1] == fr and ties[j - 1] > ti)):
            fracs[j] = fracs[j - 1]
            ties[j] = ties[j - 1]
            names[j] = names[j - 1]
            prices[j] = prices[j - 1]
            j -= 1
        fracs[j] = fr
        ties[j] = ti
        names[j] = nm
        prices[j] = pr
    done = 0
    for k in range(nh):
        price = prices[k]
        if span == 0.0:
            frac = 0.0
        else:
            frac = (price - a) / span
            if frac < 0.0:
                frac = 0.0
            elif frac > 1.0:
                frac = 1.0
        rank = bar * 10.0 + seg + frac * 0.999
        if names[k] < 0:
            stop_on = 1
            stop_rank = rank
            stop_bar = bar
            stop_price = price
            done = 1
            break
        i = names[k]
        found[i] = 1
        found_rank[i] = rank
        found_bar[i] = bar
        found_price[i] = price
        n_found += 1
        if n_found == 4:
            done = 1
            break
    return n_found, stop_on, stop_rank, stop_bar, stop_price, done


@njit(cache=True)
def resolve_stop_nb(side, fill, sl, bar_i, seg_i, points, o, h, l, c):
    tp_px = np.empty(4, np.float64)
    tp_px[0] = fill + 50.0 * side
    tp_px[1] = fill + 100.0 * side
    tp_px[2] = fill + 150.0 * side
    tp_px[3] = fill + 200.0 * side
    stop_px = fill - sl * side
    found = np.zeros(4, np.int8)
    found_rank = np.zeros(4, np.float64)
    found_bar = np.zeros(4, np.int32)
    found_price = np.zeros(4, np.float64)
    fracs = np.empty(5, np.float64)
    ties = np.empty(5, np.int8)
    names = np.empty(5, np.int8)
    prices = np.empty(5, np.float64)
    n_found = 0
    stop_on = 0
    stop_rank = 0.0
    stop_bar = 0
    stop_price = 0.0
    n_found, stop_on, stop_rank, stop_bar, stop_price, done = _consume_segment(
        fill, points[seg_i + 1], bar_i, seg_i, stop_px, tp_px, found, found_rank, found_bar, found_price,
        n_found, stop_on, stop_rank, stop_bar, stop_price, fracs, ties, names, prices,
    )
    if done == 0:
        seg = seg_i + 1
        a = points[seg_i + 1]
        for p_i in range(seg_i + 2, len(points)):
            price = points[p_i]
            n_found, stop_on, stop_rank, stop_bar, stop_price, done = _consume_segment(
                a, price, bar_i, seg, stop_px, tp_px, found, found_rank, found_bar, found_price,
                n_found, stop_on, stop_rank, stop_bar, stop_price, fracs, ties, names, prices,
            )
            seg += 1
            a = price
            if done:
                break
    if done == 0:
        n = len(o)
        prev = c[bar_i]
        j = bar_i + 1
        while j < n and done == 0:
            lj = l[j]
            hj = h[j]
            lo = lj if prev >= lj else prev
            hi = hj if prev <= hj else prev
            interesting = 1 if (stop_on == 0 and lo <= stop_px <= hi) else 0
            if interesting == 0:
                for i in range(4):
                    if found[i] == 0 and lo <= tp_px[i] <= hi:
                        interesting = 1
                        break
            if interesting == 0:
                prev = c[j]
                j += 1
                continue
            oj = o[j]
            cj = c[j]
            if prev != oj:
                n_found, stop_on, stop_rank, stop_bar, stop_price, done = _consume_segment(
                    prev, oj, j, 0, stop_px, tp_px, found, found_rank, found_bar, found_price,
                    n_found, stop_on, stop_rank, stop_bar, stop_price, fracs, ties, names, prices,
                )
            if done == 0:
                if cj >= oj:
                    p1 = lj
                    p2 = hj
                else:
                    p1 = hj
                    p2 = lj
                seg = 1
                a = oj
                for step in range(3):
                    price = p1 if step == 0 else (p2 if step == 1 else cj)
                    if price != a:
                        n_found, stop_on, stop_rank, stop_bar, stop_price, done = _consume_segment(
                            a, price, j, seg, stop_px, tp_px, found, found_rank, found_bar, found_price,
                            n_found, stop_on, stop_rank, stop_bar, stop_price, fracs, ties, names, prices,
                        )
                        seg += 1
                        a = price
                        if done:
                            break
            prev = cj
            j += 1
    pnl = np.empty(4, np.float64)
    kind = np.empty(4, np.int8)
    rank = np.empty(4, np.float64)
    bars = np.empty(4, np.int32)
    last = len(c) - 1
    end_pnl = side * (c[last] - fill)
    end_rank = last * 10.0 + 9.0
    for i in range(4):
        if found[i] != 0 and (stop_on == 0 or found_rank[i] < stop_rank):
            pnl[i] = side * (found_price[i] - fill)
            kind[i] = 1
            rank[i] = found_rank[i]
            bars[i] = found_bar[i]
        elif stop_on != 0:
            pnl[i] = side * (stop_price - fill)
            kind[i] = 0
            rank[i] = stop_rank
            bars[i] = stop_bar
        else:
            pnl[i] = end_pnl
            kind[i] = 2
            rank[i] = end_rank
            bars[i] = last
    return pnl, kind, rank, bars


def resolve_one_stop(side, fill, sl, bar_i, seg_i, points, o, h, l, c, block_low, block_high):
    """First stop or target along the path, for every target, in one walk.

    A target that prints before the stop is a win. A later target still open
    when the stop prints is a loss. The walk ends when the stop prints or the
    farthest target has printed.
    """
    del block_low, block_high
    pts = np.asarray(points, dtype=np.float64)
    pnl, kind, rank, bars = resolve_stop_nb(
        float(side), float(fill), float(sl), int(bar_i), int(seg_i), pts, o, h, l, c
    )
    return {
        int(TARGETS[i]): (float(pnl[i]), _KIND_NAME[int(kind[i])], float(rank[i]), int(bars[i]))
        for i in range(4)
    }


def crosses(points, prices, cents):
    found = []
    seg = 0
    for a, b in zip(points, points[1:]):
        if b > a:
            lo = int(np.searchsorted(prices, a, side="right"))
            hi = int(np.searchsorted(prices, b, side="right"))
            order = range(lo, hi)
            side = -1
        else:
            lo = int(np.searchsorted(prices, b, side="left"))
            hi = int(np.searchsorted(prices, a, side="left"))
            order = range(hi - 1, lo - 1, -1)
            side = 1
        for k in order:
            found.append((seg, a, b, float(prices[k]), int(cents[k]), side))
        seg += 1
    return found


def generate(records, look_days, ts, o, h, l, c, clock, block_low, block_high):
    n = len(ts)
    for i, row in enumerate(records):
        row["cents_id"] = i
    expire_i = np.array([expire_index(ts, row["close_ts"], look_days) for row in records], dtype=np.int32)
    tradable = clock["in_ny"] | clock["in_lon"]
    slices = day_slices(clock["ny_ymd"], tradable)
    touches = []
    audit_levels = []
    cursor = 0
    records_ready = records
    for ymd, day_start, bars in slices:
        while cursor < len(records_ready) and records_ready[cursor]["ready_i"] <= day_start:
            cursor += 1
        prices, cents, labels, kinds = active_book(records_ready[:cursor], day_start, expire_i)
        if ymd == AUDIT_YMD:
            for k, price in zip(cents, prices):
                kind = kinds[int(k)]
                if kind == {"D", "W"}:
                    color = "both"
                elif "W" in kind:
                    color = "weekly"
                else:
                    color = "daily"
                audit_levels.append(
                    {"price": float(price), "color": color, "sources": labels[int(k)]}
                )
        if len(prices) == 0:
            continue
        for bar in bars:
            prev = None if bar == 0 else c[bar - 1]
            points = bar_points(prev, o[bar], h[bar], l[bar], c[bar])
            if len(points) < 2:
                continue
            for seg, a, b, price, cent, side in crosses(points, prices, cents):
                fill = b if (seg == 0 and prev is not None and prev != o[bar] and price != b) else price
                # Gap fills happen at the open. Rank them in the order the level was crossed.
                if fill == b and price != b:
                    entry_rank = pos_rank(bar, seg, a, b, b) - (abs(b - price) * 1e-6)
                else:
                    entry_rank = pos_rank(bar, seg, a, b, price)
                slots = [None] * (len(STOPS) * len(TARGETS))
                for sl in STOPS:
                    by_tp = resolve_one_stop(side, fill, sl, int(bar), seg, points, o, h, l, c, block_low, block_high)
                    for tp in TARGETS:
                        slots[EXIT_INDEX[(int(sl), int(tp))]] = by_tp[int(tp)]
                touches.append(
                    {
                        "ymd": ymd,
                        "bar": int(bar),
                        "ts": int(ts[bar]),
                        "rank": entry_rank,
                        "cent": cent,
                        "price": price,
                        "side": side,
                        "fill": fill,
                        "in_ny": bool(clock["in_ny"][bar]),
                        "in_rth": bool(clock["in_rth"][bar]),
                        "in_lon": bool(clock["in_lon"][bar]),
                        "sources": labels.get(cent, []),
                        "exits": tuple(slots),
                    }
                )
    return touches, audit_levels


def simulate(touches, sl, tp, session, concurrency, manage):
    slot = EXIT_INDEX[(int(sl), int(tp))]
    position_exit = -1.0
    today = None
    taken_today = 0
    today_closed = []
    used = set()
    trades = []
    decisions = []
    for touch in touches:
        if touch["ymd"] != today:
            today = touch["ymd"]
            taken_today = 0
            today_closed = []
        in_session = {
            "london": touch["in_lon"],
            "ny": touch["in_ny"],
            "rth": touch["in_rth"],
            "all": touch["in_lon"] or touch["in_ny"],
        }[session]
        reason = None
        if not in_session:
            reason = "outside session"
        elif manage == "one" and taken_today:
            reason = "daily trade already taken"
        else:
            realized = sum(pnl for exit_rank, pnl in today_closed if exit_rank < touch["rank"])
            if manage == "until" and realized >= DAY_CAP:
                reason = "day is up 50 points"
            elif concurrency == "serial" and position_exit > touch["rank"]:
                reason = "a trade is still open"
            elif (today, touch["cent"]) in used:
                reason = "level already used today"
        pnl, kind, rank, bar = touch["exits"][slot]
        take = reason is None
        if take:
            reason = "taken"
            used.add((today, touch["cent"]))
            taken_today += 1
            today_closed.append((rank, pnl))
            if concurrency == "serial":
                position_exit = rank
            trades.append(
                (
                    touch,
                    {
                        "pnl": pnl,
                        "kind": kind,
                        "rank": rank,
                        "bar": bar,
                        "exit": touch["fill"] + pnl * touch["side"],
                    },
                )
            )
        if touch["ymd"] == AUDIT_YMD:
            decisions.append(reason)
    return trades, decisions


def ymd_to_ord(ymd):
    y, m, d = divmod(ymd, 10000)[0], divmod(ymd, 100)[1] // 1, ymd % 100
    y = ymd // 10000
    m = (ymd // 100) % 100
    d = ymd % 100
    return int(np.datetime64(f"{y:04d}-{m:02d}-{d:02d}").astype("datetime64[D]").view("int64"))


def max_drawdown(pnls):
    if len(pnls) == 0:
        return 0.0, 0
    equity = np.cumsum(pnls)
    peak = np.maximum.accumulate(equity)
    dd = peak - equity
    worst = float(dd.max()) if len(dd) else 0.0
    longest = 0
    length = 0
    for value in dd:
        if value > 1e-9:
            length += 1
            longest = max(longest, length)
        else:
            length = 0
    return worst, longest


def pearson_lag1(values):
    if len(values) < 3:
        return None
    a = values[:-1]
    b = values[1:]
    if a.std() == 0 or b.std() == 0:
        return 0.0
    return float(((a - a.mean()) * (b - b.mean())).mean() / (a.std() * b.std()))


def streak_tables(pnls, cap=15):
    after_loss = [[0, 0] for _ in range(cap + 1)]
    after_win = [[0, 0] for _ in range(cap + 1)]
    streak = 0
    prev = None
    max_wins = 0
    max_losses = 0
    for pnl in pnls:
        won = pnl > 0
        if prev is not None:
            if streak < 0:
                for k in range(1, min(-streak, cap) + 1):
                    after_loss[k][0] += 1
                    after_loss[k][1] += int(won)
            elif streak > 0:
                for k in range(1, min(streak, cap) + 1):
                    after_win[k][0] += 1
                    after_win[k][1] += int(won)
        if prev is None or won != prev:
            streak = 1 if won else -1
        elif won:
            streak += 1
        else:
            streak -= 1
        prev = won
        if streak > 0:
            max_wins = max(max_wins, streak)
        else:
            max_losses = max(max_losses, -streak)

    def pack(rows, win_field):
        out = []
        for k, (count, wins) in enumerate(rows):
            if k == 0 or count == 0:
                continue
            win_pct = 100.0 * wins / count
            out.append(
                {
                    "k": k,
                    "n": count,
                    "next_win_pct": round(win_pct, 1),
                    "next_loss_pct": round(100.0 - win_pct, 1),
                }
            )
        return out

    return pack(after_loss, "win"), pack(after_win, "loss"), max_wins, max_losses


def autocorrelation_block(pnls, sl):
    pnls = np.asarray(pnls, dtype=np.float64)
    n = len(pnls)
    if n < 2:
        return None
    wins = pnls > 0
    uc = float(wins.mean())
    after_loss_mask = ~wins[:-1]
    after_win_mask = wins[:-1]
    co_n = int(after_loss_mask.sum())
    aw_n = int(after_win_mask.sum())
    co = float(wins[1:][after_loss_mask].mean()) if co_n else None
    aw = float(wins[1:][after_win_mask].mean()) if aw_n else None
    gap = None if co is None else round((uc - co) * 100.0, 1)
    if gap is None:
        sign, band = "unknown", "not enough losses"
        frac_name, frac = "fixed risk", 0.0
    else:
        mag = abs(gap)
        if mag <= 2:
            sign, band, frac_name, frac = "zero", "no autocorrelation, fixed risk", "fixed risk", 0.0
        elif mag <= 4:
            sign, band, frac_name, frac = "weak", "weak", "1/5 Kelly", 0.2
        elif mag <= 6:
            sign, band, frac_name, frac = "solid", "solid", "1/3 Kelly", 1.0 / 3.0
        elif mag <= 8:
            sign, band, frac_name, frac = "stronger", "stronger", "1/2 Kelly", 0.5
        else:
            sign, band, frac_name, frac = "extreme", "extreme, check the data", "not used", 0.0
        if gap < -2:
            sign = "negative"
        elif gap > 2:
            sign = "positive"
        else:
            sign = "zero"
    winners = pnls[wins]
    losers = pnls[~wins]
    avg_winner_r = float(winners.mean() / sl) if len(winners) else None
    p = uc
    q = 1.0 - p
    kelly = None
    if avg_winner_r and avg_winner_r > 0 and len(losers):
        kelly = p - (q / avg_winner_r)
    bet = None if kelly is None else max(0.0, kelly * frac)
    if sign == "positive":
        sizing = (
            "Wins cluster. His map raises risk after a win and cuts it after a loss. "
            f"The fraction on that map is {frac_name}."
        )
    elif sign == "negative":
        sizing = (
            "Results alternate. His map cuts risk after a win and can raise it after a loss. "
            f"The fraction on that map is {frac_name}."
        )
    else:
        sizing = "No autocorrelation on his scale. Fixed size only. Kelly is not used."
    loss_rows, win_rows, max_wins, max_losses = streak_tables(pnls)
    return {
        "trades": n,
        "unconditional_win_pct": round(uc * 100.0, 1),
        "conditional_win_pct": None if co is None else round(co * 100.0, 1),
        "after_loss": co_n,
        "after_win_win_pct": None if aw is None else round(aw * 100.0, 1),
        "after_win": aw_n,
        "gap": gap,
        "sign": sign,
        "band": band,
        "pearson_winloss": None if pearson_lag1(wins.astype(float)) is None else round(pearson_lag1(wins.astype(float)), 3),
        "pearson_points": None if pearson_lag1(pnls) is None else round(pearson_lag1(pnls), 3),
        "kelly_full": None if kelly is None else round(kelly, 4),
        "kelly_fraction": frac_name,
        "kelly_bet": None if bet is None else round(bet, 4),
        "sizing": sizing,
        "after_loss_streaks": loss_rows,
        "after_win_streaks": win_rows,
        "max_consecutive_wins": max_wins,
        "max_consecutive_losses": max_losses,
    }


def profit_factor(pnls):
    gains = float(pnls[pnls > 0].sum()) if np.any(pnls > 0) else 0.0
    losses = float(-pnls[pnls < 0].sum()) if np.any(pnls < 0) else 0.0
    if losses == 0:
        return None
    return gains / losses


def metrics(trades, sl):
    if not trades:
        return {
            "trades": 0,
            "wins": 0,
            "losses": 0,
            "win_rate": None,
            "net_points": 0.0,
            "expectancy": None,
            "profit_factor": None,
            "profit_factor_without_best": None,
            "max_drawdown": 0.0,
            "max_drawdown_trades": 0,
            "payoff": None,
            "longs": 0,
            "shorts": 0,
            "long_net": 0.0,
            "short_net": 0.0,
            "targets": 0,
            "stops": 0,
            "forced": 0,
            "chunks": [],
            "autocorrelation": None,
            "equity": [],
            "best_day": None,
            "worst_day": None,
            "avg_minutes": None,
        }
    pnls = np.array([done["pnl"] for _touch, done in trades], dtype=np.float64)
    wins = pnls > 0
    losers = pnls[~wins]
    winners = pnls[wins]
    pf = profit_factor(pnls)
    pf2 = None
    if len(pnls) > 1:
        cut = pnls.copy()
        cut[int(np.argmax(cut))] = 0.0
        pf2 = profit_factor(cut)
    dd, dd_len = max_drawdown(pnls)
    auto = autocorrelation_block(pnls, sl)
    equity = np.cumsum(pnls)
    step = max(1, len(equity) // 160)
    curve = [round(float(v), 2) for v in equity[step - 1 :: step]]
    if curve and curve[-1] != round(float(equity[-1]), 2):
        curve.append(round(float(equity[-1]), 2))
    by_day = defaultdict(float)
    minutes = []
    longs = shorts = 0
    long_net = short_net = 0.0
    targets = stops = forced = 0
    for touch, done in trades:
        by_day[touch["ymd"]] += done["pnl"]
        minutes.append(max(0, done["bar"] - touch["bar"]))
        if touch["side"] == 1:
            longs += 1
            long_net += done["pnl"]
        else:
            shorts += 1
            short_net += done["pnl"]
        if done["kind"] == "target":
            targets += 1
        elif done["kind"] == "stop":
            stops += 1
        else:
            forced += 1
    day_vals = list(by_day.values())
    best = max(by_day.items(), key=lambda item: item[1])
    worst = min(by_day.items(), key=lambda item: item[1])
    chunks = []
    if len(pnls) >= 10:
        size = len(pnls) // 10
        for i in range(10):
            block = wins[i * size : (i + 1) * size]
            chunks.append(round(100.0 * float(block.mean()), 1))
    day_arr = np.array(day_vals, dtype=np.float64)
    swing = float(day_arr.std()) if len(day_arr) else 0.0
    return {
        "trades": int(len(pnls)),
        "wins": int(wins.sum()),
        "losses": int((~wins).sum()),
        "win_rate": round(100.0 * float(wins.mean()), 1),
        "net_points": round(float(pnls.sum()), 1),
        "expectancy": round(float(pnls.mean()), 2),
        "profit_factor": None if pf is None else round(pf, 3),
        "profit_factor_without_best": None if pf2 is None else round(pf2, 3),
        "max_drawdown": round(dd, 1),
        "max_drawdown_trades": dd_len,
        "payoff": None if len(losers) == 0 or len(winners) == 0 else round(float(winners.mean() / -losers.mean()), 3),
        "avg_win": None if len(winners) == 0 else round(float(winners.mean()), 2),
        "avg_loss": None if len(losers) == 0 else round(float(losers.mean()), 2),
        "longs": longs,
        "shorts": shorts,
        "long_net": round(long_net, 1),
        "short_net": round(short_net, 1),
        "targets": targets,
        "stops": stops,
        "forced": forced,
        "chunks": chunks,
        "autocorrelation": auto,
        "equity": curve,
        "best_day": {"date": int(best[0]), "points": round(best[1], 1)},
        "worst_day": {"date": int(worst[0]), "points": round(worst[1], 1)},
        "avg_minutes": round(float(np.mean(minutes)), 1),
        "his_sharpe_daily": None if swing == 0 else round(float(day_arr.mean() / swing), 3),
        "positive_days": int(sum(v > 0 for v in day_vals)),
        "trading_days": len(day_vals),
    }


def iso(ts_ms):
    return pd.to_datetime(int(ts_ms), unit="ms", utc=True).strftime("%Y-%m-%d %H:%M")


def factor_rows(summaries):
    factors = (
        ("Stop", "sl"),
        ("Target", "tp"),
        ("Session", "session"),
        ("Trade limit", "concurrency"),
        ("Daily rule", "manage"),
        ("Lookback", "look"),
    )
    out = []
    for title, key in factors:
        groups = defaultdict(list)
        for row in summaries:
            groups[row[key]].append(row["net_points"])
        for name, values in groups.items():
            arr = np.array(values, dtype=float)
            label = {
                "session": SESSION_NAME,
                "look": LOOK_NAME,
                "concurrency": {"every": "Every level", "serial": "One at a time"},
                "manage": {"one": "One trade a day", "until": "Until +50", "greedy": "No daily cap"},
            }.get(key, {}).get(name, f"{int(name)} points" if key in ("sl", "tp") else str(name))
            out.append(
                {
                    "factor": title,
                    "option": label,
                    "configs": len(values),
                    "mean_net": round(float(arr.mean()), 1),
                    "median_net": round(float(np.median(arr)), 1),
                    "best_net": round(float(arr.max()), 1),
                    "worst_net": round(float(arr.min()), 1),
                }
            )
    return out


def write_summary_csv(path, summaries):
    cols = [
        "id",
        "sl",
        "tp",
        "session",
        "concurrency",
        "manage",
        "look",
        "trades",
        "win_rate",
        "net_points",
        "expectancy",
        "profit_factor",
        "profit_factor_without_best",
        "max_drawdown",
        "payoff",
        "max_consecutive_wins",
        "max_consecutive_losses",
        "auto_sign",
        "auto_gap",
        "auto_band",
        "pearson_winloss",
        "kelly_full",
        "kelly_fraction",
    ]
    lines = [",".join(cols)]
    for row in summaries:
        auto = row.get("autocorrelation") or {}
        values = [
            row["id"],
            row["sl"],
            row["tp"],
            row["session"],
            row["concurrency"],
            row["manage"],
            row["look"],
            row["trades"],
            row["win_rate"],
            row["net_points"],
            row["expectancy"],
            row["profit_factor"],
            row["profit_factor_without_best"],
            row["max_drawdown"],
            row["payoff"],
            auto.get("max_consecutive_wins"),
            auto.get("max_consecutive_losses"),
            auto.get("sign"),
            auto.get("gap"),
            auto.get("band"),
            auto.get("pearson_winloss"),
            auto.get("kelly_full"),
            auto.get("kelly_fraction"),
        ]
        lines.append(",".join("" if v is None else str(v) for v in values))
    path.write_text("\n".join(lines), encoding="utf-8")


def html_report(summaries, factors, audit, bars):
    payload = {"summaries": summaries, "factors": factors, "audit": audit, "bars": bars}
    data = json.dumps(payload).replace("<", "\\u003c")
    return REPORT_PAGE.replace("__DATA__", data)


REPORT_PAGE = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Nasdaq level retrace</title>
<style>
  body { margin: 0; font: 15px/1.45 Georgia, "Times New Roman", serif; background: #f4f1ea; color: #1c1a17; }
  main { max-width: 1180px; margin: 0 auto; padding: 28px 20px 80px; }
  h1 { font-size: 28px; margin: 0 0 8px; }
  h2 { font-size: 20px; margin: 32px 0 8px; }
  p, li { max-width: 78ch; }
  a { color: #1c1a17; }
  table { width: 100%; border-collapse: collapse; background: white; font: 13px/1.35 Consolas, monospace; }
  th, td { border-bottom: 1px solid #e4dccb; text-align: right; padding: 6px 8px; white-space: nowrap; }
  th:first-child, td:first-child, td.left, th.left { text-align: left; }
  th.sort { cursor: pointer; }
  th.sort:hover { background: #fff6e8; }
  tr.pick { cursor: pointer; }
  tr.on { background: #fff6e8; }
  .note, .filters { background: #fff6e8; border: 1px solid #e6d3b0; padding: 12px 14px; }
  .filters { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 14px; }
  .filters fieldset { border: 1px solid #e4dccb; margin: 0; padding: 6px 10px 8px; min-width: 150px; }
  .filters legend { font-size: 13px; padding: 0 4px; }
  .filters label { display: flex; gap: 6px; align-items: center; font: 13px/1.7 Consolas, monospace; }
  svg.eq { width: 140px; height: 36px; vertical-align: middle; }
  #chart { background: #131722; width: 100%; height: 460px; }
  select, button { font: 14px Consolas, monospace; padding: 6px 8px; }
  .pos { color: #1b7f3a; } .neg { color: #8a2b2b; }
</style>
</head>
<body>
<main>
  <h1>Nasdaq level retrace</h1>
  <div class="note">
    <p>USA 100 CFD, Dukascopy bid, <code>usatechidxusd-m1-bid</code>. No spread and no commission. One contract, scored in index points. A point here is the 50-point distance in the example 30000 to 30050. Stops are 50 and 100 points. Targets are 50, 100, 150, and 200 points.</p>
    <p>Levels are the open and the close of every completed daily and weekly candle. The candle clock matches DMC: 17:00 to 16:00 America/Chicago, week starting Sunday 17:00. Weekly levels are yellow. Daily levels are #2962ff. A price that is both is drawn yellow and tagged with both sources. The same price is one level. A level can be traded once per New York date, and it is not traded again that day if it flips from support to resistance.</p>
    <p>Crossing up sells. Crossing down buys. London is 08:00–16:30 Europe/London. New York is 08:00–17:00 America/New_York. New York RTH is the cash session inside that, 09:30–16:00. All means London or New York. Stops and targets can fill later, including overnight. Inside a minute, a rising bar travels open, low, high, close. A falling bar travels open, high, low, close. A gap fills at the open.</p>
    <p>“Up 50 points” means realized points of trades opened that New York date. Open trades still count as open, so several trades can be working before any of them closes. “One trade per day” makes the two trade-limit options the same trade.</p>
    <p><a href="definitions.html">How these numbers are calculated</a></p>
  </div>
  <div id="filters" class="filters"></div>
  <h2>What changed the result</h2>
  <p id="factorNote"></p>
  <table id="factors"></table>
  <h2 id="runCount">Runs</h2>
  <p>Click a column heading to sort. Click a row to load that run, including every touch on 2026-10-23.</p>
  <table id="runs"></table>
  <h2 id="title">Run</h2>
  <div id="detail"></div>
  <h2>2026-10-23</h2>
  <svg id="chart" viewBox="0 0 1000 460"></svg>
  <div id="daymeta"></div>
  <table id="day"></table>
</main>
<script>
const DATA = __DATA__;
const nameSession = {london: "London only", ny: "New York only", rth: "New York RTH only", all: "All"};
const nameTrade = {every: "Every level", serial: "One at a time"};
const nameDay = {one: "One trade a day", until: "Until +50", greedy: "No daily cap"};
const nameLook = {month: "1 month", "6month": "6 months", year: "1 year", all: "All history"};
const FILTERS = [
  {key: "sl", title: "Stop", options: [[50, "50 points"], [100, "100 points"]]},
  {key: "tp", title: "Target", options: [[50, "50 points"], [100, "100 points"], [150, "150 points"], [200, "200 points"]]},
  {key: "session", title: "Session", options: [["london", "London only"], ["ny", "New York only"], ["rth", "New York RTH only"], ["all", "All"]]},
  {key: "concurrency", title: "Trade limit", options: [["every", "Every level"], ["serial", "One at a time"]]},
  {key: "manage", title: "Daily rule", options: [["one", "One trade a day"], ["until", "Until +50"], ["greedy", "No daily cap"]]},
  {key: "look", title: "Lookback", options: [["month", "1 month"], ["6month", "6 months"], ["year", "1 year"], ["all", "All history"]]}
];
const sortState = {
  runs: {key: "net_points", dir: -1},
  factors: {key: null, dir: -1},
  loss: {key: null, dir: 1},
  win: {key: null, dir: 1},
  day: {key: null, dir: 1}
};
let current = null;
let shown = [];
let dayRows = [];
let streakData = {loss: [], win: []};
const host = document.getElementById("filters");
host.innerHTML = FILTERS.map((group) => `<fieldset><legend>${group.title}</legend>`
  + group.options.map(([value, label]) => `<label><input type="checkbox" data-factor="${group.key}" value="${value}" checked> ${label}</label>`).join("")
  + `</fieldset>`).join("");

function num(v) { return v === null || v === undefined || Number.isNaN(v) ? "-" : v; }
function cls(v) { return v > 0 ? "pos" : v < 0 ? "neg" : ""; }
function round1(v) { return Math.round(v * 10) / 10; }
function spark(values) {
  if (!values || !values.length) return "";
  const w = 140, h = 36;
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  const d = values.map((v, i) => `${(i / Math.max(values.length - 1, 1) * w).toFixed(1)},${(h - (v - min) / span * (h - 2) - 1).toFixed(1)}`).join(" ");
  return `<svg class="eq" viewBox="0 0 ${w} ${h}"><polyline fill="none" stroke="#1c1a17" stroke-width="1" points="${d}"/></svg>`;
}
function compare(a, b, dir) {
  const empty = (v) => v === null || v === undefined || v === "" || Number.isNaN(v);
  if (empty(a) && empty(b)) return 0;
  if (empty(a)) return 1;
  if (empty(b)) return -1;
  if (typeof a === "number" && typeof b === "number") return (a - b) * dir;
  return String(a).localeCompare(String(b)) * dir;
}
function sortRows(rows, state, value) {
  if (!state.key) return rows.slice();
  return rows.slice().sort((a, b) => compare(value(a, state.key), value(b, state.key), state.dir));
}
function heads(table, cols) {
  const state = sortState[table];
  return `<tr>` + cols.map((col) => {
    const arrow = state.key === col.key ? (state.dir < 0 ? " ▼" : " ▲") : "";
    return `<th class="sort${col.text ? " left" : ""}" data-table="${table}" data-key="${col.key}" data-text="${col.text ? 1 : 0}">${col.label}${arrow}</th>`;
  }).join("") + `</tr>`;
}
function checkedSet(key) {
  const set = new Set();
  document.querySelectorAll(`#filters input[data-factor="${key}"]`).forEach((box) => {
    if (box.checked) set.add(box.value);
  });
  return set;
}
function passingRuns() {
  const sets = {};
  FILTERS.forEach((group) => { sets[group.key] = checkedSet(group.key); });
  return DATA.summaries.filter((run) => FILTERS.every((group) => sets[group.key].has(String(run[group.key]))));
}
function runValue(run, key) {
  const auto = run.autocorrelation || {};
  if (key === "gap") return auto.gap === undefined ? null : auto.gap;
  if (key === "sign") return auto.sign || "";
  if (key === "equity") return run.equity && run.equity.length ? run.equity[run.equity.length - 1] : null;
  return run[key];
}
function orderedRuns() {
  return sortRows(shown, sortState.runs, runValue);
}
function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const n = sorted.length;
  if (n % 2) return sorted[(n - 1) / 2];
  return (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}
function factorRows() {
  const specs = [
    ["Stop", "sl", (v) => v + " points"],
    ["Target", "tp", (v) => v + " points"],
    ["Session", "session", (v) => nameSession[v]],
    ["Trade limit", "concurrency", (v) => nameTrade[v]],
    ["Daily rule", "manage", (v) => nameDay[v]],
    ["Lookback", "look", (v) => nameLook[v]]
  ];
  const rows = [];
  specs.forEach(([title, key, label]) => {
    const groups = new Map();
    shown.forEach((run) => {
      if (!groups.has(run[key])) groups.set(run[key], []);
      groups.get(run[key]).push(run.net_points);
    });
    groups.forEach((values, name) => {
      rows.push({
        factor: title,
        option: label(name),
        configs: values.length,
        mean_net: round1(values.reduce((sum, v) => sum + v, 0) / values.length),
        median_net: round1(median(values)),
        best_net: round1(Math.max(...values)),
        worst_net: round1(Math.min(...values))
      });
    });
  });
  return rows;
}
function drawFactors() {
  const rows = sortRows(factorRows(), sortState.factors, (row, key) => row[key]);
  document.getElementById("factorNote").textContent = shown.length
    ? "Mean, median, best, and worst are the net points of the runs that pass the filters."
    : "No runs pass the filters.";
  document.getElementById("factors").innerHTML = heads("factors", [
    {key: "factor", label: "Factor", text: 1},
    {key: "option", label: "Option", text: 1},
    {key: "configs", label: "Runs"},
    {key: "mean_net", label: "Mean net"},
    {key: "median_net", label: "Median net"},
    {key: "best_net", label: "Best"},
    {key: "worst_net", label: "Worst"}
  ]) + rows.map((row) => `<tr><td class="left">${row.factor}</td><td class="left">${row.option}</td><td>${row.configs}</td><td class="${cls(row.mean_net)}">${row.mean_net}</td><td>${row.median_net}</td><td>${row.best_net}</td><td>${row.worst_net}</td></tr>`).join("");
}
function drawTable() {
  const rows = orderedRuns();
  document.getElementById("runs").innerHTML = heads("runs", [
    {key: "id", label: "Run", text: 1},
    {key: "trades", label: "Trades"},
    {key: "win_rate", label: "Win %"},
    {key: "net_points", label: "Net"},
    {key: "expectancy", label: "Expectancy"},
    {key: "profit_factor", label: "PF"},
    {key: "profit_factor_without_best", label: "PF ex best"},
    {key: "max_drawdown", label: "Max DD"},
    {key: "gap", label: "Gap"},
    {key: "sign", label: "Sign", text: 1},
    {key: "equity", label: "Equity"}
  ]) + rows.map((run) => {
    const auto = run.autocorrelation || {};
    return `<tr class="pick ${run.id === current ? "on" : ""}" data-id="${run.id}"><td class="left">${run.id}</td><td>${run.trades}</td><td>${num(run.win_rate)}</td><td class="${cls(run.net_points)}">${run.net_points}</td><td>${num(run.expectancy)}</td><td>${num(run.profit_factor)}</td><td>${num(run.profit_factor_without_best)}</td><td>${run.max_drawdown}</td><td>${num(auto.gap)}</td><td class="left">${num(auto.sign)}</td><td>${spark(run.equity)}</td></tr>`;
  }).join("");
}
function renderStreak(which) {
  const title = which === "loss"
    ? "After this many losses in a row, the next trade"
    : "After this many wins in a row, the next trade";
  const host = document.getElementById(which + "Streak");
  if (!host) return;
  const rows = sortRows(streakData[which] || [], sortState[which], (row, key) => row[key]);
  if (!rows.length) {
    host.innerHTML = `<p>${title}: none.</p>`;
    return;
  }
  host.innerHTML = `<p>${title}</p><table>` + heads(which, [
    {key: "k", label: "Streak"},
    {key: "n", label: "Samples"},
    {key: "next_win_pct", label: "Next win %"},
    {key: "next_loss_pct", label: "Next loss %"}
  ]) + rows.map((row) => `<tr><td>${row.k}</td><td>${row.n}</td><td>${row.next_win_pct}</td><td>${row.next_loss_pct}</td></tr>`).join("") + `</table>`;
}
function show(id) {
  current = id;
  drawTable();
  const run = shown.find((row) => row.id === id) || DATA.summaries.find((row) => row.id === id);
  const auto = run.autocorrelation;
  document.getElementById("title").textContent = run.id;
  const detail = document.getElementById("detail");
  if (!auto) {
    detail.innerHTML = "<p>No trades.</p>";
    streakData = {loss: [], win: []};
  } else {
    detail.innerHTML = `
      <p>${nameSession[run.session]}. ${nameTrade[run.concurrency]}. ${nameDay[run.manage]}. Lookback ${nameLook[run.look]}. Stop ${run.sl} points, target ${run.tp} points.</p>
      <p>Win rate ${run.win_rate}% on ${run.trades} trades (${run.wins} wins, ${run.losses} losses). Net ${run.net_points} points. Expectancy ${run.expectancy} points. Profit factor ${num(run.profit_factor)}. Without the best trade ${num(run.profit_factor_without_best)}. Payoff ${num(run.payoff)}. Max drawdown ${run.max_drawdown} points over ${run.max_drawdown_trades} trades. Long net ${run.long_net} (${run.longs}). Short net ${run.short_net} (${run.shorts}). Targets ${run.targets}, stops ${run.stops}, still open at the end ${run.forced}. Average hold ${num(run.avg_minutes)} minutes. His return/swing on daily points ${num(run.his_sharpe_daily)}.</p>
      <p>Unconditional win rate ${auto.unconditional_win_pct}%. After a loss, next win rate ${num(auto.conditional_win_pct)}% (${auto.after_loss} trades). After a win, next win rate ${num(auto.after_win_win_pct)}% (${auto.after_win} trades). Gap ${num(auto.gap)} percentage points: ${auto.sign}, ${auto.band}. Pearson on win/loss ${num(auto.pearson_winloss)}. Pearson on points ${num(auto.pearson_points)}. Full Kelly ${num(auto.kelly_full)}. Map: ${auto.kelly_fraction}. ${auto.sizing} Longest win streak ${auto.max_consecutive_wins}. Longest loss streak ${auto.max_consecutive_losses}.</p>
      <p>Chunk win rates, ten equal blocks in trade order: ${run.chunks.join(", ") || "fewer than 10 trades"}.</p>
      <div id="lossStreak"></div>
      <div id="winStreak"></div>`;
    streakData = {loss: auto.after_loss_streaks || [], win: auto.after_win_streaks || []};
    renderStreak("loss");
    renderStreak("win");
  }
  drawDay(run);
}
function renderDay() {
  const rows = sortRows(dayRows, sortState.day, (row, key) => row[key]);
  document.getElementById("day").innerHTML = heads("day", [
    {key: "time", label: "Time UTC", text: 1},
    {key: "side", label: "Side", text: 1},
    {key: "level", label: "Level"},
    {key: "fill", label: "Fill"},
    {key: "stop", label: "Stop"},
    {key: "target", label: "Target"},
    {key: "result", label: "Result", text: 1},
    {key: "pnl", label: "PnL"},
    {key: "exit", label: "Exit"},
    {key: "sources", label: "Sources", text: 1}
  ]) + rows.map((row) => `<tr><td class="left">${row.time}</td><td class="left">${row.side}</td><td>${row.level}</td><td>${row.fill}</td><td>${row.stop}</td><td>${row.target}</td><td class="left">${row.result}</td><td class="${cls(row.pnl)}">${row.result === "taken" ? row.pnl : ""}</td><td class="left">${row.exitLabel}</td><td class="left">${row.sources}</td></tr>`).join("");
}
function drawDay(run) {
  const pack = DATA.audit[run.look];
  const svg = document.getElementById("chart");
  const bars = DATA.bars;
  if (!bars.length) { svg.innerHTML = ""; return; }
  const lows = bars.map((b) => b.l), highs = bars.map((b) => b.h);
  let lo = Math.min(...lows), hi = Math.max(...highs);
  const near = pack.levels.filter((lv) => lv.price >= lo - 150 && lv.price <= hi + 150);
  if (near.length) {
    lo = Math.min(lo, ...near.map((lv) => lv.price));
    hi = Math.max(hi, ...near.map((lv) => lv.price));
  }
  const pad = (hi - lo) * 0.05 || 1;
  lo -= pad; hi += pad;
  const W = 1000, H = 460, left = 56, right = 12, top = 12, bot = 24;
  const x = (i) => left + (bars.length === 1 ? 0 : i / (bars.length - 1) * (W - left - right));
  const y = (p) => top + (hi - p) / (hi - lo) * (H - top - bot);
  let body = "";
  near.forEach((lv) => {
    const color = lv.color === "daily" ? "#2962ff" : "#ffe600";
    body += `<line x1="${left}" x2="${W - right}" y1="${y(lv.price)}" y2="${y(lv.price)}" stroke="${color}" stroke-width="1" opacity="0.85"/>`;
  });
  const d = bars.map((b, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(b.c).toFixed(1)}`).join(" ");
  body += `<path d="${d}" fill="none" stroke="#d1d4dc" stroke-width="1.2"/>`;
  pack.touches.forEach((t) => {
    const spec = t.by_sl[String(run.sl)][String(run.tp)];
    t.pnl = spec.pnl; t.exit_kind = spec.exit_kind; t.exit = spec.exit; t.stop = spec.stop; t.target = spec.target;
  });
  const decisions = pack.decisions[run.id] || [];
  decisions.forEach((reason, i) => {
    if (reason !== "taken") return;
    const t = pack.touches[i];
    const bi = bars.findIndex((b) => b.t === t.time);
    if (bi < 0) return;
    const color = t.side === "buy" ? "#26a69a" : "#ef5350";
    body += `<circle cx="${x(bi)}" cy="${y(t.fill)}" r="3.5" fill="${color}"/>`;
  });
  body += `<text x="${left}" y="${H - 6}" fill="#d1d4dc" font-size="11">${bars[0].t} UTC to ${bars[bars.length - 1].t} UTC</text>`;
  svg.innerHTML = body;
  const counts = {};
  decisions.forEach((reason) => { counts[reason] = (counts[reason] || 0) + 1; });
  document.getElementById("daymeta").innerHTML = `<p>${pack.levels.length} levels were active. ${near.length} sit inside the day's range plus 150 points. Yellow is weekly. Blue is daily. Green dots are buys, red dots are sells, and only taken trades are marked. Touches: ${Object.entries(counts).map(([k, v]) => k + " " + v).join(", ") || "none"}.</p>`;
  dayRows = pack.touches.map((t, i) => ({
    time: t.time,
    side: t.side,
    level: t.level,
    fill: t.fill,
    stop: t.stop,
    target: t.target,
    result: decisions[i] || "",
    pnl: decisions[i] === "taken" ? t.pnl : null,
    exit: decisions[i] === "taken" ? t.exit : null,
    exitLabel: decisions[i] === "taken" ? (t.exit_kind + " " + t.exit) : "",
    sources: (t.sources || []).join("; ")
  }));
  renderDay();
}
function applyFilters() {
  shown = passingRuns();
  document.getElementById("runCount").textContent = shown.length + " of " + DATA.summaries.length + " runs";
  drawFactors();
  if (!shown.length) {
    current = null;
    document.getElementById("runs").innerHTML = `<tr><td class="left">No runs match these filters.</td></tr>`;
    document.getElementById("title").textContent = "Run";
    document.getElementById("detail").innerHTML = "<p>No runs match these filters.</p>";
    document.getElementById("chart").innerHTML = "";
    document.getElementById("daymeta").innerHTML = "";
    document.getElementById("day").innerHTML = "";
    return;
  }
  if (!shown.some((run) => run.id === current)) show(orderedRuns()[0].id);
  else drawTable();
}
document.body.addEventListener("click", (event) => {
  const th = event.target.closest("th[data-key]");
  if (th) {
    const table = th.dataset.table;
    const state = sortState[table];
    if (state.key === th.dataset.key) state.dir *= -1;
    else {
      state.key = th.dataset.key;
      state.dir = th.dataset.text === "1" ? 1 : -1;
    }
    if (table === "runs") drawTable();
    else if (table === "factors") drawFactors();
    else if (table === "day") renderDay();
    else renderStreak(table);
    return;
  }
  const row = event.target.closest("#runs tr[data-id]");
  if (row) show(row.dataset.id);
});
host.addEventListener("change", applyFilters);
applyFilters();
</script>
</body>
</html>
"""


def audit_bars(ts, o, h, l, c, clock):
    mask = clock["ny_ymd"] == AUDIT_YMD
    idx = np.flatnonzero(mask)
    # Keep the cash day readable: one point per minute is already the source.
    rows = []
    for i in idx:
        rows.append(
            {
                "t": iso(ts[i]),
                "o": round(float(o[i]), 2),
                "h": round(float(h[i]), 2),
                "l": round(float(l[i]), 2),
                "c": round(float(c[i]), 2),
            }
        )
    return rows


def main():
    self_check()
    print("Loading", CSV)
    ts, o, h, l, c = load()
    print(f"{len(ts)} bars, {iso(ts[0])} to {iso(ts[-1])} UTC")
    clock = clocks(ts)
    print("Building daily and weekly candles")
    records = build_levels(ts, o, c, clock)
    print(f"{len(records)} open/close levels before lookback")
    block_low, block_high = prepare_blocks(h, l, c)
    OUT.mkdir(exist_ok=True)
    summaries = []
    audit = {}
    bars = audit_bars(ts, o, h, l, c, clock)
    print(f"Audit day {AUDIT_YMD} has {len(bars)} minutes")
    for look, days in LOOKBACKS:
        print(f"Lookback {look}")
        touches, levels = generate(records, days, ts, o, h, l, c, clock, block_low, block_high)
        print(f"  {len(touches)} session crosses, {len(levels)} levels on the audit day")
        pack = {"levels": levels, "touches": None, "decisions": {}}
        for sl in STOPS:
            for tp in TARGETS:
                for session in SESSIONS:
                    for concurrency in CONCURRENCY:
                        for manage in MANAGE:
                            cid = config_id(sl, tp, session, concurrency, manage, look)
                            trades, decisions = simulate(touches, sl, tp, session, concurrency, manage)
                            stats = metrics(trades, sl)
                            stats.update(
                                {
                                    "id": cid,
                                    "sl": int(sl),
                                    "tp": int(tp),
                                    "session": session,
                                    "concurrency": concurrency,
                                    "manage": manage,
                                    "look": look,
                                }
                            )
                            summaries.append(stats)
                            pack["decisions"][cid] = decisions
                            print(f"  {cid}: {stats['trades']} trades, net {stats['net_points']}", flush=True)
        if look == "month":
            known = next(row for row in summaries if row["id"] == "sl50_tp50_all_every_one_month")
            print(f"MONTH_CHECK {known['trades']} {known['net_points']}", flush=True)
            if known["trades"] != 1668 or abs(known["net_points"] - 3600.0) > 0.1:
                raise SystemExit("month target-50 benchmark drifted")
        audit_touches = []
        for touch in touches:
            if touch["ymd"] != AUDIT_YMD:
                continue
            item = {
                "time": iso(touch["ts"]),
                "level": touch["price"],
                "sources": touch["sources"],
                "side": "buy" if touch["side"] == 1 else "sell",
                "fill": round(touch["fill"], 2),
                "in_ny": touch["in_ny"],
                "in_rth": touch["in_rth"],
                "in_lon": touch["in_lon"],
                "by_sl": {},
            }
            for sl in STOPS:
                item["by_sl"][str(int(sl))] = {}
                for tp in TARGETS:
                    pnl, kind, _rank, _bar = touch["exits"][EXIT_INDEX[(int(sl), int(tp))]]
                    item["by_sl"][str(int(sl))][str(int(tp))] = {
                        "pnl": round(pnl, 2),
                        "exit_kind": kind,
                        "exit": round(touch["fill"] + pnl * touch["side"], 2),
                        "stop": round(touch["fill"] - sl * touch["side"], 2),
                        "target": round(touch["fill"] + tp * touch["side"], 2),
                    }
            audit_touches.append(item)
        pack["touches_raw"] = audit_touches
        audit[look] = pack
        del touches
    # Flatten stop-specific fields onto touches for the page, per lookback.
    # The page reads t.pnl from the touch, so copy the matching stop when rendering.
    # Done in Python by giving each lookback a touches array that the JS overwrites
    # from by_sl using the selected run's stop.
    factors = factor_rows(summaries)
    # Attach a display copy. JS uses by_sl[stop].
    report_audit = {}
    for look, pack in audit.items():
        report_audit[look] = {
            "levels": pack["levels"],
            "touches": pack["touches_raw"],
            "decisions": pack["decisions"],
        }
    summary_path = OUT / "summary.json"
    # Equity curves make the JSON large but that is the point of keeping the run.
    summary_path.write_text(json.dumps({"runs": summaries, "factors": factors}, indent=1), encoding="utf-8")
    (OUT / "day_2026-10-23.json").write_text(json.dumps(report_audit), encoding="utf-8")
    write_summary_csv(OUT / "summary.csv", summaries)
    # Slim the embedded touches: JS picks by_sl.
    page = html_report(summaries, factors, report_audit, bars)
    (OUT / "report.html").write_text(page, encoding="utf-8")
    ranked = sorted(summaries, key=lambda row: row["net_points"], reverse=True)
    positive = sum(row["net_points"] > 0 for row in summaries)
    print(f"{positive}/{len(summaries)} positive")
    print("Top 10")
    for row in ranked[:10]:
        print(
            f"  {row['id']}: {row['trades']} trades, win {row['win_rate']}%, "
            f"net {row['net_points']}, pf {row['profit_factor']}, dd {row['max_drawdown']}"
        )
    print("Wrote", OUT / "report.html")


if __name__ == "__main__":
    main()
