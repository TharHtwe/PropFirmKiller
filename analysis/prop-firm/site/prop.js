'use strict';

const FACTORS = [
  { key: 'sl', title: 'Stop', options: [[50, '50 points'], [100, '100 points']] },
  { key: 'tp', title: 'Target', options: [[50, '50'], [100, '100'], [150, '150'], [200, '200']] },
  { key: 'session', title: 'Session', options: [['london', 'London'], ['ny', 'New York'], ['rth', 'RTH'], ['all', 'All']] },
  { key: 'open', title: 'Cash open', options: [['skip', 'Skip 09:30'], ['keep', 'Include 09:30']] },
  { key: 'nyopen', title: 'NY open', options: [['skip', 'Skip 08:30-08:32'], ['keep', 'Include 08:30-08:32']] },
  { key: 'lvl', title: 'Levels', options: [['all', 'All hours'], ['eth', 'ETH'], ['rth', 'RTH']] },
  { key: 'typ', title: 'Type', options: [['rev', 'Reversal'], ['cont', 'Continuation']] },
  { key: 'entry', title: 'Entry', options: [['touch', 'Touch'], ['confirm', '1-minute close']] },
  { key: 'look', title: 'Lookback', options: [['1m', '1 month'], ['6m', '6 months'], ['1y', '1 year'], ['all', 'All']] },
  { key: 'tpd', title: 'Per day', options: [['every', 'Every'], ['serial', 'Serial'], ['one', 'One'], ['until', 'Until']] },
];

const COLUMNS = [
  { key: 'fav', label: 'Prop', freeze: true, title: 'Star a prop favourite for this page. It is stored separately from the Strategy star.' },
  { key: 'strat', label: 'Strategy', freeze: true, title: 'Star from the Strategy page. Clicking it saves or removes that run there and does not open the row.' },
  { key: 'id', label: 'Run', freeze: true, title: 'The combination id. Click the row for the account detail.' },
  { key: 'open', label: '09:30', title: 'RTH only. Skip drops the 09:30 New York bar. Include keeps it. On US100 the stored RTH id skips it; the id ending in _keep includes it. Other sessions show a dash.' },
  { key: 'nyopen', label: '08:30', title: 'New York session only. Skip drops the 08:30 and 08:31 New York bars and keeps 08:32. The stored id includes them; the id ending in _skip drops them. Other sessions show a dash.' },
  { key: 'lot', label: 'Lot', num: true, title: 'Lot for the stop. A 50-point stop is 0.10 lot. A 100-point stop is 0.05 lot. On US100 that is $2 and $1 per point.' },
  { key: 'trades', label: 'Trades', num: true, title: 'Trades taken by the strategy.' },
  { key: 'win_rate', label: 'Win %', num: true, title: 'Percent of trades with points above zero.' },
  { key: 'net_points', label: 'Points', num: true, title: 'Sum of trade points before the account rules.' },
  { key: 'net', label: 'Net cash', num: true, title: 'Payouts received minus fees. Profit still inside the live account is not included.' },
  { key: 'fees', label: 'Fees', num: true, title: 'Challenge fees paid. Each new account costs $22. A pass does not charge another fee.' },
  { key: 'received', label: 'Received', num: true, title: 'Payouts received, at 80% of the profit withdrawn.' },
  { key: 'recv_fees', label: 'Recv/Fees', num: true, title: 'Received divided by fees. 1 means payouts covered the fees.' },
  { key: 'challenges', label: 'Challenges', num: true, title: 'Accounts bought. A blown account is replaced on its next trade and pays the fee again.' },
  { key: 'payouts', label: 'Payouts', num: true, title: 'Times funded profit was paid out.' },
  { key: 'maxdd', label: 'Static', num: true, title: 'Times an account touched the $4,600 floor.' },
  { key: 'daily', label: 'Daily', num: true, title: 'Times an account touched that day’s 4% line.' },
  { key: 'p1', label: 'P1', num: true, title: 'Times phase 1 was passed.' },
  { key: 'p1_min', label: 'P1 min', num: true, title: 'Fewest calendar days a phase 1 pass took, from its first trade to the pass.' },
  { key: 'p1_max', label: 'P1 max', num: true, title: 'Most calendar days a phase 1 pass took, from its first trade to the pass.' },
  { key: 'p1_avg', label: 'P1 avg', num: true, title: 'Average calendar days to pass phase 1.' },
  { key: 'p2', label: 'P2', num: true, title: 'Times phase 2 was passed.' },
  { key: 'p2_min', label: 'P2 min', num: true, title: 'Fewest calendar days a phase 2 pass took, from its first trade to the pass.' },
  { key: 'p2_max', label: 'P2 max', num: true, title: 'Most calendar days a phase 2 pass took, from its first trade to the pass.' },
  { key: 'p2_avg', label: 'P2 avg', num: true, title: 'Average calendar days to pass phase 2.' },
  { key: 'cushion_net', label: 'Keep $400', num: true, title: 'Net cash if $400 is kept above the start before a payout is allowed.' },
  { key: 'csv', label: 'Trades', title: 'The saved trade file. Export builds it when it is missing.' },
];

