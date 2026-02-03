import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';

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

