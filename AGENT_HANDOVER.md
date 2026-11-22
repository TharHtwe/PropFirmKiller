# Agent handover

Read this before changing the backtest. The decisions below were confirmed
with the user. Do not re-derive them, and do not start a full grid unless
asked.

Source of the research: `D:\TradingView2`. The chart server is `server.js`
on port 8080. Python for the engines is `C:\Python313\python.exe` on the
machine that built this. The repo is https://github.com/TharHtwe/PropFirmKiller

## Leave these alone

- Do not overwrite `analysis/nasdaq-level-retrace/results/report.html`.
  That is the original fade report. Continuation work is v2.
- Do not bump `CACHE_VERSION` (still 4) or `RULES_VERSION` (still 2) in
  `analysis/nasdaq-level-retrace-v2/config.py`. The New York skip mask and
  the combine news rule are not baked into the event cache.
- Do not let the Kelly map size trades. It is a suggestion on the strategy
  page only. Equity in that metric is always one contract.
- Do not build a 2020–2025 fit / 2026 trade test of Gianluca Bruni's model
  until the ten questions at the bottom are answered.
- Do not restart `node server.js` unless a change to `server.js` has to be
  loaded, and do not kill a running server to do it. HTML, CSS, and JS are
  read from disk on each request.
- One Python child at a time. Strategy, risk, prop, prop2, and combine
  refuse to run together.

## Pages

| URL | Code |
| --- | --- |
| `/strategy/` | `analysis/nasdaq-level-retrace-v2/site/` |
| `/risk/` | `analysis/risk-factor/site/` |
| `/prop/` | `analysis/prop-firm/site/` (`prop.js` is shared) |
| `/prop2/` | `analysis/prop-firm/site2/` sets `window.PROP_PAGE` then loads `/prop/prop.js` |
| `/combine/` | `analysis/combine/site/` |
| Remarks | `analysis/nasdaq-level-retrace-v2/site/remarks.html`, iframed by the other pages |

Outcome words are green or red in those tables: funded, target, payout,
win, pass, and `tp` are green; blown, stop, loss, gap, fail, and `sl` are
red. The helpers are `headerTone` / `paintOutcomes` in `prop.js`,
`report.js`, `risk.js`, and `combine.js`.

## Price and sessions

MT5 bid CSV, timestamps UTC. US100 point size is 1.0, scale 100, spread
1.3 (130 price steps). `$2` per index point at 0.10 lot, `$1` at 0.05.

| Session | Clock |
| --- | --- |
| London | 08:00–16:30 Europe/London |
| New York | 08:00–17:00 America/New_York |
| RTH | 09:30–16:00 America/New_York |
| All | London or New York |

`ny_min` is the local hour and minute, so EST and EDT both land on 08:30.
London 08:00 is 03:00 New York all year. A London trade can still be open
at 08:27 New York. RTH starts at 09:30, after the news window.

Run id:

`sl{50|100}_tp{50|100|150|200}_{london|ny|rth|all}_lv{all|eth|rth}_{rev|cont}_{touch|confirm}_{1m|6m|1y|all}_{every|serial|one|until}`

optional `_keep` or `_skip`.

- US100 RTH without a suffix skips the 09:30 bar. `_keep` includes it.
  Do not emit `_skip` on RTH.
- US100 New York without a suffix includes 08:30 and 08:31. `_skip` drops
  those two minutes and keeps 08:32. Do not emit `_keep` on New York.
- That grid skip is not the combine news rule.
- US100 grid size is 9,216. GBPUSD and XAUUSD stay 6,144. Server
  `MAX_IDS` must stay at least 9,216 or Re-run all is rejected.

## How a fill works

Touch is unchanged. A sell fills at the level. A buy triggers when the bid
is one spread under the level and is valued at the level, so a full target
pays the target points.

1-minute close (`confirm`):

