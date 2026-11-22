export const TF_IDS = ['1m', '3m', '5m', '15m', '30m', '1h', '4h', '1D', '1W', '1M'];

/*
 * One price per CSV prefix, mirroring analysis/nasdaq-level-retrace-v2/config.py.
 * decimals is how many digits the feed actually carries; point is what the
 * strategy calls one point (0.0001 = 1 pip on GBPUSD, so 50 points = 0.0050).
 */
const INSTRUMENTS = {
  US100: { name: 'US100 (Nasdaq)', short: 'US100', mark: 'NQ', decimals: 2, point: 1 },
  GBPUSD: { name: 'GBPUSD', short: 'GBPUSD', mark: 'GP', decimals: 5, point: 0.0001 },
  XAUUSD: { name: 'XAUUSD (Gold)', short: 'XAUUSD', mark: 'AU', decimals: 2, point: 0.1 }
};

export function instrumentFor(fileName) {
  const stem = String(fileName || '').replace(/\.csv$/i, '');
  const symbol = (stem.split('_')[0] || 'CSV').toUpperCase();
  const spec = INSTRUMENTS[symbol];
  if (spec) return Object.assign({ symbol }, spec);
  return {
    symbol,
    name: symbol,
    short: symbol,
    mark: symbol.slice(0, 2),
    decimals: 2,
    point: 1
  };
}

let priceDecimals = 2;

export function setPriceDecimals(value) {
  const n = Math.round(Number(value));
  priceDecimals = isFinite(n) ? Math.max(0, Math.min(8, n)) : 2;
}

export function getPriceDecimals() {
  return priceDecimals;
}

export function fmtPrice(value) {
  if (value === null || value === undefined || !isFinite(value)) return '—';
  return Number(value).toLocaleString('en-US', {
    minimumFractionDigits: priceDecimals,
    maximumFractionDigits: priceDecimals
  });
}

export function fmtPriceSigned(value) {
  if (value === null || value === undefined || !isFinite(value)) return '—';
  const s = fmtPrice(Math.abs(value));
  return (value > 0 ? '+' : value < 0 ? '-' : '') + s;
}

export function fmtVolume(value) {
  if (value === null || value === undefined || !isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1e9) return (value / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return (value / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return (value / 1e3).toFixed(2) + 'K';
  if (abs >= 10) return value.toFixed(0);
  return value.toFixed(3);
}

export function fmtInt(value) {
  if (!isFinite(value)) return '0';
  return Math.round(value).toLocaleString('en-US');
}

export function fmtBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

export function hexToRgba(hex, alpha) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
  if (!m) return `rgba(41, 98, 255, ${alpha})`;
  const r = parseInt(m[1], 16);
  const g = parseInt(m[2], 16);
  const b = parseInt(m[3], 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function debounce(fn, ms) {
  let t = 0;
  return function debounced(...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), ms);
  };
}
