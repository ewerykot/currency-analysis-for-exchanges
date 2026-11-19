"""Telegram-бот «Мої валюти».

Бот — ще один клієнт того ж API, що й сайт: бере курси, картки й покупки з
http://127.0.0.1:PORT/api/…, тому показує ті самі цифри, що й сторінка.

Можливості:
  • 💱 Курси        — НБУ, Monobank, ПриватБанк
  • 💳 Мої картки   — баланс, середній курс, прибуток
  • 🤔 Купувати?    — порада: порівняння з вашим середнім курсом і з курсом за 30 днів
  • 🔔 Сповіщення   — «напиши, коли $ у Mono стане дешевшим за 41,5»
  • 🌍 Сайт         — адреса сайту; після запуску тунелю бот надсилає нову адресу сам

Безпека: бот відповідає лише одному чату — тому, що підключився кодом із
«Налаштувань» сайту (код видно тільки на ПК або після входу за PIN).
"""
import asyncio
import html
import os
import random
import sqlite3
import time
from typing import Optional

import httpx

FLAGS = {"USD": "🇺🇸", "EUR": "🇪🇺"}
SIGN = {"USD": "$", "EUR": "€"}

KEYBOARD = {
    "keyboard": [
        [{"text": "💱 Курси"}, {"text": "💳 Мої картки"}],
        [{"text": "🤔 Купувати?"}, {"text": "🔔 Сповіщення"}],
        [{"text": "🌍 Сайт"}, {"text": "❓ Допомога"}],
    ],
    "resize_keyboard": True,
}

HELP = (
    "<b>Мої валюти — бот</b>\n\n"
    "💱 <b>Курси</b> — НБУ, Monobank, ПриватБанк\n"
    "💳 <b>Мої картки</b> — баланс, середній курс, прибуток\n"
    "🤔 <b>Купувати?</b> — чи вигідно докупити валюту зараз\n"
    "🔔 <b>Сповіщення</b> — список ваших сповіщень\n"
    "🌍 <b>Сайт</b> — адреса сайту для телефона\n\n"
    "<b>Нове сповіщення:</b>\n"
    "<code>/alert usd 41.5</code> — коли $ у Mono подешевшає до 41,5\n"
    "<code>/alert eur &gt; 52</code> — коли € у Mono купуватимуть дорожче за 52\n"
    "<code>/del 2</code> — видалити сповіщення №2"
)


def fmt(x: Optional[float], digits: int = 2) -> str:
    if x is None:
        return "—"
    s = f"{x:,.{digits}f}".replace(",", " ").replace(".", ",")
    return s


def average_cost(rows: list) -> Optional[dict]:
    """Той самий метод середньої вартості, що й на сайті (app.js → averageCost)."""
    rows = sorted(rows, key=lambda r: (r["date"], r.get("id") or 0))
    amount = cost = 0.0
    for r in rows:
        if r["type"] == "buy":
            amount += r["amount"]
            cost += r["uah_amount"]
        elif amount > 0:
            sold = min(r["amount"], amount)
            cost -= cost / amount * sold
            amount -= sold
    return {"amount": amount, "cost": cost, "avg": cost / amount} if amount > 0 else None


