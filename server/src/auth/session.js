import crypto from 'node:crypto';

const SESSION_IDLE_HOURS = 12;
const SESSION_ABSOLUTE_DAYS = 7;

// Kiosk/demo sessions (ProcessPass) get a much shorter idle timeout than a normal password
// login: a shared job-site tablet must lock itself down quickly if left unattended, where a
// worker's own device staying signed in for 12 hours is the whole point for a real login.
const KIOSK_SESSION_IDLE_MINUTES = 10;

const STEP_UP_MINUTES = 5;

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export async function createSession(pool, {
  userId, tenantId, ipAddress, userAgent,
  authMethod = 'password', assuranceLevel = 'standard', deviceContext = null,
}) {
  const token = crypto.randomBytes(32).toString('hex');
  const idleMs = (authMethod === 'demo_identity' ? KIOSK_SESSION_IDLE_MINUTES * 60 : SESSION_IDLE_HOURS * 3600) * 1000;
  const expiresAt = new Date(Date.now() + idleMs);
  await pool.query(
    `INSERT INTO sessions (token_hash, user_id, tenant_id, ip_address, user_agent, expires_at, auth_method, assurance_level, device_context)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [hashToken(token), userId, tenantId, ipAddress ?? null, userAgent ?? null, expiresAt, authMethod, assuranceLevel, JSON.stringify(deviceContext ?? {})],
  );
  return { token, expiresAt };
}

export async function lookupSession(pool, token) {
  const { rows } = await pool.query(
    `SELECT s.user_id, s.tenant_id, s.expires_at, s.created_at, s.auth_method, s.assurance_level, s.step_up_until,
            u.role, u.disabled_at
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
  return {
    userId: row.user_id,
    tenantId: row.tenant_id,
    role: row.role,
    authMethod: row.auth_method,
    assuranceLevel: row.assurance_level,
    stepUpValid: Boolean(row.step_up_until) && Date.now() < new Date(row.step_up_until).getTime(),
  };
}

export async function refreshSession(pool, token) {
  const { rows } = await pool.query(`SELECT auth_method FROM sessions WHERE token_hash = $1`, [hashToken(token)]);
  const authMethod = rows[0]?.auth_method ?? 'password';
  const idleMs = (authMethod === 'demo_identity' ? KIOSK_SESSION_IDLE_MINUTES * 60 : SESSION_IDLE_HOURS * 3600) * 1000;
  const expiresAt = new Date(Date.now() + idleMs);
  await pool.query(
    `UPDATE sessions SET last_seen_at = now(), expires_at = $2 WHERE token_hash = $1`,
    [hashToken(token), expiresAt],
  );
}

// Distinct from lookupSession: that function collapses "no such session," "expired," and
// "disabled user" into a single null, which is correct for the hot authenticate() path (a
// caller with an invalid session should never learn *why* it's invalid). The kiosk's
// session-status poll needs the opposite — it has to tell "never signed in" apart from
// "your kiosk session just expired" to show the right screen and to log
// processpass_session_expired only for the latter.
export async function getSessionStatus(pool, token) {
  const { rows } = await pool.query(
    `SELECT s.id, s.user_id, s.tenant_id, s.expires_at, s.created_at, s.auth_method, u.disabled_at
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1`,
    [hashToken(token)],
  );
  const row = rows[0];
  if (!row) return { exists: false };
  const absoluteExpiry = new Date(row.created_at).getTime() + SESSION_ABSOLUTE_DAYS * 86400 * 1000;
  const expired = Date.now() > absoluteExpiry || Date.now() > new Date(row.expires_at).getTime() || Boolean(row.disabled_at);
  return { exists: true, expired, userId: row.user_id, tenantId: row.tenant_id, authMethod: row.auth_method };
}

export async function deleteSession(pool, token) {
  await pool.query(`DELETE FROM sessions WHERE token_hash = $1`, [hashToken(token)]);
}

// The simulated "second factor" in a step-up confirmation: marks the session elevated for a
// short window rather than for its whole remaining life, so a kiosk left signed in doesn't
// carry a stale elevation into someone else's later use of the same device.
export async function markStepUpComplete(pool, token) {
  const until = new Date(Date.now() + STEP_UP_MINUTES * 60 * 1000);
  await pool.query(`UPDATE sessions SET step_up_until = $2 WHERE token_hash = $1`, [hashToken(token), until]);
  return until;
}
