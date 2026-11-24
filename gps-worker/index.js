// Cloudflare Worker (gps-worker/index.js) untuk aplikasi Buku Kas + Pelacak Motor.
// GPS tracker CY06/GT06 lewat sesi web CantrackPortal (cookie sesi, BUKAN official-auth yang kena 403).
//
// Fitur: Web Push SOS (VAPID) + Cron tiap menit, riwayat rute (/api/history), perintah tracker diamankan Google ID token,
// rekaman audio di R2, sesi portal tersimpan di D1. Konfigurasi lengkap: lihat wrangler.toml dan README.md.
//
// Endpoint (semua butuh "Authorization: Bearer <Google ID token>" atau "Authorization: Session <token>", kecuali yang publik):
//   publik : GET /api/cctv (kamera publik: Windy + titik statis, CORS *)   GET /api/health   GET /api/push/vapid-key   POST /api/auth/session   POST /api/auth/totp   GET /api/audio/file/:id?exp&sig (URL bertanda tangan)
//   baca   : GET /api/me /api/config /api/sync /api/history /api/commands /api/audio/list /api/push/list   (+ /pos /alarms /info)
//   tulis  : POST /api/command (WAJIB Google ID token segar)   POST /api/push/subscribe|unsubscribe|test
//            POST /api/audio/upload   DELETE /api/audio/:id (pemilik)   GET /debug (pemilik)

import { handleBmkg } from "./bmkg.js";
import { handleCctv, cctvPreflight } from "./cctv.js";

const PORTAL = "https://www.cantrackportal.com";
const UA =
  "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36";
const SESSION_TTL = 10 * 60 * 1000; // login ulang tiap 10 menit

let session = null; // { mds, loginId, cookie, at }

// Asal (origin) yang diizinkan: ALLOW_ORIGIN (boleh beberapa, pisahkan koma) + asal bawaan APK Capacitor
let curOrigin = null;
function corsOrigin(env) {
  const list = String((env && env.ALLOW_ORIGIN) || "").split(",").map((x) => x.trim()).filter(Boolean);
  if (!list.length) return "*";
  const apk = ["https://localhost", "http://localhost", "capacitor://localhost", "ionic://localhost"];
  if (curOrigin && (list.includes(curOrigin) || apk.includes(curOrigin))) return curOrigin;
  return list[0];
}

function json(body, status, env) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": corsOrigin(env),
      "access-control-allow-headers": "authorization, x-api-key, content-type, x-filename, x-totp",
      "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
      vary: "Origin",
    },
  });
}

// Preflight CORS: status 204 TIDAK boleh punya body (kalau ada, Worker error dan browser memblokir)
function preflight(env) {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": corsOrigin(env),
      "access-control-allow-headers": "authorization, x-api-key, content-type, x-filename, x-totp",
      "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
      "access-control-max-age": "86400",
      vary: "Origin",
    },
  });
}

// "2026-11-19 14:03:22" -> epoch ms. Portal memberi waktu lokal (TIMEZONE jam dari UTC).
// Jika hasilnya di masa depan, berarti string-nya ternyata sudah UTC.
function parseTime(v, tz) {
  if (v === undefined || v === null || v === "") return null;
  if (/^\d{10,13}$/.test(String(v))) { const n = Number(v); return n < 1e12 ? n * 1000 : n; }
  const m = String(v).match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const utc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  const local = utc - (Number(tz) || 0) * 3600000;
  return local > Date.now() + 180000 ? utc : local;
}

// Samarkan token/ID supaya aman ditampilkan di /debug
function mask(s) {
  return String(s || "")
    .replace(/[0-9a-f]{32}/gi, "<hex32>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>");
}

// Ekstraksi token `mds` (32 hex) dari URL redirect, HTML, JSON, atau form tersembunyi. Dicoba juga dalam bentuk URL-decoded.
const MDS_RES = [
  /[?&;]mds=([0-9a-f]{32})(?![0-9a-f])/i,
  /["']?\bmds["']?\s*[:=]\s*["']([0-9a-f]{32})["']/i,
  /name=["']mds["'][^>]*value=["']([0-9a-f]{32})["']/i,
  /value=["']([0-9a-f]{32})["'][^>]*name=["']mds["']/i,
];
function extractMds(...sources) {
  for (const src of sources) {
    const raw = String(src || "");
    let dec = raw;
    try { dec = decodeURIComponent(raw); } catch (e) {}
    for (const t of raw === dec ? [raw] : [raw, dec]) {
      for (const re of MDS_RES) { const m = t.match(re); if (m) return m[1].toLowerCase(); }
    }
  }
  return undefined;
}

function cookiesFrom(res, prev) {
  const list = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const jar = {};
  (prev || "").split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i > 0) jar[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  });
  list.forEach((c) => {
    const kv = c.split(";")[0];
    const i = kv.indexOf("=");
    if (i > 0) jar[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  });
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
}

// MD5 murni (tanpa dependensi) untuk meniru loginEncoding.js milik portal: pwd = md5(md5(password))
function md5hex(str) {
  const msg = new TextEncoder().encode(str);
  const n = msg.length;
  const total = (((n + 8) >> 6) + 1) << 6;
  const buf = new Uint8Array(total);
  buf.set(msg);
  buf[n] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(total - 8, (n * 8) >>> 0, true);
  dv.setUint32(total - 4, Math.floor((n * 8) / 4294967296), true);
  const S = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
  const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let off = 0; off < total; off += 64) {
    const M = new Uint32Array(16);
    for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + M[g]) >>> 0;
      A = D; D = C; C = B;
      B = (B + (((F << S[i]) | (F >>> (32 - S[i]))) >>> 0)) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  let out = "";
  for (const v of [a0, b0, c0, d0]) for (let i = 0; i < 4; i++) out += ((v >>> (i * 8)) & 255).toString(16).padStart(2, "0");
  return out;
}

let loginCombo = null; // kombinasi yang pernah berhasil, dicoba lebih dulu
let loginFail = null;  // { at, err } hasil gagal terakhir: mencegah akun terkunci karena percobaan beruntun
const LOGIN_FAIL_PAUSE_MS = 60 * 1000;

// Form login portal (login.js) mengirim password APA ADANYA (baris md5 dikomentari). Login IMEI memakai loginType=USER.
// Default: coba USER lalu ENTERPRISE untuk IMEI (15 digit), sebaliknya untuk akun biasa. Setelah gagal, jeda 60 dtk.
async function login(env, bypassFail) {
  if (!bypassFail && loginFail && Date.now() - loginFail.at < LOGIN_FAIL_PAUSE_MS) {
    throw { ...loginFail.err, paused: true, retryInSec: Math.ceil((LOGIN_FAIL_PAUSE_MS - (Date.now() - loginFail.at)) / 1000) };
  }
  const pwd = String(env.PASSWORD || "").trim();
  const acc = String(env.ACCOUNT || "").trim();
  const types = env.LOGIN_TYPE ? [env.LOGIN_TYPE] : /^\d{15}$/.test(acc) ? ["USER", "ENTERPRISE"] : ["ENTERPRISE", "USER"];
  const modes = env.PWD_MODE === "md5" ? ["md5"] : env.PWD_MODE === "auto" ? ["plain", "md5"] : ["plain"];
  const combos = [];
  for (const m of modes) for (const t of types) combos.push([t, m]);
  if (loginCombo) {
    const i = combos.findIndex((c) => c[0] === loginCombo[0] && c[1] === loginCombo[1]);
    if (i > 0) combos.unshift(combos.splice(i, 1)[0]);
  }
  let first = null;
  for (const [t, m] of combos) {
    try {
      const s = await loginWith(env, t, m === "md5" ? md5hex(md5hex(pwd)) : pwd);
      loginCombo = [t, m];
      loginFail = null;
      return s;
    } catch (e) {
      if (!e || e.step !== "login") throw e;
      if (!first) first = e;
    }
  }
  const err = { ...first, tried: combos.map((c) => c.join("+")), accountLen: acc.length, pwdLen: pwd.length };
  loginFail = { at: Date.now(), err };
  throw err;
}

async function loginWith(env, loginType, pwdValue) {
  if (!env.ACCOUNT || !env.PASSWORD) throw { step: "config", error: "ACCOUNT/PASSWORD belum diisi" };

  // Kolom sama seperti form login portal (doSubmit di login.js): pwd_ dikosongkan, pwd berisi password
  const body = new URLSearchParams({
    userName: String(env.ACCOUNT).trim(),
    pwd_: "",
    loginType,
    loginUrl: PORTAL + "/",
    pwd: pwdValue,
    timeZone: env.TIMEZONE || "7",
    language: "cn",
    monitor: "0",
  });

  const res = await fetch(`${PORTAL}/LoginByUser.aspx?method=loginSystem`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": UA,
      origin: PORTAL,
      referer: PORTAL + "/",
    },
    body,
  });

  const location = res.headers.get("location") || "";
  const text = await res.text().catch(() => "");
  const hay = location + "\n" + text;

  let mds = extractMds(location, text);
  let loginId =
    (hay.match(/login_id=([0-9a-f-]{36})/i) || hay.match(/custid=([0-9a-f-]{36})/i) || [])[1];

  let cookie = cookiesFrom(res, "");

  // Login IMEI: balasan hanya berisi mds (redirect ke indexp.aspx), tanpa login_id.
  // Cari id di halaman tujuan; kalau tidak ada, pakai USER_ID (di portal school_id = custid = objectid).
  if (mds && !loginId) {
    try {
      const pr = await fetch(`${PORTAL}/user/indexp.aspx?mds=${mds}`, {
        headers: { "user-agent": UA, cookie, referer: PORTAL + "/" },
      });
      const pt = await pr.text();
      loginId = (pt.match(/(?:school_id|custid|login_id)=([0-9a-f-]{36})/i) || [])[1];
      cookie = cookiesFrom(pr, cookie);
      mds = extractMds(pr.url, pt) || mds; // token terbaru dari halaman utama (bila ada)
    } catch (e) {}
    if (!loginId && env.USER_ID) loginId = String(env.USER_ID).trim();
  }

  // mds belum ada di balasan login: ambil dari halaman utama portal (URL akhir atau isi HTML)
  if (!mds) {
    for (const pth of ["/user/indexp.aspx", "/user/main.html"]) {
      try {
        const pr = await fetch(PORTAL + pth, { headers: { "user-agent": UA, cookie, referer: PORTAL + "/" } });
        const pt = await pr.text();
        mds = extractMds(pr.url, pt);
        cookie = cookiesFrom(pr, cookie);
        if (!loginId) loginId = (pt.match(/(?:school_id|custid|login_id)=([0-9a-f-]{36})/i) || [])[1];
        if (mds) break;
      } catch (e) {}
    }
    if (!loginId && env.USER_ID) loginId = String(env.USER_ID).trim();
  }
  if (!mds || !loginId) {
    throw {
      step: "login",
      error: "mds/login_id tidak ditemukan di balasan login (password salah, captcha, atau diblokir WAF)",
      status: res.status,
      location: mask(location).slice(0, 300),
      sample: mask(text).slice(0, 300),
      hasCookie: !!cookie,
    };
  }

  // Ikuti redirect sekali untuk mengumpulkan cookie sesi tambahan (opsional)
  if (location) {
    try {
      const next = new URL(location, PORTAL).toString();
      const r2 = await fetch(next, {
        redirect: "manual",
        headers: { "user-agent": UA, cookie, referer: PORTAL + "/" },
      });
      cookie = cookiesFrom(r2, cookie);
    } catch (e) {}
  }

  // portal memakai cookie domainIndex=1 bersama ASP.NET_SessionId
  if (!/(^|;\s*)domainIndex=/.test(cookie)) cookie += (cookie ? "; " : "") + "domainIndex=1";
  return { mds, loginId, cookie, at: Date.now(), hasSessionId: /(^|;\s*)ASP\.NET_SessionId=/.test(cookie) };
}

// Sesi portal disimpan di D1 (kv) agar cron & isolate baru TIDAK login ulang tiap menit (mencegah akun portal terkunci).
async function getSession(env, force, bypassFail) {
  if (!force && session && Date.now() - session.at < SESSION_TTL) return session;
  if (!force) {
    const c = await kvGet(env, "session").catch(() => null);
    if (c && c.mds && Date.now() - c.at < SESSION_TTL) { session = c; return c; }
  }
  if (!bypassFail) {
    const lf = await kvGet(env, "loginFail").catch(() => null);
    if (lf && Date.now() - lf.at < LOGIN_FAIL_PAUSE_MS) {
      throw { ...lf.err, paused: true, retryInSec: Math.ceil((LOGIN_FAIL_PAUSE_MS - (Date.now() - lf.at)) / 1000) };
    }
  }
  try {
    session = await login(env, true);
    await kvSet(env, "session", session).catch(() => {});
    await kvSet(env, "loginFail", null).catch(() => {});
    return session;
  } catch (e) {
    if (e && e.step === "login") await kvSet(env, "loginFail", { at: Date.now(), err: e }).catch(() => {});
    throw e;
  }
}

