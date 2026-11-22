'use strict';

/* ------------------------------------------------------------------ factors */

const FACTORS = [
  { key: 'sl', title: 'Stop', options: [[50, '50 points'], [100, '100 points']] },
  { key: 'tp', title: 'Target', options: [[50, '50 points'], [100, '100 points'], [150, '150 points'], [200, '200 points']] },
  { key: 'session', title: 'Trading session', options: [['london', 'London only'], ['ny', 'New York only'], ['rth', 'New York RTH only'], ['all', 'London to New York']] },
  { key: 'open', title: 'Cash open', options: [['skip', 'Skip 09:30'], ['keep', 'Include 09:30']] },
  { key: 'nyopen', title: 'NY open', options: [['skip', 'Skip 08:30-08:32'], ['keep', 'Include 08:30-08:32']] },
  { key: 'lvl', title: 'Level session', options: [['all', 'All hours'], ['eth', 'ETH session'], ['rth', 'RTH session']] },
  { key: 'typ', title: 'Trade type', options: [['rev', 'Reversal'], ['cont', 'Continuation']] },
  { key: 'entry', title: 'Entry', options: [['touch', 'Touch'], ['confirm', '1-minute close']] },
  { key: 'look', title: 'Level lookback', options: [['1m', '1 month'], ['6m', '6 months'], ['1y', '1 year'], ['all', 'All history']] },
  { key: 'tpd', title: 'Trades per day', options: [['every', 'Every level'], ['serial', 'One at a time'], ['one', 'One a day'], ['until', 'Until target']] },
];

const FACTOR_KEYS = FACTORS.map(f => f.key);
const NUMERIC_FACTORS = new Set(['sl', 'tp']);
const LABELS = {};
for (const f of FACTORS) {
  LABELS[f.key] = {};
  for (const [value, label] of f.options) LABELS[f.key][value] = label;
}

const COLUMNS = [
  { key: 'fav', label: '', sortable: false, title: 'Star a run on this page. The star is stored with this CSV.' },
  { key: 'id', label: 'Run', title: 'The combination id. Click the row for each month.' },
  { key: 'sl', label: 'SL', num: true, title: 'Stop distance in points.' },
  { key: 'tp', label: 'TP', num: true, title: 'Target distance in points, measured from the fill.' },
  { key: 'session', label: 'Session', title: 'London 08:00–16:30 London, New York 08:00–17:00 New York, RTH 09:30–16:00 New York, or All for London or New York.' },
  { key: 'open', label: '09:30', title: 'RTH only. Skip drops the 09:30 New York bar. Include keeps it. On US100 the stored RTH id skips it; the id ending in _keep includes it. Other sessions show a dash.' },
  { key: 'nyopen', label: '08:30', title: 'New York session only. Skip drops the 08:30 and 08:31 New York bars and keeps 08:32. The stored id includes them; the id ending in _skip drops them. Other sessions show a dash.' },
  { key: 'lvl', label: 'Levels', title: 'Which completed candles may supply a level: all hours, ETH, or RTH.' },
  { key: 'typ', label: 'Type', title: 'Reversal fades the level. Continuation trades the break.' },
  { key: 'entry', label: 'Entry', title: 'Touch fills from the level. A 1-minute close fills at the close, and a buy adds the 1.3 spread.' },
  { key: 'look', label: 'Look', title: 'How far back a level may come from: 1 month, 6 months, 1 year, or all history.' },
  { key: 'tpd', label: 'Per day', title: 'Every level, one trade at a time, one trade a day, or stop for the day once the target points are reached.' },
  { key: 'trades', label: 'Trades', num: true, title: 'Trades taken in the analysed months' },
  { key: 'lot', label: 'Lot', num: true, title: 'Largest lot whose Risk Factor stays under 5.5 in every month' },
  { key: 'gain_lo', label: 'Gain low', num: true, title: 'Lowest monthly gain at that lot' },
  { key: 'gain_hi', label: 'Gain high', num: true, title: 'Highest monthly gain at that lot' },
  { key: 'gain_total', label: 'Gain total', num: true, title: 'Sum of the monthly gains at that lot' },
  { key: 'gain_avg', label: 'Gain avg', num: true, title: 'Average monthly gain at that lot' },
  { key: 'ret_avg', label: 'Return avg', num: true, title: 'Average monthly gain as a % of the starting balance' },
  { key: 'rf_lo', label: 'RF low', num: true, title: 'Lowest monthly Risk Factor at that lot' },
  { key: 'rf_hi', label: 'RF high', num: true, title: 'Highest monthly Risk Factor at that lot (pass is below 5.5)' },
  { key: 'dd', label: 'Max DD', num: true, title: 'Worst relative drawdown across the months' },
  { key: 'util', label: 'Max util', num: true, title: 'Worst deposit utilisation across the months' },
  { key: 'state', label: 'State', title: 'Safe means every month of the chosen year stays under Risk Factor 5.5 at the lot shown. Fail means the minimum lot already exceeds it.' },
];

const MARGIN_LABELS = {
  US100: '1% of price per lot',
  GBPUSD: 'price × 250 per lot (1:400)',
  XAUUSD: '0.2% of price per lot',
};

const state = {
  file: '',
  meta: null,
  runs: new Map(),
  rows: [],
  favourites: new Set(),
  filters: {},
  search: '',
  favOnly: false,
  hideUnrun: false,
  sortKey: 'gain_total',
  sortDir: -1,
  fontScale: 1,
  shown: 300,
  expanded: null,
  filtered: [],
  status: null,
  pollTimer: null,
  wasRunning: false,
  instrument: null,
  specs: {},
  stale: false,
  config: { maxLot: 100, balance: 5000, year: 2026 },
  files: [],
};

for (const f of FACTORS) state.filters[f.key] = new Set(f.options.map(o => o[0]));

/* ------------------------------------------------------------------ helpers */

const nf = new Intl.NumberFormat('en-US');

function headerTone(label) {
  const low = String(label || '').toLowerCase();
  if (low === 'sl' || /\b(blown|blow|blows|stop|stops|loss|losses|gap|fail|fails)\b/.test(low)) return 'neg';
  if (low === 'tp' || /\b(funded|target|targets|payout|payouts|win|wins|pass|passes|safe)\b/.test(low)) return 'pos';
  return '';
}

function outcomeClass(token) {
  const neg = new Set(['sl', 'blown', 'blow', 'blows', 'blowing', 'stop', 'stops', 'stopped', 'gap', 'loss', 'losses', 'fail', 'fails', 'failed']);
  const pos = new Set(['tp', 'funded', 'target', 'targets', 'payout', 'payouts', 'win', 'wins', 'safe', 'pass', 'passes', 'passed']);
  const parts = String(token || '').toLowerCase().split('-');
  if (parts.some((part) => neg.has(part))) return 'neg';
  if (parts.some((part) => pos.has(part))) return 'pos';
  return '';
}

