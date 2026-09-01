import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { config } from '../../config.js';

// PasskeyIdentityProvider is the real identity door DemoIdentityProvider stands in for during
// the ProcessPass demo — the "production biometric/passkey provider" the rest of that feature
// was explicitly built to swap in later. It doesn't implement the single-call
// verifyIdentity(input) shape documented in DemoIdentityProvider.js: WebAuthn is inherently a
// two-request ceremony (the server must hand the browser a challenge, then verify what comes
// back), which a single synchronous call can't represent. routes/webauthn.js is the thing
// that actually orchestrates that round trip against the database (looking up/storing
// credentials); this module only wraps @simplewebauthn/server's calls with this app's own
// rpID/origin config baked in, so nothing else in the codebase imports that package directly
// or needs to know these values.

export async function buildRegistrationOptions({ userId, userEmail, userDisplayName, excludeCredentials }) {
  return generateRegistrationOptions({
    rpName: 'Compliance Swarm',
    rpID: config.webauthnRpId,
    userName: userEmail,
    userDisplayName,
    // A stable 16-byte handle derived from the user's own uuid (stripped of dashes, decoded
    // as hex) rather than a random one — the same user registering a second passkey later
    // must present the same userID that any resident/discoverable credential remembers,
    // otherwise a platform authenticator may treat it as a different account.
    userID: Buffer.from(userId.replace(/-/g, ''), 'hex'),
    excludeCredentials,
    // 'required', not 'preferred': this app has no separate privileged-step-up ceremony —
    // registration and login (below) are the only two WebAuthn ceremonies that exist, and
    // login is itself the assurance-granting event (assurance_level='elevated'), so it must
    // actually prove verification (PIN/biometric/etc.), not just presence.
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
  });
}

export async function verifyRegistration({ response, expectedChallenge }) {
  return verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: config.webauthnOrigin,
    expectedRPID: config.webauthnRpId,
  });
}

// No `allowCredentials`: this asks the browser for a discoverable/resident credential without
// the server naming an account first, so login/options (routes/webauthn.js) never has to look
// anyone up by email — there is no "does this email have a passkey" request to observe timing
// or response-shape differences on, the same privacy property the rest of this app already
// gives unknown users elsewhere (see routes/auth.js's ambiguous-tenant handling and
// ProcessPass's unknown-visitor path).
export async function buildAuthenticationOptions() {
  return generateAuthenticationOptions({
    rpID: config.webauthnRpId,
    // See the matching comment in buildRegistrationOptions above.
    userVerification: 'required',
  });
}

export async function verifyAuthentication({ response, expectedChallenge, credential }) {
  return verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: config.webauthnOrigin,
    expectedRPID: config.webauthnRpId,
    credential,
  });
}
