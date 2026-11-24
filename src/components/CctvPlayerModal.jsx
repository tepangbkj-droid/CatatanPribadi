// src/components/CctvPlayerModal.jsx
// Pemutar CCTV ATCS di dalam aplikasi (tanpa tab baru) memakai hls.js, fallback HLS native untuk Safari/iOS.
//
// Props:
//   camera   { id, nama, wilayah, streamUrl, portalUrl, ... } | null   (null = modal tertutup)
//   onClose  () => void
//
// Instal dependensi:  npm i hls.js

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Hls from "hls.js";

const START_TIMEOUT_MS = 15000; // tidak ada gambar dalam 15 dtk -> anggap offline/dibatasi
const MAX_NET_RETRY = 2;
const MAX_MEDIA_RECOVER = 2;

const MESSAGES = {
  offline: {
    title: "Stream ATCS sedang offline atau dibatasi CORS",
    hint: "Server kamera tidak merespons atau melarang pemutaran dari aplikasi ini. Coba lagi sebentar, atau buka portal resminya.",
  },
  timeout: {
    title: "Stream tidak merespons",
    hint: "Tidak ada gambar setelah 15 detik. Kamera mungkin sedang offline atau jaringan Anda lambat.",
  },
  http: {
    title: "Server kamera menolak permintaan",
    hint: "Stream mungkin sudah dipindahkan atau memerlukan akses dari situs resminya.",
  },
  media: {
    title: "Video tidak bisa diputar",
    hint: "Format video dari kamera ini tidak dapat didekode oleh perangkat Anda.",
  },
  unsupported: {
    title: "Perangkat ini tidak mendukung HLS",
    hint: "Peramban Anda tidak bisa memutar stream .m3u8. Gunakan portal resmi.",
  },
  nostream: {
    title: "Belum ada siaran langsung di dalam aplikasi",
    hint: "Titik ini belum punya URL stream .m3u8 yang bisa diputar langsung. Gunakan portal resmi untuk melihat kameranya.",
  },
};

const searchUrl = (nama) => `https://www.google.com/search?q=${encodeURIComponent(`live cctv ${nama}`)}`;

