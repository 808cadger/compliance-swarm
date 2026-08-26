// Preloaded before every test file: the app under test builds its own pool from
// DATABASE_URL, so pin that to the test database rather than let a stray DATABASE_URL
// (production's, on the same host:port) reach the app during a test run.
if (!process.env.TEST_DATABASE_URL) {
  throw new Error(
    'TEST_DATABASE_URL is required to run tests and has no fallback. Point it at the dedicated ' +
    'test database, e.g. TEST_DATABASE_URL=postgres://compliance_swarm_app:changeme-app@localhost:5433/compliance_swarm_test ' +
    '(5433 is the dev stack: docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres)'
  );
}

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

// media.js reads this at import time to size multer's upload limit. Production leaves it
// unset and gets the real 500MB ceiling; tests get a small one so the 413 path can be
// exercised without writing a real oversized file to disk. Fixtures used elsewhere in the
// suite (sample.jpg, disguised.jpg) are well under this.
process.env.MAX_UPLOAD_BYTES ??= String(10 * 1024);
