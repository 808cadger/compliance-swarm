const ROLE_LABELS = {
  owner_admin: 'Owner / Executive',
  supervisor: 'Foreman',
  field_worker: 'Field Worker',
  accounting: 'Accounting',
};
const STATUS_LABELS = {
  allow: 'Access granted',
  step_up_required: 'Verification required',
  deny: 'Restricted',
};

let pendingStartKey = null;
const demoStepUpPin = sessionStorage.getItem('pp:stepUpPin');

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function load() {
  const raw = sessionStorage.getItem('pp:lastResult');
  sessionStorage.removeItem('pp:lastResult');
  let seedDeny = null;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed.decision === 'deny') seedDeny = parsed;
    } catch { /* ignore malformed session storage */ }
  }
  if (seedDeny) {
    renderDeny(seedDeny.safeUserMessage);
    return;
  }

  const res = await fetch('/api/processpass/processes');
  if (!res.ok) {
    renderDeny('We could not grant Process access.');
    return;
  }
  const data = await res.json();
  renderAllow(data);
}

function renderDeny(message) {
  const card = document.getElementById('card');
  card.innerHTML = '';
  const panel = el('div', 'pp-deny-panel');
  panel.append(
    el('h1', null, message || 'We could not grant Process access.'),
    el('p', 'pp-sub', 'This device has no way to confirm who you are. No account details are shown, and this attempt has been recorded.'),
  );
  const actions = el('div', null);
  actions.style.cssText = 'display:flex; gap:0.75rem; justify-content:center; margin-top:1.25rem; flex-wrap:wrap;';
  const signIn = el('a', 'pp-btn pp-btn-primary', 'Use secure sign-in');
  signIn.href = '/login';
  signIn.style.cssText = 'text-decoration:none; width:auto; padding-left:1.5rem; padding-right:1.5rem;';
  const tryAgain = el('a', 'pp-btn pp-btn-secondary', 'Try again');
  tryAgain.href = '/processpass';
  tryAgain.style.cssText = 'text-decoration:none; width:auto; padding-left:1.5rem; padding-right:1.5rem;';
  actions.append(signIn, tryAgain);
  panel.appendChild(actions);
  card.appendChild(panel);
  document.getElementById('footerNote').textContent = 'Unknown or unrecognized visitors never see tenant, role, or Process data.';
}

function renderAllow(data) {
  document.getElementById('signOutBtn').style.display = 'inline';
  const card = document.getElementById('card');
  card.innerHTML = '';

  const welcome = el('div', 'pp-welcome');
  welcome.appendChild(el('h1', null, `Welcome, ${data.displayName}`));
  if (data.assuranceLevel === 'demo') {
    const badge = el('span', 'pp-demo-badge', '⚠ Demo Mode — simulated identity');
    badge.style.marginTop = '0.35rem';
    welcome.appendChild(badge);
  }
  card.appendChild(welcome);

  const context = el('div', 'pp-context');
  context.appendChild(el('div', 'pp-context-row', `${ROLE_LABELS[data.role] || data.role} · ${data.tenantName}`));
  if (data.assignedSites?.length) {
    context.appendChild(el('div', 'pp-context-row', `Assigned job sites: ${data.assignedSites.join(', ')}`));
  }
  card.appendChild(context);

  card.appendChild(el('h2', null, 'Your authorized Processes'));
  const explain = el('p', 'pp-sub', 'Access is based on your role, assignments, and current policy.');
  explain.style.marginBottom = '1.25rem';
  card.appendChild(explain);

  const grid = el('div', 'pp-process-grid');
  if (!data.processes.length) {
    grid.appendChild(el('p', 'pp-msg pp-msg-muted', 'No Processes are mapped to your role yet.'));
  }
  for (const p of data.processes) {
    grid.appendChild(renderProcessCard(p));
  }
  card.appendChild(grid);

  document.getElementById('footerNote').textContent =
    'Every Process open and every access decision above is recorded in the audit trail.';
}

