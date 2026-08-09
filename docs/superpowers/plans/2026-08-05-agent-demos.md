# Approval-First Business AI — Agent Demos Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the three standalone agent demos (payroll, books, contract) plus an orchestrator that iframes them with a shared approval queue, per `docs/superpowers/specs/2026-08-05-agent-demos-design.md`.

**Architecture:** Four self-contained HTML files under `agents/`, no build step, no external CDN dependencies. Each agent works standalone; the orchestrator iframes all three and adds a `postMessage`-based shared approval queue on top without touching their internal logic.

**Tech Stack:** Vanilla HTML/CSS/JS. Served locally via `python3 -m http.server` (required so `fetch()` of sibling template files works — `file://` blocks it).

## Global Constraints

- No test framework exists. Verification = load in a real browser via the local server and click through golden path + edge cases (per spec's Testing section). Every task ends with a manual browser-verification step, not a unit test.
- Cloud/Local model settings persist to `localStorage` only, key `compliance-swarm-settings`. Never transmitted anywhere but the model call itself.
- No API key/endpoint configured → the triggering button shows an inline message, never fires a request.
- Failed model calls render the raw error inline next to the row that triggered them.
- Payroll math is 100% deterministic JS — the model is never involved in computing gross pay, overtime, or flag thresholds, only in explaining an already-flagged row.
- The contract agent's clause patterns come from `fetch()`ing `templates/contract_clause_library/red-flag-clause-library.md` at runtime and parsing it — never hardcoded in JS.

---

## Shared Building Block: Settings Panel & Model Call

Every agent task below embeds this exact block inside its `<script>` tag, verbatim, then adds file-specific code after it. Defined once here to avoid repeating it three times in this plan.

```js
// --- Shared: model settings & call (localStorage-backed) ---
const SETTINGS_KEY = 'compliance-swarm-settings';

function loadSettings() {
  const defaults = { mode: 'cloud', apiKey: '', localEndpoint: 'http://localhost:11434/api/chat', localModel: 'llama3' };
  try {
    return Object.assign(defaults, JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {});
  } catch (e) {
    return defaults;
  }
}

function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function renderSettingsPanel(container) {
  const s = loadSettings();
  container.innerHTML = `
    <fieldset class="settings-panel">
      <legend>Model Settings</legend>
      <label><input type="radio" name="mode" value="cloud" ${s.mode === 'cloud' ? 'checked' : ''}> Cloud (Anthropic)</label>
      <label><input type="radio" name="mode" value="local" ${s.mode === 'local' ? 'checked' : ''}> Local (Ollama)</label>
      <div class="cloud-fields" style="${s.mode === 'cloud' ? '' : 'display:none'}">
        <label>API Key <input type="password" id="apiKeyInput" value="${s.apiKey}" placeholder="sk-ant-..."></label>
      </div>
      <div class="local-fields" style="${s.mode === 'local' ? '' : 'display:none'}">
        <label>Endpoint <input type="text" id="endpointInput" value="${s.localEndpoint}"></label>
        <label>Model <input type="text" id="localModelInput" value="${s.localModel}"></label>
      </div>
      <p class="settings-note">Stored only in this browser's localStorage.</p>
    </fieldset>
  `;
  container.querySelectorAll('input[name="mode"]').forEach(r => r.addEventListener('change', e => {
    const settings = loadSettings();
    settings.mode = e.target.value;
    saveSettings(settings);
    renderSettingsPanel(container);
  }));
  const apiKeyInput = container.querySelector('#apiKeyInput');
  if (apiKeyInput) apiKeyInput.addEventListener('change', e => { const st = loadSettings(); st.apiKey = e.target.value; saveSettings(st); });
  const endpointInput = container.querySelector('#endpointInput');
  if (endpointInput) endpointInput.addEventListener('change', e => { const st = loadSettings(); st.localEndpoint = e.target.value; saveSettings(st); });
  const localModelInput = container.querySelector('#localModelInput');
  if (localModelInput) localModelInput.addEventListener('change', e => { const st = loadSettings(); st.localModel = e.target.value; saveSettings(st); });
}

async function callModel(prompt) {
  const settings = loadSettings();
  if (settings.mode === 'cloud') {
    if (!settings.apiKey) throw new Error('NO_KEY');
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': settings.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    if (!res.ok) throw new Error(`Cloud call failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    return data.content.map(c => c.text || '').join('');
  } else {
    if (!settings.localEndpoint) throw new Error('NO_ENDPOINT');
    const res = await fetch(settings.localEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: settings.localModel || 'llama3',
        messages: [{ role: 'user', content: prompt }],
        stream: false
      })
    });
    if (!res.ok) throw new Error(`Local call failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    return data.message ? data.message.content : JSON.stringify(data);
  }
}

function renderModelError(container, err) {
  if (err.message === 'NO_KEY') {
    container.textContent = 'Add an API key in Settings to use Explain.';
  } else if (err.message === 'NO_ENDPOINT') {
    container.textContent = 'Set a Local endpoint in Settings to use Explain.';
  } else {
    container.textContent = 'Model call failed: ' + err.message;
  }
  container.classList.add('model-error');
}

// --- Shared: notify orchestrator when embedded ---
function notifyParentIfEmbedded(agentId, item) {
  if (window.self === window.top) return;
  window.parent.postMessage({ type: 'swarm-flag', agentId, itemId: item.id, summary: item.summary }, '*');
}

function listenForDecisions(onDecision) {
  window.addEventListener('message', e => {
    if (e.data && e.data.type === 'swarm-decision') {
      onDecision(e.data.itemId, e.data.decision);
    }
  });
}
```

## Shared Building Block: Base CSS

Every agent task embeds this exact `<style>` block, then adds file-specific rules after it.

```css
:root { color-scheme: light dark; }
body { font-family: system-ui, sans-serif; margin: 0; padding: 2rem; max-width: 960px; margin-inline: auto; line-height: 1.5; }
h1 { font-size: 1.4rem; }
table { width: 100%; border-collapse: collapse; margin-block: 1rem; }
th, td { text-align: left; padding: 0.5rem; border-bottom: 1px solid #8884; }
.flag-row { background: rgba(245, 163, 35, 0.1); }
.flag-row td:first-child { border-left: 3px solid #f5a323; }
button { cursor: pointer; padding: 0.35rem 0.75rem; border-radius: 4px; border: 1px solid #8886; background: transparent; font: inherit; }
button:hover { background: rgba(136, 136, 136, 0.15); }
.settings-panel { border: 1px solid #8886; border-radius: 6px; padding: 0.75rem 1rem; margin-block-end: 1rem; }
.settings-panel label { display: block; margin-block: 0.35rem; }
.settings-note { font-size: 0.8rem; opacity: 0.7; margin: 0.35rem 0 0; }
.model-error { color: #c0392b; font-size: 0.85rem; }
.disclaimer { font-size: 0.8rem; opacity: 0.75; border-left: 3px solid #8886; padding-inline-start: 0.75rem; margin-block: 1rem; }
textarea { width: 100%; min-height: 6rem; font-family: inherit; box-sizing: border-box; }
.explanation { font-size: 0.85rem; margin-block-start: 0.5rem; padding: 0.5rem; background: rgba(136, 136, 136, 0.08); border-radius: 4px; }
.badge { display: inline-block; font-size: 0.75rem; padding: 0.1rem 0.5rem; border-radius: 999px; margin-inline-start: 0.5rem; }
.badge-approved { background: #2ecc7133; color: #1e8449; }
.badge-rejected { background: #e74c3c33; color: #c0392b; }
```

---

## Task 1: Payroll Agent

**Files:**
- Create: `agents/payroll-review-demo.html`

**Interfaces:**
- Consumes: nothing from other tasks (first task, fully standalone file).
- Produces: `AGENT_ID = 'payroll'`; item shape `{ id, summary }` posted via `notifyParentIfEmbedded('payroll', item)` — Task 4 (orchestrator) relies on this exact `type: 'swarm-flag'` message shape and on `listenForDecisions` being wired up to re-render a badge.

- [ ] **Step 1: Create the file with shared boilerplate and page shell**

Create `agents/payroll-review-demo.html` with:
- `<!DOCTYPE html>`, `<title>Payroll Review Agent</title>`
- The exact shared `<style>` block from "Shared Building Block: Base CSS" above, plus:
  ```css
  .rate-note { font-size: 0.75rem; opacity: 0.7; }
  ```
- Body containing: `<h1>Payroll Review Agent</h1>`, a `.disclaimer` div reading "Demo minimum-wage figures below are illustrative only — verify against your state labor department's current posted rate before relying on this output. Not legal or tax advice.", a `<div id="settings"></div>`, a `<div id="upload">` with a `<textarea id="csvInput">` and a `<button id="loadBtn">Load CSV</button>`, and a `<div id="table-container"></div>`.
- `<script>` containing the exact shared JS block from "Shared Building Block: Settings Panel & Model Call" above, followed by `const AGENT_ID = 'payroll';`.

**Step 1 check:** Open the file directly in a browser (no server needed yet). Confirm the disclaimer, settings panel (with working Cloud/Local radio toggle), and empty page shell render with no console errors.

- [ ] **Step 2: Add sample data and deterministic payroll logic**

Append to the `<script>`:

```js
const MIN_WAGE_TABLE = { CA: 16.00, NY: 15.00, TX: 7.25, HI: 14.00, WA: 16.28 };

const SAMPLE_TIMESHEET = [
  { employee: 'Maria Ortiz', classification: 'Non-exempt', rate: 18.00, hours: 46, state: 'CA' },
  { employee: 'James Lee', classification: 'Non-exempt', rate: 15.00, hours: 40, state: 'TX' },
  { employee: 'Priya Nair', classification: 'Exempt', rate: 32.00, hours: 52, state: 'NY' },
  { employee: 'Tom Baker', classification: 'Non-exempt', rate: 7.00, hours: 30, state: 'TX' },
  { employee: 'Aiko Sato', classification: 'Non-exempt', rate: 20.00, hours: 63, state: 'WA' },
];

function computePay(row) {
  const regularHours = Math.min(row.hours, 40);
  const otHours = Math.max(row.hours - 40, 0);
  const regularPay = regularHours * row.rate;
  const otPay = otHours * row.rate * 1.5;
  return { regularPay, otPay, grossPay: regularPay + otPay, otHours };
}

function flagRow(row) {
  const flags = [];
  const minWage = MIN_WAGE_TABLE[row.state];
  if (minWage && row.rate < minWage) {
    flags.push(`Rate $${row.rate.toFixed(2)}/hr is below the ${row.state} demo minimum wage of $${minWage.toFixed(2)}/hr`);
  }
  if (row.hours >= 60) {
    flags.push(`${row.hours} hours this week is unusually high — verify against time records`);
  }
  if (row.classification === 'Exempt' && row.hours >= 45) {
    flags.push(`Exempt employee logged ${row.hours} hours with no overtime pay — possible misclassification risk`);
  }
  return flags;
}

function parseCSV(text) {
  const lines = text.trim().split('\n').filter(Boolean);
  const [header, ...rows] = lines;
  const cols = header.split(',').map(c => c.trim().toLowerCase());
  return rows.map(line => {
    const values = line.split(',').map(v => v.trim());
    const obj = {};
    cols.forEach((col, i) => { obj[col] = values[i]; });
    return {
      employee: obj.employee,
      classification: obj.classification,
      rate: parseFloat(obj.rate),
      hours: parseFloat(obj.hours),
      state: obj.state,
    };
  });
}
```

**Step 2 check:** No UI yet — this is pure logic. Skip browser check for this step, proceed to Step 3 where it becomes visible.

- [ ] **Step 3: Render the worksheet table and wire up Explain buttons**

Append to the `<script>`:

```js
let currentRows = SAMPLE_TIMESHEET;

function render() {
  renderSettingsPanel(document.getElementById('settings'));
  const container = document.getElementById('table-container');
  const rowsHtml = currentRows.map((row, i) => {
    const pay = computePay(row);
    const flags = flagRow(row);
    const isFlagged = flags.length > 0;
    const itemId = `payroll-${i}`;
    return `
      <tr class="${isFlagged ? 'flag-row' : ''}" data-row="${i}">
        <td>${row.employee}</td>
        <td>${row.classification}</td>
        <td>$${row.rate.toFixed(2)}</td>
        <td>${row.hours}</td>
        <td>${row.state}</td>
        <td>$${pay.grossPay.toFixed(2)}${pay.otHours > 0 ? ` <span class="rate-note">(incl. ${pay.otHours}h OT)</span>` : ''}</td>
        <td>
          ${isFlagged ? `<div>${flags.map(f => `&#9888; ${f}`).join('<br>')}</div><button data-explain="${i}">Explain</button><div class="explanation" data-explanation-for="${i}"></div><span data-badge-for="${itemId}"></span>` : ''}
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
      const flags = flagRow(row);
      const explDiv = container.querySelector(`[data-explanation-for="${i}"]`);
      explDiv.textContent = 'Thinking...';
      const prompt = `You are explaining a payroll compliance flag to a small business owner in plain language, 2-3 sentences. Employee: ${row.employee}, classification: ${row.classification}, rate: $${row.rate}/hr, hours this week: ${row.hours}, state: ${row.state}. Flags raised: ${flags.join('; ')}.`;
      try {
        const text = await callModel(prompt);
        explDiv.textContent = text;
      } catch (err) {
        renderModelError(explDiv, err);
      }
    });
  });

  currentRows.forEach((row, i) => {
    const flags = flagRow(row);
    if (flags.length > 0) {
      notifyParentIfEmbedded(AGENT_ID, { id: `payroll-${i}`, summary: `${row.employee}: ${flags[0]}` });
    }
  });
}

