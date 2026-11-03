"""Order placement for Chart Monitor.

Safety rules, enforced here rather than in the page:
- Orders are refused unless the logged-in MT5 account is a DEMO (or contest) account.
  Real accounts need the bridge to be started with --allow-real-trading.
- New positions are refused once today's loss (closed + open P/L) reaches the daily loss
  limit, and orders larger than the max volume are refused. Closing is always allowed.
- Every order carries MAGIC and COMMENT so it can be told apart from manual trades.
"""

import json
import os
import time

import MetaTrader5 as mt5

MAGIC = 26110301
COMMENT = "ChartMonitor"
DEVIATION = 30                      # max slippage for market orders, in points
RISK_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "risk.json")
DEFAULT_RISK = {"dailyLossLimit": 0.0, "maxVolume": 1.0}    # 0 = no daily limit
ACCOUNT_MODES = {
    mt5.ACCOUNT_TRADE_MODE_DEMO: "demo",
    mt5.ACCOUNT_TRADE_MODE_CONTEST: "contest",
    mt5.ACCOUNT_TRADE_MODE_REAL: "real",
}
OK_RETCODES = {mt5.TRADE_RETCODE_DONE, mt5.TRADE_RETCODE_PLACED, mt5.TRADE_RETCODE_DONE_PARTIAL}


class TradeError(Exception):
    pass


