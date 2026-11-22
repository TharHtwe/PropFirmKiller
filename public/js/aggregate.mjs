/*
 * Timeframe aggregation. Daily candles are bucketed by the calendar that
 * matches the data source, never by guessing:
 *   - Dukascopy data uses trading-session dates (session.mjs), so the overnight
 *     part of a session stays with the day it closes on.
 *   - ETH mode uses the 18:00-17:00 New York session date.
 *   - MT5 full data is UTC; daily candles are the UTC calendar day.
 * OHLCV values are copied/combined, never rescaled.
 */

import { ethSessionDayNumber, sessionDayNumber } from './session.mjs';

export const TFS = [
  { id: '1m', sec: 60, kind: 'fixed' },
  { id: '3m', sec: 180, kind: 'fixed' },
  { id: '5m', sec: 300, kind: 'fixed' },
  { id: '15m', sec: 900, kind: 'fixed' },
  { id: '30m', sec: 1800, kind: 'fixed' },
  { id: '1h', sec: 3600, kind: 'fixed' },
  { id: '4h', sec: 14400, kind: 'fixed' },
  { id: '1D', sec: 86400, kind: 'day' },
  { id: '1W', sec: 604800, kind: 'week' },
  { id: '1M', sec: 2592000, kind: 'month' }
];

export function buildDaily(src) {
  return buildDailyBy(src, sessionDayNumber);
}

export function buildDailyUtc(src) {
  return buildDailyBy(src, (ts) => Math.floor(ts / 86400));
}

export function buildDailyEth(src) {
  return buildDailyBy(src, ethSessionDayNumber);
}

function buildDailyBy(src, dayOf) {
  const n = src.count;
  const st = src.times;
  const so = src.open;
  const sh = src.high;
  const sl = src.low;
  const sc = src.close;
  const sv = src.volume;
  const times = [];
  const open = [];
  const high = [];
  const low = [];
  const close = [];
  const volume = [];

  let curDay = NaN;
  let curOpen = 0;
  let curHigh = 0;
  let curLow = 0;
  let curClose = 0;
  let curVol = 0;
  let has = false;

  const flush = () => {
    if (!has) return;
    times.push(curDay * 86400);
    open.push(curOpen);
    high.push(curHigh);
    low.push(curLow);
    close.push(curClose);
    volume.push(curVol);
  };

  for (let i = 0; i < n; i++) {
    const day = dayOf(st[i]);
    // Out-of-order rows (corrupt CSV) merge into the current bucket so the
    // series stays strictly increasing.
    if (!has || day > curDay) {
      flush();
      curDay = day;
      curOpen = so[i];
      curHigh = sh[i];
      curLow = sl[i];
      curClose = sc[i];
      curVol = sv[i];
      has = true;
    } else {
      const hi = sh[i];
      if (hi > curHigh) curHigh = hi;
      const lo = sl[i];
      if (lo < curLow) curLow = lo;
      curClose = sc[i];
      curVol += sv[i];
    }
  }
  flush();

  return {
    tfSec: 86400,
    times: Float64Array.from(times),
    open: Float64Array.from(open),
    high: Float64Array.from(high),
    low: Float64Array.from(low),
    close: Float64Array.from(close),
    volume: Float32Array.from(volume),
    count: times.length
  };
}

export function aggregateDaily(daily, tf) {
  const n = daily.count;
  const times = [];
  const open = [];
  const high = [];
  const low = [];
  const close = [];
  const volume = [];
  let curKey = NaN;
  for (let i = 0; i < n; i++) {
    const day = Math.floor(daily.times[i] / 86400);
    let key;
    if (tf.kind === 'week') {
      const wd = ((day + 3) % 7 + 7) % 7; // 1970-01-01 was a Thursday; 0 = Monday
      key = (day - wd) * 86400;
    } else {
      const parts = civilFromDays(day);
      key = daysFromCivil(parts[0], parts[1], 1) * 86400;
    }
    if (key !== curKey) {
      curKey = key;
      times.push(key);
      open.push(daily.open[i]);
      high.push(daily.high[i]);
      low.push(daily.low[i]);
      close.push(daily.close[i]);
      volume.push(daily.volume[i]);
    } else {
      if (daily.high[i] > high[high.length - 1]) high[high.length - 1] = daily.high[i];
      if (daily.low[i] < low[low.length - 1]) low[low.length - 1] = daily.low[i];
      close[close.length - 1] = daily.close[i];
      volume[volume.length - 1] += daily.volume[i];
    }
  }
  return {
    tfSec: tf.sec,
    times: Float64Array.from(times),
    open: Float64Array.from(open),
    high: Float64Array.from(high),
    low: Float64Array.from(low),
    close: Float64Array.from(close),
    volume: Float32Array.from(volume),
    count: times.length
  };
}

function civilFromDays(z) {
  z += 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365
  );
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return [y + (m <= 2 ? 1 : 0), m, d];
}

function daysFromCivil(y, m, d) {
  const yy = y - (m <= 2 ? 1 : 0);
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function makeBucketFn(tf) {
  const sec = tf.sec;
  return (t) => Math.floor(t / sec) * sec;
}

export function aggregate(src, tf) {
  const n = src.count;
  const perBucket = Math.max(1, Math.round(tf.sec / 60));

  let cap = Math.max(32, Math.ceil(n / perBucket) + 16);
  let times = new Float64Array(cap);
  let open = new Float64Array(cap);
  let high = new Float64Array(cap);
  let low = new Float64Array(cap);
  let close = new Float64Array(cap);
  let volume = new Float32Array(cap);

  const grow = () => {
    const next = cap * 2;
    const t2 = new Float64Array(next);
    t2.set(times);
    times = t2;
    const o2 = new Float64Array(next);
    o2.set(open);
    open = o2;
    const h2 = new Float64Array(next);
    h2.set(high);
    high = h2;
    const l2 = new Float64Array(next);
    l2.set(low);
    low = l2;
    const c2 = new Float64Array(next);
    c2.set(close);
    close = c2;
    const v2 = new Float32Array(next);
    v2.set(volume);
    volume = v2;
    cap = next;
  };

  const bucketFn = makeBucketFn(tf);
  const st = src.times;
  const so = src.open;
  const sh = src.high;
  const sl = src.low;
  const sc = src.close;
  const sv = src.volume;

  let m = 0;
  let curTime = NaN;
  let curO = 0;
  let curH = 0;
  let curL = 0;
  let curC = 0;
  let curV = 0;

  const flush = () => {
    if (m === cap) grow();
    times[m] = curTime;
    open[m] = curO;
    high[m] = curH;
    low[m] = curL;
    close[m] = curC;
    volume[m] = curV;
    m++;
  };

  for (let i = 0; i < n; i++) {
    const bt = bucketFn(st[i]);
    if (bt !== curTime) {
      if (curTime === curTime) flush();
      curTime = bt;
      curO = so[i];
      curH = sh[i];
      curL = sl[i];
      curC = sc[i];
      curV = sv[i];
    } else {
      const hi = sh[i];
      if (hi > curH) curH = hi;
      const lo = sl[i];
      if (lo < curL) curL = lo;
      curC = sc[i];
      curV += sv[i];
    }
  }
  if (curTime === curTime) flush();

  return {
    tfSec: tf.sec,
    times: times.slice(0, m),
    open: open.slice(0, m),
    high: high.slice(0, m),
    low: low.slice(0, m),
    close: close.slice(0, m),
    volume: volume.slice(0, m),
    count: m
  };
}
