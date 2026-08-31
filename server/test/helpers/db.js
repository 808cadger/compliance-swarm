import pg from 'pg';

// TEST_DATABASE_URL is required with no DATABASE_URL fallback: a production database with the
// same name listens on localhost:5432. The dev stack (docker-compose.dev.yml) is on 5433.
function requireTestDatabaseUrl() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL is required to run tests and has no fallback. Point it at the dedicated ' +
      'test database, e.g. TEST_DATABASE_URL=postgres://compliance_swarm_app:changeme-app@localhost:5433/compliance_swarm_test ' +
      '(5433 is the dev stack: docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres)'
    );
  }
  return url;
}

export function getTestPool() {
  return new pg.Pool({ connectionString: requireTestDatabaseUrl(), options: '-c TimeZone=Pacific/Honolulu' });
}

function getSuperuserConnectionString() {
  // Build superuser connection string from TEST_DATABASE_URL if possible
  const dbUrl = requireTestDatabaseUrl();
  if (!dbUrl.includes('compliance_swarm_app')) {
    // Already using superuser or unknown
    return null;
  }
  // Replace app role with superuser role and password
  const user = process.env.POSTGRES_USER || 'compliance_swarm';
  const password = process.env.POSTGRES_PASSWORD || 'changeme';
  return dbUrl
    .replace(/compliance_swarm_app:[^@]+@/, `${user}:${password}@`);
}

// The last line of defense before resetDb deletes anything: production's database is named
// `compliance_swarm`, the test database `compliance_swarm_test`. Exported (and covered by
// test/dbGuard.test.js) so that removing or inverting this check fails the suite rather than
// silently pointing the DELETEs at real company data.
export function assertTestDatabaseName(name) {
  if (!name.endsWith('_test')) {
    throw new Error(
      `resetDb refused to delete rows: connected to database "${name}", whose name does not end ` +
      'in "_test". Set TEST_DATABASE_URL to the dedicated test database (e.g. compliance_swarm_test).'
    );
  }
}

export async function resetDb(pool) {
  // Try to use superuser connection for cleanup if available
  let cleanupPool = pool;
  const superuserUrl = getSuperuserConnectionString();
  if (superuserUrl) {
    cleanupPool = new pg.Pool({ connectionString: superuserUrl, options: '-c TimeZone=Pacific/Honolulu' });
  }

  const client = await cleanupPool.connect();
  try {
    const { rows } = await client.query('SELECT current_database() AS name');
    assertTestDatabaseName(rows[0].name);

    await client.query('BEGIN');
    await client.query('DELETE FROM receipts');
    await client.query('DELETE FROM user_site_assignments');
    await client.query('DELETE FROM assignments');
    await client.query('DELETE FROM media');
    await client.query('DELETE FROM walkthroughs');
    await client.query('DELETE FROM sites');
    await client.query('DELETE FROM sessions');
    await client.query('DELETE FROM audit_log');
    await client.query('DELETE FROM users');
    await client.query('DELETE FROM tenants');
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    if (superuserUrl) {
      await cleanupPool.end();
    }
  }
}
