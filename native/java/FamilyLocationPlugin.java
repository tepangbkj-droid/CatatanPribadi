package id.bukukas.app;

import android.content.Context;
import android.content.Intent;
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
}
