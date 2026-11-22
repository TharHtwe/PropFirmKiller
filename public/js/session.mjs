/*
 * Dukascopy USATECH.IDX/USD trading calendar.
 *
 * Verified against 2,334,599 one-minute bars (2020-01-01 .. 2026-10-29):
 * every bar falls inside 17:00-15:15 America/Chicago, the last bar of each
 * session is 15:14 Chicago, the session reopens at 17:00 Chicago, the weekly
 * close is Friday 15:14 and the weekly open is Sunday 17:00. No bar was found
 * inside the daily maintenance break or on a weekend.
 *
 * The session date of a bar is the Chicago calendar date it closes on. Bars
 * from 17:00 onward therefore belong to the next date, which keeps overnight
 * candles attached to the correct trading day.
 */

import {
  tzParts,
  tzOffsetSec,
  tzWallToUtc,
  formatCalendarDate,
  isValidTimeZone,
  DEFAULT_TZ,
  pad2
} from './time.mjs';

export const DEFAULT_SCHEDULE = Object.freeze({
  timeZone: 'America/Chicago',
  openMinute: 17 * 60,
  closeMinute: 15 * 60 + 15
});

export const CASH_TIME_ZONE = DEFAULT_TZ;
export const CASH_OPEN_MINUTE = 9 * 60 + 30;
export const CASH_CLOSE_MINUTE = 16 * 60;

// CME electronic trading hours: 18:00-17:00 New York with a daily
// 17:00-18:00 break, so Monday-Thursday trade 23 h and Friday closes at 17:00.
export const ETH_TIME_ZONE = DEFAULT_TZ;
export const ETH_OPEN_MINUTE = 18 * 60;
export const ETH_CLOSE_MINUTE = 17 * 60;

let schedule = {
  timeZone: DEFAULT_SCHEDULE.timeZone,
  openMinute: DEFAULT_SCHEDULE.openMinute,
  closeMinute: DEFAULT_SCHEDULE.closeMinute
};

export function getSchedule() {
  return { ...schedule };
}

export function setSchedule(next) {
  const cfg = Object.assign({}, schedule, next || {});
  if (!(Number.isInteger(cfg.openMinute) && cfg.openMinute >= 0 && cfg.openMinute < 1440)) {
    throw new Error('Schedule open minute must be 0..1439');
  }
  if (!(Number.isInteger(cfg.closeMinute) && cfg.closeMinute >= 0 && cfg.closeMinute < 1440)) {
    throw new Error('Schedule close minute must be 0..1439');
  }
  if (!isValidTimeZone(cfg.timeZone)) throw new Error('Unknown schedule time zone: ' + cfg.timeZone);
  schedule = { timeZone: cfg.timeZone, openMinute: cfg.openMinute, closeMinute: cfg.closeMinute };
  return getSchedule();
}

export function resetSchedule() {
  return setSchedule(DEFAULT_SCHEDULE);
}

function minuteLabel(minute) {
  return `${pad2(Math.floor(minute / 60))}:${pad2(minute % 60)}`;
}

export function scheduleLabel() {
  return `${minuteLabel(schedule.openMinute)}-${minuteLabel(schedule.closeMinute)} ${schedule.timeZone}`;
}

function isOvernight() {
  return schedule.openMinute > schedule.closeMinute;
}

function civilFromDays(z) {
  const d = new Date(z * 86400000);
  return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
}

// Trading-session date (days since epoch) for an instant. Kept allocation-free
// because it runs once per one-minute bar while building daily candles.
let lastHour = NaN;
let lastOffset = 0;
let lastZone = '';

function scheduleOffset(t) {
  const hour = Math.floor(t / 3600);
  if (hour === lastHour && lastZone === schedule.timeZone) return lastOffset;
  lastOffset = tzOffsetSec(t, schedule.timeZone);
  lastHour = hour;
  lastZone = schedule.timeZone;
  return lastOffset;
}

