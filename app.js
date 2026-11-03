// ===== ตั้งค่า (แก้ตรงนี้ได้) =====
// Watchlist เริ่มต้น: XAUUSD / NASDAQ เป็นชื่อย่อจาก SYMBOL_CANDIDATES ใน bridge/bridge.py
// ส่วนตัวอื่นใช้ชื่อตามใน MT5 ได้เลย (ค้นหาเพิ่มได้จากหน้าเว็บ)
const DEFAULT_WATCHLIST = ["XAUUSD", "NASDAQ", "EURUSD", "GBPUSD", "USDJPY"];
const CHART_STYLES = {
  candles: "แท่งเทียน", hollow: "แท่งเทียนกลวง", bars: "Bar (OHLC)", ha: "Heikin Ashi", line: "Line", area: "Area"
};
const SCALES = { normal: "สเกลปกติ", log: "Log", percent: "%" };
// Listed in menu order (an object would sort the number-like keys first).
const INTERVAL_LIST = [
  ["10s", { label: "10s", tf: "S10", seconds: 10 }],   // แท่งวินาทีสร้างจาก tick ใน bridge
  ["15s", { label: "15s", tf: "S15", seconds: 15 }],
  ["30s", { label: "30s", tf: "S30", seconds: 30 }],
  ["1",   { label: "1m",  tf: "M1",  seconds: 60 }],
  ["3",   { label: "3m",  tf: "M3",  seconds: 180 }],
  ["5",   { label: "5m",  tf: "M5",  seconds: 300 }],
  ["15",  { label: "15m", tf: "M15", seconds: 900 }],
  ["30",  { label: "30m", tf: "M30", seconds: 1800 }],
  ["60",  { label: "1h",  tf: "H1",  seconds: 3600 }],
  ["240", { label: "4h",  tf: "H4",  seconds: 14400 }],
  ["D",   { label: "1D",  tf: "D1",  seconds: 86400 }]
];
const INTERVALS = Object.fromEntries(INTERVAL_LIST);
const LAYOUTS = {
  "2x2": { label:"2×2 (4 ช่อง)",        css:"grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr", n:4 },
  "big": { label:"2 เล็ก + 1 ใหญ่",      css:"grid-template-columns:1fr 1.4fr;grid-template-rows:1fr 1fr", n:3, big:2 },
  "1x3": { label:"3 คอลัมน์",            css:"grid-template-columns:repeat(3,1fr);grid-template-rows:1fr", n:3 },
  "1x2": { label:"2 คอลัมน์",            css:"grid-template-columns:1fr 1fr;grid-template-rows:1fr", n:2 },
  "1x1": { label:"ช่องเดียว",             css:"grid-template-columns:1fr;grid-template-rows:1fr", n:1 }
};
const DEFAULT_STATE = {
  layout: "2x2", style: "candles", scale: "normal",
  link: true,                    // เปลี่ยนสัญลักษณ์ทีเดียวทุกช่อง
  showWatchlist: true,
  showTrade: false,
  watchlist: DEFAULT_WATCHLIST,
  overlays: { sessions: true, levels: true, profile: false },
  indicators: [{ id: "stoch", type: "stoch", params: {} }, { id: "rsi", type: "rsi", params: {} }],
  cells: ["1", "5", "15", "60"].map(interval => ({ symbol: "XAUUSD", interval }))
};
const DEFAULT_BRIDGE = "http://127.0.0.1:8000";
const HISTORY_BARS = 500;      // แท่งที่โหลดต่อครั้ง
const MAX_BARS = 5000;         // เลื่อนย้อนหลังได้สูงสุด
const RESYNC_MS = 60000;       // ดึงแท่งล่าสุดจาก MT5 มาเทียบทุก 1 นาที
// =================================

// The bridge sends UTC times; shift into Bangkok time (UTC+7, no DST) so the time axis,
// day boundaries and labels all read in local time.
const TZ_SHIFT = 7 * 3600;
const COLORS = { up: "#26a69a", down: "#ef5350", volUp: "rgba(38,166,154,.35)", volDown: "rgba(239,83,80,.35)",
  band: "#4b5563", ask: "#ef5350", line: "#2f81f7" };

const STATE_KEY = "chartMonitorState";
const SETTINGS_KEY = "chartMonitorBridge";

