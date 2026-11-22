import { aggregateDaily, buildDaily, buildDailyEth, buildDailyUtc, TFS } from '../public/js/aggregate.mjs';
import { filterEthSession } from '../public/js/session.mjs';
import { test, assert, assertEqual, assertClose } from './harness.mjs';

const utc = (y, mo, d, h, mi) => Date.UTC(y, mo - 1, d, h || 0, mi || 0) / 1000;

function frame(rows) {
  const n = rows.length;
  return {
    times: Float64Array.from(rows.map((r) => r.t)),
    open: Float64Array.from(rows.map((r) => r.o)),
    high: Float64Array.from(rows.map((r) => r.h)),
    low: Float64Array.from(rows.map((r) => r.l)),
    close: Float64Array.from(rows.map((r) => r.c)),
    volume: Float64Array.from(rows.map((r) => r.v)),
    count: n
  };
}

test('daily candles use the trading-session date across midnight', () => {
  const src = frame([
    { t: utc(2020, 7, 19, 22, 0), o: 100, h: 104, l: 99, c: 103, v: 10 },
    { t: utc(2020, 7, 19, 23, 59), o: 103, h: 110, l: 102, c: 108, v: 12 },
    { t: utc(2020, 7, 20, 0, 0), o: 108, h: 109, l: 97, c: 98, v: 5 },
    { t: utc(2020, 7, 20, 13, 0), o: 98, h: 105, l: 98, c: 104, v: 20 },
    { t: utc(2020, 7, 20, 20, 14), o: 104, h: 106, l: 101, c: 102, v: 7 },
    { t: utc(2020, 7, 20, 22, 0), o: 102, h: 107, l: 102, c: 106, v: 3 },
    { t: utc(2020, 7, 21, 2, 0), o: 106, h: 108, l: 100, c: 101, v: 4 }
  ]);
  const daily = buildDaily(src);
  assertEqual(daily.count, 2, 'two sessions');
  assertEqual(daily.times[0], utc(2020, 7, 20), 'Monday session stamp');
  assertEqual(daily.times[1], utc(2020, 7, 21), 'Tuesday session stamp');
  assertEqual(daily.open[0], 100, 'Monday open');
  assertEqual(daily.high[0], 110, 'Monday high');
  assertEqual(daily.low[0], 97, 'Monday low');
  assertEqual(daily.close[0], 102, 'Monday close');
  assertEqual(daily.volume[0], 54, 'Monday volume');
  assertEqual(daily.open[1], 102, 'Tuesday open');
  assertEqual(daily.close[1], 101, 'Tuesday close');
  assertEqual(daily.volume[1], 7, 'Tuesday volume');
});

test('ETH daily candles group 18:00-17:00 New York sessions', () => {
  const src = frame([
    { t: utc(2020, 7, 19, 21, 59), o: 50, h: 200, l: 40, c: 60, v: 100 }, // Sunday 17:59 EDT
    { t: utc(2020, 7, 19, 22, 0), o: 100, h: 104, l: 99, c: 103, v: 10 }, // Sunday 18:00 open
    { t: utc(2020, 7, 20, 3, 0), o: 103, h: 110, l: 102, c: 108, v: 12 }, // Sunday 23:00
    { t: utc(2020, 7, 20, 13, 30), o: 108, h: 109, l: 97, c: 98, v: 5 }, // Monday 09:30
    { t: utc(2020, 7, 20, 20, 59), o: 98, h: 105, l: 96, c: 102, v: 7 }, // Monday 16:59 close
    { t: utc(2020, 7, 20, 21, 0), o: 102, h: 300, l: 50, c: 250, v: 100 }, // Monday 17:00 break
    { t: utc(2020, 7, 20, 22, 0), o: 102, h: 107, l: 101, c: 106, v: 3 }, // Monday 18:00 reopen
    { t: utc(2020, 7, 21, 2, 0), o: 106, h: 108, l: 100, c: 101, v: 4 } // Monday 22:00
  ]);
  const eth = buildDailyEth(filterEthSession(src));
  assertEqual(eth.count, 2, 'two ETH sessions');
  assertEqual(eth.times[0], utc(2020, 7, 20), 'Monday session stamped with its close date');
  assertEqual(eth.times[1], utc(2020, 7, 21), 'Tuesday session stamped with its close date');
  assertEqual(eth.open[0], 100, 'Monday open from 18:00');
  assertEqual(eth.high[0], 110, 'Monday high inside the session');
  assertEqual(eth.low[0], 96, 'Monday low inside the session');
  assertEqual(eth.close[0], 102, 'Monday close from 16:59');
  assertEqual(eth.volume[0], 34, 'Monday volume without break bars');
  assertEqual(eth.open[1], 102, 'Tuesday open from 18:00');
  assertEqual(eth.high[1], 108, 'Tuesday high');
  assertEqual(eth.low[1], 100, 'Tuesday low');
  assertEqual(eth.close[1], 101, 'Tuesday close');
  assertEqual(eth.volume[1], 7, 'Tuesday volume');
  const utcDaily = buildDailyUtc(filterEthSession(src));
  assertEqual(utcDaily.count, 3, 'UTC grouping would split the same bars differently');
});

test('out-of-order rows keep the daily series increasing', () => {
  const src = frame([
    { t: utc(2020, 7, 20, 13, 0), o: 10, h: 12, l: 9, c: 11, v: 1 },
    { t: utc(2020, 7, 20, 13, 2), o: 11, h: 13, l: 10, c: 12, v: 1 },
    // corrupt row that belongs to an earlier session
    { t: utc(2020, 7, 17, 13, 0), o: 5, h: 6, l: 4, c: 5, v: 1 },
    { t: utc(2020, 7, 21, 13, 0), o: 12, h: 14, l: 11, c: 13, v: 1 }
  ]);
  const daily = buildDaily(src);
  assertEqual(daily.count, 2, 'corrupt row merged, not appended');
  assert(daily.times[0] < daily.times[1], 'stamps increasing');
  assertEqual(daily.high[0], 13, 'corrupt row folded into the current session');
  assertEqual(daily.low[0], 4, 'corrupt row low folded in');
  assertEqual(daily.volume[0], 3, 'no bar dropped');
});

test('weekly and monthly frames build from session dates', () => {
  const rows = [];
  for (let day = 1; day <= 20; day++) {
    rows.push({ t: utc(2020, 7, day, 13, 0), o: day, h: day + 1, l: day - 1, c: day, v: 1 });
  }
  const daily = buildDaily(frame(rows));
  assertEqual(daily.count, 20, 'daily bars');
  const weekly = aggregateDaily(daily, TFS.find((tf) => tf.id === '1W'));
  assertEqual(weekly.count, 4, 'four calendar weeks touched');
  assertEqual(weekly.times[0], utc(2020, 6, 29), 'week stamp is the Monday');
  assertEqual(weekly.open[0], 1, 'first week open');
  assertEqual(weekly.close[0], 5, 'first week closes Friday');
  const monthly = aggregateDaily(daily, TFS.find((tf) => tf.id === '1M'));
  assertEqual(monthly.count, 1, 'one month');
  assertEqual(monthly.times[0], utc(2020, 7, 1), 'month stamp');
  assertEqual(monthly.open[0], 1, 'month open');
  assertEqual(monthly.close[0], 20, 'month close');
  assertClose(monthly.volume[0], 20, 1e-6, 'month volume');
});
