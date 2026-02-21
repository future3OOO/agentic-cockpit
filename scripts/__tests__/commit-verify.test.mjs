import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import childProcess from 'node:child_process';
import { verifyCommitShaOnAllowedRemotes } from '../lib/commit-verify.mjs';

function run(cmd, args, { cwd, env }) {
  return childProcess.execFileSync(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8').trim();
}

async function setupRepoWithOrigin() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'commit-verify-'));
  const bare = path.join(root, 'origin.git');
  const repo = path.join(root, 'repo');
  await fs.mkdir(repo, { recursive: true });
  run('git', ['init', '--bare', bare], { cwd: root });
  run('git', ['init'], { cwd: repo });
  run('git', ['config', 'user.name', 'Test'], { cwd: repo });
  run('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  await fs.writeFile(path.join(repo, 'a.txt'), 'one\n', 'utf8');
  run('git', ['add', '.'], { cwd: repo });
  run('git', ['commit', '-m', 'init'], { cwd: repo });
  run('git', ['branch', '-M', 'master'], { cwd: repo });
  run('git', ['remote', 'add', 'origin', bare], { cwd: repo });
  run('git', ['push', '-u', 'origin', 'master'], { cwd: repo });
  const cleanup = () => fs.rm(root, { recursive: true, force: true });
  return { root, repo, bare, cleanup };
}

test('reachable commit resolves on allowed origin remote only', async (t) => {
  const { repo, cleanup } = await setupRepoWithOrigin();
  t.after(() => cleanup());
  // Add unrelated remote that must never be touched by default allowlist.
  run('git', ['remote', 'add', 'hetzner', 'ssh://invalid/never-used'], { cwd: repo });
  const pushedSha = run('git', ['rev-parse', 'HEAD'], { cwd: repo });

  const result = await verifyCommitShaOnAllowedRemotes({
    cwd: repo,
    commitSha: pushedSha,
    env: { ...process.env, VALUA_COMMIT_VERIFY_REMOTES: 'origin,github' },
  });

  assert.equal(result.checked, true);
  assert.equal(result.reachable, true);
  assert.ok(result.remoteRefs.some((r) => r.startsWith('origin/')));
  assert.ok(result.attemptedRemotes.includes('origin'));
  assert.equal(result.attemptedRemotes.includes('hetzner'), false);
  assert.equal(result.integration.checked, false);
  assert.equal(result.integration.reason, 'not_required');
});

test('local-only commit is reported unreachable', async (t) => {
  const { repo, cleanup } = await setupRepoWithOrigin();
  t.after(() => cleanup());
  await fs.writeFile(path.join(repo, 'b.txt'), 'two\n', 'utf8');
  run('git', ['add', '.'], { cwd: repo });
  run('git', ['commit', '-m', 'local-only'], { cwd: repo });
  const localSha = run('git', ['rev-parse', 'HEAD'], { cwd: repo });

  const result = await verifyCommitShaOnAllowedRemotes({
    cwd: repo,
    commitSha: localSha,
    env: { ...process.env, VALUA_COMMIT_VERIFY_REMOTES: 'origin' },
  });

  assert.equal(result.checked, true);
  assert.equal(result.reachable, false);
  assert.equal(result.reason, 'not_found_on_allowed_remotes');
  assert.ok(result.attemptedRemotes.includes('origin'));
});

test('no configured allowed remote yields unchecked/pass-through result', async (t) => {
  const { repo, cleanup } = await setupRepoWithOrigin();
  t.after(() => cleanup());
  const sha = run('git', ['rev-parse', 'HEAD'], { cwd: repo });
  const result = await verifyCommitShaOnAllowedRemotes({
    cwd: repo,
    commitSha: sha,
    env: { ...process.env, VALUA_COMMIT_VERIFY_REMOTES: 'github' },
  });

  assert.equal(result.checked, false);
  assert.equal(result.reachable, true);
  assert.equal(result.reason, 'no_allowed_remote');
});

test('git remote listing error fails closed', async () => {
  const result = await verifyCommitShaOnAllowedRemotes({
    cwd: '/this/path/does/not/exist',
    commitSha: 'abc123',
    env: { ...process.env, VALUA_COMMIT_VERIFY_REMOTES: 'origin,github' },
  });

  assert.equal(result.checked, false);
  assert.equal(result.reachable, false);
  assert.equal(result.reason, 'git_remote_error');
  assert.ok(Array.isArray(result.errors));
  assert.ok(result.errors.length > 0);
  assert.equal(result.errors[0].phase, 'list_remotes');
});

test('all fetch failures return unchecked result (no false unreachable)', async (t) => {
  const { repo, cleanup } = await setupRepoWithOrigin();
  t.after(() => cleanup());

  // Point origin at an invalid endpoint so fetch deterministically fails.
  run('git', ['remote', 'set-url', 'origin', 'ssh://127.0.0.1:1/never/reachable.git'], { cwd: repo });
  const sha = run('git', ['rev-parse', 'HEAD'], { cwd: repo });

  const result = await verifyCommitShaOnAllowedRemotes({
    cwd: repo,
    commitSha: sha,
    env: { ...process.env, VALUA_COMMIT_VERIFY_REMOTES: 'origin' },
  });

  assert.equal(result.checked, false);
  assert.equal(result.reachable, true);
  assert.equal(result.reason, 'fetch_unavailable');
  assert.ok(result.errors.some((e) => e.phase === 'fetch'));
});

test('integration branch check passes when commit is on required branch', async (t) => {
  const { repo, cleanup } = await setupRepoWithOrigin();
  t.after(() => cleanup());
  const pushedSha = run('git', ['rev-parse', 'HEAD'], { cwd: repo });

  const result = await verifyCommitShaOnAllowedRemotes({
    cwd: repo,
    commitSha: pushedSha,
    requiredIntegrationBranch: 'master',
    env: { ...process.env, VALUA_COMMIT_VERIFY_REMOTES: 'origin' },
  });

  assert.equal(result.checked, true);
  assert.equal(result.reachable, true);
  assert.equal(result.integration.checked, true);
  assert.equal(result.integration.reachable, true);
  assert.equal(result.integration.reason, 'reachable');
  assert.ok(result.integration.matchedRefs.includes('origin/master'));
});

test('integration branch check fails when commit is not on required branch', async (t) => {
  const { repo, cleanup } = await setupRepoWithOrigin();
  t.after(() => cleanup());
  const pushedSha = run('git', ['rev-parse', 'HEAD'], { cwd: repo });
  run('git', ['checkout', '-b', 'feature/not-main'], { cwd: repo });
  await fs.writeFile(path.join(repo, 'feature.txt'), 'feature\n', 'utf8');
  run('git', ['add', '.'], { cwd: repo });
  run('git', ['commit', '-m', 'feature'], { cwd: repo });
  const featureSha = run('git', ['rev-parse', 'HEAD'], { cwd: repo });
  run('git', ['push', '-u', 'origin', 'feature/not-main'], { cwd: repo });

  const result = await verifyCommitShaOnAllowedRemotes({
    cwd: repo,
    commitSha: featureSha,
    requiredIntegrationBranch: 'master',
    env: { ...process.env, VALUA_COMMIT_VERIFY_REMOTES: 'origin' },
  });

  assert.equal(result.checked, true);
  assert.equal(result.reachable, true);
  assert.equal(result.integration.checked, true);
  assert.equal(result.integration.reachable, false);
  assert.equal(result.integration.reason, 'not_found_on_required_branch');
  assert.equal(result.integration.requiredBranch, 'master');
  // sanity: head on master still different commit
  assert.notEqual(featureSha, pushedSha);
});
