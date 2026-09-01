# ProcessPass — production assurance

Security hardening pass over ProcessPass's WebAuthn/passkey and step-up authentication,
covering configuration validation, ceremony security, signature-counter handling,
auditability, and deployment safety. See `docs/PROCESSPASS_DELIVERY.md` for what ProcessPass
itself is; this document is specifically about hardening the identity door it's built on.

## Security controls added

**Fail-closed WebAuthn configuration** (`server/src/config.js`) — the app now refuses to
start if `WEBAUTHN_ORIGIN`/`WEBAUTHN_RP_ID` are set to something invalid:
- Origin must be a well-formed URL with no path, query string, or fragment.
- Origin must be `https:` for any hostname other than `localhost`/`127.0.0.1` (which may stay
  `http:` in any environment — the standard secure-context exception this app's own dev stack
  already relies on).
- RP ID must be a bare hostname — no scheme, port, path, query, or fragment.
- RP ID must exactly equal the origin's hostname (this app is a deliberate single-domain
  deployment).
- **A value that's never set at all still falls back to `localhost`** (unchanged, existing
  behavior) — that fallback is safe by construction, so `npm test`/`npm start` keep working
  with zero config. Only an *explicit*, invalid value is rejected. This was a deliberate
  scoping decision — see "Design decisions" below.

**`userVerification: 'required'`** (`PasskeyIdentityProvider.js`) on both registration and
login — was `'preferred'`. These are the only two WebAuthn ceremonies in the app; there's no
separate privileged step-up ceremony to also harden (see below).

**Signature-counter anomaly detection** (`server/src/services/webauthnPolicy.js`,
`evaluateCounterAdvance`) — a pure function, unit-tested independent of any real WebAuthn
crypto. A nonzero counter that fails to advance past its stored value is flagged
(`passkey_counter_anomaly` audit event, high-severity by category) but the login still
succeeds and the counter is still updated — matching `@simplewebauthn/server`'s own precedent
of treating this as a "possible clone" warning, not a hard rejection, since some legitimate
authenticators always report a counter of 0 and this app has no auto-lockout mechanism
anywhere else either.

**New/extended audit events** (`server/src/routes/webauthn.js`):
- `passkey_registration_started` — on `POST /register/options`.
- `passkey_challenge_invalid` — an unknown, expired, wrong-user, or already-consumed (replayed)
  ceremony ID, for both registration and login. Previously silent.
- `passkey_registration_failed` / `passkey_login_failed` now carry a `reason` in `metadata`
  captured from the verification library's own error message (e.g. "Unexpected registration
  response origin") — previously bucketed under one generic string with the real cause
  discarded. This is operational diagnostic detail, never a raw challenge, credential payload,
  session token, or secret.
- `passkey_counter_anomaly` — see above.

None of the above log a raw challenge, raw credential payload, session token, password, or
biometric data — only IDs, event types, and short library-error text.

## Environment configuration requirements

| Variable | Production value | Notes |
|---|---|---|
| `WEBAUTHN_RP_ID` | `compliance.808techserviceshi.cc` | Already set in production `.env`. |
| `WEBAUTHN_ORIGIN` | `https://compliance.808techserviceshi.cc` | Already set in production `.env`. |

Dev stack (`docker-compose.dev.yml`) defaults both correctly already
(`localhost` / `http://localhost:4211`) — no `.env` changes needed for dev.

## Simulated vs. real authenticator testing

- **Unit tests** (`webauthnPolicy.test.js`, `webauthnChallengeStore.test.js`,
  `config.test.js`, most of `webauthn-routes.test.js`) never touch real WebAuthn cryptography —
  by this codebase's own established design (see `webauthn-routes.test.js`'s header comment),
  faking a signed CTAP2 assertion would mean reimplementing an authenticator. What's tested is
  everything this app's own code is responsible for: auth gating, ceremony ownership/expiry/
  replay, tenant/user scoping, audit coverage, and the pure counter-anomaly policy.
- **A CDP virtual authenticator** (headless Chromium + Chrome DevTools Protocol) was used in an
  earlier pass to drive one real, live registration-then-login ceremony end to end against a
  real browser — genuine cryptography, not mocked, and it did catch a real bug (a dev-stack
  origin misconfiguration). This is a legitimate way to exercise the real ceremony without
  physical hardware, but it cannot stand in for a genuine device's own UX/timing/quirks.
- **A real hardware/platform authenticator** (Touch ID, Windows Hello, a physical security
  key) has not yet been exercised. This requires a human at a real device — see the checklist
  below.

