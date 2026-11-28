// =====================================================================================
// traffic.js — lapisan lalu lintas TomTom (dipanggil dari entry.js).
//
//   GET /api/traffic-tile/:z/:x/:y.png
//       Proxy tile "flow relative0" TomTom. API key (env.TOMTOM_API_KEY) hanya ada di Worker.
//       Cache edge 180 dtk (cf.cacheTtl) + Cache-Control 180 dtk di browser -> hemat kuota TomTom.
//   GET /api/traffic-status?lat=..&lng=..
//       Flow Segment Data (absolute/10): currentSpeed vs freeFlowSpeed di titik GPS
//       -> { level: lancar | padat | macet | ditutup | unknown, ... }
//
// Secret: TOMTOM_API_KEY (wrangler secret put TOMTOM_API_KEY). Tidak ada variabel baru di [vars].
// =====================================================================================

const TILE_TTL_S = 180;
const STATUS_TTL_S = 120;
const MAX_Z = 22;                 // TomTom flow tile mendukung zoom 0..22
const UPSTREAM_TIMEOUT_MS = 8000;

// Ambang kelancaran = currentSpeed / freeFlowSpeed
const RATIO_LANCAR = 0.75;        // >= 0.75 lancar
const RATIO_PADAT = 0.45;         // 0.45 .. 0.75 padat, < 0.45 macet

function noKey(env) { return !env.TOMTOM_API_KEY || !String(env.TOMTOM_API_KEY).trim(); }

async function fetchTimeout(url, init) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), UPSTREAM_TIMEOUT_MS);
  try { return await fetch(url, { ...init, signal: ctl.signal }); }
  finally { clearTimeout(t); }
}

// h = { corsHeaders(env,req), jsonRes(obj,status,env,req,extra), sourceForbidden(env,req), appCheck(env,req,path) } dari entry.js
export async function handleTrafficTile(req, env, ctx, h) {
  const m = /^\/api\/traffic-tile\/(\d{1,2})\/(\d{1,8})\/(\d{1,8})\.png$/.exec(new URL(req.url).pathname);
  if (!m) return h.jsonRes({ ok: false, error: "format: /api/traffic-tile/{z}/{x}/{y}.png" }, 400, env, req);
  const z = +m[1], x = +m[2], y = +m[3];
  if (z > MAX_Z || x >= 2 ** z || y >= 2 ** z) return h.jsonRes({ ok: false, error: "koordinat tile di luar rentang" }, 400, env, req);
  // Longgar: <img> sering tanpa Origin/Referer. Hanya tolak bila Origin/Referer ADA tetapi bukan milik aplikasi.
  if (h.sourceForbidden(env, req)) return h.jsonRes({ ok: false, error: "asal permintaan tidak diizinkan" }, 403, env, req);
  if (noKey(env)) return h.jsonRes({ ok: false, error: "TOMTOM_API_KEY belum diisi di Worker" }, 503, env, req);

  const url = `https://api.tomtom.com/traffic/map/4/tile/flow/relative0/${z}/${x}/${y}.png?key=${encodeURIComponent(env.TOMTOM_API_KEY)}&tileSize=256`;
  let up;
  try {
    up = await fetchTimeout(url, { headers: { accept: "image/png" }, cf: { cacheTtl: TILE_TTL_S, cacheEverything: true } });
  } catch (e) {
    return h.jsonRes({ ok: false, error: "TomTom tidak merespons" }, 504, env, req);
  }
  if (!up.ok) {
    // 403 = key salah / kuota harian habis. Jangan cache, jangan bocorkan URL (ada key).
    const st = up.status === 403 || up.status === 429 ? 429 : 502;
    return h.jsonRes({ ok: false, error: "TomTom HTTP " + up.status }, st, env, req, { "x-traffic-upstream": String(up.status) });
  }
  return new Response(up.body, {
    status: 200,
    headers: {
      ...h.corsHeaders(env, req),
      "content-type": "image/png",
      "cache-control": "public, max-age=" + TILE_TTL_S,
    },
  });
}

