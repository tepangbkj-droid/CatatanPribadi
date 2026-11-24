// =====================================================================================
// Layer CCTV publik untuk peta: GET /api/cctv
//
// Menggabungkan:
//   1. Windy Webcams API v3 (kamera publik sekitar Depok, radius 50 km) -> sourceType "windy"
//      (bila kamera tidak punya URL player, dikirim sebagai "portal" ke halaman detail Windy)
//   2. JakCCTV resmi Pemprov DKI (jakcctv.jakarta.go.id/publik/data?q=&page=1..7) -> "hls"
//      URL Balitower/Flussonic ".../embed.html" otomatis diubah ke ".../index.m3u8" (siap Hls.js).
//      Hasil digabung (nama, lat, lng, URL) lalu di-cache 30 menit (Cache API + memori isolate).
//      Bila JakCCTV gagal / kosong: pakai cache lama (stale), terakhir titik statis dki(...) di bawah.
//   3. Titik statis lokal: stream HLS (.m3u8) -> "hls"; halaman portal resmi -> "portal"
//   4. (opsional) env.CCTV_EXTRA = JSON array titik tambahan, tanpa perlu ubah kode
//
// Respons seragam:
//   { ok, count, cameras:[{ id, title, lat, lng, sourceType, streamUrl, streamUrls, playerUrl, embedUrl, portalUrl,
//                           provider, approx }], sources:{...}, attribution }
//
// Query opsional:  ?nearby=lat,lon,radiusKm (default -6.4025,106.7942,50; radius maks 250)   ?windy=0 (lewati Windy)
//                  ?jakcctv=0 (lewati JakCCTV)   ?debug=1 (tampilkan diagnosa parsing JakCCTV di sources.jakcctv.diag)
//
// Rahasia: env.WINDY_API_KEY (Windy memakai header x-windy-api-key). Kunci TIDAK pernah dikirim ke browser.
// CORS: Access-Control-Allow-Origin: * (data publik). Hasil Windy di-cache 10 menit di isolate Worker agar kuota
// Windy tidak habis; bila Windy gagal, data lama (stale) tetap dikirim.
// =====================================================================================

const WINDY_URL = "https://api.windy.com/webcams/api/v3/webcams";
const DEFAULT_NEARBY = "-6.4025,106.7942,50";
const PAGE_SIZE = 50;
const MAX_PAGES = 3;
const FETCH_TIMEOUT_MS = 8000;
const TTL_MS = 10 * 60 * 1000;
const UA = "BukuKasGPS/1.0 (peta CCTV publik)";

// JakCCTV (portal publik DKI Jakarta)
const JAK_DATA_URL = "https://jakcctv.jakarta.go.id/publik/data";
const JAK_PAGES = 7;                 // 52 kamera / ~8 per halaman
const JAK_TTL_S = 30 * 60;           // 30 menit (max-age=1800)
const JAK_CACHE_PATH = "/__cache/jakcctv-v1";
const JAK_UA = "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};

// ---------- titik statis ----------
// Koordinat dengan approx:true adalah PERKIRAAN. Perbaiki lewat Google Maps (tekan lama di titik -> salin lat,lng).
const DEPOK_PORTAL = "https://dishub.depok.go.id/cctv";
const DKI_PORTAL = "https://jakcctv.jakarta.go.id/publik";
const DKI_HOST = "https://dki-jkt.balitower.co.id:7028";

// Kamera portal publik DKI: pola alamat stream = TEBAKAN pola server Flussonic (belum diuji). Pemutar di aplikasi
// mencoba semua kandidat, lalu menawarkan pemutar embed resmi dan tombol portal bila semuanya gagal.
const dki = (id, title, lat, lng, kode, n) => {
  const base = `${DKI_HOST}/${kode}_CCTV-0${n}`;
  return {
    id, title: `${title} (CCTV-0${n})`, lat, lng, sourceType: "hls",
    streamUrl: `${base}/index.m3u8`, streamUrls: [`${base}/index.m3u8`, `${base}/video.m3u8`],
    embedUrl: `${base}/embed.html`, portalUrl: DKI_PORTAL, provider: "CCTV Publik DKI Jakarta", approx: true,
  };
};

