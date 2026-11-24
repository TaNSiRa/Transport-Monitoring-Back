// GPS tracking, proxied from the SIAMGPS Public API (Rev 1.2.2).
//
// Mounted under /internal because it belongs to the office dashboard. The
// browser never sees the SIAMGPS token — it only ever talks to this router.
//
// Every response is SIAMGPS's own envelope ({ status, totalRecord, data, … })
// plus three fields of ours:
//   source    "live" | "demo"  — the page shows a badge for demo data
//   fallback  why we fell back to the mockup, or null
//   at        when this answer was produced

import { Router } from 'express';
import * as siamgps from '../siamgps/client.js';
import { SIAMGPS, SiamGpsError, PLAYBACK_MAX_MS } from '../siamgps/client.js';
import { demoVehicles, demoRealtimeList, demoPlayback } from '../siamgps/demo.js';
import { MODE, lastUpstream, resolve } from '../siamgps/source.js';
import { today } from '../geofence/today.js';

export const gpsRouter = Router();

// Every open dashboard polls; one upstream call per window serves all of them.
const REALTIME_CACHE_MS = Number(process.env.SIAMGPS_REALTIME_CACHE_MS ?? 8000);
let realtimeCache = null; // { at, payload }

function fail(res, e) {
  if (e instanceof SiamGpsError) {
    return res.status(e.needsSetup ? 403 : 502).json({
      error: 'SIAMGPS',
      code: e.status,
      message: e.message,
    });
  }
  return res.status(500).json({ error: 'INTERNAL', message: e.message });
}

const envelope = ({ source, data, fallback }) => ({
  source,
  fallback,
  at: new Date().toISOString(),
  ...data,
});

/** GET /vehicles — the organisation's vehicle list. */
gpsRouter.get('/vehicles', async (_req, res) => {
  try {
    res.json(envelope(await resolve(() => siamgps.vehicles(), () => demoVehicles())));
  } catch (e) {
    fail(res, e);
  }
});

/** GET /realtime/list — latest record of every vehicle. This is what the map polls. */
gpsRouter.get('/realtime', async (_req, res) => {
  if (realtimeCache && Date.now() - realtimeCache.at < REALTIME_CACHE_MS) {
    return res.json({ ...realtimeCache.payload, cached: true });
  }
  try {
    const payload = envelope(
      await resolve(() => siamgps.realtimeList(), () => demoRealtimeList()),
    );
    realtimeCache = { at: Date.now(), payload };
    res.json({ ...payload, cached: false });
  } catch (e) {
    fail(res, e);
  }
});

/**
 * GET /playback?vehicleId=&startDate=&endDate=  (ISO 8601 UTC)
 * History for the route line. SIAMGPS caps the window at 3 days.
 */
gpsRouter.get('/playback', async (req, res) => {
  const vehicleId = Number(req.query.vehicleId);
  if (!Number.isInteger(vehicleId) || vehicleId <= 0) {
    return res.status(400).json({ error: 'NO_VEHICLE', message: 'ต้องระบุ vehicleId' });
  }
  const end = parseTime(req.query.endDate) ?? Date.now();
  const start = parseTime(req.query.startDate) ?? end - 6 * 3600 * 1000;
  if (start >= end) {
    return res.status(400).json({ error: 'BAD_RANGE', message: 'ช่วงเวลาไม่ถูกต้อง' });
  }
  if (end - start > PLAYBACK_MAX_MS) {
    return res
      .status(400)
      .json({ error: 'RANGE_TOO_LONG', message: 'ดูย้อนหลังได้ครั้งละไม่เกิน 3 วัน' });
  }

  const startDate = new Date(start).toISOString();
  const endDate = new Date(end).toISOString();
  try {
    res.json(
      envelope(
        await resolve(
          () => siamgps.playback(vehicleId, startDate, endDate),
          () => demoPlayback(vehicleId, start, end),
        ),
      ),
    );
  } catch (e) {
    fail(res, e);
  }
});

// ── customers + geofence delivery ────────────────────────────────────────────
//
// The plan day's delivery locations (positions and radii from the customer
// master) and today's delivery state per location — see geofence/today.js,
// which the trips page reads as well.

/** GET /customers — every customer, its radius, and today's delivery state. */
gpsRouter.get('/customers', async (_req, res) => {
  try {
    const t = await today();
    const count = (s) => t.customers.filter((c) => c.status === s).length;
    res.json({
      source: t.source,
      fallback: t.fallback,
      at: t.at,
      since: t.since,
      dwellMinutes: t.dwellMinutes,
      customersSource: 'master',
      summary: {
        total: t.customers.length,
        delivered: count('delivered'),
        dwelling: count('dwelling'),
        pending: count('pending'),
      },
      customers: t.customers,
    });
  } catch (e) {
    fail(res, e);
  }
});

/** Where the data is coming from — for debugging the badge on the page. */
gpsRouter.get('/status', (_req, res) => {
  res.json({
    provider: 'SIAMGPS Public API rev 1.2.2',
    mode: MODE,
    base: SIAMGPS.base,
    hasToken: SIAMGPS.token.length > 0,
    upstream: lastUpstream,
  });
});

function parseTime(v) {
  if (v === undefined || v === null || v === '') return null;
  const d = Date.parse(String(v));
  return Number.isNaN(d) ? null : d;
}
