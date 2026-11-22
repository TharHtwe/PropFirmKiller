import { createChartView } from './chartView.js';
import { DrawingLayer, TOOL_LABELS } from './drawings.js';
import {
  TF_IDS,
  fmtPrice,
  fmtPriceSigned,
  fmtVolume,
  fmtInt,
  fmtBytes,
  clamp,
  debounce,
  instrumentFor,
  setPriceDecimals
} from './utils.js';
import {
  DEFAULT_TZ,
  TZ_LIST,
  formatCalendarDate,
  formatDateTime,
  isValidTimeZone,
  parseWallClock,
  toWallClockValue,
  zoneAbbr,
  zoneLabel,
  zoneStamp
} from './time.mjs';
import { sessionBands, scheduleLabel, getSchedule, setSchedule } from './session.mjs';

const WINDOW_BARS = 120000;
const BUFFER_BARS = 30000;
const LOOKAHEAD_BARS = 6000;
const LS = {
  tf: 'tv2.tf',
  tz: 'tv2.tz',
  file: 'tv2.file',
  drawings: 'tv2.drawings.v1:',
  session: 'tv2.session',
  width: 'tv2.width',
  schedule: 'tv2.schedule'
};
const PALETTE = ['#2962ff', '#f2c14e', '#26a69a', '#ef5350', '#a78bfa', '#e2e8f0'];

const $ = (id) => document.getElementById(id);

const S = {
  worker: null,
  counter: 0,
  pending: new Map(),
  meta: null,
  files: [],
  tf: '1D',
  tz: DEFAULT_TZ,
  sessionMode: 'full',
  buf: null,
  datasetName: null,
  datasetKey: null,
  instrument: null,
  source: null,
  updating: false,
  loading: false,
  ready: null,
  loadFailed: null,
  suspendExtend: false,
  extendTimer: 0,
  extendBusy: false,
  hintTimer: 0,
  replay: {
    active: false,
    index: -1,
    time: null,
    playing: false,
    timer: 0,
    speed: 1,
    busy: false
  },
  trade: { side: 0, entry: 0, entryTime: 0, realized: 0, trades: 0 }
};

let cv = null;
let layer = null;
let lastLegendBar = null;

/* ------------------------------- worker plumbing ------------------------------ */

function startWorker() {
  S.worker = new Worker('/js/dataWorker.js', { type: 'module' });
  S.worker.onmessage = (event) => handleWorkerMessage(event.data);
  S.worker.onerror = (event) => {
    console.error('Worker error', event.message || event);
    toast('Background worker failed: ' + (event.message || 'unknown error'), true);
  };
}

function handleWorkerMessage(msg) {
  if (!msg || !msg.type) return;
  if (msg.type === 'progress') {
    updateProgress(msg);
    return;
  }
  if (msg.type === 'ready') {
    const resolve = S.ready;
    S.ready = null;
    S.loadFailed = null;
    if (resolve) resolve(msg.meta);
    return;
  }
  if (msg.type === 'error') {
    if (msg.id && S.pending.has(msg.id)) {
      const pending = S.pending.get(msg.id);
      S.pending.delete(msg.id);
      pending.reject(new Error(msg.message));
      return;
    }
    const reject = S.loadFailed;
    S.loadFailed = null;
    if (reject) {
      S.ready = null;
      reject(new Error(msg.message));
    } else {
      console.error(msg.message);
      toast(msg.message, true);
    }
    return;
  }
  if (msg.id && S.pending.has(msg.id)) {
    const pending = S.pending.get(msg.id);
    S.pending.delete(msg.id);
    pending.resolve(msg);
  }
}

function call(cmd, payload) {
  return new Promise((resolve, reject) => {
    const id = ++S.counter;
    S.pending.set(id, { resolve, reject });
    S.worker.postMessage(Object.assign({ cmd }, payload, { id }));
  });
}

function rejectPending() {
  for (const pending of S.pending.values()) pending.reject(new Error('Dataset changed'));
  S.pending.clear();
}

/* --------------------------------- timeframe --------------------------------- */

function frameInfo(tf) {
  if (!S.meta) return null;
  return S.meta.frames.find((f) => f.id === tf) || null;
}

function frameCount(tf) {
  const info = frameInfo(tf);
  return info ? info.count : 0;
}

function frameSec(tf) {
  const info = frameInfo(tf);
  return info ? info.sec : 86400;
}

function buildTfButtons() {
  const group = $('tfGroup');
  group.innerHTML = '';
  for (const tf of TF_IDS) {
    const btn = document.createElement('button');
    btn.className = 'tf-btn';
    btn.dataset.tf = tf;
    btn.type = 'button';
    btn.textContent = tf;
    btn.addEventListener('click', () => {
      setTimeframe(tf).catch(handleAsyncError);
    });
    group.appendChild(btn);
  }
}

function updateTfButtons() {
  document.querySelectorAll('#tfGroup .tf-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tf === S.tf);
  });
}

/* ------------------------------- time and sessions --------------------------- */

function loadTz() {
  const stored = localStorage.getItem(LS.tz);
  return isValidTimeZone(stored) ? stored : DEFAULT_TZ;
}

function buildTzSelect() {
  const select = $('tzSelect');
  select.innerHTML = '';
  const now = Date.now() / 1000;
  for (const tz of TZ_LIST) {
    const option = document.createElement('option');
    option.value = tz;
    option.textContent = tz === 'UTC' ? 'UTC' : `${zoneLabel(tz)} · ${zoneAbbr(now, tz)}`;
    select.appendChild(option);
  }
  S.tz = loadTz();
  select.value = S.tz;
  select.addEventListener('change', () => {
    const prevTz = S.tz;
    const nextTz = select.value;
    if (!isValidTimeZone(nextTz) || nextTz === prevTz) return;
    const gotoValue = $('gotoInput').value;
    S.tz = nextTz;
    localStorage.setItem(LS.tz, nextTz);
    if (cv) {
      cv.setTimezone(S.tz);
      updateLegend(cv.getLastBar());
      updateReplayUI();
      if (layer) layer.redraw();
    }
    if (gotoValue) {
      const ts = parseWallClock(gotoValue, prevTz);
      if (ts !== null) $('gotoInput').value = toWallClockValue(ts, S.tz);
    }
    toast('Chart time zone: ' + zoneStamp(now, S.tz) + ' · prices unchanged');
  });
}

