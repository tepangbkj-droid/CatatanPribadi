// =====================================================================================
// entry.js — pintu masuk Worker (wrangler.toml: main = "entry.js").
// Menambah dua endpoint publik, selebihnya diteruskan apa adanya ke index.js (tidak diubah):
//
//   GET /api/proxy-cctv?url=<URL stream/gambar/segmen>
//       Proxy HLS. Menyuntikkan Referer + Origin atcsindonesia.com, lalu untuk playlist .m3u8
//       menulis ulang semua URL di dalamnya (segmen .ts/.m4s, sub-playlist, #EXT-X-KEY, #EXT-X-MAP,
//       #EXT-X-MEDIA ...) agar ikut lewat proxy ini. Segmen & gambar dialirkan (streaming).
//   GET /api/cctv-points?bbox=S,W,N,E
//       Titik lampu lalu lintas & kamera pengawas (OpenStreetMap/Overpass) untuk satu kotak peta,
//       di-cache 15 menit (Cache API + memori isolate) supaya browser tidak timeout.
//
// Variabel (wrangler.toml [vars]):
//   ALLOW_ORIGIN     WAJIB untuk proxy. Origin aplikasi (boleh beberapa, pisah koma). /api/proxy-cctv hanya melayani permintaan
//                    yang header Origin atau Referer-nya cocok; permintaan langsung dari luar (tanpa keduanya) ditolak 403.
//   CCTV_PROXY_HOSTS WAJIB untuk proxy. Daftar host yang BOLEH diproxy (akhiran domain, subdomain ikut; boleh IP persis).
//                    Kosong = proxy menolak semuanya. Pengalihan (redirect) ke host di luar daftar juga ditolak.
// Catatan keamanan: pemeriksaan Origin/Referer menahan pemakaian dari situs lain lewat browser, tetapi bukan autentikasi:
// klien non-browser bisa memalsukan header. Batas sebenarnya adalah daftar CCTV_PROXY_HOSTS + kuota Worker.
//
// CATATAN: Cache API (caches.default) TIDAK aktif di domain *.workers.dev; di sana yang bekerja hanya
// cache memori isolate (lebih pendek umurnya). Pasang Custom Domain/Route agar cache 15 menit penuh bekerja.
// =====================================================================================
import base from "./index.js";

const REFERER = "https://atcsindonesia.com/";
const ORIGIN = "https://atcsindonesia.com";
const UA = "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36";
const UPSTREAM_TIMEOUT_MS = 15000;
const SNIFF_MAX_BYTES = 3 * 1024 * 1024;

// ---------- CORS & asal permintaan ----------
function allowedOrigins(env) {
  return String(env.ALLOW_ORIGIN || "").split(",").map((x) => x.trim().replace(/\/+$/, "")).filter(Boolean);
}
function corsHeaders(env, req) {
  const list = allowedOrigins(env);
  const o = req && req.headers.get("origin");
  return {
    "access-control-allow-origin": list.length ? (o && list.includes(o) ? o : list[0]) : "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "range, content-type",
    "access-control-expose-headers": "content-length, content-range, accept-ranges, x-cctv-cache, x-cctv-upstream",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}
// Longgar (dipakai /api/cctv-points): hanya menolak Origin yang jelas salah.
function originForbidden(env, req) {
  const list = allowedOrigins(env), o = req.headers.get("origin");
  return !!(list.length && o && !list.includes(o));
}
// Ketat (dipakai /api/proxy-cctv): Origin atau Referer WAJIB ada dan cocok dengan ALLOW_ORIGIN.
function appCheck(env, req) {
  const list = allowedOrigins(env);
  if (!list.length) return { status: 500, error: "ALLOW_ORIGIN belum diisi di wrangler.toml; proxy dinonaktifkan" };
  const o = req.headers.get("origin");
  let src = null;
  if (o && o !== "null") src = o;
  else {
    const r = req.headers.get("referer");
    if (r) { try { src = new URL(r).origin; } catch (e) { src = null; } }
  }
  if (!src) return { status: 403, error: "akses langsung ditolak: permintaan harus datang dari aplikasi (Origin/Referer kosong)" };
  if (!list.includes(src)) return { status: 403, error: "asal permintaan tidak diizinkan" };
  return null;
}
function jsonRes(obj, status, env, req, extra) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders(env, req), "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...(extra || {}) },
  });
}

