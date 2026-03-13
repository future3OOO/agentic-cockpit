import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import childProcess from 'node:child_process';

const TMUX_STUB = [
  '#!/usr/bin/env bash',
  'set -euo pipefail',
  '',
  'log_file="${TMUX_LOG:-}"',
  'if [ -n "$log_file" ]; then',
  `  printf '%s\\n' "$*" >>"$log_file"`,
  '  if [ "${1:-}" = "set-environment" ]; then',
  `    printf 'SET %s\\n' "$*" >>"$log_file"`,
  '  fi',
  'fi',
  'exit 0',
  '',
].join('\n');

const TMUX_STARTUP_STUB = [
  '#!/usr/bin/env bash',
  'set -euo pipefail',
  '',
  'log_file="${TMUX_LOG:-}"',
  'if [ -n "$log_file" ]; then',
  `  printf '%s\\n' "$*" >>"$log_file"`,
  '  if [ "${1:-}" = "set-environment" ]; then',
  `    printf 'SET %s\\n' "$*" >>"$log_file"`,
  '  fi',
  'fi',
  '',
  'case "${1:-}" in',
  '  has-session|list-sessions|list-windows)',
  '    exit 1',
  '    ;;',
  'esac',
  '',
  'exit 0',
  '',
].join('\n');

async function writeExecutable(filePath, contents) {
  await fs.writeFile(filePath, contents, 'utf8');
  await fs.chmod(filePath, 0o755);
}

