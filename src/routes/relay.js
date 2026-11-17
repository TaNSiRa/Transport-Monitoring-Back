// Everything in here is the CLOUD RELAY. It is the only piece exposed to the
// internet, and it holds nothing but today's stop list and the driver's taps.
// No ERP data, no pricing, no customer master - if it leaked, the damage is
// "someone learned which trucks went where today".

import { Router } from 'express';
import crypto from 'node:crypto';
import {
  relayDb,
  relayJobsFor,
  relayStopsOfDriver,
  recordRelayEvent,
  PIN_PEPPER,
} from '../db.js';
import { hashPin, safeEqual } from '../logic/pin.js';
import { tripStatus, isActive, STOP_STATUS } from '../logic/state.js';

export const relayRouter = Router();

const RELAY_KEY = process.env.RELAY_KEY ?? 'dev-relay-key';
const LINE_CHANNEL_ID = process.env.LINE_CHANNEL_ID ?? '';

// -------------------------------------------------------- internal-only side

function requireRelayKey(req, res, next) {
  if (req.get('x-relay-key') !== RELAY_KEY) {
    return res.status(401).json({ error: 'bad relay key' });
  }
  next();
}

/** Rows of `incoming` replace same-key rows of `existing`; returns a new array. */
function upsertBy(existing, incoming, key) {
  const merged = new Map(existing.map((row) => [row[key], row]));
  for (const row of incoming) merged.set(row[key], row);
  return [...merged.values()];
}

/**
 * Sync worker pushes today's plan up, one slice at a time. Every row is an
 * upsert - same as relay-worker/src/index.js - because a slice holds only part
 * of the plan and must not erase the slices that landed before it.
 */
relayRouter.post('/jobs', requireRelayKey, (req, res) => {
  const { date, trips = [], stops = [], drivers = [] } = req.body ?? {};
  if (!date) return res.status(400).json({ error: 'date required' });

  const jobs = relayJobsFor(date) ?? { date, trips: [], stops: new Map(), drivers: [] };

  for (const s of stops) {
    // Carry over live state so a re-push does not wipe what drivers already did.
    const old = jobs.stops.get(s.stopId);
    jobs.stops.set(s.stopId, {
      ...s,
      status: old?.status ?? STOP_STATUS.WAITING,
      visitOrder: old?.visitOrder ?? null,
      startedAt: old?.startedAt ?? null,
      checkinAt: old?.checkinAt ?? null,
      checkoutAt: old?.checkoutAt ?? null,
    });
  }
  jobs.trips = upsertBy(jobs.trips, trips, 'tripId');
  jobs.drivers = upsertBy(jobs.drivers, drivers, 'driverCode');

  relayDb.jobs.set(date, jobs);
  res.json({ ok: true, date, trips: trips.length, stops: stops.length });
});

/** Sync worker pulls driver taps down. Cursor-based, so nothing is missed. */
relayRouter.get('/events', requireRelayKey, (req, res) => {
  const since = Number(req.query.since ?? 0);
  const limit = Math.min(Number(req.query.limit ?? 500), 1000);
  const batch = relayDb.events.filter((e) => e.seq > since).slice(0, limit);
  res.json({
    events: batch,
    cursor: batch.length ? batch[batch.length - 1].seq : since,
    hasMore: relayDb.events.some((e) => e.seq > (batch.at(-1)?.seq ?? since)),
  });
});

// ------------------------------------------------------------- driver's side

/**
 * In production the client sends liff.getIDToken() and this verifies it with
 * LINE, because anything the client claims about itself can be forged.
 * With no channel configured we fall back to trusting the id, for local dev only.
 */
