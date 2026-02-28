import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import childProcess from 'node:child_process';

import { ensureBusRoot, parseFrontmatter } from '../lib/agentbus.mjs';

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

function buildRoster() {
  return {
    orchestratorName: 'orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'autopilot',
    agents: [
      { name: 'autopilot', role: 'autopilot-worker', skills: [], workdir: '$REPO_ROOT' },
      { name: 'opus-consult', role: 'opus-consult-worker', skills: [], workdir: '$REPO_ROOT' },
    ],
  };
}

function buildRequestPayload() {
  return {
    version: 'v1',
    consultId: 'consult_t1',
    round: 1,
    maxRounds: 2,
    mode: 'pre_exec',
    autopilotHypothesis: {
      summary: 'Need to decide execution path and guardrails.',
      intendedActions: ['Review plan', 'Preserve bounded execution'],
      proposedDispatches: [],
    },
    autopilotMessage: null,
    taskContext: {
      taskId: 'task_1',
      taskKind: 'USER_REQUEST',
      title: 'task title',
      bodySummary: 'task summary',
      rootId: 'root_1',
      parentId: 'parent_1',
      sourceKind: 'USER_REQUEST',
      smoke: false,
      referencesSummary: '{}',
    },
    priorRoundSummary: null,
    questions: [],
  };
}

async function readInboxMetas(dirPath) {
  let names = [];
  try {
    names = (await fs.readdir(dirPath)).filter((name) => name.endsWith('.md'));
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  const metas = [];
  for (const name of names) {
    const raw = await fs.readFile(path.join(dirPath, name), 'utf8');
    metas.push(parseFrontmatter(raw).meta);
  }
  return metas;
}

const DUMMY_OPUS_STUB = [
  '#!/usr/bin/env node',
  'const mode = process.env.OPUS_STUB_MODE || "pass";',
  'const chunks = [];',
  'process.stdin.on("data", (c) => chunks.push(c));',
  'process.stdin.on("end", () => {',
  '  let req = {};',
  '  try { req = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch {}',
  '  if (mode === "invalid-json") {',
  '    process.stdout.write("not-json\\n");',
  '    return;',
  '  }',
  '  const consultId = typeof req.consultId === "string" && req.consultId ? req.consultId : "consult_missing";',
  '  const round = Number.isFinite(Number(req.round)) ? Number(req.round) : 1;',
  '  const verdict = mode === "block" ? "block" : "pass";',
  '  const payload = {',
  '    version: "v1",',
  '    consultId,',
  '    round,',
  '    final: true,',
  '    verdict,',
  '    rationale: "This deterministic consult response validates worker packet flow for tests.",',
  '    suggested_plan: ["Proceed with bounded execution and verification."],',
  '    alternatives: [],',
  '    challenge_points: [],',
  '    code_suggestions: [],',
  '    required_questions: [],',
  '    required_actions: verdict === "block" ? ["Address blocking consult issue."] : [],',
  '    retry_prompt_patch: verdict === "block" ? "Apply fixes and rerun consult." : "",',
  '    unresolved_critical_questions: [],',
  '    reasonCode: verdict === "block" ? "opus_consult_block" : "opus_consult_pass"',
  '  };',
  '  process.stdout.write(JSON.stringify({ structured_output: payload }) + "\\n");',
  '});',
  'process.stdin.resume();',
].join('\n');

test('opus-consult worker emits response packet and closes request without orchestrator notify', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-opus-worker-pass-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const stubBin = path.join(tmp, 'dummy-opus-stub');

  await writeExecutable(stubBin, DUMMY_OPUS_STUB);

  const roster = buildRoster();
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');
  await ensureBusRoot(busRoot, roster);

  await writeTask({
    busRoot,
    agentName: 'opus-consult',
    taskId: 'consult_req_1',
    meta: {
      id: 'consult_req_1',
      to: ['opus-consult'],
      from: 'autopilot',
      priority: 'P2',
      title: 'consult request',
      signals: {
        kind: 'OPUS_CONSULT_REQUEST',
        phase: 'pre_exec',
        rootId: 'root_1',
        parentId: 'task_1',
        smoke: false,
        notifyOrchestrator: false,
      },
      references: {
        opus: buildRequestPayload(),
      },
    },
    body: 'consult request',
  });

  const env = {
    ...BASE_ENV,
    AGENTIC_OPUS_STUB_BIN: stubBin,
    AGENTIC_OPUS_MODEL: 'claude-opus-4-6',
    AGENTIC_OPUS_TIMEOUT_MS: '5000',
    AGENTIC_OPUS_MAX_RETRIES: '0',
    AGENTIC_OPUS_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_AGENT_BUS_DIR: busRoot,
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-opus-consult-worker.mjs',
      '--agent',
      'opus-consult',
      '--bus-root',
      busRoot,
      '--roster',
      rosterPath,
      '--once',
      '--poll-ms',
      '10',
    ],
    { cwd: repoRoot, env },
  );
  assert.equal(run.code, 0, run.stderr || run.stdout);

  const receiptPath = path.join(busRoot, 'receipts', 'opus-consult', 'consult_req_1.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(receipt.outcome, 'done');
  assert.equal(receipt.receiptExtra.reasonCode, 'opus_consult_pass');
  assert.equal(receipt.receiptExtra.verdict, 'pass');

  const autopilotInbox = path.join(busRoot, 'inbox', 'autopilot', 'new');
  const autopilotMetas = await readInboxMetas(autopilotInbox);
  const responseMeta = autopilotMetas.find((meta) => meta?.signals?.kind === 'OPUS_CONSULT_RESPONSE');
  assert.ok(responseMeta, 'expected OPUS_CONSULT_RESPONSE in autopilot inbox');
  assert.equal(responseMeta.signals.phase, 'pre_exec');
  assert.equal(responseMeta.signals.notifyOrchestrator, false);
  assert.equal(responseMeta.references.opus.consultId, 'consult_t1');
  assert.equal(responseMeta.references.opus.verdict, 'pass');
  assert.equal(responseMeta.references.opus.reasonCode, 'opus_consult_pass');

  const orchestratorNew = path.join(busRoot, 'inbox', 'orchestrator', 'new');
  const orchestratorMetas = await readInboxMetas(orchestratorNew);
  assert.equal(orchestratorMetas.length, 0, 'request close must not emit TASK_COMPLETE');
});

