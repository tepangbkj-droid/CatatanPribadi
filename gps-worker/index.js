// Cloudflare Worker: login otomatis ke portal Cantrack, ambil posisi GPS, sajikan sebagai JSON bersih.
// BELUM DIUJI terhadap portal sungguhan: gunakan /debug untuk melihat hasil login (data sensitif disamarkan).
//
// Secrets/Variables (Settings > Variables and Secrets), JANGAN ditulis di kode:
//   ACCOUNT    akun login portal (userName)
//   PASSWORD   password akun
//   USER_ID    ID perangkat di portal (objectid)
//   APP_KEY    kata sandi buatanmu sendiri; aplikasi mengirimnya lewat header x-api-key
//   SCHOOL_ID, CUSTID (opsional) isi hanya jika /pos gagal; default memakai login_id dari login
//   LOGIN_TYPE (opsional) kosong = coba ENTERPRISE lalu USER otomatis; isi hanya untuk memaksa salah satunya
//   PWD_MODE   (opsional) kosong = password dikirim apa adanya (sesuai form portal); "md5" = md5(md5(pwd)); "auto" = coba keduanya
//   TIMEZONE   (opsional) default 7
//   ALLOW_ORIGIN (opsional) alamat aplikasimu untuk CORS (diisi otomatis dari wrangler.toml)
//
//   CANTRACK_BASE_URL (opsional) default https://www.cantrackportal.com ; IMEI (opsional) default 868720062744036
//   CMD_PASSWORD (opsional) sandi perintah tracker, default 123456
//
// Endpoint:  POST /api/command  (kirim perintah: cut_fuel | restore_fuel | set_interval)
//            /pos  (posisi, dipakai aplikasi Buku Kas)   /pos?raw=1  (plus semua field mentah)   /debug  (tes login)
// Deploy otomatis lewat GitHub Actions: lihat .github/workflows/deploy-gps-worker.yml

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
      "access-control-allow-headers": "x-api-key, content-type",
      "access-control-allow-methods": "GET, POST, OPTIONS",
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
      "access-control-allow-headers": "x-api-key, content-type",
      "access-control-allow-methods": "GET, POST, OPTIONS",
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

  const mds =
    (hay.match(/[?&]mds=([0-9a-f]{32})/i) || hay.match(/mds\s*=\s*['"]([0-9a-f]{32})['"]/i) || [])[1];
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
    } catch (e) {}
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

  return { mds, loginId, cookie, at: Date.now() };
}

async function getSession(env, force, bypassFail) {
  if (!force && session && Date.now() - session.at < SESSION_TTL) return session;
  session = await login(env, bypassFail);
  return session;
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
let lastCmd = null;      // { action, at } perintah BBM terakhir yang sukses dikirim (cadangan penanda relay)
let lastCmdSentAt = 0;   // mencegah kirim ganda akibat tap beruntun

// action -> string perintah standar. Mengembalikan { cmd } atau { error }.
function buildCommand(action, intervalSeconds, env) {
  const pw = String((env && env.CMD_PASSWORD) || "123456").replace(/[^0-9A-Za-z]/g, "");
  if (action === "cut_fuel") return { cmd: `DYD,${pw}#` };
  if (action === "restore_fuel") return { cmd: `HFYD,${pw}#` };
  if (action === "set_interval") {
    const n = Number(intervalSeconds);
    if (!Number.isInteger(n)) return { error: "intervalSeconds harus bilangan bulat" };
    if (n < INTERVAL_MIN) return { error: `intervalSeconds minimal ${INTERVAL_MIN} detik` };
    if (n > INTERVAL_MAX) return { error: `intervalSeconds maksimal ${INTERVAL_MAX} detik` };
    return { cmd: `TIMER,${pw},${n}#` };
  }
  return { error: "action tidak dikenal (pakai cut_fuel | restore_fuel | set_interval)" };
}

// Kirim ke GetDateServices.asmx/SendCommands. Token mds hanya dipakai di sini dan TIDAK pernah dikembalikan.
async function postCommand(env, s, cmd) {
  const base = String(env.CANTRACK_BASE_URL || PORTAL).replace(/\/+$/, "");
  const body = new URLSearchParams({
    macid: String(env.IMEI || DEFAULT_IMEI).trim(),
    cmd,
    pwd: "",
    mds: s.mds,
  });
  const headers = {
    "content-type": "application/x-www-form-urlencoded",
    "user-agent": UA,
    accept: "*/*",
    origin: base,
    referer: `${base}/user/main.html`,
  };
  if (s.cookie) headers.cookie = s.cookie;
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), 20000);
  try {
    const res = await fetch(`${base}/GetDateServices.asmx/SendCommands`, { method: "POST", headers, body, signal: ctl.signal });
    const text = await res.text().catch(() => "");
    return { httpStatus: res.status, httpOk: res.ok, text };
  } finally {
    clearTimeout(to);
  }
}

