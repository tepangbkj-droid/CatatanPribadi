// src/services/valhallaRouting.js
// Routing khusus motor lewat Valhalla (costing "motor_scooter"), pengganti OSRM publik.
// Shape rute berupa encoded polyline PRECISION 6 (bukan 5 seperti OSRM/Google).

export const VALHALLA_URL = "https://valhalla1.openstreetmap.de/route";
const TIMEOUT_MS = 15000;

export class RoutingError extends Error {
  constructor(message, code = "routing_error", status = 0) {
    super(message);
    this.name = "RoutingError";
    this.code = code;
    this.status = status;
  }
}

// ---------- geometri ----------
const R_EARTH_M = 6371008.8;
const toRad = (d) => (d * Math.PI) / 180;

export function haversineM(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Decode encoded polyline (default presisi 6). Hasil: [[lat, lon], ...] */
export function decodePolyline(str, precision = 6) {
  const factor = 10 ** precision;
  const out = [];
  let i = 0, lat = 0, lon = 0;
  while (i < str.length) {
    for (let axis = 0; axis < 2; axis++) {
      let shift = 0, result = 0, b;
      do {
        b = str.charCodeAt(i++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20 && i < str.length);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += delta; else lon += delta;
    }
    out.push([lat / factor, lon / factor]);
  }
  return out;
}

/** [[lat,lon]] -> [[lon,lat]] (format GeoJSON / MapLibre). */
export const toLngLat = (coords) => coords.map(([lat, lon]) => [lon, lat]);

const validPoint = (p) =>
  p && Number.isFinite(p.lat) && Number.isFinite(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180;

// ---------- permintaan rute ----------
export function buildPayload(start, end) {
  return {
    locations: [
      { lat: start.lat, lon: start.lon },
      { lat: end.lat, lon: end.lon },
    ],
    costing: "motor_scooter",
    costing_options: {
      motor_scooter: { use_highways: 0.0, use_tolls: 0.0, use_ferry: 0.5 },
    },
    directions_options: { units: "kilometers", language: "id-ID" },
  };
}

function friendlyError(body, status) {
  const code = body && body.error_code;
  if ([442, 443, 444].includes(code)) return new RoutingError("Rute tidak ditemukan. Coba pilih tujuan yang lebih dekat ke jalan.", "no_route", status);
  if (code === 171 || code === 170) return new RoutingError("Titik awal atau tujuan terlalu jauh dari jalan yang bisa dilalui motor.", "no_road", status);
  if (code === 154) return new RoutingError("Jarak rute melebihi batas server Valhalla.", "too_far", status);
  if (status === 429) return new RoutingError("Server rute sedang membatasi permintaan. Coba lagi sebentar.", "rate_limited", status);
  if (status >= 500) return new RoutingError("Server rute sedang bermasalah. Coba lagi sebentar.", "server", status);
  return new RoutingError((body && body.error) || "Gagal mengambil rute.", "bad_request", status);
}

/**
 * Ambil rute motor dari start ke end.
 * @param {{lat:number, lon:number}} start
 * @param {{lat:number, lon:number}} end
 * @param {{signal?: AbortSignal, timeoutMs?: number, retries?: number}} [opts]
 * @returns {Promise<Route>}
 */
export async function getMotorRoute(start, end, opts = {}) {
  if (!validPoint(start) || !validPoint(end)) throw new RoutingError("Koordinat awal/tujuan tidak valid.", "bad_input");
  if (haversineM(start.lat, start.lon, end.lat, end.lon) < 20) throw new RoutingError("Tujuan terlalu dekat dengan posisi Anda.", "too_close");

  const retries = opts.retries ?? 1;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (opts.signal && opts.signal.aborted) throw new RoutingError("Dibatalkan.", "aborted");
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? TIMEOUT_MS);
    const onAbort = () => ctl.abort();
    if (opts.signal) opts.signal.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await fetch(VALHALLA_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildPayload(start, end)),
        signal: ctl.signal,
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body || !body.trip) {
        const err = friendlyError(body, res.status);
        if (res.status >= 500 && attempt < retries) { lastErr = err; continue; }
        throw err;
      }
      return parseTrip(body.trip);
    } catch (e) {
      if (e instanceof RoutingError) throw e;
      if (opts.signal && opts.signal.aborted) throw new RoutingError("Dibatalkan.", "aborted");
      lastErr = e && e.name === "AbortError"
        ? new RoutingError("Server rute tidak menjawab (timeout).", "timeout")
        : new RoutingError("Tidak bisa menghubungi server rute. Periksa koneksi internet.", "network");
      if (attempt >= retries) throw lastErr;
    } finally {
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
    }
  }
  throw lastErr || new RoutingError("Gagal mengambil rute.");
}

