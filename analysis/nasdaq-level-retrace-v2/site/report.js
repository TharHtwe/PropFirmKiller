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

const DECISIONS = {
  taken: 'taken',
  session: 'outside the trading session',
  open_min: 'no entry in the first minute of the cash open',
  ny_open: 'no entry from 08:30 to 08:32 New York',
  look: 'level older than the lookback',
  type: 'crossing is the other trade type',
  flat: 'close finished exactly on the level',
  body: 'candle did not close through the level',
  level: 'level already traded today',
  open: 'a trade is still open',
  one: 'one trade a day already taken',
  cap: 'day target already reached',
};

const COLUMNS = [
  { key: 'fav', label: '', sortable: false, title: 'Star a run on this page. The star is stored with this CSV.' },
  { key: 'id', label: 'Run', title: 'The combination id. Click the row for the full statistics.' },
  { key: 'sl', label: 'SL', num: true, title: 'Stop distance in points.' },
  { key: 'tp', label: 'TP', num: true, title: 'Target distance in points, measured from the fill.' },
  { key: 'session', label: 'Session', title: 'London 08:00–16:30 London, New York 08:00–17:00 New York, RTH 09:30–16:00 New York, or All for London or New York.' },
  { key: 'open', label: '09:30', title: 'RTH only. Skip drops the 09:30 New York bar. Include keeps it. On US100 the stored RTH id skips it; the id ending in _keep includes it. Other sessions show a dash.' },
  { key: 'nyopen', label: '08:30', title: 'New York session only. Skip drops the 08:30 and 08:31 New York bars and keeps 08:32. The stored id includes them; the id ending in _skip drops them. Other sessions show a dash.' },
  { key: 'lvl', label: 'Levels', title: 'Which completed candles may supply a level: all hours, ETH, or RTH.' },
  { key: 'typ', label: 'Type', title: 'Reversal fades the level. Continuation trades the break.' },
  { key: 'entry', label: 'Entry', title: 'Touch fills from the level. A 1-minute close fills at the close, and a buy adds the 1.3 spread. The stop and target are measured from the fill.' },
  { key: 'look', label: 'Look', title: 'How far back a level may come from: 1 month, 6 months, 1 year, or all history. The window is calendar days.' },
  { key: 'tpd', label: 'Per day', title: 'Every level, one trade at a time, one trade a day, or stop for the day once the target points are reached.' },
  { key: 'trades', label: 'Trades', num: true, title: 'Trades taken.' },
  { key: 'win_rate', label: 'Win %', num: true, title: 'Percent of trades with points above zero. A result of exactly zero counts as a loss.' },
  { key: 'net_points', label: 'Net', num: true, title: 'Sum of trade points. A buy’s fill includes the 1.3 spread, and a full target still pays the target points from that fill.' },
  { key: 'profit_factor', label: 'PF', num: true, title: 'Gross winning points divided by the absolute gross of the losing points. Zero results are left out.' },
  { key: 'expectancy', label: 'Exp', num: true, title: 'Average points per trade.' },
  { key: 'max_drawdown', label: 'Max DD', num: true, title: 'Deepest drop of the point equity from a prior peak, in points.' },
  { key: 'payoff', label: 'Payoff', num: true, title: 'Average winning trade divided by the absolute average of every non-winning trade, zeros included.' },
  { key: 'hold', label: 'Hold', num: true, title: 'Average one-minute bars from entry to exit.' },
  { key: 'retrace', label: 'Retrace', num: true, title: 'Average points a winning trade moved back toward the stop before it reached the target.' },
  { key: 'equity', label: 'Equity', sortKey: 'net_points', spark: true, title: 'Cumulative point equity in trade order. Sorting this column uses the net.' },
  { key: 'actions', label: '', sortable: false, title: 'Run this combination, recompute it, or open the audit day.' },
];

const state = {
  summary: null,
  stale: false,
  runs: new Map(),
  rows: [],
  favourites: new Set(),
  filters: {},
  search: '',
  minimums: { win_rate: null, net_points: null },
  favOnly: false,
  hideUnrun: false,
  sortKey: 'net_points',
  sortDir: -1,
  fontScale: 1,
  shown: 300,
  expanded: null,
  filtered: [],
  status: null,
  pollTimer: null,
  wasRunning: false,
  audit: null,
  auditId: null,
  auditSortKey: 't',
  auditSortDir: 1,
  auditTakenOnly: false,
  file: '',
  decimals: 2,
  instrument: null,
};

for (const f of FACTORS) state.filters[f.key] = new Set(f.options.map(o => o[0]));

/* ------------------------------------------------------------------ helpers */

const nf = new Intl.NumberFormat('en-US');

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

function headerTone(label) {
  const low = String(label || '').toLowerCase();
  if (low === 'sl' || /\b(blown|blow|blows|stop|stops|loss|losses|gap|fail|fails)\b/.test(low)) return 'neg';
  if (low === 'tp' || /\b(funded|target|targets|payout|payouts|win|wins|pass|passes)\b/.test(low)) return 'pos';
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

function int(v) { return v == null ? '—' : Math.round(v).toLocaleString('en-US'); }
function f1(v) { return v == null ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }); }
function f2(v) { return v == null ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function px(v) {
  return v == null ? '—' : v.toLocaleString('en-US',
    { minimumFractionDigits: state.decimals, maximumFractionDigits: state.decimals });
}
function pct(v) { return v == null ? '—' : f1(v) + '%'; }
function signed(v, digits = 1) {
  if (v == null) return '—';
  const text = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return (v > 0 ? '+' : v < 0 ? '−' : '') + text;
}
function moneyCell(v, digits = 1) {
  const cell = h('td', { class: 'num ' + (v == null ? '' : v > 0 ? 'pos' : v < 0 ? 'neg' : '') }, signed(v, digits));
  return cell;
}

function dayText(ordinal) {
  if (ordinal == null) return '—';
  return new Date(ordinal * 86400000).toISOString().slice(0, 10);
}

const fmtUtc = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const fmtNy = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const fmtNyTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false });
const fmtNyDay = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', month: 'short', day: 'numeric' });

function utcText(ts) { return fmtUtc.format(new Date(ts * 1000)).replace(',', ''); }
function nyText(ts) { return fmtNy.format(new Date(ts * 1000)).replace(',', ''); }

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

const FILE_KEY = 'nq-data-file-v1';

function withFile(path) {
  return path + (path.includes('?') ? '&' : '?') + 'file=' + encodeURIComponent(state.file);
}

function favStorageKey() {
  return 'nq-favourites-v2|' + state.file;
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

function buildRows(summaryRuns) {
  const runs = new Map();
  for (const run of summaryRuns || []) runs.set(run.id, run);
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
          const run = runs.get(id);
          rows.push({ id, cfg, metrics: run ? run.metrics : null, fav: state.favourites.has(id) });
        }
  return rows;
}

function sortValue(row, key) {
  if (key === 'id') return row.id;
  if (key === 'fav') return row.fav ? 1 : 0;
  if (FACTOR_KEYS.includes(key)) return row.cfg[key];
  const m = row.metrics;
  if (!m) return null;
  if (key === 'hold') return m.hold ? m.hold.avg_bars : null;
  if (key === 'retrace') return m.excursion ? m.excursion.winners_mae_avg : null;
  if (key === 'equity') return m.equity && m.equity.length ? m.equity[m.equity.length - 1] : null;
  return m[key] == null ? null : m[key];
}

function rowPasses(row, skipKey) {
  for (const f of FACTORS) {
    if (f.key === skipKey) continue;
    if (!state.filters[f.key].has(row.cfg[f.key])) return false;
  }
  if (state.search && !row.id.includes(state.search)) return false;
  if (state.favOnly && !state.favourites.has(row.id)) return false;
  if (state.hideUnrun && !row.metrics) return false;
  return meetsMinimums(row);
}

