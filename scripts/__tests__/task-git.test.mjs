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

test('task-git: creates workBranch from baseSha and hard-syncs existing branch to baseSha', async () => {
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
  assert.equal(created.hardSynced, true);

  // Move branch ahead; deterministic EXECUTE preflight should pin it back to baseSha.
  await fs.writeFile(path.join(repoRoot, 'README.md'), 'changed\n', 'utf8');
  exec('git', ['add', 'README.md'], { cwd: repoRoot });
  exec('git', ['commit', '-m', 'advance'], { cwd: repoRoot });
  const advancedSha = exec('git', ['rev-parse', 'HEAD'], { cwd: repoRoot });
  assert.notEqual(advancedSha, baseSha);
  const resumed = ensureTaskGitContract({
    cwd: repoRoot,
    taskKind: 'EXECUTE',
    contract,
    enforce: false,
    allowFetch: false,
  });
  assert.equal(resumed.applied, true);
  assert.equal(resumed.hardSynced, true);
  assert.equal(exec('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }), baseSha);
  assert.equal(exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot }), 'wip/frontend/root1');

  // Dirty tree blocks deterministic branch sync.
  await fs.writeFile(path.join(repoRoot, 'README.md'), 'dirty\n', 'utf8');
  assert.throws(
    () =>
      ensureTaskGitContract({
        cwd: repoRoot,
        taskKind: 'EXECUTE',
        contract,
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

test('task-git: hard-sync recovers drifted workBranch to baseSha', async () => {
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

  const synced = ensureTaskGitContract({
    cwd: repoRoot,
    taskKind: 'EXECUTE',
    contract: { baseSha, workBranch: 'orphan' },
    enforce: false,
    allowFetch: false,
  });
  assert.equal(synced.applied, true);
  assert.equal(synced.hardSynced, true);
  assert.equal(exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot }), 'orphan');
  assert.equal(exec('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }), baseSha);
});

test('task-git: execute workBranch requires baseSha even when enforce=false', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-task-git-require-base-'));
  const repoRoot = path.join(tmp, 'repo');
  await initRepo(repoRoot);

  assert.throws(
    () =>
      ensureTaskGitContract({
        cwd: repoRoot,
        taskKind: 'EXECUTE',
        contract: { workBranch: 'wip/frontend/root1' },
        enforce: false,
        allowFetch: false,
      }),
    TaskGitPreflightBlockedError,
  );
});

test('task-git: auto-clean recovers dirty deterministic execute worktree when enabled', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-task-git-autoclean-'));
  const repoRoot = path.join(tmp, 'repo');
  const baseSha = await initRepo(repoRoot);

  const contract = {
    baseBranch: 'main',
    baseSha,
    workBranch: 'wip/backend/root1',
    integrationBranch: 'slice/root1',
  };

  // Bootstrap branch.
  ensureTaskGitContract({
    cwd: repoRoot,
    taskKind: 'EXECUTE',
    contract,
    enforce: false,
    allowFetch: false,
  });

  // Introduce both tracked + untracked dirtiness.
  await fs.writeFile(path.join(repoRoot, 'README.md'), 'dirty tracked\n', 'utf8');
  await fs.writeFile(path.join(repoRoot, 'tmp.txt'), 'dirty untracked\n', 'utf8');
  assert.notEqual(exec('git', ['status', '--porcelain'], { cwd: repoRoot }), '');

  const cleaned = ensureTaskGitContract({
    cwd: repoRoot,
    taskKind: 'EXECUTE',
    contract,
    enforce: false,
    allowFetch: false,
    autoCleanDirtyExecute: true,
  });
  assert.equal(cleaned.applied, true);
  assert.equal(cleaned.hardSynced, true);
  assert.equal(cleaned.autoCleaned, true);
  assert.ok(cleaned.autoCleanDetails);
  assert.match(cleaned.autoCleanDetails.statusPorcelain, /README\.md/);
  assert.equal(exec('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }), baseSha);
  assert.equal(exec('git', ['status', '--porcelain'], { cwd: repoRoot }), '');
});

test('task-git: disposable runtime artifacts and empty skillops logs do not block deterministic execute sync', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-task-git-runtime-artifacts-'));
  const repoRoot = path.join(tmp, 'repo');
  const baseSha = await initRepo(repoRoot);

  const contract = {
    baseBranch: 'main',
    baseSha,
    workBranch: 'wip/infra/root1',
    integrationBranch: 'slice/root1',
  };

  ensureTaskGitContract({
    cwd: repoRoot,
    taskKind: 'EXECUTE',
    contract,
    enforce: false,
    allowFetch: false,
  });

  await fs.mkdir(path.join(repoRoot, '.codex', 'quality', 'logs'), { recursive: true });
  await fs.mkdir(path.join(repoRoot, '.codex', 'reviews'), { recursive: true });
  await fs.mkdir(path.join(repoRoot, '.codex-tmp'), { recursive: true });
  await fs.mkdir(path.join(repoRoot, 'artifacts', 'reviews'), { recursive: true });
  await fs.mkdir(path.join(repoRoot, '.codex', 'skill-ops', 'logs', '2026-03'), { recursive: true });
  await fs.writeFile(path.join(repoRoot, '.codex', 'quality', 'logs', 'q.md'), 'quality\n', 'utf8');
  await fs.writeFile(path.join(repoRoot, '.codex', 'reviews', 'r.md'), 'review\n', 'utf8');
  await fs.writeFile(path.join(repoRoot, '.codex-tmp', 'temp.txt'), 'tmp\n', 'utf8');
  await fs.writeFile(path.join(repoRoot, 'artifacts', 'reviews', 'previous.md'), 'artifact\n', 'utf8');
  await fs.writeFile(
    path.join(repoRoot, '.codex', 'skill-ops', 'logs', '2026-03', 'empty.md'),
    [
      '---',
      'id: empty-log',
      'status: new',
      'skill_updates:',
      '  cockpit-autopilot: []',
      '  cockpit-skillops: []',
      '---',
      '',
    ].join('\n'),
    'utf8',
  );
  assert.notEqual(exec('git', ['status', '--porcelain'], { cwd: repoRoot }), '');

  const resumed = ensureTaskGitContract({
    cwd: repoRoot,
    taskKind: 'EXECUTE',
    contract,
    enforce: false,
    allowFetch: false,
  });
  assert.equal(resumed.applied, true);
  assert.equal(exec('git', ['status', '--porcelain'], { cwd: repoRoot }), '');
});

test('task-git: non-empty skillops logs still block deterministic execute sync', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-task-git-skillops-block-'));
  const repoRoot = path.join(tmp, 'repo');
  const baseSha = await initRepo(repoRoot);

  const contract = {
    baseBranch: 'main',
    baseSha,
    workBranch: 'wip/infra/root1',
    integrationBranch: 'slice/root1',
  };

  ensureTaskGitContract({
    cwd: repoRoot,
    taskKind: 'EXECUTE',
    contract,
    enforce: false,
    allowFetch: false,
  });

  await fs.mkdir(path.join(repoRoot, '.codex', 'skill-ops', 'logs', '2026-03'), { recursive: true });
  await fs.writeFile(
    path.join(repoRoot, '.codex', 'skill-ops', 'logs', '2026-03', 'nonempty.md'),
    [
      '---',
      'id: nonempty-log',
      'status: new',
      'skill_updates:',
      '  cockpit-autopilot:',
      '    - "Keep the learning."',
      '---',
      '',
    ].join('\n'),
    'utf8',
  );

  assert.throws(
    () =>
      ensureTaskGitContract({
        cwd: repoRoot,
        taskKind: 'EXECUTE',
        contract,
        enforce: false,
        allowFetch: false,
      }),
    TaskGitPreflightBlockedError,
  );
});
