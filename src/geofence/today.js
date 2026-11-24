// Today's deliveries, worked out once and shared: the GPS page's customer
// tab and the trips page both read this, so they can never disagree about
// whether a customer has been delivered.
//
// Rule: a truck stopped inside a customer's radius for DWELL minutes (10)
// has delivered there. Tracks come from SIAMGPS when it is live, otherwise
// from the mockup; customers are the plan day's delivery locations with the
// positions and radii in the customer master.

import { config } from '../config.js';
import * as siamgps from '../siamgps/client.js';
import { resolve } from '../siamgps/source.js';
import { demoCustomers, demoTracks, demoRealtimeList, localMidnight } from '../siamgps/demo.js';
import { onMasterChange } from '../master/store.js';
import { findStops, customerStatus } from './detect.js';

export const DWELL_MIN = config.geofence.dwellMin;
const CACHE_MS = config.geofence.cacheMs;

let cache = null; // { at, value }
onMasterChange(() => {
  cache = null; // a moved pin or a new radius must show at once
});

/** Today's tracks from SIAMGPS: one playback call per vehicle. */
async function liveTracks(startMs, endMs) {
  const list = await siamgps.vehicles();
  const startDate = new Date(startMs).toISOString();
  const endDate = new Date(endMs).toISOString();
  const tracks = [];
  for (const v of list.data ?? []) {
    const pb = await siamgps.playback(v._id, startDate, endDate);
    tracks.push({ vehicleInfo: pb.vehicleInfo ?? v, data: pb.data ?? [] });
  }
  return tracks;
}

/**
 * { source, fallback, at, since, dwellMinutes,
 *   customers: [ …customer, status, deliveredAt, deliveredBy, present, visits ],
 *   realtime:  [ SIAMGPS realtime records ] }
 */
export async function today() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const now = Date.now();
  const since = localMidnight(now);
  const { source, data, fallback } = await resolve(
    async () => ({
      tracks: await liveTracks(since, now),
      realtime: (await siamgps.realtimeList()).data ?? [],
    }),
    () => ({ tracks: demoTracks(since, now), realtime: demoRealtimeList(now).data }),
  );
  const customers = demoCustomers();
  const stops = findStops(customers, data.tracks, { now });
  const value = {
    source,
    fallback,
    at: new Date(now).toISOString(),
    since: new Date(since).toISOString(),
    dwellMinutes: DWELL_MIN,
    customers: customerStatus(customers, stops, { dwellMs: DWELL_MIN * 60_000, now }),
    realtime: data.realtime,
  };
  cache = { at: Date.now(), value };
  return value;
}