document.getElementById('loadBtn').addEventListener('click', () => {
  const text = document.getElementById('csvInput').value.trim();
  if (text) currentRows = parseCSV(text);
  render();
});

listenForDecisions((itemId, decision) => {
  const el = document.querySelector(`[data-badge-for="${itemId}"]`);
  if (el) el.innerHTML = `<span class="badge badge-${decision}">${decision}</span>`;
});

render();
```

**Step 3 check:** Run `python3 -m http.server 8000` from `compliance-swarm/`, open `http://localhost:8000/agents/payroll-review-demo.html`. Confirm:
- Table shows all 5 sample rows with correct gross pay (spot-check Maria Ortiz: 40×18 + 6×18×1.5 = 720 + 162 = $882.00).
- Rows for Maria (60h... actually 46h, no flag expected beyond none), Tom Baker (below TX min wage $7.25), Priya Nair (exempt + 52h), Aiko Sato (63h) show highlighted flag rows with correct flag text.
- James Lee (exactly 40h, at TX min wage) shows no flags, no highlight.
- Clicking "Explain" with no API key configured shows "Add an API key in Settings to use Explain." inline, without a network request (check browser Network tab shows nothing fired).

- [ ] **Step 4: Commit**

```bash
cd compliance-swarm
git add agents/payroll-review-demo.html
git commit -m "Add payroll review agent demo"
```

