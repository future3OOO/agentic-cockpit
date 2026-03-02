import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import childProcess from 'node:child_process';

import {
  classifyPostMergeResyncTrigger,
  resolvePostMergeResyncTargets,
  runPostMergeResync,
} from '../lib/post-merge-resync.mjs';

function exec(cmd, args, { cwd } = {}) {
  const res = childProcess.spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (res.status !== 0) {
    throw new Error(`Command failed: ${cmd} ${args.join(' ')}\n${res.stderr || res.stdout || ''}`);
  }
  return String(res.stdout || '').trim();
}

async function initRepoWithOrigin(tmpRoot) {
  const remote = path.join(tmpRoot, 'remote.git');
  const repo = path.join(tmpRoot, 'repo');
  await fs.mkdir(remote, { recursive: true });
  exec('git', ['init', '--bare', remote]);

  await fs.mkdir(repo, { recursive: true });
  try {
    exec('git', ['init', '-b', 'main'], { cwd: repo });
  } catch {
    exec('git', ['init'], { cwd: repo });
    exec('git', ['checkout', '-b', 'main'], { cwd: repo });
  }
  exec('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  exec('git', ['config', 'user.name', 'Test'], { cwd: repo });
  await fs.writeFile(path.join(repo, 'README.md'), 'init\n', 'utf8');
  exec('git', ['add', 'README.md'], { cwd: repo });
  exec('git', ['commit', '-m', 'init'], { cwd: repo });
  exec('git', ['remote', 'add', 'origin', remote], { cwd: repo });
  exec('git', ['push', '-u', 'origin', 'main:master'], { cwd: repo });
  exec('git', ['fetch', 'origin', 'master'], { cwd: repo });
  return { repo, remote };
}

test('resolvePostMergeResyncTargets resolves placeholders and defaults', async () => {
  const projectRoot = '/repo/runtime';
  const worktreesDir = '/home/u/.codex/valua/worktrees/Valua';
  const roster = {
    agents: [
      { name: 'frontend', kind: 'codex-worker', workdir: '$AGENTIC_WORKTREES_DIR/frontend', branch: 'agent/frontend' },
      { name: 'qa', kind: 'codex-worker' },
      { name: 'ignored', kind: 'observer' },
      { name: 'rooted', kind: 'codex-chat', workdir: '$REPO_ROOT' },
    ],
  };

  const targets = resolvePostMergeResyncTargets({ roster, projectRoot, worktreesDir });
  assert.equal(targets.length, 3);
  assert.equal(targets[0].name, 'frontend');
  assert.equal(targets[0].branch, 'agent/frontend');
  assert.equal(targets[0].workdir, path.resolve('/home/u/.codex/valua/worktrees/Valua/frontend'));

  assert.equal(targets[1].name, 'qa');
  assert.equal(targets[1].branch, 'agent/qa');
  assert.equal(targets[1].workdir, path.resolve('/home/u/.codex/valua/worktrees/Valua/qa'));

  assert.equal(targets[2].name, 'rooted');
  assert.equal(targets[2].workdir, path.resolve('/home/u/.codex/valua/worktrees/Valua/rooted'));
});

test('classifyPostMergeResyncTrigger runs only when merge evidence is present with commitSha', async () => {
  const merged = classifyPostMergeResyncTrigger({
    taskTitle: 'Merge PR111 then resync local',
    taskBody: '',
    note: 'Merged PR111 on master.',
    commitSha: 'abc123',
  });
  assert.equal(merged.shouldRun, true);
  assert.equal(merged.reasonCode, 'pr_merge_detected');

  const noMerge = classifyPostMergeResyncTrigger({
    taskTitle: 'Review PR111 comments',
    taskBody: '',
    note: 'Validated status checks only.',
    commitSha: 'abc123',
  });
  assert.equal(noMerge.shouldRun, false);
  assert.equal(noMerge.reasonCode, 'not_pr_merge_completion');

  const noCommit = classifyPostMergeResyncTrigger({
    taskTitle: 'Merge PR111 then resync local',
    taskBody: '',
    note: 'Merged PR111 on master.',
    commitSha: '',
  });
  assert.equal(noCommit.shouldRun, false);
  assert.equal(noCommit.reasonCode, 'missing_commit_sha');

  const requestedButNotMerged = classifyPostMergeResyncTrigger({
    taskTitle: 'Merge PR111 then resync local',
    taskBody: '',
    note: 'Validation complete; awaiting merge approval.',
    commitSha: 'abc123',
  });
  assert.equal(requestedButNotMerged.shouldRun, false);
  assert.equal(requestedButNotMerged.reasonCode, 'merge_requested_not_completed');
});

test('runPostMergeResync skips when project root is not a git repo', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'post-merge-resync-non-git-'));
  const busRoot = path.join(tmp, 'bus');
  const roster = { agents: [] };

  const result = await runPostMergeResync({
    projectRoot: path.join(tmp, 'not-a-repo'),
    busRoot,
    rosterPath: path.join(tmp, 'ROSTER.json'),
    roster,
    agentName: 'daddy-autopilot',
    worktreesDir: path.join(tmp, 'worktrees'),
  });

  assert.equal(result.status, 'skipped');
  assert.equal(result.reasonCode, 'project_not_git_repo');
});

