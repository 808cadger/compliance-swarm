import crypto from 'node:crypto';

// A WebAuthn ceremony is two requests apart (generate options, then verify the browser's
// response) and the server must remember the exact challenge it issued in between — but that
// state is small, short-lived, and per-attempt, not a real session, so it doesn't belong in
// Postgres. In-memory, keyed by a random ceremony id handed to the client and echoed back on
// verify, is the same shape LoginRateLimiter (rateLimit.js) already uses for comparable
// single-process ephemeral state in this app.
const TTL_MS = 5 * 60 * 1000;
const store = new Map();

export function beginCeremony(data) {
  const ceremonyId = crypto.randomBytes(24).toString('hex');
  store.set(ceremonyId, { ...data, expiresAt: Date.now() + TTL_MS });
  return ceremonyId;
}

// One-shot by design: a ceremony id is consumed the first time it's read, verified or not, so
// a captured verify request can never be replayed against the same challenge.
export function takeCeremony(ceremonyId) {
  const entry = store.get(ceremonyId);
  if (!entry) return null;
  store.delete(ceremonyId);
  if (Date.now() > entry.expiresAt) return null;
  return entry;
}
