// Drawing tools: lines, boxes and Fibonacci levels. Drawings are stored per symbol as
// { t, price } points, so the same drawing shows on every chart of that symbol, whatever
// the timeframe. Each chart draws them through a series primitive (DrawingLayer).
const Drawings = (() => {
  const KEY = "chartMonitorDrawings";
  const TOOLS = {
    cursor: { label: "↖",  title: "เลือก / ย้าย (Esc)", points: 0 },
    trend:  { label: "╱",  title: "เส้นเทรนด์", points: 2 },
    ray:    { label: "↗",  title: "Ray (ลากยาวไปทางขวา)", points: 2 },
    hline:  { label: "─",  title: "เส้นแนวนอน (ตั้ง alert ได้)", points: 1 },
    vline:  { label: "│",  title: "เส้นแนวตั้ง", points: 1 },
    rect:   { label: "▭",  title: "กล่อง", points: 2 },
    fib:    { label: "Fib", title: "Fibonacci retracement", points: 2 }
  };
  const COLORS = ["#2f81f7", "#e3b341", "#26a69a", "#ef5350", "#a371f7", "#d6dbe3"];
  const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

  let store = {};
  try { store = JSON.parse(localStorage.getItem(KEY) || "{}") || {}; } catch (e) {}
  const listeners = new Set();

  function persist() {
    try { localStorage.setItem(KEY, JSON.stringify(store)); } catch (e) {}
  }
  function notify(symbol) { for (const fn of listeners) fn(symbol); }

  let seq = 0;
  function make(type, p1, p2) {
    return { id: Date.now().toString(36) + (seq++).toString(36), type,
      p1: { t: p1.t, price: p1.price }, p2: { t: p2.t, price: p2.price }, color: COLORS[type === "hline" ? 1 : 0] };
  }

  return {
    TOOLS, COLORS, FIB_LEVELS, make,
    list: symbol => store[symbol] || [],
    all: () => store,
    get: (symbol, id) => (store[symbol] || []).find(d => d.id === id),
    add(symbol, d) { (store[symbol] = store[symbol] || []).push(d); persist(); notify(symbol); },
    // Drawings are edited in place; call this afterwards. save=false while dragging.
    changed(symbol, save = true) { if (save) persist(); notify(symbol); },
    remove(symbol, id) { store[symbol] = (store[symbol] || []).filter(d => d.id !== id); persist(); notify(symbol); },
    clear(symbol) { store[symbol] = []; persist(); notify(symbol); },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  };
})();

class DrawingLayer {
  // `ui` supplies tool(), setTool(name), selected() -> {symbol, id} | null, select(symbol, id)
  constructor(cell, ui) {
    this.cell = cell;
    this.ui = ui;
    this.requestUpdate = null;
    this.pending = null;    // second point of a two-click drawing still to come
    this.drag = null;
    this.swallowMouse = false;
    this.unsubscribe = Drawings.onChange(symbol => { if (symbol === cell.symbol) this.update(); });

    this.handlers = {
      pointerdown: e => this.onDown(e),
      pointermove: e => this.onMove(e),
      pointerup: e => this.onUp(e),
      // Lightweight Charts listens to mouse/touch events; keep them from panning the chart
      // when the pointerdown was ours.
      mousedown: e => { if (this.swallowMouse) { e.stopPropagation(); this.swallowMouse = false; } },
      touchstart: e => { if (this.swallowMouse) { e.stopPropagation(); this.swallowMouse = false; } }
    };
    for (const [type, fn] of Object.entries(this.handlers)) cell.chartEl.addEventListener(type, fn, true);
    cell.candle.attachPrimitive(this);
  }

  destroy() {
    this.unsubscribe();
    for (const [type, fn] of Object.entries(this.handlers)) this.cell.chartEl.removeEventListener(type, fn, true);
  }

  // ---------- primitive interface ----------
  attached({ requestUpdate }) { this.requestUpdate = requestUpdate; }
  detached() { this.requestUpdate = null; }
  update() { if (this.requestUpdate) this.requestUpdate(); }
  paneViews() {
    return [{ zOrder: () => "top", renderer: () => ({ draw: target => this.draw(target) }) }];
  }

  // ---------- geometry ----------
  screen(p) {
    const x = this.cell.timeToX(p.t), y = this.cell.candle.priceToCoordinate(p.price);
    return x === null || y === null ? null : { x, y };
  }

