"""
Мої валюти — бекенд  FastAPI + httpx + SQLite
"""
from __future__ import annotations

# ── ОБОВ'ЯЗКОВО ПЕРШИМ — завантажуємо .env до будь-якого os.getenv ──
from dotenv import load_dotenv
from pathlib import Path
load_dotenv(Path(__file__).parent / ".env")

import asyncio
import hashlib
import hmac
import json
import os
import platform
import re
import shutil
import socket
import sqlite3
import subprocess
import threading
import time
from collections import defaultdict, deque
from contextvars import ContextVar
from datetime import date, timedelta
from typing import Any, Optional

import httpx
from fastapi import BackgroundTasks, FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field, field_validator

# ─── конфіг ───────────────────────────────────────────────────────────────────
PORT            = int(os.getenv("PORT", 8001))
NBU_TTL         = 3600
MONO_RATES_TTL  = 5 * 60
MONO_CLIENT_TTL = 60
PRIVAT_TTL      = 5 * 60

WEB_DIR    = Path(__file__).parent.parent          # папка з index.html
DATA_DIR   = Path(__file__).parent / "data"
CACHE_FILE = DATA_DIR / "cache.json"
DB_FILE    = DATA_DIR / "app.db"
DATA_DIR.mkdir(exist_ok=True)

# ─── FastAPI ──────────────────────────────────────────────────────────────────
app = FastAPI(title="Мої валюти API", version="2.1.0")

# ─── Доступ з інших пристроїв (телефон у тій самій Wi-Fi) ─────────────────────
# З цього ж комп'ютера (localhost) — без PIN.
# З інших пристроїв — тільки з PIN-кодом APP_PIN із server/.env.
# Якщо PIN не задано: демо-режим відкритий для мережі, а справжні дані — ні.
def _pin() -> str:
    return os.getenv("APP_PIN", "").strip()

def _session_token(pin: str) -> str:
    # підпис PIN-коду: змінюєш PIN — усі старі входи стають недійсними
    return hmac.new(pin.encode(), b"moi-valyuty-session", hashlib.sha256).hexdigest()

# Тунель Cloudflare підключається до сервера з цього ж ПК (127.0.0.1), але додає
# заголовки з адресою справжнього відвідувача. Такий запит — НЕ локальний.
PROXY_HEADERS = ("cf-connecting-ip", "x-forwarded-for", "x-real-ip")

def _is_local(request: Request) -> bool:
    if any(h in request.headers for h in PROXY_HEADERS):
        return False
    host = request.client.host if request.client else ""
    return host in ("127.0.0.1", "::1", "localhost", "testclient")

def _client_ip(request: Request) -> str:
    ip = request.headers.get("cf-connecting-ip") or request.headers.get("x-forwarded-for", "").split(",")[0].strip()
    return ip or (request.client.host if request.client else "?")

def _is_https(request: Request) -> bool:
    return request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https" \
        or '"https"' in request.headers.get("cf-visitor", "")

OPEN_PATHS = {"/api/login", "/api/access", "/api/health"}

# стан тунелю Cloudflare (заповнюється, якщо запущено з TUNNEL=1)
TUNNEL: dict[str, Optional[str]] = {"url": None, "error": None}

# Демо-акаунт для гостей: QR «/?demo=1» ставить cookie mv_demo, і цей браузер бачить
# лише вигадані картки — навіть коли сервер працює зі справжнім акаунтом.
FORCED_DEMO: ContextVar[bool] = ContextVar("forced_demo", default=False)

@app.middleware("http")
async def access_guard(request: Request, call_next):
    path = request.url.path
    q = request.query_params.get("demo") if path == "/" else None
    want_demo = q == "1" or (q != "0" and request.cookies.get("mv_demo") == "1")
    ctx = FORCED_DEMO.set(want_demo)
    try:
        resp = await _guarded(request, call_next, path, want_demo)
    finally:
        FORCED_DEMO.reset(ctx)
    if q == "1":
        resp.set_cookie("mv_demo", "1", max_age=7 * 86400, httponly=True, samesite="lax",
                        secure=_is_https(request))
    elif q == "0":
        resp.delete_cookie("mv_demo")
    return resp

async def _guarded(request: Request, call_next, path: str, want_demo: bool):
    if not path.startswith("/api/") or path in OPEN_PATHS or _is_local(request) or want_demo:
        return await call_next(request)
    pin = _pin()
    if pin:
        if hmac.compare_digest(request.cookies.get("mv_session", ""), _session_token(pin)):
            return await call_next(request)
        return JSONResponse({"detail": "Потрібен PIN-код"}, status_code=401)
    if _demo():
        return await call_next(request)
    return JSONResponse({"detail": "Доступ з інших пристроїв вимкнено: задайте APP_PIN у server/.env"},
                        status_code=403)

_login_tries: dict[str, deque] = defaultdict(deque)
_all_fails: deque = deque()          # невдалі спроби з усіх адрес — захист від підбору з різних IP

class LoginIn(BaseModel):
    pin: str = Field(min_length=1, max_length=32)

@app.post("/api/login")
async def login(body: LoginIn, request: Request):
    pin = _pin()
    if not pin:
        raise HTTPException(400, "PIN-код не налаштовано")
    ip = _client_ip(request)
    tries, now = _login_tries[ip], time.time()
    while tries and tries[0] < now - 300:
        tries.popleft()
    while _all_fails and _all_fails[0] < now - 3600:
        _all_fails.popleft()
    if len(tries) >= 5:
        raise HTTPException(429, "Забагато спроб. Зачекайте 5 хвилин")
    if len(_all_fails) >= 30:
        raise HTTPException(429, "Вхід тимчасово заблоковано через підбір PIN. Спробуйте за годину")
    if not hmac.compare_digest(body.pin.strip(), pin):
        tries.append(now)
        _all_fails.append(now)
        raise HTTPException(401, "Неправильний PIN-код")
    tries.clear()
    resp = JSONResponse({"ok": True})
    resp.set_cookie("mv_session", _session_token(pin), max_age=30 * 86400,
                    httponly=True, samesite="strict", secure=_is_https(request))
    return resp

