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
