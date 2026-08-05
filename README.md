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
- orchestrator.html — All three wired into one app with a shared approval queue

templates/
- chart_of_accounts/ — CoA templates matching the books agent's category taxonomy
- payroll_checklists/ — Pre-payroll compliance checklist
- contract_clause_library/ — Red-flag clause reference library (the contract agent's prompt should be seeded from this file, not hardcoded inline)

## Architecture notes

- Payroll math is deterministic, not LLM-generated. Gross pay, overtime, and flag thresholds are computed in plain JS. The model is only called afterward, and only on already-flagged lines, to explain them in plain language. This is the highest-liability agent in the swarm — the arithmetic never touches the model.
- The orchestrator has a Cloud/Local model toggle. Default points at `https://api.anthropic.com/v1/messages` for cloud demos; switching to Local points at a configurable Ollama-style endpoint (`http://localhost:11434/api/chat` by default). Both paths flow through one `callModel()` function per agent.
- The templates are the actual sellable IP. The code will commoditize faster than the curated clause library and chart-of-accounts mappings will. Treat those as the product.

## Before deploying anywhere outside Claude's artifact sandbox

The demo HTML files call `http://api.anthropic.com` directly from client-side JS with no API key present in the code. That only works inside Claude.ai's artifact environment, which injects auth automatically. If you host these files elsewhere (GitHub Pages, a static host, etc.), that fetch will simply fail — which is the safe, correct behavior.

Do not embed a real Anthropic API key into this client-side JS to make it work standalone. A key shipped in browser-served JS is public the moment it's deployed, full stop. The production path is a small backend proxy that holds the key server-side and the frontend calls that — never the key living in a file a browser downloads.

## Status

Prototype stage. Not legal, tax, or accounting advice. Every agent's output needs human review before being acted on.