async function fetchPos(env, s) {
  const q = new URLSearchParams({
    method: "getUserAndGpsInfoByIDsUtc",
    school_id: env.SCHOOL_ID || s.loginId,
    custid: env.CUSTID || s.loginId,
    mapType: "GOOGLE",
    option: "en",
    user_id: String(env.USER_ID).trim(),
    callback: "startTrack",
    mds: s.mds,
    t: String(Date.now()),
  });
  const headers = { "user-agent": UA, accept: "*/*", referer: `${PORTAL}/user/main.html` };
  if (s.cookie) headers.cookie = s.cookie;

  const res = await fetch(`${PORTAL}/TrackService.aspx?${q}`, { headers });
  const text = await res.text();
  const m = text.match(/^\s*startTrack\(([\s\S]*)\)\s*;?\s*$/);
  if (!m) return { ok: false, step: "track", status: res.status, sample: mask(text).slice(0, 300) };

  let data;
  try {
    data = JSON.parse(m[1]);
  } catch (e) {
    return { ok: false, step: "track", error: "JSON tidak valid", sample: mask(m[1]).slice(0, 300) };
  }
  const rec = data.records && data.records[0];
  const key = data.key || {};
  if (!rec) return { ok: false, step: "track", error: "records kosong (USER_ID salah?)", keys: Object.keys(key) };

  const fields = {};
  for (const [name, idx] of Object.entries(key)) fields[name] = rec[idx];

  return {
    ok: true,
    source: "track",
    fetchedAt: new Date().toISOString(),
    lat: Number(fields.weidu),
    lon: Number(fields.jingdu),
    speed: Number(fields.su),
    heading: fields.hangxiang,
    positionTime: fields.datetime,
    positionMs: parseTime(fields.datetime, env.TIMEZONE || "7"),
    heartbeat: fields.heart_time,
    heartbeatMs: parseTime(fields.heart_time, env.TIMEZONE || "7"),
    fields,
  };
}

// Sumber utama: loadUser (format sudah terbukti dari portal). Field: jingdu/weidu/sudu/datetime/heart_time/alarm.
async function fetchLoadUser(env, s) {
  const q = new URLSearchParams({
    method: "loadUser",
    callback: "loadUserCallBack",
    school_id: env.SCHOOL_ID || s.loginId,
    custid: env.CUSTID || s.loginId,
    user_id: String(env.USER_ID).trim(),
    mds: s.mds,
  });
  const headers = { "user-agent": UA, accept: "*/*", referer: `${PORTAL}/user/main.html` };
  if (s.cookie) headers.cookie = s.cookie;
  const res = await fetch(`${PORTAL}/GetDataService.aspx?${q}`, { headers });
  const text = await res.text();
  const m = text.match(/^[^(]*\(([\s\S]*)\)\s*;?\s*$/);
  let j;
  try {
    j = JSON.parse(m ? m[1] : text);
  } catch (e) {
    return { ok: false, step: "loadUser", error: "balasan bukan JSON", status: res.status, sample: mask(text).slice(0, 300) };
  }
  const d = j && Array.isArray(j.data) ? j.data[0] : null;
  if (!d) return { ok: false, step: "loadUser", error: (j && j.errorDescribe) || "data kosong (USER_ID salah?)", status: res.status };
  const tz = env.TIMEZONE || "7";
  return {
    ok: true,
    source: "loadUser",
    fetchedAt: new Date().toISOString(),
    name: d.user_name,
    lat: Number(d.weidu),
    lon: Number(d.jingdu),
    speed: Number(d.sudu) || 0,
    heading: null,
    alarm: d.alarm,
    positionTime: d.datetime,
    positionMs: parseTime(d.datetime, tz),
    heartbeat: d.heart_time,
    heartbeatMs: parseTime(d.heart_time, tz),
    fields: d,
  };
}

// Coba loadUser dulu; jika gagal, pakai metode lama (TrackService).
// Daftar alarm (endpoint yang sama dengan halaman "Daftar Alarm" di portal)
let alarmCache = null;
function toMs(v, tz) {
  const n = Number(v);
  if (isFinite(n) && n > 0) return n > 1e12 ? n : n * 1000;
  return parseTime(v, tz) || 0;
}
async function fetchAlarms(env, s) {
  const tries = [];
  for (const type of ["product", "custom"]) {
    const q = new URLSearchParams({
      method: "queryLocalAlarmInfoUtc",
      callback: "cbAlarm",
      school_id: env.SCHOOL_ID || s.loginId,
      mds: s.mds,
      max_time: "0",
      type,
      mapType: "GOOGLE",
      timestamp: String(Date.now()),
    });
    const headers = { "user-agent": UA, accept: "*/*", referer: `${PORTAL}/user/main.html` };
    if (s.cookie) headers.cookie = s.cookie;
    const res = await fetch(`${PORTAL}/GetDataService.aspx?${q}`, { headers });
    const text = await res.text();
    const m = text.match(/^\s*cbAlarm\(([\s\S]*)\)\s*;?\s*$/);
    if (!m) { tries.push({ type, status: res.status, sample: mask(text).slice(0, 160) }); continue; }
    let data;
    try { data = JSON.parse(m[1]); } catch (e) { tries.push({ type, error: "JSON tidak valid" }); continue; }
    if (data.success === false || data.success === "false") { tries.push({ type, error: data.errorDescribe || "gagal" }); continue; }
    const tz = env.TIMEZONE || "7";
    const rows = (data.rows || []).map((r) => ({
      id: r.id,
      typeId: Number(r.type_id),
      name: r.user_name || r.macname,
      sendMs: toMs(r.send_time, tz),
      gpsMs: toMs(r.gps_time, tz),
      speed: Number(r.speed) || 0,
      lat: Number(r.weidu),
      lon: Number(r.jingdu),
      desc: String(r.gps_status || "").split("|")[0],
      classify: r.classifyDescribe,
    })).sort((a, b) => b.sendMs - a.sendMs).slice(0, 50);
    return { ok: true, fetchedAt: new Date().toISOString(), count: rows.length, rows };
  }
  return { ok: false, step: "alarms", tries };
}

// TrackService = sumber yang sama dengan peta live di portal (lebih real-time).
// loadUser = data perangkat tersimpan (bisa tertinggal), dipakai hanya sebagai cadangan.
async function fetchAny(env, s) {
  const a = await fetchPos(env, s).catch((e) => ({ ok: false, step: "track", error: String(e) }));
  if (a.ok) return a;
  const b = await fetchLoadUser(env, s);
  return b.ok ? b : { ...b, trackError: a.error || a.step };
}

// Cek apakah portal bisa dijangkau dari Cloudflare (membedakan "password salah" dari "diblokir")
async function probePortal() {
  try {
    const r = await fetch(PORTAL + "/", { headers: { "user-agent": UA }, redirect: "manual" });
    const t = await r.text().catch(() => "");
    return {
      status: r.status,
      server: r.headers.get("server"),
      cfRay: !!r.headers.get("cf-ray"),
      looksLikeLoginPage: /LoginByUser\.aspx|loginformBase/i.test(t),
      blocked: r.status === 403 || r.status === 503 || /captcha|access denied|forbidden|cloudflare/i.test(t.slice(0, 2000)),
      sample: mask(t).slice(0, 120),
    };
  } catch (e) {
    return { error: String(e) };
  }
}

// CADANGAN: API resmi gaya Gpsoo (belum diuji). Dipakai bila login portal gagal.
// Opsional: API_BASE (default http://api.gpsoo.net/1), IMEI (pilih satu perangkat).
async function fetchOfficial(env) {
  const base = env.API_BASE || "http://api.gpsoo.net/1";
  const now = Math.floor(Date.now() / 1000);
  const pwd = String(env.PASSWORD || "").trim();
  const sig = md5hex(md5hex(pwd) + now);
  const acc = String(env.ACCOUNT || "").trim();
  const tk = await (await fetch(`${base}/auth/access_token?account=${encodeURIComponent(acc)}&time=${now}&signature=${sig}`)).json().catch(() => ({}));
  if (!tk.access_token) return { ok: false, step: "official-auth", error: "token API resmi tidak didapat", reply: mask(JSON.stringify(tk)).slice(0, 200) };
  const res = await (await fetch(`${base}/account/monitor?target=${encodeURIComponent(acc)}&map_type=GOOGLE&access_token=${tk.access_token}`)).json().catch(() => ({}));
  const list = res.data || [];
  const d = (env.IMEI && list.find((x) => String(x.imei || x.sn) === String(env.IMEI).trim())) || list[0];
  if (!d) return { ok: false, step: "official-monitor", error: "daftar perangkat kosong", reply: mask(JSON.stringify(res)).slice(0, 200) };
  const tz = env.TIMEZONE || "7";
  const when = d.gps_time || d.hearttime || d.time;
  return {
    ok: true, source: "official", fetchedAt: new Date().toISOString(),
    name: d.name || d.imei, lat: Number(d.lat ?? d.latitude), lon: Number(d.lng ?? d.lon ?? d.longitude),
    speed: Number(d.speed) || 0, heading: d.course ?? d.direction ?? null, alarm: null,
    positionTime: when, positionMs: parseTime(when, tz), heartbeat: when, heartbeatMs: parseTime(when, tz), fields: d,
  };
}

// ===== Perintah ke tracker (GT06/CY06) lewat CantrackPortal =====
const DEFAULT_IMEI = "868720062744036";
const INTERVAL_MIN = 5, INTERVAL_MAX = 18000; // detik

// action -> string perintah. Mengembalikan { cmd } atau { error }. {pw} = CMD_PASSWORD.
// record/monitor: templat bisa diganti lewat CMD_RECORD_TEMPLATE / CMD_MONITOR_TEMPLATE karena sintaks suara berbeda antar firmware.
function buildCommand(action, seconds, env) {
  const pw = String((env && env.CMD_PASSWORD) || "123456").replace(/[^0-9A-Za-z]/g, "");
  if (action === "cut_fuel") return { cmd: `DYD,${pw}#` };
  if (action === "restore_fuel") return { cmd: `HFYD,${pw}#` };
  if (action === "set_interval") {
    const n = Number(seconds);
    if (!Number.isInteger(n)) return { error: "intervalSeconds harus bilangan bulat" };
    if (n < INTERVAL_MIN) return { error: `intervalSeconds minimal ${INTERVAL_MIN} detik` };
    if (n > INTERVAL_MAX) return { error: `intervalSeconds maksimal ${INTERVAL_MAX} detik` };
    return { cmd: `TIMER,${pw},${n}#` };
  }
  if (action === "record") {
    const n = seconds === undefined || seconds === null || seconds === "" ? 15 : Number(seconds);
    if (!Number.isInteger(n) || n < 5 || n > 120) return { error: "seconds harus bilangan bulat 5-120" };
    return { cmd: fillTpl((env && env.CMD_RECORD_TEMPLATE) || "RECORD,{pw},{sec}#", { pw, sec: String(n) }) };
  }
  if (action === "monitor") return { cmd: fillTpl((env && env.CMD_MONITOR_TEMPLATE) || "MONITOR,{pw}#", { pw }) };
  return { error: "action tidak dikenal (cut_fuel | restore_fuel | set_interval | record | monitor)" };
}

// ----- Pengiriman perintah lewat SESI WEB PORTAL (cookie + mds hasil login yang sama dengan /pos) -----
// Jalur "official-auth" (api.gpsoo.net) TIDAK dipakai di sini: terkena 403 forbidden (errcode 3049).
//
// PENTING: nama endpoint perintah web portal belum terverifikasi. Daftar di bawah adalah KANDIDAT yang dicoba berurutan;
// yang pertama membalas sukses (JSON success/errcode 0) dipilih dan diingat. Cara pasti: login portal di browser, kirim 1 perintah
// (mis. atur rentang), buka DevTools > Network, lihat request-nya (URL, method, nama kolom form), lalu isi variabel CMD_CANDIDATES
// (JSON) agar menggantikan daftar bawaan. Placeholder nilai: {mds} {imei} {cmd} {loginId} {userId} {ts}
//   Contoh: [{"name":"portal","method":"POST","path":"/GetDateServices.asmx/SendCommands","form":{"macid":"{imei}","cmd":"{cmd}","pwd":"","mds":"{mds}"}}]
const DEFAULT_CANDIDATES = [
  // POST GetDataService.aspx?method=...&mds=<token>, cookie sesi + X-Requested-With (dari tangkapan jaringan portal).
  // SendCommands/SendCommand: nama metode & kolom body diambil dari permintaan pengguna, BELUM terlihat langsung di tangkapan; urut dicoba.
  { name: "GDS-SendCommands", method: "POST", path: "/GetDataService.aspx", query: { method: "SendCommands", mds: "{mds}" },
    form: { userid: "{userId}", objectid: "{userId}", macid: "{imei}", cmd: "{cmd}", command: "{cmd}", pwd: "{pw}", mds: "{mds}" } },
  { name: "GDS-SendCommand", method: "POST", path: "/GetDataService.aspx", query: { method: "SendCommand", mds: "{mds}" },
    form: { userid: "{userId}", objectid: "{userId}", macid: "{imei}", cmd: "{cmd}", command: "{cmd}", pwd: "{pw}", mds: "{mds}" } },
];
let cmdWinner = null; // nama kandidat yang pernah sukses (juga disimpan di D1 agar tahan restart isolate)

function getCandidates(env) {
  let list = DEFAULT_CANDIDATES;
  if (env.CMD_CANDIDATES) {
    try { const j = JSON.parse(env.CMD_CANDIDATES); if (Array.isArray(j) && j.length) list = j; } catch (e) {}
  }
  const i = cmdWinner ? list.findIndex((c) => c.name === cmdWinner) : -1;
  return i > 0 ? [list[i], ...list.slice(0, i), ...list.slice(i + 1)] : list;
}

function fillTpl(v, vars) {
  return String(v).replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m));
}

