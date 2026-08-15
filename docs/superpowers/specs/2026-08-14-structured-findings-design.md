# Approval-First Business AI — Structured Findings, postMessage Envelope, and Provenance Design

Date: 2026-08-14
Status: Draft

## Purpose

`2026-08-07-model-policy-v2-design.md` explicitly deferred three related pieces of work to a follow-up
(`feature/structured-findings-v1`), rather than build them alongside the model-routing rework:

- **Structured findings** — replacing each agent's ad-hoc flag shape (Payroll's `flagRow()` strings,
  Books' uncategorized-transaction detection, Contract's `findFlaggedClauses()` output) with one common,
  versioned finding record.
- **A versioned postMessage envelope** — generalizing today's ad-hoc `{type:'swarm-flag',...}` /
  `{type:'swarm-decision',...}` messages between Payroll/Books/Contract and `orchestrator.html`.
- **A provenance record** — a per-finding stamp tying together which policy version and which
  model/provider (if any) touched that finding.

This spec covers all three together, since the envelope's `payload` *is* the finding, and provenance is
a field on the finding — they're one cohesive redesign, not three independent features.

## Scope decisions (settled during brainstorming, restated here for the record)

- **Applies to Payroll/Books/Contract only.** FieldSnap and ShelfSnap use a different mechanism
  entirely (direct localStorage queues — `field_docs_queue`/`shelf_snap_queue` — no postMessage), and
  were never part of what `feature/structured-findings-v1` was scoped to cover. Their queue-item shapes
  and `orchestrator.html`'s lane-rendering code for them are unchanged by this work.
- **`agentId` reuses the existing short form** already used at the postMessage boundary this envelope
  replaces: `"payroll"` / `"books"` / `"contract"` (the `AGENT_ID` constant each of those three pages
  already defines). This is deliberately *not* `config/model-policy.json`'s `CONFIG_KEY`
  (`payroll_explainer`/`books_review`/`contract_review`) — a finding's "which agent produced this" and
  a model call's "which config key resolved its provider/model" are different identities, per the same
  separation-of-concerns principle `model-policy-v2`'s spec already established for `agentId`/
  `templateVersion` being attached by the calling agent, not by `callModel`.
- **Real migration on load**, matching the pattern `shared/model-client.js` already uses for
  `localStorage` settings (`schemaVersion` + migrate-on-read) — not a clean cutover.
- **No template registry.** `reference.templateSource`/`reference.templateVersion` stay filename-based,
  exactly as today's on-page badges are. Real template version tracking (a registry file, or version
  metadata embedded in `templates/*`) is deferred again, to whenever that becomes its own piece of work.

## Finding shape

Built by Payroll/Books/Contract at their existing flag-detection call sites — `flagRow()`, the
uncategorized-transaction branch in `render()`, and `findFlaggedClauses()` — via a shared
`createFinding({...})` helper (new export from `shared/agent-common.js`) that fills in the boilerplate.
Callers supply the parts only they can know: `title`, `evidence`, `severity`, `reference`,
`suggestedQuestion`.

```json
{
  "schemaVersion": 1,
  "id": "finding_3f2a1c9e-3b7a-4e1a-9c2d-8a1b2c3d4e5f",
  "agentId": "payroll",
  "severity": "high",
  "status": "open",
  "title": "Rate below CA minimum wage",
  "evidence": {
    "summary": "Employee rate $7.00/hr is below the CA demo minimum wage of $16.00/hr",
    "sourceReference": "payroll-3",
    "sourceText": null
  },
  "reference": { "id": "min_wage_floor", "templateSource": null, "templateVersion": null },
  "suggestedQuestion": "Confirm this rate is correct and meets the applicable state minimum wage.",
  "createdAt": "2026-08-15T02:14:00.000Z",
  "provenance": { "policyVersion": 1, "modelProvider": null, "modelName": null }
}
```

Field notes:

- `id`: `"finding_" + crypto.randomUUID()`. Replaces today's `itemId` field entirely — `Finding` has
  no `itemId` property, only `id`. Every place that reads `item.itemId` today (`decide()`'s
  `queue.find(q => q.itemId === itemId)`, the `data-badge-for`/`data-approve`/`data-reject` attribute
  values in `reviewHtml()`) switches to `item.id`. The one place the string `"itemId"` survives is as a
  *wire-format key name* inside the `decision-made` envelope's `payload` (`{itemId, decision}`, see
  below) — that's a naming choice for what the message is about, independent of any JS property name,
  and its value is that finding's `.id`.