function loadJson(key) {
  try { return JSON.parse(localStorage.getItem(key) || "null"); } catch (e) { return null; }
}
function saveJson(key, value) {
  try { value === null ? localStorage.removeItem(key) : localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
}

let state = JSON.parse(JSON.stringify(DEFAULT_STATE));
{
  const saved = loadJson(STATE_KEY);
  if (saved && LAYOUTS[saved.layout]) state = normalizeState(Object.assign(state, saved));
}

// Fill in / upgrade settings saved by older versions of the page.
function normalizeState(s) {
  if (s.style === "8") s.style = "ha";                     // ค่าจากเวอร์ชัน widget เดิม
  if (!CHART_STYLES[s.style]) s.style = "candles";
  if (!SCALES[s.scale]) s.scale = "normal";
  if (!Array.isArray(s.cells)) {                           // เดิมทุกช่องใช้ state.symbol เดียวกัน
    s.cells = (Array.isArray(s.intervals) ? s.intervals : DEFAULT_STATE.cells.map(c => c.interval))
      .map(interval => ({ symbol: s.symbol || "XAUUSD", interval }));
  }
  s.cells = s.cells.map(c => ({ symbol: c.symbol || "XAUUSD", interval: INTERVALS[c.interval] ? c.interval : "15" }));
  if (!Array.isArray(s.indicators)) {                      // ค่าจากเวอร์ชันที่มีแค่ช่องติ๊ก Stoch / RSI
    s.indicators = [];
    if (s.stoch !== false) s.indicators.push({ id: "stoch", type: "stoch", params: {} });
    if (s.rsi !== false) s.indicators.push({ id: "rsi", type: "rsi", params: {} });
  }
  s.indicators = s.indicators.filter(x => INDICATOR_DEFS[x.type]);
  if (!Array.isArray(s.watchlist)) s.watchlist = DEFAULT_WATCHLIST.slice();
  s.overlays = Object.assign({}, DEFAULT_STATE.overlays, s.overlays);
  delete s.symbol; delete s.intervals; delete s.stoch; delete s.rsi;
  return s;
}

// Served by the bridge itself -> same origin. Opened elsewhere (e.g. GitHub Pages) -> local bridge.
const servedByBridge = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && location.protocol === "http:";
let settings = Object.assign({ bridgeUrl: servedByBridge ? "" : DEFAULT_BRIDGE }, loadJson(SETTINGS_KEY) || {});
let brokerSymbols = {};        // symbol -> { name, mt5, digits, description, dayOpen } from /api/info
const infoRequests = {};

function save() { saveJson(STATE_KEY, state); }

// Symbol details from the bridge, fetched once per symbol (this also starts its live stream).
function ensureInfo(symbol) {
  if (brokerSymbols[symbol]) return Promise.resolve(brokerSymbols[symbol]);
  if (!infoRequests[symbol]) {
    infoRequests[symbol] = Mt5.info(symbol)
      .then(info => (brokerSymbols[symbol] = info))
      .finally(() => { delete infoRequests[symbol]; });
  }
  return infoRequests[symbol];
}

// ---------- time formatting ----------
const fmtCache = {};
function fmt(opts) {
  const key = JSON.stringify(opts);
  return fmtCache[key] || (fmtCache[key] = new Intl.DateTimeFormat("th-TH-u-ca-gregory-nu-latn", Object.assign({ timeZone: "UTC" }, opts)));
}
const fmtTime = t => fmt({ hour: "2-digit", minute: "2-digit", hour12: false }).format(t * 1000);
const fmtTimeSec = t => fmt({ hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(t * 1000);
const fmtDate = t => fmt({ day: "numeric", month: "short", year: "numeric" }).format(t * 1000);
function tickMarkFormatter(t, type) {
  const ms = t * 1000;
  switch (type) {
    case 0: return fmt({ year: "numeric" }).format(ms);
    case 1: return fmt({ month: "short" }).format(ms);
    case 2: return fmt({ day: "numeric" }).format(ms);
    case 3: return fmtTime(t);
    default: return fmtTimeSec(t);
  }
}

// ---------- one chart cell ----------
let cells = [];
let syncing = false;

class ChartCell {
  constructor(parent, index) {
    this.index = index;
    this.symbol = state.cells[index].symbol;
    this.precision = 2;           // replaced by the symbol's digits once /api/info answers
    this.iv = INTERVALS[state.cells[index].interval];
    this.bars = [];
    this.disp = [];
    this.dead = false;
    this.hovering = false;
    this.following = -1;          // bar index shown because another chart's crosshair is here
    this.noMoreHistory = false;
    this.loadingOlder = false;
    this.frame = 0;

    this.el = document.createElement("div");
    this.el.className = "cell";
    this.el.addEventListener("pointerdown", () => setActiveCell(this.index), true);
    const header = document.createElement("header");
    header.title = "ดับเบิลคลิกเพื่อขยายเต็มจอ";
    header.addEventListener("dblclick", e => { if (!e.target.closest("button, select")) toggleMaximize(this.index); });
    const name = document.createElement("button");
    name.className = "name";
    name.textContent = this.symbol + " ▾";
    name.title = "เปลี่ยนสัญลักษณ์";
    name.addEventListener("click", () => openSymbolSearch(sym => setSymbol(sym, this.index)));
    this.srcEl = document.createElement("span");
    this.srcEl.className = "src";
    this.sel = document.createElement("select");
    for (const [k, iv] of INTERVAL_LIST) {
      const o = document.createElement("option");
      o.value = k; o.textContent = iv.label;
      if (k === state.cells[index].interval) o.selected = true;
      this.sel.appendChild(o);
    }
    this.sel.addEventListener("change", () => {
      state.cells[index].interval = this.sel.value;
      save();
      this.destroyChart();
      this.iv = INTERVALS[this.sel.value];
      this.start();
    });
    this.countdownEl = document.createElement("span");
    this.countdownEl.className = "countdown";
    this.countdownEl.title = "เวลาที่เหลือก่อนปิดแท่ง";
    this.spreadEl = document.createElement("span");
    this.spreadEl.className = "spread";
    this.spreadEl.title = "Spread (Ask − Bid)";
    this.lastEl = document.createElement("span");
    this.lastEl.className = "last";
    const shot = document.createElement("button");
    shot.className = "icon";
    shot.textContent = "📷";
    shot.title = "บันทึกรูปกราฟ (Alt+S)";
    shot.addEventListener("click", () => this.screenshot());
    const max = document.createElement("button");
    max.className = "icon";
    max.textContent = "⤢";
    max.title = "ขยาย / ย่อ (ดับเบิลคลิกหัวกราฟ)";
    max.addEventListener("click", () => toggleMaximize(this.index));
    header.append(name, this.srcEl, this.sel, this.countdownEl, this.spreadEl, this.lastEl, shot, max);

    this.chartEl = document.createElement("div");
    this.chartEl.className = "chart";
    this.legend = document.createElement("div");
    this.legend.className = "legend";
    this.overlay = document.createElement("div");
    this.overlay.className = "overlay";
    this.chartEl.append(this.legend, this.overlay);

    this.el.append(header, this.chartEl);
    parent.appendChild(this.el);
    this.start();
  }

  showOverlay(text, isError) {
    this.overlay.textContent = text;
    this.overlay.className = "overlay" + (isError ? " error" : "");
    this.overlay.hidden = false;
  }

  createChart() {
    const LW = LightweightCharts;
    const daily = this.iv.tf === "D1";
    const withSeconds = this.iv.seconds < 60;
    const chart = LW.createChart(this.chartEl, {
      autoSize: true,
      layout: { background: { type: "solid", color: "#161a20" }, textColor: "#9aa4b2", fontSize: 11,
        panes: { separatorColor: "#262c35" } },
      grid: { vertLines: { color: "#1c2128" }, horzLines: { color: "#1c2128" } },
      crosshair: { mode: LW.CrosshairMode.Normal },
      rightPriceScale: { borderColor: "#262c35" },
      timeScale: { borderColor: "#262c35", timeVisible: !daily, secondsVisible: withSeconds, rightOffset: 5, tickMarkFormatter },
      localization: { timeFormatter: t => daily ? fmtDate(t) : fmtDate(t) + " " + (withSeconds ? fmtTimeSec(t) : fmtTime(t)) }
    });
    const minMove = Math.pow(10, -this.precision);
    // The main price series; called `candle` everywhere although it can be bars, line or area.
    const priceFormat = { type: "price", precision: this.precision, minMove };
    const ohlcColors = { upColor: COLORS.up, downColor: COLORS.down };
    switch (state.style) {
      case "line":
        this.candle = chart.addSeries(LW.LineSeries, { color: COLORS.line, lineWidth: 2, priceFormat });
        break;
      case "area":
        this.candle = chart.addSeries(LW.AreaSeries, { lineColor: COLORS.line, lineWidth: 2,
          topColor: "rgba(47,129,247,.35)", bottomColor: "rgba(47,129,247,0)", priceFormat });
        break;
      case "bars":
        this.candle = chart.addSeries(LW.BarSeries, Object.assign({ thinBars: false, priceFormat }, ohlcColors));
        break;
      case "hollow":
        this.candle = chart.addSeries(LW.CandlestickSeries, { upColor: "rgba(0,0,0,0)", downColor: COLORS.down,
          borderVisible: true, borderUpColor: COLORS.up, borderDownColor: COLORS.down,
          wickUpColor: COLORS.up, wickDownColor: COLORS.down, priceFormat });
        break;
      default:   // candles, ha
        this.candle = chart.addSeries(LW.CandlestickSeries, Object.assign({
          wickUpColor: COLORS.up, wickDownColor: COLORS.down, borderVisible: false, priceFormat }, ohlcColors));
    }
    chart.priceScale("right").applyOptions({ mode: { normal: 0, log: 1, percent: 2 }[state.scale] });
    this.volume = chart.addSeries(LW.HistogramSeries, {
      priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false
    });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

    // Indicators from the indicator dialog: overlays share the price pane, others get a pane each.
    const pricePrecision = { type: "price", precision: this.precision, minMove };
    const pctPrecision = { type: "price", precision: 2, minMove: 0.01 };
    let pane = 1;
    this.ind = [];
    for (const inst of state.indicators) {
      const def = INDICATOR_DEFS[inst.type];
      const paneIndex = def.overlay ? 0 : pane++;
      const priceFormat = def.overlay || def.priceDecimals || inst.type === "macd" ? pricePrecision : pctPrecision;
      const series = def.outputs.map((o, k) => {
        const color = (inst.colors && inst.colors[k]) || o.color;
        const opts = { color, priceLineVisible: false, lastValueVisible: !def.overlay, priceFormat };
        return o.type === "histogram"
          ? chart.addSeries(LW.HistogramSeries, opts, paneIndex)
          : chart.addSeries(LW.LineSeries, Object.assign(opts, { lineWidth: 1, crosshairMarkerVisible: false }), paneIndex);
      });
      for (const level of def.bands || []) {
        series[0].createPriceLine({ price: level, color: COLORS.band, lineWidth: 1, lineStyle: LW.LineStyle.Dashed, axisLabelVisible: false });
      }
      this.ind.push({ inst, def, series, params: Object.assign({}, def.params, inst.params) });
    }
    const panes = chart.panes();
    panes[0].setStretchFactor(3);
    for (let i = 1; i < panes.length; i++) panes[i].setStretchFactor(1);

    chart.subscribeCrosshairMove(p => this.onCrosshair(p));
    chart.timeScale().subscribeVisibleLogicalRangeChange(r => {
      if (r && r.from < 20) this.loadOlder();
    });
    this.chart = chart;
    this.askLine = null;
    this.levelLines = {};
    this.overlays = new OverlayLayer(this);
    this.trades = new TradeLayer(this);           // before drawings: its mouse handlers go first
    this.drawings = new DrawingLayer(this, UI);
    chart.subscribeClick(p => this.onChartClick(p));
  }

  // ---------- day high / low ----------
  // Today's and yesterday's high/low from MT5's D1 bars (the broker's trading day), shown on
  // intraday charts. Today's pair follows live ticks.
  async loadLevels() {
    if (!state.overlays.levels || this.iv.seconds >= 86400) { this.showLevels(); return; }
    try {
      const d = await Mt5.candles(this.symbol, "D1", { count: 2 });
      if (this.dead || !this.chart || d.length < 2) return;
      this.dayLevels = { pdh: d[0].high, pdl: d[0].low, h: d[1].high, l: d[1].low };
      this.showLevels();
    } catch (e) { /* levels are optional */ }
  }

  showLevels() {
    const LW = LightweightCharts;
    // Hidden during replay: today's high/low would give away where price goes next.
    const want = state.overlays.levels && this.iv.seconds < 86400 && this.dayLevels && !this.replay ? this.dayLevels : {};
    const style = {
      h:   { title: "H วันนี้", color: "#26a69a", lineStyle: LW.LineStyle.Solid },
      l:   { title: "L วันนี้", color: "#ef5350", lineStyle: LW.LineStyle.Solid },
      pdh: { title: "PDH", color: "#7d8590", lineStyle: LW.LineStyle.Dashed },
      pdl: { title: "PDL", color: "#7d8590", lineStyle: LW.LineStyle.Dashed }
    };
    for (const key of Object.keys(style)) {
      const line = this.levelLines[key];
      if (want[key] === undefined) {
        if (line) { this.candle.removePriceLine(line); delete this.levelLines[key]; }
      } else if (line) {
        line.applyOptions({ price: want[key] });
      } else {
        this.levelLines[key] = this.candle.createPriceLine(Object.assign({ price: want[key], lineWidth: 1,
          axisLabelVisible: true }, style[key]));
      }
    }
  }

  // ---------- bar replay ----------
  // replay = { picking: true } while waiting for the start bar, then { idx, timer, speed }.
  // Live ticks keep updating this.bars; only bars up to idx are shown.
  viewBars() {
    return this.replay && this.replay.idx !== undefined ? this.bars.slice(0, this.replay.idx + 1) : this.bars;
  }

  startReplayPick() {
    this.stopReplay(false);
    this.replay = { picking: true };
    this.showReplayBar();
  }

  onChartClick(p) {
    if (!this.replay || !this.replay.picking || p.time === undefined) return;
    let idx = this.barIndexAt(p.time);
    if (idx < 0) return;
    idx = Math.max(idx, 20);                      // keep some bars for indicators to warm up
    this.replay = { idx, timer: 0, speed: this.replay.speed || 1 };
    if (this.askLine) { this.candle.removePriceLine(this.askLine); this.askLine = null; }
    this.spreadEl.textContent = "";
    this.showLevels();
    this.render(true);
    this.chart.timeScale().scrollToPosition(5, false);
    this.showReplayBar();
  }

  replayStep() {
    const r = this.replay;
    if (!r || r.idx === undefined) return;
    if (r.idx >= this.bars.length - 1) { this.replayPause(); return; }
    r.idx++;
    this.render(false);
    this.showReplayBar();
  }

  replayPlay() {
    const r = this.replay;
    if (!r || r.idx === undefined) return;
    clearInterval(r.timer);
    r.timer = setInterval(() => this.replayStep(), 1000 / r.speed);
    this.showReplayBar();
  }

  replayPause() {
    if (!this.replay) return;
    clearInterval(this.replay.timer);
    this.replay.timer = 0;
    this.showReplayBar();
  }

  stopReplay(redraw = true) {
    if (!this.replay) return;
    clearInterval(this.replay.timer);
    this.replay = null;
    if (this.replayBar) { this.replayBar.remove(); this.replayBar = null; }
    if (redraw) { this.render(true); this.showLevels(); this.chart.timeScale().scrollToRealTime(); }
    renderOverlayButtons();
  }

  showReplayBar() {
    const r = this.replay;
    if (!this.replayBar) {
      this.replayBar = document.createElement("div");
      this.replayBar.className = "replaybar";
      this.chartEl.appendChild(this.replayBar);
    }
    const bar = this.replayBar;
    bar.innerHTML = "";
    const btn = (text, title, fn, on) => {
      const b = document.createElement("button");
      b.textContent = text; b.title = title;
      if (on) b.className = "on";
      b.addEventListener("click", fn);
      bar.appendChild(b);
      return b;
    };
    if (r.picking) {
      const hint = document.createElement("span");
      hint.textContent = "คลิกที่แท่งที่จะเริ่ม replay";
      bar.appendChild(hint);
    } else {
      const playing = !!r.timer;
      btn(playing ? "⏸" : "▶", playing ? "หยุด" : "เล่น", () => playing ? this.replayPause() : this.replayPlay());
      btn("⏭", "ไปแท่งถัดไป (Shift+→)", () => this.replayStep());
      const speed = document.createElement("select");
      for (const s of [1, 2, 5, 10]) {
        const o = document.createElement("option");
        o.value = s; o.textContent = s + " แท่ง/วิ";
        speed.appendChild(o);
      }
      speed.value = r.speed;
      speed.addEventListener("change", () => { r.speed = +speed.value; if (r.timer) this.replayPlay(); });
      bar.appendChild(speed);
      const pos = document.createElement("span");
      const b = this.bars[r.idx];
      pos.textContent = `${fmtDate(b.time)} ${this.iv.seconds < 86400 ? fmtTime(b.time) : ""} · เหลือ ${this.bars.length - 1 - r.idx} แท่ง`;
      bar.appendChild(pos);
    }
    btn("ออก", "ออกจาก replay", () => this.stopReplay());
    renderOverlayButtons();
  }

  // Drawings are stored by time, so they line up across timeframes: a time between two bars
  // maps proportionally between them, and times past the last bar extrapolate by the bar period.
  timeToX(t) {
    const d = this.disp, n = d.length;
    if (!n || !this.chart) return null;
    const p = this.iv.seconds;
    let logical;
    if (t >= d[n - 1].time) logical = n - 1 + (t - d[n - 1].time) / p;
    else if (t <= d[0].time) logical = (t - d[0].time) / p;
    else {
      const i = this.barIndexAt(t);
      logical = i + (t - d[i].time) / (d[i + 1].time - d[i].time);
    }
    // logicalToCoordinate only handles whole bars; interpolate the fraction ourselves.
    const ts = this.chart.timeScale();
    const i0 = Math.floor(logical), f = logical - i0;
    const x0 = ts.logicalToCoordinate(i0);
    if (x0 === null || !f) return x0;
    const x1 = ts.logicalToCoordinate(i0 + 1);
    return x1 === null ? x0 : x0 + f * (x1 - x0);
  }

  // Inverse of timeToX, snapped to the nearest bar so clicks land on candles.
  xToTime(x) {
    const d = this.disp, n = d.length;
    if (!n || !this.chart) return null;
    const logical = this.chart.timeScale().coordinateToLogical(x);
    if (logical === null) return null;
    const i = Math.round(logical);
    if (i >= n) return d[n - 1].time + (i - n + 1) * this.iv.seconds;
    if (i < 0) return d[0].time + i * this.iv.seconds;
    return d[i].time;
  }

  async start() {
    this.dead = false;
    this.noMoreHistory = false;
    this.bars = [];
    this.showOverlay("กำลังโหลด…");
    try {
      const info = await ensureInfo(this.symbol);
      if (this.dead) return;
      this.precision = info.digits;
      this.srcEl.textContent = info.mt5 !== this.symbol ? "MT5:" + info.mt5 : info.description || "";
      this.srcEl.title = info.description || "";
    } catch (e) {
      if (!this.dead) this.showOverlay(e.message, true);
      return;
    }
    if (this.chart) this.destroyChart();
    this.createChart();
    const gen = this.chart;
    try {
      const bars = await Mt5.candles(this.symbol, this.iv.tf, { count: HISTORY_BARS });
      if (this.dead || gen !== this.chart) return;
      this.bars = bars.map(shiftBar);
      if (!this.bars.length) { this.showOverlay("ไม่มีข้อมูลสำหรับสัญลักษณ์นี้", true); return; }
      this.overlay.hidden = true;
      this.render(true);
      this.loadLevels();
      this.resyncTimer = setInterval(() => { this.resync(); this.loadLevels(); }, RESYNC_MS);
    } catch (e) {
      if (this.dead || gen !== this.chart) return;
      this.showOverlay("โหลดข้อมูลไม่สำเร็จ: " + e.message, true);
    }
  }

  // Build the live bar from streamed prices.
  onPrice(p) {
    if (!this.bars.length) return;
    const t = p.time + TZ_SHIFT;
    const last = this.bars[this.bars.length - 1];
    if (t < last.time) return;
    const period = this.iv.seconds;
    if (t < last.time + period) {
      last.high = Math.max(last.high, p.price);
      last.low = Math.min(last.low, p.price);
      last.close = p.price;
      last.volume += 1;
    } else {
      const time = last.time + Math.floor((t - last.time) / period) * period;
      this.bars.push({ time, open: p.price, high: p.price, low: p.price, close: p.price, volume: 1 });
    }
    this.quote = p;
    if (this.replay) return;                      // keep the replay view frozen
    const lv = this.dayLevels;
    if (lv && (p.price > lv.h || p.price < lv.l)) {
      lv.h = Math.max(lv.h, p.price); lv.l = Math.min(lv.l, p.price);
      this.showLevels();
    }
    if (!this.frame) this.frame = requestAnimationFrame(() => { this.frame = 0; this.render(false); });
  }

  // The candles' own last-price line is the Bid; add the Ask above it, like MT5's chart.
  showQuote() {
    const q = this.quote;
    if (!q || !q.ask || !this.candle) return;
    if (!this.askLine) {
      this.askLine = this.candle.createPriceLine({ price: q.ask, color: COLORS.ask, lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Dotted, axisLabelVisible: true, title: "Ask" });
    } else {
      this.askLine.applyOptions({ price: q.ask });
    }
    this.spreadEl.textContent = "spread " + (q.ask - q.bid).toFixed(this.precision);
  }

  // Seconds left in the current bar, shown in the header.
  updateCountdown(nowSec) {
    const last = this.bars[this.bars.length - 1];
    if (!last || this.replay) { this.countdownEl.textContent = ""; return; }
    const left = Math.floor(last.time + this.iv.seconds - (nowSec + TZ_SHIFT));
    if (left < 0) { this.countdownEl.textContent = ""; return; }     // market closed / no ticks yet
    const h = Math.floor(left / 3600), m = Math.floor(left / 60) % 60, s = left % 60;
    const pad = v => String(v).padStart(2, "0");
    this.countdownEl.textContent = "⏱ " + (h ? h + ":" + pad(m) : m) + ":" + pad(s);
  }

  // Replace the newest bars with MT5's own candles so alignment and OHLC stay exact.
  async resync() {
    try {
      const fresh = (await Mt5.candles(this.symbol, this.iv.tf, { count: 3 })).map(shiftBar);
      if (this.dead || !this.bars.length) return;
      for (const c of fresh) {
        let i = this.bars.length - 1;
        while (i >= 0 && this.bars[i].time > c.time) i--;
        if (i >= 0 && this.bars[i].time === c.time) this.bars[i] = c;
        else this.bars.splice(i + 1, 0, c);
      }
      // Drop tick-built bars that MT5's candles show do not exist.
      const newest = fresh[fresh.length - 1];
      if (newest) this.bars = this.bars.filter(b => b.time <= newest.time || b.time >= newest.time + this.iv.seconds);
      this.render(true);
    } catch (e) { /* keep showing streamed data; next resync will retry */ }
  }

  async loadOlder() {
    if (this.loadingOlder || this.noMoreHistory || !this.bars.length || this.bars.length >= MAX_BARS) return;
    this.loadingOlder = true;
    const gen = this.chart;
    try {
      const first = this.bars[0].time;
      const older = (await Mt5.candles(this.symbol, this.iv.tf,
        { count: HISTORY_BARS, to: first - TZ_SHIFT })).map(shiftBar).filter(b => b.time < first);
      if (this.dead || gen !== this.chart) return;
      if (!older.length) { this.noMoreHistory = true; return; }
      this.bars = older.concat(this.bars);
      if (this.replay && this.replay.idx !== undefined) this.replay.idx += older.length;
      this.render(true);
    } catch (e) {
      this.noMoreHistory = true;
    } finally {
      this.loadingOlder = false;
    }
  }

  render(full) {
    if (!this.chart || !this.bars.length) return;
    const bars = this.viewBars();
    const disp = state.style === "ha" ? Indicators.heikinAshi(bars) : bars;
    this.disp = disp;
    const ohlc = state.style === "line" || state.style === "area"
      ? b => ({ time: b.time, value: b.close })
      : b => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close });
    const vol = b => ({ time: b.time, value: b.volume, color: b.close >= b.open ? COLORS.volUp : COLORS.volDown });
    // Indicators are computed from the real bars, also when the candles are Heikin Ashi.
    const point = (v, i, o) => v === null ? { time: disp[i].time } :
      o.downColor ? { time: disp[i].time, value: v, color: v >= 0 ? o.color : o.downColor } : { time: disp[i].time, value: v };
    const outputs = [];
    for (const x of this.ind) {
      const values = x.def.compute(bars, x.params);
      x.def.outputs.forEach((o, k) => outputs.push([x.series[k], values[k], o]));
    }

    if (full) {
      this.candle.setData(disp.map(ohlc));
      this.volume.setData(disp.map(vol));
      for (const [series, values, o] of outputs) series.setData(values.map((v, i) => point(v, i, o)));
      this.overlays.scheduleProfile();
    } else {
      const i = disp.length - 1;
      this.candle.update(ohlc(disp[i]));
      this.volume.update(vol(disp[i]));
      for (const [series, values, o] of outputs) series.update(point(values[i], i, o));
    }
    if (!this.replay) this.showQuote();

    const last = bars[bars.length - 1];
    const prev = bars[bars.length - 2];
    this.lastEl.textContent = last.close.toFixed(this.precision);
    this.lastEl.className = "last " + (prev && last.close < prev.close ? "down" : "up");
    if (!this.hovering && this.following < 0) this.showLegend(disp.length - 1);
  }

  showLegend(i) {
    const b = this.disp[i];
    if (!b) { this.legend.textContent = ""; return; }
    const p = this.precision;
    const ref = i > 0 ? this.disp[i - 1].close : b.open;
    const chg = b.close - ref;
    const cls = chg >= 0 ? "up" : "down";
    const f = v => `<b class="${cls}">${v.toFixed(p)}</b>`;
    this.legend.innerHTML = `O ${f(b.open)} H ${f(b.high)} L ${f(b.low)} C ${f(b.close)} ` +
      `<b class="${cls}">${chg >= 0 ? "+" : ""}${chg.toFixed(p)} (${(chg / ref * 100).toFixed(2)}%)</b>`;
  }

  // Index of the bar that contains time t (last bar with time <= t), or -1.
  barIndexAt(t) {
    let lo = 0, hi = this.disp.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.disp[mid].time <= t) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return found;
  }

  onCrosshair(p) {
    if (syncing) return;
    if (p.sourceEvent && p.time !== undefined) {
      this.hovering = true;
      this.showLegend(this.barIndexAt(p.time));
      broadcastCrosshair(this, p.time);
    } else if (p.point === undefined && this.hovering) {
      this.hovering = false;
      this.showLegend(this.disp.length - 1);
      broadcastCrosshair(this, undefined);
    }
  }

  // Mirror another chart's crosshair; charts with a different interval snap to the bar containing t.
  followCrosshair(t) {
    if (!this.chart) return;
    const i = t === undefined ? -1 : this.barIndexAt(t);
    this.following = i;
    if (i < 0) {
      this.chart.clearCrosshairPosition();
      this.showLegend(this.disp.length - 1);
      return;
    }
    this.chart.setCrosshairPosition(this.disp[i].close, this.disp[i].time, this.candle);
    this.showLegend(i);
  }

  // Save the chart (with drawings and indicators) as a PNG, titled with symbol, timeframe and time.
  screenshot() {
    if (!this.chart) return;
    const shot = this.chart.takeScreenshot(true);
    const out = document.createElement("canvas");
    const head = 28 * (shot.width / this.chartEl.clientWidth || 1);
    out.width = shot.width;
    out.height = shot.height + head;
    const ctx = out.getContext("2d");
    ctx.fillStyle = "#161a20";
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(shot, 0, head);
    const now = Date.now() / 1000 + TZ_SHIFT;
    ctx.fillStyle = "#d6dbe3";
    ctx.font = `${Math.round(head * 0.5)}px system-ui, sans-serif`;
    ctx.fillText(`${this.symbol} · ${this.iv.label} · ${this.lastEl.textContent} · ${fmtDate(now)} ${fmtTime(now)}`, head * 0.4, head * 0.68);
    const a = document.createElement("a");
    a.href = out.toDataURL("image/png");
    a.download = `${this.symbol}_${this.iv.label}_${new Date((now) * 1000).toISOString().slice(0, 16).replace(/[-:T]/g, "")}.png`;
    a.click();
  }

  destroyChart() {
    if (this.replay) { clearInterval(this.replay.timer); this.replay = null; }
    if (this.replayBar) { this.replayBar.remove(); this.replayBar = null; }
    if (this.overlays) { this.overlays.destroy(); this.overlays = null; }
    this.dayLevels = null;
    if (this.drawings) { this.drawings.destroy(); this.drawings = null; }
    if (this.trades) { this.trades.destroy(); this.trades = null; }
    clearInterval(this.resyncTimer);
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    if (this.chart) { this.chart.remove(); this.chart = null; }
  }

  destroy() {
    this.dead = true;
    this.destroyChart();
  }
}

