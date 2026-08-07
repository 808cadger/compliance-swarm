# Model Policy v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current `config/model-config.json` + per-file-duplicated model-routing block (branch `worktree-model-config-routing`, commits `63123a7`..`7fca91f`) with `config/model-policy.json`, a shared ES-module client (`shared/model-client.js` + `shared/providers/{anthropic,ollama}.js`), a versioned `localStorage` settings schema, load-time safety tripwires, a payroll-specific no-fallback guarantee, and per-result badges — per `docs/superpowers/specs/2026-08-07-model-policy-v2-design.md`.

**Architecture:** Two new small provider modules (`shared/providers/anthropic.js`, `shared/providers/ollama.js`), each a pure `call(config, messages)` function with zero knowledge of Settings/policy. One orchestration module (`shared/model-client.js`) that owns settings load/save/migration, policy loading + tripwire assertions, `resolveModelConfig`, `callModel` (dispatches to the two provider modules), Settings-panel rendering, error rendering, and badge rendering. All three `shared/*.js` files are ES modules loaded via `<script type="module">`; each agent HTML file imports what it needs instead of duplicating the block. No build step, no bundler — native ES modules work directly over the local static server this repo already requires.

**Tech Stack:** Vanilla HTML/CSS/JS, ES modules. Served via `python3 -m http.server` (unchanged requirement from prior work).

## Global Constraints

- `config/model-policy.json` and `shared/schemas/*.json` contain **no secrets** — committed to git, safe to be public.
- `shared/schemas/*.json` are **documentation/contract only** — no runtime validation, no schema-validator library loaded (keeps the existing "no external CDN dependencies" rule intact).
- Policy tripwires asserted at load, immediately after `config/model-policy.json` resolves (real fetch or fallback): `policy.requireHumanApproval === true`, `policy.allowExecutedActions === false`, `policy.allowCloudFallback === false`, `policy.payroll.cloudFallbackAllowed === false`, `policy.payroll.modelMayCalculatePay === false`. Any violation throws, and the throw must propagate all the way to replacing the **entire page body** with a "Configuration error: ..." message — not just an inline widget error.
- If `config/model-policy.json` fails to load (network error, 404, malformed JSON) — this is **not** a policy violation. Fall back silently to hardcoded defaults (`anthropic`/`claude-sonnet-5`/`maxTokens: 400`, no `temperature`, `allowedProviders: ['anthropic','ollama']`, all tripwire fields already compliant) with a single `console.warn`, and the page must still render normally.
- `resolveModelConfig(agentId, modelPolicy, settings)` sources `maxTokens`/`temperature` from `modelPolicy` (merged `defaults` → `agents[agentId]`) in **every** `settings.mode` — these are never overridden by `mode`. Only `provider`/`model`/`endpoint`/`apiKey` vary by mode.
- `settings.mode === 'force-cloud'` or `'force-local'` must leave `provider`/`model`/`endpoint` exactly as the user configured in Settings (`settings.cloud.*`/`settings.local.*`), ignoring `modelPolicy` for those three fields only.
- The payroll agent (`CONFIG_KEY = 'payroll_explainer'`) never automatically retries against a different provider on failure. If its resolved `config.provider === 'ollama'` and the call fails for any reason other than `POLICY_BLOCKED_PROVIDER`, the inline error must read exactly: `Local payroll explainer is unavailable. Start Ollama, choose Force Cloud, or choose another local endpoint.`
- The Settings panel API-key field (`.cloud-fields`) must be visible whenever `mode !== 'force-local'` (i.e. in `repo-defaults` and `force-cloud`, not just `force-cloud`) — this exact bug was found and fixed in the prior branch's final review; do not reintroduce it.
- `orchestrator.html` is not touched by this plan. `notifyParentIfEmbedded`/`listenForDecisions` stay exactly as they are in each agent file — they are not part of `shared/model-client.js`.
- No test framework exists in this repo. Verification = real headless-browser interaction (the cached Playwright Chromium already used successfully on this branch: binary `/home/cadger/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`, driver library `/home/cadger/Documents/kane-avatar/node_modules/playwright-core`, required directly with Node — that project itself is never modified).

---

## Task 1: `config/model-policy.json` + `shared/schemas/*.json`

**Files:**
- Delete: `config/model-config.json`
- Create: `config/model-policy.json`
- Create: `shared/schemas/model-policy.schema.json`
- Create: `shared/schemas/settings-v2.schema.json`
- Create: `shared/schemas/agent-result.schema.json`

**Interfaces:**
- Produces: `config/model-policy.json`, fetched via the relative path `../config/model-policy.json` by `shared/model-client.js` (Task 3) from any file under `agents/`. Shape consumed by `resolveModelConfig` (Task 3): `{version, defaults: {provider, model, maxTokens, temperature}, agents: {<agentId>: {...partial}}, policy: {allowedProviders, allowCloudFallback, requireHumanApproval, allowExecutedActions, payroll: {modelMayCalculatePay, cloudFallbackAllowed}}}`.
- The three schema files are pure documentation — no other task's code reads them.

- [ ] **Step 1: Remove the old config file**

```bash
git rm config/model-config.json
```

- [ ] **Step 2: Create `config/model-policy.json`**

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
    "books_review": {},
    "contract_review": {},
    "payroll_explainer": {
      "provider": "ollama",
      "endpoint": "http://localhost:11434/api/chat",
      "model": "llama3.1:8b",
      "maxTokens": 700,
      "temperature": 0
    }
  },
  "policy": {
    "allowedProviders": ["anthropic", "ollama"],
    "allowCloudFallback": false,
    "requireHumanApproval": true,
    "allowExecutedActions": false,
    "payroll": {
      "modelMayCalculatePay": false,
      "cloudFallbackAllowed": false
    }
  }
}
```

- [ ] **Step 3: Create `shared/schemas/model-policy.schema.json`**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "compliance-swarm model policy",
  "description": "Non-secret, repo-committed model routing defaults and safety policy. Documentation/contract only — not validated at runtime.",
  "type": "object",
  "required": ["version", "defaults", "agents", "policy"],
  "properties": {
    "version": { "type": "integer", "minimum": 1 },
    "defaults": {
      "type": "object",
      "required": ["provider", "model", "maxTokens", "temperature"],
      "properties": {
        "provider": { "type": "string", "enum": ["anthropic", "ollama"] },
        "model": { "type": "string" },
        "endpoint": { "type": "string" },
        "maxTokens": { "type": "integer", "minimum": 1 },
        "temperature": { "type": "number", "minimum": 0 }
      }
    },
    "agents": {
      "type": "object",
      "additionalProperties": {
        "type": "object",
        "properties": {
          "provider": { "type": "string", "enum": ["anthropic", "ollama"] },
          "model": { "type": "string" },
          "endpoint": { "type": "string" },
          "maxTokens": { "type": "integer", "minimum": 1 },
          "temperature": { "type": "number", "minimum": 0 }
        }
      }
    },
    "policy": {
      "type": "object",
      "required": ["allowedProviders", "allowCloudFallback", "requireHumanApproval", "allowExecutedActions", "payroll"],
      "properties": {
        "allowedProviders": {
          "type": "array",
          "items": { "type": "string", "enum": ["anthropic", "ollama"] }
        },
        "allowCloudFallback": { "type": "boolean", "const": false },
        "requireHumanApproval": { "type": "boolean", "const": true },
        "allowExecutedActions": { "type": "boolean", "const": false },
        "payroll": {
          "type": "object",
          "required": ["modelMayCalculatePay", "cloudFallbackAllowed"],
          "properties": {
            "modelMayCalculatePay": { "type": "boolean", "const": false },
            "cloudFallbackAllowed": { "type": "boolean", "const": false }
          }
        }
      }
    }
  }
}
```