function parseMinimum(value) {
  const text = String(value == null ? '' : value).trim();
  if (text === '' || text === '-' || text === '.' || text === '-.') return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function readMinimums() {
  state.minimums.win_rate = parseMinimum(document.getElementById('minWin').value);
  state.minimums.net_points = parseMinimum(document.getElementById('minPoints').value);
}

function meetsMinimums(row) {
  const metrics = row.metrics;
  const win = state.minimums.win_rate;
  const points = state.minimums.net_points;
  if (win == null && points == null) return true;
  if (!metrics) return false;
  if (win != null && (metrics.win_rate == null || metrics.win_rate < win)) return false;
  if (points != null && (metrics.net_points == null || metrics.net_points < points)) return false;
  return true;
}

function filteredRows() {
  const rows = state.rows.filter(row => rowPasses(row));
  const key = state.sortKey;
  const dir = state.sortDir;
  const factorKey = FACTOR_KEYS.includes(key);
  rows.sort((a, b) => {
    let av = sortValue(a, key);
    let bv = sortValue(b, key);
    const aNull = av == null, bNull = bv == null;
    if (aNull && bNull) return a.id.localeCompare(b.id);
    if (aNull) return 1;
    if (bNull) return -1;
    let cmp;
    if (factorKey && !NUMERIC_FACTORS.has(key)) {
      cmp = String(av).localeCompare(String(bv));
    } else if (typeof av === 'string' || typeof bv === 'string') {
      cmp = String(av).localeCompare(String(bv));
    } else {
      cmp = av - bv;
    }
    if (cmp === 0) cmp = a.id.localeCompare(b.id);
    return cmp * dir;
  });
  return rows;
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
  const counts = {};
  for (const factor of FACTORS) {
    for (const [value] of factor.options) counts[factor.key + ':' + value] = 0;
  }
  for (const row of state.rows) {
    if (!row.metrics) continue;
    for (const factor of FACTORS) {
      if (rowPasses(row, factor.key)) counts[factor.key + ':' + row.cfg[factor.key]]++;
    }
  }
  for (const node of document.querySelectorAll('[data-count]')) {
    const value = counts[node.dataset.count] || 0;
    node.textContent = value ? nf.format(value) : '';
  }
}

/* ------------------------------------------------------------------- table */

function sparkSvg(equity) {
  if (!equity || equity.length < 2) return '';
  let min = Math.min(0, ...equity), max = Math.max(0, ...equity);
  if (max - min < 1e-9) { max = min + 1; }
  const W = 110, H = 26;
  const pts = equity.map((v, i) => {
    const x = (i / (equity.length - 1)) * (W - 2) + 1;
    const y = H - 2 - ((v - min) / (max - min)) * (H - 4);
    return x.toFixed(1) + ',' + y.toFixed(1);
  }).join(' ');
  const color = equity[equity.length - 1] >= 0 ? '#26a69a' : '#ef5350';
  const zero = (v) => (H - 2 - ((v - min) / (max - min)) * (H - 4)).toFixed(1);
  const zeroLine = min < 0 && max > 0
    ? `<line x1="1" x2="${W - 1}" y1="${zero(0)}" y2="${zero(0)}" stroke="#2c3446" stroke-width="1" stroke-dasharray="2 3"/>`
    : '';
  return `<svg class="spark" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true">`
    + zeroLine
    + `<polyline fill="none" stroke="${color}" stroke-width="1.3" points="${pts}"/></svg>`;
}

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
    const sortKey = col.sortKey || col.key;
    const active = state.sortKey === sortKey && col.sortable !== false && !col.spark;
    const th = h('th', {
      class: ((col.num ? 'num ' : '') + (col.sortable === false ? 'nosort ' : '') + headerTone(col.label)).trim(),
      title: col.title || null,
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
  document.getElementById('runCount').textContent =
    `${nf.format(state.filtered.length)} combinations · ${nf.format(counts().done)} with results · ${nf.format(counts().all)} total`;
  const shown = state.filtered.slice(0, state.shown);
  const frag = document.createDocumentFragment();
  for (const row of shown) {
    frag.append(rowElement(row));
    if (state.expanded === row.id) frag.append(detailElement(row));
  }
  body.append(frag);
  paintOutcomes(body);
  const more = document.getElementById('moreBtn');
  more.hidden = state.filtered.length <= state.shown;
  more.textContent = `Show 300 more (${nf.format(Math.min(300, state.filtered.length - state.shown))} left)`;
  document.getElementById('expandAll').hidden = !state.expanded;
  refreshFilterCounts();
  if (document.getElementById('tab-factors').classList.contains('active')) renderFactors();
}

function renderAll() {
  state.shown = 300;
  renderHead();
  renderBody();
}

function counts() {
  let done = 0;
  for (const row of state.rows) if (row.metrics) done++;
  return { done, all: state.rows.length };
}

function rowElement(row) {
  const m = row.metrics;
  const tr = h('tr', { class: 'row', dataset: { id: row.id } });
  const star = h('button', {
    class: 'star' + (state.favourites.has(row.id) ? ' on' : ''),
    title: 'Favourite',
    type: 'button',
    onclick: (event) => { event.stopPropagation(); toggleFavourite(row); },
  }, state.favourites.has(row.id) ? '★' : '☆');
  tr.append(h('td', null, star));
  tr.append(h('td', { class: 'idcell', title: row.id }, row.id));
  const factorTds = factorCells(row);
  tr.append(...factorTds);

  if (!m) {
    for (let i = 0; i < 10; i++) tr.append(h('td', { class: 'num faint' }, '—'));
    tr.append(h('td', null,
      h('div', { class: 'actions-cell' },
        h('button', {
          class: 'btn small', type: 'button', title: 'Run this combination',
          onclick: (event) => { event.stopPropagation(); startRun([row.id], true); },
        }, 'Run'),
      )));
  } else {
    tr.append(h('td', { class: 'num' }, int(m.trades)));
    tr.append(h('td', { class: 'num' }, pct(m.win_rate)));
    tr.append(moneyCell(m.net_points));
    tr.append(h('td', { class: 'num' }, f2(m.profit_factor)));
    tr.append(moneyCell(m.expectancy, 2));
    tr.append(h('td', { class: 'num neg' }, int(m.max_drawdown)));
    tr.append(h('td', { class: 'num' }, f2(m.payoff)));
    tr.append(h('td', { class: 'num' }, m.hold ? int(m.hold.avg_bars) : '—'));
    const exc = m.excursion || {};
    tr.append(h('td', {
      class: 'num', title: `Winners retraced on average ${f1(exc.winners_mae_avg)} points toward the stop; ` +
        `${pct(exc.winners_near_stop_pct)} of winners came within 90% of it`,
    }, f1(exc.winners_mae_avg)));
    tr.append(h('td', { class: 'sparkCell' }, h('span', { html: sparkSvg(m.equity) })));
    tr.append(h('td', null,
      h('div', { class: 'actions-cell' },
        h('button', {
          class: 'btn small', type: 'button', title: 'Recompute this combination',
          onclick: (event) => { event.stopPropagation(); startRun([row.id], true); },
        }, 'Run'),
        h('button', {
          class: 'btn small ghost', type: 'button', title: 'Open the 2026-10-29 touch table for this run',
          onclick: (event) => { event.stopPropagation(); openAuditFor(row.id); },
        }, 'Day'),
      )));
  }
  tr.addEventListener('click', (event) => {
    if (event.target.closest('button') || event.target.closest('a')) return;
    state.expanded = state.expanded === row.id ? null : row.id;
    renderBody();
  });
  return tr;
}

function kv(pairs) {
  const host = h('div', { class: 'kv' });
  for (const [key, value, note] of pairs) {
    host.append(h('div', null,
      h('div', { class: 'k' }, key),
      h('div', { class: 'v' }, value, note ? h('small', null, ' ' + note) : null),
    ));
  }
  return host;
}

function section(title, hint, ...body) {
  return h('details', { class: 'acc' },
    h('summary', null, title, hint ? h('span', { class: 'hint' }, hint) : null),
    h('div', { class: 'body' }, ...body));
}

function miniTable(headers, rows) {
  return h('table', { class: 'mini' },
    h('thead', null, h('tr', null, ...headers.map(([label, numeric, title]) =>
      h('th', { class: numeric ? 'num' : '', title: title || null }, label)))),
    h('tbody', null, ...rows.map(cells => h('tr', null, ...cells.map((cell, i) =>
      cell && cell.nodeType ? cell : h('td', { class: headers[i] && headers[i][1] ? 'num' : '' }, cell))))));
}

function streakTable(rows) {
  if (!rows || !rows.length) return h('p', { class: 'muted' }, 'no samples');
  return miniTable([
    ['k in a row', true, 'A streak of exactly this many wins or losses. A longer streak is also counted at every shorter k.'],
    ['samples', true, 'How many times a streak of this length occurred.'],
    ['next win %', true, 'Percent of the trades that followed those streaks and won.'],
    ['next loss %', true, 'Percent of the trades that followed those streaks and did not win.'],
  ], rows.map(r => [String(r.k), int(r.n), pct(r.next_win_pct), pct(r.next_loss_pct)]));
}

function barStrip(chunks) {
  if (!chunks || !chunks.length) return h('p', { class: 'muted' }, 'under 10 trades');
  const max = Math.max(1, ...chunks.map(v => Math.abs(v - 50)));
  return h('div', { class: 'bars' },
    ...chunks.map((v, i) => h('div', {
      class: v >= 50 ? 'up' : 'down',
      style: `height:${Math.max(3, (Math.abs(v - 50) / max) * 100)}%`,
      title: `block ${i + 1}: ${pct(v)} win`,
    }, h('span', { class: 'lbl' }, f1(v)))));
}

function drawEquity(canvas, equity) {
  requestAnimationFrame(() => {
    if (!canvas.isConnected || !equity || equity.length < 2) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 600;
    const hgt = canvas.clientHeight || 170;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(hgt * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hgt);
    const padL = 46, padR = 10, padT = 10, padB = 18;
    const plotW = w - padL - padR, plotH = hgt - padT - padB;
    let min = Math.min(0, ...equity), max = Math.max(0, ...equity);
    if (max - min < 1e-9) { max += 1; min -= 1; }
    const x = i => padL + (i / (equity.length - 1)) * plotW;
    const y = v => padT + (max - v) / (max - min) * plotH;
    ctx.strokeStyle = '#232b3d';
    ctx.fillStyle = '#5d6579';
    ctx.font = '10px Consolas, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
      const value = min + (max - min) * (i / 4);
      const yy = y(value);
      ctx.beginPath();
      ctx.moveTo(padL, yy);
      ctx.lineTo(w - padR, yy);
      ctx.stroke();
      ctx.fillText(Math.round(value).toLocaleString('en-US'), padL - 6, yy);
    }
    const zeroY = y(0);
    ctx.strokeStyle = '#39445c';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(padL, zeroY);
    ctx.lineTo(w - padR, zeroY);
    ctx.stroke();
    ctx.setLineDash([]);
    const final = equity[equity.length - 1];
    const color = final >= 0 ? '#26a69a' : '#ef5350';
    const grad = ctx.createLinearGradient(0, padT, 0, hgt - padB);
    grad.addColorStop(0, final >= 0 ? 'rgba(38,166,154,0.28)' : 'rgba(239,83,80,0.28)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.beginPath();
    ctx.moveTo(x(0), zeroY);
    for (let i = 0; i < equity.length; i++) ctx.lineTo(x(i), y(equity[i]));
    ctx.lineTo(x(equity.length - 1), zeroY);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.beginPath();
    for (let i = 0; i < equity.length; i++) {
      const px = x(i), py = y(equity[i]);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.textAlign = 'left';
    ctx.fillText(signed(final, 1) + ' pts', padL + 4, padT + 8);
  });
}

function detailElement(row) {
  const m = row.metrics;
  const tr = h('tr', { class: 'detail' });
  const td = h('td', { colspan: COLUMNS.length });
  tr.append(td);

  const head = h('div', { class: 'detail-head' },
    h('span', { class: 'id' }, row.id),
    ...FACTORS.map(f => h('span', { class: 'f' }, `${f.title}: ${LABELS[f.key][row.cfg[f.key]]}`)),
    h('span', { class: 'spacer' }),
    h('button', {
      class: 'btn small primary', type: 'button',
      onclick: () => startRun([row.id], true),
    }, 'Run this'),
    h('button', {
      class: 'btn small ghost', type: 'button',
      onclick: () => openAuditFor(row.id),
    }, 'Audit day'),
    h('button', {
      class: 'btn small ghost', type: 'button',
      onclick: () => downloadTrades(row.id),
    }, 'Trades CSV'),
  );
  td.append(head);

  if (!m) {
    td.append(h('div', { class: 'empty' }, h('b', null, 'Not computed yet. '), 'Use Run this to compute the combination.'));
    return tr;
  }

  if (m.trades === 0) {
    td.append(h('div', { class: 'empty' }, h('b', null, 'No trades. '), 'The filters of this combination never produced a trade.'));
    return tr;
  }

  const resultSection = section('Result', `${int(m.trades)} trades`, kv([
    ['Trades', int(m.trades)],
    ['Wins', int(m.wins)],
    ['Losses', int(m.losses)],
    ['Win rate', pct(m.win_rate)],
    ['Net points', signed(m.net_points), 'one contract'],
    ['Expectancy', signed(m.expectancy, 2), 'per trade'],
    ['Profit factor', f2(m.profit_factor)],
    ['PF without best', f2(m.profit_factor_without_best)],
    ['Payoff', f2(m.payoff)],
    ['Average win', signed(m.avg_win)],
    ['Average loss', signed(m.avg_loss)],
    ['Targets / stops', `${int(m.targets)} / ${int(m.stops)}`],
    ['Forced exits', int(m.forced), 'file ended'],
    ['Longs / shorts', `${int(m.longs)} / ${int(m.shorts)}`],
    ['Long net', signed(m.long_net)],
    ['Short net', signed(m.short_net)],
  ]));
  resultSection.open = true;
  td.append(resultSection);

  const eqCanvas = h('canvas', { class: 'equityCanvas' });
  const daily = m.daily || {};
  const equitySection = section('Equity and drawdown', signed(m.net_points) + ' pts', ...[]);
  const eqBody = equitySection.querySelector('.body');
  eqBody.append(kv([
    ['Max drawdown', int(m.max_drawdown), 'points'],
    ['Max DD trades', int(m.max_drawdown_trades), 'longest underwater'],
    ['Return / swing', f2(daily.return_swing)],
    ['Days traded', int(daily.days)],
    ['Trades per day', f1(daily.trades_per_day)],
    ['Positive days', pct(daily.positive_days_pct)],
    ['Best day', daily.best_day ? signed(daily.best_day.points) : '—', daily.best_day ? dayText(daily.best_day.day) : ''],
    ['Worst day', daily.worst_day ? signed(daily.worst_day.points) : '—', daily.worst_day ? dayText(daily.worst_day.day) : ''],
    ['Period', m.period ? dayText(m.period.first) : '—', m.period ? 'to ' + dayText(m.period.last) : ''],
    ['Hold', m.hold ? `${f1(m.hold.avg_bars)} bars` : '—', m.hold ? `median ${f1(m.hold.median_bars)}, max ${int(m.hold.max_bars)}` : ''],
  ]));
  eqBody.append(eqCanvas);
  td.append(equitySection);
  drawEquity(eqCanvas, m.equity);

  const ac = m.autocorrelation || {};
  const streakRows = (key, legacy) => ac[key] || (Array.isArray(ac[legacy]) ? ac[legacy] : []);
  const samples = (v) => (v == null || Array.isArray(v)) ? '—' : int(v);
  const acSection = section('Streaks and autocorrelation',
    `longest ${int(m.streaks && m.streaks.longest_win)}W / ${int(m.streaks && m.streaks.longest_loss)}L`);
  acSection.querySelector('.body').append(
    kv([
      ['Unconditional win', pct(ac.unconditional_win_pct)],
      ['After a loss', pct(ac.conditional_win_pct), `${samples(ac.after_loss)} samples`],
      ['After a win', pct(ac.after_win_win_pct), `${samples(ac.after_win)} samples`],
      ['Gap', signed(ac.gap) + ' pp', ac.sign],
      ['Band', ac.band || '—', 'Kelly ' + (ac.kelly_fraction || '—')],
      ['Pearson win/loss', f2(ac.pearson_winloss)],
      ['Pearson points', f2(ac.pearson_points)],
      ['Full Kelly', ac.kelly_full == null ? '—' : f2(ac.kelly_full)],
      ['Kelly bet', ac.kelly_bet == null ? '—' : f2(ac.kelly_bet)],
      ['Longest win / loss', `${int(m.streaks && m.streaks.longest_win)} / ${int(m.streaks && m.streaks.longest_loss)}`],
    ]),
    h('div', { class: 'grid2' },
      h('div', null,
        h('div', { class: 'subhead' }, 'After k losses in a row'),
        streakTable(streakRows('after_loss_streaks', 'after_loss'))),
      h('div', null,
        h('div', { class: 'subhead' }, 'After k wins in a row'),
        streakTable(streakRows('after_win_streaks', 'after_win')))),
  );
  td.append(acSection);

  const ex = m.excursion || {};
  td.append(section('Retrace and excursion',
    `winners gave back ${f1(ex.winners_mae_avg)} of ${int(row.cfg.sl)} pts`, kv([
      ['Winners MAE average', f1(ex.winners_mae_avg), 'points toward the stop'],
      ['Winners MAE median', f1(ex.winners_mae_median)],
      ['Winners MAE p90', f1(ex.winners_mae_p90)],
      ['Winners MAE max', f1(ex.winners_mae_max)],
      ['Winners near stop', `${int(ex.winners_near_stop)} · ${pct(ex.winners_near_stop_pct)}`, 'within 90% of the stop'],
      ['Winners MFE average', f1(ex.winners_mfe_avg)],
      ['Losers MFE average', f1(ex.losers_mfe_avg), 'how far losers ran first'],
      ['Losers MFE median', f1(ex.losers_mfe_median)],
      ['Losers MFE p90', f1(ex.losers_mfe_p90)],
      ['MAE average (all)', f1(ex.mae_avg)],
      ['MFE average (all)', f1(ex.mfe_avg)],
    ])));

  td.append(section('Chunk win rates', 'ten equal blocks in trade order',
    barStrip(m.chunks),
    h('p', { class: 'muted' }, 'Each bar is one block’s win rate. A high bar is greener; the height is the distance from 50%.'),
  ));

  const hourly = m.hourly || [];
  const weekday = m.weekday || [];
  const wdNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  td.append(section('Breakdowns', 'UTC hour and New York weekday',
    h('div', { class: 'grid2' },
      h('div', null,
        h('div', { class: 'subhead' }, 'Entry hour (UTC)'),
        miniTable([['Hour', false, 'UTC hour of the entry.'], ['Trades', true, 'Trades entered in this hour.'], ['Win %', true, 'Percent of those trades with points above zero.'], ['Net', true, 'Sum of their points.']],
          hourly.map(r => [`${String(r.hour).padStart(2, '0')}:00`, int(r.trades), pct(r.win_rate), signed(r.net_points)]))),
      h('div', null,
        h('div', { class: 'subhead' }, 'Entry weekday (New York)'),
        miniTable([['Day', false, 'New York weekday of the entry.'], ['Trades', true, 'Trades entered on this weekday.'], ['Win %', true, 'Percent of those trades with points above zero.'], ['Net', true, 'Sum of their points.']],
          weekday.map(r => [wdNames[r.weekday] || r.weekday, int(r.trades), pct(r.win_rate), signed(r.net_points)]))))));

  return tr;
}

/* --------------------------------------------------------------- favourites */

function applyFavourite(id, on) {
  if (on) state.favourites.add(id); else state.favourites.delete(id);
  for (const row of state.rows) if (row.id === id) row.fav = on;
  try { localStorage.setItem(favStorageKey(), JSON.stringify([...state.favourites])); } catch (err) { /* private mode */ }
  postJson('/api/strategy/favourites', { id, favourite: on, file: state.file }).catch(() => {});
  const count = state.favourites.size;
  toast((on ? 'Added to favourites' : 'Removed from favourites') + ` · ${count} saved`, 'ok');
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

function cssEscape(value) {
  return window.CSS && CSS.escape ? CSS.escape(value) : value.replace(/["\\]/g, '\\$&');
}

/* ------------------------------------------------------------------ actions */

function workerCount() {
  const input = document.getElementById('workersInput');
  const n = Math.trunc(Number(input.value));
  const workers = Math.min(4, Math.max(1, Number.isFinite(n) ? n : 2));
  input.value = String(workers);
  try { localStorage.setItem('nq-split-workers', String(workers)); } catch (err) { /* private mode */ }
  return workers;
}

async function startRun(ids, force) {
  try {
    const workers = workerCount();
    const body = ids ? { ids, force, file: state.file, workers } : { all: true, force, file: state.file, workers };
    const res = await postJson('/api/strategy/run', body);
    toast(`Started ${res.label || 'run'}${res.queued ? ` · ${res.queued} queued` : ''}`, 'ok');
    pollStatus(true);
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function downloadTrades(id) {
  try {
    toast('Building the trade CSV…');
    const res = await postJson('/api/strategy/trades', { run: id, file: state.file });
    window.open(res.url, '_blank');
    toast(`${nf.format(res.rows)} trades written`, 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
}

function openAuditFor(id) {
  document.getElementById('auditRun').value = id;
  selectTab('audit');
}

/* ------------------------------------------------------------------ factors */

function renderFactors() {
  const host = document.getElementById('factorTables');
  host.textContent = '';
  const rows = state.filtered.filter(r => r.metrics);
  if (!rows.length) {
    host.append(h('div', { class: 'empty' }, h('b', null, 'No computed runs pass the filters. '),
      'Run missing combinations or widen the filters.'));
    return;
  }
  document.getElementById('factorIntro').textContent =
    `Measured on the ${nf.format(rows.length)} computed runs that pass the filters. ` +
    'Mean, median, best and worst of the net points; the bar shows the mean against the largest absolute mean in the factor.';
  for (const factor of FACTORS) {
    const table = [];
    let maxAbs = 0;
    const stats = factor.options.map(([value, label]) => {
      const nets = rows.filter(r => r.cfg[factor.key] === value).map(r => r.metrics.net_points);
      if (!nets.length) return { value, label, runs: 0 };
      nets.sort((a, b) => a - b);
      const mean = nets.reduce((a, b) => a + b, 0) / nets.length;
      const median = nets.length % 2
        ? nets[(nets.length - 1) / 2]
        : (nets[nets.length / 2 - 1] + nets[nets.length / 2]) / 2;
      maxAbs = Math.max(maxAbs, Math.abs(mean));
      return { value, label, runs: nets.length, mean, median, best: nets[nets.length - 1], worst: nets[0] };
    });
    let bestMean = -Infinity;
    for (const s of stats) if (s.runs && s.mean > bestMean) bestMean = s.mean;
    for (const s of stats) {
      table.push(h('tr', { class: s.runs && s.mean === bestMean ? 'best' : '' },
        h('td', null, s.label),
        h('td', { class: 'num' }, int(s.runs)),
        h('td', { class: 'num ' + (s.runs ? (s.mean > 0 ? 'pos' : 'neg') : '') }, s.runs ? signed(s.mean) : '—'),
        h('td', { class: 'num' }, s.runs ? signed(s.median) : '—'),
        h('td', { class: 'num pos' }, s.runs ? signed(s.best) : '—'),
        h('td', { class: 'num neg' }, s.runs ? signed(s.worst) : '—'),
        h('td', null, s.runs
          ? h('span', { class: 'meter ' + (s.mean > 0 ? 'pos' : 'neg') },
            h('i', { style: `width:${maxAbs ? (Math.abs(s.mean) / maxAbs) * 100 : 0}%` }))
          : ''),
      ));
    }
    host.append(h('div', { class: 'factorCard' },
      h('h3', null, factor.title, h('span', null, `${factor.options.length} options`)),
      h('table', null,
        h('thead', null, h('tr', null,
          h('th', { title: 'One option of this factor. The other factors still vary inside the row.' }, 'Option'),
          h('th', { class: 'num', title: 'Runs that pass the current filters and use this option.' }, 'Runs'),
          h('th', { class: 'num', title: 'Average net points of those runs.' }, 'Mean net'),
          h('th', { class: 'num', title: 'Median net points of those runs.' }, 'Median'),
          h('th', { class: 'num', title: 'Highest net points among those runs.' }, 'Best'),
          h('th', { class: 'num', title: 'Lowest net points among those runs.' }, 'Worst'),
          h('th', { title: 'The mean drawn as a bar against the largest absolute mean in this table.' }, 'Mean'))),
        h('tbody', null, ...table))));
  }
}

/* -------------------------------------------------------------------- audit */

function updateAuditMeta() {
  const a = state.audit;
  const meta = document.getElementById('auditMeta');
  if (!a) { meta.textContent = ''; return; }
  meta.textContent = `${nf.format(a.counts.events)} touches · ${a.counts.taken} taken · ` +
    `${nf.format(a.counts.skipped)} skipped · simulated ${a.consistent ? 'matches' : 'DIFFERS from'} the run · ` +
    `${nf.format(a.bars.length)} bars · ${a.day} New York`;
}

async function loadAudit() {
  const id = document.getElementById('auditRun').value.trim();
  const day = document.getElementById('auditDay').value;
  if (!/^sl\d+_tp\d+_(london|ny|rth|all)_lv(all|eth|rth)_(rev|cont)_(touch|confirm)_(1m|6m|1y|all)_(every|serial|one|until)(?:_(skip|keep))?$/.test(id)) {
    toast('Choose a valid run id first', 'err');
    return;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    toast('Choose a valid day', 'err');
    return;
  }
  const button = document.getElementById('auditLoadBtn');
  button.disabled = true;
  document.getElementById('auditTradesBtn').disabled = true;
  const token = id + '|' + day;
  state.auditToken = token;
  try {
    let data;
    try {
      data = await api(withFile(`/api/strategy/audit?run=${encodeURIComponent(id)}&day=${day}`));
    } catch (err) {
      if (err.status !== 404) throw err;
      document.getElementById('statusText').textContent = 'building the audit table…';
      data = await postJson('/api/strategy/audit', { run: id, day, file: state.file });
    }
    if (state.auditToken !== token) return;
    state.audit = data;
    state.auditId = id;
    state.auditSortKey = 't';
    state.auditSortDir = 1;
    updateAuditMeta();
    renderAuditTable();
    AuditChart.setData(data);
    document.getElementById('auditTradesBtn').disabled = false;
    updateAuditSummary();
  } catch (err) {
    if (state.auditToken === token) toast(err.message, 'err');
  } finally {
    if (state.auditToken === token) button.disabled = false;
    pollStatus();
  }
}

function auditRows() {
  const a = state.audit;
  if (!a) return [];
  const key = state.auditSortKey;
  const dir = state.auditSortDir;
  const rows = a.rows.slice();
  rows.sort((x, y) => {
    let xv = x[key], yv = y[key];
    const xNull = xv == null, yNull = yv == null;
    if (xNull && yNull) return x.t - y.t;
    if (xNull) return 1;
    if (yNull) return -1;
    if (typeof xv === 'string') return xv.localeCompare(yv) * dir;
    return (xv - yv) * dir;
  });
  return rows;
}

function renderAuditTable() {
  const a = state.audit;
  const body = document.getElementById('auditBody');
  body.textContent = '';
  if (!a) return;
  let rows = auditRows();
  if (state.auditTakenOnly) rows = rows.filter(r => r.decision === 'taken');
  const cap = 20000;
  const frag = document.createDocumentFragment();
  for (const row of rows.slice(0, cap)) {
    const taken = row.decision === 'taken';
    const tr = h('tr', { class: taken ? 'taken' : '', dataset: { bar: row.bar } },
      h('td', { class: 'time' }, utcText(row.t)),
      h('td', { class: 'time faint' }, nyText(row.t)),
      h('td', null, h('span', { class: 'badge ' + (row.side > 0 ? 'up' : 'down') }, row.side > 0 ? 'buy' : 'sell')),
      h('td', { class: 'num' }, px(row.level)),
      h('td', { class: 'num faint' }, int(row.rank)),
      h('td', { class: 'num' }, row.look_days + 'd'),
      h('td', null, row.kind),
      h('td', { class: 'faint', title: (row.sources || []).join('\n') }, row.source),
      h('td', null, h('span', { class: 'decision ' + row.decision }, row.decision)),
      h('td', { class: 'num ' + (taken ? (row.points > 0 ? 'pos' : 'neg') : 'faint') }, taken ? signed(row.points, 2) : '—'),
      h('td', { class: 'num faint' }, taken ? `${px(row.exit)} ${row.exit_kind}` : '—'),
      h('td', { class: 'num' }, taken ? f1(row.mae) : '—'),
      h('td', { class: 'num' }, taken ? f1(row.mfe) : '—'),
      h('td', { class: 'num' }, taken ? int(row.bars) : '—'),
    );
    tr.addEventListener('click', () => {
      AuditChart.center(row.li != null ? row.li : AuditChart.barForTs(row.t));
      for (const other of body.querySelectorAll('tr.sel')) other.classList.remove('sel');
      tr.classList.add('sel');
    });
    frag.append(tr);
  }
  if (rows.length > cap) {
    frag.append(h('tr', { class: 'note' }, h('td', { colspan: 14 },
      `Showing the first ${nf.format(cap)} of ${nf.format(rows.length)} touches.`)));
  }
  body.append(frag);
}

function updateAuditSummary() {
  const a = state.audit;
  const host = document.getElementById('auditSummary');
  host.textContent = '';
  if (!a) return;
  const decisions = {};
  for (const row of a.rows) decisions[row.decision] = (decisions[row.decision] || 0) + 1;
  const taken = a.rows.filter(r => r.decision === 'taken');
  const wins = taken.filter(r => r.points > 0).length;
  const net = taken.reduce((sum, r) => sum + r.points, 0);
  host.append(h('h3', null, 'Audit day'));
  host.append(kv([
    ['Day', a.day, 'New York'],
    ['Touches', int(a.counts.events)],
    ['Taken', int(a.counts.taken)],
    ['Skipped', int(a.counts.skipped)],
    ['Taken win rate', taken.length ? pct((wins / taken.length) * 100) : '—'],
    ['Taken net', taken.length ? signed(net, 2) : '—'],
    ['Simulation', a.consistent ? 'consistent' : 'MISMATCH'],
    ['Bars', int(a.bars.length)],
    ['Levels in view', int(a.levels.length)],
  ]));
  host.append(h('div', { class: 'subhead' }, 'Why a touch was skipped'));
  const table = h('table', { class: 'mini' },
    h('thead', null, h('tr', null,
      h('th', { title: 'Why a touch was taken or skipped on the audit day.' }, 'Reason'),
      h('th', { class: 'num', title: 'How many touches had this reason.' }, 'Count'))),
    h('tbody', null, ...Object.entries(decisions).sort((x, y) => y[1] - x[1]).map(([key, count]) =>
      h('tr', null, h('td', null, DECISIONS[key] || key), h('td', { class: 'num' }, int(count))))));
  host.append(table);
  if (taken.length) {
    host.append(h('div', { class: 'subhead' }, 'Taken trades'));
    host.append(miniTable([
      ['Time UTC', false, 'UTC time of the taken trade.'],
      ['Side', false, 'Buy or sell.'],
      ['Points', true, 'Points from the fill to the exit.'],
    ], taken.map(r => [utcText(r.t).slice(11), r.side > 0 ? 'buy' : 'sell', signed(r.points, 2)])));
  }
}

/* --------------------------------------------------------------- audit chart */

const AuditChart = {
  canvas: null,
  wrap: null,
  tip: null,
  data: null,
  view: { start: 0, end: 0 },
  hover: null,
  drag: null,
  ts: null,

  init() {
    this.canvas = document.getElementById('auditCanvas');
    this.wrap = this.canvas.parentElement;
    this.tip = document.getElementById('auditTip');
    const canvas = this.canvas;
    canvas.addEventListener('wheel', (event) => this.onWheel(event), { passive: false });
    canvas.addEventListener('pointerdown', (event) => this.onDown(event));
    canvas.addEventListener('pointermove', (event) => this.onMove(event));
    window.addEventListener('pointerup', () => { this.drag = null; });
    canvas.addEventListener('pointerleave', () => {
      if (this.drag) return;
      this.hover = null;
      this.tip.hidden = true;
      this.draw();
    });
    canvas.addEventListener('dblclick', () => this.reset());
    new ResizeObserver(() => this.draw()).observe(this.wrap);
  },

  setData(a) {
    this.data = a;
    this.ts = a.bars.map(b => b[0]);
    const index = new Map();
    for (let i = 0; i < this.ts.length; i++) index.set(this.ts[i], i);
    this.byBar = new Map();
    this.taken = [];
    for (const row of a.rows) {
      const i = index.get(row.t);
      row.li = i == null ? null : i;
      if (row.li == null) continue;
      const list = this.byBar.get(row.li);
      if (list) list.push(row); else this.byBar.set(row.li, [row]);
      if (row.decision === 'taken') this.taken.push(row);
    }
    this.reset();
  },

  reset() {
    if (!this.data) return;
    const n = this.data.bars.length;
    this.view = { start: 0, end: n };
    this.hover = null;
    this.tip.hidden = true;
    this.draw();
  },

  center(bar) {
    if (!this.data) return;
    const n = this.data.bars.length;
    const span = Math.min(n, 160);
    let start = Math.round(bar - span / 2);
    start = Math.max(0, Math.min(n - span, start));
    this.view = { start, end: start + span };
    this.draw();
  },

  layout() {
    const canvas = this.canvas;
    const w = canvas.clientWidth || 800;
    const hgt = canvas.clientHeight || 460;
    const padL = 8, padR = 66, padT = 10, padB = 24;
    const plotW = w - padL - padR;
    const plotH = hgt - padT - padB;
    const data = this.data;
    const n = data.bars.length;
    let start = Math.max(0, Math.min(n - 1, Math.floor(this.view.start)));
    let end = Math.max(start + 2, Math.min(n, Math.ceil(this.view.end)));
    let min = Infinity, max = -Infinity;
    if (n > 0) {
      for (let i = start; i < end; i++) {
        const bar = data.bars[i];
        if (bar[3] < min) min = bar[3];
        if (bar[2] > max) max = bar[2];
      }
    }
    for (const row of this.taken) {
      if (row.li < start || row.li >= end) continue;
      min = Math.min(min, row.stop, row.target);
      max = Math.max(max, row.stop, row.target);
    }
    if (!isFinite(min) || !isFinite(max)) { min = 0; max = 1; }
    // The floor keeps a flat day readable; it has to scale with the price, not
    // with index points, or a 1.33 quote gets buried in a 7-point window.
    const pad = Math.max((max - min) * 0.08, Math.max(Math.abs(min), Math.abs(max)) * 0.0002);
    min -= pad; max += pad;
    const span = end - start;
    const x = i => padL + ((i + 0.5 - start) / span) * plotW;
    const y = p => padT + ((max - p) / (max - min)) * plotH;
    const barAt = px => start + Math.floor(((px - padL) / plotW) * span);
    return { w, h: hgt, padL, padR, padT, padB, plotW, plotH, start, end, span, min, max, x, y, barAt };
  },

  draw() {
    if (!this.data || !this.canvas) return;
    const canvas = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 800;
    const hgt = canvas.clientHeight || 460;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hgt * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(hgt * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hgt);
    ctx.fillStyle = '#0b0e14';
    ctx.fillRect(0, 0, w, hgt);

    const L = this.layout();
    const data = this.data;
    const { padL, padR, padT, padB, plotW, plotH, start, end, x, y } = L;
    ctx.font = '10px Consolas, monospace';
    ctx.textBaseline = 'middle';

    // price grid
    const step = niceStep(L.max - L.min, Math.max(3, Math.floor(plotH / 42)));
    ctx.strokeStyle = '#161c28';
    ctx.fillStyle = '#6b748a';
    ctx.textAlign = 'left';
    for (let price = Math.ceil(L.min / step) * step; price <= L.max; price += step) {
      const yy = y(price);
      ctx.beginPath();
      ctx.moveTo(padL, yy);
      ctx.lineTo(w - padR, yy);
      ctx.stroke();
      ctx.fillText(price.toFixed(state.decimals), w - padR + 6, yy);
    }

    // levels: touched prices first and brighter, the rest as faint context
    ctx.lineWidth = 1;
    const stepKey = Math.pow(10, state.decimals);
    const touchedKeys = new Set(data.rows.map(r => Math.round(r.level * stepKey)));
    let levelsDrawn = 0;
    for (const pass of [true, false]) {
      for (const level of data.levels) {
        if (touchedKeys.has(Math.round(level.price * stepKey)) !== pass) continue;
        if (level.price < L.min || level.price > L.max) continue;
        if (levelsDrawn > 600) break;
        const yy = Math.round(y(level.price)) + 0.5;
        if (level.color === 'weekly' || level.color === 'both') {
          ctx.strokeStyle = pass ? 'rgba(242,193,78,0.62)' : 'rgba(242,193,78,0.16)';
          ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(w - padR, yy); ctx.stroke();
        }
        if (level.color === 'daily' || level.color === 'both') {
          ctx.strokeStyle = pass ? 'rgba(79,195,247,0.45)' : 'rgba(79,195,247,0.10)';
          ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(w - padR, yy); ctx.stroke();
        }
        levelsDrawn++;
      }
    }

    // candles
    const span = L.span;
    const slot = plotW / span;
    const bodyW = Math.max(1, Math.min(13, slot * 0.68));
    const thin = bodyW < 2.2;
    const lastBar = Math.min(end, data.bars.length);
    for (let i = start; i < lastBar; i++) {
      const bar = data.bars[i];
      const [ts, o, hgh, low, c] = bar;
      const up = c >= o;
      const cx = x(i);
      const yyO = y(o), yyC = y(c);
      ctx.strokeStyle = up ? '#26a69a' : '#ef5350';
      ctx.fillStyle = up ? '#26a69a' : '#ef5350';
      if (thin) {
        ctx.beginPath();
        ctx.moveTo(Math.round(cx) + 0.5, y(hgh));
        ctx.lineTo(Math.round(cx) + 0.5, y(low));
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.moveTo(Math.round(cx) + 0.5, y(hgh));
        ctx.lineTo(Math.round(cx) + 0.5, y(low));
        ctx.stroke();
        const top = Math.min(yyO, yyC);
        const height = Math.max(1, Math.abs(yyC - yyO));
        ctx.fillRect(cx - bodyW / 2, top, bodyW, height);
      }
    }

    // taken trades: stop / target / result
    for (const row of this.taken) {
      if (row.li < start || row.li >= end) continue;
      const exitBar = this.barForTs(row.exit_t);
      const x0 = x(row.li);
      const x1 = exitBar == null ? w - padR : x(exitBar);
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = 'rgba(239,83,80,0.55)';
      ctx.beginPath(); ctx.moveTo(x0, y(row.stop)); ctx.lineTo(x1, y(row.stop)); ctx.stroke();
      ctx.strokeStyle = 'rgba(38,166,154,0.55)';
      ctx.beginPath(); ctx.moveTo(x0, y(row.target)); ctx.lineTo(x1, y(row.target)); ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle = row.points > 0 ? 'rgba(38,166,154,0.9)' : 'rgba(239,83,80,0.9)';
      ctx.lineWidth = 1.3;
      ctx.beginPath(); ctx.moveTo(x0, y(row.fill)); ctx.lineTo(x1, y(row.exit)); ctx.stroke();
      ctx.lineWidth = 1;
      if (x1 >= padL && x1 <= w - padR) {
        ctx.fillStyle = row.points > 0 ? '#26a69a' : '#ef5350';
        ctx.fillRect(x1 - 2, y(row.exit) - 2, 4, 4);
      }
    }

    // touches
    for (const row of data.rows) {
      if (row.li == null || row.li < start || row.li >= end) continue;
      if (row.decision === 'taken') continue;
      const cx = x(row.li);
      const yy = y(row.level);
      if (yy < padT - 2 || yy > padT + plotH + 2) continue;
      ctx.fillStyle = row.side > 0 ? 'rgba(38,166,154,0.28)' : 'rgba(239,83,80,0.28)';
      ctx.beginPath();
      ctx.arc(cx, yy, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
    for (const row of this.taken) {
      if (row.li < start || row.li >= end) continue;
      const cx = x(row.li);
      const yy = y(row.level);
      ctx.beginPath();
      ctx.arc(cx, yy, 4, 0, Math.PI * 2);
      ctx.fillStyle = row.side > 0 ? '#26a69a' : '#ef5350';
      ctx.fill();
      ctx.strokeStyle = '#0b0e14';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.lineWidth = 1;
    }

    // time axis
    const tickEvery = Math.max(1, Math.round(90 / Math.max(1, slot)));
    ctx.fillStyle = '#6b748a';
    ctx.textAlign = 'center';
    ctx.strokeStyle = '#161c28';
    let lastLabel = -Infinity;
    const lastTick = Math.min(end, data.bars.length);
    for (let i = start; i < lastTick; i++) {
      const ts = data.bars[i][0];
      if (ts % 3600 !== 0) continue;
      if (i - lastLabel < tickEvery) continue;
      lastLabel = i;
      const cx = x(i);
      ctx.beginPath(); ctx.moveTo(cx, padT); ctx.lineTo(cx, padT + plotH); ctx.stroke();
      const dayStart = new Date(ts * 1000);
      const clock = fmtNyTime.format(dayStart);
      const isMidnight = clock === '00:00' || clock === '24:00';
      const labelX = Math.max(padL + 18, Math.min(w - padR - 18, cx));
      ctx.fillText(isMidnight ? fmtNyDay.format(dayStart) : clock, labelX, padT + plotH + 12);
    }

    // hover crosshair + tool
    if (this.hover != null) {
      const i = Math.max(start, Math.min(end - 1, this.hover));
      const cx = x(i);
      ctx.strokeStyle = 'rgba(209,212,220,0.25)';
      ctx.setLineDash([2, 2]);
      ctx.beginPath(); ctx.moveTo(cx, padT); ctx.lineTo(cx, padT + plotH); ctx.stroke();
      ctx.setLineDash([]);
    }

    // axes border
    ctx.strokeStyle = '#232b3d';
    ctx.beginPath();
    ctx.moveTo(padL, padT + plotH + 0.5);
    ctx.lineTo(w - padR, padT + plotH + 0.5);
    ctx.stroke();
  },

  barForTs(ts) {
    if (!this.ts || !this.ts.length) return null;
    let lo = 0, hi = this.ts.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.ts[mid] === ts) return mid;
      if (this.ts[mid] < ts) lo = mid + 1; else hi = mid - 1;
    }
    return Math.max(0, Math.min(this.ts.length - 1, lo));
  },

  onWheel(event) {
    if (!this.data) return;
    event.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const L = this.layout();
    const px = event.clientX - rect.left;
    const n = L.end - L.start;
    const anchor = L.start + ((px - L.padL) / L.plotW) * n;
    const total = this.data.bars.length;
    const factor = Math.exp(event.deltaY * 0.0016);
    let next = Math.round(n * factor);
    next = Math.max(40, Math.min(total, next));
    let start = anchor - (anchor - L.start) * (next / n);
    start = Math.max(0, Math.min(total - next, start));
    this.view = { start, end: start + next };
    this.draw();
  },

  onDown(event) {
    if (!this.data) return;
    const rect = this.canvas.getBoundingClientRect();
    this.drag = {
      x: event.clientX - rect.left,
      start: this.view.start,
      end: this.view.end,
      moved: false,
    };
    this.canvas.setPointerCapture(event.pointerId);
  },

  onMove(event) {
    if (!this.data) return;
    const rect = this.canvas.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    if (this.drag) {
      const L = this.layout();
      const dx = px - this.drag.x;
      const shift = (dx / L.plotW) * (this.drag.end - this.drag.start);
      const total = this.data.bars.length;
      const span = this.drag.end - this.drag.start;
      let start = this.drag.start - shift;
      start = Math.max(0, Math.min(total - span, start));
      this.view = { start, end: start + span };
      this.drag.moved = true;
      this.draw();
      return;
    }
    const L = this.layout();
    const i = L.barAt(px);
    this.hover = i;
    this.showTip(i, px, py, L);
    this.draw();
  },

  showTip(i, px, py, L) {
    if (i < 0 || i >= this.data.bars.length) { this.tip.hidden = true; return; }
    const bar = this.data.bars[i];
    const touches = this.byBar.get(i) || [];
    const lines = [
      `<b>${utcText(bar[0])} UTC</b> · ${nyText(bar[0])} NY`,
      `O ${px(bar[1])} · H ${px(bar[2])} · L ${px(bar[3])} · C ${px(bar[4])}`,
    ];
    for (const row of touches.slice(0, 4)) {
      lines.push(`<span style="color:${row.side > 0 ? '#26a69a' : '#ef5350'}">${row.side > 0 ? 'buy' : 'sell'}</span> ` +
        `${px(row.level)} · ${row.kind} · ${row.decision}` +
        (row.decision === 'taken' ? ` · ${signed(row.points, 2)} pts` : ''));
    }
    if (touches.length > 4) lines.push(`… ${touches.length - 4} more touches`);
    this.tip.innerHTML = lines.join('<br>');
    this.tip.hidden = false;
    const wrap = this.wrap;
    const tw = this.tip.offsetWidth || 220;
    const left = Math.max(4, Math.min(wrap.clientWidth - tw - 6, px + 14));
    this.tip.style.left = left + 'px';
    this.tip.style.top = Math.max(4, Math.min(wrap.clientHeight - 60, py - 10)) + 'px';
  },
};

function niceStep(range, count) {
  const raw = range / Math.max(1, count);
  const pow = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  const n = raw / pow;
  const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
  return step;
}

/* ------------------------------------------------------------------- status */

function setStatus(status) {
  state.status = status;
  const dot = document.getElementById('statusDot');
  const text = document.getElementById('statusText');
  const wrap = document.getElementById('statusBarWrap');
  const bar = document.getElementById('statusBar');
  const progress = status.progress || {};
  const job = status.job;
  const countsNow = counts();

  if (status.running && job && job.kind === 'grid') {
    dot.className = 'dot busy';
    const done = progress.done || 0;
    const total = progress.total || job.total || 0;
    const pctDone = total ? Math.round((done / total) * 100) : 0;
    const eta = progress.eta_seconds;
    const etaText = eta == null ? '' : ` · ${formatEta(eta)} left`;
    text.textContent = `running ${nf.format(done)}/${nf.format(total)} (${pctDone}%)${etaText}`;
    wrap.hidden = false;
    bar.style.width = pctDone + '%';
  } else if (status.running && job) {
    dot.className = 'dot busy';
    text.textContent = job.label || 'working…';
    wrap.hidden = true;
  } else if (progress.error) {
    dot.className = 'dot err';
    const first = String(progress.error).trim().split('\n').slice(-1)[0];
    text.textContent = 'last job failed: ' + first.slice(0, 90);
    wrap.hidden = true;
  } else {
    dot.className = 'dot ok';
    text.textContent = `idle · ${nf.format(countsNow.done)} of ${nf.format(countsNow.all)} computed`;
    wrap.hidden = true;
  }

  const busy = !!status.running;
  for (const id of ['runMissingBtn', 'runAllBtn', 'runShownBtn']) {
    document.getElementById(id).disabled = busy;
  }
}

function formatEta(seconds) {
  seconds = Math.max(0, Math.round(seconds));
  if (seconds < 90) return seconds + 's';
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return minutes + ' min';
  return (minutes / 60).toFixed(1) + ' h';
}

async function pollStatus(force) {
  clearTimeout(state.pollTimer);
  try {
    const status = await api(withFile('/api/strategy/status'));
    const wasRunning = state.wasRunning;
    state.wasRunning = !!status.running;
    setStatus(status);
    if (wasRunning && !status.running) {
      const failed = status.progress && status.progress.error;
      if (failed) toast('The run failed:\n' + String(failed).trim().split('\n').slice(-3).join('\n'), 'err');
      else toast('Run finished · summary reloaded', 'ok');
      await loadSummary();
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
  const symbol = inst.symbol || 'NQ';
  document.querySelector('.brand h1').childNodes[0].textContent = name + ' · level retrace ';
  document.querySelector('.brand .mark').textContent = inst.mark || symbol.slice(0, 2);
  document.title = name + ' · level retrace v2';
}

function renderFileSelect(files) {
  const sel = document.getElementById('fileSelect');
  if (!sel || !files.length) return;
  sel.textContent = '';
  for (const f of files) {
    const label = `${f.instrument.name} · ${f.name.replace(/\.csv$/i, '')}` +
      (f.computed ? '' : ' (not run)');
    sel.append(h('option', { value: f.name }, label));
  }
  sel.value = state.file;
}

async function onFileChange(name) {
  state.file = name;
  try { localStorage.setItem(FILE_KEY, name); } catch (err) { /* private mode */ }
  state.audit = null;
  state.auditId = null;
  state.auditToken = null;
  document.getElementById('auditRun').value = '';
  document.getElementById('auditDay').value = '';
  document.getElementById('auditBody').textContent = '';
  document.getElementById('auditSummary').textContent = '';
  document.getElementById('auditMeta').textContent = '';
  AuditChart.setData({ bars: [], rows: [], levels: [] });
  await loadFavourites();
  await loadSummary();
  await pollStatus(true);
}

async function loadSummary() {
  try {
    const data = await api(withFile('/api/strategy/summary'));
    state.summary = data;
    state.stale = !!data.stale;
    const meta = data.meta || {};
    state.instrument = data.instrument || (meta && meta.instrument) || null;
    state.decimals = state.instrument ? state.instrument.decimals : 2;
    applyBrand();
    renderFileSelect(data.files || []);
    const metaText = meta.sig
      ? `${meta.sig.file} · ${nf.format(meta.configs)} combinations · spread ${meta.spread} pts · ` +
        `${nf.format(meta.runs)} computed · built ${new Date(meta.built * 1000).toLocaleString()}`
      : `No summary.json yet for ${state.file} — run the grid to fill it.`;
    document.getElementById('dataInfo').textContent = metaText;
    document.getElementById('staleNote').textContent = '';
    if (state.stale) {
      const note = h('div', { class: 'notice' },
        `The CSV in data/ is newer than summary.json (${meta.sig ? meta.sig.file : 'unknown file'}). ` +
        'Use Run missing to bring the results up to date.');
      document.getElementById('staleNote').append(note);
    }
    if (meta.audit_day) document.getElementById('auditDay').value = meta.audit_day;
    state.rows = buildRows(data.runs || []);
    const dl = document.getElementById('runIds');
    dl.textContent = '';
    for (const row of state.rows.filter(r => r.metrics)) {
      dl.append(h('option', { value: row.id }));
    }
    renderBody();
    if (document.getElementById('tab-factors').classList.contains('active')) renderFactors();
    if (!document.getElementById('auditRun').value) {
      const withData = state.rows.filter(r => r.metrics);
      const pick = [...state.favourites].find(id => state.rows.some(r => r.id === id)) ||
        (withData.length ? withData[withData.length - 1].id : (meta.audit_run || 'sl50_tp50_ny_lveth_cont_touch_1m_serial'));
      document.getElementById('auditRun').value = pick;
    }
  } catch (err) {
    toast('Could not load summary.json: ' + err.message, 'err');
  }
}

async function loadFavourites() {
  try {
    const data = await api(withFile('/api/strategy/favourites'));
    state.favourites = new Set(data.ids || []);
  } catch (err) {
    try {
      state.favourites = new Set(JSON.parse(localStorage.getItem(favStorageKey()) || '[]'));
    } catch (e) {
      state.favourites = new Set();
    }
  }
}

/* -------------------------------------------------------------------- tabs */

function selectTab(name) {
  for (const tab of document.querySelectorAll('.tab')) tab.classList.toggle('active', tab.dataset.tab === name);
  for (const pane of document.querySelectorAll('.tabpane')) pane.classList.toggle('active', pane.id === 'tab-' + name);
  if (name === 'factors') renderFactors();
  if (name === 'audit') {
    requestAnimationFrame(() => {
      AuditChart.draw();
      const id = document.getElementById('auditRun').value.trim();
      if (id && id !== state.auditId) loadAudit();
    });
  }
}

/* -------------------------------------------------------------------- init */

const FONT_STEPS = [0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
const FONT_KEY = 'nq-font-scale-v2';

function applyFontScale(scale, save) {
  const s = Math.min(2, Math.max(0.9, Number(scale) || 1));
  state.fontScale = s;
  document.body.style.zoom = s === 1 ? '' : String(s);
  document.getElementById('fontLabel').textContent = Math.round(s * 100) + '%';
  if (save) {
    try { localStorage.setItem(FONT_KEY, String(s)); } catch (err) { /* private mode */ }
  }
  requestAnimationFrame(() => {
    if (state.audit) AuditChart.draw();
    if (state.rows.length) renderBody();
  });
}

function stepFont(dir) {
  const cur = state.fontScale || 1;
  let i = FONT_STEPS.findIndex(s => Math.abs(s - cur) < 0.001);
  if (i < 0) i = FONT_STEPS.indexOf(1);
  applyFontScale(FONT_STEPS[Math.max(0, Math.min(FONT_STEPS.length - 1, i + dir))], true);
}

function init() {
  AuditChart.init();
  buildFilters();
  renderHead();
  let savedFont = 1;
  try { savedFont = parseFloat(localStorage.getItem(FONT_KEY)) || 1; } catch (err) { /* private mode */ }
  applyFontScale(savedFont, false);

  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => selectTab(tab.dataset.tab));
  }

  document.getElementById('search').addEventListener('input', (event) => {
    state.search = event.target.value.trim().toLowerCase();
    state.shown = 300;
    renderBody();
  });
  for (const id of ['minWin', 'minPoints']) {
    document.getElementById(id).addEventListener('input', () => {
      readMinimums();
      state.shown = 300;
      renderBody();
    });
  }
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
    state.minimums = { win_rate: null, net_points: null };
    document.getElementById('search').value = '';
    document.getElementById('minWin').value = '';
    document.getElementById('minPoints').value = '';
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

  for (const [id, dir] of [['fontMinus', -1], ['fontPlus', 1]]) {
    document.getElementById(id).addEventListener('click', () => stepFont(dir));
  }
  document.getElementById('fontLabel').addEventListener('click', () => applyFontScale(1, true));

  document.getElementById('runMissingBtn').addEventListener('click', () => startRun(null, false));
  document.getElementById('runAllBtn').addEventListener('click', () => {
    const total = state.rows.length.toLocaleString('en-US');
    if (confirm(`Recompute every one of the ${total} combinations from scratch? This overwrites summary.json results. The new Include 09:30 rows are included.`)) {
      startRun(null, true);
    }
  });
  document.getElementById('runShownBtn').addEventListener('click', () => {
    const ids = state.filtered.map(r => r.id);
    if (!ids.length) { toast('No combinations pass the filters', 'err'); return; }
    if (!confirm(`Run ${nf.format(ids.length)} combinations that pass the filters? Ones already computed are skipped.`)) return;
    startRun(ids, false);
  });
  document.getElementById('refreshBtn').addEventListener('click', () => {
    loadSummary().then(() => pollStatus(true));
  });

  try { state.file = localStorage.getItem(FILE_KEY) || ''; } catch (err) { state.file = ''; }
  try {
    const savedWorkers = Number(localStorage.getItem('nq-split-workers'));
    if (savedWorkers >= 1 && savedWorkers <= 4) document.getElementById('workersInput').value = String(savedWorkers);
  } catch (err) { /* private mode */ }
  document.getElementById('fileSelect').addEventListener('change', (event) => {
    if (event.target.value && event.target.value !== state.file) onFileChange(event.target.value);
  });

  document.getElementById('auditLoadBtn').addEventListener('click', () => loadAudit());
  document.getElementById('auditTakenOnly').addEventListener('change', (event) => {
    state.auditTakenOnly = event.target.checked;
    renderAuditTable();
  });
  document.getElementById('auditTradesBtn').addEventListener('click', () => {
    const id = state.auditId || document.getElementById('auditRun').value.trim();
    if (id) downloadTrades(id);
  });
  for (const th of document.querySelectorAll('#auditTable th[data-sort]')) {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (state.auditSortKey === key) state.auditSortDir = -state.auditSortDir;
      else {
        state.auditSortKey = key;
        state.auditSortDir = key === 't' ? 1 : -1;
      }
      renderAuditTable();
    });
  }

  api('/api/strategy/files').then((fl) => {
    const files = (fl && fl.files) || [];
    const chosen = files.find(f => f.name === state.file) || files.find(f => f.default) || files[0];
    if (chosen) state.file = chosen.name;
    return loadFavourites();
  }).then(() => {
    loadSummary().then(() => pollStatus(true));
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
