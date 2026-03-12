import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import childProcess from 'node:child_process';

import { TaskGitPreflightBlockedError, ensureTaskGitContract, summarizeBlockingGitStatusPorcelain } from '../lib/task-git.mjs';

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

async function initDeterministicRepo(prefix, contractOverrides = {}) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const repoRoot = path.join(tmp, 'repo');
  const baseSha = await initRepo(repoRoot);
  const contract = {
    baseBranch: 'main',
    baseSha,
    workBranch: 'wip/infra/root1',
    integrationBranch: 'slice/root1',
    ...contractOverrides,
  };
  ensureTaskGitContract({
    cwd: repoRoot,
    taskKind: 'EXECUTE',
    contract,
    enforce: false,
    allowFetch: false,
  });
  return { repoRoot, contract };
}

async function writeSkillOpsLog(repoRoot, name, content) {
  const logDir = path.join(repoRoot, '.codex', 'skill-ops', 'logs', '2026-03');
  await fs.mkdir(logDir, { recursive: true });
  await fs.writeFile(path.join(logDir, name), Array.isArray(content) ? content.join('\n') : content, 'utf8');
}

function runPreflight(repoRoot, contract, overrides = {}) {
  return ensureTaskGitContract({
    cwd: repoRoot,
    taskKind: 'EXECUTE',
    contract,
    enforce: false,
    allowFetch: false,
    ...overrides,
  });
}

function assertPreflightBlocks(repoRoot, contract, matcher) {
  assert.throws(() => runPreflight(repoRoot, contract), matcher);
}

test('task-git: disposable runtime artifacts and empty skillops logs do not block deterministic execute sync', async () => {
  const { repoRoot, contract } = await initDeterministicRepo('agentic-task-git-runtime-artifacts-');
  for (const relPath of [
    '.codex/quality/logs/q.md',
    '.codex/reviews/r.md',
    '.codex-tmp/temp.txt',
    'artifacts/reviews/previous.md',
  ]) {
    await fs.mkdir(path.join(repoRoot, path.dirname(relPath)), { recursive: true });
    await fs.writeFile(path.join(repoRoot, relPath), `${path.basename(relPath)}\n`, 'utf8');
  }
  await writeSkillOpsLog(repoRoot, 'empty.md', [
    '---',
    'id: empty-log',
    'status: new',
    'skill_updates:',
    '  cockpit-autopilot: []',
    '  cockpit-skillops: []',
    '---',
    '',
  ]);
  const resumed = runPreflight(repoRoot, contract);
  assert.equal(resumed.applied, true);
  assert.equal(resumed.autoCleaned, true);
  assert.deepEqual(resumed.autoCleanDetails?.removedPaths, ['.codex', '.codex-tmp', 'artifacts']);
  assert.equal(exec('git', ['status', '--porcelain'], { cwd: repoRoot }), '');
});

test('task-git: .codex/skill-opsbackup still blocks and is not treated as disposable skillops state', async () => {
  const { repoRoot, contract } = await initDeterministicRepo('agentic-task-git-skillopsbackup-');
  await fs.mkdir(path.join(repoRoot, '.codex', 'skill-opsbackup'), { recursive: true });
  await fs.writeFile(
    path.join(repoRoot, '.codex', 'skill-opsbackup', 'oops.md'),
    ['---', 'id: oops', 'status: new', 'skill_updates: {}', '---', ''].join('\n'),
    'utf8',
  );
  const statusPorcelain = exec('git', ['status', '--porcelain'], { cwd: repoRoot });
  assert.equal(statusPorcelain, '?? .codex/');
  assert.equal(summarizeBlockingGitStatusPorcelain({ cwd: repoRoot, statusPorcelain }), '?? .codex/');
  assertPreflightBlocks(repoRoot, contract, /Worktree has uncommitted changes; refusing deterministic branch sync for task/);
});

for (const fixture of [
  {
    name: 'task-git: canonical empty skill_updates mapping does not block deterministic execute sync',
    prefix: 'agentic-task-git-skillops-empty-inline-',
    fileName: 'empty-inline.md',
    content: ['---', 'id: empty-inline-log', 'status: new', 'skill_updates: {}', '---', ''],
  },
  {
    name: 'task-git: CRLF canonical empty skill_updates mapping does not block deterministic execute sync',
    prefix: 'agentic-task-git-skillops-crlf-empty-',
    fileName: 'empty-crlf.md',
    content: '---\r\nid: empty-crlf-log\r\nstatus: new\r\nskill_updates: {}\r\n---\r\n',
  },
]) {
  test(fixture.name, async () => {
    const { repoRoot, contract } = await initDeterministicRepo(fixture.prefix);
    await writeSkillOpsLog(repoRoot, fixture.fileName, fixture.content);
    const resumed = runPreflight(repoRoot, contract);
    assert.equal(resumed.applied, true);
    assert.equal(exec('git', ['status', '--porcelain'], { cwd: repoRoot }), '');
  });
}

