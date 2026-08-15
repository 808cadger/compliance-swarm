# Structured Findings, postMessage Envelope, and Provenance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Payroll/Books/Contract's ad-hoc flag objects and `{type:'swarm-flag'}`/`{type:'swarm-decision'}` postMessage shape with a common versioned `Finding` record, a versioned envelope, and a per-finding provenance stamp — per `docs/superpowers/specs/2026-08-14-structured-findings-design.md`.

**Architecture:** A new `createFinding()` helper in `shared/agent-common.js` builds the common record; `notifyParentIfEmbedded`/`listenForDecisions` in the same file wrap/unwrap it in a versioned envelope. Each of Payroll/Books/Contract calls `createFinding()` at its existing flag-detection site instead of building an ad-hoc `{id, summary}` object. `orchestrator.html` gains a migration step for old queue data and switches its rendering/lookup from `item.decision`/`item.summary`/`item.itemId` to `item.status`/`item.title`/`item.id`.

**Tech Stack:** Vanilla JS (ES modules), no build step, no test framework — verification is real headless-Chromium interaction (Playwright's `playwright-core` driving a locally cached Chromium binary), the same approach every other plan in this repo uses.

## Global Constraints

- No automated test framework in this repo — every "test" step below is a Node script using `playwright-core` to drive headless Chromium against the app served over `http://`, not `file://` (the app's own code requires this for `fetch()` of templates/config). These scripts are **not committed** — write them to a scratch location outside the repo, run them, then discard them. Only the actual source changes in each task get committed.
- Locating the headless browser (do this once, note the paths, reuse for every task):
  ```bash
  ls ~/.cache/ms-playwright/ 2>/dev/null   # look for a chromium-<build> directory
  find ~ -maxdepth 4 -iname playwright-core -type d 2>/dev/null
  ```
  If both exist, the binary is at `~/.cache/ms-playwright/chromium-<build>/chrome-linux64/chrome` and the driver library is the `playwright-core` directory found above (`require()` it directly by that path — it does not need to be inside this repo's own `node_modules`). If neither exists, install Playwright's Chromium first (`npx playwright install chromium` in some scratch npm project) before starting Task 1.
- Serve the repo root with `python3 -m http.server <port>` from `/home/cadger/compliance-swarm/.claude/worktrees/structured-findings` before running any browser-based verification step. Use `nohup ... & disown` so the server outlives the command that started it; stop it with `pkill -f "http.server <port>"` when a task's verification is done.
- All escaping (`escapeHtml`) and postMessage origin-locking (`window.location.origin`, both as the `postMessage` target and as the `listenForDecisions`/`orchestrator.html` message-listener check) added earlier this session are load-bearing security fixes — never remove or bypass them while touching this code. Every new field that ends up interpolated into `innerHTML` must go through `escapeHtml`, same as every existing field.
- `agentId` values are the existing short form: `"payroll"` / `"books"` / `"contract"` — never `config/model-policy.json`'s `CONFIG_KEY` values (`payroll_explainer`/`books_review`/`contract_review`).
- FieldSnap, ShelfSnap, `shared/model-client.js`, and `config/model-policy.json` are out of scope — do not modify them in this plan.

---

## Task 1: `createFinding()` + envelope helpers in `shared/agent-common.js`

**Files:**
- Modify: `shared/agent-common.js` (currently 26 lines, full file shown below)

**Interfaces:**
- Produces: `createFinding({ agentId, severity, title, evidence, reference, suggestedQuestion }) → Finding` (see shape in spec's "Finding shape" section); `notifyParentIfEmbedded(finding: Finding) → void`; `listenForDecisions(onDecision: (itemId: string, decision: string) => void) → void`. These three names/signatures are what every later task imports and calls — do not rename or reshape them once this task is committed.

- [ ] **Step 1: Write the verification script (run against current code first, to confirm the harness itself works before you change anything)**

`notifyParentIfEmbedded` only does anything when `window.self !== window.top` — i.e., genuinely
embedded in an iframe. Do not try to fake that by reassigning `window.top`:
`Object.defineProperty(window, 'top', {value: {}, configurable: true})` throws
`TypeError: Cannot redefine property: top` in real Chromium (verified directly against this
project's cached Chromium binary before writing this plan — `window.top` is a non-configurable
browsing-context accessor, not a plain data property). Use a real iframe instead — this is also more
representative, since it's exactly how every agent page is actually embedded by `orchestrator.html`.

Create `/tmp/verify-agent-common.js` (adjust the two path constants at the top to whatever "Locating
the headless browser" in Global Constraints found on this machine):

```js
const assert = require('node:assert');
const { chromium } = require('/path/to/playwright-core'); // from `find ~ -maxdepth 4 -iname playwright-core`
const CHROME_PATH = '/path/to/chrome'; // from `ls ~/.cache/ms-playwright/`
const BASE = 'http://localhost:8934';

async function main() {
  const browser = await chromium.launch({ executablePath: CHROME_PATH, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.goto(`${BASE}/agents/_verify-wrapper.html`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);

  const iframeFrame = page.frames().find(f => f.url().includes('_verify-fixture.html'));
  assert.ok(iframeFrame, 'iframe frame not found');

  const fixtureResult = await iframeFrame.evaluate(() => window.__testResult);
  assert.ok(fixtureResult, 'fixture did not set window.__testResult — did the module fail to load?');
  if (fixtureResult.error) throw new Error(fixtureResult.error);

  const envelope = await page.evaluate(() => window.__capturedEnvelope);
  assert.ok(envelope, 'wrapper never captured a flag-created envelope');
  assert.strictEqual(envelope.data.version, 1, 'envelope.version');
  assert.strictEqual(envelope.data.type, 'compliance-swarm:flag-created', 'envelope.type');
  assert.strictEqual(envelope.data.agentId, 'payroll', 'envelope.agentId');
  assert.ok(envelope.data.payload.id.startsWith('finding_'), 'envelope.payload.id shape');
  assert.strictEqual(envelope.origin, BASE, 'envelope target origin');

  const findingId = await iframeFrame.evaluate(() => window.__findingId);
  const received = await iframeFrame.evaluate(() => window.__waitForDecision());
  assert.ok(received, 'fixture never received the decision-made message relayed by the wrapper');
  assert.strictEqual(received.itemId, findingId, 'received.itemId matches the original finding id');
  assert.strictEqual(received.decision, 'approved', 'received.decision');

  await browser.close();
  console.log('PASS: all agent-common.js assertions passed');
}
main().catch(err => { console.error('FAIL:', err.message); process.exit(1); });
```

Create the two fixture pages it loads (temporary — both deleted in Step 6, never committed).

`agents/_verify-wrapper.html` — the top-level page; embeds the fixture in a real iframe, captures
what it sends up, and relays a decision back down (exactly `orchestrator.html`'s own role):

```html
<!DOCTYPE html>
<html><body>
<iframe id="fixture" src="_verify-fixture.html"></iframe>
<script>
window.__capturedEnvelope = null;
window.addEventListener('message', e => {
  if (e.data && e.data.type === 'compliance-swarm:flag-created') {
    window.__capturedEnvelope = { data: e.data, origin: e.origin };
    document.getElementById('fixture').contentWindow.postMessage(
      { version: 1, type: 'compliance-swarm:decision-made', agentId: e.data.agentId, payload: { itemId: e.data.payload.id, decision: 'approved' } },
      window.location.origin
    );
  }
});
</script>
</body></html>
```

`agents/_verify-fixture.html` — the iframe content; runs the actual assertions and calls the real
`createFinding`/`notifyParentIfEmbedded`/`listenForDecisions` (exactly what an agent page's own
`<script type="module">` does):

```html
<!DOCTYPE html>
<html><body>
<script type="module">
import { createFinding, notifyParentIfEmbedded, listenForDecisions } from '../shared/agent-common.js';

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

try {
  const f = createFinding({
    agentId: 'payroll',
    severity: 'high',
    title: 'Test title',
    evidence: { summary: 'Test summary', sourceReference: 'payroll-0', sourceText: null },
    reference: { id: 'min_wage_floor', templateSource: null, templateVersion: null },
    suggestedQuestion: 'Confirm the rate?'
  });
  assertEqual(f.schemaVersion, 1, 'schemaVersion');
  assertEqual(typeof f.id, 'string', 'id type');
  assertEqual(f.id.startsWith('finding_'), true, 'id prefix');
  assertEqual(f.agentId, 'payroll', 'agentId');
  assertEqual(f.severity, 'high', 'severity');
  assertEqual(f.status, 'open', 'status');
  assertEqual(f.title, 'Test title', 'title');
  assertEqual(f.evidence.sourceReference, 'payroll-0', 'evidence.sourceReference');
  assertEqual(f.reference.id, 'min_wage_floor', 'reference.id');
  assertEqual(f.suggestedQuestion, 'Confirm the rate?', 'suggestedQuestion');
  assertEqual(typeof f.createdAt, 'string', 'createdAt type');
  assertEqual(f.provenance.policyVersion, null, 'provenance.policyVersion default');
  assertEqual(f.provenance.modelProvider, null, 'provenance.modelProvider default');
  assertEqual(f.provenance.modelName, null, 'provenance.modelName default');

  const f2 = createFinding({ agentId: 'books', severity: 'medium', title: 'x', evidence: {}, reference: {}, suggestedQuestion: null });
  if (f.id === f2.id) throw new Error('createFinding produced duplicate ids across two calls');

  let received = null;
  listenForDecisions((itemId, decision) => { received = { itemId, decision }; });

  notifyParentIfEmbedded(f); // genuinely embedded here (this file is loaded as an iframe), so this really posts up

  window.__findingId = f.id;
  window.__waitForDecision = () => received; // polled by the outer script after it relays a decision down
  window.__testResult = { error: null };
} catch (err) {
  window.__testResult = { error: err.message };
}
</script>
</body></html>
```

- [ ] **Step 2: Serve the repo and run the verification script to confirm it FAILS**

```bash
cd /home/cadger/compliance-swarm/.claude/worktrees/structured-findings && nohup python3 -m http.server 8934 >/tmp/http-server.log 2>&1 & disown
sleep 1
node /tmp/verify-agent-common.js
```

Expected: FAIL — `createFinding` is not yet exported, so the fixture's `import` throws and `window.__testResult` is never set; the script's `assert.ok(result, ...)` fails with that message.

- [ ] **Step 3: Implement `createFinding` and update `notifyParentIfEmbedded`/`listenForDecisions`**

Replace the full contents of `shared/agent-common.js`:

```js
// shared/agent-common.js
// Cross-page helpers shared by the agent demo pages: HTML-escaping for
// interpolated user content, the common Finding record shape, and the
// versioned postMessage envelope used to flag review items up to the
// orchestrator (OfficeSnap) and receive decisions back down when embedded
// in its iframe. Messages are restricted to same-origin senders/targets
// since every agent page is only ever embedded by orchestrator.html served
// from this same app.

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

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
    provenance: { policyVersion: null, modelProvider: null, modelName: null }
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

- [ ] **Step 4: Run the verification script to confirm it PASSES**

```bash
node /tmp/verify-agent-common.js
```

Expected: `PASS: all agent-common.js assertions passed`, exit code 0.

- [ ] **Step 5: Stop the server**

```bash
pkill -f "http.server 8934"
```

- [ ] **Step 6: Delete the temporary fixtures (they must not be committed)**

```bash
rm /home/cadger/compliance-swarm/.claude/worktrees/structured-findings/agents/_verify-wrapper.html
rm /home/cadger/compliance-swarm/.claude/worktrees/structured-findings/agents/_verify-fixture.html
```

- [ ] **Step 7: Commit**

```bash
cd /home/cadger/compliance-swarm/.claude/worktrees/structured-findings
git add shared/agent-common.js
git status --short   # confirm neither _verify-wrapper.html nor _verify-fixture.html is listed — both were deleted in Step 6, never staged
git commit -m "Add createFinding() and versioned postMessage envelope to agent-common.js

notifyParentIfEmbedded/listenForDecisions now wrap/unwrap findings in a
{version, type, agentId, payload} envelope instead of the old ad-hoc
{type:'swarm-flag'}/{type:'swarm-decision'} shape. Per
docs/superpowers/specs/2026-08-14-structured-findings-design.md.

No consumer of the old notifyParentIfEmbedded(agentId, item) signature
is updated yet — Payroll/Books/Contract/orchestrator.html are updated
in the next tasks of this plan."
```

---

## Task 2: `orchestrator.js` — queue migration + envelope-aware message handling

**Files:**
- Modify: `agents/orchestrator.js:89-97` (`loadQueue`), `:108-110` (`escapeHtml` — unchanged, listed for context), `:156` (`unifiedItems`), `:181-189` (`reviewHtml`), `:236-263` (`decide` + the `message` listener)

**Interfaces:**
- Consumes: the envelope shape from Task 1 (`{version, type, agentId, payload}`, `type` ∈ `'compliance-swarm:flag-created'|'compliance-swarm:decision-made'`), and the `Finding` shape (`id`, `agentId`, `title`, `status`, `schemaVersion`, plus `evidence`/`reference`/`suggestedQuestion`/`createdAt`/`provenance` which orchestrator reads but doesn't render).
- Produces: `migrateQueueItem(item) → Finding` — used only inside `loadQueue()`, not exported (this file has no module system; it's a plain `<script>`, not `type="module"`, so "export" here just means "defined at file scope, available to the rest of this file").

This task does **not** depend on Payroll/Books/Contract being updated yet — it's verified by posting a hand-built envelope message directly, simulating what an updated agent page will send starting in Task 3.

- [ ] **Step 1: Write the verification script**

Create `/tmp/verify-orchestrator.js` (reuse the `CHROME_PATH`/playwright-core path constants from Task 1):

```js
const assert = require('node:assert');
const { chromium } = require('/path/to/playwright-core');
const CHROME_PATH = '/path/to/chrome';
const BASE = 'http://localhost:8934';

async function main() {
  const browser = await chromium.launch({ executablePath: CHROME_PATH, args: ['--no-sandbox'] });
  const page = await browser.newPage();

  // --- Scenario A: fresh queue, a flag-created envelope creates a queue item ---
  await page.goto(`${BASE}/agents/orchestrator.html`, { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle' });
  const finding = {
    schemaVersion: 1, id: 'finding_test-1', agentId: 'payroll', severity: 'high', status: 'open',
    title: 'Rate below CA minimum wage',
    evidence: { summary: 'Employee rate $7.00/hr is below the CA demo minimum wage of $16.00/hr', sourceReference: 'payroll-0', sourceText: null },
    reference: { id: 'min_wage_floor', templateSource: null, templateVersion: null },
    suggestedQuestion: 'Confirm the rate.', createdAt: '2026-08-15T00:00:00.000Z',
    provenance: { policyVersion: 1, modelProvider: null, modelName: null }
  };
  await page.evaluate((f) => {
    window.postMessage({ version: 1, type: 'compliance-swarm:flag-created', agentId: 'payroll', payload: f }, window.location.origin);
  }, finding);
  await page.waitForTimeout(300);
  let stored = await page.evaluate(() => JSON.parse(localStorage.getItem('compliance-swarm-queue')));
  assert.strictEqual(stored.length, 1, 'queue should have 1 item after flag-created');
  assert.strictEqual(stored[0].id, 'finding_test-1', 'stored item id');
  assert.strictEqual(stored[0].status, 'open', 'stored item status');
  const bodyText = await page.evaluate(() => document.getElementById('queue').innerText);
  assert.ok(bodyText.includes('Rate below CA minimum wage'), 'queue UI should render the finding title');

  // --- Scenario B: approve via UI, confirm status updates and a decision-made is posted back ---
  const approveClicked = await page.evaluate(() => {
    const btn = document.querySelector('[data-approve]');
    if (!btn) return false;
    btn.click();
    return true;
  });
  assert.ok(approveClicked, 'expected an Approve button to be present for the open finding');
  await page.waitForTimeout(300);
  stored = await page.evaluate(() => JSON.parse(localStorage.getItem('compliance-swarm-queue')));
  assert.strictEqual(stored[0].status, 'approved', 'status after approve click');

  // --- Scenario C: re-notify with the same id and a filled-in provenance updates in place, preserving status ---
  const updated = { ...finding, provenance: { policyVersion: 1, modelProvider: 'anthropic', modelName: 'claude-sonnet-5' } };
  await page.evaluate((f) => {
    window.postMessage({ version: 1, type: 'compliance-swarm:flag-created', agentId: 'payroll', payload: f }, window.location.origin);
  }, updated);
  await page.waitForTimeout(300);
  stored = await page.evaluate(() => JSON.parse(localStorage.getItem('compliance-swarm-queue')));
  assert.strictEqual(stored.length, 1, 're-notify with same id must not create a second item');
  assert.strictEqual(stored[0].status, 'approved', 'status must survive a provenance re-notify');
  assert.strictEqual(stored[0].provenance.modelProvider, 'anthropic', 'provenance should be updated');

  // --- Scenario D: migration of a pre-schemaVersion item ---
  await page.evaluate(() => {
    localStorage.setItem('compliance-swarm-queue', JSON.stringify([
      { itemId: 'payroll-legacy-1', agentId: 'payroll', summary: 'Legacy flag text', decision: null }
    ]));
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(300);
  const legacyBodyText = await page.evaluate(() => document.getElementById('queue').innerText);
  assert.ok(legacyBodyText.includes('Legacy flag text'), 'migrated legacy item should render its title');
  const legacyApproveClicked = await page.evaluate(() => {
    const btn = document.querySelector('[data-approve]');
    if (!btn) return false;
    btn.click();
    return true;
  });
  assert.ok(legacyApproveClicked, 'migrated legacy item should be approvable');
  await page.waitForTimeout(300);
  stored = await page.evaluate(() => JSON.parse(localStorage.getItem('compliance-swarm-queue')));
  assert.strictEqual(stored[0].schemaVersion, 1, 'legacy item should be upgraded to schemaVersion 1 on next write');
  assert.strictEqual(stored[0].id, 'payroll-legacy-1', 'migrated id should carry over from itemId');
  assert.strictEqual(stored[0].status, 'approved', 'migrated item status after approve');

  await browser.close();
  console.log('PASS: all orchestrator migration/envelope assertions passed');
}
main().catch(err => { console.error('FAIL:', err.message); process.exit(1); });
```

- [ ] **Step 2: Serve the repo and run the verification script to confirm it FAILS**

```bash
cd /home/cadger/compliance-swarm/.claude/worktrees/structured-findings && nohup python3 -m http.server 8934 >/tmp/http-server.log 2>&1 & disown
sleep 1
node /tmp/verify-orchestrator.js
```

Expected: FAIL at Scenario A — `orchestrator.js` still listens for `e.data.type !== 'swarm-flag'` and reads `e.data.summary`/`itemId` directly, so a `compliance-swarm:flag-created` envelope is silently ignored and `stored.length` is `0`, not `1`.

- [ ] **Step 3: Implement the migration function and switch message handling**

In `agents/orchestrator.js`, insert `migrateQueueItem` immediately before `loadQueue` (i.e., right after line 87's closing `};` of the `LANES` object, before the current line 89 `function loadQueue() {`):

```js
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
```

Change `loadQueue` (current lines 89-97) to migrate on read:

```js
function loadQueue() {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    const value = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(value)) throw new Error('not an array');
    queueError = false;
    return value.filter(item => item && typeof item === 'object').map(migrateQueueItem);
  } catch (e) { queueError = true; return []; }
}
```

Change `unifiedItems` (current line 156) — `item.decision` → `item.status`:

```js
function unifiedItems() {
  const reviewItems = queue.map(item => ({ kind: 'review', source: item.agentId || '', status: item.status || 'open', job: '', type: '', item }));
  const laneItems = Object.keys(LANES).flatMap(lane => laneDocs[lane].map(doc => {
    const fields = LANES[lane].rowFields(doc.detail, doc.index);
    return { kind: 'lane', lane, source: lane, status: fields.status, job: fields.job, type: fields.type, doc, fields };
  }));
  return [...reviewItems, ...laneItems];
}
```

Change `reviewHtml` (current lines 181-189) — `item.itemId`→`item.id`, `item.summary`→`item.title`, `item.decision`→`item.status`, and the "already decided" condition changes from truthy-check (`item.decision` was `null`/`'approved'`/`'rejected'`) to an explicit non-`'open'` check (`item.status` is never `null`, it's always one of the three strings):

```js
function reviewHtml(items) {
  if (queueError) return '<h2>Review items</h2><p class="model-error">The review queue is malformed and was left unchanged.</p>';
  if (!items.length) return '<h2>Review items</h2><p>No review items match these filters.</p>';
  return `<h2>Review items</h2>${items.map(({ item }) => `<div class="queue-item" data-item-id="${escapeHtml(item.id)}">
    <div class="queue-agent-tag">${escapeHtml(sourceLabel(item.agentId))}</div>
    <p>${escapeHtml(item.title)}</p>
    ${item.status !== 'open' ? `<span class="badge badge-${escapeHtml(item.status)}">${escapeHtml(item.status)}</span>` : `<button data-approve="${escapeHtml(item.id)}">Approve</button> <button data-reject="${escapeHtml(item.id)}">Reject</button>`}
  </div>`).join('')}`;
}
```

Change `decide` and the `message` listener (current lines 236-263):

```js
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
```

Note `bindInboxEvents` (current lines 208-215) already reads `btn.dataset.approve`/`btn.dataset.reject` generically and passes them straight to `decide(itemId, ...)` — it needs no changes, since `reviewHtml` above already emits `item.id` into those `data-approve`/`data-reject` attribute values.

- [ ] **Step 4: Run the verification script to confirm it PASSES**

```bash
node /tmp/verify-orchestrator.js
```

Expected: `PASS: all orchestrator migration/envelope assertions passed`, exit code 0.

- [ ] **Step 5: Stop the server**

```bash
pkill -f "http.server 8934"
```

- [ ] **Step 6: Commit**

```bash
cd /home/cadger/compliance-swarm/.claude/worktrees/structured-findings
git add agents/orchestrator.js
git commit -m "orchestrator.js: migrate queue to Finding shape, handle envelope messages

loadQueue() now migrates any pre-schemaVersion item into the new Finding
shape on read. The message listener now handles the versioned
compliance-swarm:flag-created/decision-made envelope instead of the old
swarm-flag/swarm-decision messages, including in-place provenance
updates on a re-notify with an existing finding id (preserving whatever
status a reviewer already set). reviewHtml()/decide() read item.id/
item.title/item.status instead of item.itemId/item.summary/item.decision.

Payroll/Books/Contract still send the OLD envelope shape until the next
tasks of this plan — this commit is safe on its own because loadQueue's
migration handles any shape currently in localStorage, and the new
message-type check simply ignores senders that haven't been updated yet
(their flags stop reaching the queue until their own task lands, but
nothing throws or corrupts existing data)."
```

---

## Task 3: Payroll integration

**Files:**
- Modify: `agents/payroll-review-demo.js` (full file shown in context above, 172 lines)

**Interfaces:**
- Consumes: `createFinding`, `notifyParentIfEmbedded`, `listenForDecisions` from Task 1; the migrated queue/envelope handling from Task 2.
- Produces: nothing consumed by later tasks (Books/Contract are independent of Payroll).

This is the most involved of the three agent integrations: Payroll's existing behavior notifies once per **row** using only its first flag; per the spec, this becomes once per **flag**, so a single row can now produce multiple findings sharing one Explain button. The row-rendering and the findings-creation must happen in the same pass (not flags-then-separately-created-findings) so each finding's `id` is known when building that row's badge markup.

- [ ] **Step 1: Write the verification script**

Create `/tmp/verify-payroll.js`:

```js
const assert = require('node:assert');
const { chromium } = require('/path/to/playwright-core');
const CHROME_PATH = '/path/to/chrome';
const BASE = 'http://localhost:8934';

async function main() {
  const browser = await chromium.launch({ executablePath: CHROME_PATH, args: ['--no-sandbox'] });

  // --- Standalone: two findings from one row reach the queue via a real iframe embed ---
  const page = await browser.newPage();
  await page.goto(`${BASE}/agents/orchestrator.html`, { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(500); // let the embedded payroll iframe run its own render() + notify

  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('compliance-swarm-queue') || '[]'));
  // Sample data includes Tom Baker: TX, $7.00/hr (below TX $7.25 floor) — a single-flag row — and
  // Aiko Sato: WA, 63 hours, non-exempt — a single-flag row (>=60h). No sample row trips two flags
  // at once, so assert on the flags that DO exist and on the shape, not on a specific multi-flag row.
  const payrollFindings = stored.filter(f => f.agentId === 'payroll');
  assert.ok(payrollFindings.length >= 2, `expected at least 2 payroll findings from sample data, got ${payrollFindings.length}`);
  const wageFinding = payrollFindings.find(f => f.reference.id === 'min_wage_floor');
  assert.ok(wageFinding, 'expected a min_wage_floor finding for Tom Baker');
  assert.strictEqual(wageFinding.severity, 'high', 'wage floor finding severity');
  assert.strictEqual(wageFinding.status, 'open', 'wage floor finding status');
  assert.ok(wageFinding.id.startsWith('finding_'), 'finding id shape');
  assert.strictEqual(wageFinding.provenance.policyVersion, 1, 'policyVersion should be filled from model-policy.json');
  assert.strictEqual(wageFinding.provenance.modelProvider, null, 'modelProvider unset before any Explain click');

  // --- Standalone Payroll page: badge spans use real finding ids, and an Explain click
  //     doesn't throw even when the model call itself fails (no API key / no local Ollama here) ---
  const standalone = await browser.newPage();
  const consoleErrors = [];
  standalone.on('pageerror', err => consoleErrors.push(String(err)));
  await standalone.goto(`${BASE}/agents/payroll-review-demo.html`, { waitUntil: 'networkidle' });
  const badgeForValue = await standalone.locator('[data-badge-for]').first().getAttribute('data-badge-for');
  assert.ok(badgeForValue && badgeForValue.startsWith('finding_'), `expected a data-badge-for span with a real finding id, got: ${badgeForValue}`);
  await standalone.locator('[data-explain]').first().click();
  await standalone.waitForTimeout(2000); // give the (failing, no-credentials) model call time to reject and be handled
  assert.strictEqual(consoleErrors.length, 0, `Explain click should not throw: ${consoleErrors.join('; ')}`);
  const explanationText = await standalone.locator('.explanation').first().textContent();
  assert.ok(explanationText && explanationText.length > 0, 'explanation div should have some content (either a result or an error message) after Explain click');

  await browser.close();
  console.log('PASS: all payroll integration assertions passed');
}
main().catch(err => { console.error('FAIL:', err.message); process.exit(1); });
```

- [ ] **Step 2: Serve the repo and run the verification script to confirm it FAILS**

```bash
cd /home/cadger/compliance-swarm/.claude/worktrees/structured-findings && nohup python3 -m http.server 8934 >/tmp/http-server.log 2>&1 & disown
sleep 1
node /tmp/verify-payroll.js
```

Expected: FAIL — `payroll-review-demo.js` still sends the old envelope shape (Task 1/2 changed the receiving/sending helpers' internals, but Payroll hasn't been updated to use `createFinding` yet), so `stored` is empty and the first assertion on `payrollFindings.length` fails.

- [ ] **Step 3: Implement**

In `agents/payroll-review-demo.js`, change the import (current line 10):

```js
import { escapeHtml, createFinding, notifyParentIfEmbedded, listenForDecisions } from '../shared/agent-common.js';
```

Change `flagRow` (current lines 40-53) to return `{severity, message}` objects instead of strings, and give each check a `refId` for `reference.id`:

```js
function flagRow(row) {
  const flags = [];
  const minWage = MIN_WAGE_TABLE[row.state];
  if (minWage && row.rate < minWage) {
    flags.push({ refId: 'min_wage_floor', severity: 'high', message: `Rate $${row.rate.toFixed(2)}/hr is below the ${row.state} demo minimum wage of $${minWage.toFixed(2)}/hr` });
  }
  if (row.hours >= 60) {
    flags.push({ refId: 'excess_hours', severity: 'medium', message: `${row.hours} hours this week is unusually high — verify against time records` });
  }
  if (row.classification === 'Exempt' && row.hours >= 45) {
    flags.push({ refId: 'exempt_misclassification', severity: 'high', message: `Exempt employee logged ${row.hours} hours with no overtime pay — possible misclassification risk` });
  }
  return flags;
}
```

Replace `render()` in full (current lines 87-156):

```js
let findingsByRow = new Map();

async function render() {
  const modelPolicy = await loadModelPolicy();
  renderSettingsPanel(document.getElementById('settings'), modelPolicy);
  const container = document.getElementById('table-container');

  findingsByRow = new Map();
  currentRows.forEach((row, i) => {
    if (row.parseError) return;
    const findings = flagRow(row).map(flag => {
      const finding = createFinding({
        agentId: AGENT_ID,
        severity: flag.severity,
        title: flag.message,
        evidence: { summary: flag.message, sourceReference: `payroll-${i}`, sourceText: null },
        reference: { id: flag.refId, templateSource: null, templateVersion: null },
        suggestedQuestion: `Confirm ${row.employee}'s ${flag.severity === 'high' ? 'pay rate' : 'hours'} for this pay period.`
      });
      finding.provenance.policyVersion = modelPolicy.version;
      return finding;
    });
    if (findings.length) findingsByRow.set(i, findings);
  });

  const rowsHtml = currentRows.map((row, i) => {
    if (row.parseError) {
      return `
      <tr class="flag-row" data-row="${i}">
        <td colspan="7">&#9888; Could not parse this row — check your CSV headers (expected Employee, Classification, Hourly Rate (or Rate), Hours Worked (or Hours), State). Raw values: ${escapeHtml(row.employee || '')}, ${escapeHtml(row.classification || '')}, ${escapeHtml(row.state || '')}</td>
      </tr>`;
    }
    const pay = computePay(row);
    const findings = findingsByRow.get(i) || [];
    const isFlagged = findings.length > 0;
    return `
      <tr class="${isFlagged ? 'flag-row' : ''}" data-row="${i}">
        <td>${escapeHtml(row.employee)}</td>
        <td>${escapeHtml(row.classification)}</td>
        <td>$${row.rate.toFixed(2)}</td>
        <td>${row.hours}</td>
        <td>${escapeHtml(row.state)}</td>
        <td>$${pay.grossPay.toFixed(2)}${pay.otHours > 0 ? ` <span class="rate-note">(incl. ${pay.otHours}h OT)</span>` : ''}</td>
        <td>
          ${isFlagged ? `<div>${findings.map(f => `&#9888; ${escapeHtml(f.title)}<span data-badge-for="${f.id}"></span>`).join('<br>')}</div><button data-explain="${i}">Explain</button><div class="explanation" data-explanation-for="${i}"></div><span data-model-badge-for="${i}"></span>` : ''}
        </td>
      </tr>`;
  }).join('');
  container.innerHTML = `
    <table>
      <thead><tr><th>Employee</th><th>Classification</th><th>Rate</th><th>Hours</th><th>State</th><th>Gross Pay</th><th>Flags</th></tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>`;

  container.querySelectorAll('[data-explain]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const i = Number(btn.dataset.explain);
      const row = currentRows[i];
      const findings = findingsByRow.get(i) || [];
      const explDiv = container.querySelector(`[data-explanation-for="${i}"]`);
      const badgeSpan = container.querySelector(`[data-model-badge-for="${i}"]`);
      explDiv.classList.remove('model-error');
      explDiv.textContent = 'Thinking...';
      if (badgeSpan) badgeSpan.innerHTML = '';
      const prompt = `You are explaining a payroll compliance flag to a small business owner in plain language, 2-3 sentences. Employee: ${row.employee}, classification: ${row.classification}, rate: $${row.rate}/hr, hours this week: ${row.hours}, state: ${row.state}. Flags raised: ${findings.map(f => f.title).join('; ')}.`;
      let config;
      try {
        config = resolveModelConfig(CONFIG_KEY, modelPolicy, loadSettings());
        const result = await callModel(config, [{ role: 'user', content: prompt }]);
        explDiv.textContent = result.text;
        if (badgeSpan) badgeSpan.innerHTML = renderResultBadge(result);
        findings.forEach(finding => {
          finding.provenance.modelProvider = result.provider;
          finding.provenance.modelName = result.model;
          notifyParentIfEmbedded(finding);
        });
      } catch (err) {
        if (config?.provider === 'ollama' && !err.message.startsWith('POLICY_BLOCKED_PROVIDER')) {
          explDiv.textContent = 'Local payroll explainer is unavailable. Start Ollama, choose Force Cloud, or choose another local endpoint.';
          explDiv.classList.add('model-error');
        } else {
          renderModelError(explDiv, err);
        }
      }
    });
  });

  findingsByRow.forEach(findings => findings.forEach(finding => notifyParentIfEmbedded(finding)));
}
```

(`document.getElementById('loadBtn')...`, `listenForDecisions(...)`, and the final `render().catch(...)` block — current lines 158-171 — are unchanged; `listenForDecisions`'s callback already reads `[data-badge-for="${itemId}"]`, which now correctly matches the `f.id`-based spans above.)

- [ ] **Step 4: Run the verification script to confirm it PASSES**

```bash
node /tmp/verify-payroll.js
```

Expected: `PASS: all payroll integration assertions passed`, exit code 0.

- [ ] **Step 5: Stop the server**

```bash
pkill -f "http.server 8934"
```

- [ ] **Step 6: Commit**

```bash
cd /home/cadger/compliance-swarm/.claude/worktrees/structured-findings
git add agents/payroll-review-demo.js
git commit -m "Payroll: build Finding records per flag instead of one summary per row

flagRow() now returns [{refId, severity, message}] instead of string[].
render() creates one Finding per flag (via createFinding), notifying
the parent once per flag instead of once per row using only flags[0] —
a row that trips two checks is now two independently approvable
findings in the Unified Inbox, not one that silently drops the second
flag's message. Explain's model call, on success, stamps every finding
for that row with provenance.modelProvider/modelName and re-notifies."
```

---

## Task 4: Books integration

**Files:**
- Modify: `agents/books-review-demo.js:10` (import), `:95-160` (`render`)

**Interfaces:**
- Consumes: same as Task 3. Books has exactly one flag type (uncategorized transaction) and already notifies 1:1 per transaction — no multi-finding-per-row complication like Payroll's.

- [ ] **Step 1: Write the verification script**

Create `/tmp/verify-books.js`:

```js
const assert = require('node:assert');
const { chromium } = require('/path/to/playwright-core');
const CHROME_PATH = '/path/to/chrome';
const BASE = 'http://localhost:8934';

async function main() {
  const browser = await chromium.launch({ executablePath: CHROME_PATH, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.goto(`${BASE}/agents/orchestrator.html`, { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(500);

  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('compliance-swarm-queue') || '[]'));
  const booksFindings = stored.filter(f => f.agentId === 'books');
  // Sample transactions: 'Zylo Consulting Group Inc' matches no CATEGORY_KEYWORDS entry — uncategorized.
  assert.ok(booksFindings.length >= 1, `expected at least 1 books finding from sample data, got ${booksFindings.length}`);
  const f = booksFindings[0];
  assert.strictEqual(f.severity, 'medium', 'books finding severity');
  assert.strictEqual(f.status, 'open', 'books finding status');
  assert.ok(f.title.includes('Uncategorized'), `expected title to mention Uncategorized, got: ${f.title}`);
  assert.strictEqual(f.reference.templateVersion, 'service-business-coa.csv', 'reference.templateVersion should carry the loaded CoA filename (default select value)');
  assert.strictEqual(f.provenance.policyVersion, 1, 'policyVersion should be filled from model-policy.json');

  await browser.close();
  console.log('PASS: all books integration assertions passed');
}
main().catch(err => { console.error('FAIL:', err.message); process.exit(1); });
```

- [ ] **Step 2: Serve the repo and run the verification script to confirm it FAILS**

```bash
cd /home/cadger/compliance-swarm/.claude/worktrees/structured-findings && nohup python3 -m http.server 8934 >/tmp/http-server.log 2>&1 & disown
sleep 1
node /tmp/verify-books.js
```

Expected: FAIL — `booksFindings.length` is `0`, Books still sends the old envelope shape.

- [ ] **Step 3: Implement**

Change the import (current line 10):

```js
import { escapeHtml, createFinding, notifyParentIfEmbedded, listenForDecisions } from '../shared/agent-common.js';
```

Change the notify loop at the end of `render()` (current lines 154-158, inside the function that spans lines 95-160):

```js
  currentTxns.forEach((txn, i) => {
    if (categorize(txn)) return;
    const message = `Uncategorized: ${txn.description} ($${txn.amount.toFixed(2)})`;
    const finding = createFinding({
      agentId: AGENT_ID,
      severity: 'medium',
      title: message,
      evidence: { summary: message, sourceReference: `books-${i}`, sourceText: null },
      reference: { id: null, templateSource: coaFilename, templateVersion: coaFilename },
      suggestedQuestion: `What category should "${txn.description}" be posted to?`
    });
    finding.provenance.policyVersion = modelPolicy.version;
    notifyParentIfEmbedded(finding);
  });
  renderFieldDocuments();
}
```

(This replaces only the `currentTxns.forEach(...)` block; the trailing `renderFieldDocuments(); }` that closes `render()` stays exactly where it was.)

- [ ] **Step 4: Run the verification script to confirm it PASSES**

```bash
node /tmp/verify-books.js
```

Expected: `PASS: all books integration assertions passed`, exit code 0.

- [ ] **Step 5: Stop the server**

```bash
pkill -f "http.server 8934"
```

- [ ] **Step 6: Commit**

```bash
cd /home/cadger/compliance-swarm/.claude/worktrees/structured-findings
git add agents/books-review-demo.js
git commit -m "Books: build a Finding record for each uncategorized transaction

Same createFinding()/notifyParentIfEmbedded() pattern as the Payroll
task. reference.templateSource/templateVersion now carry the loaded
chart-of-accounts filename (previously only shown on the AI Suggest
result badge, now also part of the finding's provenance trail)."
```

---

## Task 5: Contract integration

**Files:**
- Modify: `agents/contract-review-demo.js:10` (import), `:44-52` (`MATCH_RULES`), `:92-165` (`scan`)

**Interfaces:**
- Consumes: same as Task 3/4. Contract already notifies 1:1 per matched clause — no multi-finding-per-row complication.

- [ ] **Step 1: Write the verification script**

Create `/tmp/verify-contract.js`:

```js
const assert = require('node:assert');
const { chromium } = require('/path/to/playwright-core');
const CHROME_PATH = '/path/to/chrome';
const BASE = 'http://localhost:8934';

async function main() {
  const browser = await chromium.launch({ executablePath: CHROME_PATH, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.goto(`${BASE}/agents/orchestrator.html`, { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(500);

  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('compliance-swarm-queue') || '[]'));
  const contractFindings = stored.filter(f => f.agentId === 'contract');
  // SAMPLE_CONTRACT trips Indemnification, Termination, IP, Payment terms, Governing law, and
  // (no limitation-of-liability language present) Liability — 6 findings.
  assert.ok(contractFindings.length >= 5, `expected at least 5 contract findings from sample data, got ${contractFindings.length}`);
  const indemnification = contractFindings.find(f => f.reference.id === 'Indemnification');
  assert.ok(indemnification, 'expected an Indemnification finding');
  assert.strictEqual(indemnification.severity, 'high', 'Indemnification severity');
  assert.ok(indemnification.evidence.sourceText && indemnification.evidence.sourceText.length > 0, 'Indemnification finding should carry the quoted paragraph text');
  const liability = contractFindings.find(f => f.reference.id === 'Liability');
  assert.ok(liability, 'expected a Liability (absence) finding');
  assert.strictEqual(liability.evidence.sourceText, null, 'Liability-absence finding has no source excerpt, per spec');
  assert.strictEqual(indemnification.reference.templateVersion, 'red-flag-clause-library.md', 'reference.templateVersion should carry the clause library filename');

  await browser.close();
  console.log('PASS: all contract integration assertions passed');
}
main().catch(err => { console.error('FAIL:', err.message); process.exit(1); });
```

- [ ] **Step 2: Serve the repo and run the verification script to confirm it FAILS**

```bash
cd /home/cadger/compliance-swarm/.claude/worktrees/structured-findings && nohup python3 -m http.server 8934 >/tmp/http-server.log 2>&1 & disown
sleep 1
node /tmp/verify-contract.js
```

Expected: FAIL — `contractFindings.length` is `0`, Contract still sends the old envelope shape.

- [ ] **Step 3: Implement**

Change the import (current line 10):

```js
import { escapeHtml, createFinding, notifyParentIfEmbedded, listenForDecisions } from '../shared/agent-common.js';
```

Add `severity` to every `MATCH_RULES` entry (current lines 44-52):

```js
const MATCH_RULES = [
  { clauseName: 'Indemnification', severity: 'high', test: /indemnif|any and all claims/i },
  { clauseName: 'Termination', severity: 'medium', test: /at any time,?\s*without notice/i },
  { clauseName: 'Intellectual property', severity: 'medium', test: /unused ideas|all work product/i },
  { clauseName: 'Payment terms', severity: 'medium', test: /sole discretion|60 days|90 days/i },
  { clauseName: 'Governing law \\/ venue', severity: 'medium', test: /venue to be determined|headquartered/i },
  { clauseName: 'Non-compete \\/ non-solicit', severity: 'high', test: /the united states|any business that could be considered a competitor/i },
  { clauseName: 'Auto-renewal', severity: 'medium', test: /auto-?renew|automatically renews?|renews? annually/i },
];
```

The whole-document Liability-absence check (current lines 70-77, inside `findFlaggedClauses`) has no matching `MATCH_RULES` entry — give it an inline severity when it's pushed:

```js
  if (!hasLiabilityLanguage) {
    flags.push({
      id: 'contract-liability-absence',
      paragraphIndex: -1,
      text: 'No limitation-of-liability language found anywhere in this contract.',
      clauseName: 'Liability',
      severity: 'high',
    });
  }
```

Change the notify loop at the end of `scan()` (current lines 162-164):

```js
  flags.forEach(flag => {
    const rule = MATCH_RULES.find(r => r.clauseName.replace('\\/', '/') === flag.clauseName);
    const severity = flag.severity || rule?.severity || 'medium';
    const title = `${flag.clauseName}: ${flag.text.slice(0, 60)}...`;
    const finding = createFinding({
      agentId: AGENT_ID,
      severity,
      title,
      evidence: { summary: title, sourceReference: flag.id, sourceText: flag.paragraphIndex === -1 ? null : flag.text },
      reference: { id: flag.clauseName, templateSource: clauseLibraryError ? null : CLAUSE_LIBRARY_FILENAME, templateVersion: clauseLibraryError ? null : CLAUSE_LIBRARY_FILENAME },
      suggestedQuestion: `Review the "${flag.clauseName}" clause with counsel before signing.`
    });
    finding.provenance.policyVersion = modelPolicy.version;
    notifyParentIfEmbedded(finding);
  });
}
```

- [ ] **Step 4: Run the verification script to confirm it PASSES**

```bash
node /tmp/verify-contract.js
```

Expected: `PASS: all contract integration assertions passed`, exit code 0.

- [ ] **Step 5: Stop the server**

```bash
pkill -f "http.server 8934"
```

- [ ] **Step 6: Commit**

```bash
cd /home/cadger/compliance-swarm/.claude/worktrees/structured-findings
git add agents/contract-review-demo.js
git commit -m "Contract: build a Finding record per matched clause, add severity to MATCH_RULES

Each MATCH_RULES entry now carries a first-pass editorial severity
(high for Indemnification/Non-compete/Liability-absence, medium for
the rest — not derived from red-flag-clause-library.md content, worth
a follow-up content pass if these turn out wrong in use, per the design
spec). evidence.sourceText carries the quoted paragraph for real
clause matches and stays null for the synthesized Liability-absence
finding, which has no source excerpt."
```

---

## Task 6: End-to-end regression sweep

**Files:** none modified — verification only.

**Interfaces:** none produced — this is the plan's final gate.

- [ ] **Step 1: Write the regression script**

Create `/tmp/verify-e2e-regression.js` — re-runs this session's pre-existing XSS/CSP/decision-flow checks (unaffected files/behavior must still work) plus the spec's remaining scenarios not yet covered by Tasks 1-5 (explanation text never persisted; approve/reject on a freshly-created, non-migrated finding).

```js
const assert = require('node:assert');
const { chromium } = require('/path/to/playwright-core');
const CHROME_PATH = '/path/to/chrome';
const BASE = 'http://localhost:8934';

async function main() {
  const browser = await chromium.launch({ executablePath: CHROME_PATH, args: ['--no-sandbox'] });

  // --- All 6 pages still load clean (favicon 404 excepted) ---
  for (const p of ['payroll-review-demo', 'books-review-demo', 'contract-review-demo', 'field-capture-demo', 'shelf-snap-demo', 'orchestrator']) {
    const page = await browser.newPage();
    const errors = [];
    page.on('console', msg => { if (msg.type() === 'error' && !msg.text().includes('favicon.ico')) errors.push(msg.text()); });
    page.on('pageerror', err => errors.push('pageerror: ' + err.message));
    await page.goto(`${BASE}/agents/${p}.html`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(300);
    assert.strictEqual(errors.length, 0, `${p}.html had console errors: ${errors.join('; ')}`);
    await page.close();
  }

  // --- XSS regression: payroll CSV, unchanged by this plan's escapeHtml usage ---
  {
    const page = await browser.newPage();
    let alertFired = false;
    page.on('dialog', async d => { alertFired = true; await d.dismiss(); });
    await page.goto(`${BASE}/agents/payroll-review-demo.html`, { waitUntil: 'networkidle' });
    await page.fill('#csvInput', 'Employee,Classification,Rate,Hours,State\n<img src=x onerror=alert(1)>,Non-exempt,20,45,CA\n');
    await page.click('#loadBtn');
    await page.waitForTimeout(300);
    const hasRawTag = await page.evaluate(() => document.querySelector('td').innerHTML.includes('<img'));
    assert.strictEqual(alertFired, false, 'payroll XSS payload must not fire an alert');
    assert.strictEqual(hasRawTag, false, 'payroll XSS payload must not appear as a raw tag in the DOM');
    await page.close();
  }

  // --- Full decision-flow round trip with the NEW envelope, end to end through real iframes ---
  {
    const page = await browser.newPage();
    await page.goto(`${BASE}/agents/orchestrator.html`, { waitUntil: 'networkidle' });
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    const approveBtn = page.locator('#queue [data-approve]').first();
    assert.ok(await approveBtn.count() > 0, 'expected at least one open finding to approve');
    await approveBtn.click();
    await page.waitForTimeout(500);
    const badgeCount = await page.frameLocator('iframe[data-agent="payroll"]').locator('.badge-approved').count();
    assert.ok(badgeCount > 0, 'approving a payroll finding should show an approved badge inside the payroll iframe');
    await page.close();
  }

  // --- Explanation text is never persisted to localStorage, even after a real Explain click ---
  {
    const page = await browser.newPage();
    await page.goto(`${BASE}/agents/payroll-review-demo.html`, { waitUntil: 'networkidle' });
    await page.locator('[data-explain]').first().click();
    await page.waitForTimeout(2000);
    const explanationText = await page.locator('.explanation').first().textContent();
    const queueRaw = await page.evaluate(() => localStorage.getItem('compliance-swarm-queue') || '');
    if (explanationText && explanationText.trim() && explanationText.trim() !== 'Thinking...') {
      assert.ok(!queueRaw.includes(explanationText.trim()), 'explanation text must never appear in the persisted queue');
    }
    await page.close();
  }

  await browser.close();
  console.log('PASS: full end-to-end regression sweep passed');
}
main().catch(err => { console.error('FAIL:', err.message); process.exit(1); });
```

- [ ] **Step 2: Serve the repo and run it**

```bash
cd /home/cadger/compliance-swarm/.claude/worktrees/structured-findings && nohup python3 -m http.server 8934 >/tmp/http-server.log 2>&1 & disown
sleep 1
node /tmp/verify-e2e-regression.js
```

Expected: `PASS: full end-to-end regression sweep passed`, exit code 0. If anything fails here, it means one of Tasks 1-5 broke something outside its own stated scope — go back and fix the offending task before proceeding; do not patch around it from Task 6.

- [ ] **Step 3: Stop the server and clean up scratch scripts**

```bash
pkill -f "http.server 8934"
rm /tmp/verify-agent-common.js /tmp/verify-orchestrator.js /tmp/verify-payroll.js /tmp/verify-books.js /tmp/verify-contract.js /tmp/verify-e2e-regression.js
```

- [ ] **Step 4: Update the handoff doc**

Append a new entry to `handoff-compliance-swarm.md`'s commit table and a short section describing this plan's outcome, following the doc's existing structure (see its `## What shipped` / `## Verification` sections for the established format). No separate commit step specified here — fold it into whichever convention the doc has been using this session (one commit per doc update, per its own git history).

---

## Self-review notes (for whoever executes this plan)

- **Spec coverage:** Finding shape (Task 1/3/4/5), envelope (Task 1/2), provenance incl. re-notify-on-explain (Task 1/3/4/5), migration (Task 2), `reviewHtml`/`decide` field renames (Task 2), the explicit Payroll notify-per-flag behavior change (Task 3), "no template registry" (Tasks 4/5 keep filename-based `reference.templateVersion`), "explanation text never persisted" (Task 6 asserts this directly) — all covered.
- **Not covered by this plan, per spec's "Out of scope":** FieldSnap/ShelfSnap, a template registry, persisting explanation text, a finding-history/audit view, any `config/model-policy.json` change, custom-mode Settings UI — none of these have tasks here, matching the spec.
