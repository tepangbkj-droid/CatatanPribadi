/* cctv-public.js — Layer CCTV Publik (Windy + JakCCTV + 23.203 titik) dengan grid clustering ringan */
(function () {
  'use strict';

  const GRID_DEG = 0.025;
  const STOP_AFTER_MS = 180000;
  const FETCH_RADIUS_M = 8000;
  const DEFAULT_PROXY_BASE = 'https://gps-worker.tepangbkj8.workers.dev/api/proxy/cctv';

  function getProxyBase() {
    if (window.CCTV_PROXY_URL) return String(window.CCTV_PROXY_URL).replace(/\/$/, '');
    if (window.WORKER_URL) return String(window.WORKER_URL).replace(/\/$/, '') + '/api/proxy/cctv';
    return DEFAULT_PROXY_BASE;
  }

  function proxyStreamUrl(rawUrl) {
    if (!rawUrl) return '';
    if (rawUrl.includes('/api/proxy/cctv')) return rawUrl;
    return `${getProxyBase()}?url=${encodeURIComponent(rawUrl)}`;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  const state = {
    enabled: false,
    loaded: false,
    loading: false,
    cams: [],
    layer: null,
    hls: null,
    stopTimer: null,
    countdownTimer: null,
    activeCam: null,
  };

  function getWorkerBase() {
    if (window.WORKER_URL) return String(window.WORKER_URL).replace(/\/$/, '');
    return 'https://gps-worker.tepangbkj8.workers.dev';
  }

  function getMap() {
    if (window.map && typeof window.map.addLayer === 'function') return window.map;
    for (const k of Object.keys(window)) {
      try {
        const v = window[k];
        if (v && typeof v === 'object' && typeof v.addLayer === 'function' && typeof v.getCenter === 'function') {
          return v;
        }
      } catch {}
    }
    return null;
  }

  function injectStyles() {
    if (document.getElementById('cctv-pub-css')) return;
    const style = document.createElement('style');
    style.id = 'cctv-pub-css';
    style.textContent = `
      .cctv-btn-toggle{position:fixed;right:14px;bottom:148px;z-index:1050;background:#111827;color:#fff;border:1px solid #374151;border-radius:999px;padding:9px 14px;font:600 12px/1 system-ui,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.35);cursor:pointer;display:flex;align-items:center;gap:6px}
      .cctv-btn-toggle.active{background:#059669;border-color:#10b981}
      .cctv-dot{display:flex;align-items:center;justify-content:center;border-radius:50%;color:#fff;font:700 11px/1 system-ui,sans-serif;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.4)}
      .cctv-dot.windy{background:#0284c7;width:24px;height:24px}
      .cctv-dot.jakcctv{background:#059669;width:24px;height:24px}
      .cctv-dot.atcs{background:#dc2626;width:20px;height:20px;font-size:9px}
      .cctv-dot.cluster{background:#374151;width:30px;height:30px;font-size:11px}
      .cctv-modal{position:fixed;inset:0;z-index:2000;background:rgba(0,0,0,.72);display:none;align-items:center;justify-content:center;padding:12px}
      .cctv-modal.open{display:flex}
      .cctv-card{width:100%;max-width:460px;background:#111827;color:#f9fafb;border-radius:14px;overflow:hidden;border:1px solid #374151;font-family:system-ui,sans-serif}
      .cctv-head{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:#1f2937;gap:8px}
      .cctv-title{font-weight:700;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .cctv-close{background:#374151;border:0;color:#fff;width:28px;height:28px;border-radius:50%;cursor:pointer;font-size:16px}
      .cctv-media{position:relative;background:#000;min-height:220px;display:flex;align-items:center;justify-content:center}
      .cctv-media video,.cctv-media img{width:100%;max-height:300px;object-fit:contain;display:block}
      .cctv-msg{padding:20px;text-align:center;font-size:12px;color:#d1d5db;line-height:1.5}
      .cctv-foot{display:flex;align-items:center;justify-content:space-between;padding:9px 14px;font-size:11px;color:#9ca3af;background:#1f2937;gap:8px;flex-wrap:wrap}
      .cctv-link{background:#2563eb;color:#fff;text-decoration:none;padding:5px 10px;border-radius:6px;font-weight:600;border:0;cursor:pointer;font-size:11px}
    `;
    document.head.appendChild(style);
  }

  function ensureModal() {
    let modal = document.getElementById('cctv-pub-modal');
    if (modal) return modal;
    modal = document.createElement('div');
    modal.id = 'cctv-pub-modal';
    modal.className = 'cctv-modal';
    modal.innerHTML = `
      <div class="cctv-card">
        <div class="cctv-head">
          <div class="cctv-title" id="cctv-m-title">CCTV</div>
          <button class="cctv-close" id="cctv-m-close" aria-label="Tutup">&times;</button>
        </div>
        <div class="cctv-media" id="cctv-m-media"></div>
        <div class="cctv-foot">
          <span id="cctv-m-sub">-</span>
          <div id="cctv-m-actions"></div>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal();
    });
    document.getElementById('cctv-m-close').addEventListener('click', closeModal);
    return modal;
  }

  function stopPlayback() {
    clearTimeout(state.stopTimer);
    clearInterval(state.countdownTimer);
    if (state.hls) {
      try { state.hls.destroy(); } catch {}
      state.hls = null;
    }
    const media = document.getElementById('cctv-m-media');
    if (media) {
      const v = media.querySelector('video');
      if (v) {
        try { v.pause(); v.removeAttribute('src'); v.load(); } catch {}
      }
    }
  }

  function closeModal() {
    stopPlayback();
    const modal = document.getElementById('cctv-pub-modal');
    if (modal) modal.classList.remove('open');
    state.activeCam = null;
  }

  function loadHlsScript() {
    if (window.Hls) return Promise.resolve(window.Hls);
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.15/dist/hls.min.js';
      s.onload = () => resolve(window.Hls);
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  function extractHlsErrorDetail(d) {
    let reason = '';
    try {
      const rawText = d && d.networkDetails && d.networkDetails.responseText;
      if (rawText) {
        const parsed = JSON.parse(rawText);
        if (parsed && parsed.error) reason = parsed.error;
      }
    } catch {}
    if (!reason && d && d.response && d.response.code) {
      reason = `HTTP ${d.response.code}`;
    }
    return reason;
  }

  function startAutoStopCountdown(subEl, baseText) {
    const end = Date.now() + STOP_AFTER_MS;
    clearInterval(state.countdownTimer);
    state.countdownTimer = setInterval(() => {
      const left = Math.max(0, Math.ceil((end - Date.now()) / 1000));
      subEl.textContent = `${baseText} • auto-stop ${left}d`;
    }, 1000);
    clearTimeout(state.stopTimer);
    state.stopTimer = setTimeout(() => {
      stopPlayback();
      const media = document.getElementById('cctv-m-media');
      if (media) {
        media.innerHTML = `<div class="cctv-msg">Stream dijeda otomatis setelah 3 menit untuk menghemat kuota.<br><br><button class="cctv-link" id="cctv-retry">Putar Lagi</button></div>`;
        const btn = document.getElementById('cctv-retry');
        if (btn && state.activeCam) btn.onclick = () => openCamera(state.activeCam);
      }
    }, STOP_AFTER_MS);
  }

  async function openCamera(cam) {
    state.activeCam = cam;
    const modal = ensureModal();
    const titleEl = document.getElementById('cctv-m-title');
    const mediaEl = document.getElementById('cctv-m-media');
    const subEl = document.getElementById('cctv-m-sub');
    const actEl = document.getElementById('cctv-m-actions');

    stopPlayback();
    titleEl.textContent = cam.title || 'CCTV Publik';
    actEl.innerHTML = '';
    modal.classList.add('open');

    const streamUrl = cam.streamUrl || '';
    const proxiedUrl = proxyStreamUrl(streamUrl);
    const snapUrl = cam.snapshotUrl || '';
    const pageUrl = cam.pageUrl || '';

    if (pageUrl) {
      const a = document.createElement('a');
      a.className = 'cctv-link';
      a.href = pageUrl;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = 'Buka Sumber';
      actEl.appendChild(a);
    }

    if (streamUrl) {
      mediaEl.innerHTML = `<video id="cctv-vid" controls autoplay muted playsinline></video>`;
      const video = document.getElementById('cctv-vid');
      const baseSub = `${cam.source || 'Stream'} • ${cam.city || ''}`.trim();
      subEl.textContent = baseSub;
      startAutoStopCountdown(subEl, baseSub);

      try {
        const Hls = await loadHlsScript();
        if (Hls && Hls.isSupported()) {
          const hls = new Hls({ maxBufferLength: 10, maxMaxBufferLength: 20 });
          state.hls = hls;
          hls.loadSource(proxiedUrl);
          hls.attachMedia(video);
          hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
          hls.on(Hls.Events.ERROR, (_e, d) => {
            if (d && d.fatal) {
              const reason = extractHlsErrorDetail(d);
              stopPlayback();
              mediaEl.innerHTML = `<div class="cctv-msg">Stream tidak dapat diputar${reason ? ` (${esc(reason)})` : ' atau dibatasi CORS/offline'}.<br>${pageUrl ? 'Gunakan tombol <b>Buka Sumber</b> di bawah.' : ''}</div>`;
            }
          });
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
          video.src = proxiedUrl;
          video.play().catch(() => {});
        } else {
          mediaEl.innerHTML = `<div class="cctv-msg">Browser tidak mendukung pemutar HLS.</div>`;
        }
      } catch {
        mediaEl.innerHTML = `<div class="cctv-msg">Gagal memuat pemutar HLS.</div>`;
      }
      return;
    }

    if (snapUrl) {
      mediaEl.innerHTML = `<img src="${esc(snapUrl)}" alt="${esc(cam.title)}">`;
      subEl.textContent = `${cam.source || 'Windy'} • Snapshot`;
      return;
    }

    const q = encodeURIComponent(`${cam.title || 'ATCS'} ${cam.city || 'Indonesia'} CCTV`);
    mediaEl.innerHTML = `
      <div class="cctv-msg">
        Titik lokasi terverifikasi di <b>${esc(cam.city || 'Indonesia')}</b>.<br>
        Stream video langsung tidak tersedia secara publik dari instansi terkait.<br><br>
        <a class="cctv-link" href="https://www.google.com/search?q=${q}" target="_blank" rel="noopener">Cari Portal ATCS Kota</a>
      </div>`;
    subEl.textContent = `${cam.source || 'ATCS'} • ${cam.lat.toFixed(4)}, ${cam.lon.toFixed(4)}`;
  }

  async function loadAllCameras(map) {
    if (state.loading) return;
    state.loading = true;
    const c = map ? map.getCenter() : { lat: -6.2, lng: 106.82 };
    const base = getWorkerBase();

    const [staticRes, liveRes] = await Promise.allSettled([
      fetch('./cctv-data.json').then((r) => (r.ok ? r.json() : [])),
      fetch(`${base}/api/cctv?lat=${c.lat}&lon=${c.lng}&radius=${FETCH_RADIUS_M}`).then((r) => (r.ok ? r.json() : { cameras: [] })),
    ]);

    const list = [];
    const seen = new Set();

    if (liveRes.status === 'fulfilled' && Array.isArray(liveRes.value.cameras)) {
      for (const cam of liveRes.value.cameras) {
        const key = `${Number(cam.lat).toFixed(4)},${Number(cam.lon).toFixed(4)}`;
        seen.add(key);
        list.push(cam);
      }
    }

    if (staticRes.status === 'fulfilled' && Array.isArray(staticRes.value)) {
      for (const raw of staticRes.value) {
        const lat = Number(raw.lat);
        const lon = Number(raw.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        list.push({
          id: raw.id || key,
          title: raw.n || raw.title || 'Titik ATCS / Lalu Lintas',
          lat,
          lon,
          city: raw.c || raw.city || '',
          source: raw.s || raw.source || 'atcs',
          streamUrl: raw.u || raw.streamUrl || '',
          snapshotUrl: raw.i || raw.snapshotUrl || '',
          pageUrl: raw.p || raw.pageUrl || '',
        });
      }
    }

    state.cams = list;
    state.loaded = true;
    state.loading = false;
  }

  function renderViewport(map) {
    if (!state.enabled || !map || !window.L) return;
    if (!state.layer) state.layer = window.L.layerGroup().addTo(map);
    state.layer.clearLayers();

    const b = map.getBounds();
    const zoom = map.getZoom();
    const inView = state.cams.filter(
      (c) => c.lat >= b.getSouth() && c.lat <= b.getNorth() && c.lon >= b.getWest() && c.lon <= b.getEast()
    );

    if (zoom >= 14 || inView.length <= 80) {
      for (const cam of inView.slice(0, 150)) {
        const cls = cam.source === 'windy' ? 'windy' : cam.source === 'jakcctv' ? 'jakcctv' : 'atcs';
        const label = cam.source === 'windy' ? 'W' : cam.source === 'jakcctv' ? 'J' : 'C';
        const icon = window.L.divIcon({
          className: '',
          html: `<div class="cctv-dot ${cls}" title="${esc(cam.title)}">${label}</div>`,
          iconSize: [24, 24],
          iconAnchor: [12, 12],
        });
        const m = window.L.marker([cam.lat, cam.lon], { icon });
        m.on('click', () => openCamera(cam));
        state.layer.addLayer(m);
      }
      return;
    }

    const step = zoom <= 8 ? 0.25 : zoom <= 10 ? 0.08 : GRID_DEG;
    const buckets = new Map();
    for (const cam of inView) {
      const gx = Math.floor(cam.lat / step);
      const gy = Math.floor(cam.lon / step);
      const k = `${gx}:${gy}`;
      let g = buckets.get(k);
      if (!g) {
        g = { count: 0, lat: 0, lon: 0, sample: cam };
        buckets.set(k, g);
      }
      g.count++;
      g.lat += cam.lat;
      g.lon += cam.lon;
    }

    for (const g of buckets.values()) {
      const lat = g.lat / g.count;
      const lon = g.lon / g.count;
      if (g.count === 1) {
        const cam = g.sample;
        const cls = cam.source === 'windy' ? 'windy' : cam.source === 'jakcctv' ? 'jakcctv' : 'atcs';
        const icon = window.L.divIcon({
          className: '',
          html: `<div class="cctv-dot ${cls}">C</div>`,
          iconSize: [22, 22],
          iconAnchor: [11, 11],
        });
        const m = window.L.marker([lat, lon], { icon });
        m.on('click', () => openCamera(cam));
        state.layer.addLayer(m);
      } else {
        const icon = window.L.divIcon({
          className: '',
          html: `<div class="cctv-dot cluster">${g.count > 999 ? '999+' : g.count}</div>`,
          iconSize: [30, 30],
          iconAnchor: [15, 15],
        });
        const m = window.L.marker([lat, lon], { icon });
        m.on('click', () => map.setView([lat, lon], Math.min(15, zoom + 3)));
        state.layer.addLayer(m);
      }
    }
  }

  function init() {
    injectStyles();
    const btn = document.createElement('button');
    btn.className = 'cctv-btn-toggle';
    btn.type = 'button';
    btn.innerHTML = '<span>CCTV Publik</span>';
    document.body.appendChild(btn);

    btn.addEventListener('click', async () => {
      const map = getMap();
      if (!map) return;
      state.enabled = !state.enabled;
      btn.classList.toggle('active', state.enabled);
      if (!state.enabled) {
        if (state.layer) state.layer.clearLayers();
        return;
      }
      if (!state.loaded) {
        btn.textContent = 'Memuat CCTV...';
        await loadAllCameras(map);
        btn.textContent = `CCTV (${state.cams.length})`;
      }
      renderViewport(map);
    });

    const attachMapHook = setInterval(() => {
      const map = getMap();
      if (!map) return;
      clearInterval(attachMapHook);
      map.on('moveend zoomend', () => {
        if (state.enabled) renderViewport(map);
      });
    }, 600);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
