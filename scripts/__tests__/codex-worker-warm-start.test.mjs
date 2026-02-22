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

const DUMMY_CODEX_BASH = [
  '#!/usr/bin/env bash',
  'set -euo pipefail',
  '',
  'args_log="${DUMMY_CODEX_ARGS_LOG:-}"',
  'prompt_log="${DUMMY_CODEX_PROMPT_LOG:-}"',
  'if [[ -n "$args_log" ]]; then echo "$*" >> "$args_log"; fi',
  'if [[ -n "$prompt_log" ]]; then',
  '  cat >> "$prompt_log"',
  '  printf "\\n<<<END>>>\\n" >> "$prompt_log"',
  'else',
  '  cat >/dev/null',
  'fi',
  '',
  'echo "session id: session-1" >&2',
  '',
  'out=""',
  'for ((i=1; i<=$#; i++)); do',
  '  arg="${!i}"',
  '  if [[ "$arg" == "-o" ]]; then j=$((i+1)); out="${!j}"; fi',
  'done',
  'if [[ -n "$out" ]]; then echo \'{"outcome":"done","note":"ok","commitSha":"","followUps":[]}\' > "$out"; fi',
  '',
].join('\n');

test('warm start: matching prompt bootstrap omits $skill invocations', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-warm-start-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const argsLog = path.join(tmp, 'dummy.args.log');
  const promptLog = path.join(tmp, 'dummy.prompt.log');

  await writeExecutable(dummyCodex, DUMMY_CODEX_BASH);

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
    AGENTIC_CODEX_WARM_START: '1',
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_EXEC_TIMEOUT_MS: '2000',
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

  await writeExecutable(dummyCodex, DUMMY_CODEX_BASH);

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
    AGENTIC_CODEX_WARM_START: '1',
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_EXEC_TIMEOUT_MS: '2000',
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

  await writeExecutable(dummyCodex, DUMMY_CODEX_BASH);

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
    AGENTIC_CODEX_WARM_START: '1',
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_EXEC_TIMEOUT_MS: '2000',
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

  await writeExecutable(dummyCodex, DUMMY_CODEX_BASH.replace('session-1', 'session-new'));

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
    AGENTIC_CODEX_WARM_START: '1',
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_EXEC_TIMEOUT_MS: '2000',
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
  assert.match(args, /\bresume session-stale\b/);
  const repinned = (await fs.readFile(path.join(busRoot, 'state', `${agentName}.session-id`), 'utf8')).trim();
  assert.equal(repinned, 'session-new');
});

test('exec sandbox includes CODEX_HOME as writable dir when isolated home is enabled', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-home-exec-writable-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const argsLog = path.join(tmp, 'dummy.args.log');

  await writeExecutable(dummyCodex, DUMMY_CODEX_BASH);

  const agentName = 'backend';
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

  const env = {
    ...process.env,
    AGENTIC_CODEX_ENGINE: 'exec',
    AGENTIC_CODEX_HOME_MODE: 'agent',
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_EXEC_TIMEOUT_MS: '2000',
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
  const expectedCodexHome = path.join(busRoot, 'state', 'codex-home', agentName);
  assert.match(args, new RegExp(`--add-dir ${expectedCodexHome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
});
