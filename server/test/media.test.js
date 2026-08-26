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
import { MEDIA_DIR } from '../src/storage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_JPG = path.join(__dirname, 'fixtures', 'sample.jpg');
const DISGUISED_JPG = path.join(__dirname, 'fixtures', 'disguised.jpg');

const pool = getTestPool();
beforeEach(async () => { await resetDb(pool); });
after(async () => { await pool.end(); });

async function seedWalkthrough(role = 'supervisor') {
  const { rows: [tenant] } = await pool.query(`INSERT INTO tenants (name) VALUES ('Test Co') RETURNING id`);
  const hash = await hashPassword('x');
  const { rows: [user] } = await pool.query(
    `INSERT INTO users (tenant_id, email, password_hash, role, display_name) VALUES ($1, 'u@test.co', $2, $3, 'U') RETURNING id`,
    [tenant.id, hash, role],
  );
  const { rows: [site] } = await pool.query(`INSERT INTO sites (tenant_id, name) VALUES ($1, 'Shop') RETURNING id`, [tenant.id]);
  const { rows: [walkthrough] } = await pool.query(
    `INSERT INTO walkthroughs (tenant_id, site_id, supervisor_id, slot) VALUES ($1, $2, $3, 'morning') RETURNING id`,
    [tenant.id, site.id, user.id],
  );
  const { token } = await createSession(pool, { userId: user.id, tenantId: tenant.id });
  const cookie = `session=s:${sign.sign(token, process.env.COOKIE_SECRET)}`;
  return { cookie, walkthroughId: walkthrough.id, tenantId: tenant.id };
}

test('a genuine JPEG uploads successfully', async () => {
  const { cookie, walkthroughId } = await seedWalkthrough();
  const res = await request(createApp())
    .post(`/api/walkthroughs/${walkthroughId}/media`)
    .set('Cookie', [cookie])
    .attach('file', SAMPLE_JPG);
  assert.equal(res.status, 201);
  assert.equal(res.body.kind, 'photo');
  assert.equal(res.body.mimeType, 'image/jpeg');

  const { rows } = await pool.query(`SELECT storage_key FROM media WHERE id = $1`, [res.body.id]);
  const stat = await fs.stat(path.join(MEDIA_DIR, rows[0].storage_key));
  assert.ok(stat.isFile());
});

test('a text file renamed to .jpg is rejected by content verification, not left on disk', async () => {
  const { cookie, walkthroughId } = await seedWalkthrough();
  const filesBefore = await fs.readdir(MEDIA_DIR);

  const res = await request(createApp())
    .post(`/api/walkthroughs/${walkthroughId}/media`)
    .set('Cookie', [cookie])
    .attach('file', DISGUISED_JPG);

  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'invalid_file_type');

  const { rows } = await pool.query(`SELECT count(*) FROM media`);
  assert.equal(rows[0].count, '0');

  const filesAfter = await fs.readdir(MEDIA_DIR);
  assert.equal(filesAfter.length, filesBefore.length);
});

test('accounting cannot upload media', async () => {
  const { cookie, walkthroughId } = await seedWalkthrough('accounting');
  const res = await request(createApp())
    .post(`/api/walkthroughs/${walkthroughId}/media`)
    .set('Cookie', [cookie])
    .attach('file', SAMPLE_JPG);
  assert.equal(res.status, 403);
});

test('uploading to a walkthrough in another tenant returns 404, not 403', async () => {
  const { walkthroughId } = await seedWalkthrough();
  const other = await seedWalkthrough();
  const res = await request(createApp())
    .post(`/api/walkthroughs/${walkthroughId}/media`)
    .set('Cookie', [other.cookie])
    .attach('file', SAMPLE_JPG);
  assert.equal(res.status, 404);
});

test('a successful upload writes an upload row to audit_log', async () => {
  const { cookie, walkthroughId, tenantId } = await seedWalkthrough();
  const res = await request(createApp())
    .post(`/api/walkthroughs/${walkthroughId}/media`)
    .set('Cookie', [cookie])
    .attach('file', SAMPLE_JPG);

  const { rows } = await pool.query(
    `SELECT event_type, target_type, target_id FROM audit_log WHERE tenant_id = $1 AND event_type = 'upload'`,
    [tenantId],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].target_type, 'media');
  assert.equal(rows[0].target_id, res.body.id);
});