// Kirim satu kandidat. redirect "manual": pengalihan ke halaman error dianggap gagal, bukan diikuti diam-diam.
async function sendCandidate(env, s, cand, cmd, extra) {
  const base = String(env.CANTRACK_BASE_URL || PORTAL).replace(/\/+$/, "");
  const vars = {
    mds: s.mds, imei: String(env.IMEI || DEFAULT_IMEI).trim(), cmd,
    loginId: env.SCHOOL_ID || s.loginId || "", userId: String(env.USER_ID || "").trim(), ts: String(Date.now()), base,
    pw: String(env.CMD_PASSWORD || "123456").replace(/[^0-9A-Za-z]/g, ""), ...(extra || {}),
  };
  const url = new URL(base + cand.path);
  for (const [k, v] of Object.entries(cand.query || {})) url.searchParams.set(k, fillTpl(v, vars));
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(cand.form || {})) form.set(k, fillTpl(v, vars));
  const method = String(cand.method || "POST").toUpperCase();
  const headers = {
    "user-agent": UA, accept: "*/*", origin: base, referer: cand.referer ? fillTpl(cand.referer, vars) : `${base}/user/main.html`,
    "x-requested-with": "XMLHttpRequest",
  };
  if (s.cookie) headers.cookie = s.cookie; // cookie sesi web portal yang sama dengan /pos
  let body;
  if (method === "GET") form.forEach((v, k) => url.searchParams.set(k, v));
  else { headers["content-type"] = "application/x-www-form-urlencoded; charset=UTF-8"; body = form; }
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), 20000);
  try {
    const res = await fetch(url.toString(), { method, headers, body, redirect: "manual", signal: ctl.signal });
    const text = await res.text().catch(() => "");
    return { httpStatus: res.status, httpOk: res.ok, text, location: res.headers.get("location") || "" };
  } finally {
    clearTimeout(to);
  }
}

