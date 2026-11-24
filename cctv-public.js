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
  var FETCH_TIMEOUT = 15000;
  var START_TIMEOUT = 12000;     // per kandidat stream
  var KEY_ON = 'cctv_public_on_v1';

  var states = new Map();        // map -> state
  var shared = { data: null, at: 0, promise: null };
  var active = null;             // pemutar yang sedang aktif { destroy() }

  /* ---------- util ---------- */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function https(u) { return typeof u === 'string' && /^https:\/\//i.test(u) ? u : null; }
  function windyHost(u) { return https(u) && /^https:\/\/([a-z0-9-]+\.)*windy\.com\//i.test(u) ? u : null; }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function el(tag, cls, html) { var n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; }
  function searchUrl(t) { return 'https://www.google.com/search?q=' + encodeURIComponent('live cctv ' + t); }

  function injectCss() {
    if (document.getElementById('cpv-css')) return;
    var s = el('style'); s.id = 'cpv-css';
    s.textContent = [
      '.cpv-btn{display:flex;align-items:center;justify-content:center;gap:6px;min-width:44px;height:44px;padding:0 12px;border-radius:12px;border:2px solid transparent;background:rgba(255,255,255,.97);box-shadow:0 4px 14px rgba(0,0,0,.28);font:600 14px/1 system-ui,sans-serif;color:#1f2937;cursor:pointer}',
      '.cpv-btn[aria-pressed="true"]{border-color:#dc2626;background:#fee2e2;color:#7f1d1d}',
      '.cpv-ico{width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:15px;box-shadow:0 2px 7px rgba(0,0,0,.4);border:2px solid #fff;background:#fff}',
      '.cpv-ico.hls{background:#fee2e2;border-color:#dc2626}.cpv-ico.windy{background:#e0f2fe;border-color:#0284c7}.cpv-ico.portal{background:#f1f5f9;border-color:#64748b}',
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
  function fetchCams(workerUrl, force) {
    if (!force && shared.data && Date.now() - shared.at < DATA_TTL) return Promise.resolve(shared.data);
    if (shared.promise) return shared.promise;
    var ctl = new AbortController(), t = setTimeout(function () { ctl.abort(); }, FETCH_TIMEOUT);
    shared.promise = fetch(String(workerUrl).replace(/\/$/, '') + '/api/cctv', { signal: ctl.signal })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok || !j || !j.ok) throw new Error((j && j.error) || ('HTTP ' + r.status)); return j; }); })
      .then(function (j) { shared.data = j; shared.at = Date.now(); return j; })
      .catch(function (e) { throw e && e.name === 'AbortError' ? new Error('Server CCTV lambat, coba lagi') : e; })
      .then(function (j) { clearTimeout(t); shared.promise = null; return j; }, function (e) { clearTimeout(t); shared.promise = null; throw e; });
    return shared.promise;
  }

  /* ---------- pemutar (dibuat saat popup dibuka, dihancurkan saat ditutup) ---------- */
  function closePlayer() { if (active) { var a = active; active = null; try { a.destroy(); } catch (e) {} } }

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
    var urls = (cam.streamUrls && cam.streamUrls.length ? cam.streamUrls : [cam.streamUrl]).filter(https);
    var video = el('video'); video.muted = true; video.autoplay = true; video.controls = true; video.playsInline = true; video.setAttribute('playsinline', ''); video.setAttribute('aria-label', 'Siaran ' + cam.title);
    stage.appendChild(video);
    var hls = null, idx = 0, dead = false, timer = null, netRetry = 0, mediaRec = 0, native = false, onErr = null;
    function stopTimer() { if (timer) { clearTimeout(timer); timer = null; } }
    function tryPlay() { var p = video.play(); if (p && p.catch) p.catch(function () {}); }
    function onPlaying() { if (dead) return; stopTimer(); var m = stage.querySelector('.cpv-msg'); if (m) m.remove(); }
    function onHide() {
      if (dead) return;
      if (document.hidden) { if (hls) hls.stopLoad(); video.pause(); }
      else { if (hls) hls.startLoad(); tryPlay(); }
    }
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
      hls = new Hls({ enableWorker: true, lowLatencyMode: false, manifestLoadingTimeOut: 8000, manifestLoadingMaxRetry: 0, levelLoadingTimeOut: 8000, levelLoadingMaxRetry: 1, fragLoadingTimeOut: 12000, fragLoadingMaxRetry: 1, maxBufferLength: 20 });
      var mine = hls;
      mine.on(Hls.Events.MANIFEST_PARSED, tryPlay);
      mine.on(Hls.Events.ERROR, function (_e, d) {
        if (dead || mine !== hls || !d.fatal) return;
        if (d.type === Hls.ErrorTypes.NETWORK_ERROR) {
          var manifestFail = d.details === Hls.ErrorDetails.MANIFEST_LOAD_ERROR || d.details === Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT;
          if (!manifestFail && netRetry < 1) { netRetry++; mine.startLoad(); return; }
          var code = d.response && d.response.code;
          next('Stream ATCS sedang offline atau dibatasi CORS', code ? 'Server membalas HTTP ' + code + '.' : 'Server tidak dapat dijangkau atau memblokir pemakaian dari aplikasi ini.');
        } else if (d.type === Hls.ErrorTypes.MEDIA_ERROR) {
          if (mediaRec < 2) { mediaRec++; mine.recoverMediaError(); return; }
          next('Video tidak bisa diputar', 'Format video tidak didukung perangkat ini.');
        } else next('Stream ATCS sedang offline atau dibatasi CORS', '');
      });
      mine.loadSource(urls[idx]); mine.attachMedia(video);
    }
    video.addEventListener('playing', onPlaying);
    document.addEventListener('visibilitychange', onHide);

    if (!urls.length) { fail('Alamat stream tidak tersedia', 'Gunakan tombol portal di bawah.'); }
    else loadHls().then(function (Hls) {
      if (dead) return;
      if (Hls.isSupported()) start();
      else if (video.canPlayType('application/vnd.apple.mpegurl')) { native = true; onErr = function () { next('Stream ATCS sedang offline atau dibatasi CORS', ''); }; video.addEventListener('error', onErr); start(); }
      else fail('Perangkat ini tidak mendukung HLS', 'Gunakan portal resmi.');
    }).catch(function (e) {
      if (dead) return;
      if (video.canPlayType('application/vnd.apple.mpegurl')) { native = true; onErr = function () { next('Stream ATCS sedang offline atau dibatasi CORS', ''); }; video.addEventListener('error', onErr); start(); }
      else fail('Pemutar HLS tidak termuat', e.message + '. Periksa koneksi lalu coba lagi.');
    });

    return function destroy() {
      dead = true; stopTimer();
      document.removeEventListener('visibilitychange', onHide);
      video.removeEventListener('playing', onPlaying);
      destroyEngine(); video.remove();
    };
  }

  // Isi popup: dipanggil saat popup DIBUKA. Mengembalikan fungsi pembersih.
  function mount(cam, box) {
    closePlayer();
    box.innerHTML = '';
    box.appendChild(el('div', 'cpv-title', esc(cam.title)));
    box.appendChild(el('div', 'cpv-sub', esc(cam.provider || '') + (cam.approx ? ' • lokasi perkiraan' : '')));
    var disposers = [];
    var cleaned = false;
    var stage = null;

    function showEmbedFallback() {
      if (!stage || !https(cam.embedUrl)) return;
      var old = stage.querySelector('video'); if (old) old.remove();
      var m = stage.querySelector('.cpv-msg'); if (m) m.remove();
      disposers.push(mountIframe(stage, cam.embedUrl, cam.title));
    }

    if (cam.sourceType === 'windy' && windyHost(cam.playerUrl)) {
      stage = el('div', 'cpv-stage'); box.appendChild(stage);
      disposers.push(mountIframe(stage, cam.playerUrl, cam.title));
      var win = https(cam.portalUrl);
      box.appendChild(el('div', 'cpv-note', 'Sumber: ' + (win ? '<a href="' + esc(win) + '" target="_blank" rel="noopener noreferrer">Windy Webcams ↗</a>' : 'Windy Webcams')));
    } else if (cam.sourceType === 'hls') {
      stage = el('div', 'cpv-stage'); box.appendChild(stage);
      var extra = [];
      var rowHolder = null;
      disposers.push(mountHls(cam, stage, function () {
        // semua kandidat HLS gagal: tawarkan pemutar embed resmi
        if (https(cam.embedUrl) && rowHolder && !rowHolder.querySelector('[data-embed]')) {
          var b = btn('Coba pemutar embed resmi', function () { showEmbedFallback(); b.remove(); }); b.setAttribute('data-embed', '1');
          rowHolder.insertBefore(b, rowHolder.firstChild);
        }
      }));
      rowHolder = actions(cam, extra); box.appendChild(rowHolder);
    } else {
      box.appendChild(el('div', 'cpv-note', 'Titik ini hanya tersedia lewat halaman resmi pengelola.'));
      box.appendChild(actions(cam));
    }

    var self = {
      destroy: function () {
        if (cleaned) return; cleaned = true;
        disposers.forEach(function (d) { try { d(); } catch (e) {} });
        disposers = []; box.innerHTML = '';
      }
    };
    active = self;
    return self;
  }

  /* ---------- marker & layer ---------- */
  var EMO = { hls: '🔴', windy: '🌐', portal: '🔗' };
  var iconCache = {};
  function icon(type) {
    if (iconCache[type]) return iconCache[type];
    return (iconCache[type] = L.divIcon({ className: '', iconSize: [28, 28], iconAnchor: [14, 14], popupAnchor: [0, -12], html: '<div class="cpv-ico ' + esc(type) + '">' + (EMO[type] || '📹') + '</div>' }));
  }

  function draw(st) {
    st.group.clearLayers();
    var list = (shared.data && shared.data.cameras) || [];
    list.forEach(function (cam) {
      var lat = Number(cam.lat), lng = Number(cam.lng);
      if (!isFinite(lat) || !isFinite(lng)) return;
      var box = el('div', 'cpv-box');
      var m = L.marker([lat, lng], { icon: icon(cam.sourceType), keyboard: true, title: cam.title, alt: 'CCTV ' + cam.title, riseOnHover: true });
      m.bindPopup(box, { className: 'cpv-pop', maxWidth: 340, autoPanPadding: [20, 70] });
      var handle = null;
      m.on('popupopen', function () { handle = mount(cam, box); });
      m.on('popupclose', function () { if (handle) { handle.destroy(); if (active === handle) active = null; handle = null; } });
      m.addTo(st.group);
    });
  }

  function say(st, msg, err) { try { if (st.opts.onStatus) st.opts.onStatus(msg, !!err); } catch (e) {} }
  function sync(st) { if (st.btn) st.btn.setAttribute('aria-pressed', st.on ? 'true' : 'false'); }

  function load(st, force) {
    st.loading = true;
    return fetchCams(st.opts.workerUrl, force).then(function (j) {
      st.loading = false; if (!st.on) return;
      draw(st);
      var w = j.sources && j.sources.windy;
      var msg = 'CCTV publik: ' + j.count + ' titik';
      if (w && w.configured === false) msg += ' (Windy belum aktif di server)';
      else if (w && w.error) msg += ' (Windy: ' + w.error + ')';
      say(st, msg, !!(w && w.error && !w.count));
    }).catch(function (e) { st.loading = false; say(st, 'CCTV gagal dimuat: ' + (e.message || e), true); });
  }

  function setOn(map, on) {
    var st = states.get(map); if (!st) return;
    st.on = !!on; lsSet(KEY_ON, on ? '1' : '0'); sync(st);
    if (on) { st.group.addTo(map); load(st, false); }
    else { closePlayer(); map.removeLayer(st.group); st.group.clearLayers(); say(st, 'CCTV publik: sembunyi', false); }
  }

  function attach(map, opts) {
    opts = opts || {};
    if (!map || !opts.workerUrl) { console.warn('[cctv] workerUrl wajib diisi'); return null; }
    if (states.has(map)) return states.get(map);
    injectCss();
    var st = { map: map, opts: opts, group: L.layerGroup(), on: false, btn: null, loading: false };
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

  function detach(map) { var st = states.get(map); if (!st) return; closePlayer(); map.removeLayer(st.group); st.group.clearLayers(); states.delete(map); }

  global.CctvPublic = {
    attach: attach, detach: detach, closePlayer: closePlayer,
    toggle: function (map) { var st = states.get(map); if (st) setOn(map, !st.on); return st ? st.on : false; },
    isOn: function (map) { var st = states.get(map); return !!(st && st.on); },
    refresh: function (map) { var st = states.get(map); if (st && st.on) return load(st, true); }
  };
})(window);
