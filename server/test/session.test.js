import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { getTestPool, resetDb } from './helpers/db.js';
import { createSession, lookupSession, deleteSession, refreshSession } from '../src/auth/session.js';

// Mirrors SESSION_ABSOLUTE_DAYS in ../src/auth/session.js (not exported), so the
// absolute-expiry test below can push a session's created_at just past the cap.
const SESSION_ABSOLUTE_DAYS = 7;

const pool = getTestPool();

beforeEach(async () => { await resetDb(pool); });
after(async () => { await pool.end(); });

async function seedUser() {
  const { rows: [tenant] } = await pool.query(
    `INSERT INTO tenants (name) VALUES ('Test Co') RETURNING id`,
  );
  const { rows: [user] } = await pool.query(
    `INSERT INTO users (tenant_id, email, password_hash, role, display_name)
     VALUES ($1, 'owner@test.co', 'x', 'owner_admin', 'Owner')
     RETURNING id`,
    [tenant.id],
  );
  return { tenantId: tenant.id, userId: user.id };
}

test('createSession then lookupSession returns the session', async () => {
  const { tenantId, userId } = await seedUser();
  const { token } = await createSession(pool, { userId, tenantId });
  const result = await lookupSession(pool, token);
  assert.deepEqual(result, { userId, tenantId, role: 'owner_admin' });
});

test('lookupSession returns null for unknown token', async () => {
  const result = await lookupSession(pool, 'not-a-real-token');
  assert.equal(result, null);
});

test('deleteSession invalidates the session', async () => {
  const { tenantId, userId } = await seedUser();
  const { token } = await createSession(pool, { userId, tenantId });
  await deleteSession(pool, token);
  assert.equal(await lookupSession(pool, token), null);
});

test('lookupSession returns null for a disabled user', async () => {
  const { tenantId, userId } = await seedUser();
  const { token } = await createSession(pool, { userId, tenantId });
  await pool.query(`UPDATE users SET disabled_at = now() WHERE id = $1`, [userId]);
  assert.equal(await lookupSession(pool, token), null);
});

test('refreshSession extends expires_at and updates last_seen_at', async () => {
  const { tenantId, userId } = await seedUser();
  const { token } = await createSession(pool, { userId, tenantId });

  // Push the row's existing expires_at/last_seen_at into the past so the refresh's effect
  // (both moving forward) is unambiguous rather than possibly a no-op millisecond rounding.
  await pool.query(
    `UPDATE sessions SET expires_at = now() - interval '1 hour', last_seen_at = now() - interval '1 hour' WHERE user_id = $1`,
    [userId],
  );
  const { rows: [before] } = await pool.query(
    `SELECT expires_at, last_seen_at FROM sessions WHERE user_id = $1`, [userId],
  );

  await refreshSession(pool, token);

  const { rows: [after] } = await pool.query(
    `SELECT expires_at, last_seen_at FROM sessions WHERE user_id = $1`, [userId],
  );
  assert.ok(after.expires_at > before.expires_at, 'expires_at should move forward');
  assert.ok(after.last_seen_at > before.last_seen_at, 'last_seen_at should move forward');

  // And the refreshed session is still usable.
  const result = await lookupSession(pool, token);
  assert.deepEqual(result, { userId, tenantId, role: 'owner_admin' });
});

test('lookupSession rejects a session past its idle expiry, even with a recent created_at', async () => {
  const { tenantId, userId } = await seedUser();
  const { token } = await createSession(pool, { userId, tenantId });
  await pool.query(
    `UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE user_id = $1`,
    [userId],
  );
  assert.equal(await lookupSession(pool, token), null);
});

test('lookupSession rejects a session past its absolute expiry, even with expires_at still in the future', async () => {
  const { tenantId, userId } = await seedUser();
  const { token } = await createSession(pool, { userId, tenantId });
  // created_at just past the absolute cap, but expires_at (set by createSession, ~12h out)
  // is untouched and still well in the future -- this isolates the absolute-expiry branch
  // from the idle-expiry one tested above.
  await pool.query(
    `UPDATE sessions SET created_at = now() - interval '${SESSION_ABSOLUTE_DAYS + 1} days' WHERE user_id = $1`,
    [userId],
  );
  assert.equal(await lookupSession(pool, token), null);
});