### Manual production acceptance checklist (real hardware)

Perform on production (`https://compliance.808techserviceshi.cc`), logged in with a real
account, on your own device:

1. Log in normally with your password.
2. Go to **Passkeys** (`/dashboard/passkeys`).
3. Click **"Add a passkey on this device."** Expected: your browser/OS prompts for Touch ID /
   Windows Hello / a security key. Complete it, name it.
4. **Expected success**: "Passkey added." appears; the new passkey is listed.
5. **Expected safe failure modes** (any of these are fine to see if you decline/cancel; none
   should register anything): the browser's own cancel dialog; the app showing "Passkey setup
   did not complete." on a genuine cancel; "Could not verify the new passkey." on a real
   failure — check `docs/PROCESSPASS_PRODUCTION_ASSURANCE.md`'s redacted evidence template
   below and the `audit_log` table for `passkey_registration_failed`'s `reason` if this
   happens and doesn't look like a plain cancel.
6. Sign out. Go to `/login`. Click **"Sign in with a passkey."**
7. **Expected success**: the same device prompt, then landing on your role's dashboard with no
   password typed. Confirm `audit_log` shows `passkey_login_succeeded`.

#### Redacted test-evidence template

Fill in and keep with deploy records — collects no credentials, secrets, or raw challenge/
credential data:

```
Date/time (with timezone):
Device + authenticator type (e.g. "MacBook Pro, Touch ID" / "Windows 11, Windows Hello" /
  "YubiKey 5C, USB"):
Browser + version:
Registration result (added / failed / cancelled):
  If failed: audit_log passkey_registration_failed.metadata.reason (paste the text, it is
  not a secret):
Login-with-passkey result (succeeded / failed):
  If failed: audit_log passkey_login_failed.metadata.reason:
Any anomaly audit rows seen (passkey_counter_anomaly)? If yes, paste the event only, not any
  surrounding session/credential data:
Overall: PASS / FAIL / PASS WITH NOTES
```

## Rollback considerations

- All changes are additive and backward-compatible: no existing credential, session, or
  passkey stops working. `userVerification: 'required'` only affects *new* ceremonies going
  forward (a passkey already registered under `'preferred'` still authenticates the same way —
  `userVerification` is a ceremony-time request to the authenticator, not a property stored on
  the credential itself).
- The config validation is the only thing that can make a deployment refuse to *start* — if a
  future `.env` change trips it, the fix is correcting the offending `WEBAUTHN_RP_ID`/
  `WEBAUTHN_ORIGIN` value, not a rollback. Revert this branch's commit(s) only if that's
  somehow not viable.
- No database migration was added or needed — `passkey_credentials.counter` already existed
  and is unchanged in shape; only how it's *compared* before being overwritten changed.

## Docker Compose project-name / named-volume warning (carried forward)

Already documented from the prior ProcessPass deploy, repeated here because it's easy to get
wrong on any future structural change to this stack: production's Compose project name is
`compliance-swarm` (not the directory-derived default, which would be `server` after the
repo-shaped restructure). Always deploy with `docker compose -p compliance-swarm -f
docker-compose.yml ...` from `/opt/compliance-swarm/server/`, and verify with `docker compose
-p compliance-swarm -f docker-compose.yml config | grep -A2 volumes:` that it resolves to
`compliance-swarm_postgres_data` / `compliance-swarm_media_data` *before* running `up`.

## Non-destructive smoke test

`server/scripts/smoke-test.sh <base-url>` — checks only safe, unauthenticated boundaries
(health, public pages, expected 401/404s, whether the demo-identity route is correctly closed
in production). Never creates, deletes, or alters a record, and never attempts real
authentication. Verified against live production this session — 10/10 checks passed.

```bash
server/scripts/smoke-test.sh https://compliance.808techserviceshi.cc
```

## Pre-deploy / post-deploy checklist

**Pre-deploy:**
- [ ] Confirm the git revision/tag being deployed (`git log -1 --format='%H %s'`).
- [ ] Back up Postgres: `docker exec compliance-swarm-postgres pg_dump -U compliance_swarm compliance_swarm > backup-$(date +%Y%m%d-%H%M%S).sql`.
- [ ] Confirm the Compose project name: `docker compose -p compliance-swarm -f docker-compose.yml config | grep '^name:'` → must print `compliance-swarm`.
- [ ] Inspect expected named volumes before any structural Docker/Compose change: `docker compose -p compliance-swarm -f docker-compose.yml config | grep -A2 volumes:` → must show `compliance-swarm_postgres_data` / `compliance-swarm_media_data`.
- [ ] Apply any new migrations with `psql -f` (idempotent — every migration in this repo uses `IF NOT EXISTS`/`ADD COLUMN IF NOT EXISTS`); re-run to confirm idempotence if in doubt.

