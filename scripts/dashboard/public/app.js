const els = {
  metaLine: document.getElementById('metaLine'),
  refreshBtn: document.getElementById('refreshBtn'),
  autoRefreshToggle: document.getElementById('autoRefreshToggle'),

  statusTable: document.getElementById('statusTable'),

  agentSelect: document.getElementById('agentSelect'),
  stateSelect: document.getElementById('stateSelect'),
  taskList: document.getElementById('taskList'),

  taskEmpty: document.getElementById('taskEmpty'),
  taskDetail: document.getElementById('taskDetail'),
  taskTitle: document.getElementById('taskTitle'),
  taskMeta: document.getElementById('taskMeta'),
  cancelTaskBtn: document.getElementById('cancelTaskBtn'),
  cancelHint: document.getElementById('cancelHint'),
  taskMarkdown: document.getElementById('taskMarkdown'),
  updateText: document.getElementById('updateText'),
  sendUpdateBtn: document.getElementById('sendUpdateBtn'),
  updateHint: document.getElementById('updateHint'),

  sendForm: document.getElementById('sendForm'),
  sendTo: document.getElementById('sendTo'),
  sendKind: document.getElementById('sendKind'),
  sendPriority: document.getElementById('sendPriority'),
  sendTitle: document.getElementById('sendTitle'),
  sendBody: document.getElementById('sendBody'),
  sendHint: document.getElementById('sendHint'),

  receipts: document.getElementById('receipts'),
};

/** @type {any} */
let snapshot = null;
let selected = { agent: null, state: els.stateSelect.value, taskId: null };
let refreshTimer = null;
let lastAgentOptionsKey = null;

function setHint(el, { ok, text }) {
  el.textContent = text || '';
  el.classList.remove('hint--ok', 'hint--err');
  if (!text) return;
  el.classList.add(ok ? 'hint--ok' : 'hint--err');
}

function safeJson(obj) {
  try {
    return JSON.stringify(obj, null, 2);
  } catch {
    return String(obj);
  }
}

async function apiJson(path, { method = 'GET', body = null } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = data && data.error ? data.error : `HTTP ${res.status}`;
    throw new Error(err);
  }
  return data;
}