class Bot:
    def __init__(self, db_file, port: int, tunnel: dict):
        self.token = os.getenv("TG_BOT_TOKEN", "").strip()
        self.api = os.getenv("TG_API_BASE", "https://api.telegram.org").rstrip("/") + f"/bot{self.token}"
        self.local = f"http://127.0.0.1:{port}"
        self.db_file = db_file
        self.tunnel = tunnel
        self.code = f"{random.randint(0, 999999):06d}"   # код підключення, новий при кожному запуску
        self.username: Optional[str] = None
        self.error: Optional[str] = None
        self.running = False
        self._sent_url: Optional[str] = None
        self._wrong = 0
        self._db_init()

    # ─── база ───────────────────────────────────────────────────────────────
    def _db(self):
        con = sqlite3.connect(self.db_file)
        con.row_factory = sqlite3.Row
        return con

    def _db_init(self) -> None:
        con = self._db()
        con.executescript("""
            CREATE TABLE IF NOT EXISTS bot_kv (key TEXT PRIMARY KEY, value TEXT);
            CREATE TABLE IF NOT EXISTS bot_alerts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                currency TEXT NOT NULL, op TEXT NOT NULL, value REAL NOT NULL,
                created_at TEXT DEFAULT (datetime('now','localtime'))
            );
        """)
        con.commit(); con.close()

    def _get(self, key: str) -> Optional[str]:
        con = self._db()
        row = con.execute("SELECT value FROM bot_kv WHERE key=?", (key,)).fetchone()
        con.close()
        return row["value"] if row else None

    def _set(self, key: str, value: Optional[str]) -> None:
        con = self._db()
        if value is None:
            con.execute("DELETE FROM bot_kv WHERE key=?", (key,))
        else:
            con.execute("INSERT OR REPLACE INTO bot_kv(key,value) VALUES(?,?)", (key, value))
        con.commit(); con.close()

    @property
    def chat_id(self) -> Optional[str]:
        return self._get("chat_id")

    def status(self) -> dict:
        return {
            "configured": bool(self.token),
            "running": self.running,
            "username": self.username,
            "linked": bool(self.chat_id),
            "chatName": self._get("chat_name"),
            "code": self.code,
            "link": f"https://t.me/{self.username}?start={self.code}" if self.username else None,
            "error": self.error,
            "alerts": len(self.list_alerts()),
        }

    def unlink(self) -> None:
        self._set("chat_id", None)
        self._set("chat_name", None)

    # ─── Telegram ───────────────────────────────────────────────────────────
    async def _tg(self, client: httpx.AsyncClient, method: str, **params):
        r = await client.post(f"{self.api}/{method}", json=params, timeout=40)
        data = r.json()
        if not data.get("ok"):
            raise RuntimeError(data.get("description", "помилка Telegram"))
        return data["result"]

    async def send(self, text: str, chat_id: Optional[str] = None, keyboard: bool = True) -> bool:
        chat_id = chat_id or self.chat_id
        if not (self.token and chat_id):
            return False
        params = {"chat_id": chat_id, "text": text, "parse_mode": "HTML", "disable_web_page_preview": True}
        if keyboard:
            params["reply_markup"] = KEYBOARD
        async with httpx.AsyncClient() as c:
            await self._tg(c, "sendMessage", **params)
        return True

    async def run(self) -> None:
        """Головний цикл: отримує повідомлення (long polling) і перевіряє сповіщення."""
        if not self.token:
            return
        async with httpx.AsyncClient() as c:
            try:
                me = await self._tg(c, "getMe")
                self.username = me.get("username")
                await self._tg(c, "deleteWebhook")
            except Exception as e:
                self.error = f"токен бота не підходить або немає інтернету ({e})"
                print(f"  ⚠ Telegram-бот: {self.error}")
                return
        self.running = True
        print(f"  🤖 Telegram-бот @{self.username} працює" +
              ("" if self.chat_id else f" — підключіть його: код {self.code} (Налаштування сайту)"))
        asyncio.create_task(self._alerts_loop())
        asyncio.create_task(self._announce_start())
        offset = 0
        async with httpx.AsyncClient() as c:
            while True:
                try:
                    updates = await self._tg(c, "getUpdates", offset=offset, timeout=25,
                                             allowed_updates=["message"])
                    for u in updates:
                        offset = u["update_id"] + 1
                        msg = u.get("message") or {}
                        if msg.get("text"):
                            try:
                                await self._handle(msg)
                            except Exception as e:
                                await self.send(f"⚠ Помилка: {html.escape(str(e))}", str(msg["chat"]["id"]))
                except Exception:
                    await asyncio.sleep(5)        # немає інтернету — пробуємо знову

    async def _announce_start(self) -> None:
        """Після запуску сервера: повідомлення з адресою сайту (з тунелем — коли він підніметься)."""
        if not self.chat_id:
            return
        for _ in range(60):                       # тунель стартує кілька секунд
            if self.tunnel.get("url") or not self.tunnel.get("starting"):
                break
            await asyncio.sleep(1)
        await self._send_site_message(started=True)

    async def _send_site_message(self, started: bool = False) -> None:
        access = await self._api("/api/access")
        url = self.tunnel.get("url")
        lines = ["🟢 <b>Мої валюти запущено</b>" if started else "🌍 <b>Сайт</b>"]
        if url:
            lines.append(f"З будь-якого місця: {url}")
            self._sent_url = url
        lines.append(f"Вдома по Wi-Fi: {access['lanUrl']}")
        if not url:
            lines.append("<i>Для доступу з інтернету запустіть start-internet.bat</i>")
        await self.send("\n".join(lines))

    # ─── дані з API сайту ───────────────────────────────────────────────────
    async def _api(self, path: str):
        async with httpx.AsyncClient() as c:
            r = await c.get(self.local + path, timeout=60)
            r.raise_for_status()
            return r.json()

    async def _rates(self) -> dict:
        return await self._api("/api/rates")

    # ─── обробка повідомлень ────────────────────────────────────────────────
    async def _handle(self, msg: dict) -> None:
        chat = str(msg["chat"]["id"])
        text = msg["text"].strip()
        low = text.lower()

        # підключення: /start КОД (з QR-коду на сайті) або просто код
        parts = text.split()
        code = parts[1] if low.startswith("/start") and len(parts) > 1 else \
            (text if text.isdigit() and chat != self.chat_id else None)
        if code is not None:
            if code == self.code:
                who = msg["chat"].get("first_name") or msg["chat"].get("title") or "ви"
                self._set("chat_id", chat)
                self._set("chat_name", who)
                self.code = f"{random.randint(0, 999999):06d}"     # код одноразовий
                await self.send(f"✅ Підключено! Привіт, {html.escape(who)}.\n\n" + HELP, chat)
            else:
                self._wrong += 1
                if self._wrong % 5 == 0:                       # захист від підбору: новий код
                    self.code = f"{random.randint(0, 999999):06d}"
                await self.send("❌ Неправильний код. Код — у Налаштуваннях сайту → 🤖 Telegram-бот.",
                                chat, keyboard=False)
            return
        if chat != self.chat_id:
            await self.send("🔒 Це приватний бот застосунку «Мої валюти».\n"
                            "Щоб підключити, введіть код із Налаштувань сайту.", chat, keyboard=False)
            return

        if low in ("/start", "/help", "❓ допомога"):
            await self.send(HELP)
        elif low in ("/rates", "💱 курси"):
            await self.send(await self.rates_text())
        elif low in ("/cards", "💳 мої картки"):
            await self.send(await self.cards_text())
        elif low in ("/advice", "🤔 купувати?"):
            await self.send(await self.advice_text())
        elif low in ("/alerts", "🔔 сповіщення"):
            await self.send(self.alerts_text())
        elif low in ("/site", "🌍 сайт"):
            await self._send_site_message()
        elif low.startswith("/alert"):
            await self.send(await self.add_alert(text))
        elif low.startswith("/del"):
            await self.send(self.del_alert(text))
        else:
            await self.send("Не зрозумів 🙂 Оберіть кнопку внизу або /help.")

    # ─── тексти ─────────────────────────────────────────────────────────────
    async def rates_text(self) -> str:
        r = await self._rates()
        lines = ["💱 <b>Курси валют</b>", ""]
        for ccy in ("USD", "EUR"):
            d = r.get(ccy.lower(), {})
            lines.append(f"{FLAGS[ccy]} <b>{ccy}</b>   НБУ: {fmt(d.get('nbu'), 4)}")
            lines.append(f"   Mono:    купівля {fmt(d.get('monoSell'))} · продаж {fmt(d.get('monoBuy'))}")
            lines.append(f"   Приват:  купівля {fmt(d.get('privatSell'))} · продаж {fmt(d.get('privatBuy'))}")
            lines.append("")
        lines.append("<i>купівля — скільки заплатите за 1 одиницю, продаж — скільки отримаєте</i>")
        if any(v != "ok" for v in r.get("sources", {}).values()):
            lines.append("<i>⚠ частина курсів зі збереженої копії (немає зв'язку з банком)</i>")
        return "\n".join(lines)

    async def _portfolio(self) -> list:
        """Картки з балансом, середнім курсом і прибутком — як на сайті."""
        rates = await self._rates()
        mono = await self._api("/api/mono/cards")
        manual = await self._api("/api/manual-cards")
        purchases = await self._api("/api/purchases")
        cards = []
        for c in mono.get("cards", []) if mono.get("connected") else []:
            cards.append({"id": c["id"], "name": f"Mono {c['currency']} {c.get('maskedPan', '')}",
                          "ccy": c["currency"], "balance": c["balance"], "bank": "mono"})
        for c in manual:
            cards.append({"id": str(c["id"]), "name": f"{c['bank']} {c['currency']} •••• {c['last4']}",
                          "ccy": c["currency"], "balance": c["balance"], "bank": "privat"})
        for c in cards:
            d = rates.get(c["ccy"].lower(), {})
            c["sellRate"] = d.get(f"{c['bank']}Buy") or d.get("monoBuy") or d.get("nbu")
            ac = average_cost([p for p in purchases if p["card_id"] == c["id"]])
            c["avg"] = ac["avg"] if ac else None
            if c["avg"] and c["sellRate"]:
                c["profit"] = (c["sellRate"] - c["avg"]) * c["balance"]
                c["pct"] = (c["sellRate"] / c["avg"] - 1) * 100
        return cards

    async def cards_text(self) -> str:
        cards = await self._portfolio()
        if not cards:
            return "💳 Карток поки немає. Додайте їх на сайті."
        lines = ["💳 <b>Мої картки</b>", ""]
        total = 0.0
        for c in cards:
            s = SIGN.get(c["ccy"], "")
            lines.append(f"{FLAGS.get(c['ccy'], '')} <b>{html.escape(c['name'].strip())}</b>")
            lines.append(f"   Баланс: {s}{fmt(c['balance'])}  ≈ {fmt(c['balance'] * (c['sellRate'] or 0), 0)} грн")
            if c.get("avg"):
                sign = "+" if c["profit"] >= 0 else "−"
                icon = "📈" if c["profit"] >= 0 else "📉"
                lines.append(f"   Середній курс: {fmt(c['avg'], 4)} · зараз {fmt(c['sellRate'], 4)}")
                lines.append(f"   {icon} {sign}{fmt(abs(c['profit']))} грн ({sign}{fmt(abs(c['pct']), 1)} %)")
                total += c["profit"]
            else:
                lines.append("   <i>немає покупок — прибуток не рахується</i>")
            lines.append("")
        sign = "+" if total >= 0 else "−"
        lines.append(f"<b>Разом прибуток: {sign}{fmt(abs(total))} грн</b>")
        return "\n".join(lines)

    async def advice_text(self) -> str:
        rates = await self._rates()
        cards = await self._portfolio()
        lines = ["🤔 <b>Чи вигідно купувати зараз?</b>", ""]
        for ccy in ("USD", "EUR"):
            d = rates.get(ccy.lower(), {})
            price = d.get("monoSell") or d.get("privatSell")
            if not price:
                continue
            lines.append(f"{FLAGS[ccy]} <b>{ccy}</b> — купівля в Mono {fmt(price)}")
            score = 0
            avgs = [c["avg"] for c in cards if c["ccy"] == ccy and c.get("avg")]
            if avgs:
                avg = sum(avgs) / len(avgs)
                diff = (price / avg - 1) * 100
                word = "дешевше" if diff < 0 else "дорожче"
                lines.append(f"   • ваш середній курс {fmt(avg, 2)} → зараз {word} на {fmt(abs(diff), 1)} %")
                score += 1 if diff < 0 else -1
            try:
                hist = await self._api(f"/api/rates/history?ccy={ccy}&days=30")
                vals = [h["rate"] for h in hist if h.get("rate")]
            except Exception:
                vals = []
            nbu = d.get("nbu") or (vals[-1] if vals else None)
            if len(vals) >= 5 and nbu:
                cheaper = sum(1 for v in vals if v > nbu) / len(vals) * 100
                lines.append(f"   • НБУ за 30 днів: мін {fmt(min(vals))} · сер {fmt(sum(vals) / len(vals))} · "
                             f"макс {fmt(max(vals))}")
                lines.append(f"   • зараз дешевше, ніж у {cheaper:.0f} % днів місяця")
                score += 1 if cheaper >= 60 else (-1 if cheaper <= 30 else 0)
            verdict = ("🟢 вигідний момент, щоб докупити" if score >= 2 else
                       "🔴 краще зачекати" if score <= -1 else "🟡 нейтрально — можна купувати потроху")
            lines.append(f"   <b>{verdict}</b>")
            lines.append("")
        lines.append("<i>Це підказка за історією курсу, а не фінансова порада.</i>")
        return "\n".join(lines)

    # ─── сповіщення ─────────────────────────────────────────────────────────
    def list_alerts(self) -> list:
        con = self._db()
        rows = con.execute("SELECT * FROM bot_alerts ORDER BY id").fetchall()
        con.close()
        return [dict(r) for r in rows]

    def alerts_text(self) -> str:
        alerts = self.list_alerts()
        if not alerts:
            return ("🔔 Сповіщень поки немає.\n\n"
                    "Додати: <code>/alert usd 41.5</code> — напишу, коли $ у Mono подешевшає до 41,5\n"
                    "або <code>/alert eur &gt; 52</code> — коли € купуватимуть дорожче за 52")
        lines = ["🔔 <b>Ваші сповіщення</b>", ""]
        for a in alerts:
            what = "купівля ≤" if a["op"] == "<" else "продаж ≥"
            lines.append(f"№{a['id']}  {FLAGS.get(a['currency'], '')} {a['currency']}: {what} {fmt(a['value'])}")
        lines.append("\nВидалити: <code>/del номер</code>")
        return "\n".join(lines)

    async def add_alert(self, text: str) -> str:
        parts = text.replace(",", ".").split()[1:]
        try:
            ccy = parts[0].upper()
            op = "<"
            if parts[1] in ("<", ">"):
                op, value = parts[1], float(parts[2])
            else:
                value = float(parts[1])
            assert ccy in ("USD", "EUR") and 1 < value < 1000
        except Exception:
            return "Формат: <code>/alert usd 41.5</code> або <code>/alert eur &gt; 52</code>"
        con = self._db()
        con.execute("INSERT INTO bot_alerts(currency,op,value) VALUES(?,?,?)", (ccy, op, value))
        con.commit(); con.close()
        d = (await self._rates()).get(ccy.lower(), {})
        now = d.get("monoSell") if op == "<" else d.get("monoBuy")
        what = f"купівля {ccy} у Mono стане ≤ {fmt(value)}" if op == "<" else \
               f"продаж {ccy} у Mono стане ≥ {fmt(value)}"
        asyncio.create_task(self.check_alerts())
        return f"✅ Готово! Напишу, коли {what}.\nЗараз: {fmt(now)}. Перевіряю кожні 5 хвилин."

    def del_alert(self, text: str) -> str:
        try:
            aid = int(text.split()[1].lstrip("№#"))
        except Exception:
            return "Формат: <code>/del 2</code>"
        con = self._db()
        n = con.execute("DELETE FROM bot_alerts WHERE id=?", (aid,)).rowcount
        con.commit(); con.close()
        return f"🗑 Сповіщення №{aid} видалено." if n else f"Сповіщення №{aid} немає."

    async def check_alerts(self) -> None:
        alerts = self.list_alerts()
        if not alerts or not self.chat_id:
            return
        rates = await self._rates()
        for a in alerts:
            d = rates.get(a["currency"].lower(), {})
            if a["op"] == "<" and d.get("monoSell") and d["monoSell"] <= a["value"]:
                text = (f"🔔 <b>{FLAGS[a['currency']]} {a['currency']} подешевшав!</b>\n"
                        f"Купівля в Mono: <b>{fmt(d['monoSell'])}</b> (ваша ціль ≤ {fmt(a['value'])})")
            elif a["op"] == ">" and d.get("monoBuy") and d["monoBuy"] >= a["value"]:
                text = (f"🔔 <b>{FLAGS[a['currency']]} {a['currency']} подорожчав!</b>\n"
                        f"Продаж у Mono: <b>{fmt(d['monoBuy'])}</b> (ваша ціль ≥ {fmt(a['value'])})")
            else:
                continue
            await self.send(text + "\n\n<i>Сповіщення виконано й видалено.</i>")
            con = self._db()
            con.execute("DELETE FROM bot_alerts WHERE id=?", (a["id"],))
            con.commit(); con.close()

    async def _alerts_loop(self) -> None:
        while True:
            try:
                await self.check_alerts()
                url = self.tunnel.get("url")
                if url and url != self._sent_url and self.chat_id:
                    await self._send_site_message()
            except Exception:
                pass
            await asyncio.sleep(300)

    async def test_message(self) -> None:
        await self.send("👋 <b>Тестове повідомлення з сайту «Мої валюти»</b>\n\n" + await self.rates_text())