const ID_RE = /^sl(\d+)_tp(\d+)_(london|ny|rth|all)_lv(all|eth|rth)_(rev|cont)_(touch|confirm)_(1m|6m|1y|all)_(every|serial|one|until)(?:_(skip|keep))?$/;
const PAGE = window.PROP_PAGE || {
  api: '/api/prop',
  fileKey: 'nq-prop-file-v1',
  single: false,
};
const FILE_KEY = PAGE.fileKey;
const ratioAt = COLUMNS.findIndex((col) => col.key === 'recv_fees');
const fundingColumns = [
  {
    key: 'first_days', label: 'To funded', num: true, sortFirst: 1,
    title: PAGE.single
      ? 'Calendar days from the first account’s first trade until phase 2 is passed. Days of accounts that blew before that are included.'
      : 'Median calendar days to first funded across the weekday accounts that reached it. Each weekday includes accounts that blew before that pass. Weekdays that never fund are left out of the median.',
  },
];
if (!PAGE.single) {
  fundingColumns.push({
    key: 'funded_weekdays', label: 'Funded wds', num: true,
    title: 'How many of the five weekday accounts reached funded at least once. 5 means every weekday did.',
  });
}
fundingColumns.push(
  {
    key: 'start_funded', label: 'Funded 1st', num: true,
    title: PAGE.single
      ? 'Month starts, from 1 Jan 2020, whose first result was a funded account.'
      : 'Weekday accounts, restarted on the 1st of each month from January 2020, whose first result was funded.',
  },
  {
    key: 'start_blown', label: 'Blown 1st', num: true,
    title: PAGE.single
      ? 'Month starts whose first result was a blown account.'
      : 'Weekday accounts, restarted on the 1st of each month, whose first result was blown.',
  },
  {
    key: 'start_rate', label: 'Funded %', num: true,
    title: 'Funded first divided by funded first plus blown first. Starts still open are left out.',
  },
  {
    key: 'start_earliest', label: 'Earliest', num: true, sortFirst: 1,
    title: 'Fewest calendar days from the 1st of a month until an account reaches funded.',
  });
COLUMNS.splice(ratioAt + 1, 0, ...fundingColumns);
if (PAGE.single) {
  COLUMNS.splice(COLUMNS.length - 1, 0,
    { key: 'left', label: 'Left', num: true, title: 'Profit still inside the live account. It is not part of net cash.' },
    { key: 'end_phase', label: 'End', title: 'Where the last account finished' });
}
const nf = new Intl.NumberFormat('en-US');
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

const state = {
  file: '',
  files: [],
  rows: [],
  filtered: [],
  favourites: new Set(),
  strategyFavs: new Set(),
  trades: {},
  shown: 300,
  filters: {},
  search: '',
  minimums: { win_rate: null, net_points: null, net: null, recv_fees: null },
  favOnly: false,
  stratFavOnly: false,
  hideUnrun: false,
  sortKey: 'net',
  sortDir: -1,
  status: null,
  pollTimer: null,
  wasRunning: false,
};

