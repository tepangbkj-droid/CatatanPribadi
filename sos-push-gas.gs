/**
 * Google Apps Script: kirim push SOS (FCM) ke semua HP anggota, walau app tertutup.
 * Pengganti sos-push-worker.js (Cloudflare) untuk SOS_PUSH_URL berbentuk script.google.com.
 *
 * SETUP (sekali saja):
 * 1. script.google.com > Proyek baru > tempel seluruh kode ini > simpan.
 * 2. Project Settings (ikon roda gigi) > Script properties > tambahkan:
 *      FIREBASE_PROJECT_ID = catatanpribadi-e0aca
 *      SA_CLIENT_EMAIL     = client_email dari file service account (JSON)
 *      SA_PRIVATE_KEY      = private_key dari file yang sama (seluruh isi, termasuk BEGIN/END)
 *      APP_KEY             = (opsional) kunci server-ke-server untuk worker GPS. JANGAN ditaruh di index.html
 *    (Service account: Firebase Console > Project settings > Service accounts > Generate new private key.
 *     Pastikan perannya boleh Firebase Cloud Messaging & baca Firestore, mis. "Firebase Admin SDK".)
 * 3. Deploy > New deployment > jenis "Web app" > Execute as: Me, Who has access: Anyone > Deploy.
 *    Setiap mengubah kode: Deploy > Manage deployments > edit > Version baru. URL /exec tetap sama.
 * 4. Tes: pilih fungsi tesPush di editor lalu Run (lihat Execution log).
 */
function prop_(k) { return PropertiesService.getScriptProperties().getProperty(k) || ''; }
function b64u_(s) { return Utilities.base64EncodeWebSafe(s).replace(/=+$/, ''); }

function accessToken_() {
  var now = Math.floor(Date.now() / 1000);
  var head = b64u_(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  var claim = b64u_(JSON.stringify({
    iss: prop_('SA_CLIENT_EMAIL'),
    scope: 'https://www.googleapis.com/auth/firebase.messaging https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600
  }));
  var key = prop_('SA_PRIVATE_KEY').replace(/\\n/g, '\n');
  var sig = Utilities.base64EncodeWebSafe(Utilities.computeRsaSha256Signature(head + '.' + claim, key)).replace(/=+$/, '');
  var r = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'post', muteHttpExceptions: true,
    payload: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: head + '.' + claim + '.' + sig }
  });
  var j = JSON.parse(r.getContentText());
  if (!j.access_token) throw new Error('gagal ambil access token: ' + r.getContentText());
  return j.access_token;
}

function kirimSos_(body, serverCall) {
  var pid = prop_('FIREBASE_PROJECT_ID');
  var token = accessToken_();
  var auth = { Authorization: 'Bearer ' + token };
  var name = String(body.name || 'Anggota').slice(0, 30);
  var fid = String(body.familyId || (serverCall ? 'main' : ''));
  if (!/^[a-z0-9]{3,40}$/.test(fid)) return { error: 'bad family' };
  var senderId = String(body.senderId || '');
  if (!serverCall) {   // pengirim harus anggota: baca dokumen anggotanya dengan token pengguna sendiri
    var tok = String(body.idToken || ''), uid = '';
    try { uid = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(tok.split('.')[1] + '==')).getDataAsString()).user_id || ''; } catch (e) {}
    if (!tok || !/^[A-Za-z0-9]{10,64}$/.test(uid)) return { error: 'unauthorized' };
    var mr = UrlFetchApp.fetch('https://firestore.googleapis.com/v1/projects/' + pid + '/databases/(default)/documents/bukukas_shared/' + fid + '/members/' + uid, { headers: { Authorization: 'Bearer ' + tok }, muteHttpExceptions: true });
    if (mr.getResponseCode() !== 200) return { error: 'unauthorized' };
    senderId = uid;
  }
  var base = 'https://firestore.googleapis.com/v1/projects/' + pid + '/databases/(default)/documents/bukukas_shared/' + fid + '/fcm';
  var lr = UrlFetchApp.fetch(base + '?pageSize=300', { headers: auth, muteHttpExceptions: true });
  var lj = JSON.parse(lr.getContentText());
  var targets = (lj.documents || []).map(function (d) {
    return { id: d.name.split('/').pop(), token: d.fields && d.fields.token && d.fields.token.stringValue };
  }).filter(function (t) { return t.token && t.id !== senderId; });

  var reqs = targets.map(function (t) {
    return {
      url: 'https://fcm.googleapis.com/v1/projects/' + pid + '/messages:send',
      method: 'post', contentType: 'application/json', headers: auth, muteHttpExceptions: true,
      payload: JSON.stringify({ message: {
        token: t.token,
        notification: { title: '🆘 SOS dari ' + name + '!', body: body.repeat ? 'SOS masih aktif — ketuk untuk melihat lokasi.' : 'Ketuk untuk melihat lokasi dan membantu.' },
        data: { type: 'sos', name: name, senderId: senderId, lat: String(body.lat == null ? '' : body.lat), lng: String(body.lng == null ? '' : body.lng), repeat: String(!!body.repeat) },
        android: { priority: 'HIGH', ttl: '120s', notification: { channel_id: 'sos', sound: 'default', default_vibrate_timings: true, notification_priority: 'PRIORITY_MAX', visibility: 'PUBLIC', tag: 'sos-' + senderId } }
      } })
    };
  });
  var sent = 0, errors = [];
  if (reqs.length) {
    var res = UrlFetchApp.fetchAll(reqs);
    res.forEach(function (r, i) {
      if (r.getResponseCode() === 200) { sent++; return; }
      var txt = r.getContentText();
      errors.push(txt.slice(0, 160));
      if (/UNREGISTERED|NOT_FOUND|INVALID_ARGUMENT/.test(txt)) {   // token mati → bersihkan
        UrlFetchApp.fetch(base + '/' + encodeURIComponent(targets[i].id), { method: 'delete', headers: auth, muteHttpExceptions: true });
      }
    });
  }
  return { ok: true, targets: targets.length, sent: sent, errors: errors.slice(0, 3) };
}

function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

// Dipanggil app (POST text/plain berisi JSON + key)
function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var serverCall = !!prop_('APP_KEY') && body.key === prop_('APP_KEY');
    return json_(kirimSos_(body, serverCall));
  } catch (err) { return json_({ error: String(err && err.message || err) }); }
}

// Buka URL /exec di browser: harus tampil {"ok":true,"service":"sos-push"}
function doGet() { return json_({ ok: true, service: 'sos-push', configured: !!(prop_('SA_CLIENT_EMAIL') && prop_('SA_PRIVATE_KEY') && prop_('FIREBASE_PROJECT_ID')) }); }

// Jalankan manual dari editor untuk tes (tidak butuh app)
function tesPush() {
  Logger.log(JSON.stringify(kirimSos_({ name: 'Tes', senderId: 'tes-manual', familyId: 'main', lat: null, lng: null, repeat: false }, true)));
}
