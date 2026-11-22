# Risk-factor analysis

A separate analysis of the level-retrace strategy runs against the LiteFinance
Risk Factor. It reuses the strategy engine **read only** and writes nothing into
`analysis/nasdaq-level-retrace-v2/`. All output lives under this folder.

The page is served by the chart app at **http://localhost:8080/risk/** (the
**Risk** button in the chart header opens it).

## Files

| Path | Purpose |
| --- | --- |
| `rfspec.py` | Broker specs, scoring bands and the Risk Factor formula |
| `risk.py` | Runner: per run, per month, per lot |
| `results/<csv-stem>/risk.json` | Results for one data file |
| `results/<csv-stem>/progress.json` | Live progress for the status bar |
| `results/<csv-stem>/favourites.json` | Favourites for this data file |
| `results/<csv-stem>/risk-queue.txt` | Run ids handed to the runner by the app |
| `site/index.html`, `site/risk.js`, `site/style.css` | The report page |

## Run it

From this folder:

```bat
python risk.py --file US100_M1_202001020105_202610291406.csv --all
python risk.py --file US100_M1_...csv --ids sl50_tp50_ny_lveth_cont_touch_1m_serial
python risk.py --file US100_M1_...csv --ids-file queue.txt
python risk.py --file US100_M1_...csv --all --max-lot 20 --balance 5000
```

Options: `--year` (default 2026), `--max-lot` (default 100), `--balance`
(default 5000), `--force`, `--limit N` (debug).

The runner is resumable. `risk.json` is keyed by a signature of the CSV file,
the instrument spec and the parameters; a second `--all` skips runs already in
it. Any change to the data, the spec or `--max-lot/--balance/--year` makes the
stored results obsolete and the next run replaces them.

Runtime is dominated by the strategy event cache. On a warm cache a full
grid takes roughly 25–35 minutes per data file (9,216 runs on US100, 6,144 otherwise); the cache itself is
shared with the strategy runner and is not rebuilt if it is current.

## The model

```
RF = 0.5 × drawdown points + 0.3 × utilisation points
   + 0.1 × leverage points   + 0.1 × lifespan points
```

Leverage 400 → 10 points and account lifespan 0 → 10 points, so the last two
terms are a fixed 2.0. **A run passes a month when RF < 5.5** (5.4 rounds to 5,
5.5 rounds to 6).

Drawdown and utilisation use the bands from the workbook:

| % | points | % | points |
| --- | --- | --- | --- |
| ≥ 50 | 10 | 15 – 20 | 4 |
| 40 – 50 | 9 | 10 – 15 | 3 |
| 35 – 40 | 8 | 5 – 10 | 2 |
| 30 – 35 | 7 | < 5 | 1 |
| 25 – 30 | 6 | | |
| 20 – 25 | 5 | | |

- **Relative drawdown** is `(peak equity − following low equity) / peak equity`.
- **Deposit utilisation** is `margin / equity`.

### Broker model (from `Riskfactor.xlsx`, `Symbols` sheet)

| Symbol | Min lot | Step | $ per point per 1.0 lot | Commission per 1.0 lot | Margin per 1.0 lot |
| --- | --- | --- | --- | --- | --- |
| US100 | 0.10 | 0.10 | 1.00 (1 index point) | 3.50 | 1% of price |
| GBPUSD | 0.01 | 0.01 | 10.00 (1 pip) | 5.00 | price × 250 (1:400) |
| XAUUSD | 0.01 | 0.01 | 10.00 (0.1 price) | 5.00 | 0.2% of price |

Commission is charged **once per trade** (round turn) when the position opens
and is added to the P&L before the account is marked.

### How a run is scored

1. Only the chosen year (2026 by default) is used, one calendar month at a time,
   grouped by **New York trade date**.
2. Each month opens a **fresh account** at the chosen balance; nothing carries
   over.
3. The run’s trades are replayed at the lot under test. Equity is sampled at
   every **1-minute bar** (not hourly); open positions are marked at each bar
   close and margin is reserved for every open position.
4. Lots are searched upwards in broker steps for each month (Risk Factor cannot
   improve as the lot grows), so each month’s maximum is exact. A month that
   fails at the minimum lot ends the search for that run.
5. The **run lot** is the lowest of the monthly maxima, so the same lot is safe
   for the whole year. All gains and RF values in the table are reported at that
   lot.
6. A run whose minimum lot already fails in any month has no tradeable lot and
   is reported as `RF fail`, with the failing month and the RF it reached.

## Results fields

`risk.json` stores one object per run:

- `safe_lot` — the run lot, or `null`.
- `reason` — `ok`, `no trades`, `no data`, or `risk factor over 5 at the minimum lot`.
- `trades`, `months_used`.
- `min_gain`, `max_gain`, `total_gain`, `avg_gain` — monthly gains at the run lot.
- `avg_return_pct`, `total_return_pct` — against the starting balance.
- `min_rf`, `max_rf`, `max_dd`, `max_util`.
- `best_month`, `worst_month`.
- `months` — per month: `trades`, `lot_max`, `rf_max`, `dd_max`, `util_max`,
  `gain_max`, `rf_next`, `lot_next`, and, for safe runs, `lot`, `rf`, `dd`,
  `util`, `gain`, `return_pct` at the run lot.

## Assumptions and limits

- Margin is reserved at the full notional rate for each open position; hedged
  positions are not netted.
- Intrabar equity is not sampled, so a spike between two 1-minute closes is not
  seen. The workbook refreshes hourly; this analysis samples every minute.
- The strategy engine does not charge the spread to short entries; the risk
  model mirrors that. The CSV spread column is ignored (the engine uses its
  fixed 1.3-point spread).
- Swaps / overnight financing are not part of the workbook model and are not
  charged.
- Gains are gross of any other broker fees beyond the commission above.
- `--max-lot` caps the scan; raising it only adds lots to the search.

## Server API

The chart server exposes:

- `GET /api/risk/files` — data files, instrument specs and whether results exist.
- `GET /api/risk/results?file=…` — `risk.json` plus file/instrument metadata.
- `GET /api/risk/status?file=…` — running job and progress.
- `POST /api/risk/run` — `{ file, ids | all, force, max_lot, balance, year }`.
- `GET/POST /api/risk/favourites` — per-file favourites.
- `GET /risk/` — the report page.
