# Compliance Swarm — Model Policy v2 Design (revision)

Date: 2026-08-07
Status: Draft (supersedes `2026-08-07-model-config-design.md`)

## Purpose

This revises the just-completed config-driven model routing feature (branch
`worktree-model-config-routing`, commits `63123a7`..`7fca91f`, not yet merged
or pushed). That feature is functionally sound but structurally mixes two
things that should stay separate: user secrets/local overrides
(`localStorage`) and repo-committed non-secret routing defaults
(`config/model-config.json`). This revision:

- Splits the `localStorage` settings object into a versioned schema that
  cleanly separates cloud credentials, local-endpoint config, and per-agent
  overrides, rather than one flat `{mode, apiKey, localEndpoint, localModel}`.
- Renames and restructures the committed config to `config/model-policy.json`,
  adding an explicit `allowedProviders` list and safety-tripwire fields.
- Extracts the ~150-line duplicated model-config/settings block (currently
  copy-pasted verbatim into all three agent HTML files) into one shared
  `shared/model-client.js`, loaded via `<script src>` — reversing the
  "duplication is intentional" decision from the prior design, per explicit
  instruction this revision.
- Adds a hard guarantee, enforced in code: the payroll agent never silently
  falls back to a cloud call. If its resolved local provider is unavailable,
  the user sees an explicit inline message with next steps — nothing is
  auto-retried against Anthropic.
- Adds a migration path from the current (unreleased) settings shape, and
  visible per-result badges showing which provider/model and which source
  template produced the result.

This branch was never merged or pushed (`finishing-a-development-branch`
ended in "keep as-is" for the prior revision), so there are no real-world
users of the intermediate `mode: 'auto'/'cloud'/'local'` shape — migration
only needs to handle two cases: a fresh user (no saved settings) and a user
of the *original*, pre-this-feature app (hardcoded cloud, whatever key/shape
they had).

## File Layout

- `config/model-policy.json` (renamed from `config/model-config.json`,
  committed, non-secret) — provider/model/token/temperature defaults per
  agent, plus safety policy.
- `shared/model-client.js` (new) — the extracted shared module: settings
  load/save/migration, `loadModelPolicy()`, `resolveModelConfig(agentId,
  policy, settings)`, `callModel(config, messages)`, `renderSettingsPanel`,
  `renderModelError`, and badge rendering. One copy, not duplicated.
- Each agent HTML file (`payroll-review-demo.html`, `books-review-demo.html`,
  `contract-review-demo.html`) drops its local copy of that block and instead
  adds `<script src="../shared/model-client.js"></script>` before its own
  `<script>` tag. Each file's own script shrinks to page-specific logic plus
  the call site:
  ```js
  const config = resolveModelConfig('payroll_explainer', modelPolicy, loadSettings());
  const result = await callModel(config, messages);
  ```
- `orchestrator.html`: unchanged. It has no model-calling code today and
  doesn't gain any — each agent still `fetch()`es `config/model-policy.json`
  itself, whether opened standalone or iframed. No `postMessage` distribution
  of policy data (rejected as unnecessary: the file is small, static, and
  already fetchable per-agent with no build step).

## `config/model-policy.json`

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