function normalizeSessionMode(value) {
  return value === 'cash' || value === 'eth' ? value : 'full';
}

function loadSessionMode() {
  return normalizeSessionMode(localStorage.getItem(LS.session));
}

function datasetProvider(meta) {
  return meta && meta.kind === 'mt5' ? 'MT5' : 'Dukascopy';
}

// Only the Dukascopy calendar has a scheduled maintenance break; an MT5 export
// has its own broker gaps, so the overlay must stay empty for it.
function hasScheduledBreak(meta) {
  return !meta || meta.calendar === 'dukascopy';
}

function sessionModeLabel(mode) {
  if (mode === 'cash') return 'Cash session · 09:30–16:00 New York';
  if (mode === 'eth') return 'ETH session · 18:00–17:00 New York';
  return hasScheduledBreak(S.meta) ? 'Full Dukascopy session' : 'Full session';
}

function sessionModeLegend(mode) {
  if (mode === 'cash') return 'Cash 09:30–16:00 NY';
  if (mode === 'eth') return 'ETH 18:00–17:00 NY';
  return 'Full session';
}

function syncSessionUI() {
  const el = $('lgSession');
  if (el) el.textContent = sessionModeLegend(S.sessionMode);
  const select = $('sessionSelect');
  if (select && select.value !== S.sessionMode) select.value = S.sessionMode;
}

function buildSessionSelect() {
  const select = $('sessionSelect');
  select.innerHTML = '';
  const options = [
    { value: 'full', label: 'Full session' },
    { value: 'eth', label: 'ETH session only' },
    { value: 'cash', label: 'Cash session only' }
  ];
  for (const item of options) {
    const option = document.createElement('option');
    option.value = item.value;
    option.textContent = item.label;
    select.appendChild(option);
  }
  S.sessionMode = loadSessionMode();
  select.value = S.sessionMode;
  select.addEventListener('change', () => {
    setSessionMode(select.value).catch(handleAsyncError);
  });
  syncSessionUI();
}

/*
 * Session modes are not highlights: the worker drops every bar outside the
 * session (09:30-16:00 or 18:00-17:00 New York) and rebuilds all timeframes
 * from what is left, so the O/H/L/C of every candle comes from session bars.
 */
async function setSessionMode(value) {
  const next = normalizeSessionMode(value);
  if (next === S.sessionMode) {
    syncSessionUI();
    return;
  }
  if (S.loading) {
    toast('Still loading the previous dataset…');
    syncSessionUI();
    return;
  }
  S.sessionMode = next;
  localStorage.setItem(LS.session, next);
  syncSessionUI();
  if (!S.meta) return;
  await rebuildFrames(next);
}

function currentAnchorTime() {
  const lr = cv.getLogicalRange();
  const center = lr ? cv.getBarAtLocal(Math.round((lr.from + lr.to) / 2)) : null;
  if (center) return center.time;
  return S.meta ? S.meta.lastTime : null;
}

async function rebuildFrames(mode) {
  const anchor = S.replay.active && S.replay.time != null ? S.replay.time : currentAnchorTime();
  const wasReplay = S.replay.active;
  prepareRebuild(sessionModeLabel(mode));
  let meta = null;
  try {
    meta = await new Promise((resolve, reject) => {
      S.ready = resolve;
      S.loadFailed = reject;
      S.worker.postMessage({ cmd: 'setMode', mode });
    });
    S.meta = meta;
    S.buf = null;
    lastLegendBar = null;
    updateDatasetLabel(meta);
    if (!frameCount(S.tf)) {
      const fallback = meta.frames.find((f) => f.count > 0);
      if (fallback) {
        S.tf = fallback.id;
        updateTfButtons();
        cv.setTimeframe(S.tf, frameSec(S.tf));
      }
    }
    if (wasReplay) await loadReplayAtTime(anchor, { keepTrade: true });
    else await loadCentered(S.tf, anchor, 320);
    updateLegend(cv.getLastBar());
    layer.redraw();
    toast(`${sessionModeLabel(mode)} · ${fmtInt(meta.barCount)} bars · OHLC recalculated`);
  } catch (err) {
    handleAsyncError(err);
    $('loader').classList.add('error');
    $('loaderTitle').textContent = 'Could not rebuild candles';
    $('loaderFoot').textContent = String((err && err.message) || err);
    $('loaderClose').hidden = false;
  } finally {
    S.suspendExtend = false;
    if (!meta) {
      S.sessionMode = normalizeSessionMode(S.meta && S.meta.mode);
      syncSessionUI();
    }
    $('loader').hidden = !!meta;
    finishLoadUI();
  }
}

function prepareRebuild(sub) {
  S.loading = true;
  rejectPending();
  stopPlay();
  S.suspendExtend = true;
  $('progressBar').style.width = '0%';
  $('loaderFoot').textContent = 'Recalculating timeframes…';
  $('loaderTitle').textContent = 'Rebuilding candles';
  $('loaderSub').textContent = sub;
  $('loaderClose').hidden = true;
  $('loader').hidden = false;
  $('loader').classList.remove('error');
  $('fileSelect').disabled = true;
  $('openFileBtn').disabled = true;
  syncUpdateButton();
}

function updateDatasetLabel(meta) {
  const kind = meta.mode === 'cash' ? 'cash-session bars'
    : meta.mode === 'eth' ? 'ETH-session bars'
    : 'bars';
  $('brandSub').textContent =
    `${meta.name} · ${fmtInt(meta.barCount)} ${kind} · ${datasetProvider(meta)}`;
}

/*
 * The dataset decides how the terminal reads: brand, symbol and how many
 * decimals a price carries.  GBPUSD feed prices have 5 digits, US100 has 2.
 */
function applyInstrument(fileName) {
  const inst = instrumentFor(fileName);
  S.instrument = inst;
  setPriceDecimals(inst.decimals);
  document.title = `${inst.short} · Lightweight Charts`;
  const mark = document.querySelector('.brand-mark');
  if (mark) mark.textContent = inst.mark;
  const title = document.querySelector('.brand-title');
  if (title) title.textContent = inst.name;
  const legend = document.querySelector('.legend-symbol');
  if (legend) legend.textContent = inst.short;
  if (cv) cv.setInstrument(inst);
  return inst;
}

function applyStoredSchedule() {
  const raw = localStorage.getItem(LS.schedule);
  if (!raw) return;
  try {
    setSchedule(JSON.parse(raw));
  } catch (err) {
    console.warn('Ignoring stored session schedule', err);
    localStorage.removeItem(LS.schedule);
  }
}

