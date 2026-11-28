/* =====================================================================================
 * traffic-layer.js — overlay lalu lintas TomTom + indikator kelancaran untuk peta Leaflet.
 * Pola sama dengan bmkg-layers.js / map-pro.js: satu <script>, lalu satu baris attach per peta.
 *
 *   TrafficLayer.attach(map, {
 *     workerUrl,                 // https://gps-worker.xxx.workers.dev  (WAJIB)
 *     position: 'topright',      // pojok tombol 🚦 (bertumpuk di bawah kontrol lain di pojok yang sama)
 *     getPosition: () => ({ lat, lon|lng, speed? }) | null,   // posisi GPS kendaraan; tanpa ini hanya overlay
 *     statusEl: element,         // (opsional) tulis chip status ke elemen ini, bukan ke peta
 *     defaultOn: true,           // keadaan awal bila belum pernah di-toggle
 *     minZoom: 8,                // di bawah zoom ini tile tidak diminta (hemat kuota)
 *     refreshMs: 180000,         // segarkan tile tiap 3 mnt saat tab terlihat (0 = mati)
 *     onStatus: (st, map) => {}  // callback tiap status baru
 *   })
 *   TrafficLayer.get(map) -> { isOn(), setOn(b), toggle(), check(), status(), layer }
 *
 * Layer ada di pane khusus z-index 250: DI ATAS basemap (200), DI BAWAH garis rute (400),
 * marker GPS / CCTV (600) dan popup (700).
 * Hemat kuota status: fetch hanya bila posisi bergeser >= 200 m ATAU data > 3 mnt; saat diam
 * (speed < 3 km/j) cukup tiap 10 mnt; tab tersembunyi = berhenti; gagal = backoff.
 * ===================================================================================== */
