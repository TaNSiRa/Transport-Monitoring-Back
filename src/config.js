// Every setting the backend reads, and the only place it reads them.
//
// Values come from backend/.env (next to package.json), loaded here by path —
// so it is found no matter which folder the process was started from or how
// (npm start, node src/Transport-Back.js, pm2, a Windows service …). Variables
// already set in the real environment win over the file.
//
// There are no defaults in code: a missing key stops the server at start-up
// with the list of what to add, instead of quietly running on some other
// machine's address. .env is not in git — each machine keeps its own.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ENV_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env');

const envFileFound = fs.existsSync(ENV_FILE);
if (envFileFound) loadEnvFile(ENV_FILE);

/** Node's own loader where it exists (20.12+), a plain KEY=value reader otherwise. */
function loadEnvFile(file) {
  if (typeof process.loadEnvFile === 'function') return process.loadEnvFile(file);
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    const eq = line.indexOf('=');
    if (!line || line.startsWith('#') || eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const problems = [];

function str(key, { allowEmpty = false } = {}) {
  const value = process.env[key]?.trim();
  if (value === undefined || (!allowEmpty && value === '')) {
    problems.push(`${key} ไม่ได้ตั้งค่า`);
    return '';
  }
  return value;
}

function num(key) {
  const raw = str(key);
  if (raw === '') return NaN;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) problems.push(`${key}=${raw} ต้องเป็นตัวเลข`);
  return value;
}

function oneOf(key, choices) {
  const value = str(key);
  if (value !== '' && !choices.includes(value)) {
    problems.push(`${key}=${value} ต้องเป็น ${choices.join(' | ')}`);
  }
  return value;
}

export const config = {
  port: num('PORT'),
  soi8: {
    base: str('SOI8_API_BASE'),
    timeoutMs: num('SOI8_TIMEOUT_MS'),
    cacheMs: num('SOI8_CACHE_MS'),
  },
  siamgps: {
    base: str('SIAMGPS_BASE'),
    // Empty is allowed: auto mode then serves the mockup.
    token: str('SIAMGPS_TOKEN', { allowEmpty: true }),
    mode: oneOf('SIAMGPS_MODE', ['auto', 'live', 'demo']),
    timeoutMs: num('SIAMGPS_TIMEOUT_MS'),
    realtimeCacheMs: num('SIAMGPS_REALTIME_CACHE_MS'),
  },
  geofence: {
    dwellMin: num('GEOFENCE_DWELL_MIN'),
    cacheMs: num('GEOFENCE_CACHE_MS'),
  },
};

if (problems.length) {
  const where = envFileFound ? ENV_FILE : `${ENV_FILE} (ไม่พบไฟล์ — สร้างใหม่ตามรายการด้านล่าง)`;
  console.error(`\n  ตั้งค่า backend ไม่ครบ — แก้ใน ${where}\n`);
  for (const p of problems) console.error(`   • ${p}`);
  console.error('');
  process.exit(1);
}
