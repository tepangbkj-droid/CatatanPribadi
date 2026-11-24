// src/components/CctvLayer.jsx
// Layer CCTV ATCS di atas peta MapLibre: toggle, filter wilayah, titik kamera, daftar, dan pemutar HLS.
//
// Props:
//   map            instance maplibregl.Map (boleh null sebelum peta siap)
//   ready          true setelah event "load" peta
//   onFocusCamera  () => void   dipanggil sebelum peta terbang ke kamera (agar mode ikuti motor dilepas)
//   className      kelas Tailwind posisi wadah kontrol (default: kiri atas)

import { useCallback, useEffect, useMemo, useState } from "react";
import CctvPlayerModal from "./CctvPlayerModal";
import { CCTV_ATCS, CCTV_GROUPS, filterCctv, hasLive } from "../data/cctvAtcsData";

const SRC = "cctv-atcs";
const L_HALO = "cctv-atcs-halo";
const L_DOT = "cctv-atcs-dot";
const reduceMotion = () => typeof window !== "undefined" && window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const toGeoJson = (list) => ({
  type: "FeatureCollection",
  features: list.map((c) => ({
    type: "Feature",
    properties: { id: c.id, live: hasLive(c) ? 1 : 0 },
    geometry: { type: "Point", coordinates: [c.lng, c.lat] },
  })),
});

