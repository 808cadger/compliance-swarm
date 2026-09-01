-- Real WebAuthn/passkey credentials — the production-grade identity door ProcessPass's
-- demo-identity flow explicitly stands in for (see DemoIdentityProvider and
-- PasskeyIdentityProvider in server/src/services/identityProviders/). A user registers a
-- passkey only once already signed in another way (password today); logging in with one
-- afterward creates a real session exactly like a password login does, just tagged
-- auth_method='passkey', assurance_level='elevated'.
CREATE TABLE IF NOT EXISTS passkey_credentials (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  user_id        uuid NOT NULL REFERENCES users(id),
  -- Base64url, as returned by the browser's PublicKeyCredential.id — globally unique across
  -- every tenant by construction (it's derived from randomness the authenticator generates),
  -- so a plain UNIQUE (not per-tenant) is correct and is what makes "look the user up by
  -- credential ID alone" (the login flow; see routes/webauthn.js) possible at all.
  credential_id  text NOT NULL UNIQUE,
  public_key     bytea NOT NULL,
  -- Signature counter reported by the authenticator; verifyAuthenticationResponse rejects a
  -- non-increasing value, which is what makes stealing/cloning a credential detectable. Some
  -- platform authenticators legitimately report 0 forever (their own anti-clone story is
  -- different), which is why simplewebauthn only flags this as a "possible clone" warning
  -- rather than refusing verification outright.
  counter        bigint NOT NULL DEFAULT 0,
  device_type    text NOT NULL,
  backed_up      boolean NOT NULL DEFAULT false,
  transports     text[] NOT NULL DEFAULT '{}',
  device_label   text NOT NULL DEFAULT 'Passkey',
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_used_at   timestamptz
);
CREATE INDEX IF NOT EXISTS passkey_credentials_user_idx ON passkey_credentials (user_id);
