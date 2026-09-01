import { Router } from 'express';
import { config } from '../config.js';
import { asyncRoute } from '../asyncRoute.js';
import { writeAudit } from '../audit.js';
import authenticate from '../middleware/authenticate.js';
import { createSession, deleteSession, markStepUpComplete, getSessionStatus, verifyStepUpPin } from '../auth/session.js';
import { DemoIdentityProvider } from '../services/identityProviders/DemoIdentityProvider.js';
import { evaluateProcessAccess, listProcessesForRole } from '../services/processAccess.js';

function requireDemoMode(req, res, next) {
  if (!config.demoMode) {
    return res.status(404).json({ error: { code: 'not_found', message: 'Not found' } });
  }
  next();
}

async function evaluateAllForRole(pool, { tenantId, userId, role, assuranceLevel, stepUpValid }) {
  const catalog = await listProcessesForRole(pool, role);
  const evaluated = [];
  for (const proc of catalog) {
    const decision = await evaluateProcessAccess(pool, {
      tenantId, userId, role, processKey: proc.processKey,
      sessionContext: { assuranceLevel, stepUpValid },
    });
    evaluated.push({
      processKey: proc.processKey,
      name: proc.name,
      purpose: proc.purpose,
      riskLevel: proc.riskLevel,
      decision: decision.decision,
      allowed: decision.allowed,
      safeUserMessage: decision.safeUserMessage,
      requiredAction: decision.requiredAction,
      startUrl: decision.allowed ? proc.startUrl : null,
    });
  }
  return evaluated;
}

async function loadAssignedSites(pool, tenantId, userId) {
  const { rows } = await pool.query(
    `SELECT s.name FROM user_site_assignments usa
     JOIN sites s ON s.id = usa.site_id
     WHERE usa.tenant_id = $1 AND usa.user_id = $2 ORDER BY s.name`,
    [tenantId, userId],
  );
  return rows.map((r) => r.name);
}

