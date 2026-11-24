// The trips page, built from the plan day (one trip per FO, in each truck's
// running order) and today's geofence result — so a stop reads "done" on the
// trips page exactly when the GPS page shows that customer as delivered.
//
//   done     — this truck stopped in the customer's radius for 10+ minutes
//   arrived  — this truck is inside the radius now, not long enough yet
//   enroute  — it is the truck's next open stop and the truck is moving
//   waiting  — otherwise

import { loadDay, trucksInPlan } from './day.js';

export function buildTrips(t) {
  const byLocation = new Map(t.customers.map((c) => [c.id, c]));
  const latest = new Map(
    (t.realtime ?? []).map((r) => [(r.vehicleInfo?._vehiPlateNo ?? '').trim(), r]),
  );

  const trips = [];
  for (const [plate, fos] of trucksInPlan()) {
    let earlierOpen = false; // a later FO cannot be under way before an earlier one is done
    fos.forEach((fo, i) => {
      const c = byLocation.get(fo.locationCode);
      const mine = (c?.visits ?? []).filter((v) => v.plate === plate);
      const counted = mine.find((v) => v.counted);
      const here = c?.present?.plate === plate ? mine.find((v) => v.to == null) : null;

      let status = 'waiting';
      if (counted) status = 'done';
      else if (here) status = 'arrived';
      else if (!earlierOpen && (latest.get(plate)?.speed ?? 0) > 0) status = 'enroute';
      if (status !== 'done') earlierOpen = true;

      const docs = fo.docs.map((d) => ({
        doNo: d.invoiceNo || d.deliveryNo,
        qty: Math.round(d.qty),
      }));
      const stop = {
        stopId: `${fo.foId}-1`,
        tripId: fo.foId,
        plannedSeq: 1,
        customerCode: fo.locationCode,
        customerName: fo.locationName,
        address: fo.route,
        docs,
        totalQty: docs.reduce((a, d) => a + d.qty, 0),
        status,
        visitOrder: status === 'waiting' ? null : 1,
        checkinAt: (counted ?? here)?.from ?? null,
        checkoutAt: counted?.to ?? null,
      };
      const active = status === 'enroute' || status === 'arrived';
      trips.push({
        tripId: fo.foId,
        round: i + 1,
        driverCode: plate,
        driverName: fo.driver || '-',
        truckNo: plate,
        departPlan: '',
        status: status === 'done' ? 'finished' : active ? 'inprocess' : 'waiting',
        stopCount: 1,
        doneCount: status === 'done' ? 1 : 0,
        currentStop: active ? { customerName: fo.locationName, status } : null,
        stops: [stop],
      });
    });
  }
  const order = { inprocess: 0, waiting: 1, finished: 2 };
  trips.sort((a, b) => order[a.status] - order[b.status] || a.truckNo.localeCompare(b.truckNo) || a.round - b.round);
  return { planDay: loadDay().day, trips };
}