// Dukascopy's calendar is the source of truth, but it is configurable for other
// instruments: window.__tv2.setSchedule({ openMinute, closeMinute, timeZone }).
async function applySchedule(cfg) {
  const next = setSchedule(cfg);
  localStorage.setItem(LS.schedule, JSON.stringify(next));
  if (S.source === 'server' && S.datasetName) await loadFromUrl(S.datasetName);
  toast('Session schedule: ' + scheduleLabel());
  return next;
}

// The filtered series contains no break bars, so only the full Dukascopy view
// gets the maintenance-break overlay.
function getOverlayBands() {
  if (!cv || !S.buf || S.sessionMode !== 'full' || !hasScheduledBreak(S.meta)) return [];
  const view = cv.view;
  if (!view.times.length || view.tfSec > 3600) return [];
  const range = cv.getVisibleTimeRange();
  if (!range) return [];
  const from = Math.max(range[0], view.times[0]);
  const to = Math.min(range[1], view.times[view.times.length - 1]);
  if (!(to > from)) return [];
  return sessionBands(from, to, { tfSec: view.tfSec });
}

/* ---------------------------------- toasts ----------------------------------- */

function toast(message, isError) {
  const wrap = $('toasts');
  while (wrap.children.length >= 4) wrap.removeChild(wrap.firstChild);
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' error' : '');
  el.textContent = message;
  wrap.appendChild(el);
  setTimeout(() => {
    if (el.parentNode) el.parentNode.removeChild(el);
  }, isError ? 6000 : 3600);
}

function showHint(text, ms) {
  const el = $('hint');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(S.hintTimer);
  S.hintTimer = setTimeout(() => el.classList.remove('show'), ms || 6500);
}

/* ----------------------------------- legend ---------------------------------- */

function updateLegend(bar) {
  if (bar) lastLegendBar = bar;
  const use = bar || lastLegendBar;
  $('legendTf').textContent = S.tf;
  $('lgTz').textContent =
    S.tz === 'UTC' ? 'UTC' : `${zoneLabel(S.tz)} · ${zoneAbbr(use ? use.time : Date.now() / 1000, S.tz)}`;
  if (!use) {
    ['lgO', 'lgH', 'lgL', 'lgC', 'lgVol'].forEach((id) => {
      $(id).textContent = '—';
    });
    $('lgChg').textContent = '—';
    $('lgChg').className = 'legend-chg';
    $('lgTime').textContent = '—';
    return;
  }
  $('lgO').textContent = fmtPrice(use.open);
  $('lgH').textContent = fmtPrice(use.high);
  $('lgL').textContent = fmtPrice(use.low);
  $('lgC').textContent = fmtPrice(use.close);
  $('lgVol').textContent = fmtVolume(use.volume);
  const prev = use.prevClose;
  if (prev) {
    const change = use.close - prev;
    const pct = (change / prev) * 100;
    $('lgChg').textContent = `${fmtPriceSigned(change)} (${change >= 0 ? '+' : ''}${pct.toFixed(2)}%)`;
    $('lgChg').className = 'legend-chg ' + (change >= 0 ? 'up' : 'down');
  } else {
    $('lgChg').textContent = '—';
    $('lgChg').className = 'legend-chg';
  }
  $('lgTime').textContent = frameSec(S.tf) >= 86400
    ? formatCalendarDate(use.time)
    : formatDateTime(use.time, S.tz);
}

function onCrosshair(bar) {
  updateLegend(bar || (cv ? cv.getLastBar() : null));
}

/* ----------------------------------- files ----------------------------------- */

async function refreshFileList() {
  const select = $('fileSelect');
  try {
    const response = await fetch('/api/files', { cache: 'no-store' });
    const data = await response.json();
    S.files = Array.isArray(data.files) ? data.files : [];
  } catch (err) {
    S.files = [];
  }
  select.innerHTML = '';
  if (!S.files.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No CSV in data/';
    select.appendChild(option);
    return S.files;
  }
  for (const file of S.files) {
    const option = document.createElement('option');
    option.value = file.name;
    const origin = file.kind === 'mt5' ? 'MT5' : file.kind === 'dukascopy' ? 'Dukascopy' : 'CSV';
    option.textContent = `${file.name} · ${fmtBytes(file.size)} · ${origin}`;
    option.title = file.updatable
      ? 'Data source: ' + origin + (file.symbol ? ' · ' + file.symbol : '')
      : 'This file is view-only: no updater knows its layout';
    select.appendChild(option);
  }
  const remembered = localStorage.getItem(LS.file);
  if (remembered && S.files.some((f) => f.name === remembered)) select.value = remembered;
  return S.files;
}

/* ---------------------------------- loading ---------------------------------- */

function prepareLoad(name) {
  S.loading = true;
  rejectPending();
  stopPlay();
  S.meta = null;
  S.buf = null;
  S.datasetName = null;
  S.datasetKey = null;
  S.replay.active = false;
  S.replay.index = -1;
  S.replay.time = null;
  cv.reset();
  layer.load([]);
  renderObjects();
  lastLegendBar = null;
  updateLegend(null);
  $('replayBar').hidden = true;
  $('replaySetup').hidden = true;
  $('progressBar').style.width = '0%';
  $('loaderFoot').textContent = 'Reading and parsing rows…';
  $('loaderTitle').textContent = 'Loading dataset';
  $('loaderSub').textContent = name;
  $('loaderClose').hidden = true;
  $('loader').hidden = false;
  $('loader').classList.remove('error');
  $('fileSelect').disabled = true;
  $('openFileBtn').disabled = true;
  syncUpdateButton();
}

function finishLoadUI() {
  S.loading = false;
  $('fileSelect').disabled = false;
  $('openFileBtn').disabled = false;
  syncUpdateButton();
}

function syncUpdateButton() {
  const btn = $('updateBtn');
  if (!btn) return;
  const mt5 = S.meta && S.meta.kind === 'mt5';
  btn.textContent = S.updating ? 'Updating…' : 'Update data';
  btn.disabled = !(!S.loading && !S.updating && S.source === 'server' && !!S.meta);
  btn.title = mt5
    ? 'Download the missing bars from MetaTrader 5 and append them to this CSV'
    : 'Download the missing 1-minute bars from Dukascopy and append them to this CSV';
}

