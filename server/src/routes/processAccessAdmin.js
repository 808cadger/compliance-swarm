import { Router } from 'express';
import authenticate from '../middleware/authenticate.js';
import requireRole from '../middleware/requireRole.js';
import { asyncRoute } from '../asyncRoute.js';
import { writeAudit } from '../audit.js';

const VALID_ROLES = ['owner_admin', 'supervisor', 'accounting', 'field_worker'];

// Owner-only admin surface over the tenant_process_overrides table (see
// db/init/014_process_access_overrides_schema.sql and evaluateProcessAccess in
// services/processAccess.js, which is what actually enforces whatever this route writes —
// this route only ever writes rows that function already knows how to interpret).
export default function processAccessAdminRoutes({ pool }) {
  const router = Router();
  router.use(authenticate(pool), requireRole('owner_admin'));

  router.get('/', asyncRoute(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT rpa.role, rpa.process_key AS "processKey", p.name,
              rpa.requires_site_assignment AS "defaultRequiresSiteAssignment",
              tpo.enabled AS "overrideEnabled",
              tpo.requires_site_assignment AS "overrideRequiresSiteAssignment",
              tpo.updated_at AS "overrideUpdatedAt"
       FROM role_process_access rpa
       JOIN processes p ON p.process_key = rpa.process_key
       LEFT JOIN tenant_process_overrides tpo
         ON tpo.tenant_id = $1 AND tpo.role = rpa.role AND tpo.process_key = rpa.process_key
       ORDER BY rpa.role, p.name`,
      [req.user.tenantId],
    );
    res.json(rows.map((r) => ({
      ...r,
      effectiveEnabled: r.overrideEnabled ?? true,
      effectiveRequiresSiteAssignment: r.overrideRequiresSiteAssignment ?? r.defaultRequiresSiteAssignment,
    })));
  }));

  router.put('/:role/:processKey', asyncRoute(async (req, res) => {
    const { role, processKey } = req.params;
    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: { code: 'bad_request', message: 'invalid role' } });
    }
    // `null` (as opposed to omitted) is a meaningful, valid value here: it's how the client
    // explicitly clears one field's override back to "inherit the default" without touching
    // the other field — omitted means "leave whatever this was," null means "reset this."
    const body = req.body ?? {};
    if (body.enabled !== undefined && body.enabled !== null && typeof body.enabled !== 'boolean') {
      return res.status(400).json({ error: { code: 'bad_request', message: 'enabled must be a boolean or null' } });
    }
    if (body.requiresSiteAssignment !== undefined && body.requiresSiteAssignment !== null && typeof body.requiresSiteAssignment !== 'boolean') {
      return res.status(400).json({ error: { code: 'bad_request', message: 'requiresSiteAssignment must be a boolean or null' } });
    }

    const { rows: baseRows } = await pool.query(
      `SELECT 1 FROM role_process_access WHERE role = $1::user_role AND process_key = $2`,
      [role, processKey],
    );
    if (baseRows.length === 0) {
      return res.status(400).json({
        error: { code: 'bad_request', message: 'This role is not eligible for this Process at all — an override can only adjust an existing eligibility.' },
      });
    }

    // Read-then-write rather than a blind upsert: the request may set only one of the two
    // fields, and an upsert without this would silently null out whichever field wasn't
    // included, clobbering an existing override on that field.
    const { rows: [existing] } = await pool.query(
      `SELECT enabled, requires_site_assignment AS "requiresSiteAssignment"
       FROM tenant_process_overrides WHERE tenant_id = $1 AND role = $2::user_role AND process_key = $3`,
      [req.user.tenantId, role, processKey],
    );
    const enabled = body.enabled !== undefined ? body.enabled : (existing?.enabled ?? null);
    const requiresSiteAssignment = body.requiresSiteAssignment !== undefined
      ? body.requiresSiteAssignment
      : (existing?.requiresSiteAssignment ?? null);

    await pool.query(
      `INSERT INTO tenant_process_overrides (tenant_id, role, process_key, enabled, requires_site_assignment, updated_by)
       VALUES ($1, $2::user_role, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, role, process_key)
       DO UPDATE SET enabled = EXCLUDED.enabled, requires_site_assignment = EXCLUDED.requires_site_assignment,
                     updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [req.user.tenantId, role, processKey, enabled, requiresSiteAssignment, req.user.id],
    );
    await writeAudit(pool, {
      tenantId: req.user.tenantId, actorUserId: req.user.id, eventType: 'process_access_overridden',
      targetType: 'role_process_access', targetId: `${role}:${processKey}`,
      metadata: { enabled, requiresSiteAssignment }, ipAddress: req.ip,
    });
    res.json({ role, processKey, enabled, requiresSiteAssignment });
  }));

  router.delete('/:role/:processKey', asyncRoute(async (req, res) => {
    const { role, processKey } = req.params;
    const { rowCount } = await pool.query(
      `DELETE FROM tenant_process_overrides WHERE tenant_id = $1 AND role = $2::user_role AND process_key = $3`,
      [req.user.tenantId, role, processKey],
    );
    if (rowCount === 0) {
      return res.status(404).json({ error: { code: 'not_found', message: 'No override to reset' } });
    }
    await writeAudit(pool, {
      tenantId: req.user.tenantId, actorUserId: req.user.id, eventType: 'process_access_override_reset',
      targetType: 'role_process_access', targetId: `${role}:${processKey}`, ipAddress: req.ip,
    });
    res.status(204).end();
  }));

  return router;
}