---

## Task 2: Books Agent

**Files:**
- Create: `agents/books-review-demo.html`

**Interfaces:**
- Consumes: `templates/chart_of_accounts/service-business-coa.csv` and `templates/chart_of_accounts/retail-business-coa.csv` via `fetch()` (relative path `../templates/chart_of_accounts/<file>`, since this HTML lives in `agents/`).
- Produces: `AGENT_ID = 'books'`; posts `swarm-flag` messages the same way Task 1 does (Task 4 depends on this).

- [ ] **Step 1: Create the file with shared boilerplate, page shell, and CoA loader**

Create `agents/books-review-demo.html` with the shared `<style>` block, plus:
```css
select { padding: 0.3rem; margin-inline-end: 1rem; }
```
Body: `<h1>Books Review Agent</h1>`, a `.disclaimer` div reading "Categorization suggestions are a starting point, not a bookkeeping or tax determination. Review before posting to your ledger.", `<div id="settings"></div>`, a controls row with `<select id="coaSelect"><option value="service-business-coa.csv">Service Business</option><option value="retail-business-coa.csv">Retail Business</option></select>`, a `<textarea id="txnInput">` + `<button id="loadBtn">Load Transactions</button>`, and `<div id="table-container"></div>`.

`<script>`: the exact shared JS block, then `const AGENT_ID = 'books';`, then:
```js
async function loadCoA(filename) {
  const res = await fetch(`../templates/chart_of_accounts/${filename}`);
  const text = await res.text();
  const [header, ...rows] = text.trim().split('\n');
  return rows.map(line => {
    const cols = line.split(',');
    return { name: cols[1], category: cols[3] };
  }).filter(c => c.category && c.category !== 'Uncategorized');
}
```

