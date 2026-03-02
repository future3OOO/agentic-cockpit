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
  return new Promise((resolve, reject) => {
    const proc = childProcess.spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d.toString('utf8')));
    proc.stderr.on('data', (d) => (stderr += d.toString('utf8')));
    proc.on('exit', (code) => resolve({ code, stdout, stderr }));
    proc.on('error', reject);
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseTaskMeta(rawMarkdown) {
  const match = /^---\n([\s\S]*?)\n---/.exec(String(rawMarkdown || ''));
  if (!match) throw new Error('missing task frontmatter');
  return JSON.parse(match[1]);
}

async function waitForOpusConsultRequestMeta({ busRoot, timeoutMs = 4_000 }) {
  const inboxDir = path.join(busRoot, 'inbox', 'opus-consult', 'new');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    let entries = [];
    try {
      entries = await fs.readdir(inboxDir);
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.md')) continue;
      const raw = await fs.readFile(path.join(inboxDir, entry), 'utf8');
      const meta = parseTaskMeta(raw);
      if (meta?.signals?.kind === 'OPUS_CONSULT_REQUEST') {
        return meta;
      }
    }
    await sleep(25);
  }
  throw new Error('timed out waiting for OPUS_CONSULT_REQUEST');
}

function buildValidConsultResponsePayload({ consultId, round }) {
  return {
    version: 'v1',
    consultId,
    round,
    final: true,
    verdict: 'pass',
    rationale:
      'Validated consult response for deterministic gate flow testing with complete schema coverage.',
    suggested_plan: ['Proceed with deterministic execution flow and preserve runtime evidence.'],
    alternatives: [],
    challenge_points: [],
    code_suggestions: [],
    required_questions: [],
    required_actions: [],
    retry_prompt_patch: '',
    unresolved_critical_questions: [],
    reasonCode: 'opus_consult_pass',
  };
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

function buildAutopilotRoster({ includeOpusConsult = false } = {}) {
  const agents = [
    {
      name: 'autopilot',
      role: 'autopilot-worker',
      skills: [],
      workdir: '$REPO_ROOT',
      startCommand: 'node scripts/agent-codex-worker.mjs --agent autopilot',
    },
  ];
  if (includeOpusConsult) {
    agents.push({
      name: 'opus-consult',
      role: 'opus-consult-worker',
      skills: [],
      workdir: '$REPO_ROOT',
      startCommand: 'node scripts/agent-opus-consult-worker.mjs --agent opus-consult',
    });
  }
  return {
    orchestratorName: 'orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'autopilot',
    agents,
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
    AGENTIC_OPUS_CONSULT_MODE: 'gate',
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
    AGENTIC_OPUS_CONSULT_MODE: 'gate',
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

test('daddy-autopilot: OPUS pre-exec gate fails closed when consult response is structurally valid but semantically contradictory', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-opus-preexec-contradictory-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const countFile = path.join(tmp, 'count.txt');

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);

  const roster = buildAutopilotRoster({ includeOpusConsult: true });
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
      title: 'preexec contradictory consult payload',
      signals: { kind: 'USER_REQUEST' },
    },
    body: 'run preexec gate with contradictory consult response',
  });

  const env = {
    ...BASE_ENV,
    AGENTIC_CODEX_ENGINE: 'app-server',
    AGENTIC_AUTOPILOT_DELEGATE_GATE: '0',
    AGENTIC_AUTOPILOT_OPUS_GATE: '1',
    AGENTIC_OPUS_CONSULT_MODE: 'gate',
    AGENTIC_AUTOPILOT_OPUS_GATE_KINDS: 'USER_REQUEST',
    AGENTIC_AUTOPILOT_OPUS_POST_REVIEW: '0',
    AGENTIC_AUTOPILOT_OPUS_CONSULT_AGENT: 'opus-consult',
    AGENTIC_AUTOPILOT_OPUS_GATE_TIMEOUT_MS: '1200',
    AGENTIC_OPUS_TIMEOUT_MS: '800',
    AGENTIC_OPUS_MAX_RETRIES: '0',
    COUNT_FILE: countFile,
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_EXEC_TIMEOUT_MS: '5000',
  };

  const runPromise = spawnProcess(
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

  const consultRequestMeta = await waitForOpusConsultRequestMeta({ busRoot, timeoutMs: 4_000 });
  const requestPayload = consultRequestMeta?.references?.opus ?? {};
  await writeTask({
    busRoot,
    agentName: 'autopilot',
    taskId: 'resp_invalid',
    meta: {
      id: 'resp_invalid',
      to: ['autopilot'],
      from: 'opus-consult',
      priority: 'P2',
      title: 'contradictory consult response',
      signals: {
        kind: 'OPUS_CONSULT_RESPONSE',
        phase: consultRequestMeta?.signals?.phase || 'pre_exec',
        rootId: consultRequestMeta?.signals?.rootId || null,
        parentId: consultRequestMeta?.signals?.parentId || null,
        smoke: false,
        notifyOrchestrator: false,
      },
      references: {
        opus: {
          version: 'v1',
          consultId: requestPayload.consultId,
          round: requestPayload.round,
          final: false,
          verdict: 'block',
          rationale:
            'Intentional contradiction for gate hardening test: block verdict with non-final payload must fail validation.',
          suggested_plan: ['Reject contradictory payload and wait for valid response.'],
          alternatives: [],
          challenge_points: [],
          code_suggestions: [],
          required_questions: [],
          required_actions: ['Stop and return corrected consult response.'],
          retry_prompt_patch: 'Return a corrected block response with final=true.',
          unresolved_critical_questions: [],
          reasonCode: 'opus_consult_block',
        },
      },
    },
    body: 'invalid response for fail-closed consult gate test',
  });

  const run = await runPromise;
  assert.equal(run.code, 0, run.stderr || run.stdout);

  const invalidResponseReceiptPath = path.join(busRoot, 'receipts', 'autopilot', 'resp_invalid.json');
  const invalidResponseReceipt = JSON.parse(await fs.readFile(invalidResponseReceiptPath, 'utf8'));
  assert.equal(invalidResponseReceipt.outcome, 'blocked');
  assert.equal(invalidResponseReceipt.receiptExtra.reasonCode, 'opus_consult_response_schema_invalid');
  assert.match(
    String((invalidResponseReceipt.receiptExtra.errors || []).join('; ')),
    /block verdict must set final=true/i,
  );

  const rootReceiptPath = path.join(busRoot, 'receipts', 'autopilot', 't1.json');
  const rootReceipt = JSON.parse(await fs.readFile(rootReceiptPath, 'utf8'));
  assert.equal(rootReceipt.outcome, 'blocked');
  assert.equal(rootReceipt.receiptExtra.reasonCode, 'opus_consult_response_timeout');
  assert.equal(rootReceipt.receiptExtra.opusConsultBarrier.locked, true);
});

