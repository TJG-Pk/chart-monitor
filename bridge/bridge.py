"""MT5 -> browser bridge for Chart Monitor.

Reads candles and live ticks from a running MetaTrader 5 terminal and serves them
over HTTP on 127.0.0.1 (plus the chart page itself), so the page can draw real prices.

    python bridge.py            then open http://localhost:8000

Endpoints (all times are real UTC seconds; MT5 server time is converted):
    GET /api/status                      -> {"ok", "error", "server", "account", "utcOffset"}
    GET /api/symbols                     -> {"XAUUSD": {"name": "XAUUSDm", "digits": 3}, ...}
    GET /api/search?q=eur                -> [{"name", "description", "path", "digits"}, ...]
    GET /api/info?symbol=EURUSD          -> {"name", "digits", "description", "dayOpen"}
    GET /api/candles?symbol=XAUUSD&tf=M1&count=500[&to=<utc seconds>]
    GET /api/profile?symbol=XAUUSD&from=<utc>&to=<utc>&rows=50 -> tick counts per price row
    GET /api/stream                      -> Server-Sent Events, one "tick" event per price change
    GET /api/trading                     -> account, today's P/L, positions, pending orders
    GET /api/history?days=30             -> closed trades (journal)
    POST /api/order | modify | close | cancel | risk   (see trading.py; Demo accounts only by default)

`symbol` is either an alias from SYMBOL_CANDIDATES (XAUUSD, NASDAQ) or any MT5 symbol name.
Every symbol that has been asked for is streamed from then on.
"""

import argparse
import json
import mimetypes
import os
import queue
import threading
import time
import webbrowser
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import MetaTrader5 as mt5
import numpy as np

from trading import Trader, TradeError

# ===== ตั้งค่า (แก้ตรงนี้ได้) =====
# ชื่อที่หน้าเว็บใช้ -> ชื่อที่จะลองหาใน MT5 (หาแบบขึ้นต้นด้วย จึงเจอ XAUUSDm, XAUUSD.pro ด้วย)
# ถ้าโบรกใช้ชื่ออื่น เพิ่มเข้าไปในลิสต์ หรือส่งผ่าน --symbol XAUUSD=ชื่อในMT5
SYMBOL_CANDIDATES = {
    "XAUUSD": ["XAUUSD", "GOLD"],
    "NASDAQ": ["NAS100", "USTEC", "US100", "NDX100", "NQ100", "USTECH"],
}
PORT = 8000
# หน้าเว็บที่อนุญาตให้ดึงข้อมูลจาก bridge นี้ได้ (นอกจาก localhost)
ALLOWED_ORIGINS = {"https://tjg-pk.github.io"}
TICK_POLL_SECONDS = 0.1
# =================================

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TIMEFRAMES = {
    "M1": mt5.TIMEFRAME_M1, "M3": mt5.TIMEFRAME_M3, "M5": mt5.TIMEFRAME_M5, "M15": mt5.TIMEFRAME_M15,
    "M30": mt5.TIMEFRAME_M30, "H1": mt5.TIMEFRAME_H1, "H4": mt5.TIMEFRAME_H4, "D1": mt5.TIMEFRAME_D1,
}
# MT5 has no bars shorter than M1; these are built from tick history instead.
SECOND_TIMEFRAMES = {"S10": 10, "S15": 15, "S30": 30}
MAX_COUNT = 5000
MAX_TICK_LOOKBACK = 4 * 86400  # seconds bars: look back at most 4 days of ticks (covers a weekend)
MAX_PROFILE_SPAN = 86400       # volume profile from ticks: at most 1 day (the page falls back to bars)

# The MetaTrader5 module is not documented as thread-safe; every call goes through this lock.
mt5_lock = threading.Lock()


