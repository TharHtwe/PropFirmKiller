/*
 * Streaming CSV parser used by the data worker and by the Node tests.
 * Supports Dukascopy epoch CSV and MetaTrader 5 tab-separated exports. MT5
 * date/time columns are parsed as UTC; no local time zone is ever involved.
 *
 * Rows are converted to typed arrays allocation-free, one bar at a time.
 * Daily candle bucketing is decided by the caller from the returned `calendar`
 * flag ('dukascopy' trading sessions or 'utc' calendar days).
 */

import { isOpen } from './session.mjs';
import { classifyFormat, cleanField, splitFields } from './csvFormat.mjs';

let dateYear = 0;
let dateMonth = 0;
let dateDay = 0;
let dateNext = 0;
let clockSeconds = 0;
let clockNext = 0;

function scanDate(text, i, end) {
  let year = 0;
  let digits = 0;
  while (i < end && digits < 4) {
    const code = text.charCodeAt(i);
    if (code < 48 || code > 57) return false;
    year = year * 10 + (code - 48);
    i++;
    digits++;
  }
  if (digits !== 4 || i >= end) return false;
  const sep = text.charCodeAt(i);
  if (sep !== 46 && sep !== 45 && sep !== 47) return false;
  i++;
  let month = 0;
  digits = 0;
  while (i < end && digits < 2) {
    const code = text.charCodeAt(i);
    if (code < 48 || code > 57) break;
    month = month * 10 + (code - 48);
    i++;
    digits++;
  }
  if (digits === 0 || i >= end || text.charCodeAt(i) !== sep) return false;
  i++;
  let day = 0;
  digits = 0;
  while (i < end && digits < 2) {
    const code = text.charCodeAt(i);
    if (code < 48 || code > 57) break;
    day = day * 10 + (code - 48);
    i++;
    digits++;
  }
  if (digits === 0 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  dateYear = year;
  dateMonth = month;
  dateDay = day;
  dateNext = i;
  return true;
}

function scanClock(text, i, end) {
  let hour = 0;
  let digits = 0;
  while (i < end && digits < 2) {
    const code = text.charCodeAt(i);
    if (code < 48 || code > 57) break;
    hour = hour * 10 + (code - 48);
    i++;
    digits++;
  }
  if (digits === 0 || i >= end || text.charCodeAt(i) !== 58) return false;
  i++;
  let minute = 0;
  digits = 0;
  while (i < end && digits < 2) {
    const code = text.charCodeAt(i);
    if (code < 48 || code > 57) break;
    minute = minute * 10 + (code - 48);
    i++;
    digits++;
  }
  if (digits !== 2) return false;
  let second = 0;
  if (i < end && text.charCodeAt(i) === 58) {
    i++;
    digits = 0;
    while (i < end && digits < 2) {
      const code = text.charCodeAt(i);
      if (code < 48 || code > 57) break;
      second = second * 10 + (code - 48);
      i++;
      digits++;
    }
    if (digits !== 2) return false;
    if (i < end && text.charCodeAt(i) === 46) {
      i++;
      let fraction = 0;
      let divisor = 1;
      while (i < end) {
        const code = text.charCodeAt(i);
        if (code < 48 || code > 57) break;
        fraction = fraction * 10 + (code - 48);
        divisor *= 10;
        i++;
      }
      second += fraction / divisor;
    }
  }
  if (hour > 23 || minute > 59 || second >= 61) return false;
  clockSeconds = hour * 3600 + minute * 60 + second;
  clockNext = i;
  return true;
}

export function createCsvParser(options) {
  const opts = options || {};
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;

  let cap = Math.max(4096, Math.ceil((opts.totalBytes || 0) / 42));
  let times = new Float64Array(cap);
  let open = new Float64Array(cap);
  let high = new Float64Array(cap);
  let low = new Float64Array(cap);
  let close = new Float64Array(cap);
  let volume = new Float32Array(cap);

  let n = 0;
  let prevT = -Infinity;
  let unsorted = false;
  let duplicated = false;
  let firstLine = true;
  let pending = '';
  let lastReportAt = 0;
  let kind = 'dukascopy';
  let fmt = null;
  let timeMode = null;
  let delimiter = ',';
  let maxCol = 5;
  let cols = { date: -1, time: -1, ts: 0, open: 1, high: 2, low: 3, close: 4, volume: 5 };

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

  const report = (force) => {
    if (!onProgress) return;
    const now = Date.now();
    if (!force && now - lastReportAt < 150) return;
    lastReportAt = now;
    onProgress(n);
  };

  const skipSpace = (text, start, end) => {
    let i = start;
    while (i < end) {
      const code = text.charCodeAt(i);
      if (code === 32 || code === 9 || code === 34 || code === 39) i++;
      else break;
    }
    return i;
  };

  const readNumber = (text, start, end) => {
    let i = skipSpace(text, start, end);
    let sign = 1;
    if (i < end) {
      const code = text.charCodeAt(i);
      if (code === 45) {
        sign = -1;
        i++;
      } else if (code === 43) {
        i++;
      }
    }
    let intPart = 0;
    let digits = 0;
    let code = 0;
    while (i < end && (code = text.charCodeAt(i)) >= 48 && code <= 57) {
      intPart = intPart * 10 + (code - 48);
      i++;
      digits++;
    }
    let frac = 0;
    let fracDiv = 1;
    if (i < end && text.charCodeAt(i) === 46) {
      i++;
      while (i < end && (code = text.charCodeAt(i)) >= 48 && code <= 57) {
        frac = frac * 10 + (code - 48);
        fracDiv *= 10;
        i++;
        digits++;
      }
    }
    if (digits === 0) return NaN;
    let value = intPart + frac / fracDiv;
    if (i < end && (text.charCodeAt(i) === 101 || text.charCodeAt(i) === 69)) {
      i++;
      let expSign = 1;
      if (i < end) {
        const expCode = text.charCodeAt(i);
        if (expCode === 45) {
          expSign = -1;
          i++;
        } else if (expCode === 43) {
          i++;
        }
      }
      let exp = 0;
      while (i < end && (code = text.charCodeAt(i)) >= 48 && code <= 57) {
        exp = exp * 10 + (code - 48);
        i++;
      }
      value *= Math.pow(10, expSign * exp);
    }
    return sign * value;
  };

  const parseStampField = (text, start, end) => {
    const i = skipSpace(text, start, end);
    if (i >= end) return NaN;
    const code = text.charCodeAt(i);
    if (code < 48 || code > 57) {
      let part = text.slice(i, end);
      if (part.endsWith('"') || part.endsWith("'")) part = part.slice(0, -1);
      if (/z$|[+-]\d{2}:?\d{2}$/i.test(part)) {
        const parsed = Date.parse(part);
        return isFinite(parsed) ? parsed / 1000 : NaN;
      }
      return NaN;
    }
    if (scanDate(text, i, end)) {
      let total = Date.UTC(dateYear, dateMonth - 1, dateDay) / 1000;
      let j = skipSpace(text, dateNext, end);
      if (j < end) {
        const sep = text.charCodeAt(j);
        if (sep === 84 || sep === 116 || sep === 95) j = skipSpace(text, j + 1, end);
        if (j < end && scanClock(text, j, end)) {
          total += clockSeconds;
          const k = clockNext;
          if (k < end) {
            const zone = text.charCodeAt(k);
            if (zone === 43 || zone === 45) {
              let hh = 0;
              let mm = 0;
              let p = k + 1;
              let digits = 0;
              while (p < end && digits < 2) {
                const c = text.charCodeAt(p);
                if (c < 48 || c > 57) break;
                hh = hh * 10 + (c - 48);
                p++;
                digits++;
              }
              if (p < end && text.charCodeAt(p) === 58) p++;
              digits = 0;
              while (p < end && digits < 2) {
                const c = text.charCodeAt(p);
                if (c < 48 || c > 57) break;
                mm = mm * 10 + (c - 48);
                p++;
                digits++;
              }
              total -= (zone === 45 ? -1 : 1) * (hh * 3600 + mm * 60);
            }
          }
        }
      }
      return total;
    }
    const value = readNumber(text, start, end);
    if (!isFinite(value)) return NaN;
    if (timeMode === null) timeMode = Math.abs(value) > 1e11 ? 'ms' : 's';
    return timeMode === 'ms' ? Math.round(value / 1000) : value;
  };

  const parseDateField = (text, start, end) => {
    const i = skipSpace(text, start, end);
    if (i < end && scanDate(text, i, end)) {
      return Date.UTC(dateYear, dateMonth - 1, dateDay) / 1000;
    }
    return parseStampField(text, start, end);
  };

  const parseClockField = (text, start, end) => {
    const i = skipSpace(text, start, end);
    if (i >= end) return 0;
    return scanClock(text, i, end) ? clockSeconds : NaN;
  };

  const applyLayout = (layout) => {
    fmt = layout;
    kind = layout.kind;
    delimiter = layout.delimiter;
    cols = {
      date: layout.dateCol,
      time: layout.timeCol,
      ts: layout.timestampCol,
      open: layout.openCol,
      high: layout.highCol,
      low: layout.lowCol,
      close: layout.closeCol,
      volume: layout.volumeCol
    };
    maxCol = Math.max(
      cols.ts,
      cols.date,
      cols.time,
      cols.open,
      cols.high,
      cols.low,
      cols.close,
      cols.volume
    );
  };

  const initLine = (text, start, end) => {
    const line = text.slice(start, end).replace(/^\uFEFF/, '');
    const layout = classifyFormat(line);
    applyLayout(layout);
    const firstField = cleanField(splitFields(line, layout.delimiter)[0]);
    if (/^[+\-]?\d/.test(firstField)) return true;
    if (layout.dateCol < 0 && layout.timeCol < 0 && layout.timestampCol < 0) {
      throw new Error('CSV header has no date/time column');
    }
    if (layout.openCol < 0 || layout.highCol < 0 || layout.lowCol < 0 || layout.closeCol < 0) {
      throw new Error('CSV header has no open/high/low/close columns');
    }
    return false;
  };

  const parseRow = (text, start, end) => {
    let pos = start;
    let field = 0;
    let tv = NaN;
    let ov = NaN;
    let hv = NaN;
    let lv = NaN;
    let cv = NaN;
    let vv = 0;
    let stamp = NaN;
    let day = NaN;
    let clock = NaN;
    while (field <= maxCol && pos <= end) {
      let next = text.indexOf(delimiter, pos);
      if (next === -1 || next > end) next = end;
      if (field === cols.ts) stamp = parseStampField(text, pos, next);
      else if (field === cols.date) day = parseDateField(text, pos, next);
      else if (field === cols.time) clock = parseClockField(text, pos, next);
      else if (field === cols.open) ov = readNumber(text, pos, next);
      else if (field === cols.high) hv = readNumber(text, pos, next);
      else if (field === cols.low) lv = readNumber(text, pos, next);
      else if (field === cols.close) cv = readNumber(text, pos, next);
      else if (field === cols.volume) vv = readNumber(text, pos, next);
      if (next === end) break;
      pos = next + 1;
      field++;
    }
    if (cols.date >= 0 && cols.ts < 0) {
      tv = day + (cols.time >= 0 ? clock : 0);
    } else if (cols.ts >= 0) {
      tv = stamp;
    }
    if (tv !== tv || ov !== ov || hv !== hv || lv !== lv || cv !== cv) return;
    if (!isFinite(tv) || tv <= 0) return;
    if (vv !== vv) vv = 0;
    if (n === cap) grow();
    times[n] = tv;
    open[n] = ov;
    high[n] = hv;
    low[n] = lv;
    close[n] = cv;
    volume[n] = vv;
    n++;
    if (tv < prevT) unsorted = true;
    else if (tv === prevT) duplicated = true;
    prevT = tv;
  };

  const processBlock = (text) => {
    const length = text.length;
    let pos = 0;
    while (pos < length) {
      let nl = text.indexOf('\n', pos);
      if (nl === -1) nl = length;
      let lineEnd = nl;
      if (lineEnd > pos && text.charCodeAt(lineEnd - 1) === 13) lineEnd--;
      if (lineEnd > pos) {
        const firstCode = text.charCodeAt(pos);
        if (firstCode > 32 && firstCode !== 35) {
          if (firstLine) {
            firstLine = false;
            if (initLine(text, pos, lineEnd)) parseRow(text, pos, lineEnd);
          } else {
            parseRow(text, pos, lineEnd);
          }
        }
      }
      pos = nl + 1;
    }
  };

  const detectCalendar = () => {
    if (kind === 'mt5') return 'utc';
    if (!n) return 'utc';
    const step = Math.max(1, Math.floor(n / 400));
    let inside = 0;
    let total = 0;
    for (let i = 0; i < n; i += step) {
      total++;
      if (isOpen(times[i])) inside++;
    }
    return total > 0 && inside / total >= 0.98 ? 'dukascopy' : 'utc';
  };

  return {
    push(text) {
      if (!text) return;
      pending += text;
      const cut = pending.lastIndexOf('\n');
      if (cut === -1) return;
      processBlock(pending.slice(0, cut));
      pending = pending.slice(cut + 1);
      report(false);
    },
    finish() {
      if (pending.length) {
        processBlock(pending);
        pending = '';
      }
      if (!fmt) throw new Error('CSV file has no rows');
      if (n < 1) throw new Error('No usable rows found in the CSV file');
      report(true);
      return {
        times: times.slice(0, n),
        open: open.slice(0, n),
        high: high.slice(0, n),
        low: low.slice(0, n),
        close: close.slice(0, n),
        volume: volume.slice(0, n),
        count: n,
        unsorted,
        duplicated,
        kind,
        calendar: detectCalendar(),
        format: fmt
      };
    }
  };
}
