-- Jalankan: wrangler d1 execute gps-db --remote --file=schema.sql
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, updated_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS push_subs (
  endpoint   TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  label      TEXT,
  ua         TEXT,
  created_at INTEGER NOT NULL,
  last_ok    INTEGER,
  fail_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_push_email ON push_subs(email);

CREATE TABLE IF NOT EXISTS alarm_seen (id TEXT PRIMARY KEY, seen_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS positions (
  t INTEGER NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL, speed REAL, heading REAL, up INTEGER,
  PRIMARY KEY (t, lat, lon)
);

CREATE TABLE IF NOT EXISTS command_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, email TEXT NOT NULL,
  action TEXT NOT NULL, command TEXT, ok INTEGER NOT NULL, via TEXT, reply TEXT
);

CREATE TABLE IF NOT EXISTS audio (
  id TEXT PRIMARY KEY, r2_key TEXT NOT NULL, created_at INTEGER NOT NULL, email TEXT,
  size INTEGER, mime TEXT, duration_sec REAL, note TEXT, source TEXT
);
CREATE INDEX IF NOT EXISTS idx_audio_time ON audio(created_at DESC);
