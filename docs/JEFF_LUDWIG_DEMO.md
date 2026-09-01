# Demo script — ProcessPass, for Jeff Ludwig

A 3–5 minute walkthrough of ProcessPass: consent-based visual identity access to Compliance
Swarm's Processes. **Everything about the identity step below is simulated for this demo.**
Everything after it — tenant, role, Process permission, session, and the audit trail — is real,
enforced on the backend, and would be exactly the same with a real biometric or passkey provider
swapped in behind `DemoIdentityProvider` (`server/src/services/identityProviders/`).

## 1. Start the environment

```bash
cd server
cp .env.example .env   # first time only — then edit COOKIE_SECRET/passwords for anything beyond a laptop demo
```

Add these two lines to `server/.env` (not committed — see `.env.example`'s comments).
`CONFIRM_DEMO_MODE` is a deliberate double opt-in config.js requires alongside `DEMO_MODE` in
any environment — see its own comment for why a single flag isn't enough here:

```
DEMO_MODE=true
CONFIRM_DEMO_MODE=true
```

Bring up the dev stack (Postgres + app, on `localhost:4211`; see `docker-compose.dev.yml` for
why dev uses different ports/container names than production):

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

On a **fresh** Postgres volume, every file in `db/init/` (including
`010_processpass_schema.sql`/`011_processpass_grants.sh`) runs automatically. If you're
reusing an existing dev volume that predates ProcessPass, apply just the new ones:

```bash
docker exec -i compliance-swarm-postgres-dev psql -U compliance_swarm -d compliance_swarm \
  < db/init/010_processpass_schema.sql
docker exec -e POSTGRES_USER=compliance_swarm -e POSTGRES_DB=compliance_swarm \
  compliance-swarm-postgres-dev bash /docker-entrypoint-initdb.d/011_processpass_grants.sh
```

## 2. Seed the demo tenant

Run from the host — it talks to dev Postgres over its published port, same as running tests
does (`server/.env.example`'s `TEST_DATABASE_URL` comment explains the port convention):

```bash
DEMO_MODE=true CONFIRM_DEMO_MODE=true DATABASE_URL=postgres://compliance_swarm_app:changeme-app@localhost:5433/compliance_swarm \
  node scripts/seed-demo.js
```

This creates one tenant ("Aloha Build Co. (ProcessPass Demo)"), four demo personas (Jeff
Ludwig/owner_admin, Foreman Demo User/supervisor, Field Worker Demo User/field_worker,
Accounting Demo User/accounting — each flagged `is_demo_persona`, which is what
`DemoIdentityProvider` requires before it will authenticate anyone through "Identify Me"), two
job sites, and one site assignment for the Field Worker persona. **Unknown Visitor is not a
seeded account** — it's a UI choice with no backing row, by design.

To start over: `... node scripts/seed-demo.js --reset` (wipes and recreates the demo tenant's
users, sites, sessions, and filed data; nothing else in the database is touched). The tenant
row and its audit history are kept and reused across resets rather than deleted — this script
runs as the same restricted database role the app uses, which never has DELETE on `audit_log`,
by design.

## 3. Open the kiosk

`http://localhost:4211/processpass`

## 4. The demo

1. **Kiosk screen.** Point out the headline, the privacy note, and that nothing happens until
   "Identify Me" is tapped — no passive scanning.
2. Tap **Identify Me**. `POST /api/processpass/started` fires (one audit row) and the Identity
   Verification screen loads.
3. Camera preview: real if the browser grants it, a polished simulated panel otherwise —
   either way the demo works. Point out the **Demo Mode** badge and the on-screen note that
   this step is simulated.
4. Under "choose who is stepping up to the camera," tap **Jeff Ludwig**. The status stepper
   (Camera ready → Checking liveness → Verifying identity → Checking access policy) runs, then
   the page navigates to **My Processes**.
5. **My Processes** shows: "Welcome, Jeff Ludwig," his role and tenant, and 5 Process cards —
   Owner Process, ForemanSnap, OfficeSnap open immediately; AccountingSnap and Audit Trail show
   **Verification required** (both are marked high-risk in the Process catalog). Click "Why do
   I have access?" on any card to show the non-sensitive reasons.
6. **Start Owner Process** — opens the real, connected `/dashboard/owner` (today's
   assignments, filed receipts — real tenant data, not a mock).
7. Go back to My Processes, click **Verify & Start** on **AccountingSnap**. A modal asks for a
   one-time code — this is the high-risk-action step-up moment. The modal itself shows the
   code (it's random per session, not a fixed value — a real deployment would text or push it
   instead of displaying it here). Confirm, and the real AccountingSnap dashboard opens.
8. **Sign out** (top right of My Processes). This logs `processpass_session_ended` and clears
   the session.
9. Back at the kiosk, tap **Identify Me** → **Field Worker Demo User**. My Processes now shows
   exactly one Process — FieldSnap — because that role has nothing else mapped to it.
10. Sign out, tap **Identify Me** → **Unknown Visitor**. No camera animation needed — the
    result is immediate: "We could not grant Process access," with only "Use secure sign-in" or
    "Try again" offered. No name, tenant, or role is ever shown for this path.
11. Sign back in as **Jeff Ludwig**, open **Owner Process**, click **Audit Trail** in its nav
    (or **Start Process** on the Audit Trail card — it will ask for the step-up PIN again,
    since it's marked high-risk too, unless the step-up from step 7 is still within its 5-minute
    window). Scroll the event list and point out `processpass_demo_identity_selected`,
    `processpass_identity_verified`, `processpass_access_evaluated`/`_allowed`/`_denied`,
    `processpass_step_up_completed`, and `process_started` rows — this is the real audit trail
    every step above actually wrote.

## Beyond the scripted demo (optional, if there's time)

Two follow-on capabilities are real, not demo-only, and worth showing if the room wants proof
this isn't all simulated:

- **A real passkey.** Sign in as any persona via the demo card, then open **Passkeys** in the
  nav and click "Add a passkey on this device" — this drives a genuine WebAuthn ceremony
  against whatever authenticator the browser offers (Touch ID, Windows Hello, a security key).
  Sign out, go to `/login`, and use "Sign in with a passkey" instead of the demo flow at all.
- **Process Access admin.** As Jeff, open **Process Access** in the nav. Set ForemanSnap's
  "Requires assigned site" to Yes, then switch to the Foreman persona — ForemanSnap now shows
  Restricted until that Foreman is given a site assignment on the same page. This is a live,
  per-tenant override, not a hardcoded demo state.

## Commands recap

```bash
# Start
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build

# Seed / reset demo data
DEMO_MODE=true CONFIRM_DEMO_MODE=true DATABASE_URL=postgres://compliance_swarm_app:changeme-app@localhost:5433/compliance_swarm \
  node scripts/seed-demo.js [--reset]

# Run the test suite (requires TEST_DATABASE_URL; see server/.env.example)
npm ci
TEST_DATABASE_URL=postgres://compliance_swarm_app:changeme-app@localhost:5433/compliance_swarm_test \
COOKIE_SECRET=test-secret npm test

# Stop
docker compose -f docker-compose.yml -f docker-compose.dev.yml down
```

## Environment variables this demo depends on

| Variable | Value for this demo | Why |
|---|---|---|
| `DEMO_MODE` | `true` | Gates every ProcessPass demo-identity route. Off by default — no password-free entry in a real deployment. |
| `CONFIRM_DEMO_MODE` | `true` | Required alongside `DEMO_MODE` in every environment — config.js refuses to start with `DEMO_MODE=true` alone, so a stray value can't silently open the demo door. |

`PROCESS_STATIC_ROOT` is not needed for this demo — the image (`server/Dockerfile`, built with
the repo root as its context) already bakes in `agents/`/`shared/`/`config/`/`templates/` at the
paths `server/src/app.js`'s static mounts expect by default, in both dev and production. See
`.env.example` if you ever need the override.

## If something looks wrong mid-demo

- **A Process card 404s on "Start Process."** Rebuild the image — `docker compose -f
  docker-compose.yml -f docker-compose.dev.yml up -d --build` — the four static Process
  directories are only baked in at build time, so an image built before this feature (or before
  an edit to `agents/`/`shared/`/`config/`/`templates/`) won't have current copies of them.
- **The persona grid is empty / "Demo Mode is not enabled."** `DEMO_MODE` isn't `true` in the
  running container's environment — check `server/.env` and restart the stack (compose only
  re-reads `.env` on `up`, not automatically).
- **The app container exits immediately after `up`.** Check `docker logs compliance-swarm-app-dev`
  for `DEMO_MODE=true refused to start without CONFIRM_DEMO_MODE=true` — both must be set
  together in `server/.env`.
- **A demo persona won't sign in / 404 on the whole flow.** Re-run
  `node scripts/seed-demo.js` — nothing is seeded until that's been run once against this
  Postgres volume.
