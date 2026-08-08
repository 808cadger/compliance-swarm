# ShelfSnap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add ShelfSnap (`agents/shelf-snap-demo.html`) as a new standalone SnapSuite product — owner-configured shelf profiles, worker-driven camera capture, on-device storage, and a `shelf_snap_queue` lane surfaced in `orchestrator.html`'s Unified Inbox — per `docs/superpowers/specs/2026-08-07-shelfsnap-design.md`.

**Architecture:** One new self-contained agent page (`agents/shelf-snap-demo.html`) reusing `shared/model-client.js` exactly like every other agent. It extends the existing shared IndexedDB database `snapsuite_local` (bumping `DB_VERSION` 1 → 2, additive stores only) rather than creating a separate database. `orchestrator.html`'s FieldSnap-only inbox lane (`enrichFieldDocs`/`fieldHtml`) is generalized into a lane-config-driven pair of functions reused by both FieldSnap and ShelfSnap, rather than duplicating that logic a second time in the same file.

**Tech Stack:** Vanilla HTML/CSS/JS, ES modules, IndexedDB, `localStorage`. Served via `python3 -m http.server` (existing repo requirement — opening via `file://` breaks `fetch()` of `config/model-policy.json`).

## Global Constraints

- No framework, no backend, no cloud database/storage, no remote image uploads, no vendor API calls, no real purchases — same as every other agent in this repo.
- Captured images are `Blob`/`File` in IndexedDB only, **never** base64 or image payloads in `localStorage`. Previews render via `URL.createObjectURL(blob)`, revoked on rerender/unload.
- IDs via `crypto.randomUUID()`.
- Camera: `getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false })`, with a desktop file-upload fallback (`<input type="file" accept="image/*" capture="environment">`) and a graceful denied-permission/unsupported-browser message. Stop all tracks on capture completion and on `beforeunload`.
- **Shared-database version coupling:** `snapsuite_local` is used by both `field-capture-demo.html` (currently `DB_VERSION = 1`) and the new `shelf-snap-demo.html` (`DB_VERSION = 2`). IndexedDB throws `VersionError` if a page requests a version *lower* than the database's current version. Because ShelfSnap will be the first page to request version 2, **Task 2 must also bump `field-capture-demo.html`'s `DB_VERSION` constant to `2`** — otherwise, after a browser has ever opened ShelfSnap, FieldSnap's own `indexedDB.open(DB_NAME, 1)` call throws and the whole page breaks. Every `onupgradeneeded` handler across both files must stay guarded (`if (!database.objectStoreNames.contains(X))`) so it's a no-op no matter which page's schema ran first.
- `shelf_snap_queue` (and every other `localStorage` queue key) is append-only and malformed-JSON-safe: a parse failure must render an inline error and leave the stored value untouched, never overwrite it.
- `config/model-policy.json`'s tripwires (`requireHumanApproval: true`, `allowExecutedActions: false`, `allowCloudFallback: false`) are untouched by this plan — Task 1 only adds an empty per-agent override object, which changes no policy semantics.
- Stage 1 makes **no model calls** in ShelfSnap. `detection_status` stays `"pending"`; `detected_items`/`low_stock_items`/`critical_stock_items` stay empty arrays. The Settings/badge UI still renders (via `resolveModelConfig('shelf_review', ...)`) so a human can see what would be used later, exactly like FieldSnap's current "Analysis unavailable" pattern — this is not a stub, it's the honest Stage 1 state.
- No test framework exists in this repo. Verification is real-browser interaction over the local static server — same precedent as `docs/superpowers/plans/2026-08-07-model-policy-v2.md`'s Global Constraints (cached Playwright Chromium at `/home/cadger/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`, driver library `/home/cadger/Documents/kane-avatar/node_modules/playwright-core`, required directly with Node — that project is never modified). `getUserMedia` cannot be exercised headlessly without a fake camera device; where noted, verification substitutes the file-upload fallback path, which exercises the same `persistImage()` code the camera path calls.

---

## Task 1: `config/model-policy.json` — add `shelf_review` agent entry

**Files:**
- Modify: `config/model-policy.json`

**Interfaces:**
- Produces: `modelPolicy.agents.shelf_review` (empty object, inherits `defaults`), read by `resolveModelConfig('shelf_review', modelPolicy, settings)` in Task 2.

- [ ] **Step 1: Add the entry**

Find:
```json
  "agents": {
    "books_review": {},
    "contract_review": {},
    "payroll_explainer": {
```
Replace with:
```json
  "agents": {
    "books_review": {},
    "contract_review": {},
    "shelf_review": {},
    "payroll_explainer": {
```

- [ ] **Step 2: Validate JSON**

```bash
python3 -m json.tool config/model-policy.json
```
Expected: parses with no error, `agents.shelf_review` present as `{}`.

- [ ] **Step 3: Commit**

```bash
git add config/model-policy.json
git commit -m "Add shelf_review agent entry to model-policy.json for ShelfSnap"
```

---

## Task 2: `agents/shelf-snap-demo.html` — core Stage 1 (storage, seeding, capture, list)

**Files:**
- Create: `agents/shelf-snap-demo.html`
- Modify: `agents/field-capture-demo.html:53-54` (DB_VERSION bump, see Global Constraints)

**Interfaces:**
- Consumes: `loadSettings`, `loadModelPolicy`, `resolveModelConfig`, `renderSettingsPanel`, `renderModelError`, `renderResultBadge` from `../shared/model-client.js` (unchanged exports).
- Produces (for Task 3 to extend in the same file): `db` (module-level, the open IndexedDB connection), `profiles` (module-level array of shelf-profile records), `PROFILE_STORE = 'shelf_profiles'` constant, `idbRequest(request)`, `complete(tx, message)`, `renderShelfSelect()`, `renderShelfStatus()` — Task 3's Owner Options dialog reads/writes `profiles` and calls these two render functions after saving an edit.
- Produces (for Task 4, `orchestrator.html`, to read from IndexedDB directly — not imported, just the on-disk shape): `shelf_snapshots` records shaped exactly as below, `shelf_snapshot_blobs` records `{id, blob}`, and `shelf_snap_queue` (`localStorage`) records shaped exactly as below.

- [ ] **Step 1: Bump `field-capture-demo.html`'s `DB_VERSION`**

Find (`agents/field-capture-demo.html`):
```js
const DB_NAME = 'snapsuite_local';
const DB_VERSION = 1;
```
Replace with:
```js
const DB_NAME = 'snapsuite_local';
const DB_VERSION = 2;
```

- [ ] **Step 2: Create `agents/shelf-snap-demo.html`**

