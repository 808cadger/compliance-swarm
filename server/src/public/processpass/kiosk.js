document.getElementById('identifyBtn').addEventListener('click', async () => {
  const btn = document.getElementById('identifyBtn');
  btn.disabled = true;
  btn.textContent = 'Starting…';
  try {
    await fetch('/api/processpass/started', { method: 'POST' });
  } catch {
    // Non-fatal — the audit event is best-effort from the kiosk's point of view; the verify
    // screen still works if this request fails (e.g. the network blips).
  }
  window.location.href = '/processpass/verify';
});
