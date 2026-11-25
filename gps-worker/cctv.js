// =====================================================================================
// Layer CCTV publik untuk peta: GET /api/cctv
//
// Menggabungkan:
//   1. Windy Webcams API v3 (kamera publik sekitar Depok, radius 50 km) -> sourceType "windy"
//      (bila kamera tidak punya URL player, dikirim sebagai "portal" ke halaman detail Windy)
//   2. JakCCTV resmi Pemprov DKI (jakcctv.jakarta.go.id/publik/data?q=&page=1..7) -> "hls"
//      URL Balitower/Flussonic ".../embed.html" otomatis diubah ke ".../index.m3u8" (siap Hls.js).
//      Hasil digabung (nama, lat, lng, URL) lalu di-cache 30 menit (Cache API + memori isolate).
//      Katalog 52 kamera sudah tertanam (JAK_CATALOG) sebagai data dasar; scraping live hanya menambah kamera baru.
//      Format portal: { cards, pagination, count, total }. Koordinat tidak selalu ada: dicari di data, env.JAKCCTV_COORDS,
//      lalu tabel patokan bawaan (perkiraan); sisanya tidak digambar (dilaporkan di sources.jakcctv.unplaced).
//      Bila JakCCTV gagal / kosong: pakai cache lama (stale).
//   3. Titik statis lokal: stream HLS (.m3u8) -> "hls"; halaman portal resmi -> "portal"
//   4. (opsional) env.CCTV_EXTRA = JSON array titik tambahan, tanpa perlu ubah kode
//
// Respons seragam:
//   { ok, count, cameras:[{ id, title, lat, lng, sourceType, streamUrl, streamUrls, playerUrl, embedUrl, portalUrl,
//                           provider, approx }], sources:{...}, attribution }
//
// Query opsional:  ?nearby=lat,lon,radiusKm (default -6.4025,106.7942,50; radius maks 250)   ?windy=0 (lewati Windy)
//                  env.JAKCCTV_COORDS = JSON {"nama/folder":[lat,lng]} untuk koordinat akurat kamera JakCCTV
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

