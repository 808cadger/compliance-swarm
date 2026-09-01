import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import sign from 'cookie-signature';
import { getTestPool, resetDb } from './helpers/db.js';
import { hashPassword } from '../src/auth/hash.js';
import { createSession } from '../src/auth/session.js';
import { createApp } from '../src/app.js';
import { evaluateProcessAccess } from '../src/services/processAccess.js';

const pool = getTestPool();
beforeEach(async () => { await resetDb(pool); });
after(async () => { await pool.end(); });

async function seedUserWithCookie(role, tenantName = 'Test Co') {
  const { rows: [tenant] } = await pool.query(`INSERT INTO tenants (name) VALUES ($1) RETURNING id`, [tenantName]);
  const hash = await hashPassword('x');
  const { rows: [user] } = await pool.query(
    `INSERT INTO users (tenant_id, email, password_hash, role, display_name)
     VALUES ($1, $2, $3, $4, 'U') RETURNING id`,
    [tenant.id, `${role}-${Math.random().toString(36).slice(2)}@test.co`, hash, role],
  );
  const { token } = await createSession(pool, { userId: user.id, tenantId: tenant.id });
  const cookie = `session=s:${sign.sign(token, process.env.COOKIE_SECRET)}`;
  return { cookie, tenantId: tenant.id, userId: user.id };
}

test('a non-owner cannot view or change process access overrides', async () => {
  const supervisor = await seedUserWithCookie('supervisor');
  const app = createApp();
  assert.equal((await request(app).get('/api/process-access').set('Cookie', [supervisor.cookie])).status, 403);
  assert.equal(
    (await request(app).put('/api/process-access/supervisor/foreman_snap').set('Cookie', [supervisor.cookie]).send({ enabled: false })).status,
    403,
  );
});

test('owner can force-deny a role\'s access to a Process, and it takes effect immediately', async () => {
  const owner = await seedUserWithCookie('owner_admin');
  const app = createApp();

  const before = await request(app).get('/api/process-access').set('Cookie', [owner.cookie]);
  const row = before.body.find((r) => r.role === 'supervisor' && r.processKey === 'foreman_snap');
  assert.equal(row.effectiveEnabled, true);

  const put = await request(app)
    .put('/api/process-access/supervisor/foreman_snap')
    .set('Cookie', [owner.cookie])
    .send({ enabled: false });
  assert.equal(put.status, 200);

  const decision = await evaluateProcessAccess(pool, {
    tenantId: owner.tenantId, userId: 'irrelevant-for-this-check', role: 'supervisor', processKey: 'foreman_snap',
  });
  assert.equal(decision.decision, 'deny');

  const { rows } = await pool.query(`SELECT event_type FROM audit_log WHERE event_type = 'process_access_overridden'`);
  assert.equal(rows.length, 1);
});

test('an override cannot grant a role a Process it has no base eligibility for at all', async () => {
  const owner = await seedUserWithCookie('owner_admin');
  const res = await request(createApp())
    .put('/api/process-access/field_worker/owner_process')
    .set('Cookie', [owner.cookie])
    .send({ enabled: true });
  assert.equal(res.status, 400);
});

test('an override is scoped to the tenant that created it, not global', async () => {
  const ownerA = await seedUserWithCookie('owner_admin', 'Tenant A');
  const ownerB = await seedUserWithCookie('owner_admin', 'Tenant B');
  const app = createApp();

  await request(app)
    .put('/api/process-access/supervisor/foreman_snap')
    .set('Cookie', [ownerA.cookie])
    .send({ enabled: false });

  const decisionA = await evaluateProcessAccess(pool, { tenantId: ownerA.tenantId, userId: 'x', role: 'supervisor', processKey: 'foreman_snap' });
  const decisionB = await evaluateProcessAccess(pool, { tenantId: ownerB.tenantId, userId: 'x', role: 'supervisor', processKey: 'foreman_snap' });
  assert.equal(decisionA.decision, 'deny');
  assert.equal(decisionB.decision, 'allow');
});

test('setting requiresSiteAssignment on ForemanSnap enforces per-site scoping for foremen, without touching Field Worker\'s own requirement', async () => {
  const owner = await seedUserWithCookie('owner_admin');
  const app = createApp();

  await request(app)
    .put('/api/process-access/supervisor/foreman_snap')
    .set('Cookie', [owner.cookie])
    .send({ requiresSiteAssignment: true });

  const { rows: [site] } = await pool.query(`INSERT INTO sites (tenant_id, name) VALUES ($1, 'Site A') RETURNING id`, [owner.tenantId]);
  const { rows: [foreman] } = await pool.query(
    `INSERT INTO users (tenant_id, email, password_hash, role, display_name) VALUES ($1, 'f@test.co', 'x', 'supervisor', 'F') RETURNING id`,
    [owner.tenantId],
  );

  const beforeAssignment = await evaluateProcessAccess(pool, { tenantId: owner.tenantId, userId: foreman.id, role: 'supervisor', processKey: 'foreman_snap' });
  assert.equal(beforeAssignment.decision, 'deny');

  await pool.query(`INSERT INTO user_site_assignments (tenant_id, user_id, site_id) VALUES ($1, $2, $3)`, [owner.tenantId, foreman.id, site.id]);

  const afterAssignment = await evaluateProcessAccess(pool, { tenantId: owner.tenantId, userId: foreman.id, role: 'supervisor', processKey: 'foreman_snap' });
  assert.equal(afterAssignment.decision, 'allow');

  // Field Worker's own (global-default) site requirement is unaffected by this tenant's
  // ForemanSnap override on a different role.
  const { rows: [fieldWorker] } = await pool.query(
    `INSERT INTO users (tenant_id, email, password_hash, role, display_name) VALUES ($1, 'fw@test.co', 'x', 'field_worker', 'FW') RETURNING id`,
    [owner.tenantId],
  );
  const fieldSnapDecision = await evaluateProcessAccess(pool, { tenantId: owner.tenantId, userId: fieldWorker.id, role: 'field_worker', processKey: 'field_snap' });
  assert.equal(fieldSnapDecision.decision, 'deny');
  assert.ok(fieldSnapDecision.reasons.includes('no_site_assignment'));
});

