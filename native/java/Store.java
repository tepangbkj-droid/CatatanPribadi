package id.bukukas.app;

import android.content.Context;
import android.content.SharedPreferences;
import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;

/** Penyimpanan terenkripsi (Android Keystore) untuk refresh token & konfigurasi keluarga. */
final class Store {
    private Store() {}

    static SharedPreferences prefs(Context c) throws Exception {
        MasterKey key = new MasterKey.Builder(c).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build();
        return EncryptedSharedPreferences.create(c, "family_loc_secure", key,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM);
    }

    static void save(Context c, String apiKey, String pid, String fid, String uid, String rt, String name, String color) throws Exception {
        prefs(c).edit().putString("apiKey", apiKey).putString("pid", pid).putString("fid", fid).putString("uid", uid)
            .putString("rt", rt).putString("name", name).putString("color", color).putBoolean("on", true).apply();
    }

    static void clear(Context c) { try { prefs(c).edit().clear().apply(); } catch (Exception ignored) {} }

    static void beat(Context c) { try { prefs(c).edit().putLong("hb", System.currentTimeMillis()).apply(); } catch (Exception ignored) {} }

    static boolean on(Context c) { try { return prefs(c).getBoolean("on", false); } catch (Exception e) { return false; } }
}