- Continuation: the candle body must cross the level. Close above is a buy,
  close below is a sell. A wick through a second level on that bar is not
  a confirmation. Fill at the close. A buy adds the 1.3 spread. Stop and
  target are measured from the fill, not the level.
- The 2026-10-29 image case (`sl50_tp50_rth_lvall_cont_confirm_1m_one`) is
  a sell at the close through the higher level. It is not a buy at the
  lower level that was only wicked.
- Reversal: two closes. Sell when a previous close was above and this close
  is back below. Buy is the opposite. A same-bar wick rejection is not a
  reversal.
- When the bar does not gap (open equals the previous close), continuation
  and reversal often select the same bar. They differ when the bar opens
  already beyond the level.

The engine walk fills a normal stop at the stop price even if the bar
gapped through it. The combine news remainder is the exception: a bar that
opens beyond the news stop fills at the open.

## Prop money

Shared by Prop firm and Prop firm 2. `analysis/prop-firm/prop.py`.

- Start `$5,000` (500,000 cents). Fee `$22`. Qualify day `$25`. Minimum
  payout `$20`. Targets `$400` then `$250`. Payout 80%.
- 8% floor is `$4,600` and it does not trail. `touch_hwm` is a no-op.
- Daily 4% uses `day_floor`: `band = (ref * pct + 50) // 100`, floor =
  ref − band. At `$5,000` the daily floor is `$4,800`, so `$200` only at
  that balance. It is not a fixed `$200` after the balance moves.
- A drop through both lines in one shot is labelled daily when the 8%
  floor is still above the daily line.
- Lot: 50-point stop uses 0.10, 100-point stop uses 0.05.
- Prop firm: five accounts, Monday–Friday. A Tuesday loss does not touch
  Monday. A blown weekday is replaced on its next trade and pays `$22`
  again. Net cash is the sum of the five.
- Prop firm 2: one account, every trade in time order. A pass resets the
  balance to `$5,000` on the same account and does not charge a new fee.
  A blow buys a new account on the next trade.
- Phase calendar days are inclusive, from the phase's first trade through
  the pass day. "Trading" span is a trade count and is not shown as days.
- Ranking written on the Remarks page: Funded % first (open the row and
  read Monday–Friday), then Funded weekdays (prefer 5), then median days
  to funded, then net cash and received/fees. Earliest is a best case,
  not the rank.
- Hold ratio for a phase pass (`hold_ok * 2 >= hold_n`) is required and is
  not shown on the Rules tab. Do not "fix" that unless asked.

Saved results, already computed:

- `analysis/nasdaq-level-retrace-v2/results/<stem>/summary.json`
- `analysis/prop-firm/results/US100_M1_202001020105_202610291406/prop.json`
- same folder, `prop2.json`
- `analysis/risk-factor/results/<stem>/risk.json` (the US100 file is small;
  GBPUSD and XAUUSD are the full ones)

## Combine

`analysis/combine/combine.py`. One continuation trade per session per day.
Lookback is 1 month only. Do not invent a switch from 1 month to 6 months.

| Session | Run |
| --- | --- |
| London | `sl50_tp50_london_lvrth_cont_confirm_1m_one` |
| New York | `sl50_tp50_ny_lvall_cont_touch_1m_one` |
| New York RTH | `sl50_tp50_rth_lvall_cont_touch_1m_one_keep` |

Seven mixes: each session, each pair, and all three. Checkboxes hide a row
that uses an unchecked session. `combine.json` in
`analysis/combine/results/US100_M1_202001020105_202610291406/` is version 3
and records 453 news days, so those seven rows match the red-folder list.
Do not re-run them unless asked.

### High-impact days

