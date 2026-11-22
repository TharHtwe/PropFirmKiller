"""Configuration for the Nasdaq level-retrace v2 backtest.

Every run is one point of an eight-factor grid.  The ids are stable strings so
the report, the favourites file and the chart app can all refer to a run by id.
"""
from __future__ import annotations

from datetime import date
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
PROJECT_DIR = BASE_DIR.parents[1]
DATA_DIR = PROJECT_DIR / "data"
RESULTS_DIR = BASE_DIR / "results"
CACHE_DIR = RESULTS_DIR / "cache"
SITE_DIR = BASE_DIR / "site"

DEFAULT_CSV = DATA_DIR / "US100_M1_202001020105_202610291406.csv"

# Instruments, keyed by the CSV stem prefix (the part before the first "_").
# POINT is the price value of one "point": 1.0 on US100, 0.0001 (one pip) on
# GBPUSD.  A 50 point target therefore means 1.50000 -> 1.50050 on GBPUSD.
# DECIMALS is how many fraction digits prices are shown with.
# rth_skip_open says the stored New York RTH runs for this instrument skipped
# the 09:30 bar. That choice is now a run option (skip or keep). On an
# instrument where this is true, each RTH run also has an "include 09:30"
# twin. London, New York and All never skipped that bar, so they stay one run.
# ny_skip_open adds a second New York-only run that drops 08:30 and 08:31.
# The original New York id still includes those two minutes.
INSTRUMENTS = {
    "US100": {"name": "US100 (Nasdaq)", "point": 1.0, "decimals": 2, "mark": "NQ",
              "rth_skip_open": True, "ny_skip_open": True},
    "GBPUSD": {"name": "GBPUSD", "point": 0.0001, "decimals": 5, "mark": "GP",
               "rth_skip_open": False, "ny_skip_open": False},
    # 1 gold point is 0.10, so a 50 point target is 1900.00 -> 1905.00.
    "XAUUSD": {"name": "XAUUSD (Gold)", "point": 0.1, "decimals": 2, "mark": "AU",
               "rth_skip_open": False, "ny_skip_open": False},
}
DEFAULT_INSTRUMENT = {"name": "US100 (Nasdaq)", "point": 1.0, "decimals": 2}


def instrument_for(stem):
    """Instrument spec for one CSV stem, e.g. "GBPUSD_M1_202001020600_202610300618"."""
    prefix = stem.upper().split("_")[0]
    spec = INSTRUMENTS.get(prefix)
    if spec is None:
        return {"symbol": prefix, "name": prefix, "point": 1.0, "decimals": 2,
                "mark": prefix[:2], "rth_skip_open": False, "ny_skip_open": False}
    return {"symbol": prefix, **spec}


def results_dir(stem):
    """Where summary/progress/favourites/audit/trades of one CSV file live."""
    return RESULTS_DIR / stem


def audit_dir(stem):
    return results_dir(stem) / "audit"


def trades_dir(stem):
    return results_dir(stem) / "trades"

# The CSV holds bid prices.  A buy pays the ask, the ask is bid + SPREAD points.
SPREAD = 1.3

STOPS = (50, 100)
TARGETS = (50, 100, 150, 200)
TRADE_SESSIONS = ("london", "ny", "rth", "all")
LEVEL_SESSIONS = ("all", "eth", "rth")
TYPES = ("rev", "cont")
ENTRIES = ("touch", "confirm")
LOOKBACKS = (("1m", 30), ("6m", 182), ("1y", 365), ("all", None))
TPD = ("every", "serial", "one", "until")

AUDIT_DAY = date(2026, 10, 29)

# Bump when the engine logic changes so cached bars/events are rebuilt.
CACHE_VERSION = 4

# Bump when a run *rule* changes.  Rules live in the per-run filter, not in the
# cached events, so this does not rebuild the events: it only marks the stored
# results of the affected runs stale.  2 = the unsuffixed New York RTH id on an
# instrument with rth_skip_open skips the 09:30 bar.  Including that bar is a
# separate id ending in _keep, so it does not invalidate the stored runs.
RULES_VERSION = 2

FACTORS = [
    ("sl", "Stop", [(sl, f"{sl} points") for sl in STOPS]),
    ("tp", "Target", [(tp, f"{tp} points") for tp in TARGETS]),
    ("session", "Trading session", [
        ("london", "London only"),
        ("ny", "New York only"),
        ("rth", "New York RTH only"),
        ("all", "London to New York"),
    ]),
    ("open", "Cash open", [
        ("skip", "Skip 09:30"),
        ("keep", "Include 09:30"),
    ]),
    ("nyopen", "NY open", [
        ("skip", "Skip 08:30-08:32"),
        ("keep", "Include 08:30-08:32"),
    ]),
    ("lvl", "Level session", [
        ("all", "All hours"),
        ("eth", "ETH session"),
        ("rth", "RTH session"),
    ]),
    ("typ", "Trade type", [
        ("rev", "Reversal"),
        ("cont", "Continuation"),
    ]),
    ("entry", "Entry", [
        ("touch", "Touch"),
        ("confirm", "1-minute close"),
    ]),
    ("look", "Level lookback", [
        ("1m", "1 month"),
        ("6m", "6 months"),
        ("1y", "1 year"),
        ("all", "All history"),
    ]),
    ("tpd", "Trades per day", [
        ("every", "Every level"),
        ("serial", "One at a time"),
        ("one", "One a day"),
        ("until", "Until target"),
    ]),
]

