import fs from 'fs';
import { fileURLToPath } from 'url';
import { createCsvParser } from '../public/js/csvParse.mjs';
import { buildDaily, buildDailyEth, buildDailyUtc } from '../public/js/aggregate.mjs';
import { filterEthSession, isEthSession } from '../public/js/session.mjs';
import {
  buildRowLayout,
  classifyFormat,
  formatRow,
  parseFileName,
  parseUtcStamp
} from '../public/js/csvFormat.mjs';
import { test, assert, assertEqual } from './harness.mjs';

const HEADER = '<DATE>\t<TIME>\t<OPEN>\t<HIGH>\t<LOW>\t<CLOSE>\t<TICKVOL>\t<VOL>\t<SPREAD>';
const ROWS = [
  '2020.01.02\t01:05:00\t8771.16\t8771.29\t8770.66\t8770.92\t18\t0\t65',
  '2020.01.02\t01:06:00\t8770.79\t8771.82\t8770.77\t8771.54\t24\t0\t65',
  '2020.01.02\t23:59:00\t8760.10\t8762.00\t8759.00\t8761.50\t11\t0\t70',
  '2020.01.03\t00:00:00\t8761.50\t8765.00\t8761.00\t8764.25\t9\t0\t70'
];

function parseText(text, chunkSize) {
  const parser = createCsvParser({});
  const size = chunkSize || 4096;
  for (let i = 0; i < text.length; i += size) parser.push(text.slice(i, i + size));
  return parser.finish();
}

test('MT5 tab export is detected and parsed as UTC', () => {
  const result = parseText(HEADER + '\r\n' + ROWS.join('\r\n') + '\r\n');
  assertEqual(result.kind, 'mt5', 'format kind');
  assertEqual(result.calendar, 'utc', 'calendar');
  assertEqual(result.count, 4, 'row count');
  assertEqual(result.times[0], Date.UTC(2020, 0, 2, 1, 5) / 1000, 'first stamp');
  assertEqual(result.times[3], Date.UTC(2020, 0, 3, 0, 0) / 1000, 'last stamp');
  assertEqual(result.open[0], 8771.16, 'open untouched');
  assertEqual(result.high[0], 8771.29, 'high untouched');
  assertEqual(result.low[0], 8770.66, 'low untouched');
  assertEqual(result.close[0], 8770.92, 'close untouched');
  assertEqual(result.volume[0], 18, 'tick volume used as bar volume');
  assertEqual(parseUtcStamp('2020.01.02 01:05:00'), result.times[0], 'stamp helper agrees');
});

test('CRLF rows split across chunks keep every bar', () => {
  const result = parseText(HEADER + '\r\n' + ROWS.join('\r\n'), 1);
  assertEqual(result.count, 4, 'row count');
  assertEqual(result.times[1] - result.times[0], 60, 'one-minute spacing');
  assertEqual(result.close[1], 8771.54, 'close of second bar');
});

test('headerless MT5 rows are recognised by their tab layout', () => {
  const fmt = classifyFormat(ROWS[0]);
  assertEqual(fmt.kind, 'mt5', 'kind');
  assertEqual(fmt.layout, 'date-time', 'layout');
  assertEqual(fmt.delimiter, '\t', 'delimiter');
  assertEqual(fmt.openCol, 2, 'open column');
  assertEqual(fmt.volumeCol, 6, 'tick volume column');
  const result = parseText(ROWS.join('\r\n'));
  assertEqual(result.count, 4, 'row count without header');
});

test('UTC daily candles split at midnight UTC, not at the Dukascopy close', () => {
  const result = parseText(HEADER + '\r\n' + ROWS.join('\r\n'));
  const daily = buildDailyUtc(result);
  assertEqual(daily.count, 2, 'two UTC calendar days');
  assertEqual(daily.times[0], Date.UTC(2020, 0, 2) / 1000, 'first UTC day');
  assertEqual(daily.open[0], 8771.16, 'day open');
  assertEqual(daily.high[0], 8771.82, 'day high');
  assertEqual(daily.low[0], 8759, 'day low');
  assertEqual(daily.close[0], 8761.5, 'day close');
  assertEqual(daily.volume[0], 53, 'day volume');
  assertEqual(daily.open[1], 8761.5, 'second day open');
  const dukascopy = buildDaily(result);
  assertEqual(dukascopy.count, 2, 'Dukascopy calendar also has two sessions');
  assertEqual(dukascopy.open[0], 8771.16, 'Dukascopy session open');
  assertEqual(dukascopy.close[0], 8771.54, 'Dukascopy session closes before the 23:59 bar');
  assertEqual(dukascopy.close[1], 8764.25, 'overnight bar joins the next Dukascopy session');
});