A day is high impact when its date is in
`usd_0830_redfolder_dates_2020-2027.csv` in that same results folder.
The old "08:30 or 08:31 range over 50 points" detector is not the rule
anymore. 523 dates are listed. 453 have a bar in the price file
(2020-01-10 through 2026-10-29). 2020-04-10 and 2024-03-29 are Good Friday
and have no bar. The rest of the missing dates are after the file ends
(2026-10-29). `news-days.csv` is the check file: date, releases, and the
08:30 and 08:31 ranges.

### News execution, New York session only

On a high-impact day only. London and RTH are not blocked. Their closed
profit and loss still change the equity used for the 4% stop when they
share the account.

- No New York open and no New York stop or target from 08:28 through 08:32
  inclusive. The 08:32 close is the first price that may close the remainder.
- If the day's first signal is inside that window, skip it and take the
  next signal after 08:32. Do not skip the whole day.
- If a New York trade is still open at the 08:27 close, close half the lot
  there. The 50-point run is 0.10 lot, so half is 0.05.
- At the 08:32 close, if price is already 100 points in favor of the
  original fill, close the remainder. Otherwise set the target to 100
  points from the original fill, and set the stop where equity hits the
  4% floor marked from the last bid before 00:00 UTC.
- A later bar that opens through that stop fills at the open. That can
  lose more than 4% and blow the account. The user accepted that.
- A normal day does not use this window.
- Points are lot-weighted to a full 0.10 lot. Half of a 20-point move
  counts as 10 points.
- Three equity paths, so the stop distance can differ: the strategy
  account (starts at `$5,000`, never pays a fee, never resets), the five
  weekday accounts, and the one continuous account. London profit and loss
  changes the New York news stop only on the same account.

`python combine.py --handling` rewrote `news-handling.json` for this rule.
New York session only, 453 red-folder days, 426 trades, win rate 57.5%,
+654.5 points. Still open at 08:27: 195 trades, all halved. Entered after
08:32: 209. Closed before 08:27: 22. Fast blow after 08:30: once, on
2022-12-13, on both the one-account and the five-account replay. The 4%
news stop ended the one account 46 times; that is the line being reached,
not a gap. Do not quote the older 07:58-window figures (39 trades, 51.3%,
zero carries).

## Known rough edges, not to fix unless asked

- Strategy weekday labels: metrics use Monday = 0, the report names start
  on Sunday.
- Streak tables are exact-k; some definitions read as at-least-k.
- Lookback is called 30 / 182 / 365 calendar days.
- `pick_first_per_level` caps at 4096.
- Rules text that says prop reads a trade CSV is behind the code. Prop
  rebuilds trades from the engine.

## Bruni, still blocked

Two different models were explained and not merged.

Risk Factor (the Risk page, from Riskfactor.xlsx): pass when the score is
under 5.5. It picks one lot for the run. It does not size each trade.

Kelly (strategy page only): gap between the win rate and the win rate
after a loss. Fraction is none, 1/5, 1/3, or 1/2, or no fraction when the
gap is extreme. It must not change lot size.

Do not build the 2026 test until these are answered:

1. Which rule sizes 2026: the Risk Factor lot, the Kelly map, or a Risk
   Factor lot with Kelly as a multiplier?
2. Are the 2020–2025 statistics frozen for all of 2026, or recomputed as
   2026 trades print?
3. Is a Kelly fraction a share of the `$5,000` account, or a multiplier on
   the fixed 0.10 / 0.05 lot?
4. On a negative gap, should size be cut after a win and allowed to rise
   after a loss?
5. When the gap is above 8, is size left fixed, or is the configuration
   not traded?
6. When the gap is 0–2, size stays fixed, so 2026 matches the unsized run.
   Is that an acceptable result?
7. What counts as an improvement: more points, a higher Funded %, more net
   cash, or a larger lot that still passes Risk Factor 5.5?
8. Does the varying lot run inside the prop account, or only on a separate
   risk test?
9. When several trades are open, does each one take the size that was
   current at its own entry?
10. Is the only size limit the broker's lot step, or is there also a cap,
    such as never above the Risk Factor lot?
