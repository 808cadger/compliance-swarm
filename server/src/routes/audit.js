import { Router } from 'express';
import authenticate from '../middleware/authenticate.js';
import requireRole from '../middleware/requireRole.js';
import requireStepUp from '../middleware/requireStepUp.js';
import { asyncRoute } from '../asyncRoute.js';

// Backs the audit.html page (dashboard/audit route) and nothing else. Read-only, tenant-
// scoped, owner_admin only, and step-up gated for ProcessPass demo sessions the same way the
// page itself is — this route is the actual data boundary, the page route is just what
// serves the HTML shell.
export default function auditRoutes({ pool }) {
  const router = Router();
  router.use(authenticate(pool));

  router.get('/', requireRole('owner_admin'), requireStepUp(pool, 'view_audit_trail'), asyncRoute(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT a.id, a.event_type AS "eventType", a.actor_user_id AS "actorUserId",
              u.display_name AS "actorDisplayName", a.target_type AS "targetType",
              a.target_id AS "targetId", a.metadata, a.created_at AS "createdAt"
       FROM audit_log a
       LEFT JOIN users u ON u.id = a.actor_user_id
       WHERE a.tenant_id = $1
       ORDER BY a.created_at DESC
       LIMIT 200`,
      [req.user.tenantId],
    );
    res.json(rows);
  }));

  return router;
}
