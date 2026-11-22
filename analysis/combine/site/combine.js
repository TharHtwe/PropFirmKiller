"use strict";

const $ = (id) => document.getElementById(id);
const SESSION_LABEL = { london: "London", ny: "New York", rth: "New York RTH" };
const CHECK = { london: "useLondon", ny: "useNy", rth: "useRth" };

const COLS = [
  { key: "id", label: "Sessions", title: "Which of the three sessions this row trades. Each session still takes one continuation a day." },
  { key: "trades", label: "Trades", title: "Trades on the strategy account. A news-day position that is split still counts as one trade.", num: true },
  { key: "win", label: "Win %", title: "Share of strategy-account trades whose lot-weighted points are above zero.", num: true },
  { key: "points", label: "Points", title: "Lot-weighted points on the strategy account. Half a lot counts as half the price move. This account starts at $5,000 and does not reset.", num: true },
  { key: "pf", label: "PF", title: "Profit factor of the strategy-account points. Gross win divided by gross loss.", num: true },
  { key: "exp", label: "Exp", title: "Average lot-weighted points per strategy-account trade.", num: true },
  { key: "dd", label: "Max DD", title: "Largest peak-to-trough drop of the strategy-account point curve.", num: true },
  { key: "propNet", label: "Prop net", title: "Five weekday accounts. Payouts received minus challenge fees. Unpaid profit still in an open account is not included.", num: true },
  { key: "propRatio", label: "Prop recv/fees", title: "Five-account payouts divided by fees. 1 means the payouts covered the fees.", num: true },
  { key: "propFunded", label: "Prop funded %", title: "Of the five-account month starts that finished, the share that reached funded before blowing. Open months are left out.", num: true },
  { key: "propDays", label: "Prop to funded", title: "Median calendar days from the first trade to the first funded account, across weekdays that did reach funded.", num: true, asc: true },
  { key: "p2Net", label: "Prop2 net", title: "One account traded every day. Payouts received minus challenge fees.", num: true },
  { key: "p2Ratio", label: "Prop2 recv/fees", title: "One-account payouts divided by fees.", num: true },
  { key: "p2Funded", label: "Prop2 funded %", title: "Of the one-account month starts that finished, the share that reached funded before blowing.", num: true },
  { key: "p2Days", label: "Prop2 to funded", title: "Calendar days from that account's first trade until phase 2 is passed the first time, including earlier blown challenges.", num: true, asc: true },
];

let state = { runs: {}, news: null, file: "" };

function headerTone(label) {
  const low = String(label || "").toLowerCase();
  if (low === "sl" || /\b(blown|blow|blows|stop|stops|loss|losses|gap|fail|fails)\b/.test(low)) return "neg";
  if (low === "tp" || /\b(funded|target|targets|payout|payouts|win|wins|pass|passes)\b/.test(low)) return "pos";
  return "";
}

function outcomeClass(token) {
  const neg = new Set(["sl", "blown", "blow", "blows", "blowing", "stop", "stops", "stopped", "gap", "loss", "losses", "fail", "fails", "failed"]);
  const pos = new Set(["tp", "funded", "target", "targets", "payout", "payouts", "win", "wins", "safe", "pass", "passes", "passed"]);
  const parts = String(token || "").toLowerCase().split("-");
  if (parts.some((part) => neg.has(part))) return "neg";
  if (parts.some((part) => pos.has(part))) return "pos";
  return "";
}

function paintOutcomes(root) {
  if (!root) return;
  const word = /[A-Za-z]+(?:-[A-Za-z]+)*/g;
  const nodes = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const parent = node.parentElement;
    if (!parent || parent.closest("code, .pos, .neg, .badge")) continue;
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
      const span = document.createElement("span");
      span.className = cls;
      span.textContent = match[0];
      frag.append(span);
      last = match.index + match[0].length;
    }
    if (!hit) continue;
    if (last < text.length) frag.append(document.createTextNode(text.slice(last)));
    parent.replaceChild(frag, node);
  }
}
let sortKey = "points";
let sortDir = -1;
let openId = null;
let poll = null;

function num(value, digits) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return null;
  return Number(value).toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

function money(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
  const n = Number(value);
  const body = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  return (n < 0 ? "-$" : "$") + body;
}

function text(value) {
  return value === null || value === undefined || value === "" ? "—" : String(value);
}

