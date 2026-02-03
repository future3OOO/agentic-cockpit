import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { createDashboardServer } from '../dashboard/server.mjs';

test('dashboard server: serves UI + can send/update tasks', async () => {
  const repoRoot = process.cwd();
  const rosterPath = path.join(repoRoot, 'docs', 'agentic', 'agent-bus', 'ROSTER.json');
  await fs.stat(rosterPath);

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-dashboard-'));
  const busRoot = path.join(tmp, 'bus');

  const started = await createDashboardServer({
    host: '127.0.0.1',
    port: '0',
    busRoot,
    rosterPath,
  });

  const base = `http://${started.host}:${started.port}`;
  try {
    const htmlRes = await fetch(`${base}/`);
    assert.equal(htmlRes.status, 200);
    const html = await htmlRes.text();
    assert.match(html, /Agentic Cockpit/);

    const jsRes = await fetch(`${base}/app.js`);
    assert.equal(jsRes.status, 200);
    const js = await jsRes.text();
    assert.ok(js.includes('/api/snapshot'));

    const sendRes = await fetch(`${base}/api/task/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        to: ['autopilot'],
        kind: 'USER_REQUEST',
        priority: 'P2',
        title: 't1',
        body: 'hello',
      }),
    });
    assert.equal(sendRes.status, 200);
    const sent = await sendRes.json();
    assert.equal(sent.ok, true);
    assert.ok(sent.id);

    const taskFile = path.join(busRoot, 'inbox', 'autopilot', 'new', `${sent.id}.md`);
    await fs.stat(taskFile);

    const updateRes = await fetch(`${base}/api/task/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentName: 'autopilot',
        taskId: sent.id,
        append: 'clarification: do the thing',
      }),
    });
    assert.equal(updateRes.status, 200);
    const updated = await updateRes.json();
    assert.equal(updated.ok, true);

    const openedRes = await fetch(
      `${base}/api/task/open?agent=${encodeURIComponent('autopilot')}&id=${encodeURIComponent(sent.id)}`,
    );
    assert.equal(openedRes.status, 200);
    const opened = await openedRes.json();
    assert.equal(opened.ok, true);
    assert.match(opened.markdown, /clarification: do the thing/);

    const cancelRes = await fetch(`${base}/api/task/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentName: 'autopilot',
        taskId: sent.id,
        reason: 'canceled from test',
      }),
    });
    assert.equal(cancelRes.status, 200);
    const canceled = await cancelRes.json();
    assert.equal(canceled.ok, true);

    const processedFile = path.join(busRoot, 'inbox', 'autopilot', 'processed', `${sent.id}.md`);
    await fs.stat(processedFile);

    const receiptPath = path.join(busRoot, 'receipts', 'autopilot', `${sent.id}.json`);
    const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
    assert.equal(receipt.outcome, 'skipped');
  } finally {
    await new Promise((resolve) => started.server.close(() => resolve()));
  }
});