function updateProgress(msg) {
  if (!S.loading) return;
  if (msg.phase === 'parse') {
    const total = msg.total || 0;
    const ratio = total ? msg.loaded / total : Math.min(1, msg.rows / 3000000);
    const pct = clamp(ratio * 96, 0, 96);
    $('progressBar').style.width = pct.toFixed(1) + '%';
    $('loaderFoot').textContent = `${fmtInt(msg.rows)} rows · ${fmtBytes(msg.loaded)}` +
      (total ? ` / ${fmtBytes(total)}` : '');
  } else {
    const count = msg.count || 10;
    const pct = 96 + clamp(((msg.index || 0) / count) * 4, 0, 4);
    $('progressBar').style.width = pct.toFixed(1) + '%';
    $('loaderFoot').textContent =
      msg.tf === 'sorting'
        ? 'Sorting rows by time…'
        : msg.tf === 'filtering'
          ? 'Filtering session bars…'
          : `Aggregating ${msg.tf} candles…`;
  }
}

function showLoadError(err) {
  console.error(err);
  S.loading = false;
  $('fileSelect').disabled = false;
  $('openFileBtn').disabled = false;
  $('loader').classList.add('error');
  $('loaderTitle').textContent = 'Could not load CSV';
  $('loaderSub').textContent = S.datasetName || $('loaderSub').textContent;
  $('loaderFoot').textContent = String((err && err.message) || err);
  $('loaderClose').hidden = false;
  toast('Failed to load CSV: ' + String((err && err.message) || err), true);
  if (!S.meta) updateLegend(null);
  syncUpdateButton();
}

async function loadFromUrl(name) {
  if (S.loading) {
    toast('Still loading the previous dataset…');
    return;
  }
  S.source = 'server';
  prepareLoad(name);
  try {
    const meta = await new Promise((resolve, reject) => {
      S.ready = resolve;
      S.loadFailed = reject;
      S.worker.postMessage({
        cmd: 'loadUrl',
        url: '/api/data/' + encodeURIComponent(name),
        name,
        mode: S.sessionMode
      });
    });
    await finishLoad(meta);
    localStorage.setItem(LS.file, name);
    const select = $('fileSelect');
    if (Array.from(select.options).some((o) => o.value === name)) select.value = name;
  } catch (err) {
    showLoadError(err);
  } finally {
    finishLoadUI();
  }
}

async function loadFromFile(file) {
  if (S.loading) {
    toast('Still loading the previous dataset…');
    return;
  }
  S.source = 'local';
  prepareLoad(file.name);
  try {
    const buffer = await file.arrayBuffer();
    const meta = await new Promise((resolve, reject) => {
      S.ready = resolve;
      S.loadFailed = reject;
      S.worker.postMessage(
        { cmd: 'loadBuffer', buffer, name: file.name, mode: S.sessionMode },
        [buffer]
      );
    });
    await finishLoad(meta);
    const select = $('fileSelect');
    const option = document.createElement('option');
    option.value = '__local__';
    option.textContent = `Local: ${file.name} · ${fmtBytes(file.size)}`;
    select.appendChild(option);
    select.value = '__local__';
  } catch (err) {
    showLoadError(err);
  } finally {
    finishLoadUI();
  }
}

async function updateData() {
  if (S.loading || S.updating) return;
  if (!S.meta || S.source !== 'server' || !S.datasetName) {
    toast('Open a CSV stored in the data folder to update it');
    return;
  }
  const name = S.datasetName;
  S.updating = true;
  syncUpdateButton();
  try {
    const res = await fetch('/api/update/' + encodeURIComponent(name), { method: 'POST' });
    let payload = null;
    try {
      payload = await res.json();
    } catch (err) {
      payload = null;
    }
    if (!res.ok) throw new Error((payload && payload.error) || ('HTTP ' + res.status));
    const provider = payload.provider || (S.meta && S.meta.kind === 'mt5' ? 'MetaTrader 5' : 'Dukascopy');
    const shifted = payload.offsetSeconds
      ? ` · MT5 clock shifted ${payload.offsetSeconds > 0 ? '+' : ''}${payload.offsetSeconds}s to UTC`
      : '';
    if (!payload.added) {
      const pending = payload.skipped && payload.skipped.length
        ? ` · ${payload.skipped.length} day(s) not available yet`
        : '';
      const last = payload.lastNew ? formatDateTime(payload.lastNew / 1000, S.tz) : '—';
      toast(`Data is up to date from ${provider} · last bar ${last}${pending}${shifted}`);
      return;
    }
    if (payload.remainingDays > 0) {
      toast(`${fmtInt(payload.remainingDays)} more day(s) pending · click Update again`, true);
    } else if (payload.skipped && payload.skipped.length) {
      const first = payload.skipped[0];
      toast(`${payload.skipped.length} day(s) skipped (${first.date}: ${first.error})`, true);
    }
    toast(`Added ${fmtInt(payload.added)} bars from ${provider}${shifted} · reloading chart…`);
    await loadFromUrl(name);
  } catch (err) {
    toast('Update failed: ' + String((err && err.message) || err), true);
  } finally {
    S.updating = false;
    syncUpdateButton();
  }
}

async function finishLoad(meta) {
  S.meta = meta;
  S.datasetName = meta.name;
  S.datasetKey = (S.source === 'local' ? 'local:' : 'srv:') + meta.name;
  S.sessionMode = normalizeSessionMode(meta.mode);
  syncSessionUI();
  applyInstrument(meta.name);

  const storedTf = localStorage.getItem(LS.tf);
  S.tf = storedTf && TF_IDS.indexOf(storedTf) !== -1 && meta.frames.some((f) => f.id === storedTf)
    ? storedTf
    : meta.frames.some((f) => f.id === '1D') ? '1D' : meta.frames[0].id;

  updateTfButtons();
  cv.setTimeframe(S.tf, frameSec(S.tf));
  layer.load(loadStoredDrawings());
  renderObjects();

  updateDatasetLabel(meta);
  $('legendTf').textContent = S.tf;

  S.suspendExtend = true;
  try {
    const count = frameCount(S.tf);
    const from = Math.max(0, count - WINDOW_BARS);
    await loadWindow(S.tf, from, count, { visibleBars: Math.min(420, count) });
  } finally {
    setTimeout(() => {
      S.suspendExtend = false;
    }, 150);
  }

  const last = cv.getLastBar();
  updateLegend(last);
  $('gotoInput').value = toWallClockValue(last ? last.time : meta.lastTime, S.tz);
  $('loader').hidden = true;
  const kind = meta.mode === 'cash' ? 'cash-session bars'
    : meta.mode === 'eth' ? 'ETH-session bars'
    : '1-minute bars';
  toast(`Loaded ${fmtInt(meta.barCount)} ${kind} across ${meta.frames.length} timeframes`);
}

