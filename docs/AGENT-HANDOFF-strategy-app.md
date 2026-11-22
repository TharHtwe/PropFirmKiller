# Agent handoff — TradingView2 analysis app (strategy side)

Scope: the chart app, the `nasdaq-level-retrace-v2` strategy engine, its browser
report, and the MetaTrader 4 Expert Advisor. **The Risk Factor page is out of
scope** — do not edit `analysis/risk-factor/`, `/risk/`, `/api/risk/*`, or the
risk constants in `server.js`. They share only the `spawnPython()` helper.

Give this file to a fresh agent together with the repository. It contains the
rules that must not be broken, the architecture, exact commands, data contracts,
known failure modes, and the current state.

---

## 1. What this system is

One Node process (`server.js`, port 8080) serves three things:

1. **Chart app** — `/` : a Lightweight Charts terminal for MT5/Dukascopy M1 CSVs
   with timeframes, IANA time zones, session filtering, drawings and replay.
2. **Strategy report** — `/strategy/` : a static page + Python backtest engine.
   It enumerates 6,144 strategy combinations per CSV, stores every result per
   file, and can audit one run one day at a time.
3. (Out of scope) the Risk Factor report at `/risk/`.

The strategy is **level retrace v2**: daily and weekly open/close levels; enter
when price touches a level during London or New York; fixed stop/target in
"strategy points"; 8 factors; results reported in index points on one contract.

The MT4 EA (`mt4/LevelRetrace.mq4`) trades the continuation/touch branch of the
same model live or in the MT4 tester.

### 1.1 Feature inventory (what was built, in order)

**Chart app (host).**

1. Static Node server + streaming CSV API; Lightweight Charts front end.
2. Streaming parser + Web Worker aggregation; timeframes, IANA time zones,
   goto/latest, OHLC legend.
3. Drawing tools that survive timeframe changes; bar-by-bar replay.
4. Session-aware daily/weekly/monthly candles; Full / ETH / Cash modes rebuild
   all timeframes from the filtered bars.
5. MT5 vs Dukascopy CSV detection; "Update data" appends missing bars from
   MT5 or Dukascopy; stable drawing keys and auto-reload.
6. Tests for time, session, aggregation, MT5 parsing and data.

**Strategy engine (v2).**

7. Eight-factor, 6,144-run grid with stable run ids.
8. Level books from completed daily/weekly open/close candles; next-day
   readiness; duplicate merge.
9. Vectorised touch generation (two variants) + Numba exit walk with 64-bar
   block skipping.
10. Session/lookback/type/entry/tpd filters; one trade per level per day.
11. Metrics (expectancy, PF, drawdown, MAE/MFE, retrace, streaks, hourly,
    weekday, equity) and a factor table.
12. Resumable grid runner: NPZ bar/event caches, atomic JSON, progress with ETA,
    per-file results, two-level staleness stamps.
13. Audit-day replay with a reason for every skipped touch, cross-checked
    against the fast engine.
14. Trade CSV export with instrument-correct price text.

**Browser report.**

15. Runs table (filter, search, sort, stars, paging, expandable detail,
    sparklines), Factors tab, Audit-day tab with a zoomable canvas chart.
16. Run buttons (missing / all / filtered / single), live status polling,
    per-file favourites, font scaling, CSV file selector.

**Multi-instrument.**

17. US100, GBPUSD and XAUUSD scaling; per-stem results; server and report
    currency of the selected instrument; verified gold 2-dp precision.

**Live trading.**

18. `LevelRetrace.mq4`: continuation/touch EA with pending stops, daily gates,
    server-offset input, state file, trade journal, status panel.
19. Headless MetaEditor compile recipe and `verify_ea_model.py`, which proves
    the EA's clock, DST and level arithmetic equal the engine.

The Risk Factor page was built later and is deliberately excluded here.

---

## 2. Non-negotiable rules

1. **CSV timestamps are UTC.** Parse them as UTC. Never reinterpret the file as
   local or server time.
2. **Never hardcode a UTC offset for a market session.** Use IANA zones
   (`America/New_York`, `Europe/London`, `America/Chicago`) via `zoneinfo` or
   `Intl`. DST is a rule, not a constant. The only fixed offset allowed is the
   EA's `InpServerGmtOffset`, which is a bridge from broker server time to UTC.
3. **Never change OHLCV values.** No adjustment, no resampling stored back, no
   filling. Levels are built from the untouched bars.
4. **Never use the CSV's spread column.** The model uses a fixed **1.3 strategy
   points** spread. Bid = bar close; ask = bid + 1.3 points.
5. **Do not run the full grid unless the user asks.** The user triggers runs from
   the UI. A health check must be read-only.
6. **Keep results per CSV file.** Everything lives under
   `results/<csv-stem>/`; switching files must never recompute or overwrite
   another file's results.
7. **Do not mix strategy analysis with risk analysis.** Separate folders,
   scripts, results and endpoints. (Already true; keep it that way.)
8. **Instrument decimals matter.** GBPUSD 5 dp (point = 0.0001 = 1 pip), XAUUSD
   2 dp (point = 0.10, so 50 points = 1900.00 → 1905.00), US100 2 dp
   (point = 1.0). Prices in exports must be text with the instrument's decimals.