**Step 1 check:** Open via `http://localhost:8000/agents/books-review-demo.html` (must use the server, not `file://`, for `fetch` to work). Confirm settings panel and controls render, no console errors yet (categories aren't wired to anything visible until Step 2).

- [ ] **Step 2: Add sample transactions and categorization heuristic**

Append to `<script>`:

```js
const SAMPLE_TRANSACTIONS = [
  { date: '2026-07-01', description: 'STRIPE PAYOUT', amount: 1420.00 },
  { date: '2026-07-02', description: 'AWS billing', amount: -84.12 },
  { date: '2026-07-03', description: 'Google Workspace', amount: -18.00 },
  { date: '2026-07-05', description: 'Shell Gas Station #442', amount: -52.30 },
  { date: '2026-07-08', description: 'Cheesecake Factory - client lunch', amount: -63.40 },
  { date: '2026-07-10', description: 'Zylo Consulting Group Inc', amount: -450.00 },
];

const CATEGORY_KEYWORDS = [
  { keywords: ['stripe', 'square', 'paypal fee'], category: 'Bank & Merchant Fees' },
  { keywords: ['aws', 'google workspace', 'notion', 'figma', 'quickbooks'], category: 'Software & Subscriptions' },
  { keywords: ['shell', 'chevron', 'exxon', 'gas station'], category: 'Fuel & Auto' },
  { keywords: ['restaurant', 'cafe', 'lunch', 'cheesecake factory', 'starbucks'], category: 'Meals & Entertainment' },
  { keywords: ['facebook ads', 'google ads', 'instagram promo'], category: 'Advertising' },
];

function categorize(txn) {
  const desc = txn.description.toLowerCase();
  for (const entry of CATEGORY_KEYWORDS) {
    if (entry.keywords.some(k => desc.includes(k))) {
      return entry.category;
    }
  }
  return null;
}

function parseTxnCSV(text) {
  const lines = text.trim().split('\n').filter(Boolean);
  const [header, ...rows] = lines;
  return rows.map(line => {
    const [date, description, amount] = line.split(',').map(v => v.trim());
    return { date, description, amount: parseFloat(amount) };
  });
}
```

**Step 2 check:** Pure logic, no UI change yet. Continue to Step 3.

- [ ] **Step 3: Render transaction table with AI-suggest for uncategorized rows**

Append to `<script>`:

```js
let currentTxns = SAMPLE_TRANSACTIONS;
let currentCoA = [];

async function render() {
  renderSettingsPanel(document.getElementById('settings'));
  currentCoA = await loadCoA(document.getElementById('coaSelect').value);
  const container = document.getElementById('table-container');
  const categoryNames = currentCoA.map(c => c.category);

  const rowsHtml = currentTxns.map((txn, i) => {
    const category = categorize(txn);
    const isUncategorized = !category;
    const itemId = `books-${i}`;
    return `
      <tr class="${isUncategorized ? 'flag-row' : ''}" data-row="${i}">
        <td>${txn.date}</td>
        <td>${txn.description}</td>
        <td>$${txn.amount.toFixed(2)}</td>
        <td>
          ${category ? category : `Uncategorized <button data-suggest="${i}">AI Suggest</button><span data-badge-for="${itemId}"></span>`}
          <div class="explanation" data-explanation-for="${i}"></div>
        </td>
      </tr>`;
  }).join('');

  container.innerHTML = `
    <table>
      <thead><tr><th>Date</th><th>Description</th><th>Amount</th><th>Category</th></tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>`;

  container.querySelectorAll('[data-suggest]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const i = Number(btn.dataset.suggest);
      const txn = currentTxns[i];
      const explDiv = container.querySelector(`[data-explanation-for="${i}"]`);
      explDiv.textContent = 'Thinking...';
      const prompt = `Suggest the best-matching category for this business transaction from the list, and explain briefly why. Transaction: "${txn.description}", amount $${txn.amount}. Available categories: ${categoryNames.join(', ')}.`;
      try {
        const text = await callModel(prompt);
        explDiv.textContent = text;
      } catch (err) {
        renderModelError(explDiv, err);
      }
    });
  });

  currentTxns.forEach((txn, i) => {
    if (!categorize(txn)) {
      notifyParentIfEmbedded(AGENT_ID, { id: `books-${i}`, summary: `Uncategorized: ${txn.description} ($${txn.amount.toFixed(2)})` });
    }
  });
}

document.getElementById('coaSelect').addEventListener('change', render);
document.getElementById('loadBtn').addEventListener('click', () => {
  const text = document.getElementById('txnInput').value.trim();
  if (text) currentTxns = parseTxnCSV(text);
  render();
});

listenForDecisions((itemId, decision) => {
  const el = document.querySelector(`[data-badge-for="${itemId}"]`);
  if (el) el.innerHTML = `<span class="badge badge-${decision}">${decision}</span>`;
});

render();
```

**Step 3 check:** Reload `http://localhost:8000/agents/books-review-demo.html`. Confirm:
- 5 of 6 sample transactions auto-categorize correctly (Stripe → Bank & Merchant Fees, AWS/Google Workspace → Software & Subscriptions, Shell → Fuel & Auto, Cheesecake Factory → Meals & Entertainment).
- "Zylo Consulting Group Inc" (no keyword match) shows as Uncategorized with an "AI Suggest" button, row highlighted.
- Switching the CoA dropdown from Service to Retail re-renders without error (categorization logic is CoA-independent by design, only the AI-suggest prompt's category list changes).
- Clicking "AI Suggest" with no key configured shows the inline "add a key" message.

- [ ] **Step 4: Commit**

```bash
git add agents/books-review-demo.html
git commit -m "Add books review agent demo"
```

---

## Task 3: Contract Agent

**Files:**
- Create: `agents/contract-review-demo.html`

**Interfaces:**
- Consumes: `templates/contract_clause_library/red-flag-clause-library.md` via `fetch('../templates/contract_clause_library/red-flag-clause-library.md')`.
- Produces: `AGENT_ID = 'contract'`; posts `swarm-flag` messages the same way Tasks 1-2 do (Task 4 depends on this).

- [ ] **Step 1: Create the file with shared boilerplate, page shell, and clause library parser**

Create `agents/contract-review-demo.html` with the shared `<style>` block, plus:
```css
mark { background: rgba(245, 163, 35, 0.35); padding: 0 0.1rem; }
```
Body: `<h1>Contract Review Agent</h1>`, a `.disclaimer` div reading "Pattern matches below are a first pass, not legal advice. Have a lawyer review anything before you sign it.", `<div id="settings"></div>`, `<textarea id="contractInput"></textarea>` + `<button id="scanBtn">Scan Contract</button>`, and `<div id="results"></div>`.

`<script>`: the exact shared JS block, then `const AGENT_ID = 'contract';`, then:

```js
async function loadClauseLibrary() {
  const res = await fetch('../templates/contract_clause_library/red-flag-clause-library.md');
  const text = await res.text();
  const sections = text.split(/\n## /).slice(1); // drop title + intro before first ##
  return sections.map(section => {
    const lines = section.trim().split('\n');
    const name = lines[0].trim();
    const body = lines.slice(1).join('\n');
    const pattern = (body.match(/Pattern:\s*([\s\S]*?)\nWhy it matters:/) || [])[1] || '';
    const why = (body.match(/Why it matters:\s*([\s\S]*?)\nFallback ask:/) || [])[1] || '';
    const fallback = (body.match(/Fallback ask:\s*([\s\S]*?)(\n\n|$)/) || [])[1] || '';
    return { name, pattern: pattern.trim(), why: why.trim(), fallback: fallback.trim() };
  }).filter(e => e.name !== 'Add new entries here whenever the contract agent flags a pattern not yet covered above —\nthis file is what actually improves over time, more than the code around it.'.split('\n')[0]);
}
```

**Step 1 check:** Open `http://localhost:8000/agents/contract-review-demo.html`. Add a temporary `console.log(await loadClauseLibrary())` at the end of the script, reload, and confirm the console shows 8 parsed entries (Indemnification, Liability, Intellectual property, Termination, Non-compete / non-solicit, Payment terms, Governing law / venue, Auto-renewal) each with non-empty `pattern`, `why`, and `fallback`. Remove the temporary `console.log` line before Step 2.

- [ ] **Step 2: Add sample contract text and keyword matching rules**

Append to `<script>`:

```js
const SAMPLE_CONTRACT = `SERVICES AGREEMENT

1. INDEMNIFICATION. Contractor shall indemnify and hold harmless Client from any and all claims, damages, and expenses arising from this Agreement, without limitation.

2. TERM AND TERMINATION. Client may terminate this Agreement at any time, without notice. Contractor must provide 45 days written notice to terminate.

3. INTELLECTUAL PROPERTY. All work product, including drafts, concepts, and unused ideas, shall be assigned to Client.

4. PAYMENT. Client shall pay invoices within 60 days. Client may withhold payment at Client's sole discretion pending satisfaction review.

5. GOVERNING LAW. This Agreement is governed by the laws of the state where Client is headquartered, with venue to be determined solely by Client.`;

const MATCH_RULES = [
  { clauseName: 'Indemnification', test: /indemnif|any and all claims/i },
  { clauseName: 'Termination', test: /at any time,?\s*without notice/i },
  { clauseName: 'Intellectual property', test: /unused ideas|all work product/i },
  { clauseName: 'Payment terms', test: /sole discretion|60 days|90 days/i },
  { clauseName: 'Governing law \\/ venue', test: /venue to be determined|headquartered/i },
];

function findFlaggedClauses(contractText) {
  const paragraphs = contractText.split(/\n\n+/);
  const flags = [];
  paragraphs.forEach((para, i) => {
    MATCH_RULES.forEach(rule => {
      if (rule.test.test(para)) {
        flags.push({ id: `contract-${i}-${rule.clauseName}`, paragraphIndex: i, text: para.trim(), clauseName: rule.clauseName.replace('\\/', '/') });
      }
    });
  });
  return flags;
}
```

**Step 2 check:** Pure logic, no UI change yet. Continue to Step 3.

- [ ] **Step 3: Render flagged clauses with Explain + suggest redline**

Append to `<script>`:

```js
let clauseLibrary = [];

function highlightMatch(text, rule) {
  return text.replace(rule.test, m => `<mark>${m}</mark>`);
}

async function scan() {
  clauseLibrary = await loadClauseLibrary();
  const text = document.getElementById('contractInput').value || SAMPLE_CONTRACT;
  const flags = findFlaggedClauses(text);
  const container = document.getElementById('results');

  if (flags.length === 0) {
    container.innerHTML = '<p>No known red-flag patterns matched. Not a guarantee the contract is safe — just that nothing in the library matched.</p>';
    return;
  }

  container.innerHTML = flags.map((flag, i) => {
    const rule = MATCH_RULES.find(r => r.clauseName.replace('\\/', '/') === flag.clauseName);
    const highlighted = highlightMatch(flag.text, rule);
    return `
      <div class="flag-row" style="padding: 0.75rem; margin-block: 0.5rem; border-radius: 4px;">
        <strong>${flag.clauseName}</strong>
        <p>${highlighted}</p>
        <button data-explain="${i}">Explain + suggest redline</button>
        <span data-badge-for="${flag.id}"></span>
        <div class="explanation" data-explanation-for="${i}"></div>
      </div>`;
  }).join('');

  container.querySelectorAll('[data-explain]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const i = Number(btn.dataset.explain);
      const flag = flags[i];
      const entry = clauseLibrary.find(e => e.name === flag.clauseName) || {};
      const explDiv = container.querySelector(`[data-explanation-for="${i}"]`);
      explDiv.textContent = 'Thinking...';
      const prompt = `Explain this contract clause's risk in plain language (2-3 sentences) and suggest a specific redline, for a small business owner. Clause text: "${flag.text}". Known pattern: ${entry.pattern}. Why it matters: ${entry.why}. Suggested fallback ask: ${entry.fallback}.`;
      try {
        const explanation = await callModel(prompt);
        explDiv.textContent = explanation;
      } catch (err) {
        renderModelError(explDiv, err);
      }
    });
  });

  flags.forEach(flag => {
    notifyParentIfEmbedded(AGENT_ID, { id: flag.id, summary: `${flag.clauseName}: ${flag.text.slice(0, 60)}...` });
  });
}

