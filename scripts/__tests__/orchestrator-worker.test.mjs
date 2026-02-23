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
      {
        stdio: 'ignore',
        env: { ...process.env, AGENTIC_ORCH_FORWARD_TO_DADDY: '1', AGENTIC_ORCH_DADDY_DIGEST_MODE: 'compact' },
      }
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
  assert.equal(apMeta.references.receiptOutcome, 'done');
  assert.equal(apMeta.signals.reviewRequired, true);
  assert.equal(apMeta.signals.reviewTarget.sourceTaskId, 'msg_test_3');
  assert.equal(apMeta.signals.reviewTarget.sourceAgent, 'frontend');
  assert.equal(apMeta.signals.reviewTarget.sourceKind, 'EXECUTE');
  assert.equal(apMeta.signals.reviewTarget.commitSha, 'abc123');
  assert.equal(apMeta.signals.reviewPolicy.mustUseBuiltInReview, true);
  assert.equal(apMeta.signals.reviewPolicy.requireEvidence, true);
  assert.equal(apMeta.signals.reviewPolicy.maxReviewRetries, 1);

});

test('orchestrator does not require review for failed EXECUTE completion', async () => {
  const busRoot = await mkTmpDir();
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

  await deliverTask({
    busRoot,
    meta: {
      id: 'msg_fail_1',
      to: ['frontend'],
      from: 'daddy',
      priority: 'P2',
      title: 'Will fail',
      signals: { kind: 'EXECUTE', rootId: 'root-fail' },
      references: {},
    },
    body: 'fail it',
  });
  await openTask({ busRoot, agentName: 'frontend', taskId: 'msg_fail_1', markSeen: true });
  await closeTask({
    busRoot,
    roster,
    agentName: 'frontend',
    taskId: 'msg_fail_1',
    outcome: 'failed',
    note: 'build failed',
    commitSha: 'abc123',
    receiptExtra: {},
  });

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
  assert.equal(apMeta.references.completedTaskKind, 'EXECUTE');
  assert.equal(apMeta.references.receiptOutcome, 'failed');
  assert.equal(apMeta.signals.reviewRequired, false);
  assert.equal(apMeta.signals.reviewTarget, null);
  assert.equal(apMeta.signals.reviewPolicy, null);
});

test('orchestrator does not require review for done EXECUTE completion without commitSha', async () => {
  const busRoot = await mkTmpDir();
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

  await deliverTask({
    busRoot,
    meta: {
      id: 'msg_nocommit_1',
      to: ['frontend'],
      from: 'daddy',
      priority: 'P2',
      title: 'No commit',
      signals: { kind: 'EXECUTE', rootId: 'root-nocommit' },
      references: {},
    },
    body: 'done without commit',
  });
  await openTask({ busRoot, agentName: 'frontend', taskId: 'msg_nocommit_1', markSeen: true });
  await closeTask({
    busRoot,
    roster,
    agentName: 'frontend',
    taskId: 'msg_nocommit_1',
    outcome: 'done',
    note: 'done with no code changes',
    commitSha: '',
    receiptExtra: {},
  });

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
  assert.equal(apMeta.references.completedTaskKind, 'EXECUTE');
  assert.equal(apMeta.references.receiptOutcome, 'done');
  assert.equal(apMeta.signals.reviewRequired, false);
  assert.equal(apMeta.signals.reviewTarget, null);
  assert.equal(apMeta.signals.reviewPolicy, null);
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
    from: 'observer:pr',
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
  assert.ok(!String(apMeta.id).includes(':'), 'forwarded task id must be filesystem-safe');
  assert.equal(apMeta.signals.kind, 'ORCHESTRATOR_UPDATE');
  assert.equal(apMeta.signals.sourceKind, 'REVIEW_ACTION_REQUIRED');
  assert.equal(apMeta.signals.notifyOrchestrator, false);
  assert.equal(apMeta.references.sourceReferences.prNumber, 123);
});

test('orchestrator coalesces duplicate REVIEW_ACTION_REQUIRED digests for same PR root', async () => {
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

  await deliverTask({
    busRoot,
    meta: {
      id: 'msg_review_dup_1',
      to: ['daddy-orchestrator'],
      from: 'observer:pr',
      priority: 'P1',
      title: 'PR #104 unresolved thread A',
      signals: { kind: 'REVIEW_ACTION_REQUIRED', rootId: 'PR104', phase: 'review-fix' },
      references: { prNumber: 104, threadId: 'A' },
    },
    body: 'thread A',
  });
  await deliverTask({
    busRoot,
    meta: {
      id: 'msg_review_dup_2',
      to: ['daddy-orchestrator'],
      from: 'observer:pr',
      priority: 'P1',
      title: 'PR #104 unresolved thread B',
      signals: { kind: 'REVIEW_ACTION_REQUIRED', rootId: 'PR104', phase: 'review-fix' },
      references: { prNumber: 104, threadId: 'B' },
    },
    body: 'thread B',
  });

  const scriptPath = path.join(repoRoot, 'scripts', 'agent-orchestrator-worker.mjs');
  await new Promise((resolve, reject) => {
    const proc = childProcess.spawn(
      process.execPath,
      [scriptPath, '--agent', 'daddy-orchestrator', '--bus-root', busRoot, '--roster', rosterPath, '--once'],
      { stdio: 'ignore' },
    );
    proc.on('error', reject);
    proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
  });

  const apDir = path.join(busRoot, 'inbox', 'daddy-autopilot', 'new');
  const apFiles = await fs.readdir(apDir);
  assert.equal(apFiles.length, 1, 'expected one coalesced digest packet in autopilot inbox');

  const apDigest = await fs.readFile(path.join(apDir, apFiles[0]), 'utf8');
  const { meta: apMeta, body } = parseFrontmatter(apDigest);
  assert.equal(apMeta.signals.kind, 'ORCHESTRATOR_UPDATE');
  assert.equal(apMeta.signals.sourceKind, 'REVIEW_ACTION_REQUIRED');
  assert.equal(apMeta.signals.rootId, 'PR104');
  assert.ok(body.includes('[coalesced orchestrator digest]'));
  assert.ok(body.includes('sourceTaskId: msg_review_dup_2'));
});

