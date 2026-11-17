// A stand-in for the Protrack feed.
//
// The DEMO65558 account authenticates fine but has no Open API entitlement
// (the platform answers 10007 "permission denied"), so there is nothing real
// to draw until the service provider switches it on. Rather than show an empty
// map, /internal/gps falls back to this simulator and labels the response
// `source: "demo"` — the page puts a badge on screen so nobody mistakes a
// simulated truck for a real one.
//
// The shape it returns is exactly what client.js produces, so the page, the
// models and the map layers are the same code on either source.

const IMEI = process.env.PROTRACK_IMEIS?.split(',')[0]?.trim() || '358069580065558';

export const DEMO_DEVICES = [
  {
    imei: IMEI,
    name: 'WN03D-65558',
    model: 'VT03D',
    plate: 'DEMO-65558',
    simcard: '',
    expiresAt: null,
  },
];

// A delivery loop through eastern Bangkok. Coarse on purpose — it only has to
// look like a truck on real roads, not match a lane.
const ROUTE = [
  [13.7563, 100.5018], // Bangkok centre
  [13.7470, 100.5340],
  [13.7308, 100.5605],
  [13.7245, 100.5860],
  [13.7090, 100.6110],
  [13.6880, 100.6180],
  [13.6685, 100.6050],
  [13.6620, 100.5780],
  [13.6790, 100.5490],
  [13.7010, 100.5240],
  [13.7260, 100.5080],
  [13.7563, 100.5018], // back to the yard
];

const LOOP_MS = 60 * 60 * 1000; // one lap an hour
const R = 6371; // km

function haversine([aLat, aLng], [bLat, bLng]) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(bLat - aLat);
  const dLng = rad(bLng - aLng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function bearing([aLat, aLng], [bLat, bLng]) {
  const rad = (d) => (d * Math.PI) / 180;
  const y = Math.sin(rad(bLng - aLng)) * Math.cos(rad(bLat));
  const x =
    Math.cos(rad(aLat)) * Math.sin(rad(bLat)) -
    Math.sin(rad(aLat)) * Math.cos(rad(bLat)) * Math.cos(rad(bLng - aLng));
  return Math.round((((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360);
}

// Cumulative distance along ROUTE, so progress is by metres travelled rather
// than by waypoint index — otherwise the truck crawls on long legs.
const LEGS = ROUTE.slice(0, -1).map((p, i) => haversine(p, ROUTE[i + 1]));
const TOTAL_KM = LEGS.reduce((a, b) => a + b, 0);

/** Where the truck is at [at], as a fraction 0..1 of the loop. */
function positionAt(at) {
  const phase = ((at % LOOP_MS) + LOOP_MS) % LOOP_MS / LOOP_MS;
  let target = phase * TOTAL_KM;

  for (let i = 0; i < LEGS.length; i++) {
    if (target > LEGS[i]) {
      target -= LEGS[i];
      continue;
    }
    const t = LEGS[i] === 0 ? 0 : target / LEGS[i];
    const [aLat, aLng] = ROUTE[i];
    const [bLat, bLng] = ROUTE[i + 1];
    return {
      lat: aLat + (bLat - aLat) * t,
      lng: aLng + (bLng - aLng) * t,
      course: bearing(ROUTE[i], ROUTE[i + 1]),
      legIndex: i,
    };
  }
  const [lat, lng] = ROUTE.at(-1);
  return { lat, lng, course: 0, legIndex: LEGS.length - 1 };
}

// Two stops per lap, so the page has something to show for "parked" as well.
const isStopped = (at) => {
  const minute = Math.floor((at % LOOP_MS) / 60000);
  return (minute >= 18 && minute < 23) || (minute >= 44 && minute < 48);
};

/** Same shape as client.js normaliseFix(). */
export function demoTrack(imeis, at = Date.now()) {
  const wanted = new Set(imeis.length ? imeis : DEMO_DEVICES.map((d) => d.imei));
  return DEMO_DEVICES.filter((d) => wanted.has(d.imei)).map((d) => {
    const p = positionAt(at);
    const stopped = isStopped(at);
    const lapKm = (((at % LOOP_MS) / LOOP_MS) * TOTAL_KM);
    return {
      imei: d.imei,
      lat: Number(p.lat.toFixed(6)),
      lng: Number(p.lng.toFixed(6)),
      course: p.course,
      speed: stopped ? 0 : 28 + ((p.legIndex * 7) % 22),
      moving: !stopped,
      state: 'ok',
      gpsAt: new Date(at).toISOString(),
      heartAt: new Date(at).toISOString(),
      serverAt: new Date(at).toISOString(),
      accStatus: stopped ? 0 : 1,
      accSince: null,
      doorStatus: stopped ? 1 : 0,
      chargeStatus: 1,
      battery: 92,
      mileageKm: Number((12480 + lapKm).toFixed(2)),
      todayKm: Number(lapKm.toFixed(2)),
      externalPower: '13.8',
      temperature: ['31.4'],
    };
  });
}

/** Same shape as client.js playback(): one point every 30s over the window. */
export function demoPlayback(_imei, beginSec, endSec) {
  const step = 30_000;
  const points = [];
  for (let t = beginSec * 1000; t <= endSec * 1000 && points.length < 1000; t += step) {
    const p = positionAt(t);
    points.push({
      lat: Number(p.lat.toFixed(6)),
      lng: Number(p.lng.toFixed(6)),
      at: new Date(t).toISOString(),
      speed: isStopped(t) ? 0 : 28 + ((p.legIndex * 7) % 22),
      course: p.course,
    });
  }
  return points;
}