```html
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>ShelfSnap</title>
<style>
:root { color-scheme: light dark; }
body { font-family: system-ui, sans-serif; margin: 0; padding: 2rem; max-width: 760px; margin-inline: auto; line-height: 1.5; }
h1 { font-size: 1.4rem; margin-block-end: 0; } h2 { font-size: 1.1rem; }
label { display: block; margin-block: .65rem; } input, select, textarea { font: inherit; padding: .35rem; max-width: 100%; box-sizing: border-box; }
button { cursor: pointer; padding: .4rem .75rem; border-radius: 4px; border: 1px solid #8886; background: transparent; font: inherit; }
button:hover { background: rgba(136,136,136,.15); } button:disabled { cursor: not-allowed; opacity: .6; }
.settings-panel { border: 1px solid #8886; border-radius: 6px; padding: .75rem 1rem; margin-block-end: 1rem; }
.settings-panel label { display: block; margin-block: .35rem; } .settings-note { font-size: .8rem; opacity: .7; margin: .35rem 0 0; }
.badge { display: inline-block; font-size: .75rem; padding: .1rem .5rem; border-radius: 999px; margin-inline-start: .5rem; background: rgba(136,136,136,.15); }
.notice, .model-error { font-size: .85rem; } .model-error { color: #c0392b; } .notice { border-left: 3px solid #8886; padding-inline-start: .75rem; }
video { display: block; width: min(100%, 480px); max-height: 360px; background: #111; border-radius: 6px; margin-block: 1rem; }
.capture { border: 1px solid #8886; border-radius: 6px; padding: 1rem; }
.captured-doc { display: grid; grid-template-columns: 120px 1fr; gap: 1rem; border-top: 1px solid #8884; padding-block: 1rem; }
.captured-doc img { width: 120px; height: 90px; object-fit: cover; border-radius: 4px; background: #8883; }
.status { color: #a66a00; font-weight: 600; }
.actions { display: flex; flex-wrap: wrap; gap: .5rem; margin-block-start: .75rem; }
.details { margin-block-start: .65rem; font-size: .9rem; } .details dl { margin: .35rem 0; } .details dt { font-weight: 600; } .details dd { margin-inline-start: 0; white-space: pre-wrap; }
.shelf-picker { display: flex; flex-wrap: wrap; gap: .75rem; align-items: flex-end; }
.shelf-picker > div { flex: 1; min-width: 200px; }
</style>
</head>
<body>
<h1>ShelfSnap</h1>
<p class="notice">Snap the shelf. Stay stocked.</p>
<p class="notice">Layouts are configured by the owner. Snapshots are captured by anyone. Images stay in this browser on this device and are never uploaded.</p>
<div id="settings"></div>
<p id="analysis-status" class="notice"></p>
<button id="ownerOptionsBtn" type="button">Owner Options</button>
<section class="capture">
  <div class="shelf-picker">
    <div><label>Select a shelf <select id="shelfSelect"><option value="">Loading shelves&hellip;</option></select></label></div>
    <div><label>Or enter/scan a shelf ID <input id="shelfIdInput" autocomplete="off" placeholder="Overrides the dropdown"></label></div>
  </div>
  <p id="shelf-status" class="notice">Select a shelf or enter a shelf ID to enable capture.</p>
  <video id="camera" autoplay playsinline muted hidden></video>
  <p id="camera-status" class="notice">Requesting the rear camera&hellip;</p>
  <button id="capture-btn" type="button" disabled>&#128248; Snap Shelf</button>
  <input id="file-input" type="file" accept="image/*" capture="environment" hidden>
  <p id="capture-error" class="model-error" role="alert"></p>
</section>
<section><h2>Recent Shelf Snaps</h2><div id="snapshots"><p>Loading on-device snaps&hellip;</p></div></section>

<script type="module">
import { loadSettings, loadModelPolicy, resolveModelConfig, renderSettingsPanel, renderModelError, renderResultBadge } from '../shared/model-client.js';

const DB_NAME = 'snapsuite_local';
const DB_VERSION = 2;
const SNAP_STORE = 'snaps';
const BLOB_STORE = 'snap_blobs';
const PROFILE_STORE = 'shelf_profiles';
const SNAPSHOT_STORE = 'shelf_snapshots';
const SNAPSHOT_BLOB_STORE = 'shelf_snapshot_blobs';
const CATALOG_STORE = 'product_catalog';
const PROPOSAL_STORE = 'reorder_proposals';
const NOTIFICATION_STORE = 'shelf_notifications';
const QUEUE_KEY = 'shelf_snap_queue';
const LAYOUT_TYPES = ['bin_grid', 'shelf_row', 'pegboard', 'bulk_shelf', 'open_layout'];

const STARTER_PROFILES = [
  {
    id: 'electrical-fasteners', name: 'Electrical Fasteners Shelf', location: 'Aisle 3, Bay B', layout_type: 'bin_grid',
    items: [
      { slot: 'A1', sku: 'WN-RED-100', name: 'Red Wire Nuts', unit: 'box', min_qty: 2, target_qty: 6, reorder_qty: 4, preferred_vendor: 'TBD — set in Stage 2', critical: false },
      { slot: 'A2', sku: 'WN-BLU-100', name: 'Blue Wire Nuts', unit: 'box', min_qty: 2, target_qty: 6, reorder_qty: 4, preferred_vendor: 'TBD — set in Stage 2', critical: false },
      { slot: 'B1', sku: 'EMT-CONN-050', name: '1/2-inch EMT Connectors', unit: 'each', min_qty: 10, target_qty: 40, reorder_qty: 20, preferred_vendor: 'TBD — set in Stage 2', critical: true },
      { slot: 'B2', sku: 'EMT-CONN-075', name: '3/4-inch EMT Connectors', unit: 'each', min_qty: 10, target_qty: 40, reorder_qty: 20, preferred_vendor: 'TBD — set in Stage 2', critical: true }
    ]
  },
  {
    id: 'plumbing-repair', name: 'Plumbing Repair Shelf', location: 'Aisle 5, Bay A', layout_type: 'shelf_row',
    items: [
      { slot: 'Shelf 1', sku: 'PVC-ELB-90', name: 'PVC Elbows (90°)', unit: 'each', min_qty: 8, target_qty: 30, reorder_qty: 15, preferred_vendor: 'TBD — set in Stage 2', critical: false },
      { slot: 'Shelf 1', sku: 'PVC-CPL-STD', name: 'PVC Couplings', unit: 'each', min_qty: 8, target_qty: 30, reorder_qty: 15, preferred_vendor: 'TBD — set in Stage 2', critical: false },
      { slot: 'Shelf 2', sku: 'PIPE-CEMENT-4OZ', name: 'Pipe Cement', unit: 'can', min_qty: 3, target_qty: 10, reorder_qty: 5, preferred_vendor: 'TBD — set in Stage 2', critical: true },
      { slot: 'Shelf 2', sku: 'THREAD-TAPE-STD', name: 'Thread Seal Tape', unit: 'roll', min_qty: 5, target_qty: 20, reorder_qty: 10, preferred_vendor: 'TBD — set in Stage 2', critical: false }
    ]
  },
  {
    id: 'shop-consumables', name: 'General Shop Consumables Shelf', location: 'Back Wall', layout_type: 'bulk_shelf',
    items: [
      { slot: 'Bin 1', sku: 'GLOVES-WORK-L', name: 'Work Gloves (L)', unit: 'pair', min_qty: 4, target_qty: 12, reorder_qty: 8, preferred_vendor: 'TBD — set in Stage 2', critical: false },
      { slot: 'Bin 2', sku: 'TRASH-BAGS-33GAL', name: 'Trash Bags (33 gal)', unit: 'box', min_qty: 2, target_qty: 8, reorder_qty: 4, preferred_vendor: 'TBD — set in Stage 2', critical: false },
      { slot: 'Bin 3', sku: 'SHOP-TOWELS-BLU', name: 'Shop Towels (Blue)', unit: 'roll', min_qty: 3, target_qty: 10, reorder_qty: 5, preferred_vendor: 'TBD — set in Stage 2', critical: false },
      { slot: 'Bin 4', sku: 'BATTERIES-AA', name: 'Batteries (AA, 4-pack)', unit: 'pack', min_qty: 5, target_qty: 20, reorder_qty: 10, preferred_vendor: 'TBD — set in Stage 2', critical: true }
    ]
  }
];

let db; let stream = null; let objectUrls = []; let profiles = []; let currentShelf = null;
const $ = id => document.getElementById(id);
const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' })[c]);
function setError(message = '') { $('capture-error').textContent = message; }
function imageRef(id) { return `snapsuite_local://${SNAPSHOT_BLOB_STORE}/${id}`; }