function paintOutcomes(root) {
  if (!root) return;
  const word = /[A-Za-z]+(?:-[A-Za-z]+)*/g;
  const nodes = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const parent = node.parentElement;
    if (!parent || parent.closest('code, .pos, .neg, .badge')) continue;
    const text = node.nodeValue;
    word.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0;
    let hit = false;
    let match;
    while ((match = word.exec(text))) {
      const cls = outcomeClass(match[0]);
      if (!cls) continue;
      hit = true;
      if (match.index > last) frag.append(document.createTextNode(text.slice(last, match.index)));
      frag.append(h('span', { class: cls, text: match[0] }));
      last = match.index + match[0].length;
    }
    if (!hit) continue;
    if (last < text.length) frag.append(document.createTextNode(text.slice(last)));
    parent.replaceChild(frag, node);
  }
}

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value == null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'text') el.textContent = value;
      else if (key === 'html') el.innerHTML = value;
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (value === true) el.setAttribute(key, '');
      else el.setAttribute(key, String(value));
    }
  }
  for (const kid of kids.flat(3)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

function int(v) { return v == null ? '—' : Math.round(v).toLocaleString('en-US'); }
function f1(v) { return v == null ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }); }
function f2(v) { return v == null ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function pct(v) { return v == null ? '—' : f1(v) + '%'; }
function signed(v, digits = 1) {
  if (v == null) return '—';
  const text = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return (v > 0 ? '+' : v < 0 ? '−' : '') + text;
}
function lotDigits() {
  const step = (state.instrument && state.instrument.step) || 0.01;
  return step >= 0.1 ? 1 : 2;
}
function lotText(v) {
  return v == null ? '—' : v.toLocaleString('en-US',
    { minimumFractionDigits: lotDigits(), maximumFractionDigits: lotDigits() });
}
function moneyCell(v) {
  return h('td', { class: 'num ' + (v == null ? '' : v > 0 ? 'pos' : v < 0 ? 'neg' : '') }, signed(v, 1));
}

function api(path, options) {
  return fetch(path, options).then(async (res) => {
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : {}; } catch (err) { data = { error: text }; }
    if (!res.ok) {
      const error = new Error((data && data.error) || ('HTTP ' + res.status));
      error.status = res.status;
      error.data = data;
      throw error;
    }
    return data;
  });
}

