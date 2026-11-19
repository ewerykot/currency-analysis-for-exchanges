'use strict';

/* ══════════════════════════════════════
   КОНСТАНТИ
══════════════════════════════════════ */
const CURRENCIES = ['USD', 'EUR'];
const API_BASE   = '';   // сайт і API віддає один сервер (python server/main.py)

const CURRENCY_INFO = {
  USD: { name: 'Долар США', flag: 'us' },
  EUR: { name: 'Євро',      flag: 'eu' },
  UAH: { name: 'Гривня',    flag: 'ua' },
};
const FLAG_SVG = {
  us: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 30"><rect width="60" height="30" fill="#B22234"/><rect y="2.3" width="60" height="2.3" fill="#fff"/><rect y="6.9" width="60" height="2.3" fill="#fff"/><rect y="11.5" width="60" height="2.3" fill="#fff"/><rect y="16.2" width="60" height="2.3" fill="#fff"/><rect y="20.8" width="60" height="2.3" fill="#fff"/><rect y="25.4" width="60" height="2.3" fill="#fff"/><rect width="24" height="16" fill="#3C3B6E"/></svg>`,
  eu: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 40"><rect width="60" height="40" fill="#003399"/><text x="30" y="23" text-anchor="middle" font-size="20" fill="#FFCC00">★★★★★</text></svg>`,
  ua: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 40"><rect width="60" height="20" fill="#005BBB"/><rect y="20" width="60" height="20" fill="#FFD500"/></svg>`,
  privat: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 40"><rect width="60" height="40" fill="#1a7f3f"/></svg>`,
};

function flagEl(cc, cls) {
  const f   = (CURRENCY_INFO[cc] || {}).flag || 'ua';
  const svg = FLAG_SVG[f] || '';
  return `<div class="${cls || 'cc-flag'}">${svg}</div>`;
}

/* ══════════════════════════════════════
   СТАН
══════════════════════════════════════ */
let APP = {
  settings:     { refreshInterval: '5' },
  rates:        null,
  historyCache: {},
  currentSection: 'cards',
  refreshTimer:   null,
  chartPeriodDays: 7,
  chartCC: 'USD',
};

/* ── localStorage ── */
function lsGet(k, def) {
  try { const v = localStorage.getItem(k); return v !== null ? JSON.parse(v) : def; } catch { return def; }
}
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }

function loadState() {
  ['xch_settings','xch_balances','xch_operations','xch_journal',
   'xch_notifications','xch_rates','xch_rateHistory','xch_lastUpdate','xch_mono_cache']
    .forEach(k => localStorage.removeItem(k));
  APP.settings     = lsGet('mv_settings',  { refreshInterval: '5' });
  APP.rates        = lsGet('mv_rates',      null);
  APP.historyCache = lsGet('mv_histCache',  {});
}
function saveRates()    { lsSet('mv_rates',    APP.rates); }
function saveHistory()  { lsSet('mv_histCache', APP.historyCache); }
function saveSettings() { lsSet('mv_settings', APP.settings); }

/* ══════════════════════════════════════
   УТИЛІТИ
══════════════════════════════════════ */
function fmt(n, dec = 2) {
  if (n == null || isNaN(n)) return '—';
  return Number(n).toLocaleString('uk-UA', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}
function fmtTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function shortDate(s) {
  if (!s) return '';
  if (s.includes('.')) { const [d,m] = s.split('.'); return `${d}.${m}`; }
  const [,m,d] = s.split('-'); return `${d}.${m}`;
}
function todayISO() { return new Date().toISOString().slice(0,10); }

function showToast(msg, type = 'info') {
  const icons = { success:'✓', error:'✕', warning:'⚠', info:'ℹ' };
  const c = document.getElementById('toast-container');
  if (!c) return;
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.innerHTML = `<span class="toast-icon">${icons[type]}</span><span>${msg}</span>`;
  c.appendChild(t);
  setTimeout(() => { t.style.animation='toast-out 0.3s ease forwards'; setTimeout(()=>t.remove(),300); }, 3500);
}

/* ══════════════════════════════════════
   API
══════════════════════════════════════ */
/* ─── вхід за PIN-кодом (коли сайт відкрито з телефона) ─── */
let _pinShown = false;
function showPinModal() {
  if (_pinShown) return;
  _pinShown = true;
  openModal('modal-pin');
  setTimeout(() => document.getElementById('pin-input')?.focus(), 50);
}
async function submitPin() {
  const pin = document.getElementById('pin-input').value.trim();
  if (!pin) { showToast('Введіть PIN-код', 'error'); return; }
  try {
    await apiFetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                   body: JSON.stringify({ pin }) });
    location.reload();
  } catch (e) { showToast('⚠ ' + e.message, 'error'); document.getElementById('pin-input').select(); }
}

/* ─── «Відкрити на телефоні»: інтернет-адреса тунелю або адреса в домашній Wi-Fi + QR ─── */
async function renderPhoneAccess() {
  const box = document.getElementById('phone-access');
  if (!box) return;
  let a;
  try { a = await apiFetch('/api/access'); } catch { box.innerHTML = '<p class="form-hint">Сервер недоступний</p>'; return; }
  if (a.forcedDemo) {
    box.innerHTML = `<p class="form-hint">Ви в демо-акаунті 🧪 — тут лише вигадані картки.</p>
      <a class="btn btn-secondary" href="/?demo=0">Вийти з демо</a>`;
    return;
  }
  if (!a.local) { box.innerHTML = '<p class="form-hint">Ви вже зайшли з іншого пристрою ✓</p>'; return; }
  const internet = a.internetUrl;
  const base = internet || a.lanUrl;
  // QR на демо-акаунт: гість бачить лише вигадані картки, навіть коли тут справжній акаунт
  const demoBlock = a.demo ? '' : `
    <div class="phone-demo">
      <p class="phone-demo-title">🧪 Демо-акаунт на телефоні</p>
      <p class="form-hint">Без PIN, з вигаданими картками — щоб показати застосунок іншим. Ваші справжні дані там не видно.</p>
      <div class="phone-qr" id="phone-qr-demo"></div>
      <p class="phone-url font-mono">${escapeHtml(base + '/?demo=1')}</p>
    </div>`;
  const drawDemoQr = () => { if (!a.demo) try { new QRCode(document.getElementById('phone-qr-demo'), { text: base + '/?demo=1', width: 148, height: 148 }); } catch {} };
  if (!a.networkOpen) {
    box.innerHTML = `<p class="form-hint">Щоб відкривати <b>свій</b> акаунт з телефона, додайте у файл <code>server/.env</code> рядок
      <code>APP_PIN=свій_код</code> (для інтернету — мінімум 6 символів) і перезапустіть сервер.
      Без PIN ваші баланси побачив би будь-хто.</p>
      ${a.tunnelError ? `<p class="form-hint" style="color:var(--danger,#e5484d)">⚠ Тунель: ${escapeHtml(a.tunnelError)}</p>` : ''}` + demoBlock;
    drawDemoQr();
    if (!internet && !a.tunnelError && a.tunnelStarting) setTimeout(renderPhoneAccess, 3000);
    return;
  }
  const url = internet || a.lanUrl;
  box.innerHTML = `
    <p class="form-hint">${internet
      ? '🌍 Працює з будь-якого місця — мобільний інтернет теж. Адреса нова при кожному запуску.'
      : 'Телефон має бути в тій самій Wi-Fi мережі. Для доступу будь-звідки запустіть <code>start-internet.bat</code>.'}</p>
    <div class="phone-qr" id="phone-qr"></div>
    <p class="phone-url font-mono">${escapeHtml(url)}</p>
    ${internet ? `<p class="form-hint">Вдома по Wi-Fi: <span class="font-mono">${escapeHtml(a.lanUrl)}</span></p>` : ''}
    ${a.tunnelError ? `<p class="form-hint" style="color:var(--danger,#e5484d)">⚠ Тунель: ${escapeHtml(a.tunnelError)}</p>` : ''}
    <p class="form-hint">${a.pinSet ? 'На телефоні попросить PIN-код із server/.env.' : 'Демо-режим: PIN не потрібен.'}</p>` + demoBlock;
  try { new QRCode(document.getElementById('phone-qr'), { text: url, width: 148, height: 148 }); } catch {}
  drawDemoQr();
  // тунель стартує кілька секунд — оновимо картку, коли з'явиться адреса
  if (!internet && !a.tunnelError && a.tunnelStarting) setTimeout(renderPhoneAccess, 3000);
}