function shiftBar(b) { b.time += TZ_SHIFT; return b; }

function broadcastCrosshair(source, t) {
  syncing = true;
  try { for (const c of cells) if (c !== source) c.followCrosshair(t); }
  finally { syncing = false; }
}

// ---------- page ----------
const grid = document.getElementById("grid");
const statusEl = document.getElementById("status");
const statusText = document.getElementById("statusText");
let stream = null;
let retryTimer = 0;
let serverName = "";
const lastPrices = {};

function setStatus(kind, message) {
  statusEl.className = "status " + (kind || "");
  const labels = { live: "เชื่อมต่อ MT5 แล้ว", connecting: "กำลังเชื่อมต่อ…", error: "เชื่อมต่อไม่ได้", off: "ยังไม่เชื่อมต่อ" };
  statusText.textContent = labels[kind] + (message ? " · " + message : kind === "live" && serverName ? " · " + serverName : "");
  statusEl.title = message || serverName;
}

function onPrice(p) {
  const prev = lastPrices[p.symbol];
  lastPrices[p.symbol] = p;
  if (prev) checkAlerts(p.symbol, prev.price, p.price);
  for (const c of cells) if (c.symbol === p.symbol) c.onPrice(p);
  updateWatchRow(p.symbol);
  if (p.symbol === activeSymbol()) TradePanel.onTick();
  const t = p.time + TZ_SHIFT;
  statusText.textContent = "เชื่อมต่อ MT5 แล้ว · " + fmtTime(t) + ":" + String(Math.floor(t) % 60).padStart(2, "0");
}