export default function CctvLayer({ map, ready, onFocusCamera, className = "left-3 top-3" }) {
  const [enabled, setEnabled] = useState(false);
  const [open, setOpen] = useState(false);
  const [grup, setGrup] = useState("semua");
  const [selected, setSelected] = useState(null);

  const list = useMemo(() => filterCctv(grup), [grup]);
  const byId = useMemo(() => new Map(CCTV_ATCS.map((c) => [c.id, c])), []);

  // ---- pasang source + layer sekali ----
  useEffect(() => {
    if (!map || !ready) return undefined;
    if (!map.getSource(SRC)) {
      map.addSource(SRC, { type: "geojson", data: toGeoJson([]) });
      map.addLayer({
        id: L_HALO, type: "circle", source: SRC, layout: { visibility: "none" },
        paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 9, 16, 18], "circle-color": "#ffffff", "circle-opacity": 0.95 },
      });
      map.addLayer({
        id: L_DOT, type: "circle", source: SRC, layout: { visibility: "none" },
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 6, 16, 12],
          // merah = ada stream langsung di aplikasi; abu-abu = hanya lewat portal resmi
          "circle-color": ["case", ["==", ["get", "live"], 1], "#dc2626", "#64748b"],
          "circle-stroke-width": 2, "circle-stroke-color": "#7f1d1d",
        },
      });
    }
    const onClick = (e) => {
      const f = e.features && e.features[0];
      if (!f) return;
      const cam = byId.get(f.properties.id);
      if (cam) setSelected(cam);
    };
    const enter = () => { map.getCanvas().style.cursor = "pointer"; };
    const leave = () => { map.getCanvas().style.cursor = ""; };
    map.on("click", L_DOT, onClick);
    map.on("mouseenter", L_DOT, enter);
    map.on("mouseleave", L_DOT, leave);
    return () => {
      try {
        map.off("click", L_DOT, onClick);
        map.off("mouseenter", L_DOT, enter);
        map.off("mouseleave", L_DOT, leave);
        if (map.getLayer(L_DOT)) map.removeLayer(L_DOT);
        if (map.getLayer(L_HALO)) map.removeLayer(L_HALO);
        if (map.getSource(SRC)) map.removeSource(SRC);
      } catch (e) { /* peta sudah dibuang */ }
    };
  }, [map, ready, byId]);

  // ---- data + visibilitas mengikuti toggle & filter ----
  useEffect(() => {
    if (!map || !ready) return;
    const src = map.getSource(SRC);
    if (!src) return;
    src.setData(toGeoJson(enabled ? list : []));
    const vis = enabled ? "visible" : "none";
    if (map.getLayer(L_HALO)) map.setLayoutProperty(L_HALO, "visibility", vis);
    if (map.getLayer(L_DOT)) map.setLayoutProperty(L_DOT, "visibility", vis);
  }, [map, ready, enabled, list]);

  // ---- zoom ke wilayah terpilih saat filter berganti ----
  useEffect(() => {
    if (!map || !ready || !enabled || !list.length) return;
    if (onFocusCamera) onFocusCamera();
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    list.forEach((c) => { w = Math.min(w, c.lng); e = Math.max(e, c.lng); s = Math.min(s, c.lat); n = Math.max(n, c.lat); });
    map.fitBounds([[w, s], [e, n]], { padding: 70, maxZoom: 14, duration: reduceMotion() ? 0 : 700 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grup, enabled]);

  const focusOn = useCallback((cam) => {
    if (onFocusCamera) onFocusCamera();
    if (map) map.flyTo({ center: [cam.lng, cam.lat], zoom: Math.max(map.getZoom(), 15), duration: reduceMotion() ? 0 : 700, essential: true });
    setSelected(cam);
  }, [map, onFocusCamera]);

  const chip = (active) => `min-h-11 rounded-full px-3 text-sm font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-600 ${active ? "bg-sky-700 text-white" : "bg-slate-100 text-slate-800 ring-1 ring-slate-300 active:bg-slate-200"}`;

  return (
    <>
      <div className={`absolute z-10 flex max-w-[calc(100%-5.5rem)] flex-col items-start gap-2 ${className}`}>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls="cctv-panel"
          className={`flex h-12 items-center gap-2 rounded-full px-4 text-sm font-semibold shadow-lg ring-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-600 ${enabled ? "bg-red-600 text-white ring-red-700" : "bg-white text-slate-800 ring-slate-300 active:bg-slate-100"}`}
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="2" y="7" width="14" height="10" rx="2" /><path d="M16 11l6-3v8l-6-3" />
          </svg>
          CCTV{enabled ? ` • ${list.length}` : ""}
        </button>

        {open && (
          <div id="cctv-panel" className="w-72 max-w-full rounded-2xl bg-white p-3 shadow-xl ring-1 ring-slate-300">
            <label className="flex min-h-11 cursor-pointer items-center justify-between gap-3">
              <span className="text-sm font-semibold text-slate-900">Tampilkan layer CCTV</span>
              <button
                type="button" role="switch" aria-checked={enabled} onClick={() => setEnabled((v) => !v)}
                className={`relative h-8 w-14 shrink-0 rounded-full transition-colors motion-reduce:transition-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600 ${enabled ? "bg-red-600" : "bg-slate-400"}`}
              >
                <span className={`absolute left-1 top-1 h-6 w-6 rounded-full bg-white shadow transition-transform motion-reduce:transition-none ${enabled ? "translate-x-6" : ""}`} />
                <span className="sr-only">{enabled ? "Aktif" : "Nonaktif"}</span>
              </button>
            </label>

            <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label="Filter wilayah CCTV">
              {CCTV_GROUPS.map((g) => (
                <button key={g.key} type="button" aria-pressed={grup === g.key} onClick={() => { setGrup(g.key); if (!enabled) setEnabled(true); }} className={chip(grup === g.key)}>
                  {g.label}
                </button>
              ))}
            </div>

            <p className="mt-2 flex items-center gap-3 text-xs text-slate-600">
              <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-full bg-red-600" aria-hidden="true" /> Siaran langsung</span>
              <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-full bg-slate-500" aria-hidden="true" /> Portal resmi</span>
            </p>

            <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto" aria-label="Daftar titik CCTV">
              {list.map((c) => (
                <li key={c.id}>
                  <button type="button" onClick={() => { if (!enabled) setEnabled(true); focusOn(c); }} className="flex min-h-11 w-full items-center gap-2 rounded-lg px-2 text-left active:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-600">
                    <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${hasLive(c) ? "bg-red-600" : "bg-slate-500"}`} aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-slate-900">{c.nama}</span>
                      <span className="block truncate text-xs text-slate-600">{c.wilayah}{c.feeds && c.feeds.length > 1 ? ` • ${c.feeds.length} kamera` : ""}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <CctvPlayerModal camera={selected} onClose={() => setSelected(null)} />
    </>
  );
}
