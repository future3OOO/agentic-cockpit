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
  return { root, repo, bare };
}

test('reachable commit resolves on allowed origin remote only', async () => {
  const { repo } = await setupRepoWithOrigin();
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
});

test('local-only commit is reported unreachable', async () => {
  const { repo } = await setupRepoWithOrigin();
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

test('no configured allowed remote yields unchecked/pass-through result', async () => {
  const { repo } = await setupRepoWithOrigin();
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

