import { browserSupportsWebAuthn, startRegistration } from '/assets/webauthn-client.js';

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function loadCredentials() {
  const res = await fetch('/api/webauthn/credentials');
  if (!res.ok) return;
  const rows = await res.json();
  const list = document.getElementById('credList');
  list.innerHTML = '';
  if (rows.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'No passkeys registered yet.';
    list.appendChild(li);
    return;
  }
  for (const c of rows) {
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.innerHTML = `<strong>${escapeHtml(c.deviceLabel)}</strong> — added ${new Date(c.createdAt).toLocaleDateString()}`
      + (c.lastUsedAt ? `, last used ${new Date(c.lastUsedAt).toLocaleDateString()}` : ', never used to sign in yet');
    const del = document.createElement('button');
    del.textContent = 'Remove';
    del.addEventListener('click', async () => {
      await fetch(`/api/webauthn/credentials/${c.id}`, { method: 'DELETE' });
      loadCredentials();
    });
    li.append(label, del);
    list.appendChild(li);
  }
}

const addBtn = document.getElementById('addBtn');
if (!browserSupportsWebAuthn()) {
  addBtn.disabled = true;
  addBtn.textContent = 'Passkeys not supported in this browser';
}

addBtn.addEventListener('click', async () => {
  const msg = document.getElementById('msg');
  msg.textContent = '';
  addBtn.disabled = true;
  try {
    const optionsRes = await fetch('/api/webauthn/register/options', { method: 'POST' });
    const { ceremonyId, options } = await optionsRes.json();

    const response = await startRegistration(options);

    const label = prompt('Name this passkey (e.g. "Work laptop", "iPhone"):', 'Passkey') || 'Passkey';
    const verifyRes = await fetch('/api/webauthn/register/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ceremonyId, response, deviceLabel: label }),
    });
    if (verifyRes.ok) {
      msg.textContent = 'Passkey added.';
      msg.className = 'msg ok';
      loadCredentials();
    } else {
      const body = await verifyRes.json().catch(() => ({}));
      msg.textContent = body?.error?.message || 'Could not add that passkey.';
      msg.className = 'msg err';
    }
  } catch (err) {
    if (err?.name !== 'NotAllowedError') {
      msg.textContent = 'Passkey setup did not complete.';
      msg.className = 'msg err';
    }
  } finally {
    addBtn.disabled = false;
  }
});

loadCredentials();