function postJson(path, payload) {
  return api(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
}

function withFile(path) {
  return path + (path.includes('?') ? '&' : '?') + 'file=' + encodeURIComponent(state.file);
}

let toastTimer = null;
function toast(message, kind) {
  const old = document.querySelector('.toast');
  if (old) old.remove();
  const el = h('div', { class: 'toast ' + (kind || ''), text: message });
  document.body.append(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), kind === 'err' ? 9000 : 4500);
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/* -------------------------------------------------------------- run helpers */

function skipsCashOpen() {
  return /^US100_/i.test(state.file || '');
}

function cashOpenChoices(session) {
  return session === 'rth' && skipsCashOpen() ? ['skip', 'keep'] : ['keep'];
}

function nyOpenChoices(session) {
  return session === 'ny' && skipsCashOpen() ? ['keep', 'skip'] : ['keep'];
}

function runId(cfg) {
  const base = `sl${cfg.sl}_tp${cfg.tp}_${cfg.session}_lv${cfg.lvl}_${cfg.typ}_${cfg.entry}_${cfg.look}_${cfg.tpd}`;
  if (cfg.open === 'keep' && cfg.session === 'rth' && skipsCashOpen()) return `${base}_keep`;
  if (cfg.nyopen === 'skip' && cfg.session === 'ny' && skipsCashOpen()) return `${base}_skip`;
  return base;
}

function nyOpenText(cfg) {
  if (cfg.session !== 'ny') return '—';
  return cfg.nyopen === 'skip' ? 'Skip' : 'Include';
}

function buildRows(runs) {
  const byId = new Map();
  for (const run of runs || []) byId.set(run.id, run);
  state.runs = byId;
  const rows = [];
  const byKey = {};
  for (const factor of FACTORS) byKey[factor.key] = factor.options.map((option) => option[0]);
  for (const sl of byKey.sl) for (const tp of byKey.tp) for (const session of byKey.session)
    for (const lvl of byKey.lvl) for (const typ of byKey.typ) for (const entry of byKey.entry)
      for (const look of byKey.look) for (const tpd of byKey.tpd)
        for (const open of cashOpenChoices(session))
          for (const nyopen of nyOpenChoices(session)) {
          const cfg = { sl, tp, session, open, nyopen, lvl, typ, entry, look, tpd };
          const id = runId(cfg);
          rows.push({ id, cfg, res: byId.get(id) || null, fav: state.favourites.has(id) });
        }
  return rows;
}

function totalTrades(res) {
  if (!res) return null;
  if (res.trades != null) return res.trades;
  let n = 0;
  for (const m of res.months || []) n += m.trades || 0;
  return n;
}

function runValue(res, key) {
  if (!res) return null;
  switch (key) {
    case 'trades': return totalTrades(res);
    case 'lot': return res.safe_lot;
    case 'gain_lo': return res.min_gain;
    case 'gain_hi': return res.max_gain;
    case 'gain_total': return res.total_gain;
    case 'gain_avg': return res.avg_gain;
    case 'ret_avg': return res.avg_return_pct;
    case 'rf_lo': return res.min_rf;
    case 'rf_hi': return res.max_rf != null ? res.max_rf : res.rf_at_min;
    case 'dd': return res.max_dd;
    case 'util': return res.max_util;
    case 'state': return res.safe_lot != null ? 2 : res.reason === 'ok' ? 3 : 1;
    default: return null;
  }
}

function sortValue(row, key) {
  if (key === 'id') return row.id;
  if (key === 'fav') return row.fav ? 1 : 0;
  if (FACTOR_KEYS.includes(key)) return row.cfg[key];
  return runValue(row.res, key);
}

function rowPasses(row, skipKey) {
  for (const f of FACTORS) {
    if (f.key === skipKey) continue;
    if (!state.filters[f.key].has(row.cfg[f.key])) return false;
  }
  if (state.search && !row.id.includes(state.search)) return false;
  if (state.favOnly && !state.favourites.has(row.id)) return false;
  if (state.hideUnrun && !row.res) return false;
  return true;
}

function filteredRows() {
  const rows = state.rows.filter(row => rowPasses(row));
  const key = state.sortKey;
  const dir = state.sortDir;
  const factorKey = FACTOR_KEYS.includes(key);
  rows.sort((a, b) => {
    const av = sortValue(a, key);
    const bv = sortValue(b, key);
    const aNull = av == null, bNull = bv == null;
    if (aNull && bNull) {
      if (!!a.res !== !!b.res) return a.res ? -1 : 1;
      return a.id.localeCompare(b.id);
    }
    if (aNull) return 1;
    if (bNull) return -1;
    let cmp;
    if (factorKey && !NUMERIC_FACTORS.has(key)) cmp = String(av).localeCompare(String(bv));
    else if (typeof av === 'string' || typeof bv === 'string') cmp = String(av).localeCompare(String(bv));
    else cmp = av - bv;
    if (cmp === 0) cmp = a.id.localeCompare(b.id);
    return cmp * dir;
  });
  return rows;
}

function counts() {
  let done = 0;
  for (const row of state.rows) if (row.res) done++;
  return { done, all: state.rows.length };
}

/* ------------------------------------------------------------------ filters */

function buildFilters() {
  const host = document.getElementById('filters');
  host.textContent = '';
  for (const factor of FACTORS) {
    const group = h('div', { class: 'fg', dataset: { factor: factor.key } },
      h('h4', null, factor.title, h('button', {
        type: 'button',
        title: 'Toggle every option',
        onclick: () => {
          const set = state.filters[factor.key];
          if (set.size === factor.options.length) set.clear();
          else for (const [v] of factor.options) set.add(v);
          renderAll();
        },
      }, 'all')),
    );
    for (const [value, label] of factor.options) {
      const input = h('input', {
        type: 'checkbox',
        checked: state.filters[factor.key].has(value),
        onchange: (event) => {
          const set = state.filters[factor.key];
          if (event.target.checked) set.add(value); else set.delete(value);
          renderAll();
        },
      });
      group.append(h('label', null, input, h('span', null, label), h('span', {
        class: 'count', dataset: { count: factor.key + ':' + value },
      }, '')));
    }
    host.append(group);
  }
  paintOutcomes(host);
}

function refreshFilterCounts() {
  const countsByKey = {};
  for (const factor of FACTORS) {
    for (const [value] of factor.options) countsByKey[factor.key + ':' + value] = 0;
  }
  for (const row of state.rows) {
    if (!row.res) continue;
    for (const factor of FACTORS) {
      if (rowPasses(row, factor.key)) countsByKey[factor.key + ':' + row.cfg[factor.key]]++;
    }
  }
  for (const node of document.querySelectorAll('[data-count]')) {
    const value = countsByKey[node.dataset.count] || 0;
    node.textContent = value ? nf.format(value) : '';
  }
}

/* -------------------------------------------------------------- summary cards */

function renderCards() {
  const host = document.getElementById('summaryCards');
  host.textContent = '';
  const rows = state.filtered.filter(r => r.res);
  const safe = rows.filter(r => r.res.safe_lot != null);
  const failed = rows.length - safe.length;
  const lots = safe.map(r => r.res.safe_lot);
  const gains = safe.map(r => r.res.total_gain).filter(v => v != null);
  const rfLow = safe.map(r => r.res.min_rf).filter(v => v != null);
  const rfHigh = safe.map(r => r.res.max_rf).filter(v => v != null);

  const card = (label, value, extra, cls) => h('div', { class: 'stat ' + (cls || '') },
    h('div', { class: 'k' }, label),
    h('div', { class: 'v' }, value, extra ? h('small', null, ' ' + extra) : null));

  host.append(
    card('Analysed', nf.format(rows.length), 'of ' + nf.format(state.rows.length)),
    card('Safe at min lot', nf.format(safe.length),
      rows.length ? Math.round((safe.length / rows.length) * 100) + '%' : '', 'good'),
    card('Fails at min lot', nf.format(failed), '', failed ? 'bad' : ''),
    card('Safe lot', lots.length ? lotText(median(lots)) : '—',
      lots.length ? 'median · ' + lotText(Math.min(...lots)) + '–' + lotText(Math.max(...lots)) : ''),
    card('Gain low', gains.length ? signed(Math.min(...gains), 1) : '—', gains.length ? 'total, worst run' : '',
      gains.length && Math.min(...gains) < 0 ? 'bad' : ''),
    card('Gain high', gains.length ? signed(Math.max(...gains), 1) : '—', gains.length ? 'total, best run' : '',
      gains.length && Math.max(...gains) > 0 ? 'good' : ''),
    card('Gain average', gains.length ? signed(gains.reduce((a, b) => a + b, 0) / gains.length, 1) : '—',
      gains.length ? 'mean of totals' : ''),
    card('RF range', rfLow.length ? f1(Math.min(...rfLow)) + ' – ' + f1(Math.max(...rfHigh)) : '—',
      rfLow.length ? 'monthly, at run lot' : ''),
  );
}

/* -------------------------------------------------------------------- table */

function factorCells(row) {
  return [
    h('td', { class: 'num' }, int(row.cfg.sl)),
    h('td', { class: 'num' }, int(row.cfg.tp)),
    h('td', null, LABELS.session[row.cfg.session]),
    h('td', { title: '09:30 New York bar' }, LABELS.open[row.cfg.open]),
    h('td', { title: '08:30 and 08:31 New York, New York session only' }, nyOpenText(row.cfg)),
    h('td', null, LABELS.lvl[row.cfg.lvl]),
    h('td', null, LABELS.typ[row.cfg.typ]),
    h('td', null, LABELS.entry[row.cfg.entry]),
    h('td', null, LABELS.look[row.cfg.look]),
    h('td', null, LABELS.tpd[row.cfg.tpd]),
  ];
}

function renderHead() {
  const head = document.getElementById('runsHead');
  head.textContent = '';
  for (const col of COLUMNS) {
    const sortKey = col.key;
    const active = state.sortKey === sortKey && col.sortable !== false;
    const th = h('th', {
      class: ((col.num ? 'num ' : '') + (col.sortable === false ? 'nosort ' : '') + headerTone(col.label)).trim(),
      title: col.title || (col.sortable === false ? null : 'Sort by ' + col.label),
      onclick: col.sortable === false ? null : () => {
        if (state.sortKey === sortKey) state.sortDir = -state.sortDir;
        else {
          state.sortKey = sortKey;
          state.sortDir = (FACTOR_KEYS.includes(sortKey) || sortKey === 'id') ? 1 : -1;
        }
        state.shown = 300;
        renderHead();
        renderBody();
      },
    }, col.label, active ? h('span', { class: 'arrow' }, state.sortDir > 0 ? '▲' : '▼') : null);
    head.append(th);
  }
}

function renderBody() {
  state.filtered = filteredRows();
  const body = document.getElementById('runsBody');
  body.textContent = '';
  const c = counts();
  document.getElementById('runCount').textContent =
    `${nf.format(state.filtered.length)} combinations · ${nf.format(c.done)} analysed · ${nf.format(c.all)} total`;
  const shown = state.filtered.slice(0, state.shown);
  const frag = document.createDocumentFragment();
  if (!c.done) {
    frag.append(h('tr', { class: 'note' }, h('td', {
      colspan: COLUMNS.length, class: 'muted', style: 'padding:22px;text-align:center',
    }, 'No results yet for this file. Press Run missing; the whole grid takes roughly 25–35 minutes.')));
  }
  for (const row of shown) {
    frag.append(rowElement(row));
    if (state.expanded === row.id) frag.append(detailElement(row));
  }
  body.append(frag);
  paintOutcomes(body);
  const more = document.getElementById('moreBtn');
  more.hidden = state.filtered.length <= state.shown;
  more.textContent = `Show 300 more (${nf.format(Math.min(300, state.filtered.length - shown.length))} left)`;
  document.getElementById('expandAll').hidden = !state.expanded;
  refreshFilterCounts();
  renderCards();
  if (document.getElementById('tab-factors').classList.contains('active')) renderFactors();
  if (document.getElementById('tab-about').classList.contains('active')) renderAbout();
}

function renderAll() {
  state.shown = 300;
  renderHead();
  renderBody();
}

function stateBadge(res) {
  if (!res) return h('span', { class: 'badge dim' }, 'not analysed');
  if (res.safe_lot != null) {
    return h('span', { class: 'badge ok', title: 'Safe in every month at ' + lotText(res.safe_lot) + ' lots' }, 'safe');
  }
  if (res.reason === 'no trades') return h('span', { class: 'badge none', title: 'No trades in the analysed months' }, 'no trades');
  if (res.reason === 'no data') return h('span', { class: 'badge none', title: 'The CSV has no bars in this year' }, 'no data');
  const when = res.fail_month ? ' · ' + res.fail_month : '';
  return h('span', {
    class: 'badge fail',
    title: 'Risk Factor reaches ' + f1(res.rf_at_min) + ' at the minimum lot' + when,
  }, 'RF fail');
}

function rowElement(row) {
  const res = row.res;
  const tr = h('tr', { class: 'row' + (res ? '' : ' unanalysed'), dataset: { id: row.id } });
  const star = h('button', {
    class: 'star' + (state.favourites.has(row.id) ? ' on' : ''),
    title: 'Favourite',
    type: 'button',
    onclick: (event) => { event.stopPropagation(); toggleFavourite(row); },
  }, state.favourites.has(row.id) ? '★' : '☆');
  tr.append(h('td', null, star));
  tr.append(h('td', { class: 'idcell', title: row.id }, row.id));
  tr.append(...factorCells(row));

  if (!res) {
    for (let i = 0; i < 11; i++) tr.append(h('td', { class: 'num faint' }, '—'));
    tr.append(h('td', null, stateBadge(null)));
    tr.addEventListener('click', () => toggleDetail(row.id));
    return tr;
  }

  tr.append(h('td', { class: 'num' }, int(totalTrades(res))));

  if (res.safe_lot != null) {
    tr.append(h('td', { class: 'num lotcell' }, lotText(res.safe_lot)));
    tr.append(moneyCell(res.min_gain));
    tr.append(moneyCell(res.max_gain));
    tr.append(moneyCell(res.total_gain));
    tr.append(moneyCell(res.avg_gain));
    tr.append(h('td', { class: 'num ' + (res.avg_return_pct > 0 ? 'pos' : res.avg_return_pct < 0 ? 'neg' : '') },
      pct(res.avg_return_pct)));
    tr.append(h('td', { class: 'num rfcell' }, f1(res.min_rf)));
    tr.append(h('td', { class: 'num rfcell' + (res.max_rf >= 5 ? ' hot' : '') }, f1(res.max_rf)));
    tr.append(h('td', { class: 'num' }, pct(res.max_dd)));
    tr.append(h('td', { class: 'num' }, pct(res.max_util)));
  } else {
    tr.append(h('td', { class: 'num lotcell fail', title: res.reason || '' }, 'fail'));
    for (let i = 0; i < 5; i++) tr.append(h('td', { class: 'num faint' }, '—'));
    tr.append(h('td', { class: 'num faint' }, '—'));
    tr.append(h('td', { class: 'num faint' }, '—'));
    tr.append(h('td', { class: 'num rfcell over', title: 'Highest monthly Risk Factor at the minimum lot' },
      f1(res.rf_at_min)));
    for (let i = 0; i < 2; i++) tr.append(h('td', { class: 'num faint' }, '—'));
  }
  tr.append(h('td', null, stateBadge(res)));
  tr.addEventListener('click', (event) => {
    if (event.target.closest('.star')) return;
    toggleDetail(row.id);
  });
  return tr;
}

function toggleDetail(id) {
  state.expanded = state.expanded === id ? null : id;
  renderBody();
  if (state.expanded) {
    const detail = document.querySelector(`tr.detail[data-id="${cssEscape(id)}"]`);
    if (detail) detail.scrollIntoView({ block: 'nearest' });
  }
}

function cssEscape(value) {
  return window.CSS && CSS.escape ? CSS.escape(value) : value.replace(/["\\]/g, '\\$&');
}

function kv(pairs) {
  return h('div', { class: 'kv' }, ...pairs.map(([k, v]) => h('div', null,
    h('div', { class: 'k' }, k), h('div', { class: 'v' }, v))));
}

function metricValue(value, kind) {
  if (value == null) return '—';
  if (kind === 'money') return signed(value, 1);
  if (kind === 'pct') return pct(value);
  if (kind === 'lot') return lotText(value);
  if (kind === 'rf') return f1(value);
  return String(value);
}

function monthTable(res) {
  const safe = res.safe_lot != null;
  const blank = (n) => Array.from({ length: n }, () => h('td', { class: 'num faint' }, '—'));
  const rows = (res.months || []).map((m) => {
    if (m.nodata) {
      return h('tr', null, h('td', null, m.month), h('td', { class: 'num muted' }, 'no data'),
        ...blank(safe ? 6 : 2));
    }
    if (!m.trades) {
      return h('tr', null, h('td', null, m.month), h('td', { class: 'num' }, '0'),
        ...blank(safe ? 6 : 2));
    }
    const failsMonth = m.lot_max == null;
    const rf = m.rf != null ? m.rf : (m.rf_max != null ? m.rf_max : m.rf_next);
    const rfStar = m.rf == null && m.rf_max == null && m.rf_next != null;
    const lotCell = h('td', { class: 'num' }, failsMonth ? h('span', { class: 'neg' }, 'fail') : lotText(m.lot_max));
    const rfCell = h('td', { class: 'num rfcell' + (rf != null && rf >= 5 ? ' hot' : '') },
      rf == null ? '—' : f1(rf) + (rfStar ? '*' : ''));
    if (!safe) {
      return h('tr', { title: failsMonth ? 'This month exceeds Risk Factor 5 even at the minimum lot' : null },
        h('td', null, m.month), h('td', { class: 'num' }, int(m.trades)), lotCell, rfCell);
    }
    return h('tr', { title: failsMonth ? 'This month would fail at the minimum lot' : null },
      h('td', null, m.month),
      h('td', { class: 'num' }, int(m.trades)),
      lotCell,
      rfCell,
      h('td', { class: 'num' }, pct(m.dd)),
      h('td', { class: 'num' }, pct(m.util)),
      h('td', { class: 'num ' + (m.gain == null ? '' : m.gain > 0 ? 'pos' : m.gain < 0 ? 'neg' : '') },
        signed(m.gain, 1)),
      h('td', { class: 'num' }, pct(m.return_pct)));
  });
  const head = safe
    ? h('tr', null,
      h('th', { title: 'Calendar month. The account starts fresh at the beginning of each month.' }, 'Month'),
      h('th', { class: 'num', title: 'Trades whose New York date falls in this month.' }, 'Trades'),
      h('th', { class: 'num', title: 'Largest lot whose Risk Factor stays under 5.5 for this month alone.' }, 'Lot safe in month'),
      h('th', { class: 'num', title: 'Risk Factor at the lot used for the whole year.' }, 'RF @ lot'),
      h('th', { class: 'num', title: 'Worst relative drawdown in the month: (peak equity − later low) / peak equity.' }, 'DD %'),
      h('th', { class: 'num', title: 'Worst deposit utilisation in the month: margin divided by equity.' }, 'Util %'),
      h('th', { class: 'num', title: 'Month profit in dollars at the year lot, after commission.' }, 'Gain $'),
      h('th', { class: 'num', title: 'Month profit as a percent of the starting balance.' }, 'Return %'))
    : h('tr', null,
      h('th', { title: 'Calendar month. The account starts fresh at the beginning of each month.' }, 'Month'),
      h('th', { class: 'num', title: 'Trades whose New York date falls in this month.' }, 'Trades'),
      h('th', { class: 'num', title: 'No lot passed. The minimum lot already exceeds Risk Factor 5.5.' }, 'Lot safe in month'),
      h('th', { class: 'num', title: 'Risk Factor at the broker minimum lot.' }, 'RF at min lot'));
  return h('table', { class: 'mini' }, h('thead', null, head), h('tbody', null, ...rows));
}

function detailElement(row) {
  const res = row.res;
  const tr = h('tr', { class: 'detail', dataset: { id: row.id } });
  const td = h('td', { colspan: COLUMNS.length });
  tr.append(td);
  if (!res) return tr;

  td.append(h('div', { class: 'detail-head' },
    h('span', { class: 'id' }, row.id),
    h('span', { class: 'f' }, `${row.cfg.sl} / ${row.cfg.tp} points · ${LABELS.session[row.cfg.session]} · ` +
      `${LABELS.open[row.cfg.open]} · ${LABELS.lvl[row.cfg.lvl]} levels · ${LABELS.typ[row.cfg.typ]} · ${LABELS.entry[row.cfg.entry]} · ` +
      `${LABELS.look[row.cfg.look]} · ${LABELS.tpd[row.cfg.tpd]}`),
    h('span', { class: 'spacer' }),
    stateBadge(res)));

  if (res.safe_lot != null) {
    td.append(kv([
      ['Safe lot', lotText(res.safe_lot)],
      ['Trades', int(totalTrades(res))],
      ['Months used', int(res.months_used)],
      ['Gain low', metricValue(res.min_gain, 'money')],
      ['Gain high', metricValue(res.max_gain, 'money')],
      ['Gain total', metricValue(res.total_gain, 'money')],
      ['Gain average', metricValue(res.avg_gain, 'money')],
      ['Average return', metricValue(res.avg_return_pct, 'pct')],
      ['RF low', metricValue(res.min_rf, 'rf')],
      ['RF high', metricValue(res.max_rf, 'rf')],
      ['Max drawdown', metricValue(res.max_dd, 'pct')],
      ['Max utilisation', metricValue(res.max_util, 'pct')],
      ['Best month', res.best_month || '—'],
      ['Worst month', res.worst_month || '—'],
    ]));
    td.append(h('div', { class: 'subhead' }, 'Month by month'));
    td.append(monthTable(res));
    td.append(h('p', { class: 'muted', style: 'margin:6px 0 12px;font-size:10.5px' },
      `RF, drawdown, utilisation, gain and return are at the run lot ${lotText(res.safe_lot)}. ` +
      '“Lot safe in month” is the largest lot that month allows on its own; the run is limited by the lowest of them.'));
  } else {
    const failText = res.reason === 'no trades'
      ? 'This combination takes no trades in the analysed months.'
      : res.reason === 'no data'
        ? 'The CSV has no bars in the analysed year.'
        : `Risk Factor reaches ${f1(res.rf_at_min)} at the broker minimum lot` +
          (res.fail_month ? ` in ${res.fail_month}` : '') + ', so there is no tradeable lot.';
    td.append(h('div', { class: 'notice' }, failText));
    td.append(h('div', { class: 'subhead' }, 'Month by month'));
    td.append(monthTable(res));
    td.append(h('p', { class: 'muted', style: 'margin:6px 0 12px;font-size:10.5px' },
      '* Risk Factor at the minimum lot. Months marked “fail” are over 5 even at the smallest volume. '));
  }

  const cfgLine = h('div', { class: 'muted', style: 'font-size:10.5px' },
    `Broker model: ${state.instrument.name} · min lot ${lotText(state.instrument.min_lot)} · step ${lotText(state.instrument.step)} · ` +
    `$${f2(state.instrument.usd_per_point)} per point per lot · $${f2(state.instrument.commission)} commission per lot per trade · ` +
    `margin ${MARGIN_LABELS[state.instrument.symbol] || state.instrument.margin_rate}`);
  td.append(cfgLine);

  return tr;
}

/* ------------------------------------------------------------------ factors */

function renderFactors() {
  const host = document.getElementById('factorTables');
  host.textContent = '';
  const analysed = state.filtered.filter(r => r.res);
  const safe = analysed.filter(r => r.res.safe_lot != null);
  if (!safe.length) {
    host.append(h('div', { class: 'empty' }, h('b', null, 'No safe runs pass the filters. '),
      'Run the analysis or widen the filters; only runs safe at the minimum lot are counted here.'));
    return;
  }
  document.getElementById('factorIntro').textContent =
    `Measured on the ${nf.format(safe.length)} safe runs that pass the filters ` +
    `(of ${nf.format(analysed.length)} analysed). Median lot is the largest lot each run can trade; ` +
    'median gain is the sum of its monthly gains at that lot.';

  for (const factor of FACTORS) {
    const stats = factor.options.map(([value, label]) => {
      const pool = analysed.filter(r => r.cfg[factor.key] === value);
      const rows = safe.filter(r => r.cfg[factor.key] === value);
      if (!rows.length) return { value, label, runs: 0, pool: pool.length };
      const lots = rows.map(r => r.res.safe_lot);
      const totals = rows.map(r => r.res.total_gain);
      const rfs = rows.map(r => r.res.max_rf);
      return {
        value, label,
        runs: rows.length,
        pool: pool.length,
        lot: median(lots),
        total: median(totals),
        mean: totals.reduce((a, b) => a + b, 0) / totals.length,
        rf: median(rfs),
        best: Math.max(...totals),
      };
    });
    let maxAbs = 0;
    for (const s of stats) if (s.runs) maxAbs = Math.max(maxAbs, Math.abs(s.total));
    let bestTotal = -Infinity;
    for (const s of stats) if (s.runs && s.total > bestTotal) bestTotal = s.total;

    const body = h('tbody', null, ...stats.map((s) => h('tr', {
      class: s.runs && s.total === bestTotal ? 'best' : '',
    },
      h('td', null, s.label),
      h('td', { class: 'num' }, s.runs ? nf.format(s.runs) : '—'),
      h('td', { class: 'num' }, s.runs ? Math.round((s.runs / Math.max(1, s.pool)) * 100) + '%' : '—'),
      h('td', { class: 'num' }, s.runs ? lotText(s.lot) : '—'),
      h('td', { class: 'num ' + (s.runs ? (s.total > 0 ? 'pos' : s.total < 0 ? 'neg' : '') : '') },
        s.runs ? signed(s.total, 1) : '—'),
      h('td', { class: 'num ' + (s.runs ? (s.mean > 0 ? 'pos' : s.mean < 0 ? 'neg' : '') : '') },
        s.runs ? signed(s.mean, 1) : '—'),
      h('td', { class: 'num' }, s.runs ? f1(s.rf) : '—'),
      h('td', null, s.runs
        ? h('span', { class: 'meter ' + (s.total > 0 ? 'pos' : 'neg') },
          h('i', { style: `width:${maxAbs ? (Math.abs(s.total) / maxAbs) * 100 : 0}%` }))
        : ''),
    )));
    const head = h('thead', null, h('tr', null,
      h('th', { title: 'One option of this factor. The other factors still vary inside the row.' }, 'Option'),
      h('th', { class: 'num', title: 'Runs with this option that have a lot safe for every month.' }, 'Safe'),
      h('th', { class: 'num', title: 'Safe runs divided by the runs with this option that were analysed.' }, 'Safe %'),
      h('th', { class: 'num', title: 'Median of the year-safe lots.' }, 'Median lot'),
      h('th', { class: 'num', title: 'Median of the total dollar gain at the year-safe lot.' }, 'Median gain'),
      h('th', { class: 'num', title: 'Average of the total dollar gain at the year-safe lot.' }, 'Mean gain'),
      h('th', { class: 'num', title: 'Median of each run’s highest monthly Risk Factor at its year-safe lot.' }, 'Median max RF'),
      h('th', { title: 'The median gain drawn as a bar.' }, 'Median gain')));
    host.append(h('div', { class: 'factorCard' },
      h('h3', null, factor.title, h('span', null, `${factor.options.length} options`)),
      h('table', null, head, body)));
  }
}

/* -------------------------------------------------------------------- about */

function renderAbout() {
  const host = document.getElementById('aboutBody');
  host.textContent = '';
  const inst = state.instrument || {};
  const specRows = Object.entries(state.specs || {}).map(([symbol, spec]) => h('tr', null,
    h('td', null, spec.name || symbol),
    h('td', { class: 'num' }, lotTextFor(spec, spec.min_lot)),
    h('td', { class: 'num' }, lotTextFor(spec, spec.step)),
    h('td', { class: 'num' }, '$' + f2(spec.usd_per_point)),
    h('td', { class: 'num' }, '$' + f2(spec.commission)),
    h('td', null, MARGIN_LABELS[symbol] || String(spec.margin_rate)),
  ));

  host.append(h('div', { class: 'card' },
    h('h2', null, 'What the page measures'),
    h('p', null, 'Every strategy run is replayed month by month on a fresh ' +
      `$${nf.format(state.config.balance)} account, at every lot from the broker minimum upwards. ` +
      'For each minute of each month the account is marked to the market and the LiteFinance Risk Factor is scored. ' +
      'The largest lot whose Risk Factor stays below 5.5 in every month is the run’s tradeable lot.'),
    h('div', { class: 'formula' },
      'RF = 0.5 × drawdown points + 0.3 × utilisation points + 0.1 × leverage points + 0.1 × lifespan points'),
    h('p', null, 'Leverage is 400 → 10 points and account lifespan is 0 → 10 points, so those two terms contribute a fixed 2.0. ' +
      'The score is rounded to the nearest whole number: 5.4 passes, 5.5 and above fails.'),
    h('h3', null, 'Bands'),
    h('table', null,
      h('thead', null, h('tr', null,
        h('th', { title: 'Relative drawdown or deposit utilisation. Both use this point scale.' }, 'Drawdown % / utilisation %'),
        h('th', { class: 'num', title: 'Points added for a reading in this band. Drawdown is weighted 0.5 and utilisation 0.3.' }, 'Points'))),
      h('tbody', null,
        [['≥ 50', 10], ['40 – 50', 9], ['35 – 40', 8], ['30 – 35', 7], ['25 – 30', 6],
          ['20 – 25', 5], ['15 – 20', 4], ['10 – 15', 3], ['5 – 10', 2], ['< 5', 1]]
          .map(([band, pts]) => h('tr', null, h('td', null, band), h('td', { class: 'num' }, pts))))),
  ));

  host.append(h('div', { class: 'card' },
    h('h2', null, 'Broker model'),
    h('p', null, 'Taken from the Symbols sheet of Riskfactor.xlsx. Point values, margins and commissions are per 1.0 lot; ' +
      'commission is charged once per trade (round turn) when the position opens.'),
    h('table', null,
      h('thead', null, h('tr', null,
        h('th', { title: 'Broker symbol.' }, 'Symbol'),
        h('th', { class: 'num', title: 'Smallest lot the search may use.' }, 'Min lot'),
        h('th', { class: 'num', title: 'Lot increment.' }, 'Step'),
        h('th', { class: 'num', title: 'Dollars gained or lost per strategy point, per 1.0 lot.' }, '$ / point / lot'),
        h('th', { class: 'num', title: 'Round-turn commission per 1.0 lot, charged once when the position opens.' }, 'Commission / lot'),
        h('th', { title: 'Margin reserved per 1.0 lot.' }, 'Margin per lot'))),
      h('tbody', null, ...specRows)),
    h('p', { class: 'muted', style: 'margin-top:8px' },
      `Commission is added to the P&L, so a trade pays it before any profit counts. ` +
      `The selected file is ${inst.name || inst.symbol || 'unknown'}.`),
  ));

  host.append(h('div', { class: 'card' },
    h('h2', null, 'How a run is scored'),
    h('ul', null,
      h('li', null, 'Only 2026 is used, one calendar month at a time, grouped by New York trade date.'),
      h('li', null, 'Each month starts with a fresh account at the chosen balance; nothing carries over.'),
      h('li', null, 'The run’s own trades are opened at the lot under test; open positions are marked at each 1-minute close.'),
      h('li', null, 'Equity is sampled at the beginning of every 1-minute candle, not hourly.'),
      h('li', null, 'Relative drawdown is measured from the running equity peak: (peak − low) / peak. ' +
        'Utilisation is margin / equity.'),
      h('li', null, 'Lots are searched upwards in broker steps for each month; a month that fails at the minimum lot ends the search for that run.'),
      h('li', null, 'The run lot is the lowest monthly maximum, so the same lot is safe for the whole year. ' +
        'Gains are reported at that lot.'),
      h('li', null, 'A run with no trades, or a month where even the minimum lot fails, has no tradeable lot.'),
    ),
  ));

  host.append(h('div', { class: 'card' },
    h('h2', null, 'Assumptions and limits'),
    h('ul', null,
      h('li', null, 'Every open position consumes margin at its full notional rate; hedged positions are not netted.'),
      h('li', null, 'Margin, commission and point value use the LiteFinance numbers in the workbook, not the CSV.'),
      h('li', null, 'Intrabar equity is not sampled, so a spike between two 1-minute closes is not seen.'),
      h('li', null, 'The strategy engine does not charge the spread to short entries; the risk model mirrors that, ' +
        'and the CSV spread column is ignored (the engine uses its fixed 1.3-point spread).'),
      h('li', null, 'Leverage 400 and lifespan 0 are fixed by the analysis brief.'),
      h('li', null, 'Results are written under analysis/risk-factor/results/<csv-stem>/ and never touch the strategy results.'),
    ),
    h('p', { class: 'muted' },
      'Press Run missing to fill gaps, or Re-run all after changing the maximum lot, balance or year. ' +
      'Changing a parameter makes the old results obsolete and the next run replaces them.'),
  ));
}

function lotTextFor(spec, value) {
  const step = (spec && spec.step) || 0.01;
  const digits = step >= 0.1 ? 1 : 2;
  return value == null ? '—' : Number(value).toFixed(digits);
}

/* --------------------------------------------------------------- favourites */

function favStorageKey() {
  return 'nq-risk-favourites-v1|' + state.file;
}

function applyFavourite(id, on) {
  if (on) state.favourites.add(id); else state.favourites.delete(id);
  for (const row of state.rows) if (row.id === id) row.fav = on;
  try { localStorage.setItem(favStorageKey(), JSON.stringify([...state.favourites])); } catch (err) { /* private mode */ }
  postJson('/api/risk/favourites', { id, favourite: on, file: state.file }).catch(() => {});
  toast((on ? 'Added to favourites' : 'Removed from favourites') + ` · ${state.favourites.size} saved`, 'ok');
}

function toggleFavourite(row) {
  applyFavourite(row.id, !state.favourites.has(row.id));
  if (state.favOnly) renderBody();
  else {
    const tr = document.querySelector(`tr.row[data-id="${cssEscape(row.id)}"]`);
    if (tr) {
      const button = tr.querySelector('.star');
      button.classList.toggle('on', state.favourites.has(row.id));
      button.textContent = state.favourites.has(row.id) ? '★' : '☆';
    }
  }
}

/* ------------------------------------------------------------------ actions */

function readParams() {
  const maxLot = Number(document.getElementById('maxLotInput').value);
  const balance = Number(document.getElementById('balanceInput').value);
  const year = Number(document.getElementById('yearInput').value);
  if (!(maxLot >= 0.01) || maxLot > 10000) { toast('Max lot must be between 0.01 and 10,000', 'err'); return null; }
  if (!(balance >= 100) || balance > 100000000) { toast('Balance must be between 100 and 100,000,000', 'err'); return null; }
  if (!Number.isInteger(year) || year < 2000 || year > 2100) { toast('Year must be between 2000 and 2100', 'err'); return null; }
  state.config = { maxLot, balance, year };
  try { localStorage.setItem(PARAMS_KEY, JSON.stringify(state.config)); } catch (err) { /* private mode */ }
  return state.config;
}

function paramsMismatch() {
  const params = state.meta && state.meta.sig && state.meta.sig.params;
  if (!params) return false;
  const c = state.config;
  return Number(params.max_lot) !== Number(c.maxLot) ||
    Number(params.balance) !== Number(c.balance) ||
    Number(params.year) !== Number(c.year);
}

function workerCount() {
  const input = document.getElementById('workersInput');
  const n = Math.trunc(Number(input.value));
  const workers = Math.min(4, Math.max(1, Number.isFinite(n) ? n : 2));
  input.value = String(workers);
  try { localStorage.setItem('nq-split-workers', String(workers)); } catch (err) { /* private mode */ }
  return workers;
}

async function startRun(ids, force, all) {
  const params = readParams();
  if (!params) return;
  const body = {
    file: state.file,
    force: !!force,
    max_lot: params.maxLot,
    balance: params.balance,
    year: params.year,
    workers: workerCount(),
  };
  if (all) body.all = true;
  else body.ids = ids;
  try {
    const res = await postJson('/api/risk/run', body);
    toast(`Started ${res.label || 'risk run'}`, 'ok');
    pollStatus(true);
  } catch (err) {
    toast(err.message, 'err');
  }
}

function runMissing() {
  if (paramsMismatch()) {
    toast('The stored results were built with different max lot, balance or year. Press Re-run all.', 'err');
    return;
  }
  const ids = state.rows.filter(r => !r.res).map(r => r.id);
  if (!ids.length) { toast('Every combination is already analysed', 'ok'); return; }
  if (!confirm(`Analyse ${nf.format(ids.length)} combinations that are not in risk.json yet?`)) return;
  startRun(ids, false, false);
}

function runFiltered() {
  const ids = state.filtered.map(r => r.id);
  if (!ids.length) { toast('No combinations pass the filters', 'err'); return; }
  if (paramsMismatch()) {
    toast('The stored results were built with different max lot, balance or year. Press Re-run all.', 'err');
    return;
  }
  if (!confirm(`Analyse ${nf.format(ids.length)} combinations that pass the filters? Finished ones are skipped.`)) return;
  startRun(ids, false, false);
}

function exportCsv() {
  const cols = ['run', 'analysed', 'safe', 'sl', 'tp', 'session', 'lvl', 'type', 'entry', 'look', 'tpd',
    'safe_lot', 'trades', 'gain_low', 'gain_high', 'gain_total', 'gain_avg', 'return_avg_pct',
    'rf_low', 'rf_high', 'max_dd_pct', 'max_util_pct', 'best_month', 'worst_month', 'reason'];
  const lines = [cols.join(',')];
  const esc = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v));
  for (const row of state.filtered) {
    const r = row.res;
    const c = row.cfg;
    lines.push([
      row.id, r ? 1 : 0, r && r.safe_lot != null ? 1 : 0,
      c.sl, c.tp, c.session, c.lvl, c.typ, c.entry, c.look, c.tpd,
      r ? r.safe_lot : '', r ? totalTrades(r) : '',
      r ? r.min_gain : '', r ? r.max_gain : '', r ? r.total_gain : '', r ? r.avg_gain : '',
      r ? r.avg_return_pct : '', r ? (r.min_rf != null ? r.min_rf : r.rf_at_min) : '', r ? r.max_rf : '',
      r ? r.max_dd : '', r ? r.max_util : '', r ? r.best_month : '', r ? r.worst_month : '',
      r ? r.reason : 'not analysed',
    ].map(esc).join(','));
  }
  const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${state.file.replace(/\.csv$/i, '')}-risk.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`${nf.format(state.filtered.length)} rows exported`, 'ok');
}

