import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import childProcess from 'node:child_process';

const DUMMY_APP_SERVER_SESSION = String.raw`#!/usr/bin/env python3
import json
import os
import signal
import sys
from pathlib import Path

signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
signal.signal(signal.SIGINT, lambda *_: sys.exit(0))

args = sys.argv[1:]
if not args or args[0] != "app-server":
    sys.stderr.write("dummy-codex: expected app-server\n")
    sys.stderr.flush()
    raise SystemExit(2)

args_log = os.environ.get("DUMMY_CODEX_LOG") or os.environ.get("DUMMY_CODEX_ARGS_LOG") or ""
count_file = os.environ.get("COUNT_FILE", "")

def log(line):
    if not args_log:
        return
    with open(args_log, "a", encoding="utf-8") as fh:
        fh.write(f"{line}\n")

def next_thread_id():
    if not count_file:
        return os.environ.get("THREAD_ID") or "session-1"
    try:
        n = int(Path(count_file).read_text(encoding="utf-8").strip() or "0")
    except Exception:
        n = 0
    n += 1
    Path(count_file).write_text(str(n), encoding="utf-8")
    return f"session-{n}"

def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

log(" ".join(args))

for raw in sys.stdin:
    try:
        msg = json.loads(raw)
    except Exception:
        continue
    log(f"rpc {msg.get('method', 'response')}")
    if msg.get("id") is not None and msg.get("method") == "initialize":
        send({"id": msg["id"], "result": {}})
        continue
    if msg.get("method") == "initialized":
        continue
    if msg.get("id") is not None and msg.get("method") == "thread/start":
        thread_id = next_thread_id()
        log(f"start {thread_id}")
        send({"id": msg["id"], "result": {"thread": {"id": thread_id}}})
        continue
    if msg.get("id") is not None and msg.get("method") == "thread/resume":
        thread_id = str(msg.get("params", {}).get("threadId") or os.environ.get("THREAD_ID") or "session-1")
        log(f"resume {thread_id}")
        send({"id": msg["id"], "result": {"thread": {"id": thread_id}}})
        continue
    if msg.get("id") is not None and msg.get("method") == "turn/start":
        thread_id = str(msg.get("params", {}).get("threadId") or os.environ.get("THREAD_ID") or "session-1")
        turn_id = "turn-1"
        payload = {"outcome": "done", "note": "ok", "commitSha": "", "followUps": []}
        text = json.dumps(payload)
        send({"id": msg["id"], "result": {"turn": {"id": turn_id, "status": "inProgress", "items": []}}})
        send({"method": "turn/started", "params": {"threadId": thread_id, "turn": {"id": turn_id, "status": "inProgress", "items": []}}})
        send({"method": "item/agentMessage/delta", "params": {"delta": text, "itemId": "am1", "threadId": thread_id, "turnId": turn_id}})
        send({"method": "item/completed", "params": {"threadId": thread_id, "turnId": turn_id, "item": {"id": "am1", "type": "agentMessage", "text": text}}})
        send({"method": "turn/completed", "params": {"threadId": thread_id, "turn": {"id": turn_id, "status": "completed", "items": []}}})
`;

function buildHermeticBaseEnv() {
  // Strip ambient runtime toggles so each test controls the worker env explicitly.
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('AGENTIC_') || key.startsWith('VALUA_')) {
      delete env[key];
    }
  }
  return env;
}

const BASE_ENV = buildHermeticBaseEnv();

