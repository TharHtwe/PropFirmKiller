import { fmtPrice, fmtVolume } from './utils.js';
import { DEFAULT_TZ, axisTime, tickLabel } from './time.mjs';

const LC = window.LightweightCharts;

const UP_COLOR = '#26a69a';
const DOWN_COLOR = '#ef5350';
const BG = '#131722';
const GRID = '#1b2130';
const TEXT = '#b2b5be';
const BORDER = '#2a3142';
const VOL_UP = 'rgba(38, 166, 154, 0.40)';
const VOL_DOWN = 'rgba(239, 83, 80, 0.40)';

export function createChartView(container, hooks = {}) {
  const view = {
    tf: '1D',
    tfSec: 86400,
    start: 0,
    end: 0,
    times: [],
    open: [],
    high: [],
    low: [],
    close: [],
    volume: [],
    bars: [],
    volBars: []
  };
  let timeZone = DEFAULT_TZ;
  let tradeLine = null;
  let axisDecimals = 2;

  function tickFormatter(time, tickType) {
    return tickLabel(time, tickType, timeZone, view.tfSec);
  }
  function timeFormatter(time) {
    return axisTime(time, timeZone, view.tfSec);
  }
  function priceFormatter(price) {
    // Every pane axis comes through here, including the volume pane, so a
    // value far above a fractional quote is a volume tick, not a price.
    if (axisDecimals >= 3 && Math.abs(price) >= 1000 && Number.isInteger(price)) {
      return fmtVolume(price);
    }
    return fmtPrice(price);
  }

  const chart = LC.createChart(container, {
    autoSize: true,
    layout: {
      background: { type: LC.ColorType.Solid, color: BG },
      textColor: TEXT,
      fontSize: 11,
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif",
      attributionLogo: true,
      panes: { enableResize: false, separatorColor: '#20263a' }
    },
    grid: {
      vertLines: { color: GRID },
      horzLines: { color: GRID }
    },
    crosshair: {
      mode: LC.CrosshairMode.Normal,
      vertLine: {
        color: '#5a6477',
        width: 1,
        style: LC.LineStyle.Dashed,
        labelBackgroundColor: '#2c3446'
      },
      horzLine: {
        color: '#5a6477',
        width: 1,
        style: LC.LineStyle.Dashed,
        labelBackgroundColor: '#2c3446'
      }
    },
    rightPriceScale: {
      borderColor: BORDER,
      scaleMargins: { top: 0.08, bottom: 0.12 },
      entireTextOnly: false
    },
    timeScale: {
      borderColor: BORDER,
      timeVisible: true,
      secondsVisible: false,
      rightOffset: 4,
      barSpacing: 7,
      minBarSpacing: 0.12,
      tickMarkFormatter: tickFormatter
    },
    localization: {
      locale: 'en-US',
      priceFormatter,
      timeFormatter
    },
    handleScroll: {
      mouseWheel: true,
      pressedMouseMove: true,
      horzTouchDrag: true,
      vertTouchDrag: false
    },
    handleScale: {
      axisPressedMouseMove: true,
      mouseWheel: true,
      pinch: true
    }
  });

  chart.addPane();

  const candleSeries = chart.addSeries(
    LC.CandlestickSeries,
    {
      upColor: UP_COLOR,
      downColor: DOWN_COLOR,
      borderVisible: false,
      wickUpColor: UP_COLOR,
      wickDownColor: DOWN_COLOR,
      priceLineVisible: false,
      lastValueVisible: true,
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 }
    },
    0
  );

  const volumeSeries = chart.addSeries(
    LC.HistogramSeries,
    {
      priceFormat: { type: 'volume' },
      priceLineVisible: false,
      lastValueVisible: false,
      base: 0
    },
    1
  );

  volumeSeries.priceScale().applyOptions({
    borderVisible: false,
    scaleMargins: { top: 0.15, bottom: 0 },
    entireTextOnly: true
  });

  const panes = chart.panes();
  if (panes[0]) panes[0].setStretchFactor(3.6);
  if (panes[1]) panes[1].setStretchFactor(1);

  chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
    if (hooks.onViewportChange) hooks.onViewportChange();
  });

  chart.subscribeCrosshairMove((param) => {
    if (!hooks.onCrosshair) return;
    if (!param || param.time === undefined || param.logical === undefined || param.logical === null) {
      hooks.onCrosshair(null);
      return;
    }
    const index = Math.round(param.logical);
    hooks.onCrosshair(barAtLocal(index));
  });

  function barAtLocal(index) {
    if (!Number.isFinite(index) || index < 0 || index >= view.times.length) return null;
    return {
      index,
      globalIndex: view.start + index,
      time: view.times[index],
      open: view.open[index],
      high: view.high[index],
      low: view.low[index],
      close: view.close[index],
      volume: view.volume[index],
      prevClose: index > 0 ? view.close[index - 1] : view.open[index]
    };
  }

  function setFrame(frame, displayEnd) {
    const limit = Math.max(0, Math.min(displayEnd - frame.start, frame.times.length));
    const times = new Array(limit);
    const open = new Array(limit);
    const high = new Array(limit);
    const low = new Array(limit);
    const close = new Array(limit);
    const volume = new Array(limit);
    const bars = new Array(limit);
    const volBars = new Array(limit);

    for (let i = 0; i < limit; i++) {
      const t = frame.times[i];
      const o = frame.open[i];
      const h = frame.high[i];
      const l = frame.low[i];
      const c = frame.close[i];
      const v = frame.volume[i];
      times[i] = t;
      open[i] = o;
      high[i] = h;
      low[i] = l;
      close[i] = c;
      volume[i] = v;
      bars[i] = { time: t, open: o, high: h, low: l, close: c };
      volBars[i] = { time: t, value: v, color: c >= o ? VOL_UP : VOL_DOWN };
    }

    view.tf = frame.tf;
    view.tfSec = frame.tfSec;
    view.start = frame.start;
    view.end = frame.start + limit;
    view.times = times;
    view.open = open;
    view.high = high;
    view.low = low;
    view.close = close;
    view.volume = volume;
    view.bars = bars;
    view.volBars = volBars;

    candleSeries.setData(bars);
    volumeSeries.setData(volBars);
    refreshFormatters();
  }

  function reset() {
    view.start = 0;
    view.end = 0;
    view.times = [];
    view.open = [];
    view.high = [];
    view.low = [];
    view.close = [];
    view.volume = [];
    view.bars = [];
    view.volBars = [];
    candleSeries.setData([]);
    volumeSeries.setData([]);
  }

  function appendBar(bar) {
    const len = view.times.length;
    if (len && !(bar.time > view.times[len - 1])) return false;
    view.times.push(bar.time);
    view.open.push(bar.open);
    view.high.push(bar.high);
    view.low.push(bar.low);
    view.close.push(bar.close);
    view.volume.push(bar.volume);
    const candle = { time: bar.time, open: bar.open, high: bar.high, low: bar.low, close: bar.close };
    const vol = {
      time: bar.time,
      value: bar.volume,
      color: bar.close >= bar.open ? VOL_UP : VOL_DOWN
    };
    view.bars.push(candle);
    view.volBars.push(vol);
    view.end = view.start + view.times.length;
    candleSeries.update(candle);
    volumeSeries.update(vol);
    return true;
  }

  function logicalForTime(t) {
    const times = view.times;
    const n = times.length;
    if (!n) return null;
    if (t <= times[0]) return (t - times[0]) / view.tfSec;
    if (t >= times[n - 1]) return n - 1 + (t - times[n - 1]) / view.tfSec;
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (times[mid] <= t) lo = mid;
      else hi = mid;
    }
    const span = times[hi] - times[lo];
    return span > 0 ? lo + (t - times[lo]) / span : lo;
  }

  function timeForLogical(f) {
    const times = view.times;
    const n = times.length;
    if (!n || !Number.isFinite(f)) return null;
    if (f <= 0) return times[0] + f * view.tfSec;
    if (f >= n - 1) return times[n - 1] + (f - (n - 1)) * view.tfSec;
    const i = Math.floor(f);
    const frac = f - i;
    const t0 = times[i];
    const t1 = times[Math.min(i + 1, n - 1)];
    return t0 + (t1 - t0) * frac;
  }

  function getMapping() {
    const n = view.times.length;
    if (!n) return null;
    const timeScale = chart.timeScale();
    const lr = timeScale.getVisibleLogicalRange();
    let pane = null;
    try {
      pane = chart.paneSize(0);
    } catch (err) {
      pane = null;
    }
    if (!lr || !pane || !pane.width || !pane.height) return null;
    const w = pane.width;
    const h = pane.height;
    const lo = Math.ceil(lr.from);
    const hi = Math.floor(lr.to);
    if (hi - lo < 2) return null;
    const a = lo + Math.round((hi - lo) * 0.3);
    const b = lo + Math.round((hi - lo) * 0.7);
    if (b === a) return null;
    // logicalToCoordinate returns 0 for fractional logicals, so calibrate on integers
    const xa = timeScale.logicalToCoordinate(a);
    const xb = timeScale.logicalToCoordinate(b);
    if (xa === null || xb === null || xa === xb) return null;
    const scaleX = (xb - xa) / (b - a);
    if (!Number.isFinite(scaleX) || scaleX === 0) return null;
    const originX = xa - a * scaleX;

    const pTop = candleSeries.coordinateToPrice(0);
    const pBot = candleSeries.coordinateToPrice(h);
    if (pTop === null || pBot === null || pTop === pBot) return null;
    const priceSpan = pTop - pBot;

    const xForLogical = (logical) => originX + logical * scaleX;
    const xForTime = (t) => {
      const f = logicalForTime(t);
      return f === null ? null : xForLogical(f);
    };
    const yForPrice = (price) => ((pTop - price) / priceSpan) * h;
    const priceForY = (y) => pTop - (y / h) * priceSpan;
    const timeForX = (x) => timeForLogical((x - originX) / scaleX);
    const snapTimeForX = (x) => {
      const f = Math.round((x - originX) / scaleX);
      if (f < 0) return view.times[0];
      if (f >= n) return view.times[n - 1];
      return view.times[f];
    };

    return {
      paneW: w,
      paneH: h,
      left: 0,
      top: 0,
      originX,
      scaleX,
      xForLogical,
      xForTime,
      yForPrice,
      priceForY,
      timeForX,
      snapTimeForX
    };
  }

  function applyVisibleRange(from, to) {
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) return;
    try {
      chart.timeScale().setVisibleLogicalRange({ from, to });
    } catch (err) {
      /* range can be rejected while data is loading */
    }
  }

  function getSyncKey() {
    const lr = chart.timeScale().getVisibleLogicalRange();
    let pane = null;
    try {
      pane = chart.paneSize(0);
    } catch (err) {
      pane = null;
    }
    if (!lr || !pane) return '';
    const pTop = candleSeries.coordinateToPrice(0);
    const pBot = candleSeries.coordinateToPrice(pane.height);
    return (
      lr.from.toFixed(2) + '|' + lr.to.toFixed(2) + '|' + pane.width + 'x' + pane.height +
      '|' + (pTop === null ? 'n' : pTop.toFixed(3)) + '|' + (pBot === null ? 'n' : pBot.toFixed(3))
    );
  }

  function setVisibleRangeNow(from, to) {
    applyVisibleRange(from, to);
    requestAnimationFrame(() => applyVisibleRange(from, to));
  }

  function setVisibleLatest(bars) {
    const len = view.times.length;
    if (!len) return;
    const from = Math.max(-8, len - bars);
    setVisibleRangeNow(from, len + 4);
  }

  function getLogicalRange() {
    return chart.timeScale().getVisibleLogicalRange();
  }

  function getVisibleTimeRange() {
    const lr = chart.timeScale().getVisibleLogicalRange();
    if (!lr || !view.times.length) return null;
    const t1 = timeForLogical(lr.from);
    const t2 = timeForLogical(lr.to);
    if (t1 === null || t2 === null) return null;
    return [t1, t2];
  }

  function refreshFormatters() {
    chart.applyOptions({
      localization: {
        priceFormatter,
        timeFormatter: (time) => axisTime(time, timeZone, view.tfSec)
      },
      timeScale: {
        timeVisible: view.tfSec < 86400,
        secondsVisible: false,
        tickMarkFormatter: (time, tickType) => tickLabel(time, tickType, timeZone, view.tfSec)
      }
    });
  }

  function setTimeframe(tf, tfSec) {
    view.tf = tf;
    view.tfSec = tfSec;
    refreshFormatters();
  }

  function setTimezone(tz) {
    timeZone = tz;
    refreshFormatters();
  }

  function setInstrument(inst) {
    const decimals = Math.max(0, Math.min(8, Math.round(Number(inst && inst.decimals) || 2)));
    axisDecimals = decimals;
    candleSeries.applyOptions({
      priceFormat: { type: 'price', precision: decimals, minMove: Math.pow(10, -decimals) }
    });
    refreshFormatters();
  }

  function setTradeLine(price) {
    if (tradeLine) {
      candleSeries.removePriceLine(tradeLine);
      tradeLine = null;
    }
    if (price === null || price === undefined || !Number.isFinite(price)) return;
    tradeLine = candleSeries.createPriceLine({
      price,
      color: '#f2c14e',
      lineWidth: 1,
      lineStyle: LC.LineStyle.Dashed,
      axisLabelVisible: true,
      title: 'Entry'
    });
  }

  return {
    chart,
    candleSeries,
    volumeSeries,
    view,
    setFrame,
    appendBar,
    reset,
    getMapping,
    getSyncKey,
    getView: () => view,
    getBarAtLocal: barAtLocal,
    getBarAt: (globalIndex) => barAtLocal(globalIndex - view.start),
    getLastBar: () => barAtLocal(view.times.length - 1),
    setVisibleLatest,
    setVisibleRangeNow,
    applyVisibleRange,
    getLogicalRange,
    getVisibleTimeRange,
    setTimeframe,
    setTimezone,
    setInstrument,
    setTradeLine,
    refreshFormatters,
    destroy: () => chart.remove()
  };
}
