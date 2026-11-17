// Delivery state machine + aggregation rules.
// Shared by the internal side and the relay so both enforce exactly the same thing.

export const STOP_STATUS = {
  WAITING: 'waiting',
  ENROUTE: 'enroute',
  ARRIVED: 'arrived',
  DONE: 'done',
};

export const ACTIONS = {
  start: { from: STOP_STATUS.WAITING, to: STOP_STATUS.ENROUTE, stamp: 'startedAt' },
  checkin: { from: STOP_STATUS.ENROUTE, to: STOP_STATUS.ARRIVED, stamp: 'checkinAt' },
  checkout: { from: STOP_STATUS.ARRIVED, to: STOP_STATUS.DONE, stamp: 'checkoutAt' },
};

// A stop is "occupying" the driver while it is neither untouched nor finished.
export function isActive(stop) {
  return stop.status === STOP_STATUS.ENROUTE || stop.status === STOP_STATUS.ARRIVED;
}

/**
 * Validate an action against the current state.
 * `driverStops` is every stop belonging to the driver on that day (all rounds),
 * because the "one stop at a time" rule spans rounds, not just one trip.
 */
export function validateAction(stop, action, driverStops) {
  const rule = ACTIONS[action];
  if (!rule) return { ok: false, code: 'UNKNOWN_ACTION', message: `ไม่รู้จัก action "${action}"` };
  if (!stop) return { ok: false, code: 'STOP_NOT_FOUND', message: 'ไม่พบงานนี้' };

  if (stop.status === rule.to) {
    // Already there - treat as a harmless replay, not an error.
    return { ok: true, replay: true };
  }
  if (stop.status !== rule.from) {
    return {
      ok: false,
      code: 'BAD_TRANSITION',
      message: `กด "${action}" ไม่ได้ เพราะงานนี้อยู่สถานะ "${stop.status}"`,
    };
  }

  if (action === 'start') {
    const busy = driverStops.find((s) => s.stopId !== stop.stopId && isActive(s));
    if (busy) {
      return {
        ok: false,
        code: 'DRIVER_BUSY',
        message: `ยังมีงานค้างอยู่ที่ ${busy.customerName} — ต้อง check out ให้เสร็จก่อน`,
      };
    }
  }

  return { ok: true, replay: false };
}

export function applyAction(stop, action, at) {
  const rule = ACTIONS[action];
  stop.status = rule.to;
  stop[rule.stamp] = at;
  return stop;
}

/** waiting | inprocess | finished — finished only when every stop is delivered. */
export function tripStatus(stops) {
  if (stops.length === 0) return 'waiting';
  if (stops.every((s) => s.status === STOP_STATUS.DONE)) return 'finished';
  if (stops.every((s) => s.status === STOP_STATUS.WAITING)) return 'waiting';
  return 'inprocess';
}
