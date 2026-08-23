import pg from 'pg';

export function getTestPool() {
  const connectionString = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  return new pg.Pool({ connectionString });
}

export async function resetDb(pool) {
  await pool.query('TRUNCATE audit_log, sessions, users, tenants RESTART IDENTITY CASCADE');
}
