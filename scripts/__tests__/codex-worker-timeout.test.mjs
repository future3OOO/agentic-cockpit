import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  buildHermeticBaseEnv,
  makeTempDir,
  runCodexWorkerOnce,
  writeExecutable,
  writeTask,
} from './helpers/codex-worker-harness.mjs';

const DUMMY_APP_SERVER_TIMEOUT = String.raw`#!/usr/bin/env python3
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

for raw in sys.stdin:
    try:
        msg = json.loads(raw)
    except Exception:
        continue
    if msg.get("id") is not None and msg.get("method") == "initialize":
        send({"id": msg["id"], "result": {}})
        continue
    if msg.get("method") == "initialized":
        continue
    if msg.get("id") is not None and msg.get("method") == "thread/start":
        send({"id": msg["id"], "result": {"thread": {"id": "thread-timeout"}}})
        continue
    if msg.get("id") is not None and msg.get("method") == "turn/interrupt":
        send({"id": msg["id"], "result": {}})
        send({"method": "turn/completed", "params": {"threadId": "thread-timeout", "turn": {"id": "turn-timeout", "status": "interrupted", "items": []}}})
        continue
    if msg.get("id") is not None and msg.get("method") == "turn/start":
        send({"id": msg["id"], "result": {"turn": {"id": "turn-timeout", "status": "inProgress", "items": []}}})
        send({"method": "turn/started", "params": {"threadId": "thread-timeout", "turn": {"id": "turn-timeout", "status": "inProgress", "items": []}}})
        continue
`;

const BASE_ENV = buildHermeticBaseEnv();

test('agent-codex-worker watchdog: times out codex app-server and marks task blocked', async () => {
  const repoRoot = process.cwd();
  const tmp = await makeTempDir('valua-codex-worker-timeout-');
  const busRoot = `${tmp}/bus`;
  const rosterPath = `${tmp}/ROSTER.json`;
  const dummyCodex = `${tmp}/dummy-codex`;

  await writeExecutable(
    dummyCodex,
    DUMMY_APP_SERVER_TIMEOUT,
  );

  const roster = {
    orchestratorName: 'daddy-orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'daddy-autopilot',
    agents: [
      {
        name: 'backend',
        role: 'codex-worker',
        skills: [],
        workdir: '$REPO_ROOT',
        startCommand: 'node scripts/agent-codex-worker.mjs --agent backend',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');

  await writeTask({
    busRoot,
    agentName: 'backend',
    taskId: 't1',
    meta: { id: 't1', to: ['backend'], from: 'daddy', priority: 'P2', title: 't1', signals: { kind: 'USER_REQUEST' } },
    body: 'do t1',
  });

  const env = {
    ...BASE_ENV,
    AGENTIC_CODEX_APP_SERVER_PERSIST: '0',
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_APP_SERVER_TIMEOUT_MS: '50',
  };

  const run = await runCodexWorkerOnce({
    repoRoot,
    busRoot,
    rosterPath,
    agentName: 'backend',
    codexBin: dummyCodex,
    env,
  });
  assert.equal(run.code, 0, run.stderr || run.stdout);

  const receiptPath = path.join(busRoot, 'receipts', 'backend', 't1.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(receipt.outcome, 'blocked');
  assert.match(receipt.note, /\bcodex app-server timed out\b/);

  const processedPath = path.join(busRoot, 'inbox', 'backend', 'processed', 't1.md');
  await fs.stat(processedPath);
});

test('agent-codex-worker watchdog still honors legacy exec timeout aliases during app-server transition', async () => {
  const repoRoot = process.cwd();
  const tmp = await makeTempDir('valua-codex-worker-timeout-legacy-');
  const busRoot = `${tmp}/bus`;
  const rosterPath = `${tmp}/ROSTER.json`;
  const dummyCodex = `${tmp}/dummy-codex`;

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER_TIMEOUT);

  const roster = {
    orchestratorName: 'daddy-orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'daddy-autopilot',
    agents: [
      {
        name: 'backend',
        role: 'codex-worker',
        skills: [],
        workdir: '$REPO_ROOT',
        startCommand: 'node scripts/agent-codex-worker.mjs --agent backend',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');

  await writeTask({
    busRoot,
    agentName: 'backend',
    taskId: 't1',
    meta: { id: 't1', to: ['backend'], from: 'daddy', priority: 'P2', title: 't1', signals: { kind: 'USER_REQUEST' } },
    body: 'do t1',
  });

  const env = {
    ...BASE_ENV,
    AGENTIC_CODEX_APP_SERVER_PERSIST: '0',
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_EXEC_TIMEOUT_MS: '50',
  };

  const run = await runCodexWorkerOnce({
    repoRoot,
    busRoot,
    rosterPath,
    agentName: 'backend',
    codexBin: dummyCodex,
    env,
  });
  assert.equal(run.code, 0, run.stderr || run.stdout);

  const receiptPath = path.join(busRoot, 'receipts', 'backend', 't1.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(receipt.outcome, 'blocked');
  assert.match(receipt.note, /\bcodex app-server timed out\b/);
});
