// Geofence delivery detection.
//
// Rule (from the office): a truck that stays stopped inside a customer's
// radius for DWELL minutes (10 by default) has delivered to that customer.
//
// Input is SIAMGPS-shaped tracks — { vehicleInfo, data: [record…] } with
// location.coordinates [lng, lat], time, speed — so the same code runs on the
// mockup and, later, on real /playback/listByVehicleId data.

const R = 6371000; // m

export function distanceM(aLat, aLng, bLat, bLng) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(bLat - aLat);
  const dLng = rad(bLng - aLng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** A truck under this speed counts as stopped (GPS jitter reads 1–3 km/h). */
const STOPPED_KMH = 5;

/**
 * Parked trackers report only every few minutes. A longer silence than this
 * inside the same circle is treated as the truck having left and come back.
 */
const MAX_GAP_MS = 20 * 60_000;

/** An unfinished stop whose last record is newer than this is still going on. */
const LIVE_MS = 15 * 60_000;

function parse(rec) {
  const loc = rec.location ?? rec.localtion;
  const c = loc?.coordinates;
  const time = Date.parse(rec.time);
  if (!Array.isArray(c) || Number.isNaN(time)) return null;
  return { lng: Number(c[0]), lat: Number(c[1]), time, speed: Number(rec.speed) || 0 };
}

/** The customer whose circle contains the point (nearest centre wins). */
function customerAt(customers, lat, lng) {
  let best = null;
  let bestD = Infinity;
  for (const c of customers) {
    const d = distanceM(lat, lng, c.lat, c.lng);
    if (d <= c.radiusM && d < bestD) {
      best = c;
      bestD = d;
    }
  }
  return best;
}

/**
 * Every stop of every truck inside a customer circle.
 * Returns [{ customerId, vehicleId, plate, from, to, ongoing }] (epoch ms).
 */
export function findStops(customers, tracks, { now = Date.now() } = {}) {
  const stops = [];
  for (const track of tracks) {
    const info = track.vehicleInfo;
    if (!info) continue;
    const vehicleId = info._id;
    const plate = (info._vehiPlateNo ?? '').trim() || (info._name ?? '').trim();
    const recs = (track.data ?? []).map(parse).filter(Boolean).sort((a, b) => a.time - b.time);

    let open = null; // { customer, from, to }
    const close = (ongoing) => {
      if (!open) return;
      stops.push({
        customerId: open.customer.id,
        vehicleId,
        plate,
        from: open.from,
        to: ongoing ? now : open.to,
        ongoing,
      });
      open = null;
    };

    for (const r of recs) {
      const c = r.speed < STOPPED_KMH ? customerAt(customers, r.lat, r.lng) : null;
      if (open && (!c || c.id !== open.customer.id || r.time - open.to > MAX_GAP_MS)) close(false);
      if (c) {
        if (open) open.to = r.time;
        else open = { customer: c, from: r.time, to: r.time };
      }
    }
    // Still standing there at the latest record?
    close(open != null && now - open.to < LIVE_MS);
  }
  return stops;
}

/**
 * Each customer's state for the window the tracks cover:
 *   delivered — a stop of dwellMs or longer (first one wins)
 *   dwelling  — a truck is there right now, not long enough yet
 *   pending   — neither (short stops are listed, but do not count)
 */
export function customerStatus(customers, stops, { dwellMs, now = Date.now() }) {
  return customers.map((c) => {
    const mine = stops
      .filter((s) => s.customerId === c.id)
      .sort((a, b) => a.from - b.from)
      .map((s) => ({ ...s, minutes: Math.floor((s.to - s.from) / 60_000) }));

    const done = mine.find((s) => s.to - s.from >= dwellMs);
    const here = mine.find((s) => s.ongoing);

    let status = 'pending';
    if (done) status = 'delivered';
    else if (here) status = 'dwelling';

    const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());
    return {
      ...c,
      status,
      deliveredAt: done ? iso(done.from + dwellMs) : null,
      deliveredBy: done ? { vehicleId: done.vehicleId, plate: done.plate } : null,
      // Whoever is inside the circle now, delivered or not.
      present: here
        ? {
            vehicleId: here.vehicleId,
            plate: here.plate,
            since: iso(here.from),
            minutes: Math.floor((now - here.from) / 60_000),
          }
        : null,
      visits: mine.map((s) => ({
        vehicleId: s.vehicleId,
        plate: s.plate,
        from: iso(s.from),
        to: s.ongoing ? null : iso(s.to),
        minutes: s.minutes,
        counted: s.to - s.from >= dwellMs,
      })),
    };
  });
}
