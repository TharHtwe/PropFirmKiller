import {
  CASH_CLOSE_MINUTE,
  CASH_OPEN_MINUTE,
  ETH_CLOSE_MINUTE,
  ETH_OPEN_MINUTE,
  ethSessionDayNumber,
  filterCashSession,
  filterEthSession,
  getSchedule,
  isCashSession,
  isDailyBreak,
  isEthSession,
  isOpen,
  resetSchedule,
  sessionBands,
  sessionBounds,
  sessionDateKey,
  sessionDayNumber,
  setSchedule
} from '../public/js/session.mjs';
import { buildDaily } from '../public/js/aggregate.mjs';
import { test, assert, assertEqual } from './harness.mjs';

const utc = (y, mo, d, h, mi) => Date.UTC(y, mo - 1, d, h, mi || 0) / 1000;

test('schedule defaults to 17:00-15:15 America/Chicago', () => {
  const cfg = getSchedule();
  assertEqual(cfg.timeZone, 'America/Chicago', 'schedule zone');
  assertEqual(cfg.openMinute, 17 * 60, 'open minute');
  assertEqual(cfg.closeMinute, 15 * 60 + 15, 'close minute');
  assertEqual(CASH_OPEN_MINUTE, 9 * 60 + 30, 'cash open');
  assertEqual(CASH_CLOSE_MINUTE, 16 * 60, 'cash close');
});

test('daily maintenance break UTC instants (daylight time)', () => {
  const day = sessionDayNumber(utc(2020, 7, 15, 12));
  const b = sessionBounds(day);
  assertEqual(b.date, '2020-07-15', 'session date');
  assertEqual(b.open, utc(2020, 7, 14, 22), 'open 17:00 CDT');
  assertEqual(b.close, utc(2020, 7, 15, 20, 15), 'close 15:15 CDT');
  assertEqual(b.breakEnd, utc(2020, 7, 15, 22), 'reopen 17:00 CDT');
  assertEqual(b.breakEnd - b.close, 105 * 60, 'break length');
});

test('daily maintenance break UTC instants (standard time)', () => {
  const day = sessionDayNumber(utc(2020, 1, 15, 12));
  const b = sessionBounds(day);
  assertEqual(b.date, '2020-01-15', 'session date');
  assertEqual(b.open, utc(2020, 1, 14, 23), 'open 17:00 CST');
  assertEqual(b.close, utc(2020, 1, 15, 21, 15), 'close 15:15 CST');
  assertEqual(b.breakEnd, utc(2020, 1, 15, 23), 'reopen 17:00 CST');
});

test('candles after midnight belong to the session that closes later', () => {
  // Wednesday 18:00 CDT is already Thursday's session
  assertEqual(sessionDateKey(utc(2020, 7, 15, 23)), '2020-07-16', 'overnight tail');
  // Thursday 08:00 CDT is the same Thursday session
  assertEqual(sessionDateKey(utc(2020, 7, 16, 13)), '2020-07-16', 'morning part');
  // Sunday 21:00 CDT opens Monday's session
  assertEqual(sessionDateKey(utc(2020, 7, 20, 2)), '2020-07-20', 'sunday evening');
  assertEqual(sessionDateKey(utc(2020, 7, 19, 22)), '2020-07-20', 'sunday 17:00 open');
  // Friday morning still closes Friday's session
  assertEqual(sessionDateKey(utc(2020, 7, 17, 13)), '2020-07-17', 'friday morning');
  // The instant 15:15 local is past the close but before the reopen: it stays
  // on the session that just closed.
  assertEqual(sessionDateKey(utc(2020, 7, 15, 20, 16)), '2020-07-15', 'after close');
});

test('weekend closure and daily break detection', () => {
  assertEqual(isOpen(utc(2020, 7, 15, 13)), true, 'wednesday mid-session');
  assertEqual(isOpen(utc(2020, 7, 15, 20, 30)), false, 'wednesday maintenance break');
  assertEqual(isOpen(utc(2020, 7, 17, 22, 30)), false, 'friday evening');
  assertEqual(isOpen(utc(2020, 7, 18, 15)), false, 'saturday');
  assertEqual(isOpen(utc(2020, 7, 19, 15)), false, 'sunday before open');
  assertEqual(isOpen(utc(2020, 7, 19, 22)), true, 'sunday 17:00 open');
  assertEqual(isOpen(utc(2020, 1, 18, 23, 30)), false, 'saturday winter');
  assertEqual(isDailyBreak(utc(2020, 7, 15, 20, 30)), true, 'summer break');
  assertEqual(isDailyBreak(utc(2020, 1, 15, 21, 30)), true, 'winter break');
  assertEqual(isDailyBreak(utc(2020, 7, 15, 19)), false, 'before break');
});

