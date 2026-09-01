let stream = null;
let stepTimers = [];
let busy = false;

function initials(name) {
  return name.split(' ').map(p => p[0]).slice(0, 2).join('').toUpperCase();
}

async function initCamera() {
  const video = document.getElementById('cameraVideo');
  const sim = document.getElementById('cameraSim');
  if (!navigator.mediaDevices?.getUserMedia) {
    await reportCameraPermission(false);
    markStepDone('camera');
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
    video.srcObject = stream;
    video.style.display = 'block';
    sim.style.display = 'none';
    await reportCameraPermission(true);
  } catch {
    // Denied, no camera, or insecure context — the polished simulated panel (already in the
    // DOM) stands in. This is not a failure state for the demo: the product still works end
    // to end on a device with no camera at all.
    await reportCameraPermission(false);
  }
  markStepDone('camera');
}

async function reportCameraPermission(granted) {
  try {
    await fetch('/api/processpass/camera-permission', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ granted }),
    });
  } catch { /* best-effort audit signal only */ }
}

function markStepDone(step) {
  const el = document.querySelector(`#steps [data-step="${step}"]`);
  if (el) { el.classList.remove('pp-step-active'); el.classList.add('pp-step-done'); }
}
function markStepActive(step) {
  const el = document.querySelector(`#steps [data-step="${step}"]`);
  if (el) el.classList.add('pp-step-active');
}
function resetSteps() {
  stepTimers.forEach(clearTimeout);
  stepTimers = [];
  document.querySelectorAll('#steps li').forEach((li, i) => {
    li.classList.remove('pp-step-active');
    if (i > 0) li.classList.remove('pp-step-done');
  });
}

function runVerificationAnimation() {
  document.getElementById('cameraRing').classList.add('pp-scanning');
  markStepActive('liveness');
  stepTimers.push(setTimeout(() => { markStepDone('liveness'); markStepActive('identity'); }, 550));
  stepTimers.push(setTimeout(() => { markStepDone('identity'); markStepActive('policy'); }, 1150));
}

async function loadPersonas() {
  const grid = document.getElementById('personaGrid');
  const res = await fetch('/api/processpass/demo-identities');
  if (!res.ok) {
    document.getElementById('selectorHint').textContent =
      'Demo Mode is not enabled on this server — use secure sign-in instead.';
    return;
  }
  const { personas, unknownVisitor } = await res.json();
  grid.innerHTML = '';
  for (const p of personas) {
    grid.appendChild(personaCard(p.id, p.displayName, roleLabel(p.role), p.tenantName, false));
  }
  grid.appendChild(personaCard(unknownVisitor.id, unknownVisitor.displayName, 'No tenant access', '', true));
}

function roleLabel(role) {
  return { owner_admin: 'Owner / Executive', supervisor: 'Foreman', field_worker: 'Field Worker', accounting: 'Accounting' }[role] || role;
}

function personaCard(id, name, subtitle, tenantName, unknown) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'pp-persona-card' + (unknown ? ' pp-unknown' : '');

  const avatar = document.createElement('span');
  avatar.className = 'pp-avatar';
  avatar.textContent = unknown ? '?' : initials(name);

  const nameEl = document.createElement('span');
  nameEl.className = 'pp-persona-name';
  nameEl.textContent = name;

  const roleEl = document.createElement('span');
  roleEl.className = 'pp-persona-role';
  roleEl.textContent = subtitle + (tenantName ? ' · ' + tenantName : '');

  const textWrap = document.createElement('span');
  textWrap.append(nameEl, document.createElement('br'), roleEl);

  btn.append(avatar, textWrap);
  btn.addEventListener('click', () => selectPersona(id, btn));
  return btn;
}

async function selectPersona(id, btn) {
  if (busy) return;
  busy = true;
  document.querySelectorAll('.pp-persona-card').forEach(c => { c.disabled = true; });
  btn.classList.add('pp-selected');
  document.getElementById('verifyMsg').textContent = '';

  runVerificationAnimation();

  try {
    const res = await fetch('/api/processpass/identify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ demoUserId: id, deviceContext: { kiosk: true, label: 'ProcessPass Demo Kiosk' } }),
    });
    const data = await res.json();
    markStepDone('policy');
    sessionStorage.setItem('pp:lastResult', JSON.stringify(data));
    // Kept under its own key (not just inside pp:lastResult, which decision.js consumes and
    // discards on first load) so it's still readable if the tab is later navigated to another
    // authenticated page (e.g. /dashboard/accounting) that also needs it for its own step-up
    // prompt, or if My Processes is reloaded mid-demo.
    if (data.stepUpPin) sessionStorage.setItem('pp:stepUpPin', data.stepUpPin);
    setTimeout(() => { window.location.href = '/processpass/decision'; }, 350);
  } catch {
    document.getElementById('verifyMsg').textContent = 'Something went wrong — please try again.';
    resetSteps();
    document.querySelectorAll('.pp-persona-card').forEach(c => { c.disabled = false; });
    busy = false;
  }
}

document.getElementById('cancelBtn').addEventListener('click', () => {
  resetSteps();
  stream?.getTracks().forEach(t => t.stop());
  sessionStorage.removeItem('pp:lastResult');
  window.location.href = '/processpass';
});

initCamera();
loadPersonas();
