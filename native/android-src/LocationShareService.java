package id.bukukas.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Bundle;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/** Layanan foreground: terus membagikan lokasi ke Firestore walau app digeser dari layar. */
public class LocationShareService extends Service implements LocationListener {
    static final String TAG = "FamilyLoc";
    static final String PREFS = "famloc";
    static final String CH_ID = "famloc_sharing";
    static final int NOTIF_ID = 4417;

    public interface FixListener { void onFix(double lat, double lng, float acc, float speed, long time); }

    public static volatile FixListener fixListener = null;
    public static volatile long lastJsWrite = 0;
    public static volatile boolean running = false;

    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final AtomicBoolean writing = new AtomicBoolean(false);
    private long lastGpsAt = 0, lastWriteAt = 0, modeSince = 0;
    private Location lastWritten = null, prevLoc = null;
    private double speedSm = 0;
    private String mode = "diam";
    private String tok = null;
    private long tokExp = 0;

    private SharedPreferences prefs() { return getSharedPreferences(PREFS, Context.MODE_PRIVATE); }

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        createChannel();
        Notification n = buildNotification();
        try {
            if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
            else startForeground(NOTIF_ID, n);
        } catch (Throwable t) {
            Log.e(TAG, "startForeground gagal", t);
            stopSelf();
            return START_NOT_STICKY;
        }
        if (!prefs().getBoolean("enabled", false)) { stopSelf(); return START_NOT_STICKY; }
        modeSince = System.currentTimeMillis();
        startUpdates();
        running = true;
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        stopUpdates();
        running = false;
        io.shutdown();
        super.onDestroy();
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        NotificationChannel ch = new NotificationChannel(CH_ID, "Berbagi lokasi", NotificationManager.IMPORTANCE_LOW);
        ch.setDescription("Menandakan lokasimu sedang dibagikan ke peta keluarga");
        nm.createNotificationChannel(ch);
    }

    private Notification buildNotification() {
        Intent li = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent pi = PendingIntent.getActivity(this, 0, li, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CH_ID) : new Notification.Builder(this);
        b.setContentTitle("Buku Kas — berbagi lokasi")
                .setContentText("Lokasimu dibagikan ke peta keluarga. Ketuk untuk membuka.")
                .setSmallIcon(android.R.drawable.ic_menu_mylocation)
                .setOngoing(true)
                .setContentIntent(pi);
        if (Build.VERSION.SDK_INT >= 31) b.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE);
        return b.build();
    }

    private void startUpdates() {
        LocationManager lm = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        if (lm == null) return;
        stopUpdates();
        try {
            if (lm.isProviderEnabled(LocationManager.GPS_PROVIDER))
                lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, 5000L, 5f, this, Looper.getMainLooper());
            if (lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER))
                lm.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 15000L, 20f, this, Looper.getMainLooper());
        } catch (SecurityException e) {
            Log.w(TAG, "izin lokasi belum diberikan", e);
        }
    }

    private void stopUpdates() {
        LocationManager lm = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        if (lm != null) { try { lm.removeUpdates(this); } catch (Throwable ignored) { } }
    }

    // ---- LocationListener (4 method wajib agar aman di Android < 11) ----
    @Override public void onStatusChanged(String provider, int status, Bundle extras) { }
    @Override public void onProviderEnabled(String provider) { startUpdates(); }
    @Override public void onProviderDisabled(String provider) { }

    @Override
    public void onLocationChanged(Location l) {
        if (l == null) return;
        long now = System.currentTimeMillis();
        String pv = l.getProvider();
        if (LocationManager.NETWORK_PROVIDER.equals(pv) && now - lastGpsAt < 30000L) return;
        if (LocationManager.GPS_PROVIDER.equals(pv)) lastGpsAt = now;
        if (l.hasAccuracy() && l.getAccuracy() > 200f && lastWriteAt > 0) return;

        double raw = l.hasSpeed() ? l.getSpeed() : -1;
        if (raw < 0 && prevLoc != null) {
            double dt = (l.getTime() - prevLoc.getTime()) / 1000.0;
            double d = l.distanceTo(prevLoc);
            raw = (dt > 0.5 && d > Math.max(8.0, Math.min(l.getAccuracy(), 60f) * 0.6)) ? d / dt : 0;
        }
        if (raw < 0) raw = 0;
        speedSm = prevLoc == null ? raw : 0.6 * raw + 0.4 * speedSm;
        prevLoc = l;

        FixListener fl = fixListener;
        if (fl != null) {
            try { fl.onFix(l.getLatitude(), l.getLongitude(), l.hasAccuracy() ? l.getAccuracy() : 0f, (float) raw, l.getTime() > 0 ? l.getTime() : now); }
            catch (Throwable ignored) { }
        }
        maybeWrite(l, now);
    }

    private static String classify(double v) { return v < 0.8 ? "diam" : v < 2.3 ? "jalan" : v < 6 ? "sepeda" : "kendara"; }

    private void maybeWrite(Location l, long now) {
        if (now - lastJsWrite < 120000L) return;           // app terbuka & sudah menulis sendiri
        String m = classify(speedSm);
        boolean changed = !m.equals(mode);
        if (changed) { mode = m; modeSince = now; }
        boolean act = !"diam".equals(mode);
        long minInt = act ? 10000L : 30000L, hb = act ? 60000L : 180000L;
        float minMove = act ? 10f : 25f;
        float moved = lastWritten == null ? Float.MAX_VALUE : l.distanceTo(lastWritten);
        long since = now - lastWriteAt;
        if (!(lastWritten == null || changed || (moved >= minMove && since >= minInt) || since >= hb)) return;
        if (!writing.compareAndSet(false, true)) return;
        lastWritten = l; lastWriteAt = now;
        final double lat = l.getLatitude(), lng = l.getLongitude();
        final int acc = l.hasAccuracy() ? Math.round(l.getAccuracy()) : 0;
        final int kmh = (int) Math.round(speedSm * 3.6);
        final String md = mode; final long ms = modeSince;
        try {
            io.execute(() -> {
                PowerManager.WakeLock wl = null;
                try {
                    PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
                    if (pm != null) { wl = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "famloc:write"); wl.acquire(25000L); }
                    doWrite(lat, lng, acc, kmh, md, ms);
                } catch (Throwable t) {
                    Log.w(TAG, "tulis gagal: " + t);
                } finally {
                    if (wl != null && wl.isHeld()) wl.release();
                    writing.set(false);
                }
            });
        } catch (Throwable t) { writing.set(false); }
    }

    private static JSONObject sv(String s) throws Exception { return new JSONObject().put("stringValue", s == null ? "" : s); }
    private static JSONObject dv(double d) throws Exception { return new JSONObject().put("doubleValue", d); }
    private static JSONObject iv(long v) throws Exception { return new JSONObject().put("integerValue", String.valueOf(v)); }
    private static JSONObject bv(boolean b) throws Exception { return new JSONObject().put("booleanValue", b); }

    private void doWrite(double lat, double lng, int acc, int kmh, String md, long ms) throws Exception {
        SharedPreferences p = prefs();
        String pid = p.getString("projectId", ""), space = p.getString("spaceId", ""), uid = p.getString("uid", "");
        if (pid.isEmpty() || space.isEmpty() || uid.isEmpty()) return;
        String token = idToken();

        Intent b = registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
        int pct = -1; boolean charging = false;
        if (b != null) {
            int level = b.getIntExtra(BatteryManager.EXTRA_LEVEL, -1), scale = b.getIntExtra(BatteryManager.EXTRA_SCALE, -1);
            if (level >= 0 && scale > 0) pct = Math.round(level * 100f / scale);
            int st = b.getIntExtra(BatteryManager.EXTRA_STATUS, -1);
            charging = st == BatteryManager.BATTERY_STATUS_CHARGING || st == BatteryManager.BATTERY_STATUS_FULL;
        }
        JSONObject f = new JSONObject();
        f.put("name", sv(p.getString("name", "Aku")));
        f.put("color", sv(p.getString("color", "#6D4AFF")));
        f.put("sharing", bv(true));
        f.put("lat", dv(lat)); f.put("lng", dv(lng)); f.put("accuracy", iv(acc));
        f.put("mode", sv(md)); f.put("modeSince", iv(ms)); f.put("speedKmh", iv(kmh));
        if (pct >= 0) f.put("battery", iv(pct));
        f.put("charging", bv(charging));
        JSONArray mask = new JSONArray();
        java.util.Iterator<String> it = f.keys();
        while (it.hasNext()) mask.put(it.next());

        String docName = "projects/" + pid + "/databases/(default)/documents/bukukas_shared/" + space + "/locations/" + uid;
        JSONObject write = new JSONObject()
                .put("update", new JSONObject().put("name", docName).put("fields", f))
                .put("updateMask", new JSONObject().put("fieldPaths", mask))
                .put("updateTransforms", new JSONArray().put(new JSONObject().put("fieldPath", "updatedAt").put("setToServerValue", "REQUEST_TIME")));
        String body = new JSONObject().put("writes", new JSONArray().put(write)).toString();
        String[] r = http("https://firestore.googleapis.com/v1/projects/" + pid + "/databases/(default)/documents:commit",
                "application/json", body, token);
        int code = Integer.parseInt(r[0]);
        if (code == 401 || code == 403) { tok = null; tokExp = 0; }
        if (code < 200 || code >= 300) Log.w(TAG, "commit HTTP " + code + " " + r[1]);
    }

    private synchronized String idToken() throws Exception {
        long now = System.currentTimeMillis();
        if (tok != null && tokExp - now > 120000L) return tok;
        SharedPreferences p = prefs();
        String rt = p.getString("refreshToken", "");
        if (rt.isEmpty()) throw new Exception("refresh token kosong");
        String body = "grant_type=refresh_token&refresh_token=" + URLEncoder.encode(rt, "UTF-8");
        String[] r = http("https://securetoken.googleapis.com/v1/token?key=" + URLEncoder.encode(p.getString("apiKey", ""), "UTF-8"),
                "application/x-www-form-urlencoded", body, null);
        if (Integer.parseInt(r[0]) != 200) throw new Exception("refresh HTTP " + r[0]);
        JSONObject j = new JSONObject(r[1]);
        tok = j.getString("id_token");
        tokExp = now + Long.parseLong(j.optString("expires_in", "3600")) * 1000L;
        String nrt = j.optString("refresh_token", "");
        if (!nrt.isEmpty()) p.edit().putString("refreshToken", nrt).apply();
        return tok;
    }

    private static String[] http(String url, String ctype, String body, String bearer) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        try {
            c.setRequestMethod("POST");
            c.setConnectTimeout(10000); c.setReadTimeout(15000);
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", ctype);
            if (bearer != null) c.setRequestProperty("Authorization", "Bearer " + bearer);
            byte[] data = body.getBytes("UTF-8");
            OutputStream os = c.getOutputStream();
            os.write(data); os.close();
            int code = c.getResponseCode();
            InputStream is = code >= 400 ? c.getErrorStream() : c.getInputStream();
            StringBuilder sb = new StringBuilder();
            if (is != null) {
                byte[] buf = new byte[4096]; int n;
                while ((n = is.read(buf)) > 0) sb.append(new String(buf, 0, n, "UTF-8"));
                is.close();
            }
            return new String[]{String.valueOf(code), sb.toString()};
        } finally { c.disconnect(); }
    }
}