9. **Do not bypass the two-level staleness stamps** when changing behaviour:
   `CACHE_VERSION` rebuilds bars/events; `RULES_VERSION` only invalidates the
   results that read a changed rule.

---

## 3. Repository map

```
D:\TradingView2\
├─ server.js                     Node static server + JSON API (1284 lines)
├─ package.json                  only dependency: lightweight-charts
├─ data\                         input M1 CSVs (tab-separated MT5 exports)
├─ public\                       chart app (no build step)
│  ├─ index.html                 shell, Strategy/Risk buttons
│  ├─ css\app.css
│  └─ js\
│     ├─ app.js                  UI wiring, replay, data loading
│     ├─ chartView.js            Lightweight Charts wrapper
│     ├─ dataWorker.js           streaming parse + timeframe aggregation
│     ├─ csvParse.mjs            CSV tokenizer
│     ├─ csvFormat.mjs           MT5 vs Dukascopy format detection/formatting
│     ├─ session.mjs             market calendar rules
│     ├─ time.mjs                IANA time-zone helpers
│     ├─ aggregate.mjs           bar aggregation
│     └─ drawings.js             drawing tools
├─ vendor\                       lightweight-charts
├─ tests\                        node tests (time, session, aggregate, mt5, data)
├─ tools\
│  ├─ mt5_fetch.py               fetch missing MT5 bars
│  └─ strategy-health.sh         read-only health check (this handoff)
├─ docs\
│  └─ AGENT-HANDOFF-strategy-app.md
└─ analysis\nasdaq-level-retrace-v2\
   ├─ config.py                  grid, instruments, sessions, versions
   ├─ data.py                    CSV reader + session clocks + bar cache
   ├─ levels.py                  daily/weekly candles -> level records
   ├─ events.py                  touch events + Numba exit walk
   ├─ metrics.py                 per-run metrics + factor table
   ├─ run.py                     CLI/orchestrator (grid, audit, trades)
   ├─ site\                      report page (index.html, report.js, style.css,
   │                             definitions.html)
   ├─ mt4\
   │  ├─ LevelRetrace.mq4        Expert Advisor (source of record)
   │  ├─ compile.sh              headless MetaEditor build
   │  ├─ verify_ea_model.py      proves EA clock/level math == engine
   │  └─ README.md               EA deployment and tester recipe
   └─ results\
      ├─ cache\                  bar + event NPZ caches (safe to delete)
      └─ <csv-stem>\             summary.json, progress.json, favourites.json,
                                 audit\*.json, trades\*.csv, queue.txt
```

`analysis/nasdaq-level-retrace/` is the **old v1** work (plots, old reports). It
is not part of the running app; do not wire it in.

---

## 4. Environment

- Windows 10/11, Git Bash. Node has no build step; this machine's Git Bash
  reports **v14.20.0**, which is what currently serves the app. Python 3.13.
- Python packages: `numpy`, `pandas`, `numba` (measured here: numpy 2.4.2,
  pandas 3.0.3, numba 0.68.0). Numba `cache=True` writes `.npy`/`.nbi` files in
  `__pycache__`; that is normal.
- Server: `node server.js` from `D:\TradingView2`, listens on **8080**.
  - `PORT` override; `STRATEGY_PYTHON` (or `MT5_PYTHON`) points at `python.exe`
    if `python` is not on PATH.
- MT4 (optional, for the EA):
  - Program: `C:\Program Files (x86)\LiteFinance VC MT4 Terminal\`
  - Data folder:
    `C:\Users\TharHtwe\AppData\Roaming\MetaQuotes\Terminal\DBED2B1AA5190ECE30AE5FCFF29920C2\`
  - Installed EA: `...\MQL4\Experts\LevelRetrace.mq4` + `.ex4`.

---

## 5. Quick start

```bash
cd /d/TradingView2
npm start                 # or: node server.js
# open http://localhost:8080/
```

Pages:

| URL | What |
| --- | --- |
| `http://localhost:8080/` | chart app |
| `http://localhost:8080/strategy/` | strategy report |
| `http://localhost:8080/api/strategy/files` | datasets and computed flags |

Run the health check (does not start any backtest):

```bash
bash tools/strategy-health.sh
```

Command-line engine (optional; the UI does the same):

```bash
cd analysis/nasdaq-level-retrace-v2
python run.py --all                       # all 6,144 combinations (slow)
python run.py --run sl50_tp50_ny_lveth_cont_touch_1m_serial
python run.py --ids id1,id2 --force
python run.py --audit sl50_tp50_ny_lveth_cont_touch_1m_serial --day 2026-10-29
python run.py --export-trades sl50_tp50_ny_lveth_cont_touch_1m_serial
python run.py --file GBPUSD_M1_202001020600_202610300618.csv --all
```

---

## 6. Data contract

### 6.1 Input CSV

MT5 export, tab separated, header starts `<DATE> <TIME> <OPEN> ...`:

