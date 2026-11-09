// Service worker Buku Kas.
// Tugasnya: (1) membuat app ini bisa "diinstall" di HP, (2) menyimpan cache tampilan dasar agar
// tetap terbuka saat offline, dan (3) memastikan PEMBARUAN SELALU TERAMBIL tanpa install ulang.
//
// Strategi: network-first dengan revalidasi (cache: 'no-cache'), jadi setiap kali online file terbaru
// dari server yang dipakai; cache hanya cadangan saat offline.
// Data transaksi tetap diambil langsung dari Firebase saat online.
//
// Setiap rilis: naikkan VERSION di sini DAN APP_VERSION di index.html.
const VERSION = '2.0.0';
const CACHE_NAME = 'buku-kas-shell-' + VERSION;
const APP_SHELL = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      .catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING' || event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Jangan sentuh permintaan ke Firebase/Firestore/CDN/API eksternal — biarkan selalu live.
  if (url.origin !== self.location.origin) return;
  // Pengecekan versi dari aplikasi (index.html?_v=...) harus langsung ke jaringan, tanpa cache.
  if (url.searchParams.has('_v')) return;

  event.respondWith(
    fetch(req, { cache: 'no-cache' })
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then((hit) => hit || (req.mode === 'navigate' ? caches.match('./index.html') : undefined))
      )
  );
});