- [ ] **Step 4: Create `shared/schemas/settings-v2.schema.json`**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "compliance-swarm localStorage settings (schema v2)",
  "description": "Per-browser user overrides, stored under the localStorage key 'compliance-swarm-settings'. May contain a real API key — never commit an example with a real value here, and this shape never leaves the browser except a user's own pasted key going directly to that provider's endpoint. Documentation/contract only — not validated at runtime.",
  "type": "object",
  "required": ["schemaVersion", "mode", "cloud", "local", "agentOverrides"],
  "properties": {
    "schemaVersion": { "const": 2 },
    "mode": { "type": "string", "enum": ["repo-defaults", "force-cloud", "force-local", "custom"] },
    "cloud": {
      "type": "object",
      "required": ["apiKey", "endpoint", "model"],
      "properties": {
        "apiKey": { "type": "string" },
        "endpoint": { "type": "string" },
        "model": { "type": ["string", "null"] }
      }
    },
    "local": {
      "type": "object",
      "required": ["endpoint", "model"],
      "properties": {
        "endpoint": { "type": "string" },
        "model": { "type": ["string", "null"] }
      }
    },
    "agentOverrides": {
      "type": "object",
      "additionalProperties": {
        "type": "object",
        "properties": {
          "provider": { "type": "string", "enum": ["anthropic", "ollama"] },
          "model": { "type": "string" }
        }
      }
    }
  }
}
```

- [ ] **Step 5: Create `shared/schemas/agent-result.schema.json`**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "compliance-swarm agent-result",
  "description": "The exact object callModel() returns — what a model call produced. agentId and templateVersion are NOT part of this shape; callers attach those separately when building an on-page badge. Documentation/contract only — not validated at runtime.",
  "type": "object",
  "required": ["text", "provider", "model", "usage"],
  "properties": {
    "text": { "type": "string" },
    "provider": { "type": "string", "enum": ["anthropic", "ollama"] },
    "model": { "type": "string" },
    "usage": {
      "type": "object",
      "required": ["inputTokens", "outputTokens"],
      "properties": {
        "inputTokens": { "type": ["integer", "null"] },
        "outputTokens": { "type": ["integer", "null"] }
      }
    }
  }
}
```

- [ ] **Step 6: Validate all four JSON files parse**

Run, from the repo root:
```bash
python3 -m json.tool config/model-policy.json
python3 -m json.tool shared/schemas/model-policy.schema.json
python3 -m json.tool shared/schemas/settings-v2.schema.json
python3 -m json.tool shared/schemas/agent-result.schema.json
```
Expected: each prints the parsed structure with no error.

- [ ] **Step 7: Commit**

Step 1's `git rm` already staged the deletion of `config/model-config.json` — this just adds the new files and commits both changes together:
```bash
git add config/model-policy.json shared/schemas/model-policy.schema.json shared/schemas/settings-v2.schema.json shared/schemas/agent-result.schema.json
git commit -m "Replace config/model-config.json with config/model-policy.json + docs-only schemas"
```

---

## Task 2: `shared/providers/anthropic.js` + `shared/providers/ollama.js`

**Files:**
- Create: `shared/providers/anthropic.js`
- Create: `shared/providers/ollama.js`

**Interfaces:**
- Produces: `export async function call(config, messages)` from each file, returning `{text: string, usage: {inputTokens: number|null, outputTokens: number|null}}`. Consumed by `shared/model-client.js`'s `callModel` (Task 3) via `import { call as callAnthropic } from './providers/anthropic.js';` / `import { call as callOllama } from './providers/ollama.js';`.
- Consumes: a `config` object with (at minimum) `model`, `maxTokens`, `endpoint`, and — for `anthropic.js` only — `apiKey`; optionally `temperature`. `messages` is a chat-format array: `[{role: 'user', content: '...'}]`.
- Neither file reads `localStorage`, calls `fetch('../config/...')`, or knows anything about Settings/policy — each is a pure function of its two arguments plus the network.

- [ ] **Step 1: Create `shared/providers/anthropic.js`**

```js
// shared/providers/anthropic.js
// Sends one chat-style request to the Anthropic Messages API and normalizes
// the response. Knows nothing about Settings, localStorage, or policy.

export async function call(config, messages) {
  if (!config.apiKey) throw new Error('NO_KEY');
  const body = {
    model: config.model,
    max_tokens: config.maxTokens,
    messages
  };
  if (config.temperature !== undefined) body.temperature = config.temperature;
  const res = await fetch(config.endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Cloud call failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return {
    text: data.content.map(c => c.text || '').join(''),
    usage: {
      inputTokens: data.usage?.input_tokens ?? null,
      outputTokens: data.usage?.output_tokens ?? null
    }
  };
}
```

- [ ] **Step 2: Create `shared/providers/ollama.js`**

```js
// shared/providers/ollama.js
// Sends one chat-style request to an Ollama-compatible /api/chat endpoint
// and normalizes the response. Knows nothing about Settings, localStorage,
// or policy.

export async function call(config, messages) {
  if (!config.endpoint) throw new Error('NO_ENDPOINT');
  const body = {
    model: config.model,
    messages,
    stream: false,
    options: { num_predict: config.maxTokens }
  };
  if (config.temperature !== undefined) body.options.temperature = config.temperature;
  const res = await fetch(config.endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Local call failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return {
    text: data.message ? data.message.content : JSON.stringify(data),
    usage: {
      inputTokens: data.prompt_eval_count ?? null,
      outputTokens: data.eval_count ?? null
    }
  };
}
```