test('opus-consult worker blocks invalid request schema and returns schema-invalid response', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-opus-worker-schema-invalid-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const stubBin = path.join(tmp, 'dummy-opus-stub');

  await writeExecutable(stubBin, DUMMY_OPUS_STUB);

  const roster = buildRoster();
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');
  await ensureBusRoot(busRoot, roster);

  await writeTask({
    busRoot,
    agentName: 'opus-consult',
    taskId: 'consult_req_2',
    meta: {
      id: 'consult_req_2',
      to: ['opus-consult'],
      from: 'autopilot',
      priority: 'P2',
      title: 'consult request invalid',
      signals: {
        kind: 'OPUS_CONSULT_REQUEST',
        phase: 'pre_exec',
        rootId: 'root_2',
        parentId: 'task_2',
        smoke: false,
        notifyOrchestrator: false,
      },
      references: {
        opus: {
          version: 'v1',
          consultId: '',
        },
      },
    },
    body: 'consult request invalid payload',
  });

  const env = {
    ...BASE_ENV,
    AGENTIC_OPUS_STUB_BIN: stubBin,
    AGENTIC_OPUS_TIMEOUT_MS: '5000',
    AGENTIC_OPUS_MAX_RETRIES: '0',
    AGENTIC_OPUS_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_AGENT_BUS_DIR: busRoot,
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-opus-consult-worker.mjs',
      '--agent',
      'opus-consult',
      '--bus-root',
      busRoot,
      '--roster',
      rosterPath,
      '--once',
      '--poll-ms',
      '10',
    ],
    { cwd: repoRoot, env },
  );
  assert.equal(run.code, 0, run.stderr || run.stdout);

  const receiptPath = path.join(busRoot, 'receipts', 'opus-consult', 'consult_req_2.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(receipt.outcome, 'blocked');
  assert.equal(receipt.receiptExtra.reasonCode, 'opus_schema_invalid');

  const autopilotInbox = path.join(busRoot, 'inbox', 'autopilot', 'new');
  const autopilotMetas = await readInboxMetas(autopilotInbox);
  const responseMeta = autopilotMetas.find((meta) => meta?.signals?.kind === 'OPUS_CONSULT_RESPONSE');
  assert.ok(responseMeta, 'expected fallback OPUS_CONSULT_RESPONSE for invalid request');
  assert.equal(responseMeta.references.opus.verdict, 'block');
  assert.equal(responseMeta.references.opus.reasonCode, 'opus_schema_invalid');

  const orchestratorNew = path.join(busRoot, 'inbox', 'orchestrator', 'new');
  const orchestratorMetas = await readInboxMetas(orchestratorNew);
  assert.equal(orchestratorMetas.length, 0, 'schema-invalid close must not emit TASK_COMPLETE');
});