/* ------------------------------------------------------------------- status */

function formatEta(seconds) {
  seconds = Math.max(0, Math.round(seconds));
  if (seconds < 90) return seconds + 's';
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return minutes + ' min';
  return (minutes / 60).toFixed(1) + ' h';
}

function setStatus(status) {
  state.status = status;
  const dot = document.getElementById('statusDot');
  const text = document.getElementById('statusText');
  const wrap = document.getElementById('statusBarWrap');
  const bar = document.getElementById('statusBar');
  const progress = status.progress || {};
  const job = status.job;
  const c = counts();

  if (status.running && job) {
    dot.className = 'dot busy';
    const done = progress.done || 0;
    const total = progress.total || job.total || 0;
    const percent = total ? Math.round((done / total) * 100) : 0;
    const eta = progress.eta_seconds;
    text.textContent = `analysing ${nf.format(done)}/${nf.format(total)} (${percent}%)` +
      (eta == null ? '' : ` · ${formatEta(eta)} left`);
    wrap.hidden = false;
    bar.style.width = percent + '%';
  } else if (progress.error) {
    dot.className = 'dot err';
    const last = String(progress.error).trim().split('\n').slice(-1)[0];
    text.textContent = 'last run failed: ' + last.slice(0, 90);
    wrap.hidden = true;
  } else {
    dot.className = 'dot ok';
    text.textContent = `idle · ${nf.format(c.done)} of ${nf.format(c.all)} analysed`;
    wrap.hidden = true;
  }

  const busy = !!status.running;
  for (const id of ['runMissingBtn', 'runAllBtn', 'runShownBtn', 'refreshBtn', 'fileSelect']) {
    document.getElementById(id).disabled = busy;
  }
  for (const id of ['maxLotInput', 'balanceInput', 'yearInput']) {
    document.getElementById(id).disabled = busy;
  }
}

