'use strict';
/* ══════════════════════════════════════════════════════════
   ДОДАТКОВІ ФІЧІ
   1. Режим презентації — ховає ім'я, номери карток і суми
   2. Сповіщення про курс — «повідом, коли EUR < 50,50»
   3. Історія покупок — таблиця, фільтри, експорт CSV
   4. Точки покупок і середній курс на графіку
══════════════════════════════════════════════════════════ */

/* ── спільне ── */
const CCY_SIGN = { USD: '$', EUR: '€' };
function isoToUa(iso) {                      // 2026-11-05 → 05.11.2026
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}.${m}.${y}`;
}
function uaToIso(ua) {                       // 05.11.2026 → 2026-11-05
  const [d, m, y] = ua.split('.');
  return `${y}-${m}-${d}`;
}
function monoSell(ccy) {                     // скільки коштує купити валюту зараз
  const d = ccy === 'USD' ? APP.rates?.usd : APP.rates?.eur;
  return d?.monoSell || d?.nbu || null;
}
function monoBuy(ccy) {                      // скільки дадуть, якщо продати
  const d = ccy === 'USD' ? APP.rates?.usd : APP.rates?.eur;
  return d?.monoBuy || d?.nbu || null;
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ══════════════════════════════════════
   1. РЕЖИМ ПРЕЗЕНТАЦІЇ
══════════════════════════════════════ */
function isPresentMode() { return lsGet('mv_present', false) === true; }

function togglePresentMode(on) {
  lsSet('mv_present', !!on);
  applyPresentMode();
  renderCurrentSection();
  showToast(on ? '🎤 Режим презентації увімкнено' : 'Режим презентації вимкнено', 'info');
}
function applyPresentMode() {
  const on = isPresentMode();
  const badge = document.getElementById('present-badge');
  if (badge) badge.style.display = on ? '' : 'none';
  const t = document.getElementById('present-toggle');
  if (t) t.checked = on;
  document.documentElement.classList.toggle('present-mode', on);
}
function isAmountsHidden() { return isPresentMode() || lsGet('mv_balances_hidden', false); }

/* ══════════════════════════════════════
   2. СПОВІЩЕННЯ ПРО КУРС
══════════════════════════════════════ */
function loadAlerts() { return lsGet('mv_alerts', []); }
function saveAlerts(list) { lsSet('mv_alerts', list); }

function renderAlerts() {
  const box = document.getElementById('alerts-list');
  if (!box) return;
  const list = loadAlerts();
  const cur = document.getElementById('alert-current');
  if (cur) {
    const u = monoSell('USD'), e = monoSell('EUR');
    cur.textContent = (u && e) ? `Зараз: USD ${fmt(u, 2)} · EUR ${fmt(e, 2)} (продаж Mono)` : '';
  }
  if (!list.length) {
    box.innerHTML = `<p class="form-hint">Сповіщень ще немає.</p>`;
    return;
  }
  box.innerHTML = list.map(a => `
    <div class="alert-item ${a.fired ? 'alert-fired' : ''}">
      <span>${a.fired ? '✅' : '🔔'} ${a.ccy} ${a.dir === 'below' ? 'нижче' : 'вище'} ${fmt(a.value, 2)} грн</span>
      <span class="alert-item-actions">
        ${a.fired ? `<button class="btn btn-sm btn-secondary" onclick="resetRateAlert('${a.id}')">Знову стежити</button>` : ''}
        <button class="btn btn-sm btn-secondary" onclick="deleteRateAlert('${a.id}')" title="Видалити">🗑</button>
      </span>
    </div>`).join('');
}

async function addRateAlert() {
  const ccy = document.getElementById('alert-ccy').value;
  const dir = document.getElementById('alert-dir').value;
  const value = parseFloat(String(document.getElementById('alert-value').value).replace(',', '.'));
  if (!(value > 0)) { showToast('Введіть курс, наприклад 50.50', 'error'); return; }
  const list = loadAlerts();
  list.push({ id: String(Date.now()), ccy, dir, value, fired: false });
  saveAlerts(list);
  document.getElementById('alert-value').value = '';
  if ('Notification' in window && Notification.permission === 'default') {
    try { await Notification.requestPermission(); } catch {}
  }
  renderAlerts();
  showToast(`🔔 Повідомлю, коли ${ccy} буде ${dir === 'below' ? 'нижче' : 'вище'} ${fmt(value, 2)} грн`, 'success');
  checkRateAlerts();
}
function deleteRateAlert(id) { saveAlerts(loadAlerts().filter(a => a.id !== id)); renderAlerts(); }
function resetRateAlert(id) {
  saveAlerts(loadAlerts().map(a => a.id === id ? { ...a, fired: false } : a));
  renderAlerts(); checkRateAlerts();
}

function checkRateAlerts() {
  const list = loadAlerts();
  let changed = false;
  for (const a of list) {
    if (a.fired) continue;
    const rate = monoSell(a.ccy);
    if (!rate) continue;
    const hit = a.dir === 'below' ? rate <= a.value : rate >= a.value;
    if (!hit) continue;
    a.fired = true; changed = true;
    const msg = `${a.ccy} зараз ${fmt(rate, 2)} грн — ${a.dir === 'below' ? 'нижче' : 'вище'} вашої цілі ${fmt(a.value, 2)}`;
    showToast(`🔔 ${msg}`, 'success');
    if ('Notification' in window && Notification.permission === 'granted') {
      try { new Notification('Мої валюти', { body: msg }); } catch {}
    }
  }
  if (changed) { saveAlerts(list); renderAlerts(); }
}

/* ══════════════════════════════════════
   3. ІСТОРІЯ ПОКУПОК
══════════════════════════════════════ */
let _histRows = [];          // відфільтровані рядки для CSV
let _cardNames = {};         // card_id → «mono USD •••• 0048»

async function loadCardNames() {
  const names = {};
  try {
    const [mono, manual] = await Promise.all([
      apiFetch('/api/mono/cards', {}, 15000).catch(() => ({ connected: false })),
      apiFetch('/api/manual-cards').catch(() => []),
    ]);
    for (const c of (mono.cards || [])) names[c.id] = `mono ${c.currency} ${c.maskedPan}`;
    for (const c of manual) names[String(c.id)] = `${c.bank} ${c.currency} •••• ${c.last4}`;
  } catch {}
  _cardNames = names;
  return names;
}

function cardLabel(id) {
  const n = _cardNames[id] || 'картка';
  return isPresentMode() ? n.replace(/•••• \S+/, '•••• ••••') : n;
}

async function renderHistory() {
  const tbody = document.getElementById('hist-tbody');
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="9" class="text-muted">Завантаження…</td></tr>`;

  let rows = [];
  try {
    [rows] = await Promise.all([apiFetch('/api/purchases'), loadCardNames()]);
  } catch {
    tbody.innerHTML = `<tr><td colspan="9" class="text-muted">Сервер недоступний — запустіть start.bat</td></tr>`;
    return;
  }

  // фільтр карток
  const sel = document.getElementById('hist-card');
  const prev = sel.value;
  sel.innerHTML = `<option value="">Усі картки</option>` +
    Object.keys(_cardNames).map(id => `<option value="${escapeHtml(id)}">${escapeHtml(cardLabel(id))}</option>`).join('');
  sel.value = prev && _cardNames[prev] ? prev : '';

  const fCard = sel.value;
  const fCcy  = document.getElementById('hist-ccy').value;
  const fType = document.getElementById('hist-type').value;
  rows = rows.filter(r => (!fCard || r.card_id === fCard) && (!fCcy || r.currency === fCcy) && (!fType || r.type === fType));
  _histRows = rows;

  const hide = isAmountsHidden();
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="text-muted">Покупок не знайдено. Синхронізуйте виписку на сторінці «Мої картки» або додайте вручну.</td></tr>`;
    document.getElementById('hist-summary').innerHTML = '';
    return;
  }

  tbody.innerHTML = rows.map(r => {
    const sign   = CCY_SIGN[r.currency] || '';
    const nowVal = r.amount * (monoBuy(r.currency) || r.rate);
    const diff   = r.type === 'buy' ? nowVal - r.uah_amount : null;   // для покупок: скільки змінилась вартість
    const diffHtml = diff == null ? '—'
      : `<span class="${diff >= 0 ? 'text-green' : 'text-red'}">${diff >= 0 ? '+' : ''}${hide ? '•••' : fmt(diff)} грн</span>`;
    return `<tr>
      <td>${isoToUa(r.date)}</td>
      <td>${escapeHtml(cardLabel(r.card_id))}</td>
      <td><span class="hist-type hist-${r.type}">${r.type === 'buy' ? 'Купівля' : 'Продаж'}</span></td>
      <td class="font-mono">${hide ? '•••' : `${sign}${fmt(r.amount)}`}</td>
      <td class="font-mono">${fmt(r.rate, 4)}</td>
      <td class="font-mono">${hide ? '•••' : fmt(r.uah_amount)}</td>
      <td class="font-mono">${diffHtml}</td>
      <td>${r.source === 'mono' ? 'Monobank · авто' : 'Вручну'}</td>
      <td>${r.source === 'manual' ? `<button class="btn btn-sm btn-secondary" title="Видалити" onclick="deleteHistoryRow(${r.id})">🗑</button>` : ''}</td>
    </tr>`;
  }).join('');

  // підсумок по валютах
  const byCcy = {};
  for (const r of rows) {
    const s = byCcy[r.currency] ||= { buyAmt: 0, buyUah: 0, n: 0 };
    s.n++;
    if (r.type === 'buy') { s.buyAmt += r.amount; s.buyUah += r.uah_amount; }
  }
  document.getElementById('hist-summary').innerHTML = Object.entries(byCcy).map(([ccy, s]) =>
    `<div class="hist-sum-item"><b>${ccy}</b>: ${s.n} операцій · куплено ${hide ? '•••' : `${CCY_SIGN[ccy] || ''}${fmt(s.buyAmt)}`}` +
    (s.buyAmt ? ` · середній курс покупки <b>${fmt(s.buyUah / s.buyAmt, 4)}</b>` : '') + `</div>`).join('');
}

async function deleteHistoryRow(id) {
  if (!confirm('Видалити цю покупку?')) return;
  try {
    await apiFetch(`/api/purchases/${id}`, { method: 'DELETE' });
    showToast('Покупку видалено', 'success');
    renderHistory();
  } catch { showToast('Не вдалося видалити', 'error'); }
}

function exportHistoryCSV() {
  if (!_histRows.length) { showToast('Немає даних для експорту', 'error'); return; }
  const hide = isAmountsHidden();
  const head = ['Дата', 'Картка', 'Тип', 'Сума', 'Валюта', 'Курс', 'Сума в грн', 'Джерело'];
  const lines = _histRows.map(r => [
    isoToUa(r.date), cardLabel(r.card_id), r.type === 'buy' ? 'Купівля' : 'Продаж',
    hide ? '' : r.amount.toFixed(2).replace('.', ','), r.currency,
    r.rate.toFixed(4).replace('.', ','), hide ? '' : r.uah_amount.toFixed(2).replace('.', ','),
    r.source === 'mono' ? 'Monobank' : 'Вручну',
  ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(';'));
  // BOM + «;» — щоб Excel правильно відкрив кирилицю й колонки
  const blob = new Blob(['﻿' + [head.join(';'), ...lines].join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `pokupky_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ══════════════════════════════════════
   4. ПОКУПКИ НА ГРАФІКУ КУРСУ