function fundedPct(starts) {
  if (!starts) return null;
  const done = (starts.funded || 0) + (starts.blown || 0);
  if (!done) return null;
  return (100 * starts.funded) / done;
}

function ratio(account) {
  if (!account || !account.fees) return null;
  return account.received / account.fees;
}

function valueOf(run, key) {
  const s = run.strategy || {};
  const p = run.prop || {};
  const q = run.prop2 || {};
  switch (key) {
    case "id": return run.id || "";
    case "trades": return s.trades || 0;
    case "win": return s.win_rate || 0;
    case "points": return s.net_points || 0;
    case "pf": return s.profit_factor;
    case "exp": return s.expectancy;
    case "dd": return s.max_drawdown;
    case "propNet": return p.net;
    case "propRatio": return ratio(p);
    case "propFunded": return fundedPct(p.starts);
    case "propDays": return p.first_days;
    case "p2Net": return q.net;
    case "p2Ratio": return ratio(q);
    case "p2Funded": return fundedPct(q.starts);
    case "p2Days": return q.first_days;
    default: return null;
  }
}

function shown(run) {
  return (run.sessions || []).every((session) => $(CHECK[session]).checked);
}

function paintCell(key, run) {
  const value = valueOf(run, key);
  if (key === "id") {
    return (run.labels || []).map((label) => `<span class="chip">${label}</span>`).join("");
  }
  if (value === null || value === undefined) return "—";
  if (key === "win" || key === "propFunded" || key === "p2Funded") return num(value, 1) + "%";
  if (key === "propRatio" || key === "p2Ratio") return num(value, 2);
  if (key === "propNet" || key === "p2Net") {
    const cls = value > 0 ? "up" : value < 0 ? "down" : "";
    return `<span class="${cls}">${money(value)}</span>`;
  }
  if (key === "points" || key === "exp") {
    const cls = value > 0 ? "up" : value < 0 ? "down" : "";
    return `<span class="${cls}">${num(value, key === "exp" ? 2 : 1)}</span>`;
  }
  if (key === "pf") return num(value, 2);
  if (key === "dd" || key === "propDays" || key === "p2Days") return num(value, key === "dd" ? 1 : 0);
  return text(value);
}

function renderHead() {
  $("runsHead").innerHTML = COLS.map((col) => {
    const mark = col.key === sortKey ? (sortDir < 0 ? " ↓" : " ↑") : "";
    const tone = headerTone(col.label);
    const cls = [col.num ? "num" : "", tone].filter(Boolean).join(" ");
    return `<th class="${cls}" data-key="${col.key}" title="${col.title}">${col.label}${mark}</th>`;
  }).join("");
  $("runsHead").querySelectorAll("th").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.key;
      const col = COLS.find((item) => item.key === key);
      if (sortKey === key) sortDir *= -1;
      else {
        sortKey = key;
        sortDir = col && col.asc ? 1 : -1;
      }
      render();
    });
  });
}

function accountCard(title, account) {
  if (!account) return "";
  const starts = account.starts || {};
  const pass = account.pass || {};
  const p1 = (pass.p1 && pass.p1.calendar) || {};
  const p2 = (pass.p2 && pass.p2.calendar) || {};
  const days = starts.funded_days || {};
  return `<div class="card"><h3>${title}</h3>
    <p>Trades ${text(account.trades)} · win ${text(account.win_rate)}% · points ${text(account.points)}</p>
    <p>Net ${money(account.net)} · fees ${money(account.fees)} · received ${money(account.received)} · challenges ${text(account.challenges)} · payouts ${text(account.payouts)}</p>
    <p>Phase 1 passes ${text(account.p1)} · days ${text(p1.min)}–${text(p1.max)} avg ${text(p1.avg)}. Phase 2 passes ${text(account.p2)} · days ${text(p2.min)}–${text(p2.max)} avg ${text(p2.avg)}.</p>
    <p>Daily blows ${text(account.daily)} · max-loss blows ${text(account.maxdd)} · funded blows ${text(account.funded_blow)}. Cushion net ${money(account.cushion_net)} · no-green net ${money(account.no_green_net)}.</p>
    <p>Month starts: funded ${text(starts.funded)} · blown ${text(starts.blown)} · open ${text(starts.open)}. Funded days ${text(days.min)}–${text(days.max)} avg ${text(days.avg)}. To funded ${text(account.first_days)}. Funded weekdays ${text(account.funded_weekdays)}. Left ${money(account.left)}. End ${text(account.end_phase)}.</p>
  </div>`;
}