document.getElementById('scanBtn').addEventListener('click', scan);
document.getElementById('contractInput').value = SAMPLE_CONTRACT;
renderSettingsPanel(document.getElementById('settings'));
scan();

listenForDecisions((itemId, decision) => {
  const el = document.querySelector(`[data-badge-for="${itemId}"]`);
  if (el) el.innerHTML = `<span class="badge badge-${decision}">${decision}</span>`;
});
```

**Step 3 check:** Reload `http://localhost:8000/agents/contract-review-demo.html`. Confirm all 5 clauses in the sample contract are flagged with the correct clause name and the triggering phrase highlighted (indemnification, termination asymmetry, IP assignment, payment discretion, governing law). Clear the textarea and type a clean paragraph with none of the trigger phrases, click "Scan Contract", confirm the "No known red-flag patterns matched" message appears. Click "Explain + suggest redline" with no key configured, confirm the inline "add a key" message.

- [ ] **Step 4: Commit**

```bash
git add agents/contract-review-demo.html
git commit -m "Add contract review agent demo"
```

---

## Task 4: Orchestrator

**Files:**
- Create: `agents/orchestrator.html`

**Interfaces:**
- Consumes: `swarm-flag` messages `{ type: 'swarm-flag', agentId, itemId, summary }` posted by Tasks 1-3's `notifyParentIfEmbedded`, sent automatically once those pages are loaded inside an iframe (they detect `window.self !== window.top`).
- Produces: `swarm-decision` messages `{ type: 'swarm-decision', itemId, decision }` sent to the originating iframe; Tasks 1-3's `listenForDecisions` callback consumes these to render a badge.