  point(pt) {
    const t = this.cell.xToTime(pt.x), price = this.cell.candle.coordinateToPrice(pt.y);
    return t === null || price === null ? null : { t, price };
  }

  // Mouse position relative to the price pane; inPane is false over the axes or indicator panes.
  local(e) {
    const r = this.cell.chartEl.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const chart = this.cell.chart;
    const inPane = chart && x >= 0 && x < chart.timeScale().width() && y >= 0 && y < chart.panes()[0].getHeight();
    return { x, y, inPane };
  }

  fibPrice(d, level) { return d.p2.price + (d.p1.price - d.p2.price) * level; }

  hitTest(x, y) {
    const list = Drawings.list(this.cell.symbol);
    const sel = this.ui.selected();
    for (let i = list.length - 1; i >= 0; i--) {
      const d = list[i];
      const a = this.screen(d.p1), b = this.screen(d.p2);
      if (!a || !b) continue;
      if (sel && sel.id === d.id && Drawings.TOOLS[d.type].points === 2) {
        if (Math.hypot(x - a.x, y - a.y) <= 7) return { d, handle: 1 };
        if (Math.hypot(x - b.x, y - b.y) <= 7) return { d, handle: 2 };
      }
      if (this.hitBody(d, a, b, x, y)) return { d, handle: 0 };
    }
    return null;
  }

  hitBody(d, a, b, x, y) {
    const tol = 5;
    switch (d.type) {
      case "hline": return Math.abs(y - a.y) <= tol;
      case "vline": return Math.abs(x - a.x) <= tol;
      case "trend": return distToSegment(x, y, a, b) <= tol;
      case "ray": return distToSegment(x, y, a, this.rayEnd(a, b)) <= tol;
      case "rect": return x >= Math.min(a.x, b.x) - tol && x <= Math.max(a.x, b.x) + tol &&
                          y >= Math.min(a.y, b.y) - tol && y <= Math.max(a.y, b.y) + tol;
      case "fib": {
        if (x < Math.min(a.x, b.x) - tol || x > Math.max(a.x, b.x) + tol) return false;
        return Drawings.FIB_LEVELS.some(l => {
          const ly = this.cell.candle.priceToCoordinate(this.fibPrice(d, l));
          return ly !== null && Math.abs(y - ly) <= tol;
        });
      }
    }
    return false;
  }

  rayEnd(a, b) {
    const w = this.cell.chart.timeScale().width();
    if (b.x === a.x) return { x: b.x, y: b.y > a.y ? 1e5 : -1e5 };
    const edge = b.x > a.x ? w + 50 : -50;
    return { x: edge, y: a.y + (b.y - a.y) * (edge - a.x) / (b.x - a.x) };
  }

