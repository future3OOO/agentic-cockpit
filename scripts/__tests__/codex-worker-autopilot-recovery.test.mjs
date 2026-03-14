import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { safeIdToken } from '../lib/agentbus.mjs';
import { planAutopilotBlockedRecovery } from '../lib/autopilot-root-recovery.mjs';
import {
  buildHermeticBaseEnv,
  initRepoWithTrackedCodexDir,
  runCodexWorkerOnce,
  writeExecutable,
  writeTask,
} from './helpers/codex-worker-harness.mjs';

const BASE_ENV = buildHermeticBaseEnv();

const DUMMY_APP_SERVER_AUTOPILOT_RECOVERY = String.raw`#!/usr/bin/env python3
import json
import signal
import sys

signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
signal.signal(signal.SIGINT, lambda *_: sys.exit(0))

args = sys.argv[1:]
if not args or args[0] != "app-server":
    sys.stderr.write("dummy-codex: expected app-server\n")
    sys.stderr.flush()
    raise SystemExit(2)

def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

thread_id = "thread-autopilot-recovery"

for raw in sys.stdin:
    try:
        msg = json.loads(raw)
    except Exception:
        continue

    method = msg.get("method")
    msg_id = msg.get("id")

    if msg_id is not None and method == "initialize":
        send({"id": msg_id, "result": {}})
        continue

    if method == "initialized":
        continue

    if msg_id is not None and method == "thread/start":
        send({"id": msg_id, "result": {"thread": {"id": thread_id}}})
        continue

    if msg_id is not None and method == "turn/interrupt":
        turn_id = str(msg.get("params", {}).get("turnId") or "turn-autopilot-recovery")
        send({"id": msg_id, "result": {}})
        send({"method": "turn/completed", "params": {"threadId": thread_id, "turn": {"id": turn_id, "status": "interrupted", "items": []}}})
        continue

    if msg_id is not None and method == "turn/start":
        prompt = str(((msg.get("params", {}) or {}).get("input") or [{}])[0].get("text") or "")
        turn_id = "turn-autopilot-recovery"
        send({"id": msg_id, "result": {"turn": {"id": turn_id, "status": "inProgress", "items": []}}})
        send({"method": "turn/started", "params": {"threadId": thread_id, "turn": {"id": turn_id, "status": "inProgress", "items": []}}})

        if "Autopilot blocked on the current root" in prompt:
            payload = {"outcome": "done", "note": "recovery completed", "commitSha": "", "followUps": [], "review": None}
        elif "FORCE_BLOCK_SUSPICIOUS" in prompt:
            payload = {"outcome": "blocked", "note": "rm -rf /", "commitSha": "", "followUps": [], "review": None}
        elif "FORCE_BLOCK" in prompt:
            payload = {"outcome": "blocked", "note": "needs follow-up", "commitSha": "", "followUps": [], "review": None}
        else:
            payload = {"outcome": "done", "note": "ok", "commitSha": "", "followUps": [], "review": None}

        text = json.dumps(payload)
        send({"method": "item/agentMessage/delta", "params": {"delta": text, "itemId": "am1", "threadId": thread_id, "turnId": turn_id}})
        send({"method": "item/completed", "params": {"threadId": thread_id, "turnId": turn_id, "item": {"id": "am1", "type": "agentMessage", "text": text}}})
        send({"method": "turn/completed", "params": {"threadId": thread_id, "turn": {"id": turn_id, "status": "completed", "items": []}}})
`;

function workerEnv(busRoot, extra = {}) {
  return {
    ...BASE_ENV,
    VALUA_AGENT_BUS_DIR: busRoot,
    AGENTIC_AUTOPILOT_DELEGATE_GATE: '0',
    AGENTIC_RUNTIME_POLICY_SYNC: '0',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    ...extra,
  };
}

