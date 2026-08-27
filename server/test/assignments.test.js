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

async function seedUserWithCookie(role, tenantId, email) {
  let resolvedTenantId = tenantId;
  if (!resolvedTenantId) {
    const { rows: [tenant] } = await pool.query(`INSERT INTO tenants (name) VALUES ('Test Co') RETURNING id`);
    resolvedTenantId = tenant.id;
  }
  const hash = await hashPassword('x');
  const { rows: [user] } = await pool.query(
    `INSERT INTO users (tenant_id, email, password_hash, role, display_name)
     VALUES ($1, $2, $3, $4, 'U') RETURNING id`,
    [resolvedTenantId, email ?? `${role}@test.co`, hash, role],
  );
  const { token } = await createSession(pool, { userId: user.id, tenantId: resolvedTenantId });
  return { cookie: `session=s:${sign.sign(token, process.env.COOKIE_SECRET)}`, tenantId: resolvedTenantId, userId: user.id };
}

async function seedSite(tenantId, name = 'Main Shop') {
  const { rows: [site] } = await pool.query(`INSERT INTO sites (tenant_id, name) VALUES ($1, $2) RETURNING id`, [tenantId, name]);
  return site.id;
}

test('owner_admin can assign a walkthrough to a supervisor', async () => {
  const owner = await seedUserWithCookie('owner_admin');
  const sup = await seedUserWithCookie('supervisor', owner.tenantId, 'sup@test.co');
  const siteId = await seedSite(owner.tenantId);
  const res = await request(createApp()).post('/api/assignments').set('Cookie', [owner.cookie])
    .send({ supervisorId: sup.userId, siteId, slot: 'morning', assignedDate: '2026-09-01' });
  assert.equal(res.status, 200);
  assert.equal(res.body.supervisorId, sup.userId);
  assert.equal(res.body.assignedDate, '2026-09-01');
});

test('accounting cannot create an assignment', async () => {
  const owner = await seedUserWithCookie('owner_admin');
  const sup = await seedUserWithCookie('supervisor', owner.tenantId, 'sup@test.co');
  const siteId = await seedSite(owner.tenantId);
  const accounting = await seedUserWithCookie('accounting', owner.tenantId, 'acct@test.co');
  const res = await request(createApp()).post('/api/assignments').set('Cookie', [accounting.cookie])
    .send({ supervisorId: sup.userId, siteId, slot: 'morning' });
  assert.equal(res.status, 403);
});

test('supervisor cannot create an assignment', async () => {
  const owner = await seedUserWithCookie('owner_admin');
  const sup = await seedUserWithCookie('supervisor', owner.tenantId, 'sup@test.co');
  const siteId = await seedSite(owner.tenantId);
  const res = await request(createApp()).post('/api/assignments').set('Cookie', [sup.cookie])
    .send({ supervisorId: sup.userId, siteId, slot: 'morning' });
  assert.equal(res.status, 403);
});

test('assigning to an unknown siteId is rejected', async () => {
  const owner = await seedUserWithCookie('owner_admin');
  const sup = await seedUserWithCookie('supervisor', owner.tenantId, 'sup@test.co');
  const res = await request(createApp()).post('/api/assignments').set('Cookie', [owner.cookie])
    .send({ supervisorId: sup.userId, siteId: '00000000-0000-0000-0000-000000000000', slot: 'morning' });
  assert.equal(res.status, 400);
});

test('assigning to a non-supervisor user is rejected', async () => {
  const owner = await seedUserWithCookie('owner_admin');
  const siteId = await seedSite(owner.tenantId);
  const accounting = await seedUserWithCookie('accounting', owner.tenantId, 'acct@test.co');
  const res = await request(createApp()).post('/api/assignments').set('Cookie', [owner.cookie])
    .send({ supervisorId: accounting.userId, siteId, slot: 'morning' });
  assert.equal(res.status, 400);
});

test('assigning to a disabled supervisor is rejected', async () => {
  const owner = await seedUserWithCookie('owner_admin');
  const sup = await seedUserWithCookie('supervisor', owner.tenantId, 'sup@test.co');
  await pool.query(`UPDATE users SET disabled_at = now() WHERE id = $1`, [sup.userId]);
  const siteId = await seedSite(owner.tenantId);
  const res = await request(createApp()).post('/api/assignments').set('Cookie', [owner.cookie])
    .send({ supervisorId: sup.userId, siteId, slot: 'morning' });
  assert.equal(res.status, 400);
});

test('a malformed assignedDate is rejected', async () => {
  const owner = await seedUserWithCookie('owner_admin');
  const sup = await seedUserWithCookie('supervisor', owner.tenantId, 'sup@test.co');
  const siteId = await seedSite(owner.tenantId);
  const res = await request(createApp()).post('/api/assignments').set('Cookie', [owner.cookie])
    .send({ supervisorId: sup.userId, siteId, slot: 'morning', assignedDate: '2026-02-30' });
  assert.equal(res.status, 400);
});

