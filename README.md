# TradingView2

Chart and research app for US100 (Nasdaq CFD), GBPUSD, and XAUUSD. It draws
1-minute bars and runs a level-retrace backtest, a prop-firm replay, a risk
check, and a three-session combine. Saved result files are in this repo, so
the grids do not have to be computed again just to read them.

## What is in here

| Piece | Where | What it does |
| --- | --- | --- |
| Chart | `server.js`, `public/` | Bars, drawings, replay. Open http://localhost:8080/ |
| Strategy | `analysis/nasdaq-level-retrace-v2/` | 9,216 US100 runs (6,144 on GBPUSD and XAUUSD) |
| Risk | `analysis/risk-factor/` | LiteFinance-style Risk Factor, pass under 5.5 |
| Prop firm | `analysis/prop-firm/` | Five weekday accounts, $5,000 each |
| Prop firm 2 | `analysis/prop-firm/site2/` | One account for every weekday |
| Combine | `analysis/combine/` | London + New York + New York RTH, with the 08:30 news rule |

The older fade study is `analysis/nasdaq-level-retrace/`. Leave its
`results/report.html` as it is. The continuation work lives in v2.

`AGENT_HANDOVER.md` is the note for the next person or agent: rules that are
already decided, which result file is current, and what not to rebuild.

## Prerequisites

- Node.js 20 (developed on 20.19). `npm` comes with it.
- Python 3.11 or newer. This machine uses `C:\Python313\python.exe`.
  Packages used by the engines are numpy and pandas.
- A browser.

The chart itself only needs Node. The Strategy, Risk, Prop, and Combine
buttons start Python from the server. If `python` is not on PATH, set
`STRATEGY_PYTHON` (and `PROP_PYTHON` if it should differ) to the full path
of `python.exe` before starting the server.

## Run the app

```text
cd D:\TradingView2
npm install
node server.js
```

Then open http://localhost:8080/

| Button | Page |
| --- | --- |
| Strategy | http://localhost:8080/strategy/ |
| Risk | http://localhost:8080/risk/ |
| Prop firm | http://localhost:8080/prop/ |
| Prop firm 2 | http://localhost:8080/prop2/ |
| Combine | http://localhost:8080/combine/ |

Static pages are read from disk on each request. A refresh picks up HTML,
CSS, and JS changes. A change to `server.js` needs the process restarted.

Only one analysis may run at a time. The pages share that lock.

## Large files

GitHub refuses a file larger than 100 MB. The price CSVs and the event
caches are larger than that, so they are not stored as git blobs. They are
release assets on the tag `data-files`. After a fresh clone, from this
folder:

```text
python tools/fetch_large_files.py
```

That writes each file back to the path in `large-files.json`. If the file
is already there and the size matches, it is left alone. The copy on this
machine already has those files, so this step is only for a new clone.

`summary.json`, `prop.json`, `prop2.json`, `risk.json`, `combine.json`,
and `news-handling.json` are under 100 MB and are in git. Opening the
pages shows those saved results. You do not need to press Re-run all to
see them.

## Optional command line

From `analysis/nasdaq-level-retrace-v2`:

```text
python run.py --run sl50_tp50_ny_lvall_cont_touch_1m_one
python run.py --all
```

From `analysis/combine`:

```text
python combine.py --check
python combine.py --handling
python combine.py --file US100_M1_202001020105_202610291406.csv
```

`--handling` rewrites only the New York news report. The last command
scores the seven session mixes. Do not start either unless you mean to
replace the saved numbers.