function spawnProcess(cmd, args, { cwd, env }) {
  return new Promise((resolve) => {
    const proc = childProcess.spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d.toString('utf8')));
    proc.stderr.on('data', (d) => (stderr += d.toString('utf8')));
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function writeExecutable(filePath, contents) {
  await fs.writeFile(filePath, contents, 'utf8');
  await fs.chmod(filePath, 0o755);
}

async function writeTask({ busRoot, agentName, taskId, meta, body }) {
  const inbox = path.join(busRoot, 'inbox', agentName, 'new');
  await fs.mkdir(inbox, { recursive: true });
  const p = path.join(inbox, `${taskId}.md`);
  const raw = `---\n${JSON.stringify(meta)}\n---\n\n${body}\n`;
  await fs.writeFile(p, raw, 'utf8');
  return p;
}

test('daddy-autopilot: root-scoped app-server thread pin is reused for same root', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'valua-codex-worker-session-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const dummyLog = path.join(tmp, 'dummy-codex.log');

  await writeExecutable(
    dummyCodex,
    DUMMY_APP_SERVER_SESSION,
  );

  const roster = {
    daddyChatName: 'daddy',
    orchestratorName: 'daddy-orchestrator',
    autopilotName: 'daddy-autopilot',
    agents: [
      {
        name: 'daddy-autopilot',
        role: 'autopilot-worker',
        skills: [],
        workdir: '$REPO_ROOT',
        startCommand: 'node scripts/agent-codex-worker.mjs --agent daddy-autopilot',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');

  await writeTask({
    busRoot,
    agentName: 'daddy-autopilot',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['daddy-autopilot'],
      from: 'daddy',
      title: 't1',
      signals: { kind: 'USER_REQUEST', rootId: 'root-1' },
    },
    body: 'do t1',
  });

  const env = {
    ...BASE_ENV,
    AGENTIC_CODEX_APP_SERVER_PERSIST: '0',
    VALUA_AGENT_BUS_DIR: busRoot,
    DUMMY_CODEX_LOG: dummyLog,
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
  };
  const run1 = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'daddy-autopilot',
      '--bus-root',
      busRoot,
      '--roster',
      rosterPath,
      '--once',
      '--poll-ms',
      '10',
      '--codex-bin',
      dummyCodex,
    ],
    { cwd: repoRoot, env },
  );
  assert.equal(run1.code, 0, run1.stderr || run1.stdout);

  const log1 = await fs.readFile(dummyLog, 'utf8');
  assert.match(log1, /^app-server\b/m, log1);
  assert.ok(log1.includes('rpc initialize'), log1);
  assert.ok(log1.includes('rpc thread/start'), log1);
  assert.ok(!log1.includes('--sandbox'), log1);
  assert.ok(!log1.includes('--add-dir'), log1);

  const rootSessionPath = path.join(
    busRoot,
    'state',
    'codex-root-sessions',
    'daddy-autopilot',
    'root-1.json',
  );
  const rootSession = JSON.parse(await fs.readFile(rootSessionPath, 'utf8'));
  assert.equal(rootSession.threadId, 'session-1');

  await writeTask({
    busRoot,
    agentName: 'daddy-autopilot',
    taskId: 't2',
    meta: {
      id: 't2',
      to: ['daddy-autopilot'],
      from: 'daddy',
      title: 't2',
      signals: { kind: 'USER_REQUEST', rootId: 'root-1' },
    },
    body: 'do t2',
  });

  const run2 = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'daddy-autopilot',
      '--bus-root',
      busRoot,
      '--roster',
      rosterPath,
      '--once',
      '--poll-ms',
      '10',
      '--codex-bin',
      dummyCodex,
    ],
    { cwd: repoRoot, env },
  );
  assert.equal(run2.code, 0, run2.stderr || run2.stdout);

  const log = await fs.readFile(dummyLog, 'utf8');
  assert.match(log, /\bresume session-1\b/);
});