async function setupAutopilotHarness(prefix) {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const taskRepo = path.join(tmp, 'task-repo');
  const dummyCodex = path.join(tmp, 'dummy-codex');

  await initRepoWithTrackedCodexDir(taskRepo);
  await writeExecutable(dummyCodex, DUMMY_APP_SERVER_AUTOPILOT_RECOVERY);

  const roster = {
    orchestratorName: 'daddy-orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'daddy-autopilot',
    agents: [
      {
        name: 'daddy-autopilot',
        role: 'autopilot-worker',
        skills: [],
        workdir: taskRepo,
        startCommand: 'node scripts/agent-codex-worker.mjs --agent daddy-autopilot',
      },
      {
        name: 'backend',
        role: 'codex-worker',
        skills: [],
        workdir: taskRepo,
        startCommand: 'node scripts/agent-codex-worker.mjs --agent backend',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');

  return { repoRoot, tmp, busRoot, rosterPath, taskRepo, dummyCodex };
}

function buildRecoveryPlan({
  sourceTaskId = 't1',
  note = 'dirty root',
  reasonCode = 'dirty_cross_root_transition',
  contractClass = 'external',
  fingerprint = 'fp-recovery-1',
} = {}) {
  const plan = planAutopilotBlockedRecovery({
    isAutopilot: true,
    agentName: 'daddy-autopilot',
    openedMeta: {
      id: 't1',
      title: 'blocked root needs continuation',
      priority: 'P1',
      references: {
        autopilotRecoverySourceTaskId: sourceTaskId,
      },
      signals: {
        kind: 'ORCHESTRATOR_UPDATE',
        rootId: 'root-next',
        notifyOrchestrator: false,
      },
    },
    outcome: 'blocked',
    note,
    receiptExtra: {
      blockedRecoveryContract: {
        class: contractClass,
        reasonCode,
        fingerprint,
      },
    },
  });
  assert.equal(plan?.status, 'queue');
  return plan;
}

function buildPendingMarkerFixture({
  sourceTaskId = 't1',
  mutateMeta,
  body,
  note,
  reasonCode,
} = {}) {
  const plan = buildRecoveryPlan({ sourceTaskId, note, reasonCode });
  const meta = JSON.parse(JSON.stringify(plan.taskMeta));
  if (mutateMeta) mutateMeta(meta, plan);
  return {
    recoveryKey: plan.recoveryKey,
    taskId: plan.taskId,
    meta,
    body: typeof body === 'string' ? body : plan.taskBody,
  };
}

test('successful autopilot closure does not attach autopilotRecovery', async () => {
  const { repoRoot, busRoot, rosterPath, dummyCodex } = await setupAutopilotHarness(
    'valua-codex-worker-autopilot-recovery-success-',
  );

  await writeTask({
    busRoot,
    agentName: 'daddy-autopilot',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['daddy-autopilot'],
      from: 'daddy-orchestrator',
      priority: 'P1',
      title: 'autopilot success',
      signals: { kind: 'ORCHESTRATOR_UPDATE', rootId: 'root-next' },
    },
    body: 'normal successful autopilot completion',
  });

  const run = await runCodexWorkerOnce({
    repoRoot,
    busRoot,
    rosterPath,
    agentName: 'daddy-autopilot',
    codexBin: dummyCodex,
    env: workerEnv(busRoot),
  });
  assert.equal(run.code, 0, run.stderr || run.stdout);

  const receipt = JSON.parse(await fs.readFile(path.join(busRoot, 'receipts', 'daddy-autopilot', 't1.json'), 'utf8'));
  assert.equal(receipt.outcome, 'done');
  assert.equal(receipt.receiptExtra?.autopilotRecovery, undefined);
});

test('blocked autopilot closure queues deterministic recovery without mutating source receipt', async () => {
  const { repoRoot, busRoot, rosterPath, dummyCodex } = await setupAutopilotHarness(
    'valua-codex-worker-autopilot-recovery-queue-',
  );

  await writeTask({
    busRoot,
    agentName: 'daddy-autopilot',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['daddy-autopilot'],
      from: 'daddy-orchestrator',
      priority: 'P1',
      title: 'blocked root needs continuation',
      signals: { kind: 'ORCHESTRATOR_UPDATE', rootId: 'root-next' },
    },
    body: 'FORCE_BLOCK',
  });

  const run = await runCodexWorkerOnce({
    repoRoot,
    busRoot,
    rosterPath,
    agentName: 'daddy-autopilot',
    codexBin: dummyCodex,
    env: workerEnv(busRoot),
  });
  assert.equal(run.code, 0, run.stderr || run.stdout);

  const receipt = JSON.parse(await fs.readFile(path.join(busRoot, 'receipts', 'daddy-autopilot', 't1.json'), 'utf8'));
  assert.equal(receipt.outcome, 'blocked');
  assert.equal(receipt.receiptExtra?.autopilotRecovery, undefined);
  const queuedRaw = await fs.readFile(
    path.join(busRoot, 'inbox', 'daddy-autopilot', 'new', 'autopilot_recovery__t1__1.md'),
    'utf8',
  );
  const queuedMeta = JSON.parse(queuedRaw.split('---\n')[1]);
  assert.equal(queuedMeta.id, 'autopilot_recovery__t1__1');
  assert.equal(queuedMeta.signals?.phase, 'blocked-recovery');
  assert.equal(queuedMeta.references?.autopilotRecovery?.attempt, 1);
});

test('post-close enqueue failure persists one marker and flushes exactly one deterministic recovery task', async () => {
  const { repoRoot, busRoot, rosterPath, dummyCodex } = await setupAutopilotHarness(
    'valua-codex-worker-autopilot-recovery-pending-',
  );

  await writeTask({
    busRoot,
    agentName: 'daddy-autopilot',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['daddy-autopilot'],
      from: 'daddy-orchestrator',
      priority: 'P1',
      title: 'blocked root needs persisted continuation',
      signals: { kind: 'ORCHESTRATOR_UPDATE', rootId: 'root-next', notifyOrchestrator: false },
    },
    body: 'FORCE_BLOCK_SUSPICIOUS',
  });

  const firstRun = await runCodexWorkerOnce({
    repoRoot,
    busRoot,
    rosterPath,
    agentName: 'daddy-autopilot',
    codexBin: dummyCodex,
    env: workerEnv(busRoot),
  });
  assert.equal(firstRun.code, 0, firstRun.stderr || firstRun.stdout);

  const sourceReceipt = JSON.parse(
    await fs.readFile(path.join(busRoot, 'receipts', 'daddy-autopilot', 't1.json'), 'utf8'),
  );
  assert.equal(sourceReceipt.outcome, 'blocked');
  assert.equal(sourceReceipt.receiptExtra?.autopilotRecovery, undefined);

  const pendingDir = path.join(busRoot, 'state', 'autopilot-blocked-recovery', 'daddy-autopilot');
  const pendingFiles = await fs.readdir(pendingDir);
  assert.deepEqual(pendingFiles, ['autopilot_recovery__t1__1.json']);
  await assert.rejects(fs.access(path.join(busRoot, 'inbox', 'daddy-autopilot', 'new', 'autopilot_recovery__t1__1.md')));

  const secondRun = await runCodexWorkerOnce({
    repoRoot,
    busRoot,
    rosterPath,
    agentName: 'daddy-autopilot',
    codexBin: dummyCodex,
    env: workerEnv(busRoot, { AGENTIC_SUSPICIOUS_POLICY: 'allow' }),
  });
  assert.equal(secondRun.code, 0, secondRun.stderr || secondRun.stdout);

  const recoveryReceipt = JSON.parse(
    await fs.readFile(path.join(busRoot, 'receipts', 'daddy-autopilot', 'autopilot_recovery__t1__1.json'), 'utf8'),
  );
  assert.equal(recoveryReceipt.outcome, 'done');
  assert.match(String(recoveryReceipt.note || ''), /recovery completed/);
  const pendingAfterFlush = await fs.readdir(pendingDir);
  assert.equal(pendingAfterFlush.length, 0);
});