test('daddy-autopilot: advisory mode continues on missing consult agent and still executes codex turn', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-opus-advisory-missing-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const countFile = path.join(tmp, 'count.txt');

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);
  await fs.writeFile(rosterPath, JSON.stringify(buildAutopilotRoster(), null, 2) + '\n', 'utf8');

  await writeTask({
    busRoot,
    agentName: 'autopilot',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['autopilot'],
      from: 'daddy',
      priority: 'P2',
      title: 'advisory missing consult',
      signals: { kind: 'USER_REQUEST' },
    },
    body: 'run advisory mode with missing consult agent',
  });

  const env = {
    ...BASE_ENV,
    AGENTIC_CODEX_ENGINE: 'app-server',
    AGENTIC_AUTOPILOT_DELEGATE_GATE: '0',
    AGENTIC_OPUS_CONSULT_MODE: 'advisory',
    AGENTIC_AUTOPILOT_OPUS_GATE: '1',
    AGENTIC_AUTOPILOT_OPUS_GATE_KINDS: 'USER_REQUEST',
    AGENTIC_AUTOPILOT_OPUS_POST_REVIEW: '0',
    AGENTIC_AUTOPILOT_OPUS_CONSULT_AGENT: 'opus-consult',
    AGENTIC_AUTOPILOT_OPUS_GATE_TIMEOUT_MS: '1200',
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
  assert.equal(receipt.outcome, 'done');
  assert.equal(receipt.receiptExtra.opusConsult.status, 'warn');
  assert.equal(receipt.receiptExtra.opusConsult.consultMode, 'advisory');
  assert.equal(receipt.receiptExtra.opusConsult.reasonCode, 'opus_consult_dispatch_failed');
  assert.equal(receipt.receiptExtra.opusConsultBarrier.locked, false);

  const turnCount = await readCountFile(countFile);
  assert.equal(turnCount, 1);
});

