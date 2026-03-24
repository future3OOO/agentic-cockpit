import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import childProcess from 'node:child_process';

import {
  attemptStaleWorkerWorktreeReclaim,
  TaskGitPreflightBlockedError,
  classifyControllerDirtyWorktree,
  ensureTaskGitContract,
  summarizeBlockingGitStatusPorcelain,
} from '../lib/task-git.mjs';

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

async function writeSkillOpsPromotionState(dir, payload) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${payload.rootId || 'root1'}.json`), JSON.stringify(payload, null, 2) + '\n', 'utf8');
}

async function writeTrackedSkill(repoRoot, skillName, { learned = 'existing rule' } = {}) {
  const skillDir = path.join(repoRoot, '.codex', 'skills', skillName);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, 'SKILL.md'),
    [
      '---',
      `name: ${skillName}`,
      'description: test skill',
      '---',
      '',
      `# ${skillName}`,
      '',
      '## Learned heuristics (SkillOps)',
      '<!-- SKILLOPS:BEGIN -->',
      `- ${learned} [src:old-log]`,
      '<!-- SKILLOPS:END -->',
      '',
    ].join('\n'),
    'utf8',
  );
  exec('git', ['add', `.codex/skills/${skillName}/SKILL.md`], { cwd: repoRoot });
  exec('git', ['commit', '-m', `track ${skillName} skill`], { cwd: repoRoot });
}