// Hilangkan pembungkus XML (<string ...>isi</string>) agar balasan mudah dibaca, lalu buang token sesi jika ikut terpantul.
function cleanReply(text, s) {
  let t = String(text || "");
  const x = t.match(/<string[^>]*>([\s\S]*?)<\/string>/i);
  if (x) t = x[1];
  if (s && s.mds) t = t.split(s.mds).join("<mds>");
  return t.trim().slice(0, 2000);
}

// Balasan dianggap gagal bila HTTP bukan 2xx atau teksnya memuat kata gagal/sesi habis.
function replyLooksFailed(r) {
  if (!r.httpOk) return true;
  return /"?success"?\s*[:=]\s*"?false|"?errorCode"?\s*[:=]\s*"?[1-9]|fail|error|gagal|invalid|expired|not\s*login|offline|timeout|失败|离线|超时/i.test(r.text);
}
function replyLooksSessionExpired(r) {
  return r.httpStatus === 401 || r.httpStatus === 403 || /mds|login|session|expired|未登录|登录/i.test(r.text);
}

async function handleCommand(req, env) {
  let payload;
  try { payload = await req.json(); } catch (e) { return json({ ok: false, error: "body harus JSON: {action, intervalSeconds?}" }, 400, env); }
  const action = payload && payload.action;
  const built = buildCommand(action, payload && payload.intervalSeconds, env);
  if (built.error) return json({ ok: false, error: built.error }, 400, env);

  const now = Date.now();
  if (now - lastCmdSentAt < 3000) return json({ ok: false, error: "terlalu cepat, tunggu beberapa detik sebelum mengirim perintah lagi" }, 429, env);
  lastCmdSentAt = now;

  let sess = await getSession(env, false);
  let r = await postCommand(env, sess, built.cmd);
  if (replyLooksFailed(r) && replyLooksSessionExpired(r)) {
    // sesi mds mungkin kedaluwarsa: login ulang lalu kirim sekali lagi
    sess = await getSession(env, true);
    r = await postCommand(env, sess, built.cmd);
  }
  const ok = !replyLooksFailed(r);
  if (ok && (action === "cut_fuel" || action === "restore_fuel")) lastCmd = { action, at: Date.now() };
  return json({
    ok,
    action,
    command: built.cmd,
    httpStatus: r.httpStatus,
    reply: cleanReply(r.text, sess), // teks balasan asli CantrackPortal (untuk debugging)
    sentAt: new Date().toISOString(),
    note: ok ? "Perintah diteruskan ke server. Tracker baru menjalankannya saat online; cek balasan/status beberapa detik lagi." : "Server menolak atau balasannya terlihat gagal; lihat field reply.",
  }, ok ? 200 : 502, env);
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

function detectFlags(out) {
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

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return preflight(env);
    const u = new URL(req.url);

    // Bila ALLOW_ORIGIN diisi, tolak permintaan browser dari alamat lain
    const origin = req.headers.get("origin");
    curOrigin = origin;
    if (env.ALLOW_ORIGIN && origin && corsOrigin(env) !== origin) {
      return json({ ok: false, error: "forbidden origin" }, 403, env);
    }

    // Kunci boleh lewat header x-api-key, atau ?key=... (praktis untuk tes di browser HP)
    const sentKey = req.headers.get("x-api-key") || u.searchParams.get("key");
    if (!env.APP_KEY || sentKey !== env.APP_KEY) {
      return json({ ok: false, error: "unauthorized" }, 401, env);
    }

    const path = u.pathname;
    const raw = u.searchParams.get("raw") === "1";

    try {
      if (path === "/api/command") {
        if (req.method !== "POST") return json({ ok: false, error: "gunakan POST" }, 405, env);
        return await handleCommand(req, env);
      }

      if (path === "/debug") {
        // Selalu balas 200 berisi diagnosis lengkap (token disamarkan), supaya mudah dibaca/dibagikan.
        const out = { ok: false, userIdSet: !!env.USER_ID, accountSet: !!env.ACCOUNT, passwordSet: !!env.PASSWORD };
        out.portal = await probePortal();
        try {
          const s = await getSession(env, true, true);
          out.loginOk = true; out.ok = true; out.hasCookie = !!s.cookie;
          out.pos = await fetchAny(env, s).then((r) => (r.ok ? { ok: true, lat: r.lat, lon: r.lon, time: r.positionTime } : r)).catch((e) => ({ error: String(e) }));
        } catch (e) {
          out.loginOk = false; out.loginError = e && e.step ? e : { error: String(e) };
        }
        out.official = await fetchOfficial(env).then((r) => (r.ok ? { ok: true, lat: r.lat, lon: r.lon } : r)).catch((e) => ({ error: String(e) }));
        return json(out, 200, env);
      }

      if (path === "/info") {
        // Info perangkat dari portal (loadUser). Kunci yang mirip rahasia dibuang.
        let sess = await getSession(env, false);
        let r = await fetchLoadUser(env, sess).catch((e) => ({ ok: false, step: "info", error: String(e) }));
        if (!r.ok) {
          sess = await getSession(env, true);
          r = await fetchLoadUser(env, sess).catch((e) => ({ ok: false, step: "info", error: String(e) }));
        }
        if (!r.ok) return json({ ok: false, step: r.step, error: r.error }, 502, env);
        const safe = {};
        for (const [k, v] of Object.entries(r.fields || {})) {
          if (/pass|pwd|token|mds|cookie|secret|key/i.test(k)) continue;
          safe[k] = v;
        }
        return json({ ok: true, fetchedAt: r.fetchedAt, fields: safe }, 200, env);
      }

      if (path === "/alarms") {
        if (alarmCache && Date.now() - alarmCache.at < 8000) return json({ ...alarmCache.out, cached: true }, 200, env);
        let sess = await getSession(env, false);
        let out = await fetchAlarms(env, sess).catch((e) => ({ ok: false, step: "alarms", error: String(e) }));
        if (!out.ok) {
          sess = await getSession(env, true);
          out = await fetchAlarms(env, sess).catch((e) => ({ ok: false, step: "alarms", error: String(e) }));
        }
        if (out.ok) alarmCache = { at: Date.now(), out };
        return json(out, out.ok ? 200 : 502, env);
      }

      if (path === "/pos") {
        if (!env.USER_ID) return json({ ok: false, error: "USER_ID belum diisi" }, 400, env);
        const fresh = u.searchParams.get("fresh") === "1"; // tombol "Segarkan": lewati cache + login ulang
        if (!fresh && posCache && Date.now() - posCache.at < POS_CACHE_MS) {
          return json(shape({ ...posCache.out, ...detectFlags(posCache.out), cached: true }, raw), 200, env);
        }
        let out;
        try {
          let s = await getSession(env, fresh);
          out = await fetchAny(env, s);
          if (!out.ok) {
            // sesi mungkin kedaluwarsa: login ulang sekali lalu coba lagi
            s = await getSession(env, true);
            out = await fetchAny(env, s);
          }
        } catch (e) {
          // login portal gagal: coba API resmi sebagai cadangan
          const alt = await fetchOfficial(env).catch(() => null);
          if (alt && alt.ok) out = alt; else throw e;
        }
        if (out.ok) { Object.assign(out, detectFlags(out)); posCache = { at: Date.now(), out }; }
        return json(out.ok ? shape(out, raw) : out, out.ok ? 200 : 502, env);
      }

      return json({ ok: false, error: "not found" }, 404, env);
    } catch (e) {
      return json({ ok: false, ...(e && e.step ? e : { error: String(e) }) }, 502, env);
    }
  },
};