test('US cash session 09:30-16:00 America/New_York', () => {
  assertEqual(isCashSession(utc(2020, 7, 15, 13, 29)), false, 'before open (summer)');
  assertEqual(isCashSession(utc(2020, 7, 15, 13, 30)), true, 'at open (summer)');
  assertEqual(isCashSession(utc(2020, 7, 15, 19, 59)), true, 'before close (summer)');
  assertEqual(isCashSession(utc(2020, 7, 15, 20, 0)), false, 'at close (summer)');
  assertEqual(isCashSession(utc(2020, 1, 15, 14, 29)), false, 'before open (winter)');
  assertEqual(isCashSession(utc(2020, 1, 15, 14, 30)), true, 'at open (winter)');
  assertEqual(isCashSession(utc(2020, 1, 15, 21, 0)), false, 'at close (winter)');
  assertEqual(isCashSession(utc(2020, 7, 18, 15)), false, 'saturday');
});

function bars(list) {
  const n = list.length;
  const out = {
    times: new Float64Array(n),
    open: new Float64Array(n),
    high: new Float64Array(n),
    low: new Float64Array(n),
    close: new Float64Array(n),
    volume: new Float32Array(n),
    count: n
  };
  for (let i = 0; i < n; i++) {
    out.times[i] = list[i][0];
    out.open[i] = list[i][1];
    out.high[i] = list[i][2];
    out.low[i] = list[i][3];
    out.close[i] = list[i][4];
    out.volume[i] = list[i][5] || 0;
  }
  return out;
}

test('cash filter keeps only 09:30-16:00 New York bars', () => {
  const src = bars([
    [utc(2020, 7, 14, 22), 1, 2, 0.5, 1.5, 10], // Tuesday 18:00 NY, outside
    [utc(2020, 7, 15, 13, 29), 2, 3, 1.5, 2.5, 11], // 09:29, outside
    [utc(2020, 7, 15, 13, 30), 3, 4, 2.5, 3.5, 12], // 09:30 summer, keep
    [utc(2020, 7, 15, 19, 59), 4, 5, 3.5, 4.5, 13], // 15:59 summer, keep
    [utc(2020, 7, 15, 20, 0), 5, 6, 4.5, 5.5, 14], // 16:00 summer, outside
    [utc(2020, 7, 18, 15), 6, 7, 5.5, 6.5, 15], // Saturday, outside
    [utc(2020, 1, 15, 14, 29), 7, 8, 6.5, 7.5, 16], // 09:29 winter, outside
    [utc(2020, 1, 15, 14, 30), 8, 9, 7.5, 8.5, 17], // 09:30 winter, keep
    [utc(2020, 1, 15, 20, 59), 9, 10, 8.5, 9.5, 18], // 15:59 winter, keep
    [utc(2020, 1, 15, 21, 0), 10, 11, 9.5, 10.5, 19] // 16:00 winter, outside
  ]);
  const out = filterCashSession(src);
  assertEqual(out.count, 4, 'kept bar count');
  const keptTimes = [utc(2020, 7, 15, 13, 30), utc(2020, 7, 15, 19, 59), utc(2020, 1, 15, 14, 30), utc(2020, 1, 15, 20, 59)];
  const keptClose = [3.5, 4.5, 8.5, 9.5];
  const keptVolume = [12, 13, 17, 18];
  for (let i = 0; i < keptTimes.length; i++) {
    assertEqual(out.times[i], keptTimes[i], `kept timestamp ${i}`);
    assertEqual(out.close[i], keptClose[i], `close copied unchanged ${i}`);
    assertEqual(out.volume[i], keptVolume[i], `volume copied unchanged ${i}`);
  }
});