function showMessage(html) {
  for (const c of cells) c.destroy();
  cells = [];
  grid.style.cssText = "grid-template-columns:1fr;grid-template-rows:1fr";
  grid.innerHTML = `<div class="cell"><div class="overlay">${html}</div></div>`;
}

function showSetupHelp(error) {
  const local = servedByBridge ? "" :
    `<div class="hint">หน้านี้ดึงข้อมูลจาก bridge ที่ ${settings.bridgeUrl || DEFAULT_BRIDGE}
     ถ้าเบราว์เซอร์ถามสิทธิ์เข้าถึงอุปกรณ์ในเครือข่าย ให้กดอนุญาต</div>`;
  showMessage(`<div class="error">${escapeHtml(error)}</div>
    <div>1. เปิด MetaTrader 5 และล็อกอินบัญชี<br>2. ดับเบิลคลิก <b>start-bridge.bat</b> ในโฟลเดอร์โปรเจค<br>
    3. เปิด <b>http://localhost:8000</b></div>${local}
    <div class="hint">จะลองเชื่อมต่อใหม่อัตโนมัติทุก 5 วินาที</div>`);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

let activeCell = 0;
let maximized = -1;

function renderGrid() {
  for (const c of cells) c.destroy();
  cells = [];
  grid.innerHTML = "";
  const layout = LAYOUTS[state.layout];
  grid.style.cssText = layout.css;
  while (state.cells.length < layout.n) {
    state.cells.push({ symbol: state.cells[0] ? state.cells[0].symbol : "XAUUSD", interval: "15" });
  }
  if (activeCell >= layout.n) activeCell = 0;
  if (maximized >= layout.n) maximized = -1;
  for (let i = 0; i < layout.n; i++) {
    const cell = new ChartCell(grid, i);
    if (layout.big === i) {
      cell.el.classList.add("big");
      cell.el.style.gridRow = "1 / span 2";
      cell.el.style.gridColumn = "2";
    }
    cells.push(cell);
  }
  applyCellClasses();
  renderSymbolBar();
}

function applyCellClasses() {
  grid.classList.toggle("max", maximized >= 0);
  cells.forEach((c, i) => {
    c.el.classList.toggle("active", i === activeCell && cells.length > 1);
    c.el.classList.toggle("maxed", i === maximized);
  });
}

function setActiveCell(i) {
  if (i === activeCell) return;
  activeCell = i;
  applyCellClasses();
  renderSymbolBar();
  renderDrawToolbar();
  renderWatchlist();
  renderOverlayButtons();
}

function toggleMaximize(i) {
  maximized = maximized === i ? -1 : i;
  applyCellClasses();
}

// With 🔗 on, a symbol change applies to every chart; otherwise only to chart `index`.
function setSymbol(symbol, index = activeCell) {
  if (state.link) state.cells.forEach(c => { c.symbol = symbol; });
  else state.cells[index].symbol = symbol;
  save();
  UI.select(null);
  const changed = cells.filter(c => c.symbol !== state.cells[c.index].symbol);
  for (const c of changed) {
    c.destroy();
    const fresh = new ChartCell(document.createElement("div"), c.index);
    c.el.replaceWith(fresh.el);
    if (c.el.classList.contains("big")) {
      fresh.el.classList.add("big");
      fresh.el.style.cssText = c.el.style.cssText;
    }
    cells[c.index] = fresh;
  }
  applyCellClasses();
  renderSymbolBar();
  renderDrawToolbar();
  renderWatchlist();
}

function activeSymbol() {
  return (state.cells[activeCell] || state.cells[0]).symbol;
}

function renderSymbolBar() {
  const box = document.getElementById("symbols");
  box.innerHTML = "";
  const b = document.createElement("button");
  b.className = "on";
  b.textContent = "🔍 " + activeSymbol();
  b.title = "ค้นหาสัญลักษณ์ใน MT5";
  b.addEventListener("click", () => openSymbolSearch(sym => setSymbol(sym)));
  const link = document.createElement("button");
  link.textContent = state.link ? "🔗" : "⛓️‍💥";
  link.className = state.link ? "on" : "";
  link.title = state.link ? "ทุกช่องใช้สัญลักษณ์เดียวกัน (คลิกเพื่อแยกแต่ละช่อง)" : "แต่ละช่องเลือกสัญลักษณ์เองได้ (คลิกเพื่อผูกทุกช่อง)";
  link.addEventListener("click", () => {
    state.link = !state.link;
    save();
    if (state.link) setSymbol(activeSymbol());
    else renderSymbolBar();
  });
  box.append(b, link);
}

async function connect() {
  clearTimeout(retryTimer);
  if (stream) { stream.stop(); stream = null; }
  Mt5.configure(settings.bridgeUrl);
  setStatus("connecting");
  try {
    const st = await Mt5.status();
    if (!st.ok) throw new Error(st.error || "MT5 ยังไม่พร้อม");
    serverName = st.server + " #" + st.account;
  } catch (e) {
    setStatus("error", e.message);
    showSetupHelp(e.message);
    retryTimer = setTimeout(connect, 5000);
    return;
  }
  renderGrid();
  renderWatchlist();
  refreshWatchInfo();
  Trading.start();
  stream = Mt5.streamTicks(onPrice, setStatus);
}

// ---------- settings dialog ----------
const dlg = document.getElementById("settings");
const form = document.getElementById("settingsForm");
const bridgeInput = document.getElementById("bridgeUrl");

function openSettings() {
  bridgeInput.value = settings.bridgeUrl;
  bridgeInput.placeholder = servedByBridge ? "(ใช้ที่อยู่เดียวกับหน้านี้)" : DEFAULT_BRIDGE;
  dlg.showModal();
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  settings = { bridgeUrl: bridgeInput.value.trim() || (servedByBridge ? "" : DEFAULT_BRIDGE) };
  saveJson(SETTINGS_KEY, settings);
  dlg.close();
  connect();
});
document.getElementById("cancelSettings").addEventListener("click", () => dlg.close());
document.getElementById("openSettings").addEventListener("click", openSettings);

