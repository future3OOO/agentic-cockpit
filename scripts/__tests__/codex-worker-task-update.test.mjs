import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import childProcess from 'node:child_process';

function buildHermeticBaseEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('AGENTIC_') || key.startsWith('VALUA_')) {
      delete env[key];
    }
  }
  return env;
}

const BASE_ENV = buildHermeticBaseEnv();

const DUMMY_APP_SERVER_UPDATE = String.raw`#!/usr/bin/env python3
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

count_file = os.environ.get("COUNT_FILE", "")
started1 = os.environ.get("STARTED1", "")
interrupted1 = os.environ.get("INTERRUPTED1", "")
current_turn_id = ""

def bump_count():
    try:
        n = int(Path(count_file).read_text(encoding="utf-8").strip() or "0")
    except Exception:
        n = 0
    n += 1
    Path(count_file).write_text(str(n), encoding="utf-8")
    return n

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
        send({"id": msg["id"], "result": {"thread": {"id": "thread-update"}}})
        continue
    if msg.get("id") is not None and msg.get("method") == "thread/resume":
        send({"id": msg["id"], "result": {"thread": {"id": "thread-update"}}})
        continue
    if msg.get("id") is not None and msg.get("method") == "turn/interrupt":
        turn_id = str(msg.get("params", {}).get("turnId") or "")
        send({"id": msg["id"], "result": {}})
        if turn_id and turn_id == current_turn_id:
            if interrupted1:
                Path(interrupted1).write_text(current_turn_id, encoding="utf-8")
            send({"method": "turn/completed", "params": {"threadId": "thread-update", "turn": {"id": current_turn_id, "status": "interrupted", "items": []}}})
        continue
    if msg.get("id") is not None and msg.get("method") == "turn/start":
        n = bump_count()
        prompt = str((msg.get("params", {}).get("input") or [{}])[0].get("text") or "")
        current_turn_id = f"turn-{n}"
        send({"id": msg["id"], "result": {"turn": {"id": current_turn_id, "status": "inProgress", "items": []}}})
        send({"method": "turn/started", "params": {"threadId": "thread-update", "turn": {"id": current_turn_id, "status": "inProgress", "items": []}}})
        if n == 1:
            Path(started1).write_text("", encoding="utf-8")
            continue
        note = "saw-update" if "SENTINEL_UPDATE" in prompt else "no-update"
        text = json.dumps({"outcome": "done", "note": note, "commitSha": "", "followUps": []})
        send({"method": "item/agentMessage/delta", "params": {"delta": text, "itemId": "am1", "threadId": "thread-update", "turnId": current_turn_id}})
        send({"method": "item/completed", "params": {"threadId": "thread-update", "turnId": current_turn_id, "item": {"id": "am1", "type": "agentMessage", "text": text}}})
        send({"method": "turn/completed", "params": {"threadId": "thread-update", "turn": {"id": current_turn_id, "status": "completed", "items": []}}})
`;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

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

async function waitForPath(p, { timeoutMs = 5000, pollMs = 25 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await fs.stat(p);
      return true;
    } catch {
      // ignore
    }
    await sleep(pollMs);
  }
  return false;
}

test('agent-codex-worker: restarts codex app-server turn when task file is updated', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'valua-codex-worker-update-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const countFile = path.join(tmp, 'count.txt');
  const started1 = path.join(tmp, 'attempt1.started');
  const interrupted1 = path.join(tmp, 'attempt1.interrupted');

  await writeExecutable(
    dummyCodex,
    DUMMY_APP_SERVER_UPDATE,
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
    VALUA_CODEX_APP_SERVER_TIMEOUT_MS: '5000',
    VALUA_CODEX_TASK_UPDATE_POLL_MS: '200',
    COUNT_FILE: countFile,
    STARTED1: started1,
    INTERRUPTED1: interrupted1,
  };

  const runPromise = spawnProcess(
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

  assert.equal(await waitForPath(started1, { timeoutMs: 10000, pollMs: 25 }), true);
  const inProgressPath = path.join(busRoot, 'inbox', 'backend', 'in_progress', 't1.md');
  assert.equal(await waitForPath(inProgressPath, { timeoutMs: 10000, pollMs: 25 }), true);
  await sleep(50);
  await fs.appendFile(inProgressPath, '\n\nSENTINEL_UPDATE\n', 'utf8');
  const bumpedMtime = new Date(Date.now() + 1000);
  await fs.utimes(inProgressPath, bumpedMtime, bumpedMtime);

  const run = await runPromise;
  assert.equal(run.code, 0, run.stderr || run.stdout);
  assert.equal(await waitForPath(interrupted1, { timeoutMs: 1000, pollMs: 25 }), true);

  const receiptPath = path.join(busRoot, 'receipts', 'backend', 't1.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(receipt.outcome, 'done');
  assert.match(receipt.note, /\bsaw-update\b/);

  const invoked = Number(await fs.readFile(countFile, 'utf8'));
  assert.equal(invoked, 2);
});
