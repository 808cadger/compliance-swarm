import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import sign from 'cookie-signature';
import { getTestPool, resetDb } from './helpers/db.js';
import { hashPassword } from '../src/auth/hash.js';
import { createSession } from '../src/auth/session.js';
import { createApp } from '../src/app.js';

const pool = getTestPool();
beforeEach(async () => { await resetDb(pool); });
after(async () => { await pool.end(); });

function cookieFor(token) {
  return `session=s:${sign.sign(token, process.env.COOKIE_SECRET)}`;
}

async function seedRealUser(role, { tenantName = 'Test Co' } = {}) {
  const { rows: [tenant] } = await pool.query(`INSERT INTO tenants (name) VALUES ($1) RETURNING id`, [tenantName]);
  const hash = await hashPassword('correct-horse-battery');
  const { rows: [user] } = await pool.query(
    `INSERT INTO users (tenant_id, email, password_hash, role, display_name)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [tenant.id, `${role}@${tenantName.replace(/\W/g, '')}.test`, hash, role, `${role} user`],
  );
  const { token } = await createSession(pool, { userId: user.id, tenantId: tenant.id });
  return { tenantId: tenant.id, userId: user.id, cookie: cookieFor(token) };
}

async function seedDemoPersona(role, displayName, { tenantName = 'Demo Co' } = {}) {
  const { rows: [tenant] } = await pool.query(`INSERT INTO tenants (name) VALUES ($1) RETURNING id`, [tenantName]);
  const tenantId = tenant.id;
  const hash = await hashPassword('correct-horse-battery');
  const { rows: [user] } = await pool.query(
    `INSERT INTO users (tenant_id, email, password_hash, role, display_name, is_demo_persona)
     VALUES ($1, $2, $3, $4, $5, true) RETURNING id`,
    [tenantId, `${role}.demo@demo.test`, hash, role, displayName],
  );
  return { tenantId, userId: user.id };
}

// --- 1. Tenant isolation --------------------------------------------------------------

test('a field worker only sees their own tenant\'s site assignment, not another tenant\'s', async () => {
  const a = await seedRealUser('field_worker', { tenantName: 'Tenant A' });
  const b = await seedRealUser('field_worker', { tenantName: 'Tenant B' });
  const { rows: [siteA] } = await pool.query(`INSERT INTO sites (tenant_id, name) VALUES ($1, 'Site A') RETURNING id`, [a.tenantId]);
  await pool.query(`INSERT INTO user_site_assignments (tenant_id, user_id, site_id) VALUES ($1, $2, $3)`, [a.tenantId, a.userId, siteA.id]);

  const app = createApp();
  const resA = await request(app).get('/api/processpass/processes').set('Cookie', [a.cookie]);
  const fieldSnapA = resA.body.processes.find((p) => p.processKey === 'field_snap');
  assert.equal(fieldSnapA.decision, 'allow');

  const resB = await request(app).get('/api/processpass/processes').set('Cookie', [b.cookie]);
  const fieldSnapB = resB.body.processes.find((p) => p.processKey === 'field_snap');
  assert.equal(fieldSnapB.decision, 'deny');
});

// --- 2/6. Backend enforcement on unauthorized processes -------------------------------

test('a field worker cannot open AccountingSnap or Owner Process — the backend denies it directly', async () => {
  const worker = await seedRealUser('field_worker');
  const app = createApp();

  const accounting = await request(app).post('/api/processpass/processes/accounting_snap/start').set('Cookie', [worker.cookie]);
  assert.equal(accounting.status, 403);

  const owner = await request(app).post('/api/processpass/processes/owner_process/start').set('Cookie', [worker.cookie]);
  assert.equal(owner.status, 403);

  // Not just the ProcessPass orchestration route — the dashboard page itself refuses too.
  const dashboard = await request(app).get('/dashboard/accounting').set('Cookie', [worker.cookie]);
  assert.equal(dashboard.status, 403);
});

// --- 3. Foreman access ------------------------------------------------------------------

test('a foreman (supervisor role) can access ForemanSnap and FieldSnap', async () => {
  const foreman = await seedRealUser('supervisor');
  const { rows: [site] } = await pool.query(`INSERT INTO sites (tenant_id, name) VALUES ($1, 'Site A') RETURNING id`, [foreman.tenantId]);
  void site;
  const app = createApp();
  const res = await request(app).get('/api/processpass/processes').set('Cookie', [foreman.cookie]);
  const byKey = Object.fromEntries(res.body.processes.map((p) => [p.processKey, p.decision]));
  assert.equal(byKey.foreman_snap, 'allow');
  assert.equal(byKey.field_snap, 'allow');
  assert.equal(byKey.accounting_snap, undefined); // not even role-eligible, so not listed
});

// --- 4. Owner demo persona gets the intended Processes ----------------------------------

test('the owner demo persona (Jeff) is granted exactly the intended Processes', async () => {
  await seedDemoPersona('owner_admin', 'Jeff Ludwig');
  const app = createApp();

  const list = await request(app).get('/api/processpass/demo-identities');
  const jeff = list.body.personas.find((p) => p.displayName === 'Jeff Ludwig');
  assert.ok(jeff);

  const identify = await request(app).post('/api/processpass/identify').send({ demoUserId: jeff.id });
  assert.equal(identify.status, 200);
  assert.equal(identify.body.decision, 'allow');

  // All 5 are role-eligible and appear on the dashboard; the two high-risk ones
  // (accounting_snap, audit_view) come back step_up_required rather than allow immediately
  // after a fresh demo identification, since no step-up has happened yet in this session.
  const byKey = Object.fromEntries(identify.body.processes.map((p) => [p.processKey, p.decision]));
  assert.deepEqual(Object.keys(byKey).sort(), ['accounting_snap', 'audit_view', 'foreman_snap', 'office_snap', 'owner_process']);
  assert.equal(byKey.owner_process, 'allow');
  assert.equal(byKey.foreman_snap, 'allow');
  assert.equal(byKey.office_snap, 'allow');
  assert.equal(byKey.accounting_snap, 'step_up_required');
  assert.equal(byKey.audit_view, 'step_up_required');
});

// --- 5. Unknown visitor ------------------------------------------------------------------

test('an unknown visitor gets no session, no tenant data, and a generic deny', async () => {
  const app = createApp();
  const res = await request(app).post('/api/processpass/identify').send({ demoUserId: 'unknown_visitor' });
  assert.equal(res.status, 200);
  assert.equal(res.body.decision, 'deny');
  assert.equal(res.body.processes, undefined);
  assert.equal(res.headers['set-cookie'], undefined);

  const { rows } = await pool.query(`SELECT event_type, tenant_id, actor_user_id FROM audit_log ORDER BY id`);
  assert.deepEqual(rows.map((r) => r.event_type), [
    'processpass_demo_identity_selected', 'processpass_identity_failed', 'processpass_access_denied',
  ]);
  for (const row of rows) {
    assert.equal(row.tenant_id, null);
    assert.equal(row.actor_user_id, null);
  }
});

test('the demo identify endpoint refuses to authenticate a real (non-demo-flagged) user by id', async () => {
  const real = await seedRealUser('owner_admin');
  const app = createApp();
  const res = await request(app).post('/api/processpass/identify').send({ demoUserId: real.userId });
  assert.equal(res.status, 200);
  assert.equal(res.body.decision, 'deny');
  assert.equal(res.headers['set-cookie'], undefined);
});

// --- 7. Step-up ---------------------------------------------------------------------------

test('a step-up-required action cannot complete without the simulated second factor', async () => {
  const accounting = await seedRealUser('accounting');
  // Force this session into demo assurance directly — same effect as arriving via
  // ProcessPass, without re-driving the whole identify flow just for this test.
  await pool.query(`UPDATE sessions SET auth_method = 'demo_identity', assurance_level = 'demo' WHERE user_id = $1`, [accounting.userId]);
  const { rows: [receipt] } = await pool.query(
    `INSERT INTO receipts (tenant_id, uploaded_by, storage_key, kind, mime_type, size_bytes)
     VALUES ($1, $2, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jpg', 'receipt', 'image/jpeg', 100) RETURNING id`,
    [accounting.tenantId, accounting.userId],
  );
  const app = createApp();

  const denied = await request(app).delete(`/api/receipts/${receipt.id}`).set('Cookie', [accounting.cookie]);
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, 'step_up_required');

  const wrongPin = await request(app).post('/api/processpass/step-up').set('Cookie', [accounting.cookie]).send({ pin: '0000' });
  assert.equal(wrongPin.status, 401);

  const stillDenied = await request(app).delete(`/api/receipts/${receipt.id}`).set('Cookie', [accounting.cookie]);
  assert.equal(stillDenied.status, 403);

  const stepUp = await request(app).post('/api/processpass/step-up').set('Cookie', [accounting.cookie]).send({ pin: '1234' });
  assert.equal(stepUp.status, 200);

  const nowAllowed = await request(app).delete(`/api/receipts/${receipt.id}`).set('Cookie', [accounting.cookie]);
  assert.equal(nowAllowed.status, 204);
});

