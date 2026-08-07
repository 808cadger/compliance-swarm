# Config-Driven Model Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a committed, non-secret `config/model-config.json` that gives each agent's model call site its own default provider/model/token/temperature settings (in particular routing the payroll explainer to a local Ollama model by default), per `docs/superpowers/specs/2026-08-07-model-config-design.md`, without breaking the existing per-browser Settings panel override.

**Architecture:** One new JSON config file, loaded via `fetch()` (same pattern already used for the CoA/clause-library template files) from each of the three existing standalone agent HTML files. Each file gets a `resolveModelConfig()`/`loadModelConfig()` pair (duplicated per file, matching the existing "each agent stands alone" convention), a new `CONFIG_KEY` constant, a third "Auto" Settings mode, and policy-gate enforcement. No backend, no build step.

**Tech Stack:** Vanilla HTML/CSS/JS, no dependencies. Served locally via `python3 -m http.server` (already required by the existing agent-demos plan for `fetch()` of sibling files to work — `file://` blocks it).

## Global Constraints

- `config/model-config.json` must never contain secrets — no API keys. It's committed to git and safe to be public.
- If a saved Settings-panel `mode` is explicitly `'cloud'` or `'local'` (not `'auto'`), that choice's provider/model/endpoint is unaffected by `model-config.json` — only a fresh/untouched `mode: 'auto'` (the new default) resolves provider/model/endpoint from the config file.
- `maxTokens`/`temperature` come from `resolveModelConfig()` in **all three** Settings modes (Auto, Cloud, Local) — these aren't a provider choice, they're a per-call-site property.
- `requireHumanApproval: true` and `allowExecutedActions: false` are invariants of `model-config.json`. If either is violated, the page must fail loud (replace the whole page body with an error, not just show an inline error on one button) — this is a tripwire against future regressions, not new user-facing behavior under today's config values.
- If `model-config.json` fails to load (network error, 404, malformed JSON), fall back to today's hardcoded values (`anthropic` / `claude-sonnet-5`, `maxTokens: 400`, no temperature) with a single `console.warn`, and the page must still render normally (this is not a policy violation).
- No test framework exists in this repo. Verification = load in a real browser via the local server and exercise each mode/failure path manually (per spec's Testing section).

---

## Task 1: Add `config/model-config.json`

**Files:**
- Create: `config/model-config.json`

**Interfaces:**
- Produces: a JSON file at `config/model-config.json`, fetched via the relative path `../config/model-config.json` by every file under `agents/` (Tasks 2-4). Shape: `{ version, defaults: { provider, model, maxTokens, temperature }, agents: { <configKey>: {...partial overrides} }, policy: { allowCloud, allowLocal, requireHumanApproval, allowExecutedActions } }`.

- [ ] **Step 1: Create the config file**

Create `config/model-config.json`:

```json
{
  "version": 1,
  "defaults": {
    "provider": "anthropic",
    "model": "claude-sonnet-5",
    "maxTokens": 1200,
    "temperature": 0.1
  },
  "agents": {
    "books_review": {
      "maxTokens": 1200,
      "temperature": 0
    },
    "contract_review": {
      "maxTokens": 1600,
      "temperature": 0
    },
    "payroll_explainer": {
      "provider": "ollama",
      "endpoint": "http://localhost:11434/api/chat",
      "model": "llama3.1:8b",
      "maxTokens": 700,
      "temperature": 0
    }
  },
  "policy": {
    "allowCloud": true,
    "allowLocal": true,
    "requireHumanApproval": true,
    "allowExecutedActions": false
  }
}
```

**Step 1 check:** Run `python3 -m json.tool config/model-config.json` from `compliance-swarm/` and confirm it prints the parsed structure with no error (validates the JSON is well-formed before anything tries to fetch it).

- [ ] **Step 2: Commit**

```bash
git add config/model-config.json
git commit -m "Add committed model-config.json (non-secret provider/model routing + policy)"
```

---

## Task 2: Wire config routing into the payroll agent

**Files:**
- Modify: `agents/payroll-review-demo.html:40-134` (shared model-settings block), `:150` (`AGENT_ID` line), `:266` (`callModel` call site), `:294` (bottom init)

**Interfaces:**
- Consumes: `config/model-config.json` (Task 1), via `fetch('../config/model-config.json')`.
- Produces: `resolveModelConfig(configKey)` → `{ provider, model, endpoint?, maxTokens, temperature? }`; `loadModelConfig()` → `Promise<config>` (config object as parsed from the JSON, or `FALLBACK_MODEL_CONFIG` on failure); `callModel(prompt, configKey)` (signature changed — now takes a second argument). Tasks 3 and 4 replicate this exact same shape in their own files (not shared code — each file stays standalone, per the existing convention).

- [ ] **Step 1: Replace the shared model-settings block**

In `agents/payroll-review-demo.html`, find the block starting at the comment `// --- Shared: model settings & call (localStorage-backed) ---` (line 40) and ending at the closing `}` of `renderModelError` (line 134). Replace that entire block with:

```js
// --- Shared: model settings & call (localStorage-backed) ---
const SETTINGS_KEY = 'compliance-swarm-settings';

function loadSettings() {
  const defaults = { mode: 'auto', apiKey: '', localEndpoint: 'http://localhost:11434/api/chat', localModel: 'llama3' };
  try {
    return Object.assign(defaults, JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {});
  } catch (e) {
    return defaults;
  }
}

function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

// --- Shared: model config (config/model-config.json, no secrets, committed to git) ---
const FALLBACK_MODEL_CONFIG = {
  version: 1,
  defaults: { provider: 'anthropic', model: 'claude-sonnet-5', maxTokens: 400 },
  agents: {},
  policy: { allowCloud: true, allowLocal: true, requireHumanApproval: true, allowExecutedActions: false }
};

let cachedModelConfig = null;

function assertPolicyInvariants(policy) {
  if (policy.requireHumanApproval !== true || policy.allowExecutedActions !== false) {
    throw new Error('model-config.json violates policy invariants: requireHumanApproval must be true and allowExecutedActions must be false');
  }
}

async function loadModelConfig() {
  if (cachedModelConfig) return cachedModelConfig;
  let config;
  try {
    const res = await fetch('../config/model-config.json');
    if (!res.ok) throw new Error(`status ${res.status}`);
    config = await res.json();
  } catch (err) {
    console.warn('model-config.json failed to load, using built-in defaults:', err.message);
    config = FALLBACK_MODEL_CONFIG;
  }
  assertPolicyInvariants(config.policy);
  cachedModelConfig = config;
  return config;
}

function resolveModelConfig(configKey) {
  const config = cachedModelConfig || FALLBACK_MODEL_CONFIG;
  return Object.assign({}, config.defaults, config.agents[configKey] || {});
}

function renderSettingsPanel(container) {
  const s = loadSettings();
  const policy = (cachedModelConfig || FALLBACK_MODEL_CONFIG).policy;
  container.innerHTML = `
    <fieldset class="settings-panel">
      <legend>Model Settings</legend>
      <label><input type="radio" name="mode" value="auto" ${s.mode === 'auto' ? 'checked' : ''}> Auto (recommended)</label>
      ${policy.allowCloud ? `<label><input type="radio" name="mode" value="cloud" ${s.mode === 'cloud' ? 'checked' : ''}> Cloud (Anthropic)</label>` : ''}
      ${policy.allowLocal ? `<label><input type="radio" name="mode" value="local" ${s.mode === 'local' ? 'checked' : ''}> Local (Ollama)</label>` : ''}
      <div class="cloud-fields" style="${s.mode === 'cloud' ? '' : 'display:none'}">
        <label>API Key <input type="password" id="apiKeyInput" value="${s.apiKey}" placeholder="sk-ant-..."></label>
      </div>
      <div class="local-fields" style="${s.mode === 'local' ? '' : 'display:none'}">
        <label>Endpoint <input type="text" id="endpointInput" value="${s.localEndpoint}"></label>
        <label>Model <input type="text" id="localModelInput" value="${s.localModel}"></label>
      </div>
      <p class="settings-note">Stored only in this browser's localStorage. Auto uses this agent's default model from config/model-config.json.</p>
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

async function callModel(prompt, configKey) {
  const settings = loadSettings();
  const config = await loadModelConfig();
  const resolved = resolveModelConfig(configKey);
  const useAuto = settings.mode === 'auto';
  const provider = useAuto ? resolved.provider : (settings.mode === 'cloud' ? 'anthropic' : 'ollama');

  if (provider === 'anthropic' && !config.policy.allowCloud) throw new Error('POLICY_BLOCKED_CLOUD');
  if (provider === 'ollama' && !config.policy.allowLocal) throw new Error('POLICY_BLOCKED_LOCAL');

  if (provider === 'anthropic') {
    if (!settings.apiKey) throw new Error('NO_KEY');
    const body = {
      model: useAuto ? resolved.model : 'claude-sonnet-5',
      max_tokens: resolved.maxTokens,
      messages: [{ role: 'user', content: prompt }]
    };
    if (resolved.temperature !== undefined) body.temperature = resolved.temperature;
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': settings.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`Cloud call failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    return data.content.map(c => c.text || '').join('');
  } else {
    const endpoint = useAuto ? resolved.endpoint : settings.localEndpoint;
    if (!endpoint) throw new Error('NO_ENDPOINT');
    const body = {
      model: useAuto ? resolved.model : (settings.localModel || 'llama3'),
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      options: { num_predict: resolved.maxTokens }
    };
    if (resolved.temperature !== undefined) body.options.temperature = resolved.temperature;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
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
  } else if (err.message === 'POLICY_BLOCKED_CLOUD') {
    container.textContent = 'Cloud calls are disabled by policy (config/model-config.json). Switch to Local in Settings.';
  } else if (err.message === 'POLICY_BLOCKED_LOCAL') {
    container.textContent = 'Local calls are disabled by policy (config/model-config.json). Switch to Cloud in Settings.';
  } else {
    container.textContent = 'Model call failed: ' + err.message;
  }
  container.classList.add('model-error');
}
```

- [ ] **Step 2: Add the `CONFIG_KEY` constant**

Find `const AGENT_ID = 'payroll';` and add a new line directly after it:

```js
const AGENT_ID = 'payroll';
const CONFIG_KEY = 'payroll_explainer';
```

- [ ] **Step 3: Pass `CONFIG_KEY` at the `callModel` call site**

Find `const text = await callModel(prompt);` (inside the Explain button's click handler) and change it to:

```js
        const text = await callModel(prompt, CONFIG_KEY);
```

- [ ] **Step 4: Gate initial render on config load, blocking the page on a policy violation**

Find the final `render();` line at the bottom of the script (after the `listenForDecisions(...)` block) and replace it with:

```js
loadModelConfig()
  .then(render)
  .catch(err => {
    document.body.innerHTML = `<p style="color:#c0392b; padding:2rem;">Configuration error: ${err.message}</p>`;
  });
```

- [ ] **Step 5: Manual verification**

Start (or reuse) `python3 -m http.server 8000` from `compliance-swarm/`. Open browser devtools, clear `localStorage` for `http://localhost:8000` (Application tab → Clear site data, or `localStorage.clear()` in console), then load `http://localhost:8000/agents/payroll-review-demo.html` and confirm:

- Settings panel shows three radios: Auto (checked by default), Cloud (Anthropic), Local (Ollama).
- Click "Explain" on a flagged row (e.g. Aiko Sato, 63 hours) with Auto mode selected and no API key entered. Open the Network tab: confirm a POST fires to `http://localhost:11434/api/chat` with body containing `"model":"llama3.1:8b"`, `"options":{"num_predict":700,"temperature":0}` — this must happen even though no API key is set, proving Auto mode for this agent doesn't need one. If Ollama isn't running locally, the request will fail (connection refused) and the inline error will read "Local call failed: ...", which still confirms the routing went to the right place.
- Switch Settings to Cloud, enter any string as the API key, click Explain again. Confirm in the Network tab the request now goes to `https://api.anthropic.com/v1/messages` with `"model":"claude-sonnet-5"`, `"max_tokens":700`, `"temperature":0` (700/0 still come from `payroll_explainer`'s config, proving maxTokens/temperature apply regardless of mode).
- Edit `config/model-config.json` locally, temporarily setting `"allowLocal": false`, save, reload the page. Confirm the Local radio no longer appears in Settings. With Auto mode selected, click Explain and confirm the inline error reads "Local calls are disabled by policy...". Revert the edit (`"allowLocal": true`) afterward.
- Temporarily set `"allowExecutedActions": true` in `config/model-config.json`, reload the page. Confirm the entire page body is replaced with a red "Configuration error: ..." message instead of the normal UI. Revert the edit afterward.
- Temporarily rename `config/model-config.json` (e.g. to `model-config.json.bak`), reload the page. Confirm the console shows the `model-config.json failed to load` warning, the page still renders normally, and Explain in Auto mode now behaves like Cloud/`claude-sonnet-5`/400 max tokens with no temperature (check the Network tab request body). Rename the file back afterward.

- [ ] **Step 6: Commit**

```bash
git add agents/payroll-review-demo.html
git commit -m "Route payroll explainer through config/model-config.json with Auto mode"
```

---

## Task 3: Wire config routing into the books agent

**Files:**
- Modify: `agents/books-review-demo.html:45-139` (shared model-settings block), `:155` (`AGENT_ID` line), `:256` (`callModel` call site), `:283` (bottom init)

**Interfaces:**
- Consumes: `config/model-config.json` (Task 1).
- Produces: same shape as Task 2 (`resolveModelConfig`, `loadModelConfig`, `callModel(prompt, configKey)`), independently implemented in this file.

- [ ] **Step 1: Replace the shared model-settings block**

In `agents/books-review-demo.html`, find the block starting at the comment `// --- Shared: model settings & call (localStorage-backed) ---` (line 45) and ending at the closing `}` of `renderModelError` (line 139). Replace that entire block with the exact same code as Task 2 Step 1 above (identical content — `SETTINGS_KEY`, `loadSettings`, `saveSettings`, `FALLBACK_MODEL_CONFIG`, `cachedModelConfig`, `assertPolicyInvariants`, `loadModelConfig`, `resolveModelConfig`, `renderSettingsPanel`, `callModel`, `renderModelError`).

- [ ] **Step 2: Add the `CONFIG_KEY` constant**

Find `const AGENT_ID = 'books';` and add a new line directly after it:

```js
const AGENT_ID = 'books';
const CONFIG_KEY = 'books_review';
```

- [ ] **Step 3: Pass `CONFIG_KEY` at the `callModel` call site**

Find `const text = await callModel(prompt);` (inside the AI-Suggest button's click handler) and change it to:

```js
        const text = await callModel(prompt, CONFIG_KEY);
```

- [ ] **Step 4: Gate initial render on config load, blocking the page on a policy violation**

Find the final `render();` line at the bottom of the script (after the `listenForDecisions(...)` block) and replace it with:

```js
loadModelConfig()
  .then(render)
  .catch(err => {
    document.body.innerHTML = `<p style="color:#c0392b; padding:2rem;">Configuration error: ${err.message}</p>`;
  });
```

- [ ] **Step 5: Manual verification**

With the local server running, clear `localStorage` and load `http://localhost:8000/agents/books-review-demo.html`. Confirm:

- Settings shows Auto/Cloud/Local, Auto checked by default.
- Click "AI Suggest" on the uncategorized "Zylo Consulting Group Inc" row in Auto mode with no API key set. Confirm in the Network tab (or via the "add an API key" inline message, since `books_review` has no `provider`/`endpoint` override and inherits `anthropic` from `defaults`) that this agent requires a key even in Auto mode — unlike payroll, `books_review` doesn't override `provider`, so it resolves to `anthropic`.
- Enter a placeholder API key, click AI Suggest again, confirm the request body sent to `https://api.anthropic.com/v1/messages` contains `"max_tokens":1200`, `"temperature":0` (from `books_review`'s config override).

- [ ] **Step 6: Commit**

```bash
git add agents/books-review-demo.html
git commit -m "Route books review agent through config/model-config.json with Auto mode"
```

---

## Task 4: Wire config routing into the contract agent

**Files:**
- Modify: `agents/contract-review-demo.html:40-134` (shared model-settings block), `:150` (`AGENT_ID` line), `:278` (`callModel` call site), `:293-294` (bottom init)

**Interfaces:**
- Consumes: `config/model-config.json` (Task 1).
- Produces: same shape as Task 2 (`resolveModelConfig`, `loadModelConfig`, `callModel(prompt, configKey)`), independently implemented in this file.

- [ ] **Step 1: Replace the shared model-settings block**

In `agents/contract-review-demo.html`, find the block starting at the comment `// --- Shared: model settings & call (localStorage-backed) ---` (line 40) and ending at the closing `}` of `renderModelError` (line 134). Replace that entire block with the exact same code as Task 2 Step 1 above (identical content).

- [ ] **Step 2: Add the `CONFIG_KEY` constant**

Find `const AGENT_ID = 'contract';` and add a new line directly after it:

```js
const AGENT_ID = 'contract';
const CONFIG_KEY = 'contract_review';
```

- [ ] **Step 3: Pass `CONFIG_KEY` at the `callModel` call site**

Find `const explanation = await callModel(prompt);` (inside the "Explain + suggest redline" button's click handler) and change it to:

```js
      const explanation = await callModel(prompt, CONFIG_KEY);
```

- [ ] **Step 4: Gate initial render on config load, blocking the page on a policy violation**

Find these three lines at the bottom of the script:

```js
document.getElementById('contractInput').value = SAMPLE_CONTRACT;
renderSettingsPanel(document.getElementById('settings'));
scan();
```

Replace them with:

```js
document.getElementById('contractInput').value = SAMPLE_CONTRACT;

loadModelConfig()
  .then(() => {
    renderSettingsPanel(document.getElementById('settings'));
    scan();
  })
  .catch(err => {
    document.body.innerHTML = `<p style="color:#c0392b; padding:2rem;">Configuration error: ${err.message}</p>`;
  });
```

(`renderSettingsPanel` and `scan()` move inside the `.then()` — unlike payroll/books, this file calls `renderSettingsPanel` directly at the bottom rather than from inside `render()`, so it needs to be deferred explicitly here too, otherwise it would read `cachedModelConfig` before the fetch resolves.)

- [ ] **Step 5: Manual verification**

With the local server running, clear `localStorage` and load `http://localhost:8000/agents/contract-review-demo.html`. Confirm:

- Settings shows Auto/Cloud/Local, Auto checked by default, and the 5 sample clauses are still flagged (config gating didn't break the existing scan).
- Click "Explain + suggest redline" on any flagged clause in Auto mode with no API key set — confirm the inline "add an API key" message (contract_review inherits `anthropic` from defaults, same as books).
- Enter a placeholder API key, click again, confirm the request body sent to `https://api.anthropic.com/v1/messages` contains `"max_tokens":1600`, `"temperature":0` (from `contract_review`'s config override).

- [ ] **Step 6: Commit**

```bash
git add agents/contract-review-demo.html
git commit -m "Route contract review agent through config/model-config.json with Auto mode"
```

---

## Task 5: Update README

**Files:**
- Modify: `README.md` (Architecture notes section)

**Interfaces:**
- Consumes: nothing (documentation only).
- Produces: nothing consumed by other tasks — this is the last task.

- [ ] **Step 1: Update the Architecture notes section**

In `README.md`, find this bullet:

```
- The orchestrator has a Cloud/Local model toggle. Default points at `https://api.anthropic.com/v1/messages` for cloud demos; switching to Local points at a configurable Ollama-style endpoint (`http://localhost:11434/api/chat` by default). Both paths flow through one `callModel()` function per agent.
```

Replace it with:

```
- Each agent has a Cloud/Local/Auto model toggle in its own Settings panel (not the orchestrator — each of the three agent pages has its own). Auto (the default) resolves provider, model, and per-call token/temperature limits from the committed `config/model-config.json`, which has no secrets in it — that file routes the payroll explainer to a local Ollama model (`llama3.1:8b`) by default while books/contract stay on cloud (`claude-sonnet-5`). Explicitly picking Cloud or Local in Settings overrides the provider/model/endpoint choice from the config file, but token/temperature limits still come from it. Cloud path POSTs to `https://api.anthropic.com/v1/messages` using a key pasted into Settings; Local/Auto-to-local paths POST to a configurable Ollama-style endpoint (`http://localhost:11434/api/chat` by default). Both flow through one `callModel(prompt, configKey)` function per agent. `config/model-config.json` also carries policy flags (`allowCloud`, `allowLocal`, `requireHumanApproval`, `allowExecutedActions`) enforced at load time — the last two are invariants of this app (nothing here executes actions) and a violated config fails the whole page loudly rather than silently misbehaving.
```

**Step 1 check:** Read the updated section back and confirm it accurately describes the behavior implemented in Tasks 2-4 (no stale references to a single global toggle or a hardcoded `claude-sonnet-5` for every agent).

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "Document config-driven model routing in README"
```

---

## Plan Self-Review Notes

- **Spec coverage:** Config file shape/non-secret requirement → Task 1. `resolveModelConfig`/`loadModelConfig`/`CONFIG_KEY` mapping table → Task 2 Steps 1-2 (and replicated identically in Tasks 3-4 Steps 1-2). Auto mode + Settings precedence → Task 2 Step 1's `renderSettingsPanel`/`callModel`. Policy enforcement (tripwire + allowCloud/allowLocal gating) → Task 2 Step 1's `assertPolicyInvariants`/`callModel`, verified in Task 2 Step 5. Data-flow example (payroll, Auto mode) → Task 2 Step 5's first verification bullet. Fallback-on-load-failure behavior → Task 2 Step 5's last verification bullet. Testing/verification approach → every task's Step 5 (Step 1 check for Task 1's JSON validity). Out-of-scope items (no shared module extraction, no per-agent Settings UI, no orchestrator changes) → not touched anywhere in this plan.
- **Placeholder scan:** no TBD/TODO; every code step has literal, complete code; every verification step names the exact thing to check in the Network tab or UI rather than "add appropriate tests."
- **Type consistency:** `callModel(prompt, configKey)` signature, `resolveModelConfig(configKey)` return shape `{provider, model, endpoint?, maxTokens, temperature?}`, and `CONFIG_KEY` constant values (`payroll_explainer`, `books_review`, `contract_review` — matching `config/model-config.json`'s `agents` keys exactly) are identical across Tasks 2, 3, and 4.
