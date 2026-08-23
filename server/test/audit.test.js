import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { getTestPool, resetDb } from './helpers/db.js';
import { writeAudit } from '../src/audit.js';

const pool = getTestPool();
beforeEach(async () => { await resetDb(pool); });
after(async () => { await pool.end(); });

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
  const appPool = getTestPool();
  const { rows: [tenant] } = await pool.query(`INSERT INTO tenants (name) VALUES ('Test Co') RETURNING id`);
  await writeAudit(pool, { tenantId: tenant.id, eventType: 'login_success' });
  const { rows: [row] } = await pool.query('SELECT id FROM audit_log LIMIT 1');
  await assert.rejects(
    () => appPool.query('UPDATE audit_log SET event_type = $1 WHERE id = $2', ['tampered', row.id]),
  );
  await appPool.end();
});