test('runPostMergeResync syncs local master and repins agent worktrees once per origin/master sha', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'post-merge-resync-sync-'));
  const busRoot = path.join(tmp, 'bus');
  const worktreesDir = path.join(tmp, 'worktrees');
  const { repo } = await initRepoWithOrigin(tmp);

  const frontendWorkdir = path.join(worktreesDir, 'frontend');
  const runtimeWorkdir = path.join(worktreesDir, 'runtime-agent');
  await fs.mkdir(worktreesDir, { recursive: true });
  exec('git', ['worktree', 'add', '-B', 'agent/frontend', frontendWorkdir, 'origin/master'], { cwd: repo });
  exec('git', ['worktree', 'add', '-B', 'runtime/runtime-agent', runtimeWorkdir, 'origin/master'], { cwd: repo });

  exec('git', ['config', 'user.email', 'test@example.com'], { cwd: frontendWorkdir });
  exec('git', ['config', 'user.name', 'Test'], { cwd: frontendWorkdir });
  await fs.writeFile(path.join(frontendWorkdir, 'README.md'), 'local divergence\n', 'utf8');
  exec('git', ['add', 'README.md'], { cwd: frontendWorkdir });
  exec('git', ['commit', '-m', 'local divergence'], { cwd: frontendWorkdir });
  exec('git', ['config', 'user.email', 'test@example.com'], { cwd: runtimeWorkdir });
  exec('git', ['config', 'user.name', 'Test'], { cwd: runtimeWorkdir });
  await fs.writeFile(path.join(runtimeWorkdir, 'README.md'), 'runtime divergence\n', 'utf8');
  exec('git', ['add', 'README.md'], { cwd: runtimeWorkdir });
  exec('git', ['commit', '-m', 'runtime divergence'], { cwd: runtimeWorkdir });

  const roster = {
    agents: [
      { name: 'frontend', kind: 'codex-worker', branch: 'agent/frontend', workdir: '$AGENTIC_WORKTREES_DIR/frontend' },
      { name: 'runtime-agent', kind: 'codex-worker', branch: 'runtime/runtime-agent', workdir: '$AGENTIC_WORKTREES_DIR/runtime-agent' },
      { name: 'daddy-autopilot', kind: 'codex-worker', branch: 'agent/daddy-autopilot', workdir: '$AGENTIC_WORKTREES_DIR/daddy-autopilot' },
    ],
  };

  const first = await runPostMergeResync({
    projectRoot: repo,
    busRoot,
    rosterPath: path.join(repo, 'docs/agentic/agent-bus/ROSTER.json'),
    roster,
    agentName: 'daddy-autopilot',
    worktreesDir,
  });

  assert.equal(first.status, 'synced');
  assert.equal(first.reasonCode, 'synced_to_origin_master');
  assert.ok(first.originMaster);
  assert.equal(first.repin.updated, 2);
  assert.equal(exec('git', ['rev-parse', 'HEAD'], { cwd: frontendWorkdir }), first.originMaster);
  assert.equal(exec('git', ['rev-parse', 'HEAD'], { cwd: runtimeWorkdir }), first.originMaster);
  assert.equal(exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: frontendWorkdir }), 'agent/frontend');
  assert.equal(exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: runtimeWorkdir }), 'runtime/runtime-agent');

  const second = await runPostMergeResync({
    projectRoot: repo,
    busRoot,
    rosterPath: path.join(repo, 'docs/agentic/agent-bus/ROSTER.json'),
    roster,
    agentName: 'daddy-autopilot',
    worktreesDir,
  });

  assert.equal(second.status, 'skipped');
  assert.equal(second.reasonCode, 'already_synced');
});

