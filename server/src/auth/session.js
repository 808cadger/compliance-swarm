import crypto from 'node:crypto';

const SESSION_IDLE_HOURS = 12;
const SESSION_ABSOLUTE_DAYS = 7;

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export async function createSession(pool, { userId, tenantId, ipAddress, userAgent }) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_IDLE_HOURS * 3600 * 1000);
  await pool.query(
    `INSERT INTO sessions (token_hash, user_id, tenant_id, ip_address, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [hashToken(token), userId, tenantId, ipAddress ?? null, userAgent ?? null, expiresAt],
  );
  return { token, expiresAt };
}

export async function lookupSession(pool, token) {
  const { rows } = await pool.query(
    `SELECT s.user_id, s.tenant_id, s.expires_at, s.created_at, u.role, u.disabled_at
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1`,
    [hashToken(token)],
  );
  const row = rows[0];
  if (!row) return null;
  if (row.disabled_at) return null;
  const absoluteExpiry = new Date(row.created_at).getTime() + SESSION_ABSOLUTE_DAYS * 86400 * 1000;
  if (Date.now() > absoluteExpiry) return null;
  if (Date.now() > new Date(row.expires_at).getTime()) return null;
  return { userId: row.user_id, tenantId: row.tenant_id, role: row.role };
}

export async function refreshSession(pool, token) {
  const expiresAt = new Date(Date.now() + SESSION_IDLE_HOURS * 3600 * 1000);
  await pool.query(
    `UPDATE sessions SET last_seen_at = now(), expires_at = $2 WHERE token_hash = $1`,
    [hashToken(token), expiresAt],
  );
}

export async function deleteSession(pool, token) {
  await pool.query(`DELETE FROM sessions WHERE token_hash = $1`, [hashToken(token)]);
}
