// Pure, crypto-free policy decisions around a WebAuthn authentication result — kept separate
// from routes/webauthn.js specifically so they're unit-testable without a real signed
// assertion (see webauthn-routes.test.js's own header comment on why that's not attempted
// here). Only ever called with a real verified result's own counter value, never used to skip
// verification itself.

// A signature counter that fails to advance is the standard clone-detection signal, but many
// legitimate platform authenticators (e.g. some Touch ID/passkey-manager implementations)
// always report 0 and have their own, different anti-clone story — @simplewebauthn/server
// itself only treats a stalled *nonzero* counter as a "possible clone" warning, not a hard
// rejection, and this matches that same policy rather than inventing a stricter one: a zero on
// either side is never flagged, only two nonzero readings where the new one fails to exceed
// the stored one.
export function evaluateCounterAdvance(storedCounter, newCounter) {
  if (storedCounter === 0 || newCounter === 0) {
    return { anomaly: false };
  }
  if (newCounter <= storedCounter) {
    return { anomaly: true, reason: 'counter_did_not_advance' };
  }
  return { anomaly: false };
}
