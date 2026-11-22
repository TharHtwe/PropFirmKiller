"""Combine London, New York, and New York RTH. One stored run per session.

The seven rows are every non-empty mix of these three runs. Lookback stays
at one month. A high-impact day is a date in
usd_0830_redfolder_dates_2020-2027.csv. On that day only, a New York trade
does not open or close from 08:28 through 08:32. One still open at the
08:27 close is cut in half there. At the 08:32 close the remainder aims for 100 points
or is closed if that price is already past, and its stop is the prop daily
4 percent line marked from equity at 00:00 UTC.

    python combine.py --news
    python combine.py --check
    python combine.py --file US100_M1_....csv
    python combine.py --file US100_M1_....csv --force

The page starts the run. This file does not start itself when imported.
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
import time
import traceback
from datetime import date, datetime, timezone
from heapq import heappop, heappush
from pathlib import Path

import numpy as np

BASE = Path(__file__).resolve().parent
STRATEGY_DIR = BASE.parent / "nasdaq-level-retrace-v2"
PROP_DIR = BASE.parent / "prop-firm"
sys.path.insert(0, str(STRATEGY_DIR))
sys.path.insert(0, str(PROP_DIR))

import config as sc  # noqa: E402
import data as sd  # noqa: E402
import events  # noqa: E402
import metrics  # noqa: E402
import prop  # noqa: E402
import run as sr  # noqa: E402

VERSION = 3
REDFOLDER_NAME = "usd_0830_redfolder_dates_2020-2027.csv"
RESULTS = BASE / "results"
MOVE = 50.0
HALF_MIN = 8 * 60 + 27
BLACK_LO = 8 * 60 + 28
BLACK_HI = 8 * 60 + 32
M830 = 8 * 60 + 30
M831 = 8 * 60 + 31
NEWS_TARGET = 100
SESSIONS = ("london", "ny", "rth")
RUNS = {
    "london": "sl50_tp50_london_lvrth_cont_confirm_1m_one",
    "ny": "sl50_tp50_ny_lvall_cont_touch_1m_one",
    "rth": "sl50_tp50_rth_lvall_cont_touch_1m_one_keep",
}
SESSION_LABEL = {"london": "London", "ny": "New York", "rth": "New York RTH"}
KIND_ORDER = {"entry": 0, "mae": 1, "half": 2, "decide": 3, "exit": 4}
WALK_CACHE = {}


def combos():
    out = []
    for mask in range(1, 8):
        keys = [SESSIONS[i] for i in range(3) if mask & (1 << i)]
        out.append(keys)
    return out


def combo_id(keys):
    return "+".join(keys)


def day_text(ordinal):
    return str(np.datetime64(int(ordinal), "D"))


def day_number(iso):
    return int(np.datetime64(iso, "D").astype(np.int64))


def utc_of(ts):
    return datetime.fromtimestamp(int(ts), timezone.utc)


def utc_day(ts):
    return utc_of(ts).date()


def ny_date(ordinal):
    return date.fromisoformat(day_text(ordinal))


def weekday_of(ny):
    wd = ny.weekday()
    return 4 if wd > 4 else wd


def price_points(side, value, bid, steps):
    return side * (bid - value) / steps


def lot_points(side, value, bid, fraction, steps):
    return fraction * price_points(side, value, bid, steps)


def stop_bid(value, side, fraction, balance, other_points, floor, point, steps):
    """Bid where this remainder's loss uses the dollars left down to the floor.

    ``other_points`` is every other open position, lot-weighted. ``point`` is
    the full 0.10-lot cents per index point. The returned bid is an integer
    price step.
    """
    need = (floor - balance) / point - other_points
    moved = need / fraction
    return int(round(value + side * moved * steps))


def paths_for(stem):
    base = RESULTS / stem
    return {
        "dir": base,
        "results": base / "combine.json",
        "progress": base / "progress.json",
        "news_csv": base / "news-days.csv",
        "news_json": base / "news-days.json",
        "news_txt": base / "news-days.txt",
        "handling": base / "news-handling.json",
    }


def write_progress(path, done, total, current, phase, running):
    prop.atomic_json(path, {
        "running": running,
        "done": done,
        "total": total,
        "current": current,
        "phase": phase,
        "updated": time.time(),
    })


def load_redfolder(stem):
    """Actual 08:30 red-folder dates stored beside this file's results."""
    path = paths_for(stem)["dir"] / REDFOLDER_NAME
    if not path.is_file():
        raise SystemExit(f"Missing red-folder dates: {path}")
    rows = {}
    with open(path, encoding="utf-8", newline="") as fh:
        for rec in csv.DictReader(fh):
            iso = (rec.get("date") or "").strip()
            if iso:
                rows[iso] = rec
    if not rows:
        raise SystemExit(f"No dates in {path}")
    return path, rows


def build_clock_index(bars, clocks, point, calendar=None):
    """News days, the 08:27 and 08:32 bars, and the last bid before each UTC day.

    ``calendar`` is the red-folder file keyed by New York date. Without it,
    a day is news when the 08:30 or 08:31 range is over 50 points.
    """
    ny_min = clocks["ny_min"]
    ny_day = clocks["ny_day"].astype(np.int64)
    high = bars["h"]
    low = bars["l"]
    ts = bars["ts"].astype(np.int64)
    n = ny_min.size
    days, starts = np.unique(ny_day, return_index=True)
    ends = np.r_[starts[1:], n]

    news_rows = []
    news_days = []
    half_at = {}
    decide_at = {}
    yearly = {}
    wanted = None
    if calendar is not None:
        wanted = {day_number(iso): rec for iso, rec in calendar.items()}
    present = set(int(day) for day in days)
    for day, a, b in zip(days, starts, ends):
        mins = ny_min[a:b]
        i830 = np.flatnonzero(mins == M830)
        i831 = np.flatnonzero(mins == M831)
        span = MOVE * point

        def span_of(idxs):
            if idxs.size == 0:
                return None
            i = a + int(idxs[0])
            return float(high[i] - low[i]), i

        s830 = span_of(i830)
        s831 = span_of(i831)
        if wanted is None:
            is_news = (s830 is not None and s830[0] > span) or (s831 is not None and s831[0] > span)
            rec = None
        else:
            is_news = int(day) in wanted
            rec = wanted.get(int(day))
        ihalf = np.flatnonzero(mins == HALF_MIN)
        if ihalf.size:
            half_at[int(day)] = a + int(ihalf[-1])
        elif is_news:
            earlier = np.flatnonzero(mins < BLACK_LO)
            if earlier.size:
                half_at[int(day)] = a + int(earlier[-1])
        idec = np.flatnonzero(mins == BLACK_HI)
        if idec.size:
            decide_at[int(day)] = a + int(idec[-1])
        elif is_news:
            later = np.flatnonzero(mins > BLACK_HI)
            if later.size:
                decide_at[int(day)] = a + int(later[0])
            else:
                inside = np.flatnonzero(mins >= BLACK_LO)
                if inside.size:
                    decide_at[int(day)] = a + int(inside[-1])
        if not is_news:
            continue
        year = ny_date(int(day)).strftime("%Y")
        bucket = yearly.setdefault(year, {"year": year, "max_0830": None, "max_0831": None, "days": 0})
        bucket["days"] += 1
        if s830 is not None:
            pts = round(s830[0] / point, 2)
            bucket["max_0830"] = pts if bucket["max_0830"] is None else max(bucket["max_0830"], pts)
        if s831 is not None:
            pts = round(s831[0] / point, 2)
            bucket["max_0831"] = pts if bucket["max_0831"] is None else max(bucket["max_0831"], pts)
        if rec is None:
            bits = []
            if s830 is not None and s830[0] > span:
                bits.append("08:30")
            if s831 is not None and s831[0] > span:
                bits.append("08:31")
            trigger = "+".join(bits)
        else:
            trigger = rec.get("releases") or ""
        ny = ny_date(int(day))
        news_days.append(int(day))
        news_rows.append({
            "ny_date": ny.isoformat(),
            "weekday": ny.strftime("%A"),
            "range_0830": None if s830 is None else round(s830[0] / point, 2),
            "range_0831": None if s831 is None else round(s831[0] / point, 2),
            "status": "" if rec is None else rec.get("status") or "",
            "releases": "" if rec is None else rec.get("releases") or "",
            "sources": "" if rec is None else rec.get("sources") or "",
            "trigger": trigger,
        })

    utc_day = ts // 86400
    into = {}
    # Last bar of each UTC day. The next UTC day's reference uses that close.
    if n:
        last = 0
        cur = int(utc_day[0])
        for i in range(1, n):
            d = int(utc_day[i])
            if d != cur:
                into[cur + 1] = last
                cur = d
            last = i
        into[cur + 1] = last
    return {
        "rows": news_rows,
        "days": set(news_days),
        "day_arr": np.asarray(news_days, dtype=np.int64),
        "half": half_at,
        "decide": decide_at,
        "into": into,
        "yearly": [yearly[year] for year in sorted(yearly)],
        "outside": [] if wanted is None else [
            iso for iso in sorted(calendar) if day_number(iso) not in present
        ],
        "calendar": 0 if calendar is None else len(calendar),
    }


