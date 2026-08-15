// shared/agent-common.js
// Cross-page helpers shared by the agent demo pages: HTML-escaping for
// interpolated user content, and the postMessage protocol used to flag
// review items up to the orchestrator (OfficeSnap) and receive decisions
// back down when embedded in its iframe. Messages are restricted to same-
// origin senders/targets since every agent page is only ever embedded by
// orchestrator.html served from this same app.

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function notifyParentIfEmbedded(agentId, item) {
  if (window.self === window.top) return;
  window.parent.postMessage({ type: 'swarm-flag', agentId, itemId: item.id, summary: item.summary }, window.location.origin);
}

export function listenForDecisions(onDecision) {
  window.addEventListener('message', e => {
    if (e.origin !== window.location.origin) return;
    if (e.data && e.data.type === 'swarm-decision') {
      onDecision(e.data.itemId, e.data.decision);
    }
  });
}
