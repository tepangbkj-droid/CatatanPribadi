/* Pelacak Motor & SOS — frontend PWA.
   Isi dua nilai di CONFIG. Semua perintah & data lewat Cloudflare Worker (akses dibatasi akun Google yang diizinkan). */
const CONFIG = {
  WORKER_URL: 'https://gps-worker.tepangbkj8.workers.dev',
  GOOGLE_CLIENT_ID: 'GANTI_DENGAN_CLIENT_ID.apps.googleusercontent.com',
  MOVING_KMH: 5,
  STALE_MS: 5 * 60 * 1000,
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const S = { session: null, cfg: null, pos: null, alarms: [], relay: null, syncAt: 0, failN: 0, cred: null, credExp: 0, tab: 'map', hist: null, installEv: null };
const LS = { get: (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} } };

/* ---------- IndexedDB (dibagi dengan sw.js) ---------- */
const idb = () => new Promise((res, rej) => { const r = indexedDB.open('motor-pwa', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const idbGet = async (k) => { try { const db = await idb(); return await new Promise((res) => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(undefined); }); } catch (e) { return undefined; } };
const idbSet = async (k, v) => { try { const db = await idb(); await new Promise((res) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = res; t.onerror = res; }); } catch (e) {} };

/* ---------- util tampilan ---------- */
const pad = (n) => String(n).padStart(2, '0');
const hhmm = (ms) => { const d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
const fullTime = (ms) => new Date(ms).toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
function ago(ms) {
  if (!ms) return '–';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return s + ' dtk lalu';
  if (s < 3600) return Math.round(s / 60) + ' mnt lalu';
  if (s < 86400) return Math.round(s / 3600) + ' jam lalu';
  return Math.round(s / 86400) + ' hari lalu';
}
const bytes = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
const mmss = (s) => pad(Math.floor(s / 60)) + ':' + pad(Math.round(s % 60));
let toastT;
function toast(msg, bad) {
  const t = $('toast'); t.textContent = msg; t.className = bad ? 'bad' : ''; clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.add('hidden'), bad ? 6000 : 3200);
}
const b64uToU8 = (s) => { s = s.replace(/-/g, '+').replace(/_/g, '/'); s += '='.repeat((4 - (s.length % 4)) % 4); return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); };
const decodeJwt = (t) => { try { return JSON.parse(decodeURIComponent(escape(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))))); } catch (e) { return {}; } };

/* ---------- Autentikasi Google ---------- */
let gReady = false, credWaiters = [];
function initGoogle() {
  if (gReady || !window.google || !google.accounts || !google.accounts.id) return false;
  google.accounts.id.initialize({ client_id: CONFIG.GOOGLE_CLIENT_ID, callback: onCredential, auto_select: true, cancel_on_tap_outside: false, use_fedcm_for_prompt: true });
  google.accounts.id.renderButton($('gbtn'), { theme: 'filled_blue', size: 'large', shape: 'pill', text: 'signin_with', locale: 'id', width: 280 });
  gReady = true;
  return true;
}
async function onCredential(resp) {
  const cred = resp.credential, c = decodeJwt(cred);
  S.cred = cred; S.credExp = (c.exp || 0) * 1000;
  try { sessionStorage.setItem('gcred', JSON.stringify({ cred, exp: S.credExp })); } catch (e) {}
  const waiters = credWaiters; credWaiters = [];
  waiters.forEach((w) => w.resolve(cred));
  // Tukar dengan token sesi aplikasi (dipakai baca data, Background Sync, daftar push). Perintah tetap memakai ID token Google segar.
  try {
    const r = await fetch(CONFIG.WORKER_URL + '/api/auth/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ credential: cred }) });
    const j = await r.json();
    if (!j.ok) return gateError(j.code === 'not_whitelisted' ? `Akun ${c.email || ''} tidak ada di daftar izin.` : (j.error || 'Masuk gagal'));
    S.session = { token: j.token, exp: j.exp * 1000, email: j.email, role: j.role, name: j.name };
    LS.set('session', S.session); await idbSet('session', S.session);
    shareSession(S.session);
    $('gate').classList.add('hidden');
    startApp();
  } catch (e) { gateError('Tidak bisa menghubungi server. Cek internet.'); }
}
function gateError(msg) { const e = $('gErr'); e.textContent = msg; e.classList.remove('hidden'); $('gate').classList.remove('hidden'); }
function showGate(msg) { if (/GANTI/.test(CONFIG.GOOGLE_CLIENT_ID)) msg = 'GOOGLE_CLIENT_ID belum diisi di motor/app.js (lihat PANDUAN-GPS.md).'; $('gate').classList.remove('hidden'); if (msg) gateError(msg); else $('gErr').classList.add('hidden'); if (!initGoogle()) $('gHint').textContent = 'Memuat Google Sign-In…'; }
function freshGoogleToken() {
  if (S.cred && S.credExp - Date.now() > 120000) return Promise.resolve(S.cred);
  return new Promise((resolve, reject) => {
    if (!window.google || !gReady && !initGoogle()) return reject(new Error('Google Sign-In belum termuat (cek internet).'));
    const w = { resolve, reject }; credWaiters.push(w);
    google.accounts.id.prompt((n) => { if ((n.isNotDisplayed && n.isNotDisplayed()) || (n.isSkippedMoment && n.isSkippedMoment())) { /* tunggu timeout lalu minta masuk ulang */ } });
    setTimeout(() => { const i = credWaiters.indexOf(w); if (i >= 0) { credWaiters.splice(i, 1); reject(new Error('Token Google tidak diperbarui. Keluar lalu masuk lagi.')); } }, 12000);
  });
}

/* Sesi dibagikan ke halaman Buku Kas (origin yang sama) lewat localStorage 'gps_session' supaya tab Kendaraan bisa membaca posisi tanpa kunci API.
   Hanya token sesi (baca data, 14 hari). Perintah tetap memakai ID token Google segar dari halaman ini. */
function shareSession(s) { try { if (s) localStorage.setItem('gps_session', JSON.stringify({ token: s.token, exp: s.exp, email: s.email, role: s.role })); else localStorage.removeItem('gps_session'); } catch (e) {} }

/* ---------- API ---------- */
async function api(path, o = {}) {
  const h = { ...(o.headers || {}) };
  if (o.google) h.authorization = 'Bearer ' + await freshGoogleToken();
  else if (S.session) h.authorization = 'Session ' + S.session.token;
  let body = o.body;
  if (body && !(body instanceof FormData)) { h['content-type'] = 'application/json'; body = JSON.stringify(body); }
  const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), o.timeout || 25000);
  try {
    const r = await fetch(CONFIG.WORKER_URL + path, { method: o.method || 'GET', headers: h, body, cache: 'no-store', signal: ctl.signal });
    let j; try { j = await r.json(); } catch (e) { j = { ok: false, error: 'balasan server bukan JSON (' + r.status + ')' }; }
    j._status = r.status;
    if (r.status === 401 && !o.google && /session|no_auth/.test(j.code || '')) { S.session = null; LS.set('session', null); await idbSet('session', null); shareSession(null); showGate('Sesi berakhir. Masuk lagi.'); }
    return j;
  } finally { clearTimeout(to); }
}