test('unsafe recovery source ids still flush exactly one queued recovery task', async () => {
  const { repoRoot, busRoot, rosterPath, dummyCodex } = await setupAutopilotHarness(
    'valua-codex-worker-autopilot-recovery-unsafe-id-',
  );
  const recoverySourceTaskId = 't 1';
  const recoveryKey = `autopilot_recovery__${recoverySourceTaskId}__1`;
  const safeRecoveryTaskId = safeIdToken(recoveryKey);

  await writeTask({
    busRoot,
    agentName: 'daddy-autopilot',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['daddy-autopilot'],
      from: 'daddy-orchestrator',
      priority: 'P1',
      title: 'blocked root needs sanitized pending state',
      signals: { kind: 'ORCHESTRATOR_UPDATE', rootId: 'root-next', notifyOrchestrator: false },
      references: { autopilotRecoverySourceTaskId: recoverySourceTaskId },
    },
    body: 'FORCE_BLOCK_SUSPICIOUS',
  });

  const firstRun = await runCodexWorkerOnce({
    repoRoot,
    busRoot,
    rosterPath,
    agentName: 'daddy-autopilot',
    codexBin: dummyCodex,
    env: workerEnv(busRoot),
  });
  assert.equal(firstRun.code, 0, firstRun.stderr || firstRun.stdout);

  const pendingDir = path.join(busRoot, 'state', 'autopilot-blocked-recovery', 'daddy-autopilot');
  const pendingFiles = await fs.readdir(pendingDir);
  assert.deepEqual(pendingFiles, [`${safeRecoveryTaskId}.json`]);
  await assert.rejects(fs.access(path.join(pendingDir, `${recoveryKey}.json`)));

  const secondRun = await runCodexWorkerOnce({
    repoRoot,
    busRoot,
    rosterPath,
    agentName: 'daddy-autopilot',
    codexBin: dummyCodex,
    env: workerEnv(busRoot, { AGENTIC_SUSPICIOUS_POLICY: 'allow' }),
  });
  assert.equal(secondRun.code, 0, secondRun.stderr || secondRun.stdout);

  const recoveryReceipt = JSON.parse(
    await fs.readFile(path.join(busRoot, 'receipts', 'daddy-autopilot', `${safeRecoveryTaskId}.json`), 'utf8'),
  );
  assert.equal(recoveryReceipt.outcome, 'done');
  const pendingAfterFlush = await fs.readdir(pendingDir);
  assert.equal(pendingAfterFlush.length, 0);
});

