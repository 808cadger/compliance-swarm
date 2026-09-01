# ProcessPass — delivery summary

Covers both commits on this branch: `33eb5ac` (ProcessPass core) and `65e754e` (passkeys, real
Docker build, process-access admin UI). See `docs/JEFF_LUDWIG_DEMO.md` for the demo script and
run/seed commands — this doc is the file-by-file "what changed and why," plus the
production-readiness call the spec asked for, which had not been committed anywhere until now.

## What changed, and why

**Terminology migration** — user-facing copy only ("Apps" → "Processes", "Open app" → "Start
Process"); no source directories, DB tables, or API paths were renamed, to avoid an unforced
migration risk.
- `README.md`, `server/src/public/dashboard/{owner,supervisor,accounting}.html`,
  `server/src/public/login.html` — nav/copy updated to Process language.

**ProcessPass core flow** (kiosk → verify → decision)
- `server/src/public/processpass/{kiosk,verify,decision}.{html,js}`, `processpass.css` — the
  three required screens: consent kiosk, camera/persona verification, and the My Processes
  decision screen with the step-up PIN modal.
- `server/src/routes/processpass.js` — all ProcessPass API routes and the 14 spec'd audit
  events (`processpass_started` through `processpass_session_expired`).
- `server/src/services/processAccess.js` — `evaluateProcessAccess()`, the single authorization
  boundary. Same return shape as spec'd (`decision`/`allowed`/`reasons`/`safeUserMessage`/
  `requiredAction`/`evaluatedAt`); input uses this repo's real fields (`role`, `siteId`) instead
  of the spec's placeholder names (`roleIds`, `projectId`/`locationId`).
- `server/src/services/identityProviders/DemoIdentityProvider.js` — only ever authenticates rows
  explicitly flagged `is_demo_persona`; real accounts can't be reached through "Identify Me."
- `server/src/middleware/requireStepUp.js` — enforces step-up on high-risk Processes only when
  `assuranceLevel === 'demo'`; real logins (password/passkey) are unaffected.
- `server/src/routes/audit.js`, `server/src/public/dashboard/audit.html` — read-only audit trail
  page, so the demo can show the events it just wrote.
- `server/db/init/010_processpass_schema.sql` / `011_processpass_grants.sh` — `processes`,
  `role_process_access`, `user_site_assignments` tables, new `field_worker` role.
- `server/scripts/seed-demo.js` — seeds one demo tenant, Jeff Ludwig + 3 other personas (all
  `is_demo_persona=true`), two job sites, gated behind `DEMO_MODE`.

**Passkeys / WebAuthn** (real, not demo-only)
- `server/src/services/identityProviders/PasskeyIdentityProvider.js`,
  `server/src/routes/webauthn.js`, `server/src/services/webauthnChallengeStore.js`,
  `server/src/public/dashboard/passkeys.html`, `server/src/public/assets/{passkeys,
  webauthn-client}.js` — usernameless/discoverable-credential WebAuthn via
  `@simplewebauthn/server`. Tags sessions `auth_method='passkey'`,
  `assurance_level='elevated'`. `/login`'s "Sign in with a passkey" and the new
  `/dashboard/passkeys` registration page.
- `server/db/init/012_passkeys_schema.sql` / `013_passkeys_grants.sh` — `passkey_credentials`
  table.
- `server/src/public/assets/login.js`, `server/src/public/login.html` — passkey entry point
  added alongside the existing password form.

**Process-access admin UI**
- `server/src/routes/processAccessAdmin.js`, `server/src/routes/siteAssignmentsAdmin.js`,
  `server/src/public/dashboard/process-access.html`,
  `server/src/public/assets/process-access.js` — owner-only UI to force-allow/deny a role's
  access to a Process, or require a job-site assignment, per tenant — without ever granting a
  role a Process it has no global eligibility for. Backed by:
- `server/db/init/014_process_access_overrides_schema.sql` / `015_..._grants.sh` —
  `tenant_process_overrides` table.

