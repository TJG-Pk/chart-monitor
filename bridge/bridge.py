"""MT5 -> browser bridge for Chart Monitor.

Reads candles and live ticks from a running MetaTrader 5 terminal and serves them
over HTTP on 127.0.0.1 (plus the chart page itself), so the page can draw real prices.

    python bridge.py            then open http://localhost:8000

Endpoints (all times are real UTC seconds; MT5 server time is converted):
    GET /api/status                      -> {"ok", "error", "server", "account", "utcOffset"}
    GET /api/symbols                     -> {"XAUUSD": {"name": "XAUUSDm", "digits": 3}, ...}
    GET /api/candles?symbol=XAUUSD&tf=M1&count=500[&to=<utc seconds>]
    GET /api/stream                      -> Server-Sent Events, one "tick" event per price change
"""

import argparse
import json
import mimetypes
import os
import queue
import threading
import time
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import MetaTrader5 as mt5

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
MAX_COUNT = 5000

# The MetaTrader5 module is not documented as thread-safe; every call goes through this lock.
mt5_lock = threading.Lock()


class Bridge:
    def __init__(self, terminal_path, overrides):
        self.terminal_path = terminal_path
        self.overrides = overrides
        self.connected = False
        self.error = "ยังไม่ได้เชื่อมต่อ MT5"
        self.symbols = {}          # display name -> {"name": broker symbol, "digits": int}
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
                found[display] = {"name": name, "digits": info.digits}
        return found

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
        sym = self.symbols.get(display)
        if not sym:
            raise LookupError("ไม่พบสัญลักษณ์ %s ใน MT5" % display)
        if tf not in TIMEFRAMES:
            raise LookupError("ไม่รองรับ timeframe %s" % tf)
        count = max(1, min(int(count), MAX_COUNT))
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

    def tick_loop(self):
        last_seen = {}
        while True:
            if not self.ensure_connected():
                time.sleep(5)
                continue
            for display, sym in list(self.symbols.items()):
                with mt5_lock:
                    t = mt5.symbol_info_tick(sym["name"])
                if t is None or t.time_msc == last_seen.get(display):
                    continue
                last_seen[display] = t.time_msc
                self.update_offset(t.time_msc / 1000)
                if t.bid <= 0:
                    continue
                # Charts are built from bid prices, same as MT5's own charts.
                self.broadcast({"symbol": display, "time": t.time_msc / 1000 - self.offset(),
                                "bid": t.bid, "ask": t.ask, "price": t.bid})
            time.sleep(TICK_POLL_SECONDS)


class Handler(SimpleHTTPRequestHandler):
    bridge = None

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, fmt, *args):
        pass  # keep the console readable

    def cors(self):
        origin = self.headers.get("Origin", "")
        host = urlparse(origin).hostname or ""
        if origin in ALLOWED_ORIGINS or host in ("localhost", "127.0.0.1"):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.end_headers()

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
        if url.path == "/api/candles":
            try:
                bars = b.candles(q.get("symbol", ""), q.get("tf", ""), q.get("count", 500), q.get("to"))
            except (LookupError, ValueError) as e:
                return self.send_json(400, {"error": str(e)})
            return self.send_json(200, bars)
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


def main():
    p = argparse.ArgumentParser(description="MT5 -> Chart Monitor bridge")
    p.add_argument("--port", type=int, default=PORT)
    p.add_argument("--terminal", help="path to terminal64.exe (ถ้ามี MT5 หลายตัว)")
    p.add_argument("--symbol", action="append", default=[], metavar="NAME=MT5NAME",
                   help="กำหนดชื่อสัญลักษณ์เอง เช่น --symbol XAUUSD=XAUUSDm")
    p.add_argument("--utc-offset", type=float, metavar="HOURS",
                   help="เวลา server ของโบรกห่างจาก UTC กี่ชั่วโมง (ปกติหาเองอัตโนมัติ)")
    args = p.parse_args()
    overrides = dict(s.split("=", 1) for s in args.symbol if "=" in s)

    mimetypes.add_type("text/javascript", ".js")
    bridge = Bridge(args.terminal, overrides)
    if args.utc_offset is not None:
        bridge.utc_offset = int(args.utc_offset * 3600)
        bridge.fixed_offset = True
    if not bridge.connect():
        print(bridge.error)
        print("จะลองเชื่อมต่อใหม่ทุก 5 วินาที...")
    threading.Thread(target=bridge.tick_loop, daemon=True).start()

    Handler.bridge = bridge
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.daemon_threads = True
    print("เปิดกราฟที่ http://localhost:%d  (กด Ctrl+C เพื่อปิด)" % args.port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        with mt5_lock:
            mt5.shutdown()


if __name__ == "__main__":
    main()
