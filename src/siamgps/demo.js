// Mockup feed for the GPS page, shaped exactly like the SIAMGPS Public API
// (Revision 1.2.2 — the one that adds altitude, satellites and fuel):
//   location.coordinates  [lng, lat]  (GeoJSON order, not lat/lng!)
//   speed km/h · mileage metres · heading degrees · fuel % (-1 = no sensor)
//   battery.external/internal volts · vehicleStatus PARK|IDLE|MOVING|RUNNING
//
// What the trucks do comes from a real day of SOI8_DEL_FNISP_DATA
// (plan/day.js): the same plates, the same FOs, driving to the same delivery
// locations — positions and radii from the customer master. That day is
// replayed on today's clock, so the trips page, the geofence and the map all
// describe one consistent day.
//
// Each truck leaves the yard at its own time, drives to its FO locations in
// order (straight lines — a mockup, not a router), unloads, and drives back.
// Two trucks are parked at a customer for good, mid-delivery, and two have no
// job that day (one of them offline).

import { trucksInPlan } from '../plan/day.js';
import { AREAS, nearestArea } from '../plan/areas.js';
import { getMaster } from '../master/store.js';

const MIN = 60_000;
const TZ_MS = 7 * 60 * MIN; // Bangkok, no daylight saving
const DAY = 24 * 60 * MIN;

/** Epoch ms of the Bangkok midnight that starts the day containing [at]. */
export function localMidnight(at) {
  return Math.floor((at + TZ_MS) / DAY) * DAY - TZ_MS;
}

/** TP's yard (Soi 8) — every run starts and ends here. */
const YARD = [13.6693, 100.6425];
const YARD_ADDRESS = 'ลานจอดรถ TP ซอย 8 แขวงบางนา กรุงเทพมหานคร';

/** Trucks that stay at a customer for good, mid-delivery. */
const PARKED_AT_CUSTOMER = {
  '72-6364': { minutesAgo: 35, status: 'PARK' }, // delivered, still unloading 19 invoices
  'บต-8316': { minutesAgo: 4, status: 'IDLE' }, // just pulled in, not 10 minutes yet
};

/** Fleet vehicles with no job on the plan day. */
const SPARE = [
  { plate: 'ยข-4270', mot: '4W (2 Ton) Truck' },
  { plate: '72-5487', mot: '6W Truck', lastSeenMin: 312 },
];

const TYPE = {
  '4W (1 Ton) Truck': { name: 'กระบะ 1 ตัน', volt: 12, burn: 0.1 },
  '4W (2 Ton) Truck': { name: 'กระบะ 2 ตัน', volt: 12, burn: 0.12 },
  '4W (3-3.6 Ton) Truck': { name: '4 ล้อใหญ่ 3.5 ตัน', volt: 12, burn: 0.14 },
  '6W Truck': { name: '6 ล้อ', volt: 24, burn: 0.18 },
  '10W Truck': { name: '10 ล้อ', volt: 24, burn: 0.22 },
};
const typeOf = (mot) => TYPE[mot] ?? { name: mot || 'รถบรรทุก', volt: 24, burn: 0.15 };

// ── geometry ────────────────────────────────────────────────────────────────

const rad = (d) => (d * Math.PI) / 180;
function km([aLat, aLng], [bLat, bLng]) {
  const dLat = rad(bLat - aLat);
  const dLng = rad(bLng - aLng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}
function bearing([aLat, aLng], [bLat, bLng]) {
  const y = Math.sin(rad(bLng - aLng)) * Math.cos(rad(bLat));
  const x =
    Math.cos(rad(aLat)) * Math.sin(rad(bLat)) -
    Math.sin(rad(aLat)) * Math.cos(rad(bLat)) * Math.cos(rad(bLng - aLng));
  return Math.round(((Math.atan2(y, x) * 180) / Math.PI + 360) % 360);
}
/** Road time: straight-line distance × 1.3 at an average 48 km/h. */
const driveMs = (a, b) => Math.max(12, Math.round(((km(a, b) * 1.3) / 48) * 60)) * MIN;
const hash = (s) => [...String(s)].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);

// ── where an FO goes ────────────────────────────────────────────────────────

/** The delivery location of an FO, from the master (area centre if missing). */
function locationOf(fo) {
  const m = getMaster(fo.locationCode);
  if (m && m.lat != null && m.lng != null) {
    return { code: fo.locationCode, name: m.name, lat: m.lat, lng: m.lng, radiusM: m.radiusM ?? 300, area: m.route };
  }
  // No master entry yet: the area centre, spread a little per location (as
  // tools/build-master.mjs does) so two customers in one estate never share
  // a point — the geofence could not tell them apart.
  const [aLat, aLng] = AREAS[fo.route] ?? YARD;
  const h = hash(fo.locationCode);
  const angle = ((h % 360) * Math.PI) / 180;
  const metres = 400 + (h % 1100);
  return {
    code: fo.locationCode,
    name: fo.locationName,
    lat: aLat + (metres * Math.cos(angle)) / 111_320,
    lng: aLng + (metres * Math.sin(angle)) / (111_320 * Math.cos(rad(aLat))),
    radiusM: 300,
    area: fo.route,
  };
}

