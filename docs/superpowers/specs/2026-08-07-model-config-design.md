# Compliance Swarm — Config-Driven Model Routing Design

Date: 2026-08-07
Status: Approved

## Purpose

Today, model provider/model choice is a single global setting (`compliance-swarm-settings` in
`localStorage`, shared across all three agents): a Cloud/Local radio, a cloud API key, and a
local endpoint/model. All three agents use the same choice, and the model name is hardcoded
(`claude-sonnet-5`) regardless of which agent is calling.

This adds a committed, non-secret config file that gives each agent's model call site its own
default provider/model/token/temperature settings — in particular, letting the payroll agent's
"Explain" feature default to a local model (`llama3.1:8b` via Ollama) while books/contract stay
on cloud (`claude-sonnet-5`) — without removing the existing per-browser Settings panel override.

## Architecture

- New file: `config/model-config.json`, committed to git. Contains **no secrets** — provider
  names, model names, endpoints (for the ollama default only — no key), token limits,
  temperature, and policy flags. Safe to be public if this repo is ever hosted (GitHub Pages).
- Loaded via `fetch('../config/model-config.json')` in each agent file, matching the existing
  pattern already used for `../templates/chart_of_accounts/*.csv` and
  `../templates/contract_clause_library/red-flag-clause-library.md`. Per the existing agent-demos
  spec, these agents already require running via a local static server (`file://` does not work
  for sibling-file `fetch()`), so this introduces no new deployment constraint.
- Shape:

```json
{
  "version": 1,
  "defaults": { "provider": "anthropic", "model": "claude-sonnet-5", "maxTokens": 1200, "temperature": 0.1 },
  "agents": {
    "books_review":     { "maxTokens": 1200, "temperature": 0 },
    "contract_review":  { "maxTokens": 1600, "temperature": 0 },
    "payroll_explainer": { "provider": "ollama", "endpoint": "http://localhost:11434/api/chat", "model": "llama3.1:8b", "maxTokens": 700, "temperature": 0 }
  },
  "policy": { "allowCloud": true, "allowLocal": true, "requireHumanApproval": true, "allowExecutedActions": false }
}
```

## `resolveModelConfig(configKey)` — added to each agent file

