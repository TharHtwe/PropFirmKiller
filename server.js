'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const VENDOR_DIR = path.join(ROOT, 'vendor');
const DATA_DIR = path.join(ROOT, 'data');
const PORT = Number(process.env.PORT) || 8080;
const MT5_HELPER = path.join(ROOT, 'tools', 'mt5_fetch.py');

const STRATEGY_DIR = path.join(ROOT, 'analysis', 'nasdaq-level-retrace-v2');
const STRATEGY_SITE = path.join(STRATEGY_DIR, 'site');
const STRATEGY_RESULTS = path.join(STRATEGY_DIR, 'results');
const STRATEGY_PYTHON = process.env.STRATEGY_PYTHON || process.env.MT5_PYTHON || 'python';
const RUN_ID_RE = /^sl\d+_tp\d+_(london|ny|rth|all)_lv(all|eth|rth)_(rev|cont)_(touch|confirm)_(1m|6m|1y|all)_(every|serial|one|until)(?:_(skip|keep))?$/;

function gridSize(stem) {
  const base = 2 * 4 * 4 * 3 * 2 * 2 * 4 * 4;
  if (!String(stem || '').toUpperCase().startsWith('US100')) return base;
  const perSession = base / 4;
  return base + perSession + perSession;
}

function workerCount(value) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return 1;
  return Math.min(4, Math.max(1, n));
}
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const STRATEGY_MAX_IDS = 12000;

const RISK_DIR = path.join(ROOT, 'analysis', 'risk-factor');
const RISK_SITE = path.join(RISK_DIR, 'site');
const RISK_RESULTS = path.join(RISK_DIR, 'results');
const RISK_PYTHON = process.env.RISK_PYTHON || process.env.STRATEGY_PYTHON || process.env.MT5_PYTHON || 'python';

const PROP_DIR = path.join(ROOT, 'analysis', 'prop-firm');
const PROP_SITE = path.join(PROP_DIR, 'site');
const PROP_RESULTS = path.join(PROP_DIR, 'results');
const PROP_PYTHON = process.env.PROP_PYTHON || process.env.STRATEGY_PYTHON || process.env.MT5_PYTHON || 'python';
const PROP_MAX_IDS = 12000;
const RISK_MAX_IDS = 12000;
const RISK_DEFAULT_FILE = 'US100_M1_202001020105_202610291406.csv';
const RISK_DEFAULT_YEAR = 2026;
const RISK_DEFAULT_MAX_LOT = 100;
// Display copy of rfspec.SPECS; the Python runner is the source of truth.
const RISK_SPECS = {
  US100: { name: 'US100 (Nasdaq)', usd_per_point: 1, margin_rate: 0.01, commission: 3.5, min_lot: 0.1, step: 0.1, max_lot: 100 },
  GBPUSD: { name: 'GBPUSD', usd_per_point: 10, margin_rate: 250, commission: 5, min_lot: 0.01, step: 0.01, max_lot: 100 },
  XAUUSD: { name: 'XAUUSD (Gold)', usd_per_point: 10, margin_rate: 0.2, commission: 5, min_lot: 0.01, step: 0.01, max_lot: 100 },
};

// Shared with the browser worker: header/format detection and row formatting.
const formatModule = import(pathToFileURL(path.join(PUBLIC_DIR, 'js', 'csvFormat.mjs')).href);

const DUKA_HOST = 'jetta.dukascopy.com';
const DUKA_SYMBOL = process.env.DUKA_SYMBOL || 'USATECH.IDX-USD';
const DUKA_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MAX_UPDATE_DAYS = 400;
const DAY_MS = 86400000;
const updating = new Set();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.csv': 'text/csv; charset=utf-8',
  '.map': 'application/json; charset=utf-8'
};