def write_news(stem, info, point):
    paths = paths_for(stem)
    paths["dir"].mkdir(parents=True, exist_ok=True)
    dates = [row["ny_date"] for row in info["rows"]]
    payload = {
        "rule": "High impact on each date in usd_0830_redfolder_dates_2020-2027.csv that has a bar in this file.",
        "source": REDFOLDER_NAME,
        "calendar": info.get("calendar") or 0,
        "outside_data": info.get("outside") or [],
        "outside_count": len(info.get("outside") or []),
        "move_points": MOVE,
        "point_size": point,
        "count": len(dates),
        "first": dates[0] if dates else None,
        "last": dates[-1] if dates else None,
        "dates": dates,
        "rows": info["rows"],
        "yearly": info.get("yearly") or [],
        "written": time.time(),
    }
    prop.atomic_json(paths["news_json"], payload)
    with open(paths["news_csv"], "w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=[
            "ny_date", "weekday", "status", "releases", "sources", "range_0830", "range_0831", "trigger",
        ])
        writer.writeheader()
        writer.writerows(info["rows"])
    paths["news_txt"].write_text("\n".join(dates) + ("\n" if dates else ""), encoding="utf-8")
    return payload


def windows_for(entry_bar, exit_bar, info):
    """News windows this trade is still inside, in time order.

    A window counts when the trade is open at that day's 08:27 bar and the
    original stop or target has not filled on that bar or earlier.
    """
    out = []
    for day in sorted(info["days"]):
        half = info["half"].get(day)
        decide = info["decide"].get(day)
        if half is None or decide is None or decide <= half:
            continue
        if entry_bar <= half < exit_bar:
            out.append({"day": day, "half": int(half), "decide": int(decide)})
    return out


def select_plans(eng, ev, ex, cfg, session, info):
    """One trade a day. On a high-impact day a New York entry from 08:28 through 08:32 is skipped."""
    mode = sr.open_mode(cfg)
    ny = sr.ny_open_mode(cfg)
    sel = eng.mask(cfg["entry"], cfg["typ"], cfg["session"], cfg["look"], mode, ny)
    if sel.size == 0:
        return []
    bars = ev["bar"][sel]
    if session == "ny" and info["day_arr"].size:
        drop = np.isin(ev["day"][sel], info["day_arr"]) & (eng.clocks["ny_min"][bars] >= BLACK_LO) & (
            eng.clocks["ny_min"][bars] <= BLACK_HI
        )
        kept = sel[~drop]
    else:
        kept = sel
    out = np.empty(kept.size, np.int64)
    n = int(events.pick_first_per_day(kept.astype(np.int64), ev["day"], out))
    steps = sr.STEPS_PER_POINT
    plans = []
    for event_i in out[:n]:
        event_i = int(event_i)
        kind = int(ex[1][event_i])
        if kind < 0:
            continue
        bar = int(ev["bar"][event_i])
        if cfg["entry"] == "touch":
            side = 1 if int(ev["variant"][event_i]) == 1 else -1
            start = int(ev["fill"][event_i])
        else:
            start = int(eng.occ[bar])
            level = int(ev["cents"][event_i])
            if start == level:
                continue
            side = 1 if start > level else -1
        value = start + (sr.SPREAD_C if side > 0 else 0)
        ebar = int(ex[2][event_i])
        ny = ny_date(int(ev["day"][event_i]))
        wins = windows_for(bar, ebar, info) if session == "ny" else []
        plans.append({
            "session": session,
            "entry_bar": bar,
            "exit_bar": ebar,
            "entry_ts": int(eng.bars["ts"][bar]),
            "exit_ts": int(eng.bars["ts"][ebar]),
            "entry_day": ny,
            "weekday": weekday_of(ny),
            "side": side,
            "value": value,
            "pnl": float(ex[0][event_i]) / steps,
            "mae": float(ex[4][event_i]) / steps,
            "mfe": float(ex[5][event_i]) / steps,
            "kind": kind,
            "windows": wins,
            "news": bool(wins),
        })
    return plans


def load_plans(eng, info):
    grouped = {}
    london = sr.ensure_open(sc.parse_id(RUNS["london"]))
    ev = eng.events(london["lvl"])
    ex = eng.resolve(sr.ENTRY_CODE[london["entry"]], london["sl"], london["tp"])
    grouped["london"] = select_plans(eng, ev, ex, london, "london", info)
    del ev, ex
    eng.release()
    touch = sr.ensure_open(sc.parse_id(RUNS["ny"]))
    ev = eng.events(touch["lvl"])
    ex = eng.resolve(sr.ENTRY_CODE[touch["entry"]], touch["sl"], touch["tp"])
    for session in ("ny", "rth"):
        cfg = sr.ensure_open(sc.parse_id(RUNS[session]))
        grouped[session] = select_plans(eng, ev, ex, cfg, session, info)
    del ev, ex
    eng.release()
    return grouped