/* ---------- Tab ---------- */
function showTab(t) {
  S.tab = t;
  document.querySelectorAll('.tab').forEach((el) => el.classList.toggle('hidden', el.id !== 'tab-' + t));
  document.querySelectorAll('#nav button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === t)));
  if (t === 'map' && S.map) setTimeout(() => S.map.invalidateSize(), 50);
  if (t === 'audio') loadAudio();
  if (t === 'alarm') { LS.set('alarmSeen', Date.now()); renderAlarms(); loadCommands(); }
  if (t === 'acct') renderAcct();
}
$('nav').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) showTab(b.dataset.tab); });

/* ---------- Peta ---------- */
function initMap() {
  if (S.map || typeof L === 'undefined') return;
  S.map = L.map('map', { zoomControl: false, attributionControl: true }).setView([-6.2, 106.82], 13);
  L.control.zoom({ position: 'bottomright' }).addTo(S.map);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(S.map);
  S.hLayer = L.layerGroup().addTo(S.map);
  if (window.BmkgLayers) BmkgLayers.attach(S.map, { workerUrl: CONFIG.WORKER_URL, getPosition: () => (S.pos ? { lat: +S.pos.lat, lon: +S.pos.lon } : null) });
  if (window.TrafficLayer) TrafficLayer.attach(S.map, { workerUrl: CONFIG.WORKER_URL, position: 'topright', statusEl: $('trfChip'), getPosition: () => (S.pos ? { lat: +S.pos.lat, lon: +S.pos.lon, speed: +S.pos.speed || 0 } : null) });
  if (window.MapPro) MapPro.enhance(S.map, { extras: [{ icon: '🏍️', title: 'Posisi motor', fn: () => { if (S.pos) { S.follow = true; $('follow').setAttribute('aria-pressed', 'true'); S.map.flyTo([S.pos.lat, S.pos.lon], Math.max(S.map.getZoom(), 16), { duration: 0.8 }); } } }] });
  S.follow = true;
  S.map.on('dragstart', () => { S.follow = false; $('follow').setAttribute('aria-pressed', 'false'); });
}
$('follow').addEventListener('click', () => {
  S.follow = !S.follow; $('follow').setAttribute('aria-pressed', String(S.follow));
  if (S.follow && S.pos && S.map) S.map.setView([S.pos.lat, S.pos.lon], Math.max(S.map.getZoom(), 16));
});