const STATIC_CAMERAS = [
  // --- Kota Depok (portal Dishub) ---
  { id: "depok-margonda-juanda", title: "Simpang Margonda - Juanda, Depok", lat: -6.3896, lng: 106.8226, sourceType: "portal", portalUrl: DEPOK_PORTAL, provider: "ATCS Dishub Kota Depok", approx: true },
  { id: "depok-gdc", title: "Simpang GDC (Grand Depok City), Depok", lat: -6.4148, lng: 106.8665, sourceType: "portal", portalUrl: DEPOK_PORTAL, provider: "ATCS Dishub Kota Depok", approx: true },
  // --- Jakarta: portal publik DKI (jakcctv.jakarta.go.id/publik) ---
  dki("dki-gatot-subroto-jpo7-1", "JPO Jl. Gatot Subroto 7", -6.2137, 106.8081, "502045_JKP_POLDA_JPO-JL.-GATOT-SUBROTO-7", 1),
  dki("dki-gatot-subroto-jpo7-2", "JPO Jl. Gatot Subroto 7", -6.2137, 106.8081, "502045_JKP_POLDA_JPO-JL.-GATOT-SUBROTO-7", 2),
  dki("dki-gerbang-pemuda-c02-1", "Jl. Gerbang Pemuda C02", -6.2150, 106.8068, "502155_JKP_POLDA_JL.-GERBANG-PEMUDA-C02", 1),
  dki("dki-gerbang-pemuda-c02-2", "Jl. Gerbang Pemuda C02", -6.2150, 106.8068, "502155_JKP_POLDA_JL.-GERBANG-PEMUDA-C02", 2),
  dki("dki-gerbang-pemuda-c03-1", "Jl. Gerbang Pemuda C03", -6.2165, 106.8055, "502160_JKP_POLDA_JL.-GERBANG-PEMUDA-C03", 1),
  dki("dki-gerbang-pemuda-c03-2", "Jl. Gerbang Pemuda C03", -6.2165, 106.8055, "502160_JKP_POLDA_JL.-GERBANG-PEMUDA-C03", 2),
  dki("dki-gerbang-pemuda-c04-1", "Jl. Gerbang Pemuda C04", -6.2180, 106.8042, "502506_JKP_SATPOL-PP_JL.-GERBANG-PEMUDA-C04", 1),
  dki("dki-gerbang-pemuda-c04-2", "Jl. Gerbang Pemuda C04", -6.2180, 106.8042, "502506_JKP_SATPOL-PP_JL.-GERBANG-PEMUDA-C04", 2),
  // ATCS Bandung / Semarang: tambahkan lewat env CCTV_EXTRA setelah URL .m3u8 resminya Anda verifikasi, contoh:
  // [{"id":"bdg-1","title":"Simpang Dago","lat":-6.8915,"lng":107.6107,"sourceType":"hls","streamUrl":"https://.../index.m3u8","portalUrl":"https://atcs-dishub.bandung.go.id","provider":"ATCS Kota Bandung"}]
];

// ---------- util ----------
const isHttps = (u) => typeof u === "string" && /^https:\/\/[^\s]+$/i.test(u) && u.length <= 600;
const num = (v) => (v === null || v === undefined || v === "" ? NaN : Number(v));
const okCoord = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
const clip = (s, n) => String(s == null ? "" : s).slice(0, n);

/** Seragamkan satu kamera; kembalikan null bila tidak valid. */
function normalize(c) {
  if (!c || typeof c !== "object") return null;
  const lat = num(c.lat), lng = num(c.lng);
  if (!c.id || !okCoord(lat, lng)) return null;
  let type = ["windy", "hls", "portal"].includes(c.sourceType) ? c.sourceType : null;
  const streamUrls = (Array.isArray(c.streamUrls) ? c.streamUrls : []).concat(c.streamUrl ? [c.streamUrl] : []).filter(isHttps);
  const uniq = [...new Set(streamUrls)];
  const playerUrl = isHttps(c.playerUrl) ? c.playerUrl : null;
  const portalUrl = isHttps(c.portalUrl) ? c.portalUrl : null;
  if (!type) type = playerUrl ? "windy" : uniq.length ? "hls" : "portal";
  if (type === "hls" && !uniq.length) type = portalUrl ? "portal" : null;
  if (type === "windy" && !playerUrl) type = portalUrl ? "portal" : null;
  if (type === "portal" && !portalUrl) return null;
  if (!type) return null;
  return {
    id: clip(c.id, 80), title: clip(c.title || "CCTV", 120), lat: +lat.toFixed(6), lng: +lng.toFixed(6),
    sourceType: type,
    streamUrl: type === "hls" ? uniq[0] : null,
    streamUrls: type === "hls" ? uniq : [],
    playerUrl: type === "windy" ? playerUrl : null,
    embedUrl: isHttps(c.embedUrl) ? c.embedUrl : null,
    portalUrl,
    provider: clip(c.provider || "", 80),
    approx: !!c.approx,
  };
}