// ─── Telegram-бот ───────────────────────────────────────────────────────────
let botPoll = null, shownBotCode = null;
async function renderBotCard() {
  const box = document.getElementById('bot-card');
  if (!box) return;
  clearTimeout(botPoll);
  let b;
  try { b = await apiFetch('/api/bot'); } catch { box.innerHTML = '<p class="form-hint">Сервер недоступний</p>'; return; }
  if (!b.configured) {
    box.innerHTML = `<p class="form-hint">Бот надсилає курси, баланс і сповіщення прямо в Telegram — навіть коли сайт закритий.</p>
      <ol class="bot-steps">
        <li>У Telegram відкрийте <b>@BotFather</b> → <code>/newbot</code> → придумайте назву.</li>
        <li>Скопіюйте токен і додайте у <code>server/.env</code>: <code>TG_BOT_TOKEN=токен</code></li>
        <li>Перезапустіть сервер — тут з'явиться QR-код для підключення.</li>
      </ol>`;
    return;
  }
  if (b.error) {
    box.innerHTML = `<p class="form-hint" style="color:var(--danger,#e5484d)">⚠ ${escapeHtml(b.error)}</p>`;
    return;
  }
  if (!b.running) {
    box.innerHTML = '<p class="form-hint">Бот запускається…</p>';
    botPoll = setTimeout(renderBotCard, 2000);
    return;
  }
  const name = `<a href="https://t.me/${escapeHtml(b.username)}" target="_blank" rel="noopener">@${escapeHtml(b.username)}</a>`;
  if (b.linked) {
    box.innerHTML = `
      <p class="bot-ok">✓ Підключено ${b.chatName ? '— ' + escapeHtml(b.chatName) : ''}</p>
      <p class="form-hint">Бот ${name}. Активних сповіщень: ${b.alerts}.
        Спробуйте в боті: «💱 Курси», «💳 Мої картки», «🤔 Купувати?» або <code>/alert usd 41.5</code>.</p>
      ${b.owner ? `<div class="bot-actions">
        <button class="btn btn-primary" onclick="botTest(this)">📨 Надіслати тестове повідомлення</button>
        <button class="btn btn-secondary" onclick="botUnlink()">Відв'язати</button>
      </div>` : ''}`;
    return;
  }
  if (!b.owner) {
    box.innerHTML = `<p class="form-hint">Бот ${name} ще не підключено. Підключити можна з комп'ютера, де запущено сервер.</p>`;
    return;
  }
  box.innerHTML = `
    <p class="form-hint">Відскануйте QR-код телефоном або відкрийте бот ${name} і надішліть код:</p>
    <div class="phone-qr" id="bot-qr"></div>
    <p class="bot-code font-mono">${escapeHtml(b.code)}</p>
    <p class="form-hint">Після підключення бот відповідатиме лише вам.</p>`;
  shownBotCode = b.code;
  try { new QRCode(document.getElementById('bot-qr'), { text: b.link, width: 148, height: 148 }); } catch {}
  waitBotLink();
}

// поки на екрані QR — раз на 3 с перевіряємо, чи підключився телефон
function waitBotLink() {
  botPoll = setTimeout(async () => {
    if (APP.currentSection !== 'settings') return;
    try { const b = await apiFetch('/api/bot'); if (b.linked) { showToast('🤖 Telegram підключено!'); return renderBotCard(); }
          if (b.code !== shownBotCode) return renderBotCard(); } catch {}
    waitBotLink();
  }, 3000);
}

async function botTest(btn) {
  btn.disabled = true;
  try { await apiFetch('/api/bot/test', { method: 'POST' }, 30000); showToast('📨 Надіслано — подивіться в Telegram'); }
  catch (e) { showToast('⚠ ' + e.message); }
  btn.disabled = false;
}

async function botUnlink() {
  if (!confirm('Відв\'язати Telegram? Бот перестане надсилати повідомлення.')) return;
  try { await apiFetch('/api/bot/unlink', { method: 'POST' }); } catch (e) { showToast('⚠ ' + e.message); }
  renderBotCard();
}

// зрозумілий текст помилки від сервера: «Такої дати не існує» замість «HTTP 422»
function serverMessage(txt) {
  try {
    const d = JSON.parse(txt).detail;
    if (typeof d === 'string') return d;
    if (Array.isArray(d) && d[0]?.msg) return d[0].msg.replace(/^Value error, /, '');
  } catch {}
  return '';
}

async function apiFetch(path, opts = {}, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(API_BASE + path, { signal: ctrl.signal, ...opts });
    clearTimeout(tid);
    if (r.status === 401 && path !== '/api/login') showPinModal();
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw Object.assign(new Error(serverMessage(txt) || `HTTP ${r.status}`), { status: r.status, body: txt });
    }
    return await r.json();
  } catch(e) { clearTimeout(tid); throw e; }
}

async function fetchRates() {
  const data = await apiFetch('/api/rates');
  APP.rates = data; saveRates(); return data;
}
async function fetchHistory(cc, days) {
  const key    = `${cc}_${days}`;
  const cached = APP.historyCache[key];
  if (cached && cached.ts && Date.now() - cached.ts < 3_600_000) return cached.data;
  const data = await apiFetch(`/api/rates/history?ccy=${cc}&days=${days}`, {}, 20000);
  APP.historyCache[key] = { ts: Date.now(), data }; saveHistory(); return data;
}

/* ══════════════════════════════════════
   ОНОВЛЕННЯ КУРСІВ
══════════════════════════════════════ */
async function refreshRates(silent = false) {
  const btn = document.getElementById('refresh-btn');
  if (btn) btn.classList.add('spinning');
  try {
    await fetchRates();
    updateStatusBar();
    if (window.checkRateAlerts) checkRateAlerts();
    if (!silent) showToast('✓ Курси оновлено', 'success');
    renderCurrentSection();
  } catch(e) {
    console.error('refreshRates:', e);
    updateStatusBar();
    if (!silent) showToast('⚠ Не вдалося оновити курси', 'error');
    if (APP.rates) renderCurrentSection();
  } finally {
    if (btn) btn.classList.remove('spinning');
  }
}

async function refreshAll(silent = false) {
  await refreshRates(silent);
  if (APP.currentSection === 'cards') renderCards();
}

function updateStatusBar() {
  const sources = APP.rates?.sources || {};
  ['nbu','mono','privat'].forEach(src => {
    const el = document.getElementById('status-' + src);
    if (!el) return;
    const s = sources[src] || (APP.rates ? 'error' : 'pending');
    el.className = 'status-dot' + (s==='ok' ? ' ok' : s==='cache' ? ' cache' : s==='error' ? ' error' : '');
    el.title = `${src.toUpperCase()}: ${({ok:'✓ ок',cache:'з кешу',error:'⚠ недоступний',pending:'очікування'})[s]||s}`;
  });
  const timeEl = document.getElementById('status-time');
  if (timeEl && APP.rates?.updatedAt) timeEl.textContent = `Оновлено ${fmtTime(APP.rates.updatedAt)}`;
}

