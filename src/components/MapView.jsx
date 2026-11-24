// src/components/MapView.jsx
// Peta MapLibre GL (WebGL): rotasi/bearing halus, mode ikuti motor (heading-up / north-up), rute, dan pilih tujuan dengan tekan-lama.
//
// Props:
//   position      { lat, lon, heading?, speed? }   posisi motor dari tracker
//   route         hasil getMotorRoute() atau null
//   destination   { lat, lon } | null
//   mode          "heading" | "north" | "free"     (heading-up | utara di atas | bebas geser)
//   onModeChange  (mode) => void
//   onPickDestination ({lat, lon}) => void          dipanggil saat peta ditekan lama
//   className     kelas Tailwind untuk wadah
//   showCctv      tampilkan kontrol layer CCTV ATCS (default true)

import { useCallback, useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import CctvLayer from "./CctvLayer";

const STYLE = {
  version: 8,
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      maxzoom: 19,
      attribution: "© OpenStreetMap contributors",
    },
  },
  layers: [{ id: "osm", type: "raster", source: "osm" }],
};

const FOLLOW_ZOOM = 17;
const LONG_PRESS_MS = 600;
const reduceMotion = () => typeof window !== "undefined" && window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const EMPTY_LINE = { type: "Feature", geometry: { type: "LineString", coordinates: [] } };

/** Pilih bearing setara terdekat dari bearing sebelumnya agar peta tidak berputar 359° -> 0°. */
function unwrapBearing(prev, next) {
  let d = ((next - prev + 540) % 360) - 180;
  return prev + d;
}

function motorElement() {
  const el = document.createElement("div");
  el.className = "relative flex h-11 w-11 items-center justify-center";
  el.innerHTML = `
    <span class="absolute inset-0 rounded-full bg-sky-500/25"></span>
    <svg viewBox="0 0 40 40" class="relative h-9 w-9 drop-shadow-md" aria-hidden="true">
      <circle cx="20" cy="20" r="17" fill="#ffffff"/>
      <path d="M20 6 L30 31 L20 25.5 L10 31 Z" fill="#0369a1" stroke="#0c4a6e" stroke-width="1.5" stroke-linejoin="round"/>
    </svg>`;
  return el;
}
function destinationElement() {
  const el = document.createElement("div");
  el.innerHTML = `
    <svg viewBox="0 0 32 40" class="h-10 w-8 drop-shadow-md" aria-hidden="true">
      <path d="M16 39 C16 39 3 24 3 15 a13 13 0 1 1 26 0 C29 24 16 39 16 39Z" fill="#dc2626" stroke="#fff" stroke-width="2"/>
      <circle cx="16" cy="15" r="5" fill="#fff"/>
    </svg>`;
  return el;
}