/* ---------- Render status ---------- */
function posAge() { const p = S.pos; if (!p) return Infinity; const t = Math.max(p.heartbeatMs || 0, p.positionMs || 0); return t ? Date.now() - t : Infinity; }
function render() {
  const p = S.pos, online = posAge() < CONFIG.STALE_MS, moving = online && p && p.speed >= CONFIG.MOVING_KMH;
  $('stDot').className = 'dot ' + (!p ? '' : moving ? 'moving' : online ? 'on' : 'off');
  $('stTxt').textContent = !p ? 'menunggu data' : moving ? 'bergerak' : online ? 'diam' : 'tracker offline';
  $('spdV').textContent = p ? Math.round(p.speed || 0) : '–';
  $('fixWhen').textContent = p ? `Titik GPS ${hhmm(p.positionMs || Date.now())} · ${ago(p.positionMs)}` : 'Menunggu data…';
  $('fixAddr').textContent = p ? `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}` : '';
  const r = S.relay, cut = r && r.fuelCut, known = r && r.source && r.source !== 'unknown';
  const chip = $('relayChip'); chip.textContent = !known ? 'BBM: belum diketahui' : cut ? 'BBM: TERPUTUS' : 'BBM: normal'; chip.className = 'chip ' + (!known ? '' : cut ? 'cut' : 'ok');
  $('led').className = 'led ' + (!known ? '' : cut ? 'cut' : 'ok');
  $('relayTxt').textContent = !known ? 'Belum diketahui' : cut ? 'BBM TERPUTUS — motor tidak bisa dihidupkan' : 'BBM normal';
  $('relaySrc').textContent = !known ? '' : r.source === 'device' ? 'Dilaporkan tracker' : 'Perkiraan dari perintah terakhir yang diterima server';
  if (p && S.map) {
    const ll = [p.lat, p.lon];
    if (!S.marker) S.marker = L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="mk"></div>', iconSize: [26, 26], iconAnchor: [13, 13] }) }).addTo(S.map);
    else S.marker.setLatLng(ll);
    S.marker.getElement() && S.marker.getElement().firstChild.classList.toggle('cut', !!cut);
    if (S.follow && !S.first) { S.map.setView(ll, 16); S.first = true; } else if (S.follow) S.map.panTo(ll, { animate: true });
  }
  const off = $('offBar'), stale = S.failN >= 2 || !navigator.onLine;
  if (stale) { off.textContent = `Tanpa koneksi. Data terakhir ${ago(S.syncAt)}. Sinkron otomatis begitu online.`; off.classList.remove('hidden'); } else off.classList.add('hidden');
  const unread = (S.alarms || []).filter((a) => (a.sendMs || 0) > LS.get('alarmSeen', 0)).length;
  $('alBadge').textContent = unread; $('alBadge').classList.toggle('hidden', !unread || S.tab === 'alarm');
  const canCmd = !S.cfg || S.cfg.canCommand;
  ['cut', 'restore', 'ivGo', 'recGo', 'monGo'].forEach((id) => { $(id).disabled = !canCmd; });
}
setInterval(render, 15000);

/* ---------- Sinkronisasi cerdas ---------- */
let pollT, inflight = false;
function delay() { if (document.hidden) return 60000; const mv = S.pos && S.pos.speed >= CONFIG.MOVING_KMH; return Math.min(60000, (mv ? 5000 : 15000) * Math.pow(2, Math.min(S.failN, 3))); }
function schedule() { clearTimeout(pollT); if (!S.session) return; pollT = setTimeout(() => syncNow(), delay()); }
async function syncNow(o = {}) {
  if (!S.session || inflight) return;
  if (!navigator.onLine) { S.failN = Math.max(S.failN, 2); render(); queueBgSync(); return schedule(); }
  inflight = true;
  try {
    const j = await api('/api/sync' + (o.fresh ? '?fresh=1' : ''), { timeout: 20000 });
    if (j.ok) { onSync(j); S.failN = 0; } else { S.failN++; if (j.posError) $('fixWhen').textContent = 'Server portal: ' + (j.posError.error || 'gagal'); }
  } catch (e) { S.failN++; queueBgSync(); }
  inflight = false; render(); schedule();
}
function onSync(j) {
  S.pos = j.pos || S.pos; S.alarms = j.alarms || S.alarms; S.relay = j.relay || S.relay; S.syncAt = Date.now();
  idbSet('sync', { pos: S.pos, alarms: S.alarms, relay: S.relay, sos: j.sos, at: S.syncAt });
  if (S.tab === 'alarm') renderAlarms();
  const sos = (S.alarms || []).find((a) => a.typeId === 1 && Date.now() - (a.sendMs || a.gpsMs || 0) < 15 * 60000);
  if (sos && (sos.sendMs || sos.gpsMs) > LS.get('sosAck', 0)) showSos({ ts: sos.sendMs || sos.gpsMs, lat: sos.lat, lon: sos.lon, speed: sos.speed, name: sos.name });
}
async function loadCached() {
  const c = await idbGet('sync');
  if (c) { S.pos = c.pos; S.alarms = c.alarms || []; S.relay = c.relay; S.syncAt = c.at || 0; render(); }
}
async function queueBgSync() {
  try {
    const reg = await navigator.serviceWorker.ready;
    if (reg.sync) await reg.sync.register('motor-sync');
    if (reg.periodicSync && (await navigator.permissions.query({ name: 'periodic-background-sync' })).state === 'granted') await reg.periodicSync.register('motor-periodic', { minInterval: 15 * 60 * 1000 });
  } catch (e) {}
}
window.addEventListener('online', () => { S.failN = 0; syncNow({ fresh: true }); queueBgSync(); toast('Online lagi, menyinkronkan…'); });
window.addEventListener('offline', () => { render(); queueBgSync(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) { S.failN = 0; syncNow(); } });