- [ ] **Step 3: Verify both files are syntactically valid ES modules**

Node's `--check` flag treats a bare `.js` file as CommonJS by default (no `package.json` with `"type": "module"` exists in this repo), which would falsely reject the `export`/`import` syntax here. Use `--input-type=module` to check them as modules without executing them:
```bash
node --input-type=module --check < shared/providers/anthropic.js
node --input-type=module --check < shared/providers/ollama.js
```
Expected: no output, exit code 0, from both. If your Node version doesn't support this flag combination, skip this step and rely on Task 3/4's real-browser verification instead (a syntax error will surface immediately as a console error when the page tries to import the module) — note which path you used in your report.

- [ ] **Step 4: Commit**

```bash
git add shared/providers/anthropic.js shared/providers/ollama.js
git commit -m "Add provider modules: shared/providers/{anthropic,ollama}.js"
```

---

## Task 3: `shared/model-client.js`

**Files:**
- Create: `shared/model-client.js`

**Interfaces:**
- Consumes: `shared/providers/anthropic.js`, `shared/providers/ollama.js` (Task 2), `config/model-policy.json` (Task 1, fetched at runtime).
- Produces (all named exports, imported by each agent file in Tasks 4-6):
  - `loadSettings(): SettingsV2` — reads/migrates/returns the current `localStorage` settings.
  - `saveSettings(settings: SettingsV2): void`
  - `loadModelPolicy(): Promise<ModelPolicy>` — fetches (memoized) `../config/model-policy.json`, falls back to hardcoded defaults on failure, asserts policy tripwires, returns the resolved policy object (real or fallback). Rejects if the tripwires are violated.
  - `resolveModelConfig(agentId: string, modelPolicy: ModelPolicy, settings: SettingsV2): ResolvedConfig` — `{provider, model, endpoint, apiKey?, maxTokens, temperature?}`.
  - `callModel(config: ResolvedConfig, messages: Array<{role,content}>): Promise<{text, provider, model, usage}>`.
  - `renderSettingsPanel(container: Element, modelPolicy: ModelPolicy): void`
  - `renderModelError(container: Element, err: Error): void`
  - `renderResultBadge(result: {provider, model}, opts?: {templateVersion?: string}): string` — returns an HTML string.

- [ ] **Step 1: Create `shared/model-client.js`**