**Deploy:**
- [ ] Build and start: `docker compose -p compliance-swarm -f docker-compose.yml up -d --build` from `/opt/compliance-swarm/server/`.

**Post-deploy:**
- [ ] `server/scripts/smoke-test.sh https://compliance.808techserviceshi.cc` — all checks pass.
- [ ] Verify the canonical public hostname resolves and serves the new build (not just `localhost:<port>` on the box).
- [ ] Verify expected 401/403/404 boundaries manually if the smoke test doesn't cover something new this deploy touched.
- [ ] Inspect logs: `docker logs compliance-swarm-app --tail 50`, `docker logs compliance-swarm-postgres --tail 20`, `journalctl -u cloudflared --since '5 min ago'`.
- [ ] Confirm exactly one `cloudflared` process is running (`ps aux | grep cloudflared`), owned by root — a stray duplicate has caused live 404s before.
- [ ] Record the rollback image tag/backup point alongside the deploy notes.

## Remaining risks, limitations, and recommended follow-up

- **Real hardware authenticator check is still outstanding** — see the manual checklist above.
- **No auto-lockout on counter anomaly, by design** — see "Design decisions" below; revisit if
  a real clone incident is ever observed via the new audit event.
- **`login/options` intentionally does not get a "started" audit event** — see "Design
  decisions."
- **"Demo mode activation" is not an `audit_log` event** — see "Design decisions." Still
  observable via container/systemd logs and the visible "Demo Mode" UI badge.
- **No CSRF token system** — out of scope for this pass; the app relies on `sameSite: 'strict'`
  session cookies consistently, which is sufficient for its shape (no cross-site form posts).
  Noted here only because the audit explicitly looked for it and found nothing WebAuthn-specific
  to harden.
- **`evaluateCounterAdvance`'s wiring into the real login route is not covered by a mocked
  integration test** — only the pure function itself is unit-tested (9 tests). Consistent with
  this codebase's existing choice not to mock `@simplewebauthn/server`; the real path is
  exercised by the manual/E2E checks instead.

## Design decisions (why some literal requirements were adapted, not implemented as worded)

- **HTTPS requirement is not gated on `NODE_ENV`.** This app's dev and production Docker
  builds both run `NODE_ENV=production` — only the compose overlay/ports differ, invisibly to
  the process (documented in `docker-compose.dev.yml`). Gating on `NODE_ENV` would have broken
  the already-correctly-configured dev stack. Validated the origin's own value instead
  (non-loopback ⇒ must be https, in any environment).
- **"Reject missing RP_ID/ORIGIN" reinterpreted as "reject an insecure/malformed *explicit*
  value."** The existing `localhost` fallback for a genuinely unset value is itself safe and
  is what lets `npm test`/`npm start` work with zero config. A hard "missing ⇒ refuse to
  start" would have broken local dev/test entirely.
- **Counter anomaly: audit, don't block or disable the credential.** Matches
  `@simplewebauthn/server`'s and this app's own existing precedent (audit-log-driven human
  review over automatic lockout) rather than introducing a new, stricter policy this app
  doesn't use anywhere else.
- **No "demo-mode activation" `audit_log` event.** The `DEMO_MODE` guard in `config.js` runs
  before the Postgres pool exists in this app's module-load order, so it structurally cannot
  write to `audit_log` — only stderr (captured by container/systemd logs, same as this
  codebase's other startup-time config throws). A *successful* demo-mode activation could
  technically be logged from `app.js` after the pool exists, but `createApp()` is called fresh
  dozens of times across the test suite (which runs with `DEMO_MODE=true` for its entire
  duration) — doing so would add unpredictable extra `audit_log` rows and risk breaking other
  tests' exact row-count assertions (19 such assertions exist across the suite).
- **No "login-attempt-started" `audit_log` event.** Unlike registration (which requires
  authentication and is therefore bounded/attributable), `login/options` is anonymous, public,
  and only rate-limited per-IP — logging every call would let many different IPs generate
  unbounded `audit_log` growth. The real signal is already captured at `login/verify`
  (success/failure), which is where every existing and new audit event for login already
  lives.
