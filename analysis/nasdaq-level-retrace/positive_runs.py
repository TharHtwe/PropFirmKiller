"""Trade lists for every run with a positive net, and a filterable report.

Losing configs are not simulated again. The profitable ids come from results/summary.csv.

Run: python -u positive_runs.py
"""

from __future__ import annotations

import csv
import gc
import json
from datetime import date
from pathlib import Path

import pandas as pd

import backtest as b

ROOT = Path(__file__).resolve().parent
SUMMARY = ROOT / "results" / "summary.csv"
OUT = ROOT / "results" / "positive_runs.html"
WEEKDAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")
RESULT_CODE = {"stop": 0, "target": 1, "end of data": 2}
SESSION_NAME = {
    "london": "London only",
    "ny": "New York only",
    "rth": "New York RTH only",
    "all": "London or New York",
}
TRADE_NAME = {
    "every": "Every level, even if another trade is open",
    "serial": "One trade at a time",
}
DAY_NAME = {
    "one": "One trade per New York date",
    "until": "Keep opening until that New York date is up 50 points",
    "greedy": "No daily profit cap",
}
LOOK_NAME = {
    "month": "the previous 30 days",
    "6month": "the previous 6 months",
    "year": "the previous year",
    "all": "all history",
}


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


def profitable():
    rows = []
    with SUMMARY.open(encoding="utf-8", newline="") as handle:
        for row in csv.DictReader(handle):
            if float(row["net_points"]) > 0:
                rows.append(row)
    return rows


def pack(touch, done, stamp, sl, tp):
    ymd = touch["ymd"]
    y, m, d = ymd // 10000, (ymd // 100) % 100, ymd % 100
    when = date(y, m, d)
    side = touch["side"]
    fill = float(touch["fill"])
    flags = (1 if touch["in_lon"] else 0) | (2 if touch["in_ny"] else 0) | (4 if touch["in_rth"] else 0)
    return [
        when.isoformat(),
        stamp[touch["bar"]],
        stamp[done["bar"]],
        when.weekday(),
        week_of_month(d),
        m,
        flags,
        1 if side == 1 else 0,
        round(float(touch["price"]), 2),
        round(fill, 2),
        round(fill - sl * side, 2),
        round(fill + tp * side, 2),
        round(float(done["exit"]), 2),
        RESULT_CODE[done["kind"]],
        round(float(done["pnl"]), 2),
        "; ".join(touch["sources"]),
    ]


def html(runs):
    data = json.dumps(runs, separators=(",", ":")).replace("<", "\\u003c")
    page = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Profitable runs</title>
