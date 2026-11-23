/* =====================================================================================
 * bmkg-layers.js — layer data terbuka BMKG untuk peta Leaflet (cuaca, gempa, peringatan dini)
 * Dipakai oleh: index.html (tab Kendaraan) dan motor/index.html (Pelacak Motor).
 *
 *   BmkgLayers.attach(map, {
 *     workerUrl:   'https://gps-worker.xxx.workers.dev',
 *     getPosition: () => ({ lat, lon }) | null      // posisi kendaraan saat ini
 *   });
 *   BmkgLayers.refresh(map)   // paksa muat ulang (mis. setelah posisi kendaraan berubah jauh)
 *   BmkgLayers.detach(map)
 *
 * Tanpa dependensi selain Leaflet. CSS disuntik sendiri (prefiks .bmk-).
 * Sumber Data: BMKG (data terbuka). Atribusi dipasang di pojok bawah peta.
 * ===================================================================================== */
(function (global) {
  'use strict';
  var L = global.L;
  if (!L) { console.warn('[bmkg] Leaflet belum dimuat'); return; }

  var REFRESH = { weather: 30 * 60e3, quake: 5 * 60e3, nowcast: 5 * 60e3 };
  var NEAR_KM = 15;            // peringatan dianggap "di sekitar kendaraan" bila area <= 15 km
  var FETCH_TIMEOUT = 15000;   // BMKG kadang lambat
  var KEY = 'bmkg_layers_v1', KEY_ADM4 = 'bmkg_adm4_manual';

  /* ---------- util ---------- */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function lsGet(k, d) { try { var v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function km(a, b, c, d) { var R = 6371, r = Math.PI / 180, dl = (c - a) * r, dn = (d - b) * r, x = Math.sin(dl / 2) * Math.sin(dl / 2) + Math.cos(a * r) * Math.cos(c * r) * Math.sin(dn / 2) * Math.sin(dn / 2); return 2 * R * Math.asin(Math.sqrt(x)); }
  function validPos(p) { return p && isFinite(p.lat) && isFinite(p.lon) && !(p.lat === 0 && p.lon === 0); }
  function wib(iso, fallback) {
    if (iso) { var d = new Date(iso); if (!isNaN(d)) { try { return d.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).replace(/\./g, ':') + ' WIB'; } catch (e) {} } }
    return fallback || '-';
  }
  function ago(ms) { var m = Math.round((Date.now() - ms) / 60000); return m < 1 ? 'baru saja' : m < 60 ? m + ' mnt lalu' : Math.round(m / 60) + ' jam lalu'; }
  function safeBmkgImg(u) { return typeof u === 'string' && /^https:\/\/(data|api-apps)\.bmkg\.go\.id\//.test(u) ? u : null; }
  async function api(base, qs) {
    var ctl = new AbortController(), t = setTimeout(function () { ctl.abort(); }, FETCH_TIMEOUT);
    try {
      var r = await fetch(base.replace(/\/$/, '') + '/api/bmkg?' + qs, { signal: ctl.signal, cache: 'no-store' });
      var j = await r.json().catch(function () { return null; });
      if (!r.ok || !j || !j.ok) { var e = new Error((j && j.error) || ('HTTP ' + r.status)); e.code = j && j.code; throw e; }
      return j;
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('Server BMKG lambat, coba lagi nanti');
      throw e;
    } finally { clearTimeout(t); }
  }

  /* ---------- geometri peringatan ---------- */
  // jarak (km) titik ke poligon [[lat,lon],...]; 0 bila di dalam
  function distToPolygon(lat, lon, poly) {
    var inside = false, j = poly.length - 1, i;
    for (i = 0; i < poly.length; i++) {
      var yi = poly[i][0], xi = poly[i][1], yj = poly[j][0], xj = poly[j][1];
      if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
      j = i;
    }
    if (inside) return 0;
    var kx = 111.32 * Math.cos(lat * Math.PI / 180), ky = 110.57, best = Infinity;
    for (i = 0; i < poly.length - 1; i++) {
      var ax = (poly[i][1] - lon) * kx, ay = (poly[i][0] - lat) * ky, bx = (poly[i + 1][1] - lon) * kx, by = (poly[i + 1][0] - lat) * ky;
      var dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy, t = l2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
      best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
    }
    return best;
  }
  function alertDistance(a, lat, lon) {
    var best = Infinity;
    (a.areas || []).forEach(function (ar) {
      (ar.polygons || []).forEach(function (p) { best = Math.min(best, distToPolygon(lat, lon, p)); });
      (ar.circles || []).forEach(function (c) { best = Math.min(best, Math.max(0, km(lat, lon, c.lat, c.lon) - c.radiusKm)); });
    });
    return best;
  }
  function alertInBounds(a, b) {
    var hit = false;
    (a.areas || []).forEach(function (ar) {
      (ar.polygons || []).forEach(function (p) { if (b.intersects(L.latLngBounds(p))) hit = true; });
      (ar.circles || []).forEach(function (c) { if (b.contains([c.lat, c.lon])) hit = true; });
    });
    return hit;
  }
  var SEV = { Extreme: 4, Severe: 3, Moderate: 2, Minor: 1 };
  function sevRank(a) { return SEV[a.severity] || 0; }
  function sevLabel(a) { return { Extreme: 'EKSTREM', Severe: 'BERAT', Moderate: 'SEDANG', Minor: 'RINGAN' }[a.severity] || 'WASPADA'; }

  /* ---------- CSS ---------- */
  var CSS = '' +
    '.bmk-ctl{display:flex;flex-direction:column;align-items:flex-start;max-width:calc(100vw - 84px);font:12px/1.35 system-ui,sans-serif;pointer-events:none}.bmk-ctl>*{pointer-events:auto}' +
    '.bmk-ctl.r{align-items:flex-end}' +
    '.bmk-bar{display:flex;gap:6px;align-items:center}.bmk-ctl.r .bmk-bar{flex-direction:row-reverse}' +
    '.bmk-pill,.bmk-lay{border:0;background:rgba(255,255,255,.96);color:#0f172a;height:34px;border-radius:999px;box-shadow:0 2px 8px rgba(0,0,0,.28);cursor:pointer;-webkit-tap-highlight-color:transparent;font-family:system-ui,sans-serif}' +
    '.bmk-pill{display:inline-flex;align-items:center;gap:5px;padding:0 11px;font-weight:700;font-size:14px;white-space:nowrap}.bmk-pill .e{font-size:17px;line-height:1}' +
    '.bmk-pill small{font:600 11px system-ui;color:#64748b;max-width:78px;overflow:hidden;text-overflow:ellipsis}.bmk-pill .car{font-size:9px;color:#94a3b8}' +
    '.bmk-pill.warn{background:#dc2626;color:#fff}.bmk-pill.warn small,.bmk-pill.warn .car{color:#fecaca}' +
    '.bmk-pill.err{background:#fef3c7}' +
    '.bmk-lay{width:34px;padding:0;font-size:16px;display:inline-flex;align-items:center;justify-content:center}.bmk-lay.err::after{content:\"!\";position:absolute;margin:-22px -22px 0 0;width:13px;height:13px;border-radius:50%;background:#f59e0b;color:#fff;font:700 9px/13px system-ui;text-align:center}' +
    '.bmk-menu{margin-top:6px;background:rgba(255,255,255,.98);border-radius:14px;padding:5px;box-shadow:0 6px 20px rgba(0,0,0,.3);min-width:176px}' +
    '.bmk-row{display:flex;width:100%;align-items:center;justify-content:space-between;gap:10px;border:0;background:transparent;padding:9px 10px;border-radius:10px;font:600 13px system-ui;color:#334155;cursor:pointer}' +
    '.bmk-row i{width:34px;height:20px;border-radius:99px;background:#cbd5e1;position:relative;flex:none;transition:background .15s}.bmk-row i::after{content:\"\";position:absolute;left:2px;top:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.3);transition:left .15s}' +
    '.bmk-row[aria-pressed=\"true\"] i{background:#2563eb}.bmk-row[aria-pressed=\"true\"] i::after{left:16px}.bmk-row.err span::after{content:\" ⚠\"}' +
    '.bmk-panel{margin-top:6px;width:min(310px,calc(100vw - 84px));max-height:min(58vh,440px);overflow:auto;-webkit-overflow-scrolling:touch;background:rgba(255,255,255,.98);color:#0f172a;border-radius:16px;padding:12px;box-shadow:0 8px 26px rgba(0,0,0,.32)}' +
    '.bmk-panel .row{display:flex;align-items:center;gap:10px}.bmk-panel .ic{width:48px;height:48px;flex:none;font-size:36px;text-align:center;line-height:48px}.bmk-panel .ic img{width:48px;height:48px}' +
    '.bmk-panel .t{font:700 30px/1 system-ui}.bmk-panel .d{font-weight:600;font-size:13px;margin-top:2px}.bmk-panel .m{display:flex;gap:12px;margin-top:8px;color:#475569;font-size:12.5px;flex-wrap:wrap}' +
    '.bmk-panel .p{margin-top:6px;color:#64748b;font-size:11.5px;line-height:1.4}.bmk-panel .p b{color:#334155}' +
    '.bmk-panel .nx{display:flex;gap:4px;margin-top:10px;overflow-x:auto;padding-bottom:2px}.bmk-panel .nx div{flex:none;min-width:44px;text-align:center;font-size:11px;color:#475569;background:#f1f5f9;border-radius:10px;padding:5px 4px}' +
    '.bmk-panel .sec{margin-top:10px;padding-top:10px;border-top:1px solid #e2e8f0}.bmk-panel .sec h5{margin:0 0 6px;font:700 12px system-ui;color:#334155}' +
    '.bmk-panel .al{background:#fee2e2;color:#7f1d1d;border-radius:12px;padding:8px 10px;margin-bottom:10px;font-size:12px}.bmk-panel .al.s2{background:#ffedd5;color:#7c2d12}.bmk-panel .al.s1,.bmk-panel .al.s0{background:#fef9c3;color:#713f12}.bmk-panel .al b{display:block;font-size:13px}.bmk-panel .al details{margin-top:4px}.bmk-panel .al summary{cursor:pointer;font-weight:600}.bmk-panel .al .tx{white-space:pre-wrap;margin-top:4px}' +
    '.bmk-panel button,.bmk-panel .bt{font:600 11.5px system-ui;border:1px solid #cbd5e1;background:#f8fafc;color:#0f172a;border-radius:9px;padding:6px 9px;margin:6px 6px 0 0;cursor:pointer;text-decoration:none;display:inline-block}' +
    '.bmk-panel input{width:100%;box-sizing:border-box;margin-top:6px;padding:6px 8px;border:1px solid #cbd5e1;border-radius:8px;font:12px system-ui}' +
    '.bmk-panel .stale{color:#b45309;font-size:11px;margin-top:6px}.bmk-panel .er{color:#b91c1c}' +
    '.bmk-panel .li{display:flex;gap:8px;align-items:center;justify-content:space-between;padding:5px 0;border-bottom:1px dashed #e2e8f0;font-size:12px}.bmk-panel .li:last-child{border-bottom:0}.bmk-panel .li button{margin:0;flex:none}' +
    'body.mp-lock #bmkBanner{display:none !important}' +
    '.bmk-q{position:relative;width:0;height:0}' +
    '.bmk-q i{position:absolute;left:0;top:0;border-radius:50%;transform:translate(-50%,-50%);background:var(--c);border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.25)}' +
    '.bmk-q b{position:absolute;left:0;top:0;border-radius:50%;transform:translate(-50%,-50%);background:var(--c);opacity:.55;animation:bmkPulse 1.8s ease-out infinite}' +
    '.bmk-q b+b{animation-delay:.9s}' +
    '@keyframes bmkPulse{0%{width:var(--s);height:var(--s);opacity:.6}100%{width:calc(var(--s)*3.4);height:calc(var(--s)*3.4);opacity:0}}' +
    '@media (prefers-reduced-motion:reduce){.bmk-q b{animation:none;opacity:.25;width:calc(var(--s)*2);height:calc(var(--s)*2)}}' +
    '.bmk-pop{font:13px/1.45 system-ui,sans-serif;min-width:200px}.bmk-pop h4{margin:0 0 4px;font:700 15px system-ui}.bmk-pop table{border-collapse:collapse;width:100%}' +
    '.bmk-pop td{padding:2px 0;vertical-align:top}.bmk-pop td:first-child{color:#64748b;padding-right:8px;white-space:nowrap}.bmk-pop img{display:block;width:100%;max-width:240px;border-radius:8px;margin-top:8px}' +
    '#bmkBanner{position:fixed;left:0;right:0;top:0;z-index:1900;padding-top:env(safe-area-inset-top,0px);font:13px/1.4 system-ui,sans-serif;color:#fff;box-shadow:0 3px 12px rgba(0,0,0,.35)}' +
    '#bmkBanner.hidden{display:none}#bmkBanner .in{padding:9px 12px;display:flex;gap:10px;align-items:flex-start}' +
    '#bmkBanner .tx{flex:1;min-width:0}#bmkBanner b{display:block;font-size:14px}#bmkBanner .sm{opacity:.95}' +
    '#bmkBanner .bt{flex:none;display:flex;gap:6px}#bmkBanner button{background:rgba(255,255,255,.22);color:#fff;border:0;border-radius:8px;padding:6px 9px;font:600 12px system-ui;cursor:pointer}' +
    '#bmkBanner .dt{display:none;padding:0 12px 10px;white-space:pre-wrap}#bmkBanner.open .dt{display:block}' +
    '#bmkBanner.s4,#bmkBanner.s3{background:#b91c1c}#bmkBanner.s2{background:#c2410c}#bmkBanner.s1,#bmkBanner.s0{background:#a16207}' +
    '.bmk-cap{font-weight:600}';
  function injectCss() {
    if (document.getElementById('bmkCss')) return;
    var s = document.createElement('style'); s.id = 'bmkCss'; s.textContent = CSS; document.head.appendChild(s);
  }

  /* ---------- banner global (satu per halaman) ---------- */
  var banner = null, dismissed = lsGet('bmk_dismissed', {});
  function getBanner() {
    if (banner) return banner;
    banner = document.createElement('div'); banner.id = 'bmkBanner'; banner.className = 'hidden'; banner.setAttribute('role', 'alert');
    document.body.appendChild(banner);
    return banner;
  }
  function renderBanner(list, ctxText) {
    var el = getBanner();
    list = list.filter(function (x) { return !dismissed[x.a.id]; });
    if (!list.length) { el.className = 'hidden'; el.innerHTML = ''; return; }
    var top = list[0], a = top.a, areas = [];
    a.areas.forEach(function (ar) { if (ar.name && areas.indexOf(ar.name) < 0) areas.push(ar.name); });
    var areaTxt = areas.slice(0, 3).join(', ') + (areas.length > 3 ? ' +' + (areas.length - 3) + ' wilayah' : '');
    var where = top.km === 0 ? '📍 Kendaraan berada di area terdampak' : top.km != null && top.km < Infinity ? '📍 ± ' + Math.round(top.km) + ' km dari kendaraan' : '🗺️ Di area peta yang ditampilkan';
    var wasOpen = el.classList.contains('open');
    el.className = 's' + sevRank(a) + (wasOpen ? ' open' : '');
    el.innerHTML = '<div class="in"><div class="tx"><b>⚠️ PERINGATAN DINI ' + esc(sevLabel(a)) + ': ' + esc(a.event || a.headline || 'Cuaca ekstrem') + '</b>' +
      '<div class="sm">' + esc(areaTxt || a.headline) + '</div><div class="sm">' + where + (a.expires ? ' · berlaku s/d ' + esc(wib(a.expires)) : '') + (list.length > 1 ? ' · +' + (list.length - 1) + ' peringatan lain' : '') + '</div></div>' +
      '<div class="bt"><button data-a="more">Detail</button><button data-a="x" aria-label="Tutup">✕</button></div></div>' +
      '<div class="dt">' + list.map(function (x) { return '<div style="margin-bottom:8px"><b>' + esc(x.a.headline || x.a.event) + '</b>' + esc(x.a.description || '') + (x.a.instruction ? '\n' + esc(x.a.instruction) : '') + '\n<i>Sumber Data: BMKG</i></div>'; }).join('') + '</div>';
    el.onclick = function (e) {
      var b = e.target.closest('button'); if (!b) return;
      if (b.dataset.a === 'more') el.classList.toggle('open');
      else { list.forEach(function (x) { dismissed[x.a.id] = Date.now(); }); lsSet('bmk_dismissed', dismissed); el.className = 'hidden'; }
    };
  }
  // bersihkan catatan "ditutup" yang lebih dari 2 hari
  (function () { var n = Date.now(), ch = false; for (var k in dismissed) if (n - dismissed[k] > 2 * 864e5) { delete dismissed[k]; ch = true; } if (ch) lsSet('bmk_dismissed', dismissed); })();

  /* ---------- instance per peta ---------- */
  function attach(map, opts) {
    if (!map || map._bmkg) return map && map._bmkg;
    injectCss();
    opts = opts || {};
    var base = opts.workerUrl || '', getPos = opts.getPosition || function () { return null; };
    var st = Object.assign({ weather: true, quake: false, nowcast: true }, lsGet(KEY, {}));
    var S = { focus: lsGet('bmk_focus', 'vehicle'), timers: {}, weather: null, wErr: '', wLast: null, wAt: 0, expand: false, open: false, menu: false, rel: [], quakes: [], alerts: [], err: {}, busy: {} };
    var quakeGroup = L.layerGroup(), alertGroup = L.layerGroup();

    /* kontrol ringkas: [☁️ 27°C ▾] [🗂] — detail cuaca & info wilayah hanya muncul saat diketuk */
    var pos = opts.position || 'topright';
    var Ctl = L.Control.extend({
      options: { position: pos },
      onAdd: function () {
        var d = L.DomUtil.create('div', 'bmk-ctl' + (/right/.test(pos) ? ' r' : ''));
        d.innerHTML = '<div class="bmk-bar"><button class="bmk-pill" data-w="panel" aria-label="Cuaca" aria-expanded="false"></button><button class="bmk-lay" data-w="menu" aria-label="Lapisan peta" title="Lapisan: cuaca, gempa, peringatan dini">🗂️</button></div>' +
          '<div class="bmk-menu" style="display:none"><button class="bmk-row" data-k="weather"><span>☁️ Cuaca</span><i></i></button><button class="bmk-row" data-k="quake"><span>🌋 Gempa</span><i></i></button><button class="bmk-row" data-k="nowcast"><span>⚠️ Peringatan dini</span><i></i></button></div>' +
          '<div class="bmk-panel" style="display:none"></div>';
        L.DomEvent.disableClickPropagation(d); L.DomEvent.disableScrollPropagation(d);
        d.addEventListener('click', function (e) {
          var row = e.target.closest('.bmk-row');
          if (row) { toggle(row.dataset.k); return; }
          var fly = e.target.closest('[data-fly]');
          if (fly) { var ll = fly.dataset.fly.split(',').map(Number); map.setView(ll, Math.max(map.getZoom(), 17), { animate: true }); return; }
          var a = e.target.closest('[data-w]'); if (!a) return;
          var w = a.dataset.w;
          if (w === 'panel') { S.open = !S.open; S.menu = false; drawPanel(); if (S.open) { loadWeather(false); } }
          else if (w === 'menu') { S.menu = !S.menu; if (S.menu) S.open = false; sync(); drawPanel(); }
          else if (w === 'retry') { S.wLast = null; loadWeather(true); }
          else if (w === 'focus') { S.focus = S.focus === 'vehicle' ? 'map' : 'vehicle'; lsSet('bmk_focus', S.focus); S.wLast = null; loadWeather(true); evalAlerts(); }
          else if (w === 'save') {
            var v = (d.querySelector('.bmk-panel input') || {}).value || '';
            if (/^\d{2}\.\d{2}\.\d{2}\.\d{4}$/.test(v.trim())) { lsSet(KEY_ADM4, v.trim()); S.wLast = null; loadWeather(true); }
            else { S.wErr = 'Format kode: 31.71.03.1001'; drawPanel(); }
          } else if (w === 'auto') { try { localStorage.removeItem(KEY_ADM4); } catch (x) {} S.wLast = null; loadWeather(true); }
          else if (w === 'cb' && opts.onAction) { try { opts.onAction(a.dataset.act, a.dataset, map); } catch (x) {} }
        });
        return d;
      }
    });
    var ctl = new Ctl().addTo(map);
    var root = ctl.getContainer(), pillEl = root.querySelector('.bmk-pill'), menuEl = root.querySelector('.bmk-menu'), wBox = root.querySelector('.bmk-panel');
    // ketuk peta = tutup panel/menu
    map.on('click', function () { if (S.open || S.menu) { S.open = false; S.menu = false; sync(); drawPanel(); } });
    map.on('dragstart', function () { if (S.menu) { S.menu = false; sync(); } });

    /* atribusi resmi di pojok bawah peta */
    var ATTR = 'Sumber Data: <a href="https://www.bmkg.go.id" target="_blank" rel="noopener">BMKG</a>';
    if (map.attributionControl) map.attributionControl.addAttribution(ATTR);
    else { var ac = L.control.attribution({ position: 'bottomright', prefix: false }).addAttribution(ATTR).addTo(map); S.ac = ac; }

    function toggle(k) { st[k] = !st[k]; lsSet(KEY, st); sync(); if (st[k]) load(k, true); }
    function sync() {
      ['weather', 'quake', 'nowcast'].forEach(function (k) {
        var b = menuEl.querySelector('[data-k="' + k + '"]'); b.setAttribute('aria-pressed', String(!!st[k])); b.classList.toggle('err', !!(st[k] && S.err[k]));
        b.title = S.err[k] ? 'Gagal memuat: ' + S.err[k] : '';
      });
      var anyErr = ['weather', 'quake', 'nowcast'].some(function (k) { return st[k] && S.err[k] && S.err[k] !== 'data lama'; });
      root.querySelector('.bmk-lay').classList.toggle('err', anyErr);
      menuEl.style.display = S.menu ? '' : 'none';
      pillEl.style.display = st.weather ? '' : 'none';
      if (!st.weather) S.open = false;
      if (st.quake) quakeGroup.addTo(map); else map.removeLayer(quakeGroup);
      if (st.nowcast) alertGroup.addTo(map); else { map.removeLayer(alertGroup); S.rel = []; }
      if (!st.nowcast) renderBanner([]);
      else evalAlerts();
      drawPill(); drawPanel();
    }

    /* ---- posisi acuan: kendaraan, bila tidak ada pusat peta ---- */
    // Acuan lokasi: "kendaraan" bila tersedia dan dipilih, selain itu pusat peta yang sedang dilihat
    function vehPos() { var p = null; try { p = getPos(); } catch (e) {} return validPos(p) ? { lat: +p.lat, lon: +p.lon } : null; }
    function refPos() {
      var v = vehPos();
      if (v && S.focus === 'vehicle') return { lat: v.lat, lon: v.lon, vehicle: true };
      var c = map.getCenter(); return { lat: c.lat, lon: c.lng, vehicle: false };
    }

    /* ---- cuaca ---- */
    function wxEmoji(d) { d = String(d || '').toLowerCase(); return /petir/.test(d) ? '⛈️' : /hujan/.test(d) ? '🌧️' : /kabut|asap/.test(d) ? '🌫️' : /cerah berawan/.test(d) ? '⛅' : /berawan/.test(d) ? '☁️' : /cerah/.test(d) ? '☀️' : '🌤️'; }
    function drawPill() {
      if (!st.weather) return;
      var w = S.weather, hasAl = st.nowcast && S.rel.some(function (x) { return !dismissed[x.a.id]; });
      pillEl.classList.toggle('warn', !!hasAl); pillEl.classList.toggle('err', !w && !!S.wErr);
      var pl = (w && w.place) || {}, nm = pl.kecamatan || pl.desa || '';
      if (!w) { pillEl.innerHTML = '<span class="e">' + (S.wErr ? '⚠️' : '⏳') + '</span><small>' + (S.wErr ? 'Cuaca' : 'Memuat') + '</small>'; }
      else { var c = w.current; pillEl.innerHTML = '<span class="e">' + (hasAl ? '⚠️' : wxEmoji(c.desc)) + '</span>' + (c.temp != null ? Math.round(c.temp) + '°' : '–') + (nm ? '<small>' + esc(nm) + '</small>' : '') + '<span class="car">' + (S.open ? '▲' : '▼') + '</span>'; }
      pillEl.setAttribute('aria-expanded', String(!!S.open));
    }
    function drawPanel() {
      drawPill();
      wBox.style.display = (S.open && st.weather) ? '' : 'none';
      if (!S.open || !st.weather) return;
      var w = S.weather, h = '';
      // peringatan dini di sekitar (tampil di sini, bukan menutupi layar)
      if (st.nowcast) S.rel.filter(function (x) { return !dismissed[x.a.id]; }).slice(0, 2).forEach(function (x) {
        var a = x.a, names = []; a.areas.forEach(function (ar) { if (ar.name && names.indexOf(ar.name) < 0) names.push(ar.name); });
        h += '<div class="al s' + sevRank(a) + '"><b>⚠️ ' + esc(sevLabel(a)) + ': ' + esc(a.event || a.headline || 'Cuaca ekstrem') + '</b>' + esc(names.slice(0, 3).join(', ')) +
          '<div>' + (x.km === 0 ? '📍 Posisi Anda di area terdampak' : x.km != null && x.km < Infinity ? '📍 ± ' + Math.round(x.km) + ' km dari Anda' : '🗺️ Di area peta ini') + (a.expires ? ' · s/d ' + esc(wib(a.expires)) : '') + '</div>' +
          '<details><summary>Detail</summary><div class="tx">' + esc(a.description || a.headline || '') + (a.instruction ? '\n' + esc(a.instruction) : '') + '</div></details></div>';
      });
      if (!w) {
        h += S.wErr ? '<div class="er">⚠️ ' + esc(S.wErr.length > 140 ? S.wErr.slice(0, 140) + '…' : S.wErr) + '</div><button data-w="retry">Coba lagi</button>' : '<div>⏳ Memuat cuaca…</div>';
        if (S.needManual) h += '<input type="text" inputmode="numeric" placeholder="Kode adm4, mis. 31.71.03.1001" value="' + esc(lsGet(KEY_ADM4, '')) + '"><button data-w="save">Pakai kode ini</button>';
      } else {
        var c = w.current, pl = w.place || {}, img = safeBmkgImg(c.icon);
        h += '<div class="row"><div class="ic">' + (img ? '<img alt="" src="' + esc(img) + '" onerror="this.replaceWith(document.createTextNode(\'' + wxEmoji(c.desc) + '\'))">' : wxEmoji(c.desc)) + '</div>' +
          '<div><div class="t">' + (c.temp != null ? Math.round(c.temp) + '°C' : '–') + '</div><div class="d">' + esc(c.desc || '-') + '</div></div></div>' +
          '<div class="m"><span>💧 ' + (c.humidity != null ? Math.round(c.humidity) + '%' : '–') + '</span><span>💨 ' + (c.windKmh != null ? Math.round(c.windKmh) + ' km/j' : '–') + (c.windDir ? ' ' + esc(c.windDir) : '') + '</span>' +
          (c.cloud != null ? '<span>☁️ ' + Math.round(c.cloud) + '%</span>' : '') + (c.visText ? '<span>👁️ ' + esc(c.visText) + '</span>' : '') + (c.rainMm ? '<span>🌧️ ' + c.rainMm + ' mm</span>' : '') + '</div>' +
          '<div class="p">📍 <b>' + esc([pl.desa, pl.kecamatan].filter(Boolean).join(', ') || w.adm4 || '') + '</b>' + (pl.kotkab || pl.provinsi ? '<br>' + esc([pl.kotkab, pl.provinsi].filter(Boolean).join(', ')) : '') + '</div>';
        if (w.next && w.next.length) h += '<div class="nx">' + w.next.slice(0, 8).map(function (n) {
          var t = new Date(n.utc), hh = ''; try { hh = t.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' }).replace('.', ':'); } catch (e) {}
          return '<div>' + hh + '<br>' + wxEmoji(n.desc) + '<br><b>' + (n.temp != null ? Math.round(n.temp) + '°' : '') + '</b></div>';
        }).join('') + '</div>';
        if (w.stale) h += '<div class="stale">Data lama (BMKG sedang lambat/tidak merespons)</div>';
        else if (S.wErr) h += '<div class="stale">' + esc(S.wErr) + '</div>';
      }
      // info tambahan dari aplikasi (CCTV, lampu lalu lintas, dll. di area yang dilihat)
      if (typeof opts.areaInfo === 'function') { var extra = ''; try { extra = opts.areaInfo(map, S.weather) || ''; } catch (e) {} if (extra) h += '<div class="sec">' + extra + '</div>'; }
      h += '<div class="sec" style="padding-top:2px"><button data-w="retry">🔄 Segarkan</button>' + (vehPos() ? '<button data-w="focus">' + (S.focus === 'vehicle' ? '🚗 Acuan: kendaraan' : '🎯 Acuan: pusat peta') + '</button>' : '') +
        (lsGet(KEY_ADM4, '') ? '<button data-w="auto">Lokasi otomatis</button>' : '') +
        '<div class="p">Sumber Data: BMKG' + (S.wAt ? ' · diperbarui ' + ago(S.wAt) : '') + '</div></div>';
      wBox.innerHTML = h;
    }
    function drawWeather() { drawPanel(); }
    async function loadWeather(force) {
      if (!st.weather || S.busy.weather) return;
      var r = refPos(), manual = lsGet(KEY_ADM4, '');
      // lewati bila belum perlu: posisi hampir sama dan data masih segar
      if (!force && S.weather && S.wLast && Date.now() - S.wAt < REFRESH.weather && km(r.lat, r.lon, S.wLast.lat, S.wLast.lon) < 3) return;
      S.busy.weather = true; S.needManual = false;
      try {
        var j = await api(base, manual ? 'type=weather&adm4=' + encodeURIComponent(manual) : 'type=weather&lat=' + r.lat.toFixed(4) + '&lon=' + r.lon.toFixed(4));
        S.weather = j; S.wErr = ''; S.err.weather = ''; S.wAt = Date.now(); S.wLast = { lat: r.lat, lon: r.lon };
        if (j.stale) S.err.weather = 'data lama';
      } catch (e) {
        S.err.weather = e.message; S.wErr = e.message; if (e.code === 'adm4_unresolved') S.needManual = true;
        if (!S.weather) S.wLast = null;
      } finally { S.busy.weather = false; sync(); }
    }

    /* ---- gempa ---- */
    function quakeColor(m) { return m >= 6 ? '#dc2626' : m >= 5 ? '#f97316' : '#f59e0b'; }
    function quakePopup(q) {
      var img = safeBmkgImg(q.shakemap);
      var tsu = q.potential || 'Tidak ada informasi (hanya gempa M5+ yang dianalisis)';
      return '<div class="bmk-pop"><h4>M ' + (q.mag != null ? q.mag.toFixed(1) : '?') + ' · ' + esc(q.source === 'terbaru' ? 'Gempa Terbaru' : 'Gempa Terkini') + '</h4><table>' +
        '<tr><td>Magnitudo</td><td><b>' + (q.mag != null ? q.mag.toFixed(1) : '-') + '</b></td></tr>' +
        '<tr><td>Kedalaman</td><td>' + esc(q.depthText || (q.depthKm != null ? q.depthKm + ' km' : '-')) + '</td></tr>' +
        '<tr><td>Waktu</td><td>' + esc(wib(q.time, q.timeText)) + '</td></tr>' +
        '<tr><td>Wilayah</td><td>' + esc(q.region || '-') + '</td></tr>' +
        '<tr><td>Potensi</td><td>' + esc(tsu) + '</td></tr>' +
        (q.felt ? '<tr><td>Dirasakan</td><td>' + esc(q.felt) + '</td></tr>' : '') + '</table>' +
        (img ? '<img loading="lazy" alt="Shakemap BMKG" src="' + esc(img) + '" onerror="this.style.display=\'none\'">' : '') +
        '<div style="margin-top:6px;font-size:11px;color:#64748b">Sumber Data: BMKG</div></div>';
    }
    function drawQuakes() {
      quakeGroup.clearLayers();
      S.quakes.forEach(function (q) {
        if (q.lat == null || q.lon == null) return;
        var m = q.mag || 4, s = Math.round(10 + Math.max(0, m - 3) * 4), c = quakeColor(m);
        var icon = L.divIcon({ className: '', iconSize: [0, 0], html: '<div class="bmk-q" style="--c:' + c + ';--s:' + s + 'px"><b style="width:' + s + 'px;height:' + s + 'px"></b><b style="width:' + s + 'px;height:' + s + 'px"></b><i style="width:' + s + 'px;height:' + s + 'px"></i></div>' });
        L.marker([q.lat, q.lon], { icon: icon, title: 'M ' + m, zIndexOffset: Math.round(m * 100) }).bindPopup(quakePopup(q), { maxWidth: 260 }).addTo(quakeGroup);
      });
    }
    async function loadQuakes() {
      if (!st.quake || S.busy.quake) return; S.busy.quake = true;
      try { var j = await api(base, 'type=quake'); S.quakes = j.quakes || []; S.err.quake = j.stale ? 'data lama' : ''; drawQuakes(); }
      catch (e) { S.err.quake = e.message; } finally { S.busy.quake = false; sync(); }
    }

    /* ---- peringatan dini ---- */
    function evalAlerts() {
      alertGroup.clearLayers();
      var r = refPos(), b = map.getBounds(), rel = [];
      S.alerts.forEach(function (a) {
        var d = alertDistance(a, r.lat, r.lon), near = r.vehicle && d <= NEAR_KM, inView = alertInBounds(a, b);
        // gambar area pada peta
        var near2 = near || d <= NEAR_KM, style = { color: near2 ? '#dc2626' : '#f59e0b', weight: 2, fillOpacity: near2 ? 0.2 : 0.1 };
        var tip = '<b>' + esc(a.event || 'Peringatan') + '</b><br>' + esc((a.areas[0] && a.areas[0].name) || '') + '<br><small>Sumber Data: BMKG</small>';
        a.areas.forEach(function (ar) {
          ar.polygons.forEach(function (p) { L.polygon(p, style).bindPopup(tip).addTo(alertGroup); });
          ar.circles.forEach(function (c) { L.circle([c.lat, c.lon], Object.assign({ radius: c.radiusKm * 1000 }, style)).bindPopup(tip).addTo(alertGroup); });
        });
        if (near || (!r.vehicle && inView) || (r.vehicle && inView && d <= NEAR_KM * 3)) rel.push({ a: a, km: r.vehicle ? d : null });
      });
      rel.sort(function (x, y) { return sevRank(y.a) - sevRank(x.a) || (x.km || 0) - (y.km || 0); });
      S.rel = rel;
      if (st.nowcast) renderBanner(rel);
      drawPill(); if (S.open) drawPanel();
    }
    async function loadAlerts() {
      if (!st.nowcast || S.busy.nowcast) return; S.busy.nowcast = true;
      try { var j = await api(base, 'type=nowcast'); S.alerts = j.alerts || []; S.err.nowcast = j.stale ? 'data lama' : ''; evalAlerts(); }
      catch (e) { S.err.nowcast = e.message; } finally { S.busy.nowcast = false; sync(); }
    }

    function load(k, force) { if (k === 'weather') loadWeather(force); else if (k === 'quake') loadQuakes(); else loadAlerts(); }

    /* ---- penjadwalan: berhenti saat tab disembunyikan; muat ulang per jenis hanya bila TTL lewat ---- */
    var last = { weather: 0, quake: 0, nowcast: 0 };
    function schedule() {
      var n = Date.now();
      ['quake', 'nowcast'].forEach(function (k) { if (st[k] && n - last[k] >= REFRESH[k]) { last[k] = n; load(k, true); } });
      if (st.weather) loadWeather(false);   // melewati sendiri bila data masih segar & kendaraan belum pindah >3 km
      if (st.nowcast) evalAlerts();         // posisi kendaraan bisa berubah
    }
    var ticker = setInterval(function () { if (!document.hidden) schedule(); }, 60e3);
    var onVis = function () { if (!document.hidden) schedule(); }; document.addEventListener('visibilitychange', onVis);
    var mv; var onMove = function () { clearTimeout(mv); mv = setTimeout(function () { if (!document.hidden && st.nowcast) evalAlerts(); if (st.weather && !refPos().vehicle) loadWeather(false); if (S.open) drawPanel(); }, 1200); };
    map.on('moveend', onMove);

    var wxCache = {};
    var api_ = {
      // cuaca di titik mana pun (untuk rute): hasil di-cache 20 menit per ±1 km
      weatherAt: async function (lat, lon) {
        var k = lat.toFixed(2) + ',' + lon.toFixed(2), c = wxCache[k];
        if (c && Date.now() - c.t < 20 * 60e3) return c.v;
        var j = await api(base, 'type=weather&lat=' + lat.toFixed(4) + '&lon=' + lon.toFixed(4));
        wxCache[k] = { t: Date.now(), v: j }; return j;
      },
      // peringatan dini yang mengenai titik-titik rute: [{a, idx, km}] (km = jarak terdekat ke titik)
      alertsAlong: function (points) {
        var out = [];
        S.alerts.forEach(function (a) {
          var best = Infinity, bi = -1;
          points.forEach(function (p, i) { var d = alertDistance(a, p.lat, p.lng); if (d < best) { best = d; bi = i; } });
          if (best <= 3) out.push({ a: a, idx: bi, km: best });
        });
        out.sort(function (x, y) { return sevRank(y.a) - sevRank(x.a); });
        return out;
      },
      wxEmoji: wxEmoji,
      openPanel: function () { S.open = true; S.menu = false; sync(); loadWeather(false); },
      closePanel: function () { S.open = false; S.menu = false; sync(); },
      redraw: function () { drawPanel(); },
      refresh: function () { S.wLast = null; last = { weather: 0, quake: 0, nowcast: 0 }; schedule(); },
      detach: function () {
        clearInterval(ticker); document.removeEventListener('visibilitychange', onVis); map.off('moveend', onMove);
        map.removeControl(ctl); map.removeLayer(quakeGroup); map.removeLayer(alertGroup);
        if (map.attributionControl) map.attributionControl.removeAttribution(ATTR); else if (S.ac) map.removeControl(S.ac);
        renderBanner([]); delete map._bmkg;
      }
    };
    map._bmkg = api_;
    sync(); schedule();
    return api_;
  }

  global.BmkgLayers = {
    attach: attach,
    refresh: function (m) { if (m && m._bmkg) m._bmkg.refresh(); },
    weatherAt: function (m, lat, lon) { return m && m._bmkg ? m._bmkg.weatherAt(lat, lon) : Promise.reject(new Error('BMKG belum aktif')); },
    wxEmoji: function (d) { d = String(d || '').toLowerCase(); return /petir/.test(d) ? '⛈️' : /hujan/.test(d) ? '🌧️' : /kabut|asap/.test(d) ? '🌫️' : /cerah berawan/.test(d) ? '⛅' : /berawan/.test(d) ? '☁️' : /cerah/.test(d) ? '☀️' : '🌤️'; },
    redraw: function (m) { if (m && m._bmkg) m._bmkg.redraw(); },
    alertsAlong: function (m, pts) { return m && m._bmkg ? m._bmkg.alertsAlong(pts) : []; },
    detach: function (m) { if (m && m._bmkg) m._bmkg.detach(); },
    _test: { distToPolygon: distToPolygon }
  };
})(typeof window !== 'undefined' ? window : globalThis);