```
<DATE>	<TIME>	<OPEN>	<HIGH>	<LOW>	<CLOSE>	<TICKVOL>	<SPREAD>	<VOL>
2026.10.29	13:59:00	...
```

- Timestamps are **UTC**, format `%Y.%m.%d %H:%M:%S`.
- Sorted and de-duplicated by timestamp on load; OHLC untouched.
- Prices are **bid**.
- The `SPREAD` column is ignored.
- `data.py:29` (`_read_csv`) is the only reader.

### 6.2 Instruments

Keyed by the CSV stem prefix (before the first `_`), `config.py:26`:

| Prefix | Name | point | decimals | mark | rth_skip_open |
| --- | --- | --- | --- | --- | --- |
| `US100` | US100 (Nasdaq) | 1.0 | 2 | NQ | **true** |
| `GBPUSD` | GBPUSD | 0.0001 (1 pip) | 5 | GP | false |
| `XAUUSD` | XAUUSD (Gold) | 0.10 | 2 | AU | false |

Unknown prefixes fall back to point 1.0 / 2 dp. Add new instruments in
`config.INSTRUMENTS` **and** `STRATEGY_INSTRUMENTS` in `server.js` (display copy).

### 6.3 Integer price scale

Everything in the engine is integer price steps:

```
SCALE          = 10 ** decimals          # 100 US100/XAU, 100000 GBPUSD
STEPS_PER_POINT= point * SCALE           # 100 US100, 10 XAU, 10 GBPUSD
SPREAD_C       = round(1.3 * point * SCALE)
```

`run.use_file()` (run.py:68) calls `events.set_scale()` and
`levels.set_scale()` so one process can analyse any instrument. If you add an
instrument, these two calls are mandatory.

For US100, 1 strategy point = 1 index point. For gold, 1 point = 0.10 price.
For cable, 1 point = 1 pip.

---

## 7. Strategy model (v2)

### 7.1 Levels

- Daily and weekly candles are built from **completed** candles of the chosen
  level session (`levels.candles`, levels.py:71):
  - `all` — every bar, grouped by the **electronic market day** (18:00 New York
    opens the next day);
  - `eth` — 18:00–17:00 New York only (drops the 17:00–18:00 break);
  - `rth` — 09:30–16:00 New York, grouped by New York date.
- Every daily and weekly candle contributes its **open and close**.
- A daily candle becomes tradeable on the **next trade day**; a weekly candle
  only once a candle of a later week exists. No look-ahead.
- Equal prices merge into one level; the age is the newest source candle.
- Weekly week starts Sunday (`data.week_start`).

Implementation: `levels.build_records()` (levels.py:91), `levels.iter_books()`
(levels.py:142). The active book for a day is cursor-driven, not rebuilt per day.

### 7.2 Events (touches)

`events.generate()` (events.py:110) walks each in-session bar as four path
segments, using the previous close as the start of segment 0:

```
prev_close -> open          (gap segment)
open       -> low  (bull) / high (bear)
             high (bull) / low  (bear)
             close
```

For every segment it finds all active levels crossed, in path order, for two
variants:

- **sell** trigger: bid reaches the level (`shift = 0`);
- **buy** trigger: bid reaches `level - 1.3 points` because the buy pays the ask.

An event stores `bar`, `seg`, `dir`, `variant`, `cents` (the level), `lday`
(level age), `fill` (trigger bid, or the gap open), `rank` (path order) and
`day` (New York date). Events are packed into NPZ per level session and reused
by every run of that session.

`rank` orders touches inside a bar; it is what makes serial/one-a-day modes
deterministic.

### 7.3 Entry, exits, P&L

`events.walk()` (events.py:214) resolves the first stop/target on the **bid
path**, starting at the trigger bid (not at the level). Segment order inside a
bar is open → first extreme → second extreme → close, identical to MT4 "every
tick" OHLC reconstruction.

- Touch entry: `side` from variant; `value = trigger + spread` for a buy
  (ask), `value = trigger` for a sell. `pnl = side * (exit_bid - value)`.
- Confirmation entry: enter at the entry bar's close if it is beyond the level;
  a close exactly on the level is not tradeable.
- Stop/target are symmetric around `value`, in points.
- A buy therefore nets exactly the target after paying the spread at entry; a
  short is **never charged the spread in the engine**. This is a known model
  gap versus a live MT4 short (see §10.6).
- If neither is hit, exit is the last close (`kind = 2`, "end of data").
- MAE/MFE are measured from `value` along the walk.

`events.resolve()` (events.py:323) runs this for every event of one
`(entry, sl, tp)` combination; it is vectorised over events but the walk is
serial per event (Numba).

### 7.4 Filters and trade-per-day modes

`events.base_mask()` (events.py:360) applies each run's fixed filters:

- trading session: London 08:00–16:30 London, New York 08:00–17:00 NY, RTH
  09:30–16:00 NY, or London-or-New York;
- level lookback: 30 / 182 / 365 days or all history, measured from the level
  candle's date to the trade's New York date;
- trade type: `rev` (fade) or `cont` (continuation), implied by side vs crossing
  direction;
