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

async function seedUserWithCookie(role, tenantName = 'Test Co') {
  const { rows: [tenant] } = await pool.query(`INSERT INTO tenants (name) VALUES ($1) RETURNING id`, [tenantName]);
  const hash = await hashPassword('x');
  const { rows: [user] } = await pool.query(
    `INSERT INTO users (tenant_id, email, password_hash, role, display_name)
     VALUES ($1, 'u@test.co', $2, $3, 'U') RETURNING id`,
    [tenant.id, hash, role],
  );
  const { token } = await createSession(pool, { userId: user.id, tenantId: tenant.id });
  return { cookie: `session=s:${sign.sign(token, process.env.COOKIE_SECRET)}`, tenantId: tenant.id };
}

test('owner_admin can create a site', async () => {
  const { cookie } = await seedUserWithCookie('owner_admin');
  const res = await request(createApp()).post('/api/sites').set('Cookie', [cookie]).send({ name: 'Main Shop' });
  assert.equal(res.status, 201);
  assert.equal(res.body.name, 'Main Shop');
  assert.equal(res.body.active, true);
});

test('supervisor cannot create a site', async () => {
  const { cookie } = await seedUserWithCookie('supervisor');
  const res = await request(createApp()).post('/api/sites').set('Cookie', [cookie]).send({ name: 'Main Shop' });
  assert.equal(res.status, 403);
});

test('accounting cannot list sites', async () => {
  const { cookie } = await seedUserWithCookie('accounting');
  const res = await request(createApp()).get('/api/sites').set('Cookie', [cookie]);
  assert.equal(res.status, 403);
});

test('supervisor can list active sites, sorted, tenant-scoped', async () => {
  const { cookie, tenantId } = await seedUserWithCookie('supervisor');
  await pool.query(`INSERT INTO sites (tenant_id, name) VALUES ($1, 'Zeta Site'), ($1, 'Alpha Site')`, [tenantId]);
  const { rows: [otherTenant] } = await pool.query(`INSERT INTO tenants (name) VALUES ('Other Co') RETURNING id`);
  await pool.query(`INSERT INTO sites (tenant_id, name) VALUES ($1, 'Other Tenant Site')`, [otherTenant.id]);

  const res = await request(createApp()).get('/api/sites').set('Cookie', [cookie]);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.map(s => s.name), ['Alpha Site', 'Zeta Site']);
});

test('inactive sites are excluded from the list', async () => {
  const { cookie, tenantId } = await seedUserWithCookie('owner_admin');
  await pool.query(`INSERT INTO sites (tenant_id, name, active) VALUES ($1, 'Retired Site', false)`, [tenantId]);
  const res = await request(createApp()).get('/api/sites').set('Cookie', [cookie]);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, []);
});