function spawn(cmd, args, { cwd, env }) {
  return new Promise((resolve) => {
    const proc = childProcess.spawn(cmd, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function parseSessionEnv(logText) {
  const result = new Map();
  for (const line of String(logText || '').split('\n')) {
    const match = /^SET set-environment -t \S+ (\S+) (.+)$/.exec(line.trim());
    if (!match) continue;
    result.set(match[1], match[2]);
  }
  return result;
}

function buildLauncherRoster({
  daddyWorkdir = '$REPO_ROOT',
  orchestratorWorkdir = '$REPO_ROOT',
  autopilotWorkdir = '$AGENTIC_WORKTREES_DIR/autopilot',
} = {}) {
  const autopilot = {
    name: 'autopilot',
    role: 'autopilot-worker',
    kind: 'codex-worker',
    branch: 'agent/autopilot',
    startCommand: 'true',
  };
  if (autopilotWorkdir !== null) {
    autopilot.workdir = autopilotWorkdir;
  }

  return {
    schemaVersion: 2,
    sessionName: 'test-cockpit',
    daddyChatName: 'daddy',
    orchestratorName: 'orchestrator',
    autopilotName: 'autopilot',
    agents: [
      {
        name: 'daddy',
        role: 'daddy-chat',
        kind: 'codex-chat',
        workdir: daddyWorkdir,
        startCommand: 'true',
      },
      {
        name: 'orchestrator',
        role: 'orchestrator-worker',
        kind: 'node-worker',
        workdir: orchestratorWorkdir,
        startCommand: 'true',
      },
      autopilot,
    ],
  };
}

async function runAgentsUpWithRoster({ roster, tmuxStub = TMUX_STUB, envOverrides = {} }) {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-cockpit-tmux-launch-'));
  const projectRoot = path.join(tmp, 'project');
  const fakeBin = path.join(tmp, 'bin');
  const busRoot = path.join(tmp, 'bus');
  const worktreesDir = path.join(tmp, 'worktrees');
  const tmuxBin = path.join(fakeBin, 'tmux');
  const tmuxLog = path.join(tmp, 'tmux.log');
  const rosterPath = path.join(projectRoot, 'docs', 'agentic', 'agent-bus', 'ROSTER.json');

  await fs.mkdir(fakeBin, { recursive: true });
  await writeExecutable(tmuxBin, tmuxStub);
  await writeJson(rosterPath, roster);

  const env = {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH || ''}`,
    TMUX_LOG: tmuxLog,
    AGENTIC_PROJECT_ROOT: projectRoot,
    AGENTIC_ROSTER_PATH: rosterPath,
    VALUA_AGENT_ROSTER_PATH: rosterPath,
    AGENTIC_BUS_DIR: busRoot,
    VALUA_AGENT_BUS_DIR: busRoot,
    AGENTIC_WORKTREES_DIR: worktreesDir,
    VALUA_AGENT_WORKTREES_DIR: worktreesDir,
    AGENTIC_PR_OBSERVER_AUTOSTART: '0',
    AGENTIC_DASHBOARD_AUTOSTART: '0',
    AGENTIC_TMUX_NO_ATTACH: '1',
    AGENTIC_WORKTREES_DISABLE: '1',
    VALUA_AGENT_WORKTREES_DISABLE: '1',
    ...envOverrides,
  };

  const run = await spawn('bash', ['scripts/tmux/agents-up.sh'], { cwd: repoRoot, env });
  let logText = '';
  try {
    logText = await fs.readFile(tmuxLog, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return { run, logText, projectRoot, worktreesDir };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('agents-up seeds app-server timeout from legacy exec timeout when new names are unset', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-cockpit-tmux-timeout-legacy-'));
  const fakeBin = path.join(tmp, 'bin');
  await fs.mkdir(fakeBin, { recursive: true });
  const tmuxBin = path.join(fakeBin, 'tmux');
  const tmuxLog = path.join(tmp, 'tmux.log');
  const busRoot = path.join(tmp, 'bus');
  const worktreesDir = path.join(tmp, 'worktrees');
  await writeExecutable(tmuxBin, TMUX_STUB);

  const env = {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH || ''}`,
    TMUX_LOG: tmuxLog,
    AGENTIC_BUS_DIR: busRoot,
    AGENTIC_WORKTREES_DIR: worktreesDir,
    VALUA_AGENT_WORKTREES_DIR: worktreesDir,
    AGENTIC_WORKTREES_DISABLE: '1',
    VALUA_AGENT_WORKTREES_DISABLE: '1',
    AGENTIC_DASHBOARD_AUTOSTART: '0',
    AGENTIC_TMUX_NO_ATTACH: '1',
    AGENTIC_PR_OBSERVER_AUTOSTART: '0',
    AGENTIC_CODEX_EXEC_TIMEOUT_MS: '300000',
  };
  delete env.AGENTIC_CODEX_APP_SERVER_TIMEOUT_MS;
  delete env.VALUA_CODEX_APP_SERVER_TIMEOUT_MS;
  delete env.VALUA_CODEX_EXEC_TIMEOUT_MS;

  const run = await spawn('bash', ['scripts/tmux/agents-up.sh'], { cwd: repoRoot, env });
  assert.equal(run.code, 0, run.stderr || run.stdout);

  const seeded = parseSessionEnv(await fs.readFile(tmuxLog, 'utf8'));
  assert.equal(seeded.get('AGENTIC_CODEX_APP_SERVER_TIMEOUT_MS'), '300000');
  assert.equal(seeded.get('VALUA_CODEX_APP_SERVER_TIMEOUT_MS'), '300000');
});

test('agents-up keeps explicit app-server timeout authoritative over legacy exec timeout', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-cockpit-tmux-timeout-explicit-'));
  const fakeBin = path.join(tmp, 'bin');
  await fs.mkdir(fakeBin, { recursive: true });
  const tmuxBin = path.join(fakeBin, 'tmux');
  const tmuxLog = path.join(tmp, 'tmux.log');
  const busRoot = path.join(tmp, 'bus');
  const worktreesDir = path.join(tmp, 'worktrees');
  await writeExecutable(tmuxBin, TMUX_STUB);

  const env = {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH || ''}`,
    TMUX_LOG: tmuxLog,
    AGENTIC_BUS_DIR: busRoot,
    AGENTIC_WORKTREES_DIR: worktreesDir,
    VALUA_AGENT_WORKTREES_DIR: worktreesDir,
    AGENTIC_WORKTREES_DISABLE: '1',
    VALUA_AGENT_WORKTREES_DISABLE: '1',
    AGENTIC_DASHBOARD_AUTOSTART: '0',
    AGENTIC_TMUX_NO_ATTACH: '1',
    AGENTIC_PR_OBSERVER_AUTOSTART: '0',
    AGENTIC_CODEX_APP_SERVER_TIMEOUT_MS: '123456',
    AGENTIC_CODEX_EXEC_TIMEOUT_MS: '300000',
  };
  delete env.VALUA_CODEX_APP_SERVER_TIMEOUT_MS;
  delete env.VALUA_CODEX_EXEC_TIMEOUT_MS;

  const run = await spawn('bash', ['scripts/tmux/agents-up.sh'], { cwd: repoRoot, env });
  assert.equal(run.code, 0, run.stderr || run.stdout);

  const seeded = parseSessionEnv(await fs.readFile(tmuxLog, 'utf8'));
  assert.equal(seeded.get('AGENTIC_CODEX_APP_SERVER_TIMEOUT_MS'), '123456');
  assert.equal(seeded.get('VALUA_CODEX_APP_SERVER_TIMEOUT_MS'), '123456');
});

test('agents-up rejects invalid codex-worker workdirs through the shared resolver', async () => {
  const cases = [
    { label: 'omitted workdir', autopilotWorkdir: null },
    { label: '$REPO_ROOT alias', autopilotWorkdir: '$REPO_ROOT' },
    {
      label: '$AGENTIC_PROJECT_ROOT alias',
      autopilotWorkdir: '$AGENTIC_PROJECT_ROOT',
    },
    {
      label: '$VALUA_REPO_ROOT alias',
      autopilotWorkdir: '$VALUA_REPO_ROOT',
    },
  ];

  for (const { label, autopilotWorkdir } of cases) {
    const { run, logText } = await runAgentsUpWithRoster({
      roster: buildLauncherRoster({ autopilotWorkdir }),
      tmuxStub: TMUX_STARTUP_STUB,
    });
    assert.notEqual(run.code, 0, `${label} unexpectedly passed`);
    assert.doesNotMatch(logText, /send-keys -t test-cockpit:cockpit\.3 /);
  }
});

test('agents-up resolves codex-worker and non-codex workdirs through the shared resolver', async () => {
  const { run, logText, projectRoot, worktreesDir } = await runAgentsUpWithRoster({
    roster: buildLauncherRoster({
      daddyWorkdir: '$AGENTIC_PROJECT_ROOT',
      autopilotWorkdir: '$AGENTIC_WORKTREES_DIR/autopilot',
    }),
    tmuxStub: TMUX_STARTUP_STUB,
  });

  assert.equal(run.code, 0, run.stderr || run.stdout);

  const daddyPattern = new RegExp(
    `send-keys -t test-cockpit:cockpit\\.0 .*cd '${escapeRegExp(projectRoot)}'`,
  );
  const autopilotPattern = new RegExp(
    `send-keys -t test-cockpit:cockpit\\.3 .*cd '${escapeRegExp(path.join(worktreesDir, 'autopilot'))}'`,
  );

  assert.match(logText, daddyPattern);
  assert.match(logText, autopilotPattern);
  assert.doesNotMatch(logText, /cd '\$AGENTIC_PROJECT_ROOT'/);
});