for (const factor of FACTORS) state.filters[factor.key] = new Set(factor.options.map((row) => row[0]));

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value == null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'text') el.textContent = value;
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else el.setAttribute(key, value === true ? '' : String(value));
    }
  }
  for (const kid of kids) {
    if (kid == null) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

function toast(message, kind) {
  const host = document.getElementById('toasts');
  const node = h('div', { class: 'toast ' + (kind || '') }, message);
  host.append(node);
  setTimeout(() => node.remove(), 4200);
}

async function api(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function withFile(url) {
  const join = url.includes('?') ? '&' : '?';
  return url + join + 'file=' + encodeURIComponent(state.file);
}

function parseId(id) {
  const match = ID_RE.exec(id);
  if (!match) return null;
  const [, sl, tp, session, lvl, typ, entry, look, tpd, open] = match;
  return { id, sl, tp, session, lvl, typ, entry, look, tpd, open: open || null };
}

function skipsCashOpen() {
  return /^US100_/i.test(state.file || '');
}

function cashOpenChoices(session) {
  return session === 'rth' && skipsCashOpen() ? ['skip', 'keep'] : ['keep'];
}

function nyOpenChoices(session) {
  return session === 'ny' && skipsCashOpen() ? ['keep', 'skip'] : ['keep'];
}

function nyOpenText(cfg) {
  if (cfg.session !== 'ny') return '—';
  return cfg.nyopen === 'skip' ? 'Skip' : 'Include';
}

function moneyText(value) {
  if (value == null || Number.isNaN(value)) return '—';
  return money.format(value);
}

function numText(value, digits) {
  if (value == null || Number.isNaN(value)) return '—';
  return nf.format(digits ? Number(value.toFixed(digits)) : value);
}

function runId(cfg) {
  const base = `sl${cfg.sl}_tp${cfg.tp}_${cfg.session}_lv${cfg.lvl}_${cfg.typ}_${cfg.entry}_${cfg.look}_${cfg.tpd}`;
  if (cfg.open === 'keep' && cfg.session === 'rth' && skipsCashOpen()) return `${base}_keep`;
  if (cfg.nyopen === 'skip' && cfg.session === 'ny' && skipsCashOpen()) return `${base}_skip`;
  return base;
}

function buildGrid(stored) {
  const rows = [];
  const byKey = {};
  for (const factor of FACTORS) byKey[factor.key] = factor.options.map((row) => row[0]);
  for (const sl of byKey.sl) for (const tp of byKey.tp) for (const session of byKey.session)
    for (const lvl of byKey.lvl) for (const typ of byKey.typ) for (const entry of byKey.entry)
      for (const look of byKey.look) for (const tpd of byKey.tpd)
        for (const open of cashOpenChoices(session))
          for (const nyopen of nyOpenChoices(session)) {
          const cfg = { sl, tp, session, open, nyopen, lvl, typ, entry, look, tpd };
          const id = runId(cfg);
          rows.push({ id, cfg, res: stored[id] || null, csv: state.trades[id] || null });
        }
  return rows;
}

function buildFilters() {
  const host = document.getElementById('filters');
  host.textContent = '';
  for (const factor of FACTORS) {
    const group = h('div', { class: 'fg' },
      h('h4', null, factor.title, h('button', {
        type: 'button',
        title: 'Toggle every option',
        onclick: () => {
          const set = state.filters[factor.key];
          if (set.size === factor.options.length) set.clear();
          else for (const [value] of factor.options) set.add(value);
          state.shown = 300;
          renderBody();
        },
      }, 'all')));
    for (const [value, label] of factor.options) {
      group.append(h('label', null,
        h('input', {
          type: 'checkbox',
          checked: state.filters[factor.key].has(value),
          onchange: (event) => {
            const set = state.filters[factor.key];
            if (event.target.checked) set.add(value); else set.delete(value);
            state.shown = 300;
            renderBody();
          },
        }),
        h('span', { text: label })));
    }
    host.append(group);
  }
  paintOutcomes(host);
}

function passes(row) {
  for (const factor of FACTORS) {
    if (!state.filters[factor.key].has(row.cfg[factor.key])) return false;
  }
  if (state.search && !row.id.includes(state.search.trim().toLowerCase())) return false;
  if (state.favOnly && !state.favourites.has(row.id)) return false;
  if (state.stratFavOnly && !state.strategyFavs.has(row.id)) return false;
  if (state.hideUnrun && !row.res) return false;
  return meetsMinimums(row);
}

function parseMinimum(value) {
  const text = String(value == null ? '' : value).trim();
  if (text === '' || text === '-' || text === '.' || text === '-.') return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function passDays(account, phase, stat) {
  const row = account && account.pass && account.pass[phase];
  const calendar = row && row.calendar;
  if (!calendar || calendar[stat] == null) return null;
  return calendar[stat];
}

function feeMultiple(account) {
  if (!account || !(account.fees > 0) || account.received == null) return null;
  return account.received / account.fees;
}

function readMinimums() {
  state.minimums.win_rate = parseMinimum(document.getElementById('minWin').value);
  state.minimums.net_points = parseMinimum(document.getElementById('minPoints').value);
  state.minimums.net = parseMinimum(document.getElementById('minCash').value);
  state.minimums.recv_fees = parseMinimum(document.getElementById('minRatio').value);
}

function meetsMinimums(row) {
  const win = state.minimums.win_rate;
  const points = state.minimums.net_points;
  const cash = state.minimums.net;
  const ratio = state.minimums.recv_fees;
  if (win == null && points == null && cash == null && ratio == null) return true;
  const res = row.res;
  if (!res || res.error) return false;
  if (win != null && (res.win_rate == null || res.win_rate < win)) return false;
  if (points != null && (res.net_points == null || res.net_points < points)) return false;
  if (cash != null) {
    const net = res.account ? res.account.net : null;
    if (net == null || net < cash) return false;
  }
  if (ratio != null) {
    const multiple = feeMultiple(res.account);
    if (multiple == null || multiple < ratio) return false;
  }
  return true;
}

function sortValue(row, key) {
  if (key === 'id') return row.id;
  if (key === 'open') return row.cfg.open;
  if (key === 'nyopen') return row.cfg.session === 'ny' ? row.cfg.nyopen : '';
  if (key === 'csv') return row.csv ? 1 : 0;
  if (key === 'fav') return state.favourites.has(row.id) ? 1 : 0;
  if (key === 'strat') return state.strategyFavs.has(row.id) ? 1 : 0;
  const res = row.res;
  if (!res || res.error) return null;
  if (key === 'recv_fees') return feeMultiple(res.account);
  if (key === 'start_funded') return res.starts ? res.starts.funded : null;
  if (key === 'start_blown') return res.starts ? res.starts.blown : null;
  if (key === 'start_rate') {
    const starts = res.starts;
    const decided = starts ? starts.funded + starts.blown : 0;
    return decided ? (100 * starts.funded) / decided : null;
  }
  if (key === 'start_earliest') return res.starts && res.starts.funded_days ? res.starts.funded_days.min : null;
  const passKey = /^(p[12])_(min|max|avg)$/.exec(key);
  if (passKey) return passDays(res.account, passKey[1], passKey[2]);
  if (key === 'net' || key === 'fees' || key === 'received' || key === 'challenges' || key === 'payouts' || key === 'maxdd' || key === 'daily' || key === 'p1' || key === 'p2' || key === 'left' || key === 'end_phase' || key === 'first_days' || key === 'funded_weekdays') {
    return res.account ? res.account[key] : null;
  }
  return res[key];
}

function freezeAttrs(col, index) {
  if (!col.freeze) return { class: col.num ? 'num' : '' };
  const last = COLUMNS.filter((item) => item.freeze).length - 1;
  return {
    class: 'freeze' + (index === last ? ' freeze-end' : ''),
    dataset: { freeze: String(index) },
  };
}

function pinFrozen() {
  const head = document.getElementById('runsHead');
  if (!head) return;
  const frozen = [...head.children].filter((th) => th.classList.contains('freeze'));
  let left = 0;
  frozen.forEach((th, index) => {
    const px = left + 'px';
    th.style.left = px;
    document.querySelectorAll(`#runsBody td.freeze[data-freeze="${index}"]`).forEach((td) => {
      td.style.left = px;
    });
    left += th.offsetWidth;
  });
}

function renderHead() {
  const head = document.getElementById('runsHead');
  head.textContent = '';
  let frozen = 0;
  for (const col of COLUMNS) {
    const attrs = col.freeze ? freezeAttrs(col, frozen++) : { class: col.num ? 'num' : '' };
    const tone = headerTone(col.label);
    const th = h('th', { ...attrs, class: ((attrs.class || '') + ' ' + tone).trim(), text: col.label, title: col.title || null });
    if (col.key !== 'fav' && col.key !== 'csv' && col.key !== 'strat') {
      th.addEventListener('click', () => {
        if (state.sortKey === col.key) state.sortDir *= -1;
        else { state.sortKey = col.key; state.sortDir = col.sortFirst || (col.num ? -1 : 1); }
        renderBody();
      });
    }
    head.append(th);
  }
  requestAnimationFrame(pinFrozen);
}

function cell(text, num, cls) {
  return h('td', { class: (num ? 'num ' : '') + (cls || ''), text });
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

function heads(items) {
  return items.map((item) => Array.isArray(item)
    ? h('th', { text: item[0], title: item[1] })
    : h('th', { text: item }));
}

function renderDetail(res) {
  const account = res.account;
  const single = account.weekdays.length === 1 && account.weekdays[0].weekday === 'Account';
  const week = h('table');
  const headItems = single
    ? [['Account', 'The one account traded every weekday.'], ['Trades', 'Trades taken.'], ['Points', 'Sum of trade points.'], ['Net', 'Payouts received minus fees.'], ['Bought', 'Accounts bought.'], ['Payouts', 'Times funded profit was paid.'], ['Static', 'Times the $4,600 floor was touched.'], ['Daily', 'Times the 4% daily line was touched.'], ['End', 'Phase of the last account, or blown.'], ['Left', 'Profit still inside the live account. It is not part of net cash.']]
    : [['Weekday', 'This account trades only this New York weekday.'], ['Trades', 'Trades on this weekday.'], ['Points', 'Sum of those trade points.'], ['Net', 'Payouts received minus fees for this weekday.'], ['Challenges', 'Accounts bought for this weekday.'], ['Payouts', 'Times this weekday paid funded profit.'], ['Static', 'Times this weekday touched $4,600.'], ['Daily', 'Times this weekday touched the 4% line.'], ['To funded', 'Calendar days from this weekday’s first trade until it first reached funded, including accounts that blew. Never means it had trades and did not reach funded.'], ['End', 'Phase of this weekday’s last account, or blown.']];
  week.append(h('tr', null, ...heads(headItems)));
  for (const row of account.weekdays) {
    week.append(h('tr', null,
      h('td', { text: row.weekday }),
      cell(numText(row.trades), true),
      cell(numText(row.points, 1), true),
      cell(moneyText(row.net), true, row.net < 0 ? 'neg' : 'pos'),
      cell(numText(row.challenges), true),
      cell(numText(row.payouts), true),
      cell(numText(row.maxdd), true),
      cell(numText(row.daily), true),
      ...(single ? [] : [h('td', { text: weekdayFundedText(row, !!res.starts) })]),
      h('td', { text: row.end_phase }),
      ...(single ? [cell(moneyText(row.end_profit), true, row.end_profit < 0 ? 'neg' : 'pos')] : [])));
  }
  const years = h('table');
  years.append(h('tr', null, ...heads([
    ['Year', 'Calendar year of the fees and payouts.'],
    ['Fees', 'Challenge fees paid in that year.'],
    ['Received', 'Payouts received in that year.'],
    ['Net', 'Received minus fees for that year.'],
    ['Cumulative', 'Running sum of the yearly net.'],
  ])));
  for (const row of account.years) {
    years.append(h('tr', null,
      h('td', { text: row.year }),
      cell(moneyText(row.fees), true),
      cell(moneyText(row.received), true),
      cell(moneyText(row.net), true, row.net < 0 ? 'neg' : 'pos'),
      cell(moneyText(row.cumulative), true)));
  }
  const pass = account.pass || {};
  const passText = ['p1', 'p2'].map((key) => {
    const row = pass[key];
    if (!row || !row.n) return key.toUpperCase() + ' not passed';
    return `${key.toUpperCase()} ${row.n} passes, calendar ${row.calendar.min}–${row.calendar.max} days (avg ${row.calendar.avg})`;
  }).join(' · ');
  const lead = single
    ? `One account. Bought ${numText(account.challenges)} times. Unpaid profit still in the live account: ${moneyText(account.left)}. Lot ${res.lot} · $${res.usd_per_point} per point · stop $${res.stop_dollars} · target $${res.target_dollars}. Settled ${res.asof}. Keeping $400 above the start pays ${moneyText(res.cushion_net)}. Dropping the 3-day rule pays ${moneyText(res.no_green_net)}.`
    : `Lot ${res.lot} · $${res.usd_per_point} per point · stop $${res.stop_dollars} · target $${res.target_dollars}. Settled ${res.asof}. Keeping $400 above the start pays ${moneyText(res.cushion_net)}. Dropping the 3-day rule pays ${moneyText(res.no_green_net)}.`;
  const firstText = !res.starts ? ''
    : single
      ? (account.first_days != null
        ? `To funded: ${numText(account.first_days)} calendar days from the first account’s first trade, including accounts that blew before it.`
        : 'To funded: this run never reached a funded account.')
      : (account.funded_weekdays
        ? `To funded: median ${numText(account.first_days)} calendar days across the ${numText(account.funded_weekdays)} weekday accounts that reached funded. Each weekday’s count includes accounts that blew before that pass.`
        : 'To funded: none of the five weekday accounts reached funded.');
  return h('div', { class: 'body' },
    h('p', { text: lead }),
    h('p', { class: 'muted', text: passText }),
    firstText ? h('p', { class: 'muted', text: firstText }) : null,
    renderStarts(res.starts),
    h('h2', { text: single ? 'This account' : 'Weekday accounts' }),
    week,
    h('h2', { text: 'Cash by year' }),
    years);
}

function appendFundingCells(tr, res, account) {
  const starts = res && res.starts;
  const decided = starts ? starts.funded + starts.blown : 0;
  const rate = decided ? (100 * starts.funded) / decided : null;
  const earliest = starts && starts.funded_days ? starts.funded_days.min : null;
  tr.append(cell(account && account.first_days != null ? numText(account.first_days) : '—', true));
  if (!PAGE.single) tr.append(cell(account && account.funded_weekdays != null ? numText(account.funded_weekdays) : '—', true));
  tr.append(cell(starts ? numText(starts.funded) : '—', true));
  tr.append(cell(starts ? numText(starts.blown) : '—', true));
  tr.append(cell(rate == null ? '—' : numText(rate, 1), true));
  tr.append(cell(earliest == null ? '—' : numText(earliest), true));
}

function weekdayFundedText(row, analysed) {
  if (!analysed || !row.trades) return '—';
  if (row.first_days == null) return 'Never';
  return numText(row.first_days);
}

function startCell(entry) {
  if (!entry) return h('td', { class: 'muted', text: '—' });
  const result = entry[0];
  const days = entry[1];
  const label = result === 'funded' ? 'Funded' : result === 'blown' ? 'Blown' : 'Open';
  return h('td', {
    class: result === 'funded' ? 'pos' : result === 'blown' ? 'neg' : '',
    text: days == null ? label : `${label} ${days}`,
  });
}

function renderStarts(starts) {
  if (!starts) {
    return h('p', { class: 'muted', text: 'Month-start results appear after this run is analysed again.' });
  }
  if (starts.layout === 'week') return renderWeekStarts(starts);
  const funded = starts.funded_days;
  const blown = starts.blown_days;
  const span = (row, label) => row
    ? `${label} in ${row.min}–${row.max} days (avg ${row.avg}).`
    : '';
  const summary = `From 1 Jan 2020, each month starts a new account and stops at the first funded or blown result. ${numText(starts.funded)} funded first, ${numText(starts.blown)} blown first, ${numText(starts.open)} still open. ${span(funded, 'Funded')} ${span(blown, 'Blown')}`.trim();
  const table = h('table');
  table.append(h('tr', null, ...heads([
    ['Month', 'The account starts on the 1st of this month and uses only later trades.'],
    ['First result', 'Funded, blown, or still open. The check stops at the first funded or blown account.'],
    ['Days', 'Calendar days from the 1st of the month to that result. Open starts have no day count.'],
  ])));
  for (const [month, result, days] of starts.rows) {
    const label = result === 'funded' ? 'Funded' : result === 'blown' ? 'Blown' : 'Open';
    table.append(h('tr', null,
      h('td', { text: month }),
      h('td', { class: result === 'funded' ? 'pos' : result === 'blown' ? 'neg' : '', text: label }),
      cell(days == null ? '—' : numText(days), true)));
  }
  return h('div', null,
    h('h2', { text: 'First result by month' }),
    h('p', { class: 'muted', text: summary }),
    table);
}

function renderWeekStarts(starts) {
  const funded = starts.funded_days;
  const blown = starts.blown_days;
  const span = (row, label) => row
    ? `${label} in ${row.min}–${row.max} days (avg ${row.avg}).`
    : '';
  const summary = `Each month restarts the five weekday accounts. A weekday stops at its own first funded or blown result and does not buy a replacement. ${numText(starts.funded)} weekday-starts funded, ${numText(starts.blown)} blown, ${numText(starts.open)} still open. ${span(funded, 'Funded')} ${span(blown, 'Blown')}`.trim();
  const table = h('table');
  table.append(h('tr', null, ...heads([
    ['Month', 'Each weekday account starts again on the 1st and uses only its own later trades.'],
    ['Mon', 'Monday account: funded or blown, and the calendar days from the 1st. A dash means Monday had no trades from this date.'],
    ['Tue', 'Tuesday account, on the same rule as Monday.'],
    ['Wed', 'Wednesday account, on the same rule as Monday.'],
    ['Thu', 'Thursday account, on the same rule as Monday.'],
    ['Fri', 'Friday account, on the same rule as Monday.'],
  ])));
  for (const [month, , , , cells] of starts.rows) {
    table.append(h('tr', null,
      h('td', { text: month }),
      ...cells.map((entry) => startCell(entry))));
  }
  return h('div', null,
    h('h2', { text: 'First result by month' }),
    h('p', { class: 'muted', text: summary }),
    table);
}

function renderBody() {
  const rows = state.rows.filter(passes);
  rows.sort((a, b) => {
    const av = sortValue(a, state.sortKey);
    const bv = sortValue(b, state.sortKey);
    if (av == null && bv == null) return a.id < b.id ? -1 : 1;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (av < bv) return -state.sortDir;
    if (av > bv) return state.sortDir;
    return a.id < b.id ? -1 : 1;
  });
  state.filtered = rows;
  const body = document.getElementById('runsBody');
  body.textContent = '';
  const analysed = state.rows.filter((row) => row.res && row.res.account).length;
  const failed = state.rows.filter((row) => row.res && row.res.error).length;
  document.getElementById('runCount').textContent =
    `${nf.format(rows.length)} shown · ${nf.format(analysed)} analysed` +
    (failed ? ` · ${nf.format(failed)} failed` : '') +
    ` · ${nf.format(state.rows.length)} combinations · ${nf.format(state.strategyFavs.size)} strategy favourites`;
  const more = document.getElementById('moreBtn');
  more.hidden = rows.length <= state.shown;
  more.textContent = `Show 300 more (${nf.format(Math.max(0, rows.length - state.shown))} left)`;
  for (const row of rows.slice(0, state.shown)) {
    const res = row.res;
    const account = res && res.account;
    const tr = h('tr');
    const star = h('button', {
      class: 'star' + (state.favourites.has(row.id) ? ' on' : ''),
      type: 'button',
      text: state.favourites.has(row.id) ? '★' : '☆',
      onclick: (event) => { event.stopPropagation(); toggleFav(row.id); },
    });
    tr.append(h('td', freezeAttrs(COLUMNS[0], 0), star));
    const strategyStar = h('button', {
      class: 'star' + (state.strategyFavs.has(row.id) ? ' on' : ''),
      type: 'button',
      title: state.strategyFavs.has(row.id) ? 'Remove from Strategy favourites' : 'Save as a Strategy favourite',
      text: state.strategyFavs.has(row.id) ? '★' : '☆',
      onclick: (event) => { event.stopPropagation(); toggleStrategyFav(row.id); },
    });
    tr.append(h('td', freezeAttrs(COLUMNS[1], 1), strategyStar));
    tr.append(h('td', { ...freezeAttrs(COLUMNS[2], 2), class: 'left freeze freeze-end', text: row.id, title: res && res.error ? res.error : '' }));
    tr.append(cell(row.cfg.open === 'skip' ? 'Skip' : 'Include', false));
    tr.append(cell(nyOpenText(row.cfg), false));
    tr.append(cell(res ? String(res.lot) : '—', true));
    tr.append(cell(res ? numText(res.trades) : '—', true));
    tr.append(cell(res ? numText(res.win_rate, 1) : '—', true));
    tr.append(cell(res ? numText(res.net_points, 1) : '—', true, res && res.net_points < 0 ? 'neg' : 'pos'));
    tr.append(cell(account ? moneyText(account.net) : '—', true, account && account.net < 0 ? 'neg' : 'pos'));
    tr.append(cell(account ? moneyText(account.fees) : '—', true));
    tr.append(cell(account ? moneyText(account.received) : '—', true));
    const multiple = feeMultiple(account);
    tr.append(cell(multiple == null ? '—' : numText(multiple, 2), true, multiple == null ? '' : (multiple >= 1 ? 'pos' : 'neg')));
    appendFundingCells(tr, res, account);
    tr.append(cell(account ? numText(account.challenges) : '—', true));
    tr.append(cell(account ? numText(account.payouts) : '—', true));
    tr.append(cell(account ? numText(account.maxdd) : '—', true));
    tr.append(cell(account ? numText(account.daily) : '—', true));
    tr.append(cell(account ? numText(account.p1) : '—', true));
    tr.append(cell(passDays(account, 'p1', 'min') == null ? '—' : numText(passDays(account, 'p1', 'min')), true));
    tr.append(cell(passDays(account, 'p1', 'max') == null ? '—' : numText(passDays(account, 'p1', 'max')), true));
    tr.append(cell(passDays(account, 'p1', 'avg') == null ? '—' : numText(passDays(account, 'p1', 'avg'), 1), true));
    tr.append(cell(account ? numText(account.p2) : '—', true));
    tr.append(cell(passDays(account, 'p2', 'min') == null ? '—' : numText(passDays(account, 'p2', 'min')), true));
    tr.append(cell(passDays(account, 'p2', 'max') == null ? '—' : numText(passDays(account, 'p2', 'max')), true));
    tr.append(cell(passDays(account, 'p2', 'avg') == null ? '—' : numText(passDays(account, 'p2', 'avg'), 1), true));
    tr.append(cell(res ? moneyText(res.cushion_net) : '—', true));
    if (PAGE.single) {
      tr.append(cell(account ? moneyText(account.left) : '—', true));
      tr.append(cell(account && account.end_phase ? account.end_phase : '—', false));
    }
    const csv = h('button', {
      class: 'btn ghost small',
      type: 'button',
      text: row.csv ? 'CSV' : 'Export',
      onclick: (event) => { event.stopPropagation(); saveTrades(row); },
    });
    tr.append(h('td', null, csv));
    tr.addEventListener('click', () => {
      const next = tr.nextElementSibling;
      if (next && next.classList.contains('detail')) {
        next.remove();
        return;
      }
      if (!res || !res.account) return;
      const detail = h('tr', { class: 'detail' }, h('td', { colspan: String(COLUMNS.length) }, renderDetail(res)));
      tr.after(detail);
      paintOutcomes(detail);
    });
    body.append(tr);
  }
  paintOutcomes(body);
  requestAnimationFrame(pinFrozen);
}

async function toggleStrategyFav(id) {
  const on = !state.strategyFavs.has(id);
  if (on) state.strategyFavs.add(id); else state.strategyFavs.delete(id);
  renderBody();
  try {
    await api('/api/strategy/favourites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, favourite: on, file: state.file }),
    });
  } catch (err) {
    if (on) state.strategyFavs.delete(id); else state.strategyFavs.add(id);
    renderBody();
    toast(err.message, 'err');
  }
}

async function toggleFav(id) {
  const on = !state.favourites.has(id);
  if (on) state.favourites.add(id); else state.favourites.delete(id);
  renderBody();
  try {
    await api(PAGE.api + '/favourites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, favourite: on, file: state.file }),
    });
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function saveTrades(row) {
  try {
    if (!row.csv) {
      toast('Exporting the trade CSV from the strategy engine…', 'ok');
      await api('/api/strategy/trades', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ run: row.id, file: state.file }),
      });
      row.csv = true;
    }
    window.open(withFile('/api/strategy/trades?run=' + encodeURIComponent(row.id) + '&download=1'), '_blank', 'noopener');
    renderBody();
  } catch (err) {
    toast(err.message, 'err');
  }
}

function expectedLot(sl) {
  return Number(sl) === 100 ? 0.05 : 0.1;
}

function stale(row) {
  if (!row.res || row.res.error) return true;
  if (row.res.lot !== expectedLot(row.cfg.sl)) return true;
  if (!row.csv) return false;
  const sig = row.res.sig || {};
  return sig.size !== row.csv.size || sig.mtime !== row.csv.mtime;
}

function workerCount() {
  const input = document.getElementById('workersInput');
  const n = Math.trunc(Number(input.value));
  const workers = Math.min(4, Math.max(1, Number.isFinite(n) ? n : 2));
  input.value = String(workers);
  try { localStorage.setItem('nq-split-workers', String(workers)); } catch (err) { /* private mode */ }
  return workers;
}

async function startRun(ids, force) {
  if (!ids.length) { toast('Nothing to run', 'ok'); return; }
  try {
    const res = await api(PAGE.api + '/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: state.file, ids, force: !!force, workers: workerCount() }),
    });
    toast(res.label || 'Started', 'ok');
    poll(true);
  } catch (err) {
    toast(err.message, 'err');
  }
}