function send(res, status, body, type) {
  res.writeHead(status, {
    'Content-Type': type || 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function isInside(parent, target) {
  const rel = path.relative(parent, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function serveFile(res, baseDir, relPath, cacheControl) {
  const rel = path.posix.normalize('/' + relPath).replace(/^\/+/, '');
  const filePath = path.resolve(baseDir, rel);
  if (!isInside(baseDir, filePath)) return send(res, 403, 'Forbidden');
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) return send(res, 404, 'Not found');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': cacheControl || 'no-store'
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

function listCsvFiles() {
  return fs.readdirSync(DATA_DIR)
    .filter(name => name.toLowerCase().endsWith('.csv'))
    .map(name => {
      const stat = fs.statSync(path.join(DATA_DIR, name));
      return { name, size: stat.size, mtime: stat.mtimeMs };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function csvPath(name) {
  if (!name || name !== path.basename(name) || name.includes('..') || path.extname(name).toLowerCase() !== '.csv') {
    return null;
  }
  const filePath = path.resolve(DATA_DIR, name);
  return isInside(DATA_DIR, filePath) ? filePath : null;
}

function readHead(filePath, bytes) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(bytes, size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function readTail(filePath, bytes) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(bytes, size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

// Median spacing of the last bars: the real timeframe of the file.
async function measureBarSeconds(filePath, fmt) {
  const mod = await formatModule;
  const lines = readTail(filePath, 1 << 16).split(/\r?\n/);
  const times = [];
  for (let i = lines.length - 1; i >= 0 && times.length < 80; i--) {
    const line = lines[i].trim();
    if (!line || line[0] === '<' || line[0] === '#') continue;
    const when = mod.rowTime(line.split(fmt.delimiter), fmt);
    if (isFinite(when) && when > 0) times.push(when);
  }
  if (times.length < 2) return null;
  times.reverse();
  const diffs = [];
  for (let i = 1; i < times.length; i++) {
    const diff = times[i] - times[i - 1];
    if (diff > 0) diffs.push(diff);
  }
  if (!diffs.length) return null;
  diffs.sort((a, b) => a - b);
  return diffs[Math.floor(diffs.length / 2)];
}

// The Dukascopy CSV is headerless, but a headered epoch CSV is valid too: the
// updater appends rows only when the timestamp column holds epoch numbers.
function hasEpochStamp(mod, fmt, sampleLine) {
  if (!sampleLine) return false;
  const fields = mod.splitFields(sampleLine, fmt.delimiter);
  const index = fmt.timestampCol >= 0 ? fmt.timestampCol : fmt.dateCol;
  if (!(index >= 0 && index < fields.length)) return false;
  return /^\d{10,19}$/.test(mod.cleanField(fields[index]));
}

async function csvInfo(name) {
  const mod = await formatModule;
  const filePath = csvPath(name);
  if (!filePath) throw new Error('Invalid file name');
  const stat = fs.statSync(filePath);
  const lines = readHead(filePath, 1 << 14).split(/\r?\n/);
  const fmt = mod.classifyFormat(lines[0] || '');
  const hint = mod.parseFileName(name);
  const spacing = await measureBarSeconds(filePath, fmt);
  const timeframe = mod.timeframeName(spacing) || hint.timeframe || 'M1';
  return {
    name,
    size: stat.size,
    mtime: stat.mtimeMs,
    kind: fmt.kind,
    layout: fmt.layout,
    timeframe,
    barSeconds: spacing || mod.TF_SECONDS[timeframe] || null,
    symbol: hint.symbol || (fmt.kind === 'dukascopy' ? DUKA_SYMBOL : null),
    instrument: strategyInstrument(name.replace(/\.csv$/i, '')),
    updatable: fmt.kind === 'mt5' || (fmt.kind === 'dukascopy' && hasEpochStamp(mod, fmt, lines[1] || ''))
  };
}

async function listCsvInfo() {
  const out = [];
  for (const file of listCsvFiles()) {
    try {
      out.push(await csvInfo(file.name));
    } catch (err) {
      out.push({ ...file, kind: 'unknown', updatable: false, error: String((err && err.message) || err) });
    }
  }
  return out;
}

function readLastRow(filePath, mod, fmt) {
  const size = fs.statSync(filePath).size;
  const len = Math.min(1 << 18, size);
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const endsWithNewline = buf[buf.length - 1] === 10;
    const lines = buf.toString('utf8').split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line || line[0] === '<' || line[0] === '#') continue;
      const when = mod.rowTime(line.split(fmt.delimiter), fmt);
      if (isFinite(when) && when > 0) return { time: when, endsWithNewline };
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/*
 * Runs tools/mt5_fetch.py. The helper prints exactly one JSON object on
 * stdout: { ok, symbol, timeframe, offsetSeconds, rates } or { ok:false, error }.
 */
function runMt5Helper(args, timeoutMs) {
  const python = process.env.MT5_PYTHON || 'python';
  return new Promise((resolve, reject) => {
    const child = spawn(python, [MT5_HELPER].concat(args), { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;
    const finish = (err, payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(payload);
    };
    timer = setTimeout(() => {
      child.kill();
      finish(new Error('MetaTrader 5 fetch timed out after ' + Math.round(timeoutMs / 1000) + 's'));
    }, timeoutMs);
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('error', (err) => {
      const message = err && err.code === 'ENOENT'
        ? 'Python not found ("' + python + '"). Set MT5_PYTHON to your python.exe and install MetaTrader5.'
        : String((err && err.message) || err);
      finish(new Error(message));
    });
    child.on('close', () => {
      let payload = null;
      try {
        payload = JSON.parse(stdout.trim());
      } catch (err) {
        payload = null;
      }
      if (payload && payload.ok === false) {
        finish(new Error(payload.error || 'MetaTrader 5 fetch failed'));
        return;
      }
      if (!payload) {
        const tail = stderr.trim().split(/\r?\n/).slice(-2).join(' ');
        finish(new Error('MetaTrader 5 helper produced no result' + (tail ? ': ' + tail : '')));
        return;
      }
      finish(null, payload);
    });
  });
}

/*
 * Appends the bars MT5 has that the CSV does not. Rows are written in the
 * file's own column order, delimiter, CRLF style and price precision.
 */
async function updateFromMt5(name, info) {
  const mod = await formatModule;
  const filePath = csvPath(name);
  if (!filePath) throw new Error('Invalid file name');
  const head = readHead(filePath, 1 << 14);
  const eol = head.indexOf('\r\n') !== -1 ? '\r\n' : '\n';
  const lines = head.split(/\r?\n/);
  const headerLine = lines[0] ? lines[0].replace(/^\uFEFF/, '') : '';
  const sampleLine = lines.find((line, index) => index > 0 && line.trim()) || '';
  const fmt = mod.classifyFormat(headerLine);
  const layout = mod.buildRowLayout(headerLine, sampleLine);
  const last = readLastRow(filePath, mod, fmt);
  if (!last) throw new Error('CSV has no data rows');

  const barSeconds = info.barSeconds || mod.TF_SECONDS[info.timeframe] || 60;
  const timeframe = mod.timeframeName(barSeconds) || info.timeframe || 'M1';
  const symbol = process.env.MT5_SYMBOL || info.symbol || 'US100';
  const args = [
    '--symbol', symbol,
    '--timeframe', timeframe,
    '--from', new Date(last.time * 1000).toISOString(),
    '--to', new Date(Date.now() + DAY_MS).toISOString()
  ];
  if (process.env.MT5_TERMINAL) args.push('--terminal', process.env.MT5_TERMINAL);

  const result = await runMt5Helper(args, 180000);
  let newest = last.time;
  const rows = [];
  for (const rate of result.rates || []) {
    const t = Math.round(Number(rate.t));
    if (!(t > newest)) continue;
    const o = Number(rate.o);
    const h = Number(rate.h);
    const l = Number(rate.l);
    const c = Number(rate.c);
    if (!(o > 0 && h > 0 && l > 0 && c > 0)) continue;
    rows.push({
      t,
      o,
      h,
      l,
      c,
      tick_volume: rate.tick_volume,
      real_volume: rate.real_volume,
      spread: rate.spread
    });
    newest = t;
  }

  if (rows.length) {
    const text = rows.map((row) => mod.formatRow(layout, row)).join(eol) + eol;
    fs.appendFileSync(filePath, (last.endsWithNewline ? '' : eol) + text, 'utf8');
  }

  console.log('[mt5]', name, 'symbol', result.symbol || symbol, timeframe,
    'offset', result.offsetSeconds || 0, 'added', rows.length);

  return {
    file: name,
    provider: 'MetaTrader 5',
    symbol: result.symbol || symbol,
    timeframe,
    offsetSeconds: result.offsetSeconds || 0,
    added: rows.length,
    lastBefore: last.time * 1000,
    lastNew: newest * 1000,
    days: 1,
    remainingDays: 0,
    skipped: [],
    size: fs.statSync(filePath).size
  };
}

function streamCsv(res, name) {
  const filePath = csvPath(name);
  if (!filePath) return send(res, 400, 'Invalid file name');
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) return send(res, 404, 'Not found');
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Length': stat.size,
      'Cache-Control': 'no-store'
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), MIME['.json']);
}

/* --------------------------- Dukascopy backfill --------------------------- */

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

function fetchJson(pathname, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get({
      host: DUKA_HOST,
      path: pathname,
      headers: {
        'User-Agent': DUKA_UA,
        Accept: 'application/json',
        Referer: 'https://www.dukascopy.com/',
        Origin: 'https://www.dukascopy.com'
      }
    }, (upstream) => {
      if (upstream.statusCode !== 200) {
        upstream.resume();
        reject(new Error('HTTP ' + upstream.statusCode));
        return;
      }
      const chunks = [];
      upstream.on('data', (chunk) => chunks.push(chunk));
      upstream.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (err) {
          reject(new Error('Dukascopy returned malformed JSON'));
        }
      });
      upstream.on('error', reject);
    });
    req.setTimeout(timeoutMs || 30000, () => {
      req.destroy(new Error('Dukascopy request timed out'));
    });
    req.on('error', reject);
  });
}

// Candles arrive as deltas from a base price and a base timestamp.
function dukascopyRows(payload) {
  const steps = payload.times || [];
  const opens = payload.opens || [];
  const highs = payload.highs || [];
  const lows = payload.lows || [];
  const closes = payload.closes || [];
  const volumes = payload.volumes || [];
  const shift = Number(payload.shift) || 60000;
  const mult = Number(payload.multiplier) || 0.001;
  let t = Number(payload.timestamp);
  let o = Number(payload.open);
  let h = Number(payload.high);
  let l = Number(payload.low);
  let c = Number(payload.close);
  const rows = [];
  for (let i = 0; i < steps.length; i++) {
    t += steps[i] * shift;
    o += opens[i] * mult;
    h += highs[i] * mult;
    l += lows[i] * mult;
    c += closes[i] * mult;
    rows.push({ t, o, h, l, c, v: volumes[i] });
  }
  return rows;
}

function readLastCsvRow(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (!size) return null;
    const len = Math.min(1 << 16, size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split(/\r?\n/).filter((line) => line.trim() !== '');
    for (let i = lines.length - 1; i >= 0; i--) {
      const value = Number(lines[i].split(',')[0]);
      if (Number.isFinite(value) && value > 0) {
        return { time: value, endsWithNewline: buf[buf.length - 1] === 10 };
      }
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function utcDateText(ms) {
  const d = new Date(ms);
  return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
}

async function updateCsv(name) {
  const filePath = csvPath(name);
  if (!filePath) throw new Error('Invalid file name');
  const last = readLastCsvRow(filePath);
  if (!last) throw new Error('CSV has no data rows');
  const lastMs = last.time >= 1e12 ? last.time : last.time * 1000;

  const startMs = Math.floor(lastMs / DAY_MS) * DAY_MS;
  const todayMs = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  const totalDays = Math.max(1, Math.round((todayMs - startMs) / DAY_MS) + 1);
  const days = [];
  for (let d = startMs; d <= todayMs && days.length < MAX_UPDATE_DAYS; d += DAY_MS) days.push(d);

  const rows = [];
  const skipped = [];
  let newest = lastMs;
  for (const dayMs of days) {
    const d = new Date(dayMs);
    const url = `/v1/candles/minute/${encodeURIComponent(DUKA_SYMBOL)}/BID/`
      + d.getUTCFullYear() + '/' + pad2(d.getUTCMonth() + 1) + '/' + pad2(d.getUTCDate());
    let payload;
    try {
      payload = await fetchJson(url);
    } catch (err) {
      skipped.push({ date: utcDateText(dayMs), error: String((err && err.message) || err) });
      continue;
    }
    for (const row of dukascopyRows(payload)) {
      if (!(row.t > newest)) continue;
      if (!(row.o > 0 && row.h > 0 && row.l > 0 && row.c > 0)) continue;
      rows.push(row);
      newest = row.t;
    }
  }

  if (rows.length) {
    const text = rows.map((r) =>
      r.t + ',' + r.o.toFixed(5) + ',' + r.h.toFixed(5) + ',' + r.l.toFixed(5) + ',' + r.c.toFixed(5) + ',' + r.v
    ).join('\n') + '\n';
    fs.appendFileSync(filePath, (last.endsWithNewline ? '' : '\n') + text, 'utf8');
  }

  return {
    file: name,
    added: rows.length,
    lastBefore: lastMs,
    lastNew: rows.length ? rows[rows.length - 1].t : lastMs,
    days: days.length,
    remainingDays: Math.max(0, totalDays - days.length),
    skipped,
    size: fs.statSync(filePath).size
  };
}

/* ------------------------------ strategy site ----------------------------- */

const strategy = { run: null, tool: null, queue: [] };
const STRATEGY_DEFAULT_FILE = 'US100_M1_202001020105_202610291406.csv';

const STRATEGY_INSTRUMENTS = {
  US100: { name: 'US100 (Nasdaq)', point: 1, decimals: 2, mark: 'NQ' },
  GBPUSD: { name: 'GBPUSD', point: 0.0001, decimals: 5, mark: 'GP' },
  XAUUSD: { name: 'XAUUSD (Gold)', point: 0.1, decimals: 2, mark: 'AU' },
};

function strategyInstrument(stem) {
  const prefix = String(stem).split('_')[0].toUpperCase();
  return Object.assign({ symbol: prefix, point: 1, decimals: 2, mark: prefix.slice(0, 2) },
    STRATEGY_INSTRUMENTS[prefix] || { name: prefix });
}

/*
 * Resolve a ?file= / body file name to a CSV stem.  Only real files inside
 * DATA_DIR qualify, so a stem can be used as a directory name under results/
 * without escaping it.
 */
function strategyFile(raw) {
  const name = String(raw || STRATEGY_DEFAULT_FILE);
  if (!name || name !== path.basename(name) || name.includes('..')) return null;
  if (path.extname(name).toLowerCase() !== '.csv') return null;
  if (!fs.existsSync(path.join(DATA_DIR, name))) return null;
  return name;
}

function strategyStem(raw) {
  const name = strategyFile(raw);
  return name ? name.slice(0, -path.extname(name).length) : null;
}

function isMt5Csv(filePath) {
  try {
    return readHead(filePath, 512).includes('<DATE>');
  } catch (err) {
    return false;
  }
}

function strategyFileList() {
  return listCsvFiles()
    .filter((f) => isMt5Csv(path.join(DATA_DIR, f.name)))
    .map((f) => {
      const stem = f.name.replace(/\.csv$/i, '');
      return {
        name: f.name,
        stem,
        size: f.size,
        mtime: f.mtime,
        instrument: strategyInstrument(stem),
        default: f.name === STRATEGY_DEFAULT_FILE,
        computed: fs.existsSync(path.join(STRATEGY_RESULTS, stem, 'summary.json')),
      };
    });
}

function strategyPaths(stem) {
  const base = path.join(STRATEGY_RESULTS, stem);
  return {
    dir: base,
    summary: path.join(base, 'summary.json'),
    progress: path.join(base, 'progress.json'),
    queue: path.join(base, 'queue.txt'),
    favourites: path.join(base, 'favourites.json'),
    audit: (run, day) => path.join(base, 'audit', run + '_' + day + '.json'),
    trades: (run) => path.join(base, 'trades', run + '.csv'),
  };
}

/* -------------------------------- risk site ------------------------------ */

const risk = { run: null };

function riskFile(raw) {
  const name = String(raw || RISK_DEFAULT_FILE);
  if (!name || name !== path.basename(name) || name.includes('..')) return null;
  if (path.extname(name).toLowerCase() !== '.csv') return null;
  if (!fs.existsSync(path.join(DATA_DIR, name))) return null;
  return name;
}

function riskStem(raw) {
  const name = riskFile(raw);
  return name ? name.slice(0, -path.extname(name).length) : null;
}

function riskInstrument(stem) {
  const prefix = String(stem || '').split('_')[0].toUpperCase();
  const spec = RISK_SPECS[prefix];
  return Object.assign({ symbol: prefix, name: prefix, supported: !!spec },
    spec || {}, { symbol: prefix });
}

function riskFileList() {
  return listCsvFiles()
    .filter((f) => isMt5Csv(path.join(DATA_DIR, f.name)))
    .map((f) => {
      const stem = f.name.replace(/\.csv$/i, '');
      const instrument = riskInstrument(stem);
      return {
        name: f.name,
        stem,
        size: f.size,
        mtime: f.mtime,
        instrument,
        supported: instrument.supported,
        default: f.name === RISK_DEFAULT_FILE,
        computed: fs.existsSync(path.join(RISK_RESULTS, stem, 'risk.json')),
      };
    });
}

function riskPaths(stem) {
  const base = path.join(RISK_RESULTS, stem);
  return {
    dir: base,
    results: path.join(base, 'risk.json'),
    progress: path.join(base, 'progress.json'),
    queue: path.join(base, 'risk-queue.txt'),
    favourites: path.join(base, 'favourites.json'),
  };
}

function riskStatus(fileName) {
  const stem = riskStem(fileName) || (risk.run && risk.run.file) || '';
  let progress = (stem ? readJson(riskPaths(stem).progress, {}) : {}) || {};
  const job = risk.run;
  // progress.json survives between jobs; ignore it until this job has written its own.
  if (job && progress.updated && progress.updated * 1000 < job.started - 2000) progress = {};
  return {
    running: !!job,
    job: job ? {
      kind: job.kind,
      label: job.label,
      file: job.file || null,
      started: job.started,
      total: job.total,
      output: job.output.slice(-8),
    } : null,
    progress,
  };
}

function sendRiskResults(res, fileName) {
  const stem = riskStem(fileName);
  if (!stem) return sendJson(res, 400, { error: 'Unknown data file' });
  const paths = riskPaths(stem);
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(paths.results, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      payload = { meta: null, runs: [] };
    } else {
      return sendJson(res, 500, { error: 'risk.json is not valid JSON: ' + err.message });
    }
  }
  payload.stale = false;
  payload.instrument = riskInstrument(stem);
  payload.file = stem;
  payload.files = riskFileList();
  payload.specs = RISK_SPECS;
  payload.defaults = { year: RISK_DEFAULT_YEAR, max_lot: RISK_DEFAULT_MAX_LOT };
  const sig = payload.meta && payload.meta.sig;
  if (sig && sig.file) {
    try {
      const stat = fs.statSync(path.join(DATA_DIR, sig.file));
      payload.stale = stat.size !== sig.size || Math.floor(stat.mtimeMs / 1000) !== sig.mtime;
    } catch (err) {
      payload.stale = true;
    }
  }
  return sendJson(res, 200, payload);
}

function loadRiskFavourites(fileName) {
  const stem = riskStem(fileName);
  const data = stem ? readJson(riskPaths(stem).favourites, null) : null;
  const ids = data && Array.isArray(data.ids) ? data.ids.filter((id) => RUN_ID_RE.test(id)) : [];
  return { ids, updated: (data && data.updated) || 0 };
}

function startRiskRun(body) {
  if (risk.run) {
    return Promise.reject(Object.assign(new Error('A risk run is already running'), { status: 409 }));
  }
  const busy = engineBusy('risk');
  if (busy) return Promise.reject(Object.assign(new Error(busy), { status: 409 }));
  const stem = riskStem(body.file);
  if (!stem) return Promise.reject(Object.assign(new Error('Unknown data file'), { status: 400 }));
  if (!riskInstrument(stem).supported) {
    return Promise.reject(Object.assign(
      new Error('No broker spec for ' + stem.split('_')[0] + '; add it to rfspec.SPECS'), { status: 400 }));
  }
  const year = Number.isFinite(Number(body.year)) ? Math.trunc(Number(body.year)) : RISK_DEFAULT_YEAR;
  if (year < 2000 || year > 2100) {
    return Promise.reject(Object.assign(new Error('Year must be 2000–2100'), { status: 400 }));
  }
  const maxLot = Number.isFinite(Number(body.max_lot)) ? Number(body.max_lot) : RISK_DEFAULT_MAX_LOT;
  if (!(maxLot >= 0.01) || maxLot > 10000) {
    return Promise.reject(Object.assign(new Error('Max lot must be between 0.01 and 10,000'), { status: 400 }));
  }
  const balance = Number.isFinite(Number(body.balance)) ? Number(body.balance) : 5000;
  if (!(balance >= 100) || balance > 100000000) {
    return Promise.reject(Object.assign(new Error('Balance must be between 100 and 100,000,000'), { status: 400 }));
  }
  const paths = riskPaths(stem);
  const args = ['risk.py', '--file', riskFile(body.file), '--year', String(year),
    '--max-lot', String(maxLot), '--balance', String(balance)];
  let total;
  if (body.all) {
    total = gridSize(stem);
    args.push('--all');
  } else {
    const ids = Array.isArray(body.ids) ? [...new Set(body.ids.map(String))] : [];
    if (!ids.length) return Promise.reject(Object.assign(new Error('Give ids or all:true'), { status: 400 }));
    if (ids.length > RISK_MAX_IDS) {
      return Promise.reject(Object.assign(new Error('Too many run ids'), { status: 400 }));
    }
    const bad = ids.find((id) => !RUN_ID_RE.test(id));
    if (bad) return Promise.reject(Object.assign(new Error('Invalid run id: ' + bad), { status: 400 }));
    total = ids.length;
    fs.mkdirSync(paths.dir, { recursive: true });
    fs.writeFileSync(paths.queue, ids.join('\n') + '\n', 'utf8');
    args.push('--ids-file', paths.queue);
  }
  if (body.force) args.push('--force');
  const workers = workerCount(body.workers);
  args.push('--workers', String(workers));
  const job = {
    kind: 'risk',
    total,
    file: stem,
    label: (body.all
      ? (body.force ? 'rechecking every combination' : 'analysing every missing combination')
      : 'analysing ' + total + ' combinations') + ' · ' + workers + ' processors · ' + stem,
  };
  risk.run = job;
  spawnRisk(args, job).then((code) => {
    risk.run = null;
    if (code !== 0) console.error('[risk] run exited with code', code);
  }, (err) => {
    risk.run = null;
    console.error('[risk] run failed', err);
  });
  return Promise.resolve(job);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return fallback;
  }
}

function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (err) {
        reject(new Error('Malformed JSON body'));
      }
    });
    req.on('error', reject);
  });
}

/*
 * One Python child at a time: run.py owns results/. A grid run may not overlap
 * another grid run; audit and CSV exports use run.py too and are queued behind
 * each other, but they may run beside a grid run because they touch other files.
 */
function spawnPython(args, job, cwd, tag, python) {
  const bin = python || STRATEGY_PYTHON;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { cwd, windowsHide: true });
    } catch (err) {
      reject(err);
      return;
    }
    job.child = child;
    job.started = Date.now();
    job.output = job.output || [];
    let settled = false;
    let timer = null;
    const finish = (err, code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (err) reject(err);
      else resolve(code);
    };
    const consume = (data) => {
      const text = String(data);
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        job.output.push(line);
        if (job.output.length > 200) job.output.shift();
      }
      process.stdout.write('[' + tag + '] ' + text);
    };
    child.stdout.on('data', consume);
    child.stderr.on('data', consume);
    child.on('error', (err) => {
      const message = err && err.code === 'ENOENT'
        ? 'Python not found ("' + bin + '"). Set STRATEGY_PYTHON to your python.exe.'
        : String((err && err.message) || err);
      job.output.push(message);
      finish(new Error(message));
    });
    child.on('close', (code) => {
      job.exit = code;
      finish(null, code);
    });
    if (job.timeoutMs) {
      timer = setTimeout(() => {
        job.output.push('timed out after ' + Math.round(job.timeoutMs / 1000) + 's');
        child.kill();
      }, job.timeoutMs);
    }
  });
}

