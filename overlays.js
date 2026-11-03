// Chart overlays drawn behind/over the price pane: trading-session shading and a volume
// profile of the visible bars. Times on the chart are UTC+7 (see TZ_SHIFT in app.js).

// Local market hours; the browser's time-zone data handles daylight saving for each city.
const SESSIONS = [
  { name: "Tokyo",    tz: "Asia/Tokyo",       start: 9, end: 18, color: "rgba(227,179,65,0.08)",  text: "#e3b341" },
  { name: "London",   tz: "Europe/London",    start: 8, end: 17, color: "rgba(47,129,247,0.08)",  text: "#58a6ff" },
  { name: "New York", tz: "America/New_York", start: 8, end: 17, color: "rgba(219,97,162,0.08)",  text: "#db61a2" }
];
const SESSION_MAX_INTERVAL = 3600;   // shading only makes sense up to 1h bars

const sessionHourFormats = SESSIONS.map(s =>
  new Intl.DateTimeFormat("en-GB", { timeZone: s.tz, hour: "numeric", hourCycle: "h23" }));
const sessionMaskCache = new Map();

// Bit i set when session i is open at chart time t. Sessions start on whole hours, so one
// lookup per UTC hour is enough.
function sessionMask(t) {
  const hourKey = Math.floor((t - TZ_SHIFT) / 3600);
  let mask = sessionMaskCache.get(hourKey);
  if (mask === undefined) {
    mask = 0;
    const date = new Date(hourKey * 3600 * 1000);
    const day = date.getUTCDay();
    SESSIONS.forEach((s, i) => {
      const h = +sessionHourFormats[i].format(date);
      // Skip weekends in the session's own time zone (roughly: UTC Sat/Sun).
      if (day !== 0 && day !== 6 && h >= s.start && h < s.end) mask |= 1 << i;
    });
    if (sessionMaskCache.size > 20000) sessionMaskCache.clear();
    sessionMaskCache.set(hourKey, mask);
  }
  return mask;
}

const PROFILE_ROWS = 50;
const PROFILE_VALUE_AREA = 0.7;

class OverlayLayer {
  constructor(cell) {
    this.cell = cell;
    this.requestUpdate = null;
    this.profile = null;          // { low, high, counts, source: "ticks" | "bars" }
    this.profileKey = "";
    this.profileTimer = 0;
    this.onRange = () => this.scheduleProfile();
    cell.chart.timeScale().subscribeVisibleLogicalRangeChange(this.onRange);
    cell.candle.attachPrimitive(this);
  }

  destroy() {
    clearTimeout(this.profileTimer);
    if (this.cell.chart) this.cell.chart.timeScale().unsubscribeVisibleLogicalRangeChange(this.onRange);
  }

  attached({ requestUpdate }) { this.requestUpdate = requestUpdate; }
  detached() { this.requestUpdate = null; }
  update() { if (this.requestUpdate) this.requestUpdate(); }

  paneViews() {
    return [
      { zOrder: () => "bottom", renderer: () => ({ draw: () => {}, drawBackground: t => this.drawSessions(t) }) },
      { zOrder: () => "normal", renderer: () => ({ draw: t => this.drawProfile(t) }) }
    ];
  }

  visibleRange() {
    const r = this.cell.chart.timeScale().getVisibleLogicalRange();
    const n = this.cell.disp.length;
    if (!r || !n) return null;
    const from = Math.max(0, Math.floor(r.from)), to = Math.min(n - 1, Math.ceil(r.to));
    return from <= to ? { from, to } : null;
  }

