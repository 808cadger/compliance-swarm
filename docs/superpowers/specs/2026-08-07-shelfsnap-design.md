# ShelfSnap Design

Date: 2026-08-07
Status: Approved

## Purpose

Add ShelfSnap as a new standalone SnapSuite product: an owner configures a shelf profile
once; any employee can select that shelf, take a picture, and the snapshot lands as a
`needs_review` item for the manager, via the existing local approval/orchestrator workflow.
Rule: "Layouts are configured by the owner. Snapshots are captured by anyone."

This spec covers Stage 0 (discovery, already complete — see below) and Stage 1 (working
foundation: shelf profiles, capture flow, local storage, queue/orchestrator integration).
Stages 2–5 (full owner options, visual detection, approval workflow, order-eligibility
simulation) are named and architecturally accounted for, but not built now.

## Stage 0 — Discovery findings

The repo already had uncommitted SnapSuite work at the time this spec was written (since
committed as `96c3d1a`, prior to ShelfSnap): **FieldSnap** (`agents/field-capture-demo.html`)
and an **OfficeSnap** rebrand of `orchestrator.html`. This establishes real conventions
ShelfSnap must reuse rather than invent:

- A shared IndexedDB database `snapsuite_local` (currently `DB_VERSION = 1`) with
  **generic, non-product-prefixed** store names: `snaps`, `snap_blobs`, `approvals`,
  `settings`. ShelfSnap's stores are a new, additive schema version on the same database
  (see Data model below) — not a separate database.
- Two distinct queue lanes feed `orchestrator.html`'s Unified Inbox:
  1. An inline, per-file `postMessage` lane (`swarm-flag` / `swarm-decision` against
     `compliance-swarm-queue`), duplicated in Payroll/Books/Contract. Suited to
     synchronous, text-only flagged rows with an inline Approve/Reject control.
  2. A **lightweight-index-plus-IndexedDB** lane: FieldSnap appends a small pointer record
     to `field_docs_queue` (localStorage), and the orchestrator polls that key directly,
     then enriches each row by reading the full record + image Blob from IndexedDB for a
     thumbnail. Suited to image-heavy, async-loaded items — this is the pattern ShelfSnap
     follows.
- `config/model-policy.json`'s `agents` map already has empty-object entries
  (`books_review: {}`, `contract_review: {}`) that simply inherit `defaults`. FieldSnap
  itself does not add an entry — it reuses `books_review`'s config purely to render the
  Settings/badge UI, since Stage 1 FieldSnap makes no model calls at all.
- No existing modal/dialog UI pattern exists anywhere in `agents/*.html` to match for Owner
  Options.

## Architecture

- Same conventions as every other agent page: a single self-contained
  `agents/shelf-snap-demo.html`, pure client-side ES modules, no build step, no framework,
  no backend. Works standalone when opened directly, and embeds via iframe in
  `orchestrator.html` like the others.
- Imports `loadSettings`, `loadModelPolicy`, `resolveModelConfig`, `renderSettingsPanel`,
  `renderModelError`, `renderResultBadge` from `shared/model-client.js` — unchanged, no new
  exports needed.
- IDs via `crypto.randomUUID()`. Images captured via `getUserMedia` are never uploaded,
  never leave the device, never encoded to base64/localStorage.

## Data model

Reuses `snapsuite_local`, bumping `DB_VERSION` 1 → 2. The `onupgradeneeded` handler is
additive: it keeps creating FieldSnap's existing stores if missing (matching the guard
pattern already in `field-capture-demo.html`) and adds:

- `shelf_profiles` (keyPath `id`) — owner-configured shelves. Record:
  ```
  {
    id,                // shelf_id, e.g. "electrical-fasteners"
    name,
    location,
    layout_type,       // one of bin_grid | shelf_row | pegboard | bulk_shelf | open_layout
    items: [
      {
        slot,           // slot/zone label
        sku,
        name,
        unit,
        min_qty,
        target_qty,
        reorder_qty,
        preferred_vendor,  // placeholder string, Stage 2 gives it real vendor rules
        critical            // bool
      }, ...
    ]
  }
  ```