async function fetchT(url, init, label = "Windy") {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try { return await fetch(url, { ...init, signal: ctl.signal }); }
  catch (e) { throw e && e.name === "AbortError" ? new Error(label + " tidak merespons (timeout)") : e; }
  finally { clearTimeout(timer); }
}

// ---------- Windy ----------
const mem = new Map();      // nearby -> { t, cams, total }
const inflight = new Map(); // nearby -> Promise (hindari panggilan ganda ke Windy)

function mapWindy(w) {
  const loc = w.location || {};
  const player = w.player || {};
  const urls = w.urls || {};
  const playerUrl = player.live || player.day || player.lifetime || null;
  return normalize({
    id: "windy-" + w.webcamId,
    title: [w.title, loc.city].filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).join(" • ") || "Webcam",
    lat: loc.latitude, lng: loc.longitude,
    sourceType: playerUrl ? "windy" : "portal",
    playerUrl, portalUrl: urls.detail || null, provider: "Windy Webcams",
  });
}

async function pullWindy(env, nearby) {
  const all = [];
  let total = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const u = new URL(WINDY_URL);
    u.searchParams.set("nearby", nearby);
    u.searchParams.set("include", "location,player,urls");
    u.searchParams.set("limit", String(PAGE_SIZE));
    u.searchParams.set("offset", String(page * PAGE_SIZE));
    const r = await fetchT(u.toString(), { headers: { "x-windy-api-key": env.WINDY_API_KEY, accept: "application/json", "user-agent": UA } });
    if (r.status === 401 || r.status === 403) throw Object.assign(new Error("WINDY_API_KEY ditolak Windy (kunci salah atau belum aktif)"), { code: "windy_auth" });
    if (r.status === 429) throw Object.assign(new Error("Kuota Windy habis, coba lagi nanti"), { code: "windy_quota" });
    if (!r.ok) throw new Error("Windy HTTP " + r.status);
    const j = await r.json();
    const list = Array.isArray(j.webcams) ? j.webcams : [];
    total = Number(j.total) || total;
    list.forEach((w) => { if (!w || w.status === "inactive") return; const c = mapWindy(w); if (c) all.push(c); });
    if (list.length < PAGE_SIZE || all.length >= total) break;
  }
  return { cams: all, total };
}

async function getWindy(env, nearby) {
  if (!env.WINDY_API_KEY) return { cams: [], status: { configured: false, error: "WINDY_API_KEY belum diisi di Worker" } };
  const hit = mem.get(nearby);
  if (hit && Date.now() - hit.t < TTL_MS) return { cams: hit.cams, status: { configured: true, count: hit.cams.length, cached: true } };
  let p = inflight.get(nearby);
  if (!p) {
    p = pullWindy(env, nearby).finally(() => inflight.delete(nearby));
    inflight.set(nearby, p);
  }
  try {
    const { cams, total } = await p;
    mem.set(nearby, { t: Date.now(), cams, total });
    return { cams, status: { configured: true, count: cams.length, total, cached: false } };
  } catch (e) {
    if (hit) return { cams: hit.cams, status: { configured: true, count: hit.cams.length, stale: true, error: e.message } };
    return { cams: [], status: { configured: true, count: 0, error: e.message || "Windy gagal", code: e.code } };
  }
}

// ---------- JakCCTV (portal publik Pemprov DKI) ----------
const jakMem = { t: 0, data: null };   // cache memori isolate (cadangan bila Cache API tidak aktif, mis. di *.workers.dev)
let jakInflight = null;

const STREAM_RE = /https?:\/\/[^\s"'<>\\]+?\/(?:embed\.html|index\.m3u8|video\.m3u8|[^\s"'<>\\\/]+\.m3u8)(?:\?[^\s"'<>\\]*)?/i;