export function sessionDayNumber(ts) {
  const t = Math.floor(ts);
  const local = t + scheduleOffset(t);
  const day = Math.floor(local / 86400);
  const minuteOfDay = Math.floor((local - day * 86400) / 60);
  if (isOvernight() && minuteOfDay >= schedule.openMinute) return day + 1;
  return day;
}

export function sessionDateKey(ts) {
  return formatCalendarDate(sessionDayNumber(ts) * 86400);
}

/*
 * ETH trading date: the session opens at 18:00 New York and closes at 17:00
 * the next day, so an evening bar belongs to the date it closes on (Sunday
 * 18:00 starts Monday's session). Run it only on ETH-filtered bars, which
 * never sit inside the 17:00-18:00 break.
 */
let ethHour = NaN;
let ethOffsetSec = 0;

function ethZoneOffset(t) {
  const hour = Math.floor(t / 3600);
  if (hour === ethHour) return ethOffsetSec;
  ethOffsetSec = tzOffsetSec(t, ETH_TIME_ZONE);
  ethHour = hour;
  return ethOffsetSec;
}

export function ethSessionDayNumber(ts) {
  const t = Math.floor(ts);
  const local = t + ethZoneOffset(t);
  const day = Math.floor(local / 86400);
  const minuteOfDay = Math.floor((local - day * 86400) / 60);
  return minuteOfDay >= ETH_OPEN_MINUTE ? day + 1 : day;
}

// UTC instants of the session that closes on the given session date.
export function sessionBounds(dayNumber) {
  const [y, mo, d] = civilFromDays(dayNumber);
  const openHour = Math.floor(schedule.openMinute / 60);
  const openMin = schedule.openMinute % 60;
  const closeHour = Math.floor(schedule.closeMinute / 60);
  const closeMin = schedule.closeMinute % 60;
  if (isOvernight()) {
    const [py, pmo, pd] = civilFromDays(dayNumber - 1);
    const open = tzWallToUtc(py, pmo, pd, openHour, openMin, 0, schedule.timeZone);
    const close = tzWallToUtc(y, mo, d, closeHour, closeMin, 0, schedule.timeZone);
    const breakEnd = tzWallToUtc(y, mo, d, openHour, openMin, 0, schedule.timeZone);
    return { open, close, breakStart: close, breakEnd, date: formatCalendarDate(dayNumber * 86400) };
  }
  const open = tzWallToUtc(y, mo, d, openHour, openMin, 0, schedule.timeZone);
  const close = tzWallToUtc(y, mo, d, closeHour, closeMin, 0, schedule.timeZone);
  return { open, close, breakStart: close, breakEnd: close, date: formatCalendarDate(dayNumber * 86400) };
}

export function isOpenAt(weekday, minuteOfDay) {
  if (isOvernight()) {
    if (weekday >= 1 && weekday <= 4) return minuteOfDay <= schedule.closeMinute || minuteOfDay >= schedule.openMinute;
    if (weekday === 5) return minuteOfDay <= schedule.closeMinute;
    if (weekday === 0) return minuteOfDay >= schedule.openMinute;
    return false;
  }
  if (weekday >= 1 && weekday <= 5) {
    return minuteOfDay >= schedule.openMinute && minuteOfDay <= schedule.closeMinute;
  }
  return false;
}

export function isOpen(ts) {
  const p = tzParts(ts, schedule.timeZone);
  return isOpenAt(p.weekday, p.minuteOfDay);
}

export function isDailyBreak(ts) {
  if (!isOvernight()) return false;
  const p = tzParts(ts, schedule.timeZone);
  if (p.weekday < 1 || p.weekday > 5) return false;
  return p.minuteOfDay > schedule.closeMinute && p.minuteOfDay < schedule.openMinute;
}

// Regular US cash session: Monday-Friday, 09:30-16:00 America/New_York.
export function isCashSession(ts, tz) {
  const zone = tz || CASH_TIME_ZONE;
  const p = tzParts(ts, zone);
  if (p.weekday === 0 || p.weekday === 6) return false;
  return p.minuteOfDay >= CASH_OPEN_MINUTE && p.minuteOfDay < CASH_CLOSE_MINUTE;
}