export default function CctvPlayerModal({ camera, onClose }) {
  const videoRef = useRef(null);
  const closeRef = useRef(null);
  const [state, setState] = useState("loading"); // loading | playing | error
  const [errKey, setErrKey] = useState("offline");
  const [detail, setDetail] = useState("");
  const [attempt, setAttempt] = useState(0);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  // ---- inisialisasi pemutar tiap kamera / percobaan ulang ----
  useEffect(() => {
    if (!camera) return undefined;
    const video = videoRef.current;
    setState("loading");
    setDetail("");

    const fail = (key, d = "") => { setErrKey(key); setDetail(d); setState("error"); };

    if (!camera.streamUrl) { fail("nostream"); return undefined; }
    if (!video) return undefined;

    let hls = null;
    let disposed = false;
    let netRetry = 0;
    let mediaRecover = 0;
    const timer = setTimeout(() => { if (!disposed) fail("timeout"); }, START_TIMEOUT_MS);
    const onPlaying = () => { if (disposed) return; clearTimeout(timer); setState("playing"); };
    const tryPlay = () => { const p = video.play(); if (p && p.catch) p.catch(() => { /* autoplay ditahan: pengguna menekan play */ }); };

    video.muted = true; // wajib agar autoplay diizinkan peramban
    video.addEventListener("playing", onPlaying);

    if (Hls.isSupported()) {
      hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        manifestLoadingTimeOut: 10000,
        manifestLoadingMaxRetry: 1,
        levelLoadingTimeOut: 10000,
        levelLoadingMaxRetry: 2,
        fragLoadingTimeOut: 15000,
        fragLoadingMaxRetry: 2,
        liveSyncDurationCount: 3,
        maxBufferLength: 20,
      });
      hls.on(Hls.Events.MANIFEST_PARSED, tryPlay);
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (disposed) return;
        const info = [data.type, data.details, data.response && data.response.code ? `HTTP ${data.response.code}` : ""].filter(Boolean).join(" • ");
        if (!data.fatal) return; // error non-fatal (mis. satu segmen gagal) ditangani hls.js sendiri
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          const code = data.response && data.response.code;
          const manifestFail = data.details === Hls.ErrorDetails.MANIFEST_LOAD_ERROR || data.details === Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT;
          if (!manifestFail && netRetry < MAX_NET_RETRY) { netRetry += 1; hls.startLoad(); return; }
          clearTimeout(timer);
          hls.destroy(); hls = null;
          // code 0 / tanpa respons = diblokir CORS, jaringan putus, atau server mati
          fail(code && code >= 400 ? "http" : data.details === Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT ? "timeout" : "offline", info);
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          if (mediaRecover < MAX_MEDIA_RECOVER) { mediaRecover += 1; hls.recoverMediaError(); return; }
          clearTimeout(timer);
          hls.destroy(); hls = null;
          fail("media", info);
        } else {
          clearTimeout(timer);
          hls.destroy(); hls = null;
          fail("offline", info);
        }
      });
      hls.loadSource(camera.streamUrl);
      hls.attachMedia(video);
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      // Safari / iOS: HLS native
      const onErr = () => { if (!disposed) { clearTimeout(timer); fail("offline", "native HLS error"); } };
      video.addEventListener("error", onErr);
      video.src = camera.streamUrl;
      video.addEventListener("loadedmetadata", tryPlay, { once: true });
      hls = { destroy: () => { video.removeEventListener("error", onErr); video.removeEventListener("loadedmetadata", tryPlay); } };
    } else {
      clearTimeout(timer);
      fail("unsupported");
      video.removeEventListener("playing", onPlaying);
      return undefined;
    }

    return () => {
      disposed = true;
      clearTimeout(timer);
      video.removeEventListener("playing", onPlaying);
      if (hls) hls.destroy();
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
  }, [camera, attempt]);

  // ---- tutup dengan Esc, kunci scroll, fokus awal ----
  useEffect(() => {
    if (!camera) return undefined;
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    if (closeRef.current) closeRef.current.focus();
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [camera, onClose]);

  if (!camera) return null;
  const msg = MESSAGES[errKey] || MESSAGES.offline;
  const btnBase = "flex min-h-12 flex-1 items-center justify-center rounded-xl px-4 text-center text-sm font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2";

  return createPortal(
    <div
      className="fixed inset-0 z-[1000] flex items-end justify-center bg-slate-950/70 sm:items-center sm:p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div role="dialog" aria-modal="true" aria-label={`CCTV ${camera.nama}`} className="w-full max-w-2xl overflow-hidden rounded-t-2xl bg-white shadow-2xl sm:rounded-2xl">
        <div className="flex items-start gap-3 px-4 pb-3 pt-4">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-bold text-slate-900">{camera.nama}</h2>
            <p className="truncate text-sm text-slate-600">{camera.wilayah} • {camera.sumber}</p>
          </div>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="Tutup pemutar CCTV" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-700 active:bg-slate-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-600">
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>

        <div className="relative aspect-video w-full bg-slate-900">
          <video ref={videoRef} autoPlay muted playsInline controls className="h-full w-full bg-black object-contain" aria-label={`Siaran langsung ${camera.nama}`} />

          {state === "loading" && (
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 bg-slate-900/70 text-white" role="status" aria-live="polite">
              <span className="h-8 w-8 animate-spin rounded-full border-4 border-white/30 border-t-white motion-reduce:animate-none" aria-hidden="true" />
              <span className="text-sm">Menghubungkan ke kamera…</span>
            </div>
          )}

          {state === "error" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-slate-900/95 px-5 text-center text-white" role="alert">
              <svg viewBox="0 0 24 24" className="h-9 w-9 text-amber-400" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 3l18 18M10.6 6H15a2 2 0 012 2v3.4l4-2.4v8M17 17H5a2 2 0 01-2-2V8a2 2 0 012-2h.4" />
              </svg>
              <p className="text-base font-semibold">{msg.title}</p>
              <p className="max-w-md text-sm text-slate-300">{msg.hint}</p>
              {detail && <p className="text-xs text-slate-400">Detail teknis: {detail}</p>}
              {camera.streamUrl && (
                <button type="button" onClick={retry} className="mt-1 min-h-11 rounded-lg bg-white/15 px-4 text-sm font-semibold active:bg-white/25 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white">
                  Coba lagi
                </button>
              )}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-2 p-4 sm:flex-row" style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}>
          <a href={camera.portalUrl} target="_blank" rel="noopener noreferrer" className={`${btnBase} bg-sky-700 text-white active:bg-sky-800 focus-visible:outline-sky-700`}>
            Buka Portal Resmi ATCS
          </a>
          <a href={searchUrl(camera.nama)} target="_blank" rel="noopener noreferrer" className={`${btnBase} bg-slate-100 text-slate-900 ring-1 ring-slate-300 active:bg-slate-200 focus-visible:outline-slate-700`}>
            Cari Live CCTV {camera.nama}
          </a>
        </div>
      </div>
    </div>,
    document.body,
  );
}
