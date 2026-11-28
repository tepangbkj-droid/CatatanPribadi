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
    'android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS',
    'android.permission.POST_NOTIFICATIONS',
    'android.permission.CAMERA',
    'android.permission.RECORD_AUDIO',
    'android.permission.MODIFY_AUDIO_SETTINGS',
    'android.permission.VIBRATE',
    'android.permission.WAKE_LOCK',
    'android.permission.ACCESS_NETWORK_STATE',
    'android.permission.RECEIVE_BOOT_COMPLETED',
]
add = ''.join(f'    <uses-permission android:name="{p}" />\n' for p in perms if p not in x)
add += '    <uses-feature android:name="android.hardware.camera" android:required="false" />\n'
x = x.replace('<application', add + '    <application', 1)
# Layanan lokasi native + penerima boot
if 'FamilyLocationService' not in x:
    comp = ('        <service android:name=".FamilyLocationService" android:exported="false" '
            'android:foregroundServiceType="location" android:stopWithTask="false" />\n'
            '        <receiver android:name=".BootReceiver" android:exported="false">\n'
            '            <intent-filter><action android:name="android.intent.action.BOOT_COMPLETED" /></intent-filter>\n'
            '        </receiver>\n')
    x = x.replace('</application>', comp + '    </application>', 1)
mf.write_text(x, encoding='utf-8')

# Kode Java native (MainActivity + layanan lokasi)
import shutil, glob
jdir = root / 'java' / 'id' / 'bukukas' / 'app'
jdir.mkdir(parents=True, exist_ok=True)
for f in glob.glob('java/*.java'):
    shutil.copy(f, jdir / pathlib.Path(f).name)
print('java disalin ke', jdir)

# minSdk 23 (butuh androidx.security-crypto) + dependensi
vg = pathlib.Path('android/variables.gradle')
if vg.exists():
    v = vg.read_text(encoding='utf-8')
    v = re.sub(r'minSdkVersion\s*=\s*\d+', 'minSdkVersion = 23', v)
    vg.write_text(v, encoding='utf-8')


# --- Versi ---
bg = pathlib.Path('android/app/build.gradle')
g = bg.read_text(encoding='utf-8')
g = re.sub(r'versionCode\s+\d+', 'versionCode ' + os.environ.get('VERSION_CODE', '101'), g, count=1)
g = re.sub(r'versionName\s+"[^"]*"', 'versionName "' + os.environ.get('VERSION_NAME', '2.0.0') + '"', g, count=1)
if 'security-crypto' not in g:
    g = re.sub(r'dependencies\s*\{', 'dependencies {\n    implementation "androidx.security:security-crypto:1.1.0-alpha06"', g, count=1)
bg.write_text(g, encoding='utf-8')

# --- Nama app ---
sv = root / 'res/values/strings.xml'
t = sv.read_text(encoding='utf-8')
t = re.sub(r'(<string name="app_name">)[^<]*', r'\1Buku Kas', t)
t = re.sub(r'(<string name="title_activity_main">)[^<]*', r'\1Buku Kas', t)
sv.write_text(t, encoding='utf-8')
print('patch_android selesai')
