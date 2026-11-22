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
]
add = ''.join(f'    <uses-permission android:name="{p}" />\n' for p in perms if p not in x)
add += '    <uses-feature android:name="android.hardware.camera" android:required="false" />\n'
x = x.replace('<application', add + '    <application', 1)
mf.write_text(x, encoding='utf-8')

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
