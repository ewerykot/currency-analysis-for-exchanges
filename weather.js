'use strict';
/* ══════════════════════════════════════════════════════════
   ЖИВИЙ ПОГОДНИЙ ФОН
   Погода: GET /api/weather (бекенд → Open-Meteo, без ключа).
   Малюється на <canvas id="weather-bg"> позаду всього контенту.
══════════════════════════════════════════════════════════ */

const WX_CITIES = {
  kyiv:    { name: 'Київ',    lat: 50.45, lon: 30.52 },
  lviv:    { name: 'Львів',   lat: 49.84, lon: 24.03 },
  odesa:   { name: 'Одеса',   lat: 46.48, lon: 30.72 },
  kharkiv: { name: 'Харків',  lat: 49.99, lon: 36.23 },
  dnipro:  { name: 'Дніпро',  lat: 48.46, lon: 35.05 },
  vinnytsia:{ name: 'Вінниця', lat: 49.23, lon: 28.47 },
};

const WX_LABELS = {
  sun:   { icon: '☀️', text: 'Ясно' },
  night: { icon: '🌙', text: 'Ясна ніч' },
  clouds:{ icon: '☁️', text: 'Хмарно' },
  fog:   { icon: '🌫️', text: 'Туман' },
  rain:  { icon: '🌧️', text: 'Дощ' },
  snow:  { icon: '❄️', text: 'Сніг' },
  storm: { icon: '⛈️', text: 'Гроза' },
};

const WX = {
  settings: { enabled: true, city: 'kyiv', lat: null, lon: null, test: 'auto' },
  data: null,          // { code, isDay, temp }
  state: 'sun',
  heavy: false,
  canvas: null, ctx: null, w: 0, h: 0, dpr: 1,
  particles: [], clouds: [], stars: [], splashes: [],
  flash: 0, nextFlash: 0, shooting: null,
  raf: null, last: 0, reduced: false, timer: null,
};

/* ── налаштування ── */
function wxLoad() {
  try {
    const s = JSON.parse(localStorage.getItem('mv_weather') || 'null');
    if (s) WX.settings = { ...WX.settings, ...s };
  } catch {}
}
function wxSave() { try { localStorage.setItem('mv_weather', JSON.stringify(WX.settings)); } catch {} }

function wxCoords() {
  const s = WX.settings;
  if (s.city === 'geo' && s.lat != null && s.lon != null) return { lat: s.lat, lon: s.lon, name: 'Моє місце' };
  const c = WX_CITIES[s.city] || WX_CITIES.kyiv;
  return c;
}

/* ── код WMO → стан фону ── */
function wxStateFromCode(code, isDay) {
  if (code <= 1) return { state: isDay ? 'sun' : 'night', heavy: false };
  if (code <= 3) return { state: 'clouds', heavy: code === 3 };
  if (code === 45 || code === 48) return { state: 'fog', heavy: false };
  if (code >= 51 && code <= 57) return { state: 'rain', heavy: false };
  if (code >= 61 && code <= 67) return { state: 'rain', heavy: [63, 65, 66, 67].includes(code) };
  if (code >= 71 && code <= 77) return { state: 'snow', heavy: [75, 77].includes(code) };
  if (code >= 80 && code <= 82) return { state: 'rain', heavy: code >= 81 };
  if (code === 85 || code === 86) return { state: 'snow', heavy: code === 86 };
  if (code >= 95) return { state: 'storm', heavy: true };
  return { state: isDay ? 'sun' : 'night', heavy: false };
}

/* ── завантаження погоди ── */
async function wxFetch() {
  const c = wxCoords();
  try {
    const r = await fetch(`${API_BASE}/api/weather?lat=${c.lat}&lon=${c.lon}`);
    if (!r.ok) throw new Error();
    WX.data = await r.json();
  } catch {
    WX.data = WX.data || { code: 0, isDay: 1, temp: null };
  }
  wxApplyState();
  wxRenderWidget();
}

function wxApplyState() {
  const t = WX.settings.test;
  let st;
  if (t && t !== 'auto') {
    st = { state: t, heavy: t === 'rain' || t === 'storm' };
  } else {
    const d = WX.data || { code: 0, isDay: 1 };
    st = wxStateFromCode(d.code, d.isDay);
  }
  const changed = st.state !== WX.state || st.heavy !== WX.heavy;
  WX.state = st.state; WX.heavy = st.heavy;
  if (changed) wxSeed();
  document.documentElement.setAttribute('data-weather', WX.state);
}

