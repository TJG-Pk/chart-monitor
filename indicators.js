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