- `agentId`: `"payroll"` | `"books"` | `"contract"` — see scope decision above.
- `severity`: `"low"` | `"medium"` | `"high"`. Not a blanket default — assigned per check, not
  per-agent:
  - Payroll's `flagRow()` has no data table today, just three sequential `if` branches each doing
    `flags.push(...)`. No refactor into a table is needed for this — each branch just also assigns a
    local `severity` constant alongside its existing message string: below-minimum-wage → `"high"`,
    ≥60 hours → `"medium"`, exempt misclassification (≥45 hrs) → `"high"`.
  - Contract's `MATCH_RULES` *is* already a data table — it gains a literal `severity` property per
    entry: Indemnification/Non-compete/Liability-absence → `"high"`; Termination/IP/Payment-terms/
    Governing-law/Auto-renewal → `"medium"`. (First-pass editorial call, not derived from anything in
    the clause library today — flag for a follow-up content pass against `red-flag-clause-library.md`
    if these turn out wrong once in use.)
  - Books' uncategorized-transaction check: always `"medium"` — it isn't a graded risk today, just a
    "needs a human's categorization call" flag.
- `status`: `"open"` | `"approved"` | `"rejected"`. Replaces today's separate `decision: null|'approved'
  |'rejected'` field on the queue item — one field instead of two (`status: "open"` ≡ old
  `decision: null`).
- `evidence.sourceReference`: an opaque pointer back into that agent's own on-page data, reusing
  exactly the `id` string each agent already builds today for its own DOM lookups (`` `payroll-${i}` ``,
  `` `books-${i}` ``, `` `contract-${i}-${clauseName}` ``) — not meant to be parsed by the orchestrator.
  This is a different identifier from `Finding.id` (the new uuid, used for queue/envelope identity) on
  purpose: `sourceReference` only has to be stable *within that one page render* (it's how that agent's
  own `data-explanation-for="${i}"`/`data-model-badge-for="${i}"` lookups already work, unchanged by
  this spec), while `Finding.id` has to be stable across the postMessage round-trip and persisted
  `localStorage` queue — two different lifetimes, two different id schemes, not a naming inconsistency.
- `evidence.sourceText`: the quoted excerpt, where one exists (Contract's flagged paragraph text).
  `null` for Payroll (no excerpt, just field values) and Books (no excerpt, just the transaction row).
- `reference.id`: which specific rule/category matched (`"min_wage_floor"`, `"Indemnification"`,
  `null` for Books' uncategorized case — no rule matched, that's the finding itself).
- `reference.templateSource`/`templateVersion`: filename of the fetched template, `null` where none
  applies (Payroll has no fetched template; Books/Contract get their CoA/clause-library filename here —
  same value already shown on today's badges, just relocated into the finding).
- `suggestedQuestion`: a short, human-facing question a reviewer could ask to resolve the finding.
  Written per-rule by each agent, same effort level as today's `flags.push(...)` message strings.
- `provenance.policyVersion`: `config/model-policy.json`'s own `version` field (`1` today), read at
  finding-creation time.
- `provenance.modelProvider`/`modelName`: `null` at creation. **Findings are mutated in place** the
  first time that finding's Explain/AI-Suggest button is clicked and the model call succeeds — at that
  point the calling agent sets `finding.provenance.modelProvider = result.provider` and
  `finding.provenance.modelName = result.model`, then re-sends the `flag-created` envelope (see
  Orchestrator section) so the persisted queue item picks up the update. The explanation *text* itself
  stays exactly as ephemeral as it is today — rendered into the on-page `.explanation` div, never
  persisted to `localStorage` or included in the finding. Only *which provider/model produced an
  explanation* becomes part of the audit trail; the explanation content itself is not.

## postMessage envelope

Generalizes today's ad-hoc `{type:'swarm-flag',agentId,itemId,summary}` /
`{type:'swarm-decision',itemId,decision}`:

```json
{ "version": 1, "type": "compliance-swarm:flag-created", "agentId": "payroll", "payload": { "...": "a Finding object" } }
{ "version": 1, "type": "compliance-swarm:decision-made", "agentId": "payroll", "payload": { "itemId": "finding_...", "decision": "approved" } }
```

`version` is a plain integer versioning the *envelope* shape itself (bump it if `{version,type,agentId,
payload}` changes later) — independent of `Finding.schemaVersion`, which versions the payload. Matches
the integer-version convention `config/model-policy.json` (`version`) and settings
(`schemaVersion`) already use in this codebase.

### `shared/agent-common.js` API changes

```js
export function createFinding({ agentId, severity, title, evidence, reference, suggestedQuestion }) {
  return {
    schemaVersion: 1,
    id: `finding_${crypto.randomUUID()}`,
    agentId,
    severity,
    status: 'open',
    title,
    evidence,
    reference,
    suggestedQuestion,
    createdAt: new Date().toISOString(),
    provenance: { policyVersion: null, modelProvider: null, modelName: null } // policyVersion filled by caller (see below)
  };
}

