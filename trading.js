// Trading UI: order panel, positions and orders drawn on the charts (SL/TP draggable), and the
// trade journal. Orders go through bridge/trading.py, which refuses them on non-demo accounts
// and enforces the daily loss limit and max lot, whatever this page sends.
const Trading = (() => {
  let snap = null;                 // last /api/trading answer, or { error }
  let timer = 0;
  const listeners = new Set();

  async function refresh() {
    try { snap = await Mt5.trading(); } catch (e) { snap = { error: e.message }; }
    for (const fn of listeners) fn(snap);
  }

  async function act(path, body, okText) {
    try {
      const r = await Mt5.post(path, body);
      toast("✅ " + okText);
      refresh();
      return r;
    } catch (e) {
      toast("❌ " + e.message);
      throw e;
    }
  }

  return {
    start() { if (!timer) { refresh(); timer = setInterval(refresh, 1000); } },
    stop() { clearInterval(timer); timer = 0; },
    refresh,
    get: () => snap,
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    place: (o, text) => act("/api/order", o, text),
    modify: (o, text) => act("/api/modify", o, text),
    close: (o, text) => act("/api/close", o, text),
    cancel: (o, text) => act("/api/cancel", o, text),
    setRisk: (o) => act("/api/risk", o, "บันทึกการจำกัดความเสี่ยงแล้ว")
  };
})();

const CONFIRM_KEY = "chartMonitorTradeConfirm";
const NOTES_KEY = "chartMonitorJournalNotes";

function confirmTrades() {
  try { return localStorage.getItem(CONFIRM_KEY) !== "0"; } catch (e) { return true; }
}

// Ask before sending, unless the user switched confirmations off in the panel.
function confirmTrade(text) {
  return !confirmTrades() || confirm(text + "\n\nส่งคำสั่งนี้?");
}

// Money P/L of moving `volume` lots from `from` to `to` (positive = in the trade's favour).
function moneyBetween(symbol, side, volume, from, to) {
  const info = brokerSymbols[symbol];
  if (!info || !info.tickSize || !info.tickValue) return null;
  const dir = side === "buy" ? 1 : -1;
  return (to - from) * dir / info.tickSize * info.tickValue * volume;
}

const fmtMoney = v => (v >= 0 ? "+" : "") + v.toFixed(2);

// ---------- chart layer ----------
class TradeLayer {
  constructor(cell) {
    this.cell = cell;
    this.requestUpdate = null;
    this.drag = null;
    this.hitBoxes = [];             // close buttons drawn in the last frame
    this.unsubscribe = Trading.onChange(() => this.update());
    this.handlers = {
      pointerdown: e => this.onDown(e),
      pointermove: e => this.onMove(e),
      pointerup: e => this.onUp(e),
      mousedown: e => { if (this.swallow) { e.stopImmediatePropagation(); e.stopPropagation(); this.swallow = false; } }
    };
    // Registered before the drawing layer's listeners, so a trade line wins over a drawing.
    for (const [type, fn] of Object.entries(this.handlers)) cell.chartEl.addEventListener(type, fn, true);
    cell.candle.attachPrimitive(this);
  }

  destroy() {
    this.unsubscribe();
    for (const [type, fn] of Object.entries(this.handlers)) this.cell.chartEl.removeEventListener(type, fn, true);
  }

  attached({ requestUpdate }) { this.requestUpdate = requestUpdate; }
  detached() { this.requestUpdate = null; }
  update() { if (this.requestUpdate) this.requestUpdate(); }
  paneViews() { return [{ zOrder: () => "top", renderer: () => ({ draw: t => this.draw(t) }) }]; }

