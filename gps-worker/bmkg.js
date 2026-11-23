// =====================================================================================
// Proxy + cache data terbuka BMKG untuk Buku Kas / Pelacak Motor.
//   GET /api/bmkg?type=weather&adm4=31.71.03.1001      prakiraan cuaca (kode wilayah)
//   GET /api/bmkg?type=weather&lat=-6.2&lon=106.8      prakiraan cuaca (kode wilayah dicari otomatis dari koordinat)
//   GET /api/bmkg?type=quake                           gempa terbaru (autogempa) + 15 gempa M5+ terkini (gempaterkini)
//   GET /api/bmkg?type=nowcast                         peringatan dini cuaca (CAP XML -> JSON)
//   GET /api/bmkg?type=health                          cek ringan (tanpa menghubungi BMKG)
//
// Cache berlapis (karena caches.default TIDAK aktif di domain *.workers.dev):
//   memori isolate -> Cache API Cloudflare (bila aktif) -> tabel D1 `kv` (bila ada) -> BMKG.
// Bila BMKG lambat/mati: data lama (stale) tetap dikirim dengan "stale": true.
// Data BMKG terbuka; wajib mencantumkan atribusi "Sumber Data: BMKG" di tampilan.
// =====================================================================================

const UA = "BukuKasGPS/1.0 (proxy data terbuka BMKG)";
const URLS = {
  weather: "https://api.bmkg.go.id/publik/prakiraan-cuaca",
  autogempa: "https://data.bmkg.go.id/DataMKG/TEWS/autogempa.json",
  gempaterkini: "https://data.bmkg.go.id/DataMKG/TEWS/gempaterkini.json",
  shakemapBase: "https://data.bmkg.go.id/DataMKG/TEWS/",
  nowcast: "https://www.bmkg.go.id/alerts/nowcast/id",
  nominatim: "https://nominatim.openstreetmap.org/reverse",
  wilayah: "https://wilayah.id/api",
};
const TTL = { weather: 1800, quake: 300, nowcast: 300, adm4: 30 * 86400 }; // detik
const FETCH_TIMEOUT_MS = 8000;
const NOWCAST_MAX_ITEMS = 25;

// ---------- fetch dengan batas waktu + 1x ulang untuk error jaringan/5xx ----------
async function fetchT(url, accept, ms) {
  let lastErr;
  for (let i = 0; i < 2; i++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms || FETCH_TIMEOUT_MS);
    try {
      const r = await fetch(url, { signal: ctl.signal, headers: { accept: accept || "*/*", "user-agent": UA } });
      if (r.status >= 500 && i === 0) { lastErr = new Error("BMKG HTTP " + r.status); continue; }
      if (!r.ok) throw new Error("BMKG HTTP " + r.status);
      return r;
    } catch (e) {
      lastErr = e && e.name === "AbortError" ? new Error("BMKG tidak merespons (timeout " + (ms || FETCH_TIMEOUT_MS) / 1000 + " dtk)") : e;
      if (String(lastErr.message).startsWith("BMKG HTTP 4")) break;
    } finally { clearTimeout(timer); }
  }
  throw lastErr || new Error("BMKG tidak dapat dihubungi");
}
const getJson = async (url, ms) => (await fetchT(url, "application/json", ms)).json();
const getText = async (url, ms) => (await fetchT(url, "application/xml,text/xml,*/*", ms)).text();

// ---------- cache berlapis ----------
const mem = new Map(); // key -> { t, data }
async function d1Get(env, k) {
  if (!env.DB) return null;
  try { const r = await env.DB.prepare("SELECT v FROM kv WHERE k=?").bind("bmkg:" + k).first(); return r ? JSON.parse(r.v) : null; } catch (e) { return null; }
}
async function d1Set(env, k, v) {
  if (!env.DB) return;
  try {
    await env.DB.prepare("INSERT INTO kv(k,v,updated_at) VALUES(?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=excluded.updated_at")
      .bind("bmkg:" + k, JSON.stringify(v), Date.now()).run();
  } catch (e) { /* cache gagal tidak boleh menggagalkan respons */ }
}
const edgeKey = (k) => new Request("https://bmkg-cache.invalid/" + encodeURIComponent(k));
async function edgeGet(k) {
  try { const r = await caches.default.match(edgeKey(k)); return r ? await r.json() : null; } catch (e) { return null; }
}
function edgePut(ctx, k, rec, ttl) {
  try {
    const res = new Response(JSON.stringify(rec), { headers: { "content-type": "application/json", "cache-control": "public, max-age=" + ttl } });
    ctx.waitUntil(caches.default.put(edgeKey(k), res).catch(() => {}));
  } catch (e) {}
}