- [ ] **Step 1: Create the page shell with tabbed iframes and an approval queue panel**

Create `agents/orchestrator.html`:

```html
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Compliance Swarm Orchestrator</title>
<style>
:root { color-scheme: light dark; }
body { font-family: system-ui, sans-serif; margin: 0; padding: 2rem; line-height: 1.5; }
h1 { font-size: 1.4rem; }
h2 { font-size: 1.1rem; }
.tabs { margin-block-end: 1rem; }
.tabs button { padding: 0.5rem 1rem; border: 1px solid #8886; background: transparent; cursor: pointer; font: inherit; border-radius: 4px; margin-inline-end: 0.5rem; }
.tabs button.active { background: rgba(136, 136, 136, 0.2); font-weight: 600; }
.workspace { display: flex; gap: 1.5rem; }
.agent-panes { flex: 2; min-width: 0; }
.agent-frame { display: none; width: 100%; height: 720px; border: 1px solid #8886; border-radius: 6px; }
.agent-frame.active { display: block; }
aside#queue { flex: 1; border: 1px solid #8886; border-radius: 6px; padding: 1rem; max-height: 720px; overflow-y: auto; }
.queue-item { border-bottom: 1px solid #8884; padding-block: 0.75rem; }
.queue-item:last-child { border-bottom: none; }
.queue-agent-tag { text-transform: uppercase; font-size: 0.7rem; opacity: 0.6; letter-spacing: 0.05em; }
.badge { display: inline-block; font-size: 0.75rem; padding: 0.1rem 0.5rem; border-radius: 999px; }
.badge-approved { background: #2ecc7133; color: #1e8449; }
.badge-rejected { background: #e74c3c33; color: #c0392b; }
button { cursor: pointer; padding: 0.3rem 0.6rem; border-radius: 4px; border: 1px solid #8886; background: transparent; font: inherit; }
</style>
</head>
<body>
<h1>Compliance Swarm Orchestrator</h1>
<div class="tabs">
  <button data-tab="payroll" class="active">Payroll</button>
  <button data-tab="books">Books</button>
  <button data-tab="contract">Contract</button>
</div>
<div class="workspace">
  <div class="agent-panes">
    <iframe data-agent="payroll" src="payroll-review-demo.html" class="agent-frame active"></iframe>
    <iframe data-agent="books" src="books-review-demo.html" class="agent-frame"></iframe>
    <iframe data-agent="contract" src="contract-review-demo.html" class="agent-frame"></iframe>
  </div>
  <aside id="queue"></aside>
</div>
<script>
document.querySelectorAll('.tabs button').forEach(tabBtn => {
  tabBtn.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.agent-frame').forEach(f => f.classList.remove('active'));
    tabBtn.classList.add('active');
    document.querySelector(`iframe[data-agent="${tabBtn.dataset.tab}"]`).classList.add('active');
  });
});
</script>
</body>
</html>
```

