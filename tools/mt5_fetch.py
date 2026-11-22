#!/usr/bin/env python3
"""Fetch bars from a running MetaTrader 5 terminal and print them as JSON.

Output (one JSON object on stdout):
  {"ok": true, "symbol": "US100", "timeframe": "M1", "offsetSeconds": 0, "rates": [...]}
  {"ok": false, "error": "..."}

The CSV chart stores UTC timestamps. MT5 returns the terminal's server time,
which is often GMT+2/+3; when the newest bar is clearly ahead of UTC the whole
window is shifted back by the detected whole-hour offset.
"""

import argparse
import json
import sys
import time
from datetime import datetime, timezone


def fail(message):
    print(json.dumps({"ok": False, "error": str(message)}))
    sys.exit(1)


def parse_iso(text):
    value = text.strip()
    if value.endswith("Z"):
        value = value[:-1] + "+00:00"
    moment = datetime.fromisoformat(value)
    if moment.tzinfo is not None:
        moment = moment.astimezone(timezone.utc).replace(tzinfo=None)
    return moment


def resolve_symbol(mt5, hint):
    symbols = mt5.symbols_get()
    names = [item.name for item in symbols] if symbols else []
    lowered = hint.lower()
    for name in names:
        if name.lower() == lowered:
            return name
    prefixed = [name for name in names if name.lower().startswith(lowered)]
    if prefixed:
        prefixed.sort(key=len)
        return prefixed[0]
    return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--symbol", required=True)
    parser.add_argument("--timeframe", default="M1")
    parser.add_argument("--from", dest="start", required=True)
    parser.add_argument("--to", dest="end", required=True)
    parser.add_argument("--terminal", default="")
    args = parser.parse_args()

    try:
        import MetaTrader5 as mt5
    except Exception as exc:
        fail("Python package MetaTrader5 is not installed (%s). Run: pip install MetaTrader5" % exc)

    init_args = {"path": args.terminal} if args.terminal else {}
    if not mt5.initialize(**init_args):
        fail("MetaTrader5 initialize() failed %s. Start the MT5 terminal and log in." % (mt5.last_error(),))

    try:
        symbol = resolve_symbol(mt5, args.symbol)
        if not symbol:
            names = [item.name for item in (mt5.symbols_get() or [])
                     if any(key in item.name.upper() for key in ("US100", "USTEC", "NAS100", "NDX"))]
            fail("Symbol %s not found. Index symbols in this terminal: %s. Set MT5_SYMBOL to override."
                 % (args.symbol, ", ".join(names[:20]) or "none"))
        if not mt5.symbol_select(symbol, True):
            fail("symbol_select(%s) failed: %s" % (symbol, mt5.last_error()))

        timeframes = {
            "M1": mt5.TIMEFRAME_M1,
            "M5": mt5.TIMEFRAME_M5,
            "M15": mt5.TIMEFRAME_M15,
            "M30": mt5.TIMEFRAME_M30,
            "H1": mt5.TIMEFRAME_H1,
            "H4": mt5.TIMEFRAME_H4,
            "D1": mt5.TIMEFRAME_D1,
            "W1": mt5.TIMEFRAME_W1,
            "MN1": mt5.TIMEFRAME_MN1,
        }
        timeframe = timeframes.get(args.timeframe.upper())
        if timeframe is None:
            fail("Unsupported timeframe: %s" % args.timeframe)

        rates = mt5.copy_rates_range(symbol, timeframe, parse_iso(args.start), parse_iso(args.end))
        if rates is None:
            fail("copy_rates_range failed: %s" % (mt5.last_error(),))

        names = rates.dtype.names or ()
        offset = 0
        if len(rates) and timeframe < mt5.TIMEFRAME_D1:
            newest = int(max(int(item["time"]) for item in rates))
            ahead = newest - int(time.time())
            if ahead > 1800:
                offset = int(round(ahead / 900.0)) * 900

        rows = []
        for item in rates:
            rows.append({
                "t": int(item["time"]) - offset,
                "o": float(item["open"]),
                "h": float(item["high"]),
                "l": float(item["low"]),
                "c": float(item["close"]),
                "tick_volume": int(item["tick_volume"]) if "tick_volume" in names else 0,
                "real_volume": int(item["real_volume"]) if "real_volume" in names else 0,
                "spread": int(item["spread"]) if "spread" in names else 0,
            })

        print(json.dumps({
            "ok": True,
            "symbol": symbol,
            "timeframe": args.timeframe.upper(),
            "offsetSeconds": offset,
            "rates": rows,
        }))
    finally:
        mt5.shutdown()


if __name__ == "__main__":
    main()