async function pollStatus(force) {
  clearTimeout(state.pollTimer);
  try {
    const status = await api(withFile('/api/risk/status'));
    const wasRunning = state.wasRunning;
    state.wasRunning = !!status.running;
    setStatus(status);
    if (wasRunning && !status.running) {
      const failed = status.progress && status.progress.error;
      if (failed) toast('The run failed:\n' + String(failed).trim().split('\n').slice(-3).join('\n'), 'err');
      else toast('Run finished · results reloaded', 'ok');
      await loadResults();
      setStatus(status);
    }
    const delayed = status.running ? 2000 : (force ? 1200 : 12000);
    state.pollTimer = setTimeout(pollStatus, delayed);
  } catch (err) {
    state.pollTimer = setTimeout(pollStatus, 6000);
  }
}

/* -------------------------------------------------------------------- load */

function applyBrand() {
  const inst = state.instrument || {};
  const name = inst.name || 'US100 (Nasdaq)';
  const symbol = inst.symbol || 'US100';
  document.querySelector('.brand h1').childNodes[0].textContent = name + ' · risk factor ';
  document.querySelector('.brand .mark').textContent =
    ({ US100: 'NQ', GBPUSD: 'GP', XAUUSD: 'AU' })[symbol] || symbol.slice(0, 2).toUpperCase();
  document.title = name + ' · risk factor';
}

