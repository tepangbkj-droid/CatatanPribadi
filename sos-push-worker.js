// Cloudflare Worker: kirim notifikasi push SOS (FCM) ke semua HP anggota, walau app tertutup.
// Variables/Secrets (Cloudflare → Worker → Settings → Variables):
//   FIREBASE_PROJECT_ID   = catatanpribadi-e0aca
//   SA_CLIENT_EMAIL       = client_email dari file service account (JSON)
//   SA_PRIVATE_KEY        = private_key dari file service account (Secret)
//   APP_KEY               = (opsional) kunci server-ke-server untuk worker GPS (SOS_PUSH_KEY di gps-worker). TIDAK dipakai di index.html
//   ALLOW_ORIGIN          = https://tepangbkj-droid.github.io
const enc = new TextEncoder();
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
function pemToBuf(pem) {
  const b = atob(pem.replace(/-----[^-]+-----/g, '').replace(/\s/g, ''));
  const u = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
  return u.buffer;
}
async function accessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claim = b64url(enc.encode(JSON.stringify({
    iss: env.SA_CLIENT_EMAIL,
    scope: 'https://www.googleapis.com/auth/firebase.messaging https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600
  })));
  const key = await crypto.subtle.importKey('pkcs8', pemToBuf(env.SA_PRIVATE_KEY.replace(/\\n/g, '\n')),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = b64url(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(head + '.' + claim)));
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: head + '.' + claim + '.' + sig })
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('gagal ambil access token: ' + JSON.stringify(j));
  return j.access_token;
}

export default {
  async fetch(req, env) {
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOW_ORIGIN,
      'Access-Control-Allow-Headers': 'Content-Type, X-App-Key, Authorization',
      'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Vary': 'Origin'
    };
    const reply = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (req.method !== 'POST' || new URL(req.url).pathname !== '/sos') return reply({ error: 'not found' }, 404);
    const serverCall = !!env.APP_KEY && (req.headers.get('X-App-Key') || '') === env.APP_KEY;   // worker GPS (tanpa Origin)
    if (!serverCall && (req.headers.get('Origin') || '') !== env.ALLOW_ORIGIN) return reply({ error: 'forbidden' }, 403);
    let body; try { body = JSON.parse(await req.text()); } catch (e) { return reply({ error: 'bad json' }, 400); }
    const fid = serverCall ? String(body.familyId || 'main') : String(body.familyId || '');
    if (!/^[a-z0-9]{3,40}$/.test(fid)) return reply({ error: 'bad family' }, 400);
    let uid = '';
    if (!serverCall) {
      // Pengirim harus anggota keluarga: baca dokumen anggotanya memakai token pengguna sendiri
      const tok = String(body.idToken || '');
      try { uid = JSON.parse(atob(tok.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).user_id || ''; } catch (e) {}
      if (!tok || !/^[A-Za-z0-9]{10,64}$/.test(uid)) return reply({ error: 'unauthorized' }, 401);
      const mr = await fetch(`https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/bukukas_shared/${fid}/members/${uid}`, { headers: { Authorization: 'Bearer ' + tok } });
      if (!mr.ok) return reply({ error: 'unauthorized' }, 401);
    }
    const name = String(body.name || 'Anggota').slice(0, 30);
    const senderId = serverCall ? String(body.senderId || '') : uid;
    const pid = env.FIREBASE_PROJECT_ID;
    const token = await accessToken(env);
    const auth = { Authorization: 'Bearer ' + token };

    // ambil semua token perangkat anggota
    const base = `https://firestore.googleapis.com/v1/projects/${pid}/databases/(default)/documents/bukukas_shared/${fid}/fcm`;
    const lr = await fetch(base + '?pageSize=300', { headers: auth });
    const lj = await lr.json();
    const targets = (lj.documents || []).map(d => ({
      id: d.name.split('/').pop(), token: d.fields && d.fields.token && d.fields.token.stringValue
    })).filter(t => t.token && t.id !== senderId);

    let sent = 0;
    await Promise.all(targets.map(async (t) => {
      const msg = {
        message: {
          token: t.token,
          notification: { title: `🆘 SOS dari ${name}!`, body: body.repeat ? 'SOS masih aktif — ketuk untuk melihat lokasi.' : 'Ketuk untuk melihat lokasi dan membantu.' },
          data: { type: 'sos', name, senderId, lat: String(body.lat ?? ''), lng: String(body.lng ?? ''), repeat: String(!!body.repeat) },
          android: {
            priority: 'HIGH', ttl: '120s',
            notification: { channel_id: 'sos', sound: 'default', default_vibrate_timings: true, notification_priority: 'PRIORITY_MAX', visibility: 'PUBLIC', tag: 'sos-' + senderId }
          }
        }
      };
      const r = await fetch(`https://fcm.googleapis.com/v1/projects/${pid}/messages:send`, {
        method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(msg)
      });
      if (r.ok) { sent++; return; }
      const t2 = await r.text();
      if (/UNREGISTERED|NOT_FOUND|INVALID_ARGUMENT/.test(t2)) {          // token mati → bersihkan
        await fetch(`${base}/${encodeURIComponent(t.id)}`, { method: 'DELETE', headers: auth });
      }
    }));
    return reply({ ok: true, targets: targets.length, sent });
  }
};
