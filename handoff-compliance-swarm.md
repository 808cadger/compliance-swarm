# Handoff — compliance-swarm

Repo: `github.com/808cadger/compliance-swarm`, branch `main`. Local checkout: `/home/cadger/compliance-swarm`.

## Done (this session, 2026-08-14/15)

A prior session had reportedly done 3 commits (CSS/JS dedup, CSV/contract XSS fixes, settings-panel
XSS + postMessage origin lock) and left a `compliance-swarm-updates.patch` + this handoff doc for a
follow-up session to apply. Neither file existed on this machine and the repo had no unpushed commits
or other branches — that prior session's sandbox never persisted its work anywhere reachable from here.
Rather than guess at lost content, this session re-implemented the same 3 fixes from scratch against
current `main`, then did the follow-up CSP work. Four commits landed and pushed to `origin/main`:

1. **`d4c7294` — Dedup shared CSS/JS across agent demo pages**
   `payroll-review-demo.html`, `books-review-demo.html`, `contract-review-demo.html` carried a
   byte-identical `<style>` block and duplicated `notifyParentIfEmbedded`/`listenForDecisions`
   functions; `books`/`contract` also duplicated `escapeHtml`, as did `field-capture-demo.html` and
   `shelf-snap-demo.html` (different one-liner, same logic). Centralized into
   `shared/agent-common.css` and `shared/agent-common.js`; all 5 pages now import/link from there.

2. **`be7d40c` — Fix XSS in CSV/contract rendering**
   Payroll (`row.employee`/`classification`/`state`) and Books (`txn.date`/`description`) rendered
   user-pasted CSV fields straight into `innerHTML` with no escaping. Contract Review's
   `highlightMatch` did the same with user-pasted contract text before wrapping the regex match in
   `<mark>`. All three now escape via `escapeHtml` from `shared/agent-common.js`; `highlightMatch`
   escapes the before/matched/after segments individually so the `<mark>` highlight around the actual
   match is preserved.

3. **`81fefda` — Fix XSS in settings panel + lock postMessage origin**
   `renderSettingsPanel` (`shared/model-client.js`) interpolated stored API key / endpoint / model
   strings into `value="..."` attributes unescaped — a value like `"><script>...` typed into any
   settings field would persist to `localStorage` and execute on next render. Fixed with `escapeHtml`.
   Separately, the `swarm-flag`/`swarm-decision` postMessage protocol between each agent page and
   `orchestrator.html` used target origin `'*'` and never checked `event.origin`. Every agent page is
   only ever embedded by `orchestrator.html` on the same origin, so both sides (in
   `shared/agent-common.js` and `orchestrator.html`) now use `window.location.origin`.

4. **`99e0c00` — Extract inline scripts to external files, add CSP to all 6 agent pages**
   Every agent page's inline `<script type="module">` (orchestrator.html: two plain `<script>`
   blocks, merged) is now an external `.js` file next to its `.html` (e.g.
   `agents/payroll-review-demo.js`), loaded via `src=`. Pure structural move — same code, same
   import paths, same execution order. Each page now has
   `<meta http-equiv="Content-Security-Policy" content="script-src 'self'">`.

**Verification**: all 4 commits were checked in real headless Chromium (Playwright's cached
`chromium-1228` binary, served over `python3 -m http.server` — these pages require `http://`, not
`file://`, to fetch templates/config), not just read: loaded all 6 pages and confirmed no console
errors; fired actual `<img src=x onerror=alert(1)>` payloads through the payroll/books CSV loaders,
the contract textarea, and the settings endpoint field and confirmed no alert fired and no raw tag
landed in the DOM; confirmed `<mark>` highlighting still renders correctly post-escaping; drove the
orchestrator's full approve-decision round trip through the origin-locked postMessage listener and
confirmed the iframe's badge still updates; and actively injected a `<script>` element after CSP was
added and confirmed Chrome blocks it with a CSP console violation, proving the policy is truly in
effect (not just present and inert).

## Known open items

Carried over from before this session (see `docs/superpowers/specs|plans/*`), not touched here:
- Structured findings output shape, a versioned postMessage event envelope, and a provenance record
  shape — explicitly scoped out of model-policy v2.
- A full custom-mode Settings UI (the `custom` mode exists in `resolveModelConfig` but has no editor).
- ShelfSnap is Stage 1 of 5 planned stages (no automatic visual detection, no item-catalog editing, no
  reorder/notification logic).

New, surfaced by this session's CSP work:
- The CSP only restricts `script-src`. Inline `<style>` blocks (small page-specific residuals in
  Books/Contract) and inline `style="..."` attributes (used throughout for things like
  `display:none` toggles and error banners) still rely on the browser's default permissive behavior
  for `style-src` — no `unsafe-inline` is declared because no `style-src` directive exists at all.
  Locking that down too would need either externalizing those styles or a nonce/hash scheme.
- `connect-src` is deliberately left unrestricted: Payroll/Books/Contract's "AI Suggest"/"Explain"
  buttons call `config.endpoint`, which is a user-configurable URL (Anthropic's API, or any Ollama
  endpoint the user points Settings at). A locked-down `connect-src` would break Force Cloud/Force
  Local for any endpoint other than same-origin.
- Every page 404s on `/favicon.ico` in dev (no favicon exists in the repo) — cosmetic, unrelated to
  this session's work, left alone.