function renderFileSelect(files) {
  const sel = document.getElementById('fileSelect');
  if (!sel || !files.length) return;
  sel.textContent = '';
  for (const f of files) {
    const label = `${f.instrument.name} · ${f.name.replace(/\.csv$/i, '')}` +
      (f.supported ? '' : ' (no broker spec)') + (f.computed ? '' : ' (not analysed)');
    sel.append(h('option', { value: f.name, disabled: !f.supported, title: f.name }, label));
  }
  sel.value = state.file;
}

async function onFileChange(name) {
  state.file = name;
  try { localStorage.setItem(FILE_KEY, name); } catch (err) { /* private mode */ }
  state.expanded = null;
  await loadFavourites();
  await loadResults();
  await pollStatus(true);
}

function findFile(name) {
  return state.files.find(f => f.name === name) || null;
}

function renderNotes() {
  const host = document.getElementById('staleNote');
  host.textContent = '';
  if (state.stale) {
    host.append(h('div', { class: 'notice' },
      'The CSV in data/ is newer than risk.json. Use Run missing to bring the results up to date.'));
  }
  if (paramsMismatch()) {
    const p = state.meta.sig.params;
    host.append(h('div', { class: 'notice' },
      `The stored results were built with max lot ${p.max_lot}, balance $${nf.format(p.balance)} and ${p.year}. ` +
      `Run again with the current inputs (max lot ${state.config.maxLot}, balance $${nf.format(state.config.balance)}, ${state.config.year}) ` +
      'to replace them; Run missing would keep the old parameter set.'));
  }
}

