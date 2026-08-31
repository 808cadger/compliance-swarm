import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { getTestPool, resetDb } from './helpers/db.js';
import { evaluateProcessAccess } from '../src/services/processAccess.js';

const pool = getTestPool();
beforeEach(async () => { await resetDb(pool); });
after(async () => { await pool.end(); });

async function seedTenantUser(role, tenantName = 'Test Co') {
  const { rows: [tenant] } = await pool.query(`INSERT INTO tenants (name) VALUES ($1) RETURNING id`, [tenantName]);
  const { rows: [user] } = await pool.query(
    `INSERT INTO users (tenant_id, email, password_hash, role, display_name)
     VALUES ($1, $2, 'x', $3, 'U') RETURNING id`,
    [tenant.id, `${role}@test.co`, role],
  );
  return { tenantId: tenant.id, userId: user.id };
}

test('owner_admin is allowed to open owner_process', async () => {
  const { tenantId, userId } = await seedTenantUser('owner_admin');
  const decision = await evaluateProcessAccess(pool, { tenantId, userId, role: 'owner_admin', processKey: 'owner_process' });
  assert.equal(decision.decision, 'allow');
  assert.ok(decision.reasons.includes('role_allows_process'));
});

test('a field worker is denied a process their role does not allow at all', async () => {
  const { tenantId, userId } = await seedTenantUser('field_worker');
  const decision = await evaluateProcessAccess(pool, { tenantId, userId, role: 'field_worker', processKey: 'accounting_snap' });
  assert.equal(decision.decision, 'deny');
  assert.equal(decision.allowed, false);
});

test('a field worker with no site assignment is denied field_snap', async () => {
  const { tenantId, userId } = await seedTenantUser('field_worker');
  const decision = await evaluateProcessAccess(pool, { tenantId, userId, role: 'field_worker', processKey: 'field_snap' });
  assert.equal(decision.decision, 'deny');
  assert.ok(decision.reasons.includes('no_site_assignment'));
});

test('a field worker with a site assignment is allowed field_snap', async () => {
  const { tenantId, userId } = await seedTenantUser('field_worker');
  const { rows: [site] } = await pool.query(`INSERT INTO sites (tenant_id, name) VALUES ($1, 'Site A') RETURNING id`, [tenantId]);
  await pool.query(`INSERT INTO user_site_assignments (tenant_id, user_id, site_id) VALUES ($1, $2, $3)`, [tenantId, userId, site.id]);
  const decision = await evaluateProcessAccess(pool, { tenantId, userId, role: 'field_worker', processKey: 'field_snap' });
  assert.equal(decision.decision, 'allow');
  assert.ok(decision.reasons.includes('assigned_to_site'));
});

test('a high-risk process requires step-up for a demo-assurance session', async () => {
  const { tenantId, userId } = await seedTenantUser('accounting');
  const decision = await evaluateProcessAccess(pool, {
    tenantId, userId, role: 'accounting', processKey: 'accounting_snap',
    sessionContext: { assuranceLevel: 'demo', stepUpValid: false },
  });
  assert.equal(decision.decision, 'step_up_required');
  assert.equal(decision.requiredAction, 'step_up');
  assert.equal(decision.allowed, false);
});

test('a high-risk process is allowed once step-up is valid', async () => {
  const { tenantId, userId } = await seedTenantUser('accounting');
  const decision = await evaluateProcessAccess(pool, {
    tenantId, userId, role: 'accounting', processKey: 'accounting_snap',
    sessionContext: { assuranceLevel: 'demo', stepUpValid: true },
  });
  assert.equal(decision.decision, 'allow');
});

test('a real password-authenticated session never hits the step-up gate on a high-risk process', async () => {
  const { tenantId, userId } = await seedTenantUser('accounting');
  const decision = await evaluateProcessAccess(pool, {
    tenantId, userId, role: 'accounting', processKey: 'accounting_snap',
    sessionContext: { assuranceLevel: 'standard', stepUpValid: false },
  });
  assert.equal(decision.decision, 'allow');
});

test('evaluating against a different tenant than the one holding the site assignment is denied', async () => {
  const { userId } = await seedTenantUser('field_worker');
  const { tenantId: otherTenantId } = await seedTenantUser('field_worker', 'Other Co');
  const decision = await evaluateProcessAccess(pool, { tenantId: otherTenantId, userId, role: 'field_worker', processKey: 'field_snap' });
  assert.equal(decision.decision, 'deny');
});

test('an unknown process key is denied', async () => {
  const { tenantId, userId } = await seedTenantUser('owner_admin');
  const decision = await evaluateProcessAccess(pool, { tenantId, userId, role: 'owner_admin', processKey: 'not_a_real_process' });
  assert.equal(decision.decision, 'deny');
  assert.ok(decision.reasons.includes('unknown_process'));
});

test('missing identity fields deny closed rather than throwing', async () => {
  const decision = await evaluateProcessAccess(pool, { tenantId: null, userId: null, role: null, processKey: 'owner_process' });
  assert.equal(decision.decision, 'deny');
});
