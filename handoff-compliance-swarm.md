# Handoff — compliance-swarm

Repo: `github.com/808cadger/compliance-swarm`, branch `main`. Local checkout: `/home/cadger/compliance-swarm`.

## What shipped

5 commits on `main`, pushed to `origin/main` (2026-08-14/15):

| Commit | What |
|---|---|
| `d4c7294` | Dedup shared CSS/JS across agent demo pages |
| `be7d40c` | Fix XSS in CSV/contract rendering |
| `81fefda` | Fix XSS in settings panel + lock postMessage origin |
| `99e0c00` | Extract inline scripts to external files, add CSP to all 6 agent pages |
| `ca7bad6` | Add this handoff doc |

The 6 agent pages referenced throughout: `payroll-review-demo`, `books-review-demo`,
`contract-review-demo`, `field-capture-demo`, `shelf-snap-demo`, `orchestrator` (all under `agents/`).

### `d4c7294` — Dedup shared CSS/JS
`payroll-review-demo.html`, `books-review-demo.html`, `contract-review-demo.html` carried a
byte-identical `<style>` block and duplicated `notifyParentIfEmbedded`/`listenForDecisions`
functions; `books`/`contract` also duplicated `escapeHtml`, as did `field-capture-demo.html` and
`shelf-snap-demo.html` (different one-liner, same logic). Centralized into `shared/agent-common.css`
and `shared/agent-common.js`; all 5 pages now import/link from there.

### `be7d40c` — Fix XSS in CSV/contract rendering
Payroll (`row.employee`/`classification`/`state`) and Books (`txn.date`/`description`) rendered
user-pasted CSV fields straight into `innerHTML` with no escaping. Contract Review's
`highlightMatch` did the same with user-pasted contract text before wrapping the regex match in
`<mark>`. All three now escape via `escapeHtml` from `shared/agent-common.js`; `highlightMatch`
escapes the before/matched/after segments individually so the `<mark>` highlight around the actual
match is preserved.

### `81fefda` — Fix XSS in settings panel + lock postMessage origin
`renderSettingsPanel` (`shared/model-client.js`) interpolated stored API key / endpoint / model
strings into `value="..."` attributes unescaped — a value like `"><script>...` typed into any
settings field would persist to `localStorage` and execute on next render. Fixed with `escapeHtml`.
Separately, the `swarm-flag`/`swarm-decision` postMessage protocol between each agent page and
`orchestrator.html` used target origin `'*'` and never checked `event.origin`. Every agent page is
only ever embedded by `orchestrator.html` on the same origin, so both sides (in
`shared/agent-common.js` and `orchestrator.html`) now use `window.location.origin`.

### `99e0c00` — Extract inline scripts, add CSP
Every agent page's inline `<script type="module">` (orchestrator.html: two plain `<script>` blocks,
merged) is now an external `.js` file next to its `.html` (e.g. `agents/payroll-review-demo.js`),
loaded via `src=`. Pure structural move — same code, same import paths, same execution order. Each
page now has `<meta http-equiv="Content-Security-Policy" content="script-src 'self'">`.

This is a **meta-tag CSP, not a server header** — there's no backend serving these files, just
static hosting. That means no `frame-ancestors` (meta-tag CSP can't set it; browsers ignore it if
present), no report-only mode for testing changes safely, and no way to add security headers like
`X-Frame-Options` alongside it. If this ever moves behind a real server/CDN, moving the policy to a
response header would remove those limitations and let `frame-ancestors` be added.

## Verification

All 4 code commits were checked in real headless Chromium (Playwright's cached `chromium-1228`
binary, served over `python3 -m http.server` — these pages require `http://`, not `file://`, to
fetch templates/config), not just read:
- Loaded all 6 pages, confirmed no console errors.
- Fired actual `<img src=x onerror=alert(1)>` payloads through the payroll/books CSV loaders, the
  contract textarea, and the settings endpoint field — confirmed no alert fired and no raw tag
  landed in the DOM.
- Confirmed `<mark>` highlighting still renders correctly post-escaping.
- Drove the orchestrator's full approve-decision round trip through the origin-locked postMessage
  listener, confirmed the iframe's badge still updates.
- Actively injected a `<script>` element after CSP was added and confirmed Chrome blocks it with a
  CSP console violation — proving the policy is truly in effect, not just present and inert.

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
- No `frame-ancestors` protection (see meta-tag-CSP limitation above) — if this app is ever meant to
  resist being iframed by an unrelated site, that needs a server header, not this meta tag.
- Every page 404s on `/favicon.ico` in dev (no favicon exists in the repo) — cosmetic, unrelated to
  this session's work, left alone.