function spawnStrategy(args, job) {
  return spawnPython(args, job, STRATEGY_DIR, 'strategy');
}

function spawnRisk(args, job) {
  return spawnPython(args, job, RISK_DIR, 'risk', RISK_PYTHON);
}

/* ------------------------------- prop firm ------------------------------- */

const prop = { run: null };
const prop2 = { run: null };
const PROP2_SITE = path.join(PROP_DIR, 'site2');
const COMBINE_DIR = path.join(ROOT, 'analysis', 'combine');
const COMBINE_SITE = path.join(COMBINE_DIR, 'site');
const COMBINE_RESULTS = path.join(COMBINE_DIR, 'results');
const combine = { run: null };

function engineBusy(kind) {
  if (kind !== 'strategy' && (strategy.run || strategy.tool)) {
    return 'The strategy engine is busy. Wait for it to finish, then run this page.';
  }
  if (kind !== 'risk' && risk.run) return 'Risk is already running. Wait for it to finish.';
  if (kind !== 'prop' && prop.run) return 'Prop firm is already running. Wait for it to finish.';
  if (kind !== 'prop2' && prop2.run) return 'Prop firm 2 is already running. Wait for it to finish.';
  if (kind !== 'combine' && combine.run) return 'Combine is already running. Wait for it to finish.';
  return '';
}