export default function MapView({ position, route, destination, mode = "heading", onModeChange, onPickDestination, showCctv = true, className = "" }) {
  const boxRef = useRef(null);
  const mapRef = useRef(null);
  const motorRef = useRef(null);
  const destRef = useRef(null);
  const bearingRef = useRef(0);
  const modeRef = useRef(mode);
  const cbRef = useRef({ onModeChange, onPickDestination });
  const [ready, setReady] = useState(false);
  const [bearing, setBearing] = useState(0);

  modeRef.current = mode;
  cbRef.current = { onModeChange, onPickDestination };

  // ---- buat peta sekali ----
  useEffect(() => {
    const start = position && Number.isFinite(position.lat) ? [position.lon, position.lat] : [106.8456, -6.2088];
    const map = new maplibregl.Map({
      container: boxRef.current,
      style: STYLE,
      center: start,
      zoom: 15,
      maxPitch: 60,
      attributionControl: { compact: true },
      dragRotate: true,
      touchPitch: true,
    });
    mapRef.current = map;

    const motor = new maplibregl.Marker({ element: motorElement(), rotationAlignment: "map", pitchAlignment: "map" })
      .setLngLat(start).addTo(map);
    motorRef.current = motor;

    map.on("load", () => {
      map.addSource("route", { type: "geojson", data: EMPTY_LINE });
      map.addLayer({ id: "route-casing", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 10, 7, 18, 16] } });
      map.addLayer({ id: "route-line", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#0369a1", "line-width": ["interpolate", ["linear"], ["zoom"], 10, 4, 18, 10] } });
      setReady(true);
    });

    // Geser/zoom manual oleh pengguna -> lepas mode ikuti.
    const release = (e) => { if (e.originalEvent && modeRef.current !== "free") cbRef.current.onModeChange && cbRef.current.onModeChange("free"); };
    map.on("dragstart", release);
    map.on("rotatestart", release);
    map.on("pitchstart", release);
    map.on("zoomstart", release);
    map.on("rotate", () => setBearing(Math.round(map.getBearing())));

    // Tekan lama = pilih tujuan (MapLibre tidak punya long-press bawaan untuk layar sentuh).
    let timer = null;
    const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
    const arm = (e) => {
      cancel();
      if (e.originalEvent && e.originalEvent.touches && e.originalEvent.touches.length > 1) return;
      const ll = e.lngLat;
      timer = setTimeout(() => {
        timer = null;
        if (navigator.vibrate) navigator.vibrate(30);
        cbRef.current.onPickDestination && cbRef.current.onPickDestination({ lat: ll.lat, lon: ll.lng });
      }, LONG_PRESS_MS);
    };
    map.on("mousedown", arm);
    map.on("touchstart", arm);
    ["mouseup", "touchend", "touchcancel", "touchmove", "mousemove", "dragstart", "zoomstart", "rotatestart"].forEach((t) => map.on(t, cancel));

    return () => {
      cancel();
      motor.remove();
      if (destRef.current) destRef.current.remove();
      map.remove();
      mapRef.current = motorRef.current = destRef.current = null;
      setReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- posisi motor + mode ikuti ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !position || !Number.isFinite(position.lat) || !Number.isFinite(position.lon)) return;
    const lngLat = [position.lon, position.lat];
    const heading = Number.isFinite(position.heading) ? position.heading : null;
    if (motorRef.current) {
      motorRef.current.setLngLat(lngLat);
      if (heading !== null) motorRef.current.setRotation(heading);
    }
    if (modeRef.current === "free") return;
    const dur = reduceMotion() ? 0 : 900;
    const opts = {
      center: lngLat,
      zoom: Math.max(map.getZoom(), FOLLOW_ZOOM),
      duration: dur,
      easing: (t) => t,           // linear: GPS tiap detik terasa kontinu, tanpa "tersendat" di tiap titik
      essential: true,
      padding: { top: Math.round(map.getContainer().clientHeight * 0.35), bottom: 0, left: 0, right: 0 },
    };
    if (modeRef.current === "heading" && heading !== null) {
      bearingRef.current = unwrapBearing(bearingRef.current, heading);
      opts.bearing = bearingRef.current;
      opts.pitch = 50;
    } else if (modeRef.current === "north") {
      bearingRef.current = unwrapBearing(bearingRef.current, 0);
      opts.bearing = bearingRef.current;
      opts.pitch = 0;
    }
    map.easeTo(opts);
  }, [position, mode, ready]);

  // ---- rute ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const src = map.getSource("route");
    if (!src) return;
    src.setData(route && route.lngLat && route.lngLat.length > 1
      ? { type: "Feature", geometry: { type: "LineString", coordinates: route.lngLat } }
      : EMPTY_LINE);
    if (route && modeRef.current === "free") {
      const [a, b, c, d] = route.bounds;
      map.fitBounds([[a, b], [c, d]], { padding: 60, duration: reduceMotion() ? 0 : 800, maxZoom: 17 });
    }
  }, [route, ready]);

  // ---- tujuan ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!destination) {
      if (destRef.current) { destRef.current.remove(); destRef.current = null; }
      return;
    }
    if (!destRef.current) destRef.current = new maplibregl.Marker({ element: destinationElement(), anchor: "bottom" }).setLngLat([destination.lon, destination.lat]).addTo(map);
    else destRef.current.setLngLat([destination.lon, destination.lat]);
  }, [destination, ready]);

  const resetNorth = () => {
    const map = mapRef.current;
    if (!map) return;
    bearingRef.current = 0;
    map.easeTo({ bearing: 0, pitch: 0, duration: reduceMotion() ? 0 : 500 });
    if (modeRef.current === "heading" && cbRef.current.onModeChange) cbRef.current.onModeChange("north");
  };
  const recenter = () => {
    if (cbRef.current.onModeChange) cbRef.current.onModeChange("heading");
  };

  // Saat pengguna memilih kamera / wilayah CCTV, lepas mode ikuti motor agar kamera peta tidak ditarik balik oleh GPS.
  const freeMode = useCallback(() => { if (modeRef.current !== "free" && cbRef.current.onModeChange) cbRef.current.onModeChange("free"); }, []);

  const btn = "flex h-12 w-12 items-center justify-center rounded-full bg-white text-slate-800 shadow-lg ring-1 ring-slate-300 active:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-600";

  return (
    <div className={`relative h-full w-full overflow-hidden bg-slate-200 ${className}`}>
      <div ref={boxRef} className="absolute inset-0" />

      {showCctv && <CctvLayer map={mapRef.current} ready={ready} onFocusCamera={freeMode} />}

      <div className="absolute right-3 top-3 flex flex-col gap-2">
        <button type="button" onClick={resetNorth} className={btn} aria-label="Arahkan peta ke utara">
          <svg viewBox="0 0 24 24" className="h-7 w-7" style={{ transform: `rotate(${-bearing}deg)`, transition: "transform 150ms linear" }} aria-hidden="true">
            <path d="M12 2 L17 13 H7 Z" fill="#dc2626" />
            <path d="M12 22 L7 11 H17 Z" fill="#475569" />
          </svg>
        </button>
        {mode === "free" && (
          <button type="button" onClick={recenter} className={btn} aria-label="Ikuti posisi motor">
            <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <circle cx="12" cy="12" r="4" /><path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
