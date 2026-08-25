import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { getTestPool, resetDb } from './helpers/db.js';
import { writeAudit } from '../src/audit.js';

const pool = getTestPool();
beforeEach(async () => { await resetDb(pool); });
after(async () => { await pool.end(); });

// getTestPool() connects with whatever role TEST_DATABASE_URL happens to name. That's fine
// for tests that don't care which role runs the query, but the test below specifically
// asserts a rejection that only the restricted app role produces (a superuser connection
// would happily UPDATE and the test would fail with a confusing "missing expected rejection"
// instead of clearly signaling "wrong role for this test"). Force the known app-role
// credentials explicitly, mirroring the same host/port/db-preserving substitution
// helpers/db.js uses to go the other direction (deriving a superuser connection).
function getAppRoleConnectionString() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error('TEST_DATABASE_URL is required to run tests and has no fallback.');
  }
  return url.replace(/\/\/[^@]+@/, '//compliance_swarm_app:changeme-app@');
}

test('writeAudit inserts a row with the given fields', async () => {
  const { rows: [tenant] } = await pool.query(`INSERT INTO tenants (name) VALUES ('Test Co') RETURNING id`);
  await writeAudit(pool, {
    tenantId: tenant.id,
    eventType: 'login_failed',
    metadata: { reason: 'bad_password' },
  });
  const { rows } = await pool.query('SELECT * FROM audit_log');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event_type, 'login_failed');
  assert.equal(rows[0].actor_user_id, null);
  assert.deepEqual(rows[0].metadata, { reason: 'bad_password' });
});

test('audit_log rejects UPDATE from the app role', async () => {
  const appPool = new pg.Pool({ connectionString: getAppRoleConnectionString() });
  const { rows: [tenant] } = await pool.query(`INSERT INTO tenants (name) VALUES ('Test Co') RETURNING id`);
  await writeAudit(pool, { tenantId: tenant.id, eventType: 'login_success' });
  const { rows: [row] } = await pool.query('SELECT id FROM audit_log LIMIT 1');
  await assert.rejects(
    () => appPool.query('UPDATE audit_log SET event_type = $1 WHERE id = $2', ['tampered', row.id]),
  );
  await appPool.end();
});