function openDb() { return new Promise((resolve, reject) => {
  if (!('indexedDB' in window)) return reject(new Error('IndexedDB is not supported by this browser.'));
  const request = indexedDB.open(DB_NAME, DB_VERSION);
  request.onupgradeneeded = () => {
    const database = request.result;
    if (!database.objectStoreNames.contains(SNAP_STORE)) database.createObjectStore(SNAP_STORE, { keyPath: 'id' });
    if (!database.objectStoreNames.contains(BLOB_STORE)) database.createObjectStore(BLOB_STORE, { keyPath: 'id' });
    if (!database.objectStoreNames.contains('approvals')) database.createObjectStore('approvals', { keyPath: 'id' });
    if (!database.objectStoreNames.contains('settings')) database.createObjectStore('settings', { keyPath: 'key' });
    if (!database.objectStoreNames.contains(PROFILE_STORE)) database.createObjectStore(PROFILE_STORE, { keyPath: 'id' });
    if (!database.objectStoreNames.contains(SNAPSHOT_STORE)) database.createObjectStore(SNAPSHOT_STORE, { keyPath: 'id' });
    if (!database.objectStoreNames.contains(SNAPSHOT_BLOB_STORE)) database.createObjectStore(SNAPSHOT_BLOB_STORE, { keyPath: 'id' });
    if (!database.objectStoreNames.contains(CATALOG_STORE)) database.createObjectStore(CATALOG_STORE, { keyPath: 'sku' });
    if (!database.objectStoreNames.contains(PROPOSAL_STORE)) database.createObjectStore(PROPOSAL_STORE, { keyPath: 'id' });
    if (!database.objectStoreNames.contains(NOTIFICATION_STORE)) database.createObjectStore(NOTIFICATION_STORE, { keyPath: 'id' });
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(new Error('Could not open SnapSuite on-device storage.'));
}); }
function idbRequest(request) { return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error('IndexedDB operation failed.')); }); }
function complete(tx, message) { return new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = tx.onerror = () => reject(new Error(message)); }); }

async function seedStarterProfiles() {
  const existing = await idbRequest(db.transaction(PROFILE_STORE, 'readonly').objectStore(PROFILE_STORE).getAll());
  if (existing.length) return;
  const tx = db.transaction(PROFILE_STORE, 'readwrite');
  STARTER_PROFILES.forEach(profile => tx.objectStore(PROFILE_STORE).put(profile));
  await complete(tx, 'Could not seed starter shelf profiles.');
}
async function getProfiles() { return idbRequest(db.transaction(PROFILE_STORE, 'readonly').objectStore(PROFILE_STORE).getAll()); }
async function getSnapshots() { const tx = db.transaction(SNAPSHOT_STORE, 'readonly'); return idbRequest(tx.objectStore(SNAPSHOT_STORE).getAll()); }
async function getSnapshotBlob(id) { const tx = db.transaction(SNAPSHOT_BLOB_STORE, 'readonly'); const entry = await idbRequest(tx.objectStore(SNAPSHOT_BLOB_STORE).get(id)); return entry?.blob || null; }
async function saveSnapshot(snapshot, blob) {
  const tx = db.transaction([SNAPSHOT_STORE, SNAPSHOT_BLOB_STORE], 'readwrite');
  tx.objectStore(SNAPSHOT_BLOB_STORE).put({ id: snapshot.id, blob });
  tx.objectStore(SNAPSHOT_STORE).put(snapshot);
  await complete(tx, 'Could not save the shelf snapshot and image to IndexedDB.');
}
function revokeObjectUrls() { objectUrls.forEach(URL.revokeObjectURL); objectUrls = []; }
function readQueue(key) {
  const raw = localStorage.getItem(key); if (!raw) return [];
  try { const queue = JSON.parse(raw); if (!Array.isArray(queue)) throw new Error(); return queue; }
  catch { throw new Error(`The ${key} queue is malformed. It was left unchanged.`); }
}
function appendQueue(key, item) { const queue = readQueue(key); queue.push(item); localStorage.setItem(key, JSON.stringify(queue)); }

