import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import childProcess from 'node:child_process';

function spawnProcess(cmd, args, { cwd, env }) {
  return new Promise((resolve) => {
    const proc = childProcess.spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d.toString('utf8')));
    proc.stderr.on('data', (d) => (stderr += d.toString('utf8')));
    proc.on('exit', (code) => resolve({ code, stdout, stderr }));
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

test('agent-codex-worker streams Codex stderr + captures session id (non-JSON default)', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'valua-codex-worker-json-events-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');

  await writeExecutable(
    dummyCodex,
    [
      '#!/usr/bin/env python3',
      'import json, sys',
      '',
      'thread_id = "thread-123"',
      'turn_id = ""',
      '',
      'def send(obj):',
      '    sys.stdout.write(json.dumps(obj) + "\\n")',
      '    sys.stdout.flush()',
      '',
      'for line in sys.stdin:',
      '    try:',
      '        msg = json.loads(line)',
      '    except Exception:',
      '        continue',
      '    method = msg.get("method")',
      '    if msg.get("id") is not None and method == "initialize":',
      '        send({"id": msg["id"], "result": {}})',
      '        continue',
      '    if method == "initialized":',
      '        continue',
      '    if msg.get("id") is not None and method in ("thread/start", "thread/resume"):',
      '        send({"id": msg["id"], "result": {"thread": {"id": thread_id}}})',
      '        continue',
      '    if msg.get("id") is not None and method == "turn/start":',
      '        turn_id = "turn-1"',
      '        sys.stderr.write("session id: thread-123\\n")',
      '        sys.stderr.write("[dummy] thinking: hello\\n")',
      '        sys.stderr.flush()',
      '        send({"id": msg["id"], "result": {"turn": {"id": turn_id, "status": "inProgress", "items": []}}})',
      '        send({"method": "turn/started", "params": {"threadId": thread_id, "turn": {"id": turn_id, "status": "inProgress", "items": []}}})',
      '        text = json.dumps({"outcome": "done", "note": "ok", "commitSha": "", "followUps": []})',
      '        send({"method": "item/agentMessage/delta", "params": {"delta": text, "itemId": "am1", "threadId": thread_id, "turnId": turn_id}})',
      '        send({"method": "item/completed", "params": {"threadId": thread_id, "turnId": turn_id, "item": {"id": "am1", "type": "agentMessage", "text": text}}})',
      '        send({"method": "turn/completed", "params": {"threadId": thread_id, "turn": {"id": turn_id, "status": "completed", "items": []}}})',
    ].join('\n'),
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
    ...process.env,
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
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

  assert.match(run.stderr, /\[worker\] backend task start t1\b/);
  assert.match(run.stderr, /\bsession id: thread-123\b/);
  assert.match(run.stderr, /\[dummy\] thinking: hello\b/);
  assert.match(run.stderr, /\[worker\] backend codex thread=thread-123\b/);
  assert.match(run.stderr, /\[worker\] backend task done t1 outcome=done\b/);
});