test('resetting an override deletes it and reverts to the global default', async () => {
  const owner = await seedUserWithCookie('owner_admin');
  const app = createApp();
  await request(app).put('/api/process-access/supervisor/foreman_snap').set('Cookie', [owner.cookie]).send({ enabled: false });

  const del = await request(app).delete('/api/process-access/supervisor/foreman_snap').set('Cookie', [owner.cookie]);
  assert.equal(del.status, 204);

  const decision = await evaluateProcessAccess(pool, { tenantId: owner.tenantId, userId: 'x', role: 'supervisor', processKey: 'foreman_snap' });
  assert.equal(decision.decision, 'allow');
});

test('a partial update only touches the field that was sent, leaving the other override intact', async () => {
  const owner = await seedUserWithCookie('owner_admin');
  const app = createApp();

  await request(app).put('/api/process-access/supervisor/foreman_snap').set('Cookie', [owner.cookie]).send({ enabled: false });
  await request(app).put('/api/process-access/supervisor/foreman_snap').set('Cookie', [owner.cookie]).send({ requiresSiteAssignment: true });

  const list = await request(app).get('/api/process-access').set('Cookie', [owner.cookie]);
  const row = list.body.find((r) => r.role === 'supervisor' && r.processKey === 'foreman_snap');
  assert.equal(row.overrideEnabled, false, 'the earlier enabled:false override must survive an unrelated field update');
  assert.equal(row.overrideRequiresSiteAssignment, true);
});

// --- Site assignments admin ---

test('a non-owner cannot manage site assignments', async () => {
  const supervisor = await seedUserWithCookie('supervisor');
  const res = await request(createApp()).get('/api/site-assignments?userId=x').set('Cookie', [supervisor.cookie]);
  assert.equal(res.status, 403);
});

test('assigning and removing a site assignment works and is audited, tenant-scoped', async () => {
  const owner = await seedUserWithCookie('owner_admin');
  const { rows: [site] } = await pool.query(`INSERT INTO sites (tenant_id, name) VALUES ($1, 'Site A') RETURNING id`, [owner.tenantId]);
  const { rows: [worker] } = await pool.query(
    `INSERT INTO users (tenant_id, email, password_hash, role, display_name) VALUES ($1, 'w@test.co', 'x', 'field_worker', 'W') RETURNING id`,
    [owner.tenantId],
  );
  const app = createApp();

  const post = await request(app)
    .post('/api/site-assignments')
    .set('Cookie', [owner.cookie])
    .send({ userId: worker.id, siteId: site.id });
  assert.equal(post.status, 201);

  const list = await request(app).get(`/api/site-assignments?userId=${worker.id}`).set('Cookie', [owner.cookie]);
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].siteName, 'Site A');

  const del = await request(app).delete(`/api/site-assignments/${post.body.id}`).set('Cookie', [owner.cookie]);
  assert.equal(del.status, 204);

  const { rows } = await pool.query(
    `SELECT event_type FROM audit_log WHERE event_type IN ('user_site_assignment_added', 'user_site_assignment_removed') ORDER BY id`,
  );
  assert.deepEqual(rows.map((r) => r.event_type), ['user_site_assignment_added', 'user_site_assignment_removed']);
});

test('cannot assign a user to a site belonging to another tenant', async () => {
  const ownerA = await seedUserWithCookie('owner_admin', 'Tenant A');
  const ownerB = await seedUserWithCookie('owner_admin', 'Tenant B');
  const { rows: [siteB] } = await pool.query(`INSERT INTO sites (tenant_id, name) VALUES ($1, 'Site B') RETURNING id`, [ownerB.tenantId]);
  const { rows: [workerA] } = await pool.query(
    `INSERT INTO users (tenant_id, email, password_hash, role, display_name) VALUES ($1, 'w@test.co', 'x', 'field_worker', 'W') RETURNING id`,
    [ownerA.tenantId],
  );

  const res = await request(createApp())
    .post('/api/site-assignments')
    .set('Cookie', [ownerA.cookie])
    .send({ userId: workerA.id, siteId: siteB.id });
  assert.equal(res.status, 400);
});
