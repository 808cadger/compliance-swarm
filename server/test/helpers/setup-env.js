import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

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

// config.js reads this once at import time, so it must be set before any test file (or the
// app it builds) imports config.js — this file is preloaded via `--import` for exactly that
// reason. Demo-only routes (routes/processpass.js) are otherwise 404 by design; tests need
// them reachable to cover the ProcessPass flows at all. This has no effect on any
// non-ProcessPass route or test — DEMO_MODE only gates the additional demo-identity surface.
process.env.DEMO_MODE ??= 'true';

// media.js reads this at import time to size multer's upload limit. Production leaves it
// unset and gets the real 500MB ceiling; tests get a small one so the 413 path can be
// exercised without writing a real oversized file to disk. Fixtures used elsewhere in the
// suite (sample.jpg, disguised.jpg) are well under this.
process.env.MAX_UPLOAD_BYTES ??= String(10 * 1024);

// storage.js reads this at import time to place uploaded media on disk. Production leaves it
// unset and gets the real container path (/data/media); that path doesn't exist on a bare host,
// so tests get an OS-appropriate, always-writable default instead. Created up front (rather than
// left to whichever test happens to write first) so every test file, including ones that only
// read the directory (e.g. via fs.readdir), can rely on it already existing.
process.env.MEDIA_DIR ??= path.join(os.tmpdir(), 'compliance-swarm-test-media');
fs.mkdirSync(process.env.MEDIA_DIR, { recursive: true });