function miniTable(headers, rows) {
  if (!rows || !rows.length) return "<p>—</p>";
  return `<div class="scroll"><table class="mini"><thead><tr>${headers.map((head) => `<th title="${head[1]}">${head[0]}</th>`).join("")}</tr></thead><tbody>
    ${rows.join("")}</tbody></table></div>`;
}

function detail(run) {
  const s = run.strategy || {};
  const sessions = Object.entries(s.sessions || {}).map(([key, row]) =>
    `<tr><td>${SESSION_LABEL[key] || key}</td><td>${row.trades}</td><td>${num(row.win_rate, 1)}%</td><td>${num(row.points, 1)}</td></tr>`
  );
  const years = (s.years || []).map((row) =>
    `<tr><td>${row.year}</td><td>${row.trades}</td><td>${num(row.win_rate, 1)}%</td><td>${num(row.points, 1)}</td></tr>`
  );
  const news = run.news || {};
  const configs = Object.entries(run.configs || {}).map(([key, id]) => `<li>${SESSION_LABEL[key]}: <code>${id}</code></li>`).join("");
  const week = ((run.prop || {}).weekdays || []).map((row) =>
    `<tr><td>${row.weekday}</td><td>${row.trades}</td><td>${num(row.points, 1)}</td><td>${money(row.net)}</td><td>${text(row.p1)}</td><td>${text(row.p2)}</td><td>${text(row.first_days)}</td><td>${text(row.end_phase)}</td></tr>`
  );
  const propMonths = monthRows(run.prop && run.prop.starts);
  const oneMonths = monthRows(run.prop2 && run.prop2.starts);
  return `<tr class="detail-row"><td colspan="${COLS.length}"><div class="detail">
    <ul>${configs}</ul>
    <div class="grid2">
      <div class="card"><h3>Strategy account</h3>
        <p>Hold avg ${text(s.hold && s.hold.avg_bars)} bars · median ${text(s.hold && s.hold.median_bars)} · max ${text(s.hold && s.hold.max_bars)}.</p>
        <p>Targets ${text(s.targets)} · stops ${text(s.stops)} · other exits ${text(s.forced)}. Longs ${text(s.longs)} (${num(s.long_net, 1)}) · shorts ${text(s.shorts)} (${num(s.short_net, 1)}).</p>
        <p>Avg win ${text(s.avg_win)} · avg loss ${text(s.avg_loss)} · payoff ${text(s.payoff)}. Longest win streak ${text(s.streaks && s.streaks.longest_win)} · loss streak ${text(s.streaks && s.streaks.longest_loss)}.</p>
        <p>News trades ${text(s.news_trades)}. Halves ${text(news.halves)} · closed at 08:27 through the line ${text(news.flat_half)} · 100-point close at 08:32 ${text(news.take_100)} · through the line at 08:32 ${text(news.flat_decide)} · later target ${text(news.targets)} · later stop ${text(news.stops)} · gap through the stop ${text(news.gaps)}.</p>
      </div>
      ${accountCard("Prop firm · five weekday accounts", run.prop)}
      ${accountCard("Prop firm 2 · one account", run.prop2)}
    </div>
    <h3>Points by session</h3>
    ${miniTable([["Session", "Session"], ["Trades", "Trades"], ["Win %", "Win rate"], ["Points", "Lot-weighted points"]], sessions)}
    <h3>Points by year</h3>
    ${miniTable([["Year", "Year"], ["Trades", "Trades"], ["Win %", "Win rate"], ["Points", "Lot-weighted points"]], years)}
    <h3>Five accounts by weekday</h3>
    ${miniTable([
      ["Weekday", "Weekday account"], ["Trades", "Trades"], ["Points", "Prop points"], ["Net", "Payouts minus fees"],
      ["P1", "Phase 1 passes"], ["P2", "Phase 2 passes"], ["To funded", "Days to the first funded account"], ["End", "Where that weekday account finished"],
    ], week)}
    <h3>Five-account month starts</h3>
    ${propMonths}
    <h3>One-account month starts</h3>
    ${oneMonths}
  </div></td></tr>`;
}

