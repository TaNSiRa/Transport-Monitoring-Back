// PIN hashing, shared by the on-prem side and the cloud relay.
//
// Uses Web Crypto only, so the exact same code runs on Node and on Cloudflare
// Workers. Both sides must agree byte-for-byte, so this lives in one file.
//
// A 4-digit PIN is a weak secret by nature - 10,000 possibilities. It is not
// the real gate. The real gate is the LINE identity: a PIN alone is useless
// without a LINE account that the office has bound to that driver. What the
// pepper buys us is that a stolen copy of the database is not enough to work
// out anyone's PIN, because the pepper is never stored next to the hashes.

const enc = new TextEncoder();

export async function hashPin(pepper, driverCode, pin) {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(pepper),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${driverCode}:${pin}`));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/// Constant-time compare, so a wrong PIN cannot be narrowed down by timing.
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
