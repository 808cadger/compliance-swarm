import { test } from 'node:test';
import assert from 'node:assert/strict';
import { beginCeremony, takeCeremony } from '../src/services/webauthnChallengeStore.js';

test('a ceremony is consumable once, immediately, before expiry', () => {
  const id = beginCeremony({ purpose: 'login', challenge: 'c' });
  assert.ok(takeCeremony(id));
});

test('a ceremony cannot be taken twice (replay)', () => {
  const id = beginCeremony({ purpose: 'login', challenge: 'c' });
  assert.ok(takeCeremony(id));
  assert.equal(takeCeremony(id), null);
});

test('an unknown ceremony id returns null', () => {
  assert.equal(takeCeremony('not-a-real-ceremony-id'), null);
});

test('an expired ceremony is rejected even on its first read', () => {
  // Real production/dev callers never pass ttlMs — this is a test-only override so expiry
  // doesn't require waiting out the real 5-minute TTL.
  const id = beginCeremony({ purpose: 'register', challenge: 'c' }, -1);
  assert.equal(takeCeremony(id), null);
});