  // Lines for this chart's symbol: { kind: entry|sl|tp|pending, item, price, ... }
  lines() {
    const s = Trading.get();
    if (!s || s.error || this.cell.replay) return [];
    const out = [];
    for (const p of s.positions) {
      if (p.symbol !== this.cell.symbol) continue;
      out.push({ kind: "entry", item: p, price: p.price });
      if (p.sl) out.push({ kind: "sl", item: p, price: p.sl });
      if (p.tp) out.push({ kind: "tp", item: p, price: p.tp });
    }
    for (const o of s.orders) {
      if (o.symbol !== this.cell.symbol) continue;
      out.push({ kind: "pending", item: o, price: o.price });
      if (o.sl) out.push({ kind: "sl", item: o, price: o.sl });
      if (o.tp) out.push({ kind: "tp", item: o, price: o.tp });
    }
    // While dragging, show the line at its new price.
    const g = this.drag;
    if (g && g.price !== undefined) {
      const same = out.find(l => l.item.ticket === g.line.item.ticket && l.kind === g.target);
      if (same) same.price = g.price;
      else out.push({ kind: g.target, item: g.line.item, price: g.price, preview: true });
    }
    return out;
  }

  label(line) {
    const it = line.item, sym = this.cell.symbol;
    const vol = it.volume;
    if (line.kind === "entry") return `${it.side.toUpperCase()} ${vol}  ${fmtMoney(it.profit)}`;
    if (line.kind === "pending") return `${it.side.toUpperCase()} ${it.type.toUpperCase()} ${vol}`;
    const m = moneyBetween(sym, it.side, vol, it.price, line.price);
    return `${line.kind.toUpperCase()} ${line.price.toFixed(this.cell.precision)}` + (m === null ? "" : `  ${fmtMoney(m)}`);
  }

  color(line) {
    if (line.kind === "sl") return "#ef5350";
    if (line.kind === "tp") return "#26a69a";
    if (line.kind === "pending") return "#f0883e";
    return line.item.side === "buy" ? "#2f81f7" : "#db61a2";
  }

