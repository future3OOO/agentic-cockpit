import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import childProcess from 'node:child_process';

function runNode(scriptPath, args) {
  const res = childProcess.spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (res.status !== 0) {
    throw new Error(`command failed (${res.status}): ${process.execPath} ${scriptPath} ${args.join(' ')}\n${res.stderr || res.stdout}`);
  }
  return { stdout: res.stdout, stderr: res.stderr };
}

function run(cmd, args, cwd) {
  const res = childProcess.spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (res.status !== 0) {
    throw new Error(`command failed (${res.status}): ${cmd} ${args.join(' ')}\n${res.stderr || res.stdout}`);
  }
  return res.stdout;
}

async function writeText(filePath, text) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, 'utf8');
}

async function readText(filePath) {
  return await fs.readFile(filePath, 'utf8');
}

async function setupPolicyProject(tmpRoot) {
  const repoRoot = path.join(tmpRoot, 'repo');
  const worktreesDir = path.join(tmpRoot, 'worktrees');
  const workdirFrontend = path.join(worktreesDir, 'frontend');
  const rosterPath = path.join(repoRoot, 'docs', 'agentic', 'agent-bus', 'ROSTER.json');

  await fs.mkdir(repoRoot, { recursive: true });
  await fs.mkdir(workdirFrontend, { recursive: true });

  await writeText(path.join(repoRoot, 'AGENTS.md'), 'root agents v1\n');
  await writeText(path.join(repoRoot, '.codex', 'README.md'), 'root codex readme v1\n');
  await writeText(path.join(repoRoot, '.codex', 'skills', 'valua-sync-test', 'SKILL.md'), 'root skill v1\n');
  await writeText(path.join(repoRoot, 'docs', 'runbooks', 'PR_REVIEW_LOOP.md'), 'root runbook v1\n');
  await writeText(path.join(repoRoot, 'docs', 'agentic', 'BLUEPRINT.md'), 'root blueprint v1\n');

  await writeText(
    rosterPath,
    `${JSON.stringify(
      {
        schemaVersion: 2,
        sessionName: 'test',
        agents: [
          {
            name: 'frontend',
            kind: 'codex-worker',
            workdir: '$AGENTIC_WORKTREES_DIR/frontend',
            startCommand: 'true',
            skills: [],
          },
          {
            name: 'orchestrator',
            kind: 'node-worker',
            workdir: '$REPO_ROOT',
            startCommand: 'true',
            skills: [],
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

  return { repoRoot, worktreesDir, workdirFrontend, rosterPath };
}

test('sync-policy-to-worktrees updates stale policy files from root into worktrees', async () => {
  const cockpitRoot = process.cwd();
  const scriptPath = path.join(cockpitRoot, 'scripts', 'agentic', 'sync-policy-to-worktrees.mjs');

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-policy-sync-'));
  const { repoRoot, worktreesDir, workdirFrontend, rosterPath } = await setupPolicyProject(tmp);

  await writeText(path.join(workdirFrontend, 'AGENTS.md'), 'stale agents\n');
  await writeText(path.join(workdirFrontend, '.codex', 'skills', 'valua-sync-test', 'SKILL.md'), 'stale skill\n');
  await writeText(path.join(workdirFrontend, 'docs', 'runbooks', 'PR_REVIEW_LOOP.md'), 'stale runbook\n');

  runNode(scriptPath, ['--repo-root', repoRoot, '--worktrees-dir', worktreesDir, '--roster', rosterPath]);

  assert.equal(await readText(path.join(workdirFrontend, 'AGENTS.md')), 'root agents v1\n');
  assert.equal(await readText(path.join(workdirFrontend, '.codex', 'README.md')), 'root codex readme v1\n');
  assert.equal(await readText(path.join(workdirFrontend, '.codex', 'skills', 'valua-sync-test', 'SKILL.md')), 'root skill v1\n');
  assert.equal(await readText(path.join(workdirFrontend, 'docs', 'runbooks', 'PR_REVIEW_LOOP.md')), 'root runbook v1\n');
  assert.equal(await readText(path.join(workdirFrontend, 'docs', 'agentic', 'BLUEPRINT.md')), 'root blueprint v1\n');

  // One-way guard: worktree content must never overwrite root.
  await writeText(path.join(workdirFrontend, 'AGENTS.md'), 'worktree changed only\n');
  assert.equal(await readText(path.join(repoRoot, 'AGENTS.md')), 'root agents v1\n');
});

test('sync-policy-to-worktrees skips overwriting dirty tracked files in worktrees', async () => {
  const cockpitRoot = process.cwd();
  const scriptPath = path.join(cockpitRoot, 'scripts', 'agentic', 'sync-policy-to-worktrees.mjs');

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-policy-sync-dirty-'));
  const { repoRoot, worktreesDir, workdirFrontend, rosterPath } = await setupPolicyProject(tmp);

  run('git', ['init'], workdirFrontend);
  run('git', ['config', 'user.email', 'test@example.com'], workdirFrontend);
  run('git', ['config', 'user.name', 'Test'], workdirFrontend);
  await writeText(path.join(workdirFrontend, 'AGENTS.md'), 'tracked clean\n');
  run('git', ['add', 'AGENTS.md'], workdirFrontend);
  run('git', ['commit', '-m', 'init tracked file'], workdirFrontend);

  await writeText(path.join(workdirFrontend, 'AGENTS.md'), 'dirty local edit\n');

  const { stdout } = runNode(scriptPath, [
    '--repo-root',
    repoRoot,
    '--worktrees-dir',
    worktreesDir,
    '--roster',
    rosterPath,
  ]);

  assert.match(stdout, /skippedDirty=1/);
  assert.equal(await readText(path.join(workdirFrontend, 'AGENTS.md')), 'dirty local edit\n');
});