```js
// shared/model-client.js
// Settings (localStorage, versioned + migrated), model-policy.json loading
// and safety-tripwire enforcement, config resolution, and dispatch to
// provider modules. No secrets ever leave the browser except a user's own
// pasted API key, sent directly to that provider's endpoint.

import { call as callAnthropic } from './providers/anthropic.js';
import { call as callOllama } from './providers/ollama.js';

const SETTINGS_KEY = 'compliance-swarm-settings';
const MODEL_POLICY_PATH = '../config/model-policy.json';

const FALLBACK_MODEL_POLICY = {
  version: 1,
  defaults: { provider: 'anthropic', model: 'claude-sonnet-5', maxTokens: 400 },
  agents: {},
  policy: {
    allowedProviders: ['anthropic', 'ollama'],
    allowCloudFallback: false,
    requireHumanApproval: true,
    allowExecutedActions: false,
    payroll: { modelMayCalculatePay: false, cloudFallbackAllowed: false }
  }
};

function freshSettings() {
  return {
    schemaVersion: 2,
    mode: 'repo-defaults',
    cloud: { apiKey: '', endpoint: 'https://api.anthropic.com/v1/messages', model: null },
    local: { endpoint: 'http://localhost:11434/api/chat', model: null },
    agentOverrides: {}
  };
}

export function loadSettings() {
  let raw;
  try {
    raw = JSON.parse(localStorage.getItem(SETTINGS_KEY));
  } catch (e) {
    raw = null;
  }
  if (!raw) return freshSettings();
  if (raw.schemaVersion === 2) return raw;
  // Pre-v2 shape (predates this feature, or the unreleased intermediate
  // branch shape) — migrate, preserving whatever the user had, forced to
  // force-cloud so behavior doesn't silently change out from under them.
  const migrated = freshSettings();
  migrated.mode = 'force-cloud';
  if (raw.apiKey) migrated.cloud.apiKey = raw.apiKey;
  if (raw.localEndpoint) migrated.local.endpoint = raw.localEndpoint;
  if (raw.localModel) migrated.local.model = raw.localModel;
  saveSettings(migrated);
  return migrated;
}

export function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function assertPolicyInvariants(policy) {
  if (policy.requireHumanApproval !== true) {
    throw new Error('model-policy.json violates policy invariants: requireHumanApproval must be true');
  }
  if (policy.allowExecutedActions !== false) {
    throw new Error('model-policy.json violates policy invariants: allowExecutedActions must be false');
  }
  if (policy.allowCloudFallback !== false) {
    throw new Error('model-policy.json violates policy invariants: allowCloudFallback must be false');
  }
  if (!policy.payroll || policy.payroll.cloudFallbackAllowed !== false) {
    throw new Error('model-policy.json violates policy invariants: policy.payroll.cloudFallbackAllowed must be false');
  }
  if (policy.payroll.modelMayCalculatePay !== false) {
    throw new Error('model-policy.json violates policy invariants: policy.payroll.modelMayCalculatePay must be false');
  }
}

let modelPolicyPromise = null;

export function loadModelPolicy() {
  if (!modelPolicyPromise) {
    modelPolicyPromise = fetch(MODEL_POLICY_PATH)
      .then(res => {
        if (!res.ok) throw new Error(`status ${res.status}`);
        return res.json();
      })
      .catch(err => {
        console.warn('model-policy.json failed to load, using built-in defaults:', err.message);
        return FALLBACK_MODEL_POLICY;
      })
      .then(policy => {
        assertPolicyInvariants(policy.policy);
        return policy;
      });
  }
  return modelPolicyPromise;
}

function assertAllowed(provider, modelPolicy) {
  if (!modelPolicy.policy.allowedProviders.includes(provider)) {
    throw new Error(`POLICY_BLOCKED_PROVIDER: ${provider}`);
  }
}

export function resolveModelConfig(agentId, modelPolicy, settings) {
  const base = {
    ...modelPolicy.defaults,
    ...(modelPolicy.agents?.[agentId] || {})
  };

  if (settings.mode === 'force-cloud') {
    assertAllowed('anthropic', modelPolicy);
    return {
      ...base,
      provider: 'anthropic',
      endpoint: settings.cloud.endpoint,
      model: settings.cloud.model || base.model,
      apiKey: settings.cloud.apiKey
    };
  }

  if (settings.mode === 'force-local') {
    assertAllowed('ollama', modelPolicy);
    return {
      ...base,
      provider: 'ollama',
      endpoint: settings.local.endpoint,
      model: settings.local.model || base.model
    };
  }

  if (settings.mode === 'custom' && settings.agentOverrides?.[agentId]) {
    const merged = { ...base, ...settings.agentOverrides[agentId] };
    assertAllowed(merged.provider, modelPolicy);
    return merged;
  }

  // repo-defaults
  assertAllowed(base.provider, modelPolicy);
  return {
    ...base,
    apiKey: settings.cloud.apiKey,
    endpoint:
      base.provider === 'ollama'
        ? (base.endpoint || settings.local.endpoint)
        : (base.endpoint || settings.cloud.endpoint)
  };
}

export async function callModel(config, messages) {
  let result;
  if (config.provider === 'anthropic') {
    result = await callAnthropic(config, messages);
  } else if (config.provider === 'ollama') {
    result = await callOllama(config, messages);
  } else {
    throw new Error(`UNKNOWN_PROVIDER: ${config.provider}`);
  }
  return {
    text: result.text,
    provider: config.provider,
    model: config.model,
    usage: result.usage
  };
}

export function renderSettingsPanel(container, modelPolicy) {
  const s = loadSettings();
  const allowed = modelPolicy.policy.allowedProviders;
  container.innerHTML = `
    <fieldset class="settings-panel">
      <legend>Model Settings</legend>
      <label><input type="radio" name="mode" value="repo-defaults" ${s.mode === 'repo-defaults' ? 'checked' : ''}> Repo Defaults (recommended)</label>
      ${allowed.includes('anthropic') ? `<label><input type="radio" name="mode" value="force-cloud" ${s.mode === 'force-cloud' ? 'checked' : ''}> Force Cloud (Anthropic)</label>` : ''}
      ${allowed.includes('ollama') ? `<label><input type="radio" name="mode" value="force-local" ${s.mode === 'force-local' ? 'checked' : ''}> Force Local (Ollama)</label>` : ''}
      <div class="cloud-fields" style="${s.mode === 'force-local' ? 'display:none' : ''}">
        <label>API Key <input type="password" id="apiKeyInput" value="${s.cloud.apiKey}" placeholder="sk-ant-..."></label>
      </div>
      <div class="local-fields" style="${s.mode === 'force-local' ? '' : 'display:none'}">
        <label>Endpoint <input type="text" id="endpointInput" value="${s.local.endpoint}"></label>
        <label>Model <input type="text" id="localModelInput" value="${s.local.model || ''}" placeholder="(repo default)"></label>
      </div>
      <p class="settings-note">Stored only in this browser's localStorage. Repo Defaults resolves each agent's provider/model from config/model-policy.json.</p>
    </fieldset>
  `;
  container.querySelectorAll('input[name="mode"]').forEach(r => r.addEventListener('change', e => {
    const settings = loadSettings();
    settings.mode = e.target.value;
    saveSettings(settings);
    renderSettingsPanel(container, modelPolicy);
  }));
  const apiKeyInput = container.querySelector('#apiKeyInput');
  if (apiKeyInput) apiKeyInput.addEventListener('change', e => { const st = loadSettings(); st.cloud.apiKey = e.target.value; saveSettings(st); });
  const endpointInput = container.querySelector('#endpointInput');
  if (endpointInput) endpointInput.addEventListener('change', e => { const st = loadSettings(); st.local.endpoint = e.target.value; saveSettings(st); });
  const localModelInput = container.querySelector('#localModelInput');
  if (localModelInput) localModelInput.addEventListener('change', e => { const st = loadSettings(); st.local.model = e.target.value || null; saveSettings(st); });
}

export function renderModelError(container, err) {
  if (err.message === 'NO_KEY') {
    container.textContent = 'Add an API key in Settings to use this feature.';
  } else if (err.message === 'NO_ENDPOINT') {
    container.textContent = 'Set a Local endpoint in Settings to use this feature.';
  } else if (err.message.startsWith('POLICY_BLOCKED_PROVIDER')) {
    const provider = err.message.split(': ')[1] || '';
    container.textContent = `The "${provider}" provider is disabled by policy (config/model-policy.json). Choose a different mode in Settings.`;
  } else {
    container.textContent = 'Model call failed: ' + err.message;
  }
  container.classList.add('model-error');
}

export function renderResultBadge(result, { templateVersion } = {}) {
  const providerLabel = result.provider === 'ollama' ? 'Local' : 'Cloud';
  let html = `<span class="badge">${providerLabel} · ${result.model}</span>`;
  if (templateVersion) {
    html += ` <span class="badge">${templateVersion}</span>`;
  }
  return html;
}
```

- [ ] **Step 2: Verify the module is syntactically valid**

```bash
node --input-type=module --check < shared/model-client.js
```
Expected: no output, exit code 0. If unsupported by your Node version, skip and rely on Task 4's real-browser verification (an import/syntax error surfaces immediately as a console error).

- [ ] **Step 3: Commit**

```bash
git add shared/model-client.js
git commit -m "Add shared/model-client.js: settings v2, policy loading, resolver, callModel"
```

---

## Task 4: Wire `agents/payroll-review-demo.html` to the new shared client

**Files:**
- Modify: `agents/payroll-review-demo.html`

**Interfaces:**
- Consumes: `shared/model-client.js` (Task 3) via `import ... from '../shared/model-client.js';`.
- No change to `AGENT_ID`/`CONFIG_KEY` values (`'payroll'` / `'payroll_explainer'`) or to any of `MIN_WAGE_TABLE`, `SAMPLE_TIMESHEET`, `computePay`, `flagRow`, `parseCSV`, `notifyParentIfEmbedded`, `listenForDecisions` — all untouched.

- [ ] **Step 1: Convert the script tag to a module**

Find the opening `<script>` tag (the only one in this file) and change it to:
```html
<script type="module">
```

- [ ] **Step 2: Replace the duplicated shared block with an import**

Find the block starting at the comment `// --- Shared: model settings & call (localStorage-backed) ---` and ending at the closing `}` of `renderModelError` (immediately before the blank line that precedes `// --- Shared: notify orchestrator when embedded ---`). Replace that entire block with:

```js
import {
  loadSettings,
  loadModelPolicy,
  resolveModelConfig,
  callModel,
  renderSettingsPanel,
  renderModelError,
  renderResultBadge
} from '../shared/model-client.js';
```

