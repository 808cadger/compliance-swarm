// IdentityVerificationProvider contract (conceptual — no TS in this repo, so documented here
// rather than enforced by a type):
//
//   verifyIdentity(input) => {
//     status: 'verified' | 'failed' | 'requires_fallback',
//     subjectId?: string,
//     assuranceLevel: 'demo' | 'standard' | 'elevated',
//     method: 'demo_identity' | 'passkey' | 'pin',
//     metadata: { ...safe metadata only — never a raw image, embedding, or template },
//   }
//
// DemoIdentityProvider is the only implementation that exists today. It does not look at a
// camera frame at all — "identification" here is the demo operator explicitly tapping a
// labeled persona card, which the frontend then hands to this provider as a plain user id.
// A real biometric or passkey provider would implement the same contract and be swapped in
// behind routes/processpass.js without that route's callers changing; nothing in this file
// assumes it's the only provider that will ever exist.
export class DemoIdentityProvider {
  constructor(pool) {
    this.pool = pool;
  }

  // `demoUserId` is a real users.id — DemoIdentityProvider only ever "recognizes" a person
  // who is already a real row in this tenant's user table, tagged is_demo_persona = true by
  // the seed script. It never matches against arbitrary people, and it never runs unless the
  // caller (routes/processpass.js) has already confirmed DEMO_MODE is enabled.
  async verifyIdentity({ demoUserId }) {
    if (!demoUserId || typeof demoUserId !== 'string') {
      return { status: 'failed', assuranceLevel: 'demo', method: 'demo_identity', metadata: { reason: 'no_selection' } };
    }
    const { rows } = await this.pool.query(
      `SELECT id, tenant_id, role, display_name, disabled_at
       FROM users WHERE id = $1 AND is_demo_persona = true`,
      [demoUserId],
    );
    const user = rows[0];
    if (!user || user.disabled_at) {
      return { status: 'failed', assuranceLevel: 'demo', method: 'demo_identity', metadata: { reason: user ? 'disabled' : 'unknown_persona' } };
    }
    return {
      status: 'verified',
      subjectId: user.id,
      assuranceLevel: 'demo',
      method: 'demo_identity',
      metadata: { simulated: true, tenantId: user.tenant_id, role: user.role, displayName: user.display_name },
    };
  }
}