/* ---------- Riwayat rute ---------- */
let hMode = '6';
const toLocalInput = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
$('presets').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return; hMode = b.dataset.h;
  $('presets').querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  $('customRange').classList.toggle('hidden', hMode !== 'custom');
  if (hMode === 'custom') { $('hTo').value = toLocalInput(Date.now()); $('hFrom').value = toLocalInput(Date.now() - 6 * 3600000); }
});
$('hGo').addEventListener('click', async () => {
  let to = Date.now(), from;
  if (hMode === 'custom') { from = Date.parse($('hFrom').value); to = Date.parse($('hTo').value); if (!from || !to) return toast('Isi waktu dari & sampai', true); }
  else if (hMode === 'today') { const d = new Date(); d.setHours(0, 0, 0, 0); from = d.getTime(); }
  else from = to - Number(hMode) * 3600000;
  $('hGo').disabled = true; $('hstat').textContent = 'Mengambil riwayat…';
  try {
    const j = await api('/api/history?from=' + from + '&to=' + to, { timeout: 40000 });
    if (!j.ok) { $('hstat').textContent = 'Gagal: ' + (j.error || 'tidak diketahui'); return; }
    S.hist = j; idbSet('lastHistory', j); drawHistory(j);
  } catch (e) {
    const c = await idbGet('lastHistory');
    if (c) { drawHistory(c); $('hstat').textContent = 'Offline — menampilkan rute tersimpan terakhir. ' + $('hstat').textContent; } else $('hstat').textContent = 'Tidak ada koneksi.';
  } finally { $('hGo').disabled = false; }
});
function drawHistory(j) {
  if (!S.map) return;
  S.hLayer.clearLayers(); $('play').classList.add('hidden');
  const pts = j.points || [];
  if (!pts.length) { $('hstat').textContent = 'Tidak ada titik pada rentang ini.' + (j.note ? ' ' + j.note : ''); return; }
  const solid = { color: getComputedStyle(document.documentElement).getPropertyValue('--route').trim() || '#1D5FD1', weight: 5, opacity: .9 };
  const dash = { color: '#D9730D', weight: 4, opacity: .95, dashArray: '2 10', lineCap: 'round' };
  let run = [[pts[0].lat, pts[0].lon]];
  const flush = () => { if (run.length > 1) L.polyline(run, solid).addTo(S.hLayer); };
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i], q = [p.lat, p.lon];
    if (p.gap) {  // jeda sinyal: tarik garis putus dari titik terakhir sebelum hilang ke titik pertama setelah pulih
      flush();
      const a = [pts[i - 1].lat, pts[i - 1].lon];
      L.polyline([a, q], dash).addTo(S.hLayer);
      const mins = Math.round((p.t - pts[i - 1].t) / 60000);
      L.circleMarker(a, { radius: 6, color: '#fff', weight: 2, fillColor: '#D9730D', fillOpacity: 1 }).bindPopup(`Sinyal hilang ${hhmm(pts[i - 1].t)}`).addTo(S.hLayer);
      L.circleMarker(q, { radius: 6, color: '#fff', weight: 2, fillColor: '#D9730D', fillOpacity: 1 }).bindPopup(`Sinyal pulih ${hhmm(p.t)} (jeda ${mins} mnt)`).addTo(S.hLayer);
      run = [q];
    } else run.push(q);
    if (p.late) L.circleMarker(q, { radius: 3, color: '#D9730D', weight: 1, fillColor: '#D9730D', fillOpacity: 1, interactive: false }).addTo(S.hLayer);
  }
  flush();
  L.circleMarker([pts[0].lat, pts[0].lon], { radius: 8, color: '#fff', weight: 3, fillColor: '#1E8E4E', fillOpacity: 1 }).bindPopup('Mulai ' + fullTime(pts[0].t)).addTo(S.hLayer);
  const last = pts[pts.length - 1];
  L.circleMarker([last.lat, last.lon], { radius: 8, color: '#fff', weight: 3, fillColor: '#1B2127', fillOpacity: 1 }).bindPopup('Akhir ' + fullTime(last.t)).addTo(S.hLayer);
  S.follow = false; $('follow').setAttribute('aria-pressed', 'false');
  S.map.fitBounds(L.latLngBounds(pts.map((p) => [p.lat, p.lon])), { padding: [40, 40] });
  $('hstat').textContent = `${pts.length} titik · ${String(j.distanceKm).replace('.', ',')} km · ${j.blindSpots} blind spot · ${j.lateCount} titik dikirim terlambat · sumber: ${j.source === 'portal' ? 'portal' : j.source === 'portal-stay' ? 'portal (hanya titik berhenti)' : 'rekaman server'}${j.note ? ' — ' + j.note : ''}`;
  const sl = $('pSlider'); sl.max = pts.length - 1; sl.value = pts.length - 1; $('play').classList.remove('hidden');
  sl.oninput = () => {
    const p = pts[+sl.value];
    if (!S.pMark) S.pMark = L.circleMarker([p.lat, p.lon], { radius: 9, color: '#1B2127', weight: 3, fillColor: '#FFC20E', fillOpacity: 1 }).addTo(S.map);
    S.pMark.setLatLng([p.lat, p.lon]); if (!S.map.hasLayer(S.pMark)) S.pMark.addTo(S.map);
    $('pInfo').textContent = `${fullTime(p.t)} · ${Math.round(p.sp)} km/j${p.late ? ' · dikirim terlambat' : ''}${p.gap ? ' · setelah blind spot' : ''}`;
  };
  sl.oninput();
}