// Older builds keyed drawings by "<name>|<barCount>|<first>|<last>", so
// appending bars orphaned them. Migrate the newest legacy record to the
// per-file key the first time a dataset is opened.
function takeLegacyDrawings(name) {
  const prefix = LS.drawings + name + '|';
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.indexOf(prefix) === 0) keys.push(key);
  }
  if (!keys.length) return null;
  keys.sort();
  const raw = localStorage.getItem(keys[keys.length - 1]);
  keys.forEach((key) => localStorage.removeItem(key));
  return raw;
}

function loadStoredDrawings() {
  if (!S.datasetKey) return [];
  try {
    const key = LS.drawings + S.datasetKey;
    let raw = localStorage.getItem(key);
    if (!raw && S.meta && S.meta.name) {
      raw = takeLegacyDrawings(S.meta.name);
      if (raw) localStorage.setItem(key, raw);
    }
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}

const persistDrawings = debounce((list) => {
  if (!S.datasetKey) return;
  try {
    localStorage.setItem(LS.drawings + S.datasetKey, JSON.stringify(list));
  } catch (err) {
    console.warn('Could not save drawings', err);
  }
}, 250);

/* -------------------------------- data windows -------------------------------- */

async function loadWindow(tf, from, to, opts) {
  const options = opts || {};
  const res = await call('window', { tf, from, to });
  S.buf = res;
  const displayEnd = options.displayEnd != null ? options.displayEnd : res.end;
  cv.setFrame(res, displayEnd);
  const len = cv.view.times.length;
  if (options.visibleBars) {
    cv.setVisibleLatest(Math.min(options.visibleBars, Math.max(1, len)));
  } else if (options.visibleFrom != null && options.visibleTo != null) {
    cv.setVisibleRangeNow(options.visibleFrom, options.visibleTo);
  }
  if (options.silent !== true) updateLegend(cv.getLastBar());
  layer.redraw();
}

async function loadCentered(tf, centerTime, barsVisible) {
  if (!S.meta) return;
  S.suspendExtend = true;
  try {
    const count = frameCount(tf);
    if (!count) return;
    const found = await call('find', { tf, time: centerTime });
    const center = found.index >= 0 ? found.index : 0;
    let from = clamp(center - Math.floor(WINDOW_BARS / 2), 0, Math.max(0, count - WINDOW_BARS));
    const to = Math.min(count, from + WINDOW_BARS);
    await loadWindow(tf, from, to);
    const local = center - from;
    const len = to - from;
    const n = Math.max(40, Math.min(barsVisible || 320, len));
    let vf = local - Math.floor(n / 2);
    let vt = vf + n;
    const maxTo = len + 4;
    if (vt > maxTo) {
      vf -= vt - maxTo;
      vt = maxTo;
    }
    if (vf < -8) {
      vt += -8 - vf;
      vf = -8;
    }
    cv.setVisibleRangeNow(vf, vt);
    layer.redraw();
  } finally {
    setTimeout(() => {
      S.suspendExtend = false;
    }, 150);
  }
}

function onViewportChange() {
  if (layer) layer.redraw();
  scheduleExtend();
}

function scheduleExtend() {
  if (S.extendTimer || S.suspendExtend || S.loading || !S.buf || S.replay.busy) return;
  S.extendTimer = setTimeout(() => {
    S.extendTimer = 0;
    maybeExtend().catch(handleAsyncError);
  }, 90);
}

async function maybeExtend() {
  if (!S.buf || S.extendBusy || S.suspendExtend || S.loading || S.replay.busy) return;
  const lr = cv.getLogicalRange();
  if (!lr || !cv.view.times.length) return;
  if (cv.view.times.length < 10) return;
  if (S.buf.start > 1500 && lr.from < 1500) {
    await prependWindow();
    return;
  }
  if (!S.replay.active && S.buf.end < S.buf.count && lr.to > cv.view.times.length - 1500) {
    await appendWindow();
  }
}

async function prependWindow() {
  if (!S.buf || S.extendBusy) return;
  S.extendBusy = true;
  S.suspendExtend = true;
  try {
    const lr = cv.getLogicalRange();
    const from = Math.max(0, S.buf.start - BUFFER_BARS);
    const prepended = S.buf.start - from;
    if (prepended <= 0) return;
    const displayEnd = S.replay.active ? S.replay.index + 1 : undefined;
    const res = await call('window', { tf: S.tf, from, to: S.buf.end });
    S.buf = res;
    cv.setFrame(res, displayEnd != null ? displayEnd : res.end);
    if (lr) cv.setVisibleRangeNow(lr.from + prepended, lr.to + prepended);
    layer.redraw();
  } finally {
    S.extendBusy = false;
    setTimeout(() => {
      S.suspendExtend = false;
    }, 150);
  }
}

async function appendWindow() {
  if (!S.buf || S.extendBusy) return;
  S.extendBusy = true;
  S.suspendExtend = true;
  try {
    const lr = cv.getLogicalRange();
    const from = S.buf.start;
    const to = Math.min(S.buf.count, S.buf.end + BUFFER_BARS);
    if (to <= S.buf.end) return;
    const res = await call('window', { tf: S.tf, from, to });
    S.buf = res;
    cv.setFrame(res, res.end);
    if (lr) cv.setVisibleRangeNow(lr.from, lr.to);
    layer.redraw();
  } finally {
    S.extendBusy = false;
    setTimeout(() => {
      S.suspendExtend = false;
    }, 150);
  }
}

/* -------------------------------- navigation --------------------------------- */

async function setTimeframe(tf) {
  if (!S.meta || S.loading) return;
  if (tf === S.tf && S.buf) return;
  stopPlay();

  let anchor;
  if (S.replay.active) {
    anchor = S.replay.time;
  } else {
    const lr = cv.getLogicalRange();
    const centerBar = lr ? cv.getBarAtLocal(Math.round((lr.from + lr.to) / 2)) : null;
    const visible = centerBar ? null : cv.getVisibleTimeRange();
    anchor = centerBar ? centerBar.time : visible ? (visible[0] + visible[1]) / 2 : S.meta.lastTime;
    anchor = clamp(anchor, S.meta.firstTime, S.meta.lastTime);
  }

  S.tf = tf;
  localStorage.setItem(LS.tf, tf);
  updateTfButtons();
  cv.setTimeframe(tf, frameSec(tf));
  updateLegend(cv.getLastBar());
  $('legendTf').textContent = tf;

  if (S.replay.active) {
    await loadReplayAtTime(anchor, { keepTrade: true });
  } else {
    await loadCentered(tf, anchor, 400);
  }
  $('gotoInput').value = toWallClockValue(anchor, S.tz);
}

async function gotoTime(ts) {
  if (!S.meta) return;
  if (!Number.isFinite(ts)) return;
  let target = ts;
  if (target < S.meta.firstTime) {
    toast('That time is before the first bar — jumping to the first bar');
    target = S.meta.firstTime;
  }
  if (target > S.meta.lastTime) {
    toast('That time is after the last bar — jumping to the last bar');
    target = S.meta.lastTime;
  }
  stopPlay();
  if (S.replay.active) {
    await loadReplayAtTime(target, { keepTrade: true });
  } else {
    await loadCentered(S.tf, target, 320);
  }
  $('gotoInput').value = toWallClockValue(target, S.tz);
  updateLegend(cv.getLastBar());
}

async function gotoLatest() {
  if (!S.meta) return;
  stopPlay();
  const count = frameCount(S.tf);
  if (!count) return;
  if (S.replay.active) {
    await loadReplayWindow(count - 1, { visibleBars: 160, keepTrade: true });
    updateLegend(cv.getLastBar());
    return;
  }
  S.suspendExtend = true;
  try {
    const from = Math.max(0, count - WINDOW_BARS);
    await loadWindow(S.tf, from, count, { visibleBars: Math.min(420, count) });
  } finally {
    setTimeout(() => {
      S.suspendExtend = false;
    }, 150);
  }
  $('gotoInput').value = toWallClockValue(S.meta.lastTime, S.tz);
  updateLegend(cv.getLastBar());
}

/* ----------------------------------- replay ---------------------------------- */

async function openReplaySetup() {
  if (!S.meta) {
    toast('Load a CSV first');
    return;
  }
  let time = null;
  const visible = cv.getVisibleTimeRange();
  if (visible) time = (visible[0] + visible[1]) / 2;
  if (!time) time = S.meta.lastTime;
  $('replayStartInput').value = toWallClockValue(Math.round(time), S.tz);
  $('replaySetup').hidden = false;
  $('replayStartInput').focus();
}

function hideReplaySetup() {
  $('replaySetup').hidden = true;
}

async function startReplay(ts) {
  if (!S.meta || S.loading) return;
  const found = await call('find', { tf: S.tf, time: ts });
  let index = found.index;
  if (index < 0) {
    toast('There is no bar at or before that time');
    return;
  }
  stopPlay();
  S.replay.active = true;
  S.replay.playing = false;
  S.replay.busy = false;
  hideReplaySetup();
  $('replayBar').hidden = false;
  resetTrade(true);
  await loadReplayWindow(index, { visibleBars: 160, keepTrade: true });
  updateReplayUI();
  toast('Replay started at ' + formatDateTime(S.replay.time, S.tz) + ' · ' + zoneLabel(S.tz));
}

async function loadReplayAtTime(time, opts) {
  const options = opts || {};
  const count = frameCount(S.tf);
  if (!count) return;
  const found = await call('find', { tf: S.tf, time });
  const index = found.index >= 0 ? found.index : 0;
  await loadReplayWindow(index, { visibleBars: 160, keepTrade: options.keepTrade });
  updateLegend(cv.getLastBar());
}

async function loadReplayWindow(index, opts) {
  const options = opts || {};
  const count = frameCount(S.tf);
  const displayEnd = index + 1;
  const to = Math.min(count, displayEnd + LOOKAHEAD_BARS);
  let from = Math.max(0, to - WINDOW_BARS);
  if (from > index) from = Math.max(0, index + 1 - WINDOW_BARS);

  S.suspendExtend = true;
  try {
    await loadWindow(S.tf, from, to, { displayEnd, visibleBars: options.visibleBars || 160 });
    S.replay.index = index;
    S.replay.time = S.buf.times[index - S.buf.start];
    if (!options.keepTrade) resetTrade(false);
    updateReplayUI();
  } finally {
    setTimeout(() => {
      S.suspendExtend = false;
    }, 150);
  }
}

async function stepReplay() {
  if (!S.replay.active || S.replay.busy) return;
  const count = frameCount(S.tf);
  if (S.replay.index >= count - 1) {
    stopPlay();
    updateReplayUI();
    toast('Reached the end of the dataset');
    return;
  }
  S.replay.busy = true;
  try {
    const next = S.replay.index + 1;
    if (S.buf && next < S.buf.end) {
      const local = next - S.buf.start;
      const bar = {
        time: S.buf.times[local],
        open: S.buf.open[local],
        high: S.buf.high[local],
        low: S.buf.low[local],
        close: S.buf.close[local],
        volume: S.buf.volume[local]
      };
      cv.appendBar(bar);
      S.replay.index = next;
      S.replay.time = bar.time;
      cv.setVisibleLatest(160);
      layer.redraw();
      updateLegend(cv.getLastBar());
      updateReplayUI();
      if (cv.view.times.length > WINDOW_BARS + BUFFER_BARS) {
        await loadReplayWindow(next, { visibleBars: 160, keepTrade: true });
      }
    } else {
      await loadReplayWindow(next, { visibleBars: 160, keepTrade: true });
      layer.redraw();
      updateLegend(cv.getLastBar());
    }
  } catch (err) {
    handleAsyncError(err);
  } finally {
    S.replay.busy = false;
  }
}

function startPlay() {
  stopPlay();
  S.replay.playing = true;
  const tick = async () => {
    if (!S.replay.playing) return;
    await stepReplay();
    if (!S.replay.playing) return;
    S.replay.timer = setTimeout(tick, Math.max(40, 700 / S.replay.speed));
  };
  S.replay.timer = setTimeout(tick, 120);
  updateReplayUI();
}

function stopPlay() {
  S.replay.playing = false;
  if (S.replay.timer) {
    clearTimeout(S.replay.timer);
    S.replay.timer = 0;
  }
}

function togglePlay() {
  if (!S.replay.active) return;
  if (S.replay.playing) stopPlay();
  else startPlay();
  updateReplayUI();
}

async function exitReplay() {
  if (!S.replay.active) return;
  stopPlay();
  S.replay.active = false;
  S.replay.index = -1;
  S.replay.time = null;
  S.replay.busy = false;
  $('replayBar').hidden = true;
  hideReplaySetup();
  resetTrade(true);
  await gotoLatest();
  updateReplayUI();
  toast('Replay closed');
}

function updateReplayUI() {
  if (!S.replay.active) {
    $('tradeStatus').textContent = '—';
    $('tradeStatus').className = 'trade-status';
    return;
  }
  $('replayPlayBtn').textContent = S.replay.playing ? 'Pause' : 'Play';
  $('replayTime').textContent = S.replay.time
    ? formatDateTime(S.replay.time, S.tz) + ' · ' + zoneLabel(S.tz)
    : '—';
  updateTradeUI();
}

function resetTrade(full) {
  S.trade.side = 0;
  S.trade.entry = 0;
  S.trade.entryTime = 0;
  if (full) {
    S.trade.realized = 0;
    S.trade.trades = 0;
  }
  cv.setTradeLine(null);
  updateTradeUI();
}

function updateTradeUI() {
  const el = $('tradeStatus');
  if (!S.replay.active) {
    el.textContent = '—';
    el.className = 'trade-status';
    return;
  }
  const bar = cv.getLastBar();
  const price = bar ? bar.close : null;
  const trade = S.trade;
  if (trade.side === 0 || price === null) {
    el.textContent = trade.trades
      ? `Flat · realized ${fmtPriceSigned(trade.realized)}`
      : 'Flat';
    el.className = 'trade-status';
    return;
  }
  const diff = trade.side === 1 ? price - trade.entry : trade.entry - price;
  const pct = trade.entry ? (diff / trade.entry) * 100 : 0;
  el.textContent = `${trade.side === 1 ? 'Long' : 'Short'} @ ${fmtPrice(trade.entry)} · ` +
    `${fmtPriceSigned(diff)} (${diff >= 0 ? '+' : ''}${pct.toFixed(2)}%)`;
  el.className = 'trade-status ' + (diff >= 0 ? 'up' : 'down');
}

function tradeAction(side) {
  if (!S.replay.active) {
    toast('Paper trading is available during replay');
    return;
  }
  const bar = cv.getLastBar();
  if (!bar) return;
  const price = bar.close;
  const trade = S.trade;
  if (trade.side === 0) {
    trade.side = side;
    trade.entry = price;
    trade.entryTime = bar.time;
    cv.setTradeLine(price);
    toast((side === 1 ? 'Long' : 'Short') + ' opened at ' + fmtPrice(price) + ' (paper)');
  } else if (trade.side === side) {
    toast(trade.side === 1 ? 'Already long' : 'Already short');
  } else {
    const pnl = trade.side === 1 ? price - trade.entry : trade.entry - price;
    trade.realized += pnl;
    trade.trades += 1;
    trade.side = 0;
    trade.entry = 0;
    trade.entryTime = 0;
    cv.setTradeLine(null);
    toast(`Trade closed: ${fmtPriceSigned(pnl)} (paper)`);
  }
  updateTradeUI();
}

/* ---------------------------------- drawings --------------------------------- */

function renderObjects() {
  if (!layer) return;
  const list = $('objectsList');
  const drawings = layer.getDrawings();
  $('objCount').textContent = String(drawings.length);
  $('deleteBtn').disabled = !layer.getSelected();

  renderColorRow();
  renderWidthRow();

  if (!drawings.length) {
    list.innerHTML = '<div class="objects-empty">No drawings yet</div>';
    return;
  }
  list.innerHTML = '';
  for (const drawing of drawings.slice().reverse()) {
    const row = document.createElement('div');
    row.className = 'obj-row' + (drawing.id === layer.selectedId ? ' selected' : '');
    row.dataset.id = drawing.id;
    const dot = document.createElement('span');
    dot.className = 'obj-dot';
    dot.style.background = drawing.color;
    const name = document.createElement('span');
    name.className = 'obj-name';
    name.textContent = TOOL_LABELS[drawing.type] || drawing.type;
    const del = document.createElement('button');
    del.className = 'obj-del';
    del.type = 'button';
    del.title = 'Delete';
    del.textContent = '×';
    del.addEventListener('click', (event) => {
      event.stopPropagation();
      layer.remove(drawing.id);
    });
    row.addEventListener('click', () => {
      layer.selectById(drawing.id);
      setTool('select');
    });
    row.appendChild(dot);
    row.appendChild(name);
    row.appendChild(del);
    list.appendChild(row);
  }
}

function renderColorRow() {
  const row = $('colorRow');
  const selected = layer ? layer.getSelected() : null;
  if (!selected) {
    row.hidden = true;
    row.innerHTML = '';
    return;
  }
  row.hidden = false;
  row.innerHTML = '';
  for (const color of PALETTE) {
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'swatch' + (selected.color.toLowerCase() === color ? ' active' : '');
    swatch.style.background = color;
    swatch.title = color;
    swatch.addEventListener('click', (event) => {
      event.stopPropagation();
      layer.setColor(selected.id, color);
    });
    row.appendChild(swatch);
  }
}

function renderWidthRow() {
  const range = $('widthRange');
  if (!range || !layer) return;
  const selected = layer.getSelected();
  const width = selected ? selected.width : layer.defaultWidth;
  range.value = String(width);
  $('widthValue').textContent = width + ' px';
}

function setTool(tool) {
  layer.setTool(tool);
  document.querySelectorAll('.tool[data-tool]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tool === tool);
  });
  $('deleteBtn').disabled = !layer.getSelected();
  const messages = {
    pan: 'Drag to pan · Scroll to zoom · Use the left toolbar to draw',
    select: 'Click a drawing to select · Drag to move · Del deletes · Esc exits',
    trend: 'Drag to draw a trend line · Esc to cancel',
    hline: 'Click or drag to place a horizontal line · Esc to cancel',
    hray: 'Click or drag to place a horizontal ray · Esc to cancel',
    vline: 'Click or drag to place a vertical line · Esc to cancel',
    rect: 'Drag to draw a rectangle · Esc to cancel'
  };
  showHint(messages[tool] || messages.pan);
}

