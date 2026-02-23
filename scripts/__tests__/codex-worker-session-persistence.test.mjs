import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import childProcess from 'node:child_process';

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

test('daddy-autopilot: root-scoped session pin is reused for same root', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'valua-codex-worker-session-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const dummyLog = path.join(tmp, 'dummy-codex.log');

  await writeExecutable(
    dummyCodex,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "$*" >> "${dummyLog}"`,
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
  assert.ok(log1.includes('mcp_servers.chrome-devtools.enabled=false'), log1);
  assert.ok(log1.includes('--sandbox danger-full-access'), log1);
  assert.ok(!log1.includes('--sandbox workspace-write'), log1);
  assert.ok(!log1.includes('sandbox_workspace_write.network_access=true'), log1);
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
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `COUNT_FILE=${JSON.stringify(countFile)}`,
      `echo "$*" >> "${dummyLog}"`,
      'n=0',
      'if [[ -f "$COUNT_FILE" ]]; then n=$(cat "$COUNT_FILE"); fi',
      'n=$((n+1))',
      'echo "$n" > "$COUNT_FILE"',
      'echo "session id: session-${n}" >&2',
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
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    AGENTIC_AUTOPILOT_SESSION_ROTATE_TURNS: '40',
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
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "$*" >> "${dummyLog}"`,
      'echo "session id: session-old" >&2',
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
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    AGENTIC_AUTOPILOT_SESSION_ROTATE_TURNS: '0',
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
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "$*" >> "${dummyLog}"`,
      'echo "session id: session-new" >&2',
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
    VALUA_AGENT_BUS_DIR: busRoot,
    DUMMY_CODEX_LOG: dummyLog,
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
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "$*" >> "${dummyLog}"`,
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
