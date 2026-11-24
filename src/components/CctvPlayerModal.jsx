// src/components/CctvPlayerModal.jsx
// Pemutar CCTV ATCS di dalam aplikasi (tanpa tab baru) memakai hls.js; Safari/iOS memakai HLS native.
//
// Urutan percobaan untuk tiap kamera (feed):
//   1. Tiap kandidat streamUrls (.m3u8) berurutan, otomatis lanjut ke kandidat berikut bila gagal.
//   2. Bila semuanya gagal dan ada embedUrl: tombol "Coba pemutar embed resmi" (iframe halaman resmi pemilik kamera).
//   3. Tombol "Buka Portal Resmi ATCS" dan "Cari Live CCTV [Nama]" selalu tersedia.
//
// Props:
//   camera   { id, nama, wilayah, sumber, portalUrl, feeds: [{ label, streamUrls, embedUrl }] } | null
//   onClose  () => void
// Instal dependensi:  npm i hls.js

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Hls from "hls.js";

const START_TIMEOUT_MS = 12000; // per kandidat; tidak ada gambar dalam 12 dtk -> kandidat berikut
const MAX_NET_RETRY = 1;
const MAX_MEDIA_RECOVER = 2;

const MESSAGES = {
  offline: { title: "Stream ATCS sedang offline atau dibatasi CORS", hint: "Server kamera tidak merespons atau melarang pemutaran dari aplikasi ini. Coba lagi sebentar, coba pemutar embed resmi, atau buka portalnya." },
  timeout: { title: "Stream tidak merespons", hint: "Tidak ada gambar dalam beberapa detik. Kamera mungkin offline atau jaringan Anda lambat." },
  http: { title: "Server kamera menolak permintaan", hint: "Alamat stream mungkin sudah dipindahkan atau hanya boleh diakses dari situs resminya." },
  media: { title: "Video tidak bisa diputar", hint: "Format video kamera ini tidak dapat didekode oleh perangkat Anda." },
  unsupported: { title: "Perangkat ini tidak mendukung HLS", hint: "Peramban Anda tidak bisa memutar stream .m3u8. Gunakan pemutar embed atau portal resmi." },
  nostream: { title: "Belum ada siaran langsung di dalam aplikasi", hint: "Titik ini belum punya alamat stream yang bisa diputar langsung. Gunakan portal resmi untuk melihat kameranya." },
};

const searchUrl = (nama) => `https://www.google.com/search?q=${encodeURIComponent(`live cctv ${nama}`)}`;