// ── the fleet and its day ───────────────────────────────────────────────────

/** Vehicles with their segments for the day of [now]. Rebuilt per call. */
function buildFleet(now) {
  const midnight = localMidnight(now);
  const plan = trucksInPlan();
  const plates = [...plan.keys()].sort();
  const fleet = [];
  let id = 311201;

  plates.forEach((plate, i) => {
    const fos = plan.get(plate);
    const t = typeOf(fos[0].mot);
    const v = {
      id: id++, plate, type: t.name, volt: t.volt, burn: t.burn, fos,
      fuelBase: plate === 'บว 9361' ? 31 : 62 + (hash(plate) % 33),
      noFuelSensor: plate === '73-3301',
      door: t.volt === 24 ? 'ประตูตู้สินค้า' : null,
      segs: [],
    };
    const anchored = PARKED_AT_CUSTOMER[plate];
    if (anchored) {
      const dest = locationOf(fos[0]);
      const at = [dest.lat, dest.lng];
      const arrive = now - anchored.minutesAgo * MIN;
      const leave = arrive - driveMs(YARD, at);
      v.segs.push({ k: 'park', from: -Infinity, to: leave, at: YARD });
      v.segs.push({ k: 'drive', from: leave, to: arrive, a: YARD, b: at, fo: fos[0] });
      v.segs.push({ k: 'stop', from: arrive, to: Infinity, at, fo: fos[0], status: anchored.status });
    } else {
      // Staggered departures from 06:40, as a dispatcher would send them.
      let t0 = midnight + (6 * 60 + 40 + i * 17) * MIN;
      let pos = YARD;
      v.segs.push({ k: 'park', from: -Infinity, to: t0, at: YARD });
      for (const fo of fos) {
        const dest = locationOf(fo);
        const at = [dest.lat, dest.lng];
        const d = driveMs(pos, at);
        v.segs.push({ k: 'drive', from: t0, to: t0 + d, a: pos, b: at, fo });
        t0 += d;
        const dwell = (25 + (hash(fo.foId) % 30)) * MIN; // unloading 25–54 min
        v.segs.push({ k: 'stop', from: t0, to: t0 + dwell, at, fo });
        t0 += dwell;
        pos = at;
      }
      const back = driveMs(pos, YARD);
      v.segs.push({ k: 'drive', from: t0, to: t0 + back, a: pos, b: YARD, fo: null });
      v.segs.push({ k: 'park', from: t0 + back, to: Infinity, at: YARD });
    }
    fleet.push(v);
  });

  for (const s of SPARE) {
    const t = typeOf(s.mot);
    fleet.push({
      id: id++, plate: s.plate, type: t.name, volt: t.volt, burn: t.burn, fos: [],
      fuelBase: 70 + (hash(s.plate) % 25), noFuelSensor: false, door: null,
      lastSeenMin: s.lastSeenMin ?? null,
      segs: [{ k: 'park', from: -Infinity, to: Infinity, at: YARD }],
    });
  }
  return fleet;
}

/** Where [v] is at [t], plus the numbers a tracker would report. */
function stateAt(v, t) {
  let kmDone = 0;
  let seg = v.segs[0];
  for (const s of v.segs) {
    if (t >= s.from && t < s.to) {
      seg = s;
      break;
    }
    if (s.k === 'drive' && t >= s.to) kmDone += km(s.a, s.b);
  }
  let lat;
  let lng;
  let heading = 0;
  let speed = 0;
  let status = 'PARK';
  let address = YARD_ADDRESS;
  let doorOpen = false;

  if (seg.k === 'drive') {
    const f = Math.min(1, Math.max(0, (t - seg.from) / (seg.to - seg.from)));
    lat = seg.a[0] + (seg.b[0] - seg.a[0]) * f;
    lng = seg.a[1] + (seg.b[1] - seg.a[1]) * f;
    kmDone += km(seg.a, seg.b) * f;
    heading = bearing(seg.a, seg.b);
    // Slow at both ends (yards, estate gates), cruising in between.
    const edge = Math.min(t - seg.from, seg.to - t) < 4 * MIN;
    const cruise = Math.min(85, 38 + km(seg.a, seg.b) * 0.5);
    speed = Math.max(8, Math.round((edge ? 22 : cruise) + Math.sin(t / 47_000 + v.id) * 5));
    status = speed > 60 ? 'RUNNING' : 'MOVING';
    address = `ระหว่างทาง · ใกล้${nearestArea(lat, lng)}`;
  } else {
    [lat, lng] = seg.at;
    if (seg.k === 'stop') {
      status = seg.status ?? (t - seg.from < 3 * MIN ? 'IDLE' : 'PARK');
      address = `${seg.fo.locationName} (${seg.fo.route})`;
      doorOpen = true;
    }
  }
  const fuel = v.noFuelSensor ? -1 : Math.max(4, Math.round(v.fuelBase - kmDone * v.burn));
  return { lat, lng, heading, speed, status, address, doorOpen, kmDone, fuel };
}