// Klasifikasi balasan. ok=true HANYA bila jelas bukan halaman HTML/redirect/kosong dan tidak ada tanda gagal.
// confidence "strong" = server menyatakan sukses (success:true / errcode 0); "weak" = teks biasa tanpa tanda gagal.
const FAIL_WORDS_RE = /fail|error|gagal|invalid|expired|not\s*login|forbidden|denied|unauthori[sz]ed|offline|timeout|失败|离线|超时|未登录|错误/i;
function classifyReply(r) {
  const raw = String(r.text || "").trim();
  if (r.httpStatus >= 300 && r.httpStatus < 400) return { ok: false, kind: "redirect", text: `[redirect ${r.httpStatus}] ${r.location || ""}`.slice(0, 300) };
  if (!raw) return { ok: false, kind: "empty", text: "(balasan kosong, belum ada konfirmasi dari server)" };
  if (/^\s*(<!doctype|<html)|<html[\s>]/i.test(raw)) {
    const title = (raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "";
    return { ok: false, kind: "html", text: `[HTML, bukan JSON: halaman error/blokir] ${title.trim()} ${raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 160)}`.trim() };
  }
  let t = raw;
  const x = t.match(/<string[^>]*>([\s\S]*?)<\/string>/i);
  if (x) t = x[1].trim();
  const cb = t.match(/^[\w$.]+\(([\s\S]*)\)\s*;?\s*$/); // JSONP
  let j = null;
  try { j = JSON.parse(cb ? cb[1] : t); } catch (e) {}
  if (j && typeof j === "object") {
    const succ = j.success ?? j.Success;
    const ec = j.errcode ?? j.errCode ?? j.errorCode ?? j.error_code;
    if (succ === false || String(succ).toLowerCase() === "false") return { ok: false, kind: "json-fail", text: t };
    if (ec !== undefined && ec !== null && String(ec) !== "0" && String(ec) !== "") return { ok: false, kind: "json-errcode", text: t };
    if (succ === true || String(succ).toLowerCase() === "true" || String(ec) === "0") return { ok: !!r.httpOk, kind: "json-ok", confidence: "strong", text: t };
    if (FAIL_WORDS_RE.test(t)) return { ok: false, kind: "json-failword", text: t };
    return { ok: !!r.httpOk, kind: "json-unknown", confidence: "weak", text: t };
  }
  if (FAIL_WORDS_RE.test(t)) return { ok: false, kind: "text-fail", text: t };
  return { ok: !!r.httpOk, kind: "text", confidence: "weak", text: t };
}
// Dipertahankan untuk kompatibilitas: true bila balasan HARUS dianggap gagal
function replyLooksFailed(r) { return !classifyReply(r).ok; }

function cleanText(t, s) {
  let v = String(t || "");
  if (s && s.mds) v = v.split(s.mds).join("<mds>");
  if (s && s.cookie) for (const c of s.cookie.split(";")) { const val = (c.split("=")[1] || "").trim(); if (val.length > 12) v = v.split(val).join("<cookie>"); }
  return v.trim().slice(0, 2000);
}

// ===== Deteksi alarm SOS & status relay BBM dari data posisi =====
// Nama field status di portal tidak terdokumentasi: kumpulkan semua field berbau alarm/status/relay lalu cocokkan pola.
// Cek hasilnya lewat /pos?raw=1 (lihat "fields") dan sesuaikan pola di bawah bila perlu.
const SOS_RE = /\bsos\b|darurat|emergency|panic|紧急|求助/i;
const CUT_RE = /(oil|fuel|petrol|relay|power|circuit|bbm|minyak)[^|,;]{0,24}(cut|off|disconnect|break|open|putus)|(cut|disconnect|putus)[^|,;]{0,24}(oil|fuel|relay|bbm)|断油|断电|油电断开|油路断开/i;
const RESTORE_RE = /(oil|fuel|petrol|relay|power|circuit|bbm|minyak)[^|,;]{0,24}(restore|on|connect|normal|pulih)|油电恢复|恢复供油|油路恢复|油电接通/i;

function statusText(out) {
  const f = (out && out.fields) || {};
  const parts = [];
  if (out && out.alarm !== undefined && out.alarm !== null) parts.push(typeof out.alarm === "object" ? JSON.stringify(out.alarm) : String(out.alarm));
  for (const [k, v] of Object.entries(f)) {
    if (!/alarm|status|state|relay|oil|fuel|dy|cut|sos/i.test(k)) continue;
    if (v === undefined || v === null || v === "") continue;
    parts.push(typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  return parts.join(" | ");
}

function detectFlags(out, lastCmd) {
  const text = statusText(out);
  const f = (out && out.fields) || {};
  // SOS: teks alarm memuat SOS, atau field type_id/alarm_type bernilai 1 (type_id 1 = SOS di portal)
  const typeId = f.alarm_type_id ?? f.alarm_type ?? f.type_id;
  const isSos = SOS_RE.test(text) || (typeId !== undefined && String(typeId).trim() === "1");

  let fuelCut = false, fuelCutSource = "unknown";
  if (CUT_RE.test(text) && !RESTORE_RE.test(text)) { fuelCut = true; fuelCutSource = "device"; }
  else if (RESTORE_RE.test(text)) { fuelCut = false; fuelCutSource = "device"; }
  else if (lastCmd && Date.now() - lastCmd.at < 24 * 3600 * 1000) {
    // Portal tidak melaporkan relay: pakai perintah BBM terakhir yang berhasil dikirim (hanya perkiraan, hilang bila Worker restart)
    fuelCut = lastCmd.action === "cut_fuel"; fuelCutSource = "lastCommand";
  }
  return { isSos, fuelCut, fuelCutSource, alarmText: text.slice(0, 200) };
}

let posCache = null; // { at, out }  cache 4 dtk supaya beberapa HP keluarga tidak membebani portal
const POS_CACHE_MS = 4 * 1000;

// Keluaran untuk aplikasi: tanpa field mentah (bisa berisi IMEI dsb.) kecuali diminta ?raw=1
function shape(out, raw) {
  if (raw) return out;
  const { fields, ...rest } = out;
  return rest;
}


// =====================================================================================================
// BAGIAN BARU: util, D1, autentikasi Google, Web Push (VAPID), riwayat rute, audio (R2), cron, router
// =====================================================================================================

const enc = new TextEncoder();
const dec = new TextDecoder();
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const MAX_HISTORY_MS = 7 * 24 * 3600 * 1000;
const SESSION_TOKEN_TTL = 14 * 24 * 3600; // detik

const ALARM_NAMES = {
  1: "SOS (darurat)", 2: "Anti-maling", 3: "Keluar pagar geo", 4: "Masuk pagar geo", 5: "Listrik terputus", 6: "Kecepatan tinggi",
  7: "Kecepatan rendah", 8: "Batere lemah", 9: "Getaran", 10: "Kendaraan bergerak", 11: "Perangkat reset", 12: "Masuk area blind spot",
  13: "Keluar area blind spot", 14: "Pintu dibuka", 15: "Pintu ditutup", 16: "ACC (kontak) hidup", 17: "Tabrakan", 18: "Terguling",
  19: "GEO", 20: "Idle (mesin hidup, diam)", 23: "Diderek", 24: "Berhenti terlalu lama", 25: "Bantuan darurat (4S)",
  31: "Lepas dari pengawasan", 33: "Gangguan sinyal GPS", 34: "Gangguan sinyal GSM", 37: "Alarm offline", 38: "Perangkat dilepas",
  39: "Alarm parkir", 40: "Alarm gangguan", 41: "Start ilegal", 48: "Alarm cabut-colok",
};

// ---------- util base64url / byte ----------
function b64uEnc(buf) {
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64uDec(str) {
  let s = String(str).replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
function concatBytes(...parts) {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const listOf = (v) => String(v || "").split(/[,\s;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
const numList = (v) => String(v || "").split(/[,\s;]+/).map(Number).filter((n) => Number.isFinite(n));
const fail = (httpStatus, error, code, extra) => ({ httpStatus, error, code, ...(extra || {}) });

// ---------- D1 key-value ----------
async function kvGet(env, k) {
  if (!env.DB) return null;
  const r = await env.DB.prepare("SELECT v FROM kv WHERE k=?").bind(k).first();
  if (!r) return null;
  try { return JSON.parse(r.v); } catch (e) { return null; }
}
async function kvSet(env, k, v) {
  if (!env.DB) return;
  await env.DB.prepare("INSERT INTO kv(k,v,updated_at) VALUES(?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=excluded.updated_at")
    .bind(k, JSON.stringify(v), Date.now()).run();
}
async function markSeen(env, id) {
  const r = await env.DB.prepare("INSERT OR IGNORE INTO alarm_seen(id,seen_at) VALUES(?,?)").bind(id, Date.now()).run();
  return !!(r && r.meta && r.meta.changes > 0);
}

// ---------- HMAC (token sesi aplikasi & URL audio bertanda tangan) ----------
let autoSignCache = null;
async function signingSecret(env) {
  if (env.SIGNING_SECRET) return env.SIGNING_SECRET;       // diisi manual = dipakai
  if (autoSignCache) return autoSignCache;
  if (!env.DB) throw fail(500, "SIGNING_SECRET belum diisi dan D1 tidak tersedia", "config");
  let v = await kvGet(env, "autoSigningSecret");
  if (typeof v !== "string" || v.length < 32) {            // dibuat otomatis sekali, disimpan di D1
    v = b64uEnc(crypto.getRandomValues(new Uint8Array(48)));
    await env.DB.prepare("INSERT OR IGNORE INTO kv(k,v,updated_at) VALUES(?,?,?)").bind("autoSigningSecret", JSON.stringify(v), Date.now()).run();
    const again = await kvGet(env, "autoSigningSecret"); if (typeof again === "string") v = again; // bila dua permintaan balapan, pakai yang tersimpan
  }
  autoSignCache = v; return v;
}
async function hmacKey(env) {
  const secret = await signingSecret(env);
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
async function hmacSign(env, text) { return b64uEnc(await crypto.subtle.sign("HMAC", await hmacKey(env), enc.encode(text))); }
async function hmacVerify(env, text, sig) {
  try { return await crypto.subtle.verify("HMAC", await hmacKey(env), b64uDec(sig), enc.encode(text)); } catch (e) { return false; }
}
async function signSession(env, email, role) {
  const body = b64uEnc(enc.encode(JSON.stringify({ e: email, r: role, exp: Math.floor(Date.now() / 1000) + SESSION_TOKEN_TTL })));
  return `${body}.${await hmacSign(env, body)}`;
}
async function verifySession(env, token) {
  const [body, sig] = String(token).split(".");
  if (!body || !sig || !(await hmacVerify(env, body, sig))) throw fail(401, "token sesi tidak valid", "session_invalid");
  let p; try { p = JSON.parse(dec.decode(b64uDec(body))); } catch (e) { throw fail(401, "token sesi rusak", "session_invalid"); }
  if (!p.exp || p.exp < Date.now() / 1000) throw fail(401, "token sesi kedaluwarsa", "session_expired");
  return p;
}

// ---------- Verifikasi Google ID Token (RS256 + JWKS) ----------
let jwksCache = null;
async function getJwks(force) {
  if (!force && jwksCache && Date.now() < jwksCache.exp) return jwksCache.keys;
  const r = await fetch("https://www.googleapis.com/oauth2/v3/certs");
  if (!r.ok) throw fail(502, "gagal mengambil kunci publik Google", "jwks");
  const j = await r.json();
  const ma = Number(((r.headers.get("cache-control") || "").match(/max-age=(\d+)/) || [])[1]) || 3600;
  jwksCache = { keys: j.keys || [], exp: Date.now() + ma * 1000 };
  return jwksCache.keys;
}
async function verifyGoogle(env, idToken) {
  const aud = listOfRaw(env.GOOGLE_CLIENT_ID);
  if (!aud.length) throw fail(500, "GOOGLE_CLIENT_ID belum diisi", "config");
  const parts = String(idToken || "").split(".");
  if (parts.length !== 3) throw fail(401, "ID token Google tidak valid", "token_invalid");
  let header, claims;
  try { header = JSON.parse(dec.decode(b64uDec(parts[0]))); claims = JSON.parse(dec.decode(b64uDec(parts[1]))); }
  catch (e) { throw fail(401, "ID token Google rusak", "token_invalid"); }
  if (header.alg !== "RS256") throw fail(401, "algoritma token tidak didukung", "token_invalid");

  let keys = await getJwks(false);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) { keys = await getJwks(true); jwk = keys.find((k) => k.kid === header.kid); }
  if (!jwk) throw fail(401, "kunci penanda tangan token tidak dikenal", "token_invalid");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64uDec(parts[2]), enc.encode(parts[0] + "." + parts[1]));
  if (!ok) throw fail(401, "tanda tangan token tidak cocok", "token_invalid");

  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== "accounts.google.com" && claims.iss !== "https://accounts.google.com") throw fail(401, "penerbit token salah", "token_invalid");
  if (!aud.includes(String(claims.aud))) throw fail(401, "token bukan untuk aplikasi ini (aud)", "token_invalid");
  if (!claims.exp || claims.exp + 30 < now) throw fail(401, "token Google kedaluwarsa, masuk ulang", "token_expired");
  if (claims.iat && claims.iat - 120 > now) throw fail(401, "waktu token tidak wajar", "token_invalid");
  if (!(claims.email_verified === true || claims.email_verified === "true")) throw fail(401, "email Google belum terverifikasi", "token_invalid");
  return { email: String(claims.email || "").toLowerCase(), name: claims.name || "", sub: claims.sub };
}
function listOfRaw(v) { return String(v || "").split(/[,\s;]+/).map((x) => x.trim()).filter(Boolean); }

function roleOf(env, email) {
  const e = String(email || "").toLowerCase();
  if (listOf(env.OWNER_EMAILS).includes(e)) return "owner";
  if (listOf(env.FAMILY_EMAILS).includes(e)) return "family";
  return null;
}
function grant(env, email, via) {
  const role = roleOf(env, email);
  if (!role) throw fail(403, "akun Google ini tidak ada di daftar izin", "not_whitelisted");
  return { email, role, via };
}
const LEGACY_PATHS = ["/pos", "/alarms", "/info"];
function safeEq(a, b) {
  a = String(a || ""); b = String(b || "");
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}
// ---------- TOTP (Google Authenticator / Authy / Microsoft Authenticator) ----------
// RFC 6238: SHA-1, 6 digit, langkah 30 dtk, toleransi ±1 langkah.
// Kunci rahasia: dibuat DARI APLIKASI lewat /api/auth/totp-setup (disimpan di D1), atau diisi manual lewat secret TOTP_SECRET (menang bila ada).
// Pendaftaran/ulang-buat kunci wajib kata sandi akun CantrackPortal (secret PASSWORD yang sudah ada di server).
// Kode TIDAK bisa dipakai dua kali (per tujuan: login / perintah). Gagal 5x dari satu IP = kunci 10 menit; gagal 30x total/jam = kunci 1 jam.
const TOTP_ID = "authenticator";
async function getTotpSecret(env) {
  if (env.TOTP_SECRET) return String(env.TOTP_SECRET);
  const v = await kvGet(env, "totpSecret").catch(() => null);
  return typeof v === "string" && v ? v : null;
}
function b32dec(sec) {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const t = String(sec || "").toUpperCase().replace(/[\s=-]/g, "");
  let bits = ""; const out = [];
  for (const ch of t) { const v = A.indexOf(ch); if (v < 0) throw fail(500, "kunci TOTP bukan base32 yang valid", "config"); bits += v.toString(2).padStart(5, "0"); }
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  if (out.length < 10) throw fail(500, "kunci TOTP terlalu pendek", "config");
  return new Uint8Array(out);
}
function b32enc(bytes) {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; let bits = "", out = "";
  for (const b of bytes) bits += b.toString(2).padStart(8, "0");
  for (let i = 0; i + 5 <= bits.length; i += 5) out += A[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}
async function hotp(keyBytes, counter) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const buf = new ArrayBuffer(8), dv = new DataView(buf);
  dv.setUint32(0, Math.floor(counter / 4294967296)); dv.setUint32(4, counter >>> 0);
  const h = new Uint8Array(await crypto.subtle.sign("HMAC", key, buf));
  const o = h[19] & 15;
  const bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(bin % 1000000).padStart(6, "0");
}
async function totpCheck(env, secret, code, purpose) {
  const c = String(code || "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(c)) throw fail(400, "kode harus 6 angka", "totp_format");
  const key = b32dec(secret), step = Math.floor(Date.now() / 30000);
  let hit = null;
  for (const d of [-1, 0, 1]) if (safeEq(await hotp(key, step + d), c)) hit = step + d; // semua dihitung agar waktu respons sama
  if (hit === null) return false;
  const last = await kvGet(env, "totpLast:" + purpose);
  if (typeof last === "number" && hit <= last) return false; // kode yang sama tidak boleh dipakai ulang
  await kvSet(env, "totpLast:" + purpose, hit);
  return true;
}
// Penahan percobaan (dipakai kode Authenticator DAN kata sandi pendaftaran). check(): lempar 429 bila terkunci. fail(): catat gagal.
async function lockCheck(req, env) {
  if (!env.DB) throw fail(500, "D1 wajib (penahan percobaan & anti pakai-ulang)", "config");
  const ip = req.headers.get("cf-connecting-ip") || "x", now = Date.now();
  const kIp = "totpFail:" + ip, kAll = "totpFail:all";
  const fIp = (await kvGet(env, kIp)) || { n: 0, until: 0 }, fAll = (await kvGet(env, kAll)) || { n: 0, until: 0, since: now };
  const until = Math.max(fIp.until || 0, fAll.until || 0);
  if (until > now) throw fail(429, "terlalu banyak percobaan salah, coba lagi nanti", "totp_locked", { retryAfterSec: Math.ceil((until - now) / 1000) });
  return { kIp, kAll, fIp, fAll, now };
}
async function lockFail(env, L) {
  const { kIp, kAll, fIp, fAll, now } = L;
  fIp.n = (fIp.n || 0) + 1; if (fIp.n >= 5) { fIp.until = now + 10 * 60000; fIp.n = 0; }
  if (now - (fAll.since || now) > 3600000) { fAll.n = 0; fAll.since = now; }
  fAll.n = (fAll.n || 0) + 1; if (fAll.n >= 30) { fAll.until = now + 3600000; fAll.n = 0; fAll.since = now; }
  await kvSet(env, kIp, fIp); await kvSet(env, kAll, fAll);
}
async function totpAttempt(req, env, code, purpose) {
  const secret = await getTotpSecret(env);
  if (!secret) throw fail(409, "Authenticator belum disiapkan. Buat kunci dulu dari aplikasi.", "totp_not_enrolled");
  const L = await lockCheck(req, env);
  if (await totpCheck(env, secret, code, purpose)) { if (L.fIp.n) await kvSet(env, L.kIp, { n: 0, until: 0 }); return true; }
  await lockFail(env, L);
  throw fail(401, "kode Authenticator salah atau sudah dipakai", "totp_invalid");
}
// Buat kunci baru dari aplikasi. Kunci hanya dikembalikan SEKALI di respons ini. Membuat ulang = kunci lama & semua sesi Authenticator lama mati.
async function totpSetup(req, env, password) {
  if (env.TOTP_SECRET) throw fail(409, "kunci diatur manual lewat secret TOTP_SECRET; hapus secret itu dulu bila ingin membuatnya dari aplikasi", "totp_managed");
  const L = await lockCheck(req, env);
  if (!env.PASSWORD || !safeEq(String(password || ""), env.PASSWORD)) { await lockFail(env, L); throw fail(401, "kata sandi akun CantrackPortal salah", "setup_denied"); }
  const secret = b32enc(crypto.getRandomValues(new Uint8Array(20))); // 160 bit
  await kvSet(env, "totpSecret", secret);
  await kvSet(env, "totpSetAt", Date.now());
  await kvSet(env, "totpLast:login", 0); await kvSet(env, "totpLast:command", 0);
  const label = encodeURIComponent("Buku Kas GPS") + ":" + encodeURIComponent("Kendaraan");
  return { ok: true, secret, uri: `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent("Buku Kas GPS")}&algorithm=SHA1&digits=6&period=30` };
}

async function authenticate(req, env, u, path) {
  const m = (req.headers.get("authorization") || "").match(/^(Bearer|Session)\s+(.+)$/i);
  if (m) {
    if (m[1].toLowerCase() === "bearer") { const c = await verifyGoogle(env, m[2]); return grant(env, c.email, "google"); }
    const p = await verifySession(env, m[2]);
    if (p.e === TOTP_ID) { // sesi hasil verifikasi Authenticator (pemilik tunggal)
      if (!(await getTotpSecret(env))) throw fail(401, "verifikasi Authenticator tidak aktif di server", "session_invalid");
      const setAt = await kvGet(env, "totpSetAt").catch(() => null);
      if (typeof setAt === "number" && (p.exp - SESSION_TOKEN_TTL) * 1000 < setAt - 1000) throw fail(401, "kunci Authenticator sudah dibuat ulang, masuk lagi", "session_invalid");
      return { email: TOTP_ID, role: "owner", via: "session", totp: true };
    }
    return grant(env, p.e, "session");
  }
  // Kompatibilitas aplikasi lama (hanya baca): aktif bila LEGACY_READ=1. Perintah TIDAK pernah memakai jalur ini.
  const k = req.headers.get("x-api-key") || u.searchParams.get("key");
  if (env.LEGACY_READ === "1" && env.APP_KEY && safeEq(k, env.APP_KEY) && LEGACY_PATHS.includes(path)) return { email: "legacy", role: "legacy", via: "apikey" };
  throw fail(401, "perlu masuk dengan akun Google", "no_auth");
}

// ---------- Web Push (VAPID + aes128gcm, RFC 8030/8291/8292) ----------
let vapidKeyCache = null;
async function vapidSigningKey(env) {
  if (vapidKeyCache) return vapidKeyCache;
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) throw fail(500, "VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY belum diisi", "config");
  const pub = b64uDec(env.VAPID_PUBLIC_KEY);
  if (pub.length !== 65 || pub[0] !== 4) throw fail(500, "VAPID_PUBLIC_KEY harus 65 byte (uncompressed) base64url", "config");
  vapidKeyCache = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", x: b64uEnc(pub.slice(1, 33)), y: b64uEnc(pub.slice(33, 65)), d: env.VAPID_PRIVATE_KEY.trim(), ext: true },
    { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  return vapidKeyCache;
}
async function vapidAuthHeader(env, endpoint) {
  const aud = new URL(endpoint).origin;
  const head = b64uEnc(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claim = b64uEnc(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT || "mailto:admin@example.com" })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, await vapidSigningKey(env), enc.encode(head + "." + claim));
  return `vapid t=${head}.${claim}.${b64uEnc(sig)}, k=${env.VAPID_PUBLIC_KEY.trim()}`;
}
async function hkdf(ikmKey, salt, info, bits) {
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, ikmKey, bits));
}
async function encryptPayload(sub, plaintext) {
  const uaPub = b64uDec(sub.p256dh), authSecret = b64uDec(sub.auth);
  const eph = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, eph.privateKey, 256);
  const prk = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const ikm = await hkdf(prk, authSecret, concatBytes(enc.encode("WebPush: info\0"), uaPub, asPub), 256);
  const ikmKey = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(ikmKey, salt, enc.encode("Content-Encoding: aes128gcm\0"), 128);
  const nonce = await hkdf(ikmKey, salt, enc.encode("Content-Encoding: nonce\0"), 96);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, concatBytes(plaintext, new Uint8Array([2]))));
  return concatBytes(salt, new Uint8Array([0, 0, 0x10, 0]), new Uint8Array([asPub.length]), asPub, ct);
}
// Kirim ke satu langganan. gone=true => langganan sudah mati (404/410), hapus dari D1.
async function sendPush(env, sub, payload, opts) {
  opts = opts || {};
  const body = await encryptPayload(sub, enc.encode(JSON.stringify(payload)));
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      authorization: await vapidAuthHeader(env, sub.endpoint),
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      ttl: String(opts.ttl || 3600),
      urgency: opts.urgency || "normal",
    },
    body,
  });
  return { ok: res.status >= 200 && res.status < 300, status: res.status, gone: res.status === 404 || res.status === 410 };
}
async function pushTo(env, where, binds, payload, opts) {
  if (!env.DB) return { sent: 0, failed: 0, removed: 0 };
  const rows = (await env.DB.prepare(`SELECT endpoint,p256dh,auth,email FROM push_subs ${where}`).bind(...binds).all()).results || [];
  let sent = 0, failed = 0, removed = 0;
  await Promise.all(rows.map(async (sub) => {
    try {
      const r = await sendPush(env, sub, payload, opts);
      if (r.ok) { sent++; await env.DB.prepare("UPDATE push_subs SET last_ok=?, fail_count=0 WHERE endpoint=?").bind(Date.now(), sub.endpoint).run(); }
      else if (r.gone) { removed++; await env.DB.prepare("DELETE FROM push_subs WHERE endpoint=?").bind(sub.endpoint).run(); }
      else { failed++; await env.DB.prepare("UPDATE push_subs SET fail_count=fail_count+1 WHERE endpoint=?").bind(sub.endpoint).run(); }
    } catch (e) { failed++; console.error("push error", String(e)); }
  }));
  return { sent, failed, removed, total: rows.length };
}
const pushAll = (env, payload, opts) => pushTo(env, "", [], payload, opts);