function runMissing() {
  const ids = state.rows.filter(stale).map((row) => row.id);
  if (!ids.length) { toast(PAGE.single ? 'Every combination already has a current one-account result' : 'Every combination already has a current prop result', 'ok'); return; }
  if (!confirm(`Analyse ${nf.format(ids.length)} combinations? A missing trade CSV is exported first. The full grid takes a long time.`)) return;
  startRun(ids, false);
}

function runFiltered() {
  const ids = state.filtered.filter(stale).map((row) => row.id);
  if (!ids.length) { toast('The filtered combinations are already analysed', 'ok'); return; }
  if (!confirm(`Analyse ${nf.format(ids.length)} filtered combinations? Finished ones are skipped.`)) return;
  startRun(ids, false);
}

function runAll() {
  const ids = state.rows.map((row) => row.id);
  if (!ids.length) { toast('No combinations to run', 'err'); return; }
  if (!confirm(`Recompute all ${nf.format(ids.length)} combinations? This overwrites stored results and can take many hours when trade CSVs still need exporting.`)) return;
  startRun(ids, true);
}

function renderStatus(status) {
  state.status = status;
  const running = status && status.running;
  document.getElementById('statusDot').className = 'dot' + (running ? ' on' : '');
  const job = status && status.job;
  const progress = status && status.progress;
  let text = 'idle';
  if (running) {
    text = (job && job.label) || 'running';
    if (progress && progress.total) {
      text = `${progress.done || 0}/${progress.total}`;
      if (progress.phase) text += ' · ' + progress.phase;
      if (progress.current) text += ' · ' + progress.current;
    }
  } else if (progress && progress.total && (progress.done || 0) < progress.total) {
    text = `stopped ${progress.done || 0}/${progress.total}`;
    if (progress.current) text += ' · ' + progress.current;
  }
  document.getElementById('statusText').textContent = text;
  const wrap = document.getElementById('statusBarWrap');
  if (progress && progress.total) {
    wrap.hidden = false;
    document.getElementById('statusBar').style.width = `${Math.round(100 * (progress.done || 0) / progress.total)}%`;
  } else wrap.hidden = true;
  if (state.wasRunning && !running) loadResults().catch((err) => toast(err.message, 'err'));
  state.wasRunning = running;
}