**Docker build fix**
- `server/Dockerfile`, `server/docker-compose.yml`, `server/docker-compose.dev.yml`,
  `.dockerignore` (new, at repo root — replaces the old `server/.dockerignore`) — image build
  context moved to the repo root so `agents/`, `shared/`, `config/`, `templates/` (siblings of
  `server/`, needed for OfficeSnap/FieldSnap's "Start Process" links) are baked into the
  production image, not just available via the dev bind-mount workaround.

**Supporting changes**
- `server/src/middleware/authenticate.js`, `server/src/auth/session.js`, `server/src/config.js`,
  `server/src/app.js` — session now carries `auth_method`/`assurance_level`; new routes mounted;
  the catch-all `/api` mount that was intercepting ProcessPass routes before they could run is
  fixed.
- `server/src/routes/{dashboard,receipts,users}.js` — minor adjustments for the new role/session
  fields (not a receipts-feature change).
- `server/test/*` — `processAccess.test.js`, `processpass-routes.test.js`,
  `processAccessAdmin.test.js`, `webauthn-routes.test.js` (new), plus updates to
  `test/helpers/{db,setup-env}.js` and `test/session.test.js` for the new schema/session fields.
- `.github/workflows/test.yml` — CI updated for the new migration files.

## Commands

See `docs/JEFF_LUDWIG_DEMO.md` §1–3 and "Commands recap" for the full sequence (start stack,
apply migrations, seed demo data, open kiosk). Test suite:

```bash
cd server
npm ci
TEST_DATABASE_URL=postgres://compliance_swarm_app:changeme-app@localhost:5433/compliance_swarm_test \
COOKIE_SECRET=test-secret npm test
```

## Demo Mode

`DEMO_MODE=true` in `server/.env` gates every ProcessPass demo-identity route
(`POST /api/processpass/identify` and friends) and `seed-demo.js`. Unset (the production
default) — no password-free entry exists; "Identify Me" is unreachable and the demo personas
were never created.

## Simulated vs. production-ready

**Simulated, by design (per spec's explicit boundary against claiming real biometrics):**
- The camera panel in `verify.html`/`verify.js` — a polished UI, not a face-matching model. No
  facial embeddings or biometric templates are computed, stored, or compared anywhere in this
  branch.
- `DemoIdentityProvider` — persona selection, not identification. It only authenticates rows an
  operator has explicitly flagged `is_demo_persona`.
- The step-up PIN (`1234`, hardcoded) — a stand-in for a real second factor, gated behind
  `DEMO_MODE`.

**Real, already enforced on the backend today, unaffected by DEMO_MODE:**
- Tenant isolation, role→Process mapping, and per-tenant overrides (`evaluateProcessAccess()`,
  enforced on every route, not just hidden in the UI).
- The full audit trail (14 event types, real Postgres rows).
- Session model: `auth_method`/`assurance_level`, expiry, explicit sign-out.
- WebAuthn/passkey login — genuine cryptographic authentication via `@simplewebauthn/server`,
  usable today independent of the demo flow.
- The process-access admin overrides UI and its authorization checks.

**Not yet exercised end-to-end:** passkey registration/login against a real hardware
authenticator (Touch ID, Windows Hello, a security key) — the WebAuthn ceremony's own
signature-verification crypto is covered by `@simplewebauthn/server`'s upstream tests, not
re-derived in this branch's suite, so a manual pass with a real device is still worth doing
before relying on it live.

## Next 3 highest-value production steps

1. **Replace `DemoIdentityProvider` with a real identity door for non-demo tenants**, or make it
   explicit that ProcessPass's "Identify Me" path is demo-only and production users are expected
   to reach Processes exclusively through password/passkey login. Right now the kiosk route
   exists in the codebase whenever `DEMO_MODE` is on; nothing stops someone from turning that on
   against a real tenant's data if the env var were ever set in production by mistake — worth an
   explicit guard (e.g. refuse `DEMO_MODE=true` unless a separate `ALLOW_DEMO_MODE_IN_PROD=false`
   default is also flipped) rather than relying on operators to just not set it.
2. **Do the manual passkey/WebAuthn check with a real authenticator**, called out above — the
   crypto path is unverified end-to-end in this branch beyond the library's own tests.
3. **Replace the hardcoded step-up PIN (`1234`) with a real second factor** (e.g. require an
   actual passkey ceremony or a TOTP code) before step-up is used for anything beyond this demo —
   right now any user who has cleared the demo identity step can clear step-up with a publicly
   known value.