async function loadResults() {
  const data = await api(withFile('/api/risk/results'));
  state.meta = data.meta || null;
  state.stale = !!data.stale;
  state.instrument = data.instrument || {};
  state.specs = data.specs || state.specs;
  state.files = data.files || state.files;
  applyBrand();
  renderFileSelect(state.files);
  const meta = state.meta;
  const params = meta && meta.sig && meta.sig.params;
  const months = (meta && meta.months) || [];
  const info = meta && meta.sig
    ? `${meta.sig.file} · ${params ? params.year : ''} · ${months.length} months` +
      (params ? ` · max lot ${params.max_lot} · balance $${nf.format(params.balance)}` : '') +
      ` · ${nf.format((data.runs || []).length)} analysed · built ${new Date(meta.built * 1000).toLocaleString()}`
    : `No risk.json yet for ${state.file} — press Run missing to analyse it.`;
  document.getElementById('dataInfo').textContent = info;
  renderNotes();
  state.expanded = null;
  state.rows = buildRows(data.runs || []);
  renderBody();
  if (document.getElementById('tab-factors').classList.contains('active')) renderFactors();
  if (document.getElementById('tab-about').classList.contains('active')) renderAbout();
}

async function loadFavourites() {
  try {
    const data = await api(withFile('/api/risk/favourites'));
    state.favourites = new Set(data.ids || []);
  } catch (err) {
    try {
      state.favourites = new Set(JSON.parse(localStorage.getItem(favStorageKey()) || '[]'));
    } catch (e) {
      state.favourites = new Set();
    }
  }
  for (const row of state.rows) row.fav = state.favourites.has(row.id);
}

