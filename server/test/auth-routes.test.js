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
  await pool.query(
    `INSERT INTO users (tenant_id, email, password_hash, role, display_name, disabled_at)
     VALUES ($1, 'u@test.co', $2, $3, 'U', $4)`,
    [tenant.id, hash, role, disabled ? new Date() : null],
  );
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

test('11th login attempt within the window is rate limited', async () => {
  await seedUser();
  const app = createApp();
  for (let i = 0; i < 10; i++) {
    await request(app).post('/api/auth/login').send({ email: 'u@test.co', password: 'wrong' });
  }
  const res = await request(app).post('/api/auth/login').send({ email: 'u@test.co', password: 'wrong' });
  assert.equal(res.status, 429);
});
