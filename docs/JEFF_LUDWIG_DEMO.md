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

Add these two lines to `server/.env` (not committed — see `.env.example`'s comments):

```
DEMO_MODE=true
PROCESS_STATIC_ROOT=/app
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
DEMO_MODE=true DATABASE_URL=postgres://compliance_swarm_app:changeme-app@localhost:5433/compliance_swarm \
  node scripts/seed-demo.js
```

This creates one tenant ("Aloha Build Co. (ProcessPass Demo)"), four demo personas (Jeff
Ludwig/owner_admin, Foreman Demo User/supervisor, Field Worker Demo User/field_worker,
Accounting Demo User/accounting — each flagged `is_demo_persona`, which is what
`DemoIdentityProvider` requires before it will authenticate anyone through "Identify Me"), two
job sites, and one site assignment for the Field Worker persona. **Unknown Visitor is not a
seeded account** — it's a UI choice with no backing row, by design.

To start over: `... node scripts/seed-demo.js --reset` (wipes and recreates just that one
tenant — nothing else in the database is touched).

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
7. Go back to My Processes, click **Verify & Start** on **AccountingSnap**. A modal asks for
   the demo PIN (**1234**) — this is the high-risk-action step-up moment. Confirm, and the real
   AccountingSnap dashboard opens.
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

## Commands recap

```bash
# Start
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build

# Seed / reset demo data
DEMO_MODE=true DATABASE_URL=postgres://compliance_swarm_app:changeme-app@localhost:5433/compliance_swarm \
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
| `PROCESS_STATIC_ROOT` | `/app` (set in `docker-compose.dev.yml`) | Lets the app container serve `agents/`/`shared/`/`config/`/`templates/` (repo-root siblings of `server/`) at `/agents`, `/shared`, etc., so OfficeSnap/FieldSnap's "Start Process" links resolve. Unset in the plain production Dockerfile — see the delivery notes for what that means. |

## If something looks wrong mid-demo

- **A Process card 404s on "Start Process."** Almost certainly OfficeSnap or FieldSnap and
  `PROCESS_STATIC_ROOT`/the bind mounts in `docker-compose.dev.yml` aren't in effect — confirm
  you brought the stack up with `-f docker-compose.dev.yml` included.
- **The persona grid is empty / "Demo Mode is not enabled."** `DEMO_MODE` isn't `true` in the
  running container's environment — check `server/.env` and restart the stack (compose only
  re-reads `.env` on `up`, not automatically).
- **A demo persona won't sign in / 404 on the whole flow.** Re-run
  `node scripts/seed-demo.js` — nothing is seeded until that's been run once against this
  Postgres volume.
