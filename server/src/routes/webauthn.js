import { Router } from 'express';
import { asyncRoute } from '../asyncRoute.js';
import { writeAudit } from '../audit.js';
import authenticate from '../middleware/authenticate.js';
import { createSession } from '../auth/session.js';
import { beginCeremony, takeCeremony } from '../services/webauthnChallengeStore.js';
import {
  buildRegistrationOptions, verifyRegistration,
  buildAuthenticationOptions, verifyAuthentication,
} from '../services/identityProviders/PasskeyIdentityProvider.js';
import { evaluateCounterAdvance } from '../services/webauthnPolicy.js';

// @simplewebauthn/server throws a plain Error with a descriptive message (e.g. "Unexpected
// registration response origin") for every distinct verification failure — origin mismatch,
// RP ID mismatch, challenge mismatch, bad signature, unsupported algorithm, etc. None of that
// is a secret (it never includes the actual challenge, key material, or credential payload,
// only which structural check failed) and it's exactly the "detailed reason in structured
// server-side audit logs, generic message to the user" split this app already uses elsewhere
// (see routes/auth.js's login). Truncated defensively in case a future library version ever
// changes that.
function safeVerificationFailureReason(err) {
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, 200);
}

export default function webauthnRoutes({ pool, rateLimiter }) {
  const router = Router();

  // --- Registration: only ever reachable already signed in another way (password today).
  // A passkey is an *additional* door, not a replacement — there is no unauthenticated way to
  // register one for an account you don't already have a session for.

  router.post('/register/options', authenticate(pool), asyncRoute(async (req, res) => {
    const { rows: [user] } = await pool.query(
      `SELECT email, display_name AS "displayName" FROM users WHERE id = $1`, [req.user.id],
    );
    const { rows: existing } = await pool.query(
      `SELECT credential_id AS id, transports FROM passkey_credentials WHERE user_id = $1`, [req.user.id],
    );
    const options = await buildRegistrationOptions({
      userId: req.user.id,
      userEmail: user.email,
      userDisplayName: user.displayName,
      excludeCredentials: existing,
    });
    const ceremonyId = beginCeremony({ purpose: 'register', userId: req.user.id, tenantId: req.user.tenantId, challenge: options.challenge });
    await writeAudit(pool, { tenantId: req.user.tenantId, actorUserId: req.user.id, eventType: 'passkey_registration_started', ipAddress: req.ip });
    res.json({ ceremonyId, options });
  }));

  router.post('/register/verify', authenticate(pool), asyncRoute(async (req, res) => {
    const { ceremonyId, response, deviceLabel } = req.body ?? {};
    const ceremony = ceremonyId ? takeCeremony(ceremonyId) : null;
    if (!ceremony || ceremony.purpose !== 'register' || ceremony.userId !== req.user.id) {
      await writeAudit(pool, {
        tenantId: req.user.tenantId, actorUserId: req.user.id, eventType: 'passkey_challenge_invalid',
        metadata: { reason: 'unknown_expired_or_wrong_user_ceremony', ceremonyPurpose: 'register' }, ipAddress: req.ip,
      });
      return res.status(400).json({ error: { code: 'bad_request', message: 'This registration attempt has expired — try again.' } });
    }

    let result;
    try {
      result = await verifyRegistration({ response, expectedChallenge: ceremony.challenge });
    } catch (err) {
      result = { verified: false, failureReason: safeVerificationFailureReason(err) };
    }
    if (!result.verified) {
      await writeAudit(pool, {
        tenantId: req.user.tenantId, actorUserId: req.user.id, eventType: 'passkey_registration_failed',
        metadata: result.failureReason ? { reason: result.failureReason } : {}, ipAddress: req.ip,
      });
      return res.status(400).json({ error: { code: 'verification_failed', message: 'Could not verify the new passkey.' } });
    }

    const { credential, credentialDeviceType, credentialBackedUp } = result.registrationInfo;
    try {
      await pool.query(
        `INSERT INTO passkey_credentials (tenant_id, user_id, credential_id, public_key, counter, device_type, backed_up, transports, device_label)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          req.user.tenantId, req.user.id, credential.id, Buffer.from(credential.publicKey), credential.counter,
          credentialDeviceType, credentialBackedUp, credential.transports ?? [],
          (typeof deviceLabel === 'string' && deviceLabel.trim()) || 'Passkey',
        ],
      );
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ error: { code: 'conflict', message: 'This passkey is already registered.' } });
      }
      throw err;
    }

    await writeAudit(pool, {
      tenantId: req.user.tenantId, actorUserId: req.user.id, eventType: 'passkey_registered',
      metadata: { deviceType: credentialDeviceType }, ipAddress: req.ip,
    });
    res.status(201).json({ verified: true });
  }));

  router.get('/credentials', authenticate(pool), asyncRoute(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT id, device_label AS "deviceLabel", device_type AS "deviceType",
              created_at AS "createdAt", last_used_at AS "lastUsedAt"
       FROM passkey_credentials WHERE tenant_id = $1 AND user_id = $2 ORDER BY created_at`,
      [req.user.tenantId, req.user.id],
    );
    res.json(rows);
  }));

  router.delete('/credentials/:id', authenticate(pool), asyncRoute(async (req, res) => {
    const { rows } = await pool.query(
      `DELETE FROM passkey_credentials WHERE id = $1 AND tenant_id = $2 AND user_id = $3 RETURNING id`,
      [req.params.id, req.user.tenantId, req.user.id],
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: { code: 'not_found', message: 'Passkey not found' } });
    }
    await writeAudit(pool, {
      tenantId: req.user.tenantId, actorUserId: req.user.id, eventType: 'passkey_removed',
      targetType: 'passkey_credential', targetId: req.params.id, ipAddress: req.ip,
    });
    res.status(204).end();
  }));

  // --- Login: no account is named up front. generateAuthenticationOptions() with no
  // allowCredentials asks for whichever discoverable passkey the browser/OS has for this
  // origin; the credential id the browser hands back in the verify step is what identifies
  // the account, the same "don't ask which account before proving who you are" property
  // routes/auth.js's login already has for password sign-in.

  router.post('/login/options', asyncRoute(async (req, res) => {
    if (!rateLimiter.check(`webauthn-login:${req.ip}`)) {
      return res.status(429).json({ error: { code: 'rate_limited', message: 'Too many attempts, try again later' } });
    }
    const options = await buildAuthenticationOptions();
    const ceremonyId = beginCeremony({ purpose: 'login', challenge: options.challenge });
    res.json({ ceremonyId, options });
  }));

  router.post('/login/verify', asyncRoute(async (req, res) => {
    const genericFailure = () => res.status(401).json({ error: { code: 'invalid_credentials', message: 'Could not sign in with that passkey' } });

    const { ceremonyId, response } = req.body ?? {};
    const ceremony = ceremonyId ? takeCeremony(ceremonyId) : null;
    if (!ceremony || ceremony.purpose !== 'login') {
      // Anonymous, like login/verify itself — tenantId unknown at this point, same pattern as
      // the unknown-credential branch below. Covers an unknown, expired, or already-consumed
      // (replayed) ceremony id in one bucket; takeCeremony's one-shot design means a second use
      // of the same id lands here too.
      await writeAudit(pool, {
        tenantId: null, eventType: 'passkey_challenge_invalid',
        metadata: { reason: 'unknown_expired_or_replayed_ceremony', ceremonyPurpose: 'login' }, ipAddress: req.ip,
      });
      return genericFailure();
    }

    const credentialId = response?.id;
    if (!credentialId || typeof credentialId !== 'string') return genericFailure();

    const { rows: [row] } = await pool.query(
      `SELECT pc.id, pc.tenant_id AS "tenantId", pc.user_id AS "userId", pc.credential_id AS "credentialId",
              pc.public_key AS "publicKey", pc.counter, pc.transports,
              u.role, u.display_name AS "displayName", u.disabled_at AS "disabledAt"
       FROM passkey_credentials pc JOIN users u ON u.id = pc.user_id
       WHERE pc.credential_id = $1`,
      [credentialId],
    );
    if (!row || row.disabledAt) {
      await writeAudit(pool, {
        tenantId: row?.tenantId ?? null, eventType: 'passkey_login_failed',
        metadata: { reason: row ? 'disabled' : 'unknown_credential' }, ipAddress: req.ip,
      });
      return genericFailure();
    }

    let result;
    try {
      result = await verifyAuthentication({
        response, expectedChallenge: ceremony.challenge,
        credential: { id: row.credentialId, publicKey: row.publicKey, counter: row.counter, transports: row.transports },
      });
    } catch (err) {
      result = { verified: false, failureReason: safeVerificationFailureReason(err) };
    }
    if (!result.verified) {
      await writeAudit(pool, {
        tenantId: row.tenantId, eventType: 'passkey_login_failed',
        metadata: { reason: result.failureReason ?? 'verification_failed' }, ipAddress: req.ip,
      });
      return genericFailure();
    }

    const { anomaly } = evaluateCounterAdvance(row.counter, result.authenticationInfo.newCounter);
    if (anomaly) {
      // Flagged, not blocked: matches @simplewebauthn/server's own precedent of treating a
      // stalled nonzero counter as a "possible clone" warning rather than a hard rejection
      // (see the schema comment on passkey_credentials.counter) — this app has no
      // auto-lockout mechanism anywhere else either, favoring audit-log-driven human review.
      // The counter is still updated below so a real clone racing the legitimate device
      // doesn't keep tripping this on every subsequent legitimate login.
      await writeAudit(pool, {
        tenantId: row.tenantId, actorUserId: row.userId, eventType: 'passkey_counter_anomaly',
        targetType: 'passkey_credential', targetId: row.id,
        metadata: { storedCounter: row.counter, newCounter: result.authenticationInfo.newCounter }, ipAddress: req.ip,
      });
    }

    await pool.query(
      `UPDATE passkey_credentials SET counter = $2, last_used_at = now() WHERE id = $1`,
      [row.id, result.authenticationInfo.newCounter],
    );

    const { token } = await createSession(pool, {
      userId: row.userId, tenantId: row.tenantId, ipAddress: req.ip, userAgent: req.get('user-agent'),
      authMethod: 'passkey', assuranceLevel: 'elevated',
    });
    await writeAudit(pool, { tenantId: row.tenantId, actorUserId: row.userId, eventType: 'passkey_login_succeeded', ipAddress: req.ip });

    res.cookie('session', token, {
      httpOnly: true, secure: true, sameSite: 'strict', signed: true, maxAge: 12 * 3600 * 1000,
    });
    res.json({ role: row.role, displayName: row.displayName });
  }));

  return router;
}