/* ---------- Dialog konfirmasi ---------- */
function confirmSheet({ title, text, warn, ok, danger }) {
  return new Promise((resolve) => {
    const d = $('dlg');
    $('dlgBody').innerHTML = `<h3>${esc(title)}</h3><p>${esc(text || '')}</p>${warn ? `<div class="warnbox">${esc(warn)}</div>` : ''}<div class="btns"><button class="btn ${danger ? 'alarm' : 'sig'}" id="dY" style="min-height:56px;font-size:17px">${esc(ok)}</button><button class="btn ghost" id="dN">Batal</button></div>`;
    const done = (v) => { d.close(); resolve(v); };
    $('dY').onclick = () => done(true); $('dN').onclick = () => done(false); d.oncancel = () => resolve(false);
    d.showModal(); $('dN').focus();
  });
}

/* ---------- Perintah tracker ---------- */
const ACTION_LABEL = { cut_fuel: 'Putus BBM', restore_fuel: 'Pulihkan BBM', set_interval: 'Atur rentang', record: 'Rekam suara', monitor: 'Mode monitor' };
function showResult(ok, text) { const r = $('result'); r.className = ok ? 'good' : 'bad'; r.textContent = text; r.classList.remove('hidden'); }
async function sendCommand(action, extra = {}) {
  showResult(true, `${ACTION_LABEL[action]}: mengirim…`);
  let j;
  try {
    j = await api('/api/command', { method: 'POST', google: true, body: { action, ...extra }, timeout: 60000 });
    if (!j.ok && ['token_expired', 'token_invalid'].includes(j.code)) { S.cred = null; j = await api('/api/command', { method: 'POST', google: true, body: { action, ...extra }, timeout: 60000 }); }
  } catch (e) { showResult(false, `${ACTION_LABEL[action]} GAGAL: ${e.message || 'tidak ada koneksi'}\nPerintah belum terkirim. Coba lagi atau telepon SIM tracker.`); toast('Perintah belum terkirim', true); return; }
  if (j.ok) {
    showResult(true, `${ACTION_LABEL[action]} DITERIMA server portal (${j.confidence === 'strong' ? 'terkonfirmasi' : 'belum pasti'})\nPerintah: ${j.command}\nJalur: ${j.via}\nBalasan: ${(j.reply || '').slice(0, 300)}\n${j.note || ''}`);
    toast(ACTION_LABEL[action] + ' terkirim'); setTimeout(() => syncNow({ fresh: true }), 4000); loadCommands();
  } else {
    showResult(false, `${ACTION_LABEL[action]} GAGAL (${j.code || j.kind || j._status})\n${j.error || ''}\n${j.reply ? 'Balasan: ' + String(j.reply).slice(0, 300) + '\n' : ''}${j.hint || ''}`);
    toast(ACTION_LABEL[action] + ' gagal', true);
  }
}
async function askCut() {
  const sp = S.pos ? Math.round(S.pos.speed || 0) : null;
  const moving = sp !== null && sp >= CONFIG.MOVING_KMH;
  const warn = (moving ? `Motor terakhir terbaca melaju ${sp} km/j. ` : sp !== null ? 'Motor terakhir terbaca diam. ' : '') + 'Mesin mati mendadak; berisiko bagi pengendara bila masih melaju. Sebagian firmware menunda pemutusan sampai kecepatan turun.';
  if (await confirmSheet({ title: 'Putus BBM sekarang?', text: 'Perintah dikirim ke tracker lewat server. Anggota keluarga ikut diberi tahu.', warn, ok: 'Ya, putus BBM', danger: true })) sendCommand('cut_fuel');
}
$('cut').onclick = askCut; $('sosCut').onclick = askCut;
$('restore').onclick = async () => { if (await confirmSheet({ title: 'Pulihkan BBM?', text: 'Motor bisa dihidupkan lagi setelah tracker menerima perintah.', ok: 'Ya, pulihkan' })) sendCommand('restore_fuel'); };
$('ivPresets').onclick = (e) => { const b = e.target.closest('button'); if (b) $('ivSec').value = b.dataset.s; };
$('ivGo').onclick = async () => {
  const n = Number($('ivSec').value), lo = (S.cfg && S.cfg.intervalMin) || 5, hi = (S.cfg && S.cfg.intervalMax) || 18000;
  if (!Number.isInteger(n) || n < lo || n > hi) return toast(`Isi bilangan bulat ${lo}–${hi} detik`, true);
  if (await confirmSheet({ title: `Lapor tiap ${n} detik?`, text: n < 20 ? 'Selang sangat pendek menguras baterai tracker dan pulsa SIM.' : 'Tracker akan memakai selang baru begitu online.', ok: 'Kirim' })) sendCommand('set_interval', { intervalSeconds: n });
};
$('recGo').onclick = async () => { const n = Number($('recSec').value); if (await confirmSheet({ title: `Rekam suara ${n} detik?`, text: 'Perintah rekam dikirim ke tracker. Bila tracker tidak mendukung, perintah diabaikan.', ok: 'Kirim perintah' })) sendCommand('record', { seconds: n }); };
$('monGo').onclick = async () => { if (await confirmSheet({ title: 'Aktifkan mode monitor?', text: 'Setelah aktif, telepon nomor SIM tracker untuk mendengar sekitar motor.', ok: 'Kirim perintah' })) sendCommand('monitor'); };

