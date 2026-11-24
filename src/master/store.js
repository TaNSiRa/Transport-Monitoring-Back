// Customer master: every SOI8 delivery location (where a truck actually
// drives to) with a position and a geofence radius.
//
// Built once from SOI8_DEL_FNISP_DATA (mot_name <> 'customer', read-only) and
// OpenStreetMap lookups — see backend/data/README.md. The office can then fix
// a position or change the radius from the Master page; edits are saved back
// to backend/data/customers.json and take effect on the geofence right away.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../data/customers.json',
);

export const RADIUS_MIN = 50;
export const RADIUS_MAX = 3000;

let cache = null; // { list, byCode }
const listeners = new Set();

function load() {
  if (cache) return cache;
  let list = [];
  try {
    list = JSON.parse(fs.readFileSync(FILE, 'utf8')).customers ?? [];
  } catch {
    list = [];
  }
  cache = { list, byCode: new Map(list.map((c) => [c.code, c])) };
  return cache;
}

function save() {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ customers: cache.list }, null, 1));
  fs.renameSync(tmp, FILE); // never leave a half-written master behind
  for (const fn of listeners) fn();
}

export const listMaster = () => load().list;
export const getMaster = (code) => load().byCode.get(code) ?? null;

/** Called whenever the master changes, so cached geofence results refresh. */
export function onMasterChange(fn) {
  listeners.add(fn);
}

/** Office edits: radius and/or position. Returns the updated entry. */
export function updateMaster(code, { radiusM, lat, lng } = {}) {
  const c = getMaster(code);
  if (!c) return null;
  if (radiusM != null) {
    const r = Math.round(Number(radiusM));
    if (!Number.isFinite(r) || r < RADIUS_MIN || r > RADIUS_MAX) {
      throw new RangeError(`รัศมีต้องอยู่ระหว่าง ${RADIUS_MIN}–${RADIUS_MAX} เมตร`);
    }
    c.radiusM = r;
  }
  if (lat != null || lng != null) {
    const la = Number(lat);
    const ln = Number(lng);
    // Thailand's bounding box, give or take — catches swapped lat/lng.
    if (!(la > 5 && la < 21 && ln > 97 && ln < 106)) {
      throw new RangeError('ตำแหน่งต้องอยู่ในประเทศไทย (ตรวจว่าไม่ได้สลับ lat/lng)');
    }
    c.lat = Number(la.toFixed(6));
    c.lng = Number(ln.toFixed(6));
    c.geoSource = 'manual';
  }
  c.updatedAt = new Date().toISOString();
  save();
  return c;
}