- entry: `touch` or `confirm`;
- US100-only rule: a New York **RTH** run never enters in the 09:30–09:31 NY
  bar (`rth_skip_open`). GBPUSD/XAUUSD are unaffected. Only `session=rth` sees
  it; events stay shared.

Trade-per-day modes (`tpd`):

| Mode | Rule |
| --- | --- |
| `every` | every selected event, but one trade per level per day |
| `serial` | one position at a time |
| `one` | one trade per day (first selected event) |
| `until` | keep trading until the day's realised points reach the target |

One level still gives at most one trade per day in every mode.
Implementations: `events.pick_first_per_level`, `pick_first_per_day`,
`events.simulate_serial`.

### 7.5 Run id grammar

```
sl{50|100}_tp{50|100|150|200}_{london|ny|rth|all}_lv{all|eth|rth}_{rev|cont}_{touch|confirm}_{1m|6m|1y|all}_{every|serial|one|until}
```

Example: `sl50_tp50_ny_lveth_cont_touch_1m_serial`.

Grid size = 2 × 4 × 4 × 3 × 2 × 2 × 4 × 4 = **6,144**.

---

## 8. Engine files in detail

### `config.py`

| Item | Line | Note |
| --- | --- | --- |
| `DEFAULT_CSV` | 18 | the US100 2020–2026 file |
| `INSTRUMENTS` | 26 | point, decimals, mark, rth_skip_open |
| `SPREAD` | 61 | 1.3 points |
| factor tuples | 63–70 | stops, targets, sessions, level sessions, types, entries, lookbacks, tpd |
| `FACTORS` / `LABELS` | 83–126 | display labels used by the engine and report |
| `LONDON` / `NEW_YORK` / `NY_RTH` | 131–133 | local windows, start inclusive / end exclusive |
| `ETH_OPEN_MIN` / `ETH_CLOSE_MIN` | 138–139 | 18:00 / 17:00 New York |
| `CACHE_VERSION` | 75 | bump to rebuild bars/events |
| `RULES_VERSION` | 81 | bump to invalidate only affected stored results |

`CACHE_VERSION = 4`, `RULES_VERSION = 2` today.

### `data.py`

- `_read_csv` (29): pandas read, UTC parse, sort, de-duplicate.
- `build_clocks` (60): New York/London day, minute-of-day, weekday, ETH day,
  week start, session masks (`in_lon`, `in_ny`, `in_rth`, `in_all`, `in_break`).
- `load` (107): NPZ bar cache keyed by MD5 of the absolute path; metadata JSON
  carries path, size, mtime, `CACHE_VERSION`. A mismatch rebuilds.

### `levels.py`

- `set_scale` (28), `aggregate` (35), `aggregate_weekly` (54), `candles` (71).
- `build_records` (91): every level with `cents`, `kind` (1 daily, 2 weekly),
  `part` (open/close), `day`, `ready` (first trade day it is active), `label`.
- `iter_books` (142): active book per trade day, prices sorted, duplicates
  merged, newest age kept.

### `events.py`

- `set_scale` (37), `bar_cents` (48), `prepare_blocks` (53: 64-bar min/max
  blocks for the exit walk).
- `_crossings` (58): vectorised level crossings on one segment.
- `generate` (110): per NY day, four segments, two variants, sort by
  `(bar, rank)`.
- `_walk_segment` (180), `walk` (214): Numba exit walk with block skipping.
- `resolve` (323): all events for one `(entry, sl, tp)`.
- `base_mask` (360), picks (396–435), `simulate_serial` (438).

### `metrics.py`

`compute()` (97) returns:

```
trades, wins, losses, win_rate, net_points, expectancy,
profit_factor, profit_factor_without_best, max_drawdown,
max_drawdown_trades, payoff, avg_win, avg_loss, longs, shorts,
long_net, short_net, targets, stops, forced, chunks,
autocorrelation, streaks, hold, daily, excursion, hourly, weekday,
equity, period
```

Definitions that are easy to get wrong:

- A win is `points > 0`; a zero counts as a loss in `win_rate`/`losses`, but not
  in the profit factor.
- Equity is cumulative net points on **one contract**, in trade order.
- `max_drawdown` is the peak-to-following-trough of that trade-order curve.
- `retrace` shown in the report is `excursion.winners_mae_avg`: how far winners
  went against the entry before reaching target.
- `profit_factor_without_best` removes the single best trade.
- `daily` groups by New York date; `hourly` uses the UTC hour of the entry bar;
  `weekday` is 0–6 of the New York date.
- `equity` is downsampled to 160 points for the sparkline.

`factor_table()` (280) gives mean/median/best/worst net points per option.

### `run.py`

- `use_file` (68): switch CSV + instrument; the only place that mutates globals.
- `data_sig` (120): `{file, stem, size, mtime, version, rules}`.
- `rule_affected` (132): only `session=rth` runs on an instrument with
  `rth_skip_open` depend on the current rule bump.
- `Engine` (159): holds bars/clocks, caches events/masks/picks per level
  session; `events()` (183) loads or builds NPZ.
