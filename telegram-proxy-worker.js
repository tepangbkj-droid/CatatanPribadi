// Cloudflare Worker: menyembunyikan token bot Telegram dari kode web.
// Otorisasi: token login Google/Firebase milik pengguna (header Authorization: Bearer <idToken>) + X-Family.
// Worker memastikan pengguna adalah ANGGOTA keluarga itu dengan membaca dokumen anggotanya lewat Firestore REST
// memakai token pengguna sendiri (Aturan Firestore yang memutuskan). Tidak ada kunci statis di kode web.
// Secret : BOT_TOKEN, CHAT_ID
// Variabel: ALLOW_ORIGIN (https://tepangbkj-droid.github.io), FIREBASE_PROJECT_ID, FAMILY_ID (ID keluarga yang boleh memakai grup Telegram ini; "main" untuk data lama)
const ALLOWED = new Set(['sendMessage','sendLocation','editMessageLiveLocation','stopMessageLiveLocation','sendVideo','sendDocument']);
const MAX_BYTES = 20 * 1024 * 1024;

async function isMember(req, env) {
  const tok = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const fid = req.headers.get('X-Family') || '';
  if (!tok || !/^[a-z0-9]{3,40}$/.test(fid) || fid !== env.FAMILY_ID) return false;
  let uid;
  try { uid = JSON.parse(atob(tok.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).user_id; } catch (e) { return false; }
  if (!uid || !/^[A-Za-z0-9]{10,64}$/.test(uid)) return false;
  const r = await fetch(`https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/bukukas_shared/${fid}/members/${uid}`,
    { headers: { Authorization: 'Bearer ' + tok } });
  return r.ok;
}

export default {
  async fetch(req, env) {
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOW_ORIGIN,
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Family',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Vary': 'Origin'
    };
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: cors });
    if ((req.headers.get('Origin') || '') !== env.ALLOW_ORIGIN) return new Response('Forbidden', { status: 403, headers: cors });
    if (Number(req.headers.get('Content-Length') || 0) > MAX_BYTES) return new Response('Too large', { status: 413, headers: cors });
    if (!(await isMember(req, env))) return new Response('Unauthorized', { status: 401, headers: cors });

    const method = new URL(req.url).pathname.replace(/^\//, '');
    if (!ALLOWED.has(method)) return new Response('Not found', { status: 404, headers: cors });

    const ct = req.headers.get('Content-Type') || '';
    let body, headers = {};
    if (ct.includes('application/json')) {
      const j = await req.json();
      j.chat_id = env.CHAT_ID;               // tujuan dikunci di server
      body = JSON.stringify(j); headers['Content-Type'] = 'application/json';
    } else {
      const fd = await req.formData();
      fd.set('chat_id', env.CHAT_ID);
      body = fd;
    }
    const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, { method: 'POST', headers, body });
    return new Response(r.body, { status: r.status, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
};
