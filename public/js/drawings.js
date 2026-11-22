import { hexToRgba } from './utils.js';

export const TOOL_LABELS = {
  trend: 'Trend line',
  hline: 'Horizontal line',
  hray: 'Horizontal ray',
  vline: 'Vertical line',
  rect: 'Rectangle'
};

const DEFAULT_COLORS = {
  trend: '#2962ff',
  hline: '#f2c14e',
  hray: '#26a69a',
  vline: '#a78bfa',
  rect: '#2962ff'
};

const SINGLE_POINT = { hline: true, vline: true, hray: true };

export const MIN_WIDTH = 1;
export const MAX_WIDTH = 8;
export const DEFAULT_WIDTH = 1.5;

export function normalizeWidth(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_WIDTH;
  const clamped = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, n));
  return Math.round(clamped * 2) / 2;
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

let idCounter = 0;
function newId() {
  idCounter++;
  return 'd' + Date.now().toString(36) + idCounter.toString(36);
}

function isValidDrawing(d) {
  if (!d || typeof d.type !== 'string' || !TOOL_LABELS[d.type]) return false;
  if (!Array.isArray(d.points) || d.points.length === 0) return false;
  const need = SINGLE_POINT[d.type] ? 1 : 2;
  if (d.points.length < need) return false;
  return d.points.every((p) => p && Number.isFinite(Number(p.t)) && Number.isFinite(Number(p.p)));
}

export class DrawingLayer {
  constructor(options) {
    this.canvas = options.canvas;
    this.container = options.container;
    this.getMapping = options.getMapping;
    this.getBands = options.getBands || null;
    this.defaultWidth = normalizeWidth(options.defaultWidth);
    this.onPersist = options.onPersist || (() => {});
    this.onSelectionChange = options.onSelectionChange || (() => {});
    this.onDrawingsChange = options.onDrawingsChange || (() => {});

    this.ctx = this.canvas.getContext('2d');
    this.drawings = [];
    this.selectedId = null;
    this.hoverId = null;
    this.tool = 'pan';
    this.preview = null;
    this.drag = null;
    this.cssW = 0;
    this.cssH = 0;
    this.dpr = window.devicePixelRatio || 1;

    this.onPointerDown = this.onPointerDown.bind(this);
    this.onPointerMove = this.onPointerMove.bind(this);
    this.onPointerUp = this.onPointerUp.bind(this);
    this.onPointerLeave = this.onPointerLeave.bind(this);
    this.onDoubleClick = this.onDoubleClick.bind(this);

    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointercancel', this.onPointerUp);
    this.canvas.addEventListener('pointerleave', this.onPointerLeave);
    this.canvas.addEventListener('dblclick', this.onDoubleClick);

    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(this.container);
    this.handleResize();
    this.setTool('pan');
    this.syncKey = null;
    this.lastSyncKey = '';
    this.rafId = 0;
  }

