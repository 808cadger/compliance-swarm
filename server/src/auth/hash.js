import argon2 from 'argon2';

// Spec, Passwords: minimum 12 characters, no complexity theater beyond length.
export const MIN_PASSWORD_LENGTH = 12;

export async function hashPassword(plain) {
  return argon2.hash(plain, { type: argon2.argon2id });
}

export async function verifyPassword(hash, plain) {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}