export function notifyParentIfEmbedded(finding) {
  if (window.self === window.top) return;
  window.parent.postMessage(
    { version: 1, type: 'compliance-swarm:flag-created', agentId: finding.agentId, payload: finding },
    window.location.origin
  );
}

export function listenForDecisions(onDecision) {
  window.addEventListener('message', e => {
    if (e.origin !== window.location.origin) return;
    if (e.data?.type === 'compliance-swarm:decision-made') {
      onDecision(e.data.payload.itemId, e.data.payload.decision);
    }
  });
}
```

- `createFinding` takes `agentId`/`severity`/`title`/`evidence`/`reference`/`suggestedQuestion` from
  the caller and fills in everything else. `provenance.policyVersion` can't be filled in here without
  threading `modelPolicy` through every call site — instead, each agent sets it right after calling
  `createFinding`, since it already has `modelPolicy` in scope from its existing `loadModelPolicy()`
  call: `finding.provenance.policyVersion = modelPolicy.version;`.
- `notifyParentIfEmbedded`'s signature changes from `(agentId, item)` to `(finding)` — `finding.agentId`
  makes the separate `agentId` argument redundant. Every call site
  (`notifyParentIfEmbedded(AGENT_ID, {id, summary})`) updates to `notifyParentIfEmbedded(finding)`.
- `listenForDecisions`'s callback signature (`(itemId, decision) => ...`) is unchanged — only the
  envelope it unwraps to get there changes — so each agent's `listenForDecisions((itemId, decision) =>
  {...})` call site needs no edit at all.
- The origin lock added in this session's `81fefda`/`9bb6efd` work is preserved as-is.

### Example integration — Payroll's `flagRow()`/`render()`

Concrete enough to remove ambiguity about how the pieces above actually wire together:

```js
function flagRow(row) {
  const flags = [];
  const minWage = MIN_WAGE_TABLE[row.state];
  if (minWage && row.rate < minWage) {
    flags.push({ severity: 'high', message: `Rate $${row.rate.toFixed(2)}/hr is below the ${row.state} demo minimum wage of $${minWage.toFixed(2)}/hr` });
  }
  if (row.hours >= 60) {
    flags.push({ severity: 'medium', message: `${row.hours} hours this week is unusually high — verify against time records` });
  }
  if (row.classification === 'Exempt' && row.hours >= 45) {
    flags.push({ severity: 'high', message: `Exempt employee logged ${row.hours} hours with no overtime pay — possible misclassification risk` });
  }
  return flags; // was string[], now [{severity, message}]
}

