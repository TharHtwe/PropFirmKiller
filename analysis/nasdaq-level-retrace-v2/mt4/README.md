# LevelRetrace.mq4 — the strategy as a live MetaTrader 4 Expert Advisor

`LevelRetrace.mq4` trades the level-retrace v2 rules on a real MT4 account or in
the MT4 strategy tester: continuation on a touch of a completed daily or weekly
open/close level, touch entry, fixed stop and target in points.

| File | What it is |
| --- | --- |
| `LevelRetrace.mq4` | the Expert Advisor, one file, no includes, `#property strict` |
| `verify_ea_model.py` | proves the EA's clock and level arithmetic equal the Python engine |
| `MQL4\Files\LR<magic><symbol>.state` | written by the EA: which levels are spent today |
| `MQL4\Files\LR_<symbol>_<magic>.csv` | written by the EA: one row per closed trade |

**Compiled clean.** Built with MetaEditor from the LiteFinance MT4 install
(build 600+ compiler, `MQL4\Experts\LevelRetrace.ex4` produced): `0 errors, 0
warnings`. Two things only a compiler could catch had to be fixed first — output
parameters must be declared `int &name`, not `ref int name`, and MQL4 has no
`FileIsEOF()`; the state-file reader now compares `FileTell()` with `FileSize()`
instead.

## Compiling from the command line

MetaEditor takes the same job the F7 key does, so the EA can be rebuilt without
opening it — `compile.sh` in this folder copies the source into
`MQL4\Experts`, runs `metaeditor.exe /compile:"<file.mq4>" /log:"<file>"` and
prints the log:

```bash
bash compile.sh                 # or: bash compile.sh <metaeditor.exe> <file.mq4> <data folder>
```

The log is UTF-16, so it must go through `iconv -f UTF-16LE -t UTF-8`; raw bytes
read as CJK garbage. `0 errors, 0 warnings` is the only acceptable output, and a
stale `.ex4` from an earlier good build is easy to mistake for the current one —
check its timestamp.

## The timezone question, answered

**Yes, the EA needs the server offset, and it is an input: `InpServerGmtOffset`.**

MT4 gives an Expert Advisor only server time. There is no IANA database and no
`TimeGMT()` inside the strategy tester, so the EA cannot look up where the server
sits. It asks you instead:

- **Live chart**: leave `-99`. The EA detects `TimeCurrent() - TimeGMT()` once at
  start-up and prints it in the journal and on the panel (`server UTC+2`).
- **Strategy tester**: you must set a number, because there is no GMT clock. Find
  it once on a live chart (the panel prints it) and type the same number into the
  `.set` file. Most Central European CFD brokers are `+2` in winter and `+3` in
  summer — those brokers shift their own clock with US daylight saving, so if you
  test a range that crosses March or November, split it into two tests.

The offset is *only* a bridge from server time to UTC. Every session boundary is
then computed from the daylight saving **rule** of the zone itself (US: second
Sunday of March 07:00 UTC to first Sunday of November 06:00 UTC; EU: last Sunday
of March 01:00 UTC to last Sunday of October 01:00 UTC), never from a fixed
offset. That is what makes the London and New York windows right in the two or
three weeks a year when the two continents switch on different dates.

`verify_ea_model.py` checks that rule against `zoneinfo` for every transition
2020-2026 and for every hour of the data files, and it agrees.

## Install

1. In MT4: **File → Open Data Folder**, then put `LevelRetrace.mq4` in `MQL4\Experts`.
   The LiteFinance terminal on this machine keeps its data in
   `C:\Users\TharHtwe\AppData\Roaming\MetaQuotes\Terminal\DBED2B1AA5190ECE30AE5FCFF29920C2`,
   and the EA is already installed there together with its `.ex4`.
2. Open MetaEditor (F4) only if you change the source — press **F7** and it must
   come back `0 errors, 0 warnings`. Or run `bash compile.sh` from a shell.
3. Back in MT4: **View → Strategy Tester** for a backtest, or open a **1-minute
   chart of the symbol you want to trade** for live.
4. Drag LevelRetrace onto the chart (or pick it in the tester). Tick
   **Allow live trading**, and in **Common** leave "Allow DLL imports" off — the EA
   uses no DLLs. It needs **Allow file operations** for the daily state file and
   the trade journal.
5. Check the journal tab for the `start ...` line: it prints the point size, the
   modelled spread, the number of candles, the book size and the server offset.
   If any of those look wrong, stop and fix the inputs before trading.

