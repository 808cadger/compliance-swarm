import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { buildTestApp } from './helpers/app.js';

test('GET /api/health returns ok', async () => {
  const app = buildTestApp();
  const res = await request(app).get('/api/health');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { status: 'ok' });
});
