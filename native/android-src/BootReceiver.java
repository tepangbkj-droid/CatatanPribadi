package id.bukukas.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

/** Menyalakan lagi berbagi lokasi setelah HP restart atau app diperbarui. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        String a = intent == null ? null : intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(a) && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(a)) return;
        if (!ctx.getSharedPreferences(LocationShareService.PREFS, Context.MODE_PRIVATE).getBoolean("enabled", false)) return;
        try {
            Intent i = new Intent(ctx, LocationShareService.class);
            if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i); else ctx.startService(i);
        } catch (Throwable t) { Log.w("FamilyLoc", "gagal start setelah boot: " + t); }
    }
}