class Trader:
    def __init__(self, bridge, lock, allow_real=False):
        self.bridge = bridge
        self.lock = lock
        self.allow_real = allow_real
        self.risk = dict(DEFAULT_RISK)
        try:
            with open(RISK_FILE, encoding="utf-8") as f:
                self.risk.update({k: float(v) for k, v in json.load(f).items() if k in DEFAULT_RISK})
        except (OSError, ValueError):
            pass

    # ---------- state ----------
    def set_risk(self, values):
        for k in DEFAULT_RISK:
            if k in values:
                v = float(values[k])
                if v < 0:
                    raise TradeError("ค่าต้องไม่ติดลบ")
                self.risk[k] = v
        with open(RISK_FILE, "w", encoding="utf-8") as f:
            json.dump(self.risk, f)
        return self.risk

    def display_name(self, mt5_name):
        for alias, s in self.bridge.symbols.items():
            if s["name"] == mt5_name:
                return alias
        return mt5_name

    def day_start(self):
        """Start of the broker's trading day, in server-time seconds."""
        now = int(time.time()) + self.bridge.offset()
        return now - now % 86400

    def daily_pnl(self):
        """(closed P/L today, open P/L now) in account currency. Call under the lock."""
        start = self.day_start()
        deals = mt5.history_deals_get(start, start + 2 * 86400) or []
        closed = sum(d.profit + d.commission + d.swap + getattr(d, "fee", 0.0) for d in deals
                     if d.type in (mt5.DEAL_TYPE_BUY, mt5.DEAL_TYPE_SELL))
        floating = sum(p.profit + p.swap for p in (mt5.positions_get() or []))
        return closed, floating

    def snapshot(self):
        """Account, open positions and pending orders for the page's trade panel."""
        with self.lock:
            a = mt5.account_info()
            term = mt5.terminal_info()
            if a is None:
                raise TradeError("MT5 ยังไม่ได้ล็อกอิน")
            closed, floating = self.daily_pnl()
            positions = mt5.positions_get() or []
            orders = mt5.orders_get() or []
        mode = ACCOUNT_MODES.get(a.trade_mode, "real")
        blocked = self.block_reason(a, term, mode, closed + floating, opening=True)
        off = self.bridge.offset()
        return {
            "account": {
                "login": a.login, "server": a.server, "mode": mode, "currency": a.currency,
                "balance": a.balance, "equity": a.equity, "margin": a.margin,
                "freeMargin": a.margin_free, "leverage": a.leverage,
            },
            "today": {"closed": round(closed, 2), "open": round(floating, 2), "total": round(closed + floating, 2)},
            "risk": self.risk,
            "canTrade": blocked is None,
            "blockedReason": blocked,
            "positions": [{
                "ticket": p.ticket, "symbol": self.display_name(p.symbol), "mt5": p.symbol,
                "side": "buy" if p.type == mt5.POSITION_TYPE_BUY else "sell", "volume": p.volume,
                "price": p.price_open, "sl": p.sl, "tp": p.tp, "current": p.price_current,
                "profit": round(p.profit + p.swap, 2), "time": p.time - off, "ours": p.magic == MAGIC,
            } for p in positions],
            "orders": [{
                "ticket": o.ticket, "symbol": self.display_name(o.symbol), "mt5": o.symbol,
                "side": "buy" if o.type in (mt5.ORDER_TYPE_BUY_LIMIT, mt5.ORDER_TYPE_BUY_STOP) else "sell",
                "type": "limit" if o.type in (mt5.ORDER_TYPE_BUY_LIMIT, mt5.ORDER_TYPE_SELL_LIMIT) else "stop",
                "volume": o.volume_current, "price": o.price_open, "sl": o.sl, "tp": o.tp,
                "time": o.time_setup - off,
            } for o in orders if o.type in (mt5.ORDER_TYPE_BUY_LIMIT, mt5.ORDER_TYPE_SELL_LIMIT,
                                            mt5.ORDER_TYPE_BUY_STOP, mt5.ORDER_TYPE_SELL_STOP)],
        }

    def block_reason(self, account, terminal, mode, today_total, opening):
        if mode == "real" and not self.allow_real:
            return "บัญชีนี้เป็นบัญชีจริง (REAL) — bridge ปิดการส่งคำสั่งไว้เพื่อความปลอดภัย ใช้บัญชี Demo หรือเปิด bridge ด้วย --allow-real-trading"
        if terminal is None or not terminal.trade_allowed:
            return "ปุ่ม Algo Trading ใน MT5 ปิดอยู่ — กดเปิดที่แถบเครื่องมือของ MT5 ก่อน"
        if not account.trade_allowed:
            return "บัญชีนี้ไม่อนุญาตให้เทรด"
        limit = self.risk["dailyLossLimit"]
        if opening and limit > 0 and today_total <= -limit:
            return "ถึงขีดจำกัดขาดทุนวันนี้แล้ว (%.2f / -%.2f) — เปิดออเดอร์ใหม่ไม่ได้จนถึงวันถัดไป" % (today_total, limit)
        return None

    def guard(self, opening):
        """Raise TradeError if an order may not be sent now. Call under the lock."""
        a, term = mt5.account_info(), mt5.terminal_info()
        if a is None:
            raise TradeError("MT5 ยังไม่ได้ล็อกอิน")
        closed, floating = self.daily_pnl() if opening else (0, 0)
        reason = self.block_reason(a, term, ACCOUNT_MODES.get(a.trade_mode, "real"), closed + floating, opening)
        if reason:
            raise TradeError(reason)

    # ---------- orders ----------
    def send(self, request):
        result = mt5.order_send(request)
        if result is None:
            raise TradeError("ส่งคำสั่งไม่สำเร็จ: %s" % (mt5.last_error(),))
        if result.retcode not in OK_RETCODES:
            raise TradeError("MT5 ปฏิเสธคำสั่ง: %s (%d)" % (result.comment, result.retcode))
        return {"retcode": result.retcode, "order": result.order, "deal": result.deal,
                "price": result.price, "volume": result.volume, "comment": result.comment}

    def place(self, req):
        sym = self.bridge.resolve(str(req.get("symbol", "")))
        if not sym:
            raise TradeError("ไม่พบสัญลักษณ์")
        side, kind = req.get("side"), req.get("type", "market")
        if side not in ("buy", "sell") or kind not in ("market", "limit", "stop"):
            raise TradeError("คำสั่งไม่ถูกต้อง")
        volume = float(req.get("volume", 0))
        sl, tp = float(req.get("sl") or 0), float(req.get("tp") or 0)
        with self.lock:
            self.guard(opening=True)
            info = mt5.symbol_info(sym["name"])
            if info is None:
                raise TradeError("ไม่พบสัญลักษณ์ใน MT5")
            if volume < info.volume_min or volume > info.volume_max:
                raise TradeError("lot ต้องอยู่ระหว่าง %g ถึง %g" % (info.volume_min, info.volume_max))
            steps = round(volume / info.volume_step)
            if abs(steps * info.volume_step - volume) > 1e-9:
                raise TradeError("lot ต้องเป็นทวีคูณของ %g" % info.volume_step)
            if self.risk["maxVolume"] > 0 and volume > self.risk["maxVolume"] + 1e-9:
                raise TradeError("lot เกินที่ตั้งไว้สูงสุด (%g)" % self.risk["maxVolume"])
            request = {"symbol": sym["name"], "volume": volume, "sl": sl, "tp": tp,
                       "magic": MAGIC, "comment": COMMENT, "type_time": mt5.ORDER_TIME_GTC}
            if kind == "market":
                tick = mt5.symbol_info_tick(sym["name"])
                request.update(action=mt5.TRADE_ACTION_DEAL, deviation=DEVIATION,
                               type=mt5.ORDER_TYPE_BUY if side == "buy" else mt5.ORDER_TYPE_SELL,
                               price=tick.ask if side == "buy" else tick.bid,
                               type_filling=self.filling(info))
            else:
                price = float(req.get("price") or 0)
                if price <= 0:
                    raise TradeError("ต้องใส่ราคาสำหรับ %s order" % kind)
                types = {("buy", "limit"): mt5.ORDER_TYPE_BUY_LIMIT, ("sell", "limit"): mt5.ORDER_TYPE_SELL_LIMIT,
                         ("buy", "stop"): mt5.ORDER_TYPE_BUY_STOP, ("sell", "stop"): mt5.ORDER_TYPE_SELL_STOP}
                request.update(action=mt5.TRADE_ACTION_PENDING, type=types[(side, kind)], price=price,
                               type_filling=mt5.ORDER_FILLING_RETURN)
            return self.send(request)

    @staticmethod
    def filling(info):
        if info.filling_mode & 2:          # SYMBOL_FILLING_IOC
            return mt5.ORDER_FILLING_IOC
        if info.filling_mode & 1:          # SYMBOL_FILLING_FOK
            return mt5.ORDER_FILLING_FOK
        return mt5.ORDER_FILLING_RETURN

    def modify(self, req):
        """Change SL/TP of a position, or price/SL/TP of a pending order."""
        ticket = int(req.get("ticket", 0))
        with self.lock:
            self.guard(opening=False)
            pos = mt5.positions_get(ticket=ticket)
            if pos:
                p = pos[0]
                return self.send({"action": mt5.TRADE_ACTION_SLTP, "position": ticket, "symbol": p.symbol,
                                  "sl": float(req.get("sl", p.sl) or 0), "tp": float(req.get("tp", p.tp) or 0),
                                  "magic": MAGIC})
            orders = mt5.orders_get(ticket=ticket)
            if orders:
                o = orders[0]
                return self.send({"action": mt5.TRADE_ACTION_MODIFY, "order": ticket, "symbol": o.symbol,
                                  "price": float(req.get("price", o.price_open)),
                                  "sl": float(req.get("sl", o.sl) or 0), "tp": float(req.get("tp", o.tp) or 0),
                                  "type_time": mt5.ORDER_TIME_GTC})
        raise TradeError("ไม่พบออเดอร์ #%d" % ticket)

    def close(self, req):
        ticket = int(req.get("ticket", 0))
        with self.lock:
            self.guard(opening=False)
            pos = mt5.positions_get(ticket=ticket)
            if not pos:
                raise TradeError("ไม่พบ position #%d" % ticket)
            p = pos[0]
            volume = float(req.get("volume") or p.volume)
            tick = mt5.symbol_info_tick(p.symbol)
            buy = p.type == mt5.POSITION_TYPE_BUY
            return self.send({"action": mt5.TRADE_ACTION_DEAL, "position": ticket, "symbol": p.symbol,
                              "volume": min(volume, p.volume),
                              "type": mt5.ORDER_TYPE_SELL if buy else mt5.ORDER_TYPE_BUY,
                              "price": tick.bid if buy else tick.ask, "deviation": DEVIATION,
                              "magic": MAGIC, "comment": COMMENT,
                              "type_filling": self.filling(mt5.symbol_info(p.symbol))})

    def cancel(self, req):
        ticket = int(req.get("ticket", 0))
        with self.lock:
            self.guard(opening=False)
            return self.send({"action": mt5.TRADE_ACTION_REMOVE, "order": ticket})

    # ---------- journal ----------
    def history(self, days):
        """Closed trades of the last `days` days, one entry per position (entry + exit deals)."""
        days = max(1, min(int(days), 365))
        off = self.bridge.offset()
        now = int(time.time()) + off
        with self.lock:
            deals = mt5.history_deals_get(now - days * 86400, now + 86400) or []
        trades = {}
        for d in deals:
            if d.type not in (mt5.DEAL_TYPE_BUY, mt5.DEAL_TYPE_SELL):
                continue
            t = trades.setdefault(d.position_id, {"position": d.position_id, "symbol": self.display_name(d.symbol),
                                                  "side": None, "volume": 0.0, "openTime": None, "openPrice": None,
                                                  "closeTime": None, "closePrice": None, "profit": 0.0,
                                                  "ours": False})
            t["profit"] += d.profit + d.commission + d.swap + getattr(d, "fee", 0.0)
            t["ours"] = t["ours"] or d.magic == MAGIC
            if d.entry == mt5.DEAL_ENTRY_IN:
                t["side"] = "buy" if d.type == mt5.DEAL_TYPE_BUY else "sell"
                t["volume"] += d.volume
                t["openTime"], t["openPrice"] = d.time - off, d.price
            elif d.entry in (mt5.DEAL_ENTRY_OUT, mt5.DEAL_ENTRY_OUT_BY, mt5.DEAL_ENTRY_INOUT):
                t["closeTime"], t["closePrice"] = d.time - off, d.price
        closed = [dict(t, profit=round(t["profit"], 2)) for t in trades.values() if t["closeTime"] and t["side"]]
        closed.sort(key=lambda t: t["closeTime"], reverse=True)
        return closed