test('formatRow reproduces the MT5 layout it read', () => {
  const layout = buildRowLayout(HEADER, ROWS[0]);
  const bar = {
    t: Date.UTC(2026, 9, 29, 14, 7) / 1000,
    o: 29422.1,
    h: 29430,
    l: 29420,
    c: 29425.5,
    tick_volume: 12,
    real_volume: 0,
    spread: 80
  };
  assertEqual(
    formatRow(layout, bar),
    '2026.10.29\t14:07:00\t29422.10\t29430.00\t29420.00\t29425.50\t12\t0\t80',
    'formatted row'
  );
  const bare = buildRowLayout(ROWS[0], ROWS[0]);
  assertEqual(formatRow(bare, bar).split('\t').length, 9, 'headerless layout keeps nine columns');
  assert(formatRow(bare, bar).startsWith('2026.10.29\t14:07:00\t29422.10'), 'headerless row');
});

test('MT5 file names carry the symbol and timeframe', () => {
  const info = parseFileName('US100_M1_202001020105_202610291406.csv');
  assertEqual(info.symbol, 'US100', 'symbol');
  assertEqual(info.timeframe, 'M1', 'timeframe');
  assertEqual(info.timeframeSec, 60, 'timeframe seconds');
  const other = parseFileName('usatechidxusd-m1-bid-2020-01-01-2026-10-25.csv');
  assertEqual(other.timeframe, null, 'Dukascopy name has no MT5 code');
});

const dataDir = fileURLToPath(new URL('../data', import.meta.url));
const MT5_FILE = dataDir + '/US100_M1_202001020105_202610291406.csv';
let fullCache = null;

async function loadFull() {
  if (fullCache) return fullCache;
  if (!fs.existsSync(MT5_FILE)) return null;
  const parser = createCsvParser({});
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(MT5_FILE, { encoding: 'utf8', highWaterMark: 1 << 20 });
    stream.on('data', (chunk) => parser.push(chunk));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  fullCache = parser.finish();
  return fullCache;
}

test('full MT5 export parses as UTC end to end', async () => {
  const result = await loadFull();
  if (!result) return;
  assertEqual(result.kind, 'mt5', 'kind');
  assertEqual(result.calendar, 'utc', 'calendar');
  assert(result.count > 2387421, 'row count ' + result.count);
  assertEqual(result.times[0], Date.UTC(2020, 0, 2, 1, 5) / 1000, 'first bar in UTC');
  // The file is append-only: it never ends before the export stamp in its name.
  assert(result.times[result.count - 1] >= Date.UTC(2026, 9, 29, 14, 6) / 1000, 'last bar in UTC');
  assert(!result.unsorted && !result.duplicated, 'rows sorted without duplicates');
  const daily = buildDailyUtc(result);
  assert(daily.count > 1500, 'daily bars ' + daily.count);
  assertEqual(daily.times[0], Date.UTC(2020, 0, 2) / 1000, 'first UTC day');
  assert(daily.times[daily.count - 1] >= Date.UTC(2026, 9, 29) / 1000, 'last UTC day');
});

test('ETH filter and session days over the full MT5 export', async () => {
  const full = await loadFull();
  if (!full) return;
  const eth = filterEthSession(full);
  assert(eth.count < full.count, 'ETH bars ' + eth.count + ' of ' + full.count);
  assert(full.count - eth.count > 50000, 'bars dropped ' + (full.count - eth.count));
  let outside = 0;
  for (let i = 0; i < eth.count; i += 997) {
    if (!isEthSession(eth.times[i])) outside++;
  }
  assertEqual(outside, 0, 'sampled kept bars outside ETH');
  let seeOutsider = 0;
  for (let i = 0; i < full.count; i += 1009) {
    if (!isEthSession(full.times[i])) seeOutsider++;
  }
  assert(seeOutsider > 0, 'feed has bars outside ETH');
  const daily = buildDailyEth(eth);
  assert(daily.count > 1700 && daily.count < 2000, 'ETH daily bars ' + daily.count);
  assertEqual(daily.times[0], Date.UTC(2020, 0, 2) / 1000, 'first ETH day');
  for (let i = 1; i < daily.count; i++) {
    assert(daily.times[i] > daily.times[i - 1], 'ETH daily stamps increasing at ' + i);
  }
  for (let i = 0; i < daily.count; i += 97) {
    assertEqual(daily.times[i] % 86400, 0, 'ETH daily stamp at UTC midnight');
  }
  // First session in the feed (2020-01-01 18:00 ET -> 2020-01-02 17:00 ET).
  assertEqual(daily.open[0], 8771.16, 'first ETH day open');
  assertEqual(daily.high[0], 8863.6, 'first ETH day high');
  assertEqual(daily.low[0], 8769.33, 'first ETH day low');
  assertEqual(daily.close[0], 8862.1, 'first ETH day close');
  assertEqual(daily.volume[0], 65714, 'first ETH day tick volume');
});