function renderShelfSelect() {
  const select = $('shelfSelect');
  select.innerHTML = profiles.length
    ? `<option value="">Choose a shelf&hellip;</option>${profiles.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}${p.location ? ` — ${escapeHtml(p.location)}` : ''}</option>`).join('')}`
    : '<option value="">No shelf profiles yet</option>';
}
function resolveCurrentShelf() {
  const typedId = $('shelfIdInput').value.trim();
  if (typedId) {
    const known = profiles.find(p => p.id === typedId);
    return known || { id: typedId, name: typedId, location: '', layout_type: '' };
  }
  const selectedId = $('shelfSelect').value;
  if (!selectedId) return null;
  return profiles.find(p => p.id === selectedId) || null;
}
function renderShelfStatus() {
  currentShelf = resolveCurrentShelf();
  $('capture-btn').disabled = !currentShelf;
  $('shelf-status').textContent = currentShelf
    ? `Ready to snap: ${currentShelf.name}${currentShelf.location ? ` (${currentShelf.location})` : ''}`
    : 'Select a shelf or enter a shelf ID to enable capture.';
}

function detailsHtml(snapshot) {
  return `<div class="details" hidden data-details="${escapeHtml(snapshot.id)}"><dl><dt>Shelf</dt><dd>${escapeHtml(snapshot.shelf_id)}</dd><dt>Status</dt><dd>${escapeHtml(snapshot.status)}</dd><dt>Detection</dt><dd>${escapeHtml(snapshot.detection_status)}</dd><dt>Notes</dt><dd>${escapeHtml(snapshot.notes || '—')}</dd><dt>Captured</dt><dd>${escapeHtml(snapshot.captured_at)}</dd></dl></div>`;
}
async function renderSnapshots() {
  revokeObjectUrls(); const container = $('snapshots');
  let snapshots; try { snapshots = await getSnapshots(); } catch (err) { container.innerHTML = `<p class="model-error">${escapeHtml(err.message)}</p>`; return; }
  snapshots.sort((a, b) => b.captured_at.localeCompare(a.captured_at));
  if (!snapshots.length) { container.innerHTML = '<p>No shelf snaps yet.</p>'; return; }
  const rows = await Promise.all(snapshots.map(async snapshot => {
    const blob = await getSnapshotBlob(snapshot.id); const url = blob ? URL.createObjectURL(blob) : null; if (url) objectUrls.push(url);
    const shelfName = profiles.find(p => p.id === snapshot.shelf_id)?.name || snapshot.shelf_id;
    const image = url ? `<img src="${url}" alt="Shelf snap for ${escapeHtml(shelfName)}">` : '<div class="notice">Original image unavailable.</div>';
    return `<article class="captured-doc">${image}<div><strong>${escapeHtml(shelfName)}</strong> <span class="status">${escapeHtml(snapshot.status)}</span><br><small>${escapeHtml(snapshot.captured_at)}</small><div class="actions"><button data-details-toggle="${escapeHtml(snapshot.id)}" aria-expanded="false">View Details</button></div>${detailsHtml(snapshot)}</div></article>`;
  }));
  container.innerHTML = rows.join('');
  container.querySelectorAll('img').forEach(img => img.addEventListener('error', () => { img.alt = 'Image preview unavailable'; img.removeAttribute('src'); }));
  container.querySelectorAll('[data-details-toggle]').forEach(button => button.addEventListener('click', () => {
    const details = [...container.querySelectorAll('[data-details]')].find(item => item.dataset.details === button.dataset.detailsToggle);
    if (!details) return setError('Details for this snap are unavailable.');
    const opening = details.hidden; details.hidden = !opening; button.setAttribute('aria-expanded', String(opening)); button.textContent = opening ? 'Hide Details' : 'View Details';
  }));
}

async function persistImage(blob, filename) {
  if (!blob || !blob.type.startsWith('image/')) return setError('Choose or capture a supported image file.');
  if (!window.crypto?.randomUUID) return setError('This browser does not support crypto.randomUUID(), which is required for capture IDs.');
  if (!currentShelf) return setError('Select a shelf or enter a shelf ID before capturing.');
  const id = window.crypto.randomUUID(); const capturedAt = new Date().toISOString();
  const snapshot = {
    id, shelf_id: currentShelf.id, image_ref: imageRef(id), captured_at: capturedAt, captured_by: 'local_user',
    source_app: 'shelfsnap', location_hint: currentShelf.location || '', layout_type: currentShelf.layout_type || '',
    detection_status: 'pending', detected_items: [], low_stock_items: [], critical_stock_items: [],
    reorder_proposal_id: null, status: 'needs_review', notes: '', approval_history: []
  };
  try {
    await saveSnapshot(snapshot, blob);
    appendQueue(QUEUE_KEY, { id: crypto.randomUUID(), source: 'shelfsnap', type: 'shelf_snapshot', shelf_id: currentShelf.id, shelf_name: currentShelf.name, snapshot_id: id, status: 'needs_review', created_at: capturedAt, summary: `${currentShelf.name}: shelf snap needs review` });
    setError(''); await renderSnapshots();
  } catch (err) { setError(err.message); }
}
function snap() {
  if (!stream || $('camera').hidden || !$('camera').videoWidth) return $('file-input').click();
  const canvas = document.createElement('canvas'); canvas.width = $('camera').videoWidth; canvas.height = $('camera').videoHeight;
  canvas.getContext('2d').drawImage($('camera'), 0, 0); canvas.toBlob(blob => { if (blob) persistImage(blob, `shelfsnap-${Date.now()}.jpg`); else setError('Could not create an image from the camera.'); }, 'image/jpeg', .92);
}
async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) { $('camera-status').textContent = 'Camera capture is unavailable here. Choose an image file instead.'; return; }
  try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false }); $('camera').srcObject = stream; $('camera').hidden = false; $('camera-status').textContent = 'Rear camera ready. If this is not the rear camera, use your device camera controls.'; }
  catch { $('camera-status').textContent = 'Camera permission was denied or unavailable. Choose an image file instead.'; }
}
async function init() {
  try { db = await openDb(); await seedStarterProfiles(); profiles = await getProfiles(); } catch (err) { setError(err.message); $('capture-btn').disabled = true; return; }
  try {
    const modelPolicy = await loadModelPolicy(); renderSettingsPanel($('settings'), modelPolicy);
    const settingsNote = $('settings').querySelector('.settings-note');
    if (settingsNote) settingsNote.textContent = 'Stored only in this browser\'s localStorage. Repo Defaults resolves this page\'s provider/model from config/model-policy.json.';
    const config = resolveModelConfig('shelf_review', modelPolicy, loadSettings());
    $('analysis-status').innerHTML = `${renderResultBadge(config)} <strong>Analysis unavailable:</strong> automatic low-stock detection is not built yet. A human must review every shelf snap.`;
  } catch (err) {
    renderModelError($('analysis-status'), err);
    $('analysis-status').append(' Shelf review cannot run.');
  }
  renderShelfSelect(); renderShelfStatus(); await renderSnapshots(); startCamera();
}
$('shelfSelect').addEventListener('change', renderShelfStatus);
$('shelfIdInput').addEventListener('input', renderShelfStatus);
$('capture-btn').addEventListener('click', snap);
$('file-input').addEventListener('change', e => { const file = e.target.files?.[0]; if (file) persistImage(file, file.name); e.target.value = ''; });
window.addEventListener('beforeunload', () => { revokeObjectUrls(); stream?.getTracks().forEach(track => track.stop()); });
init();
</script>
</body>
</html>
```

- [ ] **Step 3: Verify the module script is syntactically valid**

```bash
python3 - <<'EOF'
import re
html = open('agents/shelf-snap-demo.html').read()
m = re.search(r'<script type="module">(.*)</script>', html, re.S)
open('/tmp/shelfsnap-module-check.mjs', 'w').write(m.group(1))
EOF
node --check /tmp/shelfsnap-module-check.mjs
```
Expected: no output, exit code 0. (The extracted script uses real `import`/top-level code, so a plain `.mjs` check — no `--input-type=module` needed since the extension itself marks it a module — validates syntax without executing browser-only calls like `getUserMedia`, which would throw at runtime outside a browser, not at parse time, so this is safe.)

- [ ] **Step 4: Real-browser verification**

Start `python3 -m http.server 8000` from the repo root. Using the cached Playwright Chromium (per Global Constraints):

1. `localStorage.clear()`, then load `http://localhost:8000/agents/shelf-snap-demo.html`. Confirm no console errors, the three starter shelves appear in the "Select a shelf" dropdown, Settings shows "Repo Defaults" checked, and the analysis-status line reads the "Analysis unavailable" message with a badge.
2. Reload the page. Confirm the dropdown still shows exactly 3 shelves (seeding is idempotent — `getAll()` on `shelf_profiles` still returns 3, not 6).
3. Grant a fake camera device (Chromium flag `--use-fake-device-for-media-stream`) or otherwise allow `getUserMedia`; confirm the video element becomes visible and "📸 Snap Shelf" is disabled until a shelf is selected. Select "Electrical Fasteners Shelf", confirm the button enables and the status line reads "Ready to snap: Electrical Fasteners Shelf (Aisle 3, Bay B)".
4. Click "📸 Snap Shelf". Confirm a new row appears under "Recent Shelf Snaps" with a thumbnail, the shelf name, a timestamp, and status "needs_review"; click "View Details" and confirm the detail fields render.
5. Reload the page. Confirm the snap from Step 4 still appears (IndexedDB persistence across reload) with its thumbnail intact.
6. Inspect `localStorage.getItem('shelf_snap_queue')` via `page.evaluate`. Confirm it's a JSON array with one object matching the shape `{id, source: "shelfsnap", type: "shelf_snapshot", shelf_id: "electrical-fasteners", shelf_name: "Electrical Fasteners Shelf", snapshot_id, status: "needs_review", created_at, summary}`.
7. Deny camera permission (or run without `--use-fake-device-for-media-stream` and reject the prompt). Confirm `camera-status` shows the denied-permission message and clicking "📸 Snap Shelf" opens the file picker instead (`file-input` receives the click). Upload a real image file and confirm it saves and appears in Recent Shelf Snaps identically to the camera path.
8. Type an ID not in the starter list (e.g. `test-shelf-99`) into "Or enter/scan a shelf ID". Confirm it overrides the dropdown, the status line reads "Ready to snap: test-shelf-99", and a snap taken with it appends a queue record with `shelf_id: "test-shelf-99"`, `shelf_name: "test-shelf-99"`.
9. Set `localStorage.setItem('shelf_snap_queue', 'not json')`, reload, take another snap. Confirm `setError` shows the malformed-queue message and — critically — `localStorage.getItem('shelf_snap_queue')` is still exactly `'not json'` afterward (never silently overwritten), matching the `readQueue`/`appendQueue` guard behavior.
10. Set `localStorage.setItem('compliance-swarm-settings', ...)` to a state with `mode: 'force-cloud'` and no `cloud.apiKey`; reload. Confirm the analysis-status line shows the `NO_KEY` message via `renderModelError`, not a silent fallback to any other provider.
11. Load `http://localhost:8000/agents/field-capture-demo.html` directly (not via ShelfSnap) after Step 1-10 have run against the same browser profile/origin. Confirm it still loads with no console errors and its existing snaps (if any were created earlier in this same test session) still render — this is the regression check for the `DB_VERSION` bump in Step 1.