- `execute` (346): resumable orchestration. Loads previous `summary.json` only
  when file name **and** mtime match; drops rule-affected entries; sorts by
  level session so each event cache is built once; writes progress every 10
  runs, summary every 60 s, final summary + progress in `finally`.
- `write_summary` (444): atomic JSON with `meta`, `runs`, `factors`.
- `audit` (530): one run, one day; replays every event with the decision reason
  and returns bars, levels and rows. It also cross-checks the fast selection
  against a per-event replay (`consistent`).
- `replay_day` (656): carries serial/until state from earlier days into the
  audited day.
- `export_trades` (753): CSV columns are in `CSV_COLUMNS` (738).
- `main` (836): CLI.

Atomic writes retry `os.replace` on `PermissionError` up to 40 times because
Windows scanners briefly hold the target (`_atomic_json`, run.py:100).

---

## 9. Result artefacts

Per CSV stem, under `analysis/nasdaq-level-retrace-v2/results/<stem>/`:

| File | Content |
| --- | --- |
| `summary.json` | `{meta:{sig,instrument,spread,audit_day,configs,built,runs}, runs:[{id,cfg,metrics}], factors}` |
| `progress.json` | `{running,done,total,run,elapsed,seconds_per_run,eta_seconds,updated[,error]}` |
| `favourites.json` | `{ids:[run ids], updated}` |
| `queue.txt` | ids written by the server for an `--ids-file` run |
| `audit/<run>_<YYYY-MM-DD>.json` | `{run,cfg,day,consistent,bars:[[ts,o,h,l,c]],levels:[{price,color,sources}],rows:[...],counts}` |
| `trades/<run>.csv` | one row per trade, 19 columns (see below) |

Trade CSV columns (`run.py:738`):

```
seq, entry_utc, ny_date, side, trade_type, entry_mode, level_price,
level_kind, level_source, fill, stop, target, exit_utc, exit_kind,
points, mae_pts, mfe_pts, bars_held, retrace_of_stop_pct
```

Prices are text with the instrument's decimals (gold `1565.50`, cable
`1.31381`); a float would drop the trailing zero.

Shared cache, `results/cache/`:

- `bars_<md5>.npz` + `.json` — bars and clocks.
- `events_<stem>_<lvl>_<size>_<mtime>_<version>.npz` — packed touch events.

Deleting `cache/` is safe; the first run of each level session rebuilds it.
The event cache build dominates cost: warm 6,144 runs measured at **886 s**;
cold GBPUSD ETH cache took about **35 min**. Do not delete caches casually.

---

## 10. Browser report (`site/`)

Static, no build step, plain ES5/ES2017 JS. `report.js` is ~1,667 lines.

### 10.1 Layout

- Header: file selector, **Run missing**, **Re-run all**, **Run filtered**,
  **Refresh**, **Definitions**, A−/A+/reset, status dot + progress bar.
- Tabs: **Runs**, **Factors**, **Audit day**.
- Runs: 8 filter groups with live counts, search, favourites-only, hide-not-run,
  table of 21 columns, expandable detail row, 300-row paging.
- Factors: one table per factor, computed on the currently filtered rows.
- Audit day: run input + date, canvas chart (weekly gold, daily sky, buy/sell
  touches, filled ring = taken), touch table with decision reasons, trades CSV.

### 10.2 Behaviour

- `buildRows()` (197) enumerates all 6,144 ids from the factor lists, then joins
  computed results. Not-run rows still show and can be filtered out.
- Sorting: click a header; `null` sorts last; `retrace` maps to
  `excursion.winners_mae_avg`, `hold` to `hold.avg_bars`, `equity` to the last
  equity point.
- Filters: each group can be toggled with its "all" button; counts are computed
  with the other filters applied.
- Favourites: optimistic star, `POST /api/strategy/favourites`, localStorage
  fallback if the server is unreachable.
- Font scale: 0.9–2.0, key `nq-font-scale-v2`, click the percentage to reset.
- File choice: localStorage key `nq-data-file-v1`.
- Polling: `pollStatus()` (1404) every 2 s while running, 12 s idle; on
  running→idle it toasts success/failure and reloads `summary.json`.
- Staleness: server compares the CSV size/mtime with `meta.sig`; a notice tells
  the user to press **Run missing**.
- Audit chart: custom canvas with wheel zoom, drag pan, double-click reset
  (`AuditChart`, 977). Clicking a table row centres the day's bar.
- The audit default run is the first favourite that exists, else the last
  computed run; the default day comes from `meta.audit_day` (last New York day
  with NY session bars, so a half-finished day is not offered).

### 10.3 Definitions

`site/definitions.html` is the user-facing explanation of metrics and fills.
Keep it in sync when a metric changes.

---

## 11. Server API (`server.js`)

### 11.1 Strategy section

Constants at 17–23; helpers at 520–591; spawn at 814–873; run queue at 875–958.