/* ---------------------------------- bindings --------------------------------- */

function handleAsyncError(err) {
  console.error(err);
  toast(String((err && err.message) || err), true);
}

function bindUI() {
  document.querySelectorAll('.tool[data-tool]').forEach((btn) => {
    btn.addEventListener('click', () => setTool(btn.dataset.tool));
  });

  $('deleteBtn').addEventListener('click', () => layer.deleteSelected());

  $('widthRange').addEventListener('input', (event) => {
    const width = Number(event.target.value);
    const selected = layer.getSelected();
    if (selected) {
      layer.setWidth(selected.id, width);
    } else {
      layer.setDefaultWidth(width);
      localStorage.setItem(LS.width, String(width));
    }
    renderWidthRow();
  });

  $('objectsToggle').addEventListener('click', () => {
    $('objectsPanel').classList.toggle('collapsed');
  });

  $('clearDrawingsBtn').addEventListener('click', () => {
    if (!layer.hasDrawings()) return;
    if (confirm('Remove all drawings on this dataset?')) {
      layer.clear();
      toast('Drawings cleared');
    }
  });

  $('fileSelect').addEventListener('change', (event) => {
    const name = event.target.value;
    if (!name || name === '__local__' || S.loading) return;
    loadFromUrl(name);
  });

  $('openFileBtn').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', (event) => {
    const file = event.target.files && event.target.files[0];
    if (file) loadFromFile(file);
    event.target.value = '';
  });
  $('updateBtn').addEventListener('click', () => updateData().catch(handleAsyncError));

  document.addEventListener('dragover', (event) => event.preventDefault());
  document.addEventListener('drop', (event) => {
    event.preventDefault();
    const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
    if (file && /\.csv$/i.test(file.name)) loadFromFile(file);
  });

  $('gotoBtn').addEventListener('click', () => {
    const ts = parseWallClock($('gotoInput').value, S.tz);
    if (ts === null) {
      toast('Pick a valid date and time');
      return;
    }
    gotoTime(ts).catch(handleAsyncError);
  });
  $('gotoInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      $('gotoBtn').click();
    }
  });
  $('latestBtn').addEventListener('click', () => gotoLatest().catch(handleAsyncError));

  $('replayBtn').addEventListener('click', () => {
    if (!S.meta) {
      toast('Load a CSV first');
      return;
    }
    if (S.replay.active) {
      hideReplaySetup();
      $('replayBar').hidden = false;
      return;
    }
    openReplaySetup();
  });

  $('strategyBtn').addEventListener('click', () => {
    window.open('/strategy/', '_blank', 'noopener');
  });

  $('riskBtn').addEventListener('click', () => {
    window.open('/risk/', '_blank', 'noopener');
  });

  $('propBtn').addEventListener('click', () => {
    window.open('/prop/', '_blank', 'noopener');
  });

  $('prop2Btn').addEventListener('click', () => {
    window.open('/prop2/', '_blank', 'noopener');
  });

  $('combineBtn').addEventListener('click', () => {
    window.open('/combine/', '_blank', 'noopener');
  });

  $('replayStartBtn').addEventListener('click', () => {
    const ts = parseWallClock($('replayStartInput').value, S.tz);
    if (ts === null) {
      toast('Pick a valid replay start time');
      return;
    }
    startReplay(ts).catch(handleAsyncError);
  });
  $('replaySetupClose').addEventListener('click', hideReplaySetup);
  $('replayPlayBtn').addEventListener('click', togglePlay);
  $('replayStepBtn').addEventListener('click', () => {
    stopPlay();
    stepReplay().catch(handleAsyncError);
    updateReplayUI();
  });
  $('replaySpeed').addEventListener('change', (event) => {
    S.replay.speed = Number(event.target.value) || 1;
    if (S.replay.playing) startPlay();
  });
  $('replayExitBtn').addEventListener('click', () => exitReplay().catch(handleAsyncError));
  $('tradeBuy').addEventListener('click', () => tradeAction(1));
  $('tradeSell').addEventListener('click', () => tradeAction(-1));

  $('loaderClose').addEventListener('click', () => {
    $('loader').hidden = true;
  });

  document.addEventListener('keydown', (event) => {
    const tag = event.target && event.target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

    if (event.key === 'Escape') {
      if (!$('replaySetup').hidden) {
        hideReplaySetup();
        return;
      }
      setTool('pan');
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (layer.getSelected()) {
        layer.deleteSelected();
        event.preventDefault();
      }
      return;
    }
    if (event.key === ' ' && S.replay.active) {
      togglePlay();
      event.preventDefault();
      return;
    }
    if (event.key === 'ArrowRight' && S.replay.active) {
      stopPlay();
      stepReplay().catch(handleAsyncError);
      updateReplayUI();
      event.preventDefault();
    }
  });

  window.addEventListener('resize', () => {
    if (layer) layer.redraw();
  });
}

