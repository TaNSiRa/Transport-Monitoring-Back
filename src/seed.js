// Deterministic mock plan, standing in for the internal ERP.
// Everything is generated for "today" so the demo always has live data.

import { STOP_STATUS } from './logic/state.js';

export function todayISO(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Small deterministic PRNG so the mock looks the same on every restart.
function rng(seed) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

const DRIVERS = [
  { driverCode: 'D001', name: 'สมชาย ใจดี', truckNo: '70-1234', pin: '1234' },
  { driverCode: 'D002', name: 'ประเสริฐ ทองดี', truckNo: '70-5678', pin: '1234' },
  { driverCode: 'D003', name: 'วิรัตน์ แสงทอง', truckNo: '71-2233', pin: '1234' },
  { driverCode: 'D004', name: 'อนุชา พรมมา', truckNo: '71-4455', pin: '1234' },
  { driverCode: 'D005', name: 'ธนพล ศรีสุข', truckNo: '72-0011', pin: '1234' },
  { driverCode: 'D006', name: 'เอกชัย มั่นคง', truckNo: '72-0022', pin: '1234' },
  { driverCode: 'D007', name: 'สุรชัย ก้องไกล', truckNo: '72-0033', pin: '1234' },
  { driverCode: 'D008', name: 'พิชิต แก้วใส', truckNo: '73-0044', pin: '1234' },
  { driverCode: 'D009', name: 'มานพ ดวงดี', truckNo: '73-0055', pin: '1234' },
  { driverCode: 'D010', name: 'ชูเกียรติ นาคเงิน', truckNo: '73-0066', pin: '1234' },
  { driverCode: 'D011', name: 'ไพโรจน์ ทวีทรัพย์', truckNo: '74-0077', pin: '1234' },
  { driverCode: 'D012', name: 'กิตติศักดิ์ ยอดเยี่ยม', truckNo: '74-0088', pin: '1234' },
];

const CUSTOMERS = [
  { code: 'C-SANMEI', name: 'T-SANMEI', address: 'นิคมอมตะซิตี้ ชลบุรี', lat: 13.3611, lng: 101.0432 },
  { code: 'C-TOYOTA-BP', name: 'TOYOTA บ้านโพธิ์', address: 'บ้านโพธิ์ ฉะเชิงเทรา', lat: 13.5411, lng: 101.0821 },
  { code: 'C-DENSO', name: 'DENSO (Thailand)', address: 'นิคมบางปะกง ฉะเชิงเทรา', lat: 13.5122, lng: 101.0033 },
  { code: 'C-AAPICO', name: 'AAPICO HITECH', address: 'นิคมไฮเทค อยุธยา', lat: 14.2544, lng: 100.6088 },
  { code: 'C-SUMMIT', name: 'SUMMIT AUTO BODY', address: 'บางปู สมุทรปราการ', lat: 13.5288, lng: 100.6412 },
  { code: 'C-STANLEY', name: 'THAI STANLEY ELECTRIC', address: 'บางเขน ปทุมธานี', lat: 14.0233, lng: 100.5211 },
  { code: 'C-NHK', name: 'NHK SPRING', address: 'นิคมเวลโกรว์ ฉะเชิงเทรา', lat: 13.5901, lng: 100.9744 },
  { code: 'C-NSK', name: 'SIAM NSK STEERING', address: 'นิคมอีสเทิร์นซีบอร์ด ระยอง', lat: 12.9722, lng: 101.1033 },
  { code: 'C-TOYOTA-GW', name: 'TOYOTA GATEWAY', address: 'เกตเวย์ ฉะเชิงเทรา', lat: 13.4788, lng: 101.3122 },
  { code: 'C-YAZAKI', name: 'YAZAKI (Thailand)', address: 'ลาดกระบัง กรุงเทพฯ', lat: 13.7255, lng: 100.7788 },
  { code: 'C-ARROW', name: 'THAI ARROW PRODUCTS', address: 'นิคมลาดกระบัง กรุงเทพฯ', lat: 13.7188, lng: 100.7911 },
  { code: 'C-MITSU', name: 'MITSUBISHI ELECTRIC', address: 'นิคมบางปะอิน อยุธยา', lat: 14.2011, lng: 100.5822 },
  { code: 'C-NIDEC', name: 'NIDEC ELECTRONICS', address: 'นิคมโรจนะ อยุธยา', lat: 14.3122, lng: 100.6455 },
  { code: 'C-KYOCERA', name: 'KYOCERA (Thailand)', address: 'นิคมลำพูน ลำพูน', lat: 18.5322, lng: 99.0122 },
];

/**
 * Builds the plan the way the ERP would hand it over:
 * a set of trips (one truck, one round) each carrying a set of stops.
 * plannedSeq is a suggestion only - the driver picks the real order.
 */
export function buildPlan(date = todayISO()) {
  const rand = rng(20260828);
  const trips = [];
  const stops = [];
  let doCounter = 811025700;

  // Round 1 for every driver, plus a second round for the first three.
  const assignments = [
    ...DRIVERS.map((d) => ({ driver: d, round: 1 })),
    { driver: DRIVERS[0], round: 2 },
    { driver: DRIVERS[1], round: 2 },
    { driver: DRIVERS[2], round: 2 },
  ];

  assignments.forEach((a) => {
    const tripId = `T${date.split('-').join('')}-${a.driver.driverCode}-R${a.round}`;
    trips.push({
      tripId,
      tripDate: date,
      round: a.round,
      driverCode: a.driver.driverCode,
      truckNo: a.driver.truckNo,
      departPlan: a.round === 1 ? '08:00' : '13:30',
    });

    const stopCount = 2 + Math.floor(rand() * 3); // 2-4 customers per trip
    const picked = new Set();
    for (let j = 0; j < stopCount; j++) {
      let c;
      do {
        c = CUSTOMERS[Math.floor(rand() * CUSTOMERS.length)];
      } while (picked.has(c.code));
      picked.add(c.code);

      const docCount = 1 + Math.floor(rand() * 2);
      const docs = [];
      for (let k = 0; k < docCount; k++) {
        docs.push({ doNo: String(++doCounter), qty: 4 + Math.floor(rand() * 20) });
      }

      stops.push({
        stopId: `${tripId}-S${j + 1}`,
        tripId,
        plannedSeq: j + 1,
        customerCode: c.code,
        customerName: c.name,
        address: c.address,
        lat: c.lat,
        lng: c.lng,
        docs,
        totalQty: docs.reduce((s, d) => s + d.qty, 0),
        status: STOP_STATUS.WAITING,
        visitOrder: null, // filled in when the driver actually starts it
        startedAt: null,
        checkinAt: null,
        checkoutAt: null,
      });
    }
  });

  return { date, drivers: DRIVERS, trips, stops };
}

/**
 * Backdated events so the dashboard is not empty on a cold start.
 * D001 / D002 / D003 are left untouched - those are the demo logins.
 */
export function historicalEvents(plan) {
  const demoDrivers = new Set(['D001', 'D002', 'D003']);
  const events = [];
  const base = new Date();
  base.setHours(8, 0, 0, 0);
  let tick = 0;
  const at = (mins) => new Date(base.getTime() + mins * 60000).toISOString();

  const byTrip = new Map();
  for (const s of plan.stops) {
    if (!byTrip.has(s.tripId)) byTrip.set(s.tripId, []);
    byTrip.get(s.tripId).push(s);
  }

  // Left mid-route on purpose, so the dashboard shows a non-zero "inprocess"
  // straight after a cold start instead of an unrealistically tidy board.
  const stillOnTheRoad = new Set(['D010', 'D011', 'D012']);

  for (const trip of plan.trips) {
    if (demoDrivers.has(trip.driverCode)) continue;
    const tripStops = byTrip.get(trip.tripId) ?? [];
    const finishAll = !stillOnTheRoad.has(trip.driverCode);
    const upTo = finishAll ? tripStops.length : 1;

    tripStops.slice(0, upTo).forEach((s, idx) => {
      const t0 = 20 + tick * 7;
      events.push(mkEvent(s, 'start', at(t0), trip));
      // The last stop of a truck still out there stays open: started and
      // arrived, but not checked out yet.
      if (finishAll || idx < upTo - 1) {
        events.push(mkEvent(s, 'checkin', at(t0 + 25), trip));
        events.push(mkEvent(s, 'checkout', at(t0 + 40), trip));
      } else {
        events.push(mkEvent(s, 'checkin', at(t0 + 25), trip));
      }
      tick++;
    });
  }
  return events;
}

function mkEvent(stop, action, ts, trip) {
  return {
    stopId: stop.stopId,
    action,
    clientTs: ts,
    lat: stop.lat + (Math.random() - 0.5) * 0.002,
    lng: stop.lng + (Math.random() - 0.5) * 0.002,
    accuracy: 8 + Math.round(Math.random() * 20),
    driverCode: trip.driverCode,
    dedupeKey: `${stop.stopId}:${action}`,
  };
}

// Steps 1..4-1 are not part of this build - the ERP owns them.
// Fixed mock figures so the dashboard renders whole.
export const UPSTREAM_MOCK = {
  step1: { key: 'step1', step: 'STEP 1', label: 'DO', sub: 'Outbound delivery', unit: 'TOTAL QTY', total: 100, finished: 50, inprocess: 3, waiting: 47, note: null },
  step2: { key: 'step2', step: 'STEP 2', label: 'Invoice', sub: 'Billing document', unit: 'TOTAL QTY', total: 100, finished: 80, inprocess: 1, waiting: 19, note: '1 doc on hold · 811025769 TOYOTA' },
  step3: { key: 'step3', step: 'STEP 3', label: 'Invoice', sub: 'QA gate before load out', unit: 'TOTAL QTY', total: 100, finished: 40, inprocess: 5, waiting: 55, note: null },
  step41: { key: 'step41', step: 'STEP 4-1', label: 'Customer pick-up', sub: 'ลูกค้ามารับของเอง', unit: 'CUSTOMERS', total: 2, finished: 1, inprocess: 1, waiting: 0, note: '1 customer in progress · T-SANMEI' },
};