  // Charts re-scale on data changes without emitting range events; poll a cheap
  // signature each frame so drawings stay glued to the candles after TF switches.
  startSync(keyFn) {
    this.syncKey = keyFn;
    const tick = () => {
      if (this.rafId === 0) return;
      let key = '';
      try {
        key = this.syncKey ? this.syncKey() : '';
      } catch (err) {
        key = '';
      }
      if (key && key !== this.lastSyncKey) {
        this.lastSyncKey = key;
        this.redraw();
      }
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  handleResize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    this.dpr = window.devicePixelRatio || 1;
    this.cssW = w;
    this.cssH = h;
    this.canvas.width = Math.max(1, Math.round(w * this.dpr));
    this.canvas.height = Math.max(1, Math.round(h * this.dpr));
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.redraw();
    requestAnimationFrame(() => this.redraw());
  }

  setTool(tool) {
    this.tool = tool;
    this.preview = null;
    this.drag = null;
    this.canvas.style.pointerEvents = tool === 'pan' ? 'none' : 'auto';
    this.canvas.style.cursor = tool === 'pan' ? 'default' : tool === 'select' ? 'default' : 'crosshair';
    if (tool !== 'select') {
      this.hoverId = null;
      if (this.selectedId) {
        this.selectedId = null;
        this.notifySelection();
      }
    }
    this.redraw();
  }

  load(list) {
    const arr = Array.isArray(list) ? list : [];
    this.drawings = arr.filter(isValidDrawing).map((d) => ({
      id: d.id || newId(),
      type: d.type,
      color: d.color && /^#[0-9a-f]{6}$/i.test(d.color) ? d.color : DEFAULT_COLORS[d.type],
      width: normalizeWidth(d.width),
      points: d.points.map((p) => ({ t: Math.round(Number(p.t)), p: Number(p.p) }))
    }));
    this.selectedId = null;
    this.hoverId = null;
    this.preview = null;
    this.drag = null;
    this.notifySelection();
    this.onDrawingsChange(this.drawings);
    this.redraw();
  }

  serialize() {
    return this.drawings.map((d) => ({
      id: d.id,
      type: d.type,
      color: d.color,
      width: d.width,
      points: d.points.map((p) => ({ t: p.t, p: p.p }))
    }));
  }

  getDrawings() {
    return this.drawings;
  }

  getDrawing(id) {
    return this.drawings.find((d) => d.id === id) || null;
  }

  selectById(id) {
    if (!this.getDrawing(id)) return;
    this.selectedId = id;
    this.notifySelection();
    this.redraw();
  }

  setColor(id, color) {
    const d = this.getDrawing(id);
    if (!d) return;
    d.color = color;
    this.persist();
    this.onDrawingsChange(this.drawings);
    this.redraw();
  }

  setWidth(id, width) {
    const d = this.getDrawing(id);
    if (!d) return;
    d.width = normalizeWidth(width);
    this.persist();
    this.onDrawingsChange(this.drawings);
    this.redraw();
  }

  setDefaultWidth(width) {
    this.defaultWidth = normalizeWidth(width);
  }

  remove(id) {
    const before = this.drawings.length;
    this.drawings = this.drawings.filter((d) => d.id !== id);
    if (this.drawings.length === before) return;
    if (this.selectedId === id) this.selectedId = null;
    if (this.hoverId === id) this.hoverId = null;
    this.persist();
    this.notifySelection();
    this.onDrawingsChange(this.drawings);
    this.redraw();
  }

  deleteSelected() {
    if (this.selectedId) this.remove(this.selectedId);
  }

  clear() {
    this.drawings = [];
    this.selectedId = null;
    this.hoverId = null;
    this.persist();
    this.notifySelection();
    this.onDrawingsChange(this.drawings);
    this.redraw();
  }

  hasDrawings() {
    return this.drawings.length > 0;
  }

  getSelected() {
    return this.selectedId ? this.getDrawing(this.selectedId) : null;
  }

  setDragMode(enabled) {
    this.canvas.style.pointerEvents = enabled ? 'auto' : 'none';
  }

  persist() {
    this.onPersist(this.serialize());
  }

  notifySelection() {
    this.onSelectionChange(this.getSelected());
  }

  pos(event) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  onPointerDown(event) {
    if (event.button !== 0 || this.tool === 'pan') return;
    event.preventDefault();
    try {
      this.canvas.setPointerCapture(event.pointerId);
    } catch (err) {
      /* ignore */
    }
    const { x, y } = this.pos(event);
    const m = this.getMapping();
    if (!m) return;

    if (this.tool === 'select') {
      const selected = this.getSelected();
      if (selected) {
        const handle = this.hitHandle(selected, x, y, m);
        if (handle >= 0) {
          this.beginDrag(selected, handle, x, y, m);
          return;
        }
      }
      const hit = this.hitTestTop(x, y, m);
      if (hit) {
        if (this.selectedId !== hit.id) {
          this.selectedId = hit.id;
          this.notifySelection();
        }
        this.beginDrag(hit, -1, x, y, m);
        this.redraw();
      } else if (this.selectedId) {
        this.selectedId = null;
        this.notifySelection();
        this.redraw();
      }
      return;
    }

    const start = { t: m.snapTimeForX(x), p: m.priceForY(y) };
    const type = this.tool;
    this.preview = {
      id: null,
      type,
      color: DEFAULT_COLORS[type] || '#2962ff',
      width: this.defaultWidth,
      points: SINGLE_POINT[type] ? [{ ...start }] : [{ ...start }, { ...start }]
    };
    this.redraw();
  }

  onPointerMove(event) {
    if (this.tool === 'pan') return;
    const { x, y } = this.pos(event);

    if (this.drag) {
      this.updateDrag(x, y);
      return;
    }
    if (this.preview) {
      const m = this.getMapping();
      if (!m) return;
      const t = m.snapTimeForX(x);
      const p = m.priceForY(y);
      const d = this.preview;
      if (d.type === 'hline') d.points[0].p = p;
      else if (d.type === 'vline') d.points[0].t = t;
      else if (d.type === 'hray') d.points[0] = { t, p };
      else d.points[1] = { t, p };
      this.redraw();
      return;
    }
    if (this.tool === 'select') {
      const m = this.getMapping();
      if (!m) return;
      const selected = this.getSelected();
      let cursor = 'default';
      let changed = false;
      if (selected && this.hitHandle(selected, x, y, m) >= 0) {
        cursor = 'nwse-resize';
      } else {
        const hit = this.hitTestTop(x, y, m);
        const nextHover = hit ? hit.id : null;
        if (nextHover !== this.hoverId) {
          this.hoverId = nextHover;
          changed = true;
        }
        if (hit) cursor = 'move';
      }
      this.canvas.style.cursor = cursor;
      if (changed) this.redraw();
    }
  }

  onPointerUp(event) {
    if (this.tool === 'pan') return;
    try {
      this.canvas.releasePointerCapture(event.pointerId);
    } catch (err) {
      /* ignore */
    }
    if (this.drag) {
      this.drag = null;
      this.persist();
      this.onDrawingsChange(this.drawings);
      this.redraw();
      return;
    }
    if (this.preview) {
      const d = this.preview;
      this.preview = null;
      const m = this.getMapping();
      let accept = true;
      if (m && !SINGLE_POINT[d.type]) {
        const x0 = m.xForTime(d.points[0].t);
        const x1 = m.xForTime(d.points[1].t);
        const y0 = m.yForPrice(d.points[0].p);
        const y1 = m.yForPrice(d.points[1].p);
        accept = x0 !== null && x1 !== null && Math.hypot(x1 - x0, y1 - y0) >= 6;
      }
      if (accept) {
        d.id = newId();
        this.drawings.push(d);
        this.persist();
        this.onDrawingsChange(this.drawings);
      }
      this.redraw();
    }
  }

  onPointerLeave() {
    if (this.drag) return;
    if (this.hoverId) {
      this.hoverId = null;
      this.redraw();
    }
  }

  onDoubleClick(event) {
    if (this.tool !== 'select') return;
    const { x, y } = this.pos(event);
    const m = this.getMapping();
    if (!m) return;
    const hit = this.hitTestTop(x, y, m);
    if (hit) this.remove(hit.id);
  }

  beginDrag(drawing, handle, x, y, m) {
    this.drag = {
      drawing,
      handle,
      orig: drawing.points.map((p) => ({ ...p })),
      startT: m.timeForX(x),
      startP: m.priceForY(y)
    };
  }

  updateDrag(x, y) {
    const m = this.getMapping();
    if (!m) return;
    const drag = this.drag;
    const t = m.timeForX(x);
    const p = m.priceForY(y);
    if (t === null || p === null) return;
    const drawing = drag.drawing;
    if (drag.handle >= 0) {
      drawing.points[drag.handle] = { t: m.snapTimeForX(x), p };
    } else if (drawing.type === 'hline') {
      drawing.points = [{ t: drag.orig[0].t, p: drag.orig[0].p + (p - drag.startP) }];
    } else if (drawing.type === 'vline') {
      drawing.points = [{ t: m.snapTimeForX(x), p: drag.orig[0].p }];
    } else if (drawing.type === 'hray') {
      drawing.points = [{ t: m.snapTimeForX(x), p: drag.orig[0].p + (p - drag.startP) }];
    } else {
      const dt = t - drag.startT;
      const dp = p - drag.startP;
      drawing.points = drag.orig.map((q) => ({ t: Math.round(q.t + dt), p: q.p + dp }));
    }
    this.redraw();
  }

  hitHandle(drawing, x, y, m) {
    if (drawing.type !== 'trend' && drawing.type !== 'rect') return -1;
    for (let i = 0; i < drawing.points.length; i++) {
      const point = drawing.points[i];
      const px = m.xForTime(point.t);
      if (px === null) continue;
      const py = m.yForPrice(point.p);
      if (Math.hypot(px - x, py - y) <= 8) return i;
    }
    return -1;
  }

  hitTestTop(x, y, m) {
    for (let i = this.drawings.length - 1; i >= 0; i--) {
      if (this.hitTest(this.drawings[i], x, y, m)) return this.drawings[i];
    }
    return null;
  }

  hitTest(drawing, x, y, m) {
    const tol = Math.max(6, (drawing.width || DEFAULT_WIDTH) / 2 + 4);
    const points = drawing.points;
    if (drawing.type === 'hline') {
      return Math.abs(m.yForPrice(points[0].p) - y) <= tol;
    }
    if (drawing.type === 'vline') {
      const px = m.xForTime(points[0].t);
      return px !== null && Math.abs(px - x) <= tol;
    }
    if (drawing.type === 'hray') {
      const px = m.xForTime(points[0].t);
      if (px === null) return false;
      return x >= px - tol && Math.abs(m.yForPrice(points[0].p) - y) <= tol;
    }
    if (drawing.type === 'trend') {
      const x0 = m.xForTime(points[0].t);
      const x1 = m.xForTime(points[1].t);
      if (x0 === null || x1 === null) return false;
      return distToSegment(x, y, x0, m.yForPrice(points[0].p), x1, m.yForPrice(points[1].p)) <= tol;
    }
    if (drawing.type === 'rect') {
      const x0 = m.xForTime(points[0].t);
      const x1 = m.xForTime(points[1].t);
      if (x0 === null || x1 === null) return false;
      const y0 = m.yForPrice(points[0].p);
      const y1 = m.yForPrice(points[1].p);
      return (
        x >= Math.min(x0, x1) - tol &&
        x <= Math.max(x0, x1) + tol &&
        y >= Math.min(y0, y1) - tol &&
        y <= Math.max(y0, y1) + tol
      );
    }
    return false;
  }

  drawOne(drawing, m, selected, hovered, preview) {
    const ctx = this.ctx;
    const color = drawing.color || '#2962ff';
    const points = drawing.points;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = drawing.width || DEFAULT_WIDTH;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.setLineDash(preview ? [5, 4] : []);
    if (!preview && (selected || hovered)) {
      ctx.shadowColor = hexToRgba(color, selected ? 0.5 : 0.3);
      ctx.shadowBlur = selected ? 7 : 4;
    }

    if (drawing.type === 'hline') {
      const y = m.yForPrice(points[0].p);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(m.paneW, y);
      ctx.stroke();
    } else if (drawing.type === 'vline') {
      const x = m.xForTime(points[0].t);
      if (x !== null) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, m.paneH);
        ctx.stroke();
      }
    } else if (drawing.type === 'hray') {
      const x = m.xForTime(points[0].t);
      if (x !== null) {
        const y = m.yForPrice(points[0].p);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(m.paneW, y);
        ctx.stroke();
      }
    } else if (drawing.type === 'trend') {
      const x0 = m.xForTime(points[0].t);
      const x1 = m.xForTime(points[1].t);
      if (x0 !== null && x1 !== null) {
        ctx.beginPath();
        ctx.moveTo(x0, m.yForPrice(points[0].p));
        ctx.lineTo(x1, m.yForPrice(points[1].p));
        ctx.stroke();
      }
    } else if (drawing.type === 'rect') {
      const x0 = m.xForTime(points[0].t);
      const x1 = m.xForTime(points[1].t);
      if (x0 !== null && x1 !== null) {
        const y0 = m.yForPrice(points[0].p);
        const y1 = m.yForPrice(points[1].p);
        const left = Math.min(x0, x1);
        const top = Math.min(y0, y1);
        const right = Math.max(x0, x1);
        const bottom = Math.max(y0, y1);
        ctx.fillStyle = hexToRgba(color, selected ? 0.18 : 0.1);
        ctx.save();
        ctx.shadowBlur = 0;
        ctx.fillRect(left, top, right - left, bottom - top);
        ctx.restore();
        ctx.strokeRect(left, top, right - left, bottom - top);
      }
    }
    ctx.restore();

