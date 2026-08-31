import { Router } from 'express';
import authenticate from '../middleware/authenticate.js';
import requireRole from '../middleware/requireRole.js';
import { asyncRoute } from '../asyncRoute.js';
import { writeAudit } from '../audit.js';

// Owner-only management of the standing site roster (user_site_assignments — see
// db/init/010_processpass_schema.sql) that evaluateProcessAccess consults for any Process
// marked requires_site_assignment for a role, whether that's Field Worker's built-in default
// or a Foreman's via a tenant_process_overrides row (routes/processAccessAdmin.js). Distinct
// from the existing /api/assignments (assignments.js): that table is date+slot scoped
// walkthrough coverage for supervisors specifically; this is a general standing roster for
// any role.
export default function siteAssignmentsAdminRoutes({ pool }) {
  const router = Router();
  router.use(authenticate(pool), requireRole('owner_admin'));

  router.get('/', asyncRoute(async (req, res) => {
    const { userId } = req.query;
    if (!userId) {
      return res.status(400).json({ error: { code: 'bad_request', message: 'userId is required' } });
    }
    const { rows } = await pool.query(
      `SELECT usa.id, usa.site_id AS "siteId", s.name AS "siteName", usa.created_at AS "createdAt"
       FROM user_site_assignments usa
       JOIN sites s ON s.id = usa.site_id
       WHERE usa.tenant_id = $1 AND usa.user_id = $2
       ORDER BY s.name`,
      [req.user.tenantId, userId],
    );
    res.json(rows);
  }));

  router.post('/', asyncRoute(async (req, res) => {
    const { userId, siteId } = req.body ?? {};
    if (!userId || !siteId) {
      return res.status(400).json({ error: { code: 'bad_request', message: 'userId and siteId are required' } });
    }
    const { rows: userRows } = await pool.query(
      `SELECT id FROM users WHERE id = $1 AND tenant_id = $2 AND disabled_at IS NULL`,
      [userId, req.user.tenantId],
    );
    if (userRows.length === 0) {
      return res.status(400).json({ error: { code: 'bad_request', message: 'unknown or ineligible userId' } });
    }
    const { rows: siteRows } = await pool.query(
      `SELECT id FROM sites WHERE id = $1 AND tenant_id = $2 AND active = true`,
      [siteId, req.user.tenantId],
    );
    if (siteRows.length === 0) {
      return res.status(400).json({ error: { code: 'bad_request', message: 'unknown siteId' } });
    }

    let assignment;
    try {
      ({ rows: [assignment] } = await pool.query(
        `INSERT INTO user_site_assignments (tenant_id, user_id, site_id) VALUES ($1, $2, $3)
         RETURNING id, site_id AS "siteId"`,
        [req.user.tenantId, userId, siteId],
      ));
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ error: { code: 'conflict', message: 'Already assigned to this site' } });
      }
      throw err;
    }
    await writeAudit(pool, {
      tenantId: req.user.tenantId, actorUserId: req.user.id, eventType: 'user_site_assignment_added',
      targetType: 'user', targetId: userId, metadata: { siteId }, ipAddress: req.ip,
    });
    res.status(201).json(assignment);
  }));

  router.delete('/:id', asyncRoute(async (req, res) => {
    const { rows } = await pool.query(
      `DELETE FROM user_site_assignments WHERE id = $1 AND tenant_id = $2 RETURNING user_id AS "userId", site_id AS "siteId"`,
      [req.params.id, req.user.tenantId],
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: { code: 'not_found', message: 'Assignment not found' } });
    }
    await writeAudit(pool, {
      tenantId: req.user.tenantId, actorUserId: req.user.id, eventType: 'user_site_assignment_removed',
      targetType: 'user', targetId: rows[0].userId, metadata: { siteId: rows[0].siteId }, ipAddress: req.ip,
    });
    res.status(204).end();
  }));

  return router;
}