test('agent-codex-worker: app-server forwards model and reasoning defaults via config args', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'valua-codex-worker-model-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const dummyLog = path.join(tmp, 'dummy-codex.log');

  await writeExecutable(
    dummyCodex,
    DUMMY_APP_SERVER_SESSION,
  );

  const roster = {
    daddyChatName: 'daddy',
    orchestratorName: 'daddy-orchestrator',
    autopilotName: 'daddy-autopilot',
    agents: [
      {
        name: 'backend',
        role: 'backend-worker',
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
    meta: {
      id: 't1',
      to: ['backend'],
      from: 'daddy',
      title: 't1',
      signals: { kind: 'USER_REQUEST' },
    },
    body: 'do t1',
  });

  const env = {
    ...BASE_ENV,
    AGENTIC_CODEX_APP_SERVER_PERSIST: '0',
    VALUA_AGENT_BUS_DIR: busRoot,
    DUMMY_CODEX_LOG: dummyLog,
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    AGENTIC_CODEX_MODEL: 'gpt-5.4',
    AGENTIC_CODEX_MODEL_REASONING_EFFORT: 'xhigh',
    AGENTIC_CODEX_PLAN_MODE_REASONING_EFFORT: 'xhigh',
    AGENTIC_AUTOPILOT_DELEGATE_GATE: '0',
  };
  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'backend',
      '--bus-root',
      busRoot,
      '--roster',
      rosterPath,
      '--once',
      '--poll-ms',
      '10',
      '--codex-bin',
      dummyCodex,
    ],
    { cwd: repoRoot, env },
  );
  assert.equal(run.code, 0, run.stderr || run.stdout);

  const log = await fs.readFile(dummyLog, 'utf8');
  assert.ok(log.includes('-c model="gpt-5.4"'), log);
  assert.ok(log.includes('-c model_reasoning_effort="xhigh"'), log);
  assert.ok(log.includes('-c plan_mode_reasoning_effort="xhigh"'), log);
});

test('daddy-autopilot: root-scoped session rotation resets turn count for the new thread', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'valua-codex-worker-session-rotate-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const dummyLog = path.join(tmp, 'dummy-codex.log');
  const countFile = path.join(tmp, 'count.txt');

  await writeExecutable(
    dummyCodex,
    DUMMY_APP_SERVER_SESSION,
  );

  const roster = {
    daddyChatName: 'daddy',
    orchestratorName: 'daddy-orchestrator',
    autopilotName: 'daddy-autopilot',
    agents: [
      {
        name: 'daddy-autopilot',
        role: 'autopilot-worker',
        skills: [],
        workdir: '$REPO_ROOT',
        startCommand: 'node scripts/agent-codex-worker.mjs --agent daddy-autopilot',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');

  const rootSessionDir = path.join(busRoot, 'state', 'codex-root-sessions', 'daddy-autopilot');
  const rootSessionPath = path.join(rootSessionDir, 'root-rotate.json');
  await fs.mkdir(rootSessionDir, { recursive: true });
  await fs.writeFile(
    rootSessionPath,
    JSON.stringify(
      {
        updatedAt: new Date().toISOString(),
        agent: 'daddy-autopilot',
        rootId: 'root-rotate',
        threadId: 'session-old',
        turnCount: 40,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  await writeTask({
    busRoot,
    agentName: 'daddy-autopilot',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['daddy-autopilot'],
      from: 'daddy',
      title: 't1',
      signals: { kind: 'USER_REQUEST', rootId: 'root-rotate' },
    },
    body: 'do t1',
  });

  const env = {
    ...BASE_ENV,
    AGENTIC_CODEX_APP_SERVER_PERSIST: '0',
    AGENTIC_AUTOPILOT_DELEGATE_GATE: '0',
    AGENTIC_RUNTIME_POLICY_SYNC: '0',
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    AGENTIC_AUTOPILOT_SESSION_ROTATE_TURNS: '40',
    COUNT_FILE: countFile,
    DUMMY_CODEX_LOG: dummyLog,
  };

  const run1 = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'daddy-autopilot',
      '--bus-root',
      busRoot,
      '--roster',
      rosterPath,
      '--once',
      '--poll-ms',
      '10',
      '--codex-bin',
      dummyCodex,
    ],
    { cwd: repoRoot, env },
  );
  assert.equal(run1.code, 0, run1.stderr || run1.stdout);

  const logAfterFirst = await fs.readFile(dummyLog, 'utf8');
  assert.doesNotMatch(logAfterFirst, /\bresume session-old\b/);

  const rootSessionAfterFirst = JSON.parse(await fs.readFile(rootSessionPath, 'utf8'));
  assert.equal(rootSessionAfterFirst.threadId, 'session-1');
  assert.equal(rootSessionAfterFirst.turnCount, 1);

  await writeTask({
    busRoot,
    agentName: 'daddy-autopilot',
    taskId: 't2',
    meta: {
      id: 't2',
      to: ['daddy-autopilot'],
      from: 'daddy',
      title: 't2',
      signals: { kind: 'USER_REQUEST', rootId: 'root-rotate' },
    },
    body: 'do t2',
  });

  const run2 = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'daddy-autopilot',
      '--bus-root',
      busRoot,
      '--roster',
      rosterPath,
      '--once',
      '--poll-ms',
      '10',
      '--codex-bin',
      dummyCodex,
    ],
    { cwd: repoRoot, env },
  );
  assert.equal(run2.code, 0, run2.stderr || run2.stdout);

  const logAfterSecond = await fs.readFile(dummyLog, 'utf8');
  assert.match(logAfterSecond, /\bresume session-1\b/);

  const rootSessionAfterSecond = JSON.parse(await fs.readFile(rootSessionPath, 'utf8'));
  assert.equal(rootSessionAfterSecond.turnCount, 2);
});

