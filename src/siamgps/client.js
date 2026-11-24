// SIAMGPS Public API client (Revision 1.2.2, 17 April 2026 — "เพิ่มน้ำมัน").
//
// The doc lives at data/API   SIAMGPS Public API  ใหม่ล่าสุด เพิ่มน้ำมัน.pdf.
// It replaces the Protrack365 connector as the source for the GPS page.
//
// Why this runs on the server and not in the Flutter page:
//   * the Bearer token grants read access to the whole fleet — it must not be
//     shipped to every browser that opens the dashboard;
//   * one cached upstream call serves every open tab.
//
// Responses are passed through in SIAMGPS's own shape (vehicleInfo, location
// GeoJSON [lng, lat], vehicleStatus, fuel, battery, input[] …). The page's
// models parse exactly what the doc describes, so the mockup and the real feed
// are the same code path.

export const SIAMGPS = {
  base: process.env.SIAMGPS_BASE ?? 'https://services.siamgpstrack.com',
  token: (process.env.SIAMGPS_TOKEN ?? '').trim(),
  timeoutMs: Number(process.env.SIAMGPS_TIMEOUT_MS ?? 10_000),
};

/** Playback refuses windows longer than this (doc p.27: "ไม่เกิน 3 วัน"). */
export const PLAYBACK_MAX_MS = 3 * 24 * 3600 * 1000;

export class SiamGpsError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    // No token / bad token / not allowed — a setup problem rather than an
    // outage, which is the case the simulator fallback exists for.
    this.needsSetup = status === null || status === 401 || status === 403;
  }
}

const MESSAGES = {
  400: 'คำขอไม่ถูกต้อง (400)',
  401: 'token ไม่ถูกต้องหรือไม่ได้ส่ง token (401)',
  403: 'token นี้ไม่มีสิทธิ์เรียกข้อมูลนี้ (403)',
};

async function get(path, query) {
  if (!SIAMGPS.token) {
    throw new SiamGpsError(null, 'ยังไม่ได้ตั้ง SIAMGPS_TOKEN ใน backend/.env');
  }
  const url = new URL(path, SIAMGPS.base);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }

  let res;
  try {
    res = await fetch(url, {
      headers: { authorization: `Bearer ${SIAMGPS.token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(SIAMGPS.timeoutMs),
    });
  } catch (e) {
    throw new SiamGpsError(502, `ต่อ SIAMGPS ไม่ได้ (${e.name === 'TimeoutError' ? 'timeout' : e.message})`);
  }

  let body = null;
  try {
    body = await res.json();
  } catch {
    // fall through — reported below with the HTTP status
  }
  if (!res.ok || (body && typeof body.status === 'number' && body.status !== 200)) {
    const status = res.ok ? body.status : res.status;
    throw new SiamGpsError(status, body?.message ?? MESSAGES[status] ?? `SIAMGPS ตอบ ${status}`);
  }
  return body;
}

/** GET /vehicles — every vehicle in the organisation. */
export const vehicles = () => get('/vehicles');

/** GET /realtime/list — the latest record for every vehicle (since 1.2.0). */
export const realtimeList = () => get('/realtime/list');

/** GET /realtime/listByVehicleId/{id} — the latest record for one vehicle. */
export const realtimeById = (id) => get(`/realtime/listByVehicleId/${encodeURIComponent(id)}`);

/**
 * GET /playback/listByVehicleId — history for one vehicle.
 * [startDate]/[endDate] are ISO 8601 in UTC; at most 3 days apart.
 */
export const playback = (vehicleId, startDate, endDate) =>
  get('/playback/listByVehicleId', { vehicleId, startDate, endDate });
