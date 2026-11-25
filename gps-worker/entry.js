/**
 * entry.js — Router pembungkus untuk Worker GPS Pelacak Motor + Proxy CCTV + Overpass
 *
 * Rute tambahan yang ditangani di sini:
 *   GET  /api/proxy/cctv?url=...   → Proxy HLS (.m3u8/.ts/.m4s) + injeksi header Referer/Origin
 *   GET  /api/cctv-points?...      → Titik lampu merah & kamera pengawas dari OSM Overpass
 *
 * Semua rute lain diteruskan langsung ke index.js.
 */

import mainWorker from './index.js';

const DEFAULT_ALLOWED_HOSTS = [
  'balitower.co.id',
  'atcsindonesia.com',
  'jakcctv.jakarta.go.id',
  'jakarta.go.id',
  'bandung.go.id',
  'surabaya.go.id',
  'semarangkota.go.id',
  'jogjakota.go.id',
  'depok.go.id',
  'bekasikota.go.id',
  'tangerangkota.go.id',
  'bogorkota.go.id',
  'jasamarga.com',
  'binamarga.pu.go.id',
  'pu.go.id',
  'dephub.go.id',
  'molecool.id',
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const OVERPASS_MEM = new Map();
const MAX_OVERPASS_MEM = 80;

function corsHeaders(env, origin) {
  const allowed = (env && env.ALLOW_ORIGIN) || '*';
  return {
    'Access-Control-Allow-Origin': allowed === '*' ? '*' : (origin || allowed),
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Range',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Content-Type',
  };
}

function jsonResp(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extra },
  });
}

function getAllowedHosts(env) {
  const raw = env && env.CCTV_PROXY_HOSTS;
  if (!raw || !String(raw).trim()) return DEFAULT_ALLOWED_HOSTS;
  const parsed = String(raw).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return parsed.length ? parsed : DEFAULT_ALLOWED_HOSTS;
}

function isHostAllowed(hostname, allowedList) {
  const h = hostname.toLowerCase();
  return allowedList.some((allowed) => h === allowed || h.endsWith('.' + allowed));
}

function guessUpstreamHeaders(targetUrl) {
  const u = new URL(targetUrl);
  const host = u.hostname.toLowerCase();
  const h = {
    'User-Agent': UA,
    'Accept': '*/*',
    'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
    'Connection': 'keep-alive',
  };

  if (host.includes('atcsindonesia.com')) {
    h['Referer'] = 'https://atcsindonesia.com/';
    h['Origin'] = 'https://atcsindonesia.com';
  } else if (host.includes('balitower.co.id') || host.includes('jakarta.go.id')) {
    h['Referer'] = 'https://jakcctv.jakarta.go.id/';
    h['Origin'] = 'https://jakcctv.jakarta.go.id';
  } else if (host.includes('bandung.go.id')) {
    h['Referer'] = 'https://pelindung.bandung.go.id/';
    h['Origin'] = 'https://pelindung.bandung.go.id';
  } else if (host.includes('jasamarga.com')) {
    h['Referer'] = 'https://travoy.jasamarga.com/';
    h['Origin'] = 'https://travoy.jasamarga.com';
  } else {
    h['Referer'] = `${u.protocol}//${u.host}/`;
    h['Origin'] = `${u.protocol}//${u.host}`;
  }
  return h;
}

function resolveRelativeUrl(baseUrl, line) {
  try {
    return new URL(line, baseUrl).toString();
  } catch {
    return line;
  }
}

function rewriteM3u8(body, baseUrl, proxyPrefix) {
  return body
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#')) {
        return line.replace(/URI=(["'])([^"']+)\1/gi, (_m, q, uri) => {
          const abs = resolveRelativeUrl(baseUrl, uri);
          return `URI=${q}${proxyPrefix}${encodeURIComponent(abs)}${q}`;
        });
      }
      const abs = resolveRelativeUrl(baseUrl, trimmed);
      return `${proxyPrefix}${encodeURIComponent(abs)}`;
    })
    .join('\n');
}

