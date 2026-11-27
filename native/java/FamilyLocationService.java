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
        lastWrite = now;
        final Location l = loc;
        io.execute(() -> { try { write(l); } catch (Exception ignored) {} });
    }

    private void write(Location l) throws Exception {
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
        double kmh = l.hasSpeed() ? l.getSpeed() * 3.6 : 0;
        String mode = kmh < 3 ? "diam" : kmh < 8 ? "jalan" : kmh < 22 ? "sepeda" : "kendara";

        JSONObject f = new JSONObject();
        f.put("name", str(p.getString("name", "Anggota"))).put("color", str(p.getString("color", "#6D4AFF")))
         .put("sharing", new JSONObject().put("booleanValue", true))
         .put("lat", dbl(l.getLatitude())).put("lng", dbl(l.getLongitude()))
         .put("accuracy", new JSONObject().put("integerValue", String.valueOf(Math.round(l.getAccuracy()))))
         .put("speedKmh", new JSONObject().put("integerValue", String.valueOf(Math.round(kmh))))
         .put("mode", str(mode)).put("modeSince", new JSONObject().put("integerValue", String.valueOf(System.currentTimeMillis())))
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
        io.shutdown();
        super.onDestroy();
    }
}