// Mengembalikan { data, fetchedAt, cached, stale?, upstreamError? }
async function cached(env, ctx, key, ttlSec, producer) {
  const now = Date.now(), fresh = (rec) => rec && now - rec.t < ttlSec * 1000;
  let rec = mem.get(key);
  if (fresh(rec)) return { data: rec.data, fetchedAt: rec.t, cached: true };
  const e = await edgeGet(key);
  if (fresh(e)) { mem.set(key, e); return { data: e.data, fetchedAt: e.t, cached: true }; }
  const d = await d1Get(env, key);
  if (fresh(d)) { mem.set(key, d); return { data: d.data, fetchedAt: d.t, cached: true }; }
  try {
    const data = await producer();
    const nr = { t: Date.now(), data };
    mem.set(key, nr);
    edgePut(ctx, key, nr, ttlSec);
    ctx.waitUntil(d1Set(env, key, nr));
    return { data, fetchedAt: nr.t, cached: false };
  } catch (err) {
    const old = rec || e || d; // data lama lebih baik daripada error
    if (old) return { data: old.data, fetchedAt: old.t, cached: true, stale: true, upstreamError: String(err.message || err) };
    throw err;
  }
}

// ---------- parser XML ringan (Workers tidak punya DOMParser) ----------
function decodeEnt(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (m, g) => {
    const l = g.toLowerCase();
    if (l === "lt") return "<"; if (l === "gt") return ">"; if (l === "amp") return "&"; if (l === "quot") return '"'; if (l === "apos") return "'";
    const cp = l[1] === "x" ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10);
    try { return String.fromCodePoint(cp); } catch (e) { return m; }
  });
}
export function parseXml(xml) {
  const root = { name: "#root", children: [], text: "" };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<!DOCTYPE[^>]*>|<\/\s*([^\s>]+)\s*>|<([^\s/>!?]+)((?:\s+[^\s=>/]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(xml))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.text += m[1];
    else if (m[2] !== undefined) { if (stack.length > 1) stack.pop(); }
    else if (m[3] !== undefined) {
      const node = { name: m[3].replace(/^.*:/, ""), children: [], text: "", attrs: {} };
      (m[4] || "").replace(/([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g, (_, k, __, a, b) => { node.attrs[k] = decodeEnt(a !== undefined ? a : b); return ""; });
      top.children.push(node);
      if (!m[5]) stack.push(node);
    } else if (m[6] !== undefined) top.text += decodeEnt(m[6]);
  }
  return root.children[0] || null;
}
const kids = (n, name) => (n ? n.children.filter((c) => c.name === name) : []);
const kid = (n, name) => kids(n, name)[0] || null;
const txt = (n, name) => { const c = name ? kid(n, name) : n; return c ? c.text.trim() : ""; };

// ---------- gempa ----------
const num = (v) => { const n = parseFloat(String(v == null ? "" : v).replace(",", ".")); return Number.isFinite(n) ? n : null; };
export function normQuake(g, source) {
  let lat = num(g.Lintang && String(g.Lintang).replace(/\s*(LS|S)\s*$/i, "")), lon = null;
  // "Coordinates": "-6.78,129.91" (lat,lon) lebih andal daripada "6.78 LS"
  if (g.Coordinates) { const [a, b] = String(g.Coordinates).split(","); lat = num(a); lon = num(b); }
  if (lat === null || lon === null) return null;
  const dt = g.DateTime || null; // ISO UTC, mis. 2026-11-23T03:10:22+00:00
  return {
    id: (dt || (g.Tanggal + " " + g.Jam)) + "|" + lat + "," + lon,
    source,
    time: dt, timeText: [g.Tanggal, g.Jam].filter(Boolean).join(" "),
    lat, lon,
    mag: num(g.Magnitude), depthKm: num(g.Kedalaman),
    depthText: g.Kedalaman || "",
    region: g.Wilayah || "", potential: g.Potensi || "", felt: g.Dirasakan || "",
    shakemap: g.Shakemap ? URLS.shakemapBase + g.Shakemap : null,
  };
}
async function loadQuakes() {
  const [a, t] = await Promise.allSettled([getJson(URLS.autogempa), getJson(URLS.gempaterkini)]);
  if (a.status === "rejected" && t.status === "rejected") throw a.reason;
  const out = [], seen = new Set();
  const add = (g, src) => { const q = g && normQuake(g, src); if (q && !seen.has(q.id)) { seen.add(q.id); out.push(q); } };
  if (a.status === "fulfilled") add(a.value && a.value.Infogempa && a.value.Infogempa.gempa, "terbaru");
  if (t.status === "fulfilled") {
    const arr = t.value && t.value.Infogempa && t.value.Infogempa.gempa;
    (Array.isArray(arr) ? arr : arr ? [arr] : []).forEach((g) => add(g, "terkini"));
  }
  out.sort((x, y) => String(y.time || "").localeCompare(String(x.time || "")));
  return { quakes: out, partial: a.status === "rejected" || t.status === "rejected" };
}

// ---------- cuaca ----------
export function normWeather(j) {
  const lok = (j && j.lokasi) || {};
  const slots = [];
  for (const blk of (j && j.data) || []) for (const day of blk.cuaca || []) for (const s of Array.isArray(day) ? day : [day]) {
    const utc = s.utc_datetime ? Date.parse(String(s.utc_datetime).replace(" ", "T") + "Z") : NaN;
    if (!Number.isFinite(utc)) continue;
    slots.push({
      utc, local: s.local_datetime || s.datetime || null,
      temp: num(s.t), humidity: num(s.hu), windKmh: num(s.ws), windDir: s.wd || "", windFromDeg: num(s.wd_deg),
      cloud: num(s.tcc), rainMm: num(s.tp), visText: s.vs_text || "",
      code: num(s.weather), desc: s.weather_desc || "", descEn: s.weather_desc_en || "", icon: s.image || null,
    });
  }
  slots.sort((a, b) => a.utc - b.utc);
  if (!slots.length) throw new Error("data prakiraan kosong");
  return {
    place: { adm4: lok.adm4 || null, desa: lok.desa || "", kecamatan: lok.kecamatan || "", kotkab: lok.kotkab || "", provinsi: lok.provinsi || "", lat: num(lok.lat), lon: num(lok.lon), timezone: lok.timezone || "" },
    slots,
  };
}
// pilih slot terdekat dengan "sekarang" saat respons dibentuk (bukan saat disimpan di cache)
function pickCurrent(w, now) {
  let bi = 0, bd = Infinity;
  w.slots.forEach((s, i) => { const d = Math.abs(s.utc - now); if (d < bd) { bd = d; bi = i; } });
  return { place: w.place, current: w.slots[bi], next: w.slots.slice(bi + 1, bi + 9) };
}

// ---------- kode wilayah (adm4) dari koordinat ----------
const ADM4_RE = /^\d{2}\.\d{2}\.\d{2}\.\d{4}$/;
const STOP = new Set(["kota", "kabupaten", "kab", "kecamatan", "kec", "kelurahan", "kel", "desa", "provinsi", "daerah", "khusus", "ibukota", "istimewa", "administrasi", "dki", "di"]);
const toks = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w && !STOP.has(w));
function sim(a, b) {
  const A = toks(a), B = new Set(toks(b));
  if (!A.length || !B.size) return 0;
  const inter = A.filter((w) => B.has(w)).length;
  return inter / Math.max(A.length, B.size);
}
function bestMatch(list, names, minScore) {
  let best = null, bs = 0;
  for (const it of list) for (const n of names) { const sc = sim(n, it.name); if (sc > bs) { bs = sc; best = it; } }
  return bs >= (minScore || 0.5) ? best : null;
}
async function resolveAdm4(lat, lon) {
  const rev = await getJson(`${URLS.nominatim}?format=jsonv2&zoom=18&addressdetails=1&accept-language=id&lat=${lat}&lon=${lon}`, 7000);
  const a = (rev && rev.address) || {};
  if (a.country_code && a.country_code !== "id") throw Object.assign(new Error("koordinat di luar Indonesia"), { code: "outside_id" });
  const prov = [a.state, a.region].filter(Boolean);
  const kab = [a.city, a.county, a.regency, a.municipality, a.town].filter(Boolean);
  const kec = [a.city_district, a.suburb, a.district, a.subdistrict, a.municipality].filter(Boolean);
  const des = [a.village, a.neighbourhood, a.quarter, a.hamlet, a.suburb].filter(Boolean);
  const list = async (path) => { const j = await getJson(`${URLS.wilayah}/${path}.json`, 7000); return (j && j.data) || []; };
  const p = bestMatch(await list("provinces"), prov, 0.4); if (!p) throw new Error("provinsi tidak cocok");
  const k = bestMatch(await list(`regencies/${p.code}`), kab, 0.4); if (!k) throw new Error("kabupaten/kota tidak cocok");
  const dsts = await list(`districts/${k.code}`);
  const c = bestMatch(dsts, kec.length ? kec : des, 0.4) || dsts[0]; if (!c) throw new Error("kecamatan tidak cocok");
  const vils = await list(`villages/${c.code}`);
  const v = bestMatch(vils, des, 0.4) || vils[0]; if (!v) throw new Error("kelurahan/desa tidak cocok");
  if (!ADM4_RE.test(v.code)) throw new Error("format kode wilayah tak dikenal");
  return { adm4: v.code, name: [v.name, c.name, k.name, p.name].join(", ") };
}

// ---------- peringatan dini (CAP) ----------
function parsePolygon(s) {
  const pts = String(s || "").trim().split(/\s+/).map((p) => p.split(",").map(Number)).filter((p) => p.length === 2 && p.every(Number.isFinite));
  return pts.length >= 3 ? pts : null; // [[lat,lon],...]
}
export function parseCap(xml) {
  const root = parseXml(xml);
  if (!root || root.name !== "alert") return null;
  const infos = kids(root, "info");
  const info = infos.find((i) => /^id/i.test(txt(i, "language"))) || infos[0];
  if (!info) return null;
  const areas = kids(info, "area").map((ar) => ({
    name: txt(ar, "areaDesc"),
    polygons: kids(ar, "polygon").map((p) => parsePolygon(p.text)).filter(Boolean),
    circles: kids(ar, "circle").map((c) => { const m = c.text.trim().match(/^(-?[\d.]+),(-?[\d.]+)\s+(-?[\d.]+)$/); return m ? { lat: +m[1], lon: +m[2], radiusKm: +m[3] } : null; }).filter(Boolean),
    geocodes: kids(ar, "geocode").map((g) => txt(g, "value")).filter(Boolean),
  }));
  return {
    id: txt(root, "identifier"), sender: txt(root, "sender"), sent: txt(root, "sent"),
    status: txt(root, "status"), msgType: txt(root, "msgType"),
    event: txt(info, "event"), category: txt(info, "category"),
    urgency: txt(info, "urgency"), severity: txt(info, "severity"), certainty: txt(info, "certainty"),
    effective: txt(info, "effective"), onset: txt(info, "onset"), expires: txt(info, "expires"),
    senderName: txt(info, "senderName"), headline: txt(info, "headline"), description: txt(info, "description"),
    instruction: txt(info, "instruction"), web: txt(info, "web"), areas,
  };
}
async function loadNowcast() {
  const body = await getText(URLS.nowcast);
  const root = parseXml(body);
  if (!root) throw new Error("feed peringatan dini kosong/rusak");
  let alerts = [];
  if (root.name === "alert") { const a = parseCap(body); if (a) alerts.push(a); }
  else {
    // RSS: rss > channel > item(link) | Atom: feed > entry(link href) -> setiap tautan = file CAP XML
    const chan = kid(root, "channel") || root;
    const links = [];
    for (const it of kids(chan, "item")) { const l = txt(it, "link") || txt(it, "guid"); if (/^https?:/.test(l)) links.push(l); }
    for (const en of kids(chan, "entry")) { const l = kid(en, "link"); const h = l && (l.attrs && l.attrs.href); if (h) links.push(h); }
    const uniq = [...new Set(links)].slice(0, NOWCAST_MAX_ITEMS);
    const got = await Promise.allSettled(uniq.map(async (u) => { const a = parseCap(await getText(u, 6000)); if (a) a.url = u; return a; }));
    alerts = got.filter((g) => g.status === "fulfilled" && g.value).map((g) => g.value);
    if (uniq.length && !alerts.length && got.every((g) => g.status === "rejected")) throw new Error("gagal mengambil detail peringatan (CAP)");
  }
  return { alerts };
}
function activeAlerts(list, now) {
  return list.filter((a) => {
    if (/^(cancel)$/i.test(a.msgType) || /^(test|exercise)$/i.test(a.status)) return false;
    const exp = Date.parse(a.expires); return !Number.isFinite(exp) || exp > now;
  }).sort((x, y) => String(y.sent).localeCompare(String(x.sent)));
}

// ---------- router ----------
const ok = (body, status, cors, maxAge) => new Response(JSON.stringify(body), {
  status: status || 200,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": maxAge ? "public, max-age=" + maxAge : "no-store", ...cors },
});
const fail = (status, error, code, cors) => ok({ ok: false, error, code }, status, cors);

export async function handleBmkg(req, env, ctx, cors) {
  const u = new URL(req.url), type = u.searchParams.get("type") || "";
  const meta = (r) => ({ ok: true, source: "BMKG", fetchedAt: r.fetchedAt, cached: !!r.cached, stale: !!r.stale, upstreamError: r.upstreamError || undefined });
  try {
    if (type === "health") return ok({ ok: true, time: Date.now(), types: ["weather", "quake", "nowcast"] }, 200, cors);

    if (type === "quake") {
      const r = await cached(env, ctx, "quake", TTL.quake, loadQuakes);
      return ok({ ...meta(r), partial: !!r.data.partial, quakes: r.data.quakes }, 200, cors, 60);
    }

    if (type === "nowcast") {
      const r = await cached(env, ctx, "nowcast", TTL.nowcast, loadNowcast);
      return ok({ ...meta(r), alerts: activeAlerts(r.data.alerts, Date.now()) }, 200, cors, 60);
    }

    if (type === "weather") {
      let adm4 = u.searchParams.get("adm4"), resolved = null;
      if (adm4 && !ADM4_RE.test(adm4)) return fail(400, "format adm4 salah (contoh 31.71.03.1001)", "bad_adm4", cors);
      if (!adm4) {
        const lat = num(u.searchParams.get("lat")), lon = num(u.searchParams.get("lon"));
        if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return fail(400, "isi adm4, atau lat & lon", "bad_params", cors);
        // dibulatkan ±110 m agar kendaraan yang bergerak tidak membanjiri pencarian wilayah
        const rl = lat.toFixed(3), ro = lon.toFixed(3);
        try {
          const r = await cached(env, ctx, `adm4:${rl},${ro}`, TTL.adm4, () => resolveAdm4(rl, ro));
          adm4 = r.data.adm4; resolved = r.data.name;
        } catch (e) {
          return fail(e.code === "outside_id" ? 422 : 502, "kode wilayah (adm4) tidak bisa ditentukan dari koordinat: " + (e.message || e) + ". Isi kode adm4 manual.", "adm4_unresolved", cors);
        }
      }
      const r = await cached(env, ctx, "weather:" + adm4, TTL.weather, async () => normWeather(await getJson(`${URLS.weather}?adm4=${encodeURIComponent(adm4)}`)));
      return ok({ ...meta(r), adm4, resolvedName: resolved, ...pickCurrent(r.data, Date.now()) }, 200, cors, 60);
    }

    return fail(400, "type harus weather | quake | nowcast", "bad_type", cors);
  } catch (e) {
    const msg = String((e && e.message) || e);
    return fail(/timeout|tidak merespons/i.test(msg) ? 504 : 502, "Data BMKG sedang tidak tersedia: " + msg, "upstream", cors);
  }
}