test('cash daily candles ignore overnight and post-close extremes', () => {
  const src = bars([
    [utc(2020, 7, 14, 22), 50, 200, 40, 60, 1], // 18:00 NY, full session only
    [utc(2020, 7, 15, 13, 30), 100, 105, 95, 102, 1],
    [utc(2020, 7, 15, 15, 0), 102, 110, 90, 108, 1],
    [utc(2020, 7, 15, 19, 59), 108, 112, 104, 105, 1],
    [utc(2020, 7, 15, 20, 30), 105, 130, 100, 120, 1] // break/overnight tail
  ]);
  const cash = buildDaily(filterCashSession(src));
  assertEqual(cash.count, 1, 'one cash session day');
  assertEqual(cash.times[0], utc(2020, 7, 15, 0), 'stamped with the cash date');
  assertEqual(cash.open[0], 100, 'open from 09:30');
  assertEqual(cash.close[0], 105, 'close from 15:59');
  assertEqual(cash.high[0], 112, 'high within cash hours');
  assertEqual(cash.low[0], 90, 'low within cash hours');
  const full = buildDaily(src);
  assertEqual(full.high[0], 200, 'full session keeps overnight high');
});

test('overlay bands only mark the maintenance break', () => {
  const bands = sessionBands(utc(2020, 1, 13, 0), utc(2020, 1, 16, 0), { tfSec: 60 });
  assertEqual(bands.length, 3, 'one break per session');
  assertEqual(bands[0].kind, 'break', 'break descriptor');
  assertEqual(bands[0].from, utc(2020, 1, 13, 21, 15), 'winter break');
  assertEqual(bands[0].to, utc(2020, 1, 13, 23), 'winter reopen');
});

test('no overlay bands on daily or larger candles', () => {
  const bands = sessionBands(utc(2020, 7, 1, 0), utc(2020, 7, 20, 0), { tfSec: 86400 });
  assertEqual(bands.length, 0, 'daily frame');
});

test('schedule is configurable and restores its defaults', () => {
  try {
    setSchedule({ openMinute: 16 * 60, closeMinute: 15 * 60 });
    const day = sessionDayNumber(utc(2020, 7, 15, 12));
    const b = sessionBounds(day);
    assertEqual(b.open, utc(2020, 7, 14, 21), 'open 16:00 CDT');
    assertEqual(b.close, utc(2020, 7, 15, 20), 'close 15:00 CDT');
    assertEqual(sessionDateKey(utc(2020, 7, 15, 21, 30)), '2020-07-16', '16:30 local starts next session');
    assertEqual(isOpen(utc(2020, 7, 15, 21, 30)), true, 'new open time');
  } finally {
    resetSchedule();
  }
  assertEqual(getSchedule().openMinute, 17 * 60, 'restored open');
  let rejected = false;
  try {
    setSchedule({ openMinute: 2000 });
  } catch (err) {
    rejected = true;
  }
  assert(rejected, 'invalid schedule rejected');
});

test('ETH session runs 18:00-17:00 New York with a 17:00-18:00 break', () => {
  assertEqual(ETH_OPEN_MINUTE, 18 * 60, 'eth open minute');
  assertEqual(ETH_CLOSE_MINUTE, 17 * 60, 'eth close minute');
  // Summer (EDT, UTC-4): open 22:00 UTC, close 21:00 UTC.
  assertEqual(isEthSession(utc(2020, 7, 19, 21, 59)), false, 'sunday 17:59 EDT');
  assertEqual(isEthSession(utc(2020, 7, 19, 22)), true, 'sunday 18:00 EDT open');
  assertEqual(isEthSession(utc(2020, 7, 20, 20, 59)), true, 'monday 16:59 EDT');
  assertEqual(isEthSession(utc(2020, 7, 20, 21)), false, 'monday 17:00 EDT break');
  assertEqual(isEthSession(utc(2020, 7, 20, 21, 59)), false, 'monday 17:59 EDT break');
  assertEqual(isEthSession(utc(2020, 7, 20, 22)), true, 'monday 18:00 EDT reopen');
  assertEqual(isEthSession(utc(2020, 7, 17, 20, 59)), true, 'friday 16:59 EDT');
  assertEqual(isEthSession(utc(2020, 7, 17, 21)), false, 'friday 17:00 EDT close');
  assertEqual(isEthSession(utc(2020, 7, 18, 16)), false, 'saturday');
  // Winter (EST, UTC-5): open 23:00 UTC, close 22:00 UTC.
  assertEqual(isEthSession(utc(2020, 1, 13, 22, 59)), false, 'monday 17:59 EST break');
  assertEqual(isEthSession(utc(2020, 1, 13, 23)), true, 'monday 18:00 EST reopen');
  assertEqual(isEthSession(utc(2020, 1, 14, 21, 59)), true, 'tuesday 16:59 EST');
  assertEqual(isEthSession(utc(2020, 1, 14, 22)), false, 'tuesday 17:00 EST break');
  assertEqual(isEthSession(utc(2020, 1, 14, 23)), true, 'tuesday 18:00 EST reopen');
});