Leave the `// --- Shared: notify orchestrator when embedded ---` comment and the `notifyParentIfEmbedded`/`listenForDecisions` functions immediately following it untouched — they are not part of this replacement.

- [ ] **Step 3: Make `render()` async and load the policy at its top**

Find:
```js
function render() {
  renderSettingsPanel(document.getElementById('settings'));
  const container = document.getElementById('table-container');
```
Replace with:
```js
async function render() {
  const modelPolicy = await loadModelPolicy();
  renderSettingsPanel(document.getElementById('settings'), modelPolicy);
  const container = document.getElementById('table-container');
```

- [ ] **Step 4: Add a model-result badge span to the flagged-row template**

Find:
```js
          ${isFlagged ? `<div>${flags.map(f => `&#9888; ${f}`).join('<br>')}</div><button data-explain="${i}">Explain</button><div class="explanation" data-explanation-for="${i}"></div><span data-badge-for="${itemId}"></span>` : ''}
```
Replace with:
```js
          ${isFlagged ? `<div>${flags.map(f => `&#9888; ${f}`).join('<br>')}</div><button data-explain="${i}">Explain</button><div class="explanation" data-explanation-for="${i}"></div><span data-model-badge-for="${i}"></span><span data-badge-for="${itemId}"></span>` : ''}
```

- [ ] **Step 5: Rewrite the Explain click handler**

Find:
```js
  container.querySelectorAll('[data-explain]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const i = Number(btn.dataset.explain);
      const row = currentRows[i];
      const flags = flagRow(row);
      const explDiv = container.querySelector(`[data-explanation-for="${i}"]`);
      explDiv.classList.remove('model-error');
      explDiv.textContent = 'Thinking...';
      const prompt = `You are explaining a payroll compliance flag to a small business owner in plain language, 2-3 sentences. Employee: ${row.employee}, classification: ${row.classification}, rate: $${row.rate}/hr, hours this week: ${row.hours}, state: ${row.state}. Flags raised: ${flags.join('; ')}.`;
      try {
        const text = await callModel(prompt, CONFIG_KEY);
        explDiv.textContent = text;
      } catch (err) {
        renderModelError(explDiv, err);
      }
    });
  });
```
Replace with:
```js
  container.querySelectorAll('[data-explain]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const i = Number(btn.dataset.explain);
      const row = currentRows[i];
      const flags = flagRow(row);
      const explDiv = container.querySelector(`[data-explanation-for="${i}"]`);
      const badgeSpan = container.querySelector(`[data-model-badge-for="${i}"]`);
      explDiv.classList.remove('model-error');
      explDiv.textContent = 'Thinking...';
      if (badgeSpan) badgeSpan.innerHTML = '';
      const prompt = `You are explaining a payroll compliance flag to a small business owner in plain language, 2-3 sentences. Employee: ${row.employee}, classification: ${row.classification}, rate: $${row.rate}/hr, hours this week: ${row.hours}, state: ${row.state}. Flags raised: ${flags.join('; ')}.`;
      const config = resolveModelConfig(CONFIG_KEY, modelPolicy, loadSettings());
      try {
        const result = await callModel(config, [{ role: 'user', content: prompt }]);
        explDiv.textContent = result.text;
        if (badgeSpan) badgeSpan.innerHTML = renderResultBadge(result);
      } catch (err) {
        if (config.provider === 'ollama' && !err.message.startsWith('POLICY_BLOCKED_PROVIDER')) {
          explDiv.textContent = 'Local payroll explainer is unavailable. Start Ollama, choose Force Cloud, or choose another local endpoint.';
          explDiv.classList.add('model-error');
        } else {
          renderModelError(explDiv, err);
        }
      }
    });
  });
```
(`modelPolicy` here is the `const` from Step 3, in scope via closure since this handler is defined inside the same `render()` call.)

- [ ] **Step 6: Simplify the bottom-of-script init**

Find:
```js
loadModelConfig()
  .then(render)
  .catch(err => {
    document.body.innerHTML = `<p style="color:#c0392b; padding:2rem;">Configuration error: ${err.message}</p>`;
  });
```
Replace with:
```js
render().catch(err => {
  document.body.innerHTML = `<p style="color:#c0392b; padding:2rem;">Configuration error: ${err.message}</p>`;
});
```

- [ ] **Step 7: Real-browser verification**

Start `python3 -m http.server 8000` from the repo root. Using the cached Playwright Chromium (per Global Constraints), with `localStorage.clear()` before each scenario:

1. Load `http://localhost:8000/agents/payroll-review-demo.html`. Confirm no console errors (proves the ES module import chain resolved), Settings shows "Repo Defaults" checked by default, and the API key field is visible (Repo Defaults, not Force Local).
2. Click Explain on the Aiko Sato row (63 hours) with no key entered. Intercept the outbound request (`page.route`) and confirm it POSTs to `http://localhost:11434/api/chat` with `model: "llama3.1:8b"`, `options: {num_predict: 700, temperature: 0}` — mock a `{message: {content: "..."}, prompt_eval_count: 12, eval_count: 34}` response and confirm the badge renders `Local · llama3.1:8b` (no second/template badge for payroll).
3. Without reloading, edit `config/model-policy.json` on disk (temporarily set `"allowedProviders": ["anthropic"]`), clear `localStorage`, reload, click Explain in Repo Defaults mode. Confirm the inline message reads exactly `Local payroll explainer is unavailable. Start Ollama, choose Force Cloud, or choose another local endpoint.` — **not** the generic `POLICY_BLOCKED_PROVIDER` text (per Global Constraints, since this is a resolver-level policy block, this is testing the boundary: `resolveModelConfig` will actually throw `POLICY_BLOCKED_PROVIDER` here before `callModel` is ever reached, so confirm instead that the generic policy-blocked message renders correctly in this specific case — `resolveModelConfig` throwing means the payroll-specific override in the `catch` never triggers, since `config` itself was never obtained; verify by reading `err.message` in the catch block or via a temporary console.log, and adjust the test's stated expectation to the generic "disabled by policy" message if that's what actually happens. Report exactly which message appeared.). Revert the config file edit and confirm `git diff` is clean afterward.
4. Temporarily simulate an Ollama-unavailable failure instead (mock the `http://localhost:11434/**` route to return a 500, `allowedProviders` back to normal) in Repo Defaults mode. Confirm the inline message this time is the payroll-specific "Local payroll explainer is unavailable..." text (this is the actual intended trigger path for that message — a live connection failure, not a policy block).
5. Switch to Force Cloud, enter a placeholder key, click Explain. Confirm the mocked request goes to `https://api.anthropic.com/v1/messages` with `model: "claude-sonnet-5"`, `max_tokens: 700`, `temperature: 0` (from `payroll_explainer`'s config, applied even in Force Cloud mode), and the badge renders `Cloud · claude-sonnet-5`.
6. Confirm a prior `localStorage` entry in the old (pre-v2) shape — e.g. `localStorage.setItem('compliance-swarm-settings', JSON.stringify({mode:'cloud', apiKey:'sk-old', localEndpoint:'http://localhost:11434/api/chat', localModel:'llama3'}))` — migrates on reload to `{schemaVersion:2, mode:'force-cloud', cloud:{apiKey:'sk-old',...}, ...}` (inspect via `page.evaluate(() => localStorage.getItem(...))`), and Settings shows Force Cloud selected with that key pre-filled.

Take at least one screenshot as evidence.

- [ ] **Step 8: Commit**

```bash
git add agents/payroll-review-demo.html
git commit -m "Wire payroll agent to shared/model-client.js (model-policy v2)"
```

---

## Task 5: Wire `agents/books-review-demo.html` to the new shared client

**Files:**
- Modify: `agents/books-review-demo.html`

**Interfaces:**
- Consumes: `shared/model-client.js` (Task 3).
- No change to `AGENT_ID`/`CONFIG_KEY` (`'books'` / `'books_review'`), `loadCoA`, `SAMPLE_TRANSACTIONS`, `CATEGORY_KEYWORDS`, `categorize`, `parseTxnCSV`, `notifyParentIfEmbedded`, `listenForDecisions`.

- [ ] **Step 1: Convert the script tag to a module**

Change the opening `<script>` tag to `<script type="module">`.

- [ ] **Step 2: Replace the duplicated shared block with an import**

Find the block starting at `// --- Shared: model settings & call (localStorage-backed) ---` and ending at the closing `}` of `renderModelError` (immediately before `// --- Shared: notify orchestrator when embedded ---`). Replace with the same import block as Task 4 Step 2:

```js
import {
  loadSettings,
  loadModelPolicy,
  resolveModelConfig,
  callModel,
  renderSettingsPanel,
  renderModelError,
  renderResultBadge
} from '../shared/model-client.js';
```

- [ ] **Step 3: Load the policy at the top of `render()`, capture the CoA filename**

Find:
```js
async function render() {
  renderSettingsPanel(document.getElementById('settings'));
  const container = document.getElementById('table-container');
  let coaError = null;
  try {
    currentCoA = await loadCoA(document.getElementById('coaSelect').value);
  } catch (err) {
```
Replace with:
```js
async function render() {
  const modelPolicy = await loadModelPolicy();
  renderSettingsPanel(document.getElementById('settings'), modelPolicy);
  const container = document.getElementById('table-container');
  const coaFilename = document.getElementById('coaSelect').value;
  let coaError = null;
  try {
    currentCoA = await loadCoA(coaFilename);
  } catch (err) {
```

- [ ] **Step 4: Add a model-result badge span to the uncategorized-row template**

Find:
```js
          ${category ? category : `Uncategorized <button data-suggest="${i}">AI Suggest</button><span data-badge-for="${itemId}"></span>`}
          <div class="explanation" data-explanation-for="${i}"></div>
```
Replace with:
```js
          ${category ? category : `Uncategorized <button data-suggest="${i}">AI Suggest</button><span data-badge-for="${itemId}"></span>`}
          <div class="explanation" data-explanation-for="${i}"></div>
          <span data-model-badge-for="${i}"></span>
```

- [ ] **Step 5: Rewrite the AI Suggest click handler**

Find:
```js
  container.querySelectorAll('[data-suggest]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const i = Number(btn.dataset.suggest);
      const txn = currentTxns[i];
      const explDiv = container.querySelector(`[data-explanation-for="${i}"]`);
      explDiv.classList.remove('model-error');
      explDiv.textContent = 'Thinking...';
      const prompt = `Suggest the best-matching category for this business transaction from the list, and explain briefly why. Transaction: "${txn.description}", amount $${txn.amount}. Available categories: ${categoryNames.join(', ')}.`;
      try {
        const text = await callModel(prompt, CONFIG_KEY);
        explDiv.textContent = text;
      } catch (err) {
        renderModelError(explDiv, err);
      }
    });
  });
```
Replace with:
```js
  container.querySelectorAll('[data-suggest]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const i = Number(btn.dataset.suggest);
      const txn = currentTxns[i];
      const explDiv = container.querySelector(`[data-explanation-for="${i}"]`);
      const badgeSpan = container.querySelector(`[data-model-badge-for="${i}"]`);
      explDiv.classList.remove('model-error');
      explDiv.textContent = 'Thinking...';
      if (badgeSpan) badgeSpan.innerHTML = '';
      const prompt = `Suggest the best-matching category for this business transaction from the list, and explain briefly why. Transaction: "${txn.description}", amount $${txn.amount}. Available categories: ${categoryNames.join(', ')}.`;
      const config = resolveModelConfig(CONFIG_KEY, modelPolicy, loadSettings());
      try {
        const result = await callModel(config, [{ role: 'user', content: prompt }]);
        explDiv.textContent = result.text;
        if (badgeSpan) badgeSpan.innerHTML = renderResultBadge(result, { templateVersion: coaFilename });
      } catch (err) {
        renderModelError(explDiv, err);
      }
    });
  });
```

- [ ] **Step 6: Simplify the bottom-of-script init**

Find:
```js
loadModelConfig()
  .then(render)
  .catch(err => {
    document.body.innerHTML = `<p style="color:#c0392b; padding:2rem;">Configuration error: ${err.message}</p>`;
  });
```
Replace with:
```js
render().catch(err => {
  document.body.innerHTML = `<p style="color:#c0392b; padding:2rem;">Configuration error: ${err.message}</p>`;
});
```

- [ ] **Step 7: Real-browser verification**

With the local server running and `localStorage.clear()`:

1. Load the page. Confirm no console errors, Repo Defaults checked, API key field visible (books resolves to `anthropic` even in Repo Defaults — no override in `config/model-policy.json`).
2. Click "AI Suggest" on the "Zylo Consulting Group Inc" row with no key entered. Confirm the inline `NO_KEY` message ("Add an API key...") — no network request fires.
3. Enter a placeholder key, click AI Suggest again. Intercept the request and confirm it POSTs to `https://api.anthropic.com/v1/messages` with `max_tokens: 1200`, `temperature: 0.1` (both from `defaults`, since `books_review` has an empty override object). Confirm the badge renders `Cloud · claude-sonnet-5` **and** a second badge showing `service-business-coa.csv` (the default-selected CoA option).
4. Switch the CoA dropdown to Retail, click AI Suggest on a fresh uncategorized row (or re-trigger), confirm the template badge now reads `retail-business-coa.csv`.

Take at least one screenshot as evidence.

- [ ] **Step 8: Commit**

```bash
git add agents/books-review-demo.html
git commit -m "Wire books agent to shared/model-client.js (model-policy v2)"
```

---

## Task 6: Wire `agents/contract-review-demo.html` to the new shared client

**Files:**
- Modify: `agents/contract-review-demo.html`

**Interfaces:**
- Consumes: `shared/model-client.js` (Task 3).
- No change to `AGENT_ID`/`CONFIG_KEY` (`'contract'` / `'contract_review'`), `loadClauseLibrary`, `SAMPLE_CONTRACT`, `MATCH_RULES`, `findFlaggedClauses`, `highlightMatch`, `notifyParentIfEmbedded`, `listenForDecisions`.

- [ ] **Step 1: Convert the script tag to a module**

Change the opening `<script>` tag to `<script type="module">`.

- [ ] **Step 2: Replace the duplicated shared block with an import**

Find the block starting at `// --- Shared: model settings & call (localStorage-backed) ---` and ending at the closing `}` of `renderModelError` (immediately before `// --- Shared: notify orchestrator when embedded ---`). Replace with the same import block as Task 4 Step 2:

```js
import {
  loadSettings,
  loadModelPolicy,
  resolveModelConfig,
  callModel,
  renderSettingsPanel,
  renderModelError,
  renderResultBadge
} from '../shared/model-client.js';
```

- [ ] **Step 3: Add a template-filename constant**

Find:
```js
const AGENT_ID = 'contract';
const CONFIG_KEY = 'contract_review';
```
Replace with:
```js
const AGENT_ID = 'contract';
const CONFIG_KEY = 'contract_review';
const CLAUSE_LIBRARY_FILENAME = 'red-flag-clause-library.md';
```

- [ ] **Step 4: Load the policy at the top of `scan()`**

Find:
```js
async function scan() {
  const container = document.getElementById('results');
```
Replace with:
```js
async function scan() {
  const modelPolicy = await loadModelPolicy();
  const container = document.getElementById('results');
```

- [ ] **Step 5: Add a model-result badge span to the flagged-clause template**

Find:
```js
        <button data-explain="${i}">Explain + suggest redline</button>
        <span data-badge-for="${flag.id}"></span>
        <div class="explanation" data-explanation-for="${i}"></div>
      </div>`;
```
Replace with:
```js
        <button data-explain="${i}">Explain + suggest redline</button>
        <span data-badge-for="${flag.id}"></span>
        <div class="explanation" data-explanation-for="${i}"></div>
        <span data-model-badge-for="${i}"></span>
      </div>`;
```

- [ ] **Step 6: Rewrite the Explain + suggest redline click handler**

Find:
```js
  container.querySelectorAll('[data-explain]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const i = Number(btn.dataset.explain);
      const flag = flags[i];
      const explDiv = container.querySelector(`[data-explanation-for="${i}"]`);
      if (clauseLibraryError) {
        explDiv.textContent = 'Clause library context is unavailable (the reference library failed to load), so a detailed redline suggestion can\'t be generated for this flag.';
        explDiv.classList.add('model-error');
        return;
      }
      const entry = clauseLibrary.find(e => e.name === flag.clauseName) || {};
      explDiv.classList.remove('model-error');
      explDiv.textContent = 'Thinking...';
      const prompt = `Explain this contract clause's risk in plain language (2-3 sentences) and suggest a specific redline, for a small business owner. Clause text: "${flag.text}". Known pattern: ${entry.pattern}. Why it matters: ${entry.why}. Suggested fallback ask: ${entry.fallback}.`;
      try {
        const explanation = await callModel(prompt, CONFIG_KEY);
        explDiv.textContent = explanation;
      } catch (err) {
        renderModelError(explDiv, err);
      }
    });
  });