def _lan_ip() -> str:
    """IP комп'ютера в домашній мережі (пакети нікуди не відправляються)."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"

@app.get("/api/access")
async def access_info(request: Request):
    pin, local = bool(_pin()), _is_local(request)
    return {
        "local": local,
        "lanUrl": f"http://{_lan_ip()}:{PORT}",
        "internetUrl": TUNNEL["url"],
        "tunnelError": TUNNEL["error"],
        "tunnelStarting": TUNNEL.get("starting") == "1" and not TUNNEL["url"],
        "pinSet": pin,
        "networkOpen": bool(pin or _demo()),
        "demo": _demo(),
        "forcedDemo": FORCED_DEMO.get(),
        "authorized": local or FORCED_DEMO.get() or (not pin and _demo()) or (pin and hmac.compare_digest(
            request.cookies.get("mv_session", ""), _session_token(_pin()))),
    }

# ─── SQLite init ──────────────────────────────────────────────────────────────
def _db_init() -> None:
    con = sqlite3.connect(DB_FILE)
    cur = con.cursor()
    cur.executescript("""
        CREATE TABLE IF NOT EXISTS manual_cards (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            bank       TEXT    NOT NULL DEFAULT 'Приват',
            currency   TEXT    NOT NULL DEFAULT 'USD',
            last4      TEXT    NOT NULL DEFAULT '????',
            balance    REAL    NOT NULL DEFAULT 0,
            color      TEXT    NOT NULL DEFAULT 'privat',
            updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS purchases (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            card_id     TEXT    NOT NULL,
            source      TEXT    NOT NULL DEFAULT 'manual',
            type        TEXT    NOT NULL DEFAULT 'buy',
            date        TEXT    NOT NULL,
            amount      REAL    NOT NULL,
            currency    TEXT    NOT NULL,
            rate        REAL    NOT NULL,
            uah_amount  REAL    NOT NULL,
            hidden      INTEGER NOT NULL DEFAULT 0,
            note        TEXT    NOT NULL DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS sync_state (
            account_id  TEXT PRIMARY KEY,
            synced_to   INTEGER NOT NULL
        );
    """)
    # позначка «створено в демо-режимі» — демо й справжні дані не змішуються
    for table in ("manual_cards", "purchases"):
        cols = [r[1] for r in cur.execute(f"PRAGMA table_info({table})")]
        if "demo" not in cols:
            cur.execute(f"ALTER TABLE {table} ADD COLUMN demo INTEGER NOT NULL DEFAULT 0")
    cur.execute("UPDATE purchases SET demo=1 WHERE card_id LIKE 'demo_%'")
    con.commit()
    con.close()

_db_init()

# ─── Демо-режим ───────────────────────────────────────────────────────────────
# Вмикається сам, якщо токен Monobank не задано (або DEMO=1 у .env).
# Дозволяє запустити й показати застосунок без особистих даних:
# вигадані картки й покупки, справжні курси.
def _demo() -> bool:
    if FORCED_DEMO.get():
        return True
    return os.getenv("DEMO", "").strip() == "1" or not os.getenv("MONO_TOKEN", "").strip()

def _mode() -> int:
    """1 — демо-режим, 0 — справжні дані. Записується в кожну картку й покупку."""
    return 1 if _demo() else 0

DEMO_CARDS = [
    {"id": "demo_usd", "currency": "USD", "balance": 1250.00, "type": "black",
     "maskedPan": "•••• 0001", "hasCard": True},
    {"id": "demo_eur", "currency": "EUR", "balance": 680.00, "type": "iron",
     "maskedPan": "•••• 0002", "hasCard": True},
]
# (днів тому, картка, сума, курс)
DEMO_PURCHASES = [
    (75, "demo_usd", 500, 41.20), (40, "demo_usd", 400, 41.90), (12, "demo_usd", 350, 44.10),
    (60, "demo_eur", 300, 48.30), (20, "demo_eur", 380, 50.90),
]

def _seed_demo() -> None:
    con = sqlite3.connect(DB_FILE)
    has = con.execute("SELECT COUNT(*) FROM purchases WHERE card_id LIKE 'demo_%'").fetchone()[0]
    if not has:
        for days, card, amount, rate in DEMO_PURCHASES:
            ccy = "USD" if card == "demo_usd" else "EUR"
            d = (date.today() - timedelta(days=days)).isoformat()
            con.execute("INSERT INTO purchases(card_id,source,type,date,amount,currency,rate,uah_amount,note,demo)"
                        " VALUES(?,?,?,?,?,?,?,?,?,1)",
                        (card, "mono", "buy", d, amount, ccy, rate, round(amount * rate, 2), "демо"))
        con.commit()
    con.close()

_seed_demo()          # демо-покупки є завжди: для демо-режиму і для гостьового демо-акаунта

def _db_run(fn):
    """Виконати синхронну db-функцію в executor щоб не блокувати loop."""
    import contextvars
    ctx = contextvars.copy_context()          # потік бачить режим запиту (демо-акаунт гостя)
    loop = asyncio.get_event_loop()
    return loop.run_in_executor(None, ctx.run, fn)

# ─── Кеш у пам'яті + диск ────────────────────────────────────────────────────
_cache: dict[str, Any] = {}

# На диск потрапляють ЛИШЕ публічні курси валют. Виписка Monobank, дані клієнта
# й погода (координати) живуть тільки в пам'яті і зникають після зупинки сервера.
PUBLIC_CACHE_PREFIXES = ("nbu_", "mono_rates", "privat_rates", "hist_")

def _is_public(key: str) -> bool:
    return key.startswith(PUBLIC_CACHE_PREFIXES)

def _load_disk_cache() -> None:
    if not CACHE_FILE.exists():
        return
    try:
        data = json.loads(CACHE_FILE.read_text("utf-8"))
    except Exception:
        return
    _cache.update({k: v for k, v in data.items() if _is_public(k)})
    if any(not _is_public(k) for k in data):
        _save_disk_cache()          # стара версія зберігала виписку — перезаписуємо файл без неї

def _save_disk_cache() -> None:
    safe = {k: v for k, v in _cache.items() if _is_public(k)}
    try:
        CACHE_FILE.write_text(json.dumps(safe, ensure_ascii=False, indent=2), "utf-8")
    except Exception:
        pass

def _latest_cached(prefix: str):
    """Найсвіжіший збережений запис із таким префіксом — коли немає інтернету."""
    keys = sorted(k for k in _cache if k.startswith(prefix))
    return _cache[keys[-1]] if keys else None

_load_disk_cache()

# ─── утиліти дат ──────────────────────────────────────────────────────────────
def _today()     -> str: return date.today().strftime("%Y%m%d")
def _yesterday() -> str: return (date.today() - timedelta(days=1)).strftime("%Y%m%d")
def _ago(n: int) -> str: return (date.today() - timedelta(days=n)).strftime("%Y%m%d")

async def _get(client: httpx.AsyncClient, url: str,
               headers: dict | None = None, timeout: float = 12.0) -> Any:
    r = await client.get(url, headers=headers or {}, timeout=timeout)
    r.raise_for_status()
    return r.json()

# ─── НБУ ─────────────────────────────────────────────────────────────────────
async def _fetch_nbu(client: httpx.AsyncClient) -> dict:
    CCY = {"USD", "EUR"}
    ck  = f"nbu_{_today()}"
    cached = _cache.get(ck)

    if cached and cached.get("ts", 0) > time.time() - NBU_TTL:
        result, status = cached["data"], "cache"
    else:
        try:
            raw = await _get(client, "https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?json")
            result = {item["cc"]: {"rate": item["rate"], "name": item["txt"], "date": item["exchangedate"]}
                      for item in raw if item["cc"] in CCY}
            _cache[ck] = {"ts": time.time(), "data": result}
            _save_disk_cache()
            status = "ok"
        except Exception:
            cached = cached or _latest_cached("nbu_2")   # учорашній чи давніший курс, якщо сьогоднішнього ще немає
            result = cached["data"] if cached else {}
            status = "cache" if cached else "error"

    # вчорашній курс
    yck = f"nbu_yest_{_yesterday()}"
    yc  = _cache.get(yck)
    yest: dict[str, float] = {}
    if yc and yc.get("ts", 0) > time.time() - NBU_TTL * 48:
        yest = yc["data"]
    else:
        try:
            yr = await _get(client,
                f"https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?date={_yesterday()}&json")
            yest = {item["cc"]: item["rate"] for item in yr if item["cc"] in CCY}
            _cache[yck] = {"ts": time.time(), "data": yest}
            _save_disk_cache()
        except Exception:
            pass

    return {"data": result, "yesterday": yest, "status": status}

# ─── Mono (публічний API курсів) ──────────────────────────────────────────────
_ISO = {840: "USD", 978: "EUR"}

async def _fetch_mono_rates(client: httpx.AsyncClient) -> dict:
    ck     = "mono_rates"
    cached = _cache.get(ck)
    now    = time.time()
    if cached and cached.get("ts", 0) > now - MONO_RATES_TTL:
        return {"data": cached["data"], "status": "cache"}
    try:
        raw   = await _get(client, "https://api.monobank.ua/bank/currency")
        rates = {}
        for item in raw:
            if item.get("currencyCodeB") != 980:
                continue
            cc = _ISO.get(item.get("currencyCodeA", 0))
            if not cc:
                continue
            buy  = item.get("rateBuy")  or item.get("rateCross") or 0
            sell = item.get("rateSell") or item.get("rateCross") or 0
            rates[cc] = {"buy": float(buy), "sell": float(sell)}
        _cache[ck] = {"ts": now, "data": rates}
        _save_disk_cache()
        return {"data": rates, "status": "ok"}
    except httpx.HTTPStatusError as e:
        if cached: return {"data": cached["data"], "status": "cache"}
        return {"data": {}, "status": "error"}
    except Exception:
        if cached: return {"data": cached["data"], "status": "cache"}
        return {"data": {}, "status": "error"}

# ─── ПриватБанк ──────────────────────────────────────────────────────────────
async def _fetch_privat(client: httpx.AsyncClient) -> dict:
    ck     = "privat_rates"
    cached = _cache.get(ck)
    now    = time.time()
    if cached and cached.get("ts", 0) > now - PRIVAT_TTL:
        return {"data": cached["data"], "status": "cache"}
    try:
        raw   = await _get(client, "https://api.privatbank.ua/p24api/pubinfo?exchange&coursid=11")
        rates = {}
        for item in raw:
            cc = item.get("ccy", "")
            if cc not in ("USD", "EUR") or item.get("base_ccy") != "UAH":
                continue
            buy  = float(item.get("buy")  or 0)
            sell = float(item.get("sale") or 0)
            if buy > 0 and sell > 0:
                rates[cc] = {"buy": buy, "sell": sell}
        if not rates:
            raise ValueError("empty")
        _cache[ck] = {"ts": now, "data": rates}
        _save_disk_cache()
        return {"data": rates, "status": "ok"}
    except Exception:
        if cached: return {"data": cached["data"], "status": "cache"}
        return {"data": {}, "status": "error"}

# ─── /api/rates ───────────────────────────────────────────────────────────────
@app.get("/api/rates")
async def get_rates():
    async with httpx.AsyncClient() as client:
        nbu_r, mono_r, priv_r = await asyncio.gather(
            _fetch_nbu(client), _fetch_mono_rates(client), _fetch_privat(client)
        )
    nbu, yest = nbu_r["data"], nbu_r["yesterday"]
    mono, priv = mono_r["data"], priv_r["data"]

    def _build(cc: str) -> dict:
        n = nbu.get(cc, {}); m = mono.get(cc, {}); p = priv.get(cc, {})
        return {
            "nbu": n.get("rate"), "nbuDate": n.get("date"),
            "nbuYesterday": yest.get(cc),
            "monoBuy": m.get("buy"), "monoSell": m.get("sell"),
            "privatBuy": p.get("buy"), "privatSell": p.get("sell"),
        }

    return {
        "usd": _build("USD"), "eur": _build("EUR"),
        "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "sources": {"nbu": nbu_r["status"], "mono": mono_r["status"], "privat": priv_r["status"]},
    }

# ─── /api/rates/history ───────────────────────────────────────────────────────
@app.get("/api/rates/history")
async def get_history(
    ccy:  str = Query(..., pattern="^(USD|EUR)$"),
    days: int = Query(7, ge=1, le=366),
):
    end = _today(); start = _ago(days)
    ck  = f"hist_{ccy}_{days}_{end}"
    cached = _cache.get(ck)
    if cached and cached.get("ts", 0) > time.time() - NBU_TTL:
        return cached["data"]
    url = (f"https://bank.gov.ua/NBU_Exchange/exchange_site"
           f"?start={start}&end={end}&valcode={ccy.lower()}&sort=exchangedate&order=asc&json")
    async with httpx.AsyncClient() as client:
        try:
            raw  = await _get(client, url)
            data = [{"date": item["exchangedate"], "rate": item["rate"]} for item in raw]
            _cache[ck] = {"ts": time.time(), "data": data}
            _save_disk_cache()
            return data
        except Exception as e:
            cached = cached or _latest_cached(f"hist_{ccy}_{days}_")
            if cached: return cached["data"]
            raise HTTPException(502, detail=f"НБУ history недоступний: {e}")

# ─── Mono особисті картки ─────────────────────────────────────────────────────
def _first_name(full: str) -> str:
    parts = full.strip().split()
    return parts[1] if len(parts) >= 2 else (parts[0] if parts else "")

def _masked(raw_pans: list) -> str:
    if not raw_pans:
        return "•••• ????"
    pan = str(raw_pans[0])
    digits = "".join(c for c in pan if c.isdigit())
    last4  = digits[-4:] if len(digits) >= 4 else digits
    return f"•••• {last4}"

@app.get("/api/mono/cards")
async def get_mono_cards():
    if _demo():
        return {"connected": True, "demo": True, "ownerName": "ДЕМО", "cards": DEMO_CARDS}
    token = os.getenv("MONO_TOKEN", "").strip()
    if not token:
        return {"connected": False, "reason": "no_token"}

    ck     = "mono_client"
    cached = _cache.get(ck)
    now    = time.time()

    if cached and cached.get("ts", 0) > now - MONO_CLIENT_TTL:
        info = cached["data"]
    else:
        async with httpx.AsyncClient() as client:
            try:
                info = await _get(
                    client,
                    "https://api.monobank.ua/personal/client-info",
                    headers={"X-Token": token},
                    timeout=15.0,
                )
                # зберігаємо ТІЛЬКИ в пам'яті — НЕ на диск
                _cache[ck] = {"ts": now, "data": info}
            except httpx.HTTPStatusError as e:
                if e.response.status_code == 403:
                    return {"connected": False, "reason": "invalid_token"}
                if e.response.status_code == 429:
                    if cached:
                        info = cached["data"]
                    else:
                        return {"connected": False, "reason": "rate_limited"}
                else:
                    raise HTTPException(502, detail="Monobank недоступний")
            except Exception:
                if cached:
                    info = cached["data"]
                else:
                    raise HTTPException(502, detail="Monobank недоступний")

    owner = _first_name(info.get("name", ""))
    all_accounts = info.get("accounts", [])
    
    # логуємо кількість валютних рахунків (БЕЗ сум і особистих даних)
    ccy_counts = {}
    for acc in all_accounts:
        iso = acc.get("currencyCode", 0)
        cc  = _ISO.get(iso)
        if cc:
            ccy_counts[cc] = ccy_counts.get(cc, 0) + 1
    print(f"[mono/cards] валютних рахунків: {ccy_counts}")

    cards = []
    for acc in all_accounts:
        iso = acc.get("currencyCode", 0)
        cc  = _ISO.get(iso)
        if cc not in ("USD", "EUR"):
            continue
        raw_pans = acc.get("maskedPan") or []
        # якщо масив порожній — це рахунок без фізичної картки
        has_card = len(raw_pans) > 0
        masked   = _masked(raw_pans) if has_card else f"рахунок {cc}"
        cards.append({
            "id":        acc.get("id", ""),
            "currency":  cc,
            "balance":   round((acc.get("balance") or 0) / 100, 2),
            "type":      acc.get("type", "black"),
            "maskedPan": masked,
            "hasCard":   has_card,
            # iban, creditLimit, sendId — не включаємо
        })

    return {"connected": True, "ownerName": owner, "cards": cards}

# ─── Mono виписка (statement) — фонове завантаження обмінних операцій ─────────

# Ключові слова в description, що вказують на обмін валют
_EXCHANGE_KEYWORDS = [
    "купівля валюти", "продаж валюти", "обмін валют",
    "обмін валюти", "currency exchange", "currency purchase",
    "з гривневого рахунку", "на гривневий рахунок",
    "перерахування", "конвертація",
]

def _is_exchange(tx: dict) -> bool:
    """Визначає, чи є транзакція обміном валюти."""
    desc = (tx.get("description") or "").lower()
    # найнадійніший ознака: operationAmount у гривнях (980) відрізняється від amount у валюті
    op_amount = tx.get("operationAmount", 0)
    amount    = tx.get("amount", 0)
    # У виписці Monobank валюта операції лежить у полі "currencyCode"
    # (поля "operationCurrencyCode" не існує). Для валютного рахунку
    # currencyCode == 980 означає, що операція йшла в гривні → був обмін.
    op_ccy    = tx.get("currencyCode", 0)
    if op_ccy == 980 and op_amount != 0 and amount != 0:
        return True
    # або за ключовими словами
    return any(kw in desc for kw in _EXCHANGE_KEYWORDS)

@app.get("/api/mono/statement/{account_id}")
async def get_mono_statement(account_id: str):
    """
    Завантажує виписку за останні 90 днів (3 × 31-денні шматки).
    Повертає тільки операції-обміни: кількість і список покупок.
    НЕ повертає особисті дані, описи транзакцій, імена.
    """
    token = os.getenv("MONO_TOKEN", "").strip()
    if _demo() or not token:
        raise HTTPException(403, "Недоступно в демо-режимі")

    now_ts   = int(time.time())
    chunks   = []
    # 3 шматки по ~30 днів
    for i in range(3):
        t_to   = now_ts - i * 30 * 86400
        t_from = t_to - 30 * 86400
        chunks.append((t_from, t_to))

    purchases_found = []
    total_tx   = 0
    exchange_tx = 0

    async with httpx.AsyncClient() as client:
        for idx, (t_from, t_to) in enumerate(chunks):
            ck = f"stmt_{account_id}_{t_from}_{t_to}"
            cached_stmt = _cache.get(ck)
            if cached_stmt:
                txs = cached_stmt
            else:
                # між запитами чекаємо 60 с (ліміт Mono)
                if idx > 0:
                    await asyncio.sleep(61)
                try:
                    url = f"https://api.monobank.ua/personal/statement/{account_id}/{t_from}/{t_to}"
                    txs = await _get(client, url, headers={"X-Token": token}, timeout=20.0)
                    _cache[ck] = txs  # лише пам'ять
                except httpx.HTTPStatusError as e:
                    if e.response.status_code == 429:
                        print(f"[statement] 429 на chunk {idx}, зупиняємо")
                        break
                    print(f"[statement] HTTP {e.response.status_code} на chunk {idx}")
                    continue
                except Exception as e:
                    print(f"[statement] помилка chunk {idx}: {type(e).__name__}")
                    continue

            total_tx += len(txs)
            for tx in txs:
                if not _is_exchange(tx):
                    continue
                exchange_tx += 1
                amount    = tx.get("amount", 0)        # у мінімальних одиницях валюти
                op_amount = tx.get("operationAmount", 0)  # UAH копійки
                if amount == 0 or op_amount == 0:
                    continue
                # amount > 0 = поповнення (купівля валюти), < 0 = списання (продаж)
                tx_type   = "buy" if amount > 0 else "sell"
                amt_cc    = abs(amount) / 100
                amt_uah   = abs(op_amount) / 100
                rate      = round(amt_uah / amt_cc, 6) if amt_cc else 0
                tx_date   = date.fromtimestamp(tx.get("time", now_ts)).isoformat()
                purchases_found.append({
                    "card_id":    account_id,
                    "source":     "mono",
                    "type":       tx_type,
                    "date":       tx_date,
                    "amount":     amt_cc,
                    "currency":   "",   # буде заповнено на основі рахунку
                    "rate":       rate,
                    "uah_amount": amt_uah,
                    "note":       "",
                    "mono_id":    tx.get("id", ""),
                })

    print(f"[statement] {account_id}: всього={total_tx}, обмінів={exchange_tx}, збережено={len(purchases_found)}")

    return {
        "totalTx":    total_tx,
        "exchangeTx": exchange_tx,
        "purchases":  purchases_found,
    }

@app.post("/api/mono/statement/{account_id}/import")
async def import_mono_statement(account_id: str, currency: str = Query(...)):
    """
    Завантажує виписку і зберігає нові покупки в БД.
    Перевіряє дублікати по (card_id, date, amount, rate).
    """
    token = os.getenv("MONO_TOKEN", "").strip()
    if _demo() or not token:
        raise HTTPException(403, "Недоступно в демо-режимі")

    result = await get_mono_statement(account_id)
    purchases = result["purchases"]

    # заповнюємо currency і зберігаємо нові записи
    new_count = 0
    def _save_purchases():
        nonlocal new_count
        con = sqlite3.connect(DB_FILE)
        for p in purchases:
            p["currency"] = currency
            # перевіряємо дублікат
            existing = con.execute(
                "SELECT id FROM purchases WHERE card_id=? AND date=? AND ABS(amount-?)< 0.01 AND ABS(rate-?)<0.0001",
                (p["card_id"], p["date"], p["amount"], p["rate"])
            ).fetchone()
            if existing:
                continue
            con.execute(
                "INSERT INTO purchases(card_id,source,type,date,amount,currency,rate,uah_amount,note)"
                " VALUES(?,?,?,?,?,?,?,?,?)",
                (p["card_id"], p["source"], p["type"], p["date"],
                 p["amount"], p["currency"], p["rate"], p["uah_amount"], p["note"])
            )
            new_count += 1
        con.commit()
        con.close()

    await _db_run(_save_purchases)

    return {
        "totalTx":    result["totalTx"],
        "exchangeTx": result["exchangeTx"],
        "imported":   new_count,
    }


# ─── Глобальний стан синхронізації ───────────────────────────────────────────
_sync_status: dict = {
    "running": False,
    "step":    "",
    "account": 0,
    "accountTotal": 0,
    "chunk":   0,
    "chunkTotal": 3,
    "imported": 0,
    "totalTx": 0,
    "exchangeTx": 0,
    "error":   "",
    "done":    False,
    "lastRun": "",
}

@app.get("/api/mono/sync-status")
async def get_sync_status():
    if _demo():
        return {"running": False, "done": True, "error": "", "step": "Демо-режим"}
    return dict(_sync_status)

@app.post("/api/mono/sync")
async def start_sync(bg: BackgroundTasks):
    if _demo():
        _sync_status.update({"running": False, "done": True, "error": "",
                             "step": "Демо-режим: синхронізація з Monobank вимкнена, демо-покупки вже додано."})
        return {"ok": True, "msg": "Демо-режим"}
    if _sync_status["running"]:
        return {"ok": False, "msg": "Вже запущено"}
    bg.add_task(_run_sync_bg)
    return {"ok": True, "msg": "Синхронізацію запущено"}

SYNC_DAYS      = 31            # один запит виписки на рахунок (максимум Monobank)
CHUNK_SECONDS  = 31 * 86400    # максимум Monobank за один запит
MONO_GAP       = 61            # Monobank: 1 запит виписки на 60 с
_last_stmt_req = 0.0           # час останнього запиту виписки

def _get_synced_to(acc_id: str):
    con = sqlite3.connect(DB_FILE)
    row = con.execute("SELECT synced_to FROM sync_state WHERE account_id=?", (acc_id,)).fetchone()
    con.close()
    return row[0] if row else None

def _set_synced_to(acc_id: str, ts: int) -> None:
    con = sqlite3.connect(DB_FILE)
    con.execute("INSERT INTO sync_state(account_id, synced_to) VALUES(?,?) "
                "ON CONFLICT(account_id) DO UPDATE SET synced_to=excluded.synced_to", (acc_id, ts))
    con.commit()
    con.close()

def _plan_chunks(synced_to, now_ts: int) -> list:
    """Тільки ще не завантажені періоди, шматками до 31 дня (від старих до нових)."""
    start = now_ts - SYNC_DAYS * 86400 if synced_to is None else max(synced_to - 3600, now_ts - SYNC_DAYS * 86400)
    chunks, t = [], start
    while t < now_ts:
        chunks.append((t, min(t + CHUNK_SECONDS, now_ts)))
        t += CHUNK_SECONDS
    return chunks

async def _run_sync_bg():
    """Фонова синхронізація всіх валютних рахунків."""
    global _sync_status
    token = os.getenv("MONO_TOKEN", "").strip()
    if not token:
        _sync_status.update({"running": False, "done": True, "error": "MONO_TOKEN не задано"})
        return

    _sync_status.update({
        "running": True, "done": False, "error": "",
        "imported": 0, "totalTx": 0, "exchangeTx": 0,
        "step": "Отримуємо список рахунків…",
        "lastRun": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    })

    # 1. Отримуємо картки (рахунки)
    try:
        async with httpx.AsyncClient() as client:
            info = await _get(client,
                "https://api.monobank.ua/personal/client-info",
                headers={"X-Token": token}, timeout=15.0)
        _cache["mono_client"] = {"ts": time.time(), "data": info}
    except Exception as e:
        _sync_status.update({"running": False, "done": True, "error": f"Помилка отримання рахунків: {type(e).__name__}"})
        return

    # Беремо USD і EUR рахунки
    accounts = [
        {"id": acc.get("id"), "currency": _ISO.get(acc.get("currencyCode", 0))}
        for acc in info.get("accounts", [])
        if _ISO.get(acc.get("currencyCode", 0)) in ("USD", "EUR")
    ]
    if not accounts:
        _sync_status.update({"running": False, "done": True, "step": "Валютних рахунків не знайдено"})
        return

    _sync_status["accountTotal"] = len(accounts)
    total_imported = 0
    total_tx       = 0
    total_exch     = 0

    for acc_idx, acc in enumerate(accounts):
        acc_id  = acc["id"]
        acc_ccy = acc["currency"]
        _sync_status.update({
            "account": acc_idx + 1,
            "step":    f"Рахунок {acc_idx+1}/{len(accounts)} ({acc_ccy}): завантажую виписку…",
        })

        global _last_stmt_req
        now_ts      = int(time.time())
        synced_to   = await _db_run(lambda a=acc_id: _get_synced_to(a))
        chunks      = _plan_chunks(synced_to, now_ts)
        CHUNK_COUNT = len(chunks)
        acc_ok      = True

        for chunk_idx, (t_from, t_to) in enumerate(chunks):
            ck     = f"stmt_{acc_id}_{t_from}_{t_to}"

            _sync_status.update({
                "chunk":      chunk_idx + 1,
                "chunkTotal": CHUNK_COUNT,
                "step":       f"Рахунок {acc_idx+1}/{len(accounts)} ({acc_ccy}): період {chunk_idx+1}/{CHUNK_COUNT}…",
            })

            cached_stmt = _cache.get(ck)
            if cached_stmt is not None:
                txs = cached_stmt
                print(f"[sync] {acc_ccy} chunk {chunk_idx+1}: з кешу, {len(txs)} транзакцій")
            else:
                wait = MONO_GAP - (time.time() - _last_stmt_req)
                if wait > 0:
                    # Ліміт Monobank: 1 запит виписки на 60 с — чекаємо лише залишок
                    _sync_status["step"] = (
                        f"Рахунок {acc_idx+1}/{len(accounts)} ({acc_ccy}): "
                        f"період {chunk_idx+1}/{CHUNK_COUNT}, чекаю {int(wait)} с (ліміт Monobank)…"
                    )
                    await asyncio.sleep(wait)
                _last_stmt_req = time.time()
                try:
                    url = (f"https://api.monobank.ua/personal/statement"
                           f"/{acc_id}/{t_from}/{t_to}")
                    async with httpx.AsyncClient() as client:
                        txs = await _get(client, url,
                                         headers={"X-Token": token}, timeout=25.0)
                    _cache[ck] = txs
                    print(f"[sync] {acc_ccy} chunk {chunk_idx+1}: {len(txs)} транзакцій")
                except httpx.HTTPStatusError as e:
                    acc_ok = False
                    if e.response.status_code == 429:
                        print(f"[sync] 429 на {acc_ccy} chunk {chunk_idx+1}, зупиняю цей рахунок")
                        break
                    print(f"[sync] HTTP {e.response.status_code} на {acc_ccy} chunk {chunk_idx+1}")
                    break
                except Exception as e:
                    acc_ok = False
                    print(f"[sync] помилка {acc_ccy} chunk {chunk_idx+1}: {type(e).__name__}")
                    break

            # Обробка транзакцій
            exch_in_chunk = 0
            new_in_chunk  = 0
            for tx in txs:
                total_tx += 1
                if not _is_exchange(tx):
                    continue
                exch_in_chunk += 1
                total_exch    += 1

                amount    = tx.get("amount", 0)
                op_amount = tx.get("operationAmount", 0)
                if amount == 0:
                    continue
                tx_type  = "buy" if amount > 0 else "sell"
                amt_cc   = abs(amount) / 100
                amt_uah  = abs(op_amount) / 100 if op_amount else 0
                rate     = round(amt_uah / amt_cc, 6) if amt_cc and amt_uah else 0
                if rate == 0:
                    continue
                tx_date  = date.fromtimestamp(tx.get("time", now_ts)).isoformat()

                def _save_one(card_id=acc_id, ccy=acc_ccy, d=tx_date, a=amt_cc, r=rate, u=amt_uah, tp=tx_type):
                    con = sqlite3.connect(DB_FILE)
                    ex  = con.execute(
                        "SELECT id FROM purchases WHERE card_id=? AND date=? "
                        "AND ABS(amount-?)<0.01 AND ABS(rate-?)<0.0001",
                        (card_id, d, a, r)
                    ).fetchone()
                    if not ex:
                        con.execute(
                            "INSERT INTO purchases(card_id,source,type,date,amount,currency,rate,uah_amount,note)"
                            " VALUES(?,?,?,?,?,?,?,?,?)",
                            (card_id, "mono", tp, d, a, ccy, r, u, "")
                        )
                        con.commit()
                        con.close()
                        return 1
                    con.close()
                    return 0

                added = await _db_run(_save_one)
                new_in_chunk  += added
                total_imported += added

            print(f"[sync] {acc_ccy} chunk {chunk_idx+1}: обмінів={exch_in_chunk}, нових={new_in_chunk}")
            _sync_status.update({"totalTx": total_tx, "exchangeTx": total_exch, "imported": total_imported})
            # запам'ятовуємо, до якого моменту виписку вже завантажено
            await _db_run(lambda a=acc_id, t=t_to: _set_synced_to(a, t))

        if not chunks:
            print(f"[sync] {acc_ccy}: усе вже синхронізовано")

    _sync_status.update({
        "running":    False,
        "done":       True,
        "totalTx":    total_tx,
        "exchangeTx": total_exch,
        "imported":   total_imported,
        "step":       f"Готово. Знайдено {total_exch} обмінів, додано {total_imported} нових покупок.",
    })
    print(f"[sync] завершено: tx={total_tx}, обмінів={total_exch}, нових={total_imported}")

class ManualCardIn(BaseModel):
    bank:     str = Field("Приват", min_length=1, max_length=30)
    currency: str = Field("USD", pattern="^(USD|EUR)$")
    last4:    str = Field("????", pattern=r"^(\d{4}|\?{4})$")
    balance:  float = Field(0.0, ge=0, le=10_000_000)
    color:    str = "privat"

class ManualCardUpdate(BaseModel):
    bank:     Optional[str]   = None
    last4:    Optional[str]   = None
    balance:  Optional[float] = Field(None, ge=0, le=10_000_000)
    color:    Optional[str]   = None

def _row_to_card(row) -> dict:
    return {"id": row[0], "bank": row[1], "currency": row[2],
            "last4": row[3], "balance": row[4], "color": row[5], "updated_at": row[6]}

@app.get("/api/manual-cards")
async def list_manual_cards():
    def _q():
        con = sqlite3.connect(DB_FILE)
        rows = con.execute("SELECT id,bank,currency,last4,balance,color,updated_at FROM manual_cards"
                           " WHERE demo=? ORDER BY id", (_mode(),)).fetchall()
        con.close()
        return rows
    rows = await _db_run(_q)
    return [_row_to_card(r) for r in rows]

@app.post("/api/manual-cards", status_code=201)
async def create_manual_card(body: ManualCardIn):
    def _q():
        con = sqlite3.connect(DB_FILE)
        cur = con.execute(
            "INSERT INTO manual_cards(bank,currency,last4,balance,color,demo) VALUES(?,?,?,?,?,?)",
            (body.bank, body.currency, body.last4, body.balance, body.color, _mode())
        )
        row_id = cur.lastrowid
        row = con.execute("SELECT id,bank,currency,last4,balance,color,updated_at FROM manual_cards WHERE id=?", (row_id,)).fetchone()
        con.commit(); con.close()
        return row
    row = await _db_run(_q)
    return _row_to_card(row)

@app.put("/api/manual-cards/{card_id}")
async def update_manual_card(card_id: int, body: ManualCardUpdate):
    def _q():
        con  = sqlite3.connect(DB_FILE)
        sets = []
        vals = []
        if body.bank    is not None: sets.append("bank=?");    vals.append(body.bank)
        if body.last4   is not None: sets.append("last4=?");   vals.append(body.last4)
        if body.balance is not None: sets.append("balance=?"); vals.append(body.balance)
        if body.color   is not None: sets.append("color=?");   vals.append(body.color)
        if not sets:
            con.close(); return None
        sets.append("updated_at=datetime('now')")
        vals += [card_id, _mode()]
        con.execute(f"UPDATE manual_cards SET {','.join(sets)} WHERE id=? AND demo=?", vals)
        row = con.execute("SELECT id,bank,currency,last4,balance,color,updated_at FROM manual_cards"
                          " WHERE id=? AND demo=?", (card_id, _mode())).fetchone()
        con.commit(); con.close()
        return row
    row = await _db_run(_q)
    if row is None:
        raise HTTPException(404, "Картку не знайдено")
    return _row_to_card(row)

@app.delete("/api/manual-cards/{card_id}")
async def delete_manual_card(card_id: int):
    def _q():
        con = sqlite3.connect(DB_FILE)
        found = con.execute("DELETE FROM manual_cards WHERE id=? AND demo=?", (card_id, _mode())).rowcount
        if found:
            con.execute("DELETE FROM purchases WHERE card_id=? AND demo=?", (str(card_id), _mode()))
        con.commit(); con.close()
    await _db_run(_q)
    return {"ok": True}

# ─── Покупки ──────────────────────────────────────────────────────────────────
class PurchaseIn(BaseModel):
    # Перевірка на сервері: навіть якщо сайт пропустить помилку, в базу вона не потрапить
    card_id:    str = Field(min_length=1)
    source:     str = Field("manual", pattern="^(manual|mono)$")
    type:       str = Field("buy", pattern="^(buy|sell)$")
    date:       str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    amount:     float = Field(gt=0, le=10_000_000)
    currency:   str = Field(pattern="^(USD|EUR)$")
    rate:       Optional[float] = Field(None, gt=0, le=1000)
    uah_amount: Optional[float] = Field(None, gt=0)
    note:       str = Field("", max_length=200)

    @field_validator("date")
    @classmethod
    def _real_date(cls, v: str) -> str:
        # формат РРРР-ММ-ДД ще не означає, що така дата існує (2026-02-30)
        try:
            d = date.fromisoformat(v)
        except ValueError:
            raise ValueError("Такої дати не існує")
        if d > date.today():
            raise ValueError("Дата покупки не може бути в майбутньому")
        if d < date(2000, 1, 1):
            raise ValueError("Дата покупки занадто давня")
        return v

def _row_to_purchase(r) -> dict:
    return {"id": r[0], "card_id": r[1], "source": r[2], "type": r[3],
            "date": r[4], "amount": r[5], "currency": r[6],
            "rate": r[7], "uah_amount": r[8], "hidden": bool(r[9]), "note": r[10]}

@app.get("/api/purchases")
async def list_purchases(card_id: Optional[str] = None, show_hidden: int = 0):
    def _q():
        con   = sqlite3.connect(DB_FILE)
        where = []
        vals  = []
        if card_id:
            where.append("card_id=?"); vals.append(card_id)
        # показуємо лише дані поточного режиму (демо або справжні)
        where.append("demo=?"); vals.append(_mode())
        if not show_hidden:
            where.append("hidden=0")
        sql = "SELECT id,card_id,source,type,date,amount,currency,rate,uah_amount,hidden,note FROM purchases"
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY date DESC"
        rows = con.execute(sql, vals).fetchall()
        con.close()
        return rows
    rows = await _db_run(_q)
    return [_row_to_purchase(r) for r in rows]

@app.post("/api/purchases", status_code=201)
async def create_purchase(body: PurchaseIn):
    # розраховуємо відсутні поля
    rate       = body.rate
    uah_amount = body.uah_amount
    if rate is None and uah_amount is None:
        raise HTTPException(400, "Потрібен rate або uah_amount")
    if rate is None:
        rate = round(uah_amount / body.amount, 6) if body.amount else 0
    if uah_amount is None:
        uah_amount = round(rate * body.amount, 2)

    def _q():
        con = sqlite3.connect(DB_FILE)
        # картка має існувати в поточному режимі
        if body.card_id.isdigit():
            ok = con.execute("SELECT 1 FROM manual_cards WHERE id=? AND demo=?",
                             (int(body.card_id), _mode())).fetchone()
        else:
            ok = body.card_id.startswith("demo_") == bool(_mode())
        if not ok:
            con.close()
            return None
        cur = con.execute(
            "INSERT INTO purchases(card_id,source,type,date,amount,currency,rate,uah_amount,note,demo)"
            " VALUES(?,?,?,?,?,?,?,?,?,?)",
            (body.card_id, body.source, body.type, body.date,
             body.amount, body.currency, rate, uah_amount, body.note, _mode())
        )
        rid = cur.lastrowid
        row = con.execute(
            "SELECT id,card_id,source,type,date,amount,currency,rate,uah_amount,hidden,note FROM purchases WHERE id=?",
            (rid,)
        ).fetchone()
        con.commit(); con.close()
        return row
    row = await _db_run(_q)
    if row is None:
        raise HTTPException(404, "Картку не знайдено")
    return _row_to_purchase(row)

@app.delete("/api/purchases/{purchase_id}")
async def delete_purchase(purchase_id: int):
    def _q():
        con = sqlite3.connect(DB_FILE)
        con.execute("DELETE FROM purchases WHERE id=? AND demo=?", (purchase_id, _mode()))
        con.commit(); con.close()
    await _db_run(_q)
    return {"ok": True}

# ─── Погода (Open-Meteo, без ключа) ───────────────────────────────────────────
WEATHER_TTL = 15 * 60

@app.get("/api/weather")
async def get_weather(lat: float = Query(50.45, ge=-90, le=90),
                      lon: float = Query(30.52, ge=-180, le=180)):
    """Поточна погода для фону. Координати округлюються до 0.1° і не логуються."""
    lat_r, lon_r = round(lat, 1), round(lon, 1)
    ck  = f"weather_{lat_r}_{lon_r}"
    now = time.time()
    cached = _cache.get(ck)
    if cached and cached.get("ts", 0) > now - WEATHER_TTL:
        return {**cached["data"], "source": "cache"}

    url = ("https://api.open-meteo.com/v1/forecast"
           f"?latitude={lat_r}&longitude={lon_r}"
           "&current=weather_code,is_day,temperature_2m&timezone=auto")
    try:
        async with httpx.AsyncClient() as client:
            js = await _get(client, url, timeout=10.0)
        cur  = js.get("current", {})
        data = {
            "code":      int(cur.get("weather_code", 0)),
            "isDay":     int(cur.get("is_day", 1)),
            "temp":      round(float(cur.get("temperature_2m", 0))),
            "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        _cache[ck] = {"ts": now, "data": data}
        return {**data, "source": "ok"}
    except Exception:
        if cached:
            return {**cached["data"], "source": "cache"}
        return {"code": 0, "isDay": 1, "temp": None, "updatedAt": None, "source": "error"}

# ─── health ───────────────────────────────────────────────────────────────────
@app.get("/api/health")
async def health():
    token_set = bool(os.getenv("MONO_TOKEN", "").strip())
    return {
        "status": "ok",
        "time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "mono_token_set": token_set,  # bool — не сам токен
    }


# ─── Telegram-бот ─────────────────────────────────────────────────────────────
from bot import Bot
BOT = Bot(DB_FILE, PORT, TUNNEL)

async def _start_bot():
    if BOT.token:
        asyncio.create_task(BOT.run())
app.router.on_startup.append(_start_bot)

def _owner(request: Request) -> bool:
    """Керувати ботом може лише власник: з цього ПК або після входу за PIN.
    (У демо без PIN сайт відкритий усім, але код підключення бота — ні.)"""
    pin = _pin()
    return _is_local(request) or bool(pin and hmac.compare_digest(
        request.cookies.get("mv_session", ""), _session_token(pin)))

@app.get("/api/bot")
async def bot_status(request: Request):
    st = BOT.status()
    if not _owner(request):
        st.update(code=None, link=None, chatName=None)
    st["owner"] = _owner(request)
    return st

@app.post("/api/bot/test")
async def bot_test(request: Request):
    if not _owner(request):
        raise HTTPException(403, "Лише з цього комп'ютера або після входу за PIN")
    if not BOT.chat_id:
        raise HTTPException(400, "Бот ще не підключено")
    try:
        await BOT.test_message()
    except Exception as e:
        raise HTTPException(502, f"Telegram не відповідає: {e}")
    return {"ok": True}

@app.post("/api/bot/unlink")
async def bot_unlink(request: Request):
    if not _owner(request):
        raise HTTPException(403, "Лише з цього комп'ютера або після входу за PIN")
    BOT.unlink()
    return {"ok": True}


# ─── Сайт ─────────────────────────────────────────────────────────────────────
# Віддаємо тільки файли інтерфейсу. Папка server/ (.env з токеном, база) недоступна.
WEB_FILES = {"index.html", "styles.css", "app.js", "features.js", "weather.js", "qrcode.min.js"}

@app.get("/", include_in_schema=False)
async def index_page():
    return FileResponse(WEB_DIR / "index.html", headers={"Cache-Control": "no-cache"})

@app.get("/{name}", include_in_schema=False)
async def web_file(name: str):
    if name not in WEB_FILES:
        raise HTTPException(404)
    return FileResponse(WEB_DIR / name, headers={"Cache-Control": "no-cache"})


# ─── Тунель Cloudflare: доступ з інтернету (TUNNEL=1) ─────────────────────────
# Безкоштовний «quick tunnel»: адреса https://….trycloudflare.com, нова при кожному запуску.
# Сервер лишається на цьому ПК, дані нікуди не копіюються.
BIN_DIR = Path(__file__).parent / "bin"
CLOUDFLARED_URLS = {
    ("Windows", "AMD64"): "cloudflared-windows-amd64.exe",
    ("Windows", "x86"):   "cloudflared-windows-386.exe",
    ("Linux", "x86_64"):  "cloudflared-linux-amd64",
    ("Linux", "aarch64"): "cloudflared-linux-arm64",
    ("Darwin", "x86_64"): "cloudflared-darwin-amd64.tgz",
    ("Darwin", "arm64"):  "cloudflared-darwin-arm64.tgz",
}

def _cloudflared_path() -> Optional[Path]:
    found = shutil.which("cloudflared")
    if found:
        return Path(found)
    exe = BIN_DIR / ("cloudflared.exe" if platform.system() == "Windows" else "cloudflared")
    if exe.exists():
        return exe
    name = CLOUDFLARED_URLS.get((platform.system(), platform.machine()))
    if not name or name.endswith(".tgz"):
        return None                       # macOS: brew install cloudflared
    print("  Завантажую cloudflared (один раз, ~30 МБ)…")
    url = f"https://github.com/cloudflare/cloudflared/releases/latest/download/{name}"
    BIN_DIR.mkdir(exist_ok=True)
    with httpx.stream("GET", url, follow_redirects=True, timeout=120) as r:
        r.raise_for_status()
        with open(exe, "wb") as f:
            for chunk in r.iter_bytes():
                f.write(chunk)
    exe.chmod(0o755)
    return exe

def _start_tunnel() -> None:
    try:
        exe = _cloudflared_path()
    except Exception as e:
        TUNNEL["error"] = f"не вдалося завантажити cloudflared: {e}"
        print(f"  ⚠ Тунель: {TUNNEL['error']}")
        return
    if not exe:
        TUNNEL["error"] = "cloudflared не знайдено (macOS: brew install cloudflared)"
        print(f"  ⚠ Тунель: {TUNNEL['error']}")
        return
    proc = subprocess.Popen([str(exe), "tunnel", "--no-autoupdate", "--url", f"http://localhost:{PORT}"],
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                            encoding="utf-8", errors="replace")
    import atexit
    atexit.register(proc.terminate)

    def _read():
        for line in proc.stdout:
            m = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", line)
            if m and not TUNNEL["url"]:
                TUNNEL["url"] = m.group(0)
                print(f"\n  🌍 З телефона будь-де: {TUNNEL['url']}")
                print("     (QR-код — у Налаштуваннях → 📱 Відкрити на телефоні; адреса нова при кожному запуску)\n")
        if not TUNNEL["url"]:
            TUNNEL["error"] = "тунель не запустився (перевірте інтернет)"
            print(f"  ⚠ Тунель: {TUNNEL['error']}")
    threading.Thread(target=_read, daemon=True).start()

def _tunnel_allowed() -> bool:
    """В інтернет — лише демо або справжні дані з надійним PIN."""
    pin = _pin()
    if pin and len(pin) >= 6:
        return True
    if not pin:
        return True                      # без PIN з інтернету видно лише демо-акаунт
    if pin:
        print("  ⛔ Для доступу з інтернету PIN має бути щонайменше 6 символів (зараз коротший).")
    else:
        print("  ⛔ Тунель не запущено: зі справжніми даними потрібен APP_PIN у server/.env (мін. 6 символів).")
    return False


# ─── Запуск однією командою: python server/main.py ───────────────────────────
if __name__ == "__main__":
    import uvicorn
    lan = f"http://{_lan_ip()}:{PORT}"
    print("\n  Мої валюти запущено")
    print(f"  На цьому комп'ютері:   http://localhost:{PORT}")
    if _pin():
        print(f"  Вдома по Wi-Fi:        {lan}   — вхід за PIN-кодом")
    elif _demo():
        print(f"  Вдома по Wi-Fi:        {lan}   — демо-режим")
    else:
        print(f"  Вдома по Wi-Fi:        {lan}/?demo=1   — лише демо-акаунт")
        print("  Справжні дані з телефона: додайте APP_PIN у server/.env")
    if os.getenv("TUNNEL", "").strip() == "1" and _tunnel_allowed():
        print("  Запускаю тунель Cloudflare…")
        TUNNEL["starting"] = "1"
        _start_tunnel()
    print("  Зупинити: Ctrl+C\n")
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="warning")