async function poll(force) {
  try {
    renderStatus(await api(withFile(PAGE.api + '/status')));
  } catch (err) {
    if (force) toast(err.message, 'err');
  }
  clearTimeout(state.pollTimer);
  state.pollTimer = setTimeout(() => poll(false), state.wasRunning ? 2000 : 8000);
}

function renderFiles() {
  const sel = document.getElementById('fileSelect');
  sel.textContent = '';
  for (const file of state.files) {
    sel.append(h('option', { value: file.name }, `${file.instrument.name} · ${file.stem}`));
  }
  if (state.file) sel.value = state.file;
}

async function loadResults() {
  const data = await api(withFile(PAGE.api + '/results'));
  state.files = data.files || [];
  state.favourites = new Set(data.propFavourites || []);
  state.strategyFavs = new Set(data.strategyFavourites || []);
  state.trades = data.trades || {};
  renderFiles();
  const info = data.instrument && data.instrument.name ? data.instrument.name + ' · ' : '';
  document.getElementById('dataInfo').textContent =
    `${info}${state.file} · ${nf.format(state.strategyFavs.size)} strategy favourites · ${nf.format(Object.keys(data.runs || {}).length)} prop results`;
  document.getElementById('staleNote').textContent = '';
  state.rows = buildGrid(data.runs || {});
  state.shown = 300;
  renderBody();
}

