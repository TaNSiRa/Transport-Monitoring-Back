// Protrack365 Open API client.
//
// This lives on the server for two reasons, both of which rule out calling
// Protrack straight from the Flutter page:
//
//   1. api.protrack365.com sends no CORS headers, so a browser request is
//      blocked before it ever reaches them.
//   2. The signature is md5(md5(password) + time). Doing that in the page
//      means shipping the platform password to every browser that opens the
//      dashboard. Here it stays in the backend process.
//
// Docs: https://www.protrack365.com/api.jsp

import crypto from 'node:crypto';

const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');

export const PROTRACK = {
  base: process.env.PROTRACK_BASE ?? 'https://api.protrack365.com',
  account: process.env.PROTRACK_ACCOUNT ?? 'DEMO65558',
  password: process.env.PROTRACK_PASSWORD ?? 'DEMO65558',
  // The IMEIs the dashboard shows when the account cannot list devices itself.
  imeis: (process.env.PROTRACK_IMEIS ?? '358069580065558')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
};

/** Error codes from section 3 of the API doc, in the language of this app. */
const ERRORS = {
  10002: 'เซสชันหมดอายุ',
  10003: 'ยังไม่ได้ล็อกอิน',
  10004: 'พารามิเตอร์ไม่ถูกต้อง',
  10005: 'ขาดพารามิเตอร์ที่จำเป็น',
  10007: 'บัญชีนี้ยังไม่ได้เปิดสิทธิ์ Open API — ต้องขอเปิดกับผู้ให้บริการ Protrack',
  10009: 'เรียก API ถี่เกินไป',
  10010: 'ไม่พบ access token',
  10011: 'access token ไม่ถูกต้อง',
  10012: 'access token หมดอายุ',
  10013: 'IMEI นี้ไม่ได้อยู่ในสิทธิ์ของบัญชี',
  10014: 'เวลาของเครื่องไม่ตรงกับเซิร์ฟเวอร์ Protrack',
  10016: 'บัญชีถูกระงับ',
  20001: 'บัญชีหรือรหัสผ่านไม่ถูกต้อง',
  20005: 'ไม่พบอุปกรณ์',
  20017: 'อุปกรณ์ออฟไลน์',
  20023: 'ไม่มีข้อมูลในช่วงเวลานี้',
  20046: 'อุปกรณ์หมดอายุการใช้งาน',
  20089: 'อุปกรณ์ถูกระงับ',
};

/** Codes that mean "the token is no good" — worth one retry with a fresh one. */
const TOKEN_DEAD = new Set([10002, 10003, 10010, 10011, 10012]);

export class ProtrackError extends Error {
  constructor(code, message) {
    super(message ?? ERRORS[code] ?? `Protrack error ${code}`);
    this.code = code;
    // 10007 is a provisioning problem, not a bug — the caller reports it
    // differently from a transport failure.
    this.needsProvisioning = code === 10007 || code === 10013;
  }
}

let cached = null; // { token, fetchedAt }

// The token is good for 2h; the doc suggests refreshing every 90 minutes.
const TOKEN_TTL_MS = 90 * 60 * 1000;

async function getJson(path, params) {
  const url = new URL(path, PROTRACK.base);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    throw new ProtrackError(-1, `ต่อ Protrack ไม่ได้: ${e.message}`);
  }
  if (!res.ok) throw new ProtrackError(-1, `Protrack ตอบ HTTP ${res.status}`);

  const json = await res.json();
  if (json.code !== 0) throw new ProtrackError(json.code, ERRORS[json.code] ?? json.message);
  return json.record;
}

/** 2.1 Get access token. */
async function authorize() {
  const time = Math.floor(Date.now() / 1000);
  const record = await getJson('/api/authorization', {
    time,
    account: PROTRACK.account,
    signature: md5(md5(PROTRACK.password) + time),
  });
  cached = { token: record.access_token, fetchedAt: Date.now() };
  return cached.token;
}

