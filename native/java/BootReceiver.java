package id.bukukas.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import androidx.core.content.ContextCompat;

/** Menyalakan lagi layanan lokasi setelah HP restart (hanya bila pengguna belum menjeda/keluar). */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent i) {
        if (Intent.ACTION_BOOT_COMPLETED.equals(i.getAction()) && Store.on(c)) {
            try { ContextCompat.startForegroundService(c, new Intent(c, FamilyLocationService.class)); } catch (Exception ignored) {}
        }
    }
}