function propPaths(stem) {
  const base = path.join(PROP_RESULTS, stem);
  return {
    dir: base,
    results: path.join(base, 'prop.json'),
    progress: path.join(base, 'progress.json'),
    queue: path.join(base, 'prop-queue.txt'),
    favourites: path.join(base, 'favourites.json'),
  };
}

function propStatus(fileName) {
  const stem = strategyStem(fileName) || (prop.run && prop.run.file) || '';
  let progress = (stem ? readJson(propPaths(stem).progress, {}) : {}) || {};
  const job = prop.run;
  if (job && progress.updated && progress.updated * 1000 < job.started - 2000) progress = {};
  return {
    running: !!job,
    job: job ? {
      kind: job.kind,
      label: job.label,
      file: job.file || null,
      started: job.started,
      total: job.total,
      output: job.output.slice(-8),
    } : null,
    progress,
  };
}

function loadPropFavourites(fileName) {
  const stem = strategyStem(fileName);
  const data = stem ? readJson(propPaths(stem).favourites, null) : null;
  const ids = data && Array.isArray(data.ids) ? data.ids.filter((id) => RUN_ID_RE.test(id)) : [];
  return { ids, updated: (data && data.updated) || 0 };
}

function sendPropResults(res, fileName) {
  const stem = strategyStem(fileName);
  if (!stem) return sendJson(res, 400, { error: 'Unknown data file' });
  const strategyFavs = loadFavourites(fileName).ids;
  const store = readJson(propPaths(stem).results, { runs: {} }) || { runs: {} };
  const trades = {};
  for (const id of Object.keys(store.runs || {})) {
    if (!RUN_ID_RE.test(id)) continue;
    try {
      const stat = fs.statSync(strategyPaths(stem).trades(id));
      trades[id] = { size: stat.size, mtime: Math.floor(stat.mtimeMs / 1000) };
    } catch (err) {
      trades[id] = null;
    }
  }
  return sendJson(res, 200, {
    file: strategyFile(fileName),
    instrument: strategyInstrument(stem),
    files: strategyFileList(),
    strategyFavourites: strategyFavs,
    propFavourites: loadPropFavourites(fileName).ids,
    trades,
    runs: store.runs || {},
  });
}