class Book:
    def __init__(self, point, mode, cushion, min_green, until, arrays):
        self.point = point
        self.mode = mode
        self.cushion = cushion
        self.min_green = min_green
        self.until = until
        self.oc, self.oh, self.ol, self.occ, self.blo, self.bhi, self.ts, self.into = arrays
        self.steps = sr.STEPS_PER_POINT
        self.stats = prop.blank_stats([])
        self.acct = prop.fresh()
        self.acct["alive"] = False
        self.positions = {}
        self.rows = {}
        self.heap = []
        self.seq = 0
        self.started = False
        self.decides = set()
        self.walks = {}
        self.news = {
            "managed": 0, "halves": 0, "flat_half": 0, "take_100": 0,
            "flat_decide": 0, "stops": 0, "targets": 0, "gaps": 0,
        }
        self.blows = []
        self.blow_how = ""
        self.blow_news = False

    def push(self, ts, kind, payload):
        self.seq += 1
        heappush(self.heap, (int(ts), KIND_ORDER[kind], self.seq, kind, payload))

    def buy(self, ny):
        self.acct = prop.fresh()
        self.acct["utc_ord"] = None
        self.positions.clear()
        self.acct["open"].clear()
        self.decides.clear()
        self.started = True
        if self.stats.get("first_start") is None:
            self.stats["first_start"] = ny
        if self.mode == "prop":
            self.stats["challenges"] += 1
            self.stats["fees"] += prop.FEE
            self.stats["events"].append({
                "date": ny.isoformat(), "kind": "fee", "fee": prop.FEE,
            })

    def stopped(self):
        if self.until != "decision" or not self.started:
            return False
        return (not self.acct["alive"]) or self.acct["phase"] == "funded"

    def equity(self):
        return prop.equity(self.acct, self.point)

    def guard(self, on_day):
        if self.mode != "prop" or not self.acct["alive"]:
            return False
        daily_before = self.stats["daily"]
        open_news = any(pos["plan"].get("news") for pos in self.positions.values()) or self.blow_news
        if not prop.breached(self.acct, self.stats, self.equity(), on_day):
            return False
        self.stats["death_day"] = self.acct.get("death_day")
        reason = "daily" if self.stats["daily"] != daily_before else "maxdd"
        when = on_day.isoformat() if isinstance(on_day, date) else str(on_day)
        self.blows.append({
            "date": when,
            "reason": reason,
            "how": self.blow_how or "",
            "news": bool(open_news),
        })
        self.positions.clear()
        self.decides.clear()
        return True

    def sync(self, ts, on_day):
        day = int(ts) // 86400
        acct = self.acct
        if acct.get("utc_ord") is None:
            acct["utc_ord"] = day
            acct["ref"] = acct["balance"]
            return False
        while acct["utc_ord"] < day:
            acct["utc_ord"] += 1
            bar = self.into.get(acct["utc_ord"])
            if bar is None or not self.positions:
                eq = acct["balance"]
            else:
                self.mark(int(self.occ[bar]))
                eq = self.equity()
            acct["ref"] = eq if eq > acct["balance"] else acct["balance"]
            self.blow_how = "midnight"
            if self.guard(on_day):
                return True
        return False

    def mark(self, bid):
        for pos in self.positions.values():
            pts = lot_points(pos["side"], pos["value"], bid, pos["fraction"], self.steps)
            self.acct["open"][pos["id"]] = pts
            pos["open_pts"] = pts

    def others(self, skip_id):
        return sum(pos["open_pts"] for pid, pos in self.positions.items() if pid != skip_id)

    def row_for(self, plan):
        key = id(plan)
        row = self.rows.get(key)
        if row is None:
            row = {
                "session": plan["session"],
                "entry_ts": plan["entry_ts"],
                "exit_ts": plan["exit_ts"],
                "entry_day": plan["entry_day"],
                "weekday": plan["weekday"],
                "side": plan["side"],
                "entry_bar": plan["entry_bar"],
                "exit_bar": plan["exit_bar"],
                "points": 0.0,
                "half_points": 0.0,
                "rest_points": 0.0,
                "exit_kind": {0: "stop", 1: "target", 2: "end"}.get(plan["kind"], "end"),
                "news": False,
                "mae": plan["mae"],
            }
            self.rows[key] = row
        return row

    def book_leg(self, pos, take, kind, ts, bar, final, bucket):
        row = self.row_for(pos["plan"])
        row["points"] += take
        row["exit_ts"] = int(ts)
        row["exit_bar"] = int(bar)
        row["exit_kind"] = kind
        if bucket == "half":
            row["half_points"] += take
        elif bucket == "rest":
            row["rest_points"] += take
        if pos["plan"]["news"]:
            row["news"] = True
        on_day = utc_day(ts)
        if self.mode == "plain":
            self.acct["balance"] += prop.cents(take, self.point)
            self.positions.pop(pos["id"], None) if final else None
            if final:
                self.acct["open"].pop(pos["id"], None)
            else:
                self.acct["open"][pos["id"]] = pos["open_pts"]
            return
        if final:
            self.acct["open"][pos["id"]] = take
            self.positions.pop(pos["id"], None)
            self.blow_how = kind
            self.blow_news = bool(pos["plan"].get("news"))
            if self.guard(on_day):
                return
            trade = {"id": pos["id"], "pnl": take, "phase": pos["phase"]}
            prop.book(self.acct, trade, self.stats, self.cushion, self.min_green, on_day, self.point)
            return
        leg = f"{pos['id']}:{self.seq}"
        self.seq += 1
        self.acct["open"][pos["id"]] = pos["open_pts"]
        self.acct["open"][leg] = take
        trade = {"id": leg, "pnl": take, "phase": pos["phase"]}
        prop.book(self.acct, trade, self.stats, self.cushion, self.min_green, on_day, self.point)

    def flatten(self, bid, ts, bar, kind, bucket):
        doomed = list(self.positions.values())
        breached = False
        for pos in doomed:
            take = lot_points(pos["side"], pos["value"], bid, pos["fraction"], self.steps)
            pos["open_pts"] = take
            self.acct["open"][pos["id"]] = take
        on_day = utc_day(ts)
        self.blow_how = "flat-827" if bucket == "half" else "flat-832"
        if self.mode == "prop" and self.guard(on_day):
            breached = True
        for pos in doomed:
            take = lot_points(pos["side"], pos["value"], bid, pos["fraction"], self.steps)
            if breached:
                row = self.row_for(pos["plan"])
                row["points"] += take
                if bucket == "half":
                    row["half_points"] += take
                else:
                    row["rest_points"] += take
                row["exit_kind"] = kind
                row["exit_ts"] = int(ts)
                row["exit_bar"] = int(bar)
                row["news"] = True
                continue
            pos["open_pts"] = 0
            self.book_leg(pos, take, kind, ts, bar, True, bucket)
        return breached

    def arm_half(self, pos, window):
        pos["state"] = "live"
        pos["window"] = window
        self.push(int(self.ts[window["half"]]), "half", pos["id"])

    def on_entry(self, plan):
        if self.stopped():
            return
        if not self.acct["alive"]:
            self.buy(plan["entry_day"])
        if self.sync(plan["entry_ts"], plan["entry_day"]):
            if self.until == "decision":
                return
            self.buy(plan["entry_day"])
        acct = self.acct
        if acct["phase"] == "funded" and acct["due"] is None:
            acct["due"] = date.fromisoformat(str(np.busday_offset(np.datetime64(plan["entry_day"]), 10)))
        elif acct["phase"] == "funded" and acct["due"] is not None and not self.positions:
            if acct["due"] < plan["entry_day"]:
                prop.payout(acct, acct["due"], self.cushion, self.stats, self.min_green)
        acct["hold_n"] += 1
        if plan["exit_bar"] > plan["entry_bar"]:
            acct["hold_ok"] += 1
        if acct["phase_start"] is None:
            acct["phase_start"] = plan["entry_day"]
        pid = self.stats["seq"]
        self.stats["seq"] += 1
        pos = {
            "id": pid,
            "plan": plan,
            "side": plan["side"],
            "value": plan["value"],
            "fraction": 1.0,
            "state": "live",
            "phase": acct["phase"],
            "open_pts": 0.0,
            "window": None,
            "style": "news" if plan["news"] else "plain",
        }
        self.positions[pid] = pos
        acct["open"][pid] = 0.0
        self.row_for(plan)
        self.blow_how = "entry"
        if self.guard(plan["entry_day"]):
            return
        if plan["news"]:
            self.news["managed"] += 1
            self.arm_half(pos, plan["windows"][0])
            return
        if plan["mae"] > 0:
            self.push(plan["entry_ts"] + 1, "mae", pid)
        self.push(plan["exit_ts"], "exit", pid)

    def on_mae(self, pid):
        pos = self.positions.get(pid)
        if pos is None or pos["state"] != "live":
            return
        if self.sync(pos["plan"]["entry_ts"] + 1, pos["plan"]["entry_day"]):
            return
        self.acct["open"][pid] = -pos["plan"]["mae"]
        pos["open_pts"] = -pos["plan"]["mae"]
        self.blow_how = "heat"
        self.guard(pos["plan"]["entry_day"])

    def on_half(self, pid):
        pos = self.positions.get(pid)
        if pos is None or pos["state"] != "live":
            return
        window = pos["window"]
        bar = window["half"]
        ts = int(self.ts[bar])
        if self.sync(ts, ny_date(window["day"])):
            return
        bid = int(self.occ[bar])
        self.mark(bid)
        full = lot_points(pos["side"], pos["value"], bid, pos["fraction"], self.steps)
        pos["open_pts"] = full
        self.acct["open"][pid] = full
        on_day = utc_day(ts)
        if self.mode == "prop" and self.equity() <= prop.day_floor(self.acct["ref"], prop.SPEC["daily_pct"]):
            self.news["flat_half"] += 1
            self.flatten(bid, ts, bar, "news-stop", "half")
            return
        if self.mode == "prop" and self.equity() <= self.acct["floor"]:
            self.news["flat_half"] += 1
            self.flatten(bid, ts, bar, "news-stop", "half")
            return
        half = full / 2.0
        pos["fraction"] /= 2.0
        pos["open_pts"] = half
        self.news["halves"] += 1
        self.book_leg(pos, half, "news-half", ts, bar, False, "half")
        if pid not in self.positions:
            return
        pos["state"] = "frozen"
        pos["open_pts"] = half
        self.acct["open"][pid] = half
        if window["decide"] not in self.decides:
            self.decides.add(window["decide"])
            self.push(int(self.ts[window["decide"]]), "decide", window["decide"])

    def on_decide(self, bar):
        self.decides.discard(bar)
        frozen = [pos for pos in self.positions.values() if pos["state"] == "frozen"]
        if not frozen:
            return
        ts = int(self.ts[bar])
        if self.sync(ts, utc_day(ts)):
            return
        bid = int(self.occ[bar])
        self.mark(bid)
        floor = prop.day_floor(self.acct["ref"], prop.SPEC["daily_pct"])
        if self.equity() <= floor or self.equity() <= self.acct["floor"]:
            self.news["flat_decide"] += 1
            self.flatten(bid, ts, bar, "news-stop", "rest")
            return
        for pos in list(frozen):
            if pos["id"] not in self.positions or pos["state"] != "frozen":
                continue
            moved = price_points(pos["side"], pos["value"], bid, self.steps)
            if moved >= NEWS_TARGET:
                self.news["take_100"] += 1
                take = lot_points(pos["side"], pos["value"], bid, pos["fraction"], self.steps)
                self.book_leg(pos, take, "news-target", ts, bar, True, "rest")
                continue
            other = self.others(pos["id"])
            stop = stop_bid(
                pos["value"], pos["side"], pos["fraction"], self.acct["balance"],
                other, floor, self.point, self.steps,
            )
            current = lot_points(pos["side"], pos["value"], bid, pos["fraction"], self.steps)
            allowed = (floor - self.acct["balance"]) / self.point - other
            if current <= allowed:
                self.news["flat_decide"] += 1
                take = current
                self.book_leg(pos, take, "news-stop", ts, bar, True, "rest")
                if self.mode == "prop" and not self.acct["alive"]:
                    return
                continue
            sl_c = int(pos["side"] * (pos["value"] - stop))
            if sl_c <= 0:
                self.news["flat_decide"] += 1
                self.book_leg(pos, current, "news-stop", ts, bar, True, "rest")
                continue
            hit = self.walk(pos, stop, sl_c, bar)
            nxt = self.later_window(pos, bar)
            if nxt is not None and hit["ebar"] > nxt["half"]:
                pos["state"] = "live"
                self.arm_half(pos, nxt)
                continue
            self.news[hit["bucket"]] += 1
            pos["state"] = "pending"
            self.push(int(self.ts[hit["ebar"]]), "exit", (pos["id"], hit))

    def later_window(self, pos, after_bar):
        for window in pos["plan"]["windows"]:
            if window["half"] > after_bar:
                return window
        return None

    def walk(self, pos, stop, sl_c, bar):
        key = (pos["side"], pos["value"], int(stop), int(bar), int(sl_c))
        hit = WALK_CACHE.get(key)
        if hit is None:
            pnl, kind, ebar, _esub, _mae, _mfe = events.walk(
                np.int8(pos["side"]), np.int64(self.occ[bar]), np.int64(pos["value"]),
                np.int64(sl_c), np.int64(sr.pts_c(NEWS_TARGET)),
                np.int64(bar), np.int64(4),
                self.oc, self.oh, self.ol, self.occ, self.blo, self.bhi,
            )
            ebar = int(ebar)
            kind = int(kind)
            if kind == 0:
                opened = int(self.oc[ebar])
                worse = (pos["side"] > 0 and opened < stop) or (pos["side"] < 0 and opened > stop)
                px = opened if worse else int(stop)
                label = "gap-stop" if worse else "stop"
                bucket = "gaps" if worse else "stops"
            elif kind == 1:
                px = int(pos["value"] + pos["side"] * pnl)
                label = "target"
                bucket = "targets"
            else:
                px = int(self.occ[ebar])
                label = "end"
                bucket = "stops"
            hit = {"ebar": ebar, "px": px, "label": label, "bucket": bucket}
            WALK_CACHE[key] = hit
        return hit

    def on_exit(self, payload):
        if isinstance(payload, tuple):
            pid, hit = payload
            pos = self.positions.get(pid)
            if pos is None or pos["state"] != "pending":
                return
            bar = hit["ebar"]
            ts = int(self.ts[bar])
            if self.sync(ts, utc_day(ts)):
                return
            take = lot_points(pos["side"], pos["value"], hit["px"], pos["fraction"], self.steps)
            self.book_leg(pos, take, hit["label"], ts, bar, True, "rest")
            return
        pos = self.positions.get(payload)
        if pos is None or pos["style"] != "plain":
            return
        plan = pos["plan"]
        if self.sync(plan["exit_ts"], utc_day(plan["exit_ts"])):
            return
        kind = {0: "stop", 1: "target", 2: "end"}.get(plan["kind"], "end")
        self.book_leg(pos, plan["pnl"], kind, plan["exit_ts"], plan["exit_bar"], True, None)

    def run(self, plans):
        if self.mode == "plain":
            self.buy(plans[0]["entry_day"] if plans else date(2020, 1, 1))
            self.stats["challenges"] = 0
            self.stats["fees"] = 0
            self.stats["events"] = []
            self.stats["first_start"] = None
        for plan in plans:
            self.push(plan["entry_ts"], "entry", plan)
        while self.heap:
            ts, _order, _seq, kind, payload = heappop(self.heap)
            if kind == "entry":
                self.on_entry(payload)
            elif kind == "mae":
                self.on_mae(payload)
            elif kind == "half":
                self.on_half(payload)
            elif kind == "decide":
                self.on_decide(payload)
            else:
                self.on_exit(payload)
        rows = sorted(self.rows.values(), key=lambda row: (row["entry_ts"], row["session"]))
        self.stats["trades"] = len(rows)
        self.stats["wins"] = sum(1 for row in rows if row["points"] > 0)
        self.stats["points"] = round(sum(row["points"] for row in rows), 2)
        if self.acct.get("death_day") is not None:
            self.stats["death_day"] = self.acct.get("death_day")
        self.stats["net"] = self.stats["received"] - self.stats["fees"]
        self.stats["end_alive"] = bool(self.acct["alive"]) and self.mode == "prop"
        if self.mode == "plain":
            self.stats["end_alive"] = True
            self.stats["end_phase"] = "strategy"
            self.stats["end_profit"] = self.acct["balance"] - prop.START
        else:
            self.stats["end_phase"] = self.acct["phase"] if self.acct["alive"] else "blown"
            self.stats["end_profit"] = 0 if not self.acct["alive"] else self.acct["balance"] - prop.START
        prop.note_first_days(self.stats)
        self.stats["blows"] = self.blows
        return rows, self.stats, self.news


