# Compliance-Proof Agent Swarm for Small Business

Local-first agents for books, payroll, and contract review — built for small businesses
that can't afford a back office and shouldn't have to hand their data to a SaaS vendor
to get one.

**Core design principle: agents propose, humans approve.** Every agent produces a
worksheet, a flag, or a suggested fix — never an executed action. Nothing here files a
tax form, moves money, or signs anything. That's what makes this legally and practically
different from an "AI back office" SaaS product.

## What's here

agents/
- contract-review-demo.html — Standalone contract review agent
- books-review-demo.html — Standalone bookkeeping/categorization agent
- payroll-review-demo.html — Standalone payroll worksheet agent
- field-capture-demo.html (FieldSnap) — On-device photo capture of receipts/invoices/tags/job-progress/safety forms, handed off as a needs_review item; never uploads images
- shelf-snap-demo.html (ShelfSnap) — Owner-configured shelf profiles plus worker-driven shelf photo capture, handed off as a needs_review item; never uploads images
- orchestrator.html (OfficeSnap) — All agents wired into one app with a Unified Inbox: a shared approval queue for Payroll/Books/Contract, plus separate FieldSnap and ShelfSnap paperwork lanes

templates/
- chart_of_accounts/ — CoA templates matching the books agent's category taxonomy
- payroll_checklists/ — Pre-payroll compliance checklist
- contract_clause_library/ — Red-flag clause reference library (the contract agent's prompt should be seeded from this file, not hardcoded inline)

config/
- model-policy.json — non-secret, repo-committed model routing defaults and safety policy (per-agent provider/model/token/temperature, allowed providers, and the no-cloud-fallback/no-model-computed-pay tripwires)

shared/
- model-client.js — settings (localStorage, versioned), policy loading, config resolution, and dispatch, imported by all three agents as an ES module
- providers/anthropic.js, providers/ollama.js — pure request/response adapters for each provider
- schemas/ — JSON Schema documentation for the model-policy, settings, and agent-result shapes (not runtime-validated)

## Architecture notes

- Payroll math is deterministic, not LLM-generated. Gross pay, overtime, and flag thresholds are computed in plain JS. The model is only called afterward, and only on already-flagged lines, to explain them in plain language. This is the highest-liability agent in the swarm — the arithmetic never touches the model.
- Each agent has a Settings panel with three modes — Repo Defaults, Force Cloud, Force Local. Repo Defaults (the default) resolves provider, model, and per-agent token/temperature limits from the committed `config/model-policy.json`, which has no secrets in it — that file routes the payroll explainer to a local Ollama model (`llama3.1:8b`) by default while books/contract stay on cloud (`claude-sonnet-5`). Explicitly choosing Force Cloud or Force Local overrides the provider/model/endpoint from the config file, but token/temperature limits always come from it. All model-calling logic lives in `shared/model-client.js` and `shared/providers/{anthropic,ollama}.js`, imported as ES modules by each standalone agent page — nothing is duplicated per file. `config/model-policy.json` also carries safety policy: `allowedProviders` gates which providers are reachable at all, and `requireHumanApproval`/`allowExecutedActions`/`allowCloudFallback`/`payroll.modelMayCalculatePay`/`payroll.cloudFallbackAllowed` are invariants asserted at load — the app has no code path that executes actions, falls back to cloud on a local failure, or lets a model compute payroll math, so a config claiming otherwise fails the whole page loudly rather than silently misbehaving. The payroll agent specifically never auto-retries against cloud if its local call fails — it shows an explicit "start Ollama or switch modes" message instead. Every model result renders a badge showing which provider/model produced it, plus (for books/contract) which source template file was used.
- The templates are the actual sellable IP. The code will commoditize faster than the curated clause library and chart-of-accounts mappings will. Treat those as the product.

## Before deploying anywhere outside a trusted/local environment

Each agent has a Settings panel where you paste your own Cloud (Anthropic) API key, or point at
a Local (Ollama-style) endpoint instead. Whichever you choose is stored only in that browser's
`localStorage` and sent directly to the model endpoint from client-side JS — there's no backend
and no proxy in front of it. That means this mechanism works from wherever the files are hosted
(GitHub Pages, any static host, opened locally), not just inside a sandboxed environment.

Do not embed a real Anthropic API key into this client-side JS source to make it work by default.
A key shipped in browser-served JS is public the moment it's deployed, full stop. (This app never
does that — the Settings panel is the only place a real key is entered, by the user, into their
own browser.) The production-safe path for a hosted deployment is still a small backend proxy
that holds the key server-side, with the frontend calling that instead of storing a real key in
the browser.

Understand the tradeoff before hosting this publicly: once a real key is pasted into Settings, it
lives in `localStorage` on whatever origin serves these files, for as long as that entry persists.
Treat it like any other client-side-stored credential. The unescaped-`innerHTML` rendering used
elsewhere in this app (accepted as low-risk in a local/trusted context) becomes a more meaningful
risk on a public host with a real key stored, since anything that can run script on that origin
can read `localStorage`.

## Status

Prototype stage. Not legal, tax, or accounting advice. Every agent's output needs human review before being acted on.
