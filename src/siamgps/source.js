// Where GPS data comes from — shared by the GPS routes and the trips route so
// both always agree on "live" vs "mockup".
//
//   SIAMGPS_MODE=live -> always SIAMGPS, surface errors
//   SIAMGPS_MODE=demo -> never call SIAMGPS (the mockup)
//   SIAMGPS_MODE=auto -> try SIAMGPS, fall back to the mockup

import { config } from '../config.js';

export const MODE = config.siamgps.mode;

export let lastUpstream = { ok: null, status: null, message: null, at: null };

function noteUpstream(error) {
  lastUpstream = {
    ok: !error,
    status: error?.status ?? null,
    message: error?.message ?? null,
    at: new Date().toISOString(),
  };
}

/** Runs [live]; on failure (in auto mode) answers with [demo] instead. */
export async function resolve(live, demo) {
  if (MODE === 'demo') return { source: 'demo', data: await demo(), fallback: null };
  try {
    const data = await live();
    noteUpstream(null);
    return { source: 'live', data, fallback: null };
  } catch (e) {
    noteUpstream(e);
    if (MODE === 'live') throw e;
    return {
      source: 'demo',
      data: await demo(),
      fallback: { status: e.status ?? null, message: e.message },
    };
  }
}
