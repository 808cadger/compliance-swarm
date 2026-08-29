import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import request from 'supertest';
import sign from 'cookie-signature';
import { getTestPool, resetDb } from './helpers/db.js';
import { hashPassword } from '../src/auth/hash.js';
import { createSession } from '../src/auth/session.js';
import { createApp } from '../src/app.js';
import * as storage from '../src/storage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_JPG = path.join(__dirname, 'fixtures', 'sample.jpg');
const DISGUISED_JPG = path.join(__dirname, 'fixtures', 'disguised.jpg');

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

test('accounting can file a receipt', async () => {
  const acct = await seedUserWithCookie('accounting');
  const res = await request(createApp()).post('/api/receipts').set('Cookie', [acct.cookie])
    .field('kind', 'receipt').attach('file', SAMPLE_JPG);
  assert.equal(res.status, 201);
  assert.equal(res.body.kind, 'receipt');
  assert.equal(res.body.mimeType, 'image/jpeg');
});

test('owner_admin cannot file a receipt', async () => {
  const owner = await seedUserWithCookie('owner_admin');
  const res = await request(createApp()).post('/api/receipts').set('Cookie', [owner.cookie])
    .field('kind', 'receipt').attach('file', SAMPLE_JPG);
  assert.equal(res.status, 403);
});

test('supervisor cannot file a receipt', async () => {
  const sup = await seedUserWithCookie('supervisor');
  const res = await request(createApp()).post('/api/receipts').set('Cookie', [sup.cookie])
    .field('kind', 'receipt').attach('file', SAMPLE_JPG);
  assert.equal(res.status, 403);
});

test('an invalid kind value is rejected', async () => {
  const acct = await seedUserWithCookie('accounting');
  const res = await request(createApp()).post('/api/receipts').set('Cookie', [acct.cookie])
    .field('kind', 'bogus').attach('file', SAMPLE_JPG);
  assert.equal(res.status, 400);
});

test('a text file renamed to .jpg is rejected by content verification, not left on disk', async () => {
  const acct = await seedUserWithCookie('accounting');
  const filesBefore = await fs.readdir(storage.MEDIA_DIR);

  const res = await request(createApp()).post('/api/receipts').set('Cookie', [acct.cookie])
    .field('kind', 'receipt').attach('file', DISGUISED_JPG);

  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'invalid_file_type');

  const { rows } = await pool.query(`SELECT count(*) FROM receipts`);
  assert.equal(rows[0].count, '0');

  const filesAfter = await fs.readdir(storage.MEDIA_DIR);
  assert.equal(filesAfter.length, filesBefore.length);
});

test('accounting can delete their own receipt, and it is actually gone', async () => {
  const acct = await seedUserWithCookie('accounting');
  const upload = await request(createApp()).post('/api/receipts').set('Cookie', [acct.cookie])
    .field('kind', 'invoice').attach('file', SAMPLE_JPG);

  const del = await request(createApp()).delete(`/api/receipts/${upload.body.id}`).set('Cookie', [acct.cookie]);
  assert.equal(del.status, 204);

  const refetch = await request(createApp()).get(`/api/receipts/${upload.body.id}`).set('Cookie', [acct.cookie]);
  assert.equal(refetch.status, 404);
});

test('owner_admin cannot delete a receipt', async () => {
  const acct = await seedUserWithCookie('accounting');
  const owner = await seedUserWithCookie('owner_admin', acct.tenantId, 'owner@test.co');
  const upload = await request(createApp()).post('/api/receipts').set('Cookie', [acct.cookie])
    .field('kind', 'receipt').attach('file', SAMPLE_JPG);

  const res = await request(createApp()).delete(`/api/receipts/${upload.body.id}`).set('Cookie', [owner.cookie]);
  assert.equal(res.status, 403);
});

test('cross-tenant retrieval, list, and delete all behave correctly (404, never 403)', async () => {
  const acct = await seedUserWithCookie('accounting');
  const upload = await request(createApp()).post('/api/receipts').set('Cookie', [acct.cookie])
    .field('kind', 'receipt').attach('file', SAMPLE_JPG);

  const otherAcct = await seedUserWithCookie('accounting');

  const getRes = await request(createApp()).get(`/api/receipts/${upload.body.id}`).set('Cookie', [otherAcct.cookie]);
  assert.equal(getRes.status, 404);

  const delRes = await request(createApp()).delete(`/api/receipts/${upload.body.id}`).set('Cookie', [otherAcct.cookie]);
  assert.equal(delRes.status, 404);

  const listRes = await request(createApp()).get('/api/receipts').set('Cookie', [otherAcct.cookie]);
  assert.deepEqual(listRes.body, []);
});

test('owner_admin can list and retrieve receipts in their tenant (read-only role actually works)', async () => {
  const acct = await seedUserWithCookie('accounting');
  const owner = await seedUserWithCookie('owner_admin', acct.tenantId, 'owner@test.co');
  const upload = await request(createApp()).post('/api/receipts').set('Cookie', [acct.cookie])
    .field('kind', 'receipt').attach('file', SAMPLE_JPG);

  const listRes = await request(createApp()).get('/api/receipts').set('Cookie', [owner.cookie]);
  assert.equal(listRes.status, 200);
  assert.equal(listRes.body.length, 1);
  assert.equal(listRes.body[0].uploadedByName, 'U');

  const getRes = await request(createApp()).get(`/api/receipts/${upload.body.id}`).set('Cookie', [owner.cookie]);
  assert.equal(getRes.status, 200);
  assert.equal(getRes.headers['content-type'], 'image/jpeg');
});

test('supervisor gets 403 on every receipts read, not just writes', async () => {
  const acct = await seedUserWithCookie('accounting');
  const sup = await seedUserWithCookie('supervisor', acct.tenantId, 'sup@test.co');
  const upload = await request(createApp()).post('/api/receipts').set('Cookie', [acct.cookie])
    .field('kind', 'receipt').attach('file', SAMPLE_JPG);

  const listRes = await request(createApp()).get('/api/receipts').set('Cookie', [sup.cookie]);
  assert.equal(listRes.status, 403);

  const getRes = await request(createApp()).get(`/api/receipts/${upload.body.id}`).set('Cookie', [sup.cookie]);
  assert.equal(getRes.status, 403);
});

test('filing and deleting a receipt both write audit_log rows', async () => {
  const acct = await seedUserWithCookie('accounting');
  const upload = await request(createApp()).post('/api/receipts').set('Cookie', [acct.cookie])
    .field('kind', 'receipt').attach('file', SAMPLE_JPG);

  const { rows: uploadRows } = await pool.query(
    `SELECT event_type, target_type, target_id FROM audit_log WHERE tenant_id = $1 AND event_type = 'upload' AND target_type = 'receipt'`,
    [acct.tenantId],
  );
  assert.equal(uploadRows.length, 1);
  assert.equal(uploadRows[0].target_id, upload.body.id);

  await request(createApp()).delete(`/api/receipts/${upload.body.id}`).set('Cookie', [acct.cookie]);

  const { rows: deleteRows } = await pool.query(
    `SELECT event_type, target_type, target_id FROM audit_log WHERE tenant_id = $1 AND event_type = 'delete' AND target_type = 'receipt'`,
    [acct.tenantId],
  );
  assert.equal(deleteRows.length, 1);
  assert.equal(deleteRows[0].target_id, upload.body.id);
});
