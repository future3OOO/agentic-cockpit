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

async function readCountFile(countFile) {
  const raw = await fs.readFile(countFile, 'utf8');
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

const DUMMY_APP_SERVER = [
  '#!/usr/bin/env node',
  "import { createInterface } from 'node:readline';",
  "import { promises as fs } from 'node:fs';",
  '',
  "const args = process.argv.slice(2);",
  "if (args[0] !== 'app-server') {",
  "  process.stderr.write('dummy-codex: expected app-server\\n');",
  '  process.exit(2);',
  '}',
  '',
  "const countFile = process.env.COUNT_FILE || '';",
  "const threadId = process.env.THREAD_ID || 'thread-app';",
  '',
  'async function bumpCount() {',
  '  if (!countFile) return;',
  '  let n = 0;',
  '  try { n = Number(await fs.readFile(countFile, "utf8")); } catch {}',
  '  n = Number.isFinite(n) ? n : 0;',
  '  n += 1;',
  '  await fs.writeFile(countFile, String(n), "utf8");',
  '}',
  '',
  'function send(obj) {',
  '  process.stdout.write(JSON.stringify(obj) + "\\n");',
  '}',
  '',
  'const rl = createInterface({ input: process.stdin });',
  'rl.on("line", async (line) => {',
  '  let msg;',
  '  try { msg = JSON.parse(line); } catch { return; }',
  '',
  '  if (msg && msg.id != null && msg.method === "initialize") {',
  '    send({ id: msg.id, result: {} });',
  '    return;',
  '  }',
  '  if (msg && msg.method === "initialized") return;',
  '',
  '  if (msg && msg.id != null && msg.method === "thread/start") {',
  '    send({ id: msg.id, result: { thread: { id: threadId } } });',
  '    return;',
  '  }',
  '  if (msg && msg.id != null && msg.method === "thread/resume") {',
  '    const t = msg?.params?.threadId || threadId;',
  '    send({ id: msg.id, result: { thread: { id: t } } });',
  '    return;',
  '  }',
  '',
  '  if (msg && msg.id != null && msg.method === "turn/start") {',
  '    await bumpCount();',
  '    const turnId = `turn-${Date.now()}`;',
  '    const payload = { outcome: "done", note: "ok", commitSha: "", followUps: [] };',
  '    const text = JSON.stringify(payload);',
  '    send({ id: msg.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });',
  '    send({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress", items: [] } } });',
  '    send({ method: "item/agentMessage/delta", params: { delta: text, itemId: "am1", threadId, turnId } });',
  '    send({ method: "item/completed", params: { threadId, turnId, item: { id: "am1", type: "agentMessage", text } } });',
  '    send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [] } } });',
  '  }',
  '});',
].join('\n');

function buildAutopilotRoster() {
  return {
    orchestratorName: 'orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'autopilot',
    agents: [
      {
        name: 'autopilot',
        role: 'autopilot-worker',
        skills: [],
        workdir: '$REPO_ROOT',
        startCommand: 'node scripts/agent-codex-worker.mjs --agent autopilot',
      },
    ],
  };
}

test('daddy-autopilot: OPUS pre-exec barrier blocks before Codex turn when consult agent is unavailable', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-opus-preexec-missing-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const countFile = path.join(tmp, 'count.txt');

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);

  const roster = buildAutopilotRoster();
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');

  await writeTask({
    busRoot,
    agentName: 'autopilot',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['autopilot'],
      from: 'daddy',
      priority: 'P2',
      title: 'preexec gate task',
      signals: { kind: 'USER_REQUEST' },
    },
    body: 'run preexec gate',
  });

  const env = {
    ...BASE_ENV,
    AGENTIC_CODEX_ENGINE: 'app-server',
    AGENTIC_AUTOPILOT_DELEGATE_GATE: '0',
    AGENTIC_AUTOPILOT_OPUS_GATE: '1',
    AGENTIC_AUTOPILOT_OPUS_GATE_KINDS: 'USER_REQUEST',
    AGENTIC_AUTOPILOT_OPUS_POST_REVIEW: '0',
    AGENTIC_AUTOPILOT_OPUS_CONSULT_AGENT: 'opus-consult',
    AGENTIC_AUTOPILOT_OPUS_GATE_TIMEOUT_MS: '2000',
    COUNT_FILE: countFile,
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_EXEC_TIMEOUT_MS: '5000',
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'autopilot',
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

  const receiptPath = path.join(busRoot, 'receipts', 'autopilot', 't1.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(receipt.outcome, 'blocked');
  assert.match(String(receipt.note || ''), /opus consult blocked/i);
  assert.equal(receipt.receiptExtra.reasonCode, 'opus_consult_dispatch_failed');
  assert.equal(receipt.receiptExtra.opusConsult.status, 'blocked');
  assert.equal(receipt.receiptExtra.opusConsult.phase, 'pre_exec');
  assert.equal(receipt.receiptExtra.opusConsultBarrier.locked, true);

  await assert.rejects(fs.stat(countFile));
});

test('daddy-autopilot: OPUS post-review gate can block done closure after one Codex turn when consult agent is unavailable', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-opus-postreview-missing-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const countFile = path.join(tmp, 'count.txt');

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);

  const roster = buildAutopilotRoster();
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');

  await writeTask({
    busRoot,
    agentName: 'autopilot',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['autopilot'],
      from: 'daddy',
      priority: 'P2',
      title: 'postreview gate task',
      signals: { kind: 'USER_REQUEST' },
    },
    body: 'run postreview gate',
  });

  const env = {
    ...BASE_ENV,
    AGENTIC_CODEX_ENGINE: 'app-server',
    AGENTIC_AUTOPILOT_DELEGATE_GATE: '0',
    AGENTIC_AUTOPILOT_OPUS_GATE: '0',
    AGENTIC_AUTOPILOT_OPUS_POST_REVIEW: '1',
    AGENTIC_AUTOPILOT_OPUS_POST_REVIEW_KINDS: 'USER_REQUEST',
    AGENTIC_AUTOPILOT_OPUS_CONSULT_AGENT: 'opus-consult',
    AGENTIC_AUTOPILOT_OPUS_GATE_TIMEOUT_MS: '2000',
    COUNT_FILE: countFile,
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_EXEC_TIMEOUT_MS: '5000',
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'autopilot',
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

  const receiptPath = path.join(busRoot, 'receipts', 'autopilot', 't1.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(receipt.outcome, 'blocked');
  assert.match(String(receipt.note || ''), /opus_consult_dispatch_failed/i);
  assert.equal(receipt.receiptExtra.opusConsult.status, 'skipped');
  assert.equal(receipt.receiptExtra.opusPostReview.status, 'blocked');
  assert.equal(receipt.receiptExtra.opusPostReview.phase, 'post_review');

  const turnCount = await readCountFile(countFile);
  assert.equal(turnCount, 1);
});