function applySim() {
  const sim = S.cfg && S.cfg.simNumber;
  ['callSim', 'sosCall'].forEach((id) => { const a = $(id); if (sim) { a.href = 'tel:' + sim.replace(/[^+\d]/g, ''); a.classList.remove('hidden'); } else { a.removeAttribute('href'); if (id === 'sosCall') a.classList.add('hidden'); } });
  $('callSim').textContent = sim ? 'Telepon SIM' : 'SIM belum diatur';
  $('simHint').textContent = sim ? 'Tombol Telepon SIM memanggil tracker langsung. Bila auto-answer GT06 aktif, panggilan tersambung otomatis dan Anda bisa mendengar sekitar motor.' : 'Isi secret SIM_NUMBER di Worker agar tombol panggil muncul.';
}

/* ---------- Alarm & log perintah ---------- */
function renderAlarms() {
  const rows = (S.alarms || []).slice().sort((a, b) => (b.sendMs || 0) - (a.sendMs || 0));
  $('alList').innerHTML = rows.length ? rows.map((a) => {
    const sos = a.typeId === 1, t = a.sendMs || a.gpsMs;
    return `<div class="item ${sos ? 'sos' : ''}"><div class="ic">${sos ? '🆘' : '🔔'}</div><div class="t"><b>${esc(a.name || 'Alarm')}</b><span>${esc(fullTime(t))} · ${Math.round(a.speed || 0)} km/j</span></div>${Number.isFinite(a.lat) ? `<a href="https://www.google.com/maps?q=${a.lat},${a.lon}" target="_blank" rel="noopener">Peta</a>` : ''}</div>`;
  }).join('') : '<div class="empty">Belum ada alarm.</div>';
}
async function loadCommands() {
  try {
    const j = await api('/api/commands');
    $('cmdList').innerHTML = j.ok && j.rows.length ? j.rows.map((r) => `<div class="item"><div class="ic">${r.ok ? '✓' : '✗'}</div><div class="t"><b>${esc(ACTION_LABEL[r.action] || r.action)}</b><span>${esc(fullTime(r.at))} · ${esc(String(r.email).split('@')[0])}${r.ok ? '' : ' · gagal'}</span></div></div>`).join('') : '<div class="empty">Belum ada perintah.</div>';
  } catch (e) { $('cmdList').innerHTML = '<div class="empty">Tidak ada koneksi.</div>'; }
}

/* ---------- Audio ---------- */
async function loadAudio() {
  if (S.cfg && !S.cfg.audioEnabled) { $('aList').innerHTML = '<div class="empty">Penyimpanan R2 belum terhubung di Worker.</div>'; return; }
  try {
    const j = await api('/api/audio/list');
    if (!j.ok) { $('aList').innerHTML = `<div class="empty">${esc(j.error || 'Gagal memuat')}</div>`; return; }
    const owner = S.session && S.session.role === 'owner';
    $('aList').innerHTML = j.items.length ? j.items.map((a) => `<div class="item audio-item" style="display:block"><div style="display:flex;justify-content:space-between;gap:8px"><b>${esc(fullTime(a.createdAt))}</b><span style="color:var(--steel);font-size:12.5px">${esc(bytes(a.size))}${a.durationSec ? ' · ' + mmss(a.durationSec) : ''}</span></div><span style="font-size:12.5px;color:var(--steel)">${esc(String(a.by).split('@')[0])} · ${esc(a.source)}${a.note ? ' · ' + esc(a.note) : ''}</span><audio controls preload="none" src="${esc(a.url)}"></audio><div style="display:flex;gap:14px;margin-top:6px"><a href="${esc(a.downloadUrl)}" download>Unduh</a>${owner ? `<a href="#" data-del="${esc(a.id)}" style="color:var(--alarm)">Hapus</a>` : ''}</div></div>`).join('') : '<div class="empty">Belum ada rekaman. Unggah atau rekam di atas.</div>';
  } catch (e) { $('aList').innerHTML = '<div class="empty">Tidak ada koneksi.</div>'; }
}
$('aList').addEventListener('click', async (e) => {
  const id = e.target.dataset && e.target.dataset.del; if (!id) return; e.preventDefault();
  if (!(await confirmSheet({ title: 'Hapus rekaman?', text: 'File dihapus permanen dari penyimpanan.', ok: 'Hapus', danger: true }))) return;
  const j = await api('/api/audio/' + id, { method: 'DELETE' }); toast(j.ok ? 'Rekaman dihapus' : (j.error || 'Gagal'), !j.ok); loadAudio();
});
function audioDuration(file) {
  return new Promise((res) => { const a = new Audio(), u = URL.createObjectURL(file); const done = (v) => { URL.revokeObjectURL(u); res(v); }; a.preload = 'metadata'; a.onloadedmetadata = () => done(isFinite(a.duration) ? a.duration : null); a.onerror = () => done(null); setTimeout(() => done(null), 3000); a.src = u; });
}
async function uploadAudio(file, source, dur) {
  if (file.size > 25 * 1024 * 1024) return toast('File lebih dari 25 MB', true);
  $('aState').textContent = 'Mengunggah ' + bytes(file.size) + '…';
  const fd = new FormData(); fd.append('file', file, file.name || 'rekaman'); fd.append('source', source); fd.append('note', $('aNote').value.trim());
  const d = dur || (await audioDuration(file)); if (d) fd.append('duration', String(d));
  try {
    const j = await api('/api/audio/upload', { method: 'POST', body: fd, timeout: 120000 });
    $('aState').textContent = j.ok ? 'Tersimpan.' : 'Gagal: ' + (j.error || j._status); if (j.ok) { $('aNote').value = ''; loadAudio(); }
  } catch (e) { $('aState').textContent = 'Gagal mengunggah (koneksi putus). Coba lagi.'; }
}
$('aFile').onchange = (e) => { const f = e.target.files[0]; if (f) uploadAudio(f, 'upload'); e.target.value = ''; };
let rec = null;
$('aRec').onclick = async () => {
  if (rec) { rec.stop(); return; }
  if (!navigator.mediaDevices || !window.MediaRecorder) return toast('Browser ini tidak mendukung rekam suara', true);
  let stream; try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch (e) { return toast('Izin mikrofon ditolak', true); }
  const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find((m) => MediaRecorder.isTypeSupported(m)) || '';
  const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : {}), chunks = [], t0 = Date.now();
  mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const tick = setInterval(() => { const s = (Date.now() - t0) / 1000; $('aRec').textContent = 'Berhenti & simpan ' + mmss(s); if (s > 600) mr.stop(); }, 500);
  mr.onstop = () => {
    clearInterval(tick); stream.getTracks().forEach((t) => t.stop()); rec = null; $('aRec').textContent = 'Rekam dari HP';
    const type = (mr.mimeType || 'audio/webm').split(';')[0], ext = type.includes('mp4') ? 'm4a' : 'webm';
    uploadAudio(new File(chunks, 'rekaman-hp.' + ext, { type }), 'mic', (Date.now() - t0) / 1000);
  };
  rec = mr; mr.start(1000); $('aRec').textContent = 'Berhenti & simpan 00:00';
};