function startAutoRefresh() {
  if (APP.refreshTimer) clearInterval(APP.refreshTimer);
  const ms = Math.max(parseInt(APP.settings.refreshInterval)||5, 5) * 60_000;
  APP.refreshTimer = setInterval(() => refreshRates(true), ms);
}

/* ══════════════════════════════════════
   НАВІГАЦІЯ
══════════════════════════════════════ */
const SECTION_TITLES = { cards:'Мої картки', rates:'Курси валют', history:'Історія покупок', settings:'Налаштування' };

function navigateTo(section) {
  APP.currentSection = section;
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  const sec = document.getElementById('section-' + section);
  if (sec) sec.classList.add('active');
  document.querySelectorAll('[data-section]').forEach(el =>
    el.classList.toggle('active', el.dataset.section === section));
  const t = document.getElementById('page-title');
  if (t) t.textContent = SECTION_TITLES[section] || '';
  if (window.innerWidth <= 640) closeSidebar();
  renderCurrentSection();
}

function renderCurrentSection() {
  if (APP.currentSection === 'cards')    renderCards();
  if (APP.currentSection === 'rates')    renderRates();
  if (APP.currentSection === 'settings') { renderSettings(); renderPhoneAccess(); renderBotCard(); }
  if (APP.currentSection === 'history' && window.renderHistory) renderHistory();
}

function toggleSidebar() {
  const sb = document.getElementById('sidebar');
  if (sb.classList.contains('open')) { closeSidebar(); return; }
  sb.classList.add('open');
  let ov = document.getElementById('sidebar-ov');
  if (!ov) { ov=document.createElement('div'); ov.id='sidebar-ov'; ov.className='sidebar-overlay show'; ov.onclick=closeSidebar; document.body.appendChild(ov); }
  else ov.classList.add('show');
}
function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  const ov = document.getElementById('sidebar-ov'); if(ov) ov.classList.remove('show');
}

function toggleTheme() {
  const html   = document.documentElement;
  const isDark = html.getAttribute('data-theme') === 'dark';
  html.setAttribute('data-theme', isDark ? 'light' : 'dark');
  document.getElementById('theme-btn').textContent = isDark ? '🌙' : '☀️';
  lsSet('mv_theme', isDark ? 'light' : 'dark');
  updateThemeLabel();
  if (APP.currentSection === 'rates') updateRateChart();
}
function loadTheme() {
  const t = lsGet('mv_theme','dark');
  document.documentElement.setAttribute('data-theme', t);
  const btn = document.getElementById('theme-btn');
  if (btn) btn.textContent = t==='dark' ? '🌙' : '☀️';
  updateThemeLabel();
}
function updateThemeLabel() {
  const el = document.getElementById('theme-current-label'); if (!el) return;
  el.textContent = document.documentElement.getAttribute('data-theme')==='dark' ? 'Зараз: темна' : 'Зараз: світла';
}

/* ══════════════════════════════════════
   МОДАЛКИ
══════════════════════════════════════ */
function openModal(id) {
  document.getElementById('modal-overlay').classList.remove('hidden');
  document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
  document.getElementById(id).classList.remove('hidden');
}
function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
  const anyVisible = [...document.querySelectorAll('.modal')].some(m => !m.classList.contains('hidden'));
  if (!anyVisible) document.getElementById('modal-overlay').classList.add('hidden');
}
function closeModalOnBg(e) {
  if (!document.getElementById('modal-pin').classList.contains('hidden')) return;  // без PIN далі не пускаємо
  if (e.target.id === 'modal-overlay') {
    document.getElementById('modal-overlay').classList.add('hidden');
    document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
  }
}

/* ══════════════════════════════════════
   РОЗДІЛ: МОЇ КАРТКИ
══════════════════════════════════════ */
const CCY_SYMBOL = { USD:'$', EUR:'€', UAH:'₴' };

const CARD_GRADIENTS = {
  black:    'linear-gradient(135deg,#1a1a1a 0%,#2d2d2d 50%,#111 100%)',
  white:    'linear-gradient(135deg,#e0e0e0 0%,#f5f5f5 50%,#d0d0d0 100%)',
  iron:     'linear-gradient(135deg,#2c3038 0%,#3d4450 50%,#22262e 100%)',
  platinum: 'linear-gradient(135deg,#8e9eab 0%,#bdc3c7 50%,#7f8c8d 100%)',
  yellow:   'linear-gradient(135deg,#2c2200 0%,#4a3800 50%,#1a1500 100%)',
  privat:   'linear-gradient(135deg,#0f7b3f 0%,#1fa855 50%,#0a5c2e 100%)',
};
const IS_LIGHT_CARD = { white: true, platinum: true };

function getCardGrad(type) { return CARD_GRADIENTS[type] || CARD_GRADIENTS.black; }

function getRateForCard(cc, side) {
  // side = 'buy' (клієнт купує у банку) або 'sell' (клієнт продає банку)
  if (!APP.rates) return null;
  const d = cc === 'USD' ? APP.rates.usd : APP.rates.eur;
  return side === 'buy'  ? (d?.monoSell  || d?.nbu || null)
       : side === 'sell' ? (d?.monoBuy   || d?.nbu || null)
       : (d?.nbu || null);
}
function getPrivatRateForCard(cc, side) {
  if (!APP.rates) return null;
  const d = cc === 'USD' ? APP.rates.usd : APP.rates.eur;
  return side === 'buy'  ? (d?.privatSell || d?.monoSell || d?.nbu || null)
       : side === 'sell' ? (d?.privatBuy  || d?.monoBuy  || d?.nbu || null)
       : (d?.nbu || null);
}

function fmtBal(amount, ccy, hidden) {
  if (hidden) return `${CCY_SYMBOL[ccy]||''}••••••`;
  return `${CCY_SYMBOL[ccy]||''}${fmt(amount, 2)}`;
}

function uahEq(amount, ccy, rate) {
  if (!rate) {
    const d = ccy==='USD' ? APP.rates?.usd : APP.rates?.eur;
    rate = d?.monoBuy || d?.nbu;
  }
  return rate ? amount * rate : null;
}

/* ─── обчислення прибутку ───────────────────────────────── */
/* Середній курс методом середньої вартості.
   Покупка: додаємо валюту й гривні, середній курс перераховується.
   Продаж: зменшуємо залишок за СЕРЕДНІМ курсом — середній курс від продажу не змінюється.
   Приклад: купили 100 $ по 40, продали 50 $ по 45 → лишилось 50 $, середній курс 40 (а не 35). */
function averageCost(purchases) {
  const sorted = [...purchases].sort((a, b) =>
    a.date === b.date ? (a.id || 0) - (b.id || 0) : (a.date < b.date ? -1 : 1));
  let amount = 0, cost = 0;
  for (const p of sorted) {
    if (p.type === 'buy') {
      amount += p.amount;
      cost   += p.uah_amount;
    } else if (amount > 0) {
      const sold = Math.min(p.amount, amount);
      cost   -= cost / amount * sold;
      amount -= sold;
    }
  }
  return amount > 0 ? { amount, cost, avgRate: cost / amount } : null;
}

function calcProfit(purchases, currentBalance, cc, source) {
  if (!purchases || !purchases.length) return null;
  const ac = averageCost(purchases);
  if (!ac) return null;
  const avgRate    = ac.avgRate;
  const sellRate   = source === 'manual'
    ? getPrivatRateForCard(cc, 'sell')
    : getRateForCard(cc, 'sell');
  if (!sellRate) return null;
  const invested   = avgRate * currentBalance;
  const worthNow   = sellRate * currentBalance;
  const profit     = worthNow - invested;
  const pct        = invested > 0 ? (profit / invested) * 100 : 0;
  return { avgRate, sellRate, invested, worthNow, profit, pct };
}