test('reassigning the same site+slot+date replaces the row: 200 both times, immutable created fields, mutable updated fields', async () => {
  const owner = await seedUserWithCookie('owner_admin');
  const supA = await seedUserWithCookie('supervisor', owner.tenantId, 'a@test.co');
  const supB = await seedUserWithCookie('supervisor', owner.tenantId, 'b@test.co');
  const siteId = await seedSite(owner.tenantId);

  const first = await request(createApp()).post('/api/assignments').set('Cookie', [owner.cookie])
    .send({ supervisorId: supA.userId, siteId, slot: 'morning', assignedDate: '2026-09-01' });
  assert.equal(first.status, 200);

  const second = await request(createApp()).post('/api/assignments').set('Cookie', [owner.cookie])
    .send({ supervisorId: supB.userId, siteId, slot: 'morning', assignedDate: '2026-09-01' });
  assert.equal(second.status, 200);
  assert.equal(second.body.id, first.body.id);
  assert.equal(second.body.supervisorId, supB.userId);
  assert.equal(second.body.createdAt, first.body.createdAt);
  assert.equal(second.body.createdBy, first.body.createdBy);
  assert.notEqual(second.body.updatedAt, first.body.updatedAt);
  assert.equal(second.body.updatedBy, owner.userId);

  const listRes = await request(createApp()).get('/api/assignments?date=2026-09-01').set('Cookie', [owner.cookie]);
  assert.equal(listRes.body.length, 1);
  assert.equal(listRes.body[0].supervisorId, supB.userId);
});

test('GET /api/assignments is tenant-scoped and supports siteId/date filters', async () => {
  const owner = await seedUserWithCookie('owner_admin');
  const sup = await seedUserWithCookie('supervisor', owner.tenantId, 'sup@test.co');
  const siteId = await seedSite(owner.tenantId, 'Site A');
  const otherSiteId = await seedSite(owner.tenantId, 'Site B');
  await request(createApp()).post('/api/assignments').set('Cookie', [owner.cookie])
    .send({ supervisorId: sup.userId, siteId, slot: 'morning', assignedDate: '2026-09-01' });
  await request(createApp()).post('/api/assignments').set('Cookie', [owner.cookie])
    .send({ supervisorId: sup.userId, siteId: otherSiteId, slot: 'afternoon', assignedDate: '2026-09-01' });

  const otherOwner = await seedUserWithCookie('owner_admin', undefined, 'otherowner@test.co');
  const otherSup = await seedUserWithCookie('supervisor', otherOwner.tenantId, 'othersup@test.co');
  const foreignSiteId = await seedSite(otherOwner.tenantId);
  await request(createApp()).post('/api/assignments').set('Cookie', [otherOwner.cookie])
    .send({ supervisorId: otherSup.userId, siteId: foreignSiteId, slot: 'morning', assignedDate: '2026-09-01' });

  const all = await request(createApp()).get('/api/assignments?date=2026-09-01').set('Cookie', [owner.cookie]);
  assert.equal(all.body.length, 2);

  const filtered = await request(createApp()).get(`/api/assignments?date=2026-09-01&siteId=${siteId}`).set('Cookie', [owner.cookie]);
  assert.equal(filtered.body.length, 1);
  assert.equal(filtered.body[0].siteName, 'Site A');
});

test('GET /api/assignments/today returns only the caller\'s own assignments for today', async () => {
  const owner = await seedUserWithCookie('owner_admin');
  const supA = await seedUserWithCookie('supervisor', owner.tenantId, 'a@test.co');
  const supB = await seedUserWithCookie('supervisor', owner.tenantId, 'b@test.co');
  const siteId = await seedSite(owner.tenantId);
  await request(createApp()).post('/api/assignments').set('Cookie', [owner.cookie])
    .send({ supervisorId: supA.userId, siteId, slot: 'morning' });
  await request(createApp()).post('/api/assignments').set('Cookie', [owner.cookie])
    .send({ supervisorId: supB.userId, siteId, slot: 'afternoon' });

  const resA = await request(createApp()).get('/api/assignments/today').set('Cookie', [supA.cookie]);
  assert.equal(resA.body.length, 1);
  assert.equal(resA.body[0].slot, 'morning');

  const resB = await request(createApp()).get('/api/assignments/today').set('Cookie', [supB.cookie]);
  assert.equal(resB.body.length, 1);
  assert.equal(resB.body[0].slot, 'afternoon');
});

test('GET /api/assignments/today returns an empty array when nothing is assigned', async () => {
  const sup = await seedUserWithCookie('supervisor');
  const res = await request(createApp()).get('/api/assignments/today').set('Cookie', [sup.cookie]);
  assert.deepEqual(res.body, []);
});

test('completing the assigned walkthrough does not delete or hide the assignment reminder', async () => {
  const owner = await seedUserWithCookie('owner_admin');
  const sup = await seedUserWithCookie('supervisor', owner.tenantId, 'sup@test.co');
  const siteId = await seedSite(owner.tenantId);

  await request(createApp()).post('/api/assignments').set('Cookie', [owner.cookie])
    .send({ supervisorId: sup.userId, siteId, slot: 'morning' });

  const walkthroughRes = await request(createApp()).post('/api/walkthroughs').set('Cookie', [sup.cookie])
    .send({ siteId, slot: 'morning', notes: 'done' });
  assert.equal(walkthroughRes.status, 201);

  const res = await request(createApp()).get('/api/assignments/today').set('Cookie', [sup.cookie]);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].siteId, siteId);
  assert.equal(res.body[0].slot, 'morning');
});
