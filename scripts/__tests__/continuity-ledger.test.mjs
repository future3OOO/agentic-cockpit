import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function spawnProcess(cmd, args, { cwd }) {
  return new Promise((resolve) => {
    const proc = childProcess.spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d.toString('utf8')));
    proc.stderr.on('data', (d) => (stderr += d.toString('utf8')));
    proc.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

test('continuity-ledger: check passes', async () => {
  const repoRoot = process.cwd();
  const run = await spawnProcess('node', ['scripts/continuity-ledger.mjs', 'check'], { cwd: repoRoot });
  assert.equal(run.code, 0, run.stderr || run.stdout);
});

test('continuity-ledger: --help prints usage', async () => {
  const repoRoot = process.cwd();
  const run = await spawnProcess('node', ['scripts/continuity-ledger.mjs', '--help'], { cwd: repoRoot });
  assert.equal(run.code, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /Usage:/);
  assert.match(run.stdout, /trim/);
});

test('continuity-ledger: trim succeeds in an isolated temp repo copy', async () => {
  const repoRoot = process.cwd();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-continuity-test-'));
  const tmpScriptsDir = path.join(tmpRoot, 'scripts');
  const srcScript = path.join(repoRoot, 'scripts', 'continuity-ledger.mjs');
  const dstScript = path.join(tmpScriptsDir, 'continuity-ledger.mjs');

  await fs.mkdir(tmpScriptsDir, { recursive: true });
  await fs.copyFile(srcScript, dstScript);
  await fs.mkdir(path.join(tmpRoot, '.codex'), { recursive: true });
  await fs.writeFile(
    path.join(tmpRoot, '.codex', 'CONTINUITY.md'),
    `Goal (incl. success criteria):\n- one\n\nConstraints/Assumptions:\n- one\n\nKey decisions:\n- one\n\nState:\n- one\n\nDone:\n${Array.from({ length: 80 }, (_, i) => `- done ${i + 1}`).join('\n')}\n\nNow:\n- one\n\nNext:\n- one\n\nOpen questions (UNCONFIRMED if needed):\n- one\n\nWorking set (files/ids/commands):\n- one\n`,
    'utf8',
  );

  const run = await spawnProcess('node', ['scripts/continuity-ledger.mjs', 'trim'], { cwd: tmpRoot });
  assert.equal(run.code, 0, run.stderr || run.stdout);

  const check = await spawnProcess('node', ['scripts/continuity-ledger.mjs', 'check'], { cwd: tmpRoot });
  assert.equal(check.code, 0, check.stderr || check.stdout);
});