<style>
  body { margin: 0; font: 15px/1.45 Georgia, "Times New Roman", serif; background: #f4f1ea; color: #1c1a17; }
  main { max-width: 1180px; margin: 0 auto; padding: 28px 20px 80px; }
  h1 { font-size: 28px; margin: 0 0 8px; }
  h2 { font-size: 20px; margin: 28px 0 8px; }
  p { max-width: 78ch; }
  .note, form { background: #fff6e8; border: 1px solid #e6d3b0; padding: 12px 14px; }
  form { display: flex; flex-wrap: wrap; gap: 14px; align-items: end; margin-top: 14px; }
  label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
  label.run { flex: 1 1 420px; }
  select.run { width: 100%; }
  input, select, button { font: 14px Consolas, monospace; padding: 6px 8px; }
  button { background: #1c1a17; color: white; border: 0; cursor: pointer; }
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin: 14px 0; }
  .card { background: white; border: 1px solid #ddd6c8; padding: 12px; }
  .card b { display: block; font-size: 22px; }
  table { width: 100%; border-collapse: collapse; background: white; font: 13px/1.35 Consolas, monospace; margin: 8px 0 18px; }
  th, td { border-bottom: 1px solid #e4dccb; text-align: right; padding: 6px 8px; white-space: nowrap; }
  th:first-child, td:first-child, .left { text-align: left; }
  .pos { color: #1b7f3a; } .neg { color: #8a2b2b; }
  #trades { font-size: 12px; }
  @media (max-width: 800px) { .grid { grid-template-columns: 1fr 1fr; } }
</style>
</head>
<body>
<main>
  <h1>Profitable runs</h1>
  <div class="note">
    <p id="blurb"></p>
    <p>Only runs with a positive net are listed. The menu is sorted by that net. Times are UTC. The date, weekday, week, and month use the New York calendar date of the entry. London is 08:00–16:30 London time. New York is 08:00–17:00 New York time. RTH is 09:30–16:00 New York time. Choosing a session keeps trades whose entry bar was inside it.</p>
    <p>The 1st week is days 1–7, then 8–14, 15–21, and 22–28. Days 29–31 stay separate. Weeks and calendar months are pooled across years. A win streak counts trades with points above zero. Anything else extends the loss streak. Streaks are measured inside the rows of that table, in trade order.</p>
  </div>
  <form id="filters">
    <label class="run">Run
      <select id="run" class="run"></select>
    </label>
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
  <p>Each click draws 10 stretches of 100 trades in a row from the filtered list. Trades 5–104 are one stretch.</p>
  <button type="button" id="sample">Draw 10 sets</button>
  <table id="samples"></table>
  <h2>Trades</h2>
  <p id="count"></p>
  <table id="trades"></table>
</main>
<script>
const RUNS = __DATA__;
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const RESULTS = ["stop", "target", "end of data"];
const SESSION = {london: "London only", ny: "New York only", rth: "New York RTH only", all: "London or New York"};
const TRADE = {every: "Every level, even if another trade is open", serial: "One trade at a time"};
const DAY = {one: "One trade per New York date", until: "Keep opening until that New York date is up 50 points", greedy: "No daily profit cap"};
const LOOK = {month: "the previous 30 days", "6month": "the previous 6 months", year: "the previous year", all: "all history"};
const HEAD = ["Group", "Trades", "Wins", "Losses", "Win %", "Net", "Expectancy", "Profit factor", "PF without best", "Max DD", "Payoff", "Max win streak", "Max loss streak"];
const runSelect = document.getElementById("run");
const fromInput = document.getElementById("from");
const toInput = document.getElementById("to");
let current = [];

runSelect.innerHTML = RUNS.map((run) => `<option value="${run.id}">${run.net > 0 ? "+" : ""}${run.net}  ${run.id}  (${run.trades.length} trades)</option>`).join("");

function unpack(row) {
  return {
    date: row[0],
    time: row[1],
    exitTime: row[2],
    weekday: DAYS[row[3]],
    week: row[4],
    month: row[5],
    london: (row[6] & 1) !== 0,
    newYork: (row[6] & 2) !== 0,
    rth: (row[6] & 4) !== 0,
    side: row[7] ? "buy" : "sell",
    level: row[8],
    fill: row[9],
    stop: row[10],
    target: row[11],
    exit: row[12],
    result: RESULTS[row[13]],
    points: row[14],
    sources: row[15],
  };
}

function num(v, digits) {
  if (v === null || v === undefined || Number.isNaN(v)) return "-";
  return Number(v).toFixed(digits);
}
function cls(v) { return v > 0 ? "pos" : v < 0 ? "neg" : ""; }

function stats(rows) {
  if (!rows.length) return null;
  const points = rows.map((r) => r.points);
  const wins = points.filter((v) => v > 0);
  const losses = points.filter((v) => v <= 0);
  const gain = wins.reduce((s, v) => s + v, 0);
  const loss = Math.abs(losses.reduce((s, v) => s + v, 0));
  let peak = 0, equity = 0, maxDd = 0, winStreak = 0, lossStreak = 0, maxWin = 0, maxLoss = 0;
  points.forEach((v) => {
    equity += v;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
    if (v > 0) {
      winStreak += 1;
      lossStreak = 0;
      maxWin = Math.max(maxWin, winStreak);
    } else {
      lossStreak += 1;
      winStreak = 0;
      maxLoss = Math.max(maxLoss, lossStreak);
    }
  });
  const best = Math.max(...points);
  const rest = points.slice();
  rest.splice(rest.indexOf(best), 1);
  const restGain = rest.filter((v) => v > 0).reduce((s, v) => s + v, 0);
  const restLoss = Math.abs(rest.filter((v) => v <= 0).reduce((s, v) => s + v, 0));
  const avgWin = wins.length ? gain / wins.length : null;
  const avgLoss = losses.length ? losses.reduce((s, v) => s + v, 0) / losses.length : null;
  return {
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
    maxWin,
    maxLoss,
  };
}

function cells(label, s) {
  if (!s) return `<tr><td class="left">${label}</td><td colspan="${HEAD.length - 1}">no trades</td></tr>`;
  return `<tr><td class="left">${label}</td><td>${s.trades}</td><td>${s.wins}</td><td>${s.losses}</td><td>${num(s.winRate, 1)}</td><td class="${cls(s.net)}">${num(s.net, 1)}</td><td class="${cls(s.expectancy)}">${num(s.expectancy, 2)}</td><td>${num(s.pf, 3)}</td><td>${num(s.pfEx, 3)}</td><td>${num(s.maxDd, 1)}</td><td>${num(s.payoff, 3)}</td><td>${s.maxWin}</td><td>${s.maxLoss}</td></tr>`;
}

function table(id, pairs) {
  document.getElementById(id).innerHTML = `<tr>${HEAD.map((h, i) => `<th class="${i ? "" : "left"}">${h}</th>`).join("")}</tr>`
    + pairs.map(([label, rows]) => cells(label, stats(rows))).join("");
}

function selected() {
  const session = document.getElementById("session").value;
  const from = fromInput.value;
  const to = toInput.value;
  return current.filter((t) => t.date >= from && t.date <= to && (session === "all" || t[session]));
}

function draw() {
  const rows = selected();
  const s = stats(rows);
  document.getElementById("summary").innerHTML = s ? `
    <div class="card"><b>${s.trades}</b>trades</div>
    <div class="card"><b class="${cls(s.net)}">${num(s.net, 1)}</b>net points</div>
    <div class="card"><b>${num(s.winRate, 1)}%</b>win rate</div>
    <div class="card"><b>${num(s.pf, 3)}</b>profit factor</div>
    <div class="card"><b>${s.maxWin}</b>max win streak</div>
    <div class="card"><b>${s.maxLoss}</b>max loss streak</div>` : `<div class="card"><b>0</b>trades</div>`;
  const by = (key) => {
    const map = new Map();
    rows.forEach((t) => {
      if (!map.has(t[key])) map.set(t[key], []);
      map.get(t[key]).push(t);
    });
    return map;
  };
  const dayMap = by("weekday");
  table("weekday", DAYS.filter((d) => dayMap.has(d)).map((d) => [d, dayMap.get(d)]));
  const weekName = {1: "1st week, days 1–7", 2: "2nd week, days 8–14", 3: "3rd week, days 15–21", 4: "4th week, days 22–28", 5: "Days 29–31"};
  const weekMap = by("week");
  table("week", [1, 2, 3, 4, 5].filter((w) => weekMap.has(w)).map((w) => [weekName[w], weekMap.get(w)]));
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  table("month", months.map((name, i) => [name, rows.filter((t) => t.month === i + 1)]).filter((pair) => pair[1].length));
  document.getElementById("samples").innerHTML = "";
  document.getElementById("count").textContent = rows.length + " trades.";
  document.getElementById("trades").innerHTML = `<tr><th class="left">NY date</th><th class="left">Entry UTC</th><th class="left">Exit UTC</th><th class="left">Weekday</th><th>Week</th><th class="left">Sessions</th><th class="left">Side</th><th>Level</th><th>Fill</th><th>Stop</th><th>Target</th><th>Exit</th><th class="left">Result</th><th>Points</th><th class="left">Level source</th></tr>`
    + rows.map((t) => {
      const sessions = [t.london ? "London" : "", t.newYork ? "New York" : "", t.rth ? "RTH" : ""].filter(Boolean).join(", ");
      return `<tr><td class="left">${t.date}</td><td class="left">${t.time}</td><td class="left">${t.exitTime}</td><td class="left">${t.weekday}</td><td>${t.week}</td><td class="left">${sessions}</td><td class="left">${t.side}</td><td>${t.level}</td><td>${t.fill}</td><td>${t.stop}</td><td>${t.target}</td><td>${t.exit}</td><td class="left">${t.result}</td><td class="${cls(t.points)}">${t.points}</td><td class="left">${t.sources}</td></tr>`;
    }).join("");
}

function drawSamples() {
  const rows = selected();
  const width = 100;
  const host = document.getElementById("samples");
  if (rows.length < width) {
    host.innerHTML = `<tr><td class="left">This filter has ${rows.length} trades. A set needs 100.</td></tr>`;
    return;
  }
  const starts = [];
  while (starts.length < 10) {
    const start = Math.floor(Math.random() * (rows.length - width + 1));
    if (!starts.includes(start)) starts.push(start);
  }
  starts.sort((a, b) => a - b);
  table("samples", starts.map((start) => [
    `Trades ${start + 1}–${start + width}`,
    rows.slice(start, start + width),
  ]));
}

function loadRun() {
  const run = RUNS.find((row) => row.id === runSelect.value);
  current = run.trades.map(unpack);
  if (current.length) {
    fromInput.value = current[0].date;
    toInput.value = current[current.length - 1].date;
  }
  document.getElementById("blurb").textContent = `${run.id}. Stop ${run.sl} points, target ${run.tp}. ${SESSION[run.session]}. ${TRADE[run.concurrency]}. ${DAY[run.manage]}. Levels from ${LOOK[run.look]}.`;
  draw();
}

runSelect.addEventListener("change", loadRun);
document.getElementById("filters").addEventListener("input", (event) => {
  if (event.target !== runSelect) draw();
});
document.getElementById("sample").addEventListener("click", drawSamples);
loadRun();
</script>
</body>
</html>
"""
    return page.replace("__DATA__", data)


def main():
    configs = profitable()
    print(f"{len(configs)} profitable runs", flush=True)
    by_look = {}
    for row in configs:
        by_look.setdefault(row["look"], []).append(row)
    print("Loading", b.CSV, flush=True)
    ts, o, h, l, c = b.load()
    stamp = pd.to_datetime(ts, unit="ms", utc=True).strftime("%Y-%m-%d %H:%M").to_numpy()
    clock = b.clocks(ts)
    records = b.build_levels(ts, o, c, clock)
    block_low, block_high = b.prepare_blocks(h, l, c)
    partial = ROOT / "results" / "_positive_partial.jsonl"
    with partial.open("w", encoding="utf-8") as handle:
        for look, days in b.LOOKBACKS:
            wanted = by_look.get(look, [])
            if not wanted:
                continue
            print(f"Lookback {look}, {len(wanted)} runs", flush=True)
            touches, _levels = b.generate(records, days, ts, o, h, l, c, clock, block_low, block_high)
            print(f"  {len(touches)} session crosses", flush=True)
            for row in wanted:
                sl = float(row["sl"])
                tp = float(row["tp"])
                trades, _decisions = b.simulate(touches, sl, tp, row["session"], row["concurrency"], row["manage"])
                raw_net = round(sum(done["pnl"] for _touch, done in trades), 1)
                expected = round(float(row["net_points"]), 1)
                if len(trades) != int(row["trades"]) or abs(raw_net - expected) > 0.15:
                    raise SystemExit(
                        f"{row['id']} drifted: {len(trades)} trades, net {raw_net}, expected {row['trades']} {expected}"
                    )
                packed = [pack(touch, done, stamp, sl, tp) for touch, done in trades]
                handle.write(
                    json.dumps(
                        {
                            "id": row["id"],
                            "sl": int(sl),
                            "tp": int(tp),
                            "session": row["session"],
                            "concurrency": row["concurrency"],
                            "manage": row["manage"],
                            "look": look,
                            "net": expected,
                            "trades": packed,
                        },
                        separators=(",", ":"),
                    )
                )
                handle.write("\n")
                handle.flush()
                print(f"  {row['id']}: {len(packed)} trades, net {raw_net}", flush=True)
                del packed
            del touches
            gc.collect()
    runs = [json.loads(line) for line in partial.read_text(encoding="utf-8").splitlines() if line]
    partial.unlink()
    runs.sort(key=lambda run: run["net"], reverse=True)
    text = html(runs)
    OUT.write_text(text, encoding="utf-8")
    print(f"Wrote {OUT} ({OUT.stat().st_size / 1e6:.1f} MB, {len(runs)} runs)", flush=True)


if __name__ == "__main__":
    main()