| Method | Path | Body/query | Returns |
| --- | --- | --- | --- |
| GET | `/api/strategy/files` | — | `{files:[{name,stem,size,mtime,instrument,default,computed}], default}` |
| GET | `/api/strategy/summary` | `?file=` | summary plus `stale`, `instrument`, `file`, `files` |
| GET | `/api/strategy/status` | `?file=` | `{running,job:{kind,label,file,started,total,output[]},queue,progress}` |
| GET | `/api/strategy/favourites` | `?file=` | `{ids,updated}` |
| POST | `/api/strategy/favourites` | `{file,id,favourite}` | updated favourites |
| POST | `/api/strategy/run` | `{file, all:true, force?}` or `{file, ids:[...], force?}` | `{started,label,total}` |
| GET | `/api/strategy/audit` | `?file&run&day` | audit JSON (404 if not built) |
| POST | `/api/strategy/audit` | `{file,run,day}` | builds then streams the audit JSON |
| GET | `/api/strategy/trades` | `?file&run[&download=1]` | trade CSV |
| POST | `/api/strategy/trades` | `{file,run}` | `{ok,rows,url}` after building |

Guards:

- `RUN_ID_RE` (21) and `DAY_RE` (22) validate every run/day.
- `strategyFile` (542) accepts only a basename, `.csv`, existing inside `data/`.
  The stem becomes a directory name under `results/`; this guard prevents path
  traversal.
- Only MT5 CSVs (`<DATE>` in the first 512 bytes) are listed.

Concurrency:

- **One grid run at a time**; a second returns 409.
- Audit/trade jobs share a single queue (`strategy.tool`) and may run beside a
  grid because they touch different files.
- `spawnPython` pipes stdout/stderr into a rolling 200-line buffer and kills the
  child after `timeoutMs` (tools default 300 s).
- `sendSummary` catches missing `summary.json` and returns an empty shell so the
  report can still render the grid and offer **Run missing**.

Static routes: `/strategy` → 302 `/strategy/`; `/strategy/*` served from
`site/`. Chart data: `GET /api/files`, `GET /api/data/<name>`,
`POST /api/update/<name>`.

### 11.2 What not to touch

`RISK_DIR`, `RISK_*`, `riskStatus`, `sendRiskResults`, `/api/risk/*`, `/risk/*`.
They share `spawnPython` only.

---

## 12. Host chart app

- `public/index.html` + `public/js/app.js`: data file selector, Open CSV,
  Update data, timeframes, IANA time zone, session mode (Full / ETH / Cash),
  goto/latest, Replay, drawing tools, **Strategy** button.
- Data formats detected by `public/js/csvFormat.mjs`: Dukascopy epoch CSV or MT5
  tab-separated export. CSV is streamed and parsed incrementally; a Web Worker
  aggregates timeframes.
- Session modes **rebuild all timeframes from filtered bars** — they do not just
  visually mask bars. Cash = 09:30–16:00 New York; ETH = 18:00–17:00 New York.
- `Strategy` opens `/strategy/` in a new tab (`app.js:1438`).
- Tests: `npm test` → `node tests/run.mjs` (time zones, sessions, aggregation,
  MT5 parsing, data). They do not touch Python or results.

---

## 13. MetaTrader 4 Expert Advisor

Source of record: `analysis/nasdaq-level-retrace-v2/mt4/LevelRetrace.mq4`
(~1,890 lines, one file, `#property strict`). Read `mt4/README.md` first.

### 13.1 Scope

Implements **continuation + touch only**, with daily/weekly open-close levels,
stop/target/session/level-session/lookback/tpd inputs. It does **not**
implement `rev`, `confirm`, or the `all` trading session.

### 13.2 Clock rules

- `InpServerGmtOffset` = **server time minus UTC**, in hours.
- Live chart: `-99` detects `TimeCurrent() - TimeGMT()` once and logs it.
- Strategy tester: there is no GMT clock, so an explicit number is mandatory.
- Session boundaries are then computed from the **zone's DST rule**, not from
  that offset.
- Check the panel `server UTC+n` / `NY UTC-n` lines and the start log.
- LiteFinance here was **UTC+2** on 2026-11-02. Do not assume it stays +2 across
  the broker's own DST changes; verify from the panel.

### 13.3 Inputs that matter

`InpLots`, `InpPricePer50Points` (gold 5.0, US100 50.0, cable 0.005; 0 = auto),
`InpModelSpreadPts` 1.3, `InpTargetPoints` 50, `InpStopPoints` 50,
`InpSession`, `InpLevelSession`, `InpLookback`, `InpTradesPerDay`,
`InpServerGmtOffset`, `InpCheckAlignment`, `InpMaxPendingBuys/Sells`,
`InpLevelBandPoints`, `InpLevelHistoryDays`, `InpLevelBarMinutes`,
`InpArmSeconds`, `InpMagic`, `InpTag`, `InpShowPanel`, `InpWriteCsvLog`.
Full table in `mt4/README.md`.

### 13.4 Build (headless)

```bash
cd /d/TradingView2/analysis/nasdaq-level-retrace-v2/mt4
bash compile.sh
```

`compile.sh` copies the source into `MQL4\Experts` and runs:

```powershell
Start-Process metaeditor.exe -ArgumentList '/compile:"<abs .mq4>"','/log:"<abs .log>"' -Wait
```