/*
 * CME regular electronic session: Sunday 18:00 -> Friday 17:00 New York.
 * Saturday has no bars and every weekday is closed for the daily 17:00-18:00
 * break, which is what the 18:00 open and 17:00 close interval drops.
 */
export function isEthOpenAt(weekday, minuteOfDay) {
  if (weekday === 0) return minuteOfDay >= ETH_OPEN_MINUTE;
  if (weekday === 6) return false;
  if (weekday === 5) return minuteOfDay < ETH_CLOSE_MINUTE;
  return minuteOfDay < ETH_CLOSE_MINUTE || minuteOfDay >= ETH_OPEN_MINUTE;
}

export function isEthSession(ts, tz) {
  const p = tzParts(ts, tz || ETH_TIME_ZONE);
  return isEthOpenAt(p.weekday, p.minuteOfDay);
}

/*
 * Session dataset filter: keeps only the bars whose New York clock time is
 * inside the window, so every timeframe is aggregated from those candles
 * alone. The zone offset is resolved once per hour bucket because it runs over
 * millions of bars and DST transitions land on whole hours.
 */
function filterByClock(src, zone, keep) {
  const n = src.count;
  const times = new Float64Array(n);
  const open = new Float64Array(n);
  const high = new Float64Array(n);
  const low = new Float64Array(n);
  const close = new Float64Array(n);
  const volume = new Float32Array(n);
  let w = 0;
  let hour = NaN;
  let offset = 0;
  for (let i = 0; i < n; i++) {
    const t = Math.floor(src.times[i]);
    const h = Math.floor(t / 3600);
    if (h !== hour) {
      hour = h;
      offset = tzOffsetSec(t, zone);
    }
    const local = t + offset;
    const day = Math.floor(local / 86400);
    const minuteOfDay = Math.floor((local - day * 86400) / 60);
    const weekday = (((day + 4) % 7) + 7) % 7;
    if (!keep(weekday, minuteOfDay)) continue;
    times[w] = src.times[i];
    open[w] = src.open[i];
    high[w] = src.high[i];
    low[w] = src.low[i];
    close[w] = src.close[i];
    volume[w] = src.volume[i];
    w++;
  }
  return {
    times: times.slice(0, w),
    open: open.slice(0, w),
    high: high.slice(0, w),
    low: low.slice(0, w),
    close: close.slice(0, w),
    volume: volume.slice(0, w),
    count: w
  };
}

export function filterCashSession(src, tz) {
  return filterByClock(src, tz || CASH_TIME_ZONE, (weekday, minuteOfDay) =>
    weekday >= 1 && weekday <= 5 &&
    minuteOfDay >= CASH_OPEN_MINUTE && minuteOfDay < CASH_CLOSE_MINUTE);
}

export function filterEthSession(src, tz) {
  return filterByClock(src, tz || ETH_TIME_ZONE, isEthOpenAt);
}

const BREAK_FILL = 'rgba(242, 193, 78, 0.08)';
const BREAK_COLOR = 'rgba(242, 193, 78, 0.55)';

/*
 * Maintenance-break descriptors for a visible range, in ascending time order.
 * Break periods have no bars, so on an index-based axis they collapse to zero
 * width and the overlay draws them as a marker at the closed interval.
 */
export function sessionBands(from, to, options) {
  const opts = options || {};
  const tfSec = opts.tfSec || 60;
  const bands = [];
  if (!(to > from) || tfSec >= 86400) return bands;

  const firstSession = sessionDayNumber(from - 86400);
  const lastSession = sessionDayNumber(to + 86400);
  for (let day = firstSession; day <= lastSession; day++) {
    const bounds = sessionBounds(day);
    if (bounds.breakStart < from - 7200 || bounds.breakStart > to + 7200) continue;
    bands.push({
      kind: 'break',
      from: bounds.breakStart,
      to: bounds.breakEnd,
      fill: BREAK_FILL,
      color: BREAK_COLOR
    });
  }
  return bands;
}
