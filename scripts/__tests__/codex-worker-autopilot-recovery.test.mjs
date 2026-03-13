import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
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

test('pending recovery marker sanitizes unsafe recovery keys before writing state', async () => {
  const { repoRoot, busRoot, rosterPath, dummyCodex } = await setupAutopilotHarness(
    'valua-codex-worker-autopilot-recovery-sanitized-state-',
  );
  const recoverySourceTaskId = 't 1';
  const recoveryKey = `autopilot_recovery__${recoverySourceTaskId}__1`;
  const pendingStateKey = `k_${crypto.createHash('sha256').update(recoveryKey).digest('hex').slice(0, 32)}`;

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
  assert.deepEqual(pendingFiles, [`${pendingStateKey}.json`]);
  await assert.rejects(fs.access(path.join(pendingDir, `${recoveryKey}.json`)));
});