// ---------- keamanan proxy ----------
function hostBlocked(hostname) {
  const h = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".lan")) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
    const [a, b] = h.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (h.includes(":")) return /^(::1?$|f[cd][0-9a-f]{2}:|fe80:|::ffff:)/.test(h);
  return false;
}
function proxyHostList(env) {
  return String(env.CCTV_PROXY_HOSTS || "").split(",").map((x) => x.trim().toLowerCase().replace(/^\*\./, "")).filter(Boolean);
}
function hostAllowed(env, hostname) {
  const list = proxyHostList(env);
  if (!list.length) return false;                       // tanpa daftar = tolak semua
  const h = hostname.toLowerCase();
  return list.some((d) => h === d || h.endsWith("." + d));
}
class ProxyError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

// Ikuti pengalihan satu per satu (maks 3) dan periksa ulang tiap host, supaya whitelist tidak bisa dilewati lewat redirect.
async function fetchUpstream(startUrl, headers, signal, env) {
  let url = startUrl;
  for (let hop = 0; hop <= 3; hop++) {
    const res = await fetch(url.href, { method: "GET", headers, redirect: "manual", signal });
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!loc) return { res, url };
    try { await res.body.cancel(); } catch (e) { /* abaikan */ }
    let next;
    try { next = new URL(loc, url); } catch (e) { throw new ProxyError(502, "alamat pengalihan tidak valid"); }
    if (!/^https?:$/.test(next.protocol) || hostBlocked(next.hostname) || !hostAllowed(env, next.hostname)) {
      throw new ProxyError(403, "pengalihan ke host yang tidak diizinkan: " + next.hostname);
    }
    url = next;
  }
  throw new ProxyError(508, "terlalu banyak pengalihan");
}

// ---------- penulisan ulang playlist HLS ----------
function rewriteM3u8(text, baseUrl, selfBase) {
  const prox = (raw) => {
    if (/^data:/i.test(raw)) return raw;
    try { return selfBase + "/api/proxy-cctv?url=" + encodeURIComponent(new URL(raw, baseUrl).href); }
    catch (e) { return raw; }
  };
  return text.split(/\r?\n/).map((line) => {
    const t = line.trim();
    if (!t) return line;
    if (t.charAt(0) === "#") return line.replace(/URI="([^"]+)"/g, (m, uri) => 'URI="' + prox(uri) + '"');
    return prox(t);
  }).join("\n");
}

const MEDIA_EXT = /\.(ts|m4s|mp4|m4a|aac|jpe?g|png|webp|gif|key|vtt|flv)$/i;

