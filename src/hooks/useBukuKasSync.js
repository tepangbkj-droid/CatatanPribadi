// src/hooks/useBukuKasSync.js
// Sinkronisasi Buku Kas keluarga ke API /api/buku-kas (Cloudflare D1, satu buku per family_group_id).
//
// Perilaku:
//  - Polling otomatis tiap 5 dtk HANYA saat tab terlihat (document.visibilityState === "visible").
//  - Sinkron segera saat tab kembali terlihat, jendela mendapat fokus, atau jaringan kembali online.
//  - Delta sync (?since=<nextSince>): hanya baris baru/berubah/terhapus (tombstone) yang diunduh.
//  - Setiap request memakai cache: "no-store". Tidak ada request yang saling tumpang-tindih.
//  - Tambah/hapus: state lokal langsung berubah (optimistic), lalu memicu sinkron ulang dari server.
//  - Gagal jaringan: coba lagi dengan jeda bertahap (5 -> 10 -> 20 -> 30 dtk) dan tampilkan status jelas.
//
// Opsi:
//   apiBase   awalan URL API ("" = origin yang sama). Contoh worker: "https://gps-worker.xxx.workers.dev"
//   getToken  async () => string | null   token "Bearer" (mis. Firebase getIdToken()); null = tanpa header Authorization
//   selfEmail email akun yang sedang masuk (opsional; dipakai menandai catatan "Anda")
//   pollMs    interval polling (default 5000)

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const DEFAULT_POLL_MS = 5000;
const MAX_BACKOFF_MS = 30000;
const MAX_PAGES = 10;
const REQUEST_TIMEOUT_MS = 12000;

const newId = () => (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : `tx_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`);

class ApiError extends Error {
  constructor(status, code, message, body) { super(message); this.status = status; this.code = code; this.body = body; }
}