  // ---------- rendering ----------
  draw(target) {
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize: size }) => {
      const sel = this.ui.selected();
      const items = Drawings.list(this.cell.symbol).slice();
      if (this.pending) items.push(this.pending);
      for (const d of items) {
        const a = this.screen(d.p1), b = this.screen(d.p2);
        if (!a || !b) continue;
        this.drawOne(ctx, size, d, a, b, !!sel && sel.id === d.id);
      }
    });
  }

  drawOne(ctx, size, d, a, b, selected) {
    const alertOn = d.alert && d.alert.active;
    ctx.save();
    ctx.strokeStyle = d.color;
    ctx.fillStyle = d.color;
    ctx.lineWidth = selected ? 2 : 1.5;
    ctx.setLineDash(alertOn ? [6, 4] : []);
    ctx.font = "11px system-ui, sans-serif";
    const line = (x1, y1, x2, y2) => { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); };
    const p = this.cell.precision;

    switch (d.type) {
      case "hline": {
        line(0, a.y, size.width, a.y);
        const text = (alertOn ? "🔔 " : d.alert && d.alert.firedAt ? "✓ " : "") + d.p1.price.toFixed(p);
        const w = ctx.measureText(text).width + 8;
        ctx.setLineDash([]);
        ctx.fillRect(size.width - w - 4, a.y - 9, w, 18);
        ctx.fillStyle = "#0e1013";
        ctx.fillText(text, size.width - w, a.y + 4);
        break;
      }
      case "vline": line(a.x, 0, a.x, size.height); break;
      case "trend": line(a.x, a.y, b.x, b.y); break;
      case "ray": { const e = this.rayEnd(a, b); line(a.x, a.y, e.x, e.y); break; }
      case "rect": {
        const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y), w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
        ctx.globalAlpha = 0.12; ctx.fillRect(x, y, w, h);
        ctx.globalAlpha = 1; ctx.strokeRect(x, y, w, h);
        break;
      }
      case "fib": {
        const x1 = Math.min(a.x, b.x), x2 = Math.max(a.x, b.x);
        ctx.setLineDash([]);
        for (const l of Drawings.FIB_LEVELS) {
          const price = this.fibPrice(d, l);
          const y = this.cell.candle.priceToCoordinate(price);
          if (y === null) continue;
          ctx.globalAlpha = l === 0 || l === 1 ? 1 : 0.75;
          line(x1, y, x2, y);
          ctx.fillText(`${l} (${price.toFixed(p)})`, x1 + 4, y - 3);
        }
        ctx.globalAlpha = 0.25;
        ctx.setLineDash([3, 3]);
        line(a.x, a.y, b.x, b.y);
        break;
      }
    }

    if (selected && Drawings.TOOLS[d.type].points === 2) {
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      for (const pt of [a, b]) {
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = "#0e1013"; ctx.fill(); ctx.stroke();
      }
    }
    ctx.restore();
  }

  // ---------- interaction ----------
  block(e) {
    e.stopPropagation();
    e.preventDefault();
    this.swallowMouse = true;
    this.cell.chart.applyOptions({ handleScroll: false, handleScale: false });
  }

  unblock() {
    if (this.cell.chart) this.cell.chart.applyOptions({ handleScroll: true, handleScale: true });
  }

  cancel() {
    if (this.pending) { this.pending = null; this.unblock(); this.update(); }
  }

  onDown(e) {
    if (e.button !== 0 || !this.cell.chart) return;
    const pt = this.local(e);
    if (!pt.inPane) return;
    const tool = this.ui.tool();
    const symbol = this.cell.symbol;

    if (tool !== "cursor") {
      const p = this.point(pt);
      if (!p) return;
      this.block(e);
      if (Drawings.TOOLS[tool].points === 1) {
        const d = Drawings.make(tool, p, p);
        Drawings.add(symbol, d);
        this.ui.select(symbol, d.id);
        this.ui.setTool("cursor");
        this.unblock();
      } else if (!this.pending) {
        this.pending = Drawings.make(tool, p, p);
        this.update();
      } else {
        this.pending.p2 = p;
        const d = this.pending;
        this.pending = null;
        Drawings.add(symbol, d);
        this.ui.select(symbol, d.id);
        this.ui.setTool("cursor");
        this.unblock();
      }
      return;
    }

    const hit = this.hitTest(pt.x, pt.y);
    if (!hit) { if (this.ui.selected()) this.ui.select(null); return; }   // let the chart pan
    this.block(e);
    this.ui.select(symbol, hit.d.id);
    const start = this.point(pt);
    if (!start) return;
    this.drag = { d: hit.d, handle: hit.handle, start, p1: { ...hit.d.p1 }, p2: { ...hit.d.p2 } };
    this.cell.chartEl.setPointerCapture(e.pointerId);
  }

  onMove(e) {
    if (!this.cell.chart) return;
    const pt = this.local(e);
    if (this.pending) {
      const p = this.point(pt);
      if (p) { this.pending.p2 = p; this.update(); }
      return;
    }
    if (this.drag) {
      e.stopPropagation();
      const p = this.point(pt);
      if (!p) return;
      const g = this.drag, d = g.d;
      if (g.handle === 1) d.p1 = p;
      else if (g.handle === 2) d.p2 = p;
      else {
        const dt = p.t - g.start.t, dp = p.price - g.start.price;
        d.p1 = { t: g.p1.t + dt, price: g.p1.price + dp };
        d.p2 = { t: g.p2.t + dt, price: g.p2.price + dp };
      }
      Drawings.changed(this.cell.symbol, false);
      return;
    }
    const tool = this.ui.tool();
    this.cell.chartEl.style.cursor = !pt.inPane ? "" : tool !== "cursor" ? "crosshair" :
      this.hitTest(pt.x, pt.y) ? "pointer" : "";
  }

  onUp(e) {
    if (!this.drag) return;
    this.drag = null;
    try { this.cell.chartEl.releasePointerCapture(e.pointerId); } catch (err) {}
    Drawings.changed(this.cell.symbol, true);
    this.unblock();
  }
}

function distToSegment(x, y, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len2));
  return Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy));
}
