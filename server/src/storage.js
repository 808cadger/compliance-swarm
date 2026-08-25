import crypto from 'node:crypto';
import path from 'node:path';

export const MEDIA_DIR = process.env.MEDIA_DIR || '/data/media';

export function generateStorageKey(extension) {
  const clean = extension.replace(/^\./, '').toLowerCase();
  return `${crypto.randomBytes(16).toString('hex')}.${clean}`;
}

export function resolveMediaPath(storageKey) {
  if (!/^[a-f0-9]{32}\.[a-z0-9]+$/.test(storageKey)) {
    throw new Error(`Refusing to resolve an unexpected storage key: ${storageKey}`);
  }
  return path.join(MEDIA_DIR, storageKey);
}