(function (global) {
  'use strict';
  var L = global.L;
  if (!L) { console.warn('[traffic-layer] Leaflet belum dimuat'); return; }

  var KEY = 'trf_on';
  var MOVE_M = 200, EVERY_MS = 180000, STILL_MS = 600000, STALE_MS = 360000, POLL_MS = 15000, MOVING_KMH = 3;
  var BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

  var CSS = '' +
    '.trf-ctl{display:flex;flex-direction:column;align-items:flex-end;gap:6px}' +
    '.trf-ctl.l{align-items:flex-start}' +
    '.trf-ctl .leaflet-bar a.trf-btn{display:flex;align-items:center;justify-content:center;width:34px;height:34px;font-size:18px;line-height:1;text-decoration:none;background:#fff;color:#111827;opacity:.8}' +
    '.trf-ctl .leaflet-bar a.trf-btn[aria-pressed=true]{opacity:1;box-shadow:inset 0 0 0 2px #16a34a}' +
    '.trf-ctl.offz .leaflet-bar a.trf-btn{opacity:.5}' +
    '.trf-chip{font:700 12px/1.25 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:4px 9px;border-radius:99px;background:#fff;color:#111827;white-space:nowrap}' +
    '.trf-ctl .trf-chip{box-shadow:0 1px 5px rgba(0,0,0,.35)}' +
    '.trf-chip.trf-hide{display:none}' +
    '.trf-chip.trf-lancar{background:#dcfce7;color:#166534}' +
    '.trf-chip.trf-padat{background:#fef3c7;color:#92400e}' +
    '.trf-chip.trf-macet{background:#fee2e2;color:#991b1b}' +
    '.trf-chip.trf-ditutup{background:#1f2937;color:#fff}' +
    '.trf-chip.trf-stale{opacity:.6}' +
    '@media (prefers-color-scheme:dark){' +
    '.trf-ctl .leaflet-bar a.trf-btn{background:#1f2937;color:#f3f4f6}' +
    '.trf-chip.trf-lancar{background:#14532d;color:#bbf7d0}' +
    '.trf-chip.trf-padat{background:#78350f;color:#fde68a}' +
    '.trf-chip.trf-macet{background:#7f1d1d;color:#fecaca}}';

  function injectCss() {
    if (document.getElementById('trf-css')) return;
    var s = document.createElement('style'); s.id = 'trf-css'; s.textContent = CSS; document.head.appendChild(s);
  }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* abaikan */ } }
  function dist(a, b) {
    var R = 6371000, r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function attach(map, opts) {
    if (!map) return null;
    if (map._trf) return map._trf;
    opts = opts || {};
    var base = String(opts.workerUrl || '').replace(/\/+$/, '');
    if (!base) { console.warn('[traffic-layer] workerUrl wajib diisi'); return null; }
    injectCss();

    var minZoom = opts.minZoom == null ? 8 : opts.minZoom;
    var refreshMs = opts.refreshMs == null ? EVERY_MS : opts.refreshMs;
    var statusOn = typeof opts.getPosition === 'function';
    var pos = opts.position || 'topright';

    /* ---------- tile layer di pane sendiri ---------- */
    var pane = map.getPane('trafficPane') || map.createPane('trafficPane');
    pane.style.zIndex = 250; pane.style.pointerEvents = 'none';
    var layer = L.tileLayer(base + '/api/traffic-tile/{z}/{x}/{y}.png', {
      pane: 'trafficPane', opacity: 0.85, maxZoom: 20, minZoom: minZoom, tileSize: 256,
      errorTileUrl: BLANK, updateWhenIdle: true, updateWhenZooming: false, keepBuffer: 1,
      attribution: 'Lalu lintas © <a href="https://www.tomtom.com" target="_blank" rel="noopener">TomTom</a>'
    });

    var saved = lsGet(KEY);
    var on = saved === null ? opts.defaultOn !== false : saved === '1';
    var T = { last: null, lastPos: null, lastAt: 0, busy: false, nextOkAt: 0, failN: 0, lastErr: '' };

    /* ---------- kontrol: tombol 🚦 + chip status ---------- */
    var Ctl = L.Control.extend({
      options: { position: pos },
      onAdd: function () {
        var d = L.DomUtil.create('div', 'trf-ctl' + (/left/.test(pos) ? ' l' : ''));
        d.innerHTML = '<div class="leaflet-bar"><a href="#" role="button" class="trf-btn" aria-pressed="false" aria-label="Lalu lintas" title="Lalu lintas real-time (TomTom)">🚦</a></div>' +
          '<div class="trf-chip trf-hide" aria-live="polite"></div>';
        L.DomEvent.disableClickPropagation(d); L.DomEvent.disableScrollPropagation(d);
        d.querySelector('a').addEventListener('click', function (e) { e.preventDefault(); api.toggle(); });
        return d;
      }
    });
    var ctl = new Ctl().addTo(map);
    var root = ctl.getContainer(), btn = root.querySelector('.trf-btn'), mapChip = root.querySelector('.trf-chip');
    var chip = opts.statusEl || mapChip;

    function render() {
      btn.setAttribute('aria-pressed', String(on));
      root.classList.toggle('offz', on && map.getZoom() < minZoom);
      btn.title = on ? (map.getZoom() < minZoom ? 'Lalu lintas aktif — dekatkan peta (zoom ' + minZoom + '+) untuk melihat warna jalan' : 'Lalu lintas aktif — ketuk untuk mematikan') : 'Lalu lintas mati — ketuk untuk menyalakan';
      if (!chip) return;
      var st = T.last, text = '', cls = '';
      if (!on || !statusOn) { text = ''; }
      else if (!st) { text = opts.statusEl ? '🚦 menunggu…' : ''; }
      else if (st.level === 'unknown') { text = opts.statusEl ? '🚦 –' : ''; }
      else if (st.level === 'ditutup') { text = '🚦 Jalan ditutup'; cls = 'trf-ditutup'; }
      else {
        text = '🚦 ' + st.label;
        if (isFinite(st.currentSpeed) && isFinite(st.freeFlowSpeed)) text += ' · ' + Math.round(st.currentSpeed) + '/' + Math.round(st.freeFlowSpeed) + ' km/j';
        cls = 'trf-' + st.level;
        if (st.delaySec >= 60 && st.level !== 'lancar') text += ' · +' + Math.round(st.delaySec / 60) + ' mnt';
      }
      var stale = !!(T.last && Date.now() - T.lastAt > STALE_MS);
      chip.textContent = text;
      chip.title = T.lastErr ? 'Status lalu lintas gagal diperbarui: ' + T.lastErr : (st && st.confidence != null ? 'Keyakinan data ' + Math.round(st.confidence * 100) + '%' : '');
      chip.className = (opts.statusEl ? (opts.statusEl.className.replace(/\btrf-\S+/g, '').trim() + ' ') : '') + 'trf-chip ' + cls + (stale ? ' trf-stale' : '') + (text ? '' : ' trf-hide');
      if (opts.statusEl && !text) opts.statusEl.hidden = true; else if (opts.statusEl) opts.statusEl.hidden = false;
    }

    /* ---------- status kelancaran (hemat kuota) ---------- */
    function readPos() {
      var p; try { p = opts.getPosition(); } catch (e) { p = null; }
      if (!p) return null;
      var lat = +p.lat, lng = +(p.lng != null ? p.lng : p.lon);
      if (!isFinite(lat) || !isFinite(lng) || (lat === 0 && lng === 0)) return null;
      return { lat: lat, lng: lng, speed: p.speed == null ? null : +p.speed };
    }
    function tick(force) {
      if (!on || !statusOn || document.hidden || T.busy) return;
      var now = Date.now(); if (now < T.nextOkAt) return;
      var p = readPos(); if (!p) return;
      var need;
      if (force || !T.last) need = true;
      else {
        var moved = T.lastPos ? dist(T.lastPos, p) : Infinity, age = now - T.lastAt;
        var still = p.speed != null && p.speed < MOVING_KMH;
        need = moved >= MOVE_M || age >= (still ? STILL_MS : EVERY_MS);
      }
      if (need) fetchStatus(p);
    }
    function fetchStatus(p) {
      T.busy = true;
      var ctlr = typeof AbortController === 'function' ? new AbortController() : null;
      var to = setTimeout(function () { if (ctlr) ctlr.abort(); }, 8000);
      fetch(base + '/api/traffic-status?lat=' + p.lat.toFixed(5) + '&lng=' + p.lng.toFixed(5), ctlr ? { signal: ctlr.signal } : {})
        .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; }).then(function (j) { j._http = r.status; return j; }); })
        .then(function (j) {
          if (!j || !j.ok) { var e = new Error((j && j.error) || 'gagal'); e.http = j && j._http; throw e; }
          T.last = j; T.lastPos = { lat: p.lat, lng: p.lng }; T.lastAt = Date.now(); T.failN = 0; T.lastErr = '';
          render();
          if (opts.onStatus) { try { opts.onStatus(j, map); } catch (x) { /* abaikan */ } }
        })
        .catch(function (e) {
          T.failN++; T.lastErr = (e && e.message) || 'jaringan';
          // 429 = kuota TomTom habis -> jangan menggempur; lainnya backoff 1,2,4,.. mnt (maks 10)
          T.nextOkAt = Date.now() + (e && e.http === 429 ? 600000 : Math.min(600000, 60000 * Math.pow(2, T.failN - 1)));
          render();
        })
        .then(function () { clearTimeout(to); T.busy = false; });
    }

    /* ---------- hidup-mati & jadwal ---------- */
    var pollT = setInterval(function () { tick(false); render(); }, POLL_MS);
    var refT = refreshMs > 0 ? setInterval(function () { if (on && !document.hidden && map.getZoom() >= minZoom) layer.redraw(); }, refreshMs) : null;
    function onVis() { if (!document.hidden) { tick(false); render(); } }
    document.addEventListener('visibilitychange', onVis);
    map.on('zoomend', render);
    map.on('unload', function () { clearInterval(pollT); if (refT) clearInterval(refT); document.removeEventListener('visibilitychange', onVis); });

    var api = {
      map: map, layer: layer,
      isOn: function () { return on; },
      setOn: function (v, noSave) {
        on = !!v; if (!noSave) lsSet(KEY, on ? '1' : '0');
        if (on) { layer.addTo(map); T.nextOkAt = 0; setTimeout(function () { tick(true); }, 300); } else map.removeLayer(layer);
        render();
      },
      toggle: function () { api.setOn(!on); },
      check: function () { T.nextOkAt = 0; tick(true); },
      status: function () { return T.last; }
    };
    map._trf = api;
    if (on) layer.addTo(map);
    render();
    setTimeout(function () { tick(false); }, 1500);
    return api;
  }

  global.TrafficLayer = { attach: attach, get: function (map) { return map && map._trf; }, version: '1.0.0' };
})(window);
