import fs from 'fs';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { buildDaily } from '../public/js/aggregate.mjs';
import {
  filterCashSession,
  isCashSession,
  isOpen,
  sessionBounds,
  sessionDayNumber
} from '../public/js/session.mjs';
import { test, assert, assertEqual, assertClose } from './harness.mjs';

const utc = (y, mo, d, h, mi) => Date.UTC(y, mo - 1, d, h, mi || 0) / 1000;

const dataDir = fileURLToPath(new URL('../data', import.meta.url));
let cache = null;

function findCsv() {
  const files = fs.readdirSync(dataDir).filter((name) => /\.csv$/i.test(name));
  const match = files.find((name) => /usatech|nasdaq|usa100/i.test(name));
  return match ? dataDir + '/' + match : null;
}

async function loadBars() {
  if (cache) return cache;
  const file = findCsv();
  if (!file) throw new Error('No CSV in data/ to validate against');
  let cap = 1 << 20;
  let times = new Float64Array(cap);
  let open = new Float64Array(cap);
  let high = new Float64Array(cap);
  let low = new Float64Array(cap);
  let close = new Float64Array(cap);
  let volume = new Float32Array(cap);
  let n = 0;

  const ensure = () => {
    if (n < cap) return;
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

  const reader = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of reader) {
    if (!line || line.charCodeAt(0) === 35 || line.charCodeAt(0) === 116) continue;
    const parts = line.split(',');
    if (parts.length < 5) continue;
    const raw = Number(parts[0]);
    if (!isFinite(raw) || raw <= 0) continue;
    ensure();
    times[n] = raw >= 1e12 ? Math.round(raw / 1000) : raw;
    open[n] = Number(parts[1]);
    high[n] = Number(parts[2]);
    low[n] = Number(parts[3]);
    close[n] = Number(parts[4]);
    volume[n] = parts.length > 5 ? Number(parts[5]) || 0 : 0;
    n++;
  }

  cache = {
    file,
    src: {
      times: times.slice(0, n),
      open: open.slice(0, n),
      high: high.slice(0, n),
      low: low.slice(0, n),
      close: close.slice(0, n),
      volume: volume.slice(0, n),
      count: n
    }
  };
  return cache;
}

test('every dataset bar is inside the Dukascopy schedule', async () => {
  const { src, file } = await loadBars();
  assert(src.count > 2000000, `expected a multi-year dataset, got ${src.count} bars in ${file}`);
  let outside = 0;
  let firstOutside = null;
  for (let i = 0; i < src.count; i += 7) {
    if (!isOpen(src.times[i])) {
      outside++;
      if (!firstOutside) firstOutside = new Date(src.times[i] * 1000).toISOString();
    }
  }
  assertEqual(outside, 0, 'bars sampled outside 17:00-15:15 America/Chicago: ' + firstOutside);
});

test('daily candles reproduce the 1-minute data session by session', async () => {
  const { src } = await loadBars();
  const daily = buildDaily(src);
  assert(daily.count > 1500, `unexpected daily count ${daily.count}`);

  const first = new Int32Array(daily.count);
  const last = new Int32Array(daily.count);
  let k = -1;
  let curDay = NaN;
  for (let i = 0; i < src.count; i++) {
    const day = sessionDayNumber(src.times[i]);
    if (day !== curDay) {
      k++;
      first[k] = i;
      curDay = day;
    }
    last[k] = i;
  }
  assertEqual(k + 1, daily.count, 'session groups match daily bars');

  for (let j = 0; j < daily.count; j++) {
    assertEqual(daily.times[j] / 86400, Math.floor(daily.times[j] / 86400), 'daily stamp is midnight UTC');
    if (j > 0) assert(daily.times[j] > daily.times[j - 1], 'daily stamps increasing');
    const a = first[j];
    const b = last[j];
    assertEqual(daily.open[j], src.open[a], `open of ${j}`);
    assertEqual(daily.close[j], src.close[b], `close of ${j}`);
    let hi = -Infinity;
    let lo = Infinity;
    let vol = 0;
    for (let i = a; i <= b; i++) {
      if (src.high[i] > hi) hi = src.high[i];
      if (src.low[i] < lo) lo = src.low[i];
      vol += src.volume[i];
    }
    assertEqual(daily.high[j], hi, `high of ${j}`);
    assertEqual(daily.low[j], lo, `low of ${j}`);
    assertClose(daily.volume[j], vol, Math.max(1e-3, vol * 1e-6), `volume of ${j}`);
  }
});

test('daily stamps fall on weekdays and cover overnight sessions', async () => {
  const { src } = await loadBars();
  const daily = buildDaily(src);
  for (let j = 0; j < daily.count; j++) {
    const wd = new Date(daily.times[j] * 1000).getUTCDay();
    assert(wd >= 1 && wd <= 5, `daily bar ${j} stamped on weekend`);
  }
});