// APK Capacitor tidak mendukung Web Push; SOS ke APK dikirim lewat layanan FCM yang SUDAH ada di Buku Kas
// (Google Apps Script sos-push-gas.gs atau sos-push-worker.js). Isi SOS_PUSH_URL & SOS_PUSH_KEY (secret). Kosong = dilewati.
async function pushNativeSos(env, h, pos) {
  if (!env.SOS_PUSH_URL || !env.SOS_PUSH_KEY || !h.isSos) return { skipped: true };
  const lat = Number.isFinite(h.lat) ? h.lat : pos && pos.lat, lon = Number.isFinite(h.lon) ? h.lon : pos && pos.lon;
  const base = String(env.SOS_PUSH_URL).trim();
  const isGas = /script\.google\.com/.test(base);
  const url = isGas ? base : base.replace(/\/+$/, "") + "/sos";
  const headers = { "content-type": "text/plain;charset=utf-8", "x-app-key": env.SOS_PUSH_KEY };
  const origin = String(env.ALLOW_ORIGIN || "").split(",")[0].trim();
  if (origin) headers.origin = origin;
  const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(url, { method: "POST", headers, body: JSON.stringify({ name: h.name || "Kendaraan", senderId: "gps-tracker", lat: Number.isFinite(lat) ? lat : null, lng: Number.isFinite(lon) ? lon : null, repeat: false, key: env.SOS_PUSH_KEY }), signal: ctl.signal });
    return { ok: r.ok, status: r.status };
  } catch (e) { return { ok: false, error: String(e) }; } finally { clearTimeout(to); }
}
const pushEmail = (env, email, payload, opts) => pushTo(env, "WHERE email=?", [email], payload, opts);
const pushOwners = async (env, payload, opts) => {
  const owners = listOf(env.OWNER_EMAILS);
  if (!owners.length) return pushAll(env, payload, opts);
  return pushTo(env, `WHERE email IN (${owners.map(() => "?").join(",")})`, owners, payload, opts);
};

function sosPayload(r, pos) {
  const lat = Number.isFinite(r.lat) ? r.lat : pos && pos.lat, lon = Number.isFinite(r.lon) ? r.lon : pos && pos.lon;
  const when = r.gpsMs || r.sendMs || Date.now();
  const hm = new Date(when + (Number(TZ_OFFSET_DEFAULT) * 3600000)).toISOString().slice(11, 16);
  return {
    kind: r.isSos ? "sos" : "alert",
    title: r.isSos ? "🆘 SOS DARURAT — tombol ditekan!" : "⚠️ " + (ALARM_NAMES[r.typeId] || "Alarm kendaraan"),
    body: `${r.name || "Kendaraan"} • ${hm} • ${Math.round(r.speed || 0)} km/j` + (Number.isFinite(lat) ? `\n${lat.toFixed(5)}, ${lon.toFixed(5)}` : ""),
    lat, lon, ts: when, tag: (r.isSos ? "sos-" : "alert-") + (r.id || when), url: "./?" + (r.isSos ? "sos=1" : "alarm=1") + (Number.isFinite(lat) ? `&lat=${lat}&lon=${lon}` : ""),
  };
}
let TZ_OFFSET_DEFAULT = 7;

// ---------- Posisi & alarm (dengan sesi tersimpan di D1) ----------
async function withSession(env, fn) {
  let s = await getSession(env, false);
  let r = await fn(s);
  if (r && r.ok === false) { s = await getSession(env, true); r = await fn(s); }
  return r;
}
async function getPos(env, opts) {
  if (!env.USER_ID) return { ok: false, step: "config", error: "USER_ID belum diisi" };
  if (!(opts && opts.fresh) && posCache && Date.now() - posCache.at < POS_CACHE_MS) return { ...posCache.out, cached: true };
  const out = await withSession(env, (s) => fetchAny(env, s));
  if (out.ok) {
    Object.assign(out, detectFlags(out, await kvGet(env, "lastCmd").catch(() => null)));
    posCache = { at: Date.now(), out };
  }
  return out;
}
async function getAlarms(env, opts) {
  if (!(opts && opts.fresh) && alarmCache && Date.now() - alarmCache.at < 8000) return alarmCache.out;
  const out = await withSession(env, (s) => fetchAlarms(env, s));
  if (out.ok) {
    out.rows = out.rows.map((r) => ({ ...r, name: ALARM_NAMES[r.typeId] || r.desc || "Alarm tipe " + r.typeId }));
    alarmCache = { at: Date.now(), out };
  }
  return out;
}
async function savePosition(env, p) {
  if (!env.DB || !Number.isFinite(p.lat) || !Number.isFinite(p.lon) || !p.positionMs) return;
  await env.DB.prepare("INSERT OR IGNORE INTO positions(t,lat,lon,speed,heading,up) VALUES(?,?,?,?,?,?)")
    .bind(p.positionMs, p.lat, p.lon, p.speed || 0, Number(p.heading) || null, Date.now()).run();
}

// ---------- Riwayat rute (playback) ----------
// PERHATIAN: nama endpoint playback di web CantrackPortal BELUM terverifikasi. Daftar ini hanya KANDIDAT TEBAKAN.
// Cara pasti: login portal di browser > menu Playback/Riwayat > DevTools > Network > salin URL + parameter, lalu isi variabel
// HISTORY_CANDIDATES (JSON, format sama dengan CMD_CANDIDATES). Placeholder tambahan: {from} {to} (waktu lokal "YYYY-MM-DD HH:mm:ss"),
// {fromUtc} {toUtc} (waktu UTC), {fromMs} {toMs}, {mds} {imei} {loginId} {userId} {ts}.
const DEFAULT_HISTORY_CANDIDATES = [
  // POST GetDataService.aspx?method=...&mds=<token>. Hanya StayDetail yang terbukti di tangkapan jaringan (filter=300 = jeda berhenti, detik);
  // GetHistoryTrack & HistoryTrack adalah kandidat yang belum terverifikasi. Waktu = epoch milidetik.
  { name: "GDS-GetHistoryTrack", method: "POST", path: "/GetDataService.aspx", referer: "{base}/user/playback.html?school_id={userId}&mapType=GOOGLE&objectid={userId}&lang=en&custid={userId}&mds={mds}",
    query: { method: "GetHistoryTrack", mds: "{mds}" }, form: { beginTime: "{fromMs}", endTime: "{toMs}", userid: "{userId}", objectid: "{userId}", mapType: "GOOGLE" } },
  { name: "GDS-HistoryTrack", method: "POST", path: "/GetDataService.aspx", referer: "{base}/user/playback.html?school_id={userId}&mapType=GOOGLE&objectid={userId}&lang=en&custid={userId}&mds={mds}",
    query: { method: "HistoryTrack", mds: "{mds}" }, form: { beginTime: "{fromMs}", endTime: "{toMs}", userid: "{userId}", objectid: "{userId}", mapType: "GOOGLE" } },
  { name: "GDS-StayDetail", method: "POST", path: "/GetDataService.aspx", referer: "{base}/user/playback.html?school_id={userId}&mapType=GOOGLE&objectid={userId}&lang=en&custid={userId}&mds={mds}",
    query: { method: "StayDetail", mds: "{mds}" }, form: { beginTime: "{fromMs}", endTime: "{toMs}", userid: "{userId}", mapType: "GOOGLE", filter: "300" } },
];
let historyWinner = null;
async function loadWinners(env) {
  if (!cmdWinner) { const v = await kvGet(env, "cmdWinner").catch(() => null); if (typeof v === "string") cmdWinner = v; }
  if (!historyWinner) { const v = await kvGet(env, "historyWinner").catch(() => null); if (typeof v === "string") historyWinner = v; }
}
function getHistoryCandidates(env) {
  let list = DEFAULT_HISTORY_CANDIDATES;
  if (env.HISTORY_CANDIDATES) { try { const j = JSON.parse(env.HISTORY_CANDIDATES); if (Array.isArray(j) && j.length) list = j; } catch (e) {} }
  const i = historyWinner ? list.findIndex((c) => c.name === historyWinner) : -1;
  return i > 0 ? [list[i], ...list.slice(0, i), ...list.slice(i + 1)] : list;
}
const fmtLocal = (ms, tz) => new Date(ms + (Number(tz) || 0) * 3600000).toISOString().slice(0, 19).replace("T", " ");
const fmtUtc = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const pick = (o, ...ks) => { for (const k of ks) if (o[k] !== undefined && o[k] !== null && o[k] !== "") return o[k]; return undefined; };