/* ─── SVG чип і NFC ─────────────────────────────────────── */
const CHIP_SVG = `<svg width="40" height="30" viewBox="0 0 40 30" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="chipGold" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%"   stop-color="#d4af37"/>
      <stop offset="45%"  stop-color="#f5e08a"/>
      <stop offset="100%" stop-color="#b8962e"/>
    </linearGradient>
  </defs>
  <rect width="40" height="30" rx="6" fill="url(#chipGold)"/>
  <line x1="0"  y1="10" x2="40" y2="10" stroke="#8a6a00" stroke-opacity=".4" stroke-width="1"/>
  <line x1="0"  y1="20" x2="40" y2="20" stroke="#8a6a00" stroke-opacity=".4" stroke-width="1"/>
  <line x1="13" y1="0"  x2="13" y2="30" stroke="#8a6a00" stroke-opacity=".4" stroke-width="1"/>
  <line x1="27" y1="0"  x2="27" y2="30" stroke="#8a6a00" stroke-opacity=".4" stroke-width="1"/>
  <rect x="13" y="10" width="14" height="10" rx="1" fill="none" stroke="#8a6a00" stroke-opacity=".5" stroke-width=".8"/>
</svg>`;
const NFC_SVG = `<svg width="22" height="22" viewBox="0 0 22 22" fill="none" xmlns="http://www.w3.org/2000/svg" style="transform:rotate(90deg)">
  <path d="M5 11 C5 7.7 7.7 5 11 5"  stroke="white" stroke-opacity=".5" stroke-width="1.8" stroke-linecap="round" fill="none"/>
  <path d="M2 11 C2 6.0 6.0 2 11 2"  stroke="white" stroke-opacity=".35" stroke-width="1.8" stroke-linecap="round" fill="none"/>
  <path d="M8 11 C8 9.3 9.3 8 11 8"  stroke="white" stroke-opacity=".7" stroke-width="1.8" stroke-linecap="round" fill="none"/>
  <circle cx="11" cy="11" r="1.5" fill="white" fill-opacity=".8"/>
</svg>`;

/* ─── побудова html банківської картки ──────────────────── */
function buildCardHTML({ gradient, isLight, label, ccy, balance, equivUAH, maskedPan, owner, hidden }) {
  if (window.isPresentMode && isPresentMode()) { maskedPan = '•••• ••••'; owner = owner ? 'ВЛАСНИК' : ''; }
  const textCls = IS_LIGHT_CARD[isLight] ? 'card-text-dark' : 'card-text-light';
  const sym     = CCY_SYMBOL[ccy] || '';
  const balStr  = hidden ? `${sym}••••••` : `${sym}${fmt(balance, 2)}`;
  const eqStr   = equivUAH != null ? (hidden ? `≈ •••••• грн` : `≈ ${fmt(equivUAH)} грн`) : '';
  return `
    <div class="bank-card ${textCls}" style="background:${gradient}">
      <div class="bank-card-top">
        <div class="bank-card-mono">${label}</div>
        <div class="bank-card-ccy">${flagEl(ccy,'bank-card-flag')}<span>${ccy}</span></div>
      </div>
      <div class="bank-card-chip">${CHIP_SVG}${NFC_SVG}</div>
      <div class="bank-card-balance">${balStr}</div>
      <div class="bank-card-equiv">${eqStr}</div>
      <div class="bank-card-bottom">
        <div class="bank-card-pan">${maskedPan || '•••• ????'}</div>
        <div class="bank-card-name">${owner || ''}</div>
      </div>
    </div>`;
}

/* ─── блок «Результат курсу» ────────────────────────────── */
function buildBuySignal(cc, avgRate, source) {
  // Поточний курс купівлі (скільки коштує купити зараз)
  const buyRate = source === 'manual'
    ? getPrivatRateForCard(cc, 'buy')
    : getRateForCard(cc, 'buy');
  if (!buyRate || !avgRate) return '';

  const diff    = buyRate - avgRate;
  const diffPct = (diff / avgRate) * 100;
  const isGood  = diffPct <= 0.5;   // зараз дешевше/так само як купували → добре купити
  const cls     = isGood ? 'buy-signal-good' : 'buy-signal-bad';
  const icon    = isGood ? '🟢' : '🔴';
  const label   = isGood ? 'Вигідно купити зараз' : 'Зараз дорожче ніж купували';
  const hint    = isGood
    ? `Поточна ціна на ${Math.abs(diffPct).toFixed(1)}% ${diff < 0 ? 'нижча' : 'така ж'} за вашу середню`
    : `Поточна ціна на ${diffPct.toFixed(1)}% вища за вашу середню`;
  return `
    <div class="buy-signal ${cls}">
      <span>${icon} ${label}</span>
      <span class="buy-signal-hint">${hint}</span>
      <button class="btn btn-sm buy-now-btn" onclick="openBuyCalc('${cc}','${source}','${buyRate}')">
        💰 Купити ${cc}
      </button>
    </div>`;
}

function buildProfitBlock(purchases, balance, ccy, cardId, source, hidden) {
  const syncStatus = window._syncStatus;
  const isSyncing  = syncStatus?.running;

  if (!purchases || !purchases.length) {
    const emptyMsg = isSyncing
      ? `<div class="profit-sync-status">⏳ ${syncStatus.step || 'Синхронізація…'}</div>`
      : `<div class="profit-empty-text">Ще немає покупок — синхронізуйте виписку або додайте вручну</div>`;
    return `<div class="profit-block profit-empty">
      ${emptyMsg}
      <div class="profit-empty-actions">
        <button class="btn btn-sm btn-secondary" onclick="startSync()">🔄 Синхронізувати покупки</button>
        <button class="btn btn-sm btn-secondary" onclick="openAddPurchase('${cardId}','${ccy}')">+ Вручну</button>
      </div>
    </div>`;
  }

  const p = calcProfit(purchases, balance, ccy, source);
  if (!p) return `<div class="profit-block profit-empty"><div class="profit-empty-text">Не вдалося розрахувати прибуток</div></div>`;

  const isPos   = p.profit >= 0;
  const cls     = isPos ? 'profit-pos' : 'profit-neg';
  const arrow   = isPos ? '▲' : '▼';
  const sign    = isPos ? '+' : '';
  const profStr = hidden ? '••••••' : `${sign}${fmt(p.profit)} грн`;
  const pctStr  = hidden ? '' : ` (${sign}${p.pct.toFixed(1)}%)`;
  const invStr  = hidden ? '••••••' : fmt(p.invested);
  const nowStr  = hidden ? '••••••' : fmt(p.worthNow);

  const buySignal = buildBuySignal(ccy, p.avgRate, source);

  return `<div class="profit-block">
    <div class="profit-row"><span>Середній курс покупки</span><span class="font-mono">${fmt(p.avgRate, 4)} грн</span></div>
    <div class="profit-row"><span>Поточний курс продажу</span><span class="font-mono">${fmt(p.sellRate, 4)} грн</span></div>
    <div class="profit-row"><span>Вкладено</span><span class="font-mono">${invStr} грн</span></div>
    <div class="profit-row"><span>Варте зараз</span><span class="font-mono">${nowStr} грн</span></div>
    <div class="profit-row profit-total ${cls}">
      <span>Прибуток/збиток</span>
      <span class="font-mono">${arrow} ${profStr}${pctStr}</span>
    </div>
    ${buySignal}
    <div class="profit-actions">
      <button class="btn btn-sm btn-secondary" onclick="openAddPurchase('${cardId}','${ccy}')">+ Покупка</button>
      <button class="btn btn-sm btn-secondary" onclick="startSync()" title="Синхронізувати з виписки">🔄</button>
    </div>
  </div>`;
}

