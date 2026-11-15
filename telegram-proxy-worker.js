// Cloudflare Worker: menyembunyikan token bot Telegram dari kode web.
// Environment (Settings → Variables, jadikan Secret): BOT_TOKEN, CHAT_ID, APP_KEY
// Variable biasa: ALLOW_ORIGIN = https://tepangbkj-droid.github.io
const ALLOWED = new Set(['sendMessage','sendLocation','editMessageLiveLocation','stopMessageLiveLocation','sendVideo','sendDocument']);

export default {
  async fetch(req, env) {
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOW_ORIGIN,
      'Access-Control-Allow-Headers': 'Content-Type, X-App-Key',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Vary': 'Origin'
    };
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: cors });
    if ((req.headers.get('Origin') || '') !== env.ALLOW_ORIGIN) return new Response('Forbidden', { status: 403, headers: cors });
    if (req.headers.get('X-App-Key') !== env.APP_KEY) return new Response('Unauthorized', { status: 401, headers: cors });

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