function monthRows(starts) {
  if (!starts || !starts.rows) return "<p>Month-start results appear after this mix is analysed.</p>";
  if (starts.layout === "week") {
    const rows = starts.rows.map((row) => {
      const cells = row[4] || [];
      const body = cells.map((cell) => cell ? `${cell[0]} ${cell[1] === null || cell[1] === undefined ? "" : cell[1]}` : "—");
      return `<tr><td>${row[0]}</td>${body.map((item) => `<td>${item}</td>`).join("")}</tr>`;
    });
    return miniTable([
      ["Month", "Month the five accounts start again"],
      ["Mon", "Monday result and calendar days"], ["Tue", "Tuesday"], ["Wed", "Wednesday"], ["Thu", "Thursday"], ["Fri", "Friday"],
    ], rows);
  }
  const rows = starts.rows.map((row) => `<tr><td>${row[0]}</td><td>${row[1]}</td><td>${text(row[2])}</td></tr>`);
  return miniTable([
    ["Month", "Month the account starts"], ["Result", "First outcome"], ["Days", "Calendar days from the 1st"],
  ], rows);
}

function render() {
  renderHead();
  const runs = Object.values(state.runs).filter(shown);
  runs.sort((a, b) => {
    const av = valueOf(a, sortKey);
    const bv = valueOf(b, sortKey);
    const an = av === null || av === undefined;
    const bn = bv === null || bv === undefined;
    if (an && bn) return String(valueOf(a, "id")).localeCompare(String(valueOf(b, "id")));
    if (an) return 1;
    if (bn) return -1;
    if (typeof av === "string" || typeof bv === "string") return sortDir * String(av).localeCompare(String(bv));
    return sortDir * (av - bv);
  });
  const note = $("staleNote");
  if (note) {
    note.innerHTML = state.stale
      ? "<p>These rows were scored before the red-folder date list. Re-run all to replace them.</p>"
      : "";
  }
  const analysed = runs.filter((run) => !run.error && run.strategy).length;
  $("runCount").textContent = `${runs.length} shown · ${analysed} analysed`;
  $("runsBody").innerHTML = runs.map((run) => {
    if (run.error) {
      return `<tr data-id="${run.id}"><td colspan="${COLS.length}">${run.id}: analysis failed. Open the row after a re-run.</td></tr>`;
    }
    const cells = COLS.map((col) => `<td class="${col.num ? "num" : ""}">${paintCell(col.key, run)}</td>`).join("");
    const extra = openId === run.id ? detail(run) : "";
    return `<tr data-id="${run.id}">${cells}</tr>${extra}`;
  }).join("");
  $("runsBody").querySelectorAll("tr[data-id]").forEach((tr) => {
    tr.addEventListener("click", () => {
      openId = openId === tr.dataset.id ? null : tr.dataset.id;
      render();
    });
  });
  paintOutcomes($("runsBody"));
}

function band(stats) {
  if (!stats || !stats.n) return "—";
  return `min ${num(stats.min, 1)} · avg ${num(stats.avg, 1)} · max ${num(stats.max, 1)} · n ${stats.n}`;
}

