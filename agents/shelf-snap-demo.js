import { loadSettings, loadModelPolicy, resolveModelConfig, renderSettingsPanel, renderModelError, renderResultBadge } from '../shared/model-client.js';
import { escapeHtml } from '../shared/agent-common.js';

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

let db; let stream = null; let objectUrls = []; let profiles = []; let currentShelf = null; let cameraStarted = false;
const $ = id => document.getElementById(id);
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
  request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
  request.onerror = () => reject(new Error('Could not open SnapSuite on-device storage.'));
  request.onblocked = () => reject(new Error('Close other SnapSuite tabs and reload.'));
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
  if (currentShelf && !cameraStarted) { cameraStarted = true; startCamera(); }
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
  renderShelfSelect(); renderShelfStatus(); await renderSnapshots();
}
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
$('shelfIdInput').addEventListener('input', renderShelfStatus);
$('capture-btn').addEventListener('click', snap);
$('file-input').addEventListener('change', e => { const file = e.target.files?.[0]; if (file) persistImage(file, file.name); e.target.value = ''; });
window.addEventListener('beforeunload', () => { revokeObjectUrls(); stream?.getTracks().forEach(track => track.stop()); });
init();
