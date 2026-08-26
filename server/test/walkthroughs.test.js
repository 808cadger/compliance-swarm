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

async function seedUserWithCookie(role, email = 'u@test.co') {
  const { rows: [tenant] } = await pool.query(`INSERT INTO tenants (name) VALUES ('Test Co') RETURNING id`);
  const hash = await hashPassword('x');
  const { rows: [user] } = await pool.query(
    `INSERT INTO users (tenant_id, email, password_hash, role, display_name)
     VALUES ($1, $2, $3, $4, 'U') RETURNING id`,
    [tenant.id, email, hash, role],
  );
  const { token } = await createSession(pool, { userId: user.id, tenantId: tenant.id });
  return { cookie: `session=s:${sign.sign(token, process.env.COOKIE_SECRET)}`, tenantId: tenant.id, userId: user.id };
}

async function seedSite(tenantId, name = 'Main Shop') {
  const { rows: [site] } = await pool.query(`INSERT INTO sites (tenant_id, name) VALUES ($1, $2) RETURNING id`, [tenantId, name]);
  return site.id;
}

test('supervisor can create a walkthrough for an active site in their tenant', async () => {
  const { cookie, tenantId } = await seedUserWithCookie('supervisor');
  const siteId = await seedSite(tenantId);
  const res = await request(createApp()).post('/api/walkthroughs').set('Cookie', [cookie]).send({ siteId, slot: 'morning', notes: 'all clear' });
  assert.equal(res.status, 201);
  assert.equal(res.body.slot, 'morning');
});

test('accounting cannot create a walkthrough', async () => {
  const { cookie, tenantId } = await seedUserWithCookie('accounting');
  const siteId = await seedSite(tenantId);
  const res = await request(createApp()).post('/api/walkthroughs').set('Cookie', [cookie]).send({ siteId, slot: 'morning' });
  assert.equal(res.status, 403);
});

test('creating a walkthrough for a site in another tenant is rejected', async () => {
  const { cookie } = await seedUserWithCookie('supervisor');
  const { rows: [otherTenant] } = await pool.query(`INSERT INTO tenants (name) VALUES ('Other Co') RETURNING id`);
  const foreignSiteId = await seedSite(otherTenant.id);
  const res = await request(createApp()).post('/api/walkthroughs').set('Cookie', [cookie]).send({ siteId: foreignSiteId, slot: 'morning' });
  assert.equal(res.status, 400);
});

test('supervisor sees only their own walkthroughs; owner_admin sees all', async () => {
  const supA = await seedUserWithCookie('supervisor', 'a@test.co');
  const siteId = await seedSite(supA.tenantId);
  await pool.query(`INSERT INTO walkthroughs (tenant_id, site_id, supervisor_id, slot) VALUES ($1, $2, $3, 'morning')`, [supA.tenantId, siteId, supA.userId]);

  const hash = await hashPassword('x');
  const { rows: [supB] } = await pool.query(
    `INSERT INTO users (tenant_id, email, password_hash, role, display_name) VALUES ($1, 'b@test.co', $2, 'supervisor', 'B') RETURNING id`,
    [supA.tenantId, hash],
  );
  await pool.query(`INSERT INTO walkthroughs (tenant_id, site_id, supervisor_id, slot) VALUES ($1, $2, $3, 'afternoon')`, [supA.tenantId, siteId, supB.id]);

  const resA = await request(createApp()).get('/api/walkthroughs').set('Cookie', [supA.cookie]);
  assert.equal(resA.body.length, 1);
  assert.equal(resA.body[0].slot, 'morning');

  const { rows: [ownerRow] } = await pool.query(
    `INSERT INTO users (tenant_id, email, password_hash, role, display_name) VALUES ($1, 'owner@test.co', $2, 'owner_admin', 'Owner') RETURNING id`,
    [supA.tenantId, hash],
  );
  const { token } = await createSession(pool, { userId: ownerRow.id, tenantId: supA.tenantId });
  const ownerCookie = `session=s:${sign.sign(token, process.env.COOKIE_SECRET)}`;
  const resOwner = await request(createApp()).get('/api/walkthroughs').set('Cookie', [ownerCookie]);
  assert.equal(resOwner.body.length, 2);
});

test('today-status reports morning and afternoon independently', async () => {
  const { cookie, tenantId, userId } = await seedUserWithCookie('supervisor');
  const siteId = await seedSite(tenantId);
  await pool.query(`INSERT INTO walkthroughs (tenant_id, site_id, supervisor_id, slot) VALUES ($1, $2, $3, 'morning')`, [tenantId, siteId, userId]);

  const res = await request(createApp()).get('/api/walkthroughs/today-status').set('Cookie', [cookie]);
  assert.deepEqual(res.body, { morningDone: true, afternoonDone: false });
});

test("today-status does not count yesterday's walkthrough", async () => {
  const { cookie, tenantId, userId } = await seedUserWithCookie('supervisor');
  const siteId = await seedSite(tenantId);
  await pool.query(
    `INSERT INTO walkthroughs (tenant_id, site_id, supervisor_id, slot, created_at)
     VALUES ($1, $2, $3, 'morning', now() - interval '1 day')`,
    [tenantId, siteId, userId],
  );
  const res = await request(createApp()).get('/api/walkthroughs/today-status').set('Cookie', [cookie]);
  assert.deepEqual(res.body, { morningDone: false, afternoonDone: false });
});