// Ambil daftar baris dari berbagai bentuk balasan (JSONP/JSON; rows|data|records|list; objek atau array+key)
function extractRows(j) {
  if (!j) return [];
  let rows = Array.isArray(j) ? j : pick(j, "rows", "data", "records", "list", "points", "result", "track", "tracks", "details", "items") || [];
  if (rows && !Array.isArray(rows) && typeof rows === "object") rows = pick(rows, "rows", "records", "list", "points") || [];
  if (!Array.isArray(rows)) return [];
  const key = j && !Array.isArray(j) && j.key && typeof j.key === "object" ? j.key : null;
  return rows.map((r) => {
    if (Array.isArray(r) && key) { const o = {}; for (const [n, i] of Object.entries(key)) o[n] = r[i]; return o; }
    return r && typeof r === "object" ? r : null;
  }).filter(Boolean);
}
function normPoint(o, tz) {
  const lat = num(pick(o, "weidu", "lat", "latitude")), lon = num(pick(o, "jingdu", "lng", "lon", "longitude"));
  const gps = pick(o, "gps_time", "gpstime", "gpsTime", "datetime", "dtime", "time", "positionTime", "beginTime", "startTime", "stayTime");
  const up = pick(o, "send_time", "upload_time", "recv_time", "receive_time", "servertime", "heart_time");
  const t = gps !== undefined ? toMs(gps, tz) : 0;
  if (lat === null || lon === null || (lat === 0 && lon === 0) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || !t) return null;
  return {
    t, lat, lon,
    sp: num(pick(o, "sudu", "speed", "su")) || 0,
    hd: num(pick(o, "hangxiang", "course", "direction", "heading")),
    up: up !== undefined ? toMs(up, tz) || null : null,
  };
}
const haversineKm = (a, b) => {
  const R = 6371, rad = Math.PI / 180, dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
// Urutkan menurut waktu GPS ASLI (bukan waktu upload), buang duplikat, tandai titik hasil sinkron offline.
function buildTrack(points, env) {
  const gapMs = (Number(env.HISTORY_GAP_SEC) || 300) * 1000;
  const lateMs = (Number(env.HISTORY_LATE_SEC) || 120) * 1000;
  points.sort((a, b) => a.t - b.t);
  const out = [];
  let km = 0, blind = 0;
  for (const p of points) {
    const prev = out[out.length - 1];
    if (prev && prev.t === p.t && prev.lat === p.lat && prev.lon === p.lon) continue;
    const q = { ...p };
    if (prev) {
      km += haversineKm(prev, q);
      if (q.t - prev.t > gapMs) { q.gap = true; blind++; }
    }
    if (q.up && q.up - q.t > lateMs) q.late = true;
    out.push(q);
  }
  return { points: out, distanceKm: Math.round(km * 100) / 100, blindSpots: blind, lateCount: out.filter((p) => p.late).length };
}
// Satu jendela waktu. Kandidat PERTAMA yang membalas JSON valid (success bukan false) dianggap otoritatif, walau barisnya kosong
// (kendaraan memang diam). Balasan HTML/redirect/bukan-JSON/success:false = kandidat salah, lanjut ke berikutnya.
// Hasil: { pts, cand } atau null bila semua kandidat gagal.
async function queryHistoryWindow(env, s, cands, fromMs, toMs, tries) {
  const tz = env.TIMEZONE || "7";
  const extra = { from: fmtLocal(fromMs, tz), to: fmtLocal(toMs, tz), fromUtc: fmtUtc(fromMs), toUtc: fmtUtc(toMs), fromMs: String(fromMs), toMs: String(toMs) };
  for (const cand of cands) {
    let r;
    try { r = await sendCandidate(env, s, cand, "", extra); } catch (e) { tries.push({ name: cand.name, error: e && e.name === "AbortError" ? "timeout" : String(e) }); continue; }
    const raw = String(r.text || "").trim();
    if (!raw || /^\s*(<!doctype|<html)|<html[\s>]/i.test(raw) || r.httpStatus >= 300) { tries.push({ name: cand.name, status: r.httpStatus, kind: raw ? "html/redirect" : "empty" }); continue; }
    const cb = raw.match(/^[\w$.]+\(([\s\S]*)\)\s*;?\s*$/);
    let j; try { j = JSON.parse(cb ? cb[1] : raw); } catch (e) { tries.push({ name: cand.name, status: r.httpStatus, kind: "bukan-json", snippet: mask(raw).slice(0, 120) }); continue; }
    if (j && (j.success === false || String(j.success).toLowerCase() === "false")) { tries.push({ name: cand.name, kind: "json-fail", snippet: String(j.errorDescribe || j.errorMsg || "").slice(0, 120) }); continue; }
    const pts = extractRows(j).map((o) => normPoint(o, tz)).filter(Boolean);
    tries.push({ name: cand.name, status: r.httpStatus, kind: "json", rows: pts.length });
    return { pts, cand };
  }
  return null;
}

// Rentang panjang dipecah per HISTORY_CHUNK_HOURS (default 6 jam) supaya tidak terpotong batas baris portal.
// Jendela pertama menentukan kandidat pemenang; jendela berikutnya hanya memakai pemenang itu (maks 3 paralel).
async function fetchHistoryPortal(env, s, fromMs, toMs, tries) {
  const chunkMs = Math.max(1, Number(env.HISTORY_CHUNK_HOURS) || 6) * 3600000;
  const wins = [];
  for (let a = fromMs; a < toMs; a += chunkMs) wins.push([a, Math.min(a + chunkMs, toMs)]);
  if (wins.length > 60) throw fail(400, "rentang terlalu panjang untuk ukuran jendela", "bad_range");
  const all = [];
  const first = await queryHistoryWindow(env, s, getHistoryCandidates(env), wins[0][0], wins[0][1], tries);
  if (!first) return null;
  if (historyWinner !== first.cand.name) { historyWinner = first.cand.name; await kvSet(env, "historyWinner", historyWinner).catch(() => {}); }
  all.push(...first.pts);
  const rest = wins.slice(1);
  for (let i = 0; i < rest.length; i += 3) {
    const part = await Promise.all(rest.slice(i, i + 3).map((w) => queryHistoryWindow(env, s, [first.cand], w[0], w[1], tries)));
    for (const x of part) if (x) all.push(...x.pts);
  }
  return all;
}
async function handleHistory(env, u) {
  const now = Date.now();
  const parse = (v, d) => { if (!v) return d; if (/^\d{10,13}$/.test(v)) { const n = Number(v); return n < 1e12 ? n * 1000 : n; } const t = Date.parse(v); return Number.isFinite(t) ? t : d; };
  let toMs = parse(u.searchParams.get("to"), now), fromMs = parse(u.searchParams.get("from"), toMs - 6 * 3600000);
  if (fromMs >= toMs) throw fail(400, "'from' harus lebih awal dari 'to'", "bad_range");
  if (toMs - fromMs > MAX_HISTORY_MS) throw fail(400, "rentang maksimal 7 hari", "bad_range");
  await loadWinners(env);
  const tries = [];
  let points = null, source = "portal";
  try { points = await withSessionHist(env, fromMs, toMs, tries); } catch (e) { tries.push({ name: "session", error: e && e.error ? e.error : String(e) }); }
  const portalCount = points ? points.length : 0;
  // Gabungkan titik rekaman cron (D1): menambal jeda & melengkapi bila portal hanya membalas titik berhenti. Portal diutamakan.
  let localAdded = 0;
  if (env.DB) {
    const rows = (await env.DB.prepare("SELECT t,lat,lon,speed,heading,up FROM positions WHERE t BETWEEN ? AND ? ORDER BY t LIMIT 20000").bind(fromMs, toMs).all().catch(() => ({ results: [] }))).results || [];
    const seen = new Set((points || []).map((p) => Math.round(p.t / 2000)));
    const merged = points ? points.slice() : [];
    for (const r of rows) {
      const k = Math.round(r.t / 2000);
      if (seen.has(k)) continue;
      seen.add(k); localAdded++;
      merged.push({ t: r.t, lat: r.lat, lon: r.lon, sp: r.speed || 0, hd: r.heading, up: r.up });
    }
    points = merged;
  }
  if (portalCount && historyWinner === "GDS-StayDetail") source = localAdded ? "portal-stay+local" : "portal-stay";
  else if (portalCount) source = localAdded ? "portal+local" : "portal";
  else source = "local";
  const track = buildTrack(points || [], env);
  return { ok: true, source, from: fromMs, to: toMs, count: track.points.length, ...track,
    portalPoints: portalCount, localPoints: localAdded, winner: historyWinner,
    note: source.startsWith("portal-stay") ? "Portal hanya membalas StayDetail (titik berhenti), bukan jalur lengkap; jalur ditambal dari rekaman server. Cek ?debug=1." : source === "local" ? "Portal tidak mengembalikan titik untuk rentang ini (atau endpoint playback belum cocok); ini hanya titik rekaman server per menit. Lihat ?debug=1." : undefined,
    tries: u.searchParams.get("debug") === "1" ? tries : undefined };
}
async function withSessionHist(env, fromMs, toMs, tries) {
  let s = await getSession(env, false);
  let pts = await fetchHistoryPortal(env, s, fromMs, toMs, tries);
  if (!pts) { s = await getSession(env, true); pts = await fetchHistoryPortal(env, s, fromMs, toMs, tries); }
  return pts;
}

// ---------- Perintah ----------
const maskCmd = (cmd, env) => { const pw = String((env && env.CMD_PASSWORD) || "123456").replace(/[^0-9A-Za-z]/g, ""); return pw ? cmd.split(pw).join("******") : cmd; };

async function handleCommand(req, env, ctx, who) {
  let payload;
  try { payload = await req.json(); } catch (e) { throw fail(400, "body harus JSON: {action, intervalSeconds?, seconds?}", "bad_body"); }
  const action = payload && payload.action;
  const built = buildCommand(action, action === "record" ? payload.seconds : payload.intervalSeconds, env);
  if (built.error) throw fail(400, built.error, "bad_action");

  // Hanya penahan tap ganda (3 dtk). TIDAK ADA batas kecepatan untuk Putus BBM: dapat dikirim kapan pun.
  const last = env.DB ? await env.DB.prepare("SELECT at FROM command_log ORDER BY id DESC LIMIT 1").first() : null;
  if (last && Date.now() - last.at < 3000) throw fail(429, "terlalu cepat, tunggu beberapa detik sebelum mengirim perintah lagi", "too_fast");

  await loadWinners(env);
  const tries = [];
  let win = null, lastTry = null, sess = await getSession(env, false);
  for (let pass = 0; pass < 2 && !win; pass++) {
    if (pass === 1) {
      try { sess = await getSession(env, true); } catch (e) { tries.push({ name: "relogin", error: e && e.error ? e.error : String(e) }); break; }
    }
    for (const cand of getCandidates(env)) {
      let r;
      try { r = await sendCandidate(env, sess, cand, built.cmd); }
      catch (e) { tries.push({ pass, name: cand.name, error: e && e.name === "AbortError" ? "timeout" : String(e) }); continue; }
      const c = classifyReply(r); // menolak HTML/redirect/kosong/teks gagal => ok:false
      lastTry = { r, c };
      tries.push({ pass, name: cand.name, status: r.httpStatus, kind: c.kind, ok: c.ok, snippet: cleanText(c.text, sess).slice(0, 160) });
      if (c.ok) { win = { cand, r, c }; break; }
    }
  }

  const shown = maskCmd(built.cmd, env);
  const reply = win ? cleanText(win.c.text, sess) : lastTry ? cleanText(lastTry.c.text, sess) : "tidak ada balasan";
  if (env.DB) {
    await env.DB.prepare("INSERT INTO command_log(at,email,action,command,ok,via,reply) VALUES(?,?,?,?,?,?,?)")
      .bind(Date.now(), who.email, action, shown, win ? 1 : 0, win ? win.cand.name : null, reply.slice(0, 300)).run().catch(() => {});
  }

  if (win) {
    if (cmdWinner !== win.cand.name) { cmdWinner = win.cand.name; await kvSet(env, "cmdWinner", cmdWinner).catch(() => {}); }
    posCache = null;
    if (action === "cut_fuel" || action === "restore_fuel") {
      await kvSet(env, "lastCmd", { action, at: Date.now(), by: who.email }).catch(() => {});
      const who8 = who.email.split("@")[0];
      ctx.waitUntil(pushAll(env, {
        kind: "info", tag: "fuel-" + Date.now(), ts: Date.now(), url: "./",
        title: action === "cut_fuel" ? "🔒 BBM diputus" : "🔓 BBM dipulihkan",
        body: `Perintah dikirim oleh ${who8}.`,
      }, { urgency: "high", ttl: 600 }).catch(() => {}));
    }
    return {
      ok: true, action, command: shown, via: win.cand.name, httpStatus: win.r.httpStatus, kind: win.c.kind, confidence: win.c.confidence,
      reply, tries, sentAt: new Date().toISOString(),
      note: win.c.confidence === "strong" ? "Server portal menyatakan perintah diterima. Tracker menjalankannya saat online." : "Balasan tidak berformat baku; belum tentu diterima tracker. Pantau status beberapa detik lagi.",
    };
  }
  return { ok: false, _status: 502, action, command: shown, httpStatus: lastTry ? lastTry.r.httpStatus : null, kind: lastTry ? lastTry.c.kind : "none",
    reply, tries, sentAt: new Date().toISOString(),
    error: "Perintah BELUM diterima server (semua endpoint ditolak/ber-HTML). Status BBM tidak diubah.",
    hint: "Buka portal di browser, kirim perintah, salin URL & kolom form dari DevTools > Network, lalu isi variabel CMD_CANDIDATES." };
}

// ---------- Audio (R2 + D1) ----------
const AUDIO_EXT = { "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/aac": "aac", "audio/wav": "wav", "audio/x-wav": "wav", "audio/webm": "webm", "audio/ogg": "ogg", "audio/amr": "amr", "audio/3gpp": "3gp", "video/webm": "webm", "video/mp4": "m4a" };
async function signedAudioUrl(env, base, id, ttlSec, dl) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const sig = await hmacSign(env, `${id}.${exp}`);
  return `${base}/api/audio/file/${id}?exp=${exp}&sig=${sig}${dl ? "&dl=1" : ""}`;
}
async function audioUpload(req, env, who) {
  if (!env.AUDIO || !env.DB) throw fail(503, "bucket R2 'AUDIO' / D1 belum terhubung", "config");
  const len = Number(req.headers.get("content-length") || 0);
  const ct = req.headers.get("content-type") || "";
  const u = new URL(req.url);
  let body, mime, duration = null, note = "", source = "manual", fname = "";
  if (/^multipart\/form-data/i.test(ct)) {
    if (len > MAX_AUDIO_BYTES + 65536) throw fail(413, "file terlalu besar (maks 25 MB)", "too_big");
    const fd = await req.formData();
    const f = fd.get("file");
    if (!f || typeof f === "string") throw fail(400, "kolom 'file' tidak ada", "bad_body");
    if (f.size > MAX_AUDIO_BYTES) throw fail(413, "file terlalu besar (maks 25 MB)", "too_big");
    mime = (f.type || "audio/mpeg").split(";")[0].toLowerCase();
    body = await f.arrayBuffer();
    duration = num(fd.get("duration")); note = String(fd.get("note") || ""); source = String(fd.get("source") || "manual"); fname = f.name || "";
  } else {
    if (!len) throw fail(411, "Content-Length wajib untuk unggah mentah", "bad_body");
    if (len > MAX_AUDIO_BYTES) throw fail(413, "file terlalu besar (maks 25 MB)", "too_big");
    mime = ct.split(";")[0].trim().toLowerCase();
    body = req.body;
    duration = num(u.searchParams.get("duration")); note = u.searchParams.get("note") || ""; source = u.searchParams.get("source") || "manual";
    fname = req.headers.get("x-filename") || "";
  }
  if (!AUDIO_EXT[mime] && !/^audio\//.test(mime)) throw fail(415, "hanya file audio yang diterima (mime: " + mime + ")", "bad_type");
  const ext = AUDIO_EXT[mime] || (fname.match(/\.(\w{2,4})$/) || [])[1] || "bin";
  const id = crypto.randomUUID().replace(/-/g, "");
  const d = new Date();
  const key = `audio/${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}/${id}.${ext}`;
  const obj = await env.AUDIO.put(key, body, { httpMetadata: { contentType: mime }, customMetadata: { email: who.email } });
  await env.DB.prepare("INSERT INTO audio(id,r2_key,created_at,email,size,mime,duration_sec,note,source) VALUES(?,?,?,?,?,?,?,?,?)")
    .bind(id, key, Date.now(), who.email, obj.size, mime, duration, note.slice(0, 200), source.slice(0, 20)).run();
  return { ok: true, id, size: obj.size };
}
async function audioList(env, base) {
  if (!env.DB) throw fail(503, "D1 belum terhubung", "config");
  const rows = (await env.DB.prepare("SELECT id,created_at,email,size,mime,duration_sec,note,source FROM audio ORDER BY created_at DESC LIMIT 100").all()).results || [];
  const items = await Promise.all(rows.map(async (r) => ({
    id: r.id, createdAt: r.created_at, by: r.email, size: r.size, mime: r.mime, durationSec: r.duration_sec, note: r.note, source: r.source,
    url: await signedAudioUrl(env, base, r.id, 3600, false), downloadUrl: await signedAudioUrl(env, base, r.id, 3600, true),
  })));
  return { ok: true, count: items.length, items };
}
async function audioFile(req, env, u, id) {
  const exp = Number(u.searchParams.get("exp")), sig = u.searchParams.get("sig") || "";
  if (!exp || exp < Date.now() / 1000 || !(await hmacVerify(env, `${id}.${exp}`, sig))) return new Response("link audio kedaluwarsa atau tidak valid", { status: 403 });
  const row = await env.DB.prepare("SELECT r2_key,mime,created_at FROM audio WHERE id=?").bind(id).first();
  if (!row) return new Response("tidak ditemukan", { status: 404 });
  let obj;
  try { obj = await env.AUDIO.get(row.r2_key, { range: req.headers }); } catch (e) { obj = await env.AUDIO.get(row.r2_key); }
  if (!obj) return new Response("file hilang dari R2", { status: 404 });
  const h = new Headers();
  obj.writeHttpMetadata(h);
  h.set("etag", obj.httpEtag);
  h.set("accept-ranges", "bytes");
  h.set("cache-control", "private, max-age=300");
  if (u.searchParams.get("dl") === "1") {
    const ext = (row.r2_key.match(/\.(\w+)$/) || [])[1] || "bin";
    h.set("content-disposition", `attachment; filename="rekaman-${new Date(row.created_at).toISOString().slice(0, 19).replace(/[:T]/g, "-")}.${ext}"`);
  }
  let status = 200;
  if (obj.range) {
    const off = obj.range.offset !== undefined ? obj.range.offset : obj.size - obj.range.suffix;
    const length = obj.range.length !== undefined ? obj.range.length : obj.size - off;
    h.set("content-range", `bytes ${off}-${off + length - 1}/${obj.size}`);
    h.set("content-length", String(length));
    status = 206;
  } else h.set("content-length", String(obj.size));
  return new Response(obj.body, { status, headers: h });
}

// ---------- Push: pendaftaran perangkat ----------
async function pushSubscribe(req, env, who) {
  const b = await req.json().catch(() => null);
  const s = b && b.subscription;
  if (!s || !/^https:\/\//.test(s.endpoint || "") || !s.keys || !s.keys.p256dh || !s.keys.auth) throw fail(400, "subscription tidak valid", "bad_body");
  if (b64uDec(s.keys.p256dh).length !== 65 || b64uDec(s.keys.auth).length < 16) throw fail(400, "kunci subscription tidak valid", "bad_body");
  await env.DB.prepare("INSERT INTO push_subs(endpoint,email,p256dh,auth,label,ua,created_at,fail_count) VALUES(?,?,?,?,?,?,?,0) ON CONFLICT(endpoint) DO UPDATE SET email=excluded.email,p256dh=excluded.p256dh,auth=excluded.auth,label=excluded.label,ua=excluded.ua,fail_count=0")
    .bind(s.endpoint, who.email, s.keys.p256dh, s.keys.auth, String(b.label || "").slice(0, 40), String(req.headers.get("user-agent") || "").slice(0, 160), Date.now()).run();
  // batasi 8 perangkat per akun (yang terlama dibuang)
  await env.DB.prepare("DELETE FROM push_subs WHERE email=? AND endpoint NOT IN (SELECT endpoint FROM push_subs WHERE email=? ORDER BY created_at DESC LIMIT 8)").bind(who.email, who.email).run();
  const n = await env.DB.prepare("SELECT COUNT(*) c FROM push_subs").first();
  return { ok: true, devices: n ? n.c : 1 };
}

// ---------- CRON: pantau SOS tiap menit walau aplikasi tertutup ----------
async function cronTick(env) {
  if (!env.DB) return;
  const maxAge = (Number(env.ALERT_MAX_AGE_MIN) || 15) * 60000;
  const sosTypes = new Set(numList(env.SOS_TYPE_IDS || "1"));
  const alertTypes = new Set(numList(env.ALERT_TYPE_IDS === undefined ? "5,23,38,48" : env.ALERT_TYPE_IDS));
  TZ_OFFSET_DEFAULT = Number(env.TIMEZONE) || 7;

  let pos, al, err = null;
  try {
    pos = await getPos(env, { fresh: true });
    al = await getAlarms(env, { fresh: true });
    if (!pos.ok && !al.ok) err = (pos.error || pos.step || "gagal") + " / " + (al.error || al.step || "gagal");
  } catch (e) { err = e && e.error ? e.error : String(e); }

  // Pemantauan sendiri: bila gagal 10 menit beruntun, beri tahu pemilik sekali
  const health = (await kvGet(env, "cronHealth")) || { fails: 0, warned: false };
  if (err) {
    health.fails++;
    if (health.fails >= 10 && !health.warned) {
      health.warned = true;
      await pushOwners(env, { kind: "info", tag: "monitor-down", ts: Date.now(), url: "./", title: "⚠️ Pemantauan SOS terganggu", body: String(err).slice(0, 120) }, { urgency: "high", ttl: 3600 }).catch(() => {});
    }
    await kvSet(env, "cronHealth", health);
    return;
  }
  if (health.fails || health.warned) await kvSet(env, "cronHealth", { fails: 0, warned: false });

  if (pos.ok) await savePosition(env, pos).catch(() => {});
  // Tiap 5 menit: tarik data buffer portal 30 menit terakhir (titik yang diunggah tracker terlambat setelah blind spot) ke D1.
  // Hanya bila endpoint playback sudah terbukti (historyWinner dari /api/history) dan bukan StayDetail yang jarang titiknya.
  if (new Date().getUTCMinutes() % 5 === 0) await backfillHistory(env).catch((e) => console.error("backfill", e && e.error ? e.error : String(e)));

  const hits = [];
  if (al.ok) {
    for (const r of al.rows) {
      const isSos = sosTypes.has(r.typeId), isAlert = alertTypes.has(r.typeId);
      if (!isSos && !isAlert) continue;
      const id = "a:" + String(r.id !== undefined && r.id !== null ? r.id : `${r.typeId}:${r.gpsMs || r.sendMs}`);
      if (!(await markSeen(env, id))) continue;
      const t = r.sendMs || r.gpsMs;
      if (t && Date.now() - t <= maxAge) hits.push({ ...r, isSos });
    }
  }
  // Cadangan: bendera SOS pada data posisi (bila daftar alarm belum memuatnya)
  if (pos.ok && pos.isSos && pos.positionMs && Date.now() - pos.positionMs <= maxAge && !hits.some((h) => h.isSos)) {
    if (await markSeen(env, "p:" + pos.positionMs)) hits.push({ isSos: true, typeId: 1, id: "p" + pos.positionMs, name: pos.name, lat: pos.lat, lon: pos.lon, speed: pos.speed, gpsMs: pos.positionMs });
  }
  // SOS dulu; satu notifikasi per kejadian (maks 3 per menit supaya tidak membanjiri)
  hits.sort((a, b) => (b.isSos ? 1 : 0) - (a.isSos ? 1 : 0));
  for (const h of hits.slice(0, 3)) {
    const payload = sosPayload(h, pos.ok ? pos : null);
    const res = await pushAll(env, payload, { urgency: "high", ttl: h.isSos ? 6 * 3600 : 3600 });
    const nat = await pushNativeSos(env, h, pos.ok ? pos : null).catch((e) => ({ ok: false, error: String(e) }));
    console.log("push", payload.kind, JSON.stringify(res), "native", JSON.stringify(nat));
  }

  if (new Date().getUTCMinutes() === 0) { // bersih-bersih tiap jam
    const day = 24 * 3600 * 1000, now = Date.now();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM positions WHERE t < ?").bind(now - 30 * day),
      env.DB.prepare("DELETE FROM alarm_seen WHERE seen_at < ?").bind(now - 60 * day),
      env.DB.prepare("DELETE FROM command_log WHERE at < ?").bind(now - 180 * day),
      env.DB.prepare("DELETE FROM push_subs WHERE fail_count >= 20"),
    ]).catch(() => {});
  }
}

