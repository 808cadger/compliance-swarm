# Compliance Swarm — Agent Demos Design

Date: 2026-08-05
Status: Approved

## Purpose

Build the three standalone agent demos (contract review, books/categorization, payroll
worksheet) and the orchestrator that combines them, per the structure already described in
`README.md`. Currently `agents/*.html` don't exist. This spec covers all four in one pass.

## Architecture

- Static, no-build local web app. Everything lives under `compliance-swarm/`; no npm, no
  bundler, no server-side code.
- Each agent (`contract-review-demo.html`, `books-review-demo.html`,
  `payroll-review-demo.html`) is a single self-contained HTML file — inline CSS and JS, no
  external CDN dependencies — and works fully standalone when opened on its own.
- `orchestrator.html` does not reimplement agent logic. It iframes the three standalone
  agent pages and adds one shared feature on top: a persisted **Approval Queue**. Agents
  post flagged items to the parent via `postMessage`; the orchestrator renders one combined
  queue and posts approve/reject decisions back down to the originating iframe. Queue state
  persists in `localStorage` so it survives reloads.
- Run via a local static file server (`python3 -m http.server` from `compliance-swarm/`),
  not by double-clicking the file. Opening via `file://` blocks `fetch()` of sibling files
  under browser CORS rules, which would break the books agent's CoA loading and the contract
  agent's clause-library loading (both need to read files from `templates/` at runtime,
  per the README's instruction not to hardcode the clause library inline).

## Shared building blocks (duplicated per file — each agent must stand alone)

- **Settings panel**: Cloud/Local toggle, Cloud API key field, Local endpoint field
  (default `http://localhost:11434/api/chat`). Persisted to `localStorage` only, never
  transmitted anywhere except the model call itself.
- **`callModel(prompt)`**: one function per file. Cloud path POSTs to
  `https://api.anthropic.com/v1/messages` using the stored key. Local path POSTs to the
  stored Ollama-style endpoint. Both paths return plain text; caller handles rendering.
- Both known failure modes are handled inline, next to the row that triggered them, not as
  a global error state:
  - No key/endpoint configured → button shows "add a key in Settings" instead of firing a
    request.
  - Request fails (network, CORS, bad key, non-2xx) → the raw error message renders inline
    next to that row.

## Payroll agent

- Deterministic core in plain JS, no model involvement: gross pay, overtime (>40 hrs/week
  at 1.5x), sub-minimum-wage check (illustrative demo rate table, explicitly labeled as
  such in the UI — matches the disclaimer already in
  `templates/payroll_checklists/pre-payroll-checklist.md`), and a 60+ hrs/week flag.
- Input: a sample timesheet CSV is preloaded on open (Employee, Classification, Hourly
  Rate, Hours Worked, State); an upload/paste control lets you replace it.
- Output: a worksheet table, flagged rows highlighted. Each flagged row has an "Explain"
  button that calls the model with only that row's data — the model never sees or touches
  the arithmetic itself, matching the README's "highest-liability agent" note.

## Books agent

- Toggle to load either shipped CoA (`service-business-coa.csv` /
  `retail-business-coa.csv`) via `fetch()`.
- Input: a sample transactions CSV (Date, Description, Amount) preloaded on open; upload/
  paste to replace it.
- Categorization: a small keyword/vendor-name heuristic dictionary matches descriptions to
  CoA categories (e.g. "Stripe"/"Square" → Bank & Merchant Fees, "AWS"/"Google Workspace" →
  Software & Subscriptions). Unmatched rows fall into "Uncategorized" and get an
  AI-suggest button (calls the model with the description + the list of available
  categories); accepting a suggestion is a manual click, never automatic.

## Contract agent

- On load, `fetch()`es `templates/contract_clause_library/red-flag-clause-library.md` and
  parses each `##` section into a structured `{name, pattern, why, fallback}` entry — the
  library file stays the single source of truth, nothing is hardcoded in the JS.
- Input: a sample contract with a few clauses deliberately written to trip known patterns,
  preloaded on open; a textarea to paste your own.
- First pass is keyword/regex matching of pasted text against each entry's pattern
  language — cheap, deterministic, no model call. Each match becomes a flagged clause with
  an "Explain + suggest redline" button that calls the model with the clause text plus the
  matching library entry as context.

## Testing / verification

No test framework exists for this (unbuilt static HTML/JS). Verification means: load each
page in a real browser via the local server, click through the golden path with the
built-in sample data, and exercise at least one edge case per agent (an unmatched
transaction in the books agent, a clean contract with no flags in the contract agent, a
60+ hour row in the payroll agent). Screenshots and/or direct browser interaction confirm
behavior — not a read-through of the code.

## Out of scope

- Persisting or exporting worksheets/approvals anywhere beyond `localStorage`.
- Real payroll tax tables, multi-state rules, or anything beyond the illustrative demo
  rates already flagged as such in the existing checklist template.
- An interactive/tracked version of the pre-payroll checklist inside the payroll agent —
  it stays a separate human reference document per the README's existing design note.