/* -------------------------------------------------------------------- tabs */

function selectTab(name) {
  for (const tab of document.querySelectorAll('.tab')) tab.classList.toggle('active', tab.dataset.tab === name);
  for (const pane of document.querySelectorAll('.tabpane')) pane.classList.toggle('active', pane.id === 'tab-' + name);
  if (name === 'factors') renderFactors();
  if (name === 'about') renderAbout();
}

/* -------------------------------------------------------------------- init */

const FONT_STEPS = [0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
const FONT_KEY = 'nq-risk-font-scale-v1';
const FILE_KEY = 'nq-risk-file-v1';
const PARAMS_KEY = 'nq-risk-params-v1';

function applyFontScale(scale, save) {
  const s = Math.min(2, Math.max(0.9, Number(scale) || 1));
  state.fontScale = s;
  document.body.style.zoom = s === 1 ? '' : String(s);
  document.getElementById('fontLabel').textContent = Math.round(s * 100) + '%';
  if (save) {
    try { localStorage.setItem(FONT_KEY, String(s)); } catch (err) { /* private mode */ }
  }
  requestAnimationFrame(() => { if (state.rows.length) renderBody(); });
}

function stepFont(dir) {
  const cur = state.fontScale || 1;
  let i = FONT_STEPS.findIndex(s => Math.abs(s - cur) < 0.001);
  if (i < 0) i = FONT_STEPS.indexOf(1);
  applyFontScale(FONT_STEPS[Math.max(0, Math.min(FONT_STEPS.length - 1, i + dir))], true);
}

function init() {
  buildFilters();
  renderHead();
  let savedFont = 1;
  try { savedFont = parseFloat(localStorage.getItem(FONT_KEY)) || 1; } catch (err) { /* private mode */ }
  applyFontScale(savedFont, false);

  try {
    const saved = JSON.parse(localStorage.getItem(PARAMS_KEY) || 'null');
    if (saved && saved.maxLot > 0) {
      state.config = saved;
      document.getElementById('maxLotInput').value = saved.maxLot;
      document.getElementById('balanceInput').value = saved.balance;
      document.getElementById('yearInput').value = saved.year;
    }
  } catch (err) { /* private mode */ }

  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => selectTab(tab.dataset.tab));
  }

  document.getElementById('search').addEventListener('input', (event) => {
    state.search = event.target.value.trim().toLowerCase();
    state.shown = 300;
    renderBody();
  });
  document.getElementById('favOnly').addEventListener('change', (event) => {
    state.favOnly = event.target.checked;
    state.shown = 300;
    renderBody();
  });
  document.getElementById('hideUnrun').addEventListener('change', (event) => {
    state.hideUnrun = event.target.checked;
    state.shown = 300;
    renderBody();
  });
  document.getElementById('clearFilters').addEventListener('click', () => {
    for (const f of FACTORS) state.filters[f.key] = new Set(f.options.map(o => o[0]));
    state.search = '';
    state.favOnly = false;
    state.hideUnrun = false;
    document.getElementById('search').value = '';
    document.getElementById('favOnly').checked = false;
    document.getElementById('hideUnrun').checked = false;
    state.shown = 300;
    buildFilters();
    renderBody();
  });
  document.getElementById('moreBtn').addEventListener('click', () => {
    state.shown += 300;
    renderBody();
  });
  document.getElementById('expandAll').addEventListener('click', () => {
    state.expanded = null;
    renderBody();
  });
  document.getElementById('exportBtn').addEventListener('click', exportCsv);

  for (const [id, dir] of [['fontMinus', -1], ['fontPlus', 1]]) {
    document.getElementById(id).addEventListener('click', () => stepFont(dir));
  }
  document.getElementById('fontLabel').addEventListener('click', () => applyFontScale(1, true));

  for (const id of ['maxLotInput', 'balanceInput', 'yearInput']) {
    document.getElementById(id).addEventListener('change', () => {
      readParams();
      renderNotes();
    });
  }

  document.getElementById('runMissingBtn').addEventListener('click', runMissing);
  document.getElementById('runAllBtn').addEventListener('click', () => {
    const total = state.rows.length.toLocaleString('en-US');
    if (confirm(`Recompute every one of the ${total} combinations from scratch? This overwrites risk.json. The new Include 09:30 rows are included.`)) {
      startRun(null, true, true);
    }
  });
  document.getElementById('runShownBtn').addEventListener('click', runFiltered);
  document.getElementById('refreshBtn').addEventListener('click', () => {
    loadResults().then(() => pollStatus(true)).catch((err) => toast(err.message, 'err'));
  });

  try { state.file = localStorage.getItem(FILE_KEY) || ''; } catch (err) { state.file = ''; }
  try {
    const savedWorkers = Number(localStorage.getItem('nq-split-workers'));
    if (savedWorkers >= 1 && savedWorkers <= 4) document.getElementById('workersInput').value = String(savedWorkers);
  } catch (err) { /* private mode */ }
  document.getElementById('fileSelect').addEventListener('change', (event) => {
    if (event.target.value && event.target.value !== state.file) onFileChange(event.target.value);
  });

  api('/api/risk/files').then((fl) => {
    state.files = (fl && fl.files) || [];
    state.specs = (fl && fl.specs) || {};
    const chosen = state.files.find(f => f.name === state.file && f.supported) ||
      state.files.find(f => f.default && f.supported) ||
      state.files.find(f => f.supported) || state.files[0];
    if (chosen) state.file = chosen.name;
    return loadFavourites();
  }).then(() => {
    loadResults().then(() => pollStatus(true)).catch((err) => toast('Could not load risk.json: ' + err.message, 'err'));
  }).catch((err) => toast('Could not list data files: ' + err.message, 'err'));
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
