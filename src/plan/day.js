// The delivery plan the mockup runs: one real day of SOI8_DEL_FNISP_DATA
// (mot_name <> 'customer'), snapshotted read-only into backend/data/
// soi8_day.json. "Today" in the mockup is that day replayed on today's clock.
//
// Every FO goes to exactly one delivery location (true in a year of data);
// a truck with two FOs runs them one after the other.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../data/soi8_day.json',
);

let cache = null;

/** { day, source, fos: [{ foId, plate, driver, mot, carrier, route, locationCode, locationName, customers, docs }] } */
export function loadDay() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    cache = { day: null, fos: [] };
  }
  return cache;
}

/** FOs grouped by truck plate, each in running order. */
export function trucksInPlan() {
  const byPlate = new Map();
  for (const fo of loadDay().fos) {
    if (!byPlate.has(fo.plate)) byPlate.set(fo.plate, []);
    byPlate.get(fo.plate).push(fo);
  }
  for (const list of byPlate.values()) list.sort((a, b) => a.foId.localeCompare(b.foId));
  return byPlate;
}