async function handleProxy(request, url, env, cors) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return jsonResp({ ok: false, error: 'Method tidak didukung' }, 405, cors);
  }

  let targetRaw = url.searchParams.get('url');
  if (!targetRaw && url.pathname.startsWith('/api/proxy/cctv/')) {
    const rest = url.pathname.slice('/api/proxy/cctv/'.length);
    if (rest) {
      targetRaw = `https://atcsindonesia.com/${rest}${url.search || ''}`;
    }
  }
  if (!targetRaw) {
    return jsonResp({ ok: false, error: 'Parameter ?url= wajib diisi' }, 400, cors);
  }

  let targetUrl;
  try {
    targetUrl = new URL(targetRaw);
  } catch {
    return jsonResp({ ok: false, error: 'URL tidak valid' }, 400, cors);
  }

  if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
    return jsonResp({ ok: false, error: 'Hanya protokol http/https yang didukung' }, 400, cors);
  }

  const allowed = getAllowedHosts(env);
  const isSegment = /\.(ts|m4s|mp4|aac|key)(\?|$)/i.test(targetUrl.pathname);
  if (!isSegment && !isHostAllowed(targetUrl.hostname, allowed)) {
    return jsonResp(
      { ok: false, error: `Host ${targetUrl.hostname} tidak ada di CCTV_PROXY_HOSTS` },
      403,
      cors
    );
  }

  const upstreamHeaders = guessUpstreamHeaders(targetUrl.toString());
  const range = request.headers.get('Range');
  if (range) upstreamHeaders['Range'] = range;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 14000);
  let upstream;
  try {
    upstream = await fetch(targetUrl.toString(), {
      method: request.method,
      headers: upstreamHeaders,
      redirect: 'follow',
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const msg = err && err.name === 'AbortError'
      ? 'Server kamera timeout (>14 detik)'
      : `Koneksi ke server kamera gagal: ${err && err.message ? err.message : 'TLS/Network error'}`;
    return jsonResp({ ok: false, error: msg }, 502, cors);
  }
  clearTimeout(timer);

  if (!upstream.ok) {
    return jsonResp(
      { ok: false, error: `Server kamera mengembalikan HTTP ${upstream.status} (${targetUrl.hostname})` },
      upstream.status === 404 ? 404 : 502,
      cors
    );
  }

  const ct = (upstream.headers.get('content-type') || '').toLowerCase();
  const finalUrl = upstream.url || targetUrl.toString();
  const isM3u8 =
    ct.includes('mpegurl') ||
    ct.includes('vnd.apple') ||
    /\.m3u8(\?|$)/i.test(finalUrl);

  const isHtmlOrJson = ct.includes('text/html') || ct.includes('application/json');
  if (isHtmlOrJson && !isM3u8) {
    return jsonResp(
      { ok: false, error: `Stream diblokir WAF atau kamera offline (HTTP ${upstream.status}, ${ct.split(';')[0]})` },
      502,
      cors
    );
  }

  if (isM3u8) {
    const text = await upstream.text();
    if (!text.includes('#EXTM3U')) {
      return jsonResp(
        { ok: false, error: 'Stream ATCS sedang offline (manifest #EXTM3U kosong/tidak valid)' },
        502,
        cors
      );
    }
    const proxyPrefix = `${url.origin}/api/proxy/cctv?url=`;
    const rewritten = rewriteM3u8(text, finalUrl, proxyPrefix);
    return new Response(rewritten, {
      status: 200,
      headers: {
        ...cors,
        'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
        'Cache-Control': 'no-store, max-age=0',
      },
    });
  }

  const outHeaders = new Headers(cors);
  outHeaders.set('Content-Type', ct || 'video/mp2t');
  const cl = upstream.headers.get('content-length');
  if (cl) outHeaders.set('Content-Length', cl);
  const cr = upstream.headers.get('content-range');
  if (cr) outHeaders.set('Content-Range', cr);
  outHeaders.set('Cache-Control', 'public, max-age=5');

  return new Response(upstream.body, {
    status: upstream.status,
    headers: outHeaders,
  });
}

function snapGrid(val, step = 0.05) {
  return Math.round(val / step) * step;
}

async function fetchOverpass(query) {
  let lastErr = null;
  for (const ep of OVERPASS_ENDPOINTS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 14000);
    try {
      const res = await fetch(ep, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'User-Agent': 'GPS-Tracker-Worker/1.0',
        },
        body: `data=${encodeURIComponent(query)}`,
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        lastErr = new Error(`HTTP ${res.status}`);
        continue;
      }
      return await res.json();
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
    }
  }
  throw lastErr || new Error('Semua mirror Overpass gagal');
}