for (const fixture of [
  {
    name: 'task-git: empty skill_updates with meaningful body still blocks deterministic execute sync',
    prefix: 'agentic-task-git-skillops-body-block-',
    fileName: 'meaningful-body.md',
    matcher: /Worktree has uncommitted changes; refusing deterministic branch sync for task/,
    content: [
      '---',
      'id: meaningful-body-log',
      'status: new',
      'skill_updates: {}',
      '---',
      '',
      '# Summary',
      '- What changed:',
      '- Why:',
      '',
      'Actual operator note that should not be auto-cleaned.',
      '',
    ],
  },
  {
    name: 'task-git: malformed skill_updates value still blocks deterministic execute sync',
    prefix: 'agentic-task-git-skillops-malformed-',
    fileName: 'malformed.md',
    matcher: /Worktree has uncommitted changes; refusing deterministic branch sync for task/,
    content: ['---', 'id: malformed-log', 'status: new', 'skill_updates:', '  cockpit-autopilot: "keep this"', '---', ''],
  },
  {
    name: 'task-git: bare skill_updates key without children still blocks deterministic execute sync',
    prefix: 'agentic-task-git-skillops-bare-',
    fileName: 'bare.md',
    matcher: /Worktree has uncommitted changes; refusing deterministic branch sync for task/,
    content: ['---', 'id: bare-log', 'status: new', 'skill_updates:', '---', ''],
  },
  {
    name: 'task-git: nested skill_updates mapping still blocks deterministic execute sync',
    prefix: 'agentic-task-git-skillops-nested-',
    fileName: 'nested.md',
    matcher: /Worktree has uncommitted changes; refusing deterministic branch sync for task/,
    content: ['---', 'id: nested-log', 'status: new', 'skill_updates:', '  cockpit-autopilot:', '    notes: []', '---', ''],
  },
  {
    name: 'task-git: non-empty skillops logs still block deterministic execute sync',
    prefix: 'agentic-task-git-skillops-block-',
    fileName: 'nonempty.md',
    matcher: TaskGitPreflightBlockedError,
    content: [
      '---',
      'id: nonempty-log',
      'status: new',
      'skill_updates:',
      '  cockpit-autopilot:',
      '    - "Keep the learning."',
      '---',
      '',
    ],
  },
]) {
  test(fixture.name, async () => {
    const { repoRoot, contract } = await initDeterministicRepo(fixture.prefix);
    await writeSkillOpsLog(repoRoot, fixture.fileName, fixture.content);
    assertPreflightBlocks(repoRoot, contract, fixture.matcher);
  });
}

test('task-git: non-execute preflight still cleans tracked disposable artifacts with quoted porcelain paths', async () => {
  const { repoRoot, contract } = await initDeterministicRepo('agentic-task-git-quoted-artifacts-');
  await fs.mkdir(path.join(repoRoot, 'artifacts'), { recursive: true });
  await fs.writeFile(path.join(repoRoot, 'artifacts', '.gitkeep'), '', 'utf8');
  exec('git', ['add', 'artifacts/.gitkeep'], { cwd: repoRoot });
  exec('git', ['commit', '-m', 'track artifacts dir'], { cwd: repoRoot });
  await fs.writeFile(path.join(repoRoot, 'artifacts', 'space name.md'), 'artifact\n', 'utf8');
  assert.match(exec('git', ['status', '--porcelain'], { cwd: repoRoot }), /"artifacts\/space name\.md"/);
  const resumed = runPreflight(repoRoot, contract, { taskKind: 'USER_REQUEST' });
  assert.equal(resumed.applied, true);
  assert.equal(resumed.autoCleaned, true);
  assert.deepEqual(resumed.autoCleanDetails?.removedPaths, ['artifacts/space name.md']);
  assert.equal(exec('git', ['status', '--porcelain'], { cwd: repoRoot }), '');
});

test('task-git: quoted UTF-8 disposable runtime artifacts are decoded and cleaned correctly', async () => {
  const { repoRoot, contract } = await initDeterministicRepo('agentic-task-git-quoted-utf8-artifacts-');
  await fs.mkdir(path.join(repoRoot, '.codex', 'quality'), { recursive: true });
  await fs.writeFile(path.join(repoRoot, '.codex', 'quality', '.gitkeep'), '', 'utf8');
  exec('git', ['add', '.codex/quality/.gitkeep'], { cwd: repoRoot });
  exec('git', ['commit', '-m', 'track quality dir'], { cwd: repoRoot });
  await fs.writeFile(path.join(repoRoot, '.codex', 'quality', 'café.md'), 'artifact\n', 'utf8');

  const statusPorcelain = exec('git', ['status', '--porcelain'], { cwd: repoRoot });
  assert.match(statusPorcelain, /caf\\303\\251\.md/);
  assert.equal(summarizeBlockingGitStatusPorcelain({ cwd: repoRoot, statusPorcelain }), '');

  const resumed = runPreflight(repoRoot, contract, { taskKind: 'USER_REQUEST' });
  assert.equal(resumed.applied, true);
  assert.equal(resumed.autoCleaned, true);
  assert.deepEqual(resumed.autoCleanDetails?.removedPaths, ['.codex/quality/café.md']);
  assert.equal(exec('git', ['status', '--porcelain'], { cwd: repoRoot }), '');
});