test('orchestrator forwards TASK_COMPLETE digest even when completedTaskKind missing', async () => {
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

  // Simulate an older/manual TASK_COMPLETE packet where completedTaskKind is missing.
  await deliverTask({
    busRoot,
    meta: {
      id: 'tc_missing_kind_1',
      to: ['daddy-orchestrator'],
      from: 'frontend',
      priority: 'P2',
      title: 'TASK_COMPLETE missing completedTaskKind',
      signals: { kind: 'TASK_COMPLETE', completedTaskId: 'task1', rootId: 'root1' },
      references: {},
    },
    body: 'done',
  });

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
  assert.equal(apMeta.signals.reviewRequired, false);
});

test('orchestrator forwards one self-remediation digest for non-done ORCHESTRATOR_UPDATE completion', async () => {
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

  await deliverTask({
    busRoot,
    meta: {
      id: 'ap_orch_update_1',
      to: ['daddy-autopilot'],
      from: 'daddy-orchestrator',
      priority: 'P2',
      title: 'metadata-only gate follow-up',
      signals: { kind: 'ORCHESTRATOR_UPDATE', sourceKind: 'TASK_COMPLETE', rootId: 'root-self-remediate' },
      references: { completedTaskKind: 'EXECUTE' },
    },
    body: 'digest body',
  });
  await openTask({ busRoot, agentName: 'daddy-autopilot', taskId: 'ap_orch_update_1', markSeen: true });
  await closeTask({
    busRoot,
    roster,
    agentName: 'daddy-autopilot',
    taskId: 'ap_orch_update_1',
    outcome: 'needs_review',
    note: 'missing skillops metadata command in testsToRun',
    commitSha: '',
    receiptExtra: {},
  });

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
  assert.ok(apFiles.length >= 1, 'expected self-remediation digest packet in autopilot inbox');

  const apDigest = await fs.readFile(path.join(apDir, apFiles[0]), 'utf8');
  const { meta: apMeta } = parseFrontmatter(apDigest);
  assert.equal(apMeta.signals.kind, 'ORCHESTRATOR_UPDATE');
  assert.equal(apMeta.signals.sourceKind, 'TASK_COMPLETE');
  assert.equal(apMeta.references.completedTaskKind, 'ORCHESTRATOR_UPDATE');
  assert.equal(apMeta.references.receiptOutcome, 'needs_review');
  assert.equal(apMeta.references.orchestratorSelfRemediateDepth, 1);
});

test('orchestrator stops self-remediation forwarding when depth cap is reached', async () => {
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

  await deliverTask({
    busRoot,
    meta: {
      id: 'ap_orch_update_depth_cap',
      to: ['daddy-autopilot'],
      from: 'daddy-orchestrator',
      priority: 'P2',
      title: 'metadata-only gate follow-up depth-capped',
      signals: { kind: 'ORCHESTRATOR_UPDATE', sourceKind: 'TASK_COMPLETE', rootId: 'root-depth-cap' },
      references: { completedTaskKind: 'EXECUTE', orchestratorSelfRemediateDepth: 1 },
    },
    body: 'digest body',
  });
  await openTask({ busRoot, agentName: 'daddy-autopilot', taskId: 'ap_orch_update_depth_cap', markSeen: true });
  await closeTask({
    busRoot,
    roster,
    agentName: 'daddy-autopilot',
    taskId: 'ap_orch_update_depth_cap',
    outcome: 'needs_review',
    note: 'still missing metadata command',
    commitSha: '',
    receiptExtra: {},
  });

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
  assert.equal(apFiles.length, 0, 'expected no self-remediation digest after depth cap');
});

test('orchestrator surfaces forwarding failures and closes packet as needs_review', async () => {
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

  // Make autopilot inbox read-only so forwardDigests can't write the digest file.
  const apNewDir = path.join(busRoot, 'inbox', 'daddy-autopilot', 'new');
  await fs.mkdir(apNewDir, { recursive: true });
  await fs.chmod(apNewDir, 0o555);

  const packetId = 'tc_forward_fail_1';
  await deliverTask({
    busRoot,
    meta: {
      id: packetId,
      to: ['daddy-orchestrator'],
      from: 'frontend',
      priority: 'P2',
      title: 'TASK_COMPLETE forwarding failure',
      signals: { kind: 'TASK_COMPLETE', completedTaskId: 'task1', completedTaskKind: 'EXECUTE', rootId: 'root1' },
      references: {},
    },
    body: 'done',
  });

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

  const receiptPath = path.join(busRoot, 'receipts', 'daddy-orchestrator', `${packetId}.json`);
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(receipt.outcome, 'needs_review');
  assert.ok(Array.isArray(receipt.receiptExtra?.forwardingErrors));
  assert.ok(receipt.receiptExtra.forwardingErrors.length >= 1, 'expected forwardingErrors in receipt');
});
