"""Download US100 bid minute bars for October 2026 from Dukascopy's candle API."""

import json
import urllib.request
from datetime import date, timedelta
from pathlib import Path

OUT = Path(__file__).with_name("usatechidxusd-m1-bid-2026-10.csv")
START = date(2026, 10, 1)
END = date(2026, 10, 27)
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"


def fetch(day: date):
    url = (
        "https://jetta.dukascopy.com/v1/candles/minute/USATECH.IDX-USD/BID/"
        f"{day.year}/{day.month:02d}/{day.day:02d}"
    )
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": UA,
            "Accept": "application/json",
            "Referer": "https://www.dukascopy.com/",
            "Origin": "https://www.dukascopy.com",
        },
    )
    with urllib.request.urlopen(req, timeout=40) as response:
        return json.loads(response.read())


def bars(payload):
    t = payload["timestamp"]
    o = payload["open"]
    h = payload["high"]
    l = payload["low"]
    c = payload["close"]
    mult = payload["multiplier"]
    shift = payload["shift"]
    rows = []
    for i, step in enumerate(payload["times"]):
        t += step * shift
        o += payload["opens"][i] * mult
        h += payload["highs"][i] * mult
        l += payload["lows"][i] * mult
        c += payload["closes"][i] * mult
        vol = payload["volumes"][i]
        rows.append(f"{t},{o:.5f},{h:.5f},{l:.5f},{c:.5f},{vol}")
    return rows


def main():
    lines = ["timestamp,open,high,low,close,volume"]
    day = START
    while day <= END:
        try:
            payload = fetch(day)
        except Exception as exc:
            print(f"{day} skip {exc}", flush=True)
            day += timedelta(days=1)
            continue
        got = bars(payload)
        lines.extend(got)
        print(f"{day} {len(got)}", flush=True)
        day += timedelta(days=1)
    OUT.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("wrote", OUT, "rows", len(lines) - 1, flush=True)


if __name__ == "__main__":
    main()
