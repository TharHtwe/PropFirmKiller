/*
 * IANA time-zone helpers shared by the app, the data worker and the tests.
 *
 * Timestamps are Unix seconds (UTC) everywhere. Conversion uses the runtime's
 * Intl database, so historical DST changes are handled by the platform and no
 * fixed UTC offset is ever assumed. Offsets are cached per wall-clock hour;
 * IANA transitions always happen on a whole hour at these zones.
 */

export const DEFAULT_TZ = 'America/New_York';
export const UTC = 'UTC';
export const TZ_LIST = ['America/New_York', 'America/Chicago', 'UTC'];

export const TZ_LABELS = {
  'America/New_York': 'New York',
  'America/Chicago': 'Chicago',
  UTC: 'UTC'
};

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

export function zoneLabel(tz) {
  return TZ_LABELS[tz] || tz;
}

export function normalizeZone(tz) {
  return typeof tz === 'string' && tz ? tz : DEFAULT_TZ;
}

export function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch (err) {
    return false;
  }
}

const formatters = new Map();

function formatterFor(tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
    formatters.set(tz, f);
  }
  return f;
}

function wallParts(ts, tz) {
  const out = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
  const parts = formatterFor(tz).formatToParts(new Date(Math.floor(ts) * 1000));
  for (let i = 0; i < parts.length; i++) {
    const type = parts[i].type;
    if (type !== 'literal') out[type] = Number(parts[i].value);
  }
  if (out.hour === 24) out.hour = 0;
  return out;
}

const offsetCache = new Map();
const OFFSET_CACHE_LIMIT = 40000;

export function tzOffsetSec(ts, tz) {
  const zone = normalizeZone(tz);
  const bucket = Math.floor(Math.floor(ts) / 3600);
  const key = zone + '|' + bucket;
  let offset = offsetCache.get(key);
  if (offset !== undefined) return offset;
  let p;
  if (zone === UTC) {
    const d = new Date(bucket * 3600 * 1000);
    p = {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      hour: d.getUTCHours(),
      minute: d.getUTCMinutes(),
      second: d.getUTCSeconds()
    };
  } else {
    p = wallParts(bucket * 3600, zone);
  }
  offset = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) / 1000 - bucket * 3600;
  if (offsetCache.size >= OFFSET_CACHE_LIMIT) offsetCache.clear();
  offsetCache.set(key, offset);
  return offset;
}

export function tzParts(ts, tz) {
  const zone = normalizeZone(tz);
  const t = Math.floor(ts);
  const offset = tzOffsetSec(t, zone);
  const d = new Date((t + offset) * 1000);
  const hour = d.getUTCHours();
  const minute = d.getUTCMinutes();
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour,
    minute,
    second: d.getUTCSeconds(),
    weekday: d.getUTCDay(),
    minuteOfDay: hour * 60 + minute,
    offset
  };
}

// Wall-clock date/time in a zone -> UTC seconds. Two passes settle the offset
// for instants close to a DST change.
export function tzWallToUtc(year, month, day, hour, minute, second, tz) {
  const zone = normalizeZone(tz);
  const guess = Date.UTC(year, month - 1, day, hour, minute, second || 0) / 1000;
  if (zone === UTC) return guess;
  let offset = tzOffsetSec(guess, zone);
  let ts = guess - offset;
  const offset2 = tzOffsetSec(ts, zone);
  if (offset2 !== offset) ts = guess - offset2;
  return ts;
}

export function formatOffset(offsetSec) {
  const sign = offsetSec < 0 ? '-' : '+';
  const abs = Math.abs(offsetSec);
  const h = Math.floor(abs / 3600);
  const m = Math.round((abs % 3600) / 60);
  if (h === 0 && m === 0) return 'UTC';
  return `UTC${sign}${pad2(h)}:${pad2(m)}`;
}

const abbrFormatters = new Map();
const abbrCache = new Map();

export function zoneAbbr(ts, tz) {
  const zone = normalizeZone(tz);
  if (zone === UTC) return 'UTC';
  const bucket = Math.floor(Math.floor(ts) / 3600);
  const key = zone + '|' + bucket;
  const cached = abbrCache.get(key);
  if (cached) return cached;
  let f = abbrFormatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' });
    abbrFormatters.set(zone, f);
  }
  let name = '';
  const parts = f.formatToParts(new Date(bucket * 3600 * 1000));
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].type === 'timeZoneName') name = parts[i].value;
  }
  if (abbrCache.size >= 40000) abbrCache.clear();
  abbrCache.set(key, name);
  return name;
}

export function zoneStamp(ts, tz) {
  const zone = normalizeZone(tz);
  return `${zoneLabel(zone)} · ${zoneAbbr(ts, zone)}`;
}

export function formatDate(ts, tz) {
  if (ts === null || ts === undefined || !isFinite(ts)) return '—';
  const p = tzParts(ts, tz);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

export function formatTime(ts, tz) {
  const p = tzParts(ts, tz);
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

export function formatDateTime(ts, tz) {
  if (ts === null || ts === undefined || !isFinite(ts)) return '—';
  const p = tzParts(ts, tz);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)} ${pad2(p.hour)}:${pad2(p.minute)}`;
}

// Daily and larger bars are stamped with the trading date (UTC midnight), not
// with an instant, so their label must ignore the display zone.
export function formatCalendarDate(ts) {
  if (ts === null || ts === undefined || !isFinite(ts)) return '—';
  const d = new Date(Math.round(ts) * 1000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

export function tickLabel(ts, tickType, tz, tfSec) {
  if (ts === null || ts === undefined || !isFinite(ts)) return '';
  const p = tfSec >= 86400
    ? (() => {
      const d = new Date(Math.round(ts) * 1000);
      return {
        year: d.getUTCFullYear(),
        month: d.getUTCMonth() + 1,
        day: d.getUTCDate(),
        hour: d.getUTCHours(),
        minute: d.getUTCMinutes(),
        second: d.getUTCSeconds()
      };
    })()
    : tzParts(ts, tz);
  switch (tickType) {
    case 0:
      return String(p.year);
    case 1:
      return MONTHS[p.month - 1];
    case 2:
      return `${p.day} ${MONTHS[p.month - 1]}`;
    case 3:
      return `${pad2(p.hour)}:${pad2(p.minute)}`;
    case 4:
      return `${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}`;
    default:
      return tfSec >= 86400 ? `${p.day} ${MONTHS[p.month - 1]}` : `${pad2(p.hour)}:${pad2(p.minute)}`;
  }
}

export function axisTime(ts, tz, tfSec) {
  if (tfSec >= 86400) return formatCalendarDate(ts);
  return formatDateTime(ts, tz);
}

const WALL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/;

export function parseWallClock(value, tz) {
  if (!value) return null;
  const m = WALL_RE.exec(value);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6] || 0);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  return tzWallToUtc(year, month, day, hour, minute, second, tz);
}

export function toWallClockValue(ts, tz) {
  if (ts === null || ts === undefined || !isFinite(ts)) return '';
  const p = tzParts(ts, tz);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}T${pad2(p.hour)}:${pad2(p.minute)}`;
}
