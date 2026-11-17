// Everything in here is INSIDE the company network.
// The Flutter dashboard is the only client. Nothing on the internet may reach it.

import { Router } from 'express';
import { internalDb, resetAll, driversForRelay } from '../db.js';
import { UPSTREAM_MOCK, todayISO } from '../seed.js';
import { tripStatus, isActive, STOP_STATUS } from '../logic/state.js';

export const internalRouter = Router();

function stopsByTrip() {
  const map = new Map();
  for (const s of internalDb.stops.values()) {
    if (!map.has(s.tripId)) map.set(s.tripId, []);
    map.get(s.tripId).push(s);
  }
  for (const list of map.values()) {
    list.sort((a, b) => {
      // Visited stops first in the order the driver actually took them,
      // then the untouched ones in planned order.
      if (a.visitOrder && b.visitOrder) return a.visitOrder - b.visitOrder;
      if (a.visitOrder) return -1;
      if (b.visitOrder) return 1;
      return a.plannedSeq - b.plannedSeq;
    });
  }
  return map;
}

/** The plan hand-off the sync worker pushes to the relay every few minutes. */
internalRouter.get('/plan', async (req, res) => {
  const date = req.query.date ?? internalDb.date;
  if (date !== internalDb.date) return res.json({ date, trips: [], stops: [], drivers: [] });
  res.json({
    date,
    // Hashed, never the clear PIN - the relay has no business knowing it.
    drivers: await driversForRelay(),
    trips: internalDb.trips,
    stops: [...internalDb.stops.values()].map((s) => ({
      stopId: s.stopId,
      tripId: s.tripId,
      plannedSeq: s.plannedSeq,
      customerCode: s.customerCode,
      customerName: s.customerName,
      address: s.address,
      lat: s.lat,
      lng: s.lng,
      docs: s.docs,
      totalQty: s.totalQty,
    })),
  });
});

/** The five pipeline tiles. Steps 1..4-1 are mocked; 4-2 is computed live. */
internalRouter.get('/dashboard', (req, res) => {
  const date = req.query.date ?? internalDb.date;
  const isToday = date === internalDb.date;

  const byTrip = stopsByTrip();
  let finished = 0;
  let inprocess = 0;
  let waiting = 0;

  if (isToday) {
    for (const trip of internalDb.trips) {
      switch (tripStatus(byTrip.get(trip.tripId) ?? [])) {
        case 'finished': finished++; break;
        case 'inprocess': inprocess++; break;
        default: waiting++;
      }
    }
  }

  const total = isToday ? internalDb.trips.length : 0;
  const step42 = {
    key: 'step42',
    step: 'STEP 4-2',
    label: 'Truck delivery',
    sub: 'ส่งของขึ้นรถไปหาลูกค้า',
    unit: 'TRUCKS',
    total,
    finished,
    inprocess,
    waiting,
    note: finished > 0 ? `${finished} trucks already back at TP` : null,
    live: true,
  };

  res.json({
    date,
    generatedAt: new Date().toISOString(),
    steps: [UPSTREAM_MOCK.step1, UPSTREAM_MOCK.step2, UPSTREAM_MOCK.step3, UPSTREAM_MOCK.step41, step42],
  });
});

/** Drill-down under the STEP 4-2 tile. */
internalRouter.get('/trips', (req, res) => {
  const date = req.query.date ?? internalDb.date;
  if (date !== internalDb.date) return res.json({ date, trips: [] });

  const byTrip = stopsByTrip();
  const driverName = new Map(internalDb.drivers.map((d) => [d.driverCode, d.name]));

  const trips = internalDb.trips.map((t) => {
    const stops = byTrip.get(t.tripId) ?? [];
    const active = stops.find(isActive);
    return {
      ...t,
      driverName: driverName.get(t.driverCode) ?? t.driverCode,
      status: tripStatus(stops),
      stopCount: stops.length,
      doneCount: stops.filter((s) => s.status === STOP_STATUS.DONE).length,
      currentStop: active ? { customerName: active.customerName, status: active.status } : null,
      stops,
    };
  });

  const order = { inprocess: 0, waiting: 1, finished: 2 };
  trips.sort((a, b) => order[a.status] - order[b.status] || a.truckNo.localeCompare(b.truckNo));
  res.json({ date, trips });
});

/** Proof that the internal side only ever dials outward. */
internalRouter.get('/sync-log', (_req, res) => {
  res.json({ cursor: internalDb.relayCursor, entries: internalDb.syncLog.slice(-40).reverse() });
});

internalRouter.post('/reset', async (_req, res) => {
  await resetAll();
  res.json({ ok: true, date: internalDb.date, today: todayISO() });
});
