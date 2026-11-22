"""Broker specs and the Risk Factor scoring table.

Everything here comes from ``analysis/Riskfactor.xlsx`` and the account
screenshots embedded in it:

* ``Symbols`` sheet and the order screenshots give the margin, commission and
  point value of one lot.
* ``Risk Factor`` sheet F17:F25 and A40:A46 give the weights and the four
  scoring bands.

The workbook refreshes the account risk factor hourly; this analysis samples
the same quantities at every one-minute bar close, as asked.
"""
from __future__ import annotations

# One "strategy point" is the unit the level-retrace engine trades:
# 1.0 index point on US100, 0.1 price on gold, 0.0001 (one pip) on GBPUSD.
#
# usd_per_point   P/L of one strategy point, one lot, in account currency.
# margin_rate     margin of one lot per 1.0 of price (multiply by the price).
# commission      round-turn commission of one lot, charged once at entry.
# min_lot/step    the broker's volume step; max_lot is the broker cap.
SPECS = {
    "US100": {
        "symbol": "US100", "mark": "NQ", "decimals": 2,
        "usd_per_point": 1.0, "margin_rate": 0.01, "commission": 3.5,
        "min_lot": 0.1, "step": 0.1, "max_lot": 100.0,
        "leverage_note": "1:100, 1% margin",
    },
    "GBPUSD": {
        "symbol": "GBPUSD", "mark": "GP", "decimals": 5,
        "usd_per_point": 10.0, "margin_rate": 250.0, "commission": 5.0,
        "min_lot": 0.01, "step": 0.01, "max_lot": 100.0,
        "leverage_note": "margin at account leverage 1:400",
    },
    "XAUUSD": {
        "symbol": "XAUUSD", "mark": "AU", "decimals": 2,
        "usd_per_point": 10.0, "margin_rate": 0.2, "commission": 5.0,
        "min_lot": 0.01, "step": 0.01, "max_lot": 100.0,
        "leverage_note": "1:500, 0.2% margin",
    },
}

# The workbook's standing parameters: 5,000 starting balance, 400 leverage,
# an account lifespan of 0 days.
RISK = {
    "start_balance": 5000.0,
    "leverage": 400,
    "lifespan_days": 0,
    "pass_rounds_to": 5,
    "fail_at": 5.5,
    "weights": {"drawdown": 0.5, "utilization": 0.3, "leverage": 0.1, "lifespan": 0.1},
}

# (lower bound inclusive, points) — the highest matching row wins.
DRAWDOWN_BANDS = [
    (50.0, 10), (40.0, 9), (35.0, 8), (30.0, 7), (25.0, 6),
    (20.0, 5), (15.0, 4), (10.0, 3), (5.0, 2), (0.0, 1),
]
UTILIZATION_BANDS = list(DRAWDOWN_BANDS)

LEVERAGE_BANDS = [
    (400, 10), (300, 9), (200, 8), (150, 7), (100, 6),
    (75, 5), (50, 4), (25, 3), (10, 2), (1, 1),
]

# Account lifespan is 0 days in every run, so only the first row is used.  The
# rest is transcribed as written; the sheet's 180-299 / 200-299 rows overlap.
LIFESPAN_BANDS = [
    (0, 10), (180, 9), (200, 8), (300, 7), (360, 6),
    (450, 5), (510, 4), (600, 3), (690, 2), (780, 1),
]


def _points(value, bands):
    for lower, points in bands:
        if value >= lower:
            return points
    return 1


def drawdown_points(pct):
    return _points(pct, DRAWDOWN_BANDS)


def utilization_points(pct):
    return _points(pct, UTILIZATION_BANDS)


def leverage_points(leverage):
    return _points(leverage, LEVERAGE_BANDS)


def lifespan_points(days):
    return _points(days, LIFESPAN_BANDS)


def risk_factor(dd_pct, util_pct, leverage=None, lifespan=None):
    """The weighted score, before rounding."""
    lev = RISK["leverage"] if leverage is None else leverage
    life = RISK["lifespan_days"] if lifespan is None else lifespan
    w = RISK["weights"]
    return (w["drawdown"] * drawdown_points(dd_pct)
            + w["utilization"] * utilization_points(util_pct)
            + w["leverage"] * leverage_points(lev)
            + w["lifespan"] * lifespan_points(life))


def passes(rf):
    """5.4 rounds to 5 (pass); 5.5 rounds to 6 (fail)."""
    return rf < RISK["fail_at"] - 1e-9


def spec_for(stem):
    prefix = str(stem).upper().split("_")[0]
    return SPECS.get(prefix)


def lot_levels(spec, cap):
    """Every volume the analysis may try, from the minimum to ``cap``."""
    step = spec["step"]
    first = spec["min_lot"]
    top = min(float(cap), spec["max_lot"])
    count = int(round((top - first) / step)) + 1
    return [round(first + i * step, 4) for i in range(max(0, count))]