/**
 * @typedef {Object} Route
 * @property {number} distanceKm
 * @property {number} durationSec
 * @property {number[][]} coordinates  [[lat, lon], ...]
 * @property {number[][]} lngLat       [[lon, lat], ...] untuk MapLibre/GeoJSON
 * @property {number[]} cumM           jarak kumulatif (meter) tiap titik shape
 * @property {Array} maneuvers
 * @property {number[]} bounds         [minLon, minLat, maxLon, maxLat]
 */
export function parseTrip(trip) {
  const legs = trip.legs || [];
  if (!legs.length || !legs[0].shape) throw new RoutingError("Respons rute kosong.", "empty");
  const coordinates = [];
  const maneuvers = [];
  for (const leg of legs) {
    const offset = coordinates.length ? coordinates.length - 1 : 0; // titik sambung antar-leg dipakai sekali
    const pts = decodePolyline(leg.shape, 6);
    coordinates.push(...(coordinates.length ? pts.slice(1) : pts));
    for (const m of leg.maneuvers || []) {
      const idx = Math.min(m.begin_shape_index + offset, coordinates.length - 1);
      maneuvers.push({
        type: m.type,
        instruction: m.instruction || "",
        verbal: m.verbal_pre_transition_instruction || m.instruction || "",
        verbalPost: m.verbal_post_transition_instruction || "",
        streets: m.street_names || [],
        distanceKm: m.length || 0,
        durationSec: m.time || 0,
        startIndex: idx,
        endIndex: Math.min(m.end_shape_index + offset, coordinates.length - 1),
        lat: coordinates[idx][0],
        lon: coordinates[idx][1],
      });
    }
  }
  const cumM = [0];
  for (let i = 1; i < coordinates.length; i++) {
    cumM.push(cumM[i - 1] + haversineM(coordinates[i - 1][0], coordinates[i - 1][1], coordinates[i][0], coordinates[i][1]));
  }
  let minLon = 180, minLat = 90, maxLon = -180, maxLat = -90;
  for (const [la, lo] of coordinates) {
    if (la < minLat) minLat = la;
    if (la > maxLat) maxLat = la;
    if (lo < minLon) minLon = lo;
    if (lo > maxLon) maxLon = lo;
  }
  return {
    distanceKm: trip.summary ? trip.summary.length : cumM[cumM.length - 1] / 1000,
    durationSec: trip.summary ? trip.summary.time : 0,
    coordinates, lngLat: toLngLat(coordinates), cumM, maneuvers,
    bounds: [minLon, minLat, maxLon, maxLat],
  };
}

// ---------- bantu navigasi ----------
/**
 * Proyeksikan posisi ke garis rute.
 * @returns {{index:number, distM:number, alongM:number}} segmen terdekat, jarak tegak lurus (m), jarak yang sudah ditempuh sepanjang rute (m)
 */
export function snapToRoute(pos, route) {
  const c = route.coordinates;
  const kx = 111320 * Math.cos(toRad(pos.lat)), ky = 110574;
  let best = { index: 0, distM: Infinity, alongM: 0 };
  for (let i = 0; i < c.length - 1; i++) {
    const x1 = (c[i][1] - pos.lon) * kx, y1 = (c[i][0] - pos.lat) * ky;
    const x2 = (c[i + 1][1] - pos.lon) * kx, y2 = (c[i + 1][0] - pos.lat) * ky;
    const dx = x2 - x1, dy = y2 - y1, len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, -(x1 * dx + y1 * dy) / len2)) : 0;
    const d = Math.hypot(x1 + t * dx, y1 + t * dy);
    if (d < best.distM) best = { index: i, distM: d, alongM: route.cumM[i] + t * (route.cumM[i + 1] - route.cumM[i]) };
  }
  return best;
}

/** Status navigasi: sisa jarak/waktu, belokan berikutnya, dan apakah keluar jalur. */
export function navProgress(pos, route, offRouteM = 50) {
  const s = snapToRoute(pos, route);
  const totalM = route.cumM[route.cumM.length - 1];
  const remainingM = Math.max(0, totalM - s.alongM);
  const ratio = totalM > 0 ? remainingM / totalM : 0;
  const found = route.maneuvers.findIndex((m) => m.startIndex > s.index);
  const nextIndex = found === -1 ? route.maneuvers.length - 1 : found;
  const next = route.maneuvers[nextIndex] || null;
  return {
    ...s, remainingM, remainingSec: Math.round(route.durationSec * ratio),
    next, nextIndex,
    distToNextM: next ? Math.max(0, route.cumM[next.startIndex] - s.alongM) : 0,
    arrived: remainingM < 25, offRoute: s.distM > offRouteM,
  };
}

export const fmtDistance = (m) => (m < 1000 ? `${Math.max(10, Math.round(m / 10) * 10)} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`);
export function fmtDuration(sec) {
  const m = Math.max(1, Math.round(sec / 60));
  return m < 60 ? `${m} mnt` : `${Math.floor(m / 60)} j ${m % 60} mnt`;
}
