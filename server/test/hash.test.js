import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../src/auth/hash.js';

test('hashPassword produces a hash verifyPassword accepts', async () => {
  const hash = await hashPassword('correct-horse-battery-staple');
  assert.equal(await verifyPassword(hash, 'correct-horse-battery-staple'), true);
});

test('verifyPassword rejects wrong password', async () => {
  const hash = await hashPassword('correct-horse-battery-staple');
  assert.equal(await verifyPassword(hash, 'wrong-password'), false);
});
