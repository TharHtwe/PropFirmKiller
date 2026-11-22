/*
 * CSV header/format detection shared by the browser worker, the Node server
 * and the tests. Supports Dukascopy epoch CSV and MetaTrader 5 tab-separated
 * exports. MT5 date/time columns are UTC; no local time zone is ever assumed.
 */

export const TF_SECONDS = Object.freeze({
  M1: 60,
  M5: 300,
  M15: 900,
  M30: 1800,
  H1: 3600,
  H4: 14400,
  D1: 86400,
  W1: 604800,
  MN1: 2592000
});

const TF_ORDER = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1', 'MN1'];

const DATETIME_NAMES = [
  'timestamp',
  'datetime',
  'date_time',
  'date time',
  'gmt time',
  'gmt',
  'open_time',
  'open time',
  'unix',
  'utc',
  'utc time'
];

const TICK_VOLUME_NAMES = ['tickvol', 'tick_volume', 'tickvolume', 'tick vol', 'tick'];
const VOLUME_NAMES = ['volume', 'vol', 'v', 'real volume', 'real_volume'];

export function cleanField(value) {
  let text = String(value == null ? '' : value).replace(/^\uFEFF/, '').trim();
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      text = text.slice(1, -1).trim();
    }
  }
  if (text.length >= 2 && text[0] === '<' && text[text.length - 1] === '>') {
    text = text.slice(1, -1).trim();
  }
  return text;
}

