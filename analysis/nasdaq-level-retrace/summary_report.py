"""One page for the three 2-step runs: prop cash, trading stats, and trades.

The prop numbers are taken from results/prop_weekday_accounts.html.
The sl50 trades are the stored list. The two continuation lists are resimulated.
"""

from __future__ import annotations

import gc
import json
from collections import defaultdict
from datetime import date, datetime, timezone
from pathlib import Path

import numpy as np

import backtest as b
import prop_sim
import prop_weekday_report as prop

ROOT = Path(__file__).resolve().parent
PROP_HTML = ROOT / "results" / "prop_weekday_accounts.html"
OUT = ROOT / "results" / "three_runs.html"

EXPECT_NET = {
    "sl50_tp50_all_serial_one_month": 4978,
}
EXPECT_POINTS = {
    "sl50_tp50_all_serial_one_month": 3600,
    "sl100_tp50_rth_every_one_month_touch_continuation": 8000,
    "sl100_tp150_rth_every_one_month_touch_continuation": 16600,
}
EXPECT_TRADES = {
    "sl50_tp50_all_serial_one_month": 1666,
    "sl100_tp50_rth_every_one_month_touch_continuation": 1594,
    "sl100_tp150_rth_every_one_month_touch_continuation": 1594,
}
POINT_VALUE = {
    "sl50_tp50_all_serial_one_month": 2.0,
    "sl100_tp50_rth_every_one_month_touch_continuation": 1.0,
    "sl100_tp150_rth_every_one_month_touch_continuation": 1.0,
}
STOP = {
    "sl50_tp50_all_serial_one_month": 50,
    "sl100_tp50_rth_every_one_month_touch_continuation": 100,
    "sl100_tp150_rth_every_one_month_touch_continuation": 100,
}
SETUP = {
    "sl50_tp50_all_serial_one_month": "Fade 50/50 · 0.10 lot",
    "sl100_tp50_rth_every_one_month_touch_continuation": "Continuation 100/50 · 0.05 lot",
    "sl100_tp150_rth_every_one_month_touch_continuation": "Continuation 100/150 · 0.05 lot",
}
RESULT = {"stop": 0, "target": 1, "end of data": 2}


def week_of_month(day: int) -> int:
    if day <= 7:
        return 1
    if day <= 14:
        return 2
    if day <= 21:
        return 3
    if day <= 28:
        return 4
    return 5


def stamp_ms(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000.0, timezone.utc).strftime("%Y-%m-%d %H:%M")


def load_prop():
    """The fade run is unchanged at 0.10 lot, so its 2-step result is reused."""
    text = PROP_HTML.read_text(encoding="utf-8")
    marker = "const RUNS = "
    i = text.find(marker)
    if i < 0:
        raise SystemExit("prop report has no RUNS payload")
    data, _ = json.JSONDecoder().raw_decode(text[i + len(marker) :])
    out = []
    for run in data:
        name = run["id"]
        if name not in EXPECT_NET:
            continue
        account = next(row for row in run["accounts"] if row["id"] == "2step")
        if abs(account["net"] - EXPECT_NET[name]) > 0.01:
            raise SystemExit(f"{name} prop net drifted to {account['net']}")
        out.append(
            {
                "id": name,
                "label": run["label"],
                "blurb": run["blurb"],
                "setup": SETUP[name],
                "loss": run["loss"],
                "min_win": run["min_win"],
                "point_value": POINT_VALUE[name],
                "stop": STOP[name],
                "prop": account,
            }
        )
    print("prop nets", {row["id"]: row["prop"]["net"] for row in out}, flush=True)
    return {row["id"]: row for row in out}


def overlaps(rows) -> int:
    by = defaultdict(list)
    for row in rows:
        by[row[3]].append(row)
    count = 0
    for group in by.values():
        group.sort(key=lambda row: row[1])
        for left, right in zip(group, group[1:]):
            if left[2] > right[1]:
                count += 1
    return count