/* ---------- SOS: layar penuh + sirene ---------- */
let siren = null, vibT = null;
function startSiren() {
  try {
    S.ac = S.ac || new (window.AudioContext || window.webkitAudioContext)();
    if (S.ac.state === 'suspended') { S.ac.resume(); document.addEventListener('pointerdown', () => S.ac.resume(), { once: true }); }
    stopSiren();
    const o = S.ac.createOscillator(), g = S.ac.createGain(); o.type = 'square'; g.gain.value = 0.35; o.frequency.value = 640; o.connect(g).connect(S.ac.destination); o.start();
    let hi = false; const iv = setInterval(() => { hi = !hi; o.frequency.setValueAtTime(hi ? 980 : 640, S.ac.currentTime); }, 450);
    siren = { o, iv };
  } catch (e) {}
  if (navigator.vibrate) { const v = () => { if (!navigator.userActivation || navigator.userActivation.hasBeenActive) navigator.vibrate([700, 200, 700, 200, 1400]); }; v(); vibT = setInterval(v, 3500); }
}
function stopSiren() { if (siren) { clearInterval(siren.iv); try { siren.o.stop(); } catch (e) {} siren = null; } clearInterval(vibT); if (navigator.vibrate) navigator.vibrate(0); }
function showSos(i) {
  S.sos = i;
  $('sosInfo').textContent = `${i.name || 'Kendaraan'} · ${i.ts ? hhmm(i.ts) : ''} · ${Math.round(i.speed || 0)} km/j` + (Number.isFinite(+i.lat) ? `\n${(+i.lat).toFixed(5)}, ${(+i.lon).toFixed(5)}` : '');
  $('sosInfo').style.whiteSpace = 'pre-line'; $('sosOv').classList.remove('hidden'); $('sosBar').classList.remove('hidden'); startSiren();
}
function ackSos() { stopSiren(); $('sosOv').classList.add('hidden'); if (S.sos && S.sos.ts) LS.set('sosAck', S.sos.ts); }
$('sosOff').onclick = () => { ackSos(); $('sosBar').classList.add('hidden'); };
$('sosBarBtn').onclick = () => { if (S.sos) showSos(S.sos); };
$('sosMap').onclick = () => { ackSos(); showTab('map'); if (S.sos && Number.isFinite(+S.sos.lat) && S.map) { S.follow = false; $('follow').setAttribute('aria-pressed', 'false'); S.map.setView([+S.sos.lat, +S.sos.lon], 17); } };