async function handleProxy(req, env) {
  const gate = appCheck(env, req);
  if (gate) return jsonRes({ ok: false, error: gate.error }, gate.status, env, req);
  if (!proxyHostList(env).length) return jsonRes({ ok: false, error: "CCTV_PROXY_HOSTS belum diisi di wrangler.toml; proxy dinonaktifkan" }, 500, env, req);
  const self = new URL(req.url);
  const raw = self.searchParams.get("url") || "";
  let target;
  try { target = new URL(raw); } catch (e) { return jsonRes({ ok: false, error: "parameter url tidak valid" }, 400, env, req); }
  if (raw.length > 2000 || !/^https?:$/.test(target.protocol)) return jsonRes({ ok: false, error: "hanya http/https" }, 400, env, req);
  if (target.host === self.host) return jsonRes({ ok: false, error: "tidak boleh memproxy dirinya sendiri" }, 400, env, req);
  if (hostBlocked(target.hostname)) return jsonRes({ ok: false, error: "host diblokir" }, 403, env, req);
  if (!hostAllowed(env, target.hostname)) return jsonRes({ ok: false, error: "host tidak ada di daftar CCTV_PROXY_HOSTS: " + target.hostname }, 403, env, req);

  const headers = new Headers({
    "user-agent": UA,
    referer: REFERER,
    origin: ORIGIN,
    accept: req.headers.get("accept") || "*/*",
    "accept-language": "id-ID,id;q=0.9,en;q=0.8",
  });
  const range = req.headers.get("range"); if (range) headers.set("range", range);

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), UPSTREAM_TIMEOUT_MS);
  let res, finalU;
  try { const r = await fetchUpstream(target, headers, ctl.signal, env); res = r.res; finalU = r.url; }
  catch (e) {
    if (e instanceof ProxyError) return jsonRes({ ok: false, error: e.message }, e.status, env, req);
    return jsonRes({ ok: false, error: e && e.name === "AbortError" ? "server kamera tidak merespons (waktu habis)" : "server kamera tidak dapat dijangkau" }, 504, env, req);
  } finally { clearTimeout(timer); }

  const finalUrl = finalU.href;
  const finalPath = new URL(finalUrl).pathname;
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  const out = { ...corsHeaders(env, req), "x-cctv-upstream": String(res.status) };

  if (!res.ok && res.status !== 206) {
    try { await res.body.cancel(); } catch (e) { /* abaikan */ }
    return jsonRes({ ok: false, error: "server kamera membalas HTTP " + res.status }, res.status >= 400 && res.status < 600 ? res.status : 502, env, req, { "x-cctv-upstream": String(res.status) });
  }

  const looksM3u8 = /\.m3u8?$/i.test(finalPath) || /mpegurl/.test(ct);
  const isPlainMedia = MEDIA_EXT.test(finalPath) || /^(image|video|audio)\//.test(ct);

  // Media biasa (segmen, gambar, mp4): alirkan langsung tanpa membaca isinya.
  if (!looksM3u8 && isPlainMedia) {
    ["content-type", "content-length", "content-range", "accept-ranges"].forEach((k) => { const v = res.headers.get(k); if (v) out[k] = v; });
    out["cache-control"] = /\.(ts|m4s)$/i.test(finalPath) ? "public, max-age=30" : "no-store";
    return new Response(res.body, { status: res.status, headers: out });
  }

  // Playlist, atau tipe tak jelas (alamat tanpa ekstensi): baca dan cek apakah isinya playlist HLS.
  const len = Number(res.headers.get("content-length") || 0);
  if (!looksM3u8 && len > SNIFF_MAX_BYTES) {
    ["content-type", "content-length", "content-range", "accept-ranges"].forEach((k) => { const v = res.headers.get(k); if (v) out[k] = v; });
    out["cache-control"] = "no-store";
    return new Response(res.body, { status: res.status, headers: out });
  }
  const buf = await res.arrayBuffer();
  const head = new TextDecoder().decode(buf.slice(0, 16)).replace(/^\uFEFF/, "").trimStart();
  if (looksM3u8 || head.startsWith("#EXTM3U")) {
    const text = new TextDecoder().decode(buf);
    if (!text.trimStart().replace(/^\uFEFF/, "").startsWith("#EXTM3U")) return jsonRes({ ok: false, error: "isi bukan playlist HLS yang valid" }, 502, env, req);
    out["content-type"] = "application/vnd.apple.mpegurl";
    out["cache-control"] = "no-store";
    return new Response(rewriteM3u8(text, finalUrl, self.origin), { status: 200, headers: out });
  }
  if (/text\/html|json|xml|javascript/.test(ct)) return jsonRes({ ok: false, error: "tipe respons tidak didukung proxy (" + (ct.split(";")[0] || "?") + ")" }, 415, env, req);
  if (ct) out["content-type"] = ct;
  out["cache-control"] = "no-store";
  return new Response(buf, { status: res.status, headers: out });
}

// ---------- /api/cctv-points (Overpass + cache 15 menit) ----------
const OVP_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];
const POINTS_TTL_S = 15 * 60;
const POINTS_STALE_S = 24 * 3600;
const GRID = 0.05;                    // kotak diratakan ke grid 0,05° supaya banyak pengguna berbagi cache yang sama
const MAX_SPAN = 0.3;
const memCache = new Map();           // cadangan bila Cache API tidak aktif (workers.dev)
const MEM_MAX = 80;

function memGet(key, maxAgeMs) { const v = memCache.get(key); return v && Date.now() - v.t < maxAgeMs ? v.body : null; }
function memSet(key, body) { memCache.set(key, { t: Date.now(), body }); while (memCache.size > MEM_MAX) memCache.delete(memCache.keys().next().value); }

async function queryOverpass(q) {
  let lastErr = "";
  for (const url of OVP_URLS) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 14000);
    try {
      const r = await fetch(url, {
        method: "POST", body: "data=" + encodeURIComponent(q), signal: ctl.signal,
        headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "BukuKasGPS/1.0 (peta CCTV; cache Worker)" },
      });
      if (!r.ok) { lastErr = "HTTP " + r.status; continue; }
      const j = await r.json();
      if (j && Array.isArray(j.elements)) return j;
      lastErr = "respons kosong";
    } catch (e) { lastErr = e && e.name === "AbortError" ? "waktu habis" : "koneksi gagal"; }
    finally { clearTimeout(timer); }
  }
  throw new Error(lastErr || "gagal");
}

