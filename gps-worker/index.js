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
//   PWD_MODE   (opsional) kosong = coba md5(md5(pwd)) lalu teks biasa; isi "md5" atau "plain" untuk memaksa
//   TIMEZONE   (opsional) default 7
//   ALLOW_ORIGIN (opsional) alamat aplikasimu untuk CORS (diisi otomatis dari wrangler.toml)
//
// Endpoint:  /pos  (posisi, dipakai aplikasi Buku Kas)   /pos?raw=1  (plus semua field mentah)   /debug  (tes login)
// Deploy otomatis lewat GitHub Actions: lihat .github/workflows/deploy-gps-worker.yml

const PORTAL = "https://www.cantrackportal.com";
const UA =
  "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36";
const SESSION_TTL = 10 * 60 * 1000; // login ulang tiap 10 menit

let session = null; // { mds, loginId, cookie, at }

function json(body, status, env) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": (env && env.ALLOW_ORIGIN) || "*",
      "access-control-allow-headers": "x-api-key",
      "access-control-allow-methods": "GET, OPTIONS",
      vary: "Origin",
    },
  });
}

// Preflight CORS: status 204 TIDAK boleh punya body (kalau ada, Worker error dan browser memblokir)
function preflight(env) {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": (env && env.ALLOW_ORIGIN) || "*",
      "access-control-allow-headers": "x-api-key",
      "access-control-allow-methods": "GET, OPTIONS",
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

// Tanpa LOGIN_TYPE / PWD_MODE: coba semua kombinasi (jenis login x bentuk password) sampai ada yang berhasil.
async function login(env) {
  const pwd = String(env.PASSWORD || "").trim();
  const types = env.LOGIN_TYPE ? [env.LOGIN_TYPE] : ["ENTERPRISE", "USER"];
  const modes = env.PWD_MODE === "plain" ? ["plain"] : env.PWD_MODE === "md5" ? ["md5"] : ["md5", "plain"];
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
      return s;
    } catch (e) {
      if (!e || e.step !== "login") throw e;
      if (!first) first = e;
    }
  }
  throw { ...first, tried: combos.map((c) => c.join("+")) };
}

async function loginWith(env, loginType, pwdValue) {
  if (!env.ACCOUNT || !env.PASSWORD) throw { step: "config", error: "ACCOUNT/PASSWORD belum diisi" };

  const body = new URLSearchParams({
    userName: String(env.ACCOUNT).trim(),
    pwd: pwdValue,
    loginType,
    loginUrl: PORTAL + "/",
    timeZone: env.TIMEZONE || "7",
    language: "en",
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
  const loginId =
    (hay.match(/login_id=([0-9a-f-]{36})/i) || hay.match(/custid=([0-9a-f-]{36})/i) || [])[1];

  let cookie = cookiesFrom(res, "");

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

async function getSession(env, force) {
  if (!force && session && Date.now() - session.at < SESSION_TTL) return session;
  session = await login(env);
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
async function fetchAny(env, s) {
  const a = await fetchLoadUser(env, s).catch((e) => ({ ok: false, step: "loadUser", error: String(e) }));
  if (a.ok) return a;
  const b = await fetchPos(env, s);
  return b.ok ? b : { ...b, loadUserError: a.error || a.step };
}

let posCache = null; // { at, out }  cache 15 dtk supaya beberapa HP keluarga tidak membebani portal
const POS_CACHE_MS = 15 * 1000;

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
    if (env.ALLOW_ORIGIN && origin && origin !== env.ALLOW_ORIGIN) {
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
      if (path === "/debug") {
        // Tes login saja. Tidak menampilkan token.
        const s = await getSession(env, true);
        return json({ ok: true, loginOk: true, hasCookie: !!s.cookie, userIdSet: !!env.USER_ID }, 200, env);
      }

      if (path === "/pos") {
        if (!env.USER_ID) return json({ ok: false, error: "USER_ID belum diisi" }, 400, env);
        if (posCache && Date.now() - posCache.at < POS_CACHE_MS) {
          return json(shape({ ...posCache.out, cached: true }, raw), 200, env);
        }
        let s = await getSession(env, false);
        let out = await fetchAny(env, s);
        if (!out.ok) {
          // sesi mungkin kedaluwarsa: login ulang sekali lalu coba lagi
          s = await getSession(env, true);
          out = await fetchAny(env, s);
        }
        if (out.ok) posCache = { at: Date.now(), out };
        return json(out.ok ? shape(out, raw) : out, out.ok ? 200 : 502, env);
      }

      return json({ ok: false, error: "not found" }, 404, env);
    } catch (e) {
      return json({ ok: false, ...(e && e.step ? e : { error: String(e) }) }, 502, env);
    }
  },
};