/* ---------- Notifikasi push & akun ---------- */
async function enablePush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return toast('Browser ini belum mendukung notifikasi push. Di iPhone: pasang dulu ke Layar Utama.', true);
  if ((await Notification.requestPermission()) !== 'granted') return toast('Izin notifikasi ditolak. Aktifkan lewat pengaturan situs.', true);
  const k = await api('/api/push/vapid-key'); if (!k.key) return toast('Kunci VAPID belum diisi di Worker', true);
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (sub) { const cur = sub.options && sub.options.applicationServerKey; if (cur && b64uToU8(k.key).toString() !== new Uint8Array(cur).toString()) { await sub.unsubscribe(); sub = null; } }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToU8(k.key) });
  await idbSet('vapidKey', k.key);
  const label = (/Android/i.test(navigator.userAgent) ? 'Android' : /iPhone|iPad/i.test(navigator.userAgent) ? 'iPhone' : 'Komputer') + ' ' + new Date().toLocaleDateString('id-ID');
  const j = await api('/api/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON(), label } });
  toast(j.ok ? 'Notifikasi SOS aktif di HP ini' : (j.error || 'Gagal mendaftar'), !j.ok); renderAcct();
}
$('pushOn').onclick = () => enablePush().catch((e) => toast('Gagal: ' + e.message, true));
$('pushTest').onclick = async () => { const j = await api('/api/push/test', { method: 'POST' }); toast(j.ok ? 'Tes dikirim, tunggu notifikasi' : 'Tidak ada perangkat terdaftar / gagal kirim', !j.ok); };
async function renderAcct() {
  const s = S.session;
  $('acctInfo').textContent = s ? `${s.email} · ${s.role === 'owner' ? 'pemilik' : 'keluarga'}` : '–';
  const perm = 'Notification' in window ? Notification.permission : 'tidak didukung';
  $('pushInfo').textContent = perm === 'granted' ? 'Izin notifikasi aktif di HP ini.' : perm === 'denied' ? 'Notifikasi diblokir. Aktifkan lewat pengaturan situs/browser.' : 'Aktifkan agar SOS masuk ke HP ini walau aplikasi tertutup.';
  const bg = [('SyncManager' in window) ? 'Background Sync' : null, ('PeriodicSyncManager' in window) ? 'Periodic Sync' : null].filter(Boolean).join(' + ') || 'tidak didukung browser ini';
  $('syncInfo').textContent = `Sinkron terakhir ${ago(S.syncAt)}. Sinkron latar belakang: ${bg}.`;
  $('installBtn').textContent = window.matchMedia('(display-mode: standalone)').matches ? 'Sudah terpasang' : 'Pasang aplikasi';
  try { const j = await api('/api/push/list'); if (j.ok) $('pushDevs').textContent = j.rows.length ? 'Perangkat terdaftar: ' + j.rows.map((r) => `${String(r.email).split('@')[0]} (${r.label || 'HP'})`).join(', ') : 'Belum ada perangkat terdaftar.'; } catch (e) {}
}
$('signOut').onclick = async () => { S.session = null; shareSession(null); LS.set('session', null); await idbSet('session', null); sessionStorage.removeItem('gcred'); S.cred = null; if (window.google) google.accounts.id.disableAutoSelect(); clearTimeout(pollT); showGate(); };
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); S.installEv = e; });
$('installBtn').onclick = async () => {
  if (S.installEv) { S.installEv.prompt(); S.installEv = null; } else toast(/iPhone|iPad/i.test(navigator.userAgent) ? 'Safari: Bagikan → Tambah ke Layar Utama' : 'Menu browser → Instal aplikasi / Tambahkan ke layar utama');
};
$('syncBtn').onclick = () => { S.failN = 0; syncNow({ fresh: true }); toast('Menyinkronkan…'); };

/* ---------- Service worker & pesan ---------- */
function setupSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').then((reg) => { reg.update(); queueBgSync(); }).catch(() => {});
  navigator.serviceWorker.addEventListener('message', async (e) => {
    const m = e.data || {};
    if (m.type === 'push') {
      if (m.payload.kind === 'sos') showSos({ ts: m.payload.ts, lat: m.payload.lat, lon: m.payload.lon, name: 'Kendaraan', speed: 0 });
      else toast(m.payload.title || 'Pemberitahuan');
      syncNow({ fresh: true });
    } else if (m.type === 'open') { if (m.kind === 'sos') showSos({ ts: Date.now(), lat: m.lat, lon: m.lon, name: 'Kendaraan', speed: 0 }); syncNow({ fresh: true }); }
    else if (m.type === 'synced') { await loadCached(); }
  });
}

/* ---------- Mulai ---------- */
async function startApp() {
  initMap(); showTab(S.tab);
  await loadCached(); applySim(); render();
  idbSet('config', { workerUrl: CONFIG.WORKER_URL });
  api('/api/config').then((c) => { if (c.ok) { S.cfg = c; LS.set('cfg', c); applySim(); render(); } });
  syncNow({ fresh: true });
  const q = new URLSearchParams(location.search);
  if (q.get('tab')) showTab(q.get('tab'));
  if (q.get('sos') === '1') showSos({ ts: Date.now(), lat: q.get('lat'), lon: q.get('lon'), name: 'Kendaraan', speed: 0 });
}
(async function boot() {
  setupSW();
  try { const c = JSON.parse(sessionStorage.getItem('gcred') || 'null'); if (c && c.exp > Date.now()) { S.cred = c.cred; S.credExp = c.exp; } } catch (e) {}
  S.cfg = LS.get('cfg', null);
  const ses = LS.get('session', null);
  if (ses && ses.exp > Date.now()) { S.session = ses; shareSession(ses); $('gate').classList.add('hidden'); await idbSet('session', ses); startApp(); }
  else showGate();
  // Google Sign-In dimuat async: pasang tombol begitu siap
  let n = 0; const iv = setInterval(() => { if (initGoogle() || ++n > 40) { clearInterval(iv); if (gReady) $('gHint').textContent = ''; } }, 300);
})();
