"""Daily and weekly candle levels for each level session.

The level session decides which bars build the candles:

* ``all``  every bar of the file, grouped by the electronic market day.
* ``eth``  the electronic session only (18:00-17:00 New York), so the
           17:00-18:00 break of the CFD feed is dropped.
* ``rth``  the cash session only (09:30-16:00 New York), grouped by NY date.

A candle only becomes a level on the next trade day, so the levels always come
from completed candles.  Every daily and weekly candle contributes its open and
its close.  The same price from two candles is one level; the sources are kept.
"""
from __future__ import annotations

import numpy as np

import config
import data

DAILY = 1
WEEKLY = 2
NEVER = np.int32(1 << 30)
SCALE = 100.0
DECIMALS = 2


def set_scale(scale, decimals):
    """Switch the integer step to an instrument: 10^decimals per price unit."""
    global SCALE, DECIMALS
    SCALE = float(scale)
    DECIMALS = int(decimals)


def aggregate(bars, day_key, keep):
    idx = np.flatnonzero(keep)
    if idx.size == 0:
        return None
    days = day_key[idx]
    starts = np.flatnonzero(np.r_[True, days[1:] != days[:-1]])
    ends = np.r_[starts[1:], idx.size] - 1
    return {
        "day": days[starts].astype(np.int32),
        "o": bars["o"][idx[starts]],
        "c": bars["c"][idx[ends]],
        "h": np.maximum.reduceat(bars["h"][idx], starts),
        "l": np.minimum.reduceat(bars["l"][idx], starts),
        "v": np.add.reduceat(bars["vol"][idx], starts),
        "first_i": idx[starts],
        "last_i": idx[ends],
    }


def aggregate_weekly(daily):
    if daily is None or daily["day"].size == 0:
        return None
    weeks = data.week_start(daily["day"])
    starts = np.flatnonzero(np.r_[True, weeks[1:] != weeks[:-1]])
    ends = np.r_[starts[1:], len(weeks)] - 1
    return {
        "week": weeks[starts].astype(np.int32),
        "o": daily["o"][starts],
        "c": daily["c"][ends],
        "h": np.maximum.reduceat(daily["h"], starts),
        "l": np.minimum.reduceat(daily["l"], starts),
        "v": np.add.reduceat(daily["v"], starts),
        "last_day": daily["day"][ends],
    }


def candles(bars, clocks, lvl):
    if lvl == "rth":
        keep = clocks["in_rth"]
        key = clocks["ny_day"]
    elif lvl == "eth":
        keep = ~clocks["in_break"]
        key = clocks["eth_day"]
    elif lvl == "all":
        keep = np.ones(len(bars["ts"]), dtype=bool)
        key = clocks["eth_day"]
    else:
        raise ValueError(f"unknown level session: {lvl}")
    daily = aggregate(bars, key, keep)
    return daily, aggregate_weekly(daily)


def _day_label(day):
    return str(np.datetime64(int(day), "D"))


def build_records(bars, clocks, lvl):
    daily, weekly = candles(bars, clocks, lvl)
    days = daily["day"]
    n = len(days)
    ready = np.full(n, NEVER, dtype=np.int32)
    if n > 1:
        ready[:-1] = days[1:]

    prices, kinds, parts, level_days, ready_days, labels = [], [], [], [], [], []
    for i in range(n):
        day = _day_label(days[i])
        for part, price, part_id in (("open", daily["o"][i], 0), ("close", daily["c"][i], 1)):
            prices.append(price)
            kinds.append(DAILY)
            parts.append(part_id)
            level_days.append(days[i])
            ready_days.append(ready[i])
            labels.append(f"Daily {part} {day}")

    if weekly is not None:
        idx = np.searchsorted(days, weekly["last_day"], side="right")
        for j in range(len(weekly["week"])):
            next_day = days[idx[j]] if idx[j] < n else NEVER
            week = _day_label(weekly["week"][j])
            for part, price, part_id in (("open", weekly["o"][j], 0), ("close", weekly["c"][j], 1)):
                prices.append(price)
                kinds.append(WEEKLY)
                parts.append(part_id)
                level_days.append(weekly["last_day"][j])
                ready_days.append(next_day)
                labels.append(f"Weekly {part} week of {week}")

    cents = np.rint(np.asarray(prices, dtype=np.float64) * SCALE).astype(np.int32)
    kind = np.asarray(kinds, dtype=np.int8)
    record = {
        "cents": cents,
        "kind": kind,
        "part": np.asarray(parts, dtype=np.int8),
        "day": np.asarray(level_days, dtype=np.int32),
        "ready": np.asarray(ready_days, dtype=np.int32),
        "label": labels,
    }
    order = np.argsort(record["ready"], kind="stable")
    for key in ("cents", "kind", "part", "day", "ready"):
        record[key] = record[key][order]
    record["label"] = [labels[int(i)] for i in order]
    record["daily"] = daily
    record["weekly"] = weekly
    return record


def iter_books(records, days):
    """Yield the active level book for each trade day, sorted by price.

    The book keeps one row per price.  A price made by two candles reports the
    combined kind and the newest record; the report can list every source.
    """
    cents = np.empty(0, dtype=np.int32)
    kind = np.empty(0, dtype=np.int8)
    rec = np.empty(0, dtype=np.int32)
    lday = np.empty(0, dtype=np.int32)
    cursor = 0
    n = len(records["cents"])
    for day in days:
        changed = False
        while cursor < n and records["ready"][cursor] <= day:
            c = int(records["cents"][cursor])
            k = int(records["kind"][cursor])
            d = int(records["day"][cursor])
            pos = int(np.searchsorted(cents, c))
            if pos < cents.size and cents[pos] == c:
                kind[pos] = kind[pos] | k
                rec[pos] = cursor
                if d > lday[pos]:
                    lday[pos] = d
            else:
                cents = np.insert(cents, pos, c)
                kind = np.insert(kind, pos, np.int8(k))
                rec = np.insert(rec, pos, np.int32(cursor))
                lday = np.insert(lday, pos, np.int32(d))
            cursor += 1
            changed = True
        yield day, cents, kind, rec, lday, changed


def book_for_day(records, day):
    for current, cents, kind, rec, lday, _changed in iter_books(records, [int(day)]):
        return cents, kind, rec, lday
    raise RuntimeError("no book")


def level_rows(records, day, look_days=None, lo=None, hi=None, limit=None):
    cents, kind, rec, lday = book_for_day(records, day)
    keep = np.ones(len(cents), dtype=bool)
    if look_days is not None:
        keep &= (int(day) - lday) <= look_days
    if lo is not None:
        keep &= cents >= lo
    if hi is not None:
        keep &= cents <= hi
    rows = []
    for i in np.flatnonzero(keep):
        rows.append({
            "price": round(float(cents[i]) / SCALE, DECIMALS),
            "color": {DAILY: "daily", WEEKLY: "weekly"}.get(int(kind[i]), "both"),
            "sources": [records["label"][int(rec[i])]],
            "cents": int(cents[i]),
            "lday": int(lday[i]),
        })
    if limit is not None and len(rows) > limit:
        rows = rows[:limit]
    return rows
