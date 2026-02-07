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

test('daddy-autopilot context snapshot includes open tasks even without rootId', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'valua-codex-worker-autopilot-context-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const promptPath = path.join(tmp, 'dummy-codex.prompt.txt');

  await writeExecutable(
    dummyCodex,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'promptPath="${DUMMY_PROMPT_PATH}"',
      'cat > "$promptPath"',
      'echo "session id: session-1" >&2',
      'out=""',
      'for ((i=1; i<=$#; i++)); do',
      '  arg="${!i}"',
      '  if [[ "$arg" == "-o" ]]; then j=$((i+1)); out="${!j}"; fi',
      'done',
      'if [[ -n "$out" ]]; then echo \'{"outcome":"done","note":"ok","commitSha":"","followUps":[]}\' > "$out"; fi',
      '',
    ].join('\n'),
  );

  const roster = {
    orchestratorName: 'daddy-orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'daddy-autopilot',
    agents: [
      {
        name: 'daddy-autopilot',
        role: 'autopilot-worker',
        skills: [],
        workdir: '$REPO_ROOT',
        startCommand: 'node scripts/agent-codex-worker.mjs --agent daddy-autopilot',
      },
      {
        name: 'frontend',
        role: 'codex-worker',
        skills: [],
        workdir: '$REPO_ROOT',
        startCommand: 'node scripts/agent-codex-worker.mjs --agent frontend',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');

  await writeTask({
    busRoot,
    agentName: 'frontend',
    taskId: 'front1',
    meta: {
      id: 'front1',
      to: ['frontend'],
      from: 'daddy',
      priority: 'P2',
      title: 'front1',
      signals: { kind: 'USER_REQUEST', rootId: 'root-a' },
    },
    body: 'do front1',
  });

  await writeTask({
    busRoot,
    agentName: 'frontend',
    taskId: 'front2',
    meta: {
      id: 'front2',
      to: ['frontend'],
      from: 'daddy',
      priority: 'P2',
      title: 'front2',
      signals: { kind: 'USER_REQUEST', rootId: 'root-b' },
    },
    body: 'do front2',
  });

  await writeTask({
    busRoot,
    agentName: 'daddy-autopilot',
    taskId: 't1',
    meta: { id: 't1', to: ['daddy-autopilot'], from: 'daddy', title: 't1', signals: { kind: 'USER_REQUEST' } },
    body: 'do t1',
  });

  const env = {
    ...process.env,
    VALUA_AGENT_BUS_DIR: busRoot,
    DUMMY_PROMPT_PATH: promptPath,
    VALUA_AUTOPILOT_INCLUDE_DEPLOY_JSON: '0',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
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

  const prompt = await fs.readFile(promptPath, 'utf8');
  assert.match(prompt, /\bOpen tasks:\n/);
  assert.match(prompt, /\bfront1\b/);
  assert.match(prompt, /\bfront2\b/);
});

test('daddy-autopilot fast-path skips codex for allowlisted ORCHESTRATOR_UPDATE', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'valua-codex-worker-autopilot-fastpath-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const countFile = path.join(tmp, 'count.txt');
  const promptPath = path.join(tmp, 'dummy-codex.prompt.txt');

  await writeExecutable(
    dummyCodex,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `COUNT_FILE=${JSON.stringify(countFile)}`,
      'n=0',
      'if [[ -f "$COUNT_FILE" ]]; then n=$(cat "$COUNT_FILE"); fi',
      'n=$((n+1))',
      'echo "$n" > "$COUNT_FILE"',
      'cat > "${DUMMY_PROMPT_PATH}"',
      'echo "session id: session-fastpath" >&2',
      'out=""',
      'for ((i=1; i<=$#; i++)); do',
      '  arg="${!i}"',
      '  if [[ "$arg" == "-o" ]]; then j=$((i+1)); out="${!j}"; fi',
      'done',
      'if [[ -n "$out" ]]; then echo \'{"outcome":"done","note":"ran-codex","commitSha":"","followUps":[]}\' > "$out"; fi',
      '',
    ].join('\n'),
  );

  const roster = {
    orchestratorName: 'daddy-orchestrator',
    daddyChatName: 'daddy',
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
      from: 'daddy-orchestrator',
      title: 'digest',
      signals: { kind: 'ORCHESTRATOR_UPDATE', sourceKind: 'TASK_COMPLETE' },
      references: { completedTaskKind: 'EXECUTE' },
    },
    body: 'digest body',
  });

  const env = {
    ...process.env,
    VALUA_AGENT_BUS_DIR: busRoot,
    DUMMY_PROMPT_PATH: promptPath,
    AGENTIC_AUTOPILOT_DIGEST_FASTPATH: '1',
    AGENTIC_AUTOPILOT_DIGEST_FASTPATH_ALLOWLIST: 'TASK_COMPLETE:EXECUTE',
    VALUA_AUTOPILOT_INCLUDE_DEPLOY_JSON: '0',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
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

  const receiptPath = path.join(busRoot, 'receipts', 'daddy-autopilot', 't1.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(receipt.outcome, 'done');
  assert.match(receipt.note, /fastpath ack \(TASK_COMPLETE:EXECUTE\)/);
  assert.deepEqual(receipt.receiptExtra.followUps, []);

  // Ensure codex was not invoked.
  await assert.rejects(fs.stat(promptPath));
  await assert.rejects(fs.stat(countFile));
});

