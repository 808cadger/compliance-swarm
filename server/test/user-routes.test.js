import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { getTestPool, resetDb } from './helpers/db.js';
import { hashPassword } from '../src/auth/hash.js';
import { createSession } from '../src/auth/session.js';
import sign from 'cookie-signature';
import { createApp } from '../src/app.js';

const pool = getTestPool();
beforeEach(async () => { await resetDb(pool); });
after(async () => { await pool.end(); });

async function seedUserWithCookie(role) {
  const { rows: [tenant] } = await pool.query(`INSERT INTO tenants (name) VALUES ('Test Co') RETURNING id`);
  const hash = await hashPassword('x');
  const { rows: [user] } = await pool.query(
    `INSERT INTO users (tenant_id, email, password_hash, role, display_name)
     VALUES ($1, 'u@test.co', $2, $3, 'U') RETURNING id`,
    [tenant.id, hash, role],
  );
  const { token } = await createSession(pool, { userId: user.id, tenantId: tenant.id });
  const cookie = `session=s:${sign.sign(token, process.env.COOKIE_SECRET)}`;
  return { cookie, tenantId: tenant.id, userId: user.id };
}

test('owner_admin can create a user, and the creation is audited', async () => {
  const { cookie, tenantId, userId } = await seedUserWithCookie('owner_admin');
  const res = await request(createApp())
    .post('/api/users')
    .set('Cookie', [cookie])
    .send({ email: 'new@test.co', displayName: 'New', role: 'supervisor', tempPassword: 'temp12345678' });
  assert.equal(res.status, 201);
  assert.equal(res.body.role, 'supervisor');

  // The spec requires a role change to leave an audit trail, and creating an account is the
  // first assignment of one. target_id is a text column holding the new user's uuid.
  const { rows } = await pool.query(
    `SELECT event_type, tenant_id, actor_user_id, target_type, target_id, metadata FROM audit_log ORDER BY id`,
  );
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    event_type: 'user_created',
    tenant_id: tenantId,
    actor_user_id: userId,
    target_type: 'user',
    target_id: res.body.id,
    metadata: { role: 'supervisor' },
  });
});

test('creating a user with an email already in the tenant returns 409, not 500', async () => {
  const { cookie } = await seedUserWithCookie('owner_admin');
  const res = await request(createApp())
    .post('/api/users')
    .set('Cookie', [cookie])
    .send({ email: 'u@test.co', displayName: 'Dupe', role: 'supervisor', tempPassword: 'temp12345678' });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'conflict');
});

test('supervisor cannot create a user', async () => {
  const { cookie } = await seedUserWithCookie('supervisor');
  const res = await request(createApp())
    .post('/api/users')
    .set('Cookie', [cookie])
    .send({ email: 'new@test.co', displayName: 'New', role: 'supervisor', tempPassword: 'temp12345678' });
  assert.equal(res.status, 403);
});

test('a tempPassword under the 12-character minimum is rejected', async () => {
  const { cookie } = await seedUserWithCookie('owner_admin');
  const res = await request(createApp())
    .post('/api/users')
    .set('Cookie', [cookie])
    .send({ email: 'new@test.co', displayName: 'New', role: 'supervisor', tempPassword: 'elevenchar' + 'x' });

  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'bad_request');
  assert.match(res.body.error.message, /at least 12 characters/);

  const { rows } = await pool.query(`SELECT id FROM users WHERE email = 'new@test.co'`);
  assert.equal(rows.length, 0, 'the account must not be created');
});

test('accounting cannot list users', async () => {
  const { cookie } = await seedUserWithCookie('accounting');
  const res = await request(createApp()).get('/api/users').set('Cookie', [cookie]);
  assert.equal(res.status, 403);
});

test('GET /api/users only returns users in the caller\'s tenant', async () => {
  const { cookie, tenantId } = await seedUserWithCookie('owner_admin');
  const { rows: [otherTenant] } = await pool.query(`INSERT INTO tenants (name) VALUES ('Other Co') RETURNING id`);
  await pool.query(
    `INSERT INTO users (tenant_id, email, password_hash, role, display_name)
     VALUES ($1, 'other@other.co', 'x', 'owner_admin', 'Other')`,
    [otherTenant.id],
  );
  const res = await request(createApp()).get('/api/users').set('Cookie', [cookie]);
  assert.equal(res.status, 200);
  assert.ok(res.body.every(u => u.email !== 'other@other.co'));
});