  draw(target) {
    const lines = this.lines();
    this.hitBoxes = [];
    if (!lines.length) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize: size }) => {
      ctx.font = "11px system-ui, sans-serif";
      for (const line of lines) {
        const y = this.cell.candle.priceToCoordinate(line.price);
        if (y === null) continue;
        const color = this.color(line);
        ctx.strokeStyle = color;
        ctx.lineWidth = line.kind === "entry" ? 1.5 : 1;
        ctx.setLineDash(line.kind === "entry" ? [] : [6, 4]);
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(size.width, y); ctx.stroke();
        ctx.setLineDash([]);
        const text = this.label(line);
        const w = ctx.measureText(text).width + 12, x = 60;
        ctx.fillStyle = color;
        ctx.fillRect(x, y - 9, w, 18);
        ctx.fillStyle = "#fff";
        ctx.fillText(text, x + 6, y + 4);
        if (line.kind === "entry" || line.kind === "pending") {      // close / cancel button
          ctx.fillStyle = "#0e1013";
          ctx.fillRect(x + w, y - 9, 18, 18);
          ctx.strokeStyle = color; ctx.strokeRect(x + w + 0.5, y - 8.5, 17, 17);
          ctx.fillStyle = "#fff";
          ctx.fillText("✕", x + w + 5, y + 4);
          this.hitBoxes.push({ x: x + w, y: y - 9, w: 18, h: 18, line });
        }
      }
    });
  }

  local(e) {
    const r = this.cell.chartEl.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const chart = this.cell.chart;
    const inPane = !!chart && x >= 0 && x < chart.timeScale().width() && y >= 0 && y < chart.panes()[0].getHeight();
    return { x, y, inPane };
  }

  hit(pt) {
    for (const b of this.hitBoxes) {
      if (pt.x >= b.x && pt.x <= b.x + b.w && pt.y >= b.y && pt.y <= b.y + b.h) return { line: b.line, button: true };
    }
    for (const line of this.lines()) {
      const y = this.cell.candle.priceToCoordinate(line.price);
      if (y !== null && Math.abs(pt.y - y) <= 5) return { line, button: false };
    }
    return null;
  }

  block(e) {
    e.stopImmediatePropagation();
    e.stopPropagation();
    e.preventDefault();
    this.swallow = true;
    this.cell.chart.applyOptions({ handleScroll: false, handleScale: false });
  }

  onDown(e) {
    if (e.button !== 0 || UI.tool() !== "cursor") return;
    const pt = this.local(e);
    if (!pt.inPane) return;
    const h = this.hit(pt);
    if (!h) return;
    this.block(e);
    const it = h.line.item, sym = this.cell.symbol;
    if (h.button) {
      this.cell.chart.applyOptions({ handleScroll: true, handleScale: true });
      if (h.line.kind === "entry") {
        if (confirmTrade(`ปิด ${it.side.toUpperCase()} ${it.volume} ${sym} (#${it.ticket}) กำไร/ขาดทุน ${fmtMoney(it.profit)}`)) {
          Trading.close({ ticket: it.ticket }, `ปิด #${it.ticket} แล้ว`).catch(() => {});
        }
      } else if (confirmTrade(`ยกเลิก ${it.side.toUpperCase()} ${it.type.toUpperCase()} ${it.volume} ${sym} @ ${it.price}`)) {
        Trading.cancel({ ticket: it.ticket }, `ยกเลิก #${it.ticket} แล้ว`).catch(() => {});
      }
      return;
    }
    // Dragging the entry line of a position sets a new SL or TP depending on direction.
    this.drag = { line: h.line, target: h.line.kind === "entry" ? null : h.line.kind };
    this.cell.chartEl.setPointerCapture(e.pointerId);
  }

  onMove(e) {
    const pt = this.local(e);
    if (!this.drag) {
      if (UI.tool() === "cursor" && pt.inPane) {
        const h = this.hit(pt);
        if (h) this.cell.chartEl.style.cursor = h.button ? "pointer" : "ns-resize";
      }
      return;
    }
    e.stopImmediatePropagation();
    const price = this.cell.candle.coordinateToPrice(pt.y);
    if (price === null) return;
    const g = this.drag, it = g.line.item;
    if (g.line.kind === "entry") {
      const favour = (price - it.price) * (it.side === "buy" ? 1 : -1) > 0;
      g.target = favour ? "tp" : "sl";
    }
    g.price = +price.toFixed(this.cell.precision);
    this.update();
  }

  onUp(e) {
    const g = this.drag;
    if (!g) return;
    this.drag = null;
    try { this.cell.chartEl.releasePointerCapture(e.pointerId); } catch (err) {}
    this.cell.chart.applyOptions({ handleScroll: true, handleScale: true });
    this.update();
    if (g.price === undefined || !g.target) return;
    const it = g.line.item, sym = this.cell.symbol;
    const field = g.target === "pending" ? "price" : g.target;
    const money = g.target === "pending" ? null : moneyBetween(sym, it.side, it.volume, it.price, g.price);
    const what = { sl: "SL", tp: "TP", price: "ราคา order" }[field];
    if (confirmTrade(`ตั้ง ${what} ของ #${it.ticket} ${sym} เป็น ${g.price}` + (money === null ? "" : ` (${fmtMoney(money)})`))) {
      Trading.modify({ ticket: it.ticket, [field]: g.price }, `แก้ ${what} #${it.ticket} แล้ว`).catch(() => {});
    }
  }
}

