"""Trades taken by sl50_all_every_one_month, and a filterable report.

One trade per New York day. The first level crossed during London or New York.
Stop 50, target 50, levels from the prior 30 days.

Run: python best_run_trades.py
"""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path

import numpy as np

import backtest as b

OUT = Path(__file__).resolve().parent / "results" / "best_run.html"
WEEKDAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")


def week_of_month(day):
    if day <= 7:
        return 1
    if day <= 14:
        return 2
    if day <= 21:
        return 3
    if day <= 28:
        return 4
    return 5


def collect():
    ts, o, h, l, c = b.load()
    clock = b.clocks(ts)
    records = b.build_levels(ts, o, c, clock)
    for i, row in enumerate(records):
        row["cents_id"] = i
    expire_i = np.array([b.expire_index(ts, row["close_ts"], 30) for row in records], dtype=np.int32)
    block_low, block_high = b.prepare_blocks(h, l, c)
    tradable = clock["in_ny"] | clock["in_lon"]
    slices = b.day_slices(clock["ny_ymd"], tradable)
    cursor = 0
    trades = []
    for ymd, day_start, bars in slices:
        while cursor < len(records) and records[cursor]["ready_i"] <= day_start:
            cursor += 1
        prices, cents, labels, _kinds = b.active_book(records[:cursor], day_start, expire_i)
        if len(prices) == 0:
            continue
        for bar in bars:
            prev = None if bar == 0 else c[bar - 1]
            points = b.bar_points(prev, o[bar], h[bar], l[bar], c[bar])
            if len(points) < 2:
                continue
            found = b.crosses(points, prices, cents)
            if not found:
                continue
            seg, a, bend, price, cent, side = found[0]
            fill = bend if (seg == 0 and prev is not None and prev != o[bar] and price != bend) else price
            done = b.resolve(side, fill, 50.0, int(bar), seg, points, o, h, l, c, block_low, block_high)
            y, m, d = ymd // 10000, (ymd // 100) % 100, ymd % 100
            when = date(y, m, d)
            trades.append(
                {
                    "date": when.isoformat(),
                    "time": b.iso(int(ts[bar])),
                    "exitTime": b.iso(int(ts[done["bar"]])),
                    "weekday": WEEKDAYS[when.weekday()],
                    "week": week_of_month(d),
                    "month": f"{y:04d}-{m:02d}",
                    "london": bool(clock["in_lon"][bar]),
                    "newYork": bool(clock["in_ny"][bar]),
                    "rth": bool(clock["in_rth"][bar]),
                    "side": "buy" if side == 1 else "sell",
                    "level": round(price, 2),
                    "sources": labels.get(cent, []),
                    "fill": round(float(fill), 2),
                    "stop": round(float(fill) - 50.0 * side, 2),
                    "target": round(float(fill) + 50.0 * side, 2),
                    "exit": round(float(done["exit"]), 2),
                    "result": done["kind"],
                    "points": round(float(done["pnl"]), 2),
                }
            )
            break
    return trades