def play(plans, point, mode, arrays, cushion=0, min_green=3, until=None):
    book = Book(point, mode, cushion, min_green, until, arrays)
    return book.run(plans)


def strategy_view(rows):
    if not rows:
        return {"trades": 0, "wins": 0, "win_rate": 0.0, "net_points": 0.0, "sessions": {}, "years": []}
    steps = sr.STEPS_PER_POINT
    pnl = np.array([row["points"] for row in rows], dtype=np.float64)
    kind = np.array([
        0 if row["exit_kind"] in ("stop", "news-stop", "gap-stop") else
        1 if row["exit_kind"] in ("target", "news-target") else 2
        for row in rows
    ], dtype=np.int8)
    side = np.array([row["side"] for row in rows], dtype=np.int8)
    day = np.array([row["entry_day"].toordinal() for row in rows], dtype=np.int64)
    # metrics.compute treats day as a datetime64 day number, not a Python ordinal.
    # The ordinal is only used to group days, so any unique day id is enough.
    ent = np.array([row["entry_bar"] for row in rows], dtype=np.int32)
    exb = np.array([row["exit_bar"] for row in rows], dtype=np.int32)
    hour = np.array([(row["entry_ts"] // 3600) % 24 for row in rows], dtype=np.int8)
    weekday = np.array([row["entry_day"].weekday() for row in rows], dtype=np.int8)
    mae = np.array([row["mae"] * steps for row in rows], dtype=np.float64)
    zero = np.zeros(len(rows), dtype=np.float64)
    raw = metrics.compute(
        pnl * steps, kind, exb, np.zeros(len(rows), np.int32), mae, zero,
        side, day, ent, hour, weekday, 50, steps,
    )
    for key in ("best_day", "worst_day"):
        item = raw["daily"][key]
        item["day"] = date.fromordinal(int(item["day"])).isoformat()
    sessions = {}
    years = {}
    for row in rows:
        bucket = sessions.setdefault(row["session"], {"trades": 0, "wins": 0, "points": 0.0})
        bucket["trades"] += 1
        bucket["points"] += row["points"]
        if row["points"] > 0:
            bucket["wins"] += 1
        year = str(row["entry_day"].year)
        yb = years.setdefault(year, {"year": year, "trades": 0, "wins": 0, "points": 0.0})
        yb["trades"] += 1
        yb["points"] += row["points"]
        if row["points"] > 0:
            yb["wins"] += 1
    for bucket in sessions.values():
        bucket["points"] = round(bucket["points"], 2)
        bucket["win_rate"] = round(100.0 * bucket["wins"] / bucket["trades"], 1) if bucket["trades"] else 0
    year_rows = []
    for year in sorted(years):
        yb = years[year]
        yb["points"] = round(yb["points"], 2)
        yb["win_rate"] = round(100.0 * yb["wins"] / yb["trades"], 1) if yb["trades"] else 0
        year_rows.append(yb)
    keep = (
        "trades", "wins", "losses", "win_rate", "net_points", "expectancy",
        "profit_factor", "profit_factor_without_best", "max_drawdown", "max_drawdown_trades",
        "payoff", "avg_win", "avg_loss", "longs", "shorts", "long_net", "short_net",
        "targets", "stops", "forced", "chunks", "streaks", "hold", "daily",
    )
    out = {key: raw[key] for key in keep}
    out["sessions"] = sessions
    out["years"] = year_rows
    out["news_trades"] = sum(1 for row in rows if row["news"])
    return out


def write_trade_csv(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=[
            "seq", "session", "entry_utc", "exit_utc", "ny_date", "side",
            "points", "half_points", "rest_points", "exit_kind", "news",
        ])
        writer.writeheader()
        for i, row in enumerate(rows, 1):
            writer.writerow({
                "seq": i,
                "session": row["session"],
                "entry_utc": utc_of(row["entry_ts"]).strftime("%Y-%m-%d %H:%M:%S"),
                "exit_utc": utc_of(row["exit_ts"]).strftime("%Y-%m-%d %H:%M:%S"),
                "ny_date": row["entry_day"].isoformat(),
                "side": "buy" if row["side"] > 0 else "sell",
                "points": round(row["points"], 2),
                "half_points": round(row["half_points"], 2),
                "rest_points": round(row["rest_points"], 2),
                "exit_kind": row["exit_kind"],
                "news": "yes" if row["news"] else "",
            })


def month_week(plans, point, arrays):
    if not plans:
        return {"layout": "week", "funded": 0, "blown": 0, "open": 0, "funded_days": None, "blown_days": None, "rows": []}
    last = max(plan["entry_day"] for plan in plans)
    rows = []
    funded_days = []
    blown_days = []
    for origin in prop.iter_months(last):
        cells = []
        any_trade = False
        for weekday in range(5):
            mine = [plan for plan in plans if plan["weekday"] == weekday and plan["entry_day"] >= origin]
            if not mine:
                cells.append(None)
                continue
            any_trade = True
            result, days = decision_full(mine, point, arrays, origin)
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
        "funded_days": prop.agg_days(funded_days),
        "blown_days": prop.agg_days(blown_days),
        "rows": rows,
    }


def decision_full(plans, point, arrays, origin):
    rows, stats, _news = play(plans, point, "prop", arrays, until="decision")
    del rows
    if stats.get("first_funded") is not None:
        return "funded", prop.calendar_days(origin, stats["first_funded"])
    if stats["challenges"] and not stats["end_alive"]:
        end = stats.get("death_day") or stats.get("first_start") or origin
        return "blown", prop.calendar_days(origin, end)
    return "open", None


def analyse_combo(keys, grouped, point, arrays, stem):
    plans = []
    for key in keys:
        plans.extend(grouped[key])
    plans.sort(key=lambda plan: (plan["entry_ts"], SESSIONS.index(plan["session"])))
    plain_rows, _plain_stats, plain_news = play(plans, point, "plain", arrays)
    view = strategy_view(plain_rows)
    write_trade_csv(paths_for(stem)["dir"] / f"trades-{combo_id(keys)}.csv", plain_rows)

    def prop_pack(mode, cushion, min_green):
        if mode == "one":
            _rows, stats, news = play(plans, point, "prop", arrays, cushion, min_green)
            packed = prop.pack_rows([stats])
            packed["news"] = news
            return packed, stats
        parts = []
        news = None
        for weekday in range(5):
            mine = [plan for plan in plans if plan["weekday"] == weekday]
            _rows, stats, part = play(mine, point, "prop", arrays, cushion, min_green)
            parts.append(stats)
            if news is None:
                news = {key: 0 for key in part}
            for key, value in part.items():
                news[key] += value
        packed = prop.pack_rows(parts)
        packed["news"] = news
        return packed, parts

    prop_full, prop_parts = prop_pack("week", 0, prop.SPEC["min_green"])
    prop_cushion, _ = prop_pack("week", 40_000, prop.SPEC["min_green"])
    prop_green, _ = prop_pack("week", 0, 0)
    one_full, one_stats = prop_pack("one", 0, prop.SPEC["min_green"])
    one_cushion, _ = prop_pack("one", 40_000, prop.SPEC["min_green"])
    one_green, _ = prop_pack("one", 0, 0)

    prop_full["cushion_net"] = prop_cushion["net"]
    prop_full["no_green_net"] = prop_green["net"]
    prop_full["starts"] = month_week(plans, point, arrays)
    one_full["cushion_net"] = one_cushion["net"]
    one_full["no_green_net"] = one_green["net"]
    one_full["starts"] = month_one_full(plans, point, arrays)
    one_full["points"] = one_stats["points"]
    one_full["trades"] = one_stats["trades"]
    one_full["win_rate"] = round(100.0 * one_stats["wins"] / one_stats["trades"], 1) if one_stats["trades"] else 0.0
    prop_full["points"] = round(sum(part["points"] for part in prop_parts), 2)
    prop_full["trades"] = sum(part["trades"] for part in prop_parts)
    prop_wins = sum(part["wins"] for part in prop_parts)
    prop_full["win_rate"] = round(100.0 * prop_wins / prop_full["trades"], 1) if prop_full["trades"] else 0.0
    return {
        "id": combo_id(keys),
        "sessions": list(keys),
        "labels": [SESSION_LABEL[key] for key in keys],
        "configs": {key: RUNS[key] for key in keys},
        "strategy": view,
        "news": plain_news,
        "prop": prop_full,
        "prop2": one_full,
        "analyzed": time.time(),
    }


def month_one_full(plans, point, arrays):
    if not plans:
        return {"layout": "one", "funded": 0, "blown": 0, "open": 0, "funded_days": None, "blown_days": None, "rows": []}
    last = max(plan["entry_day"] for plan in plans)
    rows = []
    funded_days = []
    blown_days = []
    for origin in prop.iter_months(last):
        mine = [plan for plan in plans if plan["entry_day"] >= origin]
        if not mine:
            continue
        result, days = decision_full(mine, point, arrays, origin)
        rows.append([origin.isoformat(), result, days])
        if result == "funded":
            funded_days.append(days)
        elif result == "blown":
            blown_days.append(days)
    return {
        "layout": "one",
        "funded": len(funded_days),
        "blown": len(blown_days),
        "open": sum(1 for row in rows if row[1] == "open"),
        "funded_days": prop.agg_days(funded_days),
        "blown_days": prop.agg_days(blown_days),
        "rows": rows,
    }


def _band(values):
    if not values:
        return {"n": 0, "min": None, "max": None, "avg": None}
    return {
        "n": len(values),
        "min": round(min(values), 2),
        "max": round(max(values), 2),
        "avg": round(sum(values) / len(values), 2),
    }


def _day_slices(ny_day):
    days, starts = np.unique(ny_day.astype(np.int64), return_index=True)
    ends = np.r_[starts[1:], ny_day.size]
    return {int(day): (int(start), int(end)) for day, start, end in zip(days, starts, ends)}


def _at(ny_min, sl, minute, first=True):
    if sl is None:
        return None
    mins = ny_min[sl[0]:sl[1]]
    hit = np.flatnonzero(mins == minute)
    if hit.size == 0:
        return None
    return sl[0] + int(hit[0] if first else hit[-1])


def _after(ny_min, sl, minute):
    if sl is None:
        return None
    mins = ny_min[sl[0]:sl[1]]
    hit = np.flatnonzero(mins >= minute)
    if hit.size == 0:
        return None
    return sl[0] + int(hit[0])


def handling_study(bars, clocks, info, plans, arrays, point):
    """New York session on high-impact days, and the path after 08:32.

    The New York session starts at 08:00, so a trade can be open at the 08:27
    close. On a news day that trade is cut in half, and a new entry waits
    until after 08:32. London and RTH are not put through this window.
    """
    ny_min = clocks["ny_min"]
    slices = _day_slices(clocks["ny_day"])
    news_ids = info["days"]
    high = bars["h"]
    low = bars["l"]
    close = bars["c"]
    opened = bars["o"]

    rows, _stats, news_counts = play(plans, point, "plain", arrays)
    by_entry = {}
    for row in rows:
        by_entry.setdefault((row["entry_ts"], row["side"]), row)

    fresh_adverse = []
    fresh_favor = []
    fresh_adv30 = []
    fresh_fav30 = []
    carry_adverse = []
    carry_favor = []
    fresh_rows = []
    carry_rows = []
    early_rows = []
    with_30 = against_30 = flat_30 = 0
    priced = {
        "days": 0, "fade_before": 0, "reverse_830": 0, "reverse_832": 0,
        "fade_then_reverse_830": 0, "fade_then_reverse_832": 0, "skipped": 0,
    }

    # Price pattern on every high-impact day, independent of whether we traded.
    for day in sorted(news_ids):
        sl = slices.get(day)
        b800 = _at(ny_min, sl, 8 * 60)
        b829 = _at(ny_min, sl, 8 * 60 + 29)
        b831 = _at(ny_min, sl, M831)
        b832 = info["decide"].get(day)
        b902 = _after(ny_min, sl, 9 * 60 + 2)
        if None in (b800, b829, b831, b832, b902):
            priced["skipped"] += 1
            continue
        priced["days"] += 1
        start = float(opened[b800])
        window = slice(b800, b829 + 1)
        hi = float(high[window].max())
        lo = float(low[window].min())
        up = hi - start
        down = start - lo
        if max(up, down) < 15:
            direction = 0
            excursion = 0.0
            retrace = 0.0
        elif up >= down:
            direction = 1
            excursion = up
            retrace = hi - float(close[b829])
        else:
            direction = -1
            excursion = down
            retrace = float(close[b829]) - lo
        faded = direction != 0 and retrace >= 0.5 * excursion
        spike = float(close[b831]) - float(close[b829])
        later = float(close[b902]) - float(close[b832])
        rev830 = direction != 0 and spike * direction < 0 and abs(spike) >= 10
        rev832 = direction != 0 and later * direction < 0 and abs(later) >= 10
        if faded:
            priced["fade_before"] += 1
        if rev830:
            priced["reverse_830"] += 1
        if rev832:
            priced["reverse_832"] += 1
        if faded and rev830:
            priced["fade_then_reverse_830"] += 1
        if faded and rev832:
            priced["fade_then_reverse_832"] += 1

    news_dates = {ny_date(day) for day in news_ids}
    for plan in plans:
        managed = by_entry.get((plan["entry_ts"], plan["side"]))
        if managed is None:
            continue
        entry_minute = int(ny_min[plan["entry_bar"]])
        news_entry = plan["entry_day"] in news_dates
        window = plan["windows"][0] if plan["windows"] else None
        carry = window is not None
        if not news_entry and not carry:
            continue
        side = plan["side"]
        sl = slices.get(int(np.datetime64(plan["entry_day"].isoformat(), "D").astype(np.int64)))
        # A carried trade is measured on the news morning it was still open.
        if carry:
            day = window["day"]
            sl = slices.get(day)
            b832 = window["decide"]
            b902 = _after(ny_min, sl, 9 * 60 + 2)
            ref = float(close[b832])
            end = int(managed["exit_bar"])
            adv, fav = _excursion(side, ref, high, low, b832 + 1, end)
            carry_adverse.append(adv)
            carry_favor.append(fav)
            moved = None if b902 is None else (float(close[b902]) - ref) * side
            record = carry_rows
            when = "open"
        elif news_entry and entry_minute > BLACK_HI:
            adv = float(plan["mae"])
            fav = float(plan["mfe"])
            fresh_adverse.append(adv)
            fresh_favor.append(fav)
            b832 = info["decide"].get(int(np.datetime64(plan["entry_day"].isoformat(), "D").astype(np.int64)))
            b902 = _after(ny_min, sl, 9 * 60 + 2)
            ref = None if b832 is None else float(close[b832])
            moved = None if ref is None or b902 is None else (float(close[b902]) - ref) * side
            if ref is not None and b902 is not None:
                a30, f30 = _excursion(side, ref, high, low, b832 + 1, b902)
                fresh_adv30.append(a30)
                fresh_fav30.append(f30)
            record = fresh_rows
            when = "after"
        elif news_entry:
            adv = float(plan["mae"])
            fav = float(plan["mfe"])
            moved = None
            record = early_rows
            when = "before"
        else:
            continue
        if moved is not None:
            if moved >= 10:
                with_30 += 1
            elif moved <= -10:
                against_30 += 1
            else:
                flat_30 += 1
        kind = managed["exit_kind"]
        record.append({
            "when": when,
            "ny_date": plan["entry_day"].isoformat() if not carry else ny_date(window["day"]).isoformat(),
            "side": "buy" if side > 0 else "sell",
            "entry_minute": entry_minute,
            "points": round(managed["points"], 2),
            "exit": kind,
            "adverse": round(adv, 2),
            "favorable": round(fav, 2),
            "after_832_30m": None if moved is None else round(moved, 2),
        })

    def outcome(bucket):
        wins = sum(1 for row in bucket if row["points"] > 0)
        targets = sum(1 for row in bucket if row["exit"] in ("target", "news-target"))
        stops = sum(1 for row in bucket if row["exit"] in ("stop", "news-stop", "gap-stop"))
        gaps = sum(1 for row in bucket if row["exit"] == "gap-stop")
        return {
            "trades": len(bucket),
            "wins": wins,
            "win_rate": round(100.0 * wins / len(bucket), 1) if bucket else None,
            "points": round(sum(row["points"] for row in bucket), 2),
            "targets": targets,
            "stops": stops,
            "gaps": gaps,
        }

    def blow_summary(stats):
        rows = stats.get("blows") or []
        fast = [row for row in rows if row["how"] in ("flat-832", "gap-stop", "news-stop")]
        at_stop = [row for row in rows if row["how"] == "stop" and row["news"]]
        return {
            "blows": len(rows),
            "fast_after_830": len(fast),
            "hit_news_stop": len(at_stop),
            "fast_dates": [row["date"] for row in fast],
        }

    _, one_stats, _ = play(plans, point, "prop", arrays)
    week_fast = 0
    week_blows = 0
    week_dates = []
    for weekday in range(5):
        mine = [plan for plan in plans if plan["weekday"] == weekday]
        _, stats, _ = play(mine, point, "prop", arrays)
        part = blow_summary(stats)
        week_fast += part["fast_after_830"]
        week_blows += part["blows"]
        week_dates.extend(part["fast_dates"])

    one = blow_summary(one_stats)
    report = {
        "session": "New York only",
        "config": RUNS["ny"],
        "news_days": len(news_ids),
        "news_day": outcome(early_rows + carry_rows + fresh_rows),
        "early": outcome(early_rows),
        "fresh": outcome(fresh_rows),
        "fresh_adverse": _band(fresh_adverse),
        "fresh_favorable": _band(fresh_favor),
        "half_hour_against": _band(fresh_adv30),
        "half_hour_with": _band(fresh_fav30),
        "news_days_without_trade": sorted(
            day.isoformat() for day in news_dates
            if day.isoformat() not in {row["ny_date"] for row in early_rows + carry_rows + fresh_rows}
        ),
        "carry": outcome(carry_rows),
        "carry_adverse": _band(carry_adverse),
        "carry_favorable": _band(carry_favor),
        "after_832": {"with_us": with_30, "against_us": against_30, "flat": flat_30},
        "price": priced,
        "engine_news": news_counts,
        "blows_one_account": one,
        "blows_five_accounts": {"blows": week_blows, "fast_after_830": week_fast, "fast_dates": week_dates},
        "rows": sorted(early_rows + carry_rows + fresh_rows, key=lambda row: (row["ny_date"], row["when"])),
        "written": time.time(),
    }
    return report


def _excursion(side, ref, high, low, i0, i1):
    if i1 < i0:
        return 0.0, 0.0
    hh = float(high[i0:i1 + 1].max())
    ll = float(low[i0:i1 + 1].min())
    if side > 0:
        return ref - ll, hh - ref
    return hh - ref, ref - ll


def json_ready(result):
    """Drop leftover date objects before the file is written."""
    def scrub(value):
        if isinstance(value, dict):
            return {key: scrub(item) for key, item in value.items()}
        if isinstance(value, list):
            return [scrub(item) for item in value]
        if isinstance(value, (date, datetime)):
            return value.isoformat()
        if isinstance(value, np.generic):
            return value.item()
        return value
    return scrub(result)


def write_handling(stem, report):
    path = paths_for(stem)["handling"]
    path.parent.mkdir(parents=True, exist_ok=True)
    prop.atomic_json(path, json_ready(report))
    fresh = report["fresh"]
    print(
        f"ny news trades {fresh['trades']}  win {fresh['win_rate']}  "
        f"targets {fresh['targets']}  stops {fresh['stops']}  "
        f"fast blows {report['blows_one_account']['fast_after_830']}",
        flush=True,
    )
    print(f"wrote {path}", flush=True)
    return report


def run_handling(file_name):
    sr.use_file(file_name)
    if not sr.STEM.upper().startswith("US100"):
        raise SystemExit("Combine is defined for US100.")
    WALK_CACHE.clear()
    bars, clocks = sd.load(sr.CSV_FILE)
    _source, calendar = load_redfolder(sr.STEM)
    info = build_clock_index(bars, clocks, sr.INST["point"], calendar)
    write_news(sr.STEM, info, sr.INST["point"])
    eng = sr.Engine(bars, clocks, sr.data_sig())
    cfg = sr.ensure_open(sc.parse_id(RUNS["ny"]))
    print("loading New York session", flush=True)
    ev = eng.events(cfg["lvl"])
    ex = eng.resolve(sr.ENTRY_CODE[cfg["entry"]], cfg["sl"], cfg["tp"])
    plans = select_plans(eng, ev, ex, cfg, "ny", info)
    print(f"  ny {len(plans)} trades", flush=True)
    arrays = (eng.oc, eng.oh, eng.ol, eng.occ, eng.blo, eng.bhi, bars["ts"], info["into"])
    point = prop.point_cents(sr.STEM, 50)
    report = handling_study(bars, clocks, info, plans, arrays, point)
    return write_handling(sr.STEM, report)


def run_file(file_name, force=False, news_only=False):
    sr.use_file(file_name)
    if not sr.STEM.upper().startswith("US100"):
        raise SystemExit("Combine is defined for US100. The 50-point news bar and the 0.10 lot are Nasdaq.")
    WALK_CACHE.clear()
    bars, clocks = sd.load(sr.CSV_FILE)
    _source, calendar = load_redfolder(sr.STEM)
    info = build_clock_index(bars, clocks, sr.INST["point"], calendar)
    payload = write_news(sr.STEM, info, sr.INST["point"])
    print(f"news days {payload['count']}  {payload['first']} .. {payload['last']}", flush=True)
    print(f"wrote {paths_for(sr.STEM)['news_csv']}", flush=True)
    if news_only:
        return payload
    eng = sr.Engine(bars, clocks, sr.data_sig())
    print("loading the three session runs", flush=True)
    grouped = load_plans(eng, info)
    for key in SESSIONS:
        print(f"  {key} {len(grouped[key])} trades", flush=True)
    arrays = (
        eng.oc, eng.oh, eng.ol, eng.occ, eng.blo, eng.bhi, bars["ts"], info["into"],
    )
    # occ above is the close in price steps. into maps a UTC day to a bar index.
    point = prop.point_cents(sr.STEM, 50)
    paths = paths_for(sr.STEM)
    store = prop.load_store(paths["results"])
    store["version"] = VERSION
    store["news_days"] = payload["count"]
    store["configs"] = RUNS
    chosen = combos()
    write_progress(paths["progress"], 0, len(chosen), "", "starting", True)
    done = 0
    for keys in chosen:
        cid = combo_id(keys)
        done += 1
        if not force and cid in store["runs"] and "error" not in store["runs"][cid]:
            print(f"keep {cid}", flush=True)
            write_progress(paths["progress"], done, len(chosen), cid, "kept", True)
            continue
        print(f"run {cid}", flush=True)
        write_progress(paths["progress"], done - 1, len(chosen), cid, "running", True)
        try:
            result = analyse_combo(keys, grouped, point, arrays, sr.STEM)
            store["runs"][cid] = json_ready(result)
        except Exception:
            store["runs"][cid] = {
                "id": cid,
                "sessions": list(keys),
                "error": traceback.format_exc(),
                "analyzed": time.time(),
            }
            print(store["runs"][cid]["error"], flush=True)
        prop.atomic_json(paths["results"], store)
    write_progress(paths["progress"], len(chosen), len(chosen), "", "news handling", True)
    try:
        write_handling(sr.STEM, handling_study(bars, clocks, info, grouped["ny"], arrays, point))
    except Exception:
        traceback.print_exc()
    write_progress(paths["progress"], len(chosen), len(chosen), "", "done", False)
    print("combine done", flush=True)
    return store


def self_check():
    point = 200  # cents per index point at 0.10 lot
    floor = prop.day_floor(prop.START, 4)
    assert floor == 480_000, floor
    value = 1_800_000
    fresh = stop_bid(value, 1, 0.5, prop.START, 0, floor, point, 100)
    assert fresh == value - 20_000, fresh
    after_london = stop_bid(value, 1, 0.5, 490_000, 0, floor, point, 100)
    assert after_london == value - 10_000, after_london
    assert BLACK_LO == 8 * 60 + 28 and BLACK_HI == 8 * 60 + 32
    assert HALF_MIN == 8 * 60 + 27
    assert len(combos()) == 7
    assert combo_id(["london", "ny", "rth"]) == "london+ny+rth"
    # A 60-point 08:30 bar is news. A 40-point bar is not. Both minutes can qualify.
    high = np.array([100.0, 160.0, 100.0, 130.0], dtype=np.float64)
    low = np.array([90.0, 90.0, 90.0, 90.0], dtype=np.float64)
    ny_min = np.array([M830, M831, M830, M831], dtype=np.int16)
    ny_day = np.array([0, 0, 1, 1], dtype=np.int32)
    ts = np.array([0, 60, 86400, 86460], dtype=np.int64)
    bars = {"h": high, "l": low, "ts": ts}
    clocks = {"ny_min": ny_min, "ny_day": ny_day}
    info = build_clock_index(bars, clocks, 1.0)
    assert info["rows"][0]["trigger"] == "08:31", info["rows"]
    assert len(info["rows"]) == 1
    assert "08:30" not in info["rows"][0]["trigger"]
    print("combine self-check ok", floor, fresh - value, after_london - value)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--file", default=sc.DEFAULT_CSV.name)
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--news", action="store_true")
    parser.add_argument("--handling", action="store_true")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.check:
        self_check()
        return
    if args.handling:
        run_handling(args.file)
        return
    run_file(args.file, force=args.force, news_only=args.news)


if __name__ == "__main__":
    main()
