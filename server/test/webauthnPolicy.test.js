import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCounterAdvance } from '../src/services/webauthnPolicy.js';

test('counter advances normally: no anomaly', () => {
  assert.deepEqual(evaluateCounterAdvance(5, 6), { anomaly: false });
});

test('stored counter is zero (authenticator has never reported a real value): no anomaly', () => {
  assert.deepEqual(evaluateCounterAdvance(0, 0), { anomaly: false });
  assert.deepEqual(evaluateCounterAdvance(0, 1), { anomaly: false });
});

test('incoming counter is zero (authenticator always reports zero): no anomaly', () => {
  assert.deepEqual(evaluateCounterAdvance(5, 0), { anomaly: false });
});

test('nonzero counter fails to advance: anomaly', () => {
  const result = evaluateCounterAdvance(5, 5);
  assert.equal(result.anomaly, true);
  assert.equal(result.reason, 'counter_did_not_advance');
});

test('nonzero counter regression (goes backward): anomaly', () => {
  const result = evaluateCounterAdvance(10, 3);
  assert.equal(result.anomaly, true);
  assert.equal(result.reason, 'counter_did_not_advance');
});