function startPropRun(body) {
  if (prop.run) {
    return Promise.reject(Object.assign(new Error('A prop run is already running'), { status: 409 }));
  }
  const busy = engineBusy('prop');
  if (busy) return Promise.reject(Object.assign(new Error(busy), { status: 409 }));
  const stem = strategyStem(body.file);
  if (!stem) return Promise.reject(Object.assign(new Error('Unknown data file'), { status: 400 }));
  const ids = Array.isArray(body.ids) ? [...new Set(body.ids.map(String))] : [];
  if (!ids.length) return Promise.reject(Object.assign(new Error('Give at least one run id'), { status: 400 }));
  if (ids.length > PROP_MAX_IDS) {
    return Promise.reject(Object.assign(new Error('Too many run ids'), { status: 400 }));
  }
  const bad = ids.find((id) => !RUN_ID_RE.test(id));
  if (bad) return Promise.reject(Object.assign(new Error('Invalid run id: ' + bad), { status: 400 }));
  const paths = propPaths(stem);
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.writeFileSync(paths.queue, ids.join('\n') + '\n', 'utf8');
  const args = ['prop.py', '--file', strategyFile(body.file), '--ids-file', paths.queue];
  if (body.force) args.push('--force');
  const workers = workerCount(body.workers);
  args.push('--workers', String(workers));
  const job = {
    kind: 'prop',
    total: ids.length,
    file: stem,
    label: (body.force ? 'recomputing ' : 'analysing ') + ids.length + ' combinations · ' +
      workers + ' processors · ' + stem,
    output: [],
  };
  prop.run = job;
  spawnPython(args, job, PROP_DIR, 'prop', PROP_PYTHON).then((code) => {
    prop.run = null;
    if (code !== 0) console.error('[prop] run exited with code', code);
  }, (err) => {
    prop.run = null;
    console.error('[prop] run failed', err);
  });
  return Promise.resolve(job);
}

function combinePaths(stem) {
  const base = path.join(COMBINE_RESULTS, stem);
  return {
    dir: base,
    results: path.join(base, 'combine.json'),
    progress: path.join(base, 'progress.json'),
    news: path.join(base, 'news-days.json'),
    handling: path.join(base, 'news-handling.json'),
  };
}

function combineStatus(fileName) {
  const stem = strategyStem(fileName) || (combine.run && combine.run.file) || '';
  const progress = (stem ? readJson(combinePaths(stem).progress, {}) : {}) || {};
  const job = combine.run;
  const running = !!(job && (!stem || job.file === stem));
  return Object.assign({}, progress, {
    running,
    file: stem,
    interrupted: !running && !!progress.running,
  });
}

function sendCombineResults(res, fileName) {
  const stem = strategyStem(fileName);
  if (!stem) return sendJson(res, 400, { error: 'Unknown data file' });
  const paths = combinePaths(stem);
  const store = readJson(paths.results, { runs: {} }) || { runs: {} };
  return sendJson(res, 200, {
    file: strategyFile(fileName),
    instrument: strategyInstrument(stem),
    files: strategyFileList(),
    news: readJson(paths.news, null),
    handling: readJson(paths.handling, null),
    runs: store.runs || {},
    stale: (store.version || 1) < 3,
    progress: combineStatus(fileName),
  });
}

function startCombineRun(body) {
  if (combine.run) {
    return Promise.reject(Object.assign(new Error('Combine is already running'), { status: 409 }));
  }
  const busy = engineBusy('combine');
  if (busy) return Promise.reject(Object.assign(new Error(busy), { status: 409 }));
  const stem = strategyStem(body.file);
  if (!stem) return Promise.reject(Object.assign(new Error('Unknown data file'), { status: 400 }));
  if (!String(stem).toUpperCase().startsWith('US100')) {
    return Promise.reject(Object.assign(new Error('Combine is defined for US100'), { status: 400 }));
  }
  const args = ['combine.py', '--file', strategyFile(body.file)];
  if (body.force) args.push('--force');
  const job = {
    kind: 'combine',
    total: 7,
    file: stem,
    label: (body.force ? 'recomputing ' : 'analysing ') + '7 session mixes · ' + stem,
    output: [],
  };
  combine.run = job;
  spawnPython(args, job, COMBINE_DIR, 'combine', PROP_PYTHON).then((code) => {
    combine.run = null;
    if (code !== 0) console.error('[combine] run exited with code', code);
  }, (err) => {
    combine.run = null;
    console.error('[combine] run failed', err);
  });
  return Promise.resolve(job);
}

function prop2Paths(stem) {
  const base = path.join(PROP_RESULTS, stem);
  return {
    dir: base,
    results: path.join(base, 'prop2.json'),
    progress: path.join(base, 'progress2.json'),
    queue: path.join(base, 'prop2-queue.txt'),
    favourites: path.join(base, 'favourites2.json'),
  };
}

function prop2Status(fileName) {
  const stem = strategyStem(fileName) || (prop2.run && prop2.run.file) || '';
  let progress = (stem ? readJson(prop2Paths(stem).progress, {}) : {}) || {};
  const job = prop2.run;
  if (job && progress.updated && progress.updated * 1000 < job.started - 2000) progress = {};
  return {
    running: !!job,
    job: job ? {
      kind: job.kind,
      label: job.label,
      file: job.file || null,
      started: job.started,
      total: job.total,
      output: job.output.slice(-8),
    } : null,
    progress,
  };
}

function loadProp2Favourites(fileName) {
  const stem = strategyStem(fileName);
  const data = stem ? readJson(prop2Paths(stem).favourites, null) : null;
  const ids = data && Array.isArray(data.ids) ? data.ids.filter((id) => RUN_ID_RE.test(id)) : [];
  return { ids, updated: (data && data.updated) || 0 };
}

function sendProp2Results(res, fileName) {
  const stem = strategyStem(fileName);
  if (!stem) return sendJson(res, 400, { error: 'Unknown data file' });
  const strategyFavs = loadFavourites(fileName).ids;
  const store = readJson(prop2Paths(stem).results, { runs: {} }) || { runs: {} };
  const trades = {};
  for (const id of Object.keys(store.runs || {})) {
    if (!RUN_ID_RE.test(id)) continue;
    try {
      const stat = fs.statSync(strategyPaths(stem).trades(id));
      trades[id] = { size: stat.size, mtime: Math.floor(stat.mtimeMs / 1000) };
    } catch (err) {
      trades[id] = null;
    }
  }
  return sendJson(res, 200, {
    file: strategyFile(fileName),
    instrument: strategyInstrument(stem),
    files: strategyFileList(),
    strategyFavourites: strategyFavs,
    propFavourites: loadProp2Favourites(fileName).ids,
    trades,
    runs: store.runs || {},
  });
}