// ── payload builders (SIAMGPS shape) ────────────────────────────────────────

const vehicleInfo = (v) => ({ _id: v.id, _name: `${v.plate} ${v.type}`, _vehiPlateNo: v.plate });
const point = (lat, lng) => ({
  type: 'Point',
  coordinates: [Number(lng.toFixed(6)), Number(lat.toFixed(6))],
});

function record(v, at, { withInfo, exact = false }) {
  const offline = v.lastSeenMin != null;
  const t = offline ? Math.min(at, Date.now() - v.lastSeenMin * MIN) : at;
  const s = stateAt(v, t);
  const step = s.status === 'PARK' ? 5 * MIN : 30_000;
  const time = exact || offline ? t : Math.floor(t / step) * step;
  const engineOn = s.status !== 'PARK';
  const nominal = v.volt === 24 ? (engineOn ? 27.6 : 24.8) : engineOn ? 13.9 : 12.6;
  const r = {
    location: point(s.lat, s.lng),
    gpsFix: !offline,
    time: new Date(time).toISOString(),
    speed: s.speed,
    mileage: Math.round(80_000_000 + (hash(v.plate) % 90_000) * 1000 + s.kmDone * 1000),
    heading: s.heading,
    altitude: 3 + (v.id % 9),
    satellites: offline ? 0 : s.speed > 0 ? 14 + (Math.floor(at / 90_000) % 6) : 11,
    fuel: s.fuel,
    battery: {
      external: Number((nominal + Math.sin(at / 600_000 + v.id) * 0.15).toFixed(2)),
      internal: Number((3.95 + Math.sin(v.id) * 0.2).toFixed(2)),
    },
    geoLocation: { sGeo: s.address, locale: 'TH' },
    vehicleStatus: s.status,
    input: [
      v.door
        ? { inputNumber: 1, isEnable: true, inputStatus: s.doorOpen ? 'OPEN' : 'CLOSE', inputName: v.door }
        : { inputNumber: 1, isEnable: false },
      { inputNumber: 2, isEnable: false },
    ],
  };
  return withInfo ? { vehicleInfo: vehicleInfo(v), ...r } : r;
}

// ── the endpoints ───────────────────────────────────────────────────────────

/** GET /vehicles */
export function demoVehicles() {
  const fleet = buildFleet(Date.now());
  const created = '2025-03-01T02:00:00.000Z';
  return {
    status: 200,
    totalRecord: fleet.length,
    data: fleet.map((v) => ({ ...vehicleInfo(v), updatedAt: created, createdAt: created, vehiRegDate: created })),
  };
}

/** GET /realtime/list */
export function demoRealtimeList(at = Date.now()) {
  const fleet = buildFleet(at);
  return { status: 200, totalRecord: fleet.length, data: fleet.map((v) => record(v, at, { withInfo: true })) };
}

function playbackOf(v, startMs, endMs) {
  const data = [];
  const last = v.lastSeenMin != null ? Date.now() - v.lastSeenMin * MIN : endMs;
  for (let t = Math.ceil(startMs / MIN) * MIN; t <= Math.min(endMs, last); t += MIN) {
    data.push(record(v, t, { withInfo: false, exact: true }));
  }
  return { status: 200, totalRecord: data.length, vehicleInfo: vehicleInfo(v), data };
}

/** GET /playback/listByVehicleId — one record per minute, exact timestamps. */
export function demoPlayback(vehicleId, startMs, endMs) {
  const v = buildFleet(Date.now()).find((f) => f.id === Number(vehicleId));
  if (!v) return { status: 200, totalRecord: 0, vehicleInfo: null, data: [] };
  return playbackOf(v, startMs, endMs);
}

/** Every vehicle's records from [startMs] to [endMs] — the geofence input. */
export function demoTracks(startMs, endMs) {
  return buildFleet(Date.now()).map((v) => {
    const pb = playbackOf(v, startMs, endMs);
    return { vehicleInfo: pb.vehicleInfo, data: pb.data };
  });
}

/** The plan day's delivery locations as geofence customers. */
export function demoCustomers() {
  const seen = new Map();
  for (const fos of trucksInPlan().values()) {
    for (const fo of fos) {
      if (seen.has(fo.locationCode)) continue;
      const l = locationOf(fo);
      seen.set(fo.locationCode, { id: l.code, name: l.name, lat: l.lat, lng: l.lng, radiusM: l.radiusM, area: l.area });
    }
  }
  return [...seen.values()];
}