async function backfillHistory(env) {
  await loadWinners(env);
  if (!historyWinner || historyWinner === "GDS-StayDetail") return;
  const cand = getHistoryCandidates(env).find((c) => c.name === historyWinner);
  if (!cand) return;
  const tz = env.TIMEZONE || "7", now = Date.now(), tries = [];
  let s = await getSession(env, false);
  let res = await queryHistoryWindow(env, s, [cand], now - 30 * 60000, now, tries);
  if (!res) { s = await getSession(env, true); res = await queryHistoryWindow(env, s, [cand], now - 30 * 60000, now, tries); }
  if (!res || !res.pts.length) return;
  const stmt = env.DB.prepare("INSERT OR IGNORE INTO positions(t,lat,lon,speed,heading,up) VALUES(?,?,?,?,?,?)");
  await env.DB.batch(res.pts.slice(0, 500).map((p) => stmt.bind(p.t, p.lat, p.lon, p.sp || 0, p.hd === null || p.hd === undefined ? null : p.hd, p.up || now)));
  void tz;
}

// ---------- Router ----------
export default {
  async fetch(req, env, ctx) {
    // Layer CCTV publik: data terbuka, CORS "*" (sengaja di depan pemeriksaan ALLOW_ORIGIN). Kunci Windy hanya ada di Worker.
    if (new URL(req.url).pathname === "/api/cctv") {
      if (req.method === "OPTIONS") return cctvPreflight();
      if (req.method === "GET") {
        try { return await handleCctv(req, env, ctx); }
        catch (e) { return new Response(JSON.stringify({ ok: false, error: "CCTV gagal: " + (e && e.message || e) }), { status: 502, headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" } }); }
      }
    }
    if (req.method === "OPTIONS") return preflight(env);
    const u = new URL(req.url);
    const origin = req.headers.get("origin");
    curOrigin = origin;
    TZ_OFFSET_DEFAULT = Number(env.TIMEZONE) || 7;
    if (env.ALLOW_ORIGIN && origin && corsOrigin(env) !== origin) return json({ ok: false, error: "forbidden origin" }, 403, env);
    const path = u.pathname;

    try {
      // --- rute publik ---
      // Data terbuka BMKG (cuaca, gempa, peringatan dini): publik, di-cache di Worker.
      if (path === "/api/bmkg" && req.method === "GET") return handleBmkg(req, env, ctx, {
        "access-control-allow-origin": corsOrigin(env), "access-control-allow-methods": "GET, POST, DELETE, OPTIONS", vary: "Origin",
      });
      if (path === "/api/health") return json({ ok: true, time: Date.now(), d1: !!env.DB, r2: !!env.AUDIO, google: !!env.GOOGLE_CLIENT_ID, totp: !!(await getTotpSecret(env)), vapid: !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) }, 200, env);
      if (path === "/api/push/vapid-key") return json({ ok: true, key: env.VAPID_PUBLIC_KEY || null }, 200, env);
      if (path === "/api/auth/session" && req.method === "POST") {
        const b = await req.json().catch(() => ({}));
        const g = await verifyGoogle(env, b.credential);
        const who = grant(env, g.email, "google");
        const exp = Math.floor(Date.now() / 1000) + SESSION_TOKEN_TTL;
        return json({ ok: true, token: await signSession(env, who.email, who.role), exp, email: who.email, name: g.name, role: who.role }, 200, env);
      }
      if (path === "/api/auth/totp-setup" && req.method === "POST") {
        const b = await req.json().catch(() => ({}));
        return json(await totpSetup(req, env, b.password), 200, env);
      }
      if (path === "/api/auth/totp" && req.method === "POST") {
        const b = await req.json().catch(() => ({}));
        await totpAttempt(req, env, b.code, "login");
        const exp = Math.floor(Date.now() / 1000) + SESSION_TOKEN_TTL;
        return json({ ok: true, token: await signSession(env, TOTP_ID, "owner"), exp, email: TOTP_ID, name: "Authenticator", role: "owner" }, 200, env);
      }
      const af = path.match(/^\/api\/audio\/file\/([0-9a-f]{32})$/);
      if (af && (req.method === "GET" || req.method === "HEAD")) return await audioFile(req, env, u, af[1]);

      // --- rute berotorisasi ---
      const who = await authenticate(req, env, u, path);
      const isOwner = who.role === "owner";
      const mayCommand = isOwner || (who.role === "family" && env.FAMILY_CAN_COMMAND !== "0");

      if (path === "/api/me") return json({ ok: true, email: who.email, role: who.role, via: who.via }, 200, env);
      if (path === "/api/config") {
        return json({ ok: true, email: who.email, role: who.role, canCommand: mayCommand, simNumber: env.SIM_NUMBER || "", imeiTail: String(env.IMEI || DEFAULT_IMEI).slice(-4),
          intervalMin: INTERVAL_MIN, intervalMax: INTERVAL_MAX, audioEnabled: !!env.AUDIO, pushEnabled: !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY), tz: Number(env.TIMEZONE) || 7 }, 200, env);
      }

      if (path === "/api/sync" || path === "/pos") {
        const raw = u.searchParams.get("raw") === "1" && isOwner;
        const fresh = u.searchParams.get("fresh") === "1";
        const pos = await getPos(env, { fresh });
        if (path === "/pos") return json(pos.ok ? shape(pos, raw) : pos, pos.ok ? 200 : 502, env);
        const al = await getAlarms(env, { fresh }).catch((e) => ({ ok: false, error: String(e) }));
        return json({
          ok: pos.ok || al.ok, serverTime: Date.now(),
          pos: pos.ok ? shape(pos, raw) : null, posError: pos.ok ? null : { step: pos.step, error: pos.error },
          alarms: al.ok ? al.rows.slice(0, 40) : [], alarmsError: al.ok ? null : { step: al.step, error: al.error },
          relay: pos.ok ? { fuelCut: pos.fuelCut, source: pos.fuelCutSource } : null, sos: !!(pos.ok && pos.isSos),
        }, 200, env);
      }
      if (path === "/alarms") {
        const al = await getAlarms(env, {});
        return json(al, al.ok ? 200 : 502, env);
      }
      if (path === "/info") {
        const r = await withSession(env, (s) => fetchLoadUser(env, s).catch((e) => ({ ok: false, step: "info", error: String(e) })));
        if (!r.ok) return json({ ok: false, step: r.step, error: r.error }, 502, env);
        const safe = {};
        for (const [k, v] of Object.entries(r.fields || {})) { if (!/pass|pwd|token|mds|cookie|secret|key/i.test(k)) safe[k] = v; }
        return json({ ok: true, fetchedAt: r.fetchedAt, fields: safe }, 200, env);
      }

      if (path === "/api/history") {
        if (req.method !== "GET") throw fail(405, "gunakan GET", "method");
        return json(await handleHistory(env, u), 200, env);
      }

      if (path === "/api/command") {
        if (req.method !== "POST") throw fail(405, "gunakan POST", "method");
        // Perintah wajib memakai ID token Google yang diverifikasi pada permintaan ini (bukan token sesi / kunci API).
        // Perintah: (a) Google ID token segar, ATAU (b) sesi Authenticator + kode 6 digit BARU di header x-totp (sekali pakai).
        if (who.via !== "google") {
          if (who.totp) await totpAttempt(req, env, req.headers.get("x-totp"), "command");
          else throw fail(401, "perintah wajib memakai Google ID token atau kode Authenticator", "need_google_token");
        }
        if (!mayCommand) throw fail(403, "akun ini tidak diizinkan mengirim perintah", "forbidden_role");
        const out = await handleCommand(req, env, ctx, who);
        const st = out._status || 200; delete out._status;
        return json(out, st, env);
      }
      if (path === "/api/commands") {
        const rows = env.DB ? (await env.DB.prepare("SELECT at,email,action,command,ok,via FROM command_log ORDER BY id DESC LIMIT 20").all()).results || [] : [];
        return json({ ok: true, rows }, 200, env);
      }

      if (path === "/api/push/subscribe" && req.method === "POST") return json(await pushSubscribe(req, env, who), 200, env);
      if (path === "/api/push/unsubscribe" && req.method === "POST") {
        const b = await req.json().catch(() => ({}));
        if (b.endpoint) await env.DB.prepare("DELETE FROM push_subs WHERE endpoint=? AND email=?").bind(b.endpoint, who.email).run();
        return json({ ok: true }, 200, env);
      }
      if (path === "/api/push/test" && req.method === "POST") {
        const r = await pushEmail(env, who.email, { kind: "test", tag: "test", ts: Date.now(), url: "./", title: "✅ Notifikasi aktif", body: "Tes berhasil. SOS akan masuk seperti ini, walau aplikasi tertutup." }, { urgency: "high", ttl: 300 });
        return json({ ok: r.sent > 0, ...r }, r.sent > 0 ? 200 : 502, env);
      }
      if (path === "/api/push/list") {
        const rows = (await env.DB.prepare("SELECT email,label,created_at,last_ok,fail_count FROM push_subs ORDER BY email,created_at DESC").all()).results || [];
        return json({ ok: true, rows: isOwner ? rows : rows.filter((r) => r.email === who.email) }, 200, env);
      }

      if (path === "/api/audio/upload" && req.method === "POST") return json(await audioUpload(req, env, who), 200, env);
      if (path === "/api/audio/list") return json(await audioList(env, u.origin), 200, env);
      const ad = path.match(/^\/api\/audio\/([0-9a-f]{32})$/);
      if (ad && req.method === "DELETE") {
        if (!isOwner) throw fail(403, "hanya pemilik yang boleh menghapus rekaman", "forbidden_role");
        const row = await env.DB.prepare("SELECT r2_key FROM audio WHERE id=?").bind(ad[1]).first();
        if (row) { await env.AUDIO.delete(row.r2_key); await env.DB.prepare("DELETE FROM audio WHERE id=?").bind(ad[1]).run(); }
        return json({ ok: true }, 200, env);
      }

      if (path === "/debug") {
        if (!isOwner) throw fail(403, "hanya pemilik", "forbidden_role");
        const out = { ok: false, userIdSet: !!env.USER_ID, accountSet: !!env.ACCOUNT, passwordSet: !!env.PASSWORD, d1: !!env.DB, r2: !!env.AUDIO };
        out.portal = await probePortal();
        try {
          const s = await getSession(env, true, true);
          out.loginOk = true; out.ok = true; out.hasCookie = !!s.cookie; out.hasMds = !!s.mds; out.hasSessionId = /ASP\.NET_SessionId=/.test(s.cookie || ""); out.hasDomainIndex = /domainIndex=1/.test(s.cookie || "");
          out.pos = await fetchAny(env, s).then((r) => (r.ok ? { ok: true, lat: r.lat, lon: r.lon, time: r.positionTime } : r)).catch((e) => ({ error: String(e) }));
        } catch (e) { out.loginOk = false; out.loginError = e && e.step ? e : { error: String(e) }; }
        out.commandCandidates = getCandidates(env).map((c) => `${c.method || "POST"} ${c.path}`);
        out.historyCandidates = getHistoryCandidates(env).map((c) => `${c.method || "POST"} ${c.path}?method=${(c.query || {}).method || ""}`);
        await loadWinners(env);
        out.commandWinner = cmdWinner; out.historyWinner = historyWinner; out.nativePushConfigured = !!(env.SOS_PUSH_URL && env.SOS_PUSH_KEY);
        out.cron = await kvGet(env, "cronHealth");
        return json(out, 200, env);
      }

      return json({ ok: false, error: "not found" }, 404, env);
    } catch (e) {
      if (e && e.httpStatus) return json({ ok: false, error: e.error, code: e.code, ...(e.hint ? { hint: e.hint } : {}) }, e.httpStatus, env);
      return json({ ok: false, ...(e && e.step ? e : { error: String(e) }) }, 502, env);
    }
  },

  // Cron Trigger: tiap menit (lihat [triggers] di wrangler.toml)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(cronTick(env).catch((e) => console.error("cron error", e && e.error ? e.error : String(e))));
  },
};