def stats_from_rows(rows, stop: int):
    pnls = np.array([float(row[14]) for row in rows], dtype=np.float64)
    wins = pnls > 0
    losers = pnls[~wins]
    winners = pnls[wins]
    pf = b.profit_factor(pnls)
    pf2 = None
    if len(pnls) > 1:
        cut = pnls.copy()
        cut[int(np.argmax(cut))] = 0.0
        pf2 = b.profit_factor(cut)
    dd, dd_len = b.max_drawdown(pnls)
    equity = np.cumsum(pnls)
    step = max(1, len(equity) // 160)
    curve = [round(float(v), 2) for v in equity[step - 1 :: step]]
    if curve and curve[-1] != round(float(equity[-1]), 2):
        curve.append(round(float(equity[-1]), 2))
    by_day = defaultdict(float)
    longs = shorts = 0
    long_net = short_net = 0.0
    targets = stops = forced = 0
    minutes = []
    for row in rows:
        by_day[row[0]] += float(row[14])
        opened = datetime.strptime(row[1], "%Y-%m-%d %H:%M")
        closed = datetime.strptime(row[2], "%Y-%m-%d %H:%M")
        if len(row) > 16:
            minutes.append(int(row[16]))
        else:
            minutes.append(max(0, int((closed - opened).total_seconds() // 60)))
        if row[7]:
            longs += 1
            long_net += float(row[14])
        else:
            shorts += 1
            short_net += float(row[14])
        code = int(row[13])
        if code == 1:
            targets += 1
        elif code == 0:
            stops += 1
        else:
            forced += 1
    day_vals = list(by_day.values())
    best = max(by_day.items(), key=lambda item: item[1])
    worst = min(by_day.items(), key=lambda item: item[1])
    chunks = []
    if len(pnls) >= 10:
        size = len(pnls) // 10
        for i in range(10):
            block = wins[i * size : (i + 1) * size]
            chunks.append(round(100.0 * float(block.mean()), 1))
    day_arr = np.array(day_vals, dtype=np.float64)
    swing = float(day_arr.std()) if len(day_arr) else 0.0
    net = round(float(pnls.sum()), 1)
    return {
        "trades": int(len(pnls)),
        "wins": int(wins.sum()),
        "losses": int((~wins).sum()),
        "win_rate": round(100.0 * float(wins.mean()), 1),
        "net_points": net,
        "expectancy": round(float(pnls.mean()), 2),
        "profit_factor": None if pf is None else round(pf, 3),
        "profit_factor_without_best": None if pf2 is None else round(pf2, 3),
        "max_drawdown": round(dd, 1),
        "max_drawdown_trades": int(dd_len),
        "payoff": None
        if len(losers) == 0 or len(winners) == 0
        else round(float(winners.mean() / -losers.mean()), 3),
        "avg_win": None if len(winners) == 0 else round(float(winners.mean()), 2),
        "avg_loss": None if len(losers) == 0 else round(float(losers.mean()), 2),
        "longs": longs,
        "shorts": shorts,
        "long_net": round(long_net, 1),
        "short_net": round(short_net, 1),
        "targets": targets,
        "stops": stops,
        "forced": forced,
        "chunks": chunks,
        "chunk_size": int(len(pnls) // 10) if len(pnls) >= 10 else 0,
        "autocorrelation": b.autocorrelation_block(pnls, stop),
        "equity": curve,
        "best_day": {"date": best[0], "points": round(best[1], 1)},
        "worst_day": {"date": worst[0], "points": round(worst[1], 1)},
        "avg_minutes": round(float(np.mean(minutes)), 1),
        "same_minute": int(sum(v == 0 for v in minutes)),
        "his_sharpe_daily": None if swing == 0 else round(float(day_arr.mean() / swing), 3),
        "positive_days": int(sum(v > 0 for v in day_vals)),
        "trading_days": len(day_vals),
        "raw_dollars": round(net * POINT_VALUE_OF, 2),
    }


# Filled per run inside attach(); placeholder so stats_from_rows can see the lot.
POINT_VALUE_OF = 1.0


def attach(run, rows):
    global POINT_VALUE_OF
    POINT_VALUE_OF = run["point_value"]
    name = run["id"]
    stats = stats_from_rows(rows, run["stop"])
    if stats["trades"] != EXPECT_TRADES[name]:
        raise SystemExit(f"{name} trades {stats['trades']}")
    if abs(stats["net_points"] - EXPECT_POINTS[name]) > 0.2:
        raise SystemExit(f"{name} points {stats['net_points']}")
    run["stats"] = stats
    run["trades"] = rows
    run["overlaps"] = overlaps(rows)
    print(
        f"  {name}: {stats['trades']} trades, {stats['win_rate']}% , "
        f"{stats['net_points']} pts, pf {stats['profit_factor']}, "
        f"dd {stats['max_drawdown']}, overlaps {run['overlaps']}",
        flush=True,
    )


def pack_pair(touch, done, sl, tp, ts):
    ymd = int(touch["ymd"])
    year, month, day = ymd // 10000, (ymd // 100) % 100, ymd % 100
    when = date(year, month, day)
    side = int(touch["side"])
    fill = float(touch["fill"])
    flags = (1 if touch["in_lon"] else 0) | (2 if touch["in_ny"] else 0) | (4 if touch["in_rth"] else 0)
    sources = touch["sources"]
    if not isinstance(sources, str):
        sources = "; ".join(sources)
    kind = done["kind"]
    if kind not in RESULT:
        raise SystemExit(f"unknown exit {kind}")
    return [
        when.isoformat(),
        stamp_ms(int(touch["ts"])),
        stamp_ms(int(ts[int(done["bar"])])),
        when.weekday(),
        week_of_month(day),
        month,
        flags,
        1 if side == 1 else 0,
        round(float(touch["price"]), 2),
        round(fill, 2),
        round(fill - sl * side, 2),
        round(fill + tp * side, 2),
        round(float(done["exit"]), 2),
        RESULT[kind],
        round(float(done["pnl"]), 2),
        sources,
        int(done["bar"]) - int(touch["bar"]),
    ]


def add_bar_minutes(rows, ts):
    """Hold is the number of one-minute bars, not the clock time across a closed market."""
    for row in rows:
        held = prop_sim.bar_index(ts, row[2]) - prop_sim.bar_index(ts, row[1])
        if len(row) > 16:
            row[16] = held
        else:
            row.append(held)


def load_continuation(runs, ts, o, h, l, c):
    clock = b.clocks(ts)
    records = b.build_levels(ts, o, c, clock)
    block_low, block_high = b.prepare_blocks(h, l, c)
    print("building month continuation touches", flush=True)
    touches = prop.build_touch(records, 30, ts, o, h, l, c, clock, block_low, block_high)
    print(f"  {len(touches)} touches", flush=True)
    configs = (
        ("sl100_tp50_rth_every_one_month_touch_continuation", 100.0, 50.0),
        ("sl100_tp150_rth_every_one_month_touch_continuation", 100.0, 150.0),
    )
    # 0.05 lot is $1 an index point. The 2-step path is resimulated; the point totals are not.
    spec = next(row for row in prop.SPECS if row["id"] == "2step")
    point = 100
    bar_day = np.array([prop.day_of_ms(int(ms)) for ms in ts])
    for name, sl, tp in configs:
        print("simulate", name, flush=True)
        pairs, _decisions = b.simulate(touches, sl, tp, "rth", "every", "one")
        rows = [pack_pair(touch, done, sl, tp, ts) for touch, done in pairs]
        net_points = round(sum(float(done["pnl"]) for _touch, done in pairs), 1)
        if abs(net_points - EXPECT_POINTS[name]) > 0.2:
            raise SystemExit(f"{name} points drifted: {net_points}")
        packed, mismatches, overlaps = prop.pack_trades(pairs, sl, tp, ts, o, h, l, c)
        print(f"  path mismatches {mismatches}, weekday overlaps {overlaps}", flush=True)
        if mismatches:
            raise SystemExit(f"{name} path mismatches {mismatches}")
        loss = int(sl) * point // 100
        win = int(tp) * point // 100
        account = prop.finish_account(packed, bar_day, point, spec, loss)
        wins = sum(1 for _touch, done in pairs if float(done["pnl"]) > 0)
        win_rate = round(100.0 * wins / len(pairs), 1)
        overlap_note = ""
        if overlaps:
            overlap_note = (
                f" {overlaps} trades were still open when the same weekday traded again;"
                f" that position stays on the same account until it closes."
            )
        sign = "+" if net_points > 0 else ""
        points_txt = f"{sign}{net_points:,.0f}" if float(net_points).is_integer() else f"{sign}{net_points}"
        run = {
            "id": name,
            "label": name.replace("_", " "),
            "setup": SETUP[name],
            "loss": loss,
            "min_win": win,
            "point_value": POINT_VALUE[name],
            "stop": int(sl),
            "prop": account,
            "blurb": (
                f"Continuation, lot 0.05. Buy a cross up and sell a cross down. Touch enters on the wick. "
                f"Stop {int(sl)} points (${loss}) and target {int(tp)} points (${win}). "
                f"New York RTH only, one trade per New York day, levels from the previous 30 days. "
                f"{len(pairs)} trades, {win_rate}% wins, net {points_txt} points.{overlap_note}"
            ),
        }
        attach(run, rows)
        runs[name] = run
        print(f"  2-step net {account['net']} cushion {account['cushion']['net']} no-green {account['no_green_net']}", flush=True)
    del touches, records
    gc.collect()


PAGE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Three runs, 2-step account</title>
<style>
  body { margin: 0; font: 15px/1.5 Georgia, "Times New Roman", serif; background: #f4f1ea; color: #1c1a17; }
  main { max-width: 1180px; margin: 0 auto; padding: 28px 20px 80px; }
  h1 { font-size: 28px; margin: 0 0 8px; }
  h2 { font-size: 20px; margin: 28px 0 8px; }
  p, li { max-width: 82ch; }
  label.run { display: flex; flex-direction: column; gap: 4px; font-size: 13px; margin: 8px 0 4px; }
  select, button { font: 14px Consolas, monospace; padding: 8px; }
  select { width: 100%; }
  button { background: #1c1a17; color: white; border: 0; cursor: pointer; }
  button:disabled { opacity: 0.35; cursor: default; }
  .note, .risk { background: #fff6e8; border: 1px solid #e6d3b0; padding: 12px 14px; }
  .risk { margin: 8px 0 0; }
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin: 16px 0; }
  .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .card { background: white; border: 1px solid #ddd6c8; padding: 12px; }
  .card b { display: block; font-size: 26px; line-height: 1.2; }
  .card span { display: block; color: #5c564c; font-size: 13px; }
  table { width: 100%; border-collapse: collapse; background: white; font: 13px/1.4 Consolas, monospace; margin: 8px 0 18px; }
  th, td { border-bottom: 1px solid #e4dccb; text-align: right; padding: 7px 8px; vertical-align: top; white-space: nowrap; }
  th:first-child, td:first-child, .left { text-align: left; }
  td.wrap { white-space: normal; min-width: 220px; }
  .pos { color: #1b7f3a; }
  .neg { color: #8a2b2b; }
  .chart { background: white; border: 1px solid #ddd6c8; padding: 12px 12px 4px; }
  .chart svg { width: 100%; height: auto; display: block; }
  .caption, .jump { color: #5c564c; font-size: 13px; margin: 0 0 8px; }
  .jump a { color: #1c1a17; }
  #compare tr { cursor: pointer; }
  #compare tr.best td { background: #f3f8f4; }
  #compare tr.on td { box-shadow: inset 0 -2px 0 #1c1a17; }
  .scroll { overflow-x: auto; }
  details { background: white; border: 1px solid #ddd6c8; margin: 12px 0; }
  summary { cursor: pointer; padding: 12px 14px; font-size: 18px; }
  details .body { padding: 0 14px 8px; }
  details[open] summary { border-bottom: 1px solid #e4dccb; }
  .tradebar { display: flex; flex-wrap: wrap; gap: 10px; align-items: end; margin-top: 12px; }
  .tradebar label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
  .tradebar select { width: auto; }
  #trades { font-size: 12px; }
  @media (max-width: 800px) {
    .grid { grid-template-columns: 1fr 1fr; }
    .pair { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
<main>
  <h1>Three runs on the 2-step account</h1>
  <div class="note">
    <p>Standard 2-step, $5,000, fee $22. One account for each New York weekday. Reaching $4,600, or that day's 4% line, blows the account. You keep 80% of funded profit. Cash is settled on 26 Oct 2026. Trades run from 2020 through 23 Oct 2026.</p>
    <p>Net cash is payouts you received minus fees. Raw dollars are the points times the lot, before blowups and the split. A blown challenge costs the fee. The firm's $5,000 absorbs the trading loss.</p>
  </div>
  <h2>The three results</h2>
  <p class="caption">Click a row to open that run. The green row keeps the most cash.</p>
  <div class="scroll"><table id="compare"></table></div>
  <label class="run">Run
    <select id="run"></select>
  </label>
  <p id="blurb"></p>
  <div class="risk" id="rules"></div>
  <div class="grid" id="cards"></div>
  <p id="sensitive"></p>
  <div class="pair">
    <div>
      <h2>Cash you keep</h2>
      <p class="caption" id="cashcap"></p>
      <div class="chart" id="cash"></div>
    </div>
    <div>
      <h2>Trading equity</h2>
      <p class="caption" id="pointcap"></p>
      <div class="chart" id="points"></div>
    </div>
  </div>
  <h2>Where the five accounts stand</h2>
  <p class="caption">Settled on 26 Oct 2026. A payout window that is already open still needs the profit and the 3 winning days.</p>
  <div class="scroll"><table id="now"></table></div>
  <p id="ended"></p>
  <p class="jump">
    <a href="#days">Days to pass</a> ·
    <a href="#year">Cash by year</a> ·
    <a href="#weekdays">Weekday accounts</a> ·
    <a href="#matrices">Trading matrices</a> ·
    <a href="#streaks">Streaks and Kelly</a> ·
    <a href="#tradelist">Trades</a> ·
    <a href="#method">How this was run</a>
  </p>
  <details id="days" open>
    <summary>Days to pass</summary>
    <div class="body">
      <p class="caption" id="passnote"></p>
      <div class="grid" id="pass-cards"></div>
      <div class="scroll"><table id="pass"></table></div>
    </div>
  </details>
  <details id="year">
    <summary>Cash by year</summary>
    <div class="body">
      <p class="caption">A fee is charged on the first trade of a new challenge. Received is the 80% you keep.</p>
      <div class="scroll"><table id="years"></table></div>
    </div>
  </details>
  <details id="weekdays" open>
    <summary>One account per weekday</summary>
    <div class="body">
      <p class="caption">Points are that weekday's trades. Net is payouts you received minus challenge fees.</p>
      <div class="scroll"><table id="weekday-table"></table></div>
      <p id="daynote"></p>
    </div>
  </details>
  <details id="cushion">
    <summary>Withdrawal and the 3-day rule</summary>
    <div class="body">
      <div class="scroll"><table id="cushion-table"></table></div>
    </div>
  </details>
  <details id="matrices">
    <summary>Trading matrices</summary>
    <div class="body">
      <p id="matrixnote"></p>
      <h2>Weekday</h2>
      <div class="scroll"><table id="by-day"></table></div>
      <h2>Week of the month</h2>
      <div class="scroll"><table id="by-week"></table></div>
      <h2>Month</h2>
      <div class="scroll"><table id="by-month"></table></div>
      <h2>Year</h2>
      <div class="scroll"><table id="by-year"></table></div>
      <h2>Side</h2>
      <div class="scroll"><table id="by-side"></table></div>
      <h2>Exit</h2>
      <div class="scroll"><table id="by-exit"></table></div>
    </div>
  </details>
  <details id="streaks">
    <summary>Streaks, Kelly, and ten blocks</summary>
    <div class="body">
      <p id="autonote"></p>
      <h2>Win rate by block</h2>
      <p class="caption" id="chunknote"></p>
      <div class="scroll"><table id="chunks"></table></div>
      <h2>After a losing streak</h2>
      <div class="scroll"><table id="loss-streak"></table></div>
      <h2>After a winning streak</h2>
      <div class="scroll"><table id="win-streak"></table></div>
    </div>
  </details>
  <details id="tradelist">
    <summary>Trades</summary>
    <div class="body">
      <p class="caption">Times are UTC. The date and the weekday are the New York date of the entry. Points are index points. Minutes are the one-minute bars from entry to exit.</p>
      <div class="tradebar">
        <label>Weekday
          <select id="tw">
            <option value="all">All</option>
            <option>Monday</option>
            <option>Tuesday</option>
            <option>Wednesday</option>
            <option>Thursday</option>
            <option>Friday</option>
          </select>
        </label>
        <label>Result
          <select id="tr">
            <option value="all">All</option>
            <option value="target">target</option>
            <option value="stop">stop</option>
            <option value="end of data">end of data</option>
          </select>
        </label>
        <button type="button" id="prev">Previous</button>
        <button type="button" id="next">Next</button>
        <span id="tcount"></span>
      </div>
      <div class="scroll"><table id="trades"></table></div>
    </div>
  </details>
  <details id="method">
    <summary>How this was run</summary>
    <div class="body">
      <ul>
        <li>Each weekday has its own account. Monday trades never mix with Tuesday trades. A blown account is replaced on the next trade for that weekday. No new account is bought after the last trade.</li>
        <li>Phase 1 needs $400 and 3 days of at least $25. Phase 2 needs $250 and 3 new days of at least $25. Each phase, and the funded account, starts again at $5,000. Challenge profit is not paid. One $22 fee covers both phases.</li>
        <li>Reaching $4,600, or that day's 4% equity floor, blows the account. The daily floor resets at 00:00 UTC from the higher of equity and balance, including an open trade.</li>
        <li>A payout withdraws all closed profit above $5,000. It needs at least $20 of profit, 3 winning days, and 10 Monday–Friday days after the first funded trade of that cycle. The next clock starts on the first trade after the payout. You keep 80%. The balance returns to $5,000.</li>
        <li>The fade run sells a cross up and buys a cross down, 0.10 lot, $2 a point. The continuation runs buy a cross up and sell a cross down, 0.05 lot, $1 a point. Touch means a wick through the level is enough. Prices are the bid series, with no spread and no commission.</li>
        <li>The fade trades are the stored combined list, split by the New York entry date. A live separate account could also take a signal that list skipped while another day's trade was open.</li>
        <li id="overlap"></li>
        <li id="holdnote"></li>
      </ul>
    </div>
  </details>
</main>
<script>
const RUNS = __DATA__;
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEK = {1: "1st week, days 1–7", 2: "2nd week, days 8–14", 3: "3rd week, days 15–21", 4: "4th week, days 22–28", 5: "Days 29–31"};
const RESULTS = ["stop", "target", "end of data"];
const HEAD = ["Group", "Trades", "Wins", "Losses", "Win %", "Net", "Expectancy", "Profit factor", "PF without best", "Max DD", "Payoff", "Max win streak", "Max loss streak"];
const PAGE_SIZE = 100;
const runSelect = document.getElementById("run");
let page = 0;
let unpacked = [];

runSelect.innerHTML = RUNS.map((run, i) => `<option value="${i}">${run.id}</option>`).join("");

function money(value) {
  const sign = value < 0 ? "−" : "";
  const abs = Math.abs(value);
  const body = Number.isInteger(abs)
    ? abs.toLocaleString("en-US")
    : abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return sign + "$" + body;
}
function points(value) {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  const abs = Math.abs(value);
  const body = Number.isInteger(abs) ? abs.toLocaleString("en-US") : abs.toLocaleString("en-US", { maximumFractionDigits: 1 });
  return sign + body;
}
function num(value, digits) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return Number(value).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
function cls(value) { return value > 0 ? "pos" : value < 0 ? "neg" : ""; }
function head(cells) {
  return "<tr>" + cells.map((cell, i) => `<th class="${i ? "" : "left"}">${cell}</th>`).join("") + "</tr>";
}
function stage(end) {
  if (!end.alive) return "Blown";
  if (end.phase === "funded") return "Funded";
  if (end.phase === "p2") return "Phase 2";
  return "Phase 1";
}
function nextText(row, account) {
  const end = row.end;
  const loss = row.loss;
  if (!end.alive) return `Blown on the last trade. The next trade for this weekday needs a new $${account.price} challenge.`;
  if (end.phase === "funded") {
    if (end.due && end.due <= "2026-10-26") {
      return `Payout window opened ${end.due}. This cycle has ${end.green} winning day${end.green === 1 ? "" : "s"} and ${money(end.profit)} of closed profit.`;
    }
    if (end.due) return `Payout date is ${end.due}. Closed profit is ${money(end.profit)}.`;
    return "Flat. The next trade starts a new 10-business-day clock.";
  }
  const target = end.phase === "p1" ? 400 : 250;
  const stops = Math.ceil((end.balance - account.floor0) / loss);
  const stopWord = stops === 1 ? "stop" : "stops";
  return `${stage(end)}. Open profit ${money(end.profit)}. Best this phase ${money(end.max_profit)}. Target is ${money(target)}. The next ${stops} full ${stopWord} of ${money(loss)} reach ${money(account.floor0)}.`;
}
function lineChart(host, labels, values, color) {
  const max = Math.max(1, ...values);
  const min = Math.min(0, ...values);
  const span = max - min || 1;
  const x0 = 64, y0 = 16, w = 640, h = 150;
  const x = (i) => x0 + (values.length === 1 ? w / 2 : (i * w) / (values.length - 1));
  const y = (v) => y0 + h * (1 - (v - min) / span);
  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const step = Math.max(1, Math.ceil(labels.length / 8));
  const text = labels.map((label, i) => (i % step === 0 || i === labels.length - 1)
    ? `<text x="${x(i).toFixed(1)}" y="186" text-anchor="middle">${label}</text>` : "").join("");
  host.innerHTML = `<svg viewBox="0 0 760 210" role="img">
    <line x1="${x0}" y1="${y(0)}" x2="${x0 + w}" y2="${y(0)}" stroke="#e4dccb"/>
    <line x1="${x0}" y1="${y0}" x2="${x0}" y2="${y0 + h}" stroke="#e4dccb"/>
    <polyline fill="none" stroke="${color}" stroke-width="2.5" points="${pts}"/>
    <g fill="#1c1a17" font-family="Consolas, monospace" font-size="11">
      ${text}
      <text x="56" y="20" text-anchor="end">${Math.round(max).toLocaleString("en-US")}</text>
      <text x="56" y="${(y(min) + 4).toFixed(0)}" text-anchor="end">${Math.round(min).toLocaleString("en-US")}</text>
    </g>
  </svg>`;
}
function holdMin(row) {
  if (row.length > 16) return row[16];
  const a = Date.parse(row[1].replace(" ", "T") + ":00Z");
  const b = Date.parse(row[2].replace(" ", "T") + ":00Z");
  return Math.max(0, Math.round((b - a) / 60000));
}
function unpack(row) {
  return {
    date: row[0],
    time: row[1],
    exitTime: row[2],
    weekday: DAYS[row[3]],
    week: row[4],
    month: row[5],
    year: row[0].slice(0, 4),
    side: row[7] ? "buy" : "sell",
    level: row[8],
    fill: row[9],
    stop: row[10],
    target: row[11],
    exit: row[12],
    result: RESULTS[row[13]],
    points: row[14],
    sources: row[15],
    hold: holdMin(row),
  };
}
function groupStats(rows) {
  if (!rows.length) return null;
  const pts = rows.map((row) => row.points);
  const wins = pts.filter((v) => v > 0);
  const losses = pts.filter((v) => v <= 0);
  const gain = wins.reduce((s, v) => s + v, 0);
  const loss = Math.abs(losses.reduce((s, v) => s + v, 0));
  let peak = 0, equity = 0, maxDd = 0, winStreak = 0, lossStreak = 0, maxWin = 0, maxLoss = 0;
  pts.forEach((v) => {
    equity += v;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
    if (v > 0) { winStreak += 1; lossStreak = 0; maxWin = Math.max(maxWin, winStreak); }
    else { lossStreak += 1; winStreak = 0; maxLoss = Math.max(maxLoss, lossStreak); }
  });
  const best = Math.max(...pts);
  const rest = pts.slice();
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
    net: pts.reduce((s, v) => s + v, 0),
    expectancy: pts.reduce((s, v) => s + v, 0) / rows.length,
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
function matrix(id, pairs) {
  document.getElementById(id).innerHTML = head(HEAD) + pairs.map(([label, rows]) => cells(label, groupStats(rows))).join("");
}
function byKey(rows, key) {
  const map = new Map();
  rows.forEach((row) => {
    if (!map.has(row[key])) map.set(row[key], []);
    map.get(row[key]).push(row);
  });
  return map;
}
function drawTrades() {
  const day = document.getElementById("tw").value;
  const result = document.getElementById("tr").value;
  const rows = unpacked.filter((row) => (day === "all" || row.weekday === day) && (result === "all" || row.result === result));
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  if (page > pages - 1) page = pages - 1;
  const slice = rows.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  const from = rows.length ? page * PAGE_SIZE + 1 : 0;
  const to = page * PAGE_SIZE + slice.length;
  document.getElementById("tcount").textContent = rows.length
    ? `${from}–${to} of ${rows.length.toLocaleString("en-US")}`
    : "0 trades";
  document.getElementById("prev").disabled = page === 0;
  document.getElementById("next").disabled = page >= pages - 1;
  document.getElementById("trades").innerHTML = head(["NY date", "Entry UTC", "Exit UTC", "Weekday", "Side", "Level", "Fill", "Stop", "Target", "Exit", "Result", "Points", "Minutes", "Level source"])
    + slice.map((row) => `<tr><td class="left">${row.date}</td><td class="left">${row.time}</td><td class="left">${row.exitTime}</td><td class="left">${row.weekday}</td><td class="left">${row.side}</td><td>${row.level}</td><td>${row.fill}</td><td>${row.stop}</td><td>${row.target}</td><td>${row.exit}</td><td class="left">${row.result}</td><td class="${cls(row.points)}">${points(row.points)}</td><td>${row.hold}</td><td class="left wrap">${row.sources}</td></tr>`).join("");
}
function render() {
  const index = Number(runSelect.value);
  const run = RUNS[index];
  const account = run.prop;
  const stats = run.stats;
  document.getElementById("blurb").textContent = run.blurb;
  document.getElementById("rules").textContent = account.summary + " You keep 80%. A payout needs $20 of closed profit, 3 winning days, and 10 Monday–Friday days.";
  const best = RUNS.reduce((a, b) => a.prop.net >= b.prop.net ? a : b);
  document.getElementById("compare").innerHTML = head(["Setup", "Net cash", "Fees", "Challenges", "Received", "Payouts", "Trades", "Win %", "Points", "Raw $", "PF", "Max DD"])
    + RUNS.map((row, i) => {
      const mark = `${i === index ? "on" : ""} ${row.id === best.id ? "best" : ""}`;
      return `<tr class="${mark}" data-i="${i}"><td class="left">${row.setup}</td><td class="${cls(row.prop.net)}">${money(row.prop.net)}</td><td>${money(row.prop.fees)}</td><td>${row.prop.challenges}</td><td>${money(row.prop.received)}</td><td>${row.prop.payouts}</td><td>${row.stats.trades.toLocaleString("en-US")}</td><td>${num(row.stats.win_rate, 1)}</td><td class="${cls(row.stats.net_points)}">${points(row.stats.net_points)}</td><td class="${cls(row.stats.raw_dollars)}">${money(row.stats.raw_dollars)}</td><td>${num(row.stats.profit_factor, 3)}</td><td>${num(row.stats.max_drawdown, 0)}</td></tr>`;
    }).join("");
  document.getElementById("cards").innerHTML = [
    ["Net cash", money(account.net), cls(account.net), "Payouts minus fees"],
    [`Fees, ${account.challenges} challenges`, money(account.fees), "", "One fee covers both phases"],
    ["Received after 80%", money(account.received), "pos", `${account.payouts} payouts`],
    ["Withdrawn before the split", money(account.gross), "", "Closed profit above $5,000"],
    ["Points", points(stats.net_points), cls(stats.net_points), `${money(stats.raw_dollars)} at $${run.point_value} a point`],
    ["Win rate", num(stats.win_rate, 1) + "%", "", `${stats.wins.toLocaleString("en-US")} wins, ${stats.losses.toLocaleString("en-US")} losses`],
    ["Profit factor", num(stats.profit_factor, 3), "", `Without the best trade ${num(stats.profit_factor_without_best, 3)}`],
    ["Max drawdown", num(stats.max_drawdown, 0), "", `${stats.max_drawdown_trades} trades · ${money(Math.round(stats.max_drawdown * run.point_value))}`],
  ].map(([label, value, tone, sub]) => `<div class="card"><b class="${tone}">${value}</b><span>${label}</span><span>${sub}</span></div>`).join("");
  const cushion = account.cushion;
  const ruleGap = account.no_green_net - account.net;
  const ruleLine = ruleGap === 0
    ? "Removing the 3-day rule leaves the same net."
    : `Removing the 3-day rule would net ${money(account.no_green_net)}.`;
  document.getElementById("sensitive").textContent = `These cards withdraw every dollar of closed profit above $5,000. Leaving a $400 cushion would net ${money(cushion.net)}. ${ruleLine}`;
  const years = account.years;
  lineChart(document.getElementById("cash"), years.map((year) => year.year), years.map((year) => year.cumulative), "#1b7f3a");
  document.getElementById("cashcap").textContent = `Year-end cumulative. Ends at ${money(account.net)}.`;
  lineChart(document.getElementById("points"), stats.equity.map((_, i, arr) => i === 0 ? "start" : i === arr.length - 1 ? "end" : ""), stats.equity, "#1c4e8a");
  document.getElementById("pointcap").textContent = `Sampled from the trade-by-trade curve. Ends at ${points(stats.net_points)} points, ${money(stats.raw_dollars)} before the prop rules.`;
  document.getElementById("now").innerHTML = head(["Weekday", "Stage", "Balance", "What happens next"])
    + account.weekdays.map((row) => `<tr><td class="left">${row.weekday}</td><td class="left">${stage(row.end)}</td><td>${money(row.end.balance)}</td><td class="left wrap">${nextText(row, account)}</td></tr>`).join("");
  document.getElementById("ended").textContent = `${account.maxdd} accounts died on the $4,600 static floor. ${account.daily} died on the 4% daily floor. Of ${account.challenges} challenges, ${account.p1} passed phase 1 and ${account.p2} passed phase 2. ${account.funded} funded accounts later blew up.`;
  const dayCard = (title, span) => span
    ? `<div class="card"><b>${span.avg}</b><span>${title}</span><span>min ${span.min} · max ${span.max}</span></div>`
    : `<div class="card"><b>—</b><span>${title}</span></div>`;
  document.getElementById("pass-cards").innerHTML = [
    dayCard(`Phase 1 calendar days, ${account.pass.p1.n} passes`, account.pass.p1.calendar),
    dayCard(`Phase 1 trading days, ${account.pass.p1.n} passes`, account.pass.p1.trading),
    dayCard(`Phase 2 calendar days, ${account.pass.p2.n} passes`, account.pass.p2.calendar),
    dayCard(`Phase 2 trading days, ${account.pass.p2.n} passes`, account.pass.p2.trading),
  ].join("");
  const spanCells = (span) => span ? `<td>${span.min}</td><td>${span.avg}</td><td>${span.max}</td>` : "<td>—</td><td>—</td><td>—</td>";
  const passRow = (label, block) => `<tr><td class="left">${label}</td><td>${block.n}</td>${spanCells(block.calendar)}${spanCells(block.trading)}</tr>`;
  document.getElementById("pass").innerHTML = head(["Phase", "Passed", "Calendar min", "Calendar average", "Calendar max", "Trading min", "Trading average", "Trading max"])
    + passRow("Phase 1", account.pass.p1) + passRow("Phase 2", account.pass.p2);
  document.getElementById("passnote").textContent = "The large number is the average. Only phases that passed are counted. Calendar days run from the entry date of that phase's first trade through the day the target was hit, and both of those days count. Trading days are the trades opened during the phase. Each account trades only its own weekday, so the calendar count includes the idle days.";
  document.getElementById("years").innerHTML = head(["Year", "Fees", "Payouts", "Gross withdrawn", "Received", "Net", "Cumulative"])
    + years.map((year) => `<tr><td class="left">${year.year}</td><td>${money(year.fees)}</td><td>${year.payouts}</td><td>${money(year.gross)}</td><td class="${cls(year.received)}">${money(year.received)}</td><td class="${cls(year.net)}">${money(year.net)}</td><td class="${cls(year.cumulative)}">${money(year.cumulative)}</td></tr>`).join("");
  const phaseKeys = ["p1", "p2"];
  const dayRow = (row) => `<tr><td class="left">${row.weekday}</td><td>${row.trades}</td><td class="${cls(row.points)}">${points(row.points)}</td><td>${row.challenges}</td><td>${row.p1}</td><td>${row.p2}</td><td>${row.funded}</td><td>${row.maxdd}</td><td>${row.daily}</td><td>${money(row.fees)}</td><td>${row.payouts}</td><td class="${cls(row.received)}">${money(row.received)}</td><td class="${cls(row.net)}">${money(row.net)}</td></tr>`;
  const sum = (key) => account.weekdays.reduce((s, row) => s + row[key], 0);
  document.getElementById("weekday-table").innerHTML = head(["Weekday", "Trades", "Points", "Challenges", "Phase 1", "Phase 2", "Funded blowups", "Static", "Daily", "Fees", "Payouts", "Received", "Net"])
    + account.weekdays.map(dayRow).join("")
    + `<tr><td class="left">All five</td><td>${sum("trades")}</td><td class="${cls(sum("points"))}">${points(sum("points"))}</td><td>${account.challenges}</td><td>${account.p1}</td><td>${account.p2}</td><td>${account.funded}</td><td>${account.maxdd}</td><td>${account.daily}</td><td>${money(account.fees)}</td><td>${account.payouts}</td><td class="${cls(account.received)}">${money(account.received)}</td><td class="${cls(account.net)}">${money(account.net)}</td></tr>`;
  const worst = account.weekdays.reduce((a, b) => a.net < b.net ? a : b);
  document.getElementById("daynote").textContent = worst.net < 0
    ? `${worst.weekday} is the one that loses cash. A blown challenge loses the firm's $5,000. The cost to you is the fee, plus any funded profit that had not been withdrawn.`
    : "Every weekday account is net positive after fees.";
  document.getElementById("cushion-table").innerHTML = head(["Rule", "Challenges", "Fees", "Payouts", "Received", "Net"])
    + `<tr><td class="left">Withdraw all profit above $5,000</td><td>${account.challenges}</td><td>${money(account.fees)}</td><td>${account.payouts}</td><td>${money(account.received)}</td><td class="${cls(account.net)}">${money(account.net)}</td></tr>`
    + `<tr><td class="left">Leave a $400 cushion</td><td>${cushion.challenges}</td><td>${money(cushion.fees)}</td><td>${cushion.payouts}</td><td>${money(cushion.received)}</td><td class="${cls(cushion.net)}">${money(cushion.net)}</td></tr>`
    + `<tr><td class="left">Remove the 3-day rule</td><td colspan="4"></td><td class="${cls(account.no_green_net)}">${money(account.no_green_net)}</td></tr>`;
  unpacked = run.trades.map(unpack);
  const dayMap = byKey(unpacked, "weekday");
  matrix("by-day", DAYS.filter((name) => dayMap.has(name)).map((name) => [name, dayMap.get(name)]));
  const weekMap = byKey(unpacked, "week");
  matrix("by-week", [1, 2, 3, 4, 5].filter((n) => weekMap.has(n)).map((n) => [WEEK[n], weekMap.get(n)]));
  const monthMap = byKey(unpacked, "month");
  matrix("by-month", MONTHS.map((name, i) => [name, monthMap.get(i + 1) || []]).filter((pair) => pair[1].length));
  const yearMap = byKey(unpacked, "year");
  matrix("by-year", [...yearMap.keys()].sort().map((year) => [year, yearMap.get(year)]));
  const sideMap = byKey(unpacked, "side");
  matrix("by-side", ["buy", "sell"].filter((name) => sideMap.has(name)).map((name) => [name, sideMap.get(name)]));
  const exitMap = byKey(unpacked, "result");
  matrix("by-exit", ["target", "stop", "end of data"].filter((name) => exitMap.has(name)).map((name) => [name, exitMap.get(name)]));
  document.getElementById("matrixnote").textContent = `${stats.trades.toLocaleString("en-US")} trades. Expectancy ${num(stats.expectancy, 2)} points. Payoff ${num(stats.payoff, 3)}. Average winner ${num(stats.avg_win, 2)}, average loser ${num(stats.avg_loss, 2)}. Average hold ${num(stats.avg_minutes, 1)} minutes. ${stats.positive_days} of ${stats.trading_days} New York days closed green. Best day ${stats.best_day.date} ${points(stats.best_day.points)}. Worst day ${stats.worst_day.date} ${points(stats.worst_day.points)}. Buy net ${points(stats.long_net)} on ${stats.longs}. Sell net ${points(stats.short_net)} on ${stats.shorts}. Targets ${stats.targets}, stops ${stats.stops}, open at the end ${stats.forced}. Daily return/swing ${num(stats.his_sharpe_daily, 3)}.`;
  const auto = stats.autocorrelation;
  document.getElementById("autonote").textContent = `Unconditional win rate ${num(auto.unconditional_win_pct, 1)}%. After a loss, the next trade wins ${num(auto.conditional_win_pct, 1)}% (${auto.after_loss} trades). After a win, the next trade wins ${num(auto.after_win_win_pct, 1)}% (${auto.after_win} trades). Gap ${num(auto.gap, 1)} percentage points: ${auto.sign}, ${auto.band}. Pearson on win/loss ${num(auto.pearson_winloss, 3)}. Pearson on points ${num(auto.pearson_points, 3)}. Full Kelly ${num(auto.kelly_full, 4)}. Map: ${auto.kelly_fraction}. ${auto.sizing} Longest win streak ${auto.max_consecutive_wins}. Longest loss streak ${auto.max_consecutive_losses}.`;
  document.getElementById("chunknote").textContent = stats.chunk_size
    ? `Each block is ${stats.chunk_size} trades, in trade order. Trades after the tenth block are left out.`
    : "Fewer than 10 trades.";
  document.getElementById("chunks").innerHTML = head(["Block", "Win %"])
    + stats.chunks.map((rate, i) => `<tr><td class="left">${i + 1}</td><td>${num(rate, 1)}</td></tr>`).join("");
  const streakTable = (id, rows) => {
    document.getElementById(id).innerHTML = head(["Streak", "Samples", "Next win %", "Next loss %"])
      + (rows || []).map((row) => `<tr><td>${row.k}</td><td>${row.n}</td><td>${num(row.next_win_pct, 1)}</td><td>${num(row.next_loss_pct, 1)}</td></tr>`).join("");
  };
  streakTable("loss-streak", auto.after_loss_streaks);
  streakTable("win-streak", auto.after_win_streaks);
  document.getElementById("overlap").textContent = run.overlaps
    ? `${run.overlaps} trades were still open when the same weekday signaled again. That position stays on the same account until it closes. A new phase starts only when the account is flat.`
    : "No trade was still open when the same weekday signaled again. A new phase starts only when the account is flat.";
  document.getElementById("holdnote").textContent = `${stats.same_minute} trades closed inside the entry minute. The rule needs at least half of a challenge's trades to be held 60 seconds or more. On these runs it does not bind.`;
  document.getElementById("tw").value = "all";
  document.getElementById("tr").value = "all";
  page = 0;
  drawTrades();
}

document.getElementById("compare").addEventListener("click", (event) => {
  const row = event.target.closest("tr");
  if (!row || !row.dataset.i) return;
  runSelect.value = row.dataset.i;
  render();
});
runSelect.addEventListener("change", render);
document.getElementById("tw").addEventListener("change", () => { page = 0; drawTrades(); });
document.getElementById("tr").addEventListener("change", () => { page = 0; drawTrades(); });
document.getElementById("prev").addEventListener("click", () => { page -= 1; drawTrades(); });
document.getElementById("next").addEventListener("click", () => { page += 1; drawTrades(); });
document.querySelectorAll(".jump a").forEach((link) => {
  link.addEventListener("click", () => {
    const box = document.querySelector(link.getAttribute("href"));
    if (box && box.tagName === "DETAILS") box.open = true;
  });
});
render();
</script>
</body>
</html>
"""


def main():
    runs = load_prop()
    print("loading prices", flush=True)
    ts, o, h, l, c = b.load()
    print("sl50 trades", flush=True)
    sl50_rows = prop_sim.load_run()
    add_bar_minutes(sl50_rows, ts)
    attach(runs["sl50_tp50_all_serial_one_month"], sl50_rows)
    load_continuation(runs, ts, o, h, l, c)
    ordered = sorted(runs.values(), key=lambda row: row["prop"]["net"], reverse=True)
    text = PAGE.replace("__DATA__", json.dumps(ordered, separators=(",", ":")).replace("<", "\\u003c"))
    OUT.write_text(text, encoding="utf-8")
    print("wrote", OUT, flush=True)


if __name__ == "__main__":
    main()
