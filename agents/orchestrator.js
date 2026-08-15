function activateTab(tabName) {
  const tabBtn = document.querySelector(`.tabs button[data-tab="${tabName}"]`);
  const frame = document.querySelector(`iframe[data-agent="${tabName}"]`);
  if (!tabBtn || !frame) return;
  document.querySelectorAll('.tabs button').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.agent-frame').forEach(f => f.classList.remove('active'));
  tabBtn.classList.add('active');
  frame.classList.add('active');
}
document.querySelectorAll('.tabs button').forEach(tabBtn => tabBtn.addEventListener('click', () => activateTab(tabBtn.dataset.tab)));
document.getElementById('snapPaperworkBtn').addEventListener('click', () => activateTab('fieldsnap'));

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
    detailKey: index => index.id,
    rowFields(detail, index) {
      const job = detail?.job_hint || index.job || 'No job specified';
      const type = detail?.snap_type || 'Unknown';
      const captured = detail?.captured_at || index.timestamp || 'Capture time unavailable';
      const amount = detail?.amount_hint || index.amount_hint || '—';
      const status = detail?.status || index.status || 'needs_review';
      return {
        title: job,
        sourceLine: `Source: FieldSnap · Type: ${type} · Captured: ${captured}`,
        detailLine: `Amount hint: ${amount} · Proposed filing: ${proposalText(detail?.proposed_filing)}`,
        status,
        job: detail?.job_hint || index.job || '',
        type: detail?.snap_type || '',
        detailsRows: detail ? [
          ['Job / project', job],
          ['Amount hint', amount],
          ['Notes', detail.notes || '—'],
          ['Snap type', type],
          ['GPS', gpsText(detail.gps)],
          ['Captured', captured],
          ['Status', status]
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
    detailKey: index => index.snapshot_id,
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

function migrateQueueItem(item) {
  if (item.schemaVersion === 1) return item;
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
    createdAt: null,
    provenance: { policyVersion: null, modelProvider: null, modelName: null }
  };
}

function loadQueue() {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    const value = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(value)) throw new Error('not an array');
    queueError = false;
    return value.filter(item => item && typeof item === 'object').map(migrateQueueItem);
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
      const detail = await idbRequest(tx.objectStore(laneConfig.detailStore).get(laneConfig.detailKey(index)));
      const blobEntry = await idbRequest(tx.objectStore(laneConfig.blobStore).get(laneConfig.detailKey(index)));
      return { index, detail: detail || null, blob: blobEntry?.blob || null };
    }));
  } catch (err) {
    laneStorageErrors[lane] = err.message;
    return indexItems.map(index => ({ index, detail: null, blob: null }));
  } finally { db.close(); }
}
function unifiedItems() {
  const reviewItems = queue.map(item => ({ kind: 'review', source: item.agentId || '', status: item.status || 'open', job: '', type: '', item }));
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
  return `<h2>Review items</h2>${items.map(({ item }) => `<div class="queue-item" data-item-id="${escapeHtml(item.id)}">
    <div class="queue-agent-tag">${escapeHtml(sourceLabel(item.agentId))}</div>
    <p>${escapeHtml(item.title)}</p>
    ${item.status !== 'open' ? `<span class="badge badge-${escapeHtml(item.status)}">${escapeHtml(item.status)}</span>` : `<button data-approve="${escapeHtml(item.id)}">Approve</button> <button data-reject="${escapeHtml(item.id)}">Reject</button>`}
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
  const item = queue.find(q => q.id === itemId);
  if (!item) return;
  item.status = decision;
  saveQueue(queue);
  renderQueue();
  const iframe = document.querySelector(`iframe[data-agent="${item.agentId}"]`);
  if (iframe) iframe.contentWindow.postMessage({ version: 1, type: 'compliance-swarm:decision-made', agentId: item.agentId, payload: { itemId, decision } }, window.location.origin);
}
window.addEventListener('message', e => {
  if (e.origin !== window.location.origin) return;
  if (!e.data || e.data.type !== 'compliance-swarm:flag-created') return;
  const finding = e.data.payload;
  queue = loadQueue();
  let item = queue.find(q => q.id === finding.id);
  if (!item) {
    queue.push(finding);
  } else {
    const preservedStatus = item.status;
    Object.assign(item, finding, { status: preservedStatus });
    if (preservedStatus !== 'open') {
      const iframe = document.querySelector(`iframe[data-agent="${finding.agentId}"]`);
      if (iframe) iframe.contentWindow.postMessage({ version: 1, type: 'compliance-swarm:decision-made', agentId: finding.agentId, payload: { itemId: item.id, decision: preservedStatus } }, window.location.origin);
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
