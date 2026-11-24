// src/components/BukuKas.jsx
// Buku Kas keluarga: sinkron otomatis antar perangkat (polling 5 dtk saat tab aktif + sinkron saat fokus).
//
// Pemakaian:
//   <BukuKas
//     apiBase="https://gps-worker.NAMAKAMU.workers.dev"     // "" bila API satu origin dengan aplikasi
//     getToken={() => auth.currentUser.getIdToken()}          // token Bearer (Firebase/Google ID token)
//     selfEmail={auth.currentUser?.email}
//     names={{ "istri@gmail.com": "Sari" }}                   // opsional: nama tampilan per email
//   />

import { useEffect, useMemo, useState } from "react";
import { useBukuKasSync } from "../hooks/useBukuKasSync";

const rupiah = (n) => new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(Number(n) || 0);
const todayWib = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);

function displayName(email, names, me) {
  if (!email) return "Anggota";
  const key = String(email).toLowerCase();
  if (names && (names[email] || names[key])) return names[email] || names[key];
  const local = key.split("@")[0].replace(/[._-]+/g, " ").trim();
  const nice = local ? local.replace(/\b\w/g, (c) => c.toUpperCase()) : "Anggota";
  return me && key === String(me).toLowerCase() ? `${nice} (Anda)` : nice;
}

