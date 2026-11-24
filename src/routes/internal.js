// Everything in here is INSIDE the company network.
// The Flutter dashboard is the only client. Nothing on the internet may reach it.

import { Router } from 'express';
import { config } from '../config.js';
import { fetchDeliveries } from '../soi8/client.js';
import { overviewSteps } from '../soi8/overview.js';
import { today } from '../geofence/today.js';
import { buildTrips } from '../plan/trips.js';
import { listMaster, updateMaster, RADIUS_MIN, RADIUS_MAX } from '../master/store.js';

export const internalRouter = Router();

/** YYYY-MM-DD in Bangkok time. */
function todayISO(d = new Date()) {
  const local = new Date(d.getTime() + 7 * 3600_000);
  return local.toISOString().slice(0, 10);
}

// The 3D overview shows real data from the SOI8 Delivery Final Inspection API
// and nothing else: if SOI8 cannot answer, this endpoint fails (502) and the
// page says so — it never substitutes made-up numbers.

// SOI8 reads SAP on every call; every open screen (3D and card view alike)
// shares one call per window and date.
const SOI8_CACHE_MS = config.soi8.cacheMs;
const soi8Cache = new Map(); // date -> { at, rows }
const SOI8_CACHE_DAYS = 4; // today plus a few days someone paged back to

async function soi8Rows(date) {
  const hit = soi8Cache.get(date);
  if (hit && Date.now() - hit.at < SOI8_CACHE_MS) return hit.rows;
  const rows = await fetchDeliveries(date);
  soi8Cache.delete(date);
  soi8Cache.set(date, { at: Date.now(), rows });
  while (soi8Cache.size > SOI8_CACHE_DAYS) soi8Cache.delete(soi8Cache.keys().next().value);
  return rows;
}

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);

/** The five pipeline stations of the 3D overview — real SOI8 numbers only. */
internalRouter.get('/dashboard', async (req, res) => {
  const date = String(req.query.date ?? todayISO());
  if (!isDate(date)) return res.status(400).json({ error: 'BAD_DATE', message: 'date ต้องเป็น YYYY-MM-DD' });
  try {
    const steps = overviewSteps(await soi8Rows(date));
    res.json({ date, generatedAt: new Date().toISOString(), source: 'soi8', steps });
  } catch (e) {
    res.status(502).json({ error: 'SOI8', message: e.message });
  }
});

/**
 * The raw SOI8 delivery rows for one day — what the card-style Overview
 * (copied from SOI8's P01 page) counts and lists itself.
 */
internalRouter.get('/deliveries', async (req, res) => {
  const date = String(req.query.date ?? todayISO());
  if (!isDate(date)) return res.status(400).json({ error: 'BAD_DATE', message: 'date ต้องเป็น YYYY-MM-DD' });
  try {
    const rows = await soi8Rows(date);
    res.json({ date, generatedAt: new Date().toISOString(), source: 'soi8', rows });
  } catch (e) {
    res.status(502).json({ error: 'SOI8', message: e.message });
  }
});

/**
 * The trips page: one trip per FO of the plan day (a real day of
 * SOI8_DEL_FNISP_DATA, mot_name <> 'customer'), with stop states from today's
 * geofence — the same result the GPS page's customer tab shows.
 */
internalRouter.get('/trips', async (_req, res) => {
  try {
    const t = await today();
    const { planDay, trips } = buildTrips(t);
    res.json({ date: todayISO(), planDay, source: t.source, dwellMinutes: t.dwellMinutes, trips });
  } catch (e) {
    res.status(500).json({ error: 'INTERNAL', message: e.message });
  }
});

// ── customer master ─────────────────────────────────────────────────────────

/** GET /master/customers — every delivery location with position and radius. */
internalRouter.get('/master/customers', (_req, res) => {
  res.json({
    source:
      'SOI8_DEL_FNISP_DATA (mot_name <> customer, read-only) · ตำแหน่งจาก OpenStreetMap (ODbL)',
    radiusMin: RADIUS_MIN,
    radiusMax: RADIUS_MAX,
    customers: listMaster(),
  });
});

/** PATCH /master/customers/:code — { radiusM?, lat?, lng? } */
internalRouter.patch('/master/customers/:code', (req, res) => {
  try {
    const c = updateMaster(req.params.code, req.body ?? {});
    if (!c) return res.status(404).json({ error: 'NOT_FOUND', message: 'ไม่พบลูกค้ารหัสนี้' });
    res.json({ customer: c });
  } catch (e) {
    res.status(400).json({ error: 'BAD_VALUE', message: e.message });
  }
});
