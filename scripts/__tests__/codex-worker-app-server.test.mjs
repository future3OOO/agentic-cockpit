import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import childProcess from 'node:child_process';

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

const DUMMY_APP_SERVER = [
  '#!/usr/bin/env node',
  "import { createInterface } from 'node:readline';",
  "import { promises as fs } from 'node:fs';",
  '',
  "process.on('SIGTERM', () => process.exit(0));",
  "process.on('SIGINT', () => process.exit(0));",
  '',
  "const args = process.argv.slice(2);",
  "if (args[0] !== 'app-server') {",
  "  process.stderr.write('dummy-codex: expected app-server\\n');",
  '  process.exit(2);',
  '}',
  '',
  "const mode = process.env.DUMMY_MODE || 'basic';",
  "const countFile = process.env.COUNT_FILE || '';",
  "const started1 = process.env.STARTED1 || '';",
  "const threadId = process.env.THREAD_ID || 'thread-app';",
  '',
  'async function bumpCount() {',
  '  if (!countFile) return 0;',
  '  let n = 0;',
  '  try { n = Number(await fs.readFile(countFile, \"utf8\")); } catch {}',
  '  n = Number.isFinite(n) ? n : 0;',
  '  n += 1;',
  '  await fs.writeFile(countFile, String(n), \"utf8\");',
  '  return n;',
  '}',
  '',
  'function send(obj) {',
  '  process.stdout.write(JSON.stringify(obj) + \"\\n\");',
  '}',
  '',
  'let startedWritten = false;',
  'let currentTurnId = null;',
  'let pendingInterrupted = new Set();',
  '',
  'const rl = createInterface({ input: process.stdin });',
  'rl.on(\"line\", async (line) => {',
  '  let msg;',
  '  try { msg = JSON.parse(line); } catch { return; }',
  '',
  '  if (msg && msg.id != null && msg.method === \"initialize\") {',
  '    send({ id: msg.id, result: {} });',
  '    return;',
  '  }',
  '',
  '  if (msg && msg.method === \"initialized\") {',
  '    return;',
  '  }',
  '',
  '  if (msg && msg.id != null && msg.method === \"thread/start\") {',
  '    send({ id: msg.id, result: { thread: { id: threadId } } });',
  '    return;',
  '  }',
  '',
  '  if (msg && msg.id != null && msg.method === \"thread/resume\") {',
  '    const t = msg?.params?.threadId || threadId;',
  '    send({ id: msg.id, result: { thread: { id: t } } });',
  '    return;',
  '  }',
  '',
  '  if (msg && msg.id != null && msg.method === \"turn/interrupt\") {',
  '    pendingInterrupted.add(String(msg?.params?.turnId || \"\"));',
  '    send({ id: msg.id, result: {} });',
  '    return;',
  '  }',
  '',
  '  if (msg && msg.id != null && msg.method === \"turn/start\") {',
  '    await bumpCount();',
  '    const prompt = String(msg?.params?.input?.[0]?.text || \"\");',
  '    currentTurnId = `turn-${Date.now()}`;',
  '    send({ id: msg.id, result: { turn: { id: currentTurnId, status: \"inProgress\", items: [] } } });',
  '    send({ method: \"turn/started\", params: { threadId, turn: { id: currentTurnId, status: \"inProgress\", items: [] } } });',
  '',
  '    if (!startedWritten && started1) {',
  '      startedWritten = true;',
  '      await fs.writeFile(started1, \"\", \"utf8\");',
  '    }',
  '',
  '    if (mode === \"update\" && !prompt.includes(\"SENTINEL_UPDATE\")) {',
  '      // Wait for interrupt; worker should detect task file update and call turn/interrupt.',
  '      const interval = setInterval(() => {',
  '        if (!pendingInterrupted.has(currentTurnId)) return;',
  '        clearInterval(interval);',
  '        send({ method: \"turn/completed\", params: { threadId, turn: { id: currentTurnId, status: \"interrupted\", items: [] } } });',
  '      }, 20);',
  '      interval.unref?.();',
  '      return;',
  '    }',
  '',
  '    const note = prompt.includes(\"SENTINEL_UPDATE\") ? \"saw-update\" : \"ok\";',
  '    const payload = { outcome: \"done\", note, commitSha: \"\", followUps: [] };',
  '    const text = JSON.stringify(payload);',
  '    send({ method: \"item/agentMessage/delta\", params: { delta: text, itemId: \"am1\", threadId, turnId: currentTurnId } });',
  '    send({ method: \"item/completed\", params: { threadId, turnId: currentTurnId, item: { id: \"am1\", type: \"agentMessage\", text } } });',
  '    send({ method: \"turn/completed\", params: { threadId, turn: { id: currentTurnId, status: \"completed\", items: [] } } });',
  '    return;',
  '  }',
  '});',
  '',
].join('\n');

test('agent-codex-worker: app-server engine completes a task', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-basic-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);

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
    AGENTIC_CODEX_ENGINE: 'app-server',
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_EXEC_TIMEOUT_MS: '2000',
    DUMMY_MODE: 'basic',
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

  const receiptPath = path.join(busRoot, 'receipts', 'backend', 't1.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(receipt.outcome, 'done');
  assert.match(receipt.note, /\bok\b/);
});

test('agent-codex-worker: app-server engine restarts when task is updated', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-update-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const countFile = path.join(tmp, 'count.txt');
  const started1 = path.join(tmp, 'attempt1.started');

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);

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
    AGENTIC_CODEX_ENGINE: 'app-server',
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_EXEC_TIMEOUT_MS: '5000',
    VALUA_CODEX_TASK_UPDATE_POLL_MS: '50',
    DUMMY_MODE: 'update',
    COUNT_FILE: countFile,
    STARTED1: started1,
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

  assert.equal(await waitForPath(started1, { timeoutMs: 4000, pollMs: 25 }), true);
  const inProgressPath = path.join(busRoot, 'inbox', 'backend', 'in_progress', 't1.md');
  assert.equal(await waitForPath(inProgressPath, { timeoutMs: 4000, pollMs: 25 }), true);
  await fs.appendFile(inProgressPath, '\n\nSENTINEL_UPDATE\n', 'utf8');

  const run = await runPromise;
  assert.equal(run.code, 0, run.stderr || run.stdout);

  const receiptPath = path.join(busRoot, 'receipts', 'backend', 't1.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(receipt.outcome, 'done');
  assert.match(receipt.note, /\bsaw-update\b/);

  const invoked = Number(await fs.readFile(countFile, 'utf8'));
  assert.equal(invoked, 2);
});
