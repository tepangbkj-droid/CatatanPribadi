// src/components/MotorNavigation.jsx
// Menyatukan peta + routing Valhalla + panel. Pakai di halaman Anda:
//
//   <div className="h-dvh"><MotorNavigation position={{ lat, lon, heading, speed }} /></div>
//
// `position` datang dari tracker (mis. GET /api/sync -> pos). Tekan lama pada peta untuk memilih tujuan.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MapView from "./MapView";
import NavigationPanel from "./NavigationPanel";
import { getMotorRoute, navProgress } from "../services/valhallaRouting";

const OFF_ROUTE_M = 50;
const OFF_ROUTE_HITS = 3;          // butuh 3 pembaruan posisi berturut-turut di luar jalur
const MIN_REROUTE_GAP_MS = 20000;  // server Valhalla publik dibatasi: jangan menembak terlalu sering

export default function MotorNavigation({ position, className = "" }) {
  const [destination, setDestination] = useState(null);
  const [route, setRoute] = useState(null);
  const [loading, setLoading] = useState(false);
  const [rerouting, setRerouting] = useState(false);
  const [error, setError] = useState("");
  const [mode, setMode] = useState("heading");

  const abortRef = useRef(null);
  const offHits = useRef(0);
  const lastFetchAt = useRef(0);
  const posRef = useRef(position);
  posRef.current = position;

  const hasPos = !!position && Number.isFinite(position.lat) && Number.isFinite(position.lon);

  const fetchRoute = useCallback(async (dest, { silent = false } = {}) => {
    const from = posRef.current;
    if (!from || !Number.isFinite(from.lat)) { setError("Posisi motor belum tersedia."); return; }
    if (abortRef.current) abortRef.current.abort();
    const ctl = new AbortController();
    abortRef.current = ctl;
    lastFetchAt.current = Date.now();
    if (silent) setRerouting(true); else { setLoading(true); setError(""); }
    try {
      const r = await getMotorRoute({ lat: from.lat, lon: from.lon }, dest, { signal: ctl.signal });
      if (ctl.signal.aborted) return;
      setRoute(r);
      setError("");
      offHits.current = 0;
    } catch (e) {
      if (e && e.code === "aborted") return;
      setError(e && e.message ? e.message : "Gagal mengambil rute.");
      if (!silent) setRoute(null);
    } finally {
      if (abortRef.current === ctl) { setLoading(false); setRerouting(false); }
    }
  }, []);

  const pick = useCallback((d) => {
    setDestination(d);
    setMode("heading");
    fetchRoute(d);
  }, [fetchRoute]);

  const cancel = useCallback(() => {
    if (abortRef.current) abortRef.current.abort();
    setDestination(null); setRoute(null); setError(""); setLoading(false); setRerouting(false); offHits.current = 0;
  }, []);

  useEffect(() => () => { if (abortRef.current) abortRef.current.abort(); }, []);

  const progress = useMemo(
    () => (route && hasPos ? navProgress(position, route, OFF_ROUTE_M) : null),
    [route, position, hasPos],
  );

  // Keluar jalur -> rute ulang (dengan jeda minimum).
  useEffect(() => {
    if (!progress || !destination || loading || rerouting) return;
    if (progress.arrived) return;
    offHits.current = progress.offRoute ? offHits.current + 1 : 0;
    if (offHits.current >= OFF_ROUTE_HITS && Date.now() - lastFetchAt.current >= MIN_REROUTE_GAP_MS) {
      offHits.current = 0;
      fetchRoute(destination, { silent: true });
    }
  }, [progress, destination, loading, rerouting, fetchRoute]);

  return (
    <div className={`relative flex h-full w-full flex-col ${className}`}>
      <div className="relative min-h-0 flex-1">
        <MapView
          position={position}
          route={route}
          destination={destination}
          mode={mode}
          onModeChange={setMode}
          onPickDestination={pick}
        />
        {!destination && (
          <p className="pointer-events-none absolute inset-x-3 bottom-3 rounded-lg bg-slate-900/85 px-3 py-2 text-center text-sm text-slate-100">
            Tekan lama di peta untuk memilih tujuan
          </p>
        )}
      </div>
      {destination && (
        <NavigationPanel
          route={route}
          progress={progress}
          loading={loading}
          rerouting={rerouting}
          error={error}
          onCancel={cancel}
          onRetry={() => fetchRoute(destination)}
        />
      )}
    </div>
  );
}