function agoText(ts, now) {
  if (!ts) return "";
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 10) return "Baru saja";
  if (s < 60) return `${s} dtk lalu`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} mnt lalu`;
  return `${Math.floor(m / 60)} jam lalu`;
}

function formatDate(iso) {
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" });
}

function SyncBadge({ phase, lastSyncedAt, error, now, online, onRetry }) {
  const base = "inline-flex min-h-8 items-center gap-2 rounded-full px-3 text-xs font-semibold";
  if (!online) {
    return <span className={`${base} bg-amber-100 text-amber-900`} role="status"><span className="h-2 w-2 rounded-full bg-amber-600" aria-hidden="true" />Offline • menunggu jaringan</span>;
  }
  if (phase === "error") {
    return (
      <button type="button" onClick={onRetry} className={`${base} bg-red-100 text-red-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-red-700`} role="status" title={error ? error.message : ""}>
        <span className="h-2 w-2 rounded-full bg-red-600" aria-hidden="true" />Gagal sinkron • ketuk untuk ulangi
      </button>
    );
  }
  if (phase === "syncing" || phase === "idle") {
    return (
      <span className={`${base} bg-sky-100 text-sky-900`} role="status">
        <span className="h-3 w-3 animate-spin rounded-full border-2 border-sky-300 border-t-sky-700 motion-reduce:animate-none" aria-hidden="true" />Menyinkronkan…
      </span>
    );
  }
  return (
    <span className={`${base} bg-emerald-100 text-emerald-900`} role="status">
      <span className="h-2 w-2 rounded-full bg-emerald-600" aria-hidden="true" />Tersinkron • {agoText(lastSyncedAt, now)}
    </span>
  );
}

export default function BukuKas({ apiBase = "", getToken, selfEmail = null, names, className = "" }) {
  const { rows, phase, error, lastSyncedAt, me, syncNow, addTx, deleteTx } = useBukuKasSync({ apiBase, getToken, selfEmail });

  const [now, setNow] = useState(() => Date.now());
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  const [type, setType] = useState("expense");
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState("");
  const [note, setNote] = useState("");
  const [date, setDate] = useState(todayWib());
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");

  // detik berjalan agar teks "Baru saja" -> "12 dtk lalu" ikut diperbarui
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 5000); return () => clearInterval(t); }, []);
  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener("online", on); window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, []);

  const totals = useMemo(() => {
    let inc = 0, exp = 0;
    rows.forEach((r) => { if (r.type === "income") inc += Number(r.amount) || 0; else if (r.type === "expense") exp += Number(r.amount) || 0; });
    return { inc, exp, bal: inc - exp };
  }, [rows]);

  const submit = async (e) => {
    e.preventDefault();
    const value = Number(String(amount).replace(/[^\d.]/g, ""));
    if (!Number.isFinite(value) || value <= 0) { setFormError("Isi jumlah lebih dari 0."); return; }
    setFormError("");
    setSaving(true);
    try {
      await addTx({ type, amount: value, category: category.trim(), note: note.trim(), tx_date: date });
      setAmount(""); setNote(""); // kategori & tanggal dipertahankan untuk input beruntun
    } catch (err) {
      setFormError(err && err.message ? err.message : "Gagal menyimpan.");
    } finally { setSaving(false); }
  };

  const remove = async (r) => {
    if (!window.confirm(`Hapus ${r.type === "income" ? "pemasukan" : "pengeluaran"} ${rupiah(r.amount)}${r.note ? ` (${r.note})` : ""}?`)) return;
    try { await deleteTx(r.id); } catch (e) { /* pesan error tampil di banner */ }
  };

  const field = "min-h-12 w-full rounded-xl border border-slate-300 bg-white px-3 text-base text-slate-900 placeholder:text-slate-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-600";

  return (
    <section className={`mx-auto w-full max-w-xl bg-slate-50 pb-8 text-slate-900 ${className}`} aria-label="Buku Kas Keluarga">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/95 px-4 pb-3 pt-3 backdrop-blur" style={{ paddingTop: "max(0.75rem, env(safe-area-inset-top))" }}>
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-lg font-bold">Buku Kas Keluarga</h1>
          <button type="button" onClick={() => syncNow()} aria-label="Sinkronkan sekarang" className="flex h-11 w-11 items-center justify-center rounded-full bg-slate-100 text-slate-700 active:bg-slate-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-600">
            <svg viewBox="0 0 24 24" className={`h-5 w-5 ${phase === "syncing" ? "animate-spin motion-reduce:animate-none" : ""}`} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 12a9 9 0 01-15.5 6.2L3 16M3 12A9 9 0 0118.5 5.8L21 8M3 21v-5h5M21 3v5h-5" />
            </svg>
          </button>
        </div>
        <div className="mt-2" aria-live="polite">
          <SyncBadge phase={phase} lastSyncedAt={lastSyncedAt} error={error} now={now} online={online} onRetry={() => syncNow()} />
        </div>
        {phase === "error" && error && <p className="mt-2 text-sm text-red-800" role="alert">{error.message}</p>}
      </header>

      <div className="grid grid-cols-3 gap-2 px-4 pt-4 text-center">
        <div className="rounded-xl bg-emerald-50 p-2 ring-1 ring-emerald-200"><p className="text-xs text-emerald-900">Pemasukan</p><p className="truncate text-sm font-bold text-emerald-900">{rupiah(totals.inc)}</p></div>
        <div className="rounded-xl bg-rose-50 p-2 ring-1 ring-rose-200"><p className="text-xs text-rose-900">Pengeluaran</p><p className="truncate text-sm font-bold text-rose-900">{rupiah(totals.exp)}</p></div>
        <div className="rounded-xl bg-white p-2 ring-1 ring-slate-300"><p className="text-xs text-slate-700">Saldo</p><p className={`truncate text-sm font-bold ${totals.bal < 0 ? "text-rose-800" : "text-slate-900"}`}>{rupiah(totals.bal)}</p></div>
      </div>

      <form onSubmit={submit} className="m-4 space-y-3 rounded-2xl bg-white p-4 ring-1 ring-slate-300" noValidate>
        <div className="grid grid-cols-2 gap-2" role="group" aria-label="Jenis transaksi">
          {[["expense", "Pengeluaran"], ["income", "Pemasukan"]].map(([v, label]) => (
            <button key={v} type="button" aria-pressed={type === v} onClick={() => setType(v)}
              className={`min-h-12 rounded-xl text-sm font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-600 ${type === v ? (v === "income" ? "bg-emerald-700 text-white" : "bg-rose-700 text-white") : "bg-slate-100 text-slate-800 ring-1 ring-slate-300"}`}>
              {label}
            </button>
          ))}
        </div>
        <div>
          <label htmlFor="bk-amount" className="mb-1 block text-sm font-medium">Jumlah (Rp)</label>
          <input id="bk-amount" className={field} inputMode="numeric" autoComplete="off" placeholder="mis. 25000" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label htmlFor="bk-cat" className="mb-1 block text-sm font-medium">Kategori</label>
            <input id="bk-cat" className={field} maxLength={120} placeholder="mis. Makan" value={category} onChange={(e) => setCategory(e.target.value)} />
          </div>
          <div>
            <label htmlFor="bk-date" className="mb-1 block text-sm font-medium">Tanggal</label>
            <input id="bk-date" type="date" className={field} value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
        </div>
        <div>
          <label htmlFor="bk-note" className="mb-1 block text-sm font-medium">Catatan</label>
          <input id="bk-note" className={field} maxLength={1000} placeholder="opsional" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        {formError && <p className="text-sm text-red-800" role="alert">{formError}</p>}
        <button type="submit" disabled={saving} className="min-h-12 w-full rounded-xl bg-sky-700 text-base font-semibold text-white active:bg-sky-800 disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-700">
          {saving ? "Menyimpan…" : "Simpan transaksi"}
        </button>
      </form>

      <ul className="space-y-2 px-4" aria-label="Daftar transaksi keluarga">
        {rows.length === 0 && (
          <li className="rounded-xl bg-white p-6 text-center text-sm text-slate-700 ring-1 ring-slate-300">
            {phase === "idle" || phase === "syncing" ? "Memuat transaksi keluarga…" : "Belum ada transaksi. Catat yang pertama di atas."}
          </li>
        )}
        {rows.map((r) => {
          const inc = r.type === "income";
          return (
            <li key={r.id} className="flex items-start gap-3 rounded-xl bg-white p-3 ring-1 ring-slate-300">
              <span className={`mt-1 h-3 w-3 shrink-0 rounded-full ${inc ? "bg-emerald-600" : "bg-rose-600"}`} aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="truncate text-sm font-semibold">{r.category || (inc ? "Pemasukan" : "Pengeluaran")}</p>
                  <p className={`shrink-0 text-sm font-bold ${inc ? "text-emerald-800" : "text-rose-800"}`}>{inc ? "+" : "−"}{rupiah(r.amount)}</p>
                </div>
                {r.note && <p className="truncate text-sm text-slate-700">{r.note}</p>}
                <p className="mt-0.5 text-xs text-slate-600">
                  {formatDate(r.tx_date)} • Dicatat oleh <span className="font-medium text-slate-800">{displayName(r.created_by, names, me)}</span>
                  {r.updated_by && r.updated_by !== r.created_by && r.version > 1 ? ` • diubah ${displayName(r.updated_by, names, me)}` : ""}
                  {r._pending ? " • menyimpan…" : ""}
                </p>
              </div>
              <button type="button" onClick={() => remove(r)} disabled={!!r._pending} aria-label={`Hapus transaksi ${r.category || ""} ${rupiah(r.amount)}`}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-slate-600 active:bg-slate-100 disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-red-700">
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
