/*
 * CSV -> typed arrays -> timeframe aggregation.
 * Keeps the full dataset in this worker and serves windowed slices to the UI.
 * Runs as an ES module worker so it can share parsing, session and timezone
 * rules with the main thread and the tests.
 */

import { TFS, buildDaily, buildDailyUtc, buildDailyEth, aggregateDaily, aggregate } from './aggregate.mjs';
import { filterCashSession, filterEthSession, getSchedule } from './session.mjs';
import { createCsvParser } from './csvParse.mjs';

let source = null; // complete 1-minute series of the loaded CSV
let sourceName = 'dataset';
let kind = 'dukascopy';
let calendar = 'dukascopy';
let mode = 'full';
let frames = Object.create(null);
let meta = null;

self.onmessage = (event) => {
  const msg = event.data || {};
  Promise.resolve()
    .then(() => handle(msg))
    .catch((err) => {
      self.postMessage({
        type: 'error',
        id: msg.id,
        message: String((err && err.message) || err)
      });
    });
};

async function handle(msg) {
  switch (msg.cmd) {
    case 'loadUrl':
      await loadUrl(msg);
      break;
    case 'loadBuffer':
      await loadBuffer(msg);
      break;
    case 'window':
      sendWindow(msg);
      break;
    case 'find':
      sendFind(msg);
      break;
    case 'setMode':
      setMode(msg);
      break;
    default:
      break;
  }
}

function normalizeMode(value) {
  return value === 'cash' || value === 'eth' ? value : 'full';
}

function setMode(msg) {
  if (!source) throw new Error('Load a dataset before changing the session mode');
  const next = normalizeMode(msg.mode);
  if (next === mode) {
    self.postMessage({ type: 'ready', meta });
    return;
  }
  mode = next;
  rebuild();
}

/*
 * Builds every timeframe from either the full series or the cash-session
 * subset of it. Switching modes only re-aggregates; the parsed CSV is never
 * modified.
 */
function rebuild() {
  const src = mode === 'cash' ? filterCashSession(source)
    : mode === 'eth' ? filterEthSession(source)
    : source;
  if (mode !== 'full') {
    self.postMessage({ type: 'progress', phase: 'aggregate', index: 0, count: 11, tf: 'filtering' });
  }
  frames = buildFrames(src, mode === 'eth' ? 'eth' : calendar);
  meta = {
    name: sourceName,
    mode,
    kind,
    calendar,
    barCount: src.count,
    firstTime: src.count ? src.times[0] : null,
    lastTime: src.count ? src.times[src.count - 1] : null,
    schedule: getSchedule(),
    frames: TFS.map((tf) => ({
      id: tf.id,
      sec: tf.sec,
      count: frames[tf.id].count
    }))
  };
  self.postMessage({ type: 'ready', meta });
}

async function loadUrl(msg) {
  mode = normalizeMode(msg.mode);
  const response = await fetch(msg.url, { cache: 'no-store' });
  if (!response.ok) throw new Error('HTTP ' + response.status + ' while fetching CSV');
  if (!response.body) throw new Error('This browser cannot stream the CSV response');
  const total = Number(response.headers.get('content-length')) || 0;
  await parseStream(response.body.getReader(), total, msg.name || 'dataset.csv');
}

async function loadBuffer(msg) {
  mode = normalizeMode(msg.mode);
  const buffer = msg.buffer;
  if (!buffer) throw new Error('No file buffer received');
  const blob = new Blob([buffer]);
  await parseStream(blob.stream().getReader(), buffer.byteLength, msg.name || 'local.csv');
}

async function parseStream(reader, totalBytes, name) {
  const decoder = new TextDecoder('utf-8');
  let loaded = 0;
  let lastProgressAt = 0;

  const parser = createCsvParser({
    totalBytes,
    onProgress: (rows) => {
      const now = Date.now();
      if (now - lastProgressAt < 120) return;
      lastProgressAt = now;
      self.postMessage({ type: 'progress', phase: 'parse', loaded, total: totalBytes || 0, rows });
    }
  });

  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    if (chunk.value) loaded += chunk.value.byteLength || chunk.value.length || 0;
    parser.push(decoder.decode(chunk.value, { stream: true }));
  }
  parser.push(decoder.decode());

  const result = parser.finish();
  self.postMessage({
    type: 'progress',
    phase: 'parse',
    loaded,
    total: totalBytes || 0,
    rows: result.count
  });
  if (result.count < 2) throw new Error('No usable rows found in the CSV file');

  let data = {
    times: result.times,
    open: result.open,
    high: result.high,
    low: result.low,
    close: result.close,
    volume: result.volume,
    count: result.count
  };
  if (result.unsorted || result.duplicated) {
    self.postMessage({ type: 'progress', phase: 'aggregate', index: 0, count: 11, tf: 'sorting' });
    data = normalize(data, result.unsorted);
  }

  source = data;
  sourceName = name;
  kind = result.kind;
  calendar = result.calendar;
  rebuild();
}

