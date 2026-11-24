// =====================================================================================
// Layer CCTV publik untuk peta: GET /api/cctv
//
// Menggabungkan:
//   1. Windy Webcams API v3 (kamera publik sekitar Depok, radius 50 km) -> sourceType "windy"
//      (bila kamera tidak punya URL player, dikirim sebagai "portal" ke halaman detail Windy)
//   2. Titik statis lokal: stream HLS (.m3u8) -> "hls"; halaman portal resmi -> "portal"
//   3. (opsional) env.CCTV_EXTRA = JSON array titik tambahan, tanpa perlu ubah kode
//
// Respons seragam:
//   { ok, count, cameras:[{ id, title, lat, lng, sourceType, streamUrl, streamUrls, playerUrl, embedUrl, portalUrl,
//                           provider, approx }], sources:{...}, attribution }
//
// Query opsional:  ?nearby=lat,lon,radiusKm (default -6.4025,106.7942,50; radius maks 250)   ?windy=0 (lewati Windy)
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

async function fetchT(url, init) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try { return await fetch(url, { ...init, signal: ctl.signal }); }
  catch (e) { throw e && e.name === "AbortError" ? new Error("Windy tidak merespons (timeout)") : e; }
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

export async function handleCctv(req, env) {
  const u = new URL(req.url);
  let nearby = u.searchParams.get("nearby") || DEFAULT_NEARBY;
  if (!NEARBY_RE.test(nearby) || Number(nearby.split(",")[2]) > 250) nearby = DEFAULT_NEARBY;

  const [windy, extra] = await Promise.all([
    u.searchParams.get("windy") === "0" ? { cams: [], status: { configured: !!env.WINDY_API_KEY, skipped: true } } : getWindy(env, nearby),
    Promise.resolve(extraCameras(env)),
  ]);
  const stat = STATIC_CAMERAS.map(normalize).filter(Boolean);

  // gabung; id yang sama: titik statis/extra menang atas Windy
  const byId = new Map();
  [...windy.cams, ...stat, ...extra.cams].forEach((c) => byId.set(c.id, c));
  const cameras = [...byId.values()];

  return new Response(JSON.stringify({
    ok: true, count: cameras.length, nearby, cameras,
    sources: { windy: windy.status, static: { count: stat.length }, extra: { count: extra.cams.length, error: extra.error } },
    attribution: "Webcam publik: Windy Webcams (windy.com). CCTV pemerintah: milik masing-masing pengelola.",
    time: Date.now(),
  }), {
    status: 200,
    headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=60" },
  });
}
