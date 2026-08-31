import { browserSupportsWebAuthn, startAuthentication } from '/assets/webauthn-client.js';

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: form.get('email'), password: form.get('password') }),
  });
  if (res.ok) {
    window.location.href = '/dashboard';
  } else if (res.status === 429) {
    document.getElementById('error').textContent = 'Too many attempts — please wait a few minutes and try again.';
  } else {
    document.getElementById('error').textContent = 'Invalid email or password.';
  }
});

const passkeyBtn = document.getElementById('passkeyBtn');
if (!browserSupportsWebAuthn()) {
  passkeyBtn.disabled = true;
  passkeyBtn.textContent = 'Passkeys not supported in this browser';
}

passkeyBtn.addEventListener('click', async () => {
  const errEl = document.getElementById('passkeyError');
  errEl.textContent = '';
  passkeyBtn.disabled = true;
  try {
    const optionsRes = await fetch('/api/webauthn/login/options', { method: 'POST' });
    if (!optionsRes.ok) throw new Error('rate_limited');
    const { ceremonyId, options } = await optionsRes.json();

    const response = await startAuthentication(options);

    const verifyRes = await fetch('/api/webauthn/login/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ceremonyId, response }),
    });
    if (!verifyRes.ok) {
      errEl.textContent = 'Could not sign in with that passkey.';
      return;
    }
    window.location.href = '/dashboard';
  } catch (err) {
    // NotAllowedError covers both an explicit user cancel and a timeout — neither is an
    // application error worth alarming over.
    if (err?.name !== 'NotAllowedError') {
      errEl.textContent = 'Passkey sign-in did not complete.';
    }
  } finally {
    passkeyBtn.disabled = false;
  }
});