- `shelf_snapshots` (keyPath `id`) — one per Snap Shelf capture, shape exactly as specified:
  ```
  {
    id, shelf_id, image_ref, captured_at, captured_by: "local_user",
    source_app: "shelfsnap", location_hint: "", layout_type: "",
    detection_status: "pending", detected_items: [], low_stock_items: [],
    critical_stock_items: [], reorder_proposal_id: null, status: "needs_review",
    notes: "", approval_history: []
  }
  ```
- `shelf_snapshot_blobs` (keyPath `id`) — `{ id, blob }`, same shape as FieldSnap's
  `snap_blobs`. `image_ref` on the snapshot record points at this store
  (`snapsuite_local://shelf_snapshot_blobs/<id>`, mirroring FieldSnap's `imageRef()`).
- `product_catalog` (keyPath `sku`) — created empty. Populated starting Stage 2.
- `reorder_proposals` (keyPath `id`) — created empty. Populated starting Stage 3.
- `shelf_notifications` (keyPath `id`) — created empty. Populated starting Stage 4.

Three starter shelf profiles are seeded into `shelf_profiles` on first load if the store is
empty (never overwriting existing rows on subsequent loads):

1. **Electrical Fasteners Shelf** (`bin_grid`) — red wire nuts, blue wire nuts, 1/2" EMT
   connectors, 3/4" EMT connectors.
2. **Plumbing Repair Shelf** (`shelf_row`) — PVC elbows, PVC couplings, pipe cement, thread
   seal tape.
3. **General Shop Consumables Shelf** (`bulk_shelf`) — work gloves, trash bags, shop towels,
   batteries.

Each sample item gets a slot/zone, SKU, unit, min/target/reorder quantities, a placeholder
preferred vendor string, and a critical flag (at minimum one critical item per shelf).

## Capture flow (worker)

1. Select a shelf from a list of `shelf_profiles`, or type/scan a shelf ID.
2. Primary button, exact label **"📸 Snap Shelf"**.
3. `getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false })`;
   camera-permission-denied or unsupported-`getUserMedia` browsers fall back to a file
   input (`<input type="file" accept="image/*" capture="environment">`), identical to
   FieldSnap's `startCamera()`/file-input pattern. Stop all tracks immediately after
   capture or on unload.
4. On capture: save the Blob to `shelf_snapshot_blobs`, save the snapshot record (shape
   above) to `shelf_snapshots`, append the lightweight queue record (below) to
   `shelf_snap_queue`, and render the new row into "Recent Shelf Snaps" without a reload.
5. "Recent Shelf Snaps" list: thumbnail (`URL.createObjectURL`, revoked on rerender/unload,
   same pattern as FieldSnap's `renderSnaps()`), shelf name, captured time, status, and a
   "View Details" toggle showing the full record.

No automatic visual detection runs in Stage 1 — `detection_status` stays `"pending"` and
`detected_items`/`low_stock_items`/`critical_stock_items` stay empty. This is not a stub
UI with fake results; it is the honest Stage 1 state, matching FieldSnap's precedent of an
explicit "Analysis unavailable" message rather than a disabled/fake button.

## Queue / orchestrator integration

- New localStorage key `shelf_snap_queue`: append-only, array-guarded, malformed-JSON-safe
  (parse failure renders an inline error and leaves the stored value untouched — same
  `readQueue`/`appendQueue` guard logic as FieldSnap, not a shared function, since nothing
  in this repo currently shares that logic across files either).
- Record shape appended on every completed snap:
  ```
  {
    id, source: "shelfsnap", type: "shelf_snapshot", shelf_id, shelf_name,
    snapshot_id, status: "needs_review", created_at, summary
  }
  ```
- `orchestrator.html` gets a third tab (`ShelfSnap`, iframing `shelf-snap-demo.html`) and a
  third Unified Inbox lane ("ShelfSnap paperwork"), polling `shelf_snap_queue` directly and
  enriching each row from `shelf_snapshots`/`shelf_snapshot_blobs` for a thumbnail. Both
  lanes live in the same `orchestrator.html` file, so this factors the row-enrichment and
  row-rendering logic that `enrichFieldDocs`/`fieldHtml` currently hardcode to FieldSnap
  into shared, parameterized helpers used by both lanes — an in-file refactor, not a new
  cross-file shared module (the repo's convention of duplicating logic *per agent file*
  is unaffected). Shows shelf name, location (if set), timestamp, status, and a "View
  Details" review action — no approve/reject control yet, matching FieldSnap's current
  (no-control) state, since Stage 1 doesn't define what "approve" means for a shelf
  snapshot (that's Stage 4).
- No handoff button to another product (unlike FieldSnap → AccountingSnap): there is no
  downstream SnapSuite product for shelf snapshots yet, so the manager reviews directly in
  OfficeSnap's Unified Inbox, per the spec's own instruction.

## Model policy

- Add `"shelf_review": {}` to `config/model-policy.json`'s `agents` map — inherits
  `defaults`, same empty-object pattern already used for `books_review`/`contract_review`.
  This is additive and schema-valid (`agents` is `additionalProperties`-open).
- `shelf-snap-demo.html` calls `resolveModelConfig('shelf_review', ...)` to render the
  Settings panel and badge, exactly like every other agent page — but Stage 1 makes no
  model call. The analysis-status line explicitly says visual detection is not available
  yet and every snapshot needs human review, mirroring FieldSnap's wording.
- All existing tripwires (`requireHumanApproval`, `!allowExecutedActions`,
  `!allowCloudFallback`, no silent cloud fallback) are unchanged and apply as-is; no new
  policy fields are introduced.

## Owner Options (Stage 1 slice)

A native `<dialog>` (no existing modal pattern in the repo to match, so this introduces the
simplest possible one — `showModal()`/`close()`, no dependencies) opened from an "Owner
Options" button. Lists the shelf profiles with name/location/layout-type as editable text
inputs and a select for `layout_type` (the five enum values). Saves back to
`shelf_profiles` on submit. Each profile also shows its item list as a **read-only**
summary (slot, SKU, name, min/target/reorder qty, critical flag) so the owner can confirm
what's seeded — item catalog editing, vendor rules, spending caps, reorder modes, and
notification targets are Stage 2 and are explicitly not editable here, so the boundary
between "configurable now" and "coming in Stage 2" is visible in the UI itself rather than
silently absent.

## Testing / verification

No test framework exists for this repo (unbuilt static HTML/JS) — matches the precedent in
`2026-08-05-agent-demos-design.md`. Verification means loading `shelf-snap-demo.html`
directly and via `orchestrator.html`'s iframe over a local static server, and exercising:

- Shelf selection from the three seeded profiles, and manual shelf-ID entry.
- Camera capture on a device/browser with `getUserMedia` support; the file-upload fallback
  on desktop/unsupported browsers; a denied-permission path.
- IndexedDB persistence of both the snapshot record and the image Blob across a reload.
- `shelf_snap_queue` growth and visibility in OfficeSnap's Unified Inbox, including
  thumbnail rendering.
- Malformed `shelf_snap_queue` JSON recovering safely (inline error, storage untouched).
- Owner Options dialog editing a shelf's name/location/layout type and persisting it.
- The unavailable-model state when no approved provider/model is configured, and
  confirmation that Force Cloud never silently falls back.

## Future stages (named, not built)

- **Stage 2** — full Owner Options: item catalog CRUD, shelf slots/zones, vendor rules,
  spending caps, reorder modes, notification targets. `product_catalog` starts getting
  real rows here.
- **Stage 3** — confidence-aware visual item/count proposals (explicitly labeled
  "Proposed", never treated as confirmed) plus manual confirmation, low-stock calculation
  against `min_qty`/`target_qty`, and draft rows in `reorder_proposals`.
- **Stage 4** — ApprovalSnap/orchestrator workflow for low-stock, critical-stock, and
  reorder-proposal review, plus real records in `shelf_notifications`.
- **Stage 5** — policy evaluation for `auto_order_eligible` as a simulation only; no real
  order is ever sent without a future, explicitly approved external integration.

## Out of scope (this spec)

- Any automatic visual inventory counting or detection.
- Real ordering, purchase-order submission, vendor integration, or email/SMS/Slack sending.
- Full item catalog editing, vendor rules, budgets, or notification targeting (Stage 2+).
- A shared/extracted queue-reading helper across FieldSnap/ShelfSnap/orchestrator — the
  repo's existing convention is per-file duplication of this logic (see the Agent Demos
  design's "Shared building blocks (duplicated per file)"), and this spec follows it rather
  than introducing a new shared module unprompted.