/* ─── RENDER CARDS ──────────────────────────────────────── */
let _cardsData = null;        // кеш для перерендеру без запитів

async function renderCards(forceReload = false) {
  const container = document.getElementById('cards-container');
  if (!container) return;
  if (!_cardsData || forceReload) {
    container.innerHTML = '<div class="cards-loading">Завантаження…</div>';
  }

  const hidden = lsGet('mv_balances_hidden', false) || (window.isPresentMode && isPresentMode());

  // завантаження Mono і ручних карток
  let monoData = { connected: false, reason: 'no_token' };
  let manualCards = [];
  let allPurchases = [];

  try {
    [monoData, manualCards, allPurchases] = await Promise.all([
      apiFetch('/api/mono/cards', {}, 15000),
      apiFetch('/api/manual-cards'),
      apiFetch('/api/purchases'),
    ]);
    _cardsData = { monoData, manualCards, allPurchases };
  } catch(e) {
    if (_cardsData) {
      ({ monoData, manualCards, allPurchases } = _cardsData);
      showToast('⚠ Дані з кешу', 'warning');
    } else {
      container.innerHTML = `<div class="card card-not-connected">
        <div class="not-connected-icon">⚠️</div>
        <div class="not-connected-title">Бекенд недоступний</div>
        <div class="not-connected-text">Переконайтесь, що сервер запущений: <code>start.bat</code> або <code>python server/main.py</code></div>
      </div>`;
      return;
    }
  }

  // підготовка purchases по card_id
  const purchasesByCard = {};
  for (const p of allPurchases) {
    if (!purchasesByCard[p.card_id]) purchasesByCard[p.card_id] = [];
    purchasesByCard[p.card_id].push(p);
  }

  // ─── Збираємо всі картки в один список ───────────────────
  const sections = [];

  // Mono картки
  if (!monoData.connected) {
    const reasonMsg = {
      no_token:      'Токен не задано у <code>server/.env</code> як <code>MONO_TOKEN</code>',
      invalid_token: 'Невірний токен. Перевірте значення MONO_TOKEN у server/.env',
      rate_limited:  'Monobank обмежив запити. Зачекайте хвилину і оновіть сторінку',
    };
    sections.push(`<div class="card card-not-connected">
      <div class="not-connected-icon">💳</div>
      <div class="not-connected-title">Monobank не підключено</div>
      <div class="not-connected-text">
        ${reasonMsg[monoData.reason] || 'Невідома помилка'}<br><br>
        Токен можна отримати на <strong>api.monobank.ua</strong> — відскануйте QR у розділі API.
      </div>
    </div>`);
  } else {
    for (const c of (monoData.cards || [])) {
      const eq       = uahEq(c.balance, c.currency, getRateForCard(c.currency, 'sell'));
      const cardHTML = buildCardHTML({
        gradient: getCardGrad(c.type),
        isLight:  IS_LIGHT_CARD[c.type],
        label: 'mono',
        ccy: c.currency, balance: c.balance,
        equivUAH: eq, maskedPan: c.maskedPan,
        owner: monoData.ownerName, hidden,
      });
      const purchases = purchasesByCard[c.id] || [];
      const profHTML  = buildProfitBlock(purchases, c.balance, c.currency, c.id, 'mono', hidden);
      sections.push(`<div class="card-with-profit">${cardHTML}${profHTML}</div>`);
    }
  }

  // Ручні картки (Приват тощо)
  for (const c of manualCards) {
    const privSell = getPrivatRateForCard(c.currency, 'sell');
    const eq       = uahEq(c.balance, c.currency, privSell);
    const cardHTML = buildCardHTML({
      gradient: getCardGrad(c.color || 'privat'),
      isLight:  IS_LIGHT_CARD[c.color],
      label: c.bank || 'Приват',
      ccy: c.currency, balance: c.balance,
      equivUAH: eq, maskedPan: `•••• ${c.last4}`,
      owner: '', hidden,
    });
    const purchases = purchasesByCard[String(c.id)] || [];
    const profHTML  = buildProfitBlock(purchases, c.balance, c.currency, String(c.id), 'manual', hidden);
    const actHTML   = `<div class="card-actions">
      <button class="btn btn-sm btn-secondary" onclick="openUpdateBalance(${c.id}, ${c.balance})">✏️ Оновити баланс</button>
      <button class="btn btn-sm btn-danger-outline" onclick="deleteManualCard(${c.id})">🗑</button>
    </div>`;
    sections.push(`<div class="card-with-profit">${cardHTML}${actHTML}${profHTML}</div>`);
  }

  // ─── Підсумок ─────────────────────────────────────────────
  let totalUAH    = 0;
  let totalProfit = 0;
  let totalInvest = 0;
  let hasPurchases = false;

  if (monoData.connected) {
    for (const c of (monoData.cards||[])) {
      const eq = uahEq(c.balance, c.currency, getRateForCard(c.currency, 'sell'));
      if (eq) totalUAH += eq;
      const pp = calcProfit(purchasesByCard[c.id]||[], c.balance, c.currency, 'mono');
      if (pp) { totalProfit += pp.profit; totalInvest += pp.invested; hasPurchases = true; }
    }
  }
  for (const c of manualCards) {
    const eq = uahEq(c.balance, c.currency, getPrivatRateForCard(c.currency,'sell'));
    if (eq) totalUAH += eq;
    const pp = calcProfit(purchasesByCard[String(c.id)]||[], c.balance, c.currency, 'manual');
    if (pp) { totalProfit += pp.profit; totalInvest += pp.invested; hasPurchases = true; }
  }

  const profSign  = totalProfit >= 0 ? '+' : '';
  const profCls   = totalProfit >= 0 ? 'text-green' : 'text-red';
  const profPct   = totalInvest > 0 ? (totalProfit / totalInvest * 100) : 0;
  const summaryHTML = `
    <div id="sync-banner" class="sync-banner" style="display:none"></div>
    <div class="cards-summary">
      <span>Усього у валюті ≈ <strong>${hidden ? '••••••' : fmt(totalUAH)} грн</strong></span>
      ${hasPurchases ? `<span class="${profCls}"> · Прибуток від курсу <strong>${hidden ? '••••••' : `${profSign}${fmt(totalProfit)} грн (${profSign}${profPct.toFixed(1)}%)`}</strong></span>` : ''}
      <div class="cards-summary-actions">
        <button class="btn btn-sm btn-secondary" onclick="startSync()">🔄 Синхронізувати покупки</button>
        <button class="btn btn-sm btn-secondary" onclick="openAddCard()">+ Додати картку</button>
      </div>
    </div>`;

  const demoHTML = !monoData.demo ? '' : window.GUEST_DEMO
    ? `<div class="demo-banner">🧪 <b>Демо-акаунт</b> — картки й покупки вигадані, курси справжні. Можна додавати картки й покупки: справжні дані власника не видно й не змінюються. <a href="/?demo=0">Вийти з демо</a></div>`
    : `<div class="demo-banner">🧪 <b>Демо-режим</b> — картки й покупки вигадані, курси справжні. Щоб побачити свої картки, вставте токен Monobank у <code>server/.env</code> і перезапустіть сервер.</div>`;
  container.innerHTML = demoHTML + summaryHTML + `<div class="bank-cards-grid">${sections.join('')}</div>`;
}