async function resolveLineUserId({ idToken, devUserId }) {
  if (idToken && LINE_CHANNEL_ID) {
    const body = new URLSearchParams({ id_token: idToken, client_id: LINE_CHANNEL_ID });
    const r = await fetch('https://api.line.me/oauth2/v2.1/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!r.ok) return null;
    const claims = await r.json();
    return claims.sub ?? null;
  }
  return devUserId ?? null; // DEV ONLY
}

function issueSession(lineUserId, driverCode) {
  const token = crypto.randomBytes(24).toString('hex');
  relayDb.sessions.set(token, { driverCode, lineUserId, issuedAt: Date.now() });
  return token;
}

function requireDriver(req, res, next) {
  const token = (req.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  const session = relayDb.sessions.get(token);
  if (!session) return res.status(401).json({ error: 'NO_SESSION' });
  req.driver = session;
  next();
}

/** Opening the LIFF app: already bound -> straight to work, else ask for PIN. */
relayRouter.post('/auth/session', async (req, res) => {
  const lineUserId = await resolveLineUserId(req.body ?? {});
  if (!lineUserId) return res.status(401).json({ error: 'NO_LINE_IDENTITY' });

  const driverCode = relayDb.bindings.get(lineUserId);
  if (!driverCode) return res.json({ bound: false, lineUserId });

  res.json({ bound: true, lineUserId, token: issueSession(lineUserId, driverCode), driverCode });
});

/** First run on a new phone: driver code + PIN handed out by the office. */
relayRouter.post('/auth/bind', async (req, res) => {
  const { driverCode, pin } = req.body ?? {};
  const lineUserId = await resolveLineUserId(req.body ?? {});
  if (!lineUserId) return res.status(401).json({ error: 'NO_LINE_IDENTITY' });

  const date = [...relayDb.jobs.keys()].sort().at(-1);
  const driver = relayJobsFor(date)?.drivers.find((d) => d.driverCode === driverCode);
  const attempt = driver ? await hashPin(PIN_PEPPER, driverCode, pin ?? '') : '';
  if (!driver || !safeEqual(attempt, driver.pinHash ?? '')) {
    return res.status(401).json({ error: 'BAD_CREDENTIALS', message: 'รหัสคนขับหรือ PIN ไม่ถูกต้อง' });
  }

  relayDb.bindings.set(lineUserId, driverCode);
  res.json({ bound: true, lineUserId, token: issueSession(lineUserId, driverCode), driverCode });
});

relayRouter.post('/auth/logout', requireDriver, (req, res) => {
  const token = (req.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  relayDb.sessions.delete(token);
  relayDb.bindings.delete(req.driver.lineUserId);
  res.json({ ok: true });
});

/**
 * The most recent day this driver has work for - mirrors latestDate() in
 * relay-worker/src/index.js. Scoped per driver on purpose: a fleet-wide latest
 * date would empty every driver's screen the moment anyone's tomorrow is pushed.
 */
function latestDateOf(driverCode) {
  return [...relayDb.jobs.keys()]
    .sort()
    .filter((d) => relayJobsFor(d)?.trips.some((t) => t.driverCode === driverCode))
    .at(-1);
}

/** Today's work for THIS driver only - never the whole fleet. */
relayRouter.get('/me/jobs', requireDriver, (req, res) => {
  const date = req.query.date ?? latestDateOf(req.driver.driverCode);
  const jobs = relayJobsFor(date);
  if (!jobs) return res.json({ date, driver: null, trips: [] });

  const driver = jobs.drivers.find((d) => d.driverCode === req.driver.driverCode);
  const myStops = relayStopsOfDriver(date, req.driver.driverCode);
  const busyStop = myStops.find(isActive) ?? null;

  const trips = jobs.trips
    .filter((t) => t.driverCode === req.driver.driverCode)
    .sort((a, b) => a.round - b.round)
    .map((t) => {
      const stops = myStops
        .filter((s) => s.tripId === t.tripId)
        .sort((a, b) => {
          if (a.visitOrder && b.visitOrder) return a.visitOrder - b.visitOrder;
          if (a.visitOrder) return -1;
          if (b.visitOrder) return 1;
          return a.plannedSeq - b.plannedSeq;
        })
        .map((s) => ({ ...s, nextAction: nextActionFor(s, busyStop) }));
      return { ...t, status: tripStatus(stops), stops };
    });

  res.json({
    date,
    driver: driver ? { driverCode: driver.driverCode, name: driver.name, truckNo: driver.truckNo } : null,
    busyStopId: busyStop?.stopId ?? null,
    trips,
  });
});

/**
 * What the one big button on screen should say, and whether it is tappable.
 * Computed on the server so the phone can never invent a state of its own.
 */
function nextActionFor(stop, busyStop) {
  switch (stop.status) {
    case STOP_STATUS.WAITING:
      return busyStop
        ? { action: 'start', enabled: false, label: 'START', reason: `ต้อง check out ${busyStop.customerName} ก่อน` }
        : { action: 'start', enabled: true, label: 'START', reason: null };
    case STOP_STATUS.ENROUTE:
      return { action: 'checkin', enabled: true, label: 'CHECK IN', reason: null };
    case STOP_STATUS.ARRIVED:
      return { action: 'checkout', enabled: true, label: 'CHECK OUT', reason: null };
    default:
      return null;
  }
}

/** The tap itself. Idempotent, so retries after a dropped signal are safe. */
relayRouter.post('/events', requireDriver, (req, res) => {
  const { stopId, action, clientTs, lat, lng, accuracy, dedupeKey } = req.body ?? {};
  if (!stopId || !action) return res.status(400).json({ error: 'stopId and action required' });

  const date = [...relayDb.jobs.keys()].sort().at(-1);
  const stop = relayJobsFor(date)?.stops.get(stopId);
  if (!stop) return res.status(404).json({ error: 'STOP_NOT_FOUND' });

  // A driver may only move their own stops.
  const mine = relayStopsOfDriver(date, req.driver.driverCode).some((s) => s.stopId === stopId);
  if (!mine) return res.status(403).json({ error: 'NOT_YOUR_STOP' });

  const result = recordRelayEvent({
    date,
    stopId,
    action,
    clientTs,
    lat,
    lng,
    accuracy,
    driverCode: req.driver.driverCode,
    lineUserId: req.driver.lineUserId,
    dedupeKey: dedupeKey || `${stopId}:${action}`,
  });

  if (!result.ok) return res.status(409).json(result);
  res.json({ ok: true, duplicate: result.duplicate, event: result.event });
});
