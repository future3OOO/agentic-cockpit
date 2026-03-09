import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import crypto from 'node:crypto';
import childProcess from 'node:child_process';

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

async function computeSkillsHash(skillsSelected, { taskCwd } = {}) {
  const normalized = Array.isArray(skillsSelected)
    ? skillsSelected
        .map((s) => String(s ?? '').trim())
        .map((s) => (s.startsWith('$') ? s.slice(1) : s))
        .filter(Boolean)
        .sort()
    : [];
  const skillsRoot = taskCwd ? path.join(taskCwd, '.codex', 'skills') : null;
  /** @type {Record<string, string>} */
  const fingerprints = {};
  for (const name of normalized) {
    if (!skillsRoot) {
      fingerprints[name] = 'unknown';
      continue;
    }
    const skillFile = path.join(skillsRoot, name, 'SKILL.md');
    try {
      const raw = await fs.readFile(skillFile);
      fingerprints[name] = `sha256:${crypto.createHash('sha256').update(raw).digest('hex')}`;
    } catch {
      fingerprints[name] = 'missing';
    }
  }
  const payload = JSON.stringify({ skills: normalized, fingerprints });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

const DUMMY_APP_SERVER_WARM = String.raw`#!/usr/bin/env python3
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

args_log = os.environ.get("DUMMY_CODEX_ARGS_LOG", "")
prompt_log = os.environ.get("DUMMY_CODEX_PROMPT_LOG", "")
count_file = os.environ.get("COUNT_FILE", "")
forced_thread_id = os.environ.get("THREAD_ID", "")

def log(file_path, line):
    if not file_path:
        return
    with open(file_path, "a", encoding="utf-8") as fh:
        fh.write(f"{line}\n")

def next_thread_id():
    if forced_thread_id:
        return forced_thread_id
    if not count_file:
        return "session-1"
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

for raw in sys.stdin:
    try:
        msg = json.loads(raw)
    except Exception:
        continue
    log(args_log, f"rpc {msg.get('method', 'response')}")
    if msg.get("id") is not None and msg.get("method") == "initialize":
        send({"id": msg["id"], "result": {}})
        continue
    if msg.get("method") == "initialized":
        continue
    if msg.get("id") is not None and msg.get("method") == "thread/start":
        thread_id = next_thread_id()
        log(args_log, f"start {thread_id}")
        send({"id": msg["id"], "result": {"thread": {"id": thread_id}}})
        continue
    if msg.get("id") is not None and msg.get("method") == "thread/resume":
        thread_id = str(forced_thread_id or msg.get("params", {}).get("threadId") or "session-1")
        log(args_log, f"resume {thread_id}")
        send({"id": msg["id"], "result": {"thread": {"id": thread_id}}})
        continue
    if msg.get("id") is not None and msg.get("method") == "turn/start":
        thread_id = str(msg.get("params", {}).get("threadId") or forced_thread_id or "session-1")
        turn_id = "turn-1"
        prompt = str((msg.get("params", {}).get("input") or [{}])[0].get("text") or "")
        if prompt_log:
            with open(prompt_log, "a", encoding="utf-8") as fh:
                fh.write(prompt)
                fh.write("\n<<<END>>>\n")
        send({"id": msg["id"], "result": {"turn": {"id": turn_id, "status": "inProgress", "items": []}}})
        send({"method": "turn/started", "params": {"threadId": thread_id, "turn": {"id": turn_id, "status": "inProgress", "items": []}}})
        text = json.dumps({"outcome": "done", "note": "ok", "commitSha": "", "followUps": []})
        send({"method": "item/agentMessage/delta", "params": {"delta": text, "itemId": "am1", "threadId": thread_id, "turnId": turn_id}})
        send({"method": "item/completed", "params": {"threadId": thread_id, "turnId": turn_id, "item": {"id": "am1", "type": "agentMessage", "text": text}}})
        send({"method": "turn/completed", "params": {"threadId": thread_id, "turn": {"id": turn_id, "status": "completed", "items": []}}})
`;

test('warm start: matching prompt bootstrap omits $skill invocations', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-warm-start-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const argsLog = path.join(tmp, 'dummy.args.log');
  const promptLog = path.join(tmp, 'dummy.prompt.log');

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER_WARM);

  const agentName = 'frontend';
  const skillName = 'my-skill';
  const skillsHash = await computeSkillsHash([skillName], { taskCwd: repoRoot });

  const roster = {
    orchestratorName: 'daddy-orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'daddy-autopilot',
    agents: [
      {
        name: agentName,
        role: 'codex-worker',
        skills: [skillName],
        workdir: '$REPO_ROOT',
        startCommand: `node scripts/agent-codex-worker.mjs --agent ${agentName}`,
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');

  await writeTask({
    busRoot,
    agentName,
    taskId: 't1',
    meta: { id: 't1', to: [agentName], from: 'daddy', priority: 'P2', title: 't1', signals: { kind: 'USER_REQUEST' } },
    body: 'do t1',
  });

  await fs.mkdir(path.join(busRoot, 'state'), { recursive: true });
  await fs.writeFile(path.join(busRoot, 'state', `${agentName}.session-id`), 'session-1\n', 'utf8');
  await fs.writeFile(
    path.join(busRoot, 'state', `${agentName}.prompt-bootstrap.json`),
    JSON.stringify({ updatedAt: new Date().toISOString(), agent: agentName, threadId: 'session-1', skillsHash }, null, 2) +
      '\n',
    'utf8',
  );

  const env = {
    ...process.env,
    AGENTIC_CODEX_APP_SERVER_PERSIST: '0',
    AGENTIC_CODEX_WARM_START: '1',
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_APP_SERVER_TIMEOUT_MS: '2000',
    DUMMY_CODEX_ARGS_LOG: argsLog,
    DUMMY_CODEX_PROMPT_LOG: promptLog,
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      agentName,
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

  const prompt = await fs.readFile(promptLog, 'utf8');
  assert.ok(!prompt.includes(`$${skillName}`), `expected prompt to omit $${skillName} when warm-resumed`);
});

test('warm start: mismatched prompt bootstrap includes $skill invocations', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-warm-start-mismatch-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const promptLog = path.join(tmp, 'dummy.prompt.log');

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER_WARM);

  const agentName = 'frontend';
  const skillName = 'my-skill';

  const roster = {
    orchestratorName: 'daddy-orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'daddy-autopilot',
    agents: [
      {
        name: agentName,
        role: 'codex-worker',
        skills: [skillName],
        workdir: '$REPO_ROOT',
        startCommand: `node scripts/agent-codex-worker.mjs --agent ${agentName}`,
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');

  await writeTask({
    busRoot,
    agentName,
    taskId: 't1',
    meta: { id: 't1', to: [agentName], from: 'daddy', priority: 'P2', title: 't1', signals: { kind: 'USER_REQUEST' } },
    body: 'do t1',
  });

  await fs.mkdir(path.join(busRoot, 'state'), { recursive: true });
  await fs.writeFile(path.join(busRoot, 'state', `${agentName}.session-id`), 'session-1\n', 'utf8');
  await fs.writeFile(
    path.join(busRoot, 'state', `${agentName}.prompt-bootstrap.json`),
    JSON.stringify(
      { updatedAt: new Date().toISOString(), agent: agentName, threadId: 'session-1', skillsHash: 'deadbeef' },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  const env = {
    ...process.env,
    AGENTIC_CODEX_APP_SERVER_PERSIST: '0',
    AGENTIC_CODEX_WARM_START: '1',
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_APP_SERVER_TIMEOUT_MS: '2000',
    DUMMY_CODEX_PROMPT_LOG: promptLog,
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      agentName,
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

  const prompt = await fs.readFile(promptLog, 'utf8');
  assert.ok(prompt.includes(`$${skillName}`), `expected prompt to include $${skillName} when bootstrap mismatches`);
});

test('warm start: root-scoped session pin beats agent session-id file for non-autopilot agents', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-root-pin-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const argsLog = path.join(tmp, 'dummy.args.log');

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER_WARM);

  const agentName = 'frontend';
  const rootId = 'root1';

  const roster = {
    orchestratorName: 'daddy-orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'daddy-autopilot',
    agents: [
      {
        name: agentName,
        role: 'codex-worker',
        skills: [],
        workdir: '$REPO_ROOT',
        startCommand: `node scripts/agent-codex-worker.mjs --agent ${agentName}`,
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');

  await writeTask({
    busRoot,
    agentName,
    taskId: 't1',
    meta: {
      id: 't1',
      to: [agentName],
      from: 'daddy',
      priority: 'P2',
      title: 't1',
      signals: { kind: 'USER_REQUEST', rootId },
    },
    body: 'do t1',
  });

  // Session-id file is present but should be ignored in favor of the root pin.
  await fs.mkdir(path.join(busRoot, 'state'), { recursive: true });
  await fs.writeFile(path.join(busRoot, 'state', `${agentName}.session-id`), 'session-1\n', 'utf8');
  await fs.mkdir(path.join(busRoot, 'state', 'codex-root-sessions', agentName), { recursive: true });
  await fs.writeFile(
    path.join(busRoot, 'state', 'codex-root-sessions', agentName, `${rootId}.json`),
    JSON.stringify({ updatedAt: new Date().toISOString(), agent: agentName, rootId, threadId: 'root-1' }, null, 2) + '\n',
    'utf8',
  );

  const env = {
    ...process.env,
    AGENTIC_CODEX_APP_SERVER_PERSIST: '0',
    AGENTIC_CODEX_WARM_START: '1',
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_APP_SERVER_TIMEOUT_MS: '2000',
    DUMMY_CODEX_ARGS_LOG: argsLog,
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      agentName,
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

  const args = await fs.readFile(argsLog, 'utf8');
  assert.match(args, /\bresume root-1\b/);
});

test('warm start: stale non-autopilot session-id is repinned to latest successful thread', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-repin-non-autopilot-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const argsLog = path.join(tmp, 'dummy.args.log');

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER_WARM);

  const agentName = 'frontend';
  const roster = {
    orchestratorName: 'daddy-orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'daddy-autopilot',
    agents: [
      {
        name: agentName,
        role: 'codex-worker',
        skills: [],
        workdir: '$REPO_ROOT',
        startCommand: `node scripts/agent-codex-worker.mjs --agent ${agentName}`,
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');

  await writeTask({
    busRoot,
    agentName,
    taskId: 't1',
    meta: { id: 't1', to: [agentName], from: 'daddy', priority: 'P2', title: 't1', signals: { kind: 'USER_REQUEST' } },
    body: 'do t1',
  });

  await fs.mkdir(path.join(busRoot, 'state'), { recursive: true });
  await fs.writeFile(path.join(busRoot, 'state', `${agentName}.session-id`), 'session-stale\n', 'utf8');

  const env = {
    ...process.env,
    AGENTIC_CODEX_APP_SERVER_PERSIST: '0',
    AGENTIC_CODEX_WARM_START: '1',
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_APP_SERVER_TIMEOUT_MS: '2000',
    DUMMY_CODEX_ARGS_LOG: argsLog,
    THREAD_ID: 'session-new',
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      agentName,
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

  const args = await fs.readFile(argsLog, 'utf8');
  assert.match(args, /\bresume session-new\b/);
  const repinned = (await fs.readFile(path.join(busRoot, 'state', `${agentName}.session-id`), 'utf8')).trim();
  assert.equal(repinned, 'session-new');
});