The log is **UTF-16LE**; decode with
`iconv -f UTF-16LE -t UTF-8 | tr -d '\000'`. Accept only `0 errors, 0 warnings`.
A stale `.ex4` looks fine — check its timestamp.

### 13.5 Install / run

1. `MQL4\Experts` must contain `LevelRetrace.mq4` + current `.ex4`.
2. In MT4: **Tools → Options → Expert Advisors → Allow Automated Trading** must
   be checked. This is terminal-level, separate from the EA's own
   "Allow live trading".
3. Attach to an **M1** chart of the symbol; tick "Allow live trading"; file
   operations allowed for the state/journal files.
4. Read the start log line: point size, modelled spread, candles, book size,
   server offset. Stop if any is wrong.
5. State file `MQL4\Files\LR<magic><symbol>.state`; trade journal
   `LR_<symbol>_<magic>.csv` with columns
   `closed_server, ticket, side, lots, level, entry, exit, points, money, note`.

Broker symbol names here: `NQ` (Nasdaq CFD, 1 dp), `SPX`, `XAUUSD` (2 dp),
`GBPUSD` (5 dp). `NQ ≈ US100` price levels.

### 13.6 Tester recipe

For `sl50_tp50_ny_lveth_cont_touch_1m_serial`:

```
InpLots 0.10
InpPricePer50Points 5.0 (gold) / 50.0 (US100) / 0.005 (cable)
InpTargetPoints 50  InpStopPoints 50  InpModelSpreadPts 1.3
InpSession New York  InpLevelSession ETH  InpLookback 1 month
InpTradesPerDay One at a time
InpServerGmtOffset 2  InpLevelBarMinutes 60
```

- Model **Every tick** — it reconstructs the same open→extreme→extreme→close
  path as the engine. "1 minute OHLC" will not reproduce touch entries.
- Fixed tester spread in tester points:
  `1.3 * (pricePer50 / 50) / Point` → **13** on gold, US100 (`NQ`) and cable.
- The tester only feeds bars inside the range; the level book needs
  `lookback + 120` days of history. Start earlier and treat the warm-up as
  unscored.
- Close the terminal before launching a second `terminal.exe` against the same
  data folder; they fight over history files.

### 13.7 Verify the EA against the engine

```bash
cd analysis/nasdaq-level-retrace-v2
python mt4/verify_ea_model.py --file XAUUSD_M1_202001020600_202610300854.csv \
        --offset 2 --days 120 --trades sl50_tp50_ny_lveth_cont_touch_1m_serial
```

It checks the New York/electronic day, the session windows for every hour, DST
boundaries 2020–2026, and the level book of every checked trade day.

### 13.8 Known model differences (do not "fix" silently)

1. The engine never charges a short the spread; live MT4 shorts pay one. On
   `sl50_tp50_ny_lveth_cont_touch_1m_serial` this was 5,391 of 15,700 net points
   (34%). Changing it means charging `SPREAD_C` on a short exit and re-running
   the whole grid — get user approval first.
2. Real spread differs from the modelled 1.3 points.
3. Broker `MODE_STOPLEVEL`/`MODE_FREEZELEVEL` can push entries/exits away.
4. The tester tick path is synthetic.
5. Broker H1/M30 candles can differ slightly from the CSV feed.
6. Gaps fill at the open, not at the level.
7. Some brokers shift their own clock with US DST; set the offset per range.
8. Margin, swap and contract size are not modelled.
9. The EA tracks at most 64 tickets and applies a level band; the engine has no
   such limits.

---

## 14. Verification checklist

Run these in order after any change:

```bash
cd /d/TradingView2

# 1. Node tests (no Python, no grid)
npm test

# 2. Read-only environment/results health
bash tools/strategy-health.sh

# 3. Server up and report reachable
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/strategy/

# 4. Datasets and computed flags
curl -s http://localhost:8080/api/strategy/files

# 5. One run, forced, as a smoke test (a few seconds; safe)
cd analysis/nasdaq-level-retrace-v2
python run.py --run sl50_tp50_ny_lveth_cont_touch_1m_serial --force
```

Expected current state:

- `/api/strategy/files` lists 5 CSVs; 3 are `computed: true`
  (US100 2020–2026, GBPUSD, XAUUSD), the US100 2017 file is not run, and the
  Dukascopy-named file is not listed because it is not an MT5 export.
- Each computed `summary.json` has **6,144** runs and `audit_day` `2026-10-29`.
- `/strategy/` renders 6,144 rows (not all computed for unrun files), status
  `idle · 6,144 of 6,144 computed` for a computed file.

---

## 15. Known failure modes and fixes