async function handlePoints(req, env, ctx) {
  if (originForbidden(env, req)) return jsonRes({ ok: false, error: "forbidden origin" }, 403, env, req);
  const u = new URL(req.url);
  const p = (u.searchParams.get("bbox") || "").split(",").map(Number);
  if (p.length !== 4 || p.some((v) => !Number.isFinite(v))) return jsonRes({ ok: false, error: "bbox harus S,W,N,E" }, 400, env, req);
  let [s, w, n, e] = p;
  if (s >= n || w >= e || s < -90 || n > 90 || w < -180 || e > 180 || n - s > MAX_SPAN || e - w > MAX_SPAN) {
    return jsonRes({ ok: false, error: "bbox tidak valid atau terlalu luas (maks " + MAX_SPAN + "°)" }, 400, env, req);
  }
  const f = (v) => Number(v.toFixed(5));
  const S = f(Math.floor(s / GRID) * GRID), W = f(Math.floor(w / GRID) * GRID), N = f(Math.ceil(n / GRID) * GRID), E = f(Math.ceil(e / GRID) * GRID);
  const id = [S, W, N, E].join("_");
  const freshReq = new Request("https://cctv-cache.invalid/points/" + id);
  const staleReq = new Request("https://cctv-cache.invalid/points-stale/" + id);
  const jh = (extra) => ({ ...corsHeaders(env, req), "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=60", ...extra });

  let cache = null; try { cache = caches.default; } catch (err) { cache = null; }

  const mem = memGet("f:" + id, POINTS_TTL_S * 1000);
  if (mem) return new Response(mem, { status: 200, headers: jh({ "x-cctv-cache": "MEM" }) });
  if (cache) {
    try {
      const hit = await cache.match(freshReq);
      if (hit) { const body = await hit.text(); memSet("f:" + id, body); return new Response(body, { status: 200, headers: jh({ "x-cctv-cache": "HIT" }) }); }
    } catch (err) { /* cache rusak: ambil baru */ }
  }

  const bb = S + "," + W + "," + N + "," + E;
  const q = '[out:json][timeout:25];(node["highway"="traffic_signals"](' + bb + ');node["man_made"="surveillance"](' + bb + ');node["highway"="speed_camera"](' + bb + '););out body 3000;';
  try {
    const j = await queryOverpass(q);
    const body = JSON.stringify({ ok: true, bbox: [S, W, N, E], count: j.elements.length, cachedAt: Date.now(), elements: j.elements });
    memSet("f:" + id, body); memSet("s:" + id, body);
    if (cache) {
      const put = Promise.all([
        cache.put(freshReq, new Response(body, { headers: { "content-type": "application/json", "cache-control": "public, max-age=" + POINTS_TTL_S } })),
        cache.put(staleReq, new Response(body, { headers: { "content-type": "application/json", "cache-control": "public, max-age=" + POINTS_STALE_S } })),
      ]).catch(() => {});
      if (ctx && ctx.waitUntil) ctx.waitUntil(put);
    }
    return new Response(body, { status: 200, headers: jh({ "x-cctv-cache": "MISS" }) });
  } catch (err) {
    // Overpass gagal: sajikan data lama (maks 24 jam) bila ada, lebih baik daripada banner error.
    let stale = memGet("s:" + id, POINTS_STALE_S * 1000);
    if (!stale && cache) { try { const hit = await cache.match(staleReq); if (hit) stale = await hit.text(); } catch (e2) { /* abaikan */ } }
    if (stale) return new Response(stale, { status: 200, headers: jh({ "x-cctv-cache": "STALE" }) });
    return jsonRes({ ok: false, error: "Overpass: " + ((err && err.message) || "gagal") }, 502, env, req);
  }
}

export default {
  async fetch(req, env, ctx) {
    const path = new URL(req.url).pathname;
    if (path === "/api/proxy-cctv" || path === "/api/cctv-points") {
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(env, req) });
      if (req.method !== "GET") return jsonRes({ ok: false, error: "method tidak didukung" }, 405, env, req);
      try { return path === "/api/proxy-cctv" ? await handleProxy(req, env) : await handlePoints(req, env, ctx); }
      catch (e) { return jsonRes({ ok: false, error: "gagal: " + ((e && e.message) || e) }, 502, env, req); }
    }
    return base.fetch(req, env, ctx);
  },
  async scheduled(event, env, ctx) {
    return base.scheduled(event, env, ctx);
  },
};