  // ---------- sessions ----------
  drawSessions(target) {
    const cell = this.cell;
    if (!state.overlays.sessions || cell.iv.seconds > SESSION_MAX_INTERVAL) return;
    const range = this.visibleRange();
    if (!range) return;
    const ts = cell.chart.timeScale();
    const spacing = ts.options().barSpacing;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize: size }) => {
      ctx.font = "10px system-ui, sans-serif";
      let prevMask = range.from > 0 ? sessionMask(cell.disp[range.from - 1].time) : 0;
      for (let i = range.from; i <= range.to; i++) {
        const mask = sessionMask(cell.disp[i].time);
        const x = ts.logicalToCoordinate(i);
        if (x === null) continue;
        SESSIONS.forEach((s, k) => {
          if (!(mask & (1 << k))) return;
          ctx.fillStyle = s.color;
          ctx.fillRect(x - spacing / 2, 0, spacing + 0.5, size.height);
          if (!(prevMask & (1 << k))) {          // session opens on this bar: label it
            ctx.fillStyle = s.text;
            ctx.fillText(s.name, x + 2, size.height - 6 - k * 12);
          }
        });
        prevMask = mask;
      }
    });
  }

  // ---------- volume profile ----------
  // Ticks from the bridge when the visible span is up to a day, otherwise each bar's volume
  // spread evenly over its high-low range. Recomputed shortly after the view stops moving.
  scheduleProfile() {
    if (!state.overlays.profile) return;
    clearTimeout(this.profileTimer);
    this.profileTimer = setTimeout(() => this.computeProfile(), 400);
  }

  async computeProfile() {
    const cell = this.cell;
    const range = this.visibleRange();
    if (!state.overlays.profile || !range) return;
    const d = cell.disp;
    const fromT = d[range.from].time, toT = d[range.to].time + cell.iv.seconds;
    const key = `${cell.symbol}|${fromT}|${toT}`;
    if (key === this.profileKey && this.profile) return;
    this.profileKey = key;
    this.profile = barProfile(cell.bars, fromT, toT, PROFILE_ROWS);
    this.update();
    if (toT - fromT > 86400) return;
    try {
      const p = await Mt5.profile(cell.symbol, fromT - TZ_SHIFT, toT - TZ_SHIFT, PROFILE_ROWS);
      if (this.profileKey !== key || !p.counts.length) return;
      this.profile = { low: p.low, high: p.high, counts: p.counts, source: "ticks" };
      this.update();
    } catch (e) { /* keep the bar-based profile */ }
  }

  drawProfile(target) {
    const p = this.profile;
    if (!state.overlays.profile || !p || !p.counts.length) return;
    const series = this.cell.candle;
    const rows = p.counts.length, step = (p.high - p.low) / rows || 1e-9;
    const max = Math.max(...p.counts);
    if (!max) return;

    // Value area: grow outward from the point of control until it holds 70% of the volume.
    const total = p.counts.reduce((a, b) => a + b, 0);
    const poc = p.counts.indexOf(max);
    let lo = poc, hi = poc, sum = max;
    while (sum < total * PROFILE_VALUE_AREA && (lo > 0 || hi < rows - 1)) {
      const below = lo > 0 ? p.counts[lo - 1] : -1, above = hi < rows - 1 ? p.counts[hi + 1] : -1;
      if (above >= below) sum += p.counts[++hi]; else sum += p.counts[--lo];
    }

    target.useMediaCoordinateSpace(({ context: ctx, mediaSize: size }) => {
      const maxW = size.width * 0.22;
      for (let i = 0; i < rows; i++) {
        const y1 = series.priceToCoordinate(p.low + i * step), y2 = series.priceToCoordinate(p.low + (i + 1) * step);
        if (y1 === null || y2 === null) continue;
        const w = p.counts[i] / max * maxW;
        ctx.fillStyle = i === poc ? "rgba(240,136,62,0.55)" : i >= lo && i <= hi ? "rgba(88,166,255,0.32)" : "rgba(154,164,178,0.18)";
        ctx.fillRect(size.width - w, Math.min(y1, y2) + 0.5, w, Math.max(1, Math.abs(y2 - y1) - 1));
      }
      const pocY = series.priceToCoordinate(p.low + (poc + 0.5) * step);
      if (pocY !== null) {
        ctx.strokeStyle = "rgba(240,136,62,0.8)";
        ctx.setLineDash([4, 3]);
        ctx.beginPath(); ctx.moveTo(0, pocY); ctx.lineTo(size.width, pocY); ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.fillStyle = "#9aa4b2";
      ctx.font = "10px system-ui, sans-serif";
      ctx.fillText("VP · " + (p.source === "ticks" ? "tick" : "bar"), size.width - maxW, 12);
    });
  }
}

// Volume profile from bars: each bar's volume spread evenly over the rows its range covers.
function barProfile(bars, fromT, toT, rows) {
  let low = Infinity, high = -Infinity;
  const inRange = bars.filter(b => b.time >= fromT && b.time < toT);
  for (const b of inRange) { if (b.low < low) low = b.low; if (b.high > high) high = b.high; }
  if (!inRange.length || !(high > low)) return null;
  const step = (high - low) / rows;
  const counts = new Array(rows).fill(0);
  for (const b of inRange) {
    const a = Math.min(rows - 1, Math.floor((b.low - low) / step));
    const z = Math.min(rows - 1, Math.floor((b.high - low) / step));
    const share = (b.volume || 1) / (z - a + 1);
    for (let i = a; i <= z; i++) counts[i] += share;
  }
  return { low, high, counts, source: "bars" };
}