| Symptom | Cause | Fix |
| --- | --- | --- |
| EA does nothing; Experts log only shows `uninit reason 5` | reason 5 is a normal parameter-change restart; trading may still be off | check **Tools → Options → Expert Advisors → Allow Automated Trading** |
| No `could not place ...` log when AutoTrading is off | `SendStop()` retries on `!IsTradeAllowed()` and returns silently (LevelRetrace.mq4:1000–1032) | enable AutoTrading; optionally make this path log once |
| EA trades at the wrong hours / level book has 415 daily candles instead of 344 | `InpServerGmtOffset` wrong (e.g. `-5` instead of `+2`/`-99`) | set `-99` live, explicit correct offset in the tester, re-attach |
| Report says "No summary.json yet" | file never run | press **Run missing** |
| Stale-results notice | CSV size/mtime changed | **Run missing** (recomputes only the invalidated file) |
| Grid appears to hang on the first run of a level session | event cache build | wait; do not kill. Warm grid is ~15 min, cold cache can be ~35 min |
| `Python not found` | `python` not on PATH | `STRATEGY_PYTHON=C:\path\to\python.exe npm start` |
| Port 8080 in use | another server | `PORT=8081 npm start` |
| `summary.json is not valid JSON` | partial/corrupt write | keep the `.bak`, re-run; atomic writes retry Windows locks |
| Audit shows fewer trades than detail | wrong day outside session bars | use the default `meta.audit_day` (last full NY day) |
| Favourites vanish | server file missing/unwritable | report falls back to localStorage; check `results/<stem>/favourites.json` |
| MT4 tester conflicts / history files locked | terminal open while launching a second instance | close the terminal or press Start in the GUI |
| Gold/cable prices lose a trailing zero in exports | float formatting | use `px_text()` / instrument decimals, never raw `float` |

---

## 16. How to extend safely

### Add a dataset

1. Drop an MT5 tab-separated M1 CSV into `data/` named `<PREFIX>_M1_....csv`.
2. If the prefix is new, add it to `config.INSTRUMENTS` and
   `STRATEGY_INSTRUMENTS` in `server.js`.
3. Open `/strategy/`, select it, press **Run missing**. Results go to
   `results/<stem>/`; no other file is touched.
4. `CACHE_VERSION` does not need a bump for a new file.

### Change a run rule (filters, tpd, sessions)

1. Change `run.py`/`events.py`/`config.py`.
2. Bump `RULES_VERSION` only if stored results depend on it; implement
   `rule_affected()` so **Run missing** recomputes only the affected runs.
3. If the change is in cached events or bars, bump `CACHE_VERSION` and expect a
   cold cache build.

### Add a factor

This changes the id grammar and the grid size. You must update, together:
`config.FACTORS`, `config.iter_configs`, `config.config_id`/`parse_id`,
`config.combo_count`, `RUN_ID_RE` in `server.js`, `FACTORS`/`COLUMNS` in
`report.js`, and the definitions page. Existing `summary.json` ids will no
longer match; expect a full rebuild.

### Add a metric

1. Compute it in `metrics.compute()`.
2. Add it to the report's `COLUMNS` and/or the detail row.
3. Explain it in `site/definitions.html`.
4. Old summaries lack the key; the UI must tolerate `null`. Recompute only if
   the metric must be backfilled.

### Change the EA

1. Edit `mt4/LevelRetrace.mq4`.
2. Compile with `bash mt4/compile.sh`; require 0 errors/0 warnings.
3. Re-run `verify_ea_model.py`.
4. Copy to `MQL4\Experts` (compile.sh does it) and re-attach.

---

## 17. Current state snapshot (2026-11-05)

- Server reachable at `http://localhost:8080/`; `/strategy/` returns 200.
- Computed grids:
  - `US100_M1_202001020105_202610291406.csv` — 6,144 / 6,144
  - `GBPUSD_M1_202001020600_202610300618.csv` — 6,144 / 6,144
  - `XAUUSD_M1_202001020600_202610300854.csv` — 6,144 / 6,144
- Audit day for all three: `2026-10-29`.
- `US100_M1_201710040100_202610291359.csv` is present but **not run**.
- Cache is warm for all three instruments and all three level sessions.
- EA source and `.ex4` are installed in the LiteFinance MT4 data folder.
- Last observed EA input set had `InpServerGmtOffset=-5`, which is wrong for
  this broker (server is UTC+2 in winter). If it is still `-5`, fix it before
  trusting live/test trades.

---

## 18. Copy-paste brief for a fresh agent

> You are working in `D:\TradingView2`, a Node + Python trading analysis app.
> Read `docs/AGENT-HANDOFF-strategy-app.md` first; it is the contract.
> The strategy engine is `analysis/nasdaq-level-retrace-v2`; the report is its
> `site/`; the host chart app is `public/`; the server is `server.js`; the MT4 EA
> is `mt4/LevelRetrace.mq4`.
>
> Hard rules: CSV timestamps are UTC; use IANA zones, never fixed offsets;
> never alter OHLCV; ignore the CSV spread column (fixed 1.3-point spread);
> keep every CSV's results under `results/<csv-stem>/`; do not run the full grid
> unless asked; GBPUSD 5 dp, XAUUSD 2 dp, US100 2 dp.
>
> Do not modify the Risk Factor page (`analysis/risk-factor`, `/risk/`,
> `/api/risk/*`).
>
> Before changing anything, run `npm test` and `bash tools/strategy-health.sh`.
> After a change, verify the affected path end-to-end and report exact commands
> and results. Prefer editing existing files; no new frameworks or build steps.