    if (selected && !preview) {
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      for (const point of points) {
        const x = m.xForTime(point.t);
        if (x === null) continue;
        const y = m.yForPrice(point.p);
        ctx.beginPath();
        ctx.arc(x, y, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  drawBands(m) {
    if (!this.getBands) return;
    const bands = this.getBands();
    if (!bands || !bands.length) return;
    const ctx = this.ctx;
    for (const band of bands) {
      const xa = m.xForTime(band.from);
      const xb = m.xForTime(band.to);
      if (xa === null || xb === null) continue;
      const left = Math.min(xa, xb);
      const right = Math.max(xa, xb);
      if (right < -2 || left > m.paneW + 2) continue;
      if (band.kind === 'break') {
        // The maintenance break contains no bars, so it has no width on an
        // index-based axis: mark it with a dashed line instead of a band.
        if (right - left >= 3) {
          ctx.fillStyle = band.fill;
          ctx.fillRect(left, 0, right - left, m.paneH);
        }
        const x = right - left >= 3 ? left + 0.5 : (left + right) / 2;
        ctx.save();
        ctx.strokeStyle = band.color;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 4]);
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, m.paneH);
        ctx.stroke();
        ctx.restore();
        continue;
      }
      ctx.fillStyle = band.fill;
      ctx.fillRect(left, 0, right - left, m.paneH);
      ctx.save();
      ctx.strokeStyle = band.edge;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(left + 0.5, 0);
      ctx.lineTo(left + 0.5, m.paneH);
      ctx.moveTo(right - 0.5, 0);
      ctx.lineTo(right - 0.5, m.paneH);
      ctx.stroke();
      ctx.restore();
    }
  }

  redraw() {
    const ctx = this.ctx;
    if (!ctx || !this.cssW || !this.cssH) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssW, this.cssH);
    const m = this.getMapping();
    if (!m) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, m.paneW, m.paneH);
    ctx.clip();
    this.drawBands(m);
    for (const drawing of this.drawings) {
      this.drawOne(drawing, m, drawing.id === this.selectedId, drawing.id === this.hoverId, false);
    }
    if (this.preview) this.drawOne(this.preview, m, false, false, true);
    ctx.restore();
  }

  destroy() {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerUp);
    this.canvas.removeEventListener('pointerleave', this.onPointerLeave);
    this.canvas.removeEventListener('dblclick', this.onDoubleClick);
    if (this.resizeObserver) this.resizeObserver.disconnect();
  }
}