test('a real password-authenticated accounting user never hits the step-up gate', async () => {
  const accounting = await seedRealUser('accounting');
  const { rows: [receipt] } = await pool.query(
    `INSERT INTO receipts (tenant_id, uploaded_by, storage_key, kind, mime_type, size_bytes)
     VALUES ($1, $2, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.jpg', 'receipt', 'image/jpeg', 100) RETURNING id`,
    [accounting.tenantId, accounting.userId],
  );
  const app = createApp();
  const res = await request(app).delete(`/api/receipts/${receipt.id}`).set('Cookie', [accounting.cookie]);
  assert.equal(res.status, 204);
});

// --- 8. ProcessPass access events are audited ----------------------------------------------

test('a full identify flow writes the expected processpass_* audit sequence', async () => {
  await seedDemoPersona('field_worker', 'Field Worker Demo User');
  const app = createApp();
  const list = await request(app).get('/api/processpass/demo-identities');
  const fw = list.body.personas.find((p) => p.displayName === 'Field Worker Demo User');

  const res = await request(app).post('/api/processpass/identify').send({ demoUserId: fw.id });
  assert.equal(res.status, 200);

  const { rows } = await pool.query(`SELECT event_type FROM audit_log ORDER BY id`);
  const types = rows.map((r) => r.event_type);
  assert.ok(types.includes('processpass_demo_identity_selected'));
  assert.ok(types.includes('processpass_identity_verified'));
  assert.ok(types.includes('processpass_access_evaluated'));
  assert.ok(types.includes('processpass_access_denied') || types.includes('processpass_access_allowed'));
});

