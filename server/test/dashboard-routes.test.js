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

async function seedUserWithCookie(role) {
  const { rows: [tenant] } = await pool.query(`INSERT INTO tenants (name) VALUES ('Test Co') RETURNING id`);
  const hash = await hashPassword('x');
  const { rows: [user] } = await pool.query(
    `INSERT INTO users (tenant_id, email, password_hash, role, display_name)
     VALUES ($1, 'u@test.co', $2, $3, 'U') RETURNING id`,
    [tenant.id, hash, role],
  );
  const { token } = await createSession(pool, { userId: user.id, tenantId: tenant.id });
  return `session=s:${sign.sign(token, process.env.COOKIE_SECRET)}`;
}

test('unauthenticated GET /dashboard redirects to 401 (no session)', async () => {
  const res = await request(createApp()).get('/dashboard');
  assert.equal(res.status, 401);
});

test('GET /dashboard redirects supervisor to /dashboard/supervisor', async () => {
  const cookie = await seedUserWithCookie('supervisor');
  const res = await request(createApp()).get('/dashboard').set('Cookie', [cookie]);
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/dashboard/supervisor');
});

test('supervisor hitting /dashboard/accounting directly gets 403', async () => {
  const cookie = await seedUserWithCookie('supervisor');
  const res = await request(createApp()).get('/dashboard/accounting').set('Cookie', [cookie]);
  assert.equal(res.status, 403);
});

test('accounting hitting their own dashboard gets 200', async () => {
  const cookie = await seedUserWithCookie('accounting');
  const res = await request(createApp()).get('/dashboard/accounting').set('Cookie', [cookie]);
  assert.equal(res.status, 200);
});

test('accounting hitting their own dashboard gets 200 with real content', async () => {
  const cookie = await seedUserWithCookie('accounting');
  const res = await request(createApp()).get('/dashboard/accounting').set('Cookie', [cookie]);
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.text, /land here in a later build/);
});

test('supervisor hitting their own dashboard gets 200 with real content', async () => {
  const cookie = await seedUserWithCookie('supervisor');
  const res = await request(createApp()).get('/dashboard/supervisor').set('Cookie', [cookie]);
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.text, /land here in a later build/);
});

test('owner_admin hitting their own dashboard gets 200 with real content', async () => {
  const cookie = await seedUserWithCookie('owner_admin');
  const res = await request(createApp()).get('/dashboard/owner').set('Cookie', [cookie]);
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.text, /land here in a later build/);
});