// in render(), replacing today's notifyParentIfEmbedded(AGENT_ID, {id, summary}) call:
currentRows.forEach((row, i) => {
  if (row.parseError) return;
  flagRow(row).forEach(flag => {
    const finding = createFinding({
      agentId: AGENT_ID,
      severity: flag.severity,
      title: flag.message,
      evidence: { summary: flag.message, sourceReference: `payroll-${i}`, sourceText: null },
      reference: { id: null, templateSource: null, templateVersion: null },
      suggestedQuestion: `Confirm ${row.employee}'s ${flag.severity === 'high' ? 'pay rate' : 'hours'} for this pay period.`
    });
    finding.provenance.policyVersion = modelPolicy.version;
    notifyParentIfEmbedded(finding);
  });
});
```

Books and Contract follow the same shape: their existing flag-detection logic gains a `severity`
alongside whatever message it already builds, then calls `createFinding` + `notifyParentIfEmbedded`
once per flag instead of the current single `{id, summary}` object.

**Behavior change worth calling out explicitly:** today, Payroll notifies the parent once per *row*
using only `flags[0]` — if a row trips both the wage-floor and misclassification checks, only the first
message ever reaches the queue. Under this design it notifies once per *flag*, so that same row becomes
two separate findings in the Unified Inbox, each independently approvable/rejectable. This is a genuine
behavior change, not incidental to the refactor — flagging it here so it's a deliberate choice, not a
side effect discovered after the fact. Contract already notifies once per matched clause (unchanged);
Books has only one flag type per transaction (unchanged).

### Re-notifying on provenance update

When a finding's `provenance.modelProvider`/`modelName` get filled in after a successful Explain call,
the agent calls `notifyParentIfEmbedded(finding)` again with the same `finding.id`. This reuses the
`flag-created` type (not a new message type) — see the Orchestrator section below for how a
same-`id` `flag-created` message is treated as an update rather than a duplicate.

## Orchestrator changes

### Queue schema + migration

`compliance-swarm-queue` items become full `Finding` objects. `loadQueue()` gains a migration step,
mirroring `shared/model-client.js`'s settings migration pattern:

```js
function migrateQueueItem(item) {
  if (item.schemaVersion === 1) return item; // already current
  // Pre-schemaVersion shape: {itemId, agentId, summary, decision}
  return {
    schemaVersion: 1,
    id: item.itemId,
    agentId: item.agentId,
    severity: 'medium', // unknown provenance — safest default, not a claim about actual risk
    status: item.decision ?? 'open',
    title: item.summary,
    evidence: { summary: item.summary, sourceReference: null, sourceText: null },
    reference: { id: null, templateSource: null, templateVersion: null },
    suggestedQuestion: null,
    createdAt: null, // unknown — genuinely wasn't recorded pre-migration
    provenance: { policyVersion: null, modelProvider: null, modelName: null }
  };
}
```

Applied to every item in `loadQueue()`'s return, immediately after parsing, before `queueError`
handling — same place `shared/model-client.js`'s `loadSettings()` migrates on read. Re-saved via the
existing `saveQueue()` on the next write (approve/reject/new-finding), not forced immediately, matching
the settings migration's "re-save on next natural write" behavior.

### Message handling

`window.addEventListener('message', ...)` in `orchestrator.html` switches on `e.data.type`:

- `'compliance-swarm:flag-created'`: find existing queue item by `e.data.payload.id`. If none exists,
  push the new `Finding` as-is. If one exists (a provenance-update re-notify, per above), merge the
  incoming payload over the existing item **except** `status` — preserve whatever `status` the
  orchestrator/reviewer already set, exactly like today's code already special-cases preserving
  `decision` across a `summary` update. Then re-send a `decision-made` envelope back down if `status`
  is already non-`"open"`, same as today's re-sync-on-reconnect behavior for `decision`.
- `'compliance-swarm:decision-made'`: unchanged in effect — sets `status` on the matching queue item,
  re-renders, and (new) posts the `decision-made` envelope back to the originating iframe, same as
  today's `decide()`.

`reviewHtml()`'s rendering reads `item.status` instead of `item.decision`, and `item.title` instead of
`item.summary`, for the queue-item card and badge (`escapeHtml(item.status)` etc. — the escaping this
session's XSS fixes added carries over unchanged, just reading a renamed/relocated field).

## What doesn't change

FieldSnap/ShelfSnap's queues and `orchestrator.html`'s lane-rendering code for them (`LANES`,
`enrichLaneDocs`, `laneHtml`), the Books/Contract/Payroll on-page table/badge UI, `shared/model-client.js`
(model-routing/settings are untouched by this), and the CSP/XSS/postMessage-origin work from earlier
this session (all of it composes cleanly with this — the envelope's origin check is the same
`window.location.origin` lock already in place).

## Testing / verification

Same approach as every other spec in this repo: no automated test framework, verification is real
headless-browser interaction (the cached Playwright Chromium already used this session). Specifically:

- Fresh queue (no existing `localStorage` data): a new finding created in each of Payroll/Books/Contract
  round-trips through the envelope into the orchestrator's queue with the correct shape, severity, and
  `reference`/`evidence` content for each of the rule types that can fire.
- Migrated queue: seed `localStorage` with a pre-migration flat item, reload the orchestrator, confirm
  it renders correctly and the stored item has been upgraded to the new shape on next write.
- Approve/reject still updates `status` and re-renders the badge in the source agent's iframe, exactly
  like today's decision-flow test.
- Provenance update: click Explain on a finding, confirm `provenance.modelProvider`/`modelName` land in
  the persisted queue item afterward, and confirm the explanation *text* itself is not present anywhere
  in `localStorage`.
- Origin-lock and XSS-escaping regression: re-run this session's existing payload/CSP checks against
  the new code paths (new fields flow through the same `escapeHtml` calls, nothing here introduces a
  new unescaped interpolation site).

## Out of scope

- FieldSnap/ShelfSnap adopting this shape (see Scope decisions above).
- Real template version tracking / a template registry (deferred again).
- Persisting explanation text into the finding or the queue.
- A "why did severity change" or finding-history/audit-log view — `status` transitions and provenance
  updates overwrite in place, no revision history is kept.
- Any change to `config/model-policy.json`'s own shape or the model-routing/settings system.
- Custom-mode Settings UI (separate, independent piece of deferred work — its own spec).