class Bridge:
    def __init__(self, terminal_path, overrides):
        self.terminal_path = terminal_path
        self.overrides = overrides
        self.connected = False
        self.error = "ยังไม่ได้เชื่อมต่อ MT5"
        self.symbols = {}          # alias -> {"name": broker symbol, "digits": int}
        self.watch = {}            # every symbol the page asked for (aliases included), streamed live
        self.utc_offset = None     # broker server time minus UTC, in seconds
        self.fixed_offset = False  # True when set with --utc-offset
        self.server = ""
        self.account = ""
        self.listeners = set()
        self.listeners_lock = threading.Lock()

    # ---------- connection ----------
    def connect(self):
        with mt5_lock:
            kwargs = {"path": self.terminal_path} if self.terminal_path else {}
            if not mt5.initialize(**kwargs):
                self.connected = False
                self.error = "เชื่อมต่อ MT5 ไม่ได้: %s (เปิด MT5 และล็อกอินบัญชีก่อน)" % (mt5.last_error(),)
                return False
            info = mt5.account_info()
            if info is None:
                self.connected = False
                self.error = "MT5 ยังไม่ได้ล็อกอินบัญชี"
                mt5.shutdown()
                return False
            self.server = info.server
            self.account = str(info.login)
            self.symbols = self._resolve_symbols()
            # Keep symbols added from the page across a reconnect, but refresh the aliases.
            self.watch = dict(self.watch, **self.symbols)
            if self.utc_offset is None:
                self.detect_offset()
        self.connected = True
        self.error = "" if self.symbols else "ไม่พบสัญลักษณ์ที่ตั้งไว้ใน MT5"
        print("เชื่อมต่อ MT5 แล้ว: %s #%s" % (self.server, self.account))
        for display, s in self.symbols.items():
            print("  %s -> %s (digits %d)" % (display, s["name"], s["digits"]))
        missing = set(SYMBOL_CANDIDATES) - set(self.symbols)
        if missing:
            print("  ไม่พบ: %s  (แก้ SYMBOL_CANDIDATES หรือใช้ --symbol)" % ", ".join(sorted(missing)))
        return True

    def _resolve_symbols(self):
        all_names = [s.name for s in (mt5.symbols_get() or [])]
        found = {}
        for display, candidates in SYMBOL_CANDIDATES.items():
            name = self.overrides.get(display)
            if not name:
                for cand in candidates:
                    matches = sorted((n for n in all_names if n.upper().startswith(cand.upper())), key=len)
                    if matches:
                        name = matches[0]
                        break
            if not name or not mt5.symbol_select(name, True):
                continue
            info = mt5.symbol_info(name)
            if info is not None:
                found[display] = {"name": name, "digits": info.digits, "description": info.description}
        return found

    def resolve(self, display):
        """Alias or MT5 symbol name -> {"name", "digits", "description"}, enabling it in
        Market Watch and adding it to the live stream. None if MT5 has no such symbol."""
        if display in self.watch:
            return self.watch[display]
        with mt5_lock:
            info = mt5.symbol_info(display)
            if info is None:
                return None
            if not info.visible:
                mt5.symbol_select(display, True)
        entry = {"name": display, "digits": info.digits, "description": info.description}
        self.watch[display] = entry
        return entry

    def search(self, text, limit=50):
        text = text.strip().upper()
        with mt5_lock:
            all_syms = mt5.symbols_get() or []
        out = []
        for alias, s in self.symbols.items():
            if not text or text in alias or text in s["name"].upper():
                out.append({"name": alias, "description": s["description"], "path": "alias -> " + s["name"],
                            "digits": s["digits"]})
        # Names starting with the text first, then other matches in name or description.
        hits = [s for s in all_syms if not text or text in s.name.upper() or text in (s.description or "").upper()]
        hits.sort(key=lambda s: (not s.name.upper().startswith(text), not s.visible, len(s.name), s.name))
        for s in hits[:limit]:
            out.append({"name": s.name, "description": s.description, "path": s.path, "digits": s.digits})
        return out[:limit]

    def info(self, display):
        sym = self.resolve(display)
        if not sym:
            raise LookupError("ไม่พบสัญลักษณ์ %s ใน MT5" % display)
        # session_open is the terminal's own "today" open. The D1 bar is only a fallback: for a
        # symbol whose history MT5 has not loaded yet it can be days old.
        with mt5_lock:
            live = mt5.symbol_info(sym["name"])
            day_open = live.session_open if live is not None and live.session_open > 0 else None
            if day_open is None:
                day = mt5.copy_rates_from_pos(sym["name"], mt5.TIMEFRAME_D1, 0, 1)
                day_open = float(day[0]["open"]) if day is not None and len(day) else None
        contract = {} if live is None else {
            "tickSize": live.trade_tick_size, "tickValue": live.trade_tick_value,
            "volumeMin": live.volume_min, "volumeStep": live.volume_step, "volumeMax": live.volume_max,
            "stopsLevel": live.trade_stops_level, "point": live.point,
        }
        return dict(sym, mt5=sym["name"], name=display, dayOpen=day_open, **contract)

    def ensure_connected(self):
        if self.connected:
            with mt5_lock:
                alive = mt5.terminal_info() is not None and mt5.account_info() is not None
            if alive:
                return True
            self.connected = False
        return self.connect()

    # ---------- time ----------
    def update_offset(self, tick_time):
        """MT5 reports times in broker server time. Learn the offset from a fresh tick,
        rounded to 30 minutes (all real-world server zones are on a 30-minute grid)."""
        if self.fixed_offset:
            return
        diff = tick_time - time.time()
        offset = round(diff / 1800) * 1800
        if abs(diff - offset) < 120:   # tick is fresh (market open), so the offset is trustworthy
            if offset != self.utc_offset:
                print("เวลา server ของโบรก = UTC%+.1f ชม." % (offset / 3600))
            self.utc_offset = offset

    def detect_offset(self):
        """When the charted symbols are closed (weekend, holiday), learn the offset from
        whichever Market Watch symbol ticked most recently, e.g. crypto. Call under mt5_lock."""
        newest = 0
        for s in mt5.symbols_get() or []:
            if s.visible:
                t = mt5.symbol_info_tick(s.name)
                if t is not None and t.time_msc > newest:
                    newest = t.time_msc
        if newest:
            self.update_offset(newest / 1000)

    def offset(self):
        return self.utc_offset or 0

    # ---------- data ----------
    def candles(self, display, tf, count, to_utc=None):
        sym = self.resolve(display)
        if not sym:
            raise LookupError("ไม่พบสัญลักษณ์ %s ใน MT5" % display)
        if tf not in TIMEFRAMES and tf not in SECOND_TIMEFRAMES:
            raise LookupError("ไม่รองรับ timeframe %s" % tf)
        count = max(1, min(int(count), MAX_COUNT))
        if tf in SECOND_TIMEFRAMES:
            return self.second_candles(sym["name"], SECOND_TIMEFRAMES[tf], count, to_utc)
        with mt5_lock:
            if to_utc:
                # Bars strictly before `to`: MT5 includes the bar opening at date_from, so step back 1s.
                server_to = datetime.fromtimestamp(int(to_utc) + self.offset() - 1, tz=timezone.utc)
                rates = mt5.copy_rates_from(sym["name"], TIMEFRAMES[tf], server_to, count)
            else:
                rates = mt5.copy_rates_from_pos(sym["name"], TIMEFRAMES[tf], 0, count)
        if rates is None:
            return []
        off = self.offset()
        return [{
            "time": int(r["time"]) - off,
            "open": float(r["open"]), "high": float(r["high"]), "low": float(r["low"]),
            "close": float(r["close"]), "volume": int(r["tick_volume"]),
        } for r in rates]

    def second_candles(self, name, sec, count, to_utc=None):
        """Aggregate bid ticks into `sec`-second bars. Starts with a window of about 2x the
        bars asked for and widens it when the market was closed for part of that time."""
        off = self.offset()
        end = (int(to_utc) if to_utc else int(time.time()) + 1) + off   # server time, exclusive
        span = count * sec * 2
        while True:
            start = max(end - span, end - MAX_TICK_LOOKBACK)
            with mt5_lock:
                ticks = mt5.copy_ticks_range(name, start, end, mt5.COPY_TICKS_INFO)
            bars = ticks_to_bars(ticks, sec, end)
            if len(bars) >= count or end - start >= MAX_TICK_LOOKBACK:
                break
            span *= 4
        for b in bars:
            b["time"] -= off
        return bars[-count:]

    def profile(self, display, from_utc, to_utc, rows):
        """Tick count per price row between two UTC times: a volume profile built from every
        bid tick rather than from bar ranges."""
        sym = self.resolve(display)
        if not sym:
            raise LookupError("ไม่พบสัญลักษณ์ %s ใน MT5" % display)
        start, end, rows = int(from_utc), int(to_utc), max(5, min(int(rows), 200))
        if end <= start or end - start > MAX_PROFILE_SPAN:
            raise ValueError("ช่วงเวลาต้องไม่เกิน %d ชั่วโมง" % (MAX_PROFILE_SPAN // 3600))
        off = self.offset()
        with mt5_lock:
            ticks = mt5.copy_ticks_range(sym["name"], start + off, end + off, mt5.COPY_TICKS_INFO)
        if ticks is None or not len(ticks):
            return {"low": None, "high": None, "counts": [], "ticks": 0}
        bid = ticks["bid"][ticks["bid"] > 0]
        if not len(bid):
            return {"low": None, "high": None, "counts": [], "ticks": 0}
        low, high = float(bid.min()), float(bid.max())
        counts, _ = np.histogram(bid, bins=rows, range=(low, high if high > low else low + 1e-9))
        return {"low": low, "high": high, "counts": counts.tolist(), "ticks": int(len(bid))}

    # ---------- live ticks ----------
    def add_listener(self, q):
        with self.listeners_lock:
            self.listeners.add(q)

    def remove_listener(self, q):
        with self.listeners_lock:
            self.listeners.discard(q)

    def broadcast(self, event):
        with self.listeners_lock:
            targets = list(self.listeners)
        for q in targets:
            try:
                q.put_nowait(event)
            except queue.Full:
                pass  # a stalled browser tab must not block the tick loop

    def emit(self, display, time_msc, bid, ask):
        # Charts are built from bid prices, same as MT5's own charts.
        if bid > 0:
            self.broadcast({"symbol": display, "time": time_msc / 1000 - self.offset(),
                            "bid": float(bid), "ask": float(ask), "price": float(bid)})

    def tick_loop(self):
        """Forward every tick, not just the latest one per poll, so short bars built in the
        browser get the true high and low."""
        last_msc = {}
        while True:
            if not self.ensure_connected():
                time.sleep(5)
                continue
            for display, sym in list(self.watch.items()):
                since = last_msc.get(display)
                with mt5_lock:
                    if since is None:
                        first = mt5.symbol_info_tick(sym["name"])
                    else:
                        ticks = mt5.copy_ticks_from(sym["name"], since // 1000, 1000, mt5.COPY_TICKS_INFO)
                if since is None:
                    if first is not None and first.time_msc:
                        last_msc[display] = first.time_msc
                        self.update_offset(first.time_msc / 1000)
                        self.emit(display, first.time_msc, first.bid, first.ask)
                    continue
                if ticks is None or not len(ticks):
                    continue
                new = ticks[ticks["time_msc"] > since]
                if not len(new):
                    continue
                last_msc[display] = int(new["time_msc"][-1])
                self.update_offset(last_msc[display] / 1000)
                for r in new:
                    self.emit(display, int(r["time_msc"]), r["bid"], r["ask"])
            time.sleep(TICK_POLL_SECONDS)


def ticks_to_bars(ticks, sec, end_server):
    """Bid ticks (numpy records from copy_ticks_*) -> OHLC bars in server time, oldest first.
    Volume is the tick count, like MT5's tick_volume."""
    if ticks is None or not len(ticks):
        return []
    ms, bid = ticks["time_msc"], ticks["bid"]
    keep = (bid > 0) & (ms < end_server * 1000)
    ms, bid = ms[keep], bid[keep]
    if not len(ms):
        return []
    bucket = (ms // 1000 // sec) * sec
    starts = np.flatnonzero(np.r_[True, bucket[1:] != bucket[:-1]])
    ends = np.r_[starts[1:], len(bid)]
    highs = np.maximum.reduceat(bid, starts)
    lows = np.minimum.reduceat(bid, starts)
    return [{
        "time": int(bucket[s]), "open": float(bid[s]), "high": float(h), "low": float(l),
        "close": float(bid[e - 1]), "volume": int(e - s),
    } for s, e, h, l in zip(starts, ends, highs, lows)]


class Handler(SimpleHTTPRequestHandler):
    bridge = None

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, fmt, *args):
        pass  # keep the console readable

    def origin_allowed(self):
        origin = self.headers.get("Origin", "")
        return origin in ALLOWED_ORIGINS or (urlparse(origin).hostname or "") in ("localhost", "127.0.0.1")

    def cors(self):
        if self.origin_allowed():
            self.send_header("Access-Control-Allow-Origin", self.headers.get("Origin"))
            self.send_header("Vary", "Origin")

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Chart-Monitor")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.end_headers()

    def do_POST(self):
        """Trading actions. Only accepted from the chart page itself: the Origin must be allowed
        and the custom X-Chart-Monitor header must be present, which a plain cross-site form or
        image request cannot send without passing the CORS preflight above."""
        url = urlparse(self.path)
        if not self.origin_allowed() or self.headers.get("X-Chart-Monitor") != "1":
            return self.send_json(403, {"error": "forbidden"})
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(min(length, 10000)) or b"{}")
        except ValueError:
            return self.send_json(400, {"error": "bad request"})
        trader = self.bridge.trader
        actions = {"/api/order": trader.place, "/api/modify": trader.modify, "/api/close": trader.close,
                   "/api/cancel": trader.cancel, "/api/risk": trader.set_risk}
        if url.path not in actions:
            return self.send_json(404, {"error": "not found"})
        if not self.bridge.connected:
            return self.send_json(503, {"error": self.bridge.error})
        try:
            result = actions[url.path](body)
        except (TradeError, ValueError, TypeError) as e:
            return self.send_json(400, {"error": str(e)})
        print("[trade] %s %s -> %s" % (url.path, json.dumps(body, ensure_ascii=False), json.dumps(result, ensure_ascii=False)))
        return self.send_json(200, result)

    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urlparse(self.path)
        if url.path.startswith("/api/"):
            return self.api(url)
        # Static files from the repo, but never dotfiles such as .git
        if any(part.startswith(".") for part in url.path.split("/")):
            return self.send_error(404)
        return super().do_GET()

    def api(self, url):
        b = self.bridge
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        if url.path == "/api/status":
            return self.send_json(200, {"ok": b.connected and bool(b.symbols), "error": b.error,
                                        "server": b.server, "account": b.account,
                                        "utcOffset": b.utc_offset})
        if not b.connected:
            return self.send_json(503, {"error": b.error})
        if url.path == "/api/symbols":
            return self.send_json(200, b.symbols)
        if url.path == "/api/search":
            return self.send_json(200, b.search(q.get("q", "")))
        if url.path == "/api/info":
            try:
                return self.send_json(200, b.info(q.get("symbol", "")))
            except LookupError as e:
                return self.send_json(404, {"error": str(e)})
        if url.path == "/api/candles":
            try:
                bars = b.candles(q.get("symbol", ""), q.get("tf", ""), q.get("count", 500), q.get("to"))
            except (LookupError, ValueError) as e:
                return self.send_json(400, {"error": str(e)})
            return self.send_json(200, bars)
        if url.path == "/api/profile":
            try:
                return self.send_json(200, b.profile(q.get("symbol", ""), q.get("from", 0), q.get("to", 0),
                                                     q.get("rows", 50)))
            except (LookupError, ValueError) as e:
                return self.send_json(400, {"error": str(e)})
        if url.path == "/api/trading":
            try:
                return self.send_json(200, b.trader.snapshot())
            except TradeError as e:
                return self.send_json(400, {"error": str(e)})
        if url.path == "/api/history":
            return self.send_json(200, b.trader.history(q.get("days", 30)))
        if url.path == "/api/stream":
            return self.stream()
        return self.send_json(404, {"error": "not found"})

    def stream(self):
        q = queue.Queue(maxsize=1000)
        self.send_response(200)
        self.cors()
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.bridge.add_listener(q)
        try:
            while True:
                try:
                    ev = q.get(timeout=5)
                    self.wfile.write(("event: tick\ndata: %s\n\n" % json.dumps(ev)).encode())
                except queue.Empty:
                    self.wfile.write(b": heartbeat\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        finally:
            self.bridge.remove_listener(q)


class Server(ThreadingHTTPServer):
    # HTTPServer sets SO_REUSEADDR, which on Windows lets a second bridge bind the same
    # port silently. Turn it off so a second launch fails to bind and says so instead.
    allow_reuse_address = False


def main():
    p = argparse.ArgumentParser(description="MT5 -> Chart Monitor bridge")
    p.add_argument("--port", type=int, default=PORT)
    p.add_argument("--terminal", help="path to terminal64.exe (ถ้ามี MT5 หลายตัว)")
    p.add_argument("--symbol", action="append", default=[], metavar="NAME=MT5NAME",
                   help="กำหนดชื่อสัญลักษณ์เอง เช่น --symbol XAUUSD=XAUUSDm")
    p.add_argument("--no-browser", action="store_true", help="ไม่ต้องเปิดเบราว์เซอร์อัตโนมัติ")
    p.add_argument("--allow-real-trading", action="store_true",
                   help="อนุญาตให้ส่งคำสั่งเข้าบัญชีจริง (ค่าเริ่มต้น: ส่งได้เฉพาะบัญชี Demo)")
    p.add_argument("--utc-offset", type=float, metavar="HOURS",
                   help="เวลา server ของโบรกห่างจาก UTC กี่ชั่วโมง (ปกติหาเองอัตโนมัติ)")
    args = p.parse_args()
    overrides = dict(s.split("=", 1) for s in args.symbol if "=" in s)

    mimetypes.add_type("text/javascript", ".js")
    url = "http://localhost:%d" % args.port

    # Bind first: if the port is taken, a bridge is most likely already running.
    try:
        server = Server(("127.0.0.1", args.port), Handler)
    except OSError:
        print("พอร์ต %d ถูกใช้อยู่ — น่าจะเปิด bridge ไว้แล้วในอีกหน้าต่างหนึ่ง" % args.port)
        print("กำลังเปิด %s ให้" % url)
        if not args.no_browser:
            webbrowser.open(url)
        return
    server.daemon_threads = True

    bridge = Bridge(args.terminal, overrides)
    bridge.trader = Trader(bridge, mt5_lock, allow_real=args.allow_real_trading)
    if args.allow_real_trading:
        print("⚠ เปิดให้ส่งคำสั่งเข้าบัญชีจริงได้ (--allow-real-trading)")
    if args.utc_offset is not None:
        bridge.utc_offset = int(args.utc_offset * 3600)
        bridge.fixed_offset = True
    if not bridge.connect():
        print(bridge.error)
        print("จะลองเชื่อมต่อใหม่ทุก 5 วินาที...")
    threading.Thread(target=bridge.tick_loop, daemon=True).start()

    Handler.bridge = bridge
    print("เปิดกราฟที่ %s  (ปิดหน้าต่างนี้หรือกด Ctrl+C เพื่อหยุด)" % url)
    if not args.no_browser:
        # The socket is already listening, so the page loads instead of "can't be reached".
        threading.Timer(0.3, webbrowser.open, [url]).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        with mt5_lock:
            mt5.shutdown()


if __name__ == "__main__":
    main()
