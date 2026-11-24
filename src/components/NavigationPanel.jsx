// src/components/NavigationPanel.jsx
// Panel navigasi: belokan berikutnya, sisa jarak/waktu, perkiraan tiba, dan daftar langkah.
// Props: route, progress (hasil navProgress), loading, error, rerouting, onCancel, onRetry

import { useState } from "react";
import { fmtDistance, fmtDuration } from "../services/valhallaRouting";

const etaText = (sec) =>
  new Date(Date.now() + sec * 1000).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Jakarta" }).replace(".", ":");

export default function NavigationPanel({ route, progress, loading, error, rerouting, onCancel, onRetry }) {
  const [open, setOpen] = useState(false);

  if (loading && !route) {
    return (
      <div className="rounded-t-2xl bg-slate-900 px-4 py-4 text-slate-100 shadow-2xl" role="status">
        <p className="text-base font-medium">Mencari rute untuk motor…</p>
      </div>
    );
  }

  if (error && !route) {
    return (
      <div className="rounded-t-2xl bg-slate-900 px-4 py-4 text-slate-100 shadow-2xl" role="alert">
        <p className="text-base font-medium text-amber-300">{error}</p>
        <div className="mt-3 flex gap-2">
          {onRetry && <button type="button" onClick={onRetry} className="h-11 flex-1 rounded-lg bg-sky-500 font-semibold text-slate-950 active:bg-sky-400">Coba lagi</button>}
          <button type="button" onClick={onCancel} className="h-11 flex-1 rounded-lg bg-slate-700 font-semibold active:bg-slate-600">Batalkan</button>
        </div>
      </div>
    );
  }

  if (!route) return null;

  const p = progress;
  const next = p && p.next;
  const remainingM = p ? p.remainingM : route.distanceKm * 1000;
  const remainingSec = p ? p.remainingSec : route.durationSec;

  return (
    <div className="rounded-t-2xl bg-slate-900 text-slate-100 shadow-2xl">
      {p && p.arrived ? (
        <div className="px-4 pt-4" role="status">
          <p className="text-xl font-semibold">Anda sudah sampai tujuan</p>
        </div>
      ) : (
        <div className="px-4 pt-4">
          {rerouting && <p className="mb-1 text-sm font-medium text-amber-300" role="status">Keluar jalur, mencari rute baru…</p>}
          {error && <p className="mb-1 text-sm font-medium text-amber-300" role="alert">{error}</p>}
          <p className="text-3xl font-bold tabular-nums">{next ? fmtDistance(p.distToNextM) : fmtDistance(remainingM)}</p>
          <p className="mt-0.5 text-lg leading-snug text-slate-200">{next ? next.instruction : "Ikuti rute"}</p>
        </div>
      )}

      <div className="mt-3 flex items-center justify-between border-t border-slate-700 px-4 py-3">
        <p className="text-sm tabular-nums text-slate-300">
          <span className="font-semibold text-slate-100">{fmtDuration(remainingSec)}</span>
          {" • "}{fmtDistance(remainingM)}{" • tiba "}{etaText(remainingSec)} WIB
        </p>
        <div className="flex gap-2">
          <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="h-10 rounded-lg bg-slate-700 px-3 text-sm font-semibold active:bg-slate-600">
            {open ? "Tutup langkah" : "Langkah"}
          </button>
          <button type="button" onClick={onCancel} className="h-10 rounded-lg bg-red-600 px-3 text-sm font-semibold active:bg-red-500">Akhiri</button>
        </div>
      </div>

      {open && (
        <ol className="max-h-56 overflow-y-auto border-t border-slate-700 px-4 py-2">
          {route.maneuvers.map((m, i) => (
            <li key={i} className={`flex items-start justify-between gap-3 py-2 text-sm ${p && i === p.nextIndex ? "font-semibold text-sky-300" : "text-slate-300"}`}>
              <span>{m.instruction}</span>
              {m.distanceKm > 0 && <span className="shrink-0 tabular-nums text-slate-400">{fmtDistance(m.distanceKm * 1000)}</span>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
