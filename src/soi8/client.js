// SOI8 Delivery Final Inspection API — the real source for the 3D overview.
//
// Same call the SOI8 front makes for its own 3D page
// (SOI8-DEL-FINAL-INSPEC-FRONT/lib/page/P08_floor3d_page/P08_floor3d_page.dart):
//
//   POST {SOI8_API_BASE}/P01_dashboard_page/fetchData   { dateSeleted: 'YYYY-MM-DD' }
//   -> 200 [ DeliveryModel, … ]   one row per DO line, read live from SAP
//
// No login is needed for this endpoint. It hits SAP on every call, so callers
// should cache (routes/internal.js does).

import { config } from '../config.js';

export const SOI8 = {
  base: config.soi8.base,
  timeoutMs: config.soi8.timeoutMs,
};

export class Soi8Error extends Error {
  constructor(message, status = null) {
    super(message);
    this.status = status;
  }
}

/** Delivery rows for one day. [date] is 'YYYY-MM-DD' in local time. */
export async function fetchDeliveries(date) {
  let res;
  try {
    res = await fetch(new URL('/P01_dashboard_page/fetchData', SOI8.base), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ dateSeleted: date }),
      signal: AbortSignal.timeout(SOI8.timeoutMs),
    });
  } catch (e) {
    const why =
      e.name === 'TimeoutError'
        ? 'timeout'
        : (e.cause?.code ?? e.cause?.errors?.[0]?.code ?? e.message);
    throw new Soi8Error(`ต่อ SOI8 (${SOI8.base}) ไม่ได้ — ${why}`);
  }

  let body = null;
  try {
    body = await res.json();
  } catch {
    // reported below
  }
  if (!res.ok || !Array.isArray(body)) {
    const msg = body?.message ?? `HTTP ${res.status}`;
    throw new Soi8Error(`SOI8 ตอบกลับผิดรูปแบบ: ${msg}`, res.status);
  }
  return body;
}