// ---------- toolbar controls ----------
const layoutSel = document.getElementById("layout");
for (const k in LAYOUTS) {
  const o = document.createElement("option");
  o.value = k; o.textContent = LAYOUTS[k].label;
  layoutSel.appendChild(o);
}
layoutSel.value = state.layout;
layoutSel.addEventListener("change", () => { state.layout = layoutSel.value; maximized = -1; save(); renderGrid(); });

function fillSelect(sel, options, value, onChange) {
  for (const [k, label] of Object.entries(options)) {
    const o = document.createElement("option");
    o.value = k; o.textContent = label;
    sel.appendChild(o);
  }
  sel.value = value;
  sel.addEventListener("change", () => onChange(sel.value));
}
// Changing the chart type swaps the series type, so the charts are rebuilt.
fillSelect(document.getElementById("style"), CHART_STYLES, state.style, v => { state.style = v; save(); renderGrid(); });
fillSelect(document.getElementById("scale"), SCALES, state.scale, v => {
  state.scale = v;
  save();
  for (const c of cells) if (c.chart) c.chart.priceScale("right").applyOptions({ mode: { normal: 0, log: 1, percent: 2 }[v] });
});

// ---------- overlays & replay ----------
function renderOverlayButtons() {
  const box = document.getElementById("overlayBtns");
  if (!box) return;
  box.innerHTML = "";
  const toggle = (key, label, title, after) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.title = title;
    b.className = state.overlays[key] ? "on" : "";
    b.addEventListener("click", () => {
      state.overlays[key] = !state.overlays[key];
      save();
      for (const c of cells) if (c.chart) after(c);
      renderOverlayButtons();
    });
    box.appendChild(b);
  };
  toggle("sessions", "Sessions", "แถบสีช่วงตลาด Tokyo / London / New York (กราฟไม่เกิน 1h)", c => c.overlays.update());
  toggle("levels", "H/L", "High/Low วันนี้ และของเมื่อวาน (PDH/PDL)", c => c.loadLevels());
  toggle("profile", "VP", "Volume Profile ของช่วงที่มองเห็น (จาก tick เมื่อช่วงไม่เกิน 1 วัน)", c => {
    c.overlays.profileKey = "";
    if (state.overlays.profile) c.overlays.scheduleProfile(); else c.overlays.update();
  });
  const cell = cells[activeCell];
  const r = document.createElement("button");
  r.textContent = "⏪ Replay";
  r.title = "เล่นกราฟย้อนหลังทีละแท่งในช่องที่เลือก";
  r.className = cell && cell.replay ? "on" : "";
  r.addEventListener("click", () => {
    const c = cells[activeCell];
    if (!c || !c.chart) return;
    if (c.replay) c.stopReplay(); else c.startReplayPick();
  });
  box.appendChild(r);
}