/* ── Показати / сховати суми ── */
function toggleBalanceVisibility() {
  const hidden = !lsGet('mv_balances_hidden', false);
  lsSet('mv_balances_hidden', hidden);
  const btn = document.getElementById('balance-toggle-btn');
  if (btn) btn.style.opacity = hidden ? '0.4' : '1';
  if (APP.currentSection === 'cards') renderCards();
}
function applyBalanceButtonState() {
  const hidden = lsGet('mv_balances_hidden', false);
  const btn    = document.getElementById('balance-toggle-btn');
  if (btn) btn.style.opacity = hidden ? '0.4' : '1';
}

/* ── Ручні картки — модалки ── */
function openAddCard() {
  document.getElementById('add-card-bank').value    = 'Приват';
  document.getElementById('add-card-currency').value= 'USD';
  document.getElementById('add-card-last4').value   = '';
  document.getElementById('add-card-balance').value = '';
  openModal('modal-add-card');
}
async function submitAddCard() {
  const body = {
    bank:     document.getElementById('add-card-bank').value.trim() || 'Приват',
    currency: document.getElementById('add-card-currency').value,
    last4:    document.getElementById('add-card-last4').value.replace(/\D/g,'').slice(-4) || '????',
    balance:  parseFloat(document.getElementById('add-card-balance').value) || 0,
    color:    'privat',
  };
  if (body.balance < 0) { showToast('Баланс не може бути від\'ємним', 'error'); return; }
  try {
    await apiFetch('/api/manual-cards', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
    closeModal('modal-add-card');
    _cardsData = null;
    showToast('✓ Картку додано', 'success');
    renderCards(true);
  } catch(e) { showToast('⚠ Помилка: ' + e.message, 'error'); }
}

function openUpdateBalance(cardId, currentBal) {
  document.getElementById('upd-balance-card-id').value = cardId;
  document.getElementById('upd-balance-val').value     = currentBal;
  openModal('modal-update-balance');
}
async function submitUpdateBalance() {
  const id  = parseInt(document.getElementById('upd-balance-card-id').value);
  const bal = parseFloat(document.getElementById('upd-balance-val').value);
  if (isNaN(bal) || bal < 0) { showToast('Введіть баланс 0 або більше', 'error'); return; }
  try {
    await apiFetch(`/api/manual-cards/${id}`, { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ balance: bal }) });
    closeModal('modal-update-balance');
    _cardsData = null;
    showToast('✓ Баланс оновлено', 'success');
    renderCards(true);
  } catch(e) { showToast('⚠ Помилка: ' + e.message, 'error'); }
}

async function deleteManualCard(cardId) {
  if (!confirm('Видалити цю картку і всі її покупки?')) return;
  try {
    await apiFetch(`/api/manual-cards/${cardId}`, { method:'DELETE' });
    _cardsData = null;
    showToast('✓ Картку видалено', 'success');
    renderCards(true);
  } catch(e) { showToast('⚠ Помилка: ' + e.message, 'error'); }
}