Each agent gets a new `CONFIG_KEY` constant, distinct from the existing `AGENT_ID` (which stays
unchanged — it's the orchestrator `postMessage` protocol identifier, unrelated to model config):

| File | `AGENT_ID` (unchanged) | new `CONFIG_KEY` |
|---|---|---|
| `books-review-demo.html` | `'books'` | `'books_review'` |
| `contract-review-demo.html` | `'contract'` | `'contract_review'` |
| `payroll-review-demo.html` | `'payroll'` | `'payroll_explainer'` |

`resolveModelConfig(configKey)` merges field-by-field:

1. `modelConfig.defaults`
2. `modelConfig.agents[configKey]` (overrides individual fields only — e.g. `books_review` only
   overrides `maxTokens`/`temperature`, still inheriting `provider`/`model` from `defaults`)
3. If the fetch fails or the file is missing/malformed, fall back to today's hardcoded values
   (`anthropic` / `claude-sonnet-5`, `maxTokens: 400`, no temperature override) and
   `console.warn` once. This is a network-dependent load (unlike a same-origin script tag), so
   this fallback path is expected to be exercised in practice, not just a theoretical guard.

Result: `{ provider, model, endpoint?, maxTokens, temperature }`.

## Settings panel gets a third mode: Auto

- `loadSettings()` default changes from `mode: 'cloud'` to `mode: 'auto'`.
- Settings panel radio gains a third option, **Auto (recommended)**, above Cloud/Local, selected
  by default for anyone who hasn't touched Settings before. Existing users with a saved
  `mode: 'cloud'` or `'local'` in `localStorage` are unaffected — their explicit prior choice is
  preserved as-is, no migration needed.
- `callModel(prompt)`:
  - `settings.mode === 'auto'` → use `resolveModelConfig(CONFIG_KEY)` for provider, model,
    endpoint, maxTokens, and temperature. The `anthropic` provider still needs a key —
    Auto mode reads `settings.apiKey`, which stays visible/editable in the Settings panel
    regardless of mode (the one thing `model-config.json` can never supply).
  - `settings.mode === 'cloud'` or `'local'` (explicitly chosen) → provider/model/endpoint
    choice stays exactly as today, ignoring `model-config.json` for those fields. `maxTokens`
    and `temperature` are still taken from `resolveModelConfig(CONFIG_KEY)` in all three modes
    (not just Auto) — these aren't a "which provider" decision, and default to today's
    equivalent behavior when the config is unavailable.

## Policy enforcement

At load, immediately after fetching `model-config.json`:

- `requireHumanApproval` must be `true` and `allowExecutedActions` must be `false`, or the
  script throws and blocks the page. These encode the product's core invariant ("agents
  propose, humans approve"; nothing here executes actions) — a config claiming otherwise is a
  bug, not a valid state, so this is a tripwire against future regressions rather than new
  runtime behavior.
- `allowCloud: false` → the Cloud radio is not rendered in the Settings panel; if
  `resolveModelConfig()` ever resolves to `provider: "anthropic"` anyway (e.g. stale
  `localStorage` from before the flag flipped), `callModel()` throws `POLICY_BLOCKED_CLOUD`
  instead of making the request.
- `allowLocal: false` → mirrored for the `ollama`/Local path (`POLICY_BLOCKED_LOCAL`).
- `renderModelError()` gets two new branches for these errors, following the existing
  `NO_KEY`/`NO_ENDPOINT` pattern: short inline message next to the row, no stack trace.
- With today's config values (`allowCloud: true, allowLocal: true`), none of this changes
  visible behavior.

## Data flow (payroll agent, Auto mode, representative case)

1. Page loads → `fetch('../config/model-config.json')` → policy assertion runs.
2. User flags a payroll line, clicks Explain → `callModel(prompt)` runs.
3. `loadSettings()` → `{ mode: 'auto', apiKey: '', ... }` (untouched Settings).
4. `resolveModelConfig('payroll_explainer')` → `{ provider: 'ollama', endpoint:
   'http://localhost:11434/api/chat', model: 'llama3.1:8b', maxTokens: 700, temperature: 0 }`.
5. `callModel` sees `provider: 'ollama'` → policy check passes (`allowLocal: true`) → POSTs to
   the local endpoint with those params, same request shape as today's local path.
6. On failure (Ollama not running) → same `renderModelError` UX as today
   ("Local call failed: ...").

Books/contract agents follow the same flow but resolve to `provider: 'anthropic'`, requiring
`settings.apiKey`; empty key still produces today's `NO_KEY` message.

## Testing / verification

No test framework exists for this repo (unbuilt static HTML/JS, per the existing agent-demos
spec). Verification means: serve the repo via a local static server, open each of the 3 agent
files, and confirm:

- `model-config.json` loads without console error, and Auto is the default-selected radio for a
  fresh `localStorage`.
- The payroll agent's Explain button resolves to the `ollama`/`llama3.1:8b` params in Auto mode
  (inspect the outgoing request, or temporarily log `resolveModelConfig()`'s result).
- Explicitly selecting Cloud or Local in Settings still behaves as it does today (provider/model/
  endpoint unaffected by config; maxTokens/temperature still come from config).
- Deleting/renaming `config/model-config.json` falls back to today's hardcoded defaults with a
  console warning, rather than breaking the page.
- A previously-saved `mode: 'cloud'` or `'local'` in `localStorage` (simulating an existing user)
  is preserved across a reload, not reset to Auto.

## Out of scope

- Extracting `resolveModelConfig`/`callModel`/`loadSettings` into a real shared module — stays
  duplicated per file, consistent with the existing "each agent stands alone" convention (see
  2026-08-05 spec). Worth revisiting later, not part of this change.
- Per-agent Settings-panel UI (separate API key/endpoint per agent) — Settings stays one global
  override, as today; only `model-config.json` is per-agent.
- Any change to `orchestrator.html` — it has no `callModel`/Settings code today and doesn't need
  any for this change.