══════════════════════════════════════ */
async function buildPurchaseOverlay(cc, hist) {
  let rows = [];
  try { rows = await apiFetch('/api/purchases'); } catch { return []; }
  const buys = rows.filter(r => r.currency === cc && r.type === 'buy');
  if (!buys.length || !hist.length) return [];

  const isoDates = hist.map(d => uaToIso(d.date));
  const first = isoDates[0], last = isoDates[isoDates.length - 1];
  const points = new Array(hist.length).fill(null);
  const info   = new Array(hist.length).fill(null);

  for (const b of buys) {
    const d = b.date.slice(0, 10);
    if (d < first || d > last) continue;
    // найближчий день з курсом НБУ (вихідні, свята)
    let idx = isoDates.findIndex(x => x >= d);
    if (idx < 0) idx = isoDates.length - 1;
    info[idx] = info[idx] || [];
    info[idx].push(b);
    points[idx] = b.rate;                      // точка на висоті курсу покупки
  }

  // той самий метод середньої вартості, що й на картках (продажі враховано)
  const ac  = averageCost(rows.filter(r => r.currency === cc));
  const avg = ac ? ac.avgRate : null;
  const hide = isAmountsHidden();
  const sign = CCY_SIGN[cc] || '';

  const sets = [];
  if (points.some(p => p != null)) {
    sets.push({
      label: 'Мої покупки (курс банку)', data: points, showLine: false,
      pointRadius: 7, pointHoverRadius: 9, pointStyle: 'circle',
      pointBackgroundColor: '#22c55e', pointBorderColor: '#0b1a10', pointBorderWidth: 2,
      borderColor: '#22c55e', backgroundColor: '#22c55e',
      tooltipFor: i => (info[i] || []).map(b =>
        ` Покупка: ${hide ? '•••' : sign + fmt(b.amount)} за ${fmt(b.rate, 4)} грн`),
    });
  }
  if (avg) {
    sets.push({
      label: `Мій середній курс ${fmt(avg, 2)}`, data: hist.map(() => avg),
      borderColor: '#f59e0b', borderDash: [6, 5], borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 0, fill: false,
      tooltipFor: () => ` Мій середній курс: ${fmt(avg, 4)} грн`,
    });
  }
  return sets;
}

/* ══════════════════════════════════════
   СТАРТ
══════════════════════════════════════ */
const _origRenderSettings = window.renderSettings;
window.renderSettings = function () {
  if (_origRenderSettings) _origRenderSettings();
  applyPresentMode();
  renderAlerts();
};

document.addEventListener('DOMContentLoaded', () => {
  applyPresentMode();
  renderAlerts();
});
