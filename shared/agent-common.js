// shared/agent-common.js
// Cross-page helpers shared by the agent demo pages: HTML-escaping for
// interpolated user content, and the postMessage protocol used to flag
// review items up to the orchestrator (OfficeSnap) and receive decisions
// back down when embedded in its iframe.

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function notifyParentIfEmbedded(agentId, item) {
  if (window.self === window.top) return;
  window.parent.postMessage({ type: 'swarm-flag', agentId, itemId: item.id, summary: item.summary }, '*');
}

export function listenForDecisions(onDecision) {
  window.addEventListener('message', e => {
    if (e.data && e.data.type === 'swarm-decision') {
      onDecision(e.data.itemId, e.data.decision);
    }
  });
}