/* ── віджет у шапці ── */
function wxRenderWidget() {
  const el = document.getElementById('weather-widget');
  if (!el) return;
  if (!WX.settings.enabled) { el.style.display = 'none'; return; }
  el.style.display = '';
  const lbl  = WX_LABELS[WX.state] || WX_LABELS.sun;
  const city = wxCoords().name;
  const temp = WX.data && WX.data.temp != null ? `${WX.data.temp > 0 ? '+' : ''}${WX.data.temp}°` : '—';
  el.innerHTML = `<span class="wx-icon">${lbl.icon}</span><span class="wx-text">${city}, ${temp}</span>`;
  el.title = `${lbl.text}. Натисніть, щоб оновити`;
}

/* ══════════════════════════════════════
   CANVAS
══════════════════════════════════════ */
function wxIsDark() { return document.documentElement.getAttribute('data-theme') !== 'light'; }
function rnd(a, b) { return a + Math.random() * (b - a); }

function wxResize() {
  const c = WX.canvas; if (!c) return;
  WX.dpr = Math.min(window.devicePixelRatio || 1, 2);
  WX.w = window.innerWidth; WX.h = window.innerHeight;
  c.width = WX.w * WX.dpr; c.height = WX.h * WX.dpr;
  c.style.width = WX.w + 'px'; c.style.height = WX.h + 'px';
  WX.ctx.setTransform(WX.dpr, 0, 0, WX.dpr, 0, 0);
  wxSeed();
}

function wxMax() {
  const mobile = WX.w < 640;
  const base = { rain: WX.heavy ? 150 : 90, storm: 150, snow: WX.heavy ? 130 : 80 }[WX.state] || 0;
  return Math.round(mobile ? base / 2 : base);
}

function wxSeed() {
  const { w, h } = WX;
  WX.particles = []; WX.splashes = []; WX.clouds = []; WX.stars = [];
  WX.flash = 0; WX.nextFlash = performance.now() + rnd(4000, 9000); WX.shooting = null;
  if (!w) return;

  const n = wxMax();
  for (let i = 0; i < n; i++) WX.particles.push(wxNewParticle(true));

  const cloudCount = { clouds: WX.heavy ? 9 : 6, rain: 7, storm: 9, snow: 5, fog: 0, sun: 2, night: 0 }[WX.state] || 0;
  for (let i = 0; i < cloudCount; i++) {
    const layer = i % 3;                      // 0 далеко, 2 близько
    WX.clouds.push({
      x: rnd(-200, w), y: rnd(20, h * (WX.state === 'clouds' ? 0.55 : 0.35)),
      s: rnd(0.6, 1.3) * (0.7 + layer * 0.25),
      v: (0.08 + layer * 0.07) * (WX.state === 'storm' ? 2 : 1),
      layer,
    });
  }
  if (WX.state === 'night') {
    for (let i = 0; i < (w < 640 ? 60 : 120); i++) {
      WX.stars.push({ x: rnd(0, w), y: rnd(0, h * 0.75), r: rnd(0.5, 1.8), p: rnd(0, Math.PI * 2), sp: rnd(0.5, 2) });
    }
  }
  if (WX.state === 'fog') {
    for (let i = 0; i < 6; i++) WX.clouds.push({ x: rnd(-300, w), y: rnd(h * 0.2, h), s: rnd(2, 3.5), v: rnd(0.05, 0.15), layer: 9 });
  }
}

function wxNewParticle(anywhere) {
  const { w, h } = WX;
  if (WX.state === 'snow') {
    const r = rnd(1.2, 3.6);
    return { x: rnd(0, w), y: anywhere ? rnd(0, h) : rnd(-20, -5), r, vy: r * 0.25 + 0.3, sway: rnd(0, Math.PI * 2), sw: rnd(0.4, 1.2) };
  }
  // дощ / гроза
  const len = rnd(10, 22) * (WX.heavy ? 1.2 : 1);
  return { x: rnd(-50, w + 50), y: anywhere ? rnd(-h, h) : rnd(-60, -10), len, vy: rnd(9, 14) * (WX.heavy ? 1.25 : 1), vx: -2.2 };
}

/* ── малювання ── */
function wxCloud(ctx, x, y, s, alpha, color) {
  ctx.fillStyle = color.replace('A', alpha.toFixed(3));
  const blobs = [[0, 0, 38], [34, -14, 32], [70, 0, 36], [36, 12, 34], [-30, 8, 26], [100, 10, 24]];
  ctx.beginPath();
  for (const [dx, dy, r] of blobs) { ctx.moveTo(x + dx * s + r * s, y + dy * s); ctx.arc(x + dx * s, y + dy * s, r * s, 0, Math.PI * 2); }
  ctx.fill();
}

