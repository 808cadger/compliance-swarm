import pg from 'pg';

export function getTestPool() {
  const connectionString = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  return new pg.Pool({ connectionString });
}

function getSuperuserConnectionString() {
  // Build superuser connection string from DATABASE_URL if possible
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || !dbUrl.includes('compliance_swarm_app')) {
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
