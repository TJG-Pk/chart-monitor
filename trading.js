// Trading UI: order panel, positions and orders drawn on the charts (SL/TP draggable), and the
// trade journal. Orders go through bridge/trading.py, which refuses them on non-demo accounts
// and enforces the daily loss limit and max lot, whatever this page sends.
const Trading = (() => {
  let snap = null;                 // last /api/trading answer, or { error }
  let timer = 0;
  const listeners = new Set();
  const log = [];                  // every action sent from this page, newest first

  function addLog(ok, text) {
    log.unshift({ time: Date.now(), ok, text });
    if (log.length > 200) log.pop();
  }

  async function refresh() {
    try { snap = await Mt5.trading(); } catch (e) { snap = { error: e.message }; }
    for (const fn of listeners) fn(snap);
  }

  async function act(path, body, okText) {
    try {
      const r = await Mt5.post(path, body);
      addLog(true, okText);
      toast("✅ " + okText);
      refresh();
      return r;
    } catch (e) {
      addLog(false, okText + " — " + e.message);
      toast("❌ " + e.message);
      throw e;
    }
  }

  return {
    start() { if (!timer) { refresh(); timer = setInterval(refresh, 1000); } },
    stop() { clearInterval(timer); timer = 0; },
    refresh,
    get: () => snap,
    log: () => log,
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

// ---------- order ticket (right panel) ----------
// Side tabs, order type tabs, lot stepper, TP/SL as price / points / money (any one can be
// typed, the others follow), order info and a submit button naming the exact order.
const OrderTicket = (() => {
  const t = { side: "buy", type: "market", tpOn: false, slOn: false, tp: 0, sl: 0 };
  let built = false;
  const $ = id => document.getElementById(id);

  function build() {
    $("tradePanel").innerHTML = `
      <div class="rp-head"><b id="otSymbol">—</b><span class="tb-spacer"></span>
        <button type="button" class="tb-btn small" id="openRisk" title="จำกัดความเสี่ยง">⚙ ความเสี่ยง</button></div>
      <div class="ot">
        <div class="ot-acct" id="otAccount">กำลังโหลด…</div>
        <div class="ot-blocked" id="otBlocked" hidden></div>
        <div class="ot-sides">
          <button type="button" class="sell" data-side="sell">Sell<b id="otBid">—</b></button>
          <button type="button" class="buy" data-side="buy">Buy<b id="otAsk">—</b></button>
        </div>
        <div class="ot-tabs">
          <button type="button" data-type="market">Market</button>
          <button type="button" data-type="limit">Limit</button>
          <button type="button" data-type="stop">Stop</button>
        </div>
        <div class="ot-field" id="otPriceField">ราคา
          <div class="ot-stepper"><button type="button" data-step="price:-1">−</button>
            <input type="number" id="otPrice" step="any"><button type="button" data-step="price:1">+</button></div>
          <span class="hint" id="otPriceHint"></span>
        </div>
        <div class="ot-field">จำนวน (lot)
          <div class="ot-stepper"><button type="button" data-step="vol:-1">−</button>
            <input type="number" id="otVolume" min="0.01" step="0.01" value="0.01"><button type="button" data-step="vol:1">+</button></div>
        </div>
        ${["tp", "sl"].map(k => `
        <div class="ot-exit">
          <label class="ot-exit-head"><span><input type="checkbox" id="ot_${k}On"> ${k === "tp" ? "Take Profit" : "Stop Loss"}</span>
            <span class="hint" id="ot_${k}Hint"></span></label>
          <div class="ot-exit-body" id="ot_${k}Body" hidden>
            <label>ราคา<input type="number" step="any" data-exit="${k}" data-unit="price"></label>
            <label>Points<input type="number" step="1" data-exit="${k}" data-unit="points"></label>
            <label id="ot_${k}Cur">USD<input type="number" step="any" data-exit="${k}" data-unit="money"></label>
          </div>
        </div>`).join("")}
        <div class="ot-info" id="otInfo"></div>
        <button type="button" class="ot-submit" id="otSubmit"></button>
        <label class="ot-check"><input type="checkbox" id="otConfirm"> ถามยืนยันก่อนส่งคำสั่ง</label>
      </div>`;
    $("tradePanel").querySelectorAll("[data-side]").forEach(b => b.addEventListener("click", () => { t.side = b.dataset.side; resetExits(); update(); }));
    $("tradePanel").querySelectorAll("[data-type]").forEach(b => b.addEventListener("click", () => {
      t.type = b.dataset.type;
      if (t.type !== "market" && !num("otPrice")) $("otPrice").value = marketPrice() || "";
      update();
    }));
    $("tradePanel").querySelectorAll("[data-step]").forEach(b => b.addEventListener("click", () => {
      const [what, dir] = b.dataset.step.split(":"), info = brokerSymbols[activeSymbol()] || {};
      if (what === "vol") {
        const step = info.volumeStep || 0.01;
        $("otVolume").value = Math.max(info.volumeMin || step, +(num("otVolume") + dir * step).toFixed(4));
      } else {
        const step = Math.pow(10, -(info.digits || 2)) * 10;
        $("otPrice").value = +((num("otPrice") || marketPrice()) + dir * step).toFixed(info.digits || 2);
      }
      update();
    }));
    for (const id of ["otVolume", "otPrice"]) $(id).addEventListener("input", update);
    for (const k of ["tp", "sl"]) {
      $(`ot_${k}On`).addEventListener("change", e => {
        t[k + "On"] = e.target.checked;
        if (t[k + "On"] && !t[k]) t[k] = defaultExit(k);
        update();
      });
    }
    $("tradePanel").querySelectorAll("[data-exit]").forEach(inp => inp.addEventListener("input", () => {
      const v = parseFloat(inp.value);
      if (!isFinite(v)) return;
      t[inp.dataset.exit] = fromUnit(inp.dataset.exit, inp.dataset.unit, v);
      update(inp);
    }));
    $("otConfirm").checked = confirmTrades();
    $("otConfirm").addEventListener("change", e => { try { localStorage.setItem(CONFIRM_KEY, e.target.checked ? "1" : "0"); } catch (err) {} });
    $("otSubmit").addEventListener("click", submit);
    $("openRisk").addEventListener("click", openRisk);
    built = true;
  }

  const num = id => { const v = parseFloat($(id).value); return isFinite(v) && v > 0 ? v : 0; };
  const info = () => brokerSymbols[activeSymbol()] || {};
  function marketPrice() {
    const q = lastPrices[activeSymbol()];
    return q ? (t.side === "buy" ? q.ask : q.bid) : 0;
  }
  const entry = () => t.type === "market" ? marketPrice() : num("otPrice");
  const dir = () => (t.side === "buy" ? 1 : -1);

  // Starting TP/SL: 1% of price away, on the right side for the order's direction.
  function defaultExit(k) {
    const e = entry(), d = info().digits || 2;
    if (!e) return 0;
    const off = e * 0.01 * (k === "tp" ? 1 : -1) * dir();
    return +(e + off).toFixed(d);
  }
  function resetExits() {
    if (t.tpOn) t.tp = defaultExit("tp");
    if (t.slOn) t.sl = defaultExit("sl");
  }

  function toUnit(k, unit) {
    const e = entry(), i = info(), p = t[k];
    if (!e || !p) return "";
    if (unit === "price") return p.toFixed(i.digits || 2);
    if (unit === "points") return Math.round(Math.abs(p - e) / (i.point || 0.01));
    const m = moneyBetween(activeSymbol(), t.side, num("otVolume"), e, p);
    return m === null ? "" : m.toFixed(2);
  }

  function fromUnit(k, unit, v) {
    const e = entry(), i = info(), d = i.digits || 2;
    if (unit === "price") return v;
    const sign = (k === "tp" ? 1 : -1) * dir();
    if (unit === "points") return +(e + sign * Math.abs(v) * (i.point || 0.01)).toFixed(d);
    // money -> price distance
    const per = moneyBetween(activeSymbol(), "buy", num("otVolume"), 0, i.tickSize || 0.01);
    if (!per) return t[k];
    return +(e + sign * Math.abs(v) / per * (i.tickSize || 0.01)).toFixed(d);
  }

  function update(skip) {
    if (!built) build();
    const s = Trading.get(), sym = activeSymbol(), i = info(), q = lastPrices[sym];
    $("otSymbol").textContent = sym;
    if (q && i.digits !== undefined) { $("otBid").textContent = q.bid.toFixed(i.digits); $("otAsk").textContent = q.ask.toFixed(i.digits); }
    $("tradePanel").querySelectorAll("[data-side]").forEach(b => b.classList.toggle("on", b.dataset.side === t.side));
    $("tradePanel").querySelectorAll("[data-type]").forEach(b => b.classList.toggle("on", b.dataset.type === t.type));
    $("otPriceField").hidden = t.type === "market";
    if (i.volumeStep) { $("otVolume").step = i.volumeStep; $("otVolume").min = i.volumeMin; }
    if (t.type !== "market" && q) {
      const e = num("otPrice"), ref = marketPrice();
      const ok = t.type === "limit" ? (t.side === "buy" ? e < ref : e > ref) : (t.side === "buy" ? e > ref : e < ref);
      $("otPriceHint").textContent = e ? `${Math.round(Math.abs(e - ref) / (i.point || 0.01))} points จากราคาตลาด` +
        (ok ? "" : ` — ${t.type} ${t.side} ควร${(t.type === "limit") === (t.side === "buy") ? "ต่ำ" : "สูง"}กว่าราคาตลาด`) : "";
    }
    const cur = s && s.account ? s.account.currency : "USD";
    for (const k of ["tp", "sl"]) {
      $(`ot_${k}On`).checked = t[k + "On"];
      $(`ot_${k}Body`).hidden = !t[k + "On"];
      $(`ot_${k}Cur`).firstChild.textContent = cur;
      $("tradePanel").querySelectorAll(`[data-exit="${k}"]`).forEach(inp => { if (inp !== skip) inp.value = toUnit(k, inp.dataset.unit); });
      const m = t[k + "On"] ? moneyBetween(sym, t.side, num("otVolume"), entry(), t[k]) : null;
      $(`ot_${k}Hint`).textContent = m === null ? "" : fmtMoney(m) + " " + cur;
    }

    // order info
    const vol = num("otVolume"), e = entry();
    const perPoint = moneyBetween(sym, "buy", vol, 0, i.point || 0.01);
    const risk = t.slOn ? moneyBetween(sym, t.side, vol, e, t.sl) : null;
    const reward = t.tpOn ? moneyBetween(sym, t.side, vol, e, t.tp) : null;
    const bal = s && s.account ? s.account.balance : 0;
    const rows = [
      ["ราคาเข้า", e ? e.toFixed(i.digits || 2) + (t.type === "market" ? " (ตลาด)" : "") : "—"],
      ["มูลค่าต่อ 1 point", perPoint === null ? "—" : perPoint.toFixed(2) + " " + cur],
      ["ความเสี่ยง (SL)", risk === null ? "—" : fmtMoney(risk) + (bal ? ` (${(risk / bal * 100).toFixed(2)}%)` : "")],
      ["ผลตอบแทน (TP)", reward === null ? "—" : fmtMoney(reward)],
      ["Risk : Reward", risk && reward ? "1 : " + (Math.abs(reward / risk)).toFixed(2) : "—"]
    ];
    $("otInfo").innerHTML = rows.map(([a, b]) => `<span>${a}</span><b>${b}</b>`).join("");

    const submit = $("otSubmit");
    submit.className = "ot-submit " + t.side;
    submit.textContent = `${t.side === "buy" ? "Buy" : "Sell"} ${vol || "—"} ${sym} ${{ market: "MKT", limit: "LMT", stop: "STP" }[t.type]}` +
      (t.type !== "market" && num("otPrice") ? " @ " + num("otPrice") : "");

    if (!s || s.error) { $("otAccount").textContent = s ? s.error : "กำลังโหลด…"; submit.disabled = true; return; }
    const a = s.account;
    $("otAccount").innerHTML = `<span class="badge ${a.mode}">${a.mode.toUpperCase()}</span> #${a.login} · ${escapeHtml(a.server)}<br>
      Balance <b>${a.balance.toFixed(2)}</b> · Equity <b>${a.equity.toFixed(2)}</b> ${escapeHtml(cur)}`;
    $("otBlocked").hidden = s.canTrade;
    $("otBlocked").textContent = s.blockedReason || "";
    submit.disabled = !s.canTrade;
  }

  async function submit() {
    const sym = activeSymbol();
    const order = { symbol: sym, side: t.side, type: t.type, volume: num("otVolume"),
      sl: t.slOn ? t.sl : 0, tp: t.tpOn ? t.tp : 0 };
    if (t.type !== "market") order.price = num("otPrice");
    const s = Trading.get();
    const acct = s && s.account ? `[${s.account.mode.toUpperCase()} #${s.account.login}] ` : "";
    const text = acct + $("otSubmit").textContent + (order.sl ? ` SL ${order.sl}` : "") + (order.tp ? ` TP ${order.tp}` : "");
    if (!confirmTrade(text)) return;
    try { await Trading.place(order, text); } catch (e) {}
  }

  // The SELL / BUY buttons on each chart: a market order of the chart's lot, no SL/TP.
  async function quick(side, symbol, volume) {
    const s = Trading.get();
    if (!s || !s.canTrade) { toast("❌ " + (s && s.blockedReason ? s.blockedReason : "ยังส่งคำสั่งไม่ได้")); return; }
    const text = `[${s.account.mode.toUpperCase()} #${s.account.login}] ${side === "buy" ? "Buy" : "Sell"} ${volume} ${symbol} MKT`;
    if (!confirmTrade(text)) return;
    try { await Trading.place({ symbol, side, type: "market", volume, sl: 0, tp: 0 }, text); } catch (e) {}
  }

  function openRisk() {
    const s = Trading.get();
    const risk = s && s.risk ? s.risk : { dailyLossLimit: 0, maxVolume: 1 };
    $("riskLoss").value = risk.dailyLossLimit;
    $("riskVolume").value = risk.maxVolume;
    $("riskDialog").showModal();
  }

  function init() {
    $("cancelRisk").addEventListener("click", () => $("riskDialog").close());
    $("riskForm").addEventListener("submit", async e => {
      e.preventDefault();
      try {
        await Trading.setRisk({ dailyLossLimit: parseFloat($("riskLoss").value) || 0, maxVolume: parseFloat($("riskVolume").value) || 0 });
        $("riskDialog").close();
      } catch (err) {}
    });
    Trading.onChange(() => update());
  }

  return { init, update: () => update(), quick, setSide(side) { t.side = side; resetExits(); update(); } };
})();

// ---------- account manager (bottom panel) ----------
const AccountManager = (() => {
  const TABS = { positions: "Positions", orders: "Orders", history: "History", account: "Account", log: "Log" };
  const TAB_KEY = "chartMonitorBottomTab";
  let tab = "positions";
  try { tab = localStorage.getItem(TAB_KEY) || "positions"; } catch (e) {}
  if (!TABS[tab]) tab = "positions";
  let historyDays = 30, history = null, lastKey = "";
  const $ = id => document.getElementById(id);
  const cur = s => s && s.account ? s.account.currency : "";
  const dt = t => { const s = t + TZ_SHIFT; return fmtDate(s) + " " + fmtTime(s); };

  function renderTabs(s) {
    const counts = { positions: s && s.positions ? s.positions.length : 0, orders: s && s.orders ? s.orders.length : 0 };
    let acct = "";
    if (s && s.account) {
      const a = s.account;
      acct = `<div class="acct"><span><span class="badge ${a.mode}">${a.mode.toUpperCase()}</span></span>
        <span>Balance <b>${a.balance.toFixed(2)}</b></span><span>Equity <b>${a.equity.toFixed(2)}</b></span>
        <span>วันนี้ <b class="${s.today.total >= 0 ? "up" : "down"}">${fmtMoney(s.today.total)}</b></span>
        <span>Margin <b>${a.margin.toFixed(2)}</b></span><span>Free <b>${a.freeMargin.toFixed(2)}</b></span></div>`;
    }
    $("bpTabs").innerHTML = Object.entries(TABS).map(([k, label]) =>
      `<button type="button" data-tab="${k}" class="${k === tab ? "on" : ""}">${label}${counts[k] ? ` (${counts[k]})` : ""}</button>`).join("") + acct;
    $("bpTabs").querySelectorAll("[data-tab]").forEach(b => b.addEventListener("click", () => {
      tab = b.dataset.tab;
      try { localStorage.setItem(TAB_KEY, tab); } catch (e) {}
      lastKey = "";
      render(Trading.get(), true);
    }));
  }

  // Re-render the table only when its rows change, so a SL/TP box being typed in keeps its
  // focus; otherwise just refresh the live numbers.
  function render(s, force) {
    renderTabs(s);
    const body = $("bpBody");
    if (tab === "history") { if (force || !history) loadHistory(); return; }
    if (tab === "log") { renderLog(); return; }
    if (!s || s.error) { body.innerHTML = `<div class="bp-empty">${escapeHtml(s ? s.error : "กำลังโหลด…")}</div>`; return; }
    if (tab === "account") { renderAccount(s); return; }
    const list = tab === "positions" ? s.positions : s.orders;
    const key = tab + ":" + list.map(x => `${x.ticket}/${x.sl}/${x.tp}/${x.price}`).join(",");
    const editing = body.contains(document.activeElement) && document.activeElement.tagName === "INPUT";
    if (!force && key === lastKey) { updateLive(s); return; }
    if (!force && editing) return;
    lastKey = key;
    body.innerHTML = (s.canTrade ? "" : `<div class="bp-blocked">${escapeHtml(s.blockedReason || "")}</div>`) +
      (tab === "positions" ? positionsTable(s) : ordersTable(s));
    wire(s);
  }

  function editBox(it, field) {
    return `<input class="cell-edit" type="number" step="any" data-edit="${field}" data-ticket="${it.ticket}" value="${it[field] || ""}" placeholder="—">`;
  }

  function positionsTable(s) {
    if (!s.positions.length) return `<div class="bp-empty">ไม่มี position ที่เปิดอยู่</div>`;
    const total = s.positions.reduce((t, p) => t + p.profit, 0);
    return `<div class="bp-tools"><span>รวม <b class="${total >= 0 ? "up" : "down"}">${fmtMoney(total)} ${escapeHtml(cur(s))}</b></span>
      <span class="spacer"></span><button type="button" class="row-btn" id="closeAll">ปิดทั้งหมด</button></div>
      <table><thead><tr><th>สัญลักษณ์</th><th>ฝั่ง</th><th class="num">Lot</th><th class="num">ราคาเข้า</th><th class="num">ราคาล่าสุด</th>
      <th>Stop Loss</th><th>Take Profit</th><th class="num">กำไร/ขาดทุน</th><th>เปิดเมื่อ</th><th></th></tr></thead><tbody>` +
      s.positions.map(p => `<tr data-ticket="${p.ticket}"><td><a href="#" data-goto="${escapeHtml(p.symbol)}"><b>${escapeHtml(p.symbol)}</b></a></td>
        <td class="${p.side === "buy" ? "up" : "down"}">${p.side.toUpperCase()}</td><td class="num">${p.volume}</td>
        <td class="num">${p.price}</td><td class="num last">${p.current}</td><td>${editBox(p, "sl")}</td><td>${editBox(p, "tp")}</td>
        <td class="num pl ${p.profit >= 0 ? "up" : "down"}">${fmtMoney(p.profit)}</td><td>${dt(p.time)}${p.ours ? "" : " · MT5"}</td>
        <td><button type="button" class="row-btn" data-close="${p.ticket}">ปิด ✕</button></td></tr>`).join("") + `</tbody></table>`;
  }

  function ordersTable(s) {
    if (!s.orders.length) return `<div class="bp-empty">ไม่มี order ที่รออยู่</div>`;
    return `<div class="bp-tools"><span class="spacer"></span><button type="button" class="row-btn" id="cancelAll">ยกเลิกทั้งหมด</button></div>
      <table><thead><tr><th>สัญลักษณ์</th><th>ฝั่ง</th><th>ประเภท</th><th class="num">Lot</th><th>ราคา</th><th>Stop Loss</th><th>Take Profit</th>
      <th>ตั้งเมื่อ</th><th></th></tr></thead><tbody>` +
      s.orders.map(o => `<tr data-ticket="${o.ticket}"><td><a href="#" data-goto="${escapeHtml(o.symbol)}"><b>${escapeHtml(o.symbol)}</b></a></td>
        <td class="${o.side === "buy" ? "up" : "down"}">${o.side.toUpperCase()}</td><td>${o.type.toUpperCase()}</td><td class="num">${o.volume}</td>
        <td>${editBox(o, "price")}</td><td>${editBox(o, "sl")}</td><td>${editBox(o, "tp")}</td><td>${dt(o.time)}</td>
        <td><button type="button" class="row-btn" data-cancel="${o.ticket}">ยกเลิก ✕</button></td></tr>`).join("") + `</tbody></table>`;
  }

  function updateLive(s) {
    const body = $("bpBody");
    for (const p of s.positions || []) {
      const row = body.querySelector(`tr[data-ticket="${p.ticket}"]`);
      if (!row) continue;
      const pl = row.querySelector(".pl"), last = row.querySelector(".last");
      if (pl) { pl.textContent = fmtMoney(p.profit); pl.className = "num pl " + (p.profit >= 0 ? "up" : "down"); }
      if (last) last.textContent = p.current;
    }
  }

  function wire(s) {
    const body = $("bpBody");
    body.querySelectorAll("[data-goto]").forEach(a => a.addEventListener("click", e => { e.preventDefault(); setSymbol(a.dataset.goto); }));
    body.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", () => {
      const p = s.positions.find(x => x.ticket === +b.dataset.close);
      if (p && confirmTrade(`ปิด ${p.side.toUpperCase()} ${p.volume} ${p.symbol} (#${p.ticket}) ${fmtMoney(p.profit)}`)) {
        Trading.close({ ticket: p.ticket }, `ปิด #${p.ticket} แล้ว`).catch(() => {});
      }
    }));
    body.querySelectorAll("[data-cancel]").forEach(b => b.addEventListener("click", () => {
      const o = s.orders.find(x => x.ticket === +b.dataset.cancel);
      if (o && confirmTrade(`ยกเลิก ${o.side.toUpperCase()} ${o.type.toUpperCase()} ${o.volume} ${o.symbol} @ ${o.price}`)) {
        Trading.cancel({ ticket: o.ticket }, `ยกเลิก #${o.ticket} แล้ว`).catch(() => {});
      }
    }));
    body.querySelectorAll("[data-edit]").forEach(inp => {
      const send = () => {
        const v = parseFloat(inp.value) || 0, field = inp.dataset.edit, ticket = +inp.dataset.ticket;
        const it = [...s.positions, ...s.orders].find(x => x.ticket === ticket);
        if (!it || v === (it[field] || 0)) return;
        const what = { sl: "SL", tp: "TP", price: "ราคา" }[field];
        if (confirmTrade(`ตั้ง ${what} ของ #${ticket} ${it.symbol} เป็น ${v || "ไม่มี"}`)) {
          Trading.modify({ ticket, [field]: v }, `แก้ ${what} #${ticket} แล้ว`).catch(() => {}).finally(() => { lastKey = ""; });
        } else {
          inp.value = it[field] || "";
        }
      };
      inp.addEventListener("keydown", e => { if (e.key === "Enter") inp.blur(); if (e.key === "Escape") { inp.value = ""; inp.blur(); } });
      inp.addEventListener("change", send);
    });
    const closeAll = $("closeAll");
    if (closeAll) closeAll.addEventListener("click", () => {
      if (!confirmTrade(`ปิด position ทั้งหมด ${s.positions.length} รายการ`)) return;
      for (const p of s.positions) Trading.close({ ticket: p.ticket }, `ปิด #${p.ticket} แล้ว`).catch(() => {});
    });
    const cancelAll = $("cancelAll");
    if (cancelAll) cancelAll.addEventListener("click", () => {
      if (!confirmTrade(`ยกเลิก order ทั้งหมด ${s.orders.length} รายการ`)) return;
      for (const o of s.orders) Trading.cancel({ ticket: o.ticket }, `ยกเลิก #${o.ticket} แล้ว`).catch(() => {});
    });
  }

  function renderAccount(s) {
    const a = s.account, c = escapeHtml(a.currency);
    const box = (label, value, cls = "") => `<div><span>${label}</span><b class="${cls}">${value}</b></div>`;
    $("bpBody").innerHTML = `<div class="bp-summary">
      ${box("บัญชี", `<span class="badge ${a.mode}">${a.mode.toUpperCase()}</span> #${a.login}`)}
      ${box("Server", escapeHtml(a.server))}
      ${box("Balance", a.balance.toFixed(2) + " " + c)}${box("Equity", a.equity.toFixed(2) + " " + c)}
      ${box("Margin", a.margin.toFixed(2))}${box("Free margin", a.freeMargin.toFixed(2))}
      ${box("Leverage", "1:" + a.leverage)}
      ${box("วันนี้ (ปิดแล้ว)", fmtMoney(s.today.closed), s.today.closed >= 0 ? "up" : "down")}
      ${box("วันนี้ (ค้าง)", fmtMoney(s.today.open), s.today.open >= 0 ? "up" : "down")}
      ${box("จำกัดขาดทุน/วัน", s.risk.dailyLossLimit ? "-" + s.risk.dailyLossLimit : "ไม่จำกัด")}
      ${box("Lot สูงสุด", s.risk.maxVolume || "ไม่จำกัด")}
      ${box("ส่งคำสั่ง", s.canTrade ? "ได้" : "ถูกบล็อก", s.canTrade ? "up" : "down")}</div>` +
      (s.canTrade ? "" : `<div class="bp-blocked">${escapeHtml(s.blockedReason || "")}</div>`);
  }

  function renderLog() {
    const log = Trading.log();
    $("bpBody").innerHTML = log.length ? `<table><thead><tr><th>เวลา</th><th>ผล</th><th>รายละเอียด</th></tr></thead><tbody>` +
      log.map(l => `<tr><td>${new Date(l.time).toLocaleTimeString("th-TH")}</td><td class="${l.ok ? "up" : "down"}">${l.ok ? "สำเร็จ" : "ไม่สำเร็จ"}</td>
        <td>${escapeHtml(l.text)}</td></tr>`).join("") + `</tbody></table>`
      : `<div class="bp-empty">ยังไม่มีคำสั่งที่ส่งจากหน้านี้</div>`;
  }

  // ---------- history / journal ----------
  async function loadHistory() {
    const body = $("bpBody");
    body.innerHTML = `<div class="bp-empty">กำลังโหลด…</div>`;
    try { history = await Mt5.history(historyDays); } catch (e) { body.innerHTML = `<div class="bp-empty">${escapeHtml(e.message)}</div>`; return; }
    if (tab !== "history") return;
    let notes = {};
    try { notes = JSON.parse(localStorage.getItem(NOTES_KEY) || "{}"); } catch (e) {}
    const wins = history.filter(t => t.profit > 0), losses = history.filter(t => t.profit < 0);
    const sum = a => a.reduce((s, t) => s + t.profit, 0);
    const net = sum(history), gw = sum(wins), gl = -sum(losses);
    const days = [7, 30, 90, 365].map(d => `<option value="${d}" ${d === historyDays ? "selected" : ""}>${d === 365 ? "1 ปี" : d + " วัน"}</option>`).join("");
    body.innerHTML = `<div class="bp-tools"><select id="histDays">${days}</select>
      <span>เทรด <b>${history.length}</b></span>
      <span>Win rate <b>${history.length ? (wins.length / history.length * 100).toFixed(0) + "%" : "—"}</b></span>
      <span>สุทธิ <b class="${net >= 0 ? "up" : "down"}">${fmtMoney(net)}</b></span>
      <span>กำไรเฉลี่ย <b class="up">${wins.length ? fmtMoney(gw / wins.length) : "—"}</b></span>
      <span>ขาดทุนเฉลี่ย <b class="down">${losses.length ? fmtMoney(-gl / losses.length) : "—"}</b></span>
      <span>Profit factor <b>${gl ? (gw / gl).toFixed(2) : "—"}</b></span>
      <span class="spacer"></span><button type="button" class="row-btn" id="histRefresh">↻</button>
      <button type="button" class="row-btn" id="histCsv">⬇ CSV</button></div>` +
      (history.length ? `<table><thead><tr><th>ปิดเมื่อ</th><th>สัญลักษณ์</th><th>ฝั่ง</th><th class="num">Lot</th><th class="num">ราคาเข้า</th>
        <th class="num">ราคาออก</th><th class="num">ผล</th><th>โน้ต</th></tr></thead><tbody>` +
        history.map(t => `<tr><td>${dt(t.closeTime)}</td><td>${escapeHtml(t.symbol)}</td><td class="${t.side === "buy" ? "up" : "down"}">${t.side.toUpperCase()}</td>
          <td class="num">${t.volume}</td><td class="num">${t.openPrice}</td><td class="num">${t.closePrice}</td>
          <td class="num ${t.profit >= 0 ? "up" : "down"}">${fmtMoney(t.profit)}</td>
          <td><input data-note="${t.position}" value="${escapeHtml(notes[t.position] || "")}" placeholder="บันทึก…" style="width:220px;padding:2px 6px"></td></tr>`).join("") +
        `</tbody></table>` : `<div class="bp-empty">ยังไม่มีเทรดที่ปิดแล้วในช่วงนี้</div>`);
    $("histDays").addEventListener("change", e => { historyDays = +e.target.value; loadHistory(); });
    $("histRefresh").addEventListener("click", loadHistory);
    $("histCsv").addEventListener("click", exportCsv);
    body.querySelectorAll("[data-note]").forEach(inp => inp.addEventListener("change", () => {
      notes[inp.dataset.note] = inp.value;
      try { localStorage.setItem(NOTES_KEY, JSON.stringify(notes)); } catch (e) {}
    }));
  }

  function exportCsv() {
    let notes = {};
    try { notes = JSON.parse(localStorage.getItem(NOTES_KEY) || "{}"); } catch (e) {}
    const iso = t => new Date(t * 1000).toISOString();
    const rows = [["position", "symbol", "side", "volume", "open_time_utc", "open_price", "close_time_utc", "close_price", "profit", "note"]]
      .concat((history || []).map(t => [t.position, t.symbol, t.side, t.volume, iso(t.openTime), t.openPrice,
        iso(t.closeTime), t.closePrice, t.profit, notes[t.position] || ""]));
    const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv" }));
    a.download = "journal.csv";
    a.click();
  }

  function init() {
    Trading.onChange(s => { if (tab !== "history") render(s); else renderTabs(s); });
    render(Trading.get(), true);
  }

  return { init, render: () => render(Trading.get(), true), show(t) { tab = t; render(Trading.get(), true); } };
})();