function wxDraw(now, dt) {
  const { ctx, w, h } = WX; if (!ctx) return;
  const dark = wxIsDark();
  ctx.clearRect(0, 0, w, h);
  const k = Math.min(dt / 16.7, 3);   // нормалізація до 60 fps

  /* ясно вдень — теплі промені і відблиски */
  if (WX.state === 'sun') {
    const g = ctx.createRadialGradient(w * 0.85, -h * 0.05, 0, w * 0.85, -h * 0.05, h * 0.9);
    g.addColorStop(0, dark ? 'rgba(255,196,80,0.55)' : 'rgba(255,190,60,0.6)');
    g.addColorStop(0.4, dark ? 'rgba(255,170,60,0.12)' : 'rgba(255,200,80,0.18)');
    g.addColorStop(1, 'rgba(255,170,60,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    ctx.save(); ctx.translate(w * 0.85, -h * 0.05); ctx.rotate(now / 40000);
    for (let i = 0; i < 12; i++) {
      ctx.rotate(Math.PI / 6);
      ctx.fillStyle = `rgba(255,210,120,${0.05 + 0.03 * Math.sin(now / 1500 + i)})`;
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(h * 1.1, -40); ctx.lineTo(h * 1.1, 40); ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }

  /* ясна ніч — зірки, падаюча зірка */
  if (WX.state === 'night') {
    for (const s of WX.stars) {
      const a = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(now / 1000 * s.sp + s.p));
      ctx.fillStyle = dark ? `rgba(255,245,200,${a})` : `rgba(90,100,160,${a * 0.7})`;
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill();
    }
    if (!WX.shooting && Math.random() < 0.002 * k) {
      WX.shooting = { x: rnd(w * 0.2, w), y: rnd(0, h * 0.3), life: 1 };
    }
    if (WX.shooting) {
      const sh = WX.shooting;
      sh.x -= 9 * k; sh.y += 4 * k; sh.life -= 0.02 * k;
      const g = ctx.createLinearGradient(sh.x, sh.y, sh.x + 90, sh.y - 40);
      g.addColorStop(0, `rgba(255,255,255,${sh.life})`); g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.strokeStyle = g; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(sh.x, sh.y); ctx.lineTo(sh.x + 90, sh.y - 40); ctx.stroke();
      if (sh.life <= 0) WX.shooting = null;
    }
  }

  /* хмари / туман */
  const cloudColor = WX.state === 'storm' || WX.state === 'rain'
    ? (dark ? 'rgba(120,135,160,A)' : 'rgba(110,120,140,A)')
    : (dark ? 'rgba(200,210,230,A)' : 'rgba(150,165,190,A)');
  for (const c of WX.clouds) {
    c.x += c.v * k;
    if (c.x - 150 * c.s > w) c.x = -260 * c.s;
    if (c.layer === 9) {   // туман — широкі розмиті смуги
      const g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, 260 * c.s);
      g.addColorStop(0, dark ? 'rgba(200,210,225,0.22)' : 'rgba(170,180,195,0.3)');
      g.addColorStop(1, 'rgba(200,210,225,0)');
      ctx.fillStyle = g; ctx.fillRect(c.x - 260 * c.s, c.y - 260 * c.s, 520 * c.s, 520 * c.s);
    } else {
      wxCloud(ctx, c.x, c.y, c.s, 0.18 + c.layer * 0.08, cloudColor);
    }
  }

  /* дощ / гроза */
  if (WX.state === 'rain' || WX.state === 'storm') {
    ctx.strokeStyle = dark ? 'rgba(170,200,255,0.75)' : 'rgba(70,110,170,0.6)';
    ctx.lineWidth = 1.3; ctx.lineCap = 'round';
    ctx.beginPath();
    for (const p of WX.particles) {
      p.x += p.vx * k; p.y += p.vy * k;
      ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + p.vx * 2, p.y - p.len);
      if (p.y > h - 4) {
        if (Math.random() < 0.5) WX.splashes.push({ x: p.x, y: h - 3, r: 0, life: 1 });
        Object.assign(p, wxNewParticle(false));
      }
    }
    ctx.stroke();
    ctx.strokeStyle = dark ? 'rgba(170,200,255,0.6)' : 'rgba(70,110,170,0.5)';
    ctx.lineWidth = 1;
    WX.splashes = WX.splashes.filter(s => s.life > 0);
    for (const s of WX.splashes) {
      s.r += 0.6 * k; s.life -= 0.06 * k;
      ctx.globalAlpha = Math.max(s.life, 0);
      ctx.beginPath(); ctx.ellipse(s.x, s.y, s.r * 2, s.r * 0.6, 0, Math.PI, Math.PI * 2); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /* блискавка — м'який спалах + зигзаг */
  if (WX.state === 'storm') {
    if (now > WX.nextFlash) {
      WX.flash = 1; WX.nextFlash = now + rnd(8000, 15000);
      WX.bolt = wxBolt(rnd(w * 0.15, w * 0.85));
    }
    if (WX.flash > 0) {
      ctx.fillStyle = dark ? `rgba(200,215,255,${WX.flash * 0.25})` : `rgba(255,255,255,${WX.flash * 0.35})`;
      ctx.fillRect(0, 0, w, h);
      if (WX.bolt && WX.flash > 0.4) {
        ctx.strokeStyle = `rgba(255,255,230,${WX.flash})`; ctx.lineWidth = 2.2;
        ctx.beginPath(); WX.bolt.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.stroke();
      }
      WX.flash -= 0.035 * k;
    }
  }

  /* сніг */
  if (WX.state === 'snow') {
    ctx.fillStyle = dark ? 'rgba(255,255,255,0.9)' : 'rgba(120,140,170,0.75)';
    for (const p of WX.particles) {
      p.sway += 0.02 * k;
      p.y += p.vy * k; p.x += Math.sin(p.sway) * p.sw * 0.5 * k;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
      if (p.y > h + 5) Object.assign(p, wxNewParticle(false));
    }
  }
}

function wxBolt(x) {
  const pts = [[x, 0]]; let y = 0;
  while (y < WX.h * 0.55) { y += rnd(25, 55); x += rnd(-35, 35); pts.push([x, y]); }
  return pts;
}

function wxLoop(now) {
  const dt = WX.last ? now - WX.last : 16.7;
  WX.last = now;
  wxDraw(now, dt);
  WX.raf = requestAnimationFrame(wxLoop);
}

function wxStart() {
  wxStop();
  if (!WX.settings.enabled || !WX.canvas) { if (WX.ctx) WX.ctx.clearRect(0, 0, WX.w, WX.h); return; }
  WX.canvas.style.display = '';
  if (WX.reduced) { wxDraw(performance.now(), 16.7); return; }   // статичний кадр
  WX.last = 0;
  WX.raf = requestAnimationFrame(wxLoop);
}
function wxStop() { if (WX.raf) cancelAnimationFrame(WX.raf); WX.raf = null; }

/* ══════════════════════════════════════
   НАЛАШТУВАННЯ (UI)
══════════════════════════════════════ */
function wxRenderSettings() {
  const en = document.getElementById('wx-enabled');
  const city = document.getElementById('wx-city');
  const test = document.getElementById('wx-test');
  if (en) en.checked = !!WX.settings.enabled;
  if (city) city.value = WX.settings.city;
  if (test) test.value = WX.settings.test || 'auto';
  const geoHint = document.getElementById('wx-geo-hint');
  if (geoHint) geoHint.textContent = WX.settings.city === 'geo' ? 'Використовується ваше місцезнаходження' : '';
}

function wxSetEnabled(on) {
  WX.settings.enabled = !!on; wxSave();
  if (!on && WX.canvas) { wxStop(); WX.ctx.clearRect(0, 0, WX.w, WX.h); WX.canvas.style.display = 'none'; }
  else wxStart();
  wxRenderWidget();
}
function wxSetCity(v) {
  WX.settings.city = v; wxSave(); wxRenderSettings(); wxFetch();
}
function wxSetTest(v) {
  WX.settings.test = v; wxSave(); wxApplyState(); wxRenderWidget(); wxStart();
}
function wxUseGeo() {
  if (!navigator.geolocation) { showToast && showToast('Браузер не підтримує геолокацію', 'error'); return; }
  navigator.geolocation.getCurrentPosition(pos => {
    WX.settings.city = 'geo';
    WX.settings.lat = Math.round(pos.coords.latitude * 10) / 10;
    WX.settings.lon = Math.round(pos.coords.longitude * 10) / 10;
    wxSave(); wxRenderSettings(); wxFetch();
    showToast && showToast('Місцезнаходження збережено', 'success');
  }, () => { showToast && showToast('Доступ до місцезнаходження не надано', 'error'); },
  { timeout: 10000, maximumAge: 3600000 });
}

/* ══════════════════════════════════════
   СТАРТ
══════════════════════════════════════ */
function wxInit() {
  wxLoad();
  WX.canvas = document.getElementById('weather-bg');
  if (!WX.canvas) return;
  WX.ctx = WX.canvas.getContext('2d');
  const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  WX.reduced = mq.matches;
  mq.addEventListener?.('change', e => { WX.reduced = e.matches; wxStart(); });

  wxResize();
  window.addEventListener('resize', () => { wxResize(); if (WX.reduced) wxStart(); });
  document.addEventListener('visibilitychange', () => { document.hidden ? wxStop() : wxStart(); });
  new MutationObserver(() => { if (WX.reduced) wxStart(); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  const widget = document.getElementById('weather-widget');
  if (widget) widget.addEventListener('click', () => wxFetch());

  wxApplyState();
  wxRenderSettings();
  wxRenderWidget();
  if (WX.settings.enabled) wxStart(); else WX.canvas.style.display = 'none';
  wxFetch();
  WX.timer = setInterval(wxFetch, 15 * 60 * 1000);
}

document.addEventListener('DOMContentLoaded', wxInit);
