import { Router } from 'express';
import authenticate from '../middleware/authenticate.js';
import requireRole from '../middleware/requireRole.js';
import { asyncRoute } from '../asyncRoute.js';

const VALID_SLOTS = ['morning', 'afternoon'];

function isValidDateString(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export default function assignmentRoutes({ pool }) {
  const router = Router();
  router.use(authenticate(pool));

  router.post('/', requireRole('owner_admin'), asyncRoute(async (req, res) => {
    const { supervisorId, siteId, slot, assignedDate } = req.body ?? {};
    if (!supervisorId || !siteId || !VALID_SLOTS.includes(slot)) {
      return res.status(400).json({ error: { code: 'bad_request', message: 'supervisorId, siteId, and a valid slot are required' } });
    }
    if (assignedDate !== undefined && assignedDate !== null && !isValidDateString(assignedDate)) {
      return res.status(400).json({ error: { code: 'bad_request', message: 'assignedDate must be a valid YYYY-MM-DD date' } });
    }
    const { rows: siteRows } = await pool.query(
      `SELECT id FROM sites WHERE id = $1 AND tenant_id = $2 AND active = true`,
      [siteId, req.user.tenantId],
    );
    if (siteRows.length === 0) {
      return res.status(400).json({ error: { code: 'bad_request', message: 'unknown siteId' } });
    }
    const { rows: supervisorRows } = await pool.query(
      `SELECT id FROM users WHERE id = $1 AND tenant_id = $2 AND role = 'supervisor' AND disabled_at IS NULL`,
      [supervisorId, req.user.tenantId],
    );
    if (supervisorRows.length === 0) {
      return res.status(400).json({ error: { code: 'bad_request', message: 'unknown or ineligible supervisorId' } });
    }
    const { rows: [assignment] } = await pool.query(
      `INSERT INTO assignments (tenant_id, site_id, supervisor_id, slot, assigned_date, created_by, updated_by)
       VALUES ($1, $2, $3, $4, COALESCE($5::date, CURRENT_DATE), $6, $6)
       ON CONFLICT (tenant_id, site_id, slot, assigned_date)
       DO UPDATE SET supervisor_id = EXCLUDED.supervisor_id, updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING id, site_id AS "siteId", supervisor_id AS "supervisorId", slot,
                 to_char(assigned_date, 'YYYY-MM-DD') AS "assignedDate", created_at AS "createdAt", created_by AS "createdBy",
                 updated_at AS "updatedAt", updated_by AS "updatedBy"`,
      [req.user.tenantId, siteId, supervisorId, slot, assignedDate ?? null, req.user.id],
    );
    res.status(200).json(assignment);
  }));

  router.get('/', requireRole('owner_admin'), asyncRoute(async (req, res) => {
    const { date, siteId } = req.query;
    if (date !== undefined && !isValidDateString(date)) {
      return res.status(400).json({ error: { code: 'bad_request', message: 'date must be a valid YYYY-MM-DD date' } });
    }
    const { rows } = await pool.query(
      `SELECT a.id, a.site_id AS "siteId", s.name AS "siteName", a.supervisor_id AS "supervisorId",
              u.display_name AS "supervisorName", a.slot, to_char(a.assigned_date, 'YYYY-MM-DD') AS "assignedDate"
       FROM assignments a
       JOIN sites s ON s.id = a.site_id
       JOIN users u ON u.id = a.supervisor_id
       WHERE a.tenant_id = $1
         AND a.assigned_date = COALESCE($2::date, CURRENT_DATE)
         AND ($3::uuid IS NULL OR a.site_id = $3)
       ORDER BY s.name, a.slot`,
      [req.user.tenantId, date ?? null, siteId ?? null],
    );
    res.json(rows);
  }));

  router.get('/today', requireRole('supervisor'), asyncRoute(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT a.site_id AS "siteId", s.name AS "siteName", a.slot
       FROM assignments a
       JOIN sites s ON s.id = a.site_id
       WHERE a.tenant_id = $1 AND a.supervisor_id = $2 AND a.assigned_date = CURRENT_DATE
       ORDER BY a.slot`,
      [req.user.tenantId, req.user.id],
    );
    res.json(rows);
  }));

  return router;
}
