import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateStorageKey, resolveMediaPath, MEDIA_DIR } from '../src/storage.js';

test('generateStorageKey produces a 32-hex-char name with the given extension', () => {
  const key = generateStorageKey('.JPG');
  assert.match(key, /^[a-f0-9]{32}\.jpg$/);
});

test('generateStorageKey calls are unique', () => {
  const a = generateStorageKey('mp4');
  const b = generateStorageKey('mp4');
  assert.notEqual(a, b);
});

test('resolveMediaPath joins a valid key under MEDIA_DIR', () => {
  const key = generateStorageKey('jpg');
  assert.equal(resolveMediaPath(key), `${MEDIA_DIR}/${key}`);
});

test('resolveMediaPath rejects a key containing a path separator', () => {
  assert.throws(() => resolveMediaPath('../../etc/passwd'));
});

test('resolveMediaPath rejects a key that is not the expected shape', () => {
  assert.throws(() => resolveMediaPath('not-a-real-key'));
});

test('generateStorageKey sanitizes extensions with spaces and parentheses', () => {
  const key = generateStorageKey('.mp4 (1)');
  // Sanitizing removes all non-alphanumeric characters, so .mp4 (1) -> mp41
  assert.match(key, /^[a-f0-9]{32}\.mp41$/);
  // Verify the sanitized key is valid for resolveMediaPath
  assert.doesNotThrow(() => resolveMediaPath(key));
});

test('generateStorageKey sanitizes extensions with special characters', () => {
  const key = generateStorageKey('.jpg@#$%^&*()');
  // Sanitizing removes all non-alphanumeric characters, so .jpg@#$%^&*() -> jpg
  assert.match(key, /^[a-f0-9]{32}\.jpg$/);
  assert.doesNotThrow(() => resolveMediaPath(key));
});

test('generateStorageKey falls back to bin when extension contains no valid characters', () => {
  const key = generateStorageKey('.@#$%^&*()');
  assert.match(key, /^[a-f0-9]{32}\.bin$/);
  assert.doesNotThrow(() => resolveMediaPath(key));
});

test('generateStorageKey still handles normal extensions correctly after sanitization', () => {
  const key1 = generateStorageKey('.jpg');
  const key2 = generateStorageKey('mp4');
  const key3 = generateStorageKey('.PNG');
  assert.match(key1, /^[a-f0-9]{32}\.jpg$/);
  assert.match(key2, /^[a-f0-9]{32}\.mp4$/);
  assert.match(key3, /^[a-f0-9]{32}\.png$/);
  assert.doesNotThrow(() => resolveMediaPath(key1));
  assert.doesNotThrow(() => resolveMediaPath(key2));
  assert.doesNotThrow(() => resolveMediaPath(key3));
});