function classify(fs) {
  const cur = Number(fs.currentSpeed), free = Number(fs.freeFlowSpeed);
  if (fs.roadClosure) return { level: "ditutup", label: "Ditutup", ratio: 0 };
  if (!(free > 0) || !Number.isFinite(cur)) return { level: "unknown", label: "Tidak diketahui", ratio: null };
  const ratio = Math.min(1.5, cur / free);
  if (ratio >= RATIO_LANCAR) return { level: "lancar", label: "Lancar", ratio };
  if (ratio >= RATIO_PADAT) return { level: "padat", label: "Padat", ratio };
  return { level: "macet", label: "Macet", ratio };
}

export async function handleTrafficStatus(req, env, ctx, h) {
  const deny = h.appCheck(env, req, "");               // JSON via fetch() selalu membawa Origin -> pakai pemeriksaan ketat
  if (deny) return h.jsonRes({ ok: false, error: deny.error }, deny.status, env, req);
  const u = new URL(req.url);
  const lat = parseFloat(u.searchParams.get("lat")), lng = parseFloat(u.searchParams.get("lng"));
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return h.jsonRes({ ok: false, error: "lat/lng tidak valid" }, 400, env, req);
  }
  if (noKey(env)) return h.jsonRes({ ok: false, error: "TOMTOM_API_KEY belum diisi di Worker" }, 503, env, req);

  const qlat = lat.toFixed(4), qlng = lng.toFixed(4);   // ~11 m: permintaan berdekatan berbagi cache edge
  const url = `https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/10/json?key=${encodeURIComponent(env.TOMTOM_API_KEY)}&point=${qlat},${qlng}&unit=KMPH`;
  const cache = { "cache-control": "public, max-age=60" };
  let up;
  try {
    up = await fetchTimeout(url, { headers: { accept: "application/json" }, cf: { cacheTtl: STATUS_TTL_S, cacheEverything: true } });
  } catch (e) {
    return h.jsonRes({ ok: false, error: "TomTom tidak merespons" }, 504, env, req);
  }
  if (up.status === 400 || up.status === 404) {
    // titik terlalu jauh dari ruas jalan yang dipantau
    return h.jsonRes({ ok: true, level: "unknown", label: "Tidak diketahui", reason: "no_road", lat: +qlat, lng: +qlng, at: Date.now() }, 200, env, req, cache);
  }
  if (!up.ok) {
    return h.jsonRes({ ok: false, error: "TomTom HTTP " + up.status }, up.status === 403 || up.status === 429 ? 429 : 502, env, req);
  }
  let j;
  try { j = await up.json(); } catch (e) { return h.jsonRes({ ok: false, error: "respons TomTom bukan JSON" }, 502, env, req); }
  const fs = j && j.flowSegmentData;
  if (!fs) return h.jsonRes({ ok: true, level: "unknown", label: "Tidak diketahui", reason: "no_data", lat: +qlat, lng: +qlng, at: Date.now() }, 200, env, req, cache);

  const c = classify(fs);
  const cT = Number(fs.currentTravelTime), fT = Number(fs.freeFlowTravelTime);
  return h.jsonRes({
    ok: true,
    level: c.level,
    label: c.label,
    ratio: c.ratio == null ? null : Math.round(c.ratio * 100) / 100,
    currentSpeed: Number(fs.currentSpeed),
    freeFlowSpeed: Number(fs.freeFlowSpeed),
    delaySec: Number.isFinite(cT) && Number.isFinite(fT) ? Math.max(0, Math.round(cT - fT)) : null,
    confidence: typeof fs.confidence === "number" ? fs.confidence : null,
    roadClosure: !!fs.roadClosure,
    frc: fs.frc || null,
    lat: +qlat, lng: +qlng,
    at: Date.now(),
  }, 200, env, req, cache);
}
