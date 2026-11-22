"""Check the MT4 EA's arithmetic against the Python engine.

The Expert Advisor cannot use IANA time zones or per-minute candles, so it
rebuilds both: daylight saving comes from the US and EU rules applied to a
constant server offset, and the daily/weekly level candles come from the
broker's H1 (or M30) bars.  This script runs that same arithmetic in Python and
compares it, bar by bar, with what the engine does.

    python mt4/verify_ea_model.py                  # US100
    python mt4/verify_ea_model.py --file XAUUSD_...csv
    python mt4/verify_ea_model.py --offset 2       # broker server UTC+2

Three checks:

1. clock   - New York day, electronic day and the London / New York / cash
   windows for every hour of the file, plus every DST boundary week.
2. levels  - the level book of a trade day (price, daily or weekly, newest
   source candle) built from H1 or M30 bars against the engine's minute book.
3. money   - what the engine gives away on the short side, read from an
   exported trade list: the engine never charges a short the spread, a live
   MT4 short pays one, so the dollar result is worse by that much.
"""
from __future__ import annotations

import argparse
import csv
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import config      # noqa: E402
import data        # noqa: E402
import levels      # noqa: E402

DAY = 86400
DAY_BASE = 40000   # the EA's LR_PACK_DAY: day numbers below this until 2079


# ---------------------------------------------------------------- clock
# A literal translation of the MQL4 helpers, so a disagreement here is a
# disagreement in the EA, not in this script.

def utc_of(server_epoch, off_h):
    return server_epoch - off_h * 3600