```
Replace with:
```js
  container.querySelectorAll('[data-explain]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const i = Number(btn.dataset.explain);
      const flag = flags[i];
      const explDiv = container.querySelector(`[data-explanation-for="${i}"]`);
      const badgeSpan = container.querySelector(`[data-model-badge-for="${i}"]`);
      if (clauseLibraryError) {
        explDiv.textContent = 'Clause library context is unavailable (the reference library failed to load), so a detailed redline suggestion can\'t be generated for this flag.';
        explDiv.classList.add('model-error');
        return;
      }
      const entry = clauseLibrary.find(e => e.name === flag.clauseName) || {};
      explDiv.classList.remove('model-error');
      explDiv.textContent = 'Thinking...';
      if (badgeSpan) badgeSpan.innerHTML = '';
      const prompt = `Explain this contract clause's risk in plain language (2-3 sentences) and suggest a specific redline, for a small business owner. Clause text: "${flag.text}". Known pattern: ${entry.pattern}. Why it matters: ${entry.why}. Suggested fallback ask: ${entry.fallback}.`;
      const config = resolveModelConfig(CONFIG_KEY, modelPolicy, loadSettings());
      try {
        const result = await callModel(config, [{ role: 'user', content: prompt }]);
        explDiv.textContent = result.text;
        if (badgeSpan) badgeSpan.innerHTML = renderResultBadge(result, { templateVersion: CLAUSE_LIBRARY_FILENAME });
      } catch (err) {
        renderModelError(explDiv, err);
      }
    });
  });
```

- [ ] **Step 7: Simplify the bottom-of-script init**

Find:
```js
loadModelConfig()
  .then(() => {
    renderSettingsPanel(document.getElementById('settings'));
    scan();
  })
  .catch(err => {
    document.body.innerHTML = `<p style="color:#c0392b; padding:2rem;">Configuration error: ${err.message}</p>`;
  });
```
Replace with:
```js
loadModelPolicy()
  .then(modelPolicy => {
    renderSettingsPanel(document.getElementById('settings'), modelPolicy);
    return scan();
  })
  .catch(err => {
    document.body.innerHTML = `<p style="color:#c0392b; padding:2rem;">Configuration error: ${err.message}</p>`;
  });
