import { writeAudit } from '../audit.js';

// Gates a single high-risk action behind the simulated "second factor" from ProcessPass's
// step-up flow (POST /api/processpass/step-up). Deliberately a no-op for every session that
// didn't start as a ProcessPass demo identity: a real password/passkey login already went
// through real credential verification, so this never adds friction to production auth —
// only to the demo's simulated one, which is the thing this whole feature is honest about
// not being production-grade.
export default function requireStepUp(pool, actionKey) {
  return async function requireStepUpMiddleware(req, res, next) {
    if (!req.user) {
      return res.status(401).json({ error: { code: 'unauthenticated', message: 'Login required' } });
    }
    if (req.user.assuranceLevel !== 'demo') {
      return next();
    }
    if (req.user.stepUpValid) {
      return next();
    }
    await writeAudit(pool, {
      tenantId: req.user.tenantId,
      actorUserId: req.user.id,
      eventType: 'processpass_step_up_required',
      targetType: 'action',
      targetId: actionKey,
      metadata: { authMethod: req.user.authMethod },
      ipAddress: req.ip,
    });
    res.status(403).json({
      error: {
        code: 'step_up_required',
        message: 'Additional verification required before this action can continue.',
      },
    });
  };
}
