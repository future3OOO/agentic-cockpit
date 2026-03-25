import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import childProcess from 'node:child_process';

const scriptPath = path.resolve(process.cwd(), 'scripts/agentic/reset-agent-codex-state.sh');

function runResetScript(args, { env = {} } = {}) {
  return childProcess.spawnSync('bash', [scriptPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('reset-agent-codex-state: purge mode removes only stale reclaim sludge', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-reset-state-purge-'));
  const busRoot = path.join(tmp, 'bus');
  const reclaimStateDir = path.join(busRoot, 'state', 'worker-reclaim', 'backend');
  const preflightDir = path.join(busRoot, 'artifacts', 'backend', 'preflight');
  await fs.mkdir(reclaimStateDir, { recursive: true });
  await fs.mkdir(preflightDir, { recursive: true });
  await fs.writeFile(path.join(reclaimStateDir, 't1.json'), '{}\n', 'utf8');
  await fs.writeFile(path.join(preflightDir, 't1.stale-reclaim.md'), 'stale reclaim\n', 'utf8');
  await fs.writeFile(path.join(preflightDir, 't1.clean.md'), 'clean artifact\n', 'utf8');

  const result = runResetScript(['--purge-stale-reclaim', '--agent', 'backend'], {
    env: { AGENTIC_BUS_DIR: busRoot },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  await assert.rejects(fs.access(path.join(reclaimStateDir, 't1.json')), /ENOENT/);
  await assert.rejects(fs.access(path.join(preflightDir, 't1.stale-reclaim.md')), /ENOENT/);
  await fs.access(path.join(preflightDir, 't1.clean.md'));
});

test('reset-agent-codex-state: purge mode refuses active locks unless --force is set', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-reset-state-lock-'));
  const busRoot = path.join(tmp, 'bus');
  const reclaimStateDir = path.join(busRoot, 'state', 'worker-reclaim', 'backend');
  const lockDir = path.join(busRoot, 'state', 'worker-locks');
  await fs.mkdir(reclaimStateDir, { recursive: true });
  await fs.mkdir(lockDir, { recursive: true });
  await fs.writeFile(path.join(reclaimStateDir, 't1.json'), '{}\n', 'utf8');
  await fs.writeFile(
    path.join(lockDir, 'backend.lock.json'),
    `${JSON.stringify({ pid: process.pid, agent: 'backend' }, null, 2)}\n`,
    'utf8',
  );

  const blocked = runResetScript(['--purge-stale-reclaim', '--agent', 'backend'], {
    env: { AGENTIC_BUS_DIR: busRoot },
  });
  assert.notEqual(blocked.status, 0);
  await fs.access(path.join(reclaimStateDir, 't1.json'));

  const forced = runResetScript(['--purge-stale-reclaim', '--agent', 'backend', '--force'], {
    env: { AGENTIC_BUS_DIR: busRoot },
  });
  assert.equal(forced.status, 0, forced.stderr || forced.stdout);
  await assert.rejects(fs.access(path.join(reclaimStateDir, 't1.json')), /ENOENT/);
});
