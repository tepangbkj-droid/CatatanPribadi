"""Menyesuaikan project Android hasil `npx cap add android`: izin lokasi latar belakang,
versi, dan nama app. Dijalankan dari folder native/ oleh GitHub Actions."""
import os, re, pathlib

root = pathlib.Path('android/app/src/main')

# --- Izin di AndroidManifest ---
mf = root / 'AndroidManifest.xml'
x = mf.read_text(encoding='utf-8')
perms = [
    'android.permission.INTERNET',
    'android.permission.ACCESS_COARSE_LOCATION',
    'android.permission.ACCESS_FINE_LOCATION',
    'android.permission.ACCESS_BACKGROUND_LOCATION',
    'android.permission.FOREGROUND_SERVICE',
    'android.permission.FOREGROUND_SERVICE_LOCATION',
    'android.permission.POST_NOTIFICATIONS',
    'android.permission.CAMERA',
    'android.permission.RECORD_AUDIO',
    'android.permission.MODIFY_AUDIO_SETTINGS',
    'android.permission.VIBRATE',
    'android.permission.WAKE_LOCK',
    'android.permission.ACCESS_NETWORK_STATE',
    'android.permission.RECEIVE_BOOT_COMPLETED',
    'android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS',
]
add = ''.join(f'    <uses-permission android:name="{p}" />\n' for p in perms if p not in x)
add += '    <uses-feature android:name="android.hardware.camera" android:required="false" />\n'
x = x.replace('<application', add + '    <application', 1)
# Hardening: refresh token tidak ikut backup cloud/adb, tanpa cleartext
x = re.sub(r'android:allowBackup="true"', 'android:allowBackup="false"', x)
if 'android:usesCleartextTraffic' not in x:
    x = x.replace('<application', '<application android:usesCleartextTraffic="false"', 1)
comp = '''
        <service android:name="id.bukukas.app.LocationShareService" android:exported="false" android:foregroundServiceType="location" />
        <receiver android:name="id.bukukas.app.BootReceiver" android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.BOOT_COMPLETED" />
                <action android:name="android.intent.action.MY_PACKAGE_REPLACED" />
            </intent-filter>
        </receiver>
    '''
assert '</application>' in x
x = x.replace('</application>', comp + '</application>', 1)
mf.write_text(x, encoding='utf-8')

# --- Plugin lokasi native (tetap jalan setelah app digeser dari layar) ---
import shutil
jdir = root / 'java' / 'id' / 'bukukas' / 'app'
jdir.mkdir(parents=True, exist_ok=True)
for f in pathlib.Path('android-src').glob('*.java'):
    shutil.copy(f, jdir / f.name)
(jdir / 'MainActivity.java').write_text('''package id.bukukas.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(FamilyLocPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
''', encoding='utf-8')

# --- Versi ---
bg = pathlib.Path('android/app/build.gradle')
g = bg.read_text(encoding='utf-8')
g = re.sub(r'versionCode\s+\d+', 'versionCode ' + os.environ.get('VERSION_CODE', '101'), g, count=1)
g = re.sub(r'versionName\s+"[^"]*"', 'versionName "' + os.environ.get('VERSION_NAME', '2.0.0') + '"', g, count=1)
bg.write_text(g, encoding='utf-8')

# --- Nama app ---
sv = root / 'res/values/strings.xml'
t = sv.read_text(encoding='utf-8')
t = re.sub(r'(<string name="app_name">)[^<]*', r'\1Buku Kas', t)
t = re.sub(r'(<string name="title_activity_main">)[^<]*', r'\1Buku Kas', t)
sv.write_text(t, encoding='utf-8')
print('patch_android selesai')