`books_review` and `contract_review` now have empty override objects —
both inherit `defaults.maxTokens: 1200` / `defaults.temperature: 0.1`
uncustomized. (This drops the prior design's `contract_review.maxTokens:
1600` override; treated as intentional per the literal content given.)

No secret fields anywhere in this file — safe to be public.

## `localStorage` settings schema v2

Stored under the existing key `compliance-swarm-settings`:

```js
{
  schemaVersion: 2,
  mode: "repo-defaults", // repo-defaults | force-cloud | force-local | custom
  cloud: {
    apiKey: "",
    endpoint: "https://api.anthropic.com/v1/messages",
    model: null
  },
  local: {
    endpoint: "http://localhost:11434/api/chat",
    model: null
  },
  agentOverrides: {
    // e.g. "payroll_explainer": { provider: "ollama", model: "llama3.1:8b" }
  }
}
```

`null` on `cloud.model`/`local.model` means "inherit from
`model-policy.json`." An override is only ever written when a user
deliberately changes a field — no code path writes a non-null value except a
Settings-panel edit.

### `mode: "custom"` — resolver support only, no UI yet

The schema and `resolveModelConfig()` support `mode: "custom"` and
`agentOverrides` (settable via `localStorage`/devtools today). The Settings
panel keeps exactly three radios — Repo Defaults / Force Cloud / Force
Local — with no "Custom" option and no override-editing form. A full
per-agent override editor is out of scope for this revision.

## Resolver

`shared/model-client.js` exports (as ordinary top-level functions, no ES
module syntax needed — plain script, same convention as the rest of this
repo):

```js
function resolveModelConfig(agentId, modelPolicy, settings) {
  const base = {
    ...modelPolicy.defaults,
    ...(modelPolicy.agents?.[agentId] || {})
  };

  if (settings.mode === "force-cloud") {
    assertAllowed("anthropic", modelPolicy);
    return {
      ...base,
      provider: "anthropic",
      endpoint: settings.cloud.endpoint,
      model: settings.cloud.model || base.model,
      apiKey: settings.cloud.apiKey
    };
  }

  if (settings.mode === "force-local") {
    assertAllowed("ollama", modelPolicy);
    return {
      ...base,
      provider: "ollama",
      endpoint: settings.local.endpoint,
      model: settings.local.model || base.model
    };
  }

  if (settings.mode === "custom" && settings.agentOverrides?.[agentId]) {
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
      base.provider === "ollama"
        ? (base.endpoint || settings.local.endpoint)
        : (base.endpoint || settings.cloud.endpoint)
  };
}

function assertAllowed(provider, modelPolicy) {
  if (!modelPolicy.policy.allowedProviders.includes(provider)) {
    throw new Error(`POLICY_BLOCKED_PROVIDER: ${provider}`);
  }
}
```

`maxTokens`/`temperature` come from `base` (i.e. from `model-policy.json`,
merged defaults→agent-override) in every mode — matching the prior design's
invariant that these are per-call-site properties, not a provider choice.
Only `provider`/`model`/`endpoint`/`apiKey` vary by `mode`.

`callModel(config, messages)` takes the fully-resolved config object
(not `(prompt, configKey)` as before) and dispatches to the Anthropic or
Ollama request shape based on `config.provider`, reading `config.maxTokens`/
`config.temperature`/`config.model`/`config.endpoint`/`config.apiKey` — no
`loadSettings()`/`resolveModelConfig()` calls inside `callModel` itself
anymore; the caller resolves first and passes the plain object. This makes
`callModel` a pure function of its input, testable independent of
`localStorage`/`fetch`-config-loading.

## Policy invariants — load-time tripwires

At load, immediately after fetching `config/model-policy.json`, assert:

- `policy.requireHumanApproval === true`
- `policy.allowExecutedActions === false`
- `policy.allowCloudFallback === false`
- `policy.payroll.cloudFallbackAllowed === false`
- `policy.payroll.modelMayCalculatePay === false`

Any violation throws and the page replaces its entire body with a
"Configuration error: ..." message — unchanged mechanism from the prior
design, extended to the three new fields. These three new fields are
tripwires, not runtime-branched behavior: **no code path in this app
implements cloud-fallback-on-local-failure or model-computed payroll math at
all**, so a config claiming otherwise would be describing behavior the code
doesn't have. `allowedProviders` is different — it IS actively branched on
(see Resolver above and Settings-panel gating below), not just asserted.

## Payroll safety: no silent cloud fallback

`resolveModelConfig('payroll_explainer', ...)` in `repo-defaults` mode
resolves to `provider: 'ollama'` and stays there — there is no retry, no
"if ollama fails, try anthropic instead" logic anywhere in `callModel` or
its callers. If the Ollama request fails (connection refused, non-2xx,
etc.), the payroll agent's Explain button shows, inline, next to that row:

> Local payroll explainer is unavailable. Start Ollama, choose Force Cloud,
> or choose another local endpoint.

This replaces the prior design's generic "Local call failed: ..." message
for this specific agent/provider combination (other agents/providers keep
the existing generic error messages — this one is payroll+ollama-specific
because it's the case the policy explicitly calls out).

## `allowedProviders` gating (replaces `allowCloud`/`allowLocal`)

- Settings panel: the Force Cloud radio renders only if
  `policy.allowedProviders.includes('anthropic')`; Force Local only if it
  includes `'ollama'`. Repo Defaults always renders (its actual resolved
  provider is per-agent, gated at the `resolveModelConfig` level instead).
- `resolveModelConfig` throws `POLICY_BLOCKED_PROVIDER: <provider>` if the
  resolved provider isn't in `allowedProviders`, for every mode — including
  `repo-defaults`, in case a future `model-policy.json` names a provider for
  an agent that the same file's own `allowedProviders` doesn't permit
  (a self-inconsistent config, caught the same way a stale-`localStorage`
  case would be).

## Badges

Every agent result (the Explain / AI-Suggest / Explain-and-redline output)
renders a badge next to it:

- `Local · llama3.1:8b` or `Cloud · claude-sonnet-5` — from the resolved
  `config.provider`/`config.model` that actually produced this result.
- A second badge showing the source template's identity: for the books
  agent, which chart-of-accounts file was loaded (`service-business-coa.csv`
  or `retail-business-coa.csv`); for the contract agent, the clause-library
  file it parsed (`red-flag-clause-library.md`, no per-file versioning
  exists in this repo today, so the badge shows the filename — a real
  version/commit-hash badge would need the file itself to carry a version
  marker, out of scope for this revision to add); for payroll, no separate
  "template" exists (the minimum-wage table is inline JS, not a fetched
  file) — the payroll agent shows only the provider/model badge, not a
  second template badge.

## Migration

`shared/model-client.js`'s settings loader, on read:

- No `compliance-swarm-settings` key in `localStorage` at all → fresh
  schema-v2 object, `mode: "repo-defaults"`.
- A `compliance-swarm-settings` key exists but has no `schemaVersion` field
  (i.e., predates this feature entirely, or is the intermediate branch
  shape) → migrate to schema v2 with `mode: "force-cloud"`, carrying over
  `apiKey`→`cloud.apiKey` and `localEndpoint`/`localModel`→
  `local.endpoint`/`local.model` where present, `cloud.model: null`
  (inherit), and re-save immediately in the new shape.
- `schemaVersion === 2` already → use as-is.

## Testing / verification

Same approach as the prior design: no automated test framework in this
repo. Verification = real headless-browser interaction (the cached
Playwright Chromium already used successfully in the prior implementation),
exercising: fresh-user default (`repo-defaults`), migrated-user default
(`force-cloud`, old values preserved), each mode's resolved
provider/model/endpoint/tokens/temperature via intercepted network request
bodies, the `POLICY_BLOCKED_PROVIDER` and other tripwire error paths, the
payroll-specific no-fallback message, and badge content matching the actual
resolved config per result.

## Out of scope

- Full `mode: "custom"` Settings-panel UI (override editor).
- `orchestrator.html` gaining any model-policy-aware code.
- Real version/commit-hash tracking for template files (clause library, CoA
  CSVs) — the template badge shows filename only.
- Changing `templates/` content itself.
