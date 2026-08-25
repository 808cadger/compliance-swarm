import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LoginRateLimiter } from '../src/rateLimit.js';

test('allows up to maxAttempts within the window', () => {
  const limiter = new LoginRateLimiter({ maxAttempts: 3, windowMs: 60000 });
  assert.equal(limiter.check('k'), true);
  assert.equal(limiter.check('k'), true);
  assert.equal(limiter.check('k'), true);
  assert.equal(limiter.check('k'), false);
});

test('different keys are tracked independently', () => {
  const limiter = new LoginRateLimiter({ maxAttempts: 1, windowMs: 60000 });
  assert.equal(limiter.check('a'), true);
  assert.equal(limiter.check('b'), true);
});

test('reset clears a key', () => {
  const limiter = new LoginRateLimiter({ maxAttempts: 1, windowMs: 60000 });
  limiter.check('k');
  limiter.reset('k');
  assert.equal(limiter.check('k'), true);
});