function renderStatus(summaryRows) {
  const rows = Array.isArray(summaryRows) ? summaryRows : [];
  const table = document.createElement('table');
  table.innerHTML = `
    <thead>
      <tr>
        <th>Agent</th>
        <th>new</th>
        <th>seen</th>
        <th>in_progress</th>
        <th>processed</th>
      </tr>
    </thead>
  `;
  const tbody = document.createElement('tbody');
  for (const r of rows) {
    const info = agentInfoFor(r.agent || '');
    const role = info && (info.role || info.kind) ? String(info.role || info.kind) : '';
    const roleBadge = role ? ` <span class="pill">${escapeHtml(role)}</span>` : '';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(r.agent || '')}${roleBadge}</td>
      <td>${Number(r.new || 0)}</td>
      <td>${Number(r.seen || 0)}</td>
      <td>${Number(r.in_progress || 0)}</td>
      <td>${Number(r.processed || 0)}</td>
    `;
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  els.statusTable.innerHTML = '';
  els.statusTable.appendChild(table);
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function agentInfoFor(name) {
  const info = snapshot && snapshot.roster && snapshot.roster.agentInfo ? snapshot.roster.agentInfo : null;
  if (!info || typeof info !== 'object') return null;
  return info[name] || null;
}

function agentDisplayLabel(name) {
  const info = agentInfoFor(name);
  const role = info && (info.role || info.kind) ? String(info.role || info.kind) : '';
  return role ? `${name} (${role})` : name;
}

function renderAgentOptions(agentNames) {
  const agents = Array.isArray(agentNames) ? agentNames : [];
  const sorted = [...new Set(agents)].sort();
  const nextKey = sorted
    .map((name) => {
      const info = agentInfoFor(name);
      const role = info && info.role ? String(info.role) : '';
      const kind = info && info.kind ? String(info.kind) : '';
      return `${name}::${role}::${kind}`;
    })
    .join('\n');

  // Avoid re-rendering the agent <select> elements on every auto-refresh:
  // it steals selection/focus from the send form and is visually noisy.
  if (nextKey === lastAgentOptionsKey) {
    if (!selected.agent && sorted.length) selected.agent = sorted[0];
    if (selected.agent && sorted.includes(selected.agent)) {
      els.agentSelect.value = selected.agent;
    }
    return;
  }
  lastAgentOptionsKey = nextKey;

  const prevSendTo = new Set(getSelectedMulti(els.sendTo));
  const prevAgent = selected.agent;

  els.agentSelect.innerHTML = '';
  els.sendTo.innerHTML = '';

  for (const name of sorted) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = agentDisplayLabel(name);
    els.agentSelect.appendChild(opt);

    const opt2 = document.createElement('option');
    opt2.value = name;
    opt2.textContent = agentDisplayLabel(name);
    opt2.selected = prevSendTo.has(name);
    els.sendTo.appendChild(opt2);
  }

  if (!prevAgent && sorted.length) selected.agent = sorted[0];
  else if (prevAgent && sorted.includes(prevAgent)) selected.agent = prevAgent;
  else if (sorted.length) selected.agent = sorted[0];

  if (selected.agent) els.agentSelect.value = selected.agent;
}

function getTasksForSelected() {
  if (!snapshot || !snapshot.inbox) return [];
  const agentBox = snapshot.inbox[selected.agent] || {};
  const list = agentBox[selected.state] || [];
  return Array.isArray(list) ? list : [];
}

function renderTaskList() {
  const tasks = getTasksForSelected();
  els.taskList.innerHTML = '';
  if (!tasks.length) {
    const empty = document.createElement('div');
    empty.className = 'hint';
    empty.textContent = 'No tasks in this state.';
    els.taskList.appendChild(empty);
    return;
  }

  for (const t of tasks) {
    const meta = t.meta || {};
    const title = meta.title || t.taskId;
    const kind = meta.signals && meta.signals.kind ? meta.signals.kind : '';
    const pri = meta.priority || '';
    const from = meta.from || '';

    const item = document.createElement('div');
    item.className = 'list__item' + (selected.taskId === t.taskId ? ' list__item--active' : '');
    item.dataset.taskId = t.taskId;
    item.innerHTML = `
      <div class="list__title">${escapeHtml(title)}</div>
      <div class="list__sub">
        <span class="pill">${escapeHtml(kind || '—')}</span>
        <span class="pill">${escapeHtml(pri || '—')}</span>
        <span class="pill">from ${escapeHtml(from || '—')}</span>
      </div>
    `;
    item.addEventListener('click', () => selectTask(t.taskId));
    els.taskList.appendChild(item);
  }
}

async function selectTask(taskId) {
  selected.taskId = taskId;
  renderTaskList();
  els.taskEmpty.classList.add('hidden');
  els.taskDetail.classList.remove('hidden');
  els.taskMarkdown.textContent = 'Loading…';
  els.updateText.value = '';
  setHint(els.updateHint, { ok: true, text: '' });
  setHint(els.cancelHint, { ok: true, text: '' });

  try {
    const data = await apiJson(`/api/task/open?agent=${encodeURIComponent(selected.agent)}&id=${encodeURIComponent(taskId)}`);
    const meta = data.meta || {};
    els.taskTitle.textContent = meta.title || taskId;
    els.taskMeta.textContent = `state=${data.state} • priority=${meta.priority || '—'} • kind=${(meta.signals && meta.signals.kind) || '—'} • from=${meta.from || '—'}`;
    els.taskMarkdown.textContent = data.markdown || '';
  } catch (err) {
    els.taskMarkdown.textContent = `Error: ${err.message || String(err)}`;
  }
}

function renderReceipts(receipts) {
  els.receipts.innerHTML = '';
  const list = Array.isArray(receipts) ? receipts : [];
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'hint';
    empty.textContent = 'No receipts yet.';
    els.receipts.appendChild(empty);
    return;
  }

  for (const r of list) {
    const outcome = r.outcome || 'unknown';
    const agent = r.agent || r.task?.to?.[0] || '';
    const title = (r.task && r.task.title) || r.taskId || '(untitled)';
    const note = r.note || '';
    const top = document.createElement('div');
    top.className = 'receipt';
    top.innerHTML = `
      <div class="receipt__top">
        <div class="receipt__title">${escapeHtml(title)}</div>
        <div class="pill">${escapeHtml(outcome)}</div>
      </div>
      <div class="receipt__meta">
        <span>agent=${escapeHtml(agent)}</span>
        <span>taskId=${escapeHtml(r.taskId || '')}</span>
        <span>closedAt=${escapeHtml(r.closedAt || '')}</span>
      </div>
      <div class="hint">${escapeHtml(note)}</div>
    `;
    els.receipts.appendChild(top);
  }
}

async function refresh() {
  try {
    snapshot = await apiJson('/api/snapshot');
    const roster = snapshot.roster || {};
    els.metaLine.textContent = `session=${roster.sessionName || '—'} • bus=${snapshot.busRoot || '—'} • roster=${snapshot.rosterPath || '—'} • updated=${snapshot.nowIso || ''}`;

    renderAgentOptions(roster.agents || []);
    renderStatus(snapshot.statusSummary);
    renderTaskList();
    renderReceipts(snapshot.recentReceipts);
  } catch (err) {
    els.metaLine.textContent = `Error: ${err.message || String(err)}`;
  }
}

function getSelectedMulti(selectEl) {
  const out = [];
  for (const opt of selectEl.selectedOptions) out.push(opt.value);
  return out;
}

els.refreshBtn.addEventListener('click', () => refresh());

els.agentSelect.addEventListener('change', () => {
  selected.agent = els.agentSelect.value;
  selected.taskId = null;
  els.taskEmpty.classList.remove('hidden');
  els.taskDetail.classList.add('hidden');
  renderTaskList();
});

els.stateSelect.addEventListener('change', () => {
  selected.state = els.stateSelect.value;
  selected.taskId = null;
  els.taskEmpty.classList.remove('hidden');
  els.taskDetail.classList.add('hidden');
  renderTaskList();
});

els.sendUpdateBtn.addEventListener('click', async () => {
  if (!selected.agent || !selected.taskId) return;
  const append = els.updateText.value || '';
  setHint(els.updateHint, { ok: true, text: 'Sending…' });
  try {
    await apiJson('/api/task/update', {
      method: 'POST',
      body: { agentName: selected.agent, taskId: selected.taskId, append },
    });
    setHint(els.updateHint, { ok: true, text: 'Update appended.' });
    await refresh();
    await selectTask(selected.taskId);
  } catch (err) {
    setHint(els.updateHint, { ok: false, text: err.message || String(err) });
  }
});

els.cancelTaskBtn.addEventListener('click', async () => {
  if (!selected.agent || !selected.taskId) return;
  const taskId = selected.taskId;
  const agentName = selected.agent;

  const ok = window.confirm(`Cancel this task?\n\nagent=${agentName}\ntaskId=${taskId}\n\nThis will mark it skipped.`);
  if (!ok) return;

  setHint(els.cancelHint, { ok: true, text: 'Canceling…' });
  try {
    await apiJson('/api/task/cancel', {
      method: 'POST',
      body: { agentName, taskId, reason: 'Canceled from dashboard', canceledBy: 'dashboard' },
    });
    setHint(els.cancelHint, { ok: true, text: 'Task canceled.' });
    selected.taskId = null;
    els.taskEmpty.classList.remove('hidden');
    els.taskDetail.classList.add('hidden');
    await refresh();
  } catch (err) {
    setHint(els.cancelHint, { ok: false, text: err.message || String(err) });
  }
});

els.sendForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const to = getSelectedMulti(els.sendTo);
  const kind = els.sendKind.value;
  const priority = els.sendPriority.value;
  const title = els.sendTitle.value;
  const body = els.sendBody.value;

  setHint(els.sendHint, { ok: true, text: 'Sending…' });
  try {
    const res = await apiJson('/api/task/send', {
      method: 'POST',
      body: { to, kind, priority, title, body },
    });
    setHint(els.sendHint, { ok: true, text: `Sent: ${res.id}` });
    els.sendTitle.value = '';
    els.sendBody.value = '';
    await refresh();
  } catch (err) {
    setHint(els.sendHint, { ok: false, text: err.message || String(err) });
  }
});

function startAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    if (!els.autoRefreshToggle.checked) return;
    refresh().catch(() => {});
  }, 2000);
}

startAutoRefresh();
refresh();