// ---------- saved layouts ----------
// A saved layout is a snapshot of everything on screen except drawings (those stay per symbol).
const LAYOUTS_KEY = "chartMonitorLayouts";
const savedSel = document.getElementById("savedLayouts");

function renderSavedLayouts() {
  const saved = loadJson(LAYOUTS_KEY) || {};
  savedSel.innerHTML = `<option value="">💾 Layout…</option>`;
  for (const name of Object.keys(saved)) {
    const o = document.createElement("option");
    o.value = "load:" + name; o.textContent = "เปิด: " + name;
    savedSel.appendChild(o);
  }
  savedSel.insertAdjacentHTML("beforeend", `<option value="save">+ บันทึก layout นี้…</option>`);
  for (const name of Object.keys(saved)) {
    const o = document.createElement("option");
    o.value = "del:" + name; o.textContent = "ลบ: " + name;
    savedSel.appendChild(o);
  }
}

savedSel.addEventListener("change", () => {
  const v = savedSel.value;
  savedSel.value = "";
  const saved = loadJson(LAYOUTS_KEY) || {};
  if (v === "save") {
    const name = (prompt("ตั้งชื่อ layout นี้") || "").trim();
    if (!name) return;
    const { layout, style, scale, link, indicators, cells: cellList } = state;
    saved[name] = JSON.parse(JSON.stringify({ layout, style, scale, link, indicators, cells: cellList }));
    saveJson(LAYOUTS_KEY, saved);
    toast("บันทึก layout “" + name + "” แล้ว");
  } else if (v.startsWith("load:")) {
    const snap = saved[v.slice(5)];
    if (!snap) return;
    state = normalizeState(Object.assign(state, JSON.parse(JSON.stringify(snap))));
    save();
    layoutSel.value = state.layout;
    document.getElementById("style").value = state.style;
    document.getElementById("scale").value = state.scale;
    maximized = -1;
    renderGrid();
  } else if (v.startsWith("del:") && confirm("ลบ layout “" + v.slice(4) + "” ?")) {
    delete saved[v.slice(4)];
    saveJson(LAYOUTS_KEY, saved);
  }
  renderSavedLayouts();
});

// ---------- symbol search ----------
const searchDlg = document.getElementById("searchDialog");
const searchInput = document.getElementById("searchInput");
const searchList = document.getElementById("searchList");
let searchPick = null, searchTimer = 0, searchSeq = 0;

function openSymbolSearch(onPick) {
  searchPick = onPick;
  searchInput.value = "";
  searchDlg.showModal();
  searchInput.focus();
  runSearch();
}

async function runSearch() {
  const seq = ++searchSeq;
  let list;
  try { list = await Mt5.search(searchInput.value); }
  catch (e) { searchList.innerHTML = `<p class="error">${escapeHtml(e.message)}</p>`; return; }
  if (seq !== searchSeq) return;
  searchList.innerHTML = list.length ? "" : `<p class="hint">ไม่พบสัญลักษณ์</p>`;
  for (const s of list) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "result";
    row.innerHTML = `<b>${escapeHtml(s.name)}</b><span>${escapeHtml(s.description || "")}</span><span class="hint">${escapeHtml(s.path || "")}</span>`;
    row.addEventListener("click", () => { searchDlg.close(); if (searchPick) searchPick(s.name); });
    searchList.appendChild(row);
  }
}
searchInput.addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 200); });
searchInput.addEventListener("keydown", e => {
  if (e.key === "Enter") { e.preventDefault(); const first = searchList.querySelector(".result"); if (first) first.click(); }
});
document.getElementById("closeSearch").addEventListener("click", () => searchDlg.close());

// ---------- watchlist ----------
const watchEl = document.getElementById("watchlist");