test('daddy-autopilot: AGENTIC_AUTOPILOT_SESSION_ROTATE_TURNS=0 disables rotation', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'valua-codex-worker-session-rotate-zero-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const dummyLog = path.join(tmp, 'dummy-codex.log');

  await writeExecutable(
    dummyCodex,
    DUMMY_APP_SERVER_SESSION,
  );

  const roster = {
    daddyChatName: 'daddy',
    orchestratorName: 'daddy-orchestrator',
    autopilotName: 'daddy-autopilot',
    agents: [
      {
        name: 'daddy-autopilot',
        role: 'autopilot-worker',
        skills: [],
        workdir: '$REPO_ROOT',
        startCommand: 'node scripts/agent-codex-worker.mjs --agent daddy-autopilot',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');

  const rootSessionDir = path.join(busRoot, 'state', 'codex-root-sessions', 'daddy-autopilot');
  const rootSessionPath = path.join(rootSessionDir, 'root-no-rotate.json');
  await fs.mkdir(rootSessionDir, { recursive: true });
  await fs.writeFile(
    rootSessionPath,
    JSON.stringify(
      {
        updatedAt: new Date().toISOString(),
        agent: 'daddy-autopilot',
        rootId: 'root-no-rotate',
        threadId: 'session-old',
        turnCount: 999,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  await writeTask({
    busRoot,
    agentName: 'daddy-autopilot',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['daddy-autopilot'],
      from: 'daddy',
      title: 't1',
      signals: { kind: 'USER_REQUEST', rootId: 'root-no-rotate' },
    },
    body: 'do t1',
  });

  const env = {
    ...BASE_ENV,
    AGENTIC_CODEX_APP_SERVER_PERSIST: '0',
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    AGENTIC_AUTOPILOT_SESSION_ROTATE_TURNS: '0',
    DUMMY_CODEX_LOG: dummyLog,
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'daddy-autopilot',
      '--bus-root',
      busRoot,
      '--roster',
      rosterPath,
      '--once',
      '--poll-ms',
      '10',
      '--codex-bin',
      dummyCodex,
    ],
    { cwd: repoRoot, env },
  );
  assert.equal(run.code, 0, run.stderr || run.stdout);

  const log = await fs.readFile(dummyLog, 'utf8');
  assert.match(log, /\bresume session-old\b/);

  const rootSession = JSON.parse(await fs.readFile(rootSessionPath, 'utf8'));
  assert.equal(rootSession.threadId, 'session-old');
  assert.equal(rootSession.turnCount, 1000);
});

test('daddy-autopilot: root-scoped session ignores stale global session pin', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'valua-codex-worker-repin-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const dummyLog = path.join(tmp, 'dummy-codex.log');

  await writeExecutable(
    dummyCodex,
    DUMMY_APP_SERVER_SESSION,
  );

  const roster = {
    daddyChatName: 'daddy',
    orchestratorName: 'daddy-orchestrator',
    autopilotName: 'daddy-autopilot',
    agents: [
      {
        name: 'daddy-autopilot',
        role: 'autopilot-worker',
        skills: [],
        workdir: '$REPO_ROOT',
        startCommand: 'node scripts/agent-codex-worker.mjs --agent daddy-autopilot',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');
  await fs.mkdir(path.join(busRoot, 'state'), { recursive: true });
  await fs.writeFile(path.join(busRoot, 'state', 'daddy-autopilot.session-id'), 'session-stale\n', 'utf8');

  await writeTask({
    busRoot,
    agentName: 'daddy-autopilot',
    taskId: 't-repin',
    meta: {
      id: 't-repin',
      to: ['daddy-autopilot'],
      from: 'daddy',
      title: 'repin',
      signals: { kind: 'USER_REQUEST', rootId: 'root-repin' },
    },
    body: 'repin task',
  });

  const env = {
    ...BASE_ENV,
    AGENTIC_CODEX_APP_SERVER_PERSIST: '0',
    VALUA_AGENT_BUS_DIR: busRoot,
    DUMMY_CODEX_LOG: dummyLog,
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    THREAD_ID: 'session-new',
  };
  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'daddy-autopilot',
      '--bus-root',
      busRoot,
      '--roster',
      rosterPath,
      '--once',
      '--poll-ms',
      '10',
      '--codex-bin',
      dummyCodex,
    ],
    { cwd: repoRoot, env },
  );
  assert.equal(run.code, 0, run.stderr || run.stdout);

  const log = await fs.readFile(dummyLog, 'utf8');
  assert.doesNotMatch(log, /\bresume session-stale\b/);

  const repinned = JSON.parse(
    await fs.readFile(path.join(busRoot, 'state', 'codex-root-sessions', 'daddy-autopilot', 'root-repin.json'), 'utf8'),
  );
  assert.equal(repinned.threadId, 'session-new');
});

test('VALUA_CODEX_ENABLE_CHROME_DEVTOOLS=1: does not force-disable chrome-devtools MCP', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'valua-codex-worker-chrome-mcp-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const dummyLog = path.join(tmp, 'dummy-codex.log');

  await writeExecutable(
    dummyCodex,
    DUMMY_APP_SERVER_SESSION,
  );

  const roster = {
    daddyChatName: 'daddy',
    orchestratorName: 'daddy-orchestrator',
    autopilotName: 'daddy-autopilot',
    agents: [
      {
        name: 'daddy-autopilot',
        role: 'autopilot-worker',
        skills: [],
        workdir: '$REPO_ROOT',
        startCommand: 'node scripts/agent-codex-worker.mjs --agent daddy-autopilot',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');

  await writeTask({
    busRoot,
    agentName: 'daddy-autopilot',
    taskId: 't1',
    meta: { id: 't1', to: ['daddy-autopilot'], from: 'daddy', title: 't1', signals: { kind: 'USER_REQUEST' } },
    body: 'do t1',
  });

  const env = {
    ...BASE_ENV,
    AGENTIC_CODEX_APP_SERVER_PERSIST: '0',
    VALUA_AGENT_BUS_DIR: busRoot,
    DUMMY_CODEX_LOG: dummyLog,
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '1',
  };
  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'daddy-autopilot',
      '--bus-root',
      busRoot,
      '--roster',
      rosterPath,
      '--once',
      '--poll-ms',
      '10',
      '--codex-bin',
      dummyCodex,
    ],
    { cwd: repoRoot, env },
  );
  assert.equal(run.code, 0, run.stderr || run.stdout);

  const log = await fs.readFile(dummyLog, 'utf8');
  assert.ok(!log.includes('mcp_servers.chrome-devtools.enabled=false'), log);
});
