// GPS tracking, proxied from Protrack365.
//
// Mounted under /internal because it belongs to the office dashboard, not to
// the driver relay. The browser never sees the Protrack password or token —
// it only ever talks to this router.

import { Router } from 'express';
import * as protrack from '../protrack/client.js';
import { PROTRACK, ProtrackError } from '../protrack/client.js';
import { DEMO_DEVICES, demoTrack, demoPlayback } from '../protrack/demo.js';

export const gpsRouter = Router();

// live -> always Protrack, surface errors.
// demo -> never call Protrack.
// auto -> try Protrack, fall back to the simulator so the page still works.
const MODE = process.env.PROTRACK_MODE ?? 'auto';

// Protrack answers 10009 when called too often, and every open dashboard tab
// polls. One upstream call per window serves all of them.
const TRACK_CACHE_MS = Number(process.env.PROTRACK_TRACK_CACHE_MS ?? 8000);
let trackCache = null; // { key, at, payload }

/** What the last upstream attempt told us — shown in the page's footer. */
let lastUpstream = { ok: null, code: null, message: null, at: null };

function noteUpstream(error) {
  lastUpstream = {
    ok: !error,
    code: error?.code ?? null,
    message: error?.message ?? null,
    at: new Date().toISOString(),
  };
}

/**
 * Runs [live], and on failure decides whether the simulator may answer.
 * A provisioning problem (10007 / 10013) is exactly the case the fallback
 * exists for; anything else in `live` mode is a real error and propagates.
 */
async function resolve(live, demo) {
  if (MODE === 'demo') return { source: 'demo', data: demo() };
  try {
    const data = await live();
    noteUpstream(null);
    return { source: 'live', data };
  } catch (e) {
    noteUpstream(e);
    if (MODE === 'live') throw e;
    return {
      source: 'demo',
      data: demo(),
      fallback: { code: e.code ?? null, message: e.message },
    };
  }
}

function fail(res, e) {
  if (e instanceof ProtrackError) {
    return res.status(e.needsProvisioning ? 403 : 502).json({
      error: 'PROTRACK',
      code: e.code,
      message: e.message,
    });
  }
  return res.status(500).json({ error: 'INTERNAL', message: e.message });
}

/** Which devices this account can see. */
gpsRouter.get('/devices', async (_req, res) => {
  try {
    const { source, data, fallback } = await resolve(
      () => protrack.deviceList(),
      () => DEMO_DEVICES,
    );
    res.json({ source, fallback: fallback ?? null, devices: data });
  } catch (e) {
    fail(res, e);
  }
});

/** The latest fix per device — this is what the map polls. */
gpsRouter.get('/track', async (req, res) => {
  const imeis = String(req.query.imeis ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const wanted = imeis.length ? imeis : PROTRACK.imeis;

  if (wanted.length === 0) {
    return res.status(400).json({ error: 'NO_IMEI', message: 'ต้องระบุ imeis อย่างน้อยหนึ่งเครื่อง' });
  }
  if (wanted.length > 100) {
    return res.status(400).json({ error: 'TOO_MANY', message: 'ขอได้สูงสุด 100 IMEI ต่อครั้ง' });
  }

  const key = wanted.join(',');
  if (trackCache && trackCache.key === key && Date.now() - trackCache.at < TRACK_CACHE_MS) {
    return res.json({ ...trackCache.payload, cached: true });
  }

  try {
    const { source, data, fallback } = await resolve(
      () => protrack.track(wanted),
      () => demoTrack(wanted),
    );
    const payload = {
      source,
      fallback: fallback ?? null,
      at: new Date().toISOString(),
      fixes: data,
    };
    trackCache = { key, at: Date.now(), payload };
    res.json({ ...payload, cached: false });
  } catch (e) {
    fail(res, e);
  }
});

/** History for the route line. `from`/`to` accept ISO or unix seconds. */
gpsRouter.get('/playback', async (req, res) => {
  const imei = String(req.query.imei ?? '').trim() || PROTRACK.imeis[0];
  if (!imei) return res.status(400).json({ error: 'NO_IMEI', message: 'ต้องระบุ imei' });

  const to = parseTime(req.query.to) ?? Math.floor(Date.now() / 1000);
  const from = parseTime(req.query.from) ?? to - 6 * 3600;
  if (from >= to) {
    return res.status(400).json({ error: 'BAD_RANGE', message: 'ช่วงเวลาไม่ถูกต้อง' });
  }

  try {
    const { source, data, fallback } = await resolve(
      () => protrack.playback(imei, from, to),
      () => demoPlayback(imei, from, to),
    );
    res.json({
      source,
      fallback: fallback ?? null,
      imei,
      from: new Date(from * 1000).toISOString(),
      to: new Date(to * 1000).toISOString(),
      // 1000 is the API's page size — say so rather than let the page guess
      // why a long window looks clipped.
      truncated: data.length >= 1000,
      points: data,
    });
  } catch (e) {
    fail(res, e);
  }
});

/** Where the data is coming from, for the banner on the page. */
gpsRouter.get('/status', (_req, res) => {
  res.json({
    mode: MODE,
    account: PROTRACK.account,
    base: PROTRACK.base,
    defaultImeis: PROTRACK.imeis,
    upstream: lastUpstream,
  });
});

function parseTime(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  const d = Date.parse(String(v));
  return Number.isNaN(d) ? null : Math.floor(d / 1000);
}