**Step 1 check:** Open `http://localhost:8000/agents/orchestrator.html`. Confirm all three tabs switch which iframe is visible, and each iframe loads its respective agent (Payroll visible by default, its sample data rendered inside the iframe).

- [ ] **Step 2: Add the shared approval queue**

Add this `<script>` block right before `</body>` (after the tab-switching script from Step 1):

```html
<script>
const QUEUE_KEY = 'compliance-swarm-queue';

function loadQueue() {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY)) || []; } catch (e) { return []; }
}
function saveQueue(queue) { localStorage.setItem(QUEUE_KEY, JSON.stringify(queue)); }

let queue = loadQueue();

function renderQueue() {
  const el = document.getElementById('queue');
  if (queue.length === 0) {
    el.innerHTML = '<h2>Approval Queue</h2><p>Nothing flagged yet.</p>';
    return;
  }
  el.innerHTML = '<h2>Approval Queue</h2>' + queue.map(item => `
    <div class="queue-item" data-item-id="${item.itemId}">
      <div class="queue-agent-tag">${item.agentId}</div>
      <p>${item.summary}</p>
      ${item.decision
        ? `<span class="badge badge-${item.decision}">${item.decision}</span>`
        : `<button data-approve="${item.itemId}">Approve</button> <button data-reject="${item.itemId}">Reject</button>`}
    </div>`).join('');

  el.querySelectorAll('[data-approve]').forEach(btn => btn.addEventListener('click', () => decide(btn.dataset.approve, 'approved')));
  el.querySelectorAll('[data-reject]').forEach(btn => btn.addEventListener('click', () => decide(btn.dataset.reject, 'rejected')));
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
  let item = queue.find(q => q.itemId === itemId);
  if (!item) {
    item = { itemId, agentId, summary, decision: null };
    queue.push(item);
    saveQueue(queue);
  } else if (item.decision) {
    const iframe = document.querySelector(`iframe[data-agent="${agentId}"]`);
    if (iframe) iframe.contentWindow.postMessage({ type: 'swarm-decision', itemId, decision: item.decision }, '*');
  }
  renderQueue();
});

renderQueue();
</script>
```