/** Balitower/Flussonic: ".../embed.html[?...]" -> ".../index.m3u8". URL .m3u8 dibiarkan. Selain itu -> "". */
export function toHls(raw) {
  if (raw === null || raw === undefined) return "";
  const m = String(raw).replace(/&amp;/g, "&").replace(/\\\//g, "/").match(STREAM_RE);
  if (!m) return "";
  const u = m[0];
  if (/\/embed\.html(?:[?#].*)?$/i.test(u)) return u.replace(/\/embed\.html(?:[?#].*)?$/i, "/index.m3u8");
  return /\.m3u8(?:\?|$)/i.test(u) ? u : "";
}
const toEmbed = (raw) => {
  const m = String(raw || "").replace(/&amp;/g, "&").replace(/\\\//g, "/").match(/https?:\/\/[^\s"'<>\\]+?\/embed\.html(?:\?[^\s"'<>\\]*)?/i);
  return m ? m[0] : null;
};

const pick = (o, keys) => { for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== "") return o[k]; return undefined; };
const prettyFolder = (f) => f.replace(/_CCTV-\d+$/i, "").replace(/^\d+_/, "").replace(/_/g, " ").replace(/-/g, " ").replace(/\s+/g, " ").trim();
const folderOf = (u) => { const m = String(u).match(/\/([^\/?#]+)\/(?:embed\.html|index\.m3u8|video\.m3u8)/i); return m ? decodeURIComponent(m[1]) : ""; };
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

/** Satu objek mentah JakCCTV -> kamera ternormalisasi, atau { skip: "alasan" }. */
function mapJakItem(it) {
  if (!it || typeof it !== "object") return { skip: "bukan objek" };
  const loc = it.location && typeof it.location === "object" ? it.location : {};
  let lat = num(pick(it, ["lat", "latitude", "Latitude", "LAT"]) ?? pick(loc, ["lat", "latitude"]));
  let lng = num(pick(it, ["lng", "lon", "long", "longitude", "Longitude", "LNG"]) ?? pick(loc, ["lng", "lon", "long", "longitude"]));
  if (!okCoord(lat, lng)) {
    const ll = String(pick(it, ["latlng", "coordinates", "coordinate", "koordinat", "position"]) || "").match(/(-?\d+\.\d+)\s*[,;\s]\s*(-?\d+\.\d+)/);
    if (ll) { lat = Number(ll[1]); lng = Number(ll[2]); }
  }
  if (!okCoord(lat, lng)) return { skip: "tanpa koordinat" };

  // URL video: kolom yang umum dulu, lalu cari di semua nilai string (mis. potongan <iframe src="...">)
  let raw = pick(it, ["url", "stream_url", "streamUrl", "embed_url", "embedUrl", "embed", "link", "src", "video", "video_url", "iframe", "cctv_url"]);
  let hls = toHls(raw);
  if (!hls) { for (const v of Object.values(it)) { if (typeof v === "string" && (hls = toHls(v))) { raw = v; break; } } }
  if (!hls) return { skip: "tanpa URL stream" };

  const folder = folderOf(hls);
  const title = String(pick(it, ["title", "name", "nama", "lokasi", "location_name", "label", "cctv_name", "nama_cctv"]) || (folder ? prettyFolder(folder) : "CCTV DKI Jakarta")).replace(/\s+/g, " ").trim();
  const rawId = pick(it, ["id", "cctv_id", "camera_id", "kode", "code"]);
  const idPart = rawId !== undefined ? slug(rawId) : slug(folder || title + "-" + lat.toFixed(4) + "-" + lng.toFixed(4));
  const cam = normalize({
    id: "jakcctv-" + idPart, title, lat, lng, sourceType: "hls",
    streamUrl: hls, streamUrls: [hls], embedUrl: toEmbed(raw) || (toEmbed(Object.values(it).join(" "))),
    portalUrl: DKI_PORTAL, provider: "CCTV Publik DKI Jakarta", approx: false,
  });
  return cam || { skip: "URL/koordinat tidak valid" };
}

/** Cari array kamera di dalam JSON (data / data.data / items / cameras / ...). */
function findItems(j) {
  if (Array.isArray(j)) return j;
  if (!j || typeof j !== "object") return null;
  for (const k of ["data", "items", "cameras", "cctv", "result", "results", "rows", "records"]) {
    const v = j[k];
    if (Array.isArray(v)) return v;
    if (v && typeof v === "object") { const r = findItems(v); if (r) return r; }
  }
  return null;
}

function parseAttrs(tag) {
  const o = {}; const re = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g; let m;
  while ((m = re.exec(tag))) o[m[1].toLowerCase().replace(/^data-/, "")] = m[2] !== undefined ? m[2] : m[3];
  return o;
}

/** Cadangan bila respons bukan JSON: potongan HTML (atribut data-lat/data-lng) atau objek JSON di dalam <script>. */
function parseJakHtml(html) {
  const items = [];
  const tagRe = /<[a-z][^>]*\bdata-(?:lat|latitude)\s*=\s*["'][^"']+["'][^>]*>/gi; let m;
  while ((m = tagRe.exec(html))) {
    const attrs = parseAttrs(m[0]);
    const after = html.slice(m.index + m[0].length, m.index + m[0].length + 1500);
    if (!attrs.url && !toHls(Object.values(attrs).join(" "))) attrs.url = (after.match(STREAM_RE) || [""])[0];
    if (!attrs.title && !attrs.name && !attrs.nama) attrs.title = after.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
    items.push(attrs);
  }
  const objRe = /\{[^{}]*["']?(?:lat|latitude)["']?\s*:[^{}]*\}/gi;
  while ((m = objRe.exec(html))) { try { items.push(JSON.parse(m[0])); } catch (e) { /* bukan JSON valid: lewati */ } }
  return items;
}

async function fetchJakPage(page) {
  const info = { page, status: 0 };
  try {
    const r = await fetchT(`${JAK_DATA_URL}?q=&page=${page}`, {
      headers: {
        "user-agent": JAK_UA, accept: "application/json, text/html;q=0.9, */*;q=0.8", "accept-language": "id-ID,id;q=0.9",
        referer: DKI_PORTAL, "x-requested-with": "XMLHttpRequest",
      },
      cf: { cacheTtl: 0 },
    }, "JakCCTV");
    info.status = r.status;
    info.type = (r.headers.get("content-type") || "").split(";")[0];
    const text = await r.text();
    if (!r.ok) { info.error = "HTTP " + r.status; info.sample = text.slice(0, 200); return { info, items: [] }; }
    let items = null;
    try { items = findItems(JSON.parse(text)); } catch (e) { /* bukan JSON */ }
    if (!items) { items = parseJakHtml(text); info.mode = "html"; } else info.mode = "json";
    info.items = items.length;
    if (!items.length) info.sample = text.slice(0, 300);   // bantu diagnosa bila format berubah
    return { info, items };
  } catch (e) {
    info.error = (e && e.message) || "gagal";
    return { info, items: [] };
  }
}

/** Ambil halaman 1..7 paralel, ubah ke HLS, hapus duplikat. */
export async function fetchJakCCTV() {
  const pages = await Promise.all(Array.from({ length: JAK_PAGES }, (_, i) => fetchJakPage(i + 1)));
  const byId = new Map(); const skipped = {};
  for (const p of pages) {
    for (const it of p.items) {
      const c = mapJakItem(it);
      if (c.skip) { skipped[c.skip] = (skipped[c.skip] || 0) + 1; continue; }
      if (!byId.has(c.id)) byId.set(c.id, c);
    }
  }
  const cams = [...byId.values()];
  const hosts = [...new Set(cams.flatMap((c) => c.streamUrls).map((u) => { try { return new URL(u).origin; } catch (e) { return null; } }).filter(Boolean))];
  return { cams, diag: { pages: pages.map((p) => p.info), skipped, hosts } };
}

/** Cache 30 menit: memori isolate -> Cache API (edge) -> fetch ke JakCCTV. Hasil kosong TIDAK di-cache. */
async function getJak(req, env, ctx) {
  const now = Date.now();
  if (jakMem.data && now - jakMem.t < JAK_TTL_S * 1000) return { cams: jakMem.data.cams, status: { count: jakMem.data.cams.length, cached: "memory", hosts: jakMem.data.diag.hosts, diag: jakMem.data.diag } };

  let cache = null; const key = new Request(new URL(JAK_CACHE_PATH, req.url).toString());
  try { cache = caches.default; } catch (e) { cache = null; }
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) {
        const data = await hit.json();
        if (data && Array.isArray(data.cams) && data.cams.length) {
          jakMem.t = Number(data.t) || now; jakMem.data = data;
          return { cams: data.cams, status: { count: data.cams.length, cached: "edge", hosts: data.diag && data.diag.hosts, diag: data.diag } };
        }
      }
    } catch (e) { /* cache rusak: lanjut ambil baru */ }
  }

  if (!jakInflight) jakInflight = fetchJakCCTV().finally(() => { jakInflight = null; });
  try {
    const { cams, diag } = await jakInflight;
    if (cams.length) {
      const data = { t: Date.now(), cams, diag };
      jakMem.t = data.t; jakMem.data = data;
      if (cache) {
        const put = cache.put(key, new Response(JSON.stringify(data), { headers: { "content-type": "application/json", "cache-control": `public, max-age=${JAK_TTL_S}` } })).catch(() => {});
        if (ctx && ctx.waitUntil) ctx.waitUntil(put);
      }
      return { cams, status: { count: cams.length, cached: false, hosts: diag.hosts, diag } };
    }
    if (jakMem.data) return { cams: jakMem.data.cams, status: { count: jakMem.data.cams.length, stale: true, error: "JakCCTV kosong/gagal, memakai data lama", diag } };
    return { cams: [], status: { count: 0, error: "JakCCTV tidak mengembalikan kamera yang bisa dibaca", diag } };
  } catch (e) {
    if (jakMem.data) return { cams: jakMem.data.cams, status: { count: jakMem.data.cams.length, stale: true, error: e.message } };
    return { cams: [], status: { count: 0, error: (e && e.message) || "JakCCTV gagal" } };
  }
}

// ---------- titik tambahan dari env ----------
function extraCameras(env) {
  if (!env.CCTV_EXTRA) return { cams: [], error: null };
  try {
    const arr = JSON.parse(env.CCTV_EXTRA);
    if (!Array.isArray(arr)) throw new Error("CCTV_EXTRA harus array JSON");
    return { cams: arr.map(normalize).filter(Boolean), error: null };
  } catch (e) { return { cams: [], error: "CCTV_EXTRA tidak valid: " + e.message }; }
}

// ---------- handler ----------
const NEARBY_RE = /^-?\d{1,2}(\.\d+)?,-?\d{1,3}(\.\d+)?,\d{1,3}$/;

export function cctvPreflight() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function handleCctv(req, env, ctx) {
  const u = new URL(req.url);
  let nearby = u.searchParams.get("nearby") || DEFAULT_NEARBY;
  if (!NEARBY_RE.test(nearby) || Number(nearby.split(",")[2]) > 250) nearby = DEFAULT_NEARBY;
  const debug = u.searchParams.get("debug") === "1";

  const [windy, jak, extra] = await Promise.all([
    u.searchParams.get("windy") === "0" ? { cams: [], status: { configured: !!env.WINDY_API_KEY, skipped: true } } : getWindy(env, nearby),
    u.searchParams.get("jakcctv") === "0" ? { cams: [], status: { skipped: true } } : getJak(req, env, ctx),
    Promise.resolve(extraCameras(env)),
  ]);

  // Titik statis dki(...) hanya tebakan: bila JakCCTV berhasil memberi kamera, yang statis dki-* dibuang
  let stat = STATIC_CAMERAS.map(normalize).filter(Boolean);
  if (jak.cams.length) stat = stat.filter((c) => !c.id.startsWith("dki-"));

  // gabung; id yang sama: JakCCTV/statis/extra menang atas Windy
  const byId = new Map();
  [...windy.cams, ...stat, ...jak.cams, ...extra.cams].forEach((c) => byId.set(c.id, c));
  const cameras = [...byId.values()];

  if (!debug && jak.status && jak.status.diag) { const { diag, ...rest } = jak.status; jak.status = { ...rest, pages: diag.pages.filter((p) => p.error).length ? diag.pages.filter((p) => p.error).length + " halaman gagal" : undefined }; }

  return new Response(JSON.stringify({
    ok: true, count: cameras.length, nearby, cameras,
    sources: { windy: windy.status, jakcctv: jak.status, static: { count: stat.length }, extra: { count: extra.cams.length, error: extra.error } },
    attribution: "Webcam publik: Windy Webcams (windy.com). CCTV pemerintah: milik masing-masing pengelola (JakCCTV: Pemprov DKI Jakarta).",
    time: Date.now(),
  }), {
    status: 200,
    headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=60" },
  });
}
