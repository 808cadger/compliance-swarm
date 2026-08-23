import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import sign from 'cookie-signature';
import { getTestPool, resetDb } from './helpers/db.js';
import { createSession } from '../src/auth/session.js';
import authenticate from '../src/middleware/authenticate.js';
import requireRole from '../src/middleware/requireRole.js';

const pool = getTestPool();
const COOKIE_SECRET = 'test-secret';

beforeEach(async () => { await resetDb(pool); });
after(async () => { await pool.end(); });

function buildApp() {
  const app = express();
  app.use(cookieParser(COOKIE_SECRET));
  app.get('/protected', authenticate(pool), requireRole('owner_admin'), (req, res) => {
    res.json({ role: req.user.role });
  });
  return app;
}

async function seedUserAndCookie(role = 'owner_admin') {
  const { rows: [tenant] } = await pool.query(`INSERT INTO tenants (name) VALUES ('Test Co') RETURNING id`);
  const { rows: [user] } = await pool.query(
    `INSERT INTO users (tenant_id, email, password_hash, role, display_name)
     VALUES ($1, 'u@test.co', 'x', $2, 'U') RETURNING id`,
    [tenant.id, role],
  );
  const { token } = await createSession(pool, { userId: user.id, tenantId: tenant.id });
  return `session=s:${sign.sign(token, COOKIE_SECRET)}`;
}

test('no cookie -> 401', async () => {
  const res = await request(buildApp()).get('/protected');
  assert.equal(res.status, 401);
});

test('valid session, wrong role -> 403', async () => {
  const cookie = await seedUserAndCookie('supervisor');
  const res = await request(buildApp())
    .get('/protected')
    .set('Cookie', [cookie]);
  assert.equal(res.status, 403);
});

test('valid session, correct role -> 200', async () => {
  const cookie = await seedUserAndCookie('owner_admin');
  const res = await request(buildApp())
    .get('/protected')
    .set('Cookie', [cookie]);
  assert.equal(res.status, 200);
});