**Step 2 check:** Reload `http://localhost:8000/agents/orchestrator.html`. Confirm, without clicking any tab:
- The Approval Queue panel populates with items from all three agents (payroll flags, the uncategorized "Zylo Consulting" transaction, all 5 contract clause flags) — proving hidden iframes still deliver their messages.
- Clicking Approve/Reject on a queue item shows the badge in the queue immediately.
- Switching to that item's agent tab shows the same badge next to the corresponding row inside the iframe (proves the `swarm-decision` message round-trip works).
- Reload the page: the queue and its decisions persist (localStorage), and previously-approved/rejected items get their badge re-applied inside the freshly-loaded iframe automatically once that agent re-flags the same item.

- [ ] **Step 3: Commit**

```bash
git add agents/orchestrator.html
git commit -m "Add orchestrator with shared approval queue"
```

---

## Plan Self-Review Notes

- **Spec coverage:** Architecture (static/no-build, standalone agents, orchestrator-as-shell) → Tasks 1-4. Shared building blocks (settings, callModel, error handling) → preamble, embedded in every task. Payroll deterministic core → Task 1 Step 2. Books CoA loading + heuristic → Task 2. Contract clause-library parsing + matching → Task 3. Testing approach (browser verification, no test framework) → every task's "check" step. Out-of-scope items (no persistence beyond localStorage, no real tax tables, no interactive checklist) → not built anywhere in this plan, consistent with the spec.
- **Placeholder scan:** no TBD/TODO; every step has literal code or an exact manual verification procedure.
- **Type consistency:** `notifyParentIfEmbedded(agentId, item)` and message shape `{ type: 'swarm-flag', agentId, itemId, summary }` are identical across Tasks 1, 2, 3, and consumed identically in Task 4. `listenForDecisions(onDecision)` and `{ type: 'swarm-decision', itemId, decision }` likewise match between Task 4's producer code and Tasks 1-3's shared consumer code.