## Inputs

### instrument and size

| Input | Default | Meaning |
| --- | --- | --- |
| `InpLots` | 0.10 | lot size, snapped down to the broker's lot step |
| `InpPricePer50Points` | 0 (auto) | **the price distance of 50 strategy points.** Gold `5.0`, US100 `50.0`, cable `0.005`. `0` picks by symbol name |
| `InpModelSpreadPts` | 1.3 | the spread the backtest assumes, in strategy points |
| `InpDigitsOverride` | 0 | decimals used to round levels; `Digits` is right unless the broker re-quotes |

One strategy point is `InpPricePer50Points / 50`: 0.10 on gold, 1.00 on US100,
one pip on cable. Everything else — stop, target, the modelled spread, the level
band — is expressed in those points, which is exactly how the Python engine
counts them. Getting this one number right is the whole instrument scaling, so
read it back from the `start` journal line.

### trade rules

| Input | Default | Meaning |
| --- | --- | --- |
| `InpTargetPoints` | 50 | target in strategy points, measured on the bid from the level |
| `InpStopPoints` | 50 | stop in strategy points, same basis |
| `InpSession` | New York | entry window: London 08:00-16:30 London time, New York 08:00-17:00 NY, cash 09:30-16:00 NY, or London-or-New York |
| `InpLevelSession` | ETH | which bars build the daily and weekly candles: all hours, ETH 18:00-17:00 NY, or cash 09:30-16:00 NY |
| `InpLookback` | 1 year | how old a level may be: 30 / 182 / 365 days, or all history |
| `InpTradesPerDay` | one at a time | every level, one at a time, one a day, or until the day reaches the target |

Trade type is **continuation** and entry is **touch**, both fixed: a BUY STOP can
only be hit from below and a SELL STOP only from above, so the pending order *is*
the continuation filter.

### clock, placement, exits, misc

| Input | Default | Meaning |
| --- | --- | --- |
| `InpServerGmtOffset` | -99 (detect) | server minus UTC in hours, see above |
| `InpCheckAlignment` | true | refuse to start when the level bars cannot line up with the session clock |
| `InpMaxPendingBuys` / `Sells` | 4 / 4 | stops kept open per side; forced to 1 in every mode except `every level` |
| `InpLevelBandPoints` | 600 | ignore levels further than this from the market |
| `InpLevelHistoryDays` | 0 | candles scanned at start-up; `0` = lookback + 120 days |
| `InpLevelBarMinutes` | 0 | 60 for all/ETH levels, 30 for cash levels; `0` picks that automatically |
| `InpArmSeconds` | 2 | how often the EA looks for a level to place a stop on |
| `InpMaxSpreadPoints` | 0 | skip arming while the live spread is wider than this (0 = no check) |
| `InpMaxDailyTrades` | 0 | hard cap on entries per day on top of `InpTradesPerDay` |
| `InpSlippagePoints` | 10 | slippage for the EA's own market closes |
| `InpExitMode` | broker stops | `EXIT_EA_BID` puts no stop on the order and closes at market when the **bid** reaches the level |
| `InpAdjustShortStops` | true | move a short's broker stops out by the live spread so they still fire on the engine's bids |
| `InpClosePendingsAtSessionEnd` | true | delete unfilled stops when the window closes |
| `InpCloseAtSessionEnd` | false | also flatten open trades at the window close |
| `InpMagic` | 20261030 | magic number; the state and journal files are named with it |
| `InpTag` | LR | order comment prefix and log prefix |
| `InpShowPanel` / `InpWriteCsvLog` | true | chart panel / `MQL4\Files` journal |

## How the strategy maps onto MT4

- **Levels.** The EA rebuilds the market-day candles itself from `InpLevelBarMinutes`
  bars — the first open and the last close per market day — because a broker's own
  D1 bar is grouped by *server* midnight, not by 18:00 New York. On a GMT+2/+3 broker
  the electronic day opens at server midnight during US daylight saving but at server
  01:00 in winter, so a D1 bar's open is then the 17:00 NY break hour instead of the
  18:00 open. Whole-hour bars never have that problem: an hourly boundary is always
  either on or before the market day open, and the grouping fixes the rest. A candle
  becomes a level on the next trade day, and a week only becomes a level once a candle
  of a later week exists, so a mid-week price is never traded as a weekly level. Equal
  prices merge into one level and keep the newest candle as their age.