/* ------------------------------------ init ----------------------------------- */

async function init() {
  applyStoredSchedule();
  buildTzSelect();
  buildSessionSelect();
  buildTfButtons();
  startWorker();

  cv = createChartView($('chart'), {
    onCrosshair,
    onViewportChange
  });

  layer = new DrawingLayer({
    canvas: $('overlay'),
    container: $('chartWrap'),
    getMapping: cv.getMapping,
    getBands: getOverlayBands,
    defaultWidth: Number(localStorage.getItem(LS.width)) || undefined,
    onPersist: persistDrawings,
    onSelectionChange: () => renderObjects(),
    onDrawingsChange: () => renderObjects()
  });
  layer.startSync(() => cv.getSyncKey());

  updateTfButtons();
  cv.setTimezone(S.tz);
  bindUI();
  renderWidthRow();
  setTool('pan');
  updateLegend(null);
  updateReplayUI();

  const files = await refreshFileList();
  if (files.length) {
    const remembered = localStorage.getItem(LS.file);
    const pick = files.find((f) => f.name === remembered) || files[0];
    await loadFromUrl(pick.name);
  } else {
    showHint('Drop a CSV anywhere, or click “Open CSV” to start', 12000);
    toast('No CSV found in data/ — open a CSV file to start', true);
  }

  window.__tv2 = {
    state: S,
    chartView: cv,
    drawings: layer,
    setSchedule: (cfg) => applySchedule(cfg),
    getSchedule,
    setSessionMode,
    bands: getOverlayBands
  };
}

init().catch((err) => {
  console.error(err);
  toast('Startup error: ' + String((err && err.message) || err), true);
});
