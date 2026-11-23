// Service worker: PWA shell offline, Web Push SOS (prioritas tinggi), Background Sync & Periodic Sync.
// Naikkan VERSION setiap rilis supaya cache lama dibuang.
const VERSION = '1.3.0';
const SHELL_CACHE = 'motor-shell-' + VERSION;
const CDN_CACHE = 'motor-cdn-v1';
const SHELL = ['./', './index.html', './app.js', './manifest.json', '../bmkg-layers.js', '../map-pro.js', '../icon-192.png', '../icon-512.png'];
const SOS_VIBRATE = [700, 200, 700, 200, 700, 200, 1400, 300, 700, 200, 700, 200, 1400];

// ---- IndexedDB kecil (dibagi dengan app.js: DB 'motor-pwa', store 'kv') ----
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('motor-pwa', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbGet(k) {
  const db = await idb();
  return new Promise((res) => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(undefined); });
}
async function idbSet(k, v) {
  const db = await idb();
  return new Promise((res) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = () => res(); t.onerror = () => res(); });
}

// ---- siklus hidup & cache ----
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('motor-') && k !== SHELL_CACHE && k !== CDN_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('message', (e) => {
  const t = e.data && e.data.type;
  if (t === 'SKIP_WAITING') self.skipWaiting();
  if (t === 'SYNC_NOW') e.waitUntil(syncData(false).catch(() => {}));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    // network-first: selalu ambil versi terbaru, cache hanya cadangan saat offline
    e.respondWith(
      fetch(req, { cache: 'no-cache' })
        .then((res) => { if (res && res.ok) { const cp = res.clone(); caches.open(SHELL_CACHE).then((c) => c.put(req, cp)).catch(() => {}); } return res; })
        .catch(() => caches.match(req).then((h) => h || (req.mode === 'navigate' ? caches.match('./index.html') : undefined)))
    );
    return;
  }
  // Leaflet dari cdnjs: stale-while-revalidate agar peta tetap berjalan saat offline
  if (url.hostname === 'cdnjs.cloudflare.com') {
    e.respondWith(caches.open(CDN_CACHE).then(async (c) => {
      const hit = await c.match(req);
      const net = fetch(req).then((r) => { if (r && (r.ok || r.type === 'opaque')) c.put(req, r.clone()); return r; }).catch(() => hit);
      return hit || net;
    }));
  }
  // lain-lain (Worker API, Google, tile peta): langsung ke jaringan
});

// ---- Web Push ----
self.addEventListener('push', (e) => e.waitUntil(onPush(e)));

async function onPush(e) {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { title: 'Pemberitahuan', body: e.data ? e.data.text() : '' }; }
  const kind = d.kind || 'info';
  const urgent = kind === 'sos';
  const opts = {
    body: d.body || '',
    icon: '../icon-192.png',
    badge: '../icon-192.png',
    tag: d.tag || kind,
    renotify: true,                              // tiap SOS baru tetap berbunyi/bergetar lagi
    requireInteraction: urgent || kind === 'alert', // tidak hilang sendiri sampai disentuh
    vibrate: urgent ? SOS_VIBRATE : kind === 'alert' ? [400, 150, 400, 150, 400] : [200, 100, 200],
    silent: false,
    timestamp: d.ts || Date.now(),
    data: { url: d.url || './', lat: d.lat, lon: d.lon, kind },
    actions: urgent ? [{ action: 'open', title: 'Buka peta' }, { action: 'map', title: 'Google Maps' }] : [],
  };
  await self.registration.showNotification(d.title || 'Pelacak Motor', opts);
  const list = ((await idbGet('alerts')) || []);
  list.unshift({ kind, title: d.title, body: d.body, ts: d.ts || Date.now(), lat: d.lat, lon: d.lon, tag: opts.tag });
  await idbSet('alerts', list.slice(0, 30));
  // Aplikasi sedang terbuka: minta ia membunyikan sirene & menampilkan layar SOS
  const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  wins.forEach((c) => c.postMessage({ type: 'push', payload: d }));
}

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const d = e.notification.data || {};
  e.waitUntil((async () => {
    if (e.action === 'map' && d.lat !== undefined && d.lon !== undefined) return self.clients.openWindow(`https://www.google.com/maps?q=${d.lat},${d.lon}`);
    const target = new URL(d.url || './', self.registration.scope).href;
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of wins) {
      if (c.url.startsWith(self.registration.scope)) {
        await c.focus();
        c.postMessage({ type: 'open', url: target, kind: d.kind, lat: d.lat, lon: d.lon });
        return;
      }
    }
    return self.clients.openWindow(target);
  })());
});

