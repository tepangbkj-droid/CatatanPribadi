package id.bukukas.app;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

@CapacitorPlugin(name = "FamilyLoc", permissions = {
        @Permission(alias = "location", strings = {"android.permission.ACCESS_COARSE_LOCATION", "android.permission.ACCESS_FINE_LOCATION"}),
        @Permission(alias = "background", strings = {"android.permission.ACCESS_BACKGROUND_LOCATION"}),
        @Permission(alias = "notifications", strings = {"android.permission.POST_NOTIFICATIONS"})
})
public class FamilyLocPlugin extends Plugin {

    private SharedPreferences prefs() { return getContext().getSharedPreferences(LocationShareService.PREFS, Context.MODE_PRIVATE); }

    @PluginMethod
    public void start(PluginCall call) {
        String apiKey = call.getString("apiKey"), pid = call.getString("projectId"), space = call.getString("spaceId");
        String uid = call.getString("uid"), rt = call.getString("refreshToken");
        if (apiKey == null || pid == null || space == null || uid == null || rt == null) { call.reject("Parameter kurang"); return; }
        String name = call.getString("name", "Aku"), color = call.getString("color", "#6D4AFF");
        prefs().edit().putString("apiKey", apiKey).putString("projectId", pid).putString("spaceId", space)
                .putString("uid", uid).putString("name", name).putString("color", color).putString("refreshToken", rt).apply();
        permStep(call);
    }

    @PermissionCallback
    private void permStep(PluginCall call) {
        if (getPermissionState("location") != PermissionState.GRANTED) {
            if (!call.getData().optBoolean("askedLoc", false)) {
                call.getData().put("askedLoc", true);
                requestPermissionForAlias("location", call, "permStep");
                return;
            }
            call.reject("Izin lokasi ditolak", "NOT_AUTHORIZED");
            return;
        }
        if (Build.VERSION.SDK_INT >= 29 && getPermissionState("background") != PermissionState.GRANTED
                && !call.getData().optBoolean("askedBg", false)) {
            call.getData().put("askedBg", true);
            requestPermissionForAlias("background", call, "permStep");
            return;
        }
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED
                && !call.getData().optBoolean("askedNotif", false)) {
            call.getData().put("askedNotif", true);
            requestPermissionForAlias("notifications", call, "permStep");
            return;
        }
        finishStart(call);
    }

    private void finishStart(PluginCall call) {
        try {
            prefs().edit().putBoolean("enabled", true).apply();
            LocationShareService.fixListener = (lat, lng, acc, speed, time) -> {
                JSObject o = new JSObject();
                o.put("latitude", lat); o.put("longitude", lng); o.put("accuracy", acc);
                o.put("speed", speed); o.put("time", time);
                notifyListeners("location", o);
            };
            Intent i = new Intent(getContext(), LocationShareService.class);
            if (Build.VERSION.SDK_INT >= 26) getContext().startForegroundService(i); else getContext().startService(i);
            JSObject r = new JSObject();
            r.put("running", true);
            r.put("background", Build.VERSION.SDK_INT < 29 || getPermissionState("background") == PermissionState.GRANTED);
            call.resolve(r);
        } catch (Throwable t) {
            call.reject("Gagal memulai layanan: " + t.getMessage());
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        prefs().edit().putBoolean("enabled", false).apply();
        LocationShareService.fixListener = null;
        try { getContext().stopService(new Intent(getContext(), LocationShareService.class)); } catch (Throwable ignored) { }
        call.resolve();
    }

    @PluginMethod
    public void markWritten(PluginCall call) {
        LocationShareService.lastJsWrite = System.currentTimeMillis();
        call.resolve();
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject r = new JSObject();
        r.put("running", LocationShareService.running);
        r.put("enabled", prefs().getBoolean("enabled", false));
        call.resolve(r);
    }

    @PluginMethod
    public void requestBatteryExemption(PluginCall call) {
        boolean ignoring = true;
        try {
            PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
            String pkg = getContext().getPackageName();
            if (Build.VERSION.SDK_INT >= 23 && pm != null && !pm.isIgnoringBatteryOptimizations(pkg)) {
                ignoring = false;
                Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                i.setData(Uri.parse("package:" + pkg));
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(i);
            }
        } catch (Throwable ignored) { }
        JSObject r = new JSObject();
        r.put("ignoring", ignoring);
        call.resolve(r);
    }

    @Override
    protected void handleOnDestroy() {
        LocationShareService.fixListener = null;
        super.handleOnDestroy();
    }
}