test('legacy pending recovery markers default missing contract fields and replay cleanly', async () => {
  const { repoRoot, busRoot, rosterPath, dummyCodex } = await setupAutopilotHarness(
    'valua-codex-worker-autopilot-recovery-legacy-marker-',
  );
  const marker = buildPendingMarkerFixture();
  delete marker.contractClass;
  delete marker.fingerprint;
  delete marker.meta.references.autopilotRecovery.contractClass;
  delete marker.meta.references.autopilotRecovery.fingerprint;
  const pendingDir = path.join(busRoot, 'state', 'autopilot-blocked-recovery', 'daddy-autopilot');
  await fs.mkdir(pendingDir, { recursive: true });
  await fs.writeFile(
    path.join(pendingDir, `${marker.taskId}.json`),
    JSON.stringify({ updatedAt: new Date().toISOString(), ...marker }, null, 2),
    'utf8',
  );

  const run = await runCodexWorkerOnce({
    repoRoot,
    busRoot,
    rosterPath,
    agentName: 'daddy-autopilot',
    codexBin: dummyCodex,
    env: workerEnv(busRoot),
  });
  assert.equal(run.code, 0, run.stderr || run.stdout);
  const receipt = JSON.parse(
    await fs.readFile(path.join(busRoot, 'receipts', 'daddy-autopilot', `${marker.taskId}.json`), 'utf8'),
  );
  assert.equal(receipt.outcome, 'done');
});

