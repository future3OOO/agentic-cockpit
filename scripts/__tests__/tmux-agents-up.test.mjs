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

function parseSessionEnv(logText) {
  const result = new Map();
  for (const line of String(logText || '').split('\n')) {
    const match = /^SET set-environment -t \S+ (\S+) (.+)$/.exec(line.trim());
    if (!match) continue;
    result.set(match[1], match[2]);
  }
  return result;
}

test('agents-up seeds app-server timeout from legacy exec timeout when new names are unset', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-cockpit-tmux-timeout-legacy-'));
  const fakeBin = path.join(tmp, 'bin');
  await fs.mkdir(fakeBin, { recursive: true });
  const tmuxBin = path.join(fakeBin, 'tmux');
  const tmuxLog = path.join(tmp, 'tmux.log');
  await writeExecutable(tmuxBin, TMUX_STUB);

  const env = {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH || ''}`,
    TMUX_LOG: tmuxLog,
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
  await writeExecutable(tmuxBin, TMUX_STUB);

  const env = {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH || ''}`,
    TMUX_LOG: tmuxLog,
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