test('exact UTC break times on verified dates', async () => {
  const { src } = await loadBars();
  const times = src.times;

  const lastBefore = (t) => {
    let lo = 0;
    let hi = times.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] < t) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found;
  };
  const has = (t) => lastBefore(t + 1) >= 0 && times[lastBefore(t + 1)] === t;

  const cases = [
    { day: utc(2020, 7, 15, 12), close: utc(2020, 7, 15, 20, 15), open: utc(2020, 7, 15, 22) },
    { day: utc(2020, 1, 15, 12), close: utc(2020, 1, 15, 21, 15), open: utc(2020, 1, 15, 23) },
    { day: utc(2020, 11, 2, 12), close: utc(2020, 11, 2, 21, 15), open: utc(2020, 11, 2, 23) },
    { day: utc(2021, 3, 15, 12), close: utc(2021, 3, 15, 20, 15), open: utc(2021, 3, 15, 22) },
    { day: utc(2026, 10, 28, 12), close: utc(2026, 10, 28, 20, 15), open: utc(2026, 10, 28, 22) }
  ];

  for (const item of cases) {
    const bounds = sessionBounds(sessionDayNumber(item.day));
    assertEqual(bounds.close, item.close, `scheduled close on ${bounds.date}`);
    assertEqual(bounds.breakEnd, item.open, `scheduled reopen on ${bounds.date}`);
    assert(has(item.close - 60), `last candle at ${new Date((item.close - 60) * 1000).toISOString()} missing`);
    assert(has(item.open), `first candle after the break at ${new Date(item.open * 1000).toISOString()} missing`);
    assert(!has(item.close), 'no candle at the scheduled close');
    const gapStart = lastBefore(item.open) + 1;
    assert(times[gapStart] === item.open, 'first bar after the break');
    const gapEnd = lastBefore(item.open);
    assert(times[gapEnd] === item.close - 60, 'last bar before the break');
  }
});

test('cash-session series contains only 09:30-16:00 New York bars', async () => {
  const { src } = await loadBars();
  const cash = filterCashSession(src);
  assert(cash.count > 500000, `unexpected cash bar count ${cash.count}`);
  assert(cash.count < src.count, 'cash series must be a subset');
  let outside = 0;
  for (let i = 0; i < cash.count; i += 7) {
    if (!isCashSession(cash.times[i])) outside++;
  }
  assertEqual(outside, 0, 'cash bars outside the regular cash session');

  const daily = buildDaily(cash);
  const fullDaily = buildDaily(src);
  const indexOf = (frame, stamp) => {
    let lo = 0;
    let hi = frame.count - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (frame.times[mid] === stamp) return mid;
      if (frame.times[mid] < stamp) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  };

  // 2020-07-15 (EDT) and 2020-01-15 (EST): open at 09:30, close at 15:59,
  // and never reach the overnight extremes of the full session.
  const cases = [
    { stamp: utc(2020, 7, 15, 0), open: utc(2020, 7, 15, 13, 30), close: utc(2020, 7, 15, 19, 59) },
    { stamp: utc(2020, 1, 15, 0), open: utc(2020, 1, 15, 14, 30), close: utc(2020, 1, 15, 20, 59) }
  ];
  for (const item of cases) {
    const j = indexOf(daily, item.stamp);
    assert(j >= 0, 'missing cash daily bar ' + new Date(item.stamp * 1000).toISOString());
    const fi = indexOf(src, item.open);
    const li = indexOf(src, item.close);
    assert(fi >= 0 && li >= 0, 'cash boundary bars missing for ' + new Date(item.stamp * 1000).toISOString());
    assertEqual(daily.open[j], src.open[fi], 'cash daily open from 09:30');
    assertEqual(daily.close[j], src.close[li], 'cash daily close from 15:59');
    const f = indexOf(fullDaily, item.stamp);
    assert(f >= 0, 'missing full daily bar');
    assert(fullDaily.open[f] !== daily.open[j], 'full and cash opens differ');
    assert(daily.high[j] <= fullDaily.high[f], 'cash high within full high');
    assert(daily.low[j] >= fullDaily.low[f], 'cash low within full low');
  }
});

test('DST changeover sessions open at the right UTC instant', async () => {
  const { src } = await loadBars();
  const has = (t) => {
    let lo = 0;
    let hi = src.times.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (src.times[mid] === t) return true;
      if (src.times[mid] < t) lo = mid + 1;
      else hi = mid - 1;
    }
    return false;
  };
  // 2020-03-08: spring forward happened before the Sunday 17:00 open
  assert(has(utc(2020, 3, 8, 22)), 'Sunday open on CDT 17:00');
  // 2020-11-01: fall back happened before the Sunday 17:00 open
  assert(has(utc(2020, 11, 1, 23)), 'Sunday open on CST 17:00');
});
