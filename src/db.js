// Two deliberately separate in-memory stores.
//
//   internalDb  ->  lives inside the company. The dashboard reads only this.
//   relayDb     ->  lives on the cloud. The LIFF app talks only to this.
//
// Nothing reaches across directly. The only bridge is sync/worker.js, and it
// always dials outward: internal -> relay. That is the whole security story,
// so keeping the two objects apart here is intentional, not cosmetic.

import { buildPlan, historicalEvents, todayISO } from './seed.js';
import { STOP_STATUS, applyAction, validateAction } from './logic/state.js';
import { hashPin } from './logic/pin.js';

export const PIN_PEPPER = process.env.PIN_PEPPER ?? 'dev-pepper-change-me';

/// The driver list as the relay is allowed to see it: never the PIN itself.
export async function driversForRelay() {
  return Promise.all(
    internalDb.drivers.map(async (d) => ({
      driverCode: d.driverCode,
      name: d.name,
      truckNo: d.truckNo,
      pinHash: await hashPin(PIN_PEPPER, d.driverCode, d.pin),
    })),
  );
}

export const internalDb = {
  date: todayISO(),
  drivers: [],
  trips: [],
  stops: new Map(), // stopId -> stop
  appliedDedupeKeys: new Set(),
  relayCursor: 0, // last relay event seq we pulled in
  syncLog: [],
};

export const relayDb = {
  jobs: new Map(), // date -> { trips, stops: Map, drivers }
  events: [], // append-only
  eventSeq: 0,
  dedupe: new Map(), // dedupeKey -> event
  bindings: new Map(), // lineUserId -> driverCode
  sessions: new Map(), // token -> { driverCode, lineUserId }
};

export async function resetAll() {
  const plan = buildPlan(todayISO());

  internalDb.date = plan.date;
  internalDb.drivers = plan.drivers;
  internalDb.trips = plan.trips;
  internalDb.stops = new Map(plan.stops.map((s) => [s.stopId, structuredClone(s)]));
  internalDb.appliedDedupeKeys = new Set();
  internalDb.relayCursor = 0;
  internalDb.syncLog = [];

  relayDb.jobs = new Map();
  relayDb.events = [];
  relayDb.eventSeq = 0;
  relayDb.dedupe = new Map();
  // bindings and sessions survive a reset so a logged-in driver stays logged in

  // Seed the relay's copy of the plan up front. The sync worker would do this
  // on its first push anyway; doing it here lets the backdated events land
  // before the first HTTP request arrives.
  relayDb.jobs.set(plan.date, {
    date: plan.date,
    trips: plan.trips,
    drivers: await driversForRelay(),
    stops: new Map(plan.stops.map((s) => [s.stopId, structuredClone(s)])),
  });

  // Replay the backdated events through the real relay path, so history and
  // live traffic go through exactly the same code.
  for (const e of historicalEvents(plan)) {
    recordRelayEvent(e, { skipValidation: true });
  }
}

export function internalStopsOfDriver(driverCode) {
  const tripIds = new Set(
    internalDb.trips.filter((t) => t.driverCode === driverCode).map((t) => t.tripId),
  );
  return [...internalDb.stops.values()].filter((s) => tripIds.has(s.tripId));
}

// ---------------------------------------------------------------- relay side

export function relayJobsFor(date) {
  return relayDb.jobs.get(date) ?? null;
}

export function relayStopsOfDriver(date, driverCode) {
  const jobs = relayJobsFor(date);
  if (!jobs) return [];
  const tripIds = new Set(
    jobs.trips.filter((t) => t.driverCode === driverCode).map((t) => t.tripId),
  );
  return [...jobs.stops.values()].filter((s) => tripIds.has(s.tripId));
}

/**
 * Append an event to the relay log and move the relay's own copy of the stop.
 * Idempotent on dedupeKey: a driver hammering the button, or a retry after a
 * dropped connection, records once.
 */
export function recordRelayEvent(input, { skipValidation = false } = {}) {
  const existing = relayDb.dedupe.get(input.dedupeKey);
  if (existing) return { ok: true, duplicate: true, event: existing };

  const date = input.date ?? internalDb.date;
  const jobs = relayJobsFor(date);
  const stop = jobs?.stops.get(input.stopId);
  if (!stop) return { ok: false, code: 'STOP_NOT_FOUND', message: 'ไม่พบงานนี้บน relay' };

  if (!skipValidation) {
    const driverStops = relayStopsOfDriver(date, input.driverCode);
    const check = validateAction(stop, input.action, driverStops);
    if (!check.ok) return check;
  }

  const event = {
    eventId: `E${String(++relayDb.eventSeq).padStart(6, '0')}`,
    seq: relayDb.eventSeq,
    date,
    stopId: input.stopId,
    action: input.action,
    clientTs: input.clientTs ?? new Date().toISOString(),
    serverTs: new Date().toISOString(),
    lat: input.lat ?? null,
    lng: input.lng ?? null,
    accuracy: input.accuracy ?? null,
    driverCode: input.driverCode,
    lineUserId: input.lineUserId ?? null,
    dedupeKey: input.dedupeKey,
  };

  relayDb.events.push(event);
  relayDb.dedupe.set(event.dedupeKey, event);

  if (input.action === 'start' && stop.visitOrder == null) {
    const driverStops = relayStopsOfDriver(date, input.driverCode);
    stop.visitOrder = driverStops.filter((s) => s.visitOrder != null).length + 1;
  }
  applyAction(stop, input.action, event.clientTs);

  return { ok: true, duplicate: false, event };
}

export { STOP_STATUS };
