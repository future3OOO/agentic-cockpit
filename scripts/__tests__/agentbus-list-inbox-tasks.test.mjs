import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { ensureBusRoot, listInboxTasks } from '../lib/agentbus.mjs';

function buildRoster() {
  return {
    agents: [
      { name: 'autopilot', role: 'autopilot-worker', skills: [], workdir: '$REPO_ROOT' },
    ],
  };
}

async function writeTask(busRoot, taskId) {
  const inbox = path.join(busRoot, 'inbox', 'autopilot', 'new');
  await fs.mkdir(inbox, { recursive: true });
  const taskPath = path.join(inbox, `${taskId}.md`);
  const raw = `---\n${JSON.stringify({ id: taskId, signals: { kind: 'USER_REQUEST' } })}\n---\n\nbody\n`;
  await fs.writeFile(taskPath, raw, 'utf8');
}

test('listInboxTasks keeps numeric zero bounded and reserves "all" for full scans', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbus-list-inbox-tasks-'));
  const busRoot = path.join(tmp, 'bus');
  await ensureBusRoot(busRoot, buildRoster());

  for (let i = 0; i < 105; i += 1) {
    await writeTask(busRoot, `task_${String(i).padStart(3, '0')}`);
  }

  const bounded = await listInboxTasks({ busRoot, agentName: 'autopilot', state: 'new', limit: 0 });
  const fullScan = await listInboxTasks({ busRoot, agentName: 'autopilot', state: 'new', limit: 'all' });

  assert.equal(bounded.length, 100);
  assert.equal(fullScan.length, 105);
  assert.equal(fullScan[0].taskId, 'task_000');
  assert.equal(fullScan.at(-1)?.taskId, 'task_104');
});
