// The sync worker is the ONLY thing that crosses the company boundary, and it
// crosses it in one direction: it dials out, over plain HTTPS 443. Nothing
// listens for inbound connections, so there is no port to open, no VPN, no DMZ.
//
// Two loops:
//   push  - hand today's plan to the relay so drivers see their stops
//   pull  - fetch the taps drivers made and fold them into the internal DB
//
// In this mock the relay happens to run in the same process. In production you
// change RELAY_BASE to the cloud URL and move routes/relay.js to that host -
// nothing else about this file changes.

import { internalDb, driversForRelay } from '../db.js';
import { ACTIONS, STOP_STATUS } from '../logic/state.js';

const RELAY_BASE = process.env.RELAY_BASE ?? `http://127.0.0.1:${process.env.PORT ?? 4000}`;
const RELAY_KEY = process.env.RELAY_KEY ?? 'dev-relay-key';

// Push hands the WHOLE day up every time - no diffing - so every tick costs one
// D1 row write per driver, trip and stop. At 60s that is half a million writes a
// day against a 100k free allowance. The plan itself barely moves after the
// morning, so 15 minutes is both plenty and 15x cheaper.
const PUSH_EVERY_MS = Number(process.env.PUSH_EVERY_MS ?? 900_000);

// One row upserted on the relay = one D1 statement, and D1 caps a Worker
// invocation at 50 statements on the free plan. One invocation is one HTTP
// request, so the plan has to leave here in slices - see MAX_STATEMENTS_PER_PUSH
// in relay-worker/src/index.js, which rejects anything bigger.
const PUSH_CHUNK_SIZE = Number(process.env.PUSH_CHUNK_SIZE ?? 45);
const PULL_EVERY_MS = Number(process.env.PULL_EVERY_MS ?? 30_000);

// Nobody is driving at 3am, but setInterval does not know that: a 24h pull loop
// spends a third of its requests on an empty road. Outside the window both loops
// stand down. Set start === end to disable the gate and run around the clock.
const SYNC_TZ = process.env.SYNC_TZ ?? 'Asia/Bangkok';
const WORK_START_HOUR = Number(process.env.WORK_START_HOUR ?? 5);
const WORK_END_HOUR = Number(process.env.WORK_END_HOUR ?? 21);

// Read the clock in the fleet's timezone, not the VM's - a server that gets
// rebuilt in UTC must not silently shift everyone's working day.
const HOUR_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: SYNC_TZ,
  hour: 'numeric',
  hourCycle: 'h23',
});

function withinWorkHours() {
  if (WORK_START_HOUR === WORK_END_HOUR) return true;
  const hour = Number(HOUR_FMT.format(new Date()));
  return WORK_START_HOUR < WORK_END_HOUR
    ? hour >= WORK_START_HOUR && hour < WORK_END_HOUR
    : hour >= WORK_START_HOUR || hour < WORK_END_HOUR; // window crosses midnight
}

const RANK = {
  [STOP_STATUS.WAITING]: 0,
  [STOP_STATUS.ENROUTE]: 1,
  [STOP_STATUS.ARRIVED]: 2,
  [STOP_STATUS.DONE]: 3,
};

function log(kind, message, extra = {}) {
  const at = new Date().toISOString();
  internalDb.syncLog.push({ at, kind, message, ...extra });
  if (internalDb.syncLog.length > 500) internalDb.syncLog.splice(0, 200);

  // Also to stdout: on the VM this is the only window into what the worker is
  // doing, and a silent process that may or may not be syncing is worthless.
  const line = `  [${at.slice(11, 19)}] ${kind.padEnd(11)} ${message}`;
  if (kind.endsWith('error')) console.error(line);
  else console.log(line);
}