async function boot() {
  const listed = await api(PAGE.api + '/files');
  state.files = listed.files || [];
  let saved = '';
  try { saved = localStorage.getItem(FILE_KEY) || ''; } catch (err) { saved = ''; }
  try {
    const savedWorkers = Number(localStorage.getItem('nq-split-workers'));
    if (savedWorkers >= 1 && savedWorkers <= 4) document.getElementById('workersInput').value = String(savedWorkers);
  } catch (err) { /* private mode */ }
  state.file = state.files.some((file) => file.name === saved) ? saved : (listed.default || (state.files[0] && state.files[0].name) || '');
  buildFilters();
  renderHead();
  window.addEventListener('resize', pinFrozen);
  document.getElementById('fileSelect').addEventListener('change', (event) => {
    state.file = event.target.value;
    try { localStorage.setItem(FILE_KEY, state.file); } catch (err) { /* private mode */ }
    loadResults().catch((err) => toast(err.message, 'err'));
  });
  document.getElementById('search').addEventListener('input', (event) => { state.search = event.target.value; state.shown = 300; renderBody(); });
  for (const id of ['minWin', 'minPoints', 'minCash', 'minRatio']) {
    document.getElementById(id).addEventListener('input', () => { readMinimums(); state.shown = 300; renderBody(); });
  }
  document.getElementById('favOnly').addEventListener('change', (event) => { state.favOnly = event.target.checked; state.shown = 300; renderBody(); });
  document.getElementById('stratFavOnly').addEventListener('change', (event) => { state.stratFavOnly = event.target.checked; state.shown = 300; renderBody(); });
  document.getElementById('hideUnrun').addEventListener('change', (event) => { state.hideUnrun = event.target.checked; state.shown = 300; renderBody(); });
  document.getElementById('moreBtn').addEventListener('click', () => { state.shown += 300; renderBody(); });
  document.getElementById('clearFilters').addEventListener('click', () => {
    for (const factor of FACTORS) state.filters[factor.key] = new Set(factor.options.map((row) => row[0]));
    state.search = '';
    state.minimums = { win_rate: null, net_points: null, net: null, recv_fees: null };
    document.getElementById('search').value = '';
    document.getElementById('minWin').value = '';
    document.getElementById('minPoints').value = '';
    document.getElementById('minCash').value = '';
    document.getElementById('minRatio').value = '';
    state.shown = 300;
    buildFilters();
    renderBody();
  });
  document.getElementById('refreshBtn').addEventListener('click', () => loadResults().catch((err) => toast(err.message, 'err')));
  document.getElementById('runMissingBtn').addEventListener('click', runMissing);
  document.getElementById('runShownBtn').addEventListener('click', runFiltered);
  document.getElementById('runAllBtn').addEventListener('click', runAll);
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((node) => node.classList.toggle('active', node === tab));
      document.querySelectorAll('.tabpane').forEach((pane) => pane.classList.toggle('active', pane.id === 'tab-' + tab.dataset.tab));
    });
  });
  if (state.file) await loadResults();
  poll(true);
}

boot().catch((err) => toast(err.message, 'err'));
