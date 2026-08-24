import pg from 'pg';

// TEST_DATABASE_URL is required with no DATABASE_URL fallback: a production database
// with the same name now listens on the same host:port that dev/test has always used.
function requireTestDatabaseUrl() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL is required to run tests and has no fallback. Point it at the dedicated ' +
      'test database, e.g. TEST_DATABASE_URL=postgres://compliance_swarm_app:changeme-app@localhost:5432/compliance_swarm_test'
    );
  }
  return url;
}

export function getTestPool() {
  return new pg.Pool({ connectionString: requireTestDatabaseUrl() });
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

export async function resetDb(pool) {
  // Try to use superuser connection for cleanup if available
  let cleanupPool = pool;
  const superuserUrl = getSuperuserConnectionString();
  if (superuserUrl) {
    cleanupPool = new pg.Pool({ connectionString: superuserUrl });
  }

  const client = await cleanupPool.connect();
  try {
    const { rows } = await client.query('SELECT current_database() AS name');
    const dbName = rows[0].name;
    if (!dbName.endsWith('_test')) {
      throw new Error(
        `resetDb refused to delete rows: connected to database "${dbName}", whose name does not end ` +
        'in "_test". Set TEST_DATABASE_URL to the dedicated test database (e.g. compliance_swarm_test).'
      );
    }

    await client.query('BEGIN');
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
