import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { getTestPool, resetDb } from './helpers/db.js';
import { createSession, lookupSession, deleteSession } from '../src/auth/session.js';

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
