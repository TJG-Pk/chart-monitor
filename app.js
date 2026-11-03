// ===== ตั้งค่า (แก้ตรงนี้ได้) =====
// ชื่อสัญลักษณ์ต้องตรงกับ SYMBOL_CANDIDATES ใน bridge/bridge.py
const SYMBOLS = ["XAUUSD", "NASDAQ"];
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
  symbol: "XAUUSD", layout: "2x2", style: "candles", stoch: true, rsi: true,
  intervals: ["1", "5", "15", "60"]
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
  k: "#2f81f7", d: "#f0883e", rsi: "#a371f7", band: "#4b5563" };

const STATE_KEY = "chartMonitorState";
const SETTINGS_KEY = "chartMonitorBridge";

function loadJson(key) {
  try { return JSON.parse(localStorage.getItem(key) || "null"); } catch (e) { return null; }
}
function saveJson(key, value) {
  try { value === null ? localStorage.removeItem(key) : localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
}

let state = Object.assign({}, DEFAULT_STATE, { intervals: DEFAULT_STATE.intervals.slice() });
{
  const saved = loadJson(STATE_KEY);
  if (saved && SYMBOLS.includes(saved.symbol) && LAYOUTS[saved.layout]) {
    state = Object.assign(state, saved);
    if (saved.style === "8") state.style = "ha";            // ค่าจากเวอร์ชัน widget เดิม
    if (state.style !== "ha") state.style = "candles";
    state.intervals = (Array.isArray(saved.intervals) ? saved.intervals : []).map(v => INTERVALS[v] ? v : "15");
  }
}

// Served by the bridge itself -> same origin. Opened elsewhere (e.g. GitHub Pages) -> local bridge.
const servedByBridge = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && location.protocol === "http:";
let settings = Object.assign({ bridgeUrl: servedByBridge ? "" : DEFAULT_BRIDGE }, loadJson(SETTINGS_KEY) || {});
let brokerSymbols = {};        // display name -> { name, digits } from the bridge

function save() { saveJson(STATE_KEY, state); }

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
    this.symbol = state.symbol;
    this.precision = brokerSymbols[this.symbol].digits;
    this.iv = INTERVALS[state.intervals[index]];
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
    const header = document.createElement("header");
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = this.symbol;
    const src = document.createElement("span");
    src.textContent = "MT5:" + brokerSymbols[this.symbol].name;
    this.sel = document.createElement("select");
    for (const [k, iv] of INTERVAL_LIST) {
      const o = document.createElement("option");
      o.value = k; o.textContent = iv.label;
      if (k === state.intervals[index]) o.selected = true;
      this.sel.appendChild(o);
    }
    this.sel.addEventListener("change", () => {
      state.intervals[index] = this.sel.value;
      save();
      this.destroyChart();
      this.iv = INTERVALS[this.sel.value];
      this.start();
    });
    this.lastEl = document.createElement("span");
    this.lastEl.className = "last";
    header.append(name, src, this.sel, this.lastEl);

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
    this.candle = chart.addSeries(LW.CandlestickSeries, {
      upColor: COLORS.up, downColor: COLORS.down, wickUpColor: COLORS.up, wickDownColor: COLORS.down,
      borderVisible: false, priceFormat: { type: "price", precision: this.precision, minMove }
    });
    this.volume = chart.addSeries(LW.HistogramSeries, {
      priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false
    });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

    const line = (pane, color) => chart.addSeries(LW.LineSeries, {
      color, lineWidth: 1, priceLineVisible: false, crosshairMarkerVisible: false,
      priceFormat: { type: "price", precision: 2, minMove: 0.01 }
    }, pane);
    const band = (series, price) => series.createPriceLine({
      price, color: COLORS.band, lineWidth: 1, lineStyle: LW.LineStyle.Dashed, axisLabelVisible: false
    });

    let pane = 1;
    this.stochK = this.stochD = this.rsi = null;
    if (state.stoch) {
      this.stochK = line(pane, COLORS.k);
      this.stochD = line(pane, COLORS.d);
      band(this.stochK, 80); band(this.stochK, 20);
      pane++;
    }
    if (state.rsi) {
      this.rsi = line(pane, COLORS.rsi);
      band(this.rsi, 70); band(this.rsi, 50); band(this.rsi, 30);
      pane++;
    }
    const panes = chart.panes();
    panes[0].setStretchFactor(3);
    for (let i = 1; i < panes.length; i++) panes[i].setStretchFactor(1);

    chart.subscribeCrosshairMove(p => this.onCrosshair(p));
    chart.timeScale().subscribeVisibleLogicalRangeChange(r => {
      if (r && r.from < 20) this.loadOlder();
    });
    this.chart = chart;
  }

  async start() {
    this.dead = false;
    this.noMoreHistory = false;
    this.bars = [];
    this.showOverlay("กำลังโหลด…");
    this.createChart();
    const gen = this.chart;
    try {
      const bars = await Mt5.candles(this.symbol, this.iv.tf, { count: HISTORY_BARS });
      if (this.dead || gen !== this.chart) return;
      this.bars = bars.map(shiftBar);
      if (!this.bars.length) { this.showOverlay("ไม่มีข้อมูลสำหรับสัญลักษณ์นี้", true); return; }
      this.overlay.hidden = true;
      this.render(true);
      this.resyncTimer = setInterval(() => this.resync(), RESYNC_MS);
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
    if (!this.frame) this.frame = requestAnimationFrame(() => { this.frame = 0; this.render(false); });
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
      this.render(true);
    } catch (e) {
      this.noMoreHistory = true;
    } finally {
      this.loadingOlder = false;
    }
  }

  render(full) {
    if (!this.chart || !this.bars.length) return;
    const disp = state.style === "ha" ? Indicators.heikinAshi(this.bars) : this.bars;
    this.disp = disp;
    const ohlc = b => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close });
    const vol = b => ({ time: b.time, value: b.volume, color: b.close >= b.open ? COLORS.volUp : COLORS.volDown });
    const pts = (values) => values.map((v, i) => v === null ? { time: disp[i].time } : { time: disp[i].time, value: v });
    const lines = [];
    if (this.stochK) {
      const s = Indicators.stochastic(this.bars);
      lines.push([this.stochK, s.k], [this.stochD, s.d]);
    }
    if (this.rsi) lines.push([this.rsi, Indicators.rsi(this.bars)]);

    if (full) {
      this.candle.setData(disp.map(ohlc));
      this.volume.setData(disp.map(vol));
      for (const [series, values] of lines) series.setData(pts(values));
    } else {
      const i = disp.length - 1;
      this.candle.update(ohlc(disp[i]));
      this.volume.update(vol(disp[i]));
      for (const [series, values] of lines) {
        series.update(values[i] === null ? { time: disp[i].time } : { time: disp[i].time, value: values[i] });
      }
    }

    const last = this.bars[this.bars.length - 1];
    const prev = this.bars[this.bars.length - 2];
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

  destroyChart() {
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
  lastPrices[p.symbol] = p;
  for (const c of cells) if (c.symbol === p.symbol) c.onPrice(p);
  const px = document.querySelector(`#symbols button[data-symbol="${p.symbol}"] .px`);
  if (px && brokerSymbols[p.symbol]) px.textContent = p.price.toFixed(brokerSymbols[p.symbol].digits);
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

function renderGrid() {
  for (const c of cells) c.destroy();
  cells = [];
  grid.innerHTML = "";
  if (!brokerSymbols[state.symbol]) {
    showMessage(`<div class="error">ไม่พบ ${escapeHtml(state.symbol)} ใน MT5 ของคุณ</div>
      <div class="hint">เพิ่มสัญลักษณ์ใน Market Watch หรือกำหนดชื่อด้วย --symbol ${escapeHtml(state.symbol)}=ชื่อในMT5</div>`);
    return;
  }
  const layout = LAYOUTS[state.layout];
  grid.style.cssText = layout.css;
  for (let i = 0; i < layout.n; i++) {
    if (!state.intervals[i]) state.intervals[i] = "15";
    const cell = new ChartCell(grid, i);
    if (layout.big === i) {
      cell.el.classList.add("big");
      cell.el.style.gridRow = "1 / span 2";
      cell.el.style.gridColumn = "2";
    }
    cells.push(cell);
  }
}

function renderToolbar() {
  const box = document.getElementById("symbols");
  box.innerHTML = "";
  for (const name of SYMBOLS) {
    const b = document.createElement("button");
    b.dataset.symbol = name;
    b.innerHTML = `${name} <span class="px"></span>`;
    const info = brokerSymbols[name];
    if (info) b.title = "MT5: " + info.name;
    const lp = lastPrices[name];
    if (lp && info) b.querySelector(".px").textContent = lp.price.toFixed(info.digits);
    if (name === state.symbol) b.classList.add("on");
    b.addEventListener("click", () => {
      state.symbol = name; save(); renderToolbar(); renderGrid();
    });
    box.appendChild(b);
  }
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
    brokerSymbols = await Mt5.symbols();
  } catch (e) {
    setStatus("error", e.message);
    showSetupHelp(e.message);
    retryTimer = setTimeout(connect, 5000);
    return;
  }
  renderToolbar();
  renderGrid();
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
layoutSel.addEventListener("change", () => { state.layout = layoutSel.value; save(); renderGrid(); });

const styleSel = document.getElementById("style");
styleSel.value = state.style;
styleSel.addEventListener("change", () => { state.style = styleSel.value; save(); for (const c of cells) c.render(true); });

for (const id of ["stoch", "rsi"]) {
  const cb = document.getElementById(id);
  cb.checked = !!state[id];
  cb.addEventListener("change", () => { state[id] = cb.checked; save(); renderGrid(); });
}

renderToolbar();
connect();
