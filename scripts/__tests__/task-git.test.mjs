import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import childProcess from 'node:child_process';

import { TaskGitPreflightBlockedError, ensureTaskGitContract } from '../lib/task-git.mjs';

function exec(cmd, args, { cwd, env } = {}) {
  const res = childProcess.spawnSync(cmd, args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (res.status !== 0) {
    throw new Error(`Command failed: ${cmd} ${args.join(' ')}\n` + (res.stderr || res.stdout || ''));
  }
  return String(res.stdout || '').trim();
}

async function initRepo(dir) {
  await fs.mkdir(dir, { recursive: true });
  try {
    exec('git', ['init', '-b', 'main'], { cwd: dir });
  } catch {
    exec('git', ['init'], { cwd: dir });
    exec('git', ['checkout', '-b', 'main'], { cwd: dir });
  }
  exec('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  exec('git', ['config', 'user.name', 'Test'], { cwd: dir });
  await fs.writeFile(path.join(dir, 'README.md'), 'hello\n', 'utf8');
  exec('git', ['add', 'README.md'], { cwd: dir });
  exec('git', ['commit', '-m', 'init'], { cwd: dir });
  return exec('git', ['rev-parse', 'HEAD'], { cwd: dir });
}

test('task-git: creates workBranch from baseSha and allows dirty resume', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-task-git-'));
  const repoRoot = path.join(tmp, 'repo');
  const baseSha = await initRepo(repoRoot);

  const contract = {
    baseBranch: 'main',
    baseSha,
    workBranch: 'wip/frontend/root1',
    integrationBranch: 'slice/root1',
  };

  const created = ensureTaskGitContract({
    cwd: repoRoot,
    taskKind: 'EXECUTE',
    contract,
    enforce: false,
    allowFetch: false,
  });
  assert.equal(created.applied, true);
  assert.equal(created.created, true);
  assert.equal(exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot }), 'wip/frontend/root1');
  assert.equal(exec('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }), baseSha);

  // Dirty resume on same branch should be allowed.
  await fs.writeFile(path.join(repoRoot, 'README.md'), 'changed\n', 'utf8');
  const resumed = ensureTaskGitContract({
    cwd: repoRoot,
    taskKind: 'EXECUTE',
    contract,
    enforce: false,
    allowFetch: false,
  });
  assert.equal(resumed.applied, true);
  assert.equal(exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot }), 'wip/frontend/root1');

  // Dirty tree should block switching to another branch.
  assert.throws(
    () =>
      ensureTaskGitContract({
        cwd: repoRoot,
        taskKind: 'EXECUTE',
        contract: { ...contract, workBranch: 'wip/frontend/root2' },
        enforce: false,
        allowFetch: false,
      }),
    TaskGitPreflightBlockedError,
  );
});

test('task-git: enforce requires git contract for EXECUTE', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-task-git-enforce-'));
  const repoRoot = path.join(tmp, 'repo');
  await initRepo(repoRoot);

  assert.throws(
    () =>
      ensureTaskGitContract({
        cwd: repoRoot,
        taskKind: 'EXECUTE',
        contract: null,
        enforce: true,
        allowFetch: false,
      }),
    TaskGitPreflightBlockedError,
  );
});

test('task-git: blocks drift when workBranch does not include baseSha', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-task-git-drift-'));
  const repoRoot = path.join(tmp, 'repo');
  const baseSha = await initRepo(repoRoot);

  // Create an orphan branch with unrelated history.
  exec('git', ['checkout', '--orphan', 'orphan'], { cwd: repoRoot });
  exec('git', ['rm', '-rf', '.'], { cwd: repoRoot });
  await fs.writeFile(path.join(repoRoot, 'ORPHAN.md'), 'orphan\n', 'utf8');
  exec('git', ['add', 'ORPHAN.md'], { cwd: repoRoot });
  exec('git', ['commit', '-m', 'orphan'], { cwd: repoRoot });
  exec('git', ['checkout', 'main'], { cwd: repoRoot });

  assert.throws(
    () =>
      ensureTaskGitContract({
        cwd: repoRoot,
        taskKind: 'EXECUTE',
        contract: { baseSha, workBranch: 'orphan' },
        enforce: false,
        allowFetch: false,
      }),
    TaskGitPreflightBlockedError,
  );
});

