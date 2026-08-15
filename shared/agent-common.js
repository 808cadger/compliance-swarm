// shared/agent-common.js
// Cross-page helpers shared by the agent demo pages: HTML-escaping for
// interpolated user content, the common Finding record shape, and the
// versioned postMessage envelope used to flag review items up to the
// orchestrator (OfficeSnap) and receive decisions back down when embedded
// in its iframe. Messages are restricted to same-origin senders/targets
// since every agent page is only ever embedded by orchestrator.html served
// from this same app.

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function createFinding({ agentId, severity, title, evidence, reference, suggestedQuestion }) {
  return {
    schemaVersion: 1,
    id: `finding_${crypto.randomUUID()}`,
    agentId,
    severity,
    status: 'open',
    title,
    evidence,
    reference,
    suggestedQuestion,
    createdAt: new Date().toISOString(),
    provenance: { policyVersion: null, modelProvider: null, modelName: null }
  };
}

export function notifyParentIfEmbedded(finding) {
  if (window.self === window.top) return;
  window.parent.postMessage(
    { version: 1, type: 'compliance-swarm:flag-created', agentId: finding.agentId, payload: finding },
    window.location.origin
  );
}

export function listenForDecisions(onDecision) {
  window.addEventListener('message', e => {
    if (e.origin !== window.location.origin) return;
    if (e.data?.type === 'compliance-swarm:decision-made') {
      onDecision(e.data.payload.itemId, e.data.payload.decision);
    }
  });
}