```
(`scan()` calls `loadModelPolicy()` again at its own top per Step 4 — cheap, since it's memoized inside `shared/model-client.js` — so its closures always have a `modelPolicy` in scope even when triggered later by the "Scan Contract" button, not just on this initial chain.)

- [ ] **Step 8: Real-browser verification**

With the local server running and `localStorage.clear()`:

1. Load the page. Confirm no console errors, Repo Defaults checked, API key field visible, and all 6 sample clauses (5 pattern matches + the structural Liability-absence flag) still render correctly — this task didn't touch `findFlaggedClauses`/`MATCH_RULES`, so this is a regression check.
2. Click "Explain + suggest redline" on any flagged clause with no key entered. Confirm the inline `NO_KEY` message, no request fires.
3. Enter a placeholder key, click again. Confirm the mocked request has `max_tokens: 1200`, `temperature: 0.1` (from `defaults`, `contract_review` has an empty override), and the badge renders `Cloud · claude-sonnet-5` plus a second badge reading `red-flag-clause-library.md`.
4. Click "Scan Contract" again (re-triggering `scan()` via the button, not the initial load chain) and confirm the Explain flow still works identically — this is the case that would break if `modelPolicy` weren't independently available inside `scan()`.

Take at least one screenshot as evidence.

- [ ] **Step 9: Commit**

```bash
git add agents/contract-review-demo.html
git commit -m "Wire contract agent to shared/model-client.js (model-policy v2)"
```

---

## Task 7: Update README

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: nothing (documentation only). Last task.

- [ ] **Step 1: Update the "What's here" file listing**

Find the `agents/` bullet list in the "What's here" section and, after the existing `templates/` section, add a new bullet block:
```
config/
- model-policy.json — non-secret, repo-committed model routing defaults and safety policy (per-agent provider/model/token/temperature, allowed providers, and the no-cloud-fallback/no-model-computed-pay tripwires)

shared/
- model-client.js — settings (localStorage, versioned), policy loading, config resolution, and dispatch, imported by all three agents as an ES module
- providers/anthropic.js, providers/ollama.js — pure request/response adapters for each provider
- schemas/ — JSON Schema documentation for the model-policy, settings, and agent-result shapes (not runtime-validated)
```

- [ ] **Step 2: Replace the Architecture notes model-routing bullet**

Find the bullet describing the Cloud/Local/Auto Settings toggle (added in the prior revision) and replace it with:
```
- Each agent has a Settings panel with three modes — Repo Defaults, Force Cloud, Force Local. Repo Defaults (the default) resolves provider, model, and per-agent token/temperature limits from the committed `config/model-policy.json`, which has no secrets in it — that file routes the payroll explainer to a local Ollama model (`llama3.1:8b`) by default while books/contract stay on cloud (`claude-sonnet-5`). Explicitly choosing Force Cloud or Force Local overrides the provider/model/endpoint from the config file, but token/temperature limits always come from it. All model-calling logic lives in `shared/model-client.js` and `shared/providers/{anthropic,ollama}.js`, imported as ES modules by each standalone agent page — nothing is duplicated per file. `config/model-policy.json` also carries safety policy: `allowedProviders` gates which providers are reachable at all, and `requireHumanApproval`/`allowExecutedActions`/`allowCloudFallback`/`payroll.modelMayCalculatePay`/`payroll.cloudFallbackAllowed` are invariants asserted at load — the app has no code path that executes actions, falls back to cloud on a local failure, or lets a model compute payroll math, so a config claiming otherwise fails the whole page loudly rather than silently misbehaving. The payroll agent specifically never auto-retries against cloud if its local call fails — it shows an explicit "start Ollama or switch modes" message instead. Every model result renders a badge showing which provider/model produced it, plus (for books/contract) which source template file was used.
```

- [ ] **Step 3: Read the updated sections back**

Confirm no remaining references to `config/model-config.json`, the old `Auto/Cloud/Local` mode names, or `callModel(prompt, configKey)` remain anywhere in `README.md`.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "Document model-policy v2 (shared client, repo-defaults/force-cloud/force-local, badges)"
```

---

## Plan Self-Review Notes

- **Spec coverage:** File layout (config/model-policy.json, shared/model-client.js, shared/providers/*, shared/schemas/*) → Tasks 1-3. Settings schema v2 + migration → Task 3 Step 1 (`loadSettings`), verified in Task 4 Step 7.6. Resolver + `mode` precedence → Task 3 Step 1 (`resolveModelConfig`), verified across Tasks 4-6's Step 7/7/8. Policy tripwires (fail-loud, whole-page replacement) → Task 3 Step 1 (`assertPolicyInvariants`), verified in Task 4 Step 7.3-7.4. `allowedProviders` gating → Task 3 Step 1 (`renderSettingsPanel`, `resolveModelConfig`'s `assertAllowed` calls). Payroll no-fallback message → Task 4 Steps 5 and 7.3-7.4. Badges (provider/model + template version) → Task 3 Step 1 (`renderResultBadge`) + Tasks 4-6 Steps 4-5/4-5/5-6. Agent-result shape (`{text, provider, model, usage}`, no `agentId`/`templateVersion`) → Task 2 (provider modules return `{text, usage}`) + Task 3's `callModel` (assembles the final shape). ES-module loading → every agent task's Step 1-2. Docs-only schemas → Task 1 Steps 3-5. README → Task 7. Deferred items (structured findings, event envelope, provenance record, full custom-mode UI) → not built anywhere in this plan, consistent with the spec's Out of Scope section.
- **Placeholder scan:** no TBD/TODO; every code step has literal, complete code; Task 4 Step 7.3's verification note is deliberately explicit about a genuine ambiguity (whether `POLICY_BLOCKED_PROVIDER` or the payroll-specific message fires when the block happens at the resolver level vs. the call level) rather than asserting a specific outcome I hadn't traced through — this is intentional, not a placeholder: the implementer must observe and report the actual behavior, and the reviewer should confirm the observed behavior matches the code's actual control flow (resolveModelConfig throws before config exists, so the catch block's `config.provider` check never runs — the generic `renderModelError` path is what should actually fire in that specific scenario; the payroll-specific message is reserved for a live connection failure, which Task 4 Step 7.4 exercises directly).
- **Type consistency:** `callModel(config, messages)` signature, provider modules' `call(config, messages)` returning `{text, usage}`, `resolveModelConfig(agentId, modelPolicy, settings)`, `renderSettingsPanel(container, modelPolicy)`, and `renderResultBadge(result, {templateVersion})` are identical across every task that defines or calls them (Task 3 defines; Tasks 4-6 call). `CONFIG_KEY` values (`payroll_explainer`, `books_review`, `contract_review`) match `config/model-policy.json`'s `agents` keys from Task 1 exactly.