function normalize(data, unsorted) {
  const n = data.count;
  let order = null;
  if (unsorted) {
    order = new Uint32Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    order.sort((a, b) => data.times[a] - data.times[b]);
  }
  const t = new Float64Array(n);
  const o = new Float64Array(n);
  const h = new Float64Array(n);
  const l = new Float64Array(n);
  const c = new Float64Array(n);
  const v = new Float32Array(n);
  let w = 0;
  let prev = -Infinity;
  for (let k = 0; k < n; k++) {
    const i = order ? order[k] : k;
    const tv = data.times[i];
    if (tv === prev) {
      o[w - 1] = data.open[i];
      h[w - 1] = data.high[i];
      l[w - 1] = data.low[i];
      c[w - 1] = data.close[i];
      v[w - 1] = data.volume[i];
      continue;
    }
    t[w] = tv;
    o[w] = data.open[i];
    h[w] = data.high[i];
    l[w] = data.low[i];
    c[w] = data.close[i];
    v[w] = data.volume[i];
    w++;
    prev = tv;
  }
  return {
    times: t.slice(0, w),
    open: o.slice(0, w),
    high: h.slice(0, w),
    low: l.slice(0, w),
    close: c.slice(0, w),
    volume: v.slice(0, w),
    count: w
  };
}

function buildFrames(src, calendarMode) {
  const out = Object.create(null);
  out['1m'] = {
    tfSec: 60,
    times: src.times,
    open: src.open,
    high: src.high,
    low: src.low,
    close: src.close,
    volume: src.volume,
    count: src.count
  };
  const list = TFS.slice(1);
  for (let k = 0; k < list.length; k++) {
    const tf = list[k];
    if (tf.kind === 'day') {
      out[tf.id] = calendarMode === 'utc' ? buildDailyUtc(src)
        : calendarMode === 'eth' ? buildDailyEth(src)
        : buildDaily(src);
    } else if (tf.kind === 'fixed') out[tf.id] = aggregate(src, tf);
    else out[tf.id] = aggregateDaily(out['1D'], tf);
    self.postMessage({
      type: 'progress',
      phase: 'aggregate',
      index: k + 1,
      count: list.length + 1,
      tf: tf.id
    });
  }
  return out;
}

function lastIndexAtOrBefore(times, target, length) {
  let lo = 0;
  let hi = (length === undefined ? times.length : length) - 1;
  let result = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= target) {
      result = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return result;
}

function sendWindow(msg) {
  const frame = frames[msg.tf];
  if (!frame) throw new Error('Unknown timeframe ' + msg.tf);
  let from = Math.max(0, Math.min(frame.count, msg.from | 0));
  let to = Math.max(from, Math.min(frame.count, msg.to | 0));
  const out = {
    type: 'window',
    id: msg.id,
    tf: msg.tf,
    tfSec: frame.tfSec,
    start: from,
    end: to,
    count: frame.count,
    times: frame.times.slice(from, to),
    open: frame.open.slice(from, to),
    high: frame.high.slice(from, to),
    low: frame.low.slice(from, to),
    close: frame.close.slice(from, to),
    volume: frame.volume.slice(from, to)
  };
  self.postMessage(out, [
    out.times.buffer,
    out.open.buffer,
    out.high.buffer,
    out.low.buffer,
    out.close.buffer,
    out.volume.buffer
  ]);
}

function sendFind(msg) {
  const frame = frames[msg.tf];
  if (!frame) throw new Error('Unknown timeframe ' + msg.tf);
  const index = lastIndexAtOrBefore(frame.times, msg.time, frame.count);
  self.postMessage({
    type: 'find',
    id: msg.id,
    tf: msg.tf,
    index,
    count: frame.count,
    tfSec: frame.tfSec,
    firstTime: frame.count ? frame.times[0] : null,
    lastTime: frame.count ? frame.times[frame.count - 1] : null
  });
}
