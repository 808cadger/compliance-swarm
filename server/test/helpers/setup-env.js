// Preloaded before every test file: the app under test builds its own pool from
// DATABASE_URL, so pin that to the test database rather than let a stray DATABASE_URL
// (production's, on the same host:port) reach the app during a test run.
if (!process.env.TEST_DATABASE_URL) {
  throw new Error(
    'TEST_DATABASE_URL is required to run tests and has no fallback. Point it at the dedicated ' +
    'test database, e.g. TEST_DATABASE_URL=postgres://compliance_swarm_app:changeme-app@localhost:5432/compliance_swarm_test'
  );
}

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
