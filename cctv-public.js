/* =====================================================================================
 * cctv-public.js — layer CCTV publik untuk peta Leaflet (data dari Worker: GET /api/cctv)
 *
 *   CctvPublic.attach(map, {
 *     workerUrl: 'https://gps-worker.xxx.workers.dev',
 *     control:   true,            // true = pasang tombol "CCTV" sendiri di peta; false = Anda memanggil toggle() dari tombol Anda
 *     position:  'topleft',       // posisi tombol bawaan
 *     onStatus:  (teks, isError) => {}   // pesan singkat (mis. showToast)
 *   });
 *   CctvPublic.toggle(map)   CctvPublic.isOn(map)   CctvPublic.refresh(map)   CctvPublic.closePlayer()   CctvPublic.detach(map)
 *
 * Sumber data: (1) Worker GET /api/cctv  +  (2) dataset statis cctv-data.json (±23 ribu titik ATCS se-Indonesia, dibuat dengan tools/build-cctv-data.py).
 *   Marker dikelompokkan (cluster) per sel grid dan hanya yang berada di layar yang digambar. Tipe tambahan: iframe (YouTube/embed), image (snapshot/MJPEG), video (mp4), auto (tebak).
 *
 * Perilaku:
 *   - Marker digambar dari JSON, tetapi PEMUTAR baru dibuat saat marker diklik (lazy). Hls.js baru diunduh saat kamera HLS pertama dibuka.
 *   - sourceType "windy"  -> <iframe> ke playerUrl
 *     sourceType "hls"    -> <video> + Hls.js (kandidat streamUrls dicoba berurutan; Safari/iOS memakai HLS native)
 *     sourceType "portal" -> tombol "Buka Live CCTV" (tab baru)
 *   - Saat popup ditutup / layer dimatikan / kamera lain dibuka: Hls.destroy(), video dikosongkan, iframe diganti about:blank lalu dibuang.
 *   - Tab disembunyikan: pengunduhan stream dijeda (hemat kuota); lanjut saat tab terlihat.
 * Tanpa dependensi selain Leaflet. CSS disuntik sendiri (prefiks .cpv-).
 * Atribusi: webcam Windy wajib menautkan ke Windy (otomatis di popup).
 * ===================================================================================== */
