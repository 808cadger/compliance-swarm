function selectValueToBody(value) {
  // 'default' -> null (explicitly clears any override for this field, see
  // routes/processAccessAdmin.js); 'true'/'false' -> the override value itself.
  if (value === 'default') return null;
  return value === 'true';
}

function currentBodyValue(select) {
  return selectValueToBody(select.value);
}

async function loadAccessTable() {
  const res = await fetch('/api/process-access');
  if (!res.ok) return;
  const rows = await res.json();
  const tbody = document.getElementById('accessBody');
  tbody.innerHTML = '';

  for (const r of rows) {
    const tr = document.createElement('tr');
    if (r.overrideEnabled !== null || r.overrideRequiresSiteAssignment !== null) {
      tr.className = 'overridden';
    }

    const roleTd = document.createElement('td');
    roleTd.innerHTML = `<span class="role-badge">${r.role}</span>`;
    const nameTd = document.createElement('td');
    nameTd.textContent = r.name;

    const accessTd = document.createElement('td');
    const accessSelect = document.createElement('select');
    accessSelect.innerHTML = `
      <option value="default">Default (allowed)</option>
      <option value="true">Force allow</option>
      <option value="false">Force deny</option>`;
    accessSelect.value = r.overrideEnabled === null ? 'default' : String(r.overrideEnabled);
    accessTd.appendChild(accessSelect);

    const siteTd = document.createElement('td');
    const siteSelect = document.createElement('select');
    const defaultLabel = r.defaultRequiresSiteAssignment ? 'Default (yes)' : 'Default (no)';
    siteSelect.innerHTML = `
      <option value="default">${defaultLabel}</option>
      <option value="true">Yes</option>
      <option value="false">No</option>`;
    siteSelect.value = r.overrideRequiresSiteAssignment === null ? 'default' : String(r.overrideRequiresSiteAssignment);
    siteTd.appendChild(siteSelect);

    async function save() {
      tr.classList.add('overridden');
      await fetch(`/api/process-access/${r.role}/${r.processKey}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: currentBodyValue(accessSelect),
          requiresSiteAssignment: currentBodyValue(siteSelect),
        }),
      });
    }
    accessSelect.addEventListener('change', save);
    siteSelect.addEventListener('change', save);

    tr.append(roleTd, nameTd, accessTd, siteTd);
    tbody.appendChild(tr);
  }
}

async function loadUsers() {
  const res = await fetch('/api/users');
  if (!res.ok) return;
  const users = await res.json();
  const select = document.getElementById('userSelect');
  select.innerHTML = '';
  for (const u of users) {
    if (u.disabledAt) continue;
    const opt = document.createElement('option');
    opt.value = u.id;
    opt.textContent = `${u.displayName} (${u.role})`;
    select.appendChild(opt);
  }
  select.addEventListener('change', loadSiteAssignments);
}

async function loadSites() {
  const res = await fetch('/api/sites');
  if (!res.ok) return;
  const sites = await res.json();
  const select = document.getElementById('siteSelect');
  select.innerHTML = '';
  for (const s of sites) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.name;
    select.appendChild(opt);
  }
}

async function loadSiteAssignments() {
  const userId = document.getElementById('userSelect').value;
  const list = document.getElementById('siteList');
  list.innerHTML = '';
  if (!userId) return;
  const res = await fetch(`/api/site-assignments?userId=${encodeURIComponent(userId)}`);
  if (!res.ok) return;
  const rows = await res.json();
  if (rows.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'No site assignments yet.';
    list.appendChild(li);
    return;
  }
  for (const a of rows) {
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = a.siteName;
    const del = document.createElement('button');
    del.textContent = 'Remove';
    del.addEventListener('click', async () => {
      await fetch(`/api/site-assignments/${a.id}`, { method: 'DELETE' });
      loadSiteAssignments();
    });
    li.append(label, del);
    list.appendChild(li);
  }
}

document.getElementById('assignBtn').addEventListener('click', async () => {
  const userId = document.getElementById('userSelect').value;
  const siteId = document.getElementById('siteSelect').value;
  const msg = document.getElementById('siteMsg');
  if (!userId || !siteId) return;
  const res = await fetch('/api/site-assignments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, siteId }),
  });
  if (res.ok) {
    msg.textContent = 'Assigned.';
    msg.className = 'msg ok';
    loadSiteAssignments();
  } else {
    const body = await res.json().catch(() => ({}));
    msg.textContent = body?.error?.message || 'Could not assign.';
    msg.className = 'msg err';
  }
});

loadAccessTable();
loadUsers().then(loadSiteAssignments);
loadSites();