/* ── Покупки — модалки ── */
function openAddPurchase(cardId, ccy) {
  document.getElementById('ap-card-id').value  = cardId;
  document.getElementById('ap-currency').value = ccy;
  document.getElementById('ap-date').value     = todayISO();
  document.getElementById('ap-amount').value   = '';
  document.getElementById('ap-rate').value     = '';
  document.getElementById('ap-uah').value      = '';
  document.getElementById('ap-note').value     = '';
  openModal('modal-add-purchase');
}
function calcApRate() {
  const amount = parseFloat(document.getElementById('ap-amount').value);
  const uah    = parseFloat(document.getElementById('ap-uah').value);
  if (!isNaN(amount) && amount > 0 && !isNaN(uah) && uah > 0) {
    document.getElementById('ap-rate').value = (uah / amount).toFixed(4);
  }
}
function calcApUah() {
  const amount = parseFloat(document.getElementById('ap-amount').value);
  const rate   = parseFloat(document.getElementById('ap-rate').value);
  if (!isNaN(amount) && amount > 0 && !isNaN(rate) && rate > 0) {
    document.getElementById('ap-uah').value = (amount * rate).toFixed(2);
  }
}
async function submitAddPurchase() {
  const cardId = document.getElementById('ap-card-id').value;
  const ccy    = document.getElementById('ap-currency').value;
  const amount = parseFloat(document.getElementById('ap-amount').value);
  const rate   = parseFloat(document.getElementById('ap-rate').value) || null;
  const uah    = parseFloat(document.getElementById('ap-uah').value)  || null;
  const dateV  = document.getElementById('ap-date').value;
  const note   = document.getElementById('ap-note').value.trim();
  // Перевірка введення: порожні, нульові, від'ємні й неможливі значення не зберігаємо
  if (!dateV)                         { showToast('Вкажіть дату покупки', 'error'); return; }
  if (dateV > todayISO())             { showToast('Дата покупки не може бути в майбутньому', 'error'); return; }
  if (isNaN(amount) || amount <= 0)   { showToast('Сума у валюті має бути більшою за 0', 'error'); return; }
  if (!rate && !uah)                  { showToast('Вкажіть курс або суму в гривнях', 'error'); return; }
  if ((rate !== null && rate <= 0) || (uah !== null && uah <= 0)) { showToast('Курс і сума в гривнях мають бути більшими за 0', 'error'); return; }
  const effRate = rate || uah / amount;
  if (effRate < 10 || effRate > 200)  { showToast(`Курс ${fmt(effRate, 2)} грн виглядає неправильно — перевірте суми`, 'error'); return; }
  const body = { card_id: cardId, source: 'manual', type: 'buy',
    date: dateV, amount, currency: ccy, note,
    ...(rate ? { rate } : {}), ...(uah ? { uah_amount: uah } : {}),
  };
  try {
    await apiFetch('/api/purchases', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
    closeModal('modal-add-purchase');
    _cardsData = null;
    showToast('✓ Покупку додано', 'success');
    renderCards(true);
  } catch(e) { showToast('⚠ ' + e.message, 'error'); }
}

/* ══════════════════════════════════════
   СИНХРОНІЗАЦІЯ ВИПИСКИ MONOBANK
══════════════════════════════════════ */
window._syncStatus    = null;
window._syncPollTimer = null;

async function startSync() {
  try {
    const res = await apiFetch('/api/mono/sync', { method: 'POST' });
    if (!res.ok) {
      showToast(`⏳ ${res.msg}`, 'info');
    } else {
      showToast('⏳ Синхронізацію запущено (до ~4 хв)', 'info');
    }
  } catch(e) {
    showToast('⚠ Не вдалося запустити синхронізацію', 'error');
    return;
  }
  startSyncPolling();
}

function startSyncPolling() {
  if (window._syncPollTimer) clearInterval(window._syncPollTimer);
  window._syncPollTimer = setInterval(pollSyncStatus, 3000);
  pollSyncStatus(); // відразу
}

async function pollSyncStatus() {
  try {
    const st = await apiFetch('/api/mono/sync-status');
    window._syncStatus = st;
    updateSyncStatusUI(st);

    if (st.done && !st.running) {
      clearInterval(window._syncPollTimer);
      window._syncPollTimer = null;
      if (st.imported > 0) {
        showToast(`✓ Знайдено ${st.exchangeTx} обмінів, додано ${st.imported} покупок`, 'success');
        _cardsData = null;
        renderCards(true);
      } else if (st.done) {
        showToast(`ℹ За 90 днів нових обмінів не знайдено`, 'info');
        if (APP.currentSection === 'cards') renderCards(false);
      }
    } else if (st.running) {
      // оновлюємо статус без перезавантаження карток
      if (APP.currentSection === 'cards') updateSyncBanner(st);
    }
  } catch(e) {
    clearInterval(window._syncPollTimer);
    window._syncPollTimer = null;
  }
}

function updateSyncStatusUI(st) {
  // оновлюємо або створюємо банер синхронізації
  let banner = document.getElementById('sync-banner');
  if (!banner) return;
  if (st.running) {
    banner.className = 'sync-banner sync-banner-running';
    banner.innerHTML = `<span class="sync-spinner">⏳</span> ${st.step}`;
    banner.style.display = '';
  } else if (st.done && st.lastRun) {
    if (st.error) {
      banner.className = 'sync-banner sync-banner-error';
      banner.innerHTML = `⚠ ${st.error}`;
    } else {
      banner.className = 'sync-banner sync-banner-done';
      banner.innerHTML = `✓ ${st.step}`;
    }
    banner.style.display = '';
    setTimeout(() => { if (banner) banner.style.display = 'none'; }, 6000);
  } else {
    banner.style.display = 'none';
  }
}

function updateSyncBanner(st) {
  let banner = document.getElementById('sync-banner');
  if (!banner) return;
  banner.className = 'sync-banner sync-banner-running';
  banner.innerHTML = `<span class="sync-spinner">⏳</span> ${st.step}`;
  banner.style.display = '';
}

/* ══════════════════════════════════════
   КАЛЬКУЛЯТОР КУПІВЛІ
══════════════════════════════════════ */
function openBuyCalc(ccy, source, buyRate) {
  // Відкриваємо модалку калькулятора
  const rate = parseFloat(buyRate);
  const sym  = ccy === 'USD' ? '$' : '€';
  document.getElementById('buy-calc-ccy').textContent   = ccy;
  document.getElementById('buy-calc-rate').textContent  = fmt(rate, 4) + ' грн';
  document.getElementById('buy-calc-amount').value = '';
  document.getElementById('buy-calc-uah').value    = '';
  document.getElementById('buy-calc-ccy-hidden').value  = ccy;
  document.getElementById('buy-calc-rate-hidden').value = rate;
  document.getElementById('buy-calc-sym').textContent   = sym;
  const stepsCcy = document.getElementById('buy-calc-steps-ccy');
  if (stepsCcy) stepsCcy.textContent = ccy;
  // QR на офіційний сайт monobank — для сканування телефоном
  const qr = document.getElementById('buy-calc-qr-code');
  if (qr && !qr.dataset.ready && window.QRCode) {
    new QRCode(qr, { text: 'https://monobank.ua/', width: 120, height: 120, colorDark: '#000000', colorLight: '#ffffff' });
    qr.dataset.ready = '1';
  }
  if (qr) qr.style.display = window.QRCode ? '' : 'none';
  // На комп'ютері застосунку немає — кнопку показуємо тільки на телефоні
  const openBtn = document.getElementById('buy-calc-open-app');
  if (openBtn) openBtn.style.display = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ? '' : 'none';
  openModal('modal-buy-calc');
}

function calcBuyAmount() {
  const rate   = parseFloat(document.getElementById('buy-calc-rate-hidden').value);
  const amount = parseFloat(document.getElementById('buy-calc-amount').value);
  if (!isNaN(amount) && amount > 0 && rate > 0) {
    document.getElementById('buy-calc-uah').value = (amount * rate).toFixed(2);
  }
}
function calcBuyUah() {
  const rate = parseFloat(document.getElementById('buy-calc-rate-hidden').value);
  const uah  = parseFloat(document.getElementById('buy-calc-uah').value);
  if (!isNaN(uah) && uah > 0 && rate > 0) {
    document.getElementById('buy-calc-amount').value = (uah / rate).toFixed(2);
  }
}

function openMonoApp() {
  // Працює тільки на телефоні з встановленим застосунком monobank
  window.location.href = 'monobank://';
}

/* ══════════════════════════════════════
   РОЗДІЛ: КУРСИ
══════════════════════════════════════ */
let _sparkCharts = {};

function renderRates() {
  if (!APP.rates) return;
  renderCurrencyCards();
  renderComparisonTable();
  updateRateChart();
  calcConverter('from');
}

function getCCData(cc) {
  if (!APP.rates) return {};
  return cc === 'USD' ? APP.rates.usd : APP.rates.eur;
}

function renderCurrencyCards() {
  const grid = document.getElementById('currency-cards'); if (!grid) return;
  grid.innerHTML = '';
  for (const cc of CURRENCIES) {
    const d = getCCData(cc);
    let changeHtml = '';
    if (d.nbu != null && d.nbuYesterday != null && d.nbuYesterday !== 0) {
      const pct   = (d.nbu - d.nbuYesterday) / d.nbuYesterday * 100;
      const cls   = pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat';
      const arrow = pct > 0 ? '▲' : pct < 0 ? '▼' : '—';
      changeHtml  = `<span class="cc-change ${cls}">${arrow} ${pct > 0 ? '+' : ''}${pct.toFixed(2)}%</span>`;
    }
    const fv = v => v != null ? fmt(v,4) : '—';
    const card = document.createElement('div');
    card.className = 'currency-card';
    card.innerHTML = `
      <div class="cc-header">
        ${flagEl(cc,'cc-flag')}
        <div class="cc-titles"><div class="cc-code">${cc}</div><div class="cc-name">${CURRENCY_INFO[cc].name}</div></div>
        ${changeHtml}
      </div>
      <div class="cc-rates">
        <div class="cc-rate-box cc-rate-nbu">
          <div class="cc-rate-label">НБУ</div>
          <div class="cc-rate-val">${fv(d.nbu)}</div>
          <div class="cc-nbu-date">${d.nbuDate||''}</div>
        </div>
        <div class="cc-rate-box"><div class="cc-rate-label">Mono купівля</div><div class="cc-rate-val">${fv(d.monoBuy)}</div></div>
        <div class="cc-rate-box"><div class="cc-rate-label">Mono продаж</div><div class="cc-rate-val">${fv(d.monoSell)}</div></div>
        <div class="cc-rate-box"><div class="cc-rate-label">Приват купівля</div><div class="cc-rate-val">${fv(d.privatBuy)}</div></div>
        <div class="cc-rate-box"><div class="cc-rate-label">Приват продаж</div><div class="cc-rate-val">${fv(d.privatSell)}</div></div>
      </div>
      <canvas class="cc-sparkline" id="spark-${cc}"></canvas>`;
    grid.appendChild(card);
    setTimeout(() => drawSparkline(cc), 20);
  }
}

async function drawSparkline(cc) {
  const canvas = document.getElementById('spark-'+cc); if (!canvas) return;
  if (_sparkCharts[cc]) { _sparkCharts[cc].destroy(); delete _sparkCharts[cc]; }
  let data; try { data = await fetchHistory(cc, 7); } catch { return; }
  if (!data || data.length < 2) return;
  const vals = data.map(d=>d.rate), isUp = vals[vals.length-1] >= vals[0];
  _sparkCharts[cc] = new Chart(canvas.getContext('2d'), {
    type:'line', data:{ labels:vals.map((_,i)=>i), datasets:[{ data:vals, borderColor:isUp?'#22c55e':'#ef4444', borderWidth:2, pointRadius:0, tension:0.4, fill:false }] },
    options:{ responsive:false, animation:false, plugins:{legend:{display:false},tooltip:{enabled:false}}, scales:{x:{display:false},y:{display:false}} },
  });
}

function renderComparisonTable() {
  const tbody = document.getElementById('comparison-tbody'); if (!tbody) return;
  tbody.innerHTML = '';
  for (const cc of CURRENCIES) {
    const d = getCCData(cc);
    const fv = v => `<td class="font-mono">${v != null ? fmt(v,4) : '—'}</td>`;
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><div class="table-cc-cell">${flagEl(cc,'cc-flag')} <strong>${cc}</strong></div></td>${fv(d.nbu)}${fv(d.monoBuy)}${fv(d.monoSell)}${fv(d.privatBuy)}${fv(d.privatSell)}`;
    tbody.appendChild(tr);
  }
}

let _rateChart = null;
let _chartCallId = 0;
async function updateRateChart() {
  const cc = document.getElementById('chart-currency')?.value || 'USD';
  APP.chartCC = cc;
  const myCall = ++_chartCallId;            // захист від двох одночасних перемальовувань
  let data; try { data = await fetchHistory(cc, APP.chartPeriodDays); } catch { return; }
  if (!data || !data.length) return;
  const overlay = window.buildPurchaseOverlay ? await buildPurchaseOverlay(cc, data) : [];
  if (myCall !== _chartCallId) return;       // за цей час почалось новіше перемальовування
  const ctx = document.getElementById('rate-chart'); if (!ctx) return;
  if (_rateChart) { _rateChart.destroy(); _rateChart = null; }
  const existing = window.Chart && Chart.getChart(ctx); if (existing) existing.destroy();
  const isDark    = document.documentElement.getAttribute('data-theme')==='dark';
  const gridColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
  const textColor = isDark ? '#8b95a3' : '#5a6270';
  _rateChart = new Chart(ctx, {
    type:'line',
    data:{ labels:data.map(d=>shortDate(d.date)), datasets:[{
      label:`${cc}/UAH`, data:data.map(d=>d.rate),
      borderColor:'#3b82f6', backgroundColor:'rgba(59,130,246,0.07)',
      borderWidth:2.5, pointRadius:APP.chartPeriodDays<=30?3:1, pointHoverRadius:6, tension:0.3, fill:true,
    }, ...overlay]},
    options:{
      responsive:true, maintainAspectRatio:false,
      interaction:{ mode:'index', intersect:false },
      plugins:{
        legend:{ labels:{ color:textColor, font:{size:11}, usePointStyle:true } },
        tooltip:{ filter: i => i.raw != null, callbacks:{
          title:items => data[items[0].dataIndex]?.date || '',
          label:c => c.dataset.tooltipFor ? c.dataset.tooltipFor(c.dataIndex) : ` ${c.dataset.label}: ${fmt(c.parsed.y,4)} грн`,
        }},
      },
      scales:{
        x:{ ticks:{ color:textColor, maxTicksLimit:APP.chartPeriodDays<=30?APP.chartPeriodDays:13, maxRotation:0 }, grid:{color:gridColor} },
        y:{ ticks:{ color:textColor, callback:v=>fmt(v,2) }, grid:{color:gridColor} },
      },
    },
  });
}

function selectPeriod(btn, days) {
  document.querySelectorAll('#chart-period .period-tab').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  APP.chartPeriodDays = days;
  updateRateChart();
}

/* ══════════════════════════════════════
   КОНВЕРТЕР
══════════════════════════════════════ */
function getMonoRate(cc, dir) {
  if (!APP.rates) return null;
  const d = getCCData(cc);
  return dir==='buy' ? (d?.monoSell||d?.nbu||null) : dir==='sell' ? (d?.monoBuy||d?.nbu||null) : d?.nbu||null;
}

function calcConverter(dir) {
  const fromSel = document.getElementById('conv-from')?.value;
  const toSel   = document.getElementById('conv-to')?.value;
  const infoEl  = document.getElementById('converter-info');
  if (!fromSel || !toSel) return;
  function ccToUAH(cc, amount) {
    if (cc==='UAH') return { uah:amount, rate:1, label:'' };
    const r = getMonoRate(cc,'sell'); if (!r) return null;
    return { uah:amount*r, rate:r, label:`1 ${cc} = ${fmt(r,4)} грн · Mono купівля` };
  }
  function uahToCC(cc, uah) {
    if (cc==='UAH') return { amount:uah, rate:1, label:'' };
    const r = getMonoRate(cc,'buy'); if (!r) return null;
    return { amount:uah/r, rate:r, label:`1 ${cc} = ${fmt(r,4)} грн · Mono продаж` };
  }
  try {
    if (dir==='from') {
      const v = parseFloat(document.getElementById('conv-amount-from')?.value);
      if (isNaN(v)||v<=0) {
        document.getElementById('conv-amount-to').value = '';
        if(infoEl) infoEl.textContent = document.getElementById('conv-amount-from').value ? 'Введіть суму більшу за 0' : '';
        return;
      }
      const s1 = ccToUAH(fromSel,v); if (!s1) { if(infoEl) infoEl.textContent='Курс недоступний'; return; }
      const s2 = uahToCC(toSel,s1.uah); if (!s2) { if(infoEl) infoEl.textContent='Курс недоступний'; return; }
      document.getElementById('conv-amount-to').value = s2.amount.toFixed(2);
      if (infoEl) {
        if (fromSel!=='UAH'&&toSel!=='UAH') infoEl.textContent=`1 ${fromSel} ≈ ${fmt(s2.amount/v,4)} ${toSel} · через UAH (Mono)`;
        else if (fromSel!=='UAH') infoEl.textContent=s1.label;
        else infoEl.textContent=s2.label;
      }
    } else {
      const v = parseFloat(document.getElementById('conv-amount-to')?.value);
      if (isNaN(v)||v<=0) {
        document.getElementById('conv-amount-from').value = '';
        if(infoEl) infoEl.textContent = document.getElementById('conv-amount-to').value ? 'Введіть суму більшу за 0' : '';
        return;
      }
      const s1 = ccToUAH(toSel,v); if(!s1) return;
      const s2 = uahToCC(fromSel,s1.uah); if(!s2) return;
      document.getElementById('conv-amount-from').value = s2.amount.toFixed(2);
      if (infoEl) infoEl.textContent = toSel!=='UAH' ? s1.label : s2.label;
    }
  } catch(e) { console.warn('converter:',e); }
}

function swapConverter() {
  const from=document.getElementById('conv-from'), to=document.getElementById('conv-to');
  const fA=document.getElementById('conv-amount-from'), tA=document.getElementById('conv-amount-to');
  [from.value,to.value]=[to.value,from.value]; [fA.value,tA.value]=[tA.value,fA.value];
  calcConverter('from');
}

/* ══════════════════════════════════════
   НАЛАШТУВАННЯ
══════════════════════════════════════ */
function renderSettings() {
  const el = document.getElementById('set-refresh');
  if (el) el.value = APP.settings.refreshInterval || '5';
  updateThemeLabel();
}
function saveSetting(key, value) {
  APP.settings[key] = value; saveSettings();
  if (key==='refreshInterval') startAutoRefresh();
}

/* ══════════════════════════════════════
   ІНІЦІАЛІЗАЦІЯ
══════════════════════════════════════ */
async function init() {
  // гостьовий демо-акаунт (відкрито за QR «/?demo=1»)
  try { window.GUEST_DEMO = (await apiFetch('/api/access')).forcedDemo; } catch {}
  if (/[?&]demo=/.test(location.search)) history.replaceState(null, '', '/');
  loadState();
  loadTheme();
  applyBalanceButtonState();
  navigateTo('cards');
  if (APP.rates) updateStatusBar();
  await refreshRates(true);
  startAutoRefresh();
  // перевіряємо чи не запущена синхронізація
  try {
    const st = await apiFetch('/api/mono/sync-status');
    window._syncStatus = st;
    if (st.running) startSyncPolling();
  } catch {}
}

document.addEventListener('DOMContentLoaded', init);