LABELS = {
    "session": {"london": "London", "ny": "New York", "rth": "New York RTH", "all": "London to New York"},
    "open": {"skip": "Skip 09:30", "keep": "Include 09:30"},
    "nyopen": {"skip": "Skip 08:30-08:32", "keep": "Include 08:30-08:32"},
    "lvl": {"all": "All hours", "eth": "ETH", "rth": "RTH"},
    "typ": {"rev": "Reversal", "cont": "Continuation"},
    "entry": {"touch": "Touch", "confirm": "1-minute close"},
    "look": {"1m": "1 month", "6m": "6 months", "1y": "1 year", "all": "All history"},
    "tpd": {"every": "Every level", "serial": "One at a time", "one": "One a day", "until": "Until target"},
}

LOOK_DAYS = dict(LOOKBACKS)

# Trade sessions in local time.  Start is inclusive, end exclusive.
LONDON = ("Europe/London", 8 * 60, 16 * 60 + 30)
NEW_YORK = ("America/New_York", 8 * 60, 17 * 60)
NY_RTH = ("America/New_York", 9 * 60 + 30, 16 * 60)
# Two New York minutes, 08:30 and 08:31. The end is exclusive, so 08:32 is kept.
# The clock is America/New_York, so the window follows EST and EDT.
NY_OPEN = (8 * 60 + 30, 8 * 60 + 32)

# Market day used by the level candles.  The electronic session opens at 18:00
# New York and closes at 17:00 New York the next day, so a bar from 18:00
# onward belongs to the next trade date.
ETH_OPEN_MIN = 18 * 60
ETH_CLOSE_MIN = 17 * 60


def config_id(sl, tp, session, lvl, typ, entry, look, tpd):
    return f"sl{int(sl)}_tp{int(tp)}_{session}_lv{lvl}_{typ}_{entry}_{look}_{tpd}"


def parse_id(run_id):
    parts = run_id.split("_")
    open_mode = None
    if len(parts) == 9 and parts[-1] in ("skip", "keep"):
        open_mode = parts.pop()
    if len(parts) != 8 or not parts[0].startswith("sl") or not parts[1].startswith("tp"):
        raise ValueError(f"bad run id: {run_id}")
    cfg = {
        "sl": int(parts[0][2:]),
        "tp": int(parts[1][2:]),
        "session": parts[2],
        "lvl": parts[3][2:] if parts[3].startswith("lv") else parts[3],
        "typ": parts[4],
        "entry": parts[5],
        "look": parts[6],
        "tpd": parts[7],
    }
    if open_mode == "skip" and cfg["session"] == "ny":
        cfg["nyopen"] = "skip"
    elif open_mode:
        cfg["open"] = open_mode
    return cfg


def iter_configs(skip_open=False, ny_skip=False):
    """One config per stored combination.

    ``skip_open`` lists each New York RTH run twice: the historical id skips
    09:30, and the same id plus ``_keep`` includes it. ``ny_skip`` lists each
    New York-only run twice: the historical id includes 08:30 and 08:31, and
    the same id plus ``_skip`` drops those two minutes. London and All stay
    one id.
    """
    for sl in STOPS:
        for tp in TARGETS:
            for session in TRADE_SESSIONS:
                for lvl in LEVEL_SESSIONS:
                    for typ in TYPES:
                        for entry in ENTRIES:
                            for look, _days in LOOKBACKS:
                                for tpd in TPD:
                                    modes = ("skip", "keep") if session == "rth" and skip_open else ("keep",)
                                    ny_modes = ("keep", "skip") if session == "ny" and ny_skip else ("keep",)
                                    for mode in modes:
                                        for ny_mode in ny_modes:
                                            cfg = {
                                                "sl": sl, "tp": tp, "session": session, "lvl": lvl,
                                                "typ": typ, "entry": entry, "look": look, "tpd": tpd,
                                                "open": mode, "nyopen": ny_mode,
                                            }
                                            cfg["id"] = config_id(sl, tp, session, lvl, typ, entry, look, tpd)
                                            if session == "rth" and skip_open and mode == "keep":
                                                cfg["id"] += "_keep"
                                            if session == "ny" and ny_skip and ny_mode == "skip":
                                                cfg["id"] += "_skip"
                                            yield cfg


def all_ids(skip_open=False, ny_skip=False):
    return [cfg["id"] for cfg in iter_configs(skip_open, ny_skip)]


def combo_count(skip_open=False, ny_skip=False):
    base = (len(STOPS) * len(TARGETS) * len(TRADE_SESSIONS) * len(LEVEL_SESSIONS)
            * len(TYPES) * len(ENTRIES) * len(LOOKBACKS) * len(TPD))
    extra = 0
    if skip_open:
        extra += base // len(TRADE_SESSIONS)
    if ny_skip:
        extra += base // len(TRADE_SESSIONS)
    return base + extra


def ensure_dirs(stem=None):
    dirs = [RESULTS_DIR, CACHE_DIR, SITE_DIR]
    if stem:
        dirs += [results_dir(stem), audit_dir(stem), trades_dir(stem)]
    for path in dirs:
        path.mkdir(parents=True, exist_ok=True)