- **Entry.** A BUY STOP at the level price (MT4 fills it when the **ask** reaches
  the level, which is the engine's `bid = level - 1.3 points`), a SELL STOP at the
  level (filled when the **bid** reaches it). The trade is valued at the price
  actually paid.
- **Exits.** Long: stop and target sit on the bid levels — MT4 closes a long at the
  bid, so no adjustment. Short: MT4 closes at the ask, so both levels move out by
  the live spread (`InpAdjustShortStops`) to fire on the same bid. The price the
  short is then settled at is one spread worse than the engine books it — see the
  caveats, that gap is real money, not a bug.
- **Daily gates.** One trade per level per day, in every mode; `one at a time` and
  `until target` refuse new entries while a position is open; `one a day` takes the
  first fill; `until target` stops the day once the same-day realised points reach
  the target. Spent levels, the day's points and the cap survive a restart through
  the state file, and live orders are re-adopted from the terminal at start-up.
- **Broker limits.** `MODE_STOPLEVEL` and `MODE_FREEZELEVEL` are read at start-up and
  the EA refuses to place a stop closer than that distance plus the modelled spread,
  which is why error 130 should not appear; when the broker distance is a large part
  of your stop, the journal warns you at start-up.

## Backtest recipe

For the run the report calls `sl50_tp50_ny_lveth_cont_touch_1m_serial`:

```
InpLots 0.10   InpPricePer50Points 5.0 (gold) or 50.0 (US100) or 0.005 (cable)
InpTargetPoints 50   InpStopPoints 50   InpModelSpreadPts 1.3
InpSession SESSION_NEWYORK   InpLevelSession LEVELS_ETH
InpLookback LOOK_1M          InpTradesPerDay TPD_SERIAL
InpServerGmtOffset 2  (or 3 in summer)   InpLevelBarMinutes 60
```

1. **Model: every tick.** The tester then walks each bar open → low → high → close
   (or open → high → low → close for a down bar), which is the *same* segment order
   the Python engine uses, so a bar that would touch both stop and target resolves
   the same way in both. `1 minute OHLC` only fills at bar opens and will not
   reproduce a touch entry — do not use it.
2. **Fixed spread** in the tester: modelled spread in tester points is
   `1.3 x (pricePer50 / 50) / Point` — **13** on gold (0.13 price), **130** on US100,
   **13** on cable.
3. **Start date = warm-up.** The tester only feeds bars inside the test range, and
   the level book needs `lookback + 120` days of history. To measure 2026, run the
   test from 2025-07 and ignore the first year of trades; the panel and journal make
   that easy to separate.
4. Apply to an **M1** chart period of the symbol you are testing, one test per
   session/level-session combination; the expensive part is the start-up scan, not
   the ticks.
5. `InpExitMode = EXIT_BROKER_STOPS` is what a live account does. Use `EXIT_EA_BID`
   only to see the pure bid-path result with no broker stop distance involved.

### On the LiteFinance MT4 of this machine

The EA is installed in that terminal's `MQL4\Experts` as source and `.ex4`. Its
symbols are not the names in `..\data`:

| broker symbol | engine file | digits | `InpPricePer50Points` | tester fixed spread |
| --- | --- | --- | --- | --- |
| `NQ` (Nasdaq index CFD) | `NAS100...csv` | 1 | 50.0 | **13** |
| `SPX` | — | 1 | 50.0 | 13 |
| `XAUUSD` | `XAUUSD...csv` | 2 | 5.0 | 13 |
| `GBPUSD` | `GBPUSD...csv` | 5 | 0.005 | 13 |

`NQ` prices match the engine's US100 series, so the two are directly comparable,
and a 1.3-point modelled spread is 1.30 index units = 13 tester points because
`NQ` ticks in 0.1. `AutoPricePer50()` knows these names, but setting
`InpPricePer50Points` by hand removes all doubt.

What the local history actually allows today (it has not been refreshed since the
demo login started failing through the proxy, so re-download by opening the charts
first if you want a longer run):

- `NQ` M1 covers 2026-02-03 → 2026-04-29 and `NQ` H1 covers 2025-09-26 →
  2026-03-16. **"every tick" needs the M1 file and the level book needs the H1
  file, so the run is 2026-02-03 → 2026-03-13.** The tester only feeds bars
  *inside* the range, so the level book starts empty on 3 February and fills one
  trade day at a time: treat the first three weeks as warm-up and score from about
  23 February, which leaves roughly 14 trade days of result. That is thin, and it
  is the reason to re-download history before drawing conclusions — `LOOK_1M` is
  all the age filter this window can support; `LOOK_6M` and `LOOK_ALL` would see a
  book that never had the chance to fill.
- That window is between US daylight saving starting (8 March) and Europe starting
  (29 March), so `InpServerGmtOffset 2` is right for the whole run and it needs no
  split at a transition.
- `GBPUSD` has no M1 file at all, so gold or `NQ` are the only every-tick choices.
- Do not run the tester from the command line while the terminal is open: a second
  `terminal.exe` on the same data folder fights the first one over the history
  files. Press Start in the GUI, or close the terminal first.

## Reading the dollar result

- **Panel** (top-left of the chart or the tester visual mode): today's trades,
  points and money, the run's closed count, win rate and money, open trades with the
  level each came from, the modelled versus live spread, and the server/UTC offsets.
- **Journal CSV** in `MQL4\Files`: `closed_server, ticket, side, lots, level, entry,
  exit, points, money, note` — `points` is on the engine's bid basis, `money` is what
  the broker actually paid.
- **MT4 history**: Account tab → History, right-click → all history. This is the only
  source that includes swap and commission.
- Points to money for a full lot: `dollars per point = contract size x pricePerPoint`,
  so 1 lot of gold is 100 oz x 0.10 = $10 per point, 1 lot of cable is 100,000 units
  x 0.0001 = $10 per point, and an index CFD depends on its contract size — read
  **Contract size** in Market Watch and divide the tester's money by the tester's
  points to check.
- Compare against the report's run of the same id and you have the answer to
  "how does this strategy do in the market in $": same levels, same touches, same
  gates, real spread and real fills.

`python mt4/verify_ea_model.py --file <csv> --offset 2 --days 120 --trades <run id>`
prints the checks: clock and DST agreement, the level books of every trade day
against the engine, and the money the engine gives away on the short side.

## What differs from the backtest — read before trusting a number

1. **A live short pays one spread.** The engine values a short at the level and
   settles it on the bid, so it never charges that side anything. On a real account
   the short closes at the ask. On the US100 run above, 4,147 of 8,174 trades are
   short, so the 1.3 points each costs **5,391 of 15,700 net points — 34% of the
   result**. Nothing in MT4 can recover it; it is a property of the backtest. If you
   want the report to tell the truth about it, the engine change is one line (charge
   `SPREAD_C` on a short's exit) and the grid gets re-run.
2. **Real spread versus the modelled 1.3 points.** Gold CFDs often quote 0.20-0.35 at
   the NY open, which is 2-3.5 strategy points. Widen `InpModelSpreadPts` to the
   spread your broker really gives and re-check the tester; the entry stop, the
   short's shifted exits and the 34% above all move with it.
3. **Broker stop distance.** If `MODE_STOPLEVEL` plus the spread is a big share of a
   50-point stop, entries and exits land further from the level than the model wants;
   the start-up journal prints the exact number of steps.
4. **The tester's tick path is synthetic.** "Every tick" rebuilds the intra-bar order
   from OHLC, same convention as the engine, but a real feed visits those prices in a
   different order and can touch the stop first. Only `real ticks` (your own tick
   history) removes that.
5. **Server bars, not feed bars.** The level candles come from the broker's H1/M30
   series. If the broker's feed opens late on a Sunday or drops the 17:00-18:00 NY
   hour, a daily open can be a few cents from the CSV's. The book still matches
   where the data agrees, which `verify_ea_model.py` demonstrates on the CSV side.
6. **Gaps fill where the market opens.** A BUY STOP below a gap open is filled at the
   open, so the entry, and the point count, is worse than the level — the engine does
   the same thing, but the real gap can be larger than the CSV's.
7. **Some brokers shift their own clock** with US daylight saving. Then the *server
   offset* changes twice a year even though the zones do not, so set
   `InpServerGmtOffset` per test range instead of relying on `-99`.
8. **Margin, swap, contract sizes** are broker facts the model has none of. Gold and
   index CFDs carry overnight financing; `until target` and `every level` hold
   several positions at once, so size `InpLots` for the worst case.
9. **64 tracked tickets** (`LR_SLOTS`), one trade per level per day, and the level band
   are the only places the EA adds a limit the engine does not have.

Reversal trades (`rev`), confirmation entries (a 1-minute close beyond the level) and
the `all` trading session of the report are the parts of the grid this EA does not
implement — it is the continuation/touch branch only.