function renderWatchlist() {
  document.body.classList.toggle("show-watch", state.showWatchlist);
  document.body.classList.toggle("show-trade", state.showTrade);
  document.body.classList.toggle("with-watchlist", state.showWatchlist || state.showTrade);
  document.getElementById("toggleWatchlist").classList.toggle("on", state.showWatchlist);
  document.getElementById("toggleTrade").classList.toggle("on", state.showTrade);
  TradePanel.render();
  const body = document.getElementById("watchRows");
  body.innerHTML = "";
  for (const symbol of state.watchlist) {
    const row = document.createElement("div");
    row.className = "wrow" + (symbol === activeSymbol() ? " on" : "");
    row.dataset.symbol = symbol;
    row.innerHTML = `<span class="sym">${escapeHtml(symbol)}</span><span class="px"></span><span class="chg"></span><span class="spr"></span>`;
    const del = document.createElement("button");
    del.className = "icon del";
    del.textContent = "✕";
    del.title = "เอาออกจาก watchlist";
    del.addEventListener("click", e => {
      e.stopPropagation();
      state.watchlist = state.watchlist.filter(s => s !== symbol);
      save(); renderWatchlist();
    });
    row.appendChild(del);
    row.addEventListener("click", () => setSymbol(symbol));
    body.appendChild(row);
    updateWatchRow(symbol);
  }
}

function updateWatchRow(symbol) {
  const row = watchEl.querySelector(`.wrow[data-symbol="${CSS.escape(symbol)}"]`);
  const p = lastPrices[symbol], info = brokerSymbols[symbol];
  if (!row || !p || !info) return;
  row.querySelector(".px").textContent = p.price.toFixed(info.digits);
  if (info.dayOpen) {
    const chg = (p.price - info.dayOpen) / info.dayOpen * 100;
    const el = row.querySelector(".chg");
    el.textContent = (chg >= 0 ? "+" : "") + chg.toFixed(2) + "%";
    el.className = "chg " + (chg >= 0 ? "up" : "down");
  }
  row.querySelector(".spr").textContent = p.ask ? (p.ask - p.bid).toFixed(info.digits) : "";
}

// /api/info also subscribes the symbol to the stream; refresh it now and then for the day's open.
function refreshWatchInfo() {
  for (const symbol of state.watchlist) {
    delete brokerSymbols[symbol];
    ensureInfo(symbol).then(() => updateWatchRow(symbol)).catch(() => {
      const row = watchEl.querySelector(`.wrow[data-symbol="${CSS.escape(symbol)}"] .px`);
      if (row) row.textContent = "ไม่พบ";
    });
  }
}
setInterval(() => { if (stream) refreshWatchInfo(); }, 10 * 60 * 1000);

document.getElementById("addWatch").addEventListener("click", () => openSymbolSearch(sym => {
  if (!state.watchlist.includes(sym)) state.watchlist.push(sym);
  save(); renderWatchlist(); ensureInfo(sym).then(() => updateWatchRow(sym)).catch(() => {});
}));
document.getElementById("toggleWatchlist").addEventListener("click", () => {
  state.showWatchlist = !state.showWatchlist;
  save(); renderWatchlist();
});
document.getElementById("toggleTrade").addEventListener("click", () => {
  state.showTrade = !state.showTrade;
  save(); renderWatchlist();
});
TradePanel.init();

// ---------- drawing tools ----------
let activeTool = "cursor";
let selection = null;              // { symbol, id } of the selected drawing
const UI = {
  tool: () => activeTool,
  setTool(name) {
    activeTool = name;
    if (name !== "cursor") selection = null;
    for (const c of cells) if (c.drawings && name === "cursor") c.drawings.cancel();
    renderDrawToolbar();
  },
  selected: () => selection,
  select(symbol, id) {
    selection = symbol ? { symbol, id } : null;
    renderDrawToolbar();
    for (const c of cells) if (c.drawings) c.drawings.update();
  }
};

function selectedDrawing() {
  return selection && Drawings.get(selection.symbol, selection.id);
}

function renderDrawToolbar() {
  const box = document.getElementById("tools");
  box.innerHTML = "";
  for (const [name, t] of Object.entries(Drawings.TOOLS)) {
    const b = document.createElement("button");
    b.textContent = t.label;
    b.title = t.title;
    if (name === activeTool) b.classList.add("on");
    b.addEventListener("click", () => UI.setTool(activeTool === name ? "cursor" : name));
    box.appendChild(b);
  }
  const clear = document.createElement("button");
  clear.textContent = "🗑";
  const sym = activeSymbol();
  clear.title = "ลบเส้นทั้งหมดของ " + sym;
  clear.addEventListener("click", () => {
    if (Drawings.list(sym).length && confirm("ลบเส้นทั้งหมดของ " + sym + " ?")) {
      Drawings.clear(sym); UI.select(null);
    }
  });
  const undo = document.createElement("button");
  undo.className = "undo";
  undo.textContent = "↶";
  undo.title = "ย้อนกลับการวาด (Ctrl+Z)";
  undo.disabled = !Drawings.canUndo();
  undo.addEventListener("click", undoDrawing);
  box.appendChild(undo);
  box.appendChild(clear);

  // Options for the selected drawing: colour, alert (horizontal lines), delete.
  const opts = document.getElementById("drawOptions");
  opts.innerHTML = "";
  const d = selectedDrawing();
  opts.hidden = !d;
  if (!d) return;
  for (const color of Drawings.COLORS) {
    const s = document.createElement("button");
    s.className = "swatch" + (d.color === color ? " on" : "");
    s.style.background = color;
    s.title = "เปลี่ยนสี";
    s.addEventListener("click", () => { Drawings.checkpoint(); d.color = color; Drawings.changed(selection.symbol); renderDrawToolbar(); });
    opts.appendChild(s);
  }
  if (d.type === "hline") {
    const a = document.createElement("button");
    const on = d.alert && d.alert.active;
    a.textContent = on ? "🔔 ปิด alert" : "🔔 ตั้ง alert";
    a.className = on ? "on" : "";
    a.title = "เตือนเมื่อราคาแตะเส้นนี้";
    a.addEventListener("click", () => { toggleAlert(selection.symbol, d); renderDrawToolbar(); });
    opts.appendChild(a);
  }
  const del = document.createElement("button");
  del.textContent = "ลบ";
  del.title = "ลบเส้นนี้ (Delete)";
  del.addEventListener("click", deleteSelected);
  opts.appendChild(del);
}

function deleteSelected() {
  if (!selection) return;
  Drawings.remove(selection.symbol, selection.id);
  UI.select(null);
  renderAlertCount();
}

Drawings.onChange(() => {
  const u = document.querySelector("#tools .undo");
  if (u) u.disabled = !Drawings.canUndo();
});

function undoDrawing() {
  if (!Drawings.undo()) return;
  if (selection && !selectedDrawing()) selection = null;
  renderDrawToolbar();
  renderAlertCount();
}

// TradingView-style shortcuts. Alt+letter picks a drawing tool; the cursor tool is Esc.
const SHORTCUT_TOOLS = { t: "trend", r: "ray", h: "hline", v: "vline", b: "rect", f: "fib" };
document.addEventListener("keydown", (e) => {
  if (e.target.closest("input, select, textarea, dialog")) return;
  const key = e.key.toLowerCase();
  if (e.key === "Escape") { UI.setTool("cursor"); UI.select(null); if (maximized >= 0) toggleMaximize(maximized); return; }
  if ((e.key === "Delete" || e.key === "Backspace") && selection) { e.preventDefault(); deleteSelected(); return; }
  if ((e.ctrlKey || e.metaKey) && key === "z") { e.preventDefault(); undoDrawing(); return; }
  if (e.altKey && SHORTCUT_TOOLS[key]) { e.preventDefault(); UI.setTool(SHORTCUT_TOOLS[key]); return; }
  if (e.altKey && key === "s") { e.preventDefault(); if (cells[activeCell]) cells[activeCell].screenshot(); return; }
  if (e.altKey && key === "w") { e.preventDefault(); document.getElementById("toggleWatchlist").click(); return; }
  if (e.altKey && key === "enter") { e.preventDefault(); toggleMaximize(activeCell); return; }
  const cell = cells[activeCell];
  if (e.shiftKey && e.key === "ArrowRight" && cell && cell.replay) { e.preventDefault(); cell.replayStep(); return; }
  // Type a symbol name (like TradingView): any letter opens the search with it filled in.
  if (!e.altKey && !e.ctrlKey && !e.metaKey && /^[a-z]$/i.test(e.key)) {
    e.preventDefault();
    openSymbolSearch(sym => setSymbol(sym));
    searchInput.value = e.key.toUpperCase();
    runSearch();
  }
});

