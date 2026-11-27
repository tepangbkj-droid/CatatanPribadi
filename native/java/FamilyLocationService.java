package id.bukukas.app;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Bundle;
import android.os.IBinder;
import android.os.Looper;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Layanan foreground: terus mengirim lokasi ke dokumen bukukas_shared/{keluarga}/locations/{uid}
 * lewat Firestore REST, walau aplikasi digeser dari layar (WebView mati). Aturan Firestore tetap berlaku
 * karena memakai ID token Firebase milik pengguna (di-refresh dari refresh token terenkripsi).
 */
public class FamilyLocationService extends Service implements LocationListener {
    private static final String CH = "family_loc";
    private static final int NID = 4412;
    private static final long MIN_WRITE_MS = 15_000, JS_ALIVE_MS = 90_000;
    private LocationManager lm;
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private volatile long lastWrite = 0;
    private String idToken = ""; private long idExp = 0;

    @Override public IBinder onBind(Intent i) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (!Store.on(this) || !hasPerm()) { stopSelf(); return START_NOT_STICKY; }
        startFg();
        mh.removeCallbacks(idleTick); mh.postDelayed(idleTick, 60_000);
        try {
            if (lm == null) lm = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
            lm.removeUpdates(this);
            if (lm.isProviderEnabled(LocationManager.GPS_PROVIDER)) lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, 15_000, 10f, this, Looper.getMainLooper());
            if (lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) lm.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 30_000, 25f, this, Looper.getMainLooper());
        } catch (SecurityException e) { stopSelf(); }
        return START_STICKY;
    }

    private boolean hasPerm() {
        return ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
            || ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private void startFg() {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CH) == null) {
            NotificationChannel ch = new NotificationChannel(CH, "Berbagi lokasi keluarga", NotificationManager.IMPORTANCE_LOW);
            nm.createNotificationChannel(ch);
        }
        Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification n = new NotificationCompat.Builder(this, CH).setSmallIcon(getApplicationInfo().icon)
            .setContentTitle("Buku Kas — berbagi lokasi").setContentText("Lokasimu dibagikan ke keluarga.")
            .setOngoing(true).setContentIntent(pi).setPriority(NotificationCompat.PRIORITY_LOW).build();
        if (Build.VERSION.SDK_INT >= 29) startForeground(NID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
        else startForeground(NID, n);
    }

    @Override
    public void onLocationChanged(Location loc) {
        long now = System.currentTimeMillis();
        if (now - lastWrite < MIN_WRITE_MS) return;
        try {
            long hb = Store.prefs(this).getLong("hb", 0);
            if (now - hb < JS_ALIVE_MS) return;          // aplikasi (JS) masih hidup dan menulis sendiri
        } catch (Exception ignored) {}
        if (loc.getAccuracy() > 150f) return;
        lastLoc = loc; lastFixAt = now; modeStep(loc.hasSpeed() ? loc.getSpeed() * 3.6 : 0, now);
        tripStep(loc, now);
        lastWrite = now;
        final Location l = loc;
        io.execute(() -> { try { write(l, false); } catch (Exception ignored) {} });
    }

    // ---- Riwayat perjalanan saat aplikasi mati (aturan sama dengan index.html: >=150 m, >=90 dtk, diam 3 mnt = selesai) ----
    private static final long TRIP_END_MS = 3 * 60_000, TRIP_GAP_MS = 8 * 60_000;
    private final android.os.Handler mh = new android.os.Handler(Looper.getMainLooper());
    private final Runnable endCheck = () -> { if (tpts != null && System.currentTimeMillis() - tMove >= TRIP_END_MS) endTrip(); };
    private double[] anchor;                        // {lat, lng, t} titik diam terakhir
    private java.util.ArrayList<double[]> tpts;     // {lat, lng, t}
    private double tDist, tMax; private long tStart, tMove;

    private static double dist(double a1, double o1, double a2, double o2) {
        float[] r = new float[1]; Location.distanceBetween(a1, o1, a2, o2, r); return r[0];
    }

    private void tripStep(Location l, long now) {
        if (l.getAccuracy() > 80f) return;
        double la = l.getLatitude(), lo = l.getLongitude(), v = l.hasSpeed() ? l.getSpeed() : 0;
        if (tpts != null) {
            double[] last = tpts.get(tpts.size() - 1);
            if (now - (long) last[2] > TRIP_GAP_MS || now - tMove >= TRIP_END_MS) { endTrip(); anchor = new double[]{ la, lo, now }; return; }
            double d = dist(last[0], last[1], la, lo);
            if (d >= 15 || now - (long) last[2] >= 30_000) { tpts.add(new double[]{ la, lo, now }); if (d >= 15) tDist += d; }
            tMax = Math.max(tMax, v);
            if (v >= 0.8 || d >= 25) tMove = now;
            mh.removeCallbacks(endCheck); mh.postDelayed(endCheck, TRIP_END_MS + 10_000);
            return;
        }
        if (anchor == null) { anchor = new double[]{ la, lo, now }; return; }
        double d = dist(anchor[0], anchor[1], la, lo);
        if (d >= 80 || (v >= 1.1 && d >= 30)) {
            tpts = new java.util.ArrayList<>(); tpts.add(anchor); tpts.add(new double[]{ la, lo, now });
            tStart = (long) anchor[2]; tDist = d; tMax = v; tMove = now;
            mh.removeCallbacks(endCheck); mh.postDelayed(endCheck, TRIP_END_MS + 10_000);
        } else if (d < 30) { anchor = new double[]{ la, lo, now }; }
    }

    private void endTrip() {
        mh.removeCallbacks(endCheck);
        final java.util.ArrayList<double[]> pts = tpts; final double dd = tDist, mx = tMax; final long st = tStart;
        tpts = null; anchor = null;
        if (pts == null || pts.size() < 2) return;
        final long en = (long) pts.get(pts.size() - 1)[2];
        if (dd < 150 || en - st < 90_000) return;
        io.execute(() -> { try { saveTrip(pts, dd, mx, st, en); } catch (Exception ignored) {} });
    }

    private void saveTrip(java.util.List<double[]> in, double dd, double mx, long st, long en) throws Exception {
        SharedPreferences p = Store.prefs(this);
        String pid = p.getString("pid", ""), fid = p.getString("fid", ""), uid = p.getString("uid", "");
        if (pid.isEmpty() || fid.isEmpty() || uid.isEmpty()) return;
        String tok = token(p);
        if (tok == null) return;
        java.util.List<double[]> pts = in;
        if (in.size() > 250) {
            int step = (int) Math.ceil(in.size() / 250.0);
            pts = new java.util.ArrayList<>();
            for (int i = 0; i < in.size(); i++) if (i % step == 0 || i == in.size() - 1) pts.add(in.get(i));
        }
        JSONArray flat = new JSONArray(), ts = new JSONArray();
        for (double[] q : pts) {
            flat.put(dbl(Math.round(q[0] * 1e5) / 1e5)); flat.put(dbl(Math.round(q[1] * 1e5) / 1e5));
            ts.put(lng(Math.max(0, Math.round((q[2] - st) / 1000.0))));
        }
        double avg = dd / Math.max((en - st) / 1000.0, 1);
        String mode = avg < 2.3 ? "jalan" : avg < 6 ? "sepeda" : "kendara";
        JSONObject nul = new JSONObject().put("nullValue", JSONObject.NULL);
        JSONObject f = new JSONObject();
        f.put("name", str(p.getString("name", "Anggota"))).put("mode", str(mode))
         .put("startAt", lng(st)).put("endAt", lng(en)).put("dist", lng(Math.round(dd)))
         .put("maxKmh", lng(Math.round(mx * 3.6))).put("avgKmh", lng(Math.round(avg * 3.6)))
         .put("pts", new JSONObject().put("arrayValue", new JSONObject().put("values", flat)))
         .put("ts", new JSONObject().put("arrayValue", new JSONObject().put("values", ts)))
         .put("startPlace", nul).put("endPlace", nul).put("startName", nul).put("endName", nul);
        String docName = "projects/" + pid + "/databases/(default)/documents/bukukas_shared/" + fid + "/locations/" + uid + "/trips/t" + st;
        JSONObject w = new JSONObject().put("update", new JSONObject().put("name", docName).put("fields", f));
        JSONObject body = new JSONObject().put("writes", new JSONArray().put(w));
        int code = post("https://firestore.googleapis.com/v1/projects/" + pid + "/databases/(default)/documents:commit", body.toString(), "Bearer " + tok, "application/json").first;
        if (code == 401 || code == 403) idExp = 0;
    }
    private static JSONObject lng(long v) throws Exception { return new JSONObject().put("integerValue", String.valueOf(v)); }

    // ---- Mode gerak & lama di tempat (benar walau aplikasi mati) ----
    private volatile String curMode = "diam"; private volatile long modeSince = 0;
    private String candMode = ""; private int candN = 0;
    private Location lastLoc; private long lastFixAt = 0;
    private final Runnable idleTick = new Runnable() { @Override public void run() { try { idle(); } catch (Exception ignored) {} mh.postDelayed(this, 60_000); } };

    private static String classify(double kmh) { return kmh < 3 ? "diam" : kmh < 8 ? "jalan" : kmh < 22 ? "sepeda" : "kendara"; }

    private void modeStep(double kmh, long now) {
        String m = classify(kmh);
        if (modeSince == 0) { curMode = m; modeSince = now; return; }
        if (m.equals(curMode)) { candN = 0; return; }
        if (m.equals(candMode)) candN++; else { candMode = m; candN = 1; }
        if (candN >= 2) { curMode = m; modeSince = now; candN = 0; }
    }

    /** GPS tidak mengirim update saat diam (min jarak 10 m): tandai "diam" sejak fix terakhir + segarkan dokumen berkala. */
    private void idle() {
        long now = System.currentTimeMillis();
        if (lastLoc == null || now - lastFixAt < 75_000) return;
        try { if (now - Store.prefs(this).getLong("hb", 0) < JS_ALIVE_MS) return; } catch (Exception ignored) {}
        boolean flipped = false;
        if (!curMode.equals("diam")) { curMode = "diam"; modeSince = lastFixAt; candN = 0; flipped = true; }
        if (!flipped && now - lastWrite < 110_000) return;
        lastWrite = now;
        final Location l = lastLoc;
        io.execute(() -> { try { write(l, true); } catch (Exception ignored) {} });
    }

    private void write(Location l, boolean idle) throws Exception {
        SharedPreferences p = Store.prefs(this);
        String pid = p.getString("pid", ""), fid = p.getString("fid", ""), uid = p.getString("uid", "");
        if (pid.isEmpty() || fid.isEmpty() || uid.isEmpty()) return;
        String tok = token(p);
        if (tok == null) return;
        BatteryManager bm = (BatteryManager) getSystemService(BATTERY_SERVICE);
        Intent bi = registerReceiver(null, new android.content.IntentFilter(Intent.ACTION_BATTERY_CHANGED));
        int bat = bm != null ? bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY) : -1;
        int st = bi != null ? bi.getIntExtra(BatteryManager.EXTRA_STATUS, -1) : -1;
        boolean charging = st == BatteryManager.BATTERY_STATUS_CHARGING || st == BatteryManager.BATTERY_STATUS_FULL;
        double kmh = idle ? 0 : (l.hasSpeed() ? l.getSpeed() * 3.6 : 0);
        String mode = curMode;
        long since = modeSince > 0 ? modeSince : System.currentTimeMillis();

        JSONObject f = new JSONObject();
        f.put("name", str(p.getString("name", "Anggota"))).put("color", str(p.getString("color", "#6D4AFF")))
         .put("sharing", new JSONObject().put("booleanValue", true))
         .put("lat", dbl(l.getLatitude())).put("lng", dbl(l.getLongitude()))
         .put("accuracy", new JSONObject().put("integerValue", String.valueOf(Math.round(l.getAccuracy()))))
         .put("speedKmh", new JSONObject().put("integerValue", String.valueOf(Math.round(kmh))))
         .put("mode", str(mode)).put("modeSince", new JSONObject().put("integerValue", String.valueOf(since)))
         .put("charging", new JSONObject().put("booleanValue", charging));
        if (bat >= 0) f.put("battery", new JSONObject().put("integerValue", String.valueOf(bat)));
        JSONArray paths = new JSONArray();
        for (java.util.Iterator<String> it = f.keys(); it.hasNext(); ) paths.put(it.next());
        String docName = "projects/" + pid + "/databases/(default)/documents/bukukas_shared/" + fid + "/locations/" + uid;
        JSONObject w = new JSONObject()
            .put("update", new JSONObject().put("name", docName).put("fields", f))
            .put("updateMask", new JSONObject().put("fieldPaths", paths))
            .put("updateTransforms", new JSONArray().put(new JSONObject().put("fieldPath", "updatedAt").put("setToServerValue", "REQUEST_TIME")));
        JSONObject body = new JSONObject().put("writes", new JSONArray().put(w));
        int code = post("https://firestore.googleapis.com/v1/projects/" + pid + "/databases/(default)/documents:commit", body.toString(), "Bearer " + tok, "application/json").first;
        if (code == 401 || code == 403) idExp = 0;     // paksa token baru di percobaan berikut
    }

    private String token(SharedPreferences p) throws Exception {
        if (!idToken.isEmpty() && idExp - System.currentTimeMillis() > 120_000) return idToken;
        String rt = p.getString("rt", ""), key = p.getString("apiKey", "");
        if (rt.isEmpty() || key.isEmpty()) return null;
        String form = "grant_type=refresh_token&refresh_token=" + java.net.URLEncoder.encode(rt, "UTF-8");
        Pair r = post("https://securetoken.googleapis.com/v1/token?key=" + java.net.URLEncoder.encode(key, "UTF-8"), form, null, "application/x-www-form-urlencoded");
        if (r.first < 200 || r.first >= 300) return null;
        JSONObject j = new JSONObject(r.second);
        idToken = j.optString("id_token", "");
        idExp = System.currentTimeMillis() + j.optLong("expires_in", 3600) * 1000;
        String newRt = j.optString("refresh_token", "");
        if (!newRt.isEmpty() && !newRt.equals(rt)) p.edit().putString("rt", newRt).apply();
        return idToken.isEmpty() ? null : idToken;
    }

    private static final class Pair { final int first; final String second; Pair(int a, String b) { first = a; second = b; } }

    private Pair post(String url, String body, String auth, String ctype) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setRequestMethod("POST"); c.setConnectTimeout(10_000); c.setReadTimeout(15_000); c.setDoOutput(true);
        c.setRequestProperty("Content-Type", ctype);
        if (auth != null) c.setRequestProperty("Authorization", auth);
        try (OutputStream os = c.getOutputStream()) { os.write(body.getBytes(StandardCharsets.UTF_8)); }
        int code = c.getResponseCode();
        java.io.InputStream is = code >= 400 ? c.getErrorStream() : c.getInputStream();
        String txt = "";
        if (is != null) { java.util.Scanner s = new java.util.Scanner(is, "UTF-8").useDelimiter("\\A"); txt = s.hasNext() ? s.next() : ""; }
        c.disconnect();
        return new Pair(code, txt);
    }

    private static JSONObject str(String v) throws Exception { return new JSONObject().put("stringValue", v); }
    private static JSONObject dbl(double v) throws Exception { return new JSONObject().put("doubleValue", v); }

    @Override public void onStatusChanged(String p, int s, Bundle e) {}
    @Override public void onProviderEnabled(String p) {}
    @Override public void onProviderDisabled(String p) {}

    @Override
    public void onTaskRemoved(Intent rootIntent) { /* sengaja kosong: layanan tetap berjalan setelah app digeser */ }

    @Override
    public void onDestroy() {
        try { if (lm != null) lm.removeUpdates(this); } catch (Exception ignored) {}
        if (tpts != null) endTrip();
        mh.removeCallbacks(idleTick);
        io.shutdown();
        super.onDestroy();
    }
}
