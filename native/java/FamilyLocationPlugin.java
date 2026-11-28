package id.bukukas.app;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.PowerManager;
import android.content.Intent;
import android.net.Uri;
import android.provider.Settings;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Jembatan JS -> layanan lokasi native. JS memanggil start() setelah izin lokasi diberikan. */
@CapacitorPlugin(name = "FamilyLocation")
public class FamilyLocationPlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        try {
            Context c = getContext();
            Store.save(c, call.getString("apiKey", ""), call.getString("projectId", ""), call.getString("familyId", ""),
                call.getString("uid", ""), call.getString("refreshToken", ""), call.getString("name", "Anggota"), call.getString("color", "#6D4AFF"));
            ContextCompat.startForegroundService(c, new Intent(c, FamilyLocationService.class));
            call.resolve();
        } catch (Exception e) { call.reject(String.valueOf(e.getMessage())); }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Context c = getContext();
        Store.clear(c);
        c.stopService(new Intent(c, FamilyLocationService.class));
        call.resolve();
    }

    /** Dipanggil JS tiap berhasil menulis lokasi: selama JS hidup, layanan native tidak menulis ganda. */
    @PluginMethod
    public void heartbeat(PluginCall call) {
        Store.beat(getContext());
        call.resolve(new JSObject());
    }

    /** Minta app dikecualikan dari penghematan baterai (supaya tidak dimatikan sistem di belakang layar). */
    @PluginMethod
    public void batterySettings(PluginCall call) {
        Context c = getContext();
        try {
            Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + c.getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            c.startActivity(i);
        } catch (Exception e) {
            try {
                Intent i = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                c.startActivity(i);
            } catch (Exception ignored) {}
        }
        call.resolve();
    }

    /** Status izin penting: lokasi halus, lokasi "Sepanjang waktu", dan pengecualian penghematan baterai. */
    @PluginMethod
    public void status(PluginCall call) {
        Context c = getContext();
        JSObject o = new JSObject();
        boolean fine = ContextCompat.checkSelfPermission(c, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
        boolean bg = Build.VERSION.SDK_INT < 29 ? fine
            : ContextCompat.checkSelfPermission(c, Manifest.permission.ACCESS_BACKGROUND_LOCATION) == PackageManager.PERMISSION_GRANTED;
        boolean ign = true;
        try {
            PowerManager pm = (PowerManager) c.getSystemService(Context.POWER_SERVICE);
            if (Build.VERSION.SDK_INT >= 23 && pm != null) ign = pm.isIgnoringBatteryOptimizations(c.getPackageName());
        } catch (Exception ignored) {}
        o.put("fine", fine); o.put("background", bg); o.put("battery", ign);
        call.resolve(o);
    }
}
