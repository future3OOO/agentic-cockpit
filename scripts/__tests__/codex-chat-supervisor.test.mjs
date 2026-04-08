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
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function writeExecutable(filePath, contents) {
  await fs.writeFile(filePath, contents, 'utf8');
  await fs.chmod(filePath, 0o755);
}

const DUMMY_CODEX = String.raw`#!/usr/bin/env node
const fs = require('node:fs');

const promptLog = process.env.CODEX_PROMPT_LOG;
if (!promptLog) {
  process.stderr.write('CODEX_PROMPT_LOG is required\n');
  process.exit(2);
}

fs.writeFileSync(promptLog, process.argv[process.argv.length - 1] + '\n', 'utf8');
`;

test('codex-chat-supervisor: Valua boot prompt overrides inherited generic AGENTIC prompt', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-chat-supervisor-'));
  const busRoot = path.join(tmp, 'bus');
  const binDir = path.join(tmp, 'bin');
  const codexBin = path.join(binDir, 'codex');
  const promptLog = path.join(tmp, 'prompt.log');

  await fs.mkdir(busRoot, { recursive: true });
  await fs.mkdir(binDir, { recursive: true });
  await writeExecutable(codexBin, DUMMY_CODEX);

  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH || ''}`,
    AGENTIC_BUS_DIR: busRoot,
    CODEX_PROMPT_LOG: promptLog,
    AGENTIC_CODEX_CHAT_BOOT_PROMPT: '$cockpit-daddy-chat-io',
    VALUA_CODEX_CHAT_BOOT_PROMPT: '$valua-daddy-chat-io',
  };

  const run = await spawnProcess(
    'bash',
    ['scripts/agentic/codex-chat-supervisor.sh'],
    { cwd: repoRoot, env },
  );
  assert.equal(run.code, 0, run.stderr || run.stdout);
  assert.equal(await fs.readFile(promptLog, 'utf8'), '$valua-daddy-chat-io\n');
});

test('codex-chat-supervisor: generic AGENTIC boot prompt still works when no Valua override is set', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-chat-supervisor-generic-'));
  const busRoot = path.join(tmp, 'bus');
  const binDir = path.join(tmp, 'bin');
  const codexBin = path.join(binDir, 'codex');
  const promptLog = path.join(tmp, 'prompt.log');

  await fs.mkdir(busRoot, { recursive: true });
  await fs.mkdir(binDir, { recursive: true });
  await writeExecutable(codexBin, DUMMY_CODEX);

  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH || ''}`,
    AGENTIC_BUS_DIR: busRoot,
    CODEX_PROMPT_LOG: promptLog,
    AGENTIC_CODEX_CHAT_BOOT_PROMPT: '$cockpit-daddy-chat-io',
  };

  const run = await spawnProcess(
    'bash',
    ['scripts/agentic/codex-chat-supervisor.sh'],
    { cwd: repoRoot, env },
  );
  assert.equal(run.code, 0, run.stderr || run.stdout);
  assert.equal(await fs.readFile(promptLog, 'utf8'), '$cockpit-daddy-chat-io\n');
});