export function useBukuKasSync({ apiBase = "", getToken, selfEmail = null, pollMs = DEFAULT_POLL_MS } = {}) {
  const [rowsMap, setRowsMap] = useState(() => new Map());
  const [phase, setPhase] = useState("idle"); // idle | syncing | ok | error
  const [error, setError] = useState(null);   // { message, code, status }
  const [lastSyncedAt, setLastSyncedAt] = useState(null);
  const [me, setMe] = useState(selfEmail);  // email pengguna (dari opsi, atau dari baris yang baru dibuatnya)

  const sinceRef = useRef(0);
  const inFlight = useRef(null);       // Promise sinkron yang sedang berjalan
  const queued = useRef(false);        // ada permintaan sinkron saat satu sedang berjalan
  const timerRef = useRef(null);
  const failRef = useRef(0);
  const hiddenIds = useRef(new Set()); // id yang sedang dihapus (disembunyikan sampai server konfirmasi)
  const aliveRef = useRef(true);
  const cfg = useRef({ apiBase, getToken });
  cfg.current = { apiBase, getToken };

  // ---------- request ----------
  const request = useCallback(async (path, { method = "GET", body, signal } = {}) => {
    const { apiBase: base, getToken: tok } = cfg.current;
    const headers = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (tok) {
      const t = await tok();
      if (t) headers.Authorization = `Bearer ${t}`;
    }
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
    if (signal) signal.addEventListener("abort", () => ctl.abort(), { once: true });
    let res;
    try {
      res = await fetch(`${base}${path}`, {
        method, headers, cache: "no-store", credentials: base ? "omit" : "same-origin",
        body: body !== undefined ? JSON.stringify(body) : undefined, signal: ctl.signal,
      });
    } catch (e) {
      throw new ApiError(0, "network", ctl.signal.aborted ? "Server tidak merespons (timeout)" : "Tidak bisa terhubung ke server");
    } finally { clearTimeout(to); }
    let json = null;
    try { json = await res.json(); } catch (e) { /* bukan JSON */ }
    if (!res.ok || (json && json.ok === false)) {
      const code = (json && json.code) || `http_${res.status}`;
      const msg = res.status === 401 ? "Sesi berakhir, silakan masuk lagi" : (json && json.error) || `Server membalas ${res.status}`;
      throw new ApiError(res.status, code, msg, json);
    }
    return json || {};
  }, []);

  // ---------- gabungkan baris dari server ----------
  const applyRows = useCallback((incoming, full) => {
    setRowsMap((prev) => {
      const next = full ? new Map() : new Map(prev);
      if (full) { // sinkron penuh: pertahankan baris lokal yang masih menunggu konfirmasi server
        prev.forEach((r, id) => { if (r._pending) next.set(id, r); });
      }
      incoming.forEach((r) => {
        if (r.deleted) next.delete(r.id);
        else next.set(r.id, r);
      });
      return next;
    });
    incoming.forEach((r) => { if (r.deleted) hiddenIds.current.delete(r.id); });
  }, []);

  // ---------- sinkron (delta) ----------
  const runSync = useCallback(async (silent) => {
    // Polling latar belakang yang sukses tidak memunculkan "Menyinkronkan…" tiap 5 dtk (menghindari kedip).
    setPhase((p) => (silent && p === "ok" ? p : "syncing"));
    let pages = 0;
    let first = true;
    for (;;) {
      const j = await request(`/api/buku-kas?since=${sinceRef.current}&limit=500`);
      const full = !!(j.full || j.resync) && first;
      if (j.full || j.resync) sinceRef.current = 0;
      applyRows(j.rows || [], full);
      first = false;
      sinceRef.current = j.nextSince || sinceRef.current;
      pages += 1;
      if (!j.hasMore || pages >= MAX_PAGES) break;
    }
  }, [applyRows, request]);

  const syncNow = useCallback((silent = false) => {
    if (inFlight.current) { queued.current = true; return inFlight.current; }
    const p = (async () => {
      try {
        await runSync(silent === true);
        failRef.current = 0;
        if (aliveRef.current) { setError(null); setPhase("ok"); setLastSyncedAt(Date.now()); }
      } catch (e) {
        failRef.current += 1;
        if (aliveRef.current) {
          setError({ message: e.message || "Gagal sinkron", code: e.code, status: e.status });
          setPhase("error");
        }
      } finally {
        inFlight.current = null;
        if (queued.current && aliveRef.current) { queued.current = false; syncNow(); }
      }
    })();
    inFlight.current = p;
    return p;
  }, [runSync]);

  // ---------- jadwal polling ----------
  const clearTimer = useCallback(() => { if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; } }, []);
  const schedule = useCallback(() => {
    clearTimer();
    if (!aliveRef.current || document.visibilityState !== "visible") return;
    const delay = failRef.current ? Math.min(MAX_BACKOFF_MS, pollMs * 2 ** Math.min(failRef.current, 3)) : pollMs;
    timerRef.current = setTimeout(async () => {
      if (document.visibilityState === "visible") await syncNow(true);
      schedule();
    }, delay);
  }, [clearTimer, pollMs, syncNow]);

  useEffect(() => {
    aliveRef.current = true;
    const kick = () => { if (document.visibilityState === "visible") { syncNow(); schedule(); } else clearTimer(); };
    const onVisibility = kick;
    const onFocus = () => { syncNow(); schedule(); };
    const onOnline = () => { failRef.current = 0; syncNow(); schedule(); };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onOnline);
    kick();
    return () => {
      aliveRef.current = false;
      clearTimer();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", onOnline);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncNow, schedule]);

  // ---------- tambah ----------
  const addTx = useCallback(async ({ type, amount, category, note, tx_date }) => {
    const id = newId();
    const now = Date.now();
    const draft = {
      id, type, amount: Number(amount), category: category || null, note: note || null,
      tx_date: tx_date || new Date(now + 7 * 3600 * 1000).toISOString().slice(0, 10),
      created_by: me || "Anda", updated_by: me || "Anda", version: 0, created_at: now, updated_at: now, deleted: false, _pending: true,
    };
    setRowsMap((prev) => new Map(prev).set(id, draft)); // langsung tampil
    try {
      const j = await request("/api/buku-kas", { method: "POST", body: { id, type: draft.type, amount: draft.amount, category: draft.category, note: draft.note, tx_date: draft.tx_date } });
      if (j.row) {
        setMe((m) => m || j.row.created_by);
        setRowsMap((prev) => new Map(prev).set(id, j.row));
      }
      syncNow(); // tarik transaksi anggota lain yang masuk bersamaan
      return j.row;
    } catch (e) {
      setRowsMap((prev) => { const n = new Map(prev); n.delete(id); return n; }); // batalkan tampilan lokal
      setError({ message: `Gagal menyimpan: ${e.message}`, code: e.code, status: e.status });
      setPhase("error");
      throw e;
    }
  }, [me, request, syncNow]);

  // ---------- hapus ----------
  const deleteTx = useCallback(async (id) => {
    let snapshot = null;
    hiddenIds.current.add(id);
    setRowsMap((prev) => { snapshot = prev.get(id) || null; const n = new Map(prev); n.delete(id); return n; });
    try {
      const v = snapshot && snapshot.version > 0 ? `?version=${snapshot.version}` : "";
      await request(`/api/buku-kas/${encodeURIComponent(id)}${v}`, { method: "DELETE" });
      hiddenIds.current.delete(id);
      syncNow();
    } catch (e) {
      hiddenIds.current.delete(id);
      if (e.status === 404) { syncNow(); return; }        // sudah tidak ada
      if (snapshot && e.status !== 409) setRowsMap((prev) => new Map(prev).set(id, snapshot)); // kembalikan baris
      setError({ message: e.status === 409 ? "Transaksi sudah diubah anggota lain. Data diperbarui, ulangi hapus." : `Gagal menghapus: ${e.message}`, code: e.code, status: e.status });
      setPhase("error");
      syncNow();
      throw e;
    }
  }, [request, syncNow]);

  const rows = useMemo(() => {
    const list = [];
    rowsMap.forEach((r) => { if (!hiddenIds.current.has(r.id)) list.push(r); });
    list.sort((a, b) => (a.tx_date < b.tx_date ? 1 : a.tx_date > b.tx_date ? -1 : b.created_at - a.created_at));
    return list;
  }, [rowsMap]);

  return { rows, phase, error, lastSyncedAt, me, syncNow, addTx, deleteTx };
}