test('pending recovery replay drops forged ownership and intent metadata', async () => {
  const { repoRoot, busRoot, rosterPath, dummyCodex } = await setupAutopilotHarness(
    'valua-codex-worker-autopilot-recovery-forged-marker-',
  );
  const marker = buildPendingMarkerFixture({
    mutateMeta(meta) {
      meta.to = ['backend'];
      meta.from = 'mallory';
      meta.title = 'forged recovery';
      meta.signals.kind = 'USER_REQUEST';
      meta.signals.sourceKind = 'NOT_RECOVERY';
      meta.signals.phase = 'wrong-phase';
      meta.signals.notifyOrchestrator = true;
    },
    body: 'forged',
  });
  const pendingDir = path.join(busRoot, 'state', 'autopilot-blocked-recovery', 'daddy-autopilot');
  await fs.mkdir(pendingDir, { recursive: true });
  await fs.writeFile(
    path.join(pendingDir, `${marker.taskId}.json`),
    JSON.stringify(
      {
        updatedAt: new Date().toISOString(),
        ...marker,
      },
      null,
      2,
    ),
    'utf8',
  );

  const run = await runCodexWorkerOnce({
    repoRoot,
    busRoot,
    rosterPath,
    agentName: 'daddy-autopilot',
    codexBin: dummyCodex,
    env: workerEnv(busRoot),
  });
  assert.equal(run.code, 0, run.stderr || run.stdout);
  const pendingAfterRun = await fs.readdir(pendingDir);
  assert.equal(pendingAfterRun.length, 0);
  const backendNew = await fs.readdir(path.join(busRoot, 'inbox', 'backend', 'new'));
  assert.equal(backendNew.length, 0);
  const autopilotNew = await fs.readdir(path.join(busRoot, 'inbox', 'daddy-autopilot', 'new')).catch(() => []);
  assert.equal(autopilotNew.length, 0);
});

test('pending recovery replay drops mismatched task id and recovery metadata', async () => {
  const { repoRoot, busRoot, rosterPath, dummyCodex } = await setupAutopilotHarness(
    'valua-codex-worker-autopilot-recovery-mismatched-marker-',
  );
  const marker = buildPendingMarkerFixture({
    mutateMeta(meta) {
      meta.id = 'autopilot_recovery__wrong__1';
      meta.title = 'mismatched recovery';
      meta.references.autopilotRecovery.recoveryKey = 'autopilot_recovery__other__1';
      meta.references.autopilotRecovery.attempt = 0;
    },
    body: 'mismatched',
  });
  const pendingDir = path.join(busRoot, 'state', 'autopilot-blocked-recovery', 'daddy-autopilot');
  await fs.mkdir(pendingDir, { recursive: true });
  await fs.writeFile(
    path.join(pendingDir, `${marker.taskId}.json`),
    JSON.stringify(
      {
        updatedAt: new Date().toISOString(),
        ...marker,
        taskId: 'autopilot_recovery__wrong__1',
      },
      null,
      2,
    ),
    'utf8',
  );

  const run = await runCodexWorkerOnce({
    repoRoot,
    busRoot,
    rosterPath,
    agentName: 'daddy-autopilot',
    codexBin: dummyCodex,
    env: workerEnv(busRoot),
  });
  assert.equal(run.code, 0, run.stderr || run.stdout);
  const pendingAfterRun = await fs.readdir(pendingDir);
  assert.equal(pendingAfterRun.length, 0);
  const autopilotNew = await fs.readdir(path.join(busRoot, 'inbox', 'daddy-autopilot', 'new')).catch(() => []);
  assert.equal(autopilotNew.length, 0);
});

test('pending recovery replay drops mismatched normalized contract metadata', async () => {
  const { repoRoot, busRoot, rosterPath, dummyCodex } = await setupAutopilotHarness(
    'valua-codex-worker-autopilot-recovery-contract-mismatch-',
  );
  const marker = buildPendingMarkerFixture();
  marker.contractClass = 'controller';
  marker.meta.references.autopilotRecovery.contractClass = 'external';
  marker.fingerprint = 'fp-top';
  marker.meta.references.autopilotRecovery.fingerprint = 'fp-meta';
  const pendingDir = path.join(busRoot, 'state', 'autopilot-blocked-recovery', 'daddy-autopilot');
  await fs.mkdir(pendingDir, { recursive: true });
  await fs.writeFile(
    path.join(pendingDir, `${marker.taskId}.json`),
    JSON.stringify({ updatedAt: new Date().toISOString(), ...marker }, null, 2),
    'utf8',
  );

  const run = await runCodexWorkerOnce({
    repoRoot,
    busRoot,
    rosterPath,
    agentName: 'daddy-autopilot',
    codexBin: dummyCodex,
    env: workerEnv(busRoot),
  });
  assert.equal(run.code, 0, run.stderr || run.stdout);
  const pendingAfterRun = await fs.readdir(pendingDir);
  assert.equal(pendingAfterRun.length, 0);
});
