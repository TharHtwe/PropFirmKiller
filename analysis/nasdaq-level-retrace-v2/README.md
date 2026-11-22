# Nasdaq level-retrace v2

Daily and weekly level touches on US100 (Nasdaq) 1-minute data. The grid is
6,144 combinations, plus a second copy of each US100 New York RTH run that
includes the 09:30 bar, plus a New York-only copy that skips 08:30-08:32
(9,216 on US100). Fixed 1.3-point spread, Python engine
plus a browser report.

## Data and price model

- Input: `data/US100_M1_202001020105_202610291406.csv` (MT5 export, timestamps UTC).
- Bid = close of the minute bar. Ask = bid + 1.3. The spread column in the CSV is ignored.
- Touch fills at the level (a buy when the ask reaches it). A 1-minute close fills
  at the signal candle's close, plus 1.3 on a buy, and the stop and target are
  measured from that fill. Continuation needs the candle body to close through
  the level. Reversal needs a prior close beyond the level and then a close back
  through it. A wick that does not close through the level is not an entry.
- Levels come only from completed daily and weekly candles. A candle becomes a
  level on the next trade day, so no future data leaks into a touch.
- Candle grouping (`Level session` factor):
  - `all` every bar, grouped by the electronic market day (18:00 New York open);
  - `eth` 18:00-17:00 New York only (drops the 17:00-18:00 feed break);
  - `rth` 09:30-16:00 New York only, grouped by New York date.
- Trade sessions (`Trading session` factor), New York / London local time:
  London 08:00-16:30, New York 08:00-17:00, RTH 09:30-16:00.
- **Cash open** is a run option, Skip 09:30 or Include 09:30. On US100 a New York
  RTH run is listed twice. The original id skips the 09:30-09:31 New York bar.
  The same id with `_keep` includes it. London, New York and All already include
  that minute, so they stay one row. GBPUSD and XAUUSD have no skip. The level
  events are shared; the option is only an entry filter.
- **NY open** is a separate option for the New York-only session. On US100 that
  session is listed twice. The original id includes 08:30 and 08:31 New York.
  The same id with `_skip` drops those two minutes and keeps 08:32. The clock
  is America/New_York, so the window follows daylight saving. RTH, London and
  All are not affected. GBPUSD and XAUUSD have no skip.

## Run ids

`sl{50|100}_tp{50|100|150|200}_{london|ny|rth|all}_lv{all|eth|rth}_{rev|cont}_{touch|confirm}_{1m|6m|1y|all}_{every|serial|one|until}`

A US100 RTH run that includes 09:30 appends `_keep`. The id without that suffix
is the skip. A US100 New York-only run that drops 08:30-08:32 appends `_skip`.
The id without that suffix includes the window.

Example: `sl50_tp50_ny_lveth_cont_touch_1m_serial` = 50 stop, 50 target,
New York session, ETH-built levels, continuation, touch entry, 1-month lookback,
one trade at a time.

`every` = every level, `serial` = one trade at a time, `one` = one trade a day,
`until` = keep trading until the day's realised points reach the target.
One level still gives at most one trade per day in every mode.

## Where to run it

Start the chart app once (`node server.js` in `D:\TradingView2`) and open
http://localhost:8080/. The **Strategy** button opens http://localhost:8080/strategy/
in a new tab. Every button talks to the Python engine through that server; no
terminal work is needed.

Report tab **Runs**:

- **Run missing** computes every combination that has no result yet (resumable).
- **Re-run all** recomputes every combination, 9,216 on US100.
- **Run filtered** computes only the combinations that pass the current filters.
- **Run** on a row recomputes that single combination.
- star = favourite (kept in `results/favourites.json` and browser storage).
- Click a row to expand every metric; **Day** opens the audit tab for that run.
- Click a column header to sort (again to reverse); the order survives filter changes.
- **A− / A+** in the top bar scales the whole report (90%–200%, kept in browser storage;
  click the percentage to reset to 100%).

**Audit day** tab shows every touch of one run on one New York day
(default day 2026-10-29), with candles, weekly (gold) and daily (sky blue) levels,
taken trades and the reason each touch was skipped. Click a row to centre the chart.

`Definitions` explains every metric and the fill model.

## Command line (optional)

```bash
cd analysis/nasdaq-level-retrace-v2

python run.py --all                     # every combination
python run.py --run sl50_tp50_ny_lveth_cont_touch_1m_serial
python run.py --ids id1,id2 --force     # recompute specific runs
python run.py --audit sl50_tp50_ny_lveth_cont_touch_1m_serial --day 2026-10-29
python run.py --export-trades sl50_tp50_ny_lveth_cont_touch_1m_serial

python run.py --all --force > log.txt    # full fresh sweep

python run.py --file GBPUSD_M1_202001020600_202610300618.csv --all
```