Take at least one screenshot as evidence.

- [ ] **Step 5: Commit**

```bash
git add agents/shelf-snap-demo.html agents/field-capture-demo.html
git commit -m "Add ShelfSnap core: shelf selection, camera capture, IndexedDB storage, shelf_snap_queue"
```

---

## Task 3: Owner Options dialog

**Files:**
- Modify: `agents/shelf-snap-demo.html`

**Interfaces:**
- Consumes: `profiles`, `PROFILE_STORE`, `db`, `idbRequest`, `complete`, `escapeHtml`, `renderShelfSelect`, `renderShelfStatus`, `LAYOUT_TYPES` — all defined in Task 2, same file, module-level scope.
- Produces: nothing consumed by other tasks (Task 4/5 don't touch this dialog).

- [ ] **Step 1: Add the dialog markup**

Find:
```html
<button id="ownerOptionsBtn" type="button">Owner Options</button>
<section class="capture">
```
Replace with:
```html
<button id="ownerOptionsBtn" type="button">Owner Options</button>
<dialog id="ownerDialog">
  <h2>Owner Options &mdash; Shelf Profiles</h2>
  <div id="ownerProfileList"></div>
  <button id="ownerCloseBtn" type="button">Close</button>
</dialog>
<section class="capture">
```

- [ ] **Step 2: Add dialog + owner-profile CSS**

Find:
```css
.shelf-picker { display: flex; flex-wrap: wrap; gap: .75rem; align-items: flex-end; }
.shelf-picker > div { flex: 1; min-width: 200px; }
</style>
```
Replace with:
```css
.shelf-picker { display: flex; flex-wrap: wrap; gap: .75rem; align-items: flex-end; }
.shelf-picker > div { flex: 1; min-width: 200px; }
dialog#ownerDialog { border: 1px solid #8886; border-radius: 8px; padding: 1.25rem; max-width: min(90vw, 640px); max-height: 80vh; overflow-y: auto; }
dialog#ownerDialog::backdrop { background: rgba(0,0,0,.4); }
.owner-profile { border: 1px solid #8886; border-radius: 6px; padding: .75rem 1rem; margin-block-end: 1rem; }
.owner-profile legend { font-weight: 600; padding-inline: .35rem; }
.owner-save-status { font-size: .8rem; }
table.owner-items { width: 100%; border-collapse: collapse; margin-block-start: .5rem; font-size: .85rem; }
table.owner-items th, table.owner-items td { text-align: left; padding: .25rem .4rem; border-bottom: 1px solid #8884; }
</style>
```

- [ ] **Step 3: Add the dialog's rendering and save logic**

Find:
```js
$('shelfSelect').addEventListener('change', renderShelfStatus);
```
Replace with:
```js
function ownerProfileHtml(profile) {
  return `<fieldset class="owner-profile" data-owner-profile="${escapeHtml(profile.id)}">
    <legend>${escapeHtml(profile.id)}</legend>
    <label>Name <input type="text" data-field="name" value="${escapeHtml(profile.name)}"></label>
    <label>Location <input type="text" data-field="location" value="${escapeHtml(profile.location)}"></label>
    <label>Layout type <select data-field="layout_type">${LAYOUT_TYPES.map(t => `<option value="${t}"${profile.layout_type === t ? ' selected' : ''}>${t}</option>`).join('')}</select></label>
    <button type="button" data-owner-save="${escapeHtml(profile.id)}">Save</button>
    <p class="owner-save-status" data-owner-status="${escapeHtml(profile.id)}"></p>
    <details><summary>Items (${profile.items.length}) &mdash; read-only, edit in a later stage</summary><table class="owner-items"><thead><tr><th>Slot</th><th>SKU</th><th>Name</th><th>Unit</th><th>Min</th><th>Target</th><th>Reorder</th><th>Critical</th></tr></thead><tbody>${profile.items.map(item => `<tr><td>${escapeHtml(item.slot)}</td><td>${escapeHtml(item.sku)}</td><td>${escapeHtml(item.name)}</td><td>${escapeHtml(item.unit)}</td><td>${item.min_qty}</td><td>${item.target_qty}</td><td>${item.reorder_qty}</td><td>${item.critical ? 'Yes' : 'No'}</td></tr>`).join('')}</tbody></table></details>
  </fieldset>`;
}
function renderOwnerDialog() {
  $('ownerProfileList').innerHTML = profiles.map(ownerProfileHtml).join('') || '<p>No shelf profiles yet.</p>';
  $('ownerProfileList').querySelectorAll('[data-owner-save]').forEach(btn => btn.addEventListener('click', () => saveOwnerProfile(btn.dataset.ownerSave)));
}
async function saveOwnerProfile(id) {
  const fieldset = $('ownerProfileList').querySelector(`[data-owner-profile="${CSS.escape(id)}"]`);
  const profile = profiles.find(p => p.id === id);
  if (!fieldset || !profile) return;
  profile.name = fieldset.querySelector('[data-field="name"]').value.trim() || profile.name;
  profile.location = fieldset.querySelector('[data-field="location"]').value.trim();
  profile.layout_type = fieldset.querySelector('[data-field="layout_type"]').value;
  const status = fieldset.querySelector('[data-owner-status]');
  try {
    const tx = db.transaction(PROFILE_STORE, 'readwrite');
    tx.objectStore(PROFILE_STORE).put(profile);
    await complete(tx, 'Could not save this shelf profile.');
    status.textContent = 'Saved.'; status.classList.remove('model-error');
    renderShelfSelect(); renderShelfStatus();
  } catch (err) { status.textContent = err.message; status.classList.add('model-error'); }
}
$('ownerOptionsBtn').addEventListener('click', () => { renderOwnerDialog(); $('ownerDialog').showModal(); });
$('ownerCloseBtn').addEventListener('click', () => $('ownerDialog').close());
$('shelfSelect').addEventListener('change', renderShelfStatus);
```

- [ ] **Step 4: Real-browser verification**

With the local server running:

1. Load the page, click "Owner Options". Confirm the dialog opens showing all 3 starter profiles, each with editable Name/Location/Layout type and a read-only items table (Plumbing Repair Shelf shows 4 rows including "Pipe Cement" marked Critical: Yes).
2. Change "Electrical Fasteners Shelf"'s Location to `Aisle 3, Bay C` and its Layout type to `open_layout`, click that profile's Save. Confirm the status line shows "Saved."
3. Click Close, reopen Owner Options. Confirm the edited values persisted (Location now `Aisle 3, Bay C`, layout `open_layout` selected).
4. Close the dialog, confirm the "Select a shelf" dropdown option for that shelf now shows `Electrical Fasteners Shelf — Aisle 3, Bay C` (picks up the rename immediately via `renderShelfSelect()`).
5. Reload the page entirely. Confirm the edit persisted in IndexedDB (not lost on reload).

Take at least one screenshot as evidence.

- [ ] **Step 5: Commit**

```bash
git add agents/shelf-snap-demo.html
git commit -m "Add ShelfSnap Owner Options dialog for editing shelf name/location/layout type"
```

---

## Task 4: `orchestrator.html` — ShelfSnap tab + generalized inbox lane

**Files:**
- Modify: `agents/orchestrator.html`

**Interfaces:**
- Consumes: `shelf_snap_queue` (localStorage, Task 2's shape) and the `shelf_snapshots`/`shelf_snapshot_blobs` IndexedDB stores (Task 2's shapes) — read-only, no writes from this file.
- No change to `compliance-swarm-queue`'s `postMessage` (`swarm-flag`/`swarm-decision`) behavior for Payroll/Books/Contract, or to `field_docs_queue`'s existing shape/behavior — this task generalizes the *code* that reads FieldSnap's lane, not its externally observable behavior.

- [ ] **Step 1: Add the ShelfSnap tab and iframe**

Find:
```html
  <button data-tab="fieldsnap">FieldSnap</button>
</div>
```
Replace with:
```html
  <button data-tab="fieldsnap">FieldSnap</button>
  <button data-tab="shelfsnap">ShelfSnap</button>
</div>
```

Find:
```html
    <iframe data-agent="fieldsnap" src="field-capture-demo.html" class="agent-frame"></iframe>
  </div>
```
Replace with:
```html
    <iframe data-agent="fieldsnap" src="field-capture-demo.html" class="agent-frame"></iframe>
    <iframe data-agent="shelfsnap" src="shelf-snap-demo.html" class="agent-frame"></iframe>
  </div>
```

- [ ] **Step 2: Replace the entire second `<script>` block**

Find the second `<script>` block — starting at `const QUEUE_KEY = 'compliance-swarm-queue';` and ending at `renderQueue();` immediately before `</script>` — and replace its **entire contents** with:

```js
const QUEUE_KEY = 'compliance-swarm-queue';
const SNAP_DB_NAME = 'snapsuite_local';
const LANES = {
  fieldsnap: {
    queueKey: 'field_docs_queue',
    detailStore: 'snaps',
    blobStore: 'snap_blobs',
    label: 'FieldSnap',
    heading: 'FieldSnap paperwork',
    unavailableMessage: 'FieldSnap detail storage is unavailable on this device.',
    rowFields(detail, index) {
      return {
        title: detail?.job_hint || index.job || 'No job specified',
        sourceLine: `Source: FieldSnap · Type: ${detail?.snap_type || 'Unknown'} · Captured: ${detail?.captured_at || index.timestamp || 'Capture time unavailable'}`,
        detailLine: `Amount hint: ${detail?.amount_hint || index.amount_hint || '—'} · Proposed filing: ${proposalText(detail?.proposed_filing)}`,
        status: detail?.status || index.status || 'needs_review',
        job: detail?.job_hint || index.job || '',
        type: detail?.snap_type || '',
        detailsRows: detail ? [
          ['Job / project', detail.job_hint],
          ['Amount hint', detail.amount_hint || '—'],
          ['Notes', detail.notes || '—'],
          ['Snap type', detail.snap_type],
          ['GPS', gpsText(detail.gps)],
          ['Captured', detail.captured_at],
          ['Status', detail.status]
        ] : []
      };
    }
  },
  shelfsnap: {
    queueKey: 'shelf_snap_queue',
    detailStore: 'shelf_snapshots',
    blobStore: 'shelf_snapshot_blobs',
    label: 'ShelfSnap',
    heading: 'ShelfSnap paperwork',
    unavailableMessage: 'ShelfSnap detail storage is unavailable on this device.',
    rowFields(detail, index) {
      const shelfName = index.shelf_name || detail?.shelf_id || 'Unspecified shelf';
      return {
        title: shelfName,
        sourceLine: `Source: ShelfSnap · Captured: ${detail?.captured_at || index.created_at || 'Capture time unavailable'}`,
        detailLine: `Location: ${detail?.location_hint || '—'} · Detection: ${detail?.detection_status || 'pending'}`,
        status: detail?.status || index.status || 'needs_review',
        job: '',
        type: detail?.layout_type || '',
        detailsRows: detail ? [
          ['Shelf', detail.shelf_id],
          ['Location', detail.location_hint || '—'],
          ['Layout type', detail.layout_type || '—'],
          ['Detection status', detail.detection_status],
          ['Notes', detail.notes || '—'],
          ['Captured', detail.captured_at],
          ['Status', detail.status]
        ] : []
      };
    }
  }
};

let queue = [];
let queueError = false;
let laneErrors = { fieldsnap: false, shelfsnap: false };
let laneStorageErrors = { fieldsnap: '', shelfsnap: '' };
let laneDocs = { fieldsnap: [], shelfsnap: [] };
let objectUrls = [];
let renderNumber = 0;
const filters = { status: '', source: '', job: '', type: '' };

function loadQueue() {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    const value = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(value)) throw new Error('not an array');
    queueError = false;
    return value.filter(item => item && typeof item === 'object');
  } catch (e) { queueError = true; return []; }
}
function saveQueue(items) { localStorage.setItem(QUEUE_KEY, JSON.stringify(items)); }
function loadLaneQueue(lane) {
  try {
    const raw = localStorage.getItem(LANES[lane].queueKey);
    const value = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(value)) throw new Error('not an array');
    laneErrors[lane] = false;
    return value.filter(item => item && typeof item === 'object');
  } catch (e) { laneErrors[lane] = true; return []; }
}
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function revokeObjectUrls() { objectUrls.forEach(URL.revokeObjectURL); objectUrls = []; }
function sourceLabel(source) {
  return ({ payroll: 'Payroll', books: 'Books', contract: 'Contract', fieldsnap: 'FieldSnap', shelfsnap: 'ShelfSnap' })[source] || 'Review item';
}
function proposalText(proposal) {
  if (!proposal) return 'No proposal yet';
  if (typeof proposal === 'string') return proposal || 'No proposal yet';
  if (typeof proposal !== 'object') return String(proposal);
  const values = Object.entries(proposal).filter(([, value]) => value !== '' && value != null).map(([key, value]) => {
    if (typeof value !== 'object') return `${key}: ${value}`;
    try { return `${key}: ${JSON.stringify(value)}`; } catch { return `${key}: unavailable`; }
  });
  return values.length ? values.join(' · ') : 'No proposal yet';
}
function gpsText(gps) {
  return gps ? `${gps.latitude}, ${gps.longitude}${gps.accuracy_m != null ? ` (accuracy ${gps.accuracy_m}m)` : ''}` : 'Unavailable';
}
function openSnapDb() { return new Promise((resolve, reject) => {
  if (!('indexedDB' in window)) return reject(new Error('IndexedDB is not supported by this browser.'));
  const request = indexedDB.open(SNAP_DB_NAME);
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(new Error('Could not open on-device SnapSuite storage.'));
}); }
function idbRequest(request) { return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error('IndexedDB operation failed.')); }); }
async function enrichLaneDocs(lane, indexItems) {
  const laneConfig = LANES[lane];
  laneStorageErrors[lane] = '';
  if (!indexItems.length) return [];
  let db;
  try { db = await openSnapDb(); }
  catch (err) { laneStorageErrors[lane] = err.message; return indexItems.map(index => ({ index, detail: null, blob: null })); }
  try {
    if (!db.objectStoreNames.contains(laneConfig.detailStore) || !db.objectStoreNames.contains(laneConfig.blobStore)) throw new Error(laneConfig.unavailableMessage);
    return await Promise.all(indexItems.map(async index => {
      const tx = db.transaction([laneConfig.detailStore, laneConfig.blobStore], 'readonly');
      const detail = await idbRequest(tx.objectStore(laneConfig.detailStore).get(index.id));
      const blobEntry = await idbRequest(tx.objectStore(laneConfig.blobStore).get(index.id));
      return { index, detail: detail || null, blob: blobEntry?.blob || null };
    }));
  } catch (err) {
    laneStorageErrors[lane] = err.message;
    return indexItems.map(index => ({ index, detail: null, blob: null }));
  } finally { db.close(); }
}
function unifiedItems() {
  const reviewItems = queue.map(item => ({ kind: 'review', source: item.agentId || '', status: item.decision || 'pending', job: '', type: '', item }));
  const laneItems = Object.keys(LANES).flatMap(lane => laneDocs[lane].map(doc => {
    const fields = LANES[lane].rowFields(doc.detail, doc.index);
    return { kind: 'lane', lane, source: lane, status: fields.status, job: fields.job, type: fields.type, doc, fields };
  }));
  return [...reviewItems, ...laneItems];
}
function matchesFilters(item) {
  return (!filters.status || item.status === filters.status)
    && (!filters.source || item.source === filters.source)
    && (!filters.job || item.job === filters.job)
    && (!filters.type || item.type === filters.type);
}
function optionsFor(items, key, label) {
  const values = [...new Set(items.map(item => key === 'source' ? item.source : item[key]).filter(Boolean))];
  return `<option value="">All ${label}</option>${values.map(value => `<option value="${escapeHtml(value)}"${filters[key] === value ? ' selected' : ''}>${escapeHtml(key === 'source' ? sourceLabel(value) : value)}</option>`).join('')}`;
}
function filterHtml(items) {
  return `<div class="filter-bar" aria-label="Inbox filters">
    <label>Status <select data-filter="status">${optionsFor(items, 'status', 'statuses')}</select></label>
    <label>Source <select data-filter="source">${optionsFor(items, 'source', 'sources')}</select></label>
    <label>Job <select data-filter="job">${optionsFor(items, 'job', 'jobs')}</select></label>
    <label>Document type <select data-filter="type">${optionsFor(items, 'type', 'document types')}</select></label>
  </div>`;
}
function reviewHtml(items) {
  if (queueError) return '<h2>Review items</h2><p class="model-error">The review queue is malformed and was left unchanged.</p>';
  if (!items.length) return '<h2>Review items</h2><p>No review items match these filters.</p>';
  return `<h2>Review items</h2>${items.map(({ item }) => `<div class="queue-item" data-item-id="${escapeHtml(item.itemId)}">
    <div class="queue-agent-tag">${escapeHtml(sourceLabel(item.agentId))}</div>
    <p>${escapeHtml(item.summary)}</p>
    ${item.decision ? `<span class="badge badge-${escapeHtml(item.decision)}">${escapeHtml(item.decision)}</span>` : `<button data-approve="${escapeHtml(item.itemId)}">Approve</button> <button data-reject="${escapeHtml(item.itemId)}">Reject</button>`}
  </div>`).join('')}`;
}
function laneHtml(lane, items) {
  const laneConfig = LANES[lane];
  if (laneErrors[lane]) return `<h2>${laneConfig.heading}</h2><p class="model-error">The ${laneConfig.label} queue is malformed and was left unchanged.</p>`;
  const storageNote = laneStorageErrors[lane] ? `<p class="model-error">${escapeHtml(laneStorageErrors[lane])} Showing available queue information only.</p>` : '';
  if (!items.length) return `<h2>${laneConfig.heading}</h2>${storageNote}<p>No ${laneConfig.label} paperwork matches these filters.</p>`;
  return `<h2>${laneConfig.heading}</h2>${storageNote}${items.map(({ doc, fields }) => {
    const { blob } = doc;
    let url = null;
    try { if (blob instanceof Blob) url = URL.createObjectURL(blob); } catch { url = null; }
    if (url) objectUrls.push(url);
    const thumbnail = url ? `<img class="field-thumb" src="${url}" alt="${escapeHtml(laneConfig.label)} image for ${escapeHtml(fields.title)}">` : '<div class="thumbnail-unavailable">Original unavailable</div>';
    return `<div class="queue-item field-row"><div>${thumbnail}</div><div>
      <div class="queue-agent-tag">${escapeHtml(laneConfig.label)}</div>
      <p><strong>${escapeHtml(fields.title)}</strong><br><small>${escapeHtml(fields.sourceLine)}</small><br><small>${escapeHtml(fields.detailLine)}</small><br><span class="badge">${escapeHtml(fields.status)}</span></p>
      <details><summary>View Details</summary><dl>${fields.detailsRows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v ?? '—')}</dd>`).join('')}</dl></details>
    </div></div>`;
  }).join('')}`;
}
function bindInboxEvents(el) {
  el.querySelectorAll('[data-filter]').forEach(select => select.addEventListener('change', () => { filters[select.dataset.filter] = select.value; renderQueue(); }));
  el.querySelectorAll('[data-approve]').forEach(btn => btn.addEventListener('click', () => decide(btn.dataset.approve, 'approved')));
  el.querySelectorAll('[data-reject]').forEach(btn => btn.addEventListener('click', () => decide(btn.dataset.reject, 'rejected')));
  el.querySelectorAll('.field-thumb').forEach(img => img.addEventListener('error', () => { img.replaceWith(Object.assign(document.createElement('div'), { className: 'thumbnail-unavailable', textContent: 'Preview unavailable' })); }));
  const clearBtn = el.querySelector('#clearQueueBtn');
  if (clearBtn) clearBtn.addEventListener('click', clearQueue);
}
async function renderQueue() {
  const thisRender = ++renderNumber;
  revokeObjectUrls();
  queue = loadQueue();
  for (const lane of Object.keys(LANES)) {
    const indexItems = loadLaneQueue(lane);
    laneDocs[lane] = await enrichLaneDocs(lane, indexItems);
  }
  if (thisRender !== renderNumber) return;
  const allItems = unifiedItems();
  const visible = allItems.filter(matchesFilters);
  const el = document.getElementById('queue');
  el.innerHTML = `<h2>Unified Inbox</h2><button id="clearQueueBtn">Clear Review Queue</button>${filterHtml(allItems)}${reviewHtml(visible.filter(item => item.kind === 'review'))}${Object.keys(LANES).map(lane => laneHtml(lane, visible.filter(item => item.kind === 'lane' && item.lane === lane))).join('')}`;
  bindInboxEvents(el);
}
function clearQueue() {
  queue = [];
  localStorage.removeItem(QUEUE_KEY);
  renderQueue();
}
function decide(itemId, decision) {
  const item = queue.find(q => q.itemId === itemId);
  if (!item) return;
  item.decision = decision;
  saveQueue(queue);
  renderQueue();
  const iframe = document.querySelector(`iframe[data-agent="${item.agentId}"]`);
  if (iframe) iframe.contentWindow.postMessage({ type: 'swarm-decision', itemId, decision }, '*');
}
window.addEventListener('message', e => {
  if (!e.data || e.data.type !== 'swarm-flag') return;
  const { agentId, itemId, summary } = e.data;
  queue = loadQueue();
  let item = queue.find(q => q.itemId === itemId);
  if (!item) {
    item = { itemId, agentId, summary, decision: null };
    queue.push(item);
  } else {
    item.summary = summary;
    if (item.decision) {
      const iframe = document.querySelector(`iframe[data-agent="${agentId}"]`);
      if (iframe) iframe.contentWindow.postMessage({ type: 'swarm-decision', itemId, decision: item.decision }, '*');
    }
  }
  saveQueue(queue);
  renderQueue();
});
window.addEventListener('storage', e => {
  if (e.key === LANES.fieldsnap.queueKey || e.key === LANES.shelfsnap.queueKey || e.key === QUEUE_KEY) renderQueue();
});
window.addEventListener('beforeunload', revokeObjectUrls);
renderQueue();
```

Note: the generic `openSnapDb()` error message changed from the FieldSnap-specific `'Could not open on-device FieldSnap storage.'` to `'Could not open on-device SnapSuite storage.'` since it's now shared across lanes — a deliberate wording change, not a regression. Every other FieldSnap-visible string (headings, field labels, badge text) is unchanged.

- [ ] **Step 3: Real-browser verification**

With the local server running:

1. Load `http://localhost:8000/agents/orchestrator.html`. Confirm 4 tabs (Payroll, Books, Contract, FieldSnap) plus the new ShelfSnap tab, and clicking ShelfSnap activates its iframe.
2. With no queue data, confirm the Unified Inbox shows "No review items match these filters", "No FieldSnap paperwork matches these filters", and "No ShelfSnap paperwork matches these filters".
3. In the ShelfSnap tab, take a shelf snap (per Task 2's flow). Switch to another tab and back, or reload the orchestrator. Confirm a "ShelfSnap paperwork" row appears with the shelf name, thumbnail, location, detection status "pending", and badge "needs_review".
4. In the FieldSnap tab, capture a document. Confirm its row still renders in "FieldSnap paperwork" exactly as before (job, type, captured time, amount hint, proposed filing, GPS in details) — this is the regression check for the generalization in Step 2.
5. Use the Source filter, selecting "ShelfSnap". Confirm only the ShelfSnap row is visible; Review items and FieldSnap paperwork both show their "no items match" message. Switch Source to "FieldSnap" and confirm the inverse.
6. Trigger a Payroll flag (per the existing golden path) and Approve it in the Unified Inbox. Confirm the Payroll iframe reflects the decision — unaffected by this task's changes.
7. Set `localStorage.setItem('shelf_snap_queue', '{not valid json')`, reload. Confirm the ShelfSnap paperwork section shows its malformed-queue message and the stored value is untouched.
8. In browser storage tools, append a `shelf_snap_queue` entry with a `snapshot_id` that has no matching IndexedDB record. Reload. Confirm the row still renders using queue-only fields (shelf name, status) with "Original unavailable" for the thumbnail — matching FieldSnap's existing graceful-degradation behavior.

Take at least one screenshot as evidence.

- [ ] **Step 4: Commit**

```bash
git add agents/orchestrator.html
git commit -m "Add ShelfSnap tab and Unified Inbox lane to orchestrator.html"
```

---

## Task 5: Update README

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: nothing (documentation only). Last task.

- [ ] **Step 1: Update the `agents/` file listing**

Find:
```
agents/
- contract-review-demo.html — Standalone contract review agent
- books-review-demo.html — Standalone bookkeeping/categorization agent
- payroll-review-demo.html — Standalone payroll worksheet agent
- orchestrator.html — All three wired into one app with a shared approval queue
```
Replace with:
```
agents/
- contract-review-demo.html — Standalone contract review agent
- books-review-demo.html — Standalone bookkeeping/categorization agent
- payroll-review-demo.html — Standalone payroll worksheet agent
- field-capture-demo.html (FieldSnap) — On-device photo capture of receipts/invoices/tags/job-progress/safety forms, handed off as a needs_review item; never uploads images
- shelf-snap-demo.html (ShelfSnap) — Owner-configured shelf profiles plus worker-driven shelf photo capture, handed off as a needs_review item; never uploads images
- orchestrator.html (OfficeSnap) — All agents wired into one app with a Unified Inbox: a shared approval queue for Payroll/Books/Contract, plus separate FieldSnap and ShelfSnap paperwork lanes
```

- [ ] **Step 2: Read the updated section back**

```bash
grep -n "agents/" -A 8 README.md
```
Expected: the block matches Step 1's replacement exactly.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "Document FieldSnap, ShelfSnap, and OfficeSnap in README's agents/ listing"
```

---

## Plan Self-Review Notes

- **Spec coverage:** Storage (reuse `snapsuite_local`, bump to v2, additive stores) → Task 2 Steps 1-2. Starter profiles (3 shelves, items with slot/SKU/unit/min/target/reorder/vendor-placeholder/critical) → Task 2 Step 2's `STARTER_PROFILES`. Capture flow (shelf select/ID entry, exact "📸 Snap Shelf" label, `getUserMedia` rear camera + file fallback, track-stop, Blob-only storage, object URL revoke) → Task 2 Step 2. Snapshot record shape (exact fields from the spec) → Task 2 Step 2's `persistImage`. Recent Shelf Snaps list (thumbnail/shelf/time/status/View Details) → Task 2 Step 2's `renderSnapshots`. `shelf_snap_queue` record shape → Task 2 Step 2's `persistImage`'s `appendQueue` call. Owner Options (list/edit name/location/layout_type, 5 layout types, read-only item summary) → Task 3. Model policy (`shelf_review` entry, Settings/badge shown, no model calls, "Analysis unavailable" honesty) → Task 1 + Task 2 Step 2's `init()`. Orchestrator integration (third tab, third lane, generalized enrichment/rendering, no handoff button) → Task 4. README → Task 5. Future stages (2-5) → intentionally not built anywhere in this plan, consistent with the spec's "Future stages (named, not built)" section.
- **Placeholder scan:** no TBD/TODO in code; `preferred_vendor: 'TBD — set in Stage 2'` is literal seed *data* the spec explicitly calls a placeholder field, not a plan placeholder. Every step has complete, literal code — no "similar to Task N" references.
- **Type consistency:** `PROFILE_STORE`/`SNAPSHOT_STORE`/`SNAPSHOT_BLOB_STORE`/`CATALOG_STORE`/`PROPOSAL_STORE`/`NOTIFICATION_STORE`/`QUEUE_KEY` constants defined in Task 2 Step 2 are the same string values Task 4 Step 2 hardcodes inside its `LANES.shelfsnap` config (`'shelf_snapshots'`, `'shelf_snapshot_blobs'`, `'shelf_snap_queue'`) — orchestrator.html doesn't import from shelf-snap-demo.html (no shared module between them, matching the existing FieldSnap/orchestrator relationship), so these are necessarily separately-declared string literals; verified they match exactly. The snapshot record's field names (`shelf_id`, `location_hint`, `layout_type`, `detection_status`, `captured_at`, `status`, `notes`) used in Task 2's `persistImage`/`detailsHtml` match exactly what Task 4's `LANES.shelfsnap.rowFields(detail, index)` reads off `detail`. The queue record's field names (`shelf_id`, `shelf_name`, `snapshot_id`, `status`, `created_at`) used in Task 2's `appendQueue` call match what Task 4's `rowFields(detail, index)` reads off `index`. `renderShelfSelect`/`renderShelfStatus`/`db`/`profiles`/`PROFILE_STORE`/`idbRequest`/`complete`/`escapeHtml`/`LAYOUT_TYPES` referenced in Task 3 are all defined with matching names/signatures in Task 2.