// ---------- alerts ----------
// Alerts are horizontal lines with alert.active; they fire once when a tick crosses the line.
let audioCtx = null;
document.addEventListener("pointerdown", () => {
  // Browsers only allow sound after a user gesture; unlock it on the first click.
  if (!audioCtx) try { audioCtx = new AudioContext(); } catch (e) {}
}, { once: true });

function beep() {
  if (!audioCtx) return;
  const now = audioCtx.currentTime;
  for (const [i, f] of [880, 1320, 880].entries()) {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, now + i * 0.18);
    g.gain.exponentialRampToValueAtTime(0.25, now + i * 0.18 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.18 + 0.16);
    o.connect(g).connect(audioCtx.destination);
    o.start(now + i * 0.18);
    o.stop(now + i * 0.18 + 0.17);
  }
}

function toggleAlert(symbol, d) {
  const on = !(d.alert && d.alert.active);
  d.alert = { active: on, firedAt: on ? null : (d.alert && d.alert.firedAt) || null };
  Drawings.changed(symbol);
  if (on && "Notification" in window && Notification.permission === "default") Notification.requestPermission();
  renderAlertCount();
}

function checkAlerts(symbol, prev, price) {
  for (const d of Drawings.list(symbol)) {
    if (d.type !== "hline" || !d.alert || !d.alert.active) continue;
    const level = d.p1.price;
    if ((prev < level && price >= level) || (prev > level && price <= level)) fireAlert(symbol, d, price);
  }
}

function fireAlert(symbol, d, price) {
  d.alert = { active: false, firedAt: Date.now() };
  Drawings.changed(symbol);
  const digits = brokerSymbols[symbol] ? brokerSymbols[symbol].digits : 2;
  const text = `${symbol} แตะ ${d.p1.price.toFixed(digits)} (ราคา ${price.toFixed(digits)})`;
  beep();
  toast("🔔 " + text);
  if ("Notification" in window && Notification.permission === "granted") {
    try { new Notification("Chart Monitor alert", { body: text }); } catch (e) {}
  }
  renderAlertCount();
  if (selection && selection.id === d.id) renderDrawToolbar();
}

function toast(text) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = text;
  el.addEventListener("click", () => el.remove());
  document.getElementById("toasts").appendChild(el);
  setTimeout(() => el.remove(), 15000);
}

function allAlerts() {
  const out = [];
  for (const [symbol, list] of Object.entries(Drawings.all())) {
    for (const d of list) if (d.type === "hline" && d.alert) out.push({ symbol, d });
  }
  return out;
}

function renderAlertCount() {
  const n = allAlerts().filter(a => a.d.alert.active).length;
  document.getElementById("openAlerts").textContent = "🔔 " + n;
}

const alertsDlg = document.getElementById("alertsDialog");
function renderAlertsList() {
  const box = document.getElementById("alertsList");
  box.innerHTML = "";
  const list = allAlerts();
  if (!list.length) {
    box.innerHTML = `<p class="hint">ยังไม่มี alert — วาดเส้นแนวนอน (─) แล้วกด “🔔 ตั้ง alert”</p>`;
    return;
  }
  for (const { symbol, d } of list) {
    const digits = brokerSymbols[symbol] ? brokerSymbols[symbol].digits : 2;
    const row = document.createElement("div");
    row.className = "row";
    const fired = d.alert.firedAt ? "แจ้งแล้ว " + new Date(d.alert.firedAt).toLocaleTimeString("th-TH") : "";
    row.innerHTML = `<span class="name">${escapeHtml(symbol)}</span><span>${d.p1.price.toFixed(digits)}</span>
      <span class="hint">${d.alert.active ? "รอราคา" : fired}</span><span class="spacer"></span>`;
    const toggle = document.createElement("button");
    toggle.textContent = d.alert.active ? "ปิด" : "เปิดใหม่";
    toggle.addEventListener("click", () => { toggleAlert(symbol, d); renderAlertsList(); renderDrawToolbar(); });
    const del = document.createElement("button");
    del.textContent = "ลบเส้น";
    del.addEventListener("click", () => {
      Drawings.remove(symbol, d.id);
      if (selection && selection.id === d.id) UI.select(null);
      renderAlertsList(); renderAlertCount();
    });
    row.append(toggle, del);
    box.appendChild(row);
  }
}
document.getElementById("openAlerts").addEventListener("click", () => { renderAlertsList(); alertsDlg.showModal(); });
document.getElementById("closeAlerts").addEventListener("click", () => alertsDlg.close());

// ---------- indicator dialog ----------
const indDlg = document.getElementById("indDialog");
let indDraft = [];

function renderIndicatorList() {
  const box = document.getElementById("indList");
  box.innerHTML = "";
  if (!indDraft.length) box.innerHTML = `<p class="hint">ยังไม่มี indicator</p>`;
  indDraft.forEach((inst, idx) => {
    const def = INDICATOR_DEFS[inst.type];
    const row = document.createElement("div");
    row.className = "row";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = def.name;
    row.appendChild(name);
    for (const [key, dflt] of Object.entries(def.params)) {
      const label = document.createElement("label");
      label.textContent = key;
      const input = document.createElement("input");
      input.type = "number";
      input.min = key === "mult" ? "0.1" : "1";
      input.step = key === "mult" ? "0.1" : "1";
      input.value = inst.params[key] !== undefined ? inst.params[key] : dflt;
      input.addEventListener("change", () => {
        const v = parseFloat(input.value);
        if (v > 0) inst.params[key] = key === "mult" ? v : Math.round(v);
      });
      label.appendChild(input);
      row.appendChild(label);
    }
    def.outputs.forEach((o, k) => {
      const c = document.createElement("input");
      c.type = "color";
      c.value = (inst.colors && inst.colors[k]) || o.color;
      c.title = "สี";
      c.addEventListener("input", () => { inst.colors = inst.colors || []; inst.colors[k] = c.value; });
      row.appendChild(c);
    });
    const spacer = document.createElement("span");
    spacer.className = "spacer";
    const del = document.createElement("button");
    del.textContent = "ลบ";
    del.addEventListener("click", () => { indDraft.splice(idx, 1); renderIndicatorList(); });
    row.append(spacer, del);
    box.appendChild(row);
  });
}

const indAdd = document.getElementById("indAdd");
for (const [type, def] of Object.entries(INDICATOR_DEFS)) {
  const o = document.createElement("option");
  o.value = type; o.textContent = def.name;
  indAdd.appendChild(o);
}
document.getElementById("indAddBtn").addEventListener("click", () => {
  indDraft.push({ id: indAdd.value + Date.now().toString(36), type: indAdd.value, params: {} });
  renderIndicatorList();
});
document.getElementById("openIndicators").addEventListener("click", () => {
  indDraft = JSON.parse(JSON.stringify(state.indicators));
  renderIndicatorList();
  indDlg.showModal();
});
document.getElementById("cancelIndicators").addEventListener("click", () => indDlg.close());
document.getElementById("indForm").addEventListener("submit", (e) => {
  e.preventDefault();
  state.indicators = indDraft;
  save();
  indDlg.close();
  renderGrid();
});

// ---------- bar countdown ----------
setInterval(() => {
  const now = Date.now() / 1000;
  for (const c of cells) c.updateCountdown(now);
}, 1000);

renderSymbolBar();
renderOverlayButtons();
renderSavedLayouts();
renderWatchlist();
renderDrawToolbar();
renderAlertCount();
connect();