test('runPostMergeResync skips repin for worktrees outside project repository ownership', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'post-merge-resync-foreign-worktree-'));
  const busRoot = path.join(tmp, 'bus');
  const worktreesDir = path.join(tmp, 'worktrees');
  const { repo } = await initRepoWithOrigin(tmp);

  const frontendWorkdir = path.join(worktreesDir, 'frontend');
  await fs.mkdir(worktreesDir, { recursive: true });
  exec('git', ['worktree', 'add', '-B', 'agent/frontend', frontendWorkdir, 'origin/master'], { cwd: repo });

  const foreignRoot = path.join(tmp, 'foreign');
  await fs.mkdir(foreignRoot, { recursive: true });
  exec('git', ['init'], { cwd: foreignRoot });
  exec('git', ['config', 'user.email', 'test@example.com'], { cwd: foreignRoot });
  exec('git', ['config', 'user.name', 'Test'], { cwd: foreignRoot });
  await fs.writeFile(path.join(foreignRoot, 'README.md'), 'foreign\n', 'utf8');
  exec('git', ['add', 'README.md'], { cwd: foreignRoot });
  exec('git', ['commit', '-m', 'foreign init'], { cwd: foreignRoot });

  const roster = {
    agents: [
      { name: 'frontend', kind: 'codex-worker', branch: 'agent/frontend', workdir: '$AGENTIC_WORKTREES_DIR/frontend' },
      { name: 'foreign-agent', kind: 'codex-worker', branch: 'agent/foreign-agent', workdir: foreignRoot },
      { name: 'daddy-autopilot', kind: 'codex-worker', branch: 'agent/daddy-autopilot', workdir: '$AGENTIC_WORKTREES_DIR/daddy-autopilot' },
    ],
  };

  const result = await runPostMergeResync({
    projectRoot: repo,
    busRoot,
    rosterPath: path.join(repo, 'docs/agentic/agent-bus/ROSTER.json'),
    roster,
    agentName: 'daddy-autopilot',
    worktreesDir,
  });

  assert.equal(result.status, 'synced');
  assert.equal(result.repin.attempted, 2);
  assert.equal(result.repin.updated, 1);
  assert.equal(result.repin.skipped, 1);
  assert.ok(result.repin.skippedReasons.includes('foreign-agent:foreign_repository_worktree'));
});

test('runPostMergeResync skips repin for agents with active worker lock', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'post-merge-resync-active-lock-'));
  const busRoot = path.join(tmp, 'bus');
  const worktreesDir = path.join(tmp, 'worktrees');
  const { repo } = await initRepoWithOrigin(tmp);

  const frontendWorkdir = path.join(worktreesDir, 'frontend');
  await fs.mkdir(worktreesDir, { recursive: true });
  exec('git', ['worktree', 'add', '-B', 'agent/frontend', frontendWorkdir, 'origin/master'], { cwd: repo });
  exec('git', ['config', 'user.email', 'test@example.com'], { cwd: frontendWorkdir });
  exec('git', ['config', 'user.name', 'Test'], { cwd: frontendWorkdir });
  await fs.writeFile(path.join(frontendWorkdir, 'README.md'), 'frontend local divergence\n', 'utf8');
  exec('git', ['add', 'README.md'], { cwd: frontendWorkdir });
  exec('git', ['commit', '-m', 'frontend local divergence'], { cwd: frontendWorkdir });
  const beforeHead = exec('git', ['rev-parse', 'HEAD'], { cwd: frontendWorkdir });

  const workerLockDir = path.join(busRoot, 'state', 'worker-locks');
  await fs.mkdir(workerLockDir, { recursive: true });
  await fs.writeFile(
    path.join(workerLockDir, 'frontend.lock.json'),
    `${JSON.stringify({ agent: 'frontend', pid: process.pid, token: 'test-lock' }, null, 2)}\n`,
    'utf8',
  );

  const roster = {
    agents: [
      { name: 'frontend', kind: 'codex-worker', branch: 'agent/frontend', workdir: '$AGENTIC_WORKTREES_DIR/frontend' },
      { name: 'daddy-autopilot', kind: 'codex-worker', branch: 'agent/daddy-autopilot', workdir: '$AGENTIC_WORKTREES_DIR/daddy-autopilot' },
    ],
  };

  const result = await runPostMergeResync({
    projectRoot: repo,
    busRoot,
    rosterPath: path.join(repo, 'docs/agentic/agent-bus/ROSTER.json'),
    roster,
    agentName: 'daddy-autopilot',
    worktreesDir,
  });

  assert.equal(result.status, 'synced');
  assert.equal(result.repin.attempted, 1);
  assert.equal(result.repin.updated, 0);
  assert.equal(result.repin.skipped, 1);
  assert.ok(result.repin.skippedReasons.includes('frontend:active_worker_lock'));
  assert.equal(exec('git', ['rev-parse', 'HEAD'], { cwd: frontendWorkdir }), beforeHead);
});