const STATIC_CAMERAS = [
  // --- Kota Depok (portal Dishub) ---
  { id: "depok-margonda-juanda", title: "Simpang Margonda - Juanda, Depok", lat: -6.3896, lng: 106.8226, sourceType: "portal", portalUrl: DEPOK_PORTAL, provider: "ATCS Dishub Kota Depok", approx: true },
  { id: "depok-gdc", title: "Simpang GDC (Grand Depok City), Depok", lat: -6.4148, lng: 106.8665, sourceType: "portal", portalUrl: DEPOK_PORTAL, provider: "ATCS Dishub Kota Depok", approx: true },
  // Kamera Jakarta diambil otomatis dari portal JakCCTV (lihat fetchJakCCTV); tidak ada titik tebakan lagi.
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
// Format asli /publik/data?q=&page=N : JSON { cards, pagination, count, total }. Tiap "card" berisi nama lokasi + iframe
// Balitower (.../embed.html). Portal TIDAK pasti menyertakan koordinat, jadi koordinat dicari berurutan:
//   1) di data kartu (data-lat/data-lng, lat/lng)  2) env.JAKCCTV_COORDS (milik Anda, akurat)  3) tabel patokan bawaan (perkiraan)
// Kamera yang koordinatnya tidak ketemu TIDAK digambar di peta (agar tidak salah tempat); namanya dilaporkan di sources.jakcctv.unplaced.
const jakMem = { t: 0, data: null };   // cache memori isolate (cadangan bila Cache API tidak aktif, mis. di *.workers.dev)
let jakInflight = null;

const STREAM_RE = /https?:\/\/[^\s"'<>\\]+?\/(?:embed\.html|[^\s"'<>\\\/]+\.m3u8)(?:\?[^\s"'<>\\]*)?/i;
const unesc = (s) => String(s).replace(/&amp;/g, "&").replace(/&#0?38;/g, "&").replace(/\\\//g, "/");

/** Balitower/Flussonic: ".../embed.html[?...]" -> ".../index.m3u8". URL .m3u8 dibiarkan. http port 80 dinaikkan ke https. */
export function toHls(raw) {
  if (raw === null || raw === undefined) return "";
  const m = unesc(raw).match(STREAM_RE);
  if (!m) return "";
  let u = m[0].replace(/^http:\/\/([^\/:]+)(?::80)?(?=\/)/i, "https://$1");
  // Embed di jakcctv.jakarta.go.id -> stream aslinya di cctv-jsc.balitower.co.id:8011 (terkonfirmasi dari dataset ATCS)
  u = u.replace(/^https:\/\/jakcctv\.jakarta\.go\.id\/(?=[^\/]+\/embed\.html)/i, "https://cctv-jsc.balitower.co.id:8011/");
  if (/\/embed\.html(?:[?#].*)?$/i.test(u)) return u.replace(/\/embed\.html(?:[?#].*)?$/i, "/index.m3u8");
  return /\.m3u8(?:\?|$)/i.test(u) ? u : "";
}
const toEmbed = (raw) => {
  const m = unesc(raw || "").match(/https?:\/\/[^\s"'<>\\]+?\/embed\.html(?:\?[^\s"'<>\\]*)?/i);
  return m ? m[0].replace(/^http:\/\/([^\/:]+)(?::80)?(?=\/)/i, "https://$1") : null;
};

const pick = (o, keys) => { for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== "") return o[k]; return undefined; };
const decodeEnt = (s) => String(s).replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const stripTags = (s) => decodeEnt(String(s).replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
const prettyFolder = (f) => f.replace(/_CCTV-?\d+$/i, "").replace(/^\d+_(?:JKP_)?(?:POLDA_|SATPOL-PP_|DISHUB_)?/i, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
const folderOf = (u) => { const m = String(u).match(/\/([^\/?#]+)\/(?:embed\.html|index\.m3u8|video\.m3u8|index\.fmp4\.m3u8)/i); return m ? decodeURIComponent(m[1]) : ""; };
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
const normKey = (s) => " " + String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() + " ";

/** Judul dari potongan HTML satu kartu. */
function titleFromHtml(chunk) {
  let m = chunk.match(/<(h[1-6])\b[^>]*>([\s\S]*?)<\/\1>/i); if (m && stripTags(m[2])) return stripTags(m[2]);
  m = chunk.match(/class=["'][^"']*(?:title|name|nama|lokasi|location)[^"']*["'][^>]*>([\s\S]*?)<\/[a-z0-9]+>/i); if (m && stripTags(m[1])) return stripTags(m[1]);
  m = chunk.match(/<iframe[^>]*\btitle=["']([^"']+)["']/i) || chunk.match(/\b(?:data-title|data-name|aria-label|alt|title)=["']([^"']{3,})["']/i); if (m) return decodeEnt(m[1]).trim();
  const t = stripTags(chunk); return t ? t.slice(0, 90) : "";
}

/** String HTML (satu kartu) -> objek mentah. */
function cardFromHtml(chunk) {
  const attrs = {}; const re = /\bdata-([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g; let m;
  while ((m = re.exec(chunk))) attrs[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : m[3];
  const o = { ...attrs };
  o.url = (chunk.match(STREAM_RE) || [""])[0];
  o.title = attrs.title || attrs.name || attrs.nama || titleFromHtml(chunk);
  return o;
}

/** Satu string HTML berisi banyak kartu -> potongan per kartu. */
function splitCards(html) {
  const n = (html.match(new RegExp(STREAM_RE.source, "gi")) || []).length;
  if (n <= 1) return [html];
  const parts = html.split(/(?=<(?:div|article|li|section)\b[^>]*class=["'](?:[^"']*\s)?card(?:\s[^"']*)?["'])/i).filter((p) => STREAM_RE.test(p));
  if (parts.length >= n && parts.every((p) => (p.match(new RegExp(STREAM_RE.source, "gi")) || []).length === 1)) return parts;
  const out = []; const re = new RegExp(STREAM_RE.source, "gi"); let prev = 0, mm;   // cadangan: teks sebelum tiap iframe = milik iframe itu
  while ((mm = re.exec(html))) { const end = html.indexOf(">", mm.index + mm[0].length); const e = end < 0 ? mm.index + mm[0].length : end + 1; out.push(html.slice(prev, e)); prev = e; }
  return out;
}

/** Cari array kartu/kamera di dalam JSON. Mengembalikan array objek atau string. */
function findItems(j) {
  if (Array.isArray(j)) return j;
  if (typeof j === "string" && /</.test(j)) return splitCards(j);
  if (!j || typeof j !== "object") return null;
  for (const k of ["cards", "data", "items", "cameras", "cctv", "result", "results", "rows", "records", "html"]) {
    const v = j[k];
    if (v === undefined || v === null) continue;
    const r = findItems(v);
    if (r && r.length) return r;
  }
  return null;
}

function parseAttrs(tag) {
  const o = {}; const re = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g; let m;
  while ((m = re.exec(tag))) o[m[1].toLowerCase().replace(/^data-/, "")] = m[2] !== undefined ? m[2] : m[3];
  return o;
}

/** Cadangan bila respons bukan JSON: HTML langsung. */
function parseJakHtml(html) {
  const items = [];
  if (STREAM_RE.test(html)) for (const c of splitCards(html)) items.push(cardFromHtml(c));
  const objRe = /\{[^{}]*["']?(?:lat|latitude)["']?\s*:[^{}]*\}/gi; let m;
  while ((m = objRe.exec(html))) { try { items.push(JSON.parse(m[0])); } catch (e) { /* bukan JSON valid */ } }
  return items;
}

/** Satu kartu mentah -> { raw } (koordinat boleh kosong) atau { skip }. */
function mapJakItem(item) {
  const it = typeof item === "string" ? cardFromHtml(item) : item;
  if (!it || typeof it !== "object") return { skip: "bukan objek" };
  if (Object.values(it).some((v) => typeof v === "string" && /<(iframe|div|a)\b/i.test(v)) && !pick(it, ["title", "name", "nama"])) {
    for (const v of Object.values(it)) if (typeof v === "string" && /<(iframe|div|a)\b/i.test(v)) { const t = titleFromHtml(v); if (t) { it.title = t; break; } }
  }
  const loc = it.location && typeof it.location === "object" ? it.location : {};
  let lat = num(pick(it, ["lat", "latitude", "Latitude", "LAT"]) ?? pick(loc, ["lat", "latitude"]));
  let lng = num(pick(it, ["lng", "lon", "long", "longitude", "Longitude", "LNG"]) ?? pick(loc, ["lng", "lon", "long", "longitude"]));
  if (!okCoord(lat, lng)) {
    const ll = String(pick(it, ["latlng", "coordinates", "coordinate", "koordinat", "position"]) || "").match(/(-?\d+\.\d+)\s*[,;\s]\s*(-?\d+\.\d+)/);
    if (ll) { lat = Number(ll[1]); lng = Number(ll[2]); }
  }
  const hasCoord = okCoord(lat, lng);

  let raw = pick(it, ["url", "stream_url", "streamUrl", "embed_url", "embedUrl", "embed", "link", "src", "video", "video_url", "iframe", "cctv_url"]);
  let hls = toHls(raw);
  if (!hls) { for (const v of Object.values(it)) { if (typeof v === "string" && (hls = toHls(v))) { raw = v; break; } } }
  if (!hls) return { skip: "tanpa URL stream" };
  if (!isHttps(hls)) return { skip: "stream bukan https" };

  const folder = folderOf(hls);
  const title = String(pick(it, ["title", "name", "nama", "lokasi", "location_name", "label", "cctv_name", "nama_cctv"]) || (folder ? prettyFolder(folder) : "CCTV DKI Jakarta")).replace(/\s+/g, " ").trim();
  const rawId = pick(it, ["id", "cctv_id", "camera_id", "kode", "code"]);
  const idPart = slug(folder || (rawId !== undefined ? rawId : title));
  const embed = toEmbed(raw) || toEmbed(Object.values(it).filter((v) => typeof v === "string").join(" "));
  return { raw: { id: "jakcctv-" + idPart, title, folder, lat: hasCoord ? lat : null, lng: hasCoord ? lng : null, hls, embed } };
}

// Koordinat per kamera, dikunci dengan ID 6 digit di nama folder stream (nama folder = label teknis kamera yang paling bisa dipercaya;
// judul di portal untuk ~10 kamera tidak sesuai dengan folder-nya, mis. judul "Pasar Tanah Abang" berfolder "...S.-PARMAN-C02").
// [lat, lng, akurat]. akurat=true: titik dari registri Balitower. Selain itu PERKIRAAN tingkat ruas jalan (beberapa ratus meter).
// Sumber: dataset ATCS yang Anda unggah + pengecekan manual; koordinat kamera jakcctv di dataset itu sendiri banyak yang salah
// (mis. Gatot Subroto 7 CCTV-01 jatuh di Jakarta Timur), jadi hanya yang masuk akal yang dipakai. Perbaiki lewat env.JAKCCTV_COORDS.
const JAK_COORDS = {
  502045: [-6.20763, 106.80376],   // JPO Gatot Subroto 7 (Gatsu seberang DPR)
  502155: [-6.213496, 106.802207], // Gerbang Pemuda C02
  502160: [-6.213496, 106.802207], // Gerbang Pemuda C03
  502506: [-6.213496, 106.802207], // Gerbang Pemuda C04
  502507: [-6.20763, 106.80376],   // Gatot Subroto C11
  503300: [-6.221569, 106.80987],  // Gatot Subroto C13
  503303: [-6.221569, 106.80987],  // Gatot Subroto C14
  503301: [-6.2155, 106.8000],     // Tentara Pelajar C04 (Senayan)
  503536: [-6.2118, 106.8030],     // Flyover Ladokgi (Senayan, Gatsu x Gerbang Pemuda)
  502535: [-6.193739, 106.797456], // S. Parman C07 (JKB)
  502645: [-6.193739, 106.797456], // S. Parman C08 (JKB)
  501862: [-6.2005, 106.7978],     // S. Parman C01 (JKB)
  502540: [-6.1860, 106.7940],     // S. Parman C02 (JKB)
  502491: [-6.195297, 106.823627], // Thamrin C07 (sekitar Bundaran HI)
  502492: [-6.195297, 106.823627], // Thamrin C08
  502493: [-6.195297, 106.823627], // Thamrin C09
  501844: [-6.195297, 106.823627], // Thamrin C01
  501941: [-6.195297, 106.823627], // Thamrin C02
  504866: [-6.1935, 106.8236],     // UOB Plaza (Jl. MH Thamrin 10)
  501478: [-6.2447, 106.7996],     // Taman Literasi (Blok M)
  501493: [-6.1855, 106.8118],     // Pasar Tanah Abang C02
  501594: [-6.2100, 106.8480],     // Manggarai Utara 2 C01
  502041: [-6.1985, 106.8168],     // KH Mas Mansyur C02
  503343: [-6.1735, 106.8100],     // JPO Cideng Timur C02
  503675: [-6.186921, 106.807942], // Jati Baru Raya C02
  501968: [-6.158821, 106.793722], // Simpang Jl Nurdin Raya C01 (JKB)
  705979: [-6.2235, 106.8015],     // Senayan 018
  705084: [-6.229418, 106.800027, true], // Senayan 001 (Jl. Sisingamangaraja) - registri Balitower
  700014: [-6.205555, 106.807644, true], // Bendungan Hilir 003 (Jl. Mesjid 1 / Pejompongan) - registri Balitower
  700332: [-6.19792, 106.82334],   // Kebon Melati 010
};

// Patokan umum berdasarkan kata di judul/folder (cadangan untuk kamera BARU dari portal yang belum ada di JAK_COORDS)
const JAK_ANCHORS = [
  [["bundaran hi", "bundaran hotel indonesia"], -6.19508, 106.82308],
  [["uob"], -6.1935, 106.8236],
  [["sarinah"], -6.1875, 106.8233],
  [["thamrin"], -6.195297, 106.823627],
  [["dukuh atas"], -6.2008, 106.8223],
  [["monas", "medan merdeka"], -6.1754, 106.8272],
  [["semanggi"], -6.2189, 106.8142],
  [["gerbang pemuda"], -6.213496, 106.802207],
  [["ladokgi"], -6.2118, 106.8030],
  [["gelora", "gbk"], -6.2185, 106.8018],
  [["senayan"], -6.2262, 106.7992],
];

function envCoords(env) {
  if (!env || !env.JAKCCTV_COORDS) return [];
  try {
    const j = typeof env.JAKCCTV_COORDS === "string" ? JSON.parse(env.JAKCCTV_COORDS) : env.JAKCCTV_COORDS;
    return Object.entries(j || {}).map(([k, v]) => {
      const lat = num(Array.isArray(v) ? v[0] : v && v.lat), lng = num(Array.isArray(v) ? v[1] : v && (v.lng ?? v.lon));
      return okCoord(lat, lng) ? { key: normKey(k), lat, lng } : null;
    }).filter(Boolean).sort((a, b) => b.key.length - a.key.length);
  } catch (e) { return []; }
}

/** Tentukan koordinat tiap kamera mentah; kembalikan { cams, unplaced }. */
function resolveCoords(raws, env) {
  const mine = envCoords(env); const cams = []; const unplaced = []; const seen = new Map();
  for (const r of raws) {
    let lat = r.lat, lng = r.lng, approx = false;
    if (!okCoord(lat, lng)) {
      const hay = normKey(r.title + " " + r.folder + " " + r.id);
      const hit = mine.find((e) => hay.includes(e.key));
      const fid = (String(r.folder).match(/\d{6}/) || [""])[0];
      const known = JAK_COORDS[fid];
      if (hit) { lat = hit.lat; lng = hit.lng; }
      else if (known) { lat = known[0]; lng = known[1]; approx = !known[2]; }
      else {
        const a = JAK_ANCHORS.find(([kw]) => kw.some((k) => hay.includes(" " + k + " ")));
        if (a) { lat = a[1]; lng = a[2]; approx = true; }
      }
    }
    if (!okCoord(lat, lng)) { unplaced.push({ id: r.id, title: r.title, folder: r.folder }); continue; }
    // beberapa kamera di titik yang sama: sebar sedikit agar penanda tidak menumpuk
    const k = lat.toFixed(5) + "," + lng.toFixed(5); const n = seen.get(k) || 0; seen.set(k, n + 1);
    if (n > 0) { const ring = 1 + Math.floor((n - 1) / 6), ang = (n - 1) * (Math.PI / 3); lat += 0.00013 * ring * Math.sin(ang); lng += 0.00013 * ring * Math.cos(ang); }
    const c = normalize({
      id: r.id, title: r.title, lat, lng, sourceType: "hls",
      streamUrl: r.hls, streamUrls: [r.hls, r.hls.replace(/\/index\.m3u8$/, "/index.fmp4.m3u8")],
      embedUrl: r.embed, portalUrl: DKI_PORTAL, provider: "CCTV Publik DKI Jakarta", approx,
    });
    if (c) cams.push(c); else unplaced.push({ id: r.id, title: r.title, folder: r.folder });
  }
  return { cams, unplaced };
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
    try {
      const j = JSON.parse(text);
      items = findItems(j);
      if (j && typeof j === "object") { if (j.total !== undefined) info.total = j.total; if (j.count !== undefined) info.count = j.count; }
    } catch (e) { /* bukan JSON */ }
    if (!items) { items = parseJakHtml(text); info.mode = "html"; } else info.mode = "json";
    info.items = items.length;
    if (!items.length) info.sample = text.slice(0, 300);                       // bantu diagnosa bila format berubah
    else if (page === 1) info.cardSample = (typeof items[0] === "string" ? items[0] : JSON.stringify(items[0])).slice(0, 400);
    return { info, items };
  } catch (e) {
    info.error = (e && e.message) || "gagal";
    return { info, items: [] };
  }
}

/** Ambil halaman 1..7 paralel, ubah ke HLS, hapus duplikat. Koordinat diselesaikan terpisah (resolveCoords). */
export async function fetchJakCCTV() {
  const pages = await Promise.all(Array.from({ length: JAK_PAGES }, (_, i) => fetchJakPage(i + 1)));
  const byId = new Map(); const skipped = {};
  for (const p of pages) {
    for (const it of p.items) {
      const c = mapJakItem(it);
      if (c.skip) { skipped[c.skip] = (skipped[c.skip] || 0) + 1; continue; }
      if (!byId.has(c.raw.id)) byId.set(c.raw.id, c.raw);
    }
  }
  const raws = [...byId.values()];
  const hosts = [...new Set(raws.map((r) => { try { return new URL(r.hls).origin; } catch (e) { return null; } }).filter(Boolean))];
  return { raws, diag: { pages: pages.map((p) => p.info), skipped, hosts } };
}

// Katalog 52 kamera dari portal JakCCTV (salinan /publik/data): [judul, badge, URL embed]. Dipakai sebagai data dasar agar peta
// tetap terisi walau scraping gagal; hasil scraping live hanya menambah kamera baru. Perbarui bila portal menambah kamera.
const JAK_CATALOG = [
  ["JKP POLDA JPO JL. GATOT SUBROTO 7", "CCTV-01", "https://dki-jkt.balitower.co.id:7028/502045_JKP_POLDA_JPO-JL.-GATOT-SUBROTO-7_CCTV-01/embed.html"],
  ["JKP POLDA JPO JL. GATOT SUBROTO 7", "CCTV-02", "https://dki-jkt.balitower.co.id:7028/502045_JKP_POLDA_JPO-JL.-GATOT-SUBROTO-7_CCTV-02/embed.html"],
  ["JKP POLDA JL. GERBANG PEMUDA C02", "CCTV-01", "https://dki-jkt.balitower.co.id:7028/502155_JKP_POLDA_JL.-GERBANG-PEMUDA-C02_CCTV-01/embed.html"],
  ["JKP POLDA JL. GERBANG PEMUDA C02", "CCTV-02", "https://dki-jkt.balitower.co.id:7028/502155_JKP_POLDA_JL.-GERBANG-PEMUDA-C02_CCTV-02/embed.html"],
  ["JKP POLDA JL. GERBANG PEMUDA C03", "CCTV-01", "https://dki-jkt.balitower.co.id:7028/502160_JKP_POLDA_JL.-GERBANG-PEMUDA-C03_CCTV-01/embed.html"],
  ["JKP POLDA JL. GERBANG PEMUDA C03", "CCTV-02", "https://dki-jkt.balitower.co.id:7028/502160_JKP_POLDA_JL.-GERBANG-PEMUDA-C03_CCTV-02/embed.html"],
  ["JKP SATPOL PP JL. GERBANG PEMUDA C04", "CCTV-01", "https://dki-jkt.balitower.co.id:7028/502506_JKP_SATPOL-PP_JL.-GERBANG-PEMUDA-C04_CCTV-01/embed.html"],
  ["JKP SATPOL PP JL. GERBANG PEMUDA C04", "CCTV-02", "https://dki-jkt.balitower.co.id:7028/502506_JKP_SATPOL-PP_JL.-GERBANG-PEMUDA-C04_CCTV-02/embed.html"],
  ["JKP SATPOL PP JL. JEND. GATOT SUBROTO C11", "CCTV-01", "https://dki-jkt.balitower.co.id:7028/502507_JKP_SATPOL-PP_JL.-JEND.-GATOT-SUBROTO-C11_CCTV-01/embed.html"],
  ["JKP SATPOL PP JL. JEND. GATOT SUBROTO C11", "CCTV-02", "https://dki-jkt.balitower.co.id:7028/502507_JKP_SATPOL-PP_JL.-JEND.-GATOT-SUBROTO-C11_CCTV-02/embed.html"],
  ["JKB SATPOL PP SIMPANG JL. LETJEN. S. PARMAN C07", "CCTV-01", "https://dki-jkt.balitower.co.id:7028/502535_JKB_SATPOL-PP_SIMPANG-JL.-LETJEN.-S.-PARMAN-C07_CCTV-01/embed.html"],
  ["JKB SATPOL PP SIMPANG JL. LETJEN. S. PARMAN C07", "CCTV-02", "https://dki-jkt.balitower.co.id:7028/502535_JKB_SATPOL-PP_SIMPANG-JL.-LETJEN.-S.-PARMAN-C07_CCTV-02/embed.html"],
  ["JKB SATPOL PP SIMPANG JL. LETJEN. S. PARMAN C08", "CCTV-01", "https://dki-jkt.balitower.co.id:7028/502645_JKB_SATPOL-PP_SIMPANG-JL.-LETJEN.-S.-PARMAN-C08_CCTV-01/embed.html"],
  ["JKB SATPOL PP SIMPANG JL. LETJEN. S. PARMAN C08", "CCTV-02", "https://dki-jkt.balitower.co.id:7028/502645_JKB_SATPOL-PP_SIMPANG-JL.-LETJEN.-S.-PARMAN-C08_CCTV-02/embed.html"],
  ["JKP POLDA JL. JEND. GATOT SUBROTO C13", "CCTV-01", "https://dki-jkt.balitower.co.id:7028/503300_JKP_POLDA_JL.-JEND.-GATOT-SUBROTO-C13_CCTV-01/embed.html"],
  ["JKP POLDA JL. JEND. GATOT SUBROTO C13", "CCTV-02", "https://dki-jkt.balitower.co.id:7028/503300_JKP_POLDA_JL.-JEND.-GATOT-SUBROTO-C13_CCTV-02/embed.html"],
  ["JKP POLDA JL. TENTARA PELAJAR C04", "CCTV-01", "https://dki-jkt.balitower.co.id:7028/503301_JKP_POLDA_JL.-TENTARA-PELAJAR-C04_CCTV-01/embed.html"],
  ["JKP POLDA JL. TENTARA PELAJAR C04", "CCTV-02", "https://dki-jkt.balitower.co.id:7028/503301_JKP_POLDA_JL.-TENTARA-PELAJAR-C04_CCTV-02/embed.html"],
  ["JKP POLDA JL. JEND. GATOT SUBROTO C14", "CCTV-01", "https://dki-jkt.balitower.co.id:7028/503303_JKP_POLDA_JL.-JEND.-GATOT-SUBROTO-C14_CCTV-01/embed.html"],
  ["JKP POLDA JL. JEND. GATOT SUBROTO C14", "CCTV-02", "https://dki-jkt.balitower.co.id:7028/503303_JKP_POLDA_JL.-JEND.-GATOT-SUBROTO-C14_CCTV-02/embed.html"],
  ["JKP DBM FLYOVER LADOKGI C01", "CCTV-01", "https://dki-jkt.balitower.co.id:7028/503536_JKP_DBM_FLYOVER-LADOKGI-C01_CCTV-01/embed.html"],
  ["JKP DBM FLYOVER LADOKGI C01", "CCTV-02", "https://dki-jkt.balitower.co.id:7028/503536_JKP_DBM_FLYOVER-LADOKGI-C01_CCTV-02/embed.html"],
  ["JKP SATPOL PP SIMPANG JL. MH. THAMRIN C07", "CCTV-01", "https://dki-jkt.balitower.co.id:7028/502491_JKP_SATPOL-PP_SIMPANG-JL.-MH.-THAMRIN-C07_CCTV-01/embed.html"],
  ["JKP SATPOL PP SIMPANG JL. MH. THAMRIN C07", "CCTV-02", "https://dki-jkt.balitower.co.id:7028/502491_JKP_SATPOL-PP_SIMPANG-JL.-MH.-THAMRIN-C07_CCTV-02/embed.html"],
  ["JKP SATPOL PP SIMPANG JL. MH. THAMRIN C08", "CCTV-01", "https://dki-jkt.balitower.co.id:7028/502492_JKP_SATPOL-PP_SIMPANG-JL.-MH.-THAMRIN-C08_CCTV-01/embed.html"],
  ["JKP SATPOL PP SIMPANG JL. MH. THAMRIN C08", "CCTV-02", "https://dki-jkt.balitower.co.id:7028/502492_JKP_SATPOL-PP_SIMPANG-JL.-MH.-THAMRIN-C08_CCTV-02/embed.html"],
  ["JKP DISHUB JL. MH. THAMRIN C01", "CCTV-01", "https://dki-jkt.balitower.co.id:7028/501844_JKP_DISHUB_JL.-MH.-THAMRIN-C01_CCTV-01/embed.html"],
  ["JKP DISHUB JL. MH. THAMRIN C01", "CCTV-02", "https://dki-jkt.balitower.co.id:7028/501844_JKP_DISHUB_JL.-MH.-THAMRIN-C01_CCTV-02/embed.html"],
  ["JKP SATPOLPP JL. MH. THAMRIN C02", "CCTV-01", "https://dki-jkt.balitower.co.id:7028/501941_JKP_SATPOLPP_JL.-MH.-THAMRIN-C02_CCTV-01/embed.html"],
  ["JKP SATPOLPP JL. MH. THAMRIN C02", "CCTV-02", "https://dki-jkt.balitower.co.id:7028/501941_JKP_SATPOLPP_JL.-MH.-THAMRIN-C02_CCTV-02/embed.html"],
  ["JKP SATPOL PP SIMPANG JL. MH. THAMRIN C09", "CCTV-01", "https://dki-jkt.balitower.co.id:7028/502493_JKP_SATPOL-PP_SIMPANG-JL.-MH.-THAMRIN-C09_CCTV-01/embed.html"],
  ["JKP SATPOL PP SIMPANG JL. MH. THAMRIN C09", "CCTV-02", "https://dki-jkt.balitower.co.id:7028/502493_JKP_SATPOL-PP_SIMPANG-JL.-MH.-THAMRIN-C09_CCTV-02/embed.html"],
  ["JKP POLRI UOB PLAZA C01", "CCTV-01", "https://dki-jkt.balitower.co.id:7028/504866_JKP_POLRI_UOB-PLAZA-C01_CCTV-01/embed.html"],
  ["JKP POLRI UOB PLAZA C01", "CCTV-02", "https://dki-jkt.balitower.co.id:7028/504866_JKP_POLRI_UOB-PLAZA-C01_CCTV-02/embed.html"],
  ["JKP POLRI UOB PLAZA C01", "CCTV-03", "https://dki-jkt.balitower.co.id:7028/504866_JKP_POLRI_UOB-PLAZA-C01_CCTV-03/embed.html"],
  ["Taman Literasi-C01", "CCTV-01", "https://dki-jkt.balitower.co.id:7028/501478_JKS_SATPOLPP_TAMAN-LITERASI-C01_CCTV-01/embed.html"],
  ["Simpang Jl. Panglima Polim-C01", "CCTV-02", "https://dki-jkt.balitower.co.id:7028/501493_JKP_SATPOLPP_PASAR-TANAH-ABANG-C02_CCTV-02/embed.html"],
  ["Jl. Sultan Agung-C03", "CCTV-01", "https://dki-jkt.balitower.co.id:7028/501594_JKS_DISGULKARMAT_JL.-MANGGARAI-UTARA-2-C01_CCTV-01/embed.html"],
  ["Simpang Jl. Sultan Agung-C01", "CCTV-01", "https://dki-jkt.balitower.co.id:7028/501862_JKB_DISHUB_JL.-LETJEN.-S.-PARMAN-C01_CCTV-01/embed.html"],
  ["Simpang Jl. Sultan Agung-C01", "CCTV-03", "https://dki-jkt.balitower.co.id:7028/501862_JKB_DISHUB_JL.-LETJEN.-S.-PARMAN-C01_CCTV-03/embed.html"],
  ["Simpang Jl. Sultan Agung-C02", "CCTV-02", "https://dki-jkt.balitower.co.id:7028/502041_JKP_POLDA_JL.-KH.-MAS-MANSYUR-C02_CCTV-02/embed.html"],
  ["Pasar Tanah Abang-C02", "CCTV-01", "https://dki-jkt.balitower.co.id:7028/502540_JKB_SATPOL-PP_SIMPANG-JL.-LETJEN.-S.-PARMAN-C02_CCTV-01/embed.html"],
  ["Pasar Tanah Abang-C02", "CCTV-02", "https://dki-jkt.balitower.co.id:7028/502540_JKB_SATPOL-PP_SIMPANG-JL.-LETJEN.-S.-PARMAN-C02_CCTV-02/embed.html"],
  ["Jl. KH. Mas Mansyur-C02", "CCTV-01", "https://dki-jkt.balitower.co.id:7028/503343_JKP_DBM_JPO-JL.-CIDENG-TIMUR-C02_CCTV-01/embed.html"],
  ["Jl. KH. Mas Mansyur-C02", "CCTV-02", "https://dki-jkt.balitower.co.id:7028/503343_JKP_DBM_JPO-JL.-CIDENG-TIMUR-C02_CCTV-02/embed.html"],
  ["Jl. Jati Baru Raya-C02", "CCTV-01", "https://dki-jkt.balitower.co.id:7028/503675_JKP_BAKESBANGPOL_JL.-JATI-BARU-RAYA-C02_CCTV-01/embed.html"],
  ["Simpang Jl Nurdin Raya C01", "CCTV-01", "https://dki-jkt.balitower.co.id:7028/501968-Simpang-Jl-Nurdin-Raya-C01_CCTV-01/embed.html"],
  ["Simpang Jl Nurdin Raya C01", "CCTV-02", "https://dki-jkt.balitower.co.id:7028/501968-Simpang-Jl-Nurdin-Raya-C01_CCTV-02/embed.html"],
  ["Senayan 018", "CCTV-2", "https://jakcctv.jakarta.go.id/Senayan-018-705979_2/embed.html?proto=hls"],
  ["Senayan 001", "CCTV-2", "https://jakcctv.jakarta.go.id/Senayan-001-705084_2/embed.html?proto=hls"],
  ["Bendungan Hilir 003", "CCTV-1", "https://jakcctv.jakarta.go.id/Bendungan-Hilir-003-700014_1/embed.html?proto=hls"],
  ["Kebon Melati 010", "CCTV-2", "https://jakcctv.jakarta.go.id/Kebon-Melati-010-700332_2/embed.html?proto=hls"]
];

function catalogRaws() {
  const out = [];
  for (const [title, badge, url] of JAK_CATALOG) {
    const m = mapJakItem({ title: `${title} (${badge})`, url });
    if (m.raw) out.push(m.raw);
  }
  return out;
}

/** Cache 30 menit (memori isolate -> Cache API edge -> fetch). Yang di-cache adalah hasil scraping mentah; katalog dasar dan koordinat digabung tiap respons. */
async function getJak(req, env, ctx) {
  const now = Date.now();
  const build = (data, extra) => {
    const byId = new Map(catalogRaws().map((r) => [r.id, r]));
    let added = 0;
    for (const r of data.raws) { if (!byId.has(r.id)) { byId.set(r.id, r); added++; } else { const o = byId.get(r.id); if (r.lat != null && o.lat == null) { o.lat = r.lat; o.lng = r.lng; } } }
    const { cams, unplaced } = resolveCoords([...byId.values()], env);
    return { cams, status: { count: cams.length, source: data.raws.length ? "live+catalog" : "catalog", liveCount: data.raws.length, newFromLive: added, placedApprox: cams.filter((c) => c.approx).length, unplaced: unplaced.length ? unplaced : undefined, hosts: data.diag && data.diag.hosts, diag: data.diag, ...extra } };
  };
  if (jakMem.data && now - jakMem.t < JAK_TTL_S * 1000) return build(jakMem.data, { cached: "memory" });

  let cache = null; const key = new Request(new URL(JAK_CACHE_PATH, req.url).toString());
  try { cache = caches.default; } catch (e) { cache = null; }
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) {
        const data = await hit.json();
        if (data && Array.isArray(data.raws) && data.raws.length) { jakMem.t = Number(data.t) || now; jakMem.data = data; return build(data, { cached: "edge" }); }
      }
    } catch (e) { /* cache rusak: lanjut ambil baru */ }
  }

  if (!jakInflight) jakInflight = fetchJakCCTV().finally(() => { jakInflight = null; });
  try {
    const { raws, diag } = await jakInflight;
    if (raws.length) {
      const data = { t: Date.now(), raws, diag };
      jakMem.t = data.t; jakMem.data = data;
      if (cache) {
        const put = cache.put(key, new Response(JSON.stringify(data), { headers: { "content-type": "application/json", "cache-control": `public, max-age=${JAK_TTL_S}` } })).catch(() => {});
        if (ctx && ctx.waitUntil) ctx.waitUntil(put);
      }
      return build(data, { cached: false });
    }
    if (jakMem.data) return build(jakMem.data, { stale: true, error: "scraping JakCCTV kosong, memakai data lama" });
    return build({ raws: [], diag }, { error: "scraping JakCCTV tidak membaca kamera; memakai katalog bawaan" });
  } catch (e) {
    if (jakMem.data) return build(jakMem.data, { stale: true, error: e.message });
    return build({ raws: [], diag: null }, { error: (e && e.message) || "JakCCTV gagal; memakai katalog bawaan" });
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

  const stat = STATIC_CAMERAS.map(normalize).filter(Boolean);

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