function startProp2Run(body) {
  if (prop2.run) {
    return Promise.reject(Object.assign(new Error('A one-account prop run is already running'), { status: 409 }));
  }
  const busy = engineBusy('prop2');
  if (busy) return Promise.reject(Object.assign(new Error(busy), { status: 409 }));
  const stem = strategyStem(body.file);
  if (!stem) return Promise.reject(Object.assign(new Error('Unknown data file'), { status: 400 }));
  const ids = Array.isArray(body.ids) ? [...new Set(body.ids.map(String))] : [];
  if (!ids.length) return Promise.reject(Object.assign(new Error('Give at least one run id'), { status: 400 }));
  if (ids.length > PROP_MAX_IDS) {
    return Promise.reject(Object.assign(new Error('Too many run ids'), { status: 400 }));
  }
  const bad = ids.find((id) => !RUN_ID_RE.test(id));
  if (bad) return Promise.reject(Object.assign(new Error('Invalid run id: ' + bad), { status: 400 }));
  const paths = prop2Paths(stem);
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.writeFileSync(paths.queue, ids.join('\n') + '\n', 'utf8');
  const args = ['prop2.py', '--file', strategyFile(body.file), '--ids-file', paths.queue];
  if (body.force) args.push('--force');
  const workers = workerCount(body.workers);
  args.push('--workers', String(workers));
  const job = {
    kind: 'prop2',
    total: ids.length,
    file: stem,
    label: (body.force ? 'recomputing ' : 'analysing ') + ids.length + ' one-account combinations · ' +
      workers + ' processors · ' + stem,
    output: [],
  };
  prop2.run = job;
  spawnPython(args, job, PROP_DIR, 'prop2', PROP_PYTHON).then((code) => {
    prop2.run = null;
    if (code !== 0) console.error('[prop2] run exited with code', code);
  }, (err) => {
    prop2.run = null;
    console.error('[prop2] run failed', err);
  });
  return Promise.resolve(job);
}

function startGridRun(ids, all, force, fileName, workers) {
  if (strategy.run) {
    return Promise.reject(Object.assign(new Error('A grid run is already running'), { status: 409 }));
  }
  const busy = engineBusy('strategy');
  if (busy) return Promise.reject(Object.assign(new Error(busy), { status: 409 }));
  if (strategy.tool) {
    return Promise.reject(Object.assign(
      new Error('An audit or trade CSV job is running, start the grid again in a moment'), { status: 409 }));
  }
  const stem = strategyStem(fileName);
  if (!stem) return Promise.reject(Object.assign(new Error('Unknown data file'), { status: 400 }));
  const paths = strategyPaths(stem);
  const args = ['run.py', '--file', strategyFile(fileName)];
  const total = all ? gridSize(stem) : ids.length;
  if (all) {
    args.push('--all');
  } else {
    fs.mkdirSync(paths.dir, { recursive: true });
    fs.writeFileSync(paths.queue, ids.join('\n') + '\n', 'utf8');
    args.push('--ids-file', paths.queue);
  }
  if (force) args.push('--force');
  const n = workerCount(workers);
  args.push('--workers', String(n));
  const job = {
    kind: 'grid',
    total,
    file: stem,
    label: (all
      ? (force ? 'recomputing every combination' : 'running every missing combination')
      : 'running ' + total + ' combinations') + ' · ' + n + ' processors · ' + stem,
  };
  strategy.run = job;
  spawnStrategy(args, job).then((code) => {
    strategy.run = null;
    if (code !== 0) console.error('[strategy] grid exited with code', code);
  }, (err) => {
    strategy.run = null;
    console.error('[strategy] grid failed', err);
  });
  return Promise.resolve(job);
}

function enqueueTool(job) {
  return new Promise((resolve, reject) => {
    job.resolve = resolve;
    job.reject = reject;
    job.timeoutMs = job.timeoutMs || 300000;
    strategy.queue.push(job);
    pumpTools();
  });
}

function pumpTools() {
  if (strategy.tool || !strategy.queue.length) return;
  const job = strategy.queue.shift();
  strategy.tool = job;
  spawnStrategy(job.args, job).then((code) => {
    strategy.tool = null;
    if (code === 0) job.resolve(job);
    else job.reject(new Error(job.output.slice(-3).join(' ') || ('python exited with code ' + code)));
    pumpTools();
  }, (err) => {
    strategy.tool = null;
    job.reject(err);
    pumpTools();
  });
}

function strategyStatus(fileName) {
  const stem = strategyStem(fileName) || (strategy.run && strategy.run.file) || '';
  const progress = (stem ? readJson(strategyPaths(stem).progress, {}) : {}) || {};
  const job = strategy.run || strategy.tool;
  return {
    running: !!job,
    job: job ? {
      kind: job.kind,
      label: job.label,
      file: job.file || null,
      started: job.started,
      total: job.total,
      output: job.output.slice(-8),
    } : null,
    queue: strategy.queue.length,
    progress,
  };
}

function sendSummary(res, fileName) {
  const stem = strategyStem(fileName);
  if (!stem) return sendJson(res, 400, { error: 'Unknown data file' });
  const paths = strategyPaths(stem);
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(paths.summary, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      return sendJson(res, 200, {
        meta: null, runs: [], factors: {}, stale: false,
        instrument: strategyInstrument(stem), file: stem,
        files: strategyFileList(),
      });
    }
    return sendJson(res, 500, { error: 'summary.json is not valid JSON: ' + err.message });
  }
  payload.stale = false;
  payload.instrument = Object.assign(
    strategyInstrument(stem), (payload.meta && payload.meta.instrument) || {});
  payload.file = stem;
  payload.files = strategyFileList();
  const sig = payload.meta && payload.meta.sig;
  if (sig && sig.file) {
    try {
      const stat = fs.statSync(path.join(DATA_DIR, sig.file));
      payload.stale = stat.size !== sig.size || Math.floor(stat.mtimeMs / 1000) !== sig.mtime;
    } catch (err) {
      payload.stale = true;
    }
  }
  return sendJson(res, 200, payload);
}

function loadFavourites(fileName) {
  const stem = strategyStem(fileName);
  const data = stem ? readJson(strategyPaths(stem).favourites, null) : null;
  const ids = data && Array.isArray(data.ids) ? data.ids.filter((id) => RUN_ID_RE.test(id)) : [];
  return { ids, updated: (data && data.updated) || 0 };
}