async function token({ force = false } = {}) {
  if (!force && cached && Date.now() - cached.fetchedAt < TOKEN_TTL_MS) return cached.token;
  return authorize();
}

/** Every call goes through here so an expired token is retried exactly once. */
async function call(path, params) {
  try {
    return await getJson(path, { ...params, access_token: await token() });
  } catch (e) {
    if (!(e instanceof ProtrackError) || !TOKEN_DEAD.has(e.code)) throw e;
    cached = null;
    return getJson(path, { ...params, access_token: await token({ force: true }) });
  }
}

/** 2.7 Get device list. */
export async function deviceList() {
  const record = (await call('/api/device/list', { account: PROTRACK.account })) ?? [];
  return record.map((d) => ({
    imei: String(d.imei),
    name: d.devicename || String(d.imei),
    model: d.devicetype || '',
    plate: d.platenumber || '',
    simcard: d.simcard || '',
    expiresAt: sec(d.userduetime),
  }));
}

/** 2.2 Track — the latest fix for up to 100 IMEIs. */
export async function track(imeis) {
  const record = (await call('/api/track', { imeis: imeis.join(',') })) ?? [];
  return record.map(normaliseFix);
}

/** 2.3 Playback — the history between two instants. */
export async function playback(imei, beginSec, endSec) {
  const record = await call('/api/playback', {
    imei,
    begintime: beginSec,
    endtime: endSec,
  });
  return parsePlayback(record);
}

/**
 * Playback comes back as one string: groups split by ";", and each group is
 * "longitude,latitude,gpstime,speed,course".
 */
export function parsePlayback(record) {
  if (typeof record !== 'string' || record === '') return [];
  const points = [];
  for (const group of record.split(';')) {
    const [lng, lat, gpstime, speed, course] = group.split(',');
    const point = {
      lat: Number(lat),
      lng: Number(lng),
      at: sec(Number(gpstime)),
      speed: Number(speed),
      course: Number(course),
    };
    if (Number.isFinite(point.lat) && Number.isFinite(point.lng)) points.push(point);
  }
  return points;
}

/** Protrack sends unix seconds; 0 means "never". */
function sec(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null;
}

/** "" and -1 are the API's two ways of saying "this device has no such sensor". */
const opt = (v) => (v === -1 || v === '' || v === undefined || v === null ? null : v);

/**
 * datastatus (2.2) is the device's own verdict on whether its data is usable.
 * Everything downstream keys off `state`, so the mapping lives here only.
 */
const DATA_STATUS = {
  1: 'never', // never online
  2: 'ok',
  3: 'expired',
  4: 'offline',
  5: 'blocked',
};

export function normaliseFix(r) {
  const state = DATA_STATUS[r.datastatus] ?? 'unknown';
  const speed = Number(r.speed) || 0;
  return {
    imei: String(r.imei),
    lat: Number(r.latitude),
    lng: Number(r.longitude),
    course: Number(r.course) || 0,
    speed,
    // A device can be online and parked, which is worth seeing at a glance.
    moving: state === 'ok' && speed > 0,
    state,
    gpsAt: sec(r.gpstime),
    heartAt: sec(r.hearttime),
    serverAt: sec(r.servertime),
    accStatus: opt(r.accstatus),
    accSince: Number(r.acctime) > 0 ? Number(r.acctime) : null,
    doorStatus: opt(r.doorstatus),
    chargeStatus: opt(r.chargestatus),
    battery: opt(r.battery),
    // The API works in metres; kilometres is what the office actually reads.
    mileageKm: r.mileage === -1 || r.mileage === undefined ? null : Number(r.mileage) / 1000,
    todayKm:
      r.todaymileage === -1 || r.todaymileage === undefined ? null : Number(r.todaymileage) / 1000,
    externalPower: opt(r.externalpower),
    temperature: Array.isArray(r.temperature) ? r.temperature : [],
  };
}