(function (global) {
  'use strict';
  var L = global.L;
  if (!L) { console.warn('[cctv] Leaflet belum dimuat'); return; }

  var HLS_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.5.8/hls.min.js';
  var DATA_TTL = 5 * 60e3;       // data kamera di-cache di browser 5 menit (Worker juga meng-cache)
  var FETCH_TIMEOUT = 18000;     // timeout fetch data titik CCTV/lampu dari Worker (ms)
  var START_TIMEOUT = 12000;     // per kandidat stream
  var KEY_ON = 'cctv_public_on_v1';
  var STOP_AFTER_MS = 180000;                    // pemutaran berhenti otomatis setelah 3 menit (hemat kuota Worker)
  var LS_LIST_KEY = 'cctv_list_v1';              // cache daftar titik dari Worker di localStorage
  var LS_TTL_MS = 2 * 60 * 60 * 1000;            // 2 jam
  var STATIC_URL = 'cctv-data.json';              // dataset statis ~23 ribu titik (dibuat tools/build-cctv-data.py)
  // Host yang punya CORS publik & port standar: diputar LANGSUNG dari browser (hemat kuota Worker). Selain ini lewat Worker.
  var DIRECT_OK_HOSTS = ['cctvbadilag.my.id'];
  var MAX_SINGLE = 2500;                         // batas marker tunggal di layar
  var CLUSTER_PX = 56;                           // ukuran sel pengelompokan (piksel)

  var WORKER = '';               // alamat Worker (diisi attach); dipakai untuk /api/proxy/cctv
  var states = new Map();        // map -> state
  var shared = { data: null, at: 0, promise: null };
  var stat = { cams: null, promise: null };
  // (dataset statis diunduh sekali)
  var active = null;             // pemutar yang sedang aktif { destroy() }

  /* ---------- util ---------- */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function https(u) { return typeof u === 'string' && /^https:\/\//i.test(u) ? u : null; }
  function windyHost(u) { return https(u) && /^https:\/\/([a-z0-9-]+\.)*windy\.com\//i.test(u) ? u : null; }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function el(tag, cls, html) { var n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; }
  // Resolver alamat stream:
  //  - "/api/proxy/cctv/..."        -> dipakai langsung di Worker (Worker memetakan prefix ke upstream aslinya)
  //  - path relatif lain "/api/..." -> Worker /api/proxy/cctv?url=<path>
  //  - URL penuh dari host ber-CORS publik & port standar (DIRECT_OK_HOSTS) -> langsung, tanpa Worker
  //  - URL penuh lainnya / port non-standar (mis. pelindung.bandung.go.id:3443) / http:// -> Worker /api/proxy/cctv?url=<URL>
  function directOk(u) {
    try {
      var p = new URL(u), h = p.hostname.toLowerCase();
      if (p.protocol !== 'https:' || (p.port && p.port !== '443')) return false;
      return DIRECT_OK_HOSTS.some(function (d) { return h === d || h.slice(-(d.length + 1)) === '.' + d; });
    } catch (e) { return false; }
  }
  function proxify(u) {
    if (!WORKER || typeof u !== 'string' || !u) return u;
    if (u.indexOf(WORKER + '/api/proxy/cctv') === 0) return u;
    if (u.indexOf('/api/proxy/cctv/') === 0) return WORKER + u;
    if (u.charAt(0) === '/') return WORKER + '/api/proxy/cctv?url=' + encodeURIComponent(u);
    if (!/^https?:\/\//i.test(u) || directOk(u)) return u;
    return WORKER + '/api/proxy/cctv?url=' + encodeURIComponent(u);
  }
  // Sumber anti-hotlink: gambar/stream-nya harus lewat proxy Worker dan tanpa Referer dari aplikasi.
  var HOTLINK_RE = /balitower|jakcctv|atcsindonesia|binamarga/i;
  function isHotlink(u) { return !!u && HOTLINK_RE.test(String(u)); }
  // Selalu lewat Worker (tanpa pengecualian DIRECT_OK_HOSTS), termasuk URL http:// dan path relatif.
  function forceProxy(u) {
    if (!WORKER || typeof u !== 'string' || !u) return u;
    if (u.indexOf(WORKER + '/api/proxy/cctv') === 0) return u;
    if (u.indexOf('/api/proxy/cctv/') === 0) return WORKER + u;
    if (u.charAt(0) === '/' || /^https?:\/\//i.test(u)) return WORKER + '/api/proxy/cctv?url=' + encodeURIComponent(u);
    return u;
  }
  function searchUrl(t) { return 'https://www.google.com/search?q=' + encodeURIComponent('live cctv ' + t); }

  function injectCss() {
    if (document.getElementById('cpv-css')) return;
    var s = el('style'); s.id = 'cpv-css';
    s.textContent = [
      '.cpv-btn{display:flex;align-items:center;justify-content:center;gap:6px;min-width:44px;height:44px;padding:0 12px;border-radius:12px;border:2px solid transparent;background:rgba(255,255,255,.97);box-shadow:0 4px 14px rgba(0,0,0,.28);font:600 14px/1 system-ui,sans-serif;color:#1f2937;cursor:pointer}',
      '.cpv-btn[aria-pressed="true"]{border-color:#dc2626;background:#fee2e2;color:#7f1d1d}',
      '.cpv-ico{width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:15px;box-shadow:0 2px 7px rgba(0,0,0,.4);border:2px solid #fff;background:#fff}',
      '.cpv-ico.hls,.cpv-ico.image,.cpv-ico.video,.cpv-ico.iframe,.cpv-ico.auto{background:#fee2e2;border-color:#dc2626}.cpv-ico.off{background:#e5e7eb;border-color:#9ca3af;opacity:.7;filter:grayscale(1)}',
      '.cpv-cl{display:flex;align-items:center;justify-content:center;border-radius:50%;background:rgba(220,38,38,.9);color:#fff;font:700 12px system-ui,sans-serif;border:3px solid rgba(255,255,255,.95);box-shadow:0 2px 8px rgba(0,0,0,.45)}',
      '.cpv-stage img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000}',
      '.cpv-idle{display:flex;flex-direction:column;align-items:center;gap:10px;padding:22px 12px;text-align:center;font-size:12px;line-height:1.4;color:#475569;background:#f1f5f9;border-radius:12px}.cpv-msg small{white-space:pre-line;word-break:break-word}.cpv-warn{font-size:11px;color:#92400e;background:#fef3c7;border-radius:8px;padding:6px 8px;margin-top:6px}.cpv-ico.windy{background:#e0f2fe;border-color:#0284c7}.cpv-ico.portal{background:#f1f5f9;border-color:#64748b}',
      '.cpv-pop .leaflet-popup-content{margin:10px;width:min(320px,calc(100vw - 80px))!important}',
      '.cpv-box{font:14px/1.35 system-ui,sans-serif;color:#111827}',
      '.cpv-title{font-weight:700;margin:0 24px 2px 0}.cpv-sub{font-size:12px;color:#4b5563;margin-bottom:8px}',
      '.cpv-stage{position:relative;width:100%;aspect-ratio:16/9;background:#0f172a;border-radius:10px;overflow:hidden}',
      '.cpv-stage video,.cpv-stage iframe{position:absolute;inset:0;width:100%;height:100%;border:0;background:#000}',
      '.cpv-msg{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:10px;text-align:center;color:#fff;background:rgba(15,23,42,.93);font-size:13px;overflow:auto}',
      '.cpv-msg b{font-size:14px}.cpv-msg small{color:#cbd5e1}',
      '.cpv-row{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}',
      '.cpv-act{flex:1 1 auto;min-height:44px;display:flex;align-items:center;justify-content:center;padding:0 12px;border-radius:10px;border:0;background:#4338ca;color:#fff!important;font:600 13px system-ui,sans-serif;text-align:center;text-decoration:none!important;cursor:pointer}',
      '.cpv-act.alt{background:#e5e7eb;color:#111827!important}',
      '.cpv-note{font-size:11px;color:#6b7280;margin-top:6px}',
      '.cpv-spin{width:26px;height:26px;border-radius:50%;border:3px solid rgba(255,255,255,.3);border-top-color:#fff;animation:cpvs 1s linear infinite}',
      '@keyframes cpvs{to{transform:rotate(360deg)}}@media (prefers-reduced-motion:reduce){.cpv-spin{animation:none}}'
    ].join('\n');
    document.head.appendChild(s);
  }

  /* ---------- Hls.js: diunduh sekali, hanya saat dibutuhkan ---------- */
  var hlsPromise = null;
  function loadHls() {
    if (global.Hls) return Promise.resolve(global.Hls);
    if (hlsPromise) return hlsPromise;
    hlsPromise = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = HLS_SRC; s.async = true; s.crossOrigin = 'anonymous';
      s.onload = function () { global.Hls ? resolve(global.Hls) : reject(new Error('Hls.js tidak tersedia')); };
      s.onerror = function () { hlsPromise = null; reject(new Error('Hls.js gagal diunduh')); };
      document.head.appendChild(s);
    });
    return hlsPromise;
  }

  /* ---------- data dari Worker ---------- */
  // Cache daftar titik di localStorage (TTL 2 jam): bila masih berlaku, Worker tidak dipanggil lagi.
  function lsRead(workerUrl) {
    try {
      var o = JSON.parse(global.localStorage.getItem(LS_LIST_KEY) || 'null');
      if (o && o.w === workerUrl && o.t && Date.now() - o.t < LS_TTL_MS && o.d && o.d.ok) return o;
    } catch (e) {}
    return null;
  }
  function lsWrite(workerUrl, data) {
    try { global.localStorage.setItem(LS_LIST_KEY, JSON.stringify({ w: workerUrl, t: Date.now(), d: data })); } catch (e) {}   // kuota penuh/mode privat: abaikan
  }
  function fetchCams(workerUrl, force) {
    var base = String(workerUrl).replace(/\/$/, '');
    if (!force && shared.data && Date.now() - shared.at < DATA_TTL) return Promise.resolve(shared.data);
    if (!force) { var hit = lsRead(base); if (hit) { shared.data = hit.d; shared.at = Date.now(); return Promise.resolve(hit.d); } }
    if (shared.promise) return shared.promise;
    var ctl = new AbortController(), t = setTimeout(function () { ctl.abort(); }, FETCH_TIMEOUT);
    shared.promise = fetch(base + '/api/cctv', { signal: ctl.signal })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok || !j || !j.ok) throw new Error((j && j.error) || ('HTTP ' + r.status)); return j; }); })
      .then(function (j) { shared.data = j; shared.at = Date.now(); lsWrite(base, j); return j; })
      .catch(function (e) { throw e && e.name === 'AbortError' ? new Error('Server CCTV lambat, coba lagi') : e; })
      .then(function (j) { clearTimeout(t); shared.promise = null; return j; }, function (e) { clearTimeout(t); shared.promise = null; throw e; });
    return shared.promise;
  }

  /* ---------- pemutar (dibuat saat popup dibuka, dihancurkan saat ditutup) ---------- */
  function closePlayer() { if (active) { var a = active; active = null; try { a.destroy(); } catch (e) {} } }
  if (global.addEventListener) global.addEventListener('pagehide', closePlayer);   // halaman ditutup/di-bfcache: hentikan stream

  function actions(cam, extra) {
    var row = el('div', 'cpv-row');
    (extra || []).forEach(function (a) { row.appendChild(a); });
    var portal = https(cam.portalUrl);
    if (portal) { var a = el('a', 'cpv-act', cam.sourceType === 'portal' ? 'Buka Live CCTV' : 'Buka Portal Resmi'); a.href = portal; a.target = '_blank'; a.rel = 'noopener noreferrer'; row.appendChild(a); }
    if (cam.sourceType !== 'windy') { var s = el('a', 'cpv-act alt', 'Cari Live CCTV'); s.href = searchUrl(cam.title); s.target = '_blank'; s.rel = 'noopener noreferrer'; row.appendChild(s); }
    return row;
  }
  function btn(label, fn) { var b = el('button', 'cpv-act alt', esc(label)); b.type = 'button'; b.addEventListener('click', fn); return b; }
  function message(stage, title, hint, spinner) {
    var old = stage.querySelector('.cpv-msg'); if (old) old.remove();
    var m = el('div', 'cpv-msg'); m.setAttribute('role', spinner ? 'status' : 'alert');
    m.innerHTML = (spinner ? '<div class="cpv-spin" aria-hidden="true"></div>' : '') + '<b>' + esc(title) + '</b>' + (hint ? '<small>' + esc(hint) + '</small>' : '');
    stage.appendChild(m); return m;
  }

  function mountIframe(stage, url, title) {
    var f = el('iframe'); f.title = 'Siaran ' + title; f.setAttribute('allow', 'autoplay; fullscreen; picture-in-picture');
    f.setAttribute('referrerpolicy', 'no-referrer'); f.allowFullscreen = true; f.loading = 'lazy';
    f.src = url; stage.appendChild(f);
    return function () { try { f.src = 'about:blank'; } catch (e) {} f.remove(); };
  }

  function mountHls(cam, stage, onFail) {
    var urls = (cam.streamUrls && cam.streamUrls.length ? cam.streamUrls : [cam.streamUrl]).filter(https).map(proxify);
    var video = el('video'); video.muted = true; video.autoplay = true; video.controls = true; video.playsInline = true; video.setAttribute('playsinline', ''); video.setAttribute('aria-label', 'Siaran ' + cam.title);
    stage.appendChild(video);
    var hls = null, idx = 0, dead = false, timer = null, netRetry = 0, mediaRec = 0, native = false, onErr = null;
    function stopTimer() { if (timer) { clearTimeout(timer); timer = null; } }
    function tryPlay() { var p = video.play(); if (p && p.catch) p.catch(function () {}); }
    function onPlaying() { if (dead) return; stopTimer(); var m = stage.querySelector('.cpv-msg'); if (m) m.remove(); }
    function fail(title, hint) { stopTimer(); if (dead) return; destroyEngine(); message(stage, title, hint); onFail(); }
    function next(title, hint) {
      stopTimer(); if (dead) return;
      if (idx + 1 < urls.length) { idx++; netRetry = 0; mediaRec = 0; start(); } else fail(title, hint);
    }
    function destroyEngine() { if (hls) { try { hls.destroy(); } catch (e) {} hls = null; } if (onErr) { video.removeEventListener('error', onErr); onErr = null; } try { video.pause(); video.removeAttribute('src'); video.load(); } catch (e) {} }
    function start() {
      if (dead) return;
      message(stage, 'Menghubungkan ke kamera…', urls.length > 1 ? 'Percobaan ' + (idx + 1) + ' dari ' + urls.length : '', true);
      stopTimer(); timer = setTimeout(function () { next('Stream tidak merespons', 'Kamera mungkin offline atau jaringan lambat.'); }, START_TIMEOUT);
      if (native) { video.src = urls[idx]; video.load(); video.addEventListener('loadedmetadata', tryPlay, { once: true }); return; }
      var Hls = global.Hls;
      if (hls) { try { hls.destroy(); } catch (e) {} }
      hls = new Hls({ xhrSetup: function (xhr, url) { var p = proxify(url); if (p !== url) xhr.open('GET', p, true); }, enableWorker: true, lowLatencyMode: false, manifestLoadingTimeOut: 12000, manifestLoadingMaxRetry: 0, levelLoadingTimeOut: 8000, levelLoadingMaxRetry: 1, fragLoadingTimeOut: 12000, fragLoadingMaxRetry: 1, maxBufferLength: 20 });
      var mine = hls;
      mine.on(Hls.Events.MANIFEST_PARSED, tryPlay);
      mine.on(Hls.Events.ERROR, function (_e, d) {
        if (dead || mine !== hls || !d.fatal) return;
        if (d.type === Hls.ErrorTypes.NETWORK_ERROR) {
          var manifestFail = d.details === Hls.ErrorDetails.MANIFEST_LOAD_ERROR || d.details === Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT;
          if (!manifestFail && netRetry < 1) { netRetry++; mine.startLoad(); return; }
          var code = d.response && d.response.code;
          next('Stream ATCS tidak dapat dibuka', code ? 'Server membalas HTTP ' + code + (code === 403 || code === 404 ? ' (kamera offline atau menolak proxy).' : '.') : 'Proxy Worker/server kamera tidak dapat dijangkau.');
        } else if (d.type === Hls.ErrorTypes.MEDIA_ERROR) {
          if (mediaRec < 2) { mediaRec++; mine.recoverMediaError(); return; }
          next('Video tidak bisa diputar', 'Format video tidak didukung perangkat ini.');
        } else next('Stream tidak dapat dibuka lewat proxy', 'Kamera offline, atau Worker menolak (cek ALLOW_ORIGIN dan CCTV_PROXY_HOSTS).');
      });
      mine.loadSource(urls[idx]); mine.attachMedia(video);
    }
    video.addEventListener('playing', onPlaying);

    if (!urls.length) { fail('Alamat stream tidak tersedia', 'Gunakan tombol portal di bawah.'); }
    else loadHls().then(function (Hls) {
      if (dead) return;
      if (Hls.isSupported()) start();
      else if (video.canPlayType('application/vnd.apple.mpegurl')) { native = true; onErr = function () { next('Stream tidak dapat dibuka lewat proxy', 'Kamera offline, atau Worker menolak (cek ALLOW_ORIGIN dan CCTV_PROXY_HOSTS).'); }; video.addEventListener('error', onErr); start(); }
      else fail('Perangkat ini tidak mendukung HLS', 'Gunakan portal resmi.');
    }).catch(function (e) {
      if (dead) return;
      if (video.canPlayType('application/vnd.apple.mpegurl')) { native = true; onErr = function () { next('Stream tidak dapat dibuka lewat proxy', 'Kamera offline, atau Worker menolak (cek ALLOW_ORIGIN dan CCTV_PROXY_HOSTS).'); }; video.addEventListener('error', onErr); start(); }
      else fail('Pemutar HLS tidak termuat', e.message + '. Periksa koneksi lalu coba lagi.');
    });

    return function destroy() {
      dead = true; stopTimer();
      video.removeEventListener('playing', onPlaying);
      destroyEngine(); video.remove();
    };
  }


  // ---- Periksa alamat kamera lewat proxy: tahu persis kenapa gagal & host mana yang benar ----
  function hostOf(u) { return String(u).replace(/^https?:\/\//, '').split('/')[0]; }
  function probe(url) {
    var ctl = new AbortController(), t = setTimeout(function () { ctl.abort(); }, 9000);
    return fetch(proxify(url), { cache: 'no-store', signal: ctl.signal }).then(function (r) {
      var ct = (r.headers.get('content-type') || '').toLowerCase();
      if (!r.ok) {
        clearTimeout(t);
        return r.json().then(function (j) {
          var msg = (j && j.error) || ('HTTP ' + r.status);
          if (r.status === 404 && !/server kamera/.test(msg)) msg += ' (bila bukan dari server kamera: Worker belum memakai entry.js)';
          return { ok: false, reason: msg };
        }, function () { return { ok: false, reason: 'HTTP ' + r.status }; });
      }
      if (/^image\/|multipart\//.test(ct)) { clearTimeout(t); try { r.body.cancel(); } catch (e) {} return { ok: true, kind: 'image', snap: !/multipart\//.test(ct) }; }
      return r.text().then(function (txt) {
        clearTimeout(t);
        if (txt.replace(/^\uFEFF/, '').trimStart().indexOf('#EXTM3U') === 0) return { ok: true, kind: 'hls' };
        return { ok: false, reason: 'balasan bukan stream (' + (ct.split(';')[0] || 'tanpa tipe') + ')' };
      });
    }).catch(function (e) {
      clearTimeout(t);
      return { ok: false, net: true, reason: e && e.name === 'AbortError' ? 'waktu habis (9 dtk)' : 'Worker tidak dapat dijangkau (belum ter-deploy, ALLOW_ORIGIN tidak cocok, atau diblokir CORS)' };
    });
  }
  function resolveCam(cam) {
    if (cam.resolved) return Promise.resolve(cam.resolved);
    return probe(cam.streamUrl).then(function (r) {
      if (r.ok) cam.resolved = r;
      else r.reason = (cam.relPath || hostOf(cam.streamUrl)) + ' → ' + r.reason;
      return r;
    });
  }

  function mountImage(cam, stage, onFail) {
    var raw = cam.streamUrl, dead = false, timer = null, retried = false;
    var hot = isHotlink(raw) || isHotlink(cam.relPath);                  // balitower / jakcctv / atcsindonesia / binamarga
    var url = hot ? forceProxy(raw) : proxify(raw);                      // domain anti-hotlink: URL proxy didahulukan
    var snap = /\.(jpe?g|png|webp)(\?|$)|\/img\?/i.test(raw) || !!(cam.resolved && cam.resolved.snap);   // snapshot: segarkan berkala; selain itu MJPEG
    var img = el('img'); img.alt = 'Siaran ' + cam.title;
    img.referrerPolicy = hot ? 'no-referrer' : (url !== raw ? 'origin' : 'no-referrer');   // hotlink: tanpa Referer (Worker mengizinkan aset media tanpa Origin/Referer)
    img.decoding = 'async';
    var gotFrame = false;
    function setSrc() { img.src = snap ? url + (url.indexOf('?') < 0 ? '?' : '&') + '_t=' + Date.now() : url; }
    img.addEventListener('load', function () { if (dead) return; gotFrame = true; var m = stage.querySelector('.cpv-msg'); if (m) m.remove(); });
    img.addEventListener('error', function () {
      if (dead) return;
      if (!gotFrame && hot && !retried) { retried = true; img.referrerPolicy = 'origin'; setSrc(); return; }   // Worker lama: coba lagi dengan origin
      clearInterval(timer); timer = null;
      if (gotFrame) return;                                        // satu kali gagal saat menyegarkan: tetap tampilkan frame terakhir
      img.remove(); message(stage, 'Gambar kamera tidak dapat dimuat', 'Kamera offline atau server memblokir pemakaian dari aplikasi ini.');
      if (onFail) onFail();
    });
    stage.appendChild(img); message(stage, 'Menghubungkan ke kamera…', '', true); setSrc();
    if (snap) timer = setInterval(function () { if (!document.hidden) setSrc(); }, 5000);
    return function destroy() { dead = true; clearInterval(timer); try { img.removeAttribute('src'); } catch (e) {} img.remove(); };
  }

  function mountVideo(cam, stage) {
    var v = el('video'); v.muted = true; v.autoplay = true; v.controls = true; v.loop = true; v.playsInline = true; v.setAttribute('playsinline', '');
    v.setAttribute('aria-label', 'Siaran ' + cam.title);
    v.addEventListener('playing', function () { var m = stage.querySelector('.cpv-msg'); if (m) m.remove(); });
    v.addEventListener('error', function () { message(stage, 'Video tidak bisa diputar', 'Format tidak didukung atau server memblokir pemakaian dari aplikasi ini.'); });
    stage.appendChild(v); message(stage, 'Menghubungkan ke kamera…', '', true); v.src = cam.streamUrl;
    return function destroy() { try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e) {} v.remove(); };
  }

  // Isi popup: dipanggil saat popup DIBUKA. Mengembalikan fungsi pembersih.
  // Hemat kuota Worker: pemutar dihancurkan (hls.destroy + video.src dikosongkan) saat popup ditutup, pindah kamera,
  // aplikasi/tab masuk latar belakang, atau setelah 3 menit; setelah itu penonton menekan "Putar Ulang / Lanjut".
  function mount(cam, box) {
    closePlayer();
    box.innerHTML = '';
    box.appendChild(el('div', 'cpv-title', esc(cam.title)));
    box.appendChild(el('div', 'cpv-sub', esc([cam.provider, cam.region].filter(Boolean).join(' • ')) + (cam.approx ? ' • lokasi perkiraan' : '')));
    var disposers = [], cleaned = false, stage = null, stopT = null, idle = null, starter = null, rowHolder = null;
    var type = cam.sourceType;

    function showEmbedFallback() {
      if (!stage || !https(cam.embedUrl)) return;
      var old = stage.querySelector('video'); if (old) old.remove();
      var m = stage.querySelector('.cpv-msg'); if (m) m.remove();
      disposers.push(mountIframe(stage, cam.embedUrl, cam.title));
    }

    function onHlsFail() {
      // semua kandidat HLS gagal: tawarkan pemutar embed resmi
      if (https(cam.embedUrl) && rowHolder && !rowHolder.querySelector('[data-embed]')) {
        var b = btn('Coba pemutar embed resmi', function () { showEmbedFallback(); b.remove(); }); b.setAttribute('data-embed', '1');
        rowHolder.insertBefore(b, rowHolder.firstChild);
      }
    }
    function startProbed() {
      var my = stage;
      message(stage, 'Memeriksa kamera…', '', true);
      resolveCam(cam).then(function (r) {
        if (cleaned || stage !== my) return;                        // sudah ditutup/dihentikan selagi memeriksa
        if (!r.ok) { message(stage, 'Kamera tidak dapat dibuka', r.reason); return; }
        var m = stage.querySelector('.cpv-msg'); if (m) m.remove();
        if (r.kind === 'image') disposers.push(mountImage(cam, stage, null));
        else disposers.push(mountHls({ title: cam.title, streamUrls: [cam.streamUrl] }, stage, onHlsFail));
      });
    }

    // ---- pemutar menurut tipe (dipanggil setiap kali pemutaran dimulai) ----
    if (type === 'windy' && windyHost(cam.playerUrl)) {
      starter = function () { disposers.push(mountIframe(stage, cam.playerUrl, cam.title)); };
      var win = https(cam.portalUrl);
      rowHolder = el('div', 'cpv-note', 'Sumber: ' + (win ? '<a href="' + esc(win) + '" target="_blank" rel="noopener noreferrer">Windy Webcams ↗</a>' : 'Windy Webcams'));
    } else if (type === 'hls') {
      starter = cam.relPath ? startProbed : function () { disposers.push(mountHls(cam, stage, onHlsFail)); };
    } else if (type === 'iframe' && https(cam.embedUrl)) {
      starter = function () { disposers.push(mountIframe(stage, cam.embedUrl, cam.title)); };
    } else if ((type === 'image' || type === 'auto') && https(cam.streamUrl)) {
      // alamat relatif / format tak dikenal: periksa dulu lewat proxy, lalu pilih pemutar yang cocok (HLS atau gambar/MJPEG)
      starter = (cam.relPath || type === 'auto') ? startProbed : function () { disposers.push(mountImage(cam, stage, null)); };
    } else if (type === 'video' && https(cam.streamUrl)) {
      starter = function () { disposers.push(mountVideo(cam, stage)); };
    }

    // ---- siklus hidup pemutaran ----
    function clearIdle() { if (idle) { idle.remove(); idle = null; } }
    function halt(reason) {
      clearTimeout(stopT); stopT = null;
      var d = disposers; disposers = [];
      d.forEach(function (fn) { try { fn(); } catch (e) {} });          // hls.destroy(), video.removeAttribute('src'), dst.
      if (stage) { stage.remove(); stage = null; }
      if (reason && !cleaned) {
        clearIdle();
        idle = el('div', 'cpv-idle', '<div>' + esc(reason) + '</div>');
        idle.appendChild(btn('▶ Putar Ulang / Lanjut', run));
        box.insertBefore(idle, rowHolder);
      }
    }
    function run() {
      if (cleaned || !starter) return;
      halt(); clearIdle();
      stage = el('div', 'cpv-stage'); box.insertBefore(stage, rowHolder);
      starter();
      stopT = setTimeout(function () { halt('Pemutaran dihentikan otomatis setelah 3 menit untuk menghemat kuota.'); }, STOP_AFTER_MS);
    }
    function onVis() { if (document.hidden && stage) halt('Pemutaran dijeda karena aplikasi berada di latar belakang.'); }

    if (starter) {
      if (!rowHolder) rowHolder = actions(cam);
      box.appendChild(rowHolder);
      document.addEventListener('visibilitychange', onVis);
      run();
    } else {
      box.appendChild(el('div', 'cpv-note', 'Titik ini hanya tersedia lewat halaman resmi pengelola.'));
      box.appendChild(actions(cam));
    }
    if (cam.status === 'offline') box.appendChild(el('div', 'cpv-warn', '⚠ Ditandai offline pada audit terakhir.' + (cam.note ? ' ' + esc(cam.note) : '')));
    if (cam.needsHeaders) box.appendChild(el('div', 'cpv-warn', 'Server kamera ini meminta header khusus; mungkin tidak bisa diputar langsung dari browser.'));

    var self = {
      destroy: function () {
        if (cleaned) return; cleaned = true;
        document.removeEventListener('visibilitychange', onVis);
        halt(); clearIdle(); box.innerHTML = '';
      }
    };
    active = self;
    return self;
  }

  /* ---------- dataset statis (cctv-data.json) ---------- */
  function expandStatic(d) {
    var S = d.S, n = d.count, out = new Array(n), TYPE = { h: 'hls', y: 'iframe', e: 'iframe', i: 'image', v: 'video', a: 'auto', p: 'portal' };
    for (var i = 0; i < n; i++) {
      var k = d.k.charAt(i), f = d.f[i], u = d.u[i] || '', type = TYPE[k] || 'portal';
      var rel = ''; if (u && u.charAt(0) === '/') { rel = u; u = proxify(u); }   // relatif: Worker yang memetakan upstream-nya
      var pu = d.pu[i] >= 0 ? S[d.pu[i]] : null, reg = [d.ci[i] >= 0 ? S[d.ci[i]] : '', d.pr[i] >= 0 ? S[d.pr[i]] : ''].filter(Boolean);
      if (reg.length === 2 && reg[0] === reg[1]) reg.pop();
      var st = d.s.charAt(i);
      out[i] = {
        relPath: rel, id: 's:' + d.i[i], title: d.t[i], lat: d.la[i], lng: d.ln[i], sourceType: type,
        streamUrl: u, streamUrls: type === 'hls' ? [u] : [], embedUrl: type === 'iframe' ? u : null,
        portalUrl: https(pu), provider: d.so[i] >= 0 ? S[d.so[i]] : '', region: reg.join(', '),
        approx: !!(f & 1), needsHeaders: !!(f & 2), status: st === '1' ? 'offline' : st === '0' ? 'live' : '', note: d.n[i] >= 0 ? S[d.n[i]] : ''
      };
    }
    return out;
  }
  function fetchStatic(url) {
    if (stat.cams) return Promise.resolve(stat.cams);
    if (stat.promise) return stat.promise;
    stat.promise = fetch(url).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) { stat.cams = expandStatic(d); stat.promise = null; return stat.cams; })
      .catch(function (e) { stat.promise = null; throw e; });
    return stat.promise;
  }

  /* ---------- marker & layer (clustering sederhana per sel grid + hanya yang terlihat di layar) ---------- */
  var EMO = { hls: '🔴', windy: '🌐', portal: '🔗', image: '📷', video: '🎞️', iframe: '▶️', auto: '📹' };
  var iconCache = {};
  function icon(type, off) {
    var key = type + (off ? '!' : '');
    if (iconCache[key]) return iconCache[key];
    return (iconCache[key] = L.divIcon({ className: '', iconSize: [28, 28], iconAnchor: [14, 14], popupAnchor: [0, -12], html: '<div class="cpv-ico ' + esc(type) + (off ? ' off' : '') + '">' + (EMO[type] || '📹') + '</div>' }));
  }
  function clusterIcon(n) {
    var size = n < 100 ? 36 : n < 1000 ? 42 : 50, label = n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n);
    return L.divIcon({ className: '', iconSize: [size, size], iconAnchor: [size / 2, size / 2], html: '<div class="cpv-cl" style="width:' + size + 'px;height:' + size + 'px">' + label + '</div>' });
  }

  function makeMarker(cam) {
    var box = el('div', 'cpv-box');
    var m = L.marker([cam.lat, cam.lng], { icon: icon(cam.sourceType, cam.status === 'offline'), keyboard: true, title: cam.title, alt: 'CCTV ' + cam.title, riseOnHover: true });
    m.bindPopup(box, { className: 'cpv-pop', maxWidth: 340, autoPanPadding: [20, 70] });
    var handle = null;
    m.on('popupopen', function () { handle = mount(cam, box); });
    m.on('popupclose', function () { if (handle) { handle.destroy(); if (active === handle) active = null; handle = null; } });
    return m;
  }

  function draw(st) {
    var list = st.cams || [], map = st.map;
    if (!st.on || !list.length) return;
    var z = map.getZoom(), b = map.getBounds().pad(0.15);
    var s = b.getSouth(), n = b.getNorth(), w = b.getWest(), e = b.getEast();
    var cell = z >= 16 ? 0 : CLUSTER_PX * 360 / (256 * Math.pow(2, z));
    var buckets = new Map(), singles = [], clusters = [];
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (c.lat < s || c.lat > n || c.lng < w || c.lng > e) continue;
      if (!cell) { singles.push(c); continue; }
      var key = Math.floor(c.lng / cell) + ':' + Math.floor(c.lat / cell), g = buckets.get(key);
      if (!g) buckets.set(key, { n: 1, first: c, sla: c.lat, sln: c.lng, a: c.lat, b: c.lat, c: c.lng, d: c.lng });
      else { g.n++; g.sla += c.lat; g.sln += c.lng; if (c.lat < g.a) g.a = c.lat; if (c.lat > g.b) g.b = c.lat; if (c.lng < g.c) g.c = c.lng; if (c.lng > g.d) g.d = c.lng; }
    }
    buckets.forEach(function (g) { if (g.n === 1) singles.push(g.first); else clusters.push(g); });
    if (singles.length > MAX_SINGLE) singles.length = MAX_SINGLE;

    var want = new Set(); singles.forEach(function (c) { want.add(c.id); });
    st.markers.forEach(function (m, id) { if (!want.has(id) && !m.isPopupOpen()) { st.group.removeLayer(m); st.markers.delete(id); } });   // marker dengan popup terbuka tidak dibuang
    singles.forEach(function (c) { if (!st.markers.has(c.id)) { var m = makeMarker(c); m.addTo(st.group); st.markers.set(c.id, m); } });

    st.clusterGroup.clearLayers();
    clusters.forEach(function (g) {
      var m = L.marker([g.sla / g.n, g.sln / g.n], { icon: clusterIcon(g.n), keyboard: false, title: g.n + ' kamera' });
      m.on('click', function () {
        if (g.b - g.a < 1e-4 && g.d - g.c < 1e-4) map.setView([g.a, g.c], Math.min(map.getMaxZoom() || 18, z + 3));
        else map.fitBounds([[g.a, g.c], [g.b, g.d]], { padding: [40, 40], maxZoom: 18 });
      });
      m.addTo(st.clusterGroup);
    });
  }
  function scheduleDraw(st) { clearTimeout(st.drawT); st.drawT = setTimeout(function () { draw(st); }, 120); }

  function say(st, msg, err) { try { if (st.opts.onStatus) st.opts.onStatus(msg, !!err); } catch (e) {} }
  function sync(st) { if (st.btn) st.btn.setAttribute('aria-pressed', st.on ? 'true' : 'false'); }
  function fmt(n) { try { return n.toLocaleString('id-ID'); } catch (e) { return String(n); } }

  function load(st, force) {
    st.loading = true;
    var pw = fetchCams(st.opts.workerUrl, force).then(function (j) { return { j: j }; }, function (e) { return { err: e }; });
    var ps = fetchStatic(st.opts.dataUrl || STATIC_URL).then(function (c) { return { cams: c }; }, function (e) { return { err: e }; });
    return Promise.all([pw, ps]).then(function (r) {
      st.loading = false; if (!st.on) return;
      var wj = r[0].j, sc = r[1].cams, cams = [], seen = new Set();
      // Worker (Windy/JakCCTV/statis Worker) lebih dulu; titik dataset statis dengan stream sama dilewati agar tidak dobel.
      ((wj && wj.cameras) || []).forEach(function (c) { cams.push(c); [c.streamUrl, c.playerUrl].forEach(function (u) { if (u) seen.add(u); }); });
      (sc || []).forEach(function (c) { if (!(c.streamUrl && seen.has(c.streamUrl))) cams.push(c); });
      if (!cams.length) { say(st, 'CCTV gagal dimuat: ' + ((r[1].err || r[0].err || {}).message || 'data kosong'), true); return; }
      st.cams = cams; st.markers.forEach(function (m) { st.group.removeLayer(m); }); st.markers.clear();
      draw(st);
      var live = 0; cams.forEach(function (c) { if (c.status !== 'offline') live++; });
      var msg = 'CCTV publik: ' + fmt(cams.length) + ' titik (' + fmt(live) + ' live)';
      var w = wj && wj.sources && wj.sources.windy;
      if (r[1].err) msg += ' — dataset statis gagal dimuat';
      else if (r[0].err) msg += ' — server Worker tidak terjangkau';
      else if (w && w.configured === false) msg += ' (Windy belum aktif di server)';
      else if (w && w.error) msg += ' (Windy: ' + w.error + ')';
      say(st, msg, !!(r[1].err && r[0].err));
    });
  }

  function setOn(map, on) {
    var st = states.get(map); if (!st) return;
    st.on = !!on; lsSet(KEY_ON, on ? '1' : '0'); sync(st);
    if (on) { st.group.addTo(map); st.clusterGroup.addTo(map); map.on('moveend', st.onMove); load(st, false); }
    else { closePlayer(); map.off('moveend', st.onMove); map.removeLayer(st.group); map.removeLayer(st.clusterGroup); st.group.clearLayers(); st.clusterGroup.clearLayers(); st.markers.clear(); say(st, 'CCTV publik: sembunyi', false); }
  }

  function attach(map, opts) {
    opts = opts || {};
    if (!map || !opts.workerUrl) { console.warn('[cctv] workerUrl wajib diisi'); return null; }
    if (states.has(map)) return states.get(map);
    injectCss();
    WORKER = String(opts.workerUrl).replace(/\/$/, '');
    var st = { map: map, opts: opts, group: L.layerGroup(), clusterGroup: L.layerGroup(), markers: new Map(), cams: null, on: false, btn: null, loading: false, drawT: null };
    st.onMove = function () { scheduleDraw(st); };
    states.set(map, st);
    if (opts.control !== false) {
      var Ctl = L.Control.extend({
        onAdd: function () {
          var b = el('button', 'cpv-btn', '🎥 <span>CCTV</span>'); b.type = 'button'; b.setAttribute('aria-label', 'Tampilkan atau sembunyikan CCTV publik'); b.setAttribute('aria-pressed', 'false');
          L.DomEvent.disableClickPropagation(b); L.DomEvent.on(b, 'click', function () { setOn(map, !st.on); });
          st.btn = b; return b;
        }
      });
      new Ctl({ position: opts.position || 'topleft' }).addTo(map);
    }
    // bersihkan pemutar bila peta dibuang/disembunyikan
    map.on('unload', function () { closePlayer(); states.delete(map); });
    if (lsGet(KEY_ON) === '1') setOn(map, true);
    return st;
  }

  function detach(map) { var st = states.get(map); if (!st) return; closePlayer(); map.off('moveend', st.onMove); map.removeLayer(st.group); map.removeLayer(st.clusterGroup); st.group.clearLayers(); st.clusterGroup.clearLayers(); st.markers.clear(); states.delete(map); }

  /* ---------- pencarian CCTV terdekat (keluarga di tab Lokasi & jalur navigasi) ---------- */
  function distM(aLat, aLng, bLat, bLng) {
    var k = Math.PI / 180, x = (bLng - aLng) * k * Math.cos((aLat + bLat) / 2 * k), y = (bLat - aLat) * k;
    return Math.sqrt(x * x + y * y) * 6371000;
  }
  // Semua titik yang diketahui: daftar Worker (bila sudah dimuat) + dataset statis; yang offline dibuang.
  function allCams() {
    return fetchStatic(STATIC_URL).then(function (c) { return c; }, function () { return []; }).then(function (sc) {
      var out = [], seen = new Set();
      ((shared.data && shared.data.cameras) || []).forEach(function (c) {
        if (typeof c.lat !== 'number' || typeof c.lng !== 'number' || c.status === 'offline') return;
        out.push(c); [c.streamUrl, c.playerUrl].forEach(function (u) { if (u) seen.add(u); });
      });
      (sc || []).forEach(function (c) { if (c.status !== 'offline' && !(c.streamUrl && seen.has(c.streamUrl))) out.push(c); });
      return out;
    });
  }
  // CCTV dalam radius (meter) dari satu titik: [{ cam, dist }] terdekat dulu.
  function nearby(lat, lng, radiusM, limit) {
    return allCams().then(function (cams) {
      var dLat = radiusM / 111000, dLng = radiusM / (111000 * Math.max(0.2, Math.cos(lat * Math.PI / 180))), out = [];
      for (var i = 0; i < cams.length; i++) {
        var c = cams[i];
        if (Math.abs(c.lat - lat) > dLat || Math.abs(c.lng - lng) > dLng) continue;
        var d = distM(lat, lng, c.lat, c.lng);
        if (d <= radiusM) out.push({ cam: c, dist: d });
      }
      out.sort(function (a, b) { return a.dist - b.dist; });
      return out.slice(0, limit || 5);
    });
  }
  // CCTV di sepanjang jalur (pts = [{lat,lng}]), selisih maksimal offM meter: [{ cam, off, idx, t }] (idx = ruas terdekat, t = posisi 0..1 di ruas itu).
  function alongRoute(pts, offM, limit) {
    return allCams().then(function (cams) {
      if (!pts || pts.length < 2) return [];
      var n = pts.length - 1, segs = new Array(n), minLa = 90, maxLa = -90, minLn = 180, maxLn = -180, i, j;
      var padLa = offM / 111000 * 1.2;
      for (i = 0; i < n; i++) {
        var a = pts[i], b = pts[i + 1];
        segs[i] = { la0: Math.min(a.lat, b.lat) - padLa, la1: Math.max(a.lat, b.lat) + padLa, ln0: Math.min(a.lng, b.lng), ln1: Math.max(a.lng, b.lng) };
        minLa = Math.min(minLa, segs[i].la0); maxLa = Math.max(maxLa, segs[i].la1); minLn = Math.min(minLn, segs[i].ln0); maxLn = Math.max(maxLn, segs[i].ln1);
      }
      var padLn = offM / (111000 * Math.max(0.2, Math.cos((minLa + maxLa) / 2 * Math.PI / 180))) * 1.2;
      var out = [];
      for (j = 0; j < cams.length; j++) {
        var c = cams[j];
        if (c.lat < minLa || c.lat > maxLa || c.lng < minLn - padLn || c.lng > maxLn + padLn) continue;
        var kx = 111320 * Math.cos(c.lat * Math.PI / 180), ky = 110540, best = Infinity, bi = -1, bt = 0;
        for (i = 0; i < n; i++) {
          var s = segs[i];
          if (c.lat < s.la0 || c.lat > s.la1 || c.lng < s.ln0 - padLn || c.lng > s.ln1 + padLn) continue;
          var p = pts[i], q = pts[i + 1];
          var ax = (p.lng - c.lng) * kx, ay = (p.lat - c.lat) * ky, bx = (q.lng - c.lng) * kx, by = (q.lat - c.lat) * ky;
          var dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy, t = l2 ? -(ax * dx + ay * dy) / l2 : 0;
          t = Math.max(0, Math.min(1, t));
          var d = Math.sqrt(Math.pow(ax + t * dx, 2) + Math.pow(ay + t * dy, 2));
          if (d < best) { best = d; bi = i; bt = t; }
        }
        if (bi >= 0 && best <= offM) out.push({ cam: c, off: best, idx: bi, t: bt });
      }
      out.sort(function (x, y) { return (x.idx + x.t) - (y.idx + y.t); });
      return limit ? out.slice(0, limit) : out;
    });
  }

  global.CctvPublic = {
    nearby: nearby, alongRoute: alongRoute, distM: distM,
    mount: function (cam, box) { injectCss(); return mount(cam, box); },     // pemutar langsung di dalam elemen mana pun (satu pemutar aktif sekaligus)
    marker: function (cam) { injectCss(); return makeMarker(cam); },         // marker Leaflet dengan popup pemutar
    attach: attach, detach: detach, closePlayer: closePlayer,
    toggle: function (map) { var st = states.get(map); if (st) setOn(map, !st.on); return st ? st.on : false; },
    isOn: function (map) { var st = states.get(map); return !!(st && st.on); },
    refresh: function (map) { var st = states.get(map); if (st && st.on) return load(st, true); }
  };
})(window);