test('ETH session date is the date the session closes on', () => {
  assertEqual(ethSessionDayNumber(utc(2020, 7, 19, 22)), utc(2020, 7, 20, 0) / 86400, 'sunday evening -> monday');
  assertEqual(ethSessionDayNumber(utc(2020, 7, 20, 3)), utc(2020, 7, 20, 0) / 86400, 'sunday night stays monday');
  assertEqual(ethSessionDayNumber(utc(2020, 7, 20, 20, 59)), utc(2020, 7, 20, 0) / 86400, 'monday close bar');
  assertEqual(ethSessionDayNumber(utc(2020, 7, 20, 22)), utc(2020, 7, 21, 0) / 86400, 'monday evening -> tuesday');
  assertEqual(ethSessionDayNumber(utc(2020, 1, 13, 23)), utc(2020, 1, 14, 0) / 86400, 'winter 18:00 EST -> next date');
  assertEqual(ethSessionDayNumber(utc(2020, 1, 14, 21, 59)), utc(2020, 1, 14, 0) / 86400, 'winter close bar');
});

test('ETH filter keeps only bars inside 18:00-17:00 New York', () => {
  const src = bars([
    [utc(2020, 7, 19, 21, 59), 1, 2, 0.5, 1.5, 10], // Sunday 17:59 EDT, outside
    [utc(2020, 7, 19, 22), 2, 3, 1.5, 2.5, 11], // Sunday 18:00 EDT, keep
    [utc(2020, 7, 20, 20, 59), 3, 4, 2.5, 3.5, 12], // Monday 16:59 EDT, keep
    [utc(2020, 7, 20, 21), 4, 5, 3.5, 4.5, 13], // Monday 17:00 break, outside
    [utc(2020, 7, 20, 21, 59), 5, 6, 4.5, 5.5, 14], // Monday 17:59 break, outside
    [utc(2020, 7, 20, 22), 6, 7, 5.5, 6.5, 15], // Monday 18:00 EDT, keep
    [utc(2020, 7, 18, 16), 7, 8, 6.5, 7.5, 16], // Saturday, outside
    [utc(2020, 1, 14, 21, 59), 8, 9, 7.5, 8.5, 17], // Tuesday 16:59 EST, keep
    [utc(2020, 1, 14, 22), 9, 10, 8.5, 9.5, 18], // Tuesday 17:00 break, outside
    [utc(2020, 1, 14, 23), 10, 11, 9.5, 10.5, 19] // Tuesday 18:00 EST, keep
  ]);
  const out = filterEthSession(src);
  assertEqual(out.count, 5, 'kept bar count');
  const keptTimes = [
    utc(2020, 7, 19, 22),
    utc(2020, 7, 20, 20, 59),
    utc(2020, 7, 20, 22),
    utc(2020, 1, 14, 21, 59),
    utc(2020, 1, 14, 23)
  ];
  const keptClose = [2.5, 3.5, 6.5, 8.5, 10.5];
  const keptVolume = [11, 12, 15, 17, 19];
  for (let i = 0; i < keptTimes.length; i++) {
    assertEqual(out.times[i], keptTimes[i], `kept timestamp ${i}`);
    assertEqual(out.close[i], keptClose[i], `close copied unchanged ${i}`);
    assertEqual(out.volume[i], keptVolume[i], `volume copied unchanged ${i}`);
  }
});