export default function CctvPlayerModal({ camera, onClose }) {
  const videoRef = useRef(null);
  const closeRef = useRef(null);
  const [feedIdx, setFeedIdx] = useState(0);
  const [mode, setMode] = useState("hls"); // hls | embed
  const [state, setState] = useState("loading"); // loading | playing | error
  const [errKey, setErrKey] = useState("offline");
  const [detail, setDetail] = useState("");
  const [attempt, setAttempt] = useState(0);

  const feeds = useMemo(() => (camera && camera.feeds) || [], [camera]);
  const feed = feeds[Math.min(feedIdx, Math.max(feeds.length - 1, 0))] || null;

  const retry = useCallback(() => { setMode("hls"); setAttempt((n) => n + 1); }, []);

  // ganti kamera/titik -> mulai dari feed pertama
  useEffect(() => { setFeedIdx(0); setMode("hls"); setAttempt(0); }, [camera]);
  useEffect(() => { setMode("hls"); }, [feedIdx]);

  // ---- inisialisasi pemutar HLS ----
  useEffect(() => {
    if (!camera || mode !== "hls") return undefined;
    setState("loading"); setDetail("");
    const fail = (key, d = "") => { setErrKey(key); setDetail(d); setState("error"); };

    const urls = feed ? feed.streamUrls : [];
    if (!urls.length) { fail(feed && feed.embedUrl ? "offline" : "nostream"); return undefined; }
    const video = videoRef.current;
    if (!video) return undefined;

    let hls = null, disposed = false, idx = 0, netRetry = 0, mediaRecover = 0, timer = null, nativeErr = null;
    const native = !Hls.isSupported() && !!video.canPlayType("application/vnd.apple.mpegurl");
    if (!Hls.isSupported() && !native) { fail("unsupported"); return undefined; }

    const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };
    const onPlaying = () => { if (disposed) return; clear(); setState("playing"); };
    const tryPlay = () => { const p = video.play(); if (p && p.catch) p.catch(() => { /* autoplay ditahan: pengguna menekan play */ }); };
    video.muted = true; // wajib agar autoplay diizinkan peramban
    video.addEventListener("playing", onPlaying);

    // lanjut ke kandidat berikut, atau gagal bila habis
    const next = (key, d) => {
      clear();
      if (disposed) return;
      if (idx + 1 < urls.length) { idx += 1; netRetry = 0; mediaRecover = 0; start(); }
      else fail(key, d);
    };
    const info = (data) => [data.type, data.details, data.response && data.response.code ? `HTTP ${data.response.code}` : "", `kandidat ${idx + 1}/${urls.length}`].filter(Boolean).join(" • ");

    function start() {
      if (disposed) return;
      clear();
      timer = setTimeout(() => next("timeout", `kandidat ${idx + 1}/${urls.length}`), START_TIMEOUT_MS);
      const url = urls[idx];
      if (native) {
        video.src = url; video.load();
        video.addEventListener("loadedmetadata", tryPlay, { once: true });
        return;
      }
      if (hls) { hls.destroy(); hls = null; }
      hls = new Hls({
        enableWorker: true, lowLatencyMode: false,
        manifestLoadingTimeOut: 8000, manifestLoadingMaxRetry: 0,
        levelLoadingTimeOut: 8000, levelLoadingMaxRetry: 1,
        fragLoadingTimeOut: 12000, fragLoadingMaxRetry: 1,
        liveSyncDurationCount: 3, maxBufferLength: 20,
      });
      const mine = hls;
      mine.on(Hls.Events.MANIFEST_PARSED, tryPlay);
      mine.on(Hls.Events.ERROR, (_e, data) => {
        if (disposed || mine !== hls || !data.fatal) return; // error non-fatal ditangani hls.js sendiri
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          const manifestFail = data.details === Hls.ErrorDetails.MANIFEST_LOAD_ERROR || data.details === Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT;
          if (!manifestFail && netRetry < MAX_NET_RETRY) { netRetry += 1; mine.startLoad(); return; }
          const code = data.response && data.response.code;
          next(code && code >= 400 ? "http" : data.details === Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT ? "timeout" : "offline", info(data));
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          if (mediaRecover < MAX_MEDIA_RECOVER) { mediaRecover += 1; mine.recoverMediaError(); return; }
          next("media", info(data));
        } else next("offline", info(data));
      });
      mine.loadSource(url);
      mine.attachMedia(video);
    }

    if (native) {
      nativeErr = () => { if (!disposed) next("offline", `native HLS • kandidat ${idx + 1}/${urls.length}`); };
      video.addEventListener("error", nativeErr);
    }
    start();

    return () => {
      disposed = true; clear();
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("loadedmetadata", tryPlay);
      if (nativeErr) video.removeEventListener("error", nativeErr);
      if (hls) hls.destroy();
      video.pause(); video.removeAttribute("src"); video.load();
    };
  }, [camera, feed, mode, attempt]);

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
  const embedUrl = feed && feed.embedUrl;
  const btnBase = "flex min-h-12 flex-1 items-center justify-center rounded-xl px-4 text-center text-sm font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2";
  const smallBtn = "min-h-11 rounded-lg bg-white/15 px-4 text-sm font-semibold active:bg-white/25 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white";

  return createPortal(
    <div className="fixed inset-0 z-[1000] flex items-end justify-center bg-slate-950/70 sm:items-center sm:p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
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

        {feeds.length > 1 && (
          <div className="flex flex-wrap gap-2 px-4 pb-3" role="group" aria-label="Pilih kamera">
            {feeds.map((f, i) => (
              <button key={f.label + i} type="button" aria-pressed={i === feedIdx} onClick={() => setFeedIdx(i)}
                className={`min-h-11 rounded-full px-4 text-sm font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-600 ${i === feedIdx ? "bg-sky-700 text-white" : "bg-slate-100 text-slate-800 ring-1 ring-slate-300 active:bg-slate-200"}`}>
                {f.label}
              </button>
            ))}
          </div>
        )}

        <div className="relative aspect-video w-full bg-slate-900">
          {mode === "embed" && embedUrl ? (
            <iframe key={embedUrl} src={embedUrl} title={`Siaran ${camera.nama}`} className="h-full w-full border-0 bg-black" allow="autoplay; fullscreen; picture-in-picture" referrerPolicy="no-referrer" allowFullScreen />
          ) : (
            <>
              <video ref={videoRef} autoPlay muted playsInline controls className="h-full w-full bg-black object-contain" aria-label={`Siaran langsung ${camera.nama}`} />
              {state === "loading" && (
                <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 bg-slate-900/70 text-white" role="status" aria-live="polite">
                  <span className="h-8 w-8 animate-spin rounded-full border-4 border-white/30 border-t-white motion-reduce:animate-none" aria-hidden="true" />
                  <span className="text-sm">Menghubungkan ke kamera…</span>
                </div>
              )}
              {state === "error" && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 overflow-y-auto bg-slate-900/95 px-5 py-3 text-center text-white" role="alert">
                  <svg viewBox="0 0 24 24" className="h-9 w-9 shrink-0 text-amber-400" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 3l18 18M10.6 6H15a2 2 0 012 2v3.4l4-2.4v8M17 17H5a2 2 0 01-2-2V8a2 2 0 012-2h.4" /></svg>
                  <p className="text-base font-semibold">{msg.title}</p>
                  <p className="max-w-md text-sm text-slate-300">{msg.hint}</p>
                  {detail && <p className="text-xs text-slate-400">Detail teknis: {detail}</p>}
                  <div className="mt-1 flex flex-wrap justify-center gap-2">
                    {feed && feed.streamUrls.length > 0 && <button type="button" onClick={retry} className={smallBtn}>Coba lagi</button>}
                    {embedUrl && <button type="button" onClick={() => setMode("embed")} className={smallBtn}>Coba pemutar embed resmi</button>}
                    {embedUrl && <a href={embedUrl} target="_blank" rel="noopener noreferrer" className={`${smallBtn} flex items-center`}>Buka kamera di tab baru</a>}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {mode === "embed" && (
          <div className="flex items-center justify-between gap-2 px-4 pt-3 text-xs text-slate-600">
            <span>Pemutar embed resmi. Bila layar kosong, pemilik kamera melarang bingkai.</span>
            <button type="button" onClick={retry} className="min-h-11 shrink-0 rounded-lg px-3 font-semibold text-sky-800 underline">Kembali ke pemutar HLS</button>
          </div>
        )}

        <div className="flex flex-col gap-2 p-4 sm:flex-row" style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}>
          <a href={camera.portalUrl} target="_blank" rel="noopener noreferrer" className={`${btnBase} bg-sky-700 text-white active:bg-sky-800 focus-visible:outline-sky-700`}>Buka Portal Resmi ATCS</a>
          <a href={searchUrl(camera.nama)} target="_blank" rel="noopener noreferrer" className={`${btnBase} bg-slate-100 text-slate-900 ring-1 ring-slate-300 active:bg-slate-200 focus-visible:outline-slate-700`}>Cari Live CCTV {camera.nama}</a>
        </div>
      </div>
    </div>,
    document.body,
  );
}