function streamFile(res, file, type, download) {
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) return sendJson(res, 404, { error: 'not built yet' });
    const headers = {
      'Content-Type': type,
      'Content-Length': stat.size,
      'Cache-Control': 'no-store',
    };
    if (download) headers['Content-Disposition'] = 'attachment; filename="' + path.basename(file) + '"';
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  let pathname = '/';
  let query = new URLSearchParams();
  try {
    const parsed = new URL(req.url, 'http://localhost');
    pathname = decodeURIComponent(parsed.pathname);
    query = parsed.searchParams;
  } catch (err) {
    return send(res, 400, 'Bad request');
  }

  /* ------------------------------ strategy api ----------------------------- */

  if (pathname === '/api/strategy/files' && req.method === 'GET') {
    return sendJson(res, 200, { files: strategyFileList(), default: STRATEGY_DEFAULT_FILE });
  }

  if (pathname === '/api/strategy/summary' && req.method === 'GET') {
    return sendSummary(res, query.get('file'));
  }

  if (pathname === '/api/strategy/status' && req.method === 'GET') {
    return sendJson(res, 200, strategyStatus(query.get('file')));
  }

  if (pathname === '/api/strategy/favourites') {
    if (req.method === 'GET') return sendJson(res, 200, loadFavourites(query.get('file')));
    if (req.method === 'POST') {
      return readBody(req, 1 << 20)
        .then((body) => {
          const id = String(body.id || '');
          if (!RUN_ID_RE.test(id)) return sendJson(res, 400, { error: 'Invalid run id' });
          const stem = strategyStem(body.file);
          if (!stem) return sendJson(res, 400, { error: 'Unknown data file' });
          const paths = strategyPaths(stem);
          const current = loadFavourites(body.file);
          const ids = new Set(current.ids);
          if (body.favourite === false) ids.delete(id); else ids.add(id);
          const payload = { ids: [...ids].sort(), updated: Date.now() };
          writeJsonAtomic(paths.favourites, payload);
          sendJson(res, 200, payload);
        })
        .catch((err) => sendJson(res, 400, { error: String((err && err.message) || err) }));
    }
    return sendJson(res, 405, { error: 'Use GET or POST' });
  }

  if (pathname === '/api/strategy/run' && req.method === 'POST') {
    return readBody(req, 8 << 20)
      .then((body) => {
        const force = !!body.force;
        const workers = workerCount(body.workers);
        if (body.all) {
          return startGridRun(null, true, force, body.file, workers).then((job) => sendJson(res, 200, {
            started: true, label: job.label, total: job.total,
          }));
        }
        const ids = Array.isArray(body.ids) ? [...new Set(body.ids.map(String))] : [];
        if (!ids.length) return sendJson(res, 400, { error: 'Give ids or all:true' });
        if (ids.length > STRATEGY_MAX_IDS) return sendJson(res, 400, { error: 'Too many run ids' });
        const bad = ids.find((id) => !RUN_ID_RE.test(id));
        if (bad) return sendJson(res, 400, { error: 'Invalid run id: ' + bad });
        return startGridRun(ids, false, force, body.file, workers).then((job) => sendJson(res, 200, {
          started: true, label: job.label, total: job.total,
        }));
      })
      .catch((err) => sendJson(res, err.status || 400, { error: String((err && err.message) || err) }));
  }

  if (pathname === '/api/strategy/audit') {
    const run = String(query.get('run') || '');
    const day = String(query.get('day') || '');
    if (req.method === 'GET') {
      const stem = strategyStem(query.get('file'));
      if (!stem || !RUN_ID_RE.test(run) || !DAY_RE.test(day)) return sendJson(res, 400, { error: 'Invalid run, day or file' });
      return streamFile(res, strategyPaths(stem).audit(run, day), MIME['.json']);
    }
    if (req.method === 'POST') {
      return readBody(req, 1 << 20)
        .then((body) => {
          const postRun = String(body.run || '');
          const postDay = String(body.day || '');
          const stem = strategyStem(body.file);
          if (!stem || !RUN_ID_RE.test(postRun) || !DAY_RE.test(postDay)) {
            return sendJson(res, 400, { error: 'Invalid run, day or file' });
          }
          return enqueueTool({
            kind: 'audit',
            file: stem,
            label: 'building the audit day for ' + postRun + ' · ' + postDay + ' · ' + stem,
            args: ['run.py', '--file', strategyFile(body.file), '--audit', postRun, '--day', postDay],
          }).then(() => streamFile(res, strategyPaths(stem).audit(postRun, postDay), MIME['.json']));
        })
        .catch((err) => sendJson(res, 502, { error: String((err && err.message) || err) }));
    }
    return sendJson(res, 405, { error: 'Use GET or POST' });
  }

  if (pathname === '/api/strategy/trades') {
    const run = String(query.get('run') || '');
    if (req.method === 'GET') {
      const stem = strategyStem(query.get('file'));
      if (!stem || !RUN_ID_RE.test(run)) return sendJson(res, 400, { error: 'Invalid run or file' });
      return streamFile(res, strategyPaths(stem).trades(run), MIME['.csv'], query.get('download') === '1');
    }
    if (req.method === 'POST') {
      return readBody(req, 1 << 20)
        .then((body) => {
          const postRun = String(body.run || '');
          const stem = strategyStem(body.file);
          if (!stem || !RUN_ID_RE.test(postRun)) return sendJson(res, 400, { error: 'Invalid run or file' });
          const csvName = strategyFile(body.file);
          return enqueueTool({
            kind: 'trades',
            file: stem,
            label: 'exporting the trade list of ' + postRun + ' · ' + stem,
            args: ['run.py', '--file', csvName, '--export-trades', postRun],
          }).then(() => {
            const file = strategyPaths(stem).trades(postRun);
            let rows = 0;
            try {
              const text = fs.readFileSync(file, 'utf8');
              rows = Math.max(0, text.split(/\r?\n/).filter(Boolean).length - 1);
            } catch (err) {
              rows = 0;
            }
            sendJson(res, 200, {
              ok: true,
              rows,
              url: '/api/strategy/trades?run=' + encodeURIComponent(postRun) +
                '&file=' + encodeURIComponent(csvName) + '&download=1',
            });
          });
        })
        .catch((err) => sendJson(res, 502, { error: String((err && err.message) || err) }));
    }
    return sendJson(res, 405, { error: 'Use GET or POST' });
  }

  /* -------------------------------- risk api ------------------------------- */

  if (pathname === '/api/risk/files' && req.method === 'GET') {
    return sendJson(res, 200, { files: riskFileList(), default: RISK_DEFAULT_FILE, specs: RISK_SPECS });
  }

  if (pathname === '/api/risk/results' && req.method === 'GET') {
    return sendRiskResults(res, query.get('file'));
  }

  if (pathname === '/api/risk/status' && req.method === 'GET') {
    return sendJson(res, 200, riskStatus(query.get('file')));
  }

  if (pathname === '/api/risk/favourites') {
    if (req.method === 'GET') return sendJson(res, 200, loadRiskFavourites(query.get('file')));
    if (req.method === 'POST') {
      return readBody(req, 1 << 20)
        .then((body) => {
          const id = String(body.id || '');
          if (!RUN_ID_RE.test(id)) return sendJson(res, 400, { error: 'Invalid run id' });
          const stem = riskStem(body.file);
          if (!stem) return sendJson(res, 400, { error: 'Unknown data file' });
          const paths = riskPaths(stem);
          const current = loadRiskFavourites(body.file);
          const ids = new Set(current.ids);
          if (body.favourite === false) ids.delete(id); else ids.add(id);
          const payload = { ids: [...ids].sort(), updated: Date.now() };
          writeJsonAtomic(paths.favourites, payload);
          sendJson(res, 200, payload);
        })
        .catch((err) => sendJson(res, 400, { error: String((err && err.message) || err) }));
    }
    return sendJson(res, 405, { error: 'Use GET or POST' });
  }

  if (pathname === '/api/risk/run' && req.method === 'POST') {
    return readBody(req, 8 << 20)
      .then((body) => startRiskRun(body))
      .then((job) => sendJson(res, 200, { started: true, label: job.label, total: job.total }))
      .catch((err) => sendJson(res, err.status || 400, { error: String((err && err.message) || err) }));
  }

  /* -------------------------------- prop api ------------------------------- */

  if (pathname === '/api/prop/files' && req.method === 'GET') {
    return sendJson(res, 200, { files: strategyFileList(), default: STRATEGY_DEFAULT_FILE });
  }

  if (pathname === '/api/prop/results' && req.method === 'GET') {
    return sendPropResults(res, query.get('file'));
  }

  if (pathname === '/api/prop/status' && req.method === 'GET') {
    return sendJson(res, 200, propStatus(query.get('file')));
  }

  if (pathname === '/api/prop/favourites') {
    if (req.method === 'GET') return sendJson(res, 200, loadPropFavourites(query.get('file')));
    if (req.method === 'POST') {
      return readBody(req, 1 << 20)
        .then((body) => {
          const id = String(body.id || '');
          if (!RUN_ID_RE.test(id)) return sendJson(res, 400, { error: 'Invalid run id' });
          const stem = strategyStem(body.file);
          if (!stem) return sendJson(res, 400, { error: 'Unknown data file' });
          const paths = propPaths(stem);
          const current = loadPropFavourites(body.file);
          const ids = new Set(current.ids);
          if (body.favourite === false) ids.delete(id); else ids.add(id);
          const payload = { ids: [...ids].sort(), updated: Date.now() };
          writeJsonAtomic(paths.favourites, payload);
          sendJson(res, 200, payload);
        })
        .catch((err) => sendJson(res, 400, { error: String((err && err.message) || err) }));
    }
    return sendJson(res, 405, { error: 'Use GET or POST' });
  }

  if (pathname === '/api/prop/run' && req.method === 'POST') {
    return readBody(req, 1 << 20)
      .then((body) => startPropRun(body))
      .then((job) => sendJson(res, 200, { started: true, label: job.label, total: job.total }))
      .catch((err) => sendJson(res, err.status || 400, { error: String((err && err.message) || err) }));
  }

  if (pathname === '/api/combine/results' && req.method === 'GET') {
    return sendCombineResults(res, query.get('file'));
  }

  if (pathname === '/api/combine/status' && req.method === 'GET') {
    return sendJson(res, 200, combineStatus(query.get('file')));
  }

  if (pathname === '/api/combine/news' && req.method === 'GET') {
    const stem = strategyStem(query.get('file'));
    if (!stem) return sendJson(res, 400, { error: 'Unknown data file' });
    return sendJson(res, 200, readJson(combinePaths(stem).news, { count: 0, rows: [] }));
  }

  if (pathname === '/api/combine/run' && req.method === 'POST') {
    return readBody(req, 1 << 20)
      .then((body) => startCombineRun(body))
      .then((job) => sendJson(res, 200, { started: true, label: job.label, total: job.total }))
      .catch((err) => sendJson(res, err.status || 400, { error: String((err && err.message) || err) }));
  }

  if (pathname === '/api/prop2/files' && req.method === 'GET') {
    return sendJson(res, 200, { files: strategyFileList(), default: STRATEGY_DEFAULT_FILE });
  }

  if (pathname === '/api/prop2/results' && req.method === 'GET') {
    return sendProp2Results(res, query.get('file'));
  }

  if (pathname === '/api/prop2/status' && req.method === 'GET') {
    return sendJson(res, 200, prop2Status(query.get('file')));
  }

  if (pathname === '/api/prop2/favourites') {
    if (req.method === 'GET') return sendJson(res, 200, loadProp2Favourites(query.get('file')));
    if (req.method === 'POST') {
      return readBody(req, 1 << 20)
        .then((body) => {
          const id = String(body.id || '');
          if (!RUN_ID_RE.test(id)) return sendJson(res, 400, { error: 'Invalid run id' });
          const stem = strategyStem(body.file);
          if (!stem) return sendJson(res, 400, { error: 'Unknown data file' });
          const paths = prop2Paths(stem);
          const current = loadProp2Favourites(body.file);
          const ids = new Set(current.ids);
          if (body.favourite === false) ids.delete(id); else ids.add(id);
          const payload = { ids: [...ids].sort(), updated: Date.now() };
          writeJsonAtomic(paths.favourites, payload);
          sendJson(res, 200, payload);
        })
        .catch((err) => sendJson(res, 400, { error: String((err && err.message) || err) }));
    }
    return sendJson(res, 405, { error: 'Use GET or POST' });
  }

  if (pathname === '/api/prop2/run' && req.method === 'POST') {
    return readBody(req, 1 << 20)
      .then((body) => startProp2Run(body))
      .then((job) => sendJson(res, 200, { started: true, label: job.label, total: job.total }))
      .catch((err) => sendJson(res, err.status || 400, { error: String((err && err.message) || err) }));
  }

  if (pathname === '/combine') {
    res.writeHead(302, { Location: '/combine/' });
    return res.end();
  }
  if (pathname.startsWith('/combine/')) {
    const rel = pathname.slice('/combine/'.length) || 'index.html';
    return serveFile(res, COMBINE_SITE, rel);
  }

  if (pathname === '/prop2') {
    res.writeHead(302, { Location: '/prop2/' });
    return res.end();
  }
  if (pathname.startsWith('/prop2/')) {
    const rel = pathname.slice('/prop2/'.length) || 'index.html';
    return serveFile(res, PROP2_SITE, rel);
  }

  if (pathname === '/prop') {
    res.writeHead(302, { Location: '/prop/' });
    return res.end();
  }
  if (pathname.startsWith('/prop/')) {
    const rel = pathname.slice('/prop/'.length) || 'index.html';
    return serveFile(res, PROP_SITE, rel);
  }

  if (pathname === '/risk') {
    res.writeHead(302, { Location: '/risk/' });
    return res.end();
  }
  if (pathname.startsWith('/risk/')) {
    const rel = pathname.slice('/risk/'.length) || 'index.html';
    return serveFile(res, RISK_SITE, rel);
  }

  if (pathname === '/strategy') {
    res.writeHead(302, { Location: '/strategy/' });
    return res.end();
  }
  if (pathname.startsWith('/strategy/')) {
    const rel = pathname.slice('/strategy/'.length) || 'index.html';
    return serveFile(res, STRATEGY_SITE, rel);
  }

  if (pathname === '/api/files') {
    listCsvInfo()
      .then((files) => sendJson(res, 200, { files }))
      .catch((err) => sendJson(res, 500, { error: String((err && err.message) || err) }));
    return;
  }

  const updateMatch = /^\/api\/update\/(.+)$/.exec(pathname);
  if (updateMatch) {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use POST' });
    const name = updateMatch[1];
    const filePath = csvPath(name);
    if (!filePath) return sendJson(res, 400, { error: 'Invalid file name' });
    if (!fs.existsSync(filePath)) return sendJson(res, 404, { error: 'CSV not found' });
    if (updating.has(name)) return sendJson(res, 409, { error: 'An update for this file is already running' });
    updating.add(name);
    console.log('[update] start', name);
    csvInfo(name)
      .then((info) => {
        if (!info.updatable) {
          throw new Error(info.kind === 'mt5'
            ? 'This MT5 file has an unsupported column layout'
            : 'Update supports Dukascopy epoch CSV and MetaTrader 5 exports only');
        }
        return info.kind === 'mt5' ? updateFromMt5(name, info) : updateCsv(name);
      })
      .then((result) => {
        console.log('[update] done', name, 'added', result.added, 'skipped', result.skipped.length);
        sendJson(res, 200, result);
      })
      .catch((err) => {
        console.error('[update] failed', name, err);
        sendJson(res, 502, { error: String((err && err.message) || err) });
      })
      .then(() => updating.delete(name));
    return;
  }

  const dataMatch = /^\/api\/data\/(.+)$/.exec(pathname);
  if (dataMatch) return streamCsv(res, dataMatch[1]);

  if (pathname === '/' || pathname === '/index.html') {
    return serveFile(res, PUBLIC_DIR, 'index.html');
  }
  if (pathname.startsWith('/js/') || pathname.startsWith('/css/')) {
    return serveFile(res, PUBLIC_DIR, pathname.slice(1));
  }
  if (pathname.startsWith('/vendor/')) {
    return serveFile(res, VENDOR_DIR, pathname.slice('/vendor/'.length), 'public, max-age=86400');
  }
  return send(res, 404, 'Not found');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Try: PORT=8081 npm start`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`NASDAQ chart running at http://localhost:${PORT}`);
  try {
    const files = listCsvFiles();
    console.log(`CSV files in data/: ${files.length ? files.map(f => f.name).join(', ') : 'none'}`);
  } catch (err) {
    console.log('data/ directory is missing or unreadable:', err.message);
  }
});