def fields(epoch):
    """The wall clock of an epoch, and its day number."""
    dt = datetime.fromtimestamp(int(epoch), timezone.utc)
    return dt, int(int(epoch) // DAY)


def day_number(epoch):
    return int(epoch // DAY) if epoch >= 0 else -((-epoch + DAY - 1) // DAY)


def minute_of_day(epoch):
    return int(epoch % DAY) // 60


def dow_of(epoch):
    return int((day_number(epoch) + 4) % 7)   # 0 = Sunday


def sunday_week(year, month, nth):
    first = datetime(year, month, 1, tzinfo=timezone.utc)
    base = int(first.timestamp())
    add = (7 - dow_of(base)) % 7
    return base + (add + 7 * (nth - 1)) * DAY


def last_sunday(year, month):
    y, m = (year + 1, 1) if month == 12 else (year, month + 1)
    nxt = int(datetime(y, m, 1, tzinfo=timezone.utc).timestamp())
    d = dow_of(nxt)
    return nxt - (7 if d == 0 else d) * DAY


def ny_offset_at(gmt_epoch):
    dt, _ = fields(gmt_epoch)
    year = dt.year
    start = sunday_week(year, 3, 2) + 7 * 3600
    end = sunday_week(year, 11, 1) + 6 * 3600
    return -4 if start <= gmt_epoch < end else -5


def london_offset_at(gmt_epoch):
    dt, _ = fields(gmt_epoch)
    year = dt.year
    start = last_sunday(year, 3) + 3600
    end = last_sunday(year, 10) + 3600
    return 1 if start <= gmt_epoch < end else 0


def local_fields(server_epoch, off_h, zone_offset):
    return server_epoch - off_h * 3600 + zone_offset * 3600


def ny_day_of(server_epoch, off_h):
    return day_number(local_fields(server_epoch, off_h, ny_offset_at(utc_of(server_epoch, off_h))))


def eth_day_of(server_epoch, off_h):
    local = local_fields(server_epoch, off_h, ny_offset_at(utc_of(server_epoch, off_h)))
    return day_number(local) + (1 if minute_of_day(local) >= 1080 else 0)


def in_ny_break(server_epoch, off_h):
    local = local_fields(server_epoch, off_h, ny_offset_at(utc_of(server_epoch, off_h)))
    return 1020 <= minute_of_day(local) < 1080


def windows(server_epoch, off_h):
    ny = local_fields(server_epoch, off_h, ny_offset_at(utc_of(server_epoch, off_h)))
    lon = local_fields(server_epoch, off_h, london_offset_at(utc_of(server_epoch, off_h)))
    ny_min, lon_min = minute_of_day(ny), minute_of_day(lon)
    work_ny = 1 <= dow_of(ny) <= 5
    work_lon = 1 <= dow_of(lon) <= 5
    london = work_lon and 480 <= lon_min < 990
    newyork = work_ny and 480 <= ny_min < 1020
    cash = work_ny and 570 <= ny_min < 960
    return london, newyork, cash


# ---------------------------------------------------------------- candles
def aggregate(bars, keys, keep):
    """First open and last close per key, in the order the keys appear."""
    idx = np.flatnonzero(keep)
    if idx.size == 0:
        return np.empty(0, np.int32), np.empty(0, np.float64), np.empty(0, np.float64)
    days = keys[idx]
    starts = np.flatnonzero(np.r_[True, days[1:] != days[:-1]])
    ends = np.r_[starts[1:], idx.size] - 1
    return (days[starts].astype(np.int32), bars["o"][idx[starts]],
            bars["c"][idx[ends]])


def ea_bar_placement(ts_server, off_h, lvl):
    """The EA's BarPlacement on whole-hour bars."""
    if lvl == "rth":
        keys = np.array([ny_day_of(t, off_h) for t in ts_server], dtype=np.int32)
        keep = np.array([windows(t, off_h)[2] for t in ts_server], dtype=bool)
    else:
        keys = np.array([eth_day_of(t, off_h) for t in ts_server], dtype=np.int32)
        if lvl == "eth":
            keep = np.array([not in_ny_break(t, off_h) for t in ts_server], dtype=bool)
        else:
            keep = np.ones(ts_server.size, dtype=bool)
    return keys, keep


def build_records(days, opens, closes, scale):
    """The EA's BuildRecords: completed candles only, ready on the next day."""
    n = len(days)
    if n < 2:
        return np.empty(0, np.int64), np.empty(0, np.int64), np.empty(0, np.int32), np.empty(0, np.int8)
    last = n - 1
    ready, price, day, kind = [], [], [], []
    step = lambda v: int(round(float(v) * scale))    # noqa: E731
    for i in range(last):
        ready.append(days[i + 1])
        price.append(step(opens[i]))
        day.append(days[i])
        kind.append(1)
        ready.append(days[i + 1])
        price.append(step(closes[i]))
        day.append(days[i])
        kind.append(1)
    i = 0
    while i < n:
        week = sunday_start(days[i])
        j = i
        while j + 1 < n and sunday_start(days[j + 1]) == week:
            j += 1
        if j < last:            # the week is over, a later candle exists
            ready.append(days[j + 1])
            price.append(step(opens[i]))
            day.append(days[j])
            kind.append(2)
            ready.append(days[j + 1])
            price.append(step(closes[j]))
            day.append(days[j])
            kind.append(2)
        i = j + 1
    return (np.asarray(ready, np.int64), np.asarray(price, np.int64),
            np.asarray(day, np.int32), np.asarray(kind, np.int8))


def sunday_start(day_number):
    """The Sunday opening the week, exactly the EA's SundayOf."""
    return day_number - (day_number + 4) % 7


def build_book(ready, price, day, kind, book_day):
    """The EA's BuildBook, including the price / day / kind packing it sorts on."""
    sel = ready <= book_day
    if not sel.any():
        return {}, 0
    pack = ((price[sel].astype(np.float64) * DAY_BASE + day[sel].astype(np.float64)) * 4.0
            + kind[sel].astype(np.float64))
    pack.sort()
    out = {}
    total = 0.0
    for v in pack:
        p = int(v // (DAY_BASE * 4))
        rest = v - p * (DAY_BASE * 4.0)
        d = int(rest // 4)
        k = int(round(rest - d * 4))
        row = out.get(p)
        if row is None:
            out[p] = [d, k]
        else:
            row[1] |= k
            if d > row[0]:
                row[0] = d
        total += 1
    return out, total


# ---------------------------------------------------------------- checks
def check_clock(bars, clocks, off_h):
    ts = bars["ts"]
    sample = np.arange(0, len(ts), 60)          # every hour of the file
    server = ts[sample] + off_h * 3600
    bad = {"ny_day": 0, "eth_day": 0, "in_lon": 0, "in_ny": 0, "in_rth": 0, "in_break": 0}
    worst = []
    for i, epoch in enumerate(server):
        k = int(sample[i])
        london, newyork, cash = windows(epoch, off_h)
        checks = (
            ("ny_day", ny_day_of(epoch, off_h) == int(clocks["ny_day"][k])),
            ("eth_day", eth_day_of(epoch, off_h) == int(clocks["eth_day"][k])),
            ("in_lon", bool(london) == bool(clocks["in_lon"][k])),
            ("in_ny", bool(newyork) == bool(clocks["in_ny"][k])),
            ("in_rth", bool(cash) == bool(clocks["in_rth"][k])),
            ("in_break", bool(in_ny_break(epoch, off_h)) == bool(clocks["in_break"][k])),
        )
        for name, ok in checks:
            if not ok:
                bad[name] += 1
                if len(worst) < 5:
                    worst.append((int(ts[k]), name))
    print(f"clock   sampled {sample.size} hours, offset UTC{off_h:+d}")
    for name, count in bad.items():
        flag = "ok" if count == 0 else f"MISMATCH {count}"
        print(f"        {name:<9} {flag}")
    for epoch, name in worst:
        utc = datetime.fromtimestamp(epoch, timezone.utc)
        print(f"        first {name} mismatch at utc {utc}")
    return sum(bad.values())


def local_day_number(instant, zone):
    """Day number of the wall clock of a zone at a UTC instant."""
    dt = datetime.fromtimestamp(instant, zone).replace(tzinfo=timezone.utc)
    return int(dt.timestamp() // DAY)


def check_boundaries(off_h):
    """Every DST switch 2020-2026: the EA rule and zoneinfo must agree to the second."""
    import zoneinfo

    ny = zoneinfo.ZoneInfo(config.NEW_YORK[0])
    lon = zoneinfo.ZoneInfo(config.LONDON[0])
    bad = 0
    steps = []
    for year in range(2020, 2027):
        for month, nth in ((3, 2), (11, 1)):
            steps.append(sunday_week(year, month, nth) + (7 if month == 3 else 6) * 3600)
        for month in (3, 10):
            steps.append(last_sunday(year, month) + 3600)
    for gmt in sorted(steps):
        for instant in (gmt - 60, gmt, gmt + 60):
            server = instant + off_h * 3600
            stamp = datetime.fromtimestamp(instant, timezone.utc)
            if ny_day_of(server, off_h) != local_day_number(instant, ny):
                bad += 1
                print(f"        NY day wrong at utc {stamp}")
            got_lon = day_number(local_fields(server, off_h, london_offset_at(instant)))
            if got_lon != local_day_number(instant, lon):
                bad += 1
                print(f"        London day wrong at utc {stamp}")
    print(f"clock   dst boundary instants 2020-2026 checked: {len(steps) * 3}, mismatches {bad}")
    return bad


def resample(bars, period):
    """Group the minute file into whole-period buckets, like a broker's series.

    A partial bucket still becomes a bar: its open is the first minute's open and
    its close the last minute's close, which is what the terminal shows.
    """
    ts = bars["ts"]
    bucket = ts - ts % period
    starts = np.flatnonzero(np.r_[True, bucket[1:] != bucket[:-1]])
    ends = np.r_[starts[1:], len(bucket)] - 1
    return {"ts": bucket[starts], "o": bars["o"][starts], "c": bars["c"][ends]}


def check_levels(bars, clocks, lvl, scale, off_h, days_to_check):
    """The EA's book from H1/M30 bars against the engine's minute book."""
    minutes = 30 if lvl == "rth" else 60
    tbars = resample(bars, minutes * 60)
    tserver = tbars["ts"] + off_h * 3600
    keys, keep = ea_bar_placement(tserver, off_h, lvl)
    days, opens, closes = aggregate(tbars, keys, keep)
    ready, price, day, kind = build_records(days, opens, closes, scale)
    records = levels.build_records(bars, clocks, lvl)
    problems = 0
    for d in days_to_check:
        ea, _ = build_book(ready, price, day, kind, int(d))
        cents, bk_kind, _rec, lday = levels.book_for_day(records, int(d))
        engine = {int(cents[i]): [int(lday[i]), int(bk_kind[i])] for i in range(len(cents))}
        missing = sorted(set(engine) - set(ea))
        extra = sorted(set(ea) - set(engine))
        differ = [p for p in set(ea) & set(engine)
                  if ea[p][1] != engine[p][1] or ea[p][0] != engine[p][0]]
        if missing or extra or differ:
            problems += 1
            label = str(np.datetime64(int(d), "D"))
            print(f"levels  {lvl} {label}: engine {len(engine)} ea {len(ea)}"
                  f" missing {len(missing)} extra {len(extra)} differing {len(differ)}")
            for p in missing[:3]:
                print(f"        missing  {p / scale:.2f} {engine[p]}")
            for p in extra[:3]:
                print(f"        extra    {p / scale:.2f} {ea[p]}")
            for p in differ[:3]:
                print(f"        differs  {p / scale:.2f} ea {ea[p]} engine {engine[p]}")
    if problems == 0:
        print(f"levels  {lvl}: {len(days_to_check)} trade days match the engine exactly"
              f" ({len(days)} market candles from {minutes}M bars)")
    return problems


def check_money(trades_csv, model_spread):
    """What the engine's short side gives away, read from an exported trade list.

    The engine values a short at the level and walks the bid, so it never
    charges the spread on that side.  A live MT4 short closes at the ask, so it
    pays one spread.  A long is already exact: it buys at the ask and sells at
    the bid, which is what the engine assumes.
    """
    if not trades_csv.exists():
        print(f"money   {trades_csv.name} not found, run --export-trades first")
        return 0
    rows = []
    with open(trades_csv, newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            rows.append((row["side"], float(row["points"]), row["exit_kind"]))
    if not rows:
        print("money   the trade list is empty")
        return 0
    buys = [r for r in rows if r[0] == "buy"]
    sells = [r for r in rows if r[0] == "sell"]
    net = sum(r[1] for r in rows)
    short_net = sum(r[1] for r in sells)
    long_net = sum(r[1] for r in buys)
    wins = sum(1 for r in rows if r[1] > 0)
    print(f"money   {trades_csv.stem}  {len(rows)} trades "
          f"({len(buys)} buy / {len(sells)} sell), engine win {100.0 * wins / len(rows):.1f}%")
    print(f"        engine net {net:+.1f} points (buy {long_net:+.1f}, sell {short_net:+.1f})")
    give = model_spread * len(sells)
    if net != 0:
        print(f"        a live short pays one spread ({model_spread} points each): net "
              f"{net - give:+.1f} points, {100.0 * give / abs(net):.1f}% of the engine net")
    else:
        print(f"        a live short pays one spread: {give:.1f} points in total")
    stopped = sum(1 for r in rows if r[2] == "stop")
    print(f"        stopped out {stopped} of {len(rows)}, {100.0 * stopped / len(rows):.1f}% "
          "- a real spread wider than the model hurts those trades most")
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--file", default=None, help="CSV name from ../data")
    parser.add_argument("--offset", type=int, default=2, help="server minus UTC, hours")
    parser.add_argument("--days", type=int, default=60, help="trade days to compare")
    parser.add_argument("--levels", default="all,eth,rth", help="level sessions to check")
    parser.add_argument("--trades", default=None, help="run id of a trade CSV to price the spread")
    args = parser.parse_args()

    path = config.DATA_DIR / args.file if args.file else config.DEFAULT_CSV
    spec = config.instrument_for(path.stem)
    scale = 10 ** spec["decimals"]
    levels.set_scale(scale, spec["decimals"])
    bars, clocks = data.load(path)
    print(f"{path.name}  {len(bars['ts'])} bars  point={spec['point']} decimals={spec['decimals']}")

    failures = 0
    failures += check_clock(bars, clocks, args.offset)
    failures += check_boundaries(args.offset)

    in_all = clocks["in_all"]
    every_day = np.unique(clocks["ny_day"][in_all])
    head = every_day[3:6]          # the first days are partial in any series
    tail = every_day[-args.days:]
    days = list(dict.fromkeys(np.r_[head, tail].astype(np.int64)))
    for lvl in [x for x in args.levels.split(",") if x]:
        failures += check_levels(bars, clocks, lvl, scale, args.offset, days)
    if args.trades:
        check_money(config.trades_dir(path.stem) / f"{args.trades}.csv", config.SPREAD)
    print("RESULT " + ("all checks agree with the engine" if failures == 0
                      else f"{failures} mismatches"))
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