async function relayFetch(path, init = {}) {
  return fetch(`${RELAY_BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-relay-key': RELAY_KEY, ...(init.headers ?? {}) },
  });
}

/**
 * Cut the plan into slices no bigger than the relay will accept.
 *
 * Drivers and trips go first so that by the time a stop lands, the rows it reads
 * as context are already there. Slices are not a transaction and do not need to
 * be: every row is an idempotent upsert and the whole plan is replayed on the
 * next tick.
 */
function slicePlan(drivers, trips, stops, size) {
  const rows = [
    ...drivers.map((row) => ['drivers', row]),
    ...trips.map((row) => ['trips', row]),
    ...stops.map((row) => ['stops', row]),
  ];

  const slices = [];
  for (let i = 0; i < rows.length; i += size) {
    const slice = { drivers: [], trips: [], stops: [] };
    for (const [kind, row] of rows.slice(i, i + size)) slice[kind].push(row);
    slices.push(slice);
  }
  return slices;
}

export async function pushPlan() {
  const date = internalDb.date;
  const drivers = await driversForRelay(); // hashed PIN only, never the clear one
  const trips = internalDb.trips;

  // A stop knows its trip, not its driver. That was fine when trips and stops
  // always travelled together; now that a slice can hold stops whose trips went
  // out in an earlier request, the driver has to be stamped on here instead.
  const driverOfTrip = new Map(trips.map((t) => [t.tripId, t.driverCode]));
  const stops = [...internalDb.stops.values()].map((s) => ({
    stopId: s.stopId,
    tripId: s.tripId,
    driverCode: driverOfTrip.get(s.tripId) ?? '',
    plannedSeq: s.plannedSeq,
    customerCode: s.customerCode,
    customerName: s.customerName,
    address: s.address,
    lat: s.lat,
    lng: s.lng,
    docs: s.docs,
    totalQty: s.totalQty,
  }));

  const slices = slicePlan(drivers, trips, stops, PUSH_CHUNK_SIZE);
  if (slices.length === 0) {
    log('push', 'ไม่มีแผนงานให้ส่ง');
    return;
  }

  let sent = 0;
  try {
    for (const slice of slices) {
      const r = await relayFetch('/relay/jobs', {
        method: 'POST',
        body: JSON.stringify({ date, ...slice }),
      });
      if (!r.ok) {
        const detail = await r.json().catch(() => ({}));
        throw new Error(detail.message ?? detail.error ?? `HTTP ${r.status}`);
      }
      sent++;
    }
    log(
      'push',
      `ส่งแผนงานขึ้น relay: ${trips.length} เที่ยว / ${stops.length} จุดส่ง (${slices.length} ก้อน)`,
    );
  } catch (err) {
    // Partial delivery is safe to leave as it is - the next push replays it all.
    log('push-error', `ส่งแผนไม่สำเร็จที่ก้อนที่ ${sent + 1}/${slices.length}: ${err.message}`);
  }
}

export async function pullEvents() {
  try {
    const r = await relayFetch(`/relay/events?since=${internalDb.relayCursor}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const { events, cursor } = await r.json();
    if (events.length === 0) return;

    let applied = 0;
    for (const e of events) {
      if (internalDb.appliedDedupeKeys.has(e.dedupeKey)) continue;
      const stop = internalDb.stops.get(e.stopId);
      const rule = ACTIONS[e.action];
      if (!stop || !rule) continue;

      // Only ever move forward. Late or duplicated events cannot rewind a stop.
      if (RANK[rule.to] > RANK[stop.status]) {
        stop.status = rule.to;
        stop[rule.stamp] = e.clientTs;
        if (e.action === 'start' && stop.visitOrder == null) {
          stop.visitOrder = countStarted(e.driverCode) + 1;
        }
      }
      internalDb.appliedDedupeKeys.add(e.dedupeKey);
      applied++;
    }

    internalDb.relayCursor = cursor;
    if (applied) log('pull', `รับ ${applied} event เข้าระบบภายใน`, { cursor });
  } catch (err) {
    log('pull-error', `ดึง event ไม่สำเร็จ: ${err.message}`);
  }
}

function countStarted(driverCode) {
  const tripIds = new Set(
    internalDb.trips.filter((t) => t.driverCode === driverCode).map((t) => t.tripId),
  );
  return [...internalDb.stops.values()].filter(
    (s) => tripIds.has(s.tripId) && s.visitOrder != null,
  ).length;
}

// null until the first tick, so booting outside the window still logs the state.
let windowOpen = null;

export function startSyncWorker() {
  // The boot run ignores the window on purpose: if the relay key is wrong or the
  // URL is a typo, the operator needs to see that in the log now, not at 05:00.
  const kick = async () => {
    await pushPlan();
    await pullEvents();
  };
  setTimeout(kick, 300);

  setInterval(() => {
    if (withinWorkHours()) pushPlan();
  }, PUSH_EVERY_MS);

  setInterval(async () => {
    const open = withinWorkHours();
    const changed = windowOpen !== open;
    if (changed) {
      windowOpen = open;
      // With the gate disabled every tick is "open", so there is no edge to report.
      if (WORK_START_HOUR !== WORK_END_HOUR) {
        log('window', open ? 'เข้าเวลาทำงาน — เริ่ม sync' : 'หมดเวลาทำงาน — กวาดครั้งสุดท้ายแล้วพัก');
      }
    }
    // `changed` on a closing edge buys one last sweep, so a late tap at the end
    // of the shift is not stranded on the relay until tomorrow morning.
    if (open || changed) await pullEvents();
  }, PULL_EVERY_MS);

  const window =
    WORK_START_HOUR === WORK_END_HOUR
      ? 'ตลอด 24 ชม.'
      : `${String(WORK_START_HOUR).padStart(2, '0')}:00-${String(WORK_END_HOUR).padStart(2, '0')}:00 (${SYNC_TZ})`;
  log(
    'boot',
    `sync worker เริ่มทำงาน — push ทุก ${PUSH_EVERY_MS / 1000}s / pull ทุก ${PULL_EVERY_MS / 1000}s / ช่วงเวลา ${window}`,
  );
}