export function detectDelimiter(line) {
  const candidates = ['\t', ',', ';', '|'];
  let best = ',';
  let bestCount = 0;
  for (const candidate of candidates) {
    let count = 0;
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      if (line.charCodeAt(i) === 34) quoted = !quoted;
      else if (!quoted && line[i] === candidate) count++;
    }
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

export function splitFields(line, delimiter) {
  if (line.indexOf('"') === -1) return line.split(delimiter);
  const out = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      quoted = !quoted;
    } else if (!quoted && ch === delimiter) {
      out.push(field);
      field = '';
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out;
}

export function nameToCanonical(name) {
  const key = String(name).toLowerCase().trim();
  if (key === 'date' || key === 'day' || key === 'trading day') return 'date';
  if (key === 'time' || key === 'bar time' || key === 'time (utc)') return 'time';
  if (DATETIME_NAMES.indexOf(key) !== -1) return 'datetime';
  if (key === 'open' || key === 'o' || key === 'bid open') return 'open';
  if (key === 'high' || key === 'h' || key === 'bid high') return 'high';
  if (key === 'low' || key === 'l' || key === 'bid low') return 'low';
  if (key === 'close' || key === 'c' || key === 'bid close') return 'close';
  if (TICK_VOLUME_NAMES.indexOf(key) !== -1) return 'tickvol';
  if (VOLUME_NAMES.indexOf(key) !== -1) return 'volume';
  if (key === 'spread') return 'spread';
  return 'other';
}

// Numeric first field means the file has no header row.
function numericFirstField(field) {
  return /^[+\-]?\d/.test(field);
}

/*
 * Detects the layout from the first non-empty line, with or without a header.
 * Column indices are -1 when a field is absent. `volumeCol` is the column used
 * as bar volume (tick volume when the export has both).
 */
export function classifyFormat(line) {
  const delimiter = detectDelimiter(line);
  const fields = splitFields(line, delimiter).map(cleanField);
  if (numericFirstField(fields[0] || '')) return numericLayout(delimiter, fields.length);
  return headerLayout(delimiter, fields);
}

// Headerless rows. A tab file with 9 numeric columns is an MT5 export.
function numericLayout(delimiter, columnCount) {
  const mt5 = delimiter === '\t' && columnCount >= 9;
  return {
    delimiter,
    hasHeader: false,
    header: null,
    columns: null,
    columnCount,
    kind: mt5 ? 'mt5' : 'dukascopy',
    layout: mt5 ? 'date-time' : 'epoch',
    dateCol: mt5 ? 0 : -1,
    timeCol: mt5 ? 1 : -1,
    timestampCol: mt5 ? -1 : 0,
    openCol: mt5 ? 2 : 1,
    highCol: mt5 ? 3 : 2,
    lowCol: mt5 ? 4 : 3,
    closeCol: mt5 ? 5 : 4,
    tickVolCol: mt5 ? 6 : -1,
    realVolumeCol: mt5 ? 7 : -1,
    volumeCol: mt5 ? 6 : columnCount > 5 ? 5 : -1,
    spreadCol: mt5 ? 8 : -1
  };
}

function headerLayout(delimiter, fields) {
  const names = fields.map((value) => String(value).toLowerCase().trim());
  const columns = names.map(nameToCanonical);
  const indexOf = (canonical) => columns.indexOf(canonical);

  const dateCol = indexOf('date');
  const timeCol = indexOf('time');
  let timestampCol = indexOf('datetime');
  if (timestampCol < 0 && dateCol < 0 && timeCol < 0) {
    timestampCol = names.findIndex((name) => /date|time/.test(name));
  }

  const tickVolCol = indexOf('tickvol');
  const realVolumeCol = indexOf('volume');
  const hasDateAndTime = dateCol >= 0 && timeCol >= 0;
  const mt5 = delimiter === '\t' || tickVolCol >= 0 || indexOf('spread') >= 0 || hasDateAndTime;

  return {
    delimiter,
    hasHeader: true,
    header: fields,
    columns,
    columnCount: fields.length,
    kind: mt5 ? 'mt5' : 'dukascopy',
    layout: hasDateAndTime ? 'date-time' : timestampCol >= 0 ? 'datetime' : 'date-time',
    dateCol,
    timeCol,
    timestampCol,
    openCol: indexOf('open'),
    highCol: indexOf('high'),
    lowCol: indexOf('low'),
    closeCol: indexOf('close'),
    tickVolCol,
    realVolumeCol,
    volumeCol: tickVolCol >= 0 ? tickVolCol : realVolumeCol,
    spreadCol: indexOf('spread')
  };
}

function validParts(year, month, day, hour, minute, second) {
  return year >= 1000 && year <= 9999 &&
    month >= 1 && month <= 12 &&
    day >= 1 && day <= 31 &&
    hour >= 0 && hour <= 23 &&
    minute >= 0 && minute <= 59 &&
    second >= 0 && second <= 60;
}

/*
 * Parses an MT5/Dukascopy style timestamp as UTC and returns epoch seconds.
 * Accepted: "2020.01.02 01:05:00", "2020-01-02T01:05:00Z", "2020-01-02",
 * ISO strings with an explicit offset, and plain epoch seconds / milliseconds.
 */
export function parseUtcStamp(value) {
  const text = cleanField(value);
  if (!text) return NaN;
  if (/^\d{10}$|^\d{13}$|^\d{16}$|^\d{19}$/.test(text)) {
    const number = Number(text);
    if (!isFinite(number) || number <= 0) return NaN;
    return number > 1e11 ? Math.round(number / 1000) : number;
  }
  const match = /^(\d{4})([.\-\/])(\d{1,2})\2(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?/.exec(text);
  if (!match) {
    if (/z$|[+-]\d{2}:?\d{2}$/i.test(text)) {
      const parsed = Date.parse(text);
      return isFinite(parsed) ? parsed / 1000 : NaN;
    }
    return NaN;
  }
  const year = Number(match[1]);
  const month = Number(match[3]);
  const day = Number(match[4]);
  const hour = match[5] === undefined ? 0 : Number(match[5]);
  const minute = match[6] === undefined ? 0 : Number(match[6]);
  const second = match[7] === undefined ? 0 : Number(match[7]);
  const millis = match[8] === undefined ? 0 : Number((match[8] + '000').slice(0, 3));
  if (!validParts(year, month, day, hour, minute, second)) return NaN;
  let ms = Date.UTC(year, month - 1, day, hour, minute, second, millis);
  const rest = text.slice(match[0].length).trim();
  if (rest && !/^z$/i.test(rest)) {
    const offset = /^([+-])(\d{2}):?(\d{2})$/.exec(rest);
    if (!offset) return NaN;
    const sign = offset[1] === '-' ? -1 : 1;
    ms -= sign * (Number(offset[2]) * 3600 + Number(offset[3]) * 60) * 1000;
  }
  return ms / 1000;
}

// Seconds since midnight for "HH:MM" or "HH:MM:SS[.fff]".
export function parseClockSeconds(value) {
  const text = cleanField(value);
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?$/.exec(text);
  if (!match) return NaN;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = match[3] === undefined ? 0 : Number(match[3]);
  const fraction = match[4] === undefined ? 0 : Number((match[4] + '000').slice(0, 3)) / 1000;
  if (hour > 23 || minute > 59 || second > 60) return NaN;
  return hour * 3600 + minute * 60 + second + fraction;
}

// Timestamp of one row, given the columns detected by classifyFormat().
export function rowTime(fields, fmt) {
  if (fmt.dateCol >= 0 && fmt.dateCol < fields.length) {
    const day = parseUtcStamp(fields[fmt.dateCol]);
    if (!isFinite(day)) return NaN;
    if (fmt.timeCol < 0 || fmt.timeCol >= fields.length) return day;
    const clock = parseClockSeconds(fields[fmt.timeCol]);
    return isFinite(clock) ? day + clock : NaN;
  }
  if (fmt.timestampCol >= 0 && fmt.timestampCol < fields.length) {
    return parseUtcStamp(fields[fmt.timestampCol]);
  }
  return NaN;
}

// MT5 export names look like US100_M1_202001020105_202610291406.csv.
export function parseFileName(name) {
  const match = /^(.*?)_(M1|M5|M15|M30|H1|H4|D1|W1|MN1?)_(\d{8,14})_(\d{8,14})\.csv$/i.exec(String(name || ''));
  if (!match) return { symbol: null, timeframe: null, timeframeSec: null };
  const timeframe = match[2].toUpperCase();
  return { symbol: match[1], timeframe, timeframeSec: TF_SECONDS[timeframe] || null };
}

export function timeframeName(seconds) {
  if (!seconds || !isFinite(seconds)) return null;
  for (const name of TF_ORDER) {
    const value = TF_SECONDS[name];
    if (Math.abs(seconds - value) <= Math.max(5, value * 0.05)) return name;
  }
  return null;
}

function countDecimals(value) {
  const text = String(value == null ? '' : value).trim();
  const dot = text.indexOf('.');
  if (dot < 0) return 0;
  let end = text.length;
  while (end > dot + 1 && !/[0-9]/.test(text[end - 1])) end--;
  return Math.min(8, end - dot - 1);
}

/*
 * Row formatter for appending bars in the same shape as an existing MT5 file:
 * same column order, delimiter, decimal precision and date style.
 */
export function buildRowLayout(headerLine, sampleLine) {
  const fmt = classifyFormat(headerLine);
  const headerFields = fmt.hasHeader ? splitFields(headerLine, fmt.delimiter).map(cleanField) : [];
  const columns = fmt.hasHeader ? headerFields.map(nameToCanonical) : defaultColumns(fmt);
  const sampleFields = sampleLine ? splitFields(sampleLine, fmt.delimiter) : [];
  const decimals = columns.map((column, index) => {
    if (column === 'open' || column === 'high' || column === 'low' || column === 'close') {
      return countDecimals(sampleFields[index]);
    }
    return 0;
  });
  const sampleDate = fmt.dateCol >= 0 ? cleanField(sampleFields[fmt.dateCol]) : '';
  const sepMatch = /^\d{4}([.\-\/])/.exec(sampleDate);
  const sampleTime = fmt.timeCol >= 0 ? cleanField(sampleFields[fmt.timeCol]) : '';
  return {
    delimiter: fmt.delimiter,
    columns,
    decimals,
    dateSep: sepMatch ? sepMatch[1] : '.',
    hasSeconds: sampleTime.split(':').length >= 3
  };
}

function pad2(value) {
  return value < 10 ? '0' + value : String(value);
}

function defaultColumns(fmt) {
  if (fmt.kind === 'mt5' && fmt.layout === 'date-time') {
    return ['date', 'time', 'open', 'high', 'low', 'close', 'tickvol', 'volume', 'spread'];
  }
  return ['datetime', 'open', 'high', 'low', 'close', 'volume'];
}

export function formatRow(layout, bar) {
  const when = new Date(Math.round(bar.t) * 1000);
  const dateText = when.getUTCFullYear() + layout.dateSep +
    pad2(when.getUTCMonth() + 1) + layout.dateSep + pad2(when.getUTCDate());
  const timeText = pad2(when.getUTCHours()) + ':' + pad2(when.getUTCMinutes()) +
    (layout.hasSeconds ? ':' + pad2(when.getUTCSeconds()) : '');
  const parts = layout.columns.map((column, index) => {
    if (column === 'date') return dateText;
    if (column === 'time') return timeText;
    if (column === 'datetime') return dateText + ' ' + timeText;
    if (column === 'open') return Number(bar.o).toFixed(layout.decimals[index]);
    if (column === 'high') return Number(bar.h).toFixed(layout.decimals[index]);
    if (column === 'low') return Number(bar.l).toFixed(layout.decimals[index]);
    if (column === 'close') return Number(bar.c).toFixed(layout.decimals[index]);
    if (column === 'tickvol') return String(Math.round(Number(bar.tick_volume) || 0));
    if (column === 'volume') return String(Math.round(Number(bar.real_volume) || 0));
    if (column === 'spread') return String(Math.round(Number(bar.spread) || 0));
    return '0';
  });
  return parts.join(layout.delimiter);
}