async function handleCctvPoints(request, url, cors) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }
  const lat = parseFloat(url.searchParams.get('lat'));
  const lon = parseFloat(url.searchParams.get('lon'));
  let radius = parseInt(url.searchParams.get('radius') || '3500', 10);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return jsonResp({ ok: false, error: 'Parameter lat & lon wajib diisi' }, 400, cors);
  }
  if (!Number.isFinite(radius) || radius < 500) radius = 500;
  if (radius > 8000) radius = 8000;

  const sLat = snapGrid(lat, 0.05);
  const sLon = snapGrid(lon, 0.05);
  const sRad = Math.round(radius / 500) * 500;
  const cacheKey = `${sLat.toFixed(2)},${sLon.toFixed(2)},${sRad}`;

  const memHit = OVERPASS_MEM.get(cacheKey);
  if (memHit && Date.now() - memHit.ts < 6 * 3600 * 1000) {
    return jsonResp(memHit.data, 200, { ...cors, 'X-Cache': 'MEM' });
  }

  const cache = caches.default;
  const cacheReq = new Request(`https://cctv-overpass.cache/${cacheKey}`);
  const edgeHit = await cache.match(cacheReq);
  if (edgeHit) {
    const body = await edgeHit.text();
    return new Response(body, {
      status: 200,
      headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'X-Cache': 'EDGE' },
    });
  }

  const q = `[out:json][timeout:12];(node["highway"="traffic_signals"](around:${sRad},${sLat},${sLon});node["man_made"="surveillance"](around:${sRad},${sLat},${sLon});node["amenity"="speed_camera"](around:${sRad},${sLat},${sLon}););out body 120;`;

  let raw;
  try {
    raw = await fetchOverpass(q);
  } catch (err) {
    return jsonResp(
      { ok: false, error: `Overpass gagal: ${err && err.message ? err.message : 'timeout'}`, points: [] },
      502,
      cors
    );
  }

  const seen = new Set();
  const points = [];
  for (const el of raw.elements || []) {
    if (typeof el.lat !== 'number' || typeof el.lon !== 'number') continue;
    const key = `${el.lat.toFixed(4)},${el.lon.toFixed(4)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const tags = el.tags || {};
    const kind =
      tags.man_made === 'surveillance'
        ? 'cctv'
        : tags.amenity === 'speed_camera'
        ? 'etle'
        : 'atcs';
    points.push({
      id: el.id,
      lat: el.lat,
      lon: el.lon,
      kind,
      name:
        tags.name ||
        tags['name:id'] ||
        tags.operator ||
        (kind === 'cctv' ? 'Kamera Pengawas' : kind === 'etle' ? 'Kamera ETLE' : 'Simpang ATCS'),
    });
  }

  const payload = { ok: true, count: points.length, points };
  const bodyStr = JSON.stringify(payload);

  if (OVERPASS_MEM.size >= MAX_OVERPASS_MEM) {
    const firstKey = OVERPASS_MEM.keys().next().value;
    OVERPASS_MEM.delete(firstKey);
  }
  OVERPASS_MEM.set(cacheKey, { ts: Date.now(), data: payload });

  try {
    await cache.put(
      cacheReq,
      new Response(bodyStr, {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'public, max-age=21600',
        },
      })
    );
  } catch {}

  return new Response(bodyStr, {
    status: 200,
    headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'X-Cache': 'MISS' },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(env, origin);

    if (
      url.pathname === '/api/proxy-cctv' ||
      url.pathname === '/api/proxy/cctv' ||
      url.pathname.startsWith('/api/proxy/cctv/')
    ) {
      return handleProxy(request, url, env, cors);
    }

    if (url.pathname === '/api/cctv-points') {
      return handleCctvPoints(request, url, cors);
    }

    return mainWorker.fetch(request, env, ctx);
  },

  async scheduled(event, env, ctx) {
    if (typeof mainWorker.scheduled === 'function') {
      return mainWorker.scheduled(event, env, ctx);
    }
  },
};