test('daddy-autopilot: advisory synthetic response stays canonical when late real response arrives', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-opus-advisory-late-real-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const countFile = path.join(tmp, 'count.txt');

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);
  await fs.writeFile(
    rosterPath,
    JSON.stringify(buildAutopilotRoster({ includeOpusConsult: true }), null, 2) + '\n',
    'utf8',
  );

  await writeTask({
    busRoot,
    agentName: 'autopilot',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['autopilot'],
      from: 'daddy',
      priority: 'P2',
      title: 'advisory late real response',
      signals: { kind: 'USER_REQUEST' },
    },
    body: 'simulate late real consult response after synthetic advisory fallback',
  });

  const env = {
    ...BASE_ENV,
    AGENTIC_CODEX_ENGINE: 'app-server',
    AGENTIC_AUTOPILOT_DELEGATE_GATE: '0',
    AGENTIC_OPUS_CONSULT_MODE: 'advisory',
    AGENTIC_AUTOPILOT_OPUS_GATE: '1',
    AGENTIC_AUTOPILOT_OPUS_GATE_KINDS: 'USER_REQUEST',
    AGENTIC_AUTOPILOT_OPUS_POST_REVIEW: '0',
    AGENTIC_AUTOPILOT_OPUS_CONSULT_AGENT: 'opus-consult',
    AGENTIC_AUTOPILOT_OPUS_GATE_TIMEOUT_MS: '1200',
    AGENTIC_OPUS_TIMEOUT_MS: '800',
    AGENTIC_OPUS_MAX_RETRIES: '0',
    COUNT_FILE: countFile,
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_EXEC_TIMEOUT_MS: '5000',
  };

  const runPromise = spawnProcess(
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

  const consultRequestMeta = await waitForOpusConsultRequestMeta({ busRoot, timeoutMs: 4_000 });
  const requestPayload = consultRequestMeta?.references?.opus ?? {};
  const run = await runPromise;
  assert.equal(run.code, 0, run.stderr || run.stdout);

  const rootReceiptPath = path.join(busRoot, 'receipts', 'autopilot', 't1.json');
  const rootReceipt = JSON.parse(await fs.readFile(rootReceiptPath, 'utf8'));
  assert.equal(rootReceipt.outcome, 'done');
  assert.equal(rootReceipt.receiptExtra.opusConsult.status, 'warn');

  await writeTask({
    busRoot,
    agentName: 'autopilot',
    taskId: 'resp_late_real',
    meta: {
      id: 'resp_late_real',
      to: ['autopilot'],
      from: 'opus-consult',
      priority: 'P2',
      title: 'late real consult response',
      signals: {
        kind: 'OPUS_CONSULT_RESPONSE',
        phase: consultRequestMeta?.signals?.phase || 'pre_exec',
        rootId: consultRequestMeta?.signals?.rootId || null,
        parentId: consultRequestMeta?.id || null,
        smoke: false,
        notifyOrchestrator: false,
      },
      references: {
        opus: buildValidConsultResponsePayload({
          consultId: requestPayload.consultId,
          round: requestPayload.round,
        }),
      },
    },
    body: 'late real consult response after synthetic fallback',
  });

  const consumeLate = await spawnProcess(
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
  assert.equal(consumeLate.code, 0, consumeLate.stderr || consumeLate.stdout);

  const lateReceiptPath = path.join(busRoot, 'receipts', 'autopilot', 'resp_late_real.json');
  const lateReceipt = JSON.parse(await fs.readFile(lateReceiptPath, 'utf8'));
  assert.equal(lateReceipt.outcome, 'skipped');
  assert.equal(lateReceipt.receiptExtra.reasonCode, 'late_real_response_after_synthetic');
});
