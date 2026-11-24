// Builds backend/data/customers.json — the customer master — from
//   locations.json  every delivery location in SOI8_DEL_FNISP_DATA
//                   (mot_name <> 'customer'), read-only via SOI8's history export
//   geocoded.json   OpenStreetMap Nominatim lookups for those locations
//
//   node tools/build-master.mjs <folder with locations.json + geocoded.json>
//
// Re-running keeps what the office already set on the Master page: a
// position marked "manual" and any radius that was changed.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(here, '../data/customers.json');
const DEFAULT_RADIUS = 300;

const src = process.argv[2];
if (!src) {
  console.error('usage: node tools/build-master.mjs <folder>');
  process.exit(1);
}
const locations = JSON.parse(fs.readFileSync(path.join(src, 'locations.json'), 'utf8'));
const geo = JSON.parse(fs.readFileSync(path.join(src, 'geocoded.json'), 'utf8'));
const previous = fs.existsSync(OUT)
  ? new Map(JSON.parse(fs.readFileSync(OUT, 'utf8')).customers.map((c) => [c.code, c]))
  : new Map();

const hash = (s) => [...String(s)].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);

/**
 * Many customers fall back to the same estate centre. Spread them on a small
 * spiral (0.4–1.5 km) so their pins do not sit on top of each other — still
 * flagged "area" so the page shows them as approximate.
 */
function spread(lat, lng, key) {
  const h = hash(key);
  const angle = ((h % 360) * Math.PI) / 180;
  const metres = 400 + (h % 1100);
  return [
    lat + (metres * Math.cos(angle)) / 111_320,
    lng + (metres * Math.sin(angle)) / (111_320 * Math.cos((lat * Math.PI) / 180)),
  ];
}

const customers = locations.map((l) => {
  const key = l.code || l.name;
  const g = geo[key] ?? { source: 'none' };
  const old = previous.get(l.code);
  let lat = g.lat ?? null;
  let lng = g.lng ?? null;
  if (g.source === 'area' && lat != null) [lat, lng] = spread(lat, lng, key);
  const manual = old?.geoSource === 'manual';
  return {
    code: l.code,
    name: l.name,
    route: l.route,
    customers: l.customers,
    fos: l.fos,
    lat: manual ? old.lat : lat == null ? null : Number(lat.toFixed(6)),
    lng: manual ? old.lng : lng == null ? null : Number(lng.toFixed(6)),
    geoSource: manual ? 'manual' : g.source,
    osmName: g.osmName ?? null,
    radiusM: old?.radiusM ?? DEFAULT_RADIUS,
    updatedAt: old?.updatedAt ?? null,
  };
});

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ customers }, null, 1));
const tally = {};
for (const c of customers) tally[c.geoSource] = (tally[c.geoSource] ?? 0) + 1;
console.log(`wrote ${customers.length} customers to ${OUT}`, JSON.stringify(tally));
