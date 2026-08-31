// evaluateProcessAccess: the single place that decides whether a caller may open a given
// Process. Every ProcessPass route and every "why do I have access" explanation goes
// through this function rather than re-deriving the logic — see routes/processpass.js.
//
// Contract (conceptually — no TS in this repo):
//   evaluateProcessAccess(pool, { tenantId, userId, role, processKey, siteId, sessionContext })
//   => {
//        decision: 'allow' | 'deny' | 'step_up_required',
//        allowed: boolean,
//        reasons: string[],          // safe, high-level — never a tenant/role id or a score
//        safeUserMessage: string,
//        requiredAction: 'step_up' | null,
//        evaluatedAt: string,
//      }
//
// `role` accepts a single role string (the real shape today) or an array of role strings —
// the spec's contract names the param `roleIds` for a multi-role future this schema doesn't
// have yet; normalizing here means adding multi-role support later doesn't change this
// function's callers.
export async function evaluateProcessAccess(pool, {
  tenantId, userId, role, processKey, siteId = null, sessionContext = {},
}) {
  const evaluatedAt = new Date().toISOString();
  const roles = (Array.isArray(role) ? role : [role]).filter(Boolean);

  if (!tenantId || !userId || roles.length === 0) {
    return result('deny', evaluatedAt, ['not_authenticated'], 'Sign in to see your Processes.');
  }

  const { rows: [process] } = await pool.query(
    `SELECT process_key, risk_level FROM processes WHERE process_key = $1`,
    [processKey],
  );
  if (!process) {
    return result('deny', evaluatedAt, ['unknown_process'], 'That Process does not exist.');
  }

  const { rows: accessRows } = await pool.query(
    `SELECT requires_site_assignment FROM role_process_access WHERE role = ANY($1::user_role[]) AND process_key = $2`,
    [roles, processKey],
  );
  if (accessRows.length === 0) {
    return result('deny', evaluatedAt, ['role_does_not_allow_process'], 'Additional approval is required for this Process.');
  }
  const requiresSiteAssignment = accessRows.some((r) => r.requires_site_assignment);

  const reasons = ['role_allows_process'];

  if (requiresSiteAssignment) {
    const { rows } = await pool.query(
      siteId
        ? `SELECT 1 FROM user_site_assignments WHERE tenant_id = $1 AND user_id = $2 AND site_id = $3`
        : `SELECT 1 FROM user_site_assignments WHERE tenant_id = $1 AND user_id = $2`,
      siteId ? [tenantId, userId, siteId] : [tenantId, userId],
    );
    if (rows.length === 0) {
      return result(
        'deny', evaluatedAt, [...reasons, 'no_site_assignment'],
        'Additional approval is required for this Process — you have no assigned job sites yet.',
      );
    }
    reasons.push('assigned_to_site');
  }

  if (process.risk_level === 'high' && sessionContext.assuranceLevel === 'demo' && !sessionContext.stepUpValid) {
    return {
      decision: 'step_up_required',
      allowed: false,
      reasons,
      safeUserMessage: 'Additional verification required to continue.',
      requiredAction: 'step_up',
      evaluatedAt,
    };
  }

  return result('allow', evaluatedAt, reasons, 'You can access this Process.');
}

function result(decision, evaluatedAt, reasons, safeUserMessage) {
  return {
    decision,
    allowed: decision === 'allow',
    reasons,
    safeUserMessage,
    requiredAction: null,
    evaluatedAt,
  };
}

// The full set of Processes a role is eligible for at all, independent of any one
// evaluation — used to build the "My Processes" card list (routes/processpass.js), which
// needs to show every role-eligible Process (even ones currently denied, e.g. a Field
// Worker with no site yet) rather than only ones that currently evaluate to allow.
export async function listProcessesForRole(pool, role) {
  const { rows } = await pool.query(
    `SELECT p.process_key AS "processKey", p.name, p.purpose, p.start_url AS "startUrl", p.risk_level AS "riskLevel"
     FROM processes p
     JOIN role_process_access rpa ON rpa.process_key = p.process_key
     WHERE rpa.role = $1::user_role
     ORDER BY p.name`,
    [role],
  );
  return rows;
}