test('daddy-autopilot fast-path falls back to codex when not allowlisted', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'valua-codex-worker-autopilot-fastpath-fallback-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const countFile = path.join(tmp, 'count.txt');
  const promptPath = path.join(tmp, 'dummy-codex.prompt.txt');

  await writeExecutable(
    dummyCodex,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `COUNT_FILE=${JSON.stringify(countFile)}`,
      'n=0',
      'if [[ -f "$COUNT_FILE" ]]; then n=$(cat "$COUNT_FILE"); fi',
      'n=$((n+1))',
      'echo "$n" > "$COUNT_FILE"',
      'cat > "${DUMMY_PROMPT_PATH}"',
      'echo "session id: session-fallback" >&2',
      'out=""',
      'for ((i=1; i<=$#; i++)); do',
      '  arg="${!i}"',
      '  if [[ "$arg" == "-o" ]]; then j=$((i+1)); out="${!j}"; fi',
      'done',
      'if [[ -n "$out" ]]; then echo \'{"outcome":"done","note":"ran-codex","commitSha":"","followUps":[]}\' > "$out"; fi',
      '',
    ].join('\n'),
  );

  const roster = {
    orchestratorName: 'daddy-orchestrator',
    daddyChatName: 'daddy',
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
      from: 'daddy-orchestrator',
      title: 'digest',
      signals: { kind: 'ORCHESTRATOR_UPDATE', sourceKind: 'TASK_COMPLETE' },
      references: { completedTaskKind: 'EXECUTE' },
    },
    body: 'digest body',
  });

  const env = {
    ...process.env,
    VALUA_AGENT_BUS_DIR: busRoot,
    DUMMY_PROMPT_PATH: promptPath,
    AGENTIC_AUTOPILOT_DIGEST_FASTPATH: '1',
    AGENTIC_AUTOPILOT_DIGEST_FASTPATH_ALLOWLIST: 'REVIEW_ACTION_REQUIRED:*',
    VALUA_AUTOPILOT_INCLUDE_DEPLOY_JSON: '0',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
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

  const receiptPath = path.join(busRoot, 'receipts', 'daddy-autopilot', 't1.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(receipt.outcome, 'done');
  assert.equal(receipt.note, 'ran-codex');
  assert.deepEqual(receipt.receiptExtra.followUps, []);

  assert.equal(Number(await fs.readFile(countFile, 'utf8')), 1);
  assert.match(await fs.readFile(promptPath, 'utf8'), /ORCHESTRATOR_UPDATE/);
});
