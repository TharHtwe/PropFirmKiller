"""Read the MetaTrader 5 minute file and build the session clocks.

The file is tab separated, the header is ``<DATE> <TIME> <OPEN> ...`` and the
timestamps are UTC.  The prices are bid prices.  Everything that follows works
on these raw bars without changing any OHLC value.

Clocks are derived with IANA time zones, so London and New York both follow
their own daylight saving rules.  Nothing is hard coded to a UTC offset.

The market day used by the level candles is the electronic session: it opens
at 18:00 New York and closes at 17:00 New York the next day.  A bar at or
after 18:00 belongs to the next trade date.  The price levels themselves are
built in ``levels.py``.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np
import pandas as pd

import config

BAR_KEYS = ("ts", "o", "h", "l", "c", "vol")


def _read_csv(path):
    frame = pd.read_csv(
        path,
        sep="\t",
        header=0,
        usecols=["<DATE>", "<TIME>", "<OPEN>", "<HIGH>", "<LOW>", "<CLOSE>", "<TICKVOL>"],
        dtype={"<DATE>": str, "<TIME>": str},
    )
    stamps = pd.to_datetime(
        frame["<DATE>"] + " " + frame["<TIME>"], format="%Y.%m.%d %H:%M:%S", utc=True
    )
    ts = stamps.to_numpy("datetime64[s]").astype(np.int64)
    o = frame["<OPEN>"].to_numpy(np.float64)
    h = frame["<HIGH>"].to_numpy(np.float64)
    l = frame["<LOW>"].to_numpy(np.float64)
    c = frame["<CLOSE>"].to_numpy(np.float64)
    vol = frame["<TICKVOL>"].to_numpy(np.int64)
    order = np.argsort(ts, kind="mergesort")
    ts, o, h, l, c, vol = ts[order], o[order], h[order], l[order], c[order], vol[order]
    keep = np.ones(len(ts), dtype=bool)
    keep[1:] = ts[1:] != ts[:-1]
    return ts[keep], o[keep], h[keep], l[keep], c[keep], vol[keep]


def _local(idx, zone):
    local = idx.tz_convert(zone)
    days = np.asarray(local.normalize().tz_localize(None)).astype("datetime64[D]").astype(np.int64)
    minute = (local.hour * 60 + local.minute).to_numpy(np.int16)
    return days.astype(np.int32), minute, local.weekday.to_numpy(np.int8)


def build_clocks(ts):
    idx = pd.to_datetime(ts, unit="s", utc=True)
    ny_day, ny_min, ny_wd = _local(idx, config.NEW_YORK[0])
    lon_day, lon_min, lon_wd = _local(idx, config.LONDON[0])
    eth_day = (ny_day + (ny_min >= config.ETH_OPEN_MIN)).astype(np.int32)
    week = week_start(eth_day)

    in_lon = (lon_min >= config.LONDON[1]) & (lon_min < config.LONDON[2]) & (lon_wd < 5)
    in_ny = (ny_min >= config.NEW_YORK[1]) & (ny_min < config.NEW_YORK[2]) & (ny_wd < 5)
    in_rth = (ny_min >= config.NY_RTH[1]) & (ny_min < config.NY_RTH[2]) & (ny_wd < 5)
    # The 17:00-18:00 New York hour sits between the close and the next open.
    in_break = (ny_min >= config.ETH_CLOSE_MIN) & (ny_min < config.ETH_OPEN_MIN)
    return {
        "ny_day": ny_day,
        "ny_min": ny_min,
        "ny_wd": ny_wd,
        "lon_day": lon_day,
        "lon_min": lon_min,
        "lon_wd": lon_wd,
        "eth_day": eth_day,
        "week": week,
        "in_lon": in_lon,
        "in_ny": in_ny,
        "in_rth": in_rth,
        "in_all": in_lon | in_ny,
        "in_break": in_break,
    }


def week_start(days):
    """Sunday that starts the week of each local day number."""
    days = np.asarray(days, dtype=np.int64)
    weekday = (days + 3) % 7  # 1970-01-01 was a Thursday, Monday is 0
    return (days - ((weekday + 1) % 7)).astype(np.int32)


def _cache_path(path):
    digest = hashlib.md5(str(path.resolve()).encode("utf-8")).hexdigest()[:8]
    return config.CACHE_DIR / f"bars_{digest}.npz"


def _stamp(path):
    stat = path.stat()
    return {"path": str(path.resolve()), "size": stat.st_size, "mtime": int(stat.st_mtime),
            "version": config.CACHE_VERSION}


def load(path=None):
    """Return bars and clocks, using the NPZ cache when the file is unchanged."""
    path = Path(path) if path is not None else config.DEFAULT_CSV
    if not path.exists():
        raise FileNotFoundError(f"missing minute file: {path}")
    config.ensure_dirs()
    cache = _cache_path(path)
    meta_path = cache.with_suffix(".json")
    stamp = _stamp(path)
    if cache.exists() and meta_path.exists():
        try:
            meta = json.loads(meta_path.read_text())
        except (OSError, ValueError):
            meta = None
        if meta == stamp:
            try:
                with np.load(cache) as data:
                    bars = {key: data[key] for key in BAR_KEYS}
                    clocks = {key: data[key] for key in data.files if key not in BAR_KEYS}
            except (OSError, ValueError, KeyError):
                bars = None
            if bars is not None:
                bars["path"] = path
                return bars, clocks

    ts, o, h, l, c, vol = _read_csv(path)
    bars = {"ts": ts, "o": o, "h": h, "l": l, "c": c, "vol": vol, "path": path}
    clocks = build_clocks(ts)
    # The Path in bars is not saved: object arrays cannot be read back safely.
    np.savez(cache, **{key: bars[key] for key in BAR_KEYS}, **clocks)
    meta_path.write_text(json.dumps(stamp))
    return bars, clocks


def day_label(day):
    return str(np.datetime64(int(day), "D"))


def ts_label(ts):
    return str(np.datetime64(int(ts), "s"))