def html(trades):
    payload = json.dumps(trades).replace("<", "\\u003c")
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Best run trades</title>
<style>
  body {{ margin: 0; font: 15px/1.45 Georgia, "Times New Roman", serif; background: #f4f1ea; color: #1c1a17; }}
  main {{ max-width: 1180px; margin: 0 auto; padding: 28px 20px 80px; }}
  h1 {{ font-size: 28px; margin: 0 0 8px; }}
  h2 {{ font-size: 20px; margin: 28px 0 8px; }}
  p {{ max-width: 78ch; }}
  .note, form {{ background: #fff6e8; border: 1px solid #e6d3b0; padding: 12px 14px; }}
  form {{ display: flex; flex-wrap: wrap; gap: 14px; align-items: end; margin-top: 14px; }}
  label {{ display: flex; flex-direction: column; gap: 4px; font-size: 13px; }}
  input, select, button {{ font: 14px Consolas, monospace; padding: 6px 8px; }}
  button {{ background: #1c1a17; color: white; border: 0; cursor: pointer; }}
  .grid {{ display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin: 14px 0; }}
  .card {{ background: white; border: 1px solid #ddd6c8; padding: 12px; }}
  .card b {{ display: block; font-size: 22px; }}
  table {{ width: 100%; border-collapse: collapse; background: white; font: 13px/1.35 Consolas, monospace; margin: 8px 0 18px; }}
  th, td {{ border-bottom: 1px solid #e4dccb; text-align: right; padding: 6px 8px; white-space: nowrap; }}
  th:first-child, td:first-child, .left {{ text-align: left; }}
  .pos {{ color: #1b7f3a; }} .neg {{ color: #8a2b2b; }}
  #trades {{ font-size: 12px; }}
  @media (max-width: 800px) {{ .grid {{ grid-template-columns: 1fr 1fr; }} }}
</style>
</head>
<body>
<main>
  <h1>Best run, trades taken</h1>
  <div class="note">
    <p><b>sl50_all_every_one_month.</b> One trade on a New York date. The first level crossed while London or New York is open. Stop 50 points, target 50, levels from the previous 30 days. Skipped touches are not listed.</p>
    <p>Times are UTC, so they match a TradingView chart set to UTC. The date, weekday, week, and month use the New York calendar date of that entry. London is 08:00–16:30 London time. New York is 08:00–17:00 New York time. RTH is 09:30–16:00 New York time. On 23 October 2026 those are 07:00–15:30 UTC, 12:00–21:00 UTC, and 13:30–20:00 UTC. A trade can sit in more than one of those windows. Choosing a session keeps the trades whose entry bar was inside it. All keeps every taken trade.</p>
    <p>The 1st week is days 1–7 of the month, then 8–14, 15–21, and 22–28. Days 29–31 are listed on their own so they are not folded into the 4th week. Weeks are pooled across months. January is every January in the sample, pooled the same way, and the same for the other months.</p>
  </div>
  <form id="filters">
    <label>From <input id="from" type="date"></label>
    <label>To <input id="to" type="date"></label>
    <label>Session
      <select id="session">
        <option value="all">All</option>
        <option value="london">London</option>
        <option value="newYork">New York</option>
        <option value="rth">New York RTH</option>
      </select>
    </label>
  </form>
  <div class="grid" id="summary"></div>
  <h2>Weekday</h2>
  <table id="weekday"></table>
  <h2>Week of the month</h2>
  <table id="week"></table>
  <h2>Month of the year</h2>
  <table id="month"></table>
  <h2>Random sets of 100 trades</h2>
  <p>Each click draws 10 stretches of 100 trades in a row from the filtered list. Trades 5–104 are one stretch. The point is to see whether a block of 100 trades looks like the full run.</p>
  <button type="button" id="sample">Draw 10 sets</button>
  <table id="samples"></table>
  <h2>Trades</h2>
  <p id="count"></p>
  <table id="trades"></table>
</main>
<script>
const TRADES = {payload};
const HEAD = ["Group", "Trades", "Wins", "Losses", "Win %", "Net", "Expectancy", "Profit factor", "PF without best", "Max DD", "Payoff"];
const fromInput = document.getElementById("from");
const toInput = document.getElementById("to");
fromInput.value = TRADES[0].date;
toInput.value = TRADES[TRADES.length - 1].date;

function num(v, digits) {{
  if (v === null || v === undefined || Number.isNaN(v)) return "-";
  return Number(v).toFixed(digits);
}}
function cls(v) {{ return v > 0 ? "pos" : v < 0 ? "neg" : ""; }}

function stats(rows) {{
  if (!rows.length) return null;
  const points = rows.map((r) => r.points);
  const wins = points.filter((v) => v > 0);
  const losses = points.filter((v) => v <= 0);
  const gain = wins.reduce((s, v) => s + v, 0);
  const loss = Math.abs(losses.reduce((s, v) => s + v, 0));
  let peak = 0, equity = 0, maxDd = 0;
  points.forEach((v) => {{
    equity += v;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
  }});
  const best = Math.max(...points);
  const rest = points.slice();
  rest.splice(rest.indexOf(best), 1);
  const restGain = rest.filter((v) => v > 0).reduce((s, v) => s + v, 0);
  const restLoss = Math.abs(rest.filter((v) => v <= 0).reduce((s, v) => s + v, 0));
  const avgWin = wins.length ? gain / wins.length : null;
  const avgLoss = losses.length ? losses.reduce((s, v) => s + v, 0) / losses.length : null;
  return {{
    trades: rows.length,
    wins: wins.length,
    losses: losses.length,
    winRate: 100 * wins.length / rows.length,
    net: points.reduce((s, v) => s + v, 0),
    expectancy: points.reduce((s, v) => s + v, 0) / rows.length,
    pf: loss === 0 ? null : gain / loss,
    pfEx: restLoss === 0 ? null : restGain / restLoss,
    maxDd,
    payoff: avgWin === null || !avgLoss ? null : avgWin / Math.abs(avgLoss),
  }};
}}

function cells(label, s) {{
  if (!s) return `<tr><td class="left">${{label}}</td><td colspan="10">no trades</td></tr>`;
  return `<tr><td class="left">${{label}}</td><td>${{s.trades}}</td><td>${{s.wins}}</td><td>${{s.losses}}</td><td>${{num(s.winRate, 1)}}</td><td class="${{cls(s.net)}}">${{num(s.net, 1)}}</td><td class="${{cls(s.expectancy)}}">${{num(s.expectancy, 2)}}</td><td>${{num(s.pf, 3)}}</td><td>${{num(s.pfEx, 3)}}</td><td>${{num(s.maxDd, 1)}}</td><td>${{num(s.payoff, 3)}}</td></tr>`;
}}

function table(id, pairs) {{
  document.getElementById(id).innerHTML = `<tr>${{HEAD.map((h, i) => `<th class="${{i ? "" : "left"}}">${{h}}</th>`).join("")}}</tr>`
    + pairs.map(([label, rows]) => cells(label, stats(rows))).join("");
}}

function selected() {{
  const session = document.getElementById("session").value;
  const from = fromInput.value;
  const to = toInput.value;
  return TRADES.filter((t) => t.date >= from && t.date <= to && (session === "all" || t[session]));
}}

function draw() {{
  const rows = selected();
  const s = stats(rows);
  document.getElementById("summary").innerHTML = s ? `
    <div class="card"><b>${{s.trades}}</b>trades</div>
    <div class="card"><b class="${{cls(s.net)}}">${{num(s.net, 1)}}</b>net points</div>
    <div class="card"><b>${{num(s.winRate, 1)}}%</b>win rate</div>
    <div class="card"><b>${{num(s.pf, 3)}}</b>profit factor</div>` : `<div class="card"><b>0</b>trades</div>`;
  const by = (key) => {{
    const map = new Map();
    rows.forEach((t) => {{
      if (!map.has(t[key])) map.set(t[key], []);
      map.get(t[key]).push(t);
    }});
    return map;
  }};
  const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const dayMap = by("weekday");
  table("weekday", days.filter((d) => dayMap.has(d)).map((d) => [d, dayMap.get(d)]));
  const weekName = {{1: "1st week, days 1–7", 2: "2nd week, days 8–14", 3: "3rd week, days 15–21", 4: "4th week, days 22–28", 5: "Days 29–31"}};
  const weekMap = by("week");
  table("week", [1, 2, 3, 4, 5].filter((w) => weekMap.has(w)).map((w) => [weekName[w], weekMap.get(w)]));
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  table("month", months.map((name, i) => [name, rows.filter((t) => Number(t.month.slice(5)) === i + 1)]).filter((pair) => pair[1].length));
  document.getElementById("samples").innerHTML = "";
  document.getElementById("count").textContent = rows.length + " trades.";
  document.getElementById("trades").innerHTML = `<tr><th class="left">NY date</th><th class="left">Entry UTC</th><th class="left">Weekday</th><th>Week</th><th class="left">Sessions</th><th class="left">Side</th><th>Level</th><th>Fill</th><th>Exit UTC</th><th class="left">Result</th><th>Points</th><th class="left">Level source</th></tr>`
    + rows.map((t) => {{
      const sessions = [t.london ? "London" : "", t.newYork ? "New York" : "", t.rth ? "RTH" : ""].filter(Boolean).join(", ");
      return `<tr><td class="left">${{t.date}}</td><td class="left">${{t.time.slice(11)}}</td><td class="left">${{t.weekday}}</td><td>${{t.week}}</td><td class="left">${{sessions}}</td><td class="left">${{t.side}}</td><td>${{t.level}}</td><td>${{t.fill}}</td><td class="left">${{t.exitTime.slice(11)}}</td><td class="left">${{t.result}}</td><td class="${{cls(t.points)}}">${{t.points}}</td><td class="left">${{t.sources.join("; ")}}</td></tr>`;
    }}).join("");
}}

function drawSamples() {{
  const rows = selected();
  const width = 100;
  const host = document.getElementById("samples");
  if (rows.length < width) {{
    host.innerHTML = `<tr><td class="left">This filter has ${{rows.length}} trades. A set needs 100.</td></tr>`;
    return;
  }}
  const starts = [];
  while (starts.length < 10) {{
    const start = Math.floor(Math.random() * (rows.length - width + 1));
    if (!starts.includes(start)) starts.push(start);
  }}
  starts.sort((a, b) => a - b);
  table("samples", starts.map((start) => [
    `Trades ${{start + 1}}–${{start + width}}`,
    rows.slice(start, start + width),
  ]));
}}

document.getElementById("filters").addEventListener("input", draw);
document.getElementById("sample").addEventListener("click", drawSamples);
draw();
</script>
</body>
</html>
"""


def main():
    trades = collect()
    net = round(sum(t["points"] for t in trades), 1)
    print(f"{len(trades)} trades, net {net}")
    if trades:
        print(trades[0]["date"], trades[0]["time"], trades[-1]["date"], trades[-1]["time"])
    OUT.write_text(html(trades), encoding="utf-8")
    print("Wrote", OUT)


if __name__ == "__main__":
    main()