export default function processpassRoutes({ pool }) {
  const router = Router();

  // --- Pre-authentication: the kiosk flow itself (see test/processpass-routes.test.js for
  // the integration coverage, run against a real test DB). Every one of these is DEMO_MODE
  // only, so with DEMO_MODE unset there is no password-free way into any account.

  router.post('/started', requireDemoMode, asyncRoute(async (req, res) => {
    await writeAudit(pool, { tenantId: null, eventType: 'processpass_started', metadata: {}, ipAddress: req.ip });
    res.status(204).end();
  }));

  router.post('/camera-permission', requireDemoMode, asyncRoute(async (req, res) => {
    const granted = req.body?.granted === true;
    await writeAudit(pool, {
      tenantId: null,
      eventType: granted ? 'processpass_camera_permission_granted' : 'processpass_camera_permission_denied',
      metadata: {},
      ipAddress: req.ip,
    });
    res.status(204).end();
  }));

  router.get('/demo-identities', requireDemoMode, asyncRoute(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT u.id, u.display_name AS "displayName", u.role, t.name AS "tenantName"
       FROM users u JOIN tenants t ON t.id = u.tenant_id
       WHERE u.is_demo_persona = true AND u.disabled_at IS NULL
       ORDER BY (u.role = 'owner_admin') DESC, u.display_name`,
    );
    res.json({
      personas: rows,
      unknownVisitor: { id: 'unknown_visitor', displayName: 'Unknown Visitor', role: null },
    });
  }));

  // The single endpoint behind "tap a persona card": selects, simulates verification,
  // evaluates every Process the resulting role is eligible for, opens a real session (same
  // sessions table and authenticate() middleware a password login uses), and logs the full
  // processpass_* event sequence for this attempt.
  router.post('/identify', requireDemoMode, asyncRoute(async (req, res) => {
    const { demoUserId, deviceContext } = req.body ?? {};

    if (!demoUserId || demoUserId === 'unknown_visitor') {
      await writeAudit(pool, { tenantId: null, eventType: 'processpass_demo_identity_selected', metadata: { selection: 'unknown_visitor' }, ipAddress: req.ip });
      await writeAudit(pool, { tenantId: null, eventType: 'processpass_identity_failed', metadata: { reason: 'unknown_visitor' }, ipAddress: req.ip });
      await writeAudit(pool, { tenantId: null, eventType: 'processpass_access_denied', metadata: { reason: 'unknown_visitor' }, ipAddress: req.ip });
      return res.json({ decision: 'deny', safeUserMessage: 'We could not grant Process access.' });
    }

    await writeAudit(pool, { tenantId: null, eventType: 'processpass_demo_identity_selected', metadata: {}, ipAddress: req.ip });

    const provider = new DemoIdentityProvider(pool);
    const verification = await provider.verifyIdentity({ demoUserId });

    if (verification.status !== 'verified') {
      await writeAudit(pool, {
        tenantId: null, eventType: 'processpass_identity_failed',
        metadata: { reason: verification.metadata?.reason ?? 'failed' }, ipAddress: req.ip,
      });
      return res.json({ decision: 'deny', safeUserMessage: 'We could not grant Process access.' });
    }

    const userId = verification.subjectId;
    const { tenantId, role, displayName } = verification.metadata;

    await writeAudit(pool, {
      tenantId, actorUserId: userId, eventType: 'processpass_identity_verified',
      metadata: { method: 'demo_identity' }, ipAddress: req.ip,
    });

    const { token, expiresAt, stepUpPin } = await createSession(pool, {
      userId, tenantId, ipAddress: req.ip, userAgent: req.get('user-agent'),
      authMethod: 'demo_identity', assuranceLevel: 'demo',
      deviceContext: deviceContext ?? { kiosk: true },
    });
    res.cookie('session', token, {
      httpOnly: true, secure: true, sameSite: 'strict', signed: true, maxAge: 10 * 60 * 1000,
    });

    const evaluated = await evaluateAllForRole(pool, { tenantId, userId, role, assuranceLevel: 'demo', stepUpValid: false });
    for (const p of evaluated) {
      await writeAudit(pool, {
        tenantId, actorUserId: userId, eventType: 'processpass_access_evaluated',
        targetType: 'process', targetId: p.processKey,
        metadata: { decision: p.decision }, ipAddress: req.ip,
      });
    }
    const anyOpen = evaluated.some((p) => p.allowed || p.decision === 'step_up_required');
    await writeAudit(pool, {
      tenantId, actorUserId: userId,
      eventType: anyOpen ? 'processpass_access_allowed' : 'processpass_access_denied',
      metadata: { allowedCount: evaluated.filter((p) => p.allowed).length }, ipAddress: req.ip,
    });

    const { rows: [tenant] } = await pool.query(`SELECT name FROM tenants WHERE id = $1`, [tenantId]);
    const assignedSites = await loadAssignedSites(pool, tenantId, userId);

    res.json({
      decision: 'allow',
      displayName,
      role,
      tenantName: tenant?.name ?? '',
      assignedSites,
      sessionExpiresAt: expiresAt,
      processes: evaluated,
      // Demo-only: a real deployment would send this to the user's device out of band, never
      // hand it back in the same response that authenticated them. Surfaced so the frontend
      // can show it at the moment step-up is actually needed, instead of a publicly-documented
      // constant every session shared.
      stepUpPin,
    });
  }));

  router.get('/session/status', asyncRoute(async (req, res) => {
    const token = req.signedCookies?.session;
    if (!token) return res.json({ active: false });
    const status = await getSessionStatus(pool, token);
    if (!status.exists) return res.json({ active: false });
    if (status.expired) {
      if (status.authMethod === 'demo_identity') {
        await writeAudit(pool, {
          tenantId: status.tenantId, actorUserId: status.userId,
          eventType: 'processpass_session_expired', metadata: {}, ipAddress: req.ip,
        });
      }
      await deleteSession(pool, token);
      res.clearCookie('session');
      return res.json({ active: false });
    }
    return res.json({ active: true });
  }));

  // --- Authenticated: the same session cookie a password login uses, so these work
  // identically for a demo identity or a real signed-in user.

  // The canonical source for the My Processes dashboard — works identically right after
  // /identify or on a cold page load/refresh, for a demo identity or a real password login,
  // since it only ever reads from the session the request already carries.
  router.get('/processes', authenticate(pool), asyncRoute(async (req, res) => {
    const processes = await evaluateAllForRole(pool, {
      tenantId: req.user.tenantId, userId: req.user.id, role: req.user.role,
      assuranceLevel: req.user.assuranceLevel, stepUpValid: req.user.stepUpValid,
    });
    const assignedSites = await loadAssignedSites(pool, req.user.tenantId, req.user.id);
    const { rows: [user] } = await pool.query(`SELECT display_name AS "displayName" FROM users WHERE id = $1`, [req.user.id]);
    const { rows: [tenant] } = await pool.query(`SELECT name FROM tenants WHERE id = $1`, [req.user.tenantId]);
    res.json({
      displayName: user?.displayName ?? '',
      role: req.user.role,
      tenantName: tenant?.name ?? '',
      assuranceLevel: req.user.assuranceLevel,
      assignedSites,
      processes,
    });
  }));

  router.get('/processes/:key/why', authenticate(pool), asyncRoute(async (req, res) => {
    const decision = await evaluateProcessAccess(pool, {
      tenantId: req.user.tenantId, userId: req.user.id, role: req.user.role, processKey: req.params.key,
      sessionContext: { assuranceLevel: req.user.assuranceLevel, stepUpValid: req.user.stepUpValid },
    });
    if (decision.decision === 'deny') {
      return res.json({ decision: decision.decision, safeUserMessage: decision.safeUserMessage });
    }
    res.json(decision);
  }));

  // The actual backend enforcement point behind every "Start Process" button — a client
  // hiding the button is UX, this is the authorization boundary. Denies here even if a
  // caller crafts the request directly, skipping the dashboard entirely.
  router.post('/processes/:key/start', authenticate(pool), asyncRoute(async (req, res) => {
    const processKey = req.params.key;
    const decision = await evaluateProcessAccess(pool, {
      tenantId: req.user.tenantId, userId: req.user.id, role: req.user.role, processKey,
      sessionContext: { assuranceLevel: req.user.assuranceLevel, stepUpValid: req.user.stepUpValid },
    });
    if (!decision.allowed) {
      await writeAudit(pool, {
        tenantId: req.user.tenantId, actorUserId: req.user.id, eventType: 'processpass_access_denied',
        targetType: 'process', targetId: processKey, metadata: { decision: decision.decision }, ipAddress: req.ip,
      });
      const code = decision.decision === 'step_up_required' ? 'step_up_required' : 'forbidden';
      return res.status(403).json({ error: { code, message: decision.safeUserMessage } });
    }
    const { rows: [process] } = await pool.query(`SELECT start_url AS "startUrl" FROM processes WHERE process_key = $1`, [processKey]);
    if (!process) {
      return res.status(404).json({ error: { code: 'not_found', message: 'Process not found' } });
    }
    await writeAudit(pool, {
      tenantId: req.user.tenantId, actorUserId: req.user.id, eventType: 'process_started',
      targetType: 'process', targetId: processKey, metadata: {}, ipAddress: req.ip,
    });
    res.json({ startUrl: process.startUrl });
  }));

  router.post('/step-up', authenticate(pool), requireDemoMode, asyncRoute(async (req, res) => {
    const { pin } = req.body ?? {};
    if (!(await verifyStepUpPin(pool, req.sessionToken, pin))) {
      return res.status(401).json({ error: { code: 'invalid_pin', message: 'Incorrect PIN.' } });
    }
    const until = await markStepUpComplete(pool, req.sessionToken);
    await writeAudit(pool, {
      tenantId: req.user.tenantId, actorUserId: req.user.id, eventType: 'processpass_step_up_completed',
      metadata: { method: 'demo_pin' }, ipAddress: req.ip,
    });
    res.json({ stepUpValid: true, stepUpUntil: until });
  }));

  router.post('/session/end', authenticate(pool), asyncRoute(async (req, res) => {
    await writeAudit(pool, {
      tenantId: req.user.tenantId, actorUserId: req.user.id, eventType: 'processpass_session_ended',
      metadata: { authMethod: req.user.authMethod }, ipAddress: req.ip,
    });
    await deleteSession(pool, req.sessionToken);
    res.clearCookie('session');
    res.status(204).end();
  }));

  return router;
}