function renderHandling() {
  const h = state.handling;
  const root = $("handlingReport");
  if (!root) return;
  if (!h) {
    root.innerHTML = "<p>News-handling results are not stored for this file yet.</p>";
    return;
  }
  const fresh = h.fresh || {};
  const carry = h.carry || {};
  const price = h.price || {};
  const after = h.after_832 || {};
  const one = h.blows_one_account || {};
  const five = h.blows_five_accounts || {};
  const rows = (h.rows || []).map((row) =>
    `<tr><td>${row.ny_date}</td><td>${row.side}</td><td>${row.entry_minute}</td><td>${row.exit}</td><td>${num(row.points, 1)}</td><td>${num(row.adverse, 1)}</td><td>${num(row.favorable, 1)}</td><td>${num(row.after_832_30m, 1)}</td></tr>`
  );
  root.innerHTML = `
    <p>New York session only, <code>${h.config || ""}</code>. ${text(h.news_days)} high-impact days. The blocked window is 08:28 through 08:32. A trade still open at the 08:27 close is cut in half. A new entry waits until after 08:32.</p>
    <div class="grid2">
      <div class="card"><h3>High-impact days, New York only</h3>
        <p>Win rate ${text((h.news_day || {}).win_rate)}% on ${text((h.news_day || {}).trades)} trades. Points ${num((h.news_day || {}).points, 1)}. This is every New York trade whose day is high impact: closed before 08:27, cut in half at 08:27, or entered after 08:32.</p>
        <p>Entered after 08:32: ${text(fresh.trades)} trades, win rate ${text(fresh.win_rate)}%, target ${text(fresh.targets)}, stop ${text(fresh.stops)}. Those exits are the normal 50-point stop and target.</p>
        <p>Closed before 08:27: ${text((h.early || {}).trades)} trades, win rate ${text((h.early || {}).win_rate)}%.</p>
        <p>Against the open trade, until the stop or target: ${band(h.fresh_adverse)}. The stop is 50 points, so this cannot print a larger number.</p>
        <p>With the open trade: ${band(h.fresh_favorable)}.</p>
        <p>From the 08:32 close to 09:02, high and low, not capped by the stop. Against ${band(h.half_hour_against)}. With ${band(h.half_hour_with)}.</p>
        <p>News days with no New York trade: ${(h.news_days_without_trade || []).length}. ${(h.news_days_without_trade || []).join(", ") || "none"}.</p>
      </div>
      <div class="card"><h3>Still open at 08:32</h3>
        <p>Trades ${text(carry.trades)}. Win rate ${text(carry.win_rate)}%. Points ${num(carry.points, 1)}.</p>
        <p>100-point target ${text(carry.targets)} · stop ${text(carry.stops)} · gap ${text(carry.gaps)}.</p>
        <p>Points against after the 08:32 close, until the exit: ${band(h.carry_adverse)}.</p>
        <p>Points with the position after 08:32: ${band(h.carry_favorable)}.</p>
      </div>
      <div class="card"><h3>Direction from 08:32 to 09:02</h3>
        <p>Signed with that day's New York trade. A move of 10 points or more counts.</p>
        <p>With us ${text(after.with_us)} · against us ${text(after.against_us)} · inside 10 points ${text(after.flat)}.</p>
      </div>
      <div class="card"><h3>Fade before 08:30, reverse after</h3>
        <p>Before 08:30, the larger swing from the 08:00 open is at least 15 points and the 08:29 close has given back at least half of it. That is a fade. A reverse is at least 10 points the other way.</p>
        <p>Days measured ${text(price.days)} · missing bars ${text(price.skipped)}.</p>
        <p>Fade before 08:30: ${text(price.fade_before)}.</p>
        <p>Reverse on the 08:30–08:31 move: ${text(price.reverse_830)}. Fade and that reverse: ${text(price.fade_then_reverse_830)}.</p>
        <p>Reverse from the 08:32 close to 09:02: ${text(price.reverse_832)}. Fade and that reverse: ${text(price.fade_then_reverse_832)}.</p>
      </div>
      <div class="card"><h3>Account blows from a fast move</h3>
        <p>A fast blow is the 08:32 price already through the 4% line, or a later bar that gaps through the news stop. A stop filled at the 4% price is counted separately. It is the line working, not a gap.</p>
        <p>One account: fast blows after 08:30 ${text(one.fast_after_830)}. Fills at the 4% news stop ${text(one.hit_news_stop)}. The account also died ${text(one.blows)} times in the whole New York history, on ordinary days as well as news days.</p>
        <p>Five weekday accounts: fast blows after 08:30 ${text(five.fast_after_830)}. All deaths in the New York history ${text(five.blows)}.</p>
        <p>Fast dates, one account: ${one.fast_dates && one.fast_dates.length ? one.fast_dates.join(", ") : "none"}.</p>
      </div>
    </div>
    <h2>Each news-day New York result</h2>
    <div class="scroll"><table class="mini"><thead><tr>
      <th title="New York date of the entry, or the news morning for a trade carried in">Date</th>
      <th title="Buy or sell">Side</th>
      <th title="New York minute of the entry, 8:00 is 480">Minute</th>
      <th title="How the position ended">Exit</th>
      <th title="Lot-weighted points">Points</th>
      <th title="Furthest points against the position">Against</th>
      <th title="Furthest points with the position">With</th>
      <th title="08:32 close to 09:02, signed with the trade">08:32 to 09:02</th>
    </tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
  paintOutcomes(root);
}

function renderNews() {
  const news = state.news;
  if (!news) {
    $("newsSummary").innerHTML = "<p>The news-day file is not on this file yet.</p>";
    $("newsTable").innerHTML = "";
    return;
  }
  const years = (news.yearly || []).map((row) =>
    `<tr><td>${row.year}</td><td>${text(row.max_0830)}</td><td>${text(row.max_0831)}</td><td>${text(row.days)}</td></tr>`
  ).join("");
  $("newsSummary").innerHTML = `<p>${news.count} red-folder days inside this price file, ${text(news.first)} through ${text(news.last)}. The list is usd_0830_redfolder_dates_2020-2027.csv. ${text(news.outside_count)} listed dates have no bar in this file.</p>
    <h2>Red-folder days by year</h2>
    <table class="mini"><thead><tr><th>Year</th><th title="Widest 08:30 high-low on a red-folder day, in points">08:30 max</th><th title="Widest 08:31 high-low on a red-folder day, in points">08:31 max</th><th title="Red-folder days with a bar that year">Days</th></tr></thead><tbody>${years}</tbody></table>`;
  const body = (news.rows || []).map((row) =>
    `<tr><td>${row.ny_date}</td><td>${row.weekday}</td><td>${text(row.status)}</td><td>${text(row.releases)}</td><td class="num">${text(row.range_0830)}</td><td class="num">${text(row.range_0831)}</td></tr>`
  ).join("");
  $("newsTable").innerHTML = `<thead><tr>
    <th title="New York date">Date</th>
    <th title="Weekday in New York">Weekday</th>
    <th title="actual means the release happened; scheduled is a published date that has not printed yet">Status</th>
    <th title="08:30 releases on that date">Releases</th>
    <th title="08:30 high minus low, in index points">08:30</th>
    <th title="08:31 high minus low, in index points">08:31</th>
  </tr></thead><tbody>${body}</tbody>`;
}

async function load() {
  const file = $("fileSelect").value;
  const q = file ? "?file=" + encodeURIComponent(file) : "";
  const res = await fetch("/api/combine/results" + q);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Could not load results");
  state = data;
  if (!$("fileSelect").options.length) {
    $("fileSelect").innerHTML = (data.files || []).filter((file) => String(file.name).toUpperCase().startsWith("US100"))
      .map((file) => `<option value="${file.name}">${file.name}</option>`).join("");
    if (data.file) $("fileSelect").value = data.file;
  }
  $("dataInfo").textContent = `${data.instrument ? data.instrument.name : "US100"} · ${data.news ? data.news.count + " high-impact days" : "news file missing"}`;
  render();
  renderNews();
  renderHandling();
  applyStatus(data.progress || {});
}

function applyStatus(progress) {
  const running = !!progress.running;
  $("statusDot").style.background = running ? "#f2c14e" : "#26a69a";
  $("statusText").textContent = running
    ? `${progress.phase || "running"} ${progress.current || ""} · ${progress.done || 0}/${progress.total || 7}`
    : (progress.phase === "done" ? "idle · last run finished" : "idle");
  $("statusBarWrap").hidden = !running;
  if (running && progress.total) {
    $("statusBar").style.width = `${Math.round((100 * (progress.done || 0)) / progress.total)}%`;
  }
  $("runBtn").disabled = running;
  $("rerunBtn").disabled = running;
  if (running && !poll) poll = setInterval(refreshStatus, 1000);
  if (!running && poll) {
    clearInterval(poll);
    poll = null;
  }
}

async function refreshStatus() {
  const file = $("fileSelect").value;
  const res = await fetch("/api/combine/status?file=" + encodeURIComponent(file));
  const data = await res.json();
  applyStatus(data);
  if (!data.running) load().catch((err) => { $("statusText").textContent = err.message; });
}

async function start(force) {
  const res = await fetch("/api/combine/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file: $("fileSelect").value, force: !!force }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Could not start");
  $("statusText").textContent = data.label || "started";
  refreshStatus();
}

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((item) => item.classList.toggle("active", item === tab));
    document.querySelectorAll(".tabpane").forEach((pane) => pane.classList.toggle("active", pane.id === "tab-" + tab.dataset.tab));
  });
});

["useLondon", "useNy", "useRth"].forEach((id) => $(id).addEventListener("change", render));
$("fileSelect").addEventListener("change", () => load().catch((err) => { $("statusText").textContent = err.message; }));
$("runBtn").addEventListener("click", () => start(false).catch((err) => { $("statusText").textContent = err.message; }));
$("rerunBtn").addEventListener("click", () => start(true).catch((err) => { $("statusText").textContent = err.message; }));
$("refreshBtn").addEventListener("click", () => load().catch((err) => { $("statusText").textContent = err.message; }));

load().catch((err) => { $("dataInfo").textContent = err.message; });
