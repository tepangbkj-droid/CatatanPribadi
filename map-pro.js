/* =====================================================================================
 * map-pro.js — peta layar penuh ala Google Maps untuk SEMUA peta Leaflet di aplikasi.
 *
 *   MapPro.enhance(map, { host, locate, onChange })
 *       Menambah tombol ⛶ (layar penuh) + ◎ (lokasiku) di peta.
 *       host   : elemen yang dibuat layar penuh (default: .loc-mapbox terdekat, atau wadah peta)
 *       locate : false untuk menyembunyikan tombol ◎ (default true)
 *       extras : [{ icon, title, fn(inst) }] tombol tambahan
 *       onChange(isFull) : dipanggil saat masuk / keluar layar penuh
 *   MapPro.open(map) / MapPro.close(map) / MapPro.isFull(map)
 *
 * Cara kerja: elemen host dipindahkan sementara ke <body> (supaya tidak terpengaruh
 * transform/overflow induknya), lalu dikembalikan persis ke tempat semula saat keluar.
 * Tombol Back (Android / gesture) menutup layar penuh, bukan keluar dari aplikasi.
 * ===================================================================================== */
(function (global) {
  'use strict';
  var L = global.L;
  if (!L) { console.warn('[map-pro] Leaflet belum dimuat'); return; }

  var CSS = '' +
    ':root{--mp-top:116px}' +
    'body.mp-lock{overflow:hidden !important;touch-action:none}' +
    '.mp-full{position:fixed !important;inset:0 !important;width:100% !important;height:100% !important;max-width:none !important;margin:0 !important;border-radius:0 !important;border:0 !important;z-index:99100 !important;background:#e5e7eb;box-shadow:none !important;overflow:hidden !important}' +
    '.mp-full.leaflet-container{height:100% !important}' +
    '.mp-full > .leaflet-container,.mp-full #locMap,.mp-full #rdMap{height:100% !important;width:100% !important;border-radius:0 !important}' +
    '.mp-full .leaflet-top{top:var(--mp-top)}' +
    '.mp-full .leaflet-bottom{bottom:env(safe-area-inset-bottom,0px)}' +
    '.mp-full .mk-tools{bottom:calc(30px + env(safe-area-inset-bottom,0px))}' +
    '.mp-full .loc-fab{bottom:calc(30px + env(safe-area-inset-bottom,0px))}' +
    '.mp-full .mk-hint{top:calc(10px + env(safe-area-inset-top,0px));left:64px;right:136px}' +
    '.mp-full:not(.nv-host) .leaflet-top.leaflet-right,.mp-full:not(.nv-host).leaflet-container .leaflet-top.leaflet-right{top:calc(10px + env(safe-area-inset-top,0px)) !important}' +
    '.mp-ctl a.mp-fs,.mp-ctl a.mp-me{display:flex !important;align-items:center;justify-content:center;width:34px;height:34px;font-size:19px;line-height:1;color:#111827;text-decoration:none;cursor:pointer}' +
    '.mp-ctl a.mp-me.busy{opacity:.45}' +
    '.mp-close,.mp-sos{display:none;position:absolute;z-index:1200;border:0;font-family:inherit;cursor:pointer;-webkit-tap-highlight-color:transparent}' +
    '.mp-full .mp-close,.mp-full .mp-sos{display:flex;align-items:center;justify-content:center}' +
    '.mp-close{left:8px;top:calc(8px + env(safe-area-inset-top,0px));width:46px;height:46px;border-radius:50%;background:#fff;color:#111827;font-size:20px;font-weight:700;box-shadow:0 3px 12px rgba(0,0,0,.35)}' +
    '.mp-sos{left:8px;top:calc(62px + env(safe-area-inset-top,0px));width:46px;height:46px;border-radius:50%;background:#D90429;color:#fff;font-size:13px;font-weight:800;letter-spacing:.4px;box-shadow:0 3px 12px rgba(217,4,41,.55);border:2px solid #fff}' +
    '.mp-me-dot{width:16px;height:16px;border-radius:50%;background:#2E8BFF;border:3px solid #fff;box-shadow:0 0 0 7px rgba(46,139,255,.25),0 2px 8px rgba(0,0,0,.4)}' +
    '@media (prefers-color-scheme:dark){.mp-ctl a.mp-fs,.mp-ctl a.mp-me{background:#1f2937;color:#f3f4f6}}';

  function injectCss() {
    if (document.getElementById('mpCss')) return;
    var s = document.createElement('style'); s.id = 'mpCss'; s.textContent = CSS; document.head.appendChild(s);
  }

  var cur = null; // instance yang sedang layar penuh
  function toast(t) { try { if (typeof global.showToast === 'function') global.showToast(t); } catch (e) {} }

  function settle(inst) {
    [30, 200, 500].forEach(function (ms) { setTimeout(function () { try { inst.map.invalidateSize({ animate: false }); } catch (e) {} }, ms); });
  }

  function enter(inst) {
    if (inst.full) return;
    if (cur && cur !== inst) doExit(cur, false);
    var h = inst.host;
    inst.ph = document.createComment('mp-ph');
    if (h.parentNode) h.parentNode.insertBefore(inst.ph, h);
    document.body.appendChild(h);
    h.classList.add('mp-full');
    inst.full = true; cur = inst;
    document.body.classList.add('mp-lock');
    try { history.pushState({ mp: 1 }, ''); inst.pushed = true; } catch (e) { inst.pushed = false; }
    settle(inst);
    var c = inst.map.getCenter(); try { inst.map.setView(c, inst.map.getZoom(), { animate: false }); } catch (e) {}
    if (inst.o.onChange) try { inst.o.onChange(true); } catch (e) {}
  }

  function doExit(inst, fromPop) {
    if (!inst.full) return;
    var h = inst.host;
    h.classList.remove('mp-full');
    if (inst.ph && inst.ph.parentNode) { inst.ph.parentNode.insertBefore(h, inst.ph); inst.ph.parentNode.removeChild(inst.ph); }
    else if (h.parentNode === document.body) { document.body.removeChild(h); }   // tempat asal sudah hilang
    inst.ph = null; inst.full = false;
    if (cur === inst) cur = null;
    document.body.classList.remove('mp-lock');
    if (inst.pushed && !fromPop) { inst.pushed = false; /* biarkan entri history; popstate berikutnya diabaikan */ inst.skipPop = true; try { history.back(); } catch (e) {} }
    inst.pushed = false;
    settle(inst);
    if (inst.o.onChange) try { inst.o.onChange(false); } catch (e) {}
  }

  window.addEventListener('popstate', function () {
    if (cur) { var i = cur; i.pushed = false; doExit(i, true); return; }
  });

  function toggle(inst) { inst.full ? doExit(inst, false) : enter(inst); }

  /* ---------- lokasiku ---------- */
  function locate(inst, btn) {
    if (!navigator.geolocation) { toast('GPS tidak tersedia di perangkat ini'); return; }
    btn.classList.add('busy');
    navigator.geolocation.getCurrentPosition(function (p) {
      btn.classList.remove('busy');
      var ll = [p.coords.latitude, p.coords.longitude];
      if (!inst.meMk) inst.meMk = L.marker(ll, { icon: L.divIcon({ className: '', iconSize: [16, 16], iconAnchor: [8, 8], html: '<div class="mp-me-dot"></div>' }), interactive: false, zIndexOffset: 900 }).addTo(inst.map);
      else inst.meMk.setLatLng(ll);
      inst.map.flyTo(ll, Math.max(inst.map.getZoom(), 16), { duration: 0.8 });
    }, function () { btn.classList.remove('busy'); toast('Lokasi tidak bisa diambil. Cek izin lokasi.'); }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 15000 });
  }

  function enhance(map, o) {
    if (!map || map._mp) return map && map._mp;
    injectCss();
    o = o || {};
    var cont = map.getContainer();
    var host = o.host || (cont.closest && cont.closest('.loc-mapbox')) || cont;
    var inst = { map: map, host: host, o: o, full: false, ph: null, pushed: false };

    // tombol tutup + SOS (hanya tampil saat layar penuh; lihat CSS)
    var close = document.createElement('button'); close.type = 'button'; close.className = 'mp-close'; close.setAttribute('aria-label', 'Tutup layar penuh'); close.textContent = '✕';
    close.addEventListener('click', function (e) { e.stopPropagation(); doExit(inst, false); });
    host.appendChild(close);
    var sos = document.createElement('button'); sos.type = 'button'; sos.className = 'mp-sos'; sos.setAttribute('aria-label', 'Tombol darurat SOS'); sos.textContent = 'SOS';
    sos.addEventListener('click', function (e) { e.stopPropagation(); var b = document.getElementById('btnSos'); if (b) b.click(); });
    if (document.getElementById('btnSos')) host.appendChild(sos);
    ['click', 'dblclick', 'mousedown', 'touchstart'].forEach(function (ev) { L.DomEvent.on(close, ev, L.DomEvent.stopPropagation); L.DomEvent.on(sos, ev, L.DomEvent.stopPropagation); });

    var Ctl = L.Control.extend({
      options: { position: o.position || 'topright' },
      onAdd: function () {
        var b = L.DomUtil.create('div', 'leaflet-bar mp-ctl');
        var a = L.DomUtil.create('a', 'mp-fs', b); a.href = '#'; a.title = 'Layar penuh'; a.setAttribute('role', 'button'); a.setAttribute('aria-label', 'Layar penuh'); a.textContent = '⛶';
        L.DomEvent.on(a, 'click', function (e) { L.DomEvent.preventDefault(e); toggle(inst); });
        if (o.locate !== false) {
          var m = L.DomUtil.create('a', 'mp-me', b); m.href = '#'; m.title = 'Lokasiku'; m.setAttribute('role', 'button'); m.setAttribute('aria-label', 'Lokasiku'); m.textContent = '◎';
          L.DomEvent.on(m, 'click', function (e) { L.DomEvent.preventDefault(e); locate(inst, m); });
        }
        (o.extras || []).forEach(function (x) {
          var e = L.DomUtil.create('a', 'mp-me', b); e.href = '#'; e.title = x.title || ''; e.setAttribute('role', 'button'); e.setAttribute('aria-label', x.title || ''); e.textContent = x.icon;
          L.DomEvent.on(e, 'click', function (ev) { L.DomEvent.preventDefault(ev); try { x.fn(inst); } catch (err) {} });
        });
        L.DomEvent.disableClickPropagation(b);
        return b;
      }
    });
    inst.ctl = new Ctl().addTo(map);
    map._mp = inst;
    return inst;
  }

  global.MapPro = {
    enhance: enhance,
    open: function (m) { if (m && m._mp) enter(m._mp); },
    close: function (m) { if (m && m._mp) doExit(m._mp, false); },
    isFull: function (m) { return !!(m && m._mp && m._mp.full); }
  };
})(typeof window !== 'undefined' ? window : globalThis);
