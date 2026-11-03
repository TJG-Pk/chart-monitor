// Indicator math on plain bar arrays: [{ time, open, high, low, close, volume }]
// Results are aligned to the input: one entry per bar, value null while warming up.
const Indicators = {
  // RSI with Wilder's smoothing (same as TradingView's built-in RSI).
  rsi(bars, length = 14) {
    const out = new Array(bars.length).fill(null);
    let avgGain = 0, avgLoss = 0;
    for (let i = 1; i < bars.length; i++) {
      const diff = bars[i].close - bars[i - 1].close;
      const gain = Math.max(diff, 0), loss = Math.max(-diff, 0);
      if (i <= length) {
        avgGain += gain / length;
        avgLoss += loss / length;
        if (i < length) continue;
      } else {
        avgGain = (avgGain * (length - 1) + gain) / length;
        avgLoss = (avgLoss * (length - 1) + loss) / length;
      }
      out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
    return out;
  },

  // Stochastic %K / %D. Defaults match TradingView: 14, 1, 3.
  stochastic(bars, kLength = 14, kSmooth = 1, dSmooth = 3) {
    const raw = bars.map((_, i) => {
      if (i < kLength - 1) return null;
      let hi = -Infinity, lo = Infinity;
      for (let j = i - kLength + 1; j <= i; j++) {
        if (bars[j].high > hi) hi = bars[j].high;
        if (bars[j].low < lo) lo = bars[j].low;
      }
      return hi === lo ? 50 : (bars[i].close - lo) / (hi - lo) * 100;
    });
    const k = Indicators.sma(raw, kSmooth);
    return { k, d: Indicators.sma(k, dSmooth) };
  },

  // Simple moving average over a series that may start with nulls.
  sma(values, length) {
    if (length <= 1) return values.slice();
    const out = new Array(values.length).fill(null);
    let sum = 0, count = 0;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v === null) { sum = 0; count = 0; continue; }
      sum += v; count++;
      if (count > length) sum -= values[i - length];
      if (count >= length) out[i] = sum / length;
    }
    return out;
  },

  // Exponential moving average seeded with the SMA of the first `length` values (TradingView's ta.ema).
  ema(values, length) {
    const out = new Array(values.length).fill(null);
    const k = 2 / (length + 1);
    let prev = null, seed = 0, count = 0;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v === null) continue;
      if (prev === null) {
        seed += v; count++;
        if (count === length) { prev = seed / length; out[i] = prev; }
        continue;
      }
      prev = v * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  },

  // Wilder's moving average (RMA), used by ATR.
  rma(values, length) {
    const out = new Array(values.length).fill(null);
    let prev = null, seed = 0, count = 0;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v === null) continue;
      if (prev === null) {
        seed += v; count++;
        if (count === length) { prev = seed / length; out[i] = prev; }
        continue;
      }
      prev = (prev * (length - 1) + v) / length;
      out[i] = prev;
    }
    return out;
  },

  bollinger(bars, length = 20, mult = 2) {
    const closes = bars.map(b => b.close);
    const mid = Indicators.sma(closes, length);
    const upper = new Array(bars.length).fill(null), lower = new Array(bars.length).fill(null);
    for (let i = length - 1; i < bars.length; i++) {
      let sq = 0;
      for (let j = i - length + 1; j <= i; j++) sq += (closes[j] - mid[i]) ** 2;
      const sd = Math.sqrt(sq / length);
      upper[i] = mid[i] + mult * sd;
      lower[i] = mid[i] - mult * sd;
    }
    return { upper, mid, lower };
  },

  // VWAP of the typical price, restarting when `sessionKey(time)` changes.
  vwap(bars, sessionKey) {
    const out = new Array(bars.length).fill(null);
    let key = null, pv = 0, vol = 0;
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i], k = sessionKey(b.time);
      if (k !== key) { key = k; pv = 0; vol = 0; }
      const v = b.volume || 1;
      pv += (b.high + b.low + b.close) / 3 * v;
      vol += v;
      out[i] = pv / vol;
    }
    return out;
  },

  macd(bars, fast = 12, slow = 26, signal = 9) {
    const closes = bars.map(b => b.close);
    const f = Indicators.ema(closes, fast), s = Indicators.ema(closes, slow);
    const macd = closes.map((_, i) => f[i] === null || s[i] === null ? null : f[i] - s[i]);
    const sig = Indicators.ema(macd, signal);
    const hist = macd.map((m, i) => m === null || sig[i] === null ? null : m - sig[i]);
    return { macd, signal: sig, hist };
  },

  atr(bars, length = 14) {
    const tr = bars.map((b, i) => i === 0 ? b.high - b.low :
      Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close)));
    return Indicators.rma(tr, length);
  },

  heikinAshi(bars) {
    const out = [];
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      const close = (b.open + b.high + b.low + b.close) / 4;
      const open = i === 0 ? (b.open + b.close) / 2 : (out[i - 1].open + out[i - 1].close) / 2;
      out.push({ time: b.time, open, close, high: Math.max(b.high, open, close), low: Math.min(b.low, open, close), volume: b.volume });
    }
    return out;
  }
};

// What the indicator dialog can add. `overlay` ones draw on the price pane, the rest get their own pane.
// compute() returns one array per entry in `outputs`, aligned with the bars.
// VWAP restarts at 00:00 UTC (bar times are UTC+7 here, see TZ_SHIFT in app.js).
const INDICATOR_DEFS = {
  sma:   { name: "SMA", overlay: true, params: { length: 20 }, outputs: [{ color: "#e3b341" }],
           compute: (b, p) => [Indicators.sma(b.map(x => x.close), p.length)] },
  ema:   { name: "EMA", overlay: true, params: { length: 50 }, outputs: [{ color: "#2f81f7" }],
           compute: (b, p) => [Indicators.ema(b.map(x => x.close), p.length)] },
  bb:    { name: "Bollinger Bands", overlay: true, params: { length: 20, mult: 2 },
           outputs: [{ color: "#58a6ff" }, { color: "#f0883e" }, { color: "#58a6ff" }],
           compute: (b, p) => { const r = Indicators.bollinger(b, p.length, p.mult); return [r.upper, r.mid, r.lower]; } },
  vwap:  { name: "VWAP", overlay: true, params: {}, outputs: [{ color: "#db61a2" }],
           compute: b => [Indicators.vwap(b, t => Math.floor((t - 7 * 3600) / 86400))] },
  rsi:   { name: "RSI", overlay: false, params: { length: 14 }, outputs: [{ color: "#a371f7" }], bands: [70, 50, 30],
           compute: (b, p) => [Indicators.rsi(b, p.length)] },
  stoch: { name: "Stochastic", overlay: false, params: { k: 14, smooth: 1, d: 3 },
           outputs: [{ color: "#2f81f7" }, { color: "#f0883e" }], bands: [80, 20],
           compute: (b, p) => { const s = Indicators.stochastic(b, p.k, p.smooth, p.d); return [s.k, s.d]; } },
  macd:  { name: "MACD", overlay: false, params: { fast: 12, slow: 26, signal: 9 },
           outputs: [{ type: "histogram", color: "#26a69a", downColor: "#ef5350" }, { color: "#2f81f7" }, { color: "#f0883e" }],
           compute: (b, p) => { const m = Indicators.macd(b, p.fast, p.slow, p.signal); return [m.hist, m.macd, m.signal]; } },
  atr:   { name: "ATR", overlay: false, params: { length: 14 }, outputs: [{ color: "#ef5350" }], priceDecimals: true,
           compute: (b, p) => [Indicators.atr(b, p.length)] }
};