function renderProcessCard(p) {
  const card = el('div', 'pp-process-card');
  card.appendChild(el('h3', null, p.name));
  card.appendChild(el('p', null, p.purpose));

  const status = el('span', `pp-status pp-status-${p.decision}`, STATUS_LABELS[p.decision] || p.decision);
  card.appendChild(status);

  if (p.decision !== 'allow') {
    card.appendChild(el('p', null, p.safeUserMessage));
  }

  const startBtn = el('button', 'pp-btn pp-btn-primary',
    p.decision === 'step_up_required' ? 'Verify & Start' : (p.decision === 'allow' ? 'Start Process' : 'Restricted'));
  startBtn.style.cssText = 'padding:0.6rem 1rem; font-size:0.9rem;';
  startBtn.disabled = p.decision === 'deny';
  startBtn.addEventListener('click', () => startProcess(p.processKey));
  card.appendChild(startBtn);

  const whyBtn = el('button', 'pp-btn-ghost', 'Why do I have access?');
  const whyDetail = el('div', 'pp-why-detail');
  whyBtn.addEventListener('click', () => toggleWhy(p.processKey, whyDetail));
  card.append(whyBtn, whyDetail);

  return card;
}

async function toggleWhy(processKey, detailEl) {
  if (detailEl.classList.contains('pp-open')) {
    detailEl.classList.remove('pp-open');
    return;
  }
  detailEl.textContent = 'Loading…';
  detailEl.classList.add('pp-open');
  const res = await fetch(`/api/processpass/processes/${encodeURIComponent(processKey)}/why`);
  const data = await res.json();
  detailEl.innerHTML = '';
  detailEl.appendChild(el('div', null, data.safeUserMessage));
  if (data.reasons?.length) {
    const list = el('ul');
    for (const r of data.reasons) list.appendChild(el('li', null, reasonLabel(r)));
    detailEl.appendChild(list);
  }
}

function reasonLabel(reason) {
  return {
    role_allows_process: 'Your role includes this Process.',
    assigned_to_site: 'You are assigned to a relevant job site.',
  }[reason] || reason;
}

async function startProcess(processKey) {
  const res = await fetch(`/api/processpass/processes/${encodeURIComponent(processKey)}/start`, { method: 'POST' });
  if (res.ok) {
    const { startUrl } = await res.json();
    window.location.href = startUrl;
    return;
  }
  const body = await res.json().catch(() => ({}));
  if (body?.error?.code === 'step_up_required') {
    pendingStartKey = processKey;
    openStepUpModal();
    return;
  }
  alert(body?.error?.message || 'This Process is not available right now.');
}

function openStepUpModal() {
  document.getElementById('stepUpErr').textContent = '';
  document.getElementById('stepUpPin').value = '';
  document.getElementById('stepUpHint').textContent = demoStepUpPin
    ? `Demo mode: your one-time code for this session is ${demoStepUpPin} — a real deployment would send this to your device instead of showing it here.`
    : 'Demo mode: no one-time code is available for this session — sign out and verify again through the kiosk.';
  document.getElementById('stepUpBackdrop').classList.add('pp-open');
  document.getElementById('stepUpPin').focus();
}
function closeStepUpModal() {
  document.getElementById('stepUpBackdrop').classList.remove('pp-open');
  pendingStartKey = null;
}

document.getElementById('stepUpCancel').addEventListener('click', closeStepUpModal);
document.getElementById('stepUpConfirm').addEventListener('click', async () => {
  const pin = document.getElementById('stepUpPin').value.trim();
  const res = await fetch('/api/processpass/step-up', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }),
  });
  if (!res.ok) {
    document.getElementById('stepUpErr').textContent = 'Incorrect PIN.';
    return;
  }
  const key = pendingStartKey;
  closeStepUpModal();
  if (key) await startProcess(key);
});

document.getElementById('signOutBtn').addEventListener('click', async () => {
  await fetch('/api/processpass/session/end', { method: 'POST' });
  sessionStorage.removeItem('pp:stepUpPin');
  window.location.href = '/processpass';
});

load();
