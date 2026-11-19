// Cloudflare Worker: login otomatis ke portal Cantrack, ambil posisi GPS, sajikan sebagai JSON bersih.
// BELUM DIUJI terhadap portal sungguhan: gunakan /debug untuk melihat hasil login (data sensitif disamarkan).
//
// Secrets/Variables (Settings > Variables and Secrets), JANGAN ditulis di kode:
//   ACCOUNT    akun login portal (userName)
//   PASSWORD   password akun
//   USER_ID    ID perangkat di portal (objectid)
//   APP_KEY    kata sandi buatanmu sendiri; aplikasi mengirimnya lewat header x-api-key
//   SCHOOL_ID, CUSTID (opsional) isi hanya jika /pos gagal; default memakai login_id dari login
//   LOGIN_TYPE (opsional) ENTERPRISE untuk login akun (default), USER untuk login IMEI/plat
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

async function login(env) {
  if (!env.ACCOUNT || !env.PASSWORD) throw { step: "config", error: "ACCOUNT/PASSWORD belum diisi" };

  const body = new URLSearchParams({
    userName: env.ACCOUNT,
    pwd: env.PASSWORD, // portal mengirim password apa adanya (setPwdValue dikomentari di core-51.js)
    loginType: env.LOGIN_TYPE || "ENTERPRISE",
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
    user_id: env.USER_ID,
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
        let out = await fetchPos(env, s);
        if (!out.ok) {
          // sesi mungkin kedaluwarsa: login ulang sekali lalu coba lagi
          s = await getSession(env, true);
          out = await fetchPos(env, s);
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
