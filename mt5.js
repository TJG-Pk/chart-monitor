// Client for bridge/bridge.py, which serves candles and live ticks from a running MetaTrader 5.
const Mt5 = (() => {
  let base = "";

  function configure(url) { base = (url || "").replace(/\/+$/, ""); }

  async function get(path) {
    let res;
    try {
      res = await fetch(base + path, { cache: "no-store" });
    } catch (e) {
      throw new Error("ติดต่อ bridge ไม่ได้ — เปิด start-bridge.bat แล้วหรือยัง");
    }
    let data = {};
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
    return data;
  }

  const status = () => get("/api/status");
  const symbols = () => get("/api/symbols");
  const info = symbol => get("/api/info?symbol=" + encodeURIComponent(symbol));
  const search = text => get("/api/search?q=" + encodeURIComponent(text));

  // Bars oldest first, times in UTC seconds. `to` loads history before that time.
  function candles(symbol, tf, { count = 500, to } = {}) {
    let q = `symbol=${encodeURIComponent(symbol)}&tf=${tf}&count=${count}`;
    if (to) q += `&to=${to}`;
    return get("/api/candles?" + q);
  }

  // Live ticks via Server-Sent Events. EventSource retries by itself on network drops,
  // but gives up on an HTTP error (e.g. 503 while MT5 is closed), so retry that here.
  function streamTicks(onTick, onStatus) {
    let es = null, stopped = false, timer = 0;
    function open() {
      onStatus("connecting");
      es = new EventSource(base + "/api/stream");
      es.onopen = () => onStatus("live");
      es.addEventListener("tick", e => onTick(JSON.parse(e.data)));
      es.onerror = async () => {
        if (stopped) return;
        if (es.readyState !== EventSource.CLOSED) { onStatus("connecting", "รอ bridge…"); return; }
        let msg = "รอ bridge…";
        try { const st = await status(); if (st.error) msg = st.error; } catch (e) { msg = e.message; }
        onStatus("error", msg);
        timer = setTimeout(open, 5000);
      };
    }
    open();
    return { stop() { stopped = true; clearTimeout(timer); if (es) es.close(); } };
  }

  return { configure, status, symbols, info, search, candles, streamTicks };
})();
