export class LoginRateLimiter {
  constructor({ maxAttempts = 10, windowMs = 15 * 60 * 1000 } = {}) {
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
    this.attempts = new Map();
  }

  check(key) {
    const now = Date.now();
    const entry = this.attempts.get(key);
    if (!entry || now - entry.windowStart > this.windowMs) {
      this.attempts.set(key, { count: 1, windowStart: now });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.maxAttempts;
  }

  reset(key) {
    this.attempts.delete(key);
  }
}