async function writeInboxTask(busRoot, agentName, state, taskId) {
  const dir = path.join(busRoot, 'inbox', agentName, state);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${taskId}.md`), `---\nid: ${taskId}\n---\n`, 'utf8');
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

test('task-git: queued skillops logs are non-blocking only with matching promotion state evidence and are not auto-removed', async () => {
  const { repoRoot, contract } = await initDeterministicRepo('agentic-task-git-skillops-queued-');
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-task-git-state-'));
  const logPath = path.join(repoRoot, '.codex', 'skill-ops', 'logs', '2026-03', 'queued.md');
  await writeSkillOpsLog(repoRoot, 'queued.md', [
    '---',
    'id: queued-log',
    'created_at: "2026-03-10T00:00:00Z"',
    'status: queued',
    'processed_at: null',
    'queued_at: "2026-03-10T00:00:00Z"',
    'promotion_task_id: "skillops_promotion__autopilot__root1"',
    'skills:',
    '  - cockpit-autopilot',
    'skill_updates:',
    '  cockpit-autopilot:',
    '    - "durable learning"',
    'title: "Queued log"',
    '---',
    '',
  ]);
  await writeSkillOpsPromotionState(stateDir, {
    rootId: 'root1',
    promotionTaskId: 'skillops_promotion__autopilot__root1',
    sourceLogIds: ['queued-log'],
    status: 'queued',
  });

  const statusPorcelain = exec('git', ['status', '--porcelain'], { cwd: repoRoot });
  assert.notEqual(statusPorcelain, '');
  assert.equal(summarizeBlockingGitStatusPorcelain({ cwd: repoRoot, statusPorcelain, skillOpsPromotionStateDir: stateDir }), '');
  const resumed = runPreflight(repoRoot, contract, { skillOpsPromotionStateDir: stateDir });
  assert.equal(resumed.applied, true);
  assert.notEqual(resumed.autoCleaned, true);
  await fs.stat(logPath);
  assert.notEqual(exec('git', ['status', '--porcelain'], { cwd: repoRoot }), '');
});

for (const fixture of [
  { status: 'processed', prefix: 'agentic-task-git-skillops-processed-', fileName: 'processed.md' },
  { status: 'skipped', prefix: 'agentic-task-git-skillops-skipped-', fileName: 'skipped.md' },
]) {
  test(`task-git: ${fixture.status} skillops logs are disposable local dirt`, async () => {
    const { repoRoot, contract } = await initDeterministicRepo(fixture.prefix);
    const logPath = path.join(repoRoot, '.codex', 'skill-ops', 'logs', '2026-03', fixture.fileName);
    await writeSkillOpsLog(repoRoot, fixture.fileName, [
      '---',
      `id: ${fixture.status}-log`,
      'created_at: "2026-03-10T00:00:00Z"',
      `status: ${fixture.status}`,
      'processed_at: "2026-03-10T01:00:00Z"',
      'queued_at: null',
      'promotion_task_id: null',
      'skills:',
      '  - cockpit-autopilot',
      'skill_updates:',
      '  cockpit-autopilot: []',
      `title: "${fixture.status} log"`,
      '---',
      '',
    ]);

    const resumed = runPreflight(repoRoot, contract);
    assert.equal(resumed.applied, true);
    assert.equal(resumed.autoCleaned, true);
    await assert.rejects(fs.stat(logPath), /ENOENT/);
    assert.equal(exec('git', ['status', '--porcelain'], { cwd: repoRoot }), '');
  });
}

test('task-git: queued skillops logs without matching promotion state still block deterministic execute sync', async () => {
  const { repoRoot, contract } = await initDeterministicRepo('agentic-task-git-skillops-queued-block-');
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-task-git-state-'));
  await writeSkillOpsLog(repoRoot, 'queued-block.md', [
    '---',
    'id: queued-log',
    'created_at: "2026-03-10T00:00:00Z"',
    'status: queued',
    'processed_at: null',
    'queued_at: "2026-03-10T00:00:00Z"',
    'promotion_task_id: "skillops_promotion__autopilot__root1"',
    'skills:',
    '  - cockpit-autopilot',
    'skill_updates:',
    '  cockpit-autopilot:',
    '    - "durable learning"',
    'title: "Queued log"',
    '---',
    '',
  ]);
  await writeSkillOpsPromotionState(stateDir, {
    rootId: 'root1',
    promotionTaskId: 'skillops_promotion__autopilot__root1',
    sourceLogIds: ['different-log'],
    status: 'queued',
  });

  assert.throws(
    () => runPreflight(repoRoot, contract, { skillOpsPromotionStateDir: stateDir }),
    TaskGitPreflightBlockedError,
  );
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
    name: 'task-git: bare child skill_updates key without children does not block deterministic execute sync',
    prefix: 'agentic-task-git-skillops-empty-bare-child-',
    fileName: 'empty-bare-child.md',
    content: ['---', 'id: empty-bare-child-log', 'status: new', 'skill_updates:', '  cockpit-autopilot:', '---', ''],
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

test('task-git: non-rename paths containing arrow text are not split into fake rename paths', async () => {
  const { repoRoot, contract } = await initDeterministicRepo('agentic-task-git-arrow-path-');
  await fs.mkdir(path.join(repoRoot, 'docs'), { recursive: true });
  await fs.writeFile(path.join(repoRoot, 'docs', 'a -> b.md'), 'seed\n', 'utf8');
  exec('git', ['add', 'docs/a -> b.md'], { cwd: repoRoot });
  exec('git', ['commit', '-m', 'track arrow path'], { cwd: repoRoot });
  await fs.writeFile(path.join(repoRoot, 'docs', 'a -> b.md'), 'changed\n', 'utf8');

  const statusPorcelain = exec('git', ['status', '--porcelain'], { cwd: repoRoot });
  assert.match(statusPorcelain, /"docs\/a -> b\.md"/);
  const summary = summarizeBlockingGitStatusPorcelain({ cwd: repoRoot, statusPorcelain });
  assert.match(summary, /docs\/a -> b\.md/);
  assert.doesNotMatch(summary, /^ M b\.md$/m);
  assertPreflightBlocks(repoRoot, contract, TaskGitPreflightBlockedError);
});

test('task-git: tracked disposable runtime artifacts still block preflight', async () => {
  const { repoRoot, contract } = await initDeterministicRepo('agentic-task-git-tracked-runtime-artifact-');
  await fs.mkdir(path.join(repoRoot, '.codex', 'quality'), { recursive: true });
  await fs.writeFile(path.join(repoRoot, '.codex', 'quality', '.gitkeep'), 'tracked\n', 'utf8');
  exec('git', ['add', '.codex/quality/.gitkeep'], { cwd: repoRoot });
  exec('git', ['commit', '-m', 'track quality keep'], { cwd: repoRoot });
  await fs.writeFile(path.join(repoRoot, '.codex', 'quality', '.gitkeep'), 'modified\n', 'utf8');

  const statusPorcelain = exec('git', ['status', '--porcelain'], { cwd: repoRoot });
  assert.match(statusPorcelain, /\.codex\/quality\/\.gitkeep/);
  assert.match(summarizeBlockingGitStatusPorcelain({ cwd: repoRoot, statusPorcelain }), /\.codex\/quality\/\.gitkeep/);
  assertPreflightBlocks(repoRoot, contract, TaskGitPreflightBlockedError);
});

test('task-git: stale dirty worker worktree is reclaimed when no other open tasks exist', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-task-git-stale-reclaim-'));
  const busRoot = path.join(tmp, 'bus');
  const repoRoot = path.join(tmp, 'repo');
  const baseSha = await initRepo(repoRoot);
  const staleContract = {
    baseBranch: 'main',
    baseSha,
    workBranch: 'wip/backend/root-old',
    integrationBranch: 'slice/root-old',
  };
  ensureTaskGitContract({
    cwd: repoRoot,
    taskKind: 'EXECUTE',
    contract: staleContract,
    enforce: false,
    allowFetch: false,
  });
  await fs.writeFile(path.join(repoRoot, 'README.md'), 'stale dirt\n', 'utf8');
  await writeInboxTask(busRoot, 'backend', 'in_progress', 'task-current');

  const reclaimed = attemptStaleWorkerWorktreeReclaim({
    cwd: repoRoot,
    busRoot,
    agentName: 'backend',
    currentTaskId: 'task-current',
    incomingRootId: 'root-new',
    previousRootId: 'root-old',
    contract: {
      baseBranch: 'main',
      baseSha,
      workBranch: 'wip/backend/root-new',
      integrationBranch: 'slice/root-new',
    },
  });

  assert.equal(reclaimed.reclaimed, true);
  assert.equal(exec('git', ['status', '--porcelain'], { cwd: repoRoot }), '');
  assert.equal(exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot }), 'wip/backend/root-old');
  assert.equal(typeof reclaimed.diffWorking, 'undefined');
  assert.equal(typeof reclaimed.diffStaged, 'undefined');
  assert.equal(reclaimed.workingDiffSummary.captured, true);
  assert.ok(reclaimed.workingDiffSummary.byteCount > 0);
  assert.deepEqual(reclaimed.workingDiffSummary.files, ['README.md']);
});

test('task-git: stale dirty worker reclaim fails closed when branch ownership is not proven', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-task-git-branch-proof-'));
  const busRoot = path.join(tmp, 'bus');
  const repoRoot = path.join(tmp, 'repo');
  const baseSha = await initRepo(repoRoot);
  const currentContract = {
    baseBranch: 'main',
    baseSha,
    workBranch: 'wip/backend/root-new',
    integrationBranch: 'slice/root-new',
  };
  ensureTaskGitContract({
    cwd: repoRoot,
    taskKind: 'EXECUTE',
    contract: currentContract,
    enforce: false,
    allowFetch: false,
  });
  await fs.writeFile(path.join(repoRoot, 'README.md'), 'current-root dirt\n', 'utf8');
  await writeInboxTask(busRoot, 'backend', 'in_progress', 'task-current');

  const reclaimed = attemptStaleWorkerWorktreeReclaim({
    cwd: repoRoot,
    busRoot,
    agentName: 'backend',
    currentTaskId: 'task-current',
    incomingRootId: 'root-new',
    previousRootId: 'root-old',
    contract: currentContract,
  });

  assert.equal(reclaimed.reclaimed, false);
  assert.equal(reclaimed.reason, 'branch_ownership_not_proven');
  assert.equal(reclaimed.currentBranch, 'wip/backend/root-new');
  assert.equal(reclaimed.targetBranch, 'wip/backend/root-new');
  assert.match(exec('git', ['status', '--porcelain'], { cwd: repoRoot }), /README\.md/);
});

test('task-git: stale dirty worker reclaim fails closed when another open task still exists', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-task-git-stale-reclaim-block-'));
  const busRoot = path.join(tmp, 'bus');
  const repoRoot = path.join(tmp, 'repo');
  const baseSha = await initRepo(repoRoot);
  const staleContract = {
    baseBranch: 'main',
    baseSha,
    workBranch: 'wip/backend/root-old',
    integrationBranch: 'slice/root-old',
  };
  ensureTaskGitContract({
    cwd: repoRoot,
    taskKind: 'EXECUTE',
    contract: staleContract,
    enforce: false,
    allowFetch: false,
  });
  await fs.writeFile(path.join(repoRoot, 'README.md'), 'stale dirt\n', 'utf8');
  await writeInboxTask(busRoot, 'backend', 'in_progress', 'task-current');
  await writeInboxTask(busRoot, 'backend', 'new', 'task-other');

  const reclaimed = attemptStaleWorkerWorktreeReclaim({
    cwd: repoRoot,
    busRoot,
    agentName: 'backend',
    currentTaskId: 'task-current',
    incomingRootId: 'root-new',
    previousRootId: 'root-old',
    contract: {
      baseBranch: 'main',
      baseSha,
      workBranch: 'wip/backend/root-new',
      integrationBranch: 'slice/root-new',
    },
  });

  assert.equal(reclaimed.reclaimed, false);
  assert.equal(reclaimed.reason, 'other_open_tasks_present');
  assert.deepEqual(reclaimed.otherOpenTaskIds, ['task-other']);
  assert.match(exec('git', ['status', '--porcelain'], { cwd: repoRoot }), /README\.md/);
});

test('task-git: inbox scan errors fail closed before reclaim', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-task-git-inbox-scan-error-'));
  const busRoot = path.join(tmp, 'bus');
  const repoRoot = path.join(tmp, 'repo');
  const baseSha = await initRepo(repoRoot);
  const staleContract = {
    baseBranch: 'main',
    baseSha,
    workBranch: 'wip/backend/root-old',
    integrationBranch: 'slice/root-old',
  };
  ensureTaskGitContract({
    cwd: repoRoot,
    taskKind: 'EXECUTE',
    contract: staleContract,
    enforce: false,
    allowFetch: false,
  });
  await fs.writeFile(path.join(repoRoot, 'README.md'), 'stale dirt\n', 'utf8');
  const brokenStatePath = path.join(busRoot, 'inbox', 'backend', 'new');
  await fs.mkdir(path.dirname(brokenStatePath), { recursive: true });
  await fs.writeFile(brokenStatePath, 'not-a-directory\n', 'utf8');

  const reclaimed = attemptStaleWorkerWorktreeReclaim({
    cwd: repoRoot,
    busRoot,
    agentName: 'backend',
    currentTaskId: 'task-current',
    incomingRootId: 'root-new',
    previousRootId: 'root-old',
    contract: {
      baseBranch: 'main',
      baseSha,
      workBranch: 'wip/backend/root-new',
      integrationBranch: 'slice/root-new',
    },
  });

  assert.equal(reclaimed.reclaimed, false);
  assert.equal(reclaimed.reason, 'inbox_scan_error');
  assert.match(String(reclaimed.error || ''), /ENOTDIR|not a directory/i);
  assert.match(exec('git', ['status', '--porcelain'], { cwd: repoRoot }), /README\.md/);
});

test('task-git: same-root rotate branch transition is not treated as stale ownership', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-task-git-rotate-preserve-'));
  const busRoot = path.join(tmp, 'bus');
  const repoRoot = path.join(tmp, 'repo');
  const baseSha = await initRepo(repoRoot);
  const initialContract = {
    baseBranch: 'main',
    baseSha,
    workBranch: 'wip/backend/root-same/main',
    integrationBranch: 'slice/root-same',
  };
  ensureTaskGitContract({
    cwd: repoRoot,
    taskKind: 'EXECUTE',
    contract: initialContract,
    enforce: false,
    allowFetch: false,
  });
  await fs.writeFile(path.join(repoRoot, 'README.md'), 'same-root rotate dirt\n', 'utf8');
  await writeInboxTask(busRoot, 'backend', 'in_progress', 'task-current');

  const reclaimed = attemptStaleWorkerWorktreeReclaim({
    cwd: repoRoot,
    busRoot,
    agentName: 'backend',
    currentTaskId: 'task-current',
    incomingRootId: 'root-same',
    previousRootId: 'root-same',
    contract: {
      baseBranch: 'main',
      baseSha,
      workBranch: 'wip/backend/root-same/main/r1',
      integrationBranch: 'slice/root-same',
    },
  });

  assert.equal(reclaimed.reclaimed, false);
  assert.equal(reclaimed.reason, 'same_root_branch_transition_not_stale');
  assert.match(exec('git', ['status', '--porcelain'], { cwd: repoRoot }), /README\.md/);
  assert.equal(exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot }), 'wip/backend/root-same/main');
});

test('task-git: pending skillops promotion dirt stays on controller-housekeeping path', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-task-git-skillops-housekeeping-'));
  const busRoot = path.join(tmp, 'bus');
  const { repoRoot } = await initDeterministicRepo('agentic-task-git-skillops-housekeeping-repo-');
  const baseSha = exec('git', ['rev-parse', 'HEAD'], { cwd: repoRoot });
  ensureTaskGitContract({
    cwd: repoRoot,
    taskKind: 'EXECUTE',
    contract: {
      baseBranch: 'main',
      baseSha,
      workBranch: 'wip/backend/root-old',
      integrationBranch: 'slice/root-old',
    },
    enforce: false,
    allowFetch: false,
  });
  await writeTrackedSkill(repoRoot, 'cockpit-autopilot');
  await fs.writeFile(
    path.join(repoRoot, '.codex', 'skills', 'cockpit-autopilot', 'SKILL.md'),
    [
      '---',
      'name: cockpit-autopilot',
      'description: test skill',
      '---',
      '',
      '# cockpit-autopilot',
      '',
      '## Learned heuristics (SkillOps)',
      '<!-- SKILLOPS:BEGIN -->',
      '- new runtime rule [src:pending-log]',
      '<!-- SKILLOPS:END -->',
      '',
    ].join('\n'),
    'utf8',
  );
  await writeSkillOpsLog(repoRoot, 'pending.md', [
    '---',
    'id: pending-log',
    'status: pending',
    'skill_updates:',
    '  cockpit-autopilot:',
    '    - "new runtime rule"',
    '---',
    '',
  ]);
  await writeInboxTask(busRoot, 'backend', 'in_progress', 'task-current');

  const reclaimed = attemptStaleWorkerWorktreeReclaim({
    cwd: repoRoot,
    busRoot,
    agentName: 'backend',
    currentTaskId: 'task-current',
    incomingRootId: 'root-new',
    previousRootId: 'root-old',
    contract: {
      baseBranch: 'main',
      baseSha,
      workBranch: 'wip/backend/root-new',
      integrationBranch: 'slice/root-new',
    },
  });

  assert.equal(reclaimed.reclaimed, false);
  assert.equal(reclaimed.reason, 'controller_housekeeping_required');
  assert.deepEqual(reclaimed.pendingSkillOpsLogPaths, ['.codex/skill-ops/logs/2026-03/pending.md']);
  assert.deepEqual(reclaimed.recoverableTrackedPaths, ['.codex/skills/cockpit-autopilot/SKILL.md']);
  const statusPorcelain = exec('git', ['status', '--porcelain'], { cwd: repoRoot });
  assert.match(statusPorcelain, /\.codex\/skill-ops\//);
  assert.match(statusPorcelain, /cockpit-autopilot\/SKILL\.md/);
});

test('task-git: controller dirt classifier routes pending skillops log plus matching tracked skill target into housekeeping', async () => {
  const { repoRoot } = await initDeterministicRepo('agentic-task-git-controller-classifier-');
  await writeTrackedSkill(repoRoot, 'cockpit-autopilot');
  await fs.writeFile(
    path.join(repoRoot, '.codex', 'skills', 'cockpit-autopilot', 'SKILL.md'),
    [
      '---',
      'name: cockpit-autopilot',
      'description: test skill',
      '---',
      '',
      '# cockpit-autopilot',
      '',
      '## Learned heuristics (SkillOps)',
      '<!-- SKILLOPS:BEGIN -->',
      '- new runtime rule [src:pending-log]',
      '<!-- SKILLOPS:END -->',
      '',
    ].join('\n'),
    'utf8',
  );
  await writeSkillOpsLog(repoRoot, 'pending.md', [
    '---',
    'id: pending-log',
    'status: pending',
    'skill_updates:',
    '  cockpit-autopilot:',
    '    - "new runtime rule"',
    '---',
    '',
  ]);

  const snapshot = {
    branch: exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot }),
    headSha: exec('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }),
    commonDir: exec('git', ['rev-parse', '--git-common-dir'], { cwd: repoRoot }),
    statusPorcelain: exec('git', ['status', '--porcelain'], { cwd: repoRoot }),
  };
  const classified = classifyControllerDirtyWorktree({
    cwd: repoRoot,
    statusPorcelain: snapshot.statusPorcelain,
    agentName: 'daddy-autopilot',
    branch: snapshot.branch,
    repoCommonGitDir: path.resolve(repoRoot, snapshot.commonDir),
    headSha: snapshot.headSha,
    autoCleanRuntimeArtifacts: false,
  });

  assert.equal(classified.classification, 'controller_housekeeping_required');
  assert.deepEqual(classified.pendingSkillOpsLogPaths, ['.codex/skill-ops/logs/2026-03/pending.md']);
  assert.deepEqual(classified.recoverableTrackedPaths, ['.codex/skills/cockpit-autopilot/SKILL.md']);
  assert.match(classified.recoverableStatusPorcelain, /\?\? \.codex\/skill-ops\/logs\/2026-03\/pending\.md/);
  assert.match(classified.recoverableStatusPorcelain, /cockpit-autopilot\/SKILL\.md/);
});

test('task-git: controller dirt classifier fails closed on mixed tracked model dirt', async () => {
  const { repoRoot } = await initDeterministicRepo('agentic-task-git-controller-mixed-');
  await writeTrackedSkill(repoRoot, 'cockpit-autopilot');
  await fs.writeFile(path.join(repoRoot, 'README.md'), 'user dirt\n', 'utf8');
  await writeSkillOpsLog(repoRoot, 'pending.md', [
    '---',
    'id: pending-log',
    'status: pending',
    'skill_updates:',
    '  cockpit-autopilot:',
    '    - "new runtime rule"',
    '---',
    '',
  ]);

  const snapshot = {
    branch: exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot }),
    headSha: exec('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }),
    commonDir: exec('git', ['rev-parse', '--git-common-dir'], { cwd: repoRoot }),
    statusPorcelain: exec('git', ['status', '--porcelain'], { cwd: repoRoot }),
  };
  const classified = classifyControllerDirtyWorktree({
    cwd: repoRoot,
    statusPorcelain: snapshot.statusPorcelain,
    agentName: 'daddy-autopilot',
    branch: snapshot.branch,
    repoCommonGitDir: path.resolve(repoRoot, snapshot.commonDir),
    headSha: snapshot.headSha,
    autoCleanRuntimeArtifacts: false,
  });

  assert.equal(classified.classification, 'substantive_dirty_block');
  assert.match(classified.blockingStatusPorcelain, /README\.md/);
});

test('task-git: controller dirt fingerprint changes when headSha changes even if recoverable lines stay the same', async () => {
  const { repoRoot } = await initDeterministicRepo('agentic-task-git-controller-fingerprint-');
  await writeTrackedSkill(repoRoot, 'cockpit-autopilot');
  await fs.writeFile(
    path.join(repoRoot, '.codex', 'skills', 'cockpit-autopilot', 'SKILL.md'),
    [
      '---',
      'name: cockpit-autopilot',
      'description: test skill',
      '---',
      '',
      '# cockpit-autopilot',
      '',
      '## Learned heuristics (SkillOps)',
      '<!-- SKILLOPS:BEGIN -->',
      '- new runtime rule [src:pending-log]',
      '<!-- SKILLOPS:END -->',
      '',
    ].join('\n'),
    'utf8',
  );
  await writeSkillOpsLog(repoRoot, 'pending.md', [
    '---',
    'id: pending-log',
    'status: pending',
    'skill_updates:',
    '  cockpit-autopilot:',
    '    - "new runtime rule"',
    '---',
    '',
  ]);

  const statusPorcelain = exec('git', ['status', '--porcelain'], { cwd: repoRoot });
  const branch = exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot });
  const repoCommonGitDir = path.resolve(repoRoot, exec('git', ['rev-parse', '--git-common-dir'], { cwd: repoRoot }));
  const headSha = exec('git', ['rev-parse', 'HEAD'], { cwd: repoRoot });

  const first = classifyControllerDirtyWorktree({
    cwd: repoRoot,
    statusPorcelain,
    agentName: 'daddy-autopilot',
    branch,
    repoCommonGitDir,
    headSha,
    autoCleanRuntimeArtifacts: false,
  });

  await fs.writeFile(path.join(repoRoot, 'README.md'), 'head advance\n', 'utf8');
  exec('git', ['add', 'README.md'], { cwd: repoRoot });
  exec('git', ['commit', '-m', 'advance head'], { cwd: repoRoot });
  await fs.writeFile(
    path.join(repoRoot, '.codex', 'skills', 'cockpit-autopilot', 'SKILL.md'),
    [
      '---',
      'name: cockpit-autopilot',
      'description: test skill',
      '---',
      '',
      '# cockpit-autopilot',
      '',
      '## Learned heuristics (SkillOps)',
      '<!-- SKILLOPS:BEGIN -->',
      '- new runtime rule [src:pending-log]',
      '<!-- SKILLOPS:END -->',
      '',
    ].join('\n'),
    'utf8',
  );
  await writeSkillOpsLog(repoRoot, 'pending.md', [
    '---',
    'id: pending-log',
    'status: pending',
    'skill_updates:',
    '  cockpit-autopilot:',
    '    - "new runtime rule"',
    '---',
    '',
  ]);

  const second = classifyControllerDirtyWorktree({
    cwd: repoRoot,
    statusPorcelain: exec('git', ['status', '--porcelain'], { cwd: repoRoot }),
    agentName: 'daddy-autopilot',
    branch: exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot }),
    repoCommonGitDir: path.resolve(repoRoot, exec('git', ['rev-parse', '--git-common-dir'], { cwd: repoRoot })),
    headSha: exec('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }),
    autoCleanRuntimeArtifacts: false,
  });

  assert.notEqual(first.fingerprint, second.fingerprint);
});
