import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { getTestPool, resetDb } from './helpers/db.js';
import { hashPassword } from '../src/auth/hash.js';
import { createApp } from '../src/app.js';

const pool = getTestPool();
beforeEach(async () => { await resetDb(pool); });
after(async () => { await pool.end(); });

async function seedUser({ role = 'owner_admin', password = 'correct-horse-battery', disabled = false } = {}) {
  const { rows: [tenant] } = await pool.query(`INSERT INTO tenants (name) VALUES ('Test Co') RETURNING id`);
  const hash = await hashPassword(password);
  const { rows: [user] } = await pool.query(
    `INSERT INTO users (tenant_id, email, password_hash, role, display_name, disabled_at)
     VALUES ($1, 'u@test.co', $2, $3, 'U', $4) RETURNING id`,
    [tenant.id, hash, role, disabled ? new Date() : null],
  );
  return { tenantId: tenant.id, userId: user.id };
}

test('login with correct password sets cookie and returns role', async () => {
  await seedUser();
  const app = createApp();
  const res = await request(app).post('/api/auth/login').send({ email: 'u@test.co', password: 'correct-horse-battery' });
  assert.equal(res.status, 200);
  assert.equal(res.body.role, 'owner_admin');
  assert.ok(res.headers['set-cookie']?.[0].includes('session='));
  const { rows } = await pool.query(`SELECT event_type FROM audit_log`);
  assert.deepEqual(rows.map(r => r.event_type), ['login_success']);
});

test('login with wrong password returns generic error and audits login_failed', async () => {
  await seedUser();
  const res = await request(createApp()).post('/api/auth/login').send({ email: 'u@test.co', password: 'wrong' });
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, 'invalid_credentials');
  const { rows } = await pool.query(`SELECT event_type FROM audit_log`);
  assert.deepEqual(rows.map(r => r.event_type), ['login_failed']);
});

// The spec requires an audit row for every logout, not just every login. Driving this through
// a real login (rather than a hand-built session row) is what proves the cookie the client is
// actually given resolves back to the right user and tenant when it is spent on logout.
test('logout writes a logout audit row for the session it ends', async () => {
  const { tenantId, userId } = await seedUser();
  const app = createApp();

  const login = await request(app).post('/api/auth/login').send({ email: 'u@test.co', password: 'correct-horse-battery' });
  assert.equal(login.status, 200);
  const cookie = login.headers['set-cookie'];

  const logout = await request(app).post('/api/auth/logout').set('Cookie', cookie);
  assert.equal(logout.status, 204);

  const { rows } = await pool.query(
    `SELECT event_type, actor_user_id, tenant_id FROM audit_log ORDER BY id`,
  );
  assert.deepEqual(rows.map(r => r.event_type), ['login_success', 'logout']);
  const logoutRow = rows[1];
  assert.equal(logoutRow.actor_user_id, userId);
  assert.equal(logoutRow.tenant_id, tenantId);

  // The session must actually be gone, or the audit row records something that didn't happen.
  const { rows: sessions } = await pool.query(`SELECT id FROM sessions`);
  assert.equal(sessions.length, 0);
});

test('login with unknown email returns the same generic error', async () => {
  const res = await request(createApp()).post('/api/auth/login').send({ email: 'nobody@test.co', password: 'x' });
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, 'invalid_credentials');
});

test('login for a disabled user is rejected', async () => {
  await seedUser({ disabled: true });
  const res = await request(createApp()).post('/api/auth/login').send({ email: 'u@test.co', password: 'correct-horse-battery' });
  assert.equal(res.status, 401);
});

// UNIQUE (tenant_id, email) permits the same address in two tenants, and login is not
// tenant-scoped. Rather than guess which user was meant, the route fails closed — with the
// same body as every other login failure, so the client learns nothing about the collision.
test('login with an email present in two tenants fails closed and audits the real reason', async () => {
  const hash = await hashPassword('correct-horse-battery');
  for (const name of ['Test Co', 'Other Co']) {
    const { rows: [tenant] } = await pool.query(`INSERT INTO tenants (name) VALUES ($1) RETURNING id`, [name]);
    await pool.query(
      `INSERT INTO users (tenant_id, email, password_hash, role, display_name)
       VALUES ($1, 'u@test.co', $2, 'owner_admin', 'U')`,
      [tenant.id, hash],
    );
  }

  const res = await request(createApp())
    .post('/api/auth/login')
    .send({ email: 'u@test.co', password: 'correct-horse-battery' });

  // Correct password, but the account is ambiguous: still refused, and indistinguishable
  // from a wrong password or an unknown address.
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: { code: 'invalid_credentials', message: 'Invalid email or password' } });
  assert.equal(res.headers['set-cookie'], undefined);

  const { rows } = await pool.query(`SELECT event_type, metadata FROM audit_log`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event_type, 'login_failed');
  assert.equal(rows[0].metadata.reason, 'ambiguous_tenant');
  assert.equal(rows[0].metadata.tenantCount, 2);

  const { rows: sessions } = await pool.query(`SELECT id FROM sessions`);
  assert.equal(sessions.length, 0);
});

test('11th login attempt within the window is rate limited', async () => {
  await seedUser();
  const app = createApp();
  for (let i = 0; i < 10; i++) {
    await request(app).post('/api/auth/login').send({ email: 'u@test.co', password: 'wrong' });
  }
  const res = await request(app).post('/api/auth/login').send({ email: 'u@test.co', password: 'wrong' });
  assert.equal(res.status, 429);
});
