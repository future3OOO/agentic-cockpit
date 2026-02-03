import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';

import {
  ensureBusRoot,
  deliverTask,
  openTask,
  closeTask,
  parseFrontmatter,
} from '../lib/agentbus.mjs';

async function mkTmpDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'valua-orch-test-'));
}

test('orchestrator forwards TASK_COMPLETE digest to daddy inbox', async () => {
  const busRoot = await mkTmpDir();

  // Create a temp roster file because orchestrator script uses loadRoster().
  const repoRoot = process.cwd();
  const rosterPath = path.join(busRoot, 'ROSTER.json');
  const roster = {
    schemaVersion: 2,
    sessionName: 'test',
    orchestratorName: 'daddy-orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'daddy-autopilot',
    agents: [{ name: 'frontend' }, { name: 'daddy-orchestrator' }, { name: 'daddy-autopilot' }, { name: 'daddy' }],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2));

  await ensureBusRoot(busRoot, roster);

  // Deliver a task to frontend and close it to generate TASK_COMPLETE to orchestrator.
  const meta = {
    id: 'msg_test_3',
    to: ['frontend'],
    from: 'daddy',
    priority: 'P2',
    title: 'Do thing',
    signals: { kind: 'EXECUTE', rootId: 'root1' },
    references: {},
  };

  await deliverTask({ busRoot, meta, body: 'Do it' });
  await openTask({ busRoot, agentName: 'frontend', taskId: 'msg_test_3', markSeen: true });
  await closeTask({
    busRoot,
    roster,
    agentName: 'frontend',
    taskId: 'msg_test_3',
    outcome: 'done',
    note: 'ok',
    commitSha: 'abc123',
    receiptExtra: {},
  });

  // Run orchestrator once.
  const scriptPath = path.join(repoRoot, 'scripts', 'agent-orchestrator-worker.mjs');
  await new Promise((resolve, reject) => {
    const proc = childProcess.spawn(
      process.execPath,
      [scriptPath, '--agent', 'daddy-orchestrator', '--bus-root', busRoot, '--roster', rosterPath, '--once'],
      { stdio: 'ignore' }
    );
    proc.on('error', reject);
    proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
  });

  // Daddy should now have a new digest packet.
  const daddyDir = path.join(busRoot, 'inbox', 'daddy', 'new');
  const daddyFiles = await fs.readdir(daddyDir);
  assert.ok(daddyFiles.length >= 1, 'expected digest packet in daddy inbox');

  const digest = await fs.readFile(path.join(daddyDir, daddyFiles[0]), 'utf8');
  const { meta: dmeta, body } = parseFrontmatter(digest);
  assert.equal(dmeta.signals.kind, 'ORCHESTRATOR_UPDATE');
  assert.equal(dmeta.signals.notifyOrchestrator, false);
  assert.ok(/commitSha: abc123/.test(body), 'digest should include commitSha');

  // Autopilot should also receive the same digest for actionable kinds.
  const apDir = path.join(busRoot, 'inbox', 'daddy-autopilot', 'new');
  const apFiles = await fs.readdir(apDir);
  assert.ok(apFiles.length >= 1, 'expected digest packet in autopilot inbox');
  const apDigest = await fs.readFile(path.join(apDir, apFiles[0]), 'utf8');
  const { meta: apMeta } = parseFrontmatter(apDigest);
  assert.equal(apMeta.signals.kind, 'ORCHESTRATOR_UPDATE');
  assert.equal(apMeta.signals.notifyOrchestrator, false);
  assert.equal(apMeta.references.completedTaskKind, 'EXECUTE');

});

test('orchestrator forwards REVIEW_ACTION_REQUIRED digest to autopilot', async () => {
  const busRoot = await mkTmpDir();

  const repoRoot = process.cwd();
  const rosterPath = path.join(busRoot, 'ROSTER.json');
  const roster = {
    schemaVersion: 2,
    sessionName: 'test',
    orchestratorName: 'daddy-orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'daddy-autopilot',
    agents: [{ name: 'daddy-orchestrator' }, { name: 'daddy-autopilot' }, { name: 'daddy' }],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2));

  await ensureBusRoot(busRoot, roster);

  // Deliver a REVIEW_ACTION_REQUIRED packet to the orchestrator.
  const meta = {
    id: 'msg_review_1',
    to: ['daddy-orchestrator'],
    from: 'pr-observer',
    priority: 'P1',
    title: 'PR review: unresolved threads',
    signals: { kind: 'REVIEW_ACTION_REQUIRED' },
    references: { prNumber: 123 },
  };
  await deliverTask({ busRoot, meta, body: 'Unresolved review threads found.' });

  // Run orchestrator once.
  const scriptPath = path.join(repoRoot, 'scripts', 'agent-orchestrator-worker.mjs');
  await new Promise((resolve, reject) => {
    const proc = childProcess.spawn(
      process.execPath,
      [scriptPath, '--agent', 'daddy-orchestrator', '--bus-root', busRoot, '--roster', rosterPath, '--once'],
      { stdio: 'ignore' }
    );
    proc.on('error', reject);
    proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
  });

  const apDir = path.join(busRoot, 'inbox', 'daddy-autopilot', 'new');
  const apFiles = await fs.readdir(apDir);
  assert.ok(apFiles.length >= 1, 'expected digest packet in autopilot inbox');

  const apDigest = await fs.readFile(path.join(apDir, apFiles[0]), 'utf8');
  const { meta: apMeta } = parseFrontmatter(apDigest);
  assert.equal(apMeta.signals.kind, 'ORCHESTRATOR_UPDATE');
  assert.equal(apMeta.signals.sourceKind, 'REVIEW_ACTION_REQUIRED');
  assert.equal(apMeta.signals.notifyOrchestrator, false);
  assert.equal(apMeta.references.sourceReferences.prNumber, 123);
});