## Multiple instruments

Any MT5 minute CSV in `data/` can be analysed. The instrument (name, point
size, decimals) is taken from the CSV stem prefix: `US100*` is the Nasdaq
(1 point = 1.0, 2 decimals), `GBPUSD*` is cable (1 point = 0.0001 = one pip,
5 decimals, so a 50 point target is 1.50000 → 1.50050) and `XAUUSD*` is gold
(1 point = 0.10, 2 decimals, so a 50 point target is 1900.00 → 1905.00).
Unknown prefixes fall back to 1 point / 2 decimals; add a line to `INSTRUMENTS`
in `config.py` for anything new.

The report has a file selector in the top bar. **Every CSV keeps its own
results** under `results/<csv-stem>/` — summary, favourites, audit days and
trade CSVs — and its own audit-day default (the last New York day that has
session bars, so a half-finished day is not offered), so switching files never
recomputes or overwrites anything.

The engine loads the CSV once, caches the bars and the touch events in
`results/cache/`, then simulates each run. Only the first run of a level session
is slow, because it builds that session's event cache; every later run reuses
it. 6.5 years of GBPUSD M1 needed ~35 minutes to build the ETH event cache, and
with all caches warm the complete 6,144-run grid finished in 886 seconds, so the
grid itself is not the cost — the per-session cache is.

## Output files

| Path | Content |
| --- | --- |
| `results/<csv-stem>/summary.json` | every computed run with all metrics and the factor table |
| `results/<csv-stem>/audit/<run>_<day>.json` | touch-by-touch audit table plus bars and levels |
| `results/<csv-stem>/trades/<run>.csv` | trade list: entry/exit time, level source, side, points, MAE/MFE, bars held, retrace — prices written with that instrument's decimals (gold `1565.50`, cable `1.31381`) |
| `results/<csv-stem>/favourites.json` | starred run ids of that file |
| `results/<csv-stem>/progress.json` | progress of the running job |
| `results/cache/` | bar and event caches, shared, keyed by file (safe to delete, they rebuild) |

## Reading a run

`Retrace` in the run table is the average MAE of winning trades: how far a winner
went against the entry before reaching the target, in points (0 = never in the
red). The trade CSV has the same value per trade plus `retrace_of_stop_pct`, so
near-stops can be filtered out later.

## Live trading: the MetaTrader 4 Expert Advisor

`mt4/LevelRetrace.mq4` trades this strategy on a real account: continuation,
touch entry, daily/weekly open-close levels, the same four trades-per-day modes.
Trade type and entry are fixed by construction — a BUY STOP can only be hit from
below and a SELL STOP only from above, which is the continuation filter — while
lot size, the price of 50 points, stop, target, trading session, level session,
lookback and trades per day are inputs. MT4 has no IANA zones, so the server
offset is an input (`InpServerGmtOffset`, detected live, mandatory in the tester)
and daylight saving comes from the zone rules.

`mt4/verify_ea_model.py` proves the EA's arithmetic equals the engine's: on
US100, GBPUSD and XAUUSD it reproduces the New York day, the electronic day, the
London/New York/cash windows for every hour of the files, every 2020-2026 DST
boundary instant, and the level book (price, daily or weekly, newest source
candle) of every checked trade day from the broker's 60- and 30-minute bars.

Read `mt4/README.md` before the first run. It documents the tester recipe and
one number that matters for a dollar comparison: the engine never charges a
short the spread, a live MT4 short pays one, which on
`sl50_tp50_ny_lveth_cont_touch_1m_serial` is 34% of the net points.

```bash
python mt4/verify_ea_model.py --file XAUUSD_M1_202001020600_202610300854.csv \
        --offset 3 --days 120 --trades sl50_tp50_ny_lveth_cont_touch_1m_serial
```

## Re-running after a data update

Replace `data/US100_M1_202001020105_202610291406.csv` (or append the new bars),
then press **Run missing**. The data signature changed, so every run is recomputed
and the old results are discarded automatically.

A change to a run *rule* is a different case and is stamped separately:
`config.RULES_VERSION` (data signature) versus `config.CACHE_VERSION` (bars and
cached events). Bumping the rules version keeps every cached event and discards
only the results that read the changed rule: with the first-minute rule that is
the 1,536 `session=rth` runs of US100, so **Run missing** recomputes a quarter of
the grid instead of all of it.