// ---------- order panel ----------
const TradePanel = (() => {
  const el = () => document.getElementById("tradePanel");
  let built = false;

  function build() {
    el().innerHTML = `
      <div class="whead"><b>เทรด</b><span class="spacer"></span>
        <button type="button" id="openJournal" title="บันทึกการเทรด">📒 Journal</button>
        <button type="button" id="openRisk" title="จำกัดความเสี่ยง">⚙</button></div>
      <div id="tpAccount" class="tp-account"></div>
      <div id="tpBlocked" class="tp-blocked" hidden></div>
      <div class="tp-form">
        <div class="tp-sym" id="tpSymbol"></div>
        <div class="tp-sides">
          <button type="button" class="sell" id="tpSell">SELL<b id="tpBid">—</b></button>
          <button type="button" class="buy" id="tpBuy">BUY<b id="tpAsk">—</b></button>
        </div>
        <div class="tp-row">
          <label>Lot <input type="number" id="tpVolume" min="0.01" step="0.01" value="0.01"></label>
          <label>ประเภท <select id="tpType"><option value="market">Market</option><option value="limit">Limit</option><option value="stop">Stop</option></select></label>
        </div>
        <div class="tp-row" id="tpPriceRow" hidden><label>ราคา <input type="number" id="tpPrice" step="any"></label></div>
        <div class="tp-row">
          <label>SL <input type="number" id="tpSL" step="any" placeholder="ไม่ตั้ง"></label>
          <label>TP <input type="number" id="tpTP" step="any" placeholder="ไม่ตั้ง"></label>
        </div>
        <div class="tp-risk hint" id="tpRiskText"></div>
        <label class="tp-check"><input type="checkbox" id="tpConfirm"> ถามยืนยันก่อนส่งคำสั่ง</label>
      </div>
      <div class="tp-list" id="tpPositions"></div>`;
    const $ = id => document.getElementById(id);
    $("tpConfirm").checked = confirmTrades();
    $("tpConfirm").addEventListener("change", e => { try { localStorage.setItem(CONFIRM_KEY, e.target.checked ? "1" : "0"); } catch (err) {} });
    $("tpType").addEventListener("change", () => { $("tpPriceRow").hidden = $("tpType").value === "market"; updateRiskText(); });
    for (const id of ["tpVolume", "tpSL", "tpTP", "tpPrice"]) $(id).addEventListener("input", updateRiskText);
    $("tpBuy").addEventListener("click", () => submit("buy"));
    $("tpSell").addEventListener("click", () => submit("sell"));
    $("openJournal").addEventListener("click", openJournal);
    $("openRisk").addEventListener("click", openRisk);
    built = true;
  }

  function num(id) { const v = parseFloat(document.getElementById(id).value); return isFinite(v) && v > 0 ? v : 0; }

  // Entry price the order would get: the typed price for limit/stop, else the live ask/bid.
  function entryPrice(side) {
    const type = document.getElementById("tpType").value;
    if (type !== "market") return num("tpPrice");
    const q = lastPrices[activeSymbol()];
    return q ? (side === "buy" ? q.ask : q.bid) : 0;
  }

  function updateRiskText() {
    const sym = activeSymbol(), vol = num("tpVolume"), sl = num("tpSL"), tp = num("tpTP");
    const parts = [];
    for (const side of ["buy", "sell"]) {
      const entry = entryPrice(side);
      if (!entry) continue;
      const bits = [];
      if (sl) { const m = moneyBetween(sym, side, vol, entry, sl); if (m !== null) bits.push("SL " + fmtMoney(m)); }
      if (tp) { const m = moneyBetween(sym, side, vol, entry, tp); if (m !== null) bits.push("TP " + fmtMoney(m)); }
      if (bits.length) parts.push(side.toUpperCase() + ": " + bits.join(" / "));
    }
    document.getElementById("tpRiskText").textContent = parts.join("   ");
  }

  async function submit(side) {
    const sym = activeSymbol(), type = document.getElementById("tpType").value;
    const order = { symbol: sym, side, type, volume: num("tpVolume"), sl: num("tpSL"), tp: num("tpTP") };
    if (type !== "market") order.price = num("tpPrice");
    const s = Trading.get();
    const acct = s && s.account ? `[${s.account.mode.toUpperCase()} #${s.account.login}] ` : "";
    const text = `${acct}${side.toUpperCase()} ${type.toUpperCase()} ${order.volume} ${sym}` +
      (order.price ? ` @ ${order.price}` : "") + (order.sl ? ` SL ${order.sl}` : "") + (order.tp ? ` TP ${order.tp}` : "");
    if (!confirmTrade(text)) return;
    try { await Trading.place(order, text); } catch (e) {}
  }

  function render(s) {
    if (!built) build();
    const $ = id => document.getElementById(id);
    const sym = activeSymbol();
    $("tpSymbol").textContent = sym;
    const info = brokerSymbols[sym];
    if (info) { $("tpVolume").step = info.volumeStep || 0.01; $("tpVolume").min = info.volumeMin || 0.01; }
    if (!s || s.error) {
      $("tpAccount").textContent = s ? s.error : "กำลังโหลด…";
      return;
    }
    const a = s.account, cur = a.currency;
    const limit = s.risk.dailyLossLimit;
    $("tpAccount").innerHTML = `<span class="badge ${a.mode}">${a.mode.toUpperCase()}</span> #${a.login}
      <div>Balance <b>${a.balance.toFixed(2)}</b> · Equity <b>${a.equity.toFixed(2)}</b> ${escapeHtml(cur)}</div>
      <div>วันนี้ <b class="${s.today.total >= 0 ? "up" : "down"}">${fmtMoney(s.today.total)}</b>
        (ปิดแล้ว ${fmtMoney(s.today.closed)} · ค้าง ${fmtMoney(s.today.open)})${limit > 0 ? ` · จำกัด -${limit}` : ""}</div>`;
    $("tpBlocked").hidden = s.canTrade;
    $("tpBlocked").textContent = s.blockedReason || "";
    $("tpBuy").disabled = $("tpSell").disabled = !s.canTrade;

    const list = $("tpPositions");
    const total = s.positions.reduce((t, p) => t + p.profit, 0);
    let html = `<div class="tp-head">Positions (${s.positions.length})<span class="${total >= 0 ? "up" : "down"}">${fmtMoney(total)}</span></div>`;
    for (const p of s.positions) {
      html += `<div class="tp-item"><span><b>${escapeHtml(p.symbol)}</b> <span class="${p.side === "buy" ? "up" : "down"}">${p.side.toUpperCase()}</span> ${p.volume}
        @ ${p.price}<br><span class="hint">SL ${p.sl || "—"} · TP ${p.tp || "—"}${p.ours ? "" : " · เปิดจาก MT5"}</span></span>
        <span class="${p.profit >= 0 ? "up" : "down"}">${fmtMoney(p.profit)}</span>
        <button type="button" class="icon" data-close="${p.ticket}" title="ปิด position">✕</button></div>`;
    }
    if (s.orders.length) html += `<div class="tp-head">Orders (${s.orders.length})</div>`;
    for (const o of s.orders) {
      html += `<div class="tp-item"><span><b>${escapeHtml(o.symbol)}</b> ${o.side.toUpperCase()} ${o.type.toUpperCase()} ${o.volume} @ ${o.price}</span>
        <span></span><button type="button" class="icon" data-cancel="${o.ticket}" title="ยกเลิก order">✕</button></div>`;
    }
    list.innerHTML = html;
    list.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", () => {
      const p = s.positions.find(x => x.ticket === +b.dataset.close);
      if (p && confirmTrade(`ปิด ${p.side.toUpperCase()} ${p.volume} ${p.symbol} (#${p.ticket}) ${fmtMoney(p.profit)}`)) {
        Trading.close({ ticket: p.ticket }, `ปิด #${p.ticket} แล้ว`).catch(() => {});
      }
    }));
    list.querySelectorAll("[data-cancel]").forEach(b => b.addEventListener("click", () => {
      const o = s.orders.find(x => x.ticket === +b.dataset.cancel);
      if (o && confirmTrade(`ยกเลิก ${o.side.toUpperCase()} ${o.type.toUpperCase()} ${o.volume} ${o.symbol} @ ${o.price}`)) {
        Trading.cancel({ ticket: o.ticket }, `ยกเลิก #${o.ticket} แล้ว`).catch(() => {});
      }
    }));
    onTick();
  }

  function onTick() {
    if (!built) return;
    const sym = activeSymbol(), q = lastPrices[sym], info = brokerSymbols[sym];
    if (q && info) {
      document.getElementById("tpBid").textContent = q.bid.toFixed(info.digits);
      document.getElementById("tpAsk").textContent = q.ask.toFixed(info.digits);
    }
    updateRiskText();
  }

  // ---------- risk dialog ----------
  function openRisk() {
    const s = Trading.get();
    const risk = s && s.risk ? s.risk : { dailyLossLimit: 0, maxVolume: 1 };
    const dlg = document.getElementById("riskDialog");
    document.getElementById("riskLoss").value = risk.dailyLossLimit;
    document.getElementById("riskVolume").value = risk.maxVolume;
    dlg.showModal();
  }

  // ---------- journal ----------
  async function openJournal() {
    document.getElementById("journalDialog").showModal();
    await loadJournal();
  }

  async function loadJournal() {
    const days = document.getElementById("journalDays").value;
    const box = document.getElementById("journalBody");
    box.innerHTML = `<p class="hint">กำลังโหลด…</p>`;
    let trades;
    try { trades = await Mt5.history(days); } catch (e) { box.innerHTML = `<p class="error">${escapeHtml(e.message)}</p>`; return; }
    journalTrades = trades;
    let notes = {};
    try { notes = JSON.parse(localStorage.getItem(NOTES_KEY) || "{}"); } catch (e) {}
    const wins = trades.filter(t => t.profit > 0), losses = trades.filter(t => t.profit < 0);
    const sum = a => a.reduce((s, t) => s + t.profit, 0);
    const net = sum(trades), gw = sum(wins), gl = -sum(losses);
    document.getElementById("journalSummary").innerHTML = trades.length ? `
      <div><span>เทรด</span><b>${trades.length}</b></div>
      <div><span>Win rate</span><b>${(wins.length / trades.length * 100).toFixed(0)}%</b></div>
      <div><span>สุทธิ</span><b class="${net >= 0 ? "up" : "down"}">${fmtMoney(net)}</b></div>
      <div><span>กำไรเฉลี่ย</span><b class="up">${wins.length ? fmtMoney(gw / wins.length) : "—"}</b></div>
      <div><span>ขาดทุนเฉลี่ย</span><b class="down">${losses.length ? fmtMoney(-gl / losses.length) : "—"}</b></div>
      <div><span>Profit factor</span><b>${gl ? (gw / gl).toFixed(2) : "—"}</b></div>` : "";
    if (!trades.length) { box.innerHTML = `<p class="hint">ยังไม่มีเทรดที่ปิดแล้วในช่วงนี้</p>`; return; }
    const dt = t => { const s = t + TZ_SHIFT; return fmtDate(s) + " " + fmtTime(s); };
    box.innerHTML = `<table><thead><tr><th>ปิดเมื่อ</th><th>สัญลักษณ์</th><th></th><th>Lot</th><th>เข้า → ออก</th><th>ผล</th><th>โน้ต</th></tr></thead><tbody>` +
      trades.map(t => `<tr><td>${dt(t.closeTime)}</td><td>${escapeHtml(t.symbol)}</td>
        <td class="${t.side === "buy" ? "up" : "down"}">${t.side.toUpperCase()}</td><td>${t.volume}</td>
        <td>${t.openPrice} → ${t.closePrice}</td><td class="${t.profit >= 0 ? "up" : "down"}">${fmtMoney(t.profit)}</td>
        <td><input data-note="${t.position}" value="${escapeHtml(notes[t.position] || "")}" placeholder="บันทึก…"></td></tr>`).join("") +
      `</tbody></table>`;
    box.querySelectorAll("[data-note]").forEach(inp => inp.addEventListener("change", () => {
      notes[inp.dataset.note] = inp.value;
      try { localStorage.setItem(NOTES_KEY, JSON.stringify(notes)); } catch (e) {}
    }));
  }

  let journalTrades = [];
  function exportCsv() {
    let notes = {};
    try { notes = JSON.parse(localStorage.getItem(NOTES_KEY) || "{}"); } catch (e) {}
    const iso = t => new Date(t * 1000).toISOString();
    const rows = [["position", "symbol", "side", "volume", "open_time_utc", "open_price", "close_time_utc", "close_price", "profit", "note"]]
      .concat(journalTrades.map(t => [t.position, t.symbol, t.side, t.volume, iso(t.openTime), t.openPrice,
        iso(t.closeTime), t.closePrice, t.profit, notes[t.position] || ""]));
    const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv" }));
    a.download = "journal.csv";
    a.click();
  }

  function init() {
    document.getElementById("journalDays").addEventListener("change", loadJournal);
    document.getElementById("journalCsv").addEventListener("click", exportCsv);
    document.getElementById("closeJournal").addEventListener("click", () => document.getElementById("journalDialog").close());
    document.getElementById("cancelRisk").addEventListener("click", () => document.getElementById("riskDialog").close());
    document.getElementById("riskForm").addEventListener("submit", async e => {
      e.preventDefault();
      try {
        await Trading.setRisk({ dailyLossLimit: parseFloat(document.getElementById("riskLoss").value) || 0,
                                maxVolume: parseFloat(document.getElementById("riskVolume").value) || 0 });
        document.getElementById("riskDialog").close();
      } catch (err) {}
    });
    Trading.onChange(render);
  }

  return { init, render: () => render(Trading.get()), onTick };
})();