// Langganan push diganti browser: daftarkan ulang diam-diam supaya SOS tidak terputus
self.addEventListener('pushsubscriptionchange', (e) => {
  e.waitUntil((async () => {
    const [key, cfg, ses] = await Promise.all([idbGet('vapidKey'), idbGet('config'), idbGet('session')]);
    if (!key || !cfg || !ses) return;
    const pad = '='.repeat((4 - (key.length % 4)) % 4);
    const raw = atob((key + pad).replace(/-/g, '+').replace(/_/g, '/'));
    const appKey = Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
    const sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appKey });
    await fetch(cfg.workerUrl + '/api/push/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Session ' + ses.token },
      body: JSON.stringify({ subscription: sub.toJSON(), label: 'perangkat (otomatis)' }),
    });
  })().catch(() => {}));
});

// ---- Background Sync / Periodic Sync ----
// Menarik posisi terakhir, status relay BBM & log alarm, menyimpannya ke IndexedDB, lalu memberi tahu halaman.
async function syncData(throwOnFail) {
  const [cfg, ses] = await Promise.all([idbGet('config'), idbGet('session')]);
  if (!cfg || !ses) return;
  let r;
  try {
    r = await fetch(cfg.workerUrl + '/api/sync', { headers: { authorization: 'Session ' + ses.token }, cache: 'no-store' });
  } catch (err) { if (throwOnFail) throw err; return; }   // lempar => browser mengulang Background Sync nanti
  if (!r.ok) { if (throwOnFail && r.status >= 500) throw new Error('sync ' + r.status); return; }
  const j = await r.json();
  if (!j.ok) return;
  await idbSet('sync', { pos: j.pos, alarms: j.alarms, relay: j.relay, sos: j.sos, at: Date.now() });
  // Cadangan bila push gagal: SOS baru (<15 mnt) yang belum pernah diberitahukan -> notifikasi lokal
  const sos = (j.alarms || []).find((a) => a.typeId === 1 && Date.now() - (a.sendMs || a.gpsMs || 0) < 15 * 60000);
  if (sos) {
    const last = (await idbGet('lastSosNotified')) || 0;
    const t = sos.sendMs || sos.gpsMs;
    if (t > last) {
      await idbSet('lastSosNotified', t);
      await self.registration.showNotification('🆘 SOS DARURAT — tombol ditekan!', {
        body: `${sos.name || 'Kendaraan'} • ${Math.round(sos.speed || 0)} km/j`, icon: '../icon-192.png', badge: '../icon-192.png',
        tag: 'sos-' + sos.id, renotify: true, requireInteraction: true, vibrate: SOS_VIBRATE, timestamp: t,
        data: { url: './?sos=1', lat: sos.lat, lon: sos.lon, kind: 'sos' },
      });
    }
  }
  const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  wins.forEach((c) => c.postMessage({ type: 'synced' }));
}
self.addEventListener('sync', (e) => { if (e.tag === 'motor-sync') e.waitUntil(syncData(true)); });
self.addEventListener('periodicsync', (e) => { if (e.tag === 'motor-periodic') e.waitUntil(syncData(false)); });