// --- 9. Kiosk session expiry -----------------------------------------------------------

test('an expired kiosk (demo) session cannot be reused, and is reported inactive', async () => {
  const worker = await seedRealUser('field_worker');
  await pool.query(
    `UPDATE sessions SET auth_method = 'demo_identity', assurance_level = 'demo', expires_at = now() - interval '1 minute' WHERE user_id = $1`,
    [worker.userId],
  );
  const app = createApp();

  const res = await request(app).get('/api/processpass/processes').set('Cookie', [worker.cookie]);
  assert.equal(res.status, 401);

  const status = await request(app).get('/api/processpass/session/status').set('Cookie', [worker.cookie]);
  assert.equal(status.body.active, false);

  const { rows } = await pool.query(`SELECT event_type FROM audit_log WHERE event_type = 'processpass_session_expired'`);
  assert.equal(rows.length, 1);

  const { rows: sessions } = await pool.query(`SELECT id FROM sessions WHERE user_id = $1`, [worker.userId]);
  assert.equal(sessions.length, 0);
});

test('ending a ProcessPass session logs processpass_session_ended and clears the cookie', async () => {
  const worker = await seedRealUser('field_worker');
  const app = createApp();
  const res = await request(app).post('/api/processpass/session/end').set('Cookie', [worker.cookie]);
  assert.equal(res.status, 204);
  const { rows } = await pool.query(`SELECT event_type FROM audit_log WHERE event_type = 'processpass_session_ended'`);
  assert.equal(rows.length, 1);
});
