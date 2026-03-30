import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import childProcess from 'node:child_process';
import {
  buildPreflightPlanHash,
  buildPreflightTaskFingerprint,
  normalizePreflightPlan,
  validatePreflightSubmission,
} from '../lib/worker-preflight-submission.mjs';
import {
  validatePreflightExecutionUnlock,
  validatePreflightClosure,
  captureTrackedSnapshot,
} from '../lib/worker-preflight-runtime.mjs';
import { readNumstatForBaseRef } from '../lib/code-quality-modularity.mjs';
import { runWriterPreflightPhase } from '../lib/worker-preflight-runner.mjs';
import { readNumstatRecordsForCommitOrWorkingTree } from '../lib/worker-preflight-session.mjs';

function git(cwd, args) {
  const res = childProcess.spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${String(res.stderr || '').trim()}`);
  }
}

function repeatLines(prefix, count) {
  return Array.from({ length: count }, (_, index) => `export const ${prefix}${index} = ${index};`).join('\n') + '\n';
}

async function createRepo() {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-preflight-'));
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.name', 'Test Bot']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  await fs.writeFile(path.join(repo, 'README.md'), '# test\n', 'utf8');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-m', 'init']);
  return repo;
}

function buildPlan(overrides = {}) {
  return {
    goal: 'Keep the fix scoped before tracked edits.',
    reusePath: 'Extend the existing runtime path in place.',
    modularityPlan: 'boundary-only:no-extraction-needed',
    chosenApproach: 'Use the existing narrow runtime path.',
    rejectedApproaches: [
      {
        approach: 'Rewrite the subsystem from scratch.',
        reason: 'That would blow scope and add pointless risk.',
      },
    ],
    touchpoints: ['src/**/*.js'],
    coupledSurfaces: ['verify:docs/**/*.md', 'update:scripts/**/*.mjs'],
    riskChecks: ['Verify runtime guards before done.'],
    openQuestions: [],
    ...overrides,
  };
}

test('worker-preflight: valid submission normalizes and hashes deterministically', async () => {
  const plan = buildPlan();
  const first = validatePreflightSubmission({
    preflightPlan: plan,
    taskKind: 'EXECUTE',
    taskPhase: 'execute',
    taskTitle: 'Fix runtime drift',
    taskBody: 'Implement the fix.',
    baseHead: 'abc123',
    workBranch: 'wip/backend/root/main',
  });
  const secondHash = buildPreflightPlanHash({
    taskKind: 'EXECUTE',
    taskPhase: 'execute',
    taskTitle: 'Fix runtime drift',
    taskBody: 'Implement the fix.',
    baseHead: 'abc123',
    workBranch: 'wip/backend/root/main',
    preflightPlan: first.normalizedPlan,
  });

  assert.equal(first.ok, true, first.errors.join('; '));
  assert.equal(first.planHash.length > 10, true);
  assert.equal(first.planHash, secondHash);
});

test('worker-preflight: task fingerprint changes when task metadata drifts', async () => {
  const base = buildPreflightTaskFingerprint({
    taskKind: 'EXECUTE',
    taskPhase: 'execute',
    taskTitle: 'Fix runtime drift',
    taskBody: 'Implement the fix.',
    taskMeta: {
      id: 't1',
      title: 'Fix runtime drift',
      signals: { kind: 'EXECUTE', phase: 'execute' },
      references: { git: { baseSha: 'abc123', workBranch: 'wip/test' } },
    },
    baseHead: 'abc123',
    workBranch: 'wip/test',
  });
  const changed = buildPreflightTaskFingerprint({
    taskKind: 'EXECUTE',
    taskPhase: 'execute',
    taskTitle: 'Fix runtime drift',
    taskBody: 'Implement the fix.',
    taskMeta: {
      id: 't1',
      title: 'Fix runtime drift',
      signals: { kind: 'EXECUTE', phase: 'execute', sourceKind: 'AUTOPILOT_BLOCKED_RECOVERY' },
      references: { git: { baseSha: 'abc123', workBranch: 'wip/test' } },
    },
    baseHead: 'abc123',
    workBranch: 'wip/test',
  });

  assert.notEqual(base, changed);
});

test('worker-preflight: banned filler values fail submission validation', async () => {
  const result = validatePreflightSubmission({
    preflightPlan: buildPlan({ reusePath: 'tbd' }),
    taskKind: 'EXECUTE',
    taskPhase: 'execute',
    taskTitle: 'Fix runtime drift',
    taskBody: 'Implement the fix.',
    baseHead: 'abc123',
    workBranch: 'wip/backend/root/main',
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /must not be filler/i);
});

test('worker-preflight: normalization drops empty rejected approaches', async () => {
  const normalized = normalizePreflightPlan(
    buildPlan({
      rejectedApproaches: [
        { approach: 'Keep the narrow path.', reason: 'Avoid rewrite churn.' },
        { approach: '   ', reason: '   ' },
      ],
    }),
  );

  assert.deepEqual(normalized?.rejectedApproaches, [
    {
      approach: 'Keep the narrow path.',
      reason: 'Avoid rewrite churn.',
    },
  ]);
});

test('worker-preflight: normalization canonicalizes rejectedApproaches ordering for stable hashes', async () => {
  const ordered = normalizePreflightPlan(
    buildPlan({
      rejectedApproaches: [
        { approach: 'Rewrite the subsystem from scratch.', reason: 'That would blow scope and add pointless risk.' },
        { approach: 'Split every helper first.', reason: 'That adds churn before proving the narrow fix.' },
      ],
    }),
  );
  const reordered = normalizePreflightPlan(
    buildPlan({
      rejectedApproaches: [
        { approach: 'Split every helper first.', reason: 'That adds churn before proving the narrow fix.' },
        { approach: 'Rewrite the subsystem from scratch.', reason: 'That would blow scope and add pointless risk.' },
      ],
    }),
  );

  assert.deepEqual(ordered?.rejectedApproaches, reordered?.rejectedApproaches);
  assert.equal(
    buildPreflightPlanHash({
      taskKind: 'EXECUTE',
      taskPhase: 'execute',
      taskTitle: 'Fix runtime drift',
      taskBody: 'Implement the fix.',
      baseHead: 'abc123',
      workBranch: 'wip/backend/root/main',
      preflightPlan: ordered,
    }),
    buildPreflightPlanHash({
      taskKind: 'EXECUTE',
      taskPhase: 'execute',
      taskTitle: 'Fix runtime drift',
      taskBody: 'Implement the fix.',
      baseHead: 'abc123',
      workBranch: 'wip/backend/root/main',
      preflightPlan: reordered,
    }),
  );
});

test('worker-preflight: execution unlock blocks open questions and tracked mutation', async (t) => {
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));

  const snapshot = captureTrackedSnapshot({ cwd: repo });
  await fs.writeFile(path.join(repo, 'README.md'), '# mutated\n', 'utf8');

  const result = await validatePreflightExecutionUnlock({
    repoRoot: repo,
    approvedPlan: buildPlan({ openQuestions: ['Need a real answer first.'] }),
    trackedSnapshot: snapshot,
    baseRef: '',
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /unlock_open_questions/);
  assert.match(result.errors.join(' '), /unlock_preflight_mutation_detected/);
});

test('worker-preflight-session: working-tree numstat falls back to [] before the first commit exists', async (t) => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-preflight-no-head-'));
  t.after(() => fs.rm(repo, { recursive: true, force: true }));

  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.name', 'Test Bot']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  await fs.writeFile(path.join(repo, 'scratch.js'), 'export const scratch = 1;\n', 'utf8');

  const records = readNumstatRecordsForCommitOrWorkingTree({
    cwd: repo,
    commitSha: '',
  });

  assert.deepEqual(records, []);
});

test('worker-preflight-session: working-tree numstat fails closed when git ls-files errors unexpectedly', async (t) => {
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));

  const originalExecFileSync = childProcess.execFileSync;
  childProcess.execFileSync = function patchedExecFileSync(command, args, options) {
    if (
      command === 'git' &&
      Array.isArray(args) &&
      args[0] === 'ls-files' &&
      args[1] === '--others'
    ) {
      const err = new Error('ls-files exploded');
      err.stderr = 'fatal: synthetic ls-files failure';
      throw err;
    }
    return originalExecFileSync.call(this, command, args, options);
  };
  t.after(() => {
    childProcess.execFileSync = originalExecFileSync;
  });

  assert.throws(
    () =>
      readNumstatRecordsForCommitOrWorkingTree({
        cwd: repo,
        commitSha: '',
      }),
    /working-tree preflight git ls-files failed/i,
  );
});

test('worker-preflight: execution unlock pre-check blocks protected host plans without scripts/lib extraction', async (t) => {
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));

  await fs.mkdir(path.join(repo, 'scripts'), { recursive: true });
  await fs.writeFile(path.join(repo, 'scripts', 'agent-codex-worker.mjs'), 'export const run = 1;\n', 'utf8');
  git(repo, ['add', 'scripts/agent-codex-worker.mjs']);
  git(repo, ['commit', '-m', 'add protected host']);

  const snapshot = captureTrackedSnapshot({ cwd: repo });
  const result = await validatePreflightExecutionUnlock({
    repoRoot: repo,
    approvedPlan: buildPlan({
      touchpoints: ['scripts/agent-codex-worker.mjs'],
      modularityPlan: 'Edit the worker host directly.',
    }),
    trackedSnapshot: snapshot,
    baseRef: '',
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /requires modularityPlan to reference extraction into scripts\/lib\//i);
});

test('worker-preflight: closure validation catches scope drift, verify-surface edits, and missing update surfaces', async (t) => {
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));

  const result = await validatePreflightClosure({
    repoRoot: repo,
    approvedPlan: buildPlan({
      touchpoints: ['src/allowed.js'],
      coupledSurfaces: ['verify:docs/**/*.md', 'update:scripts/generated.mjs'],
    }),
    outputPreflightPlan: buildPlan({
      touchpoints: ['src/allowed.js'],
      coupledSurfaces: ['verify:docs/**/*.md', 'update:scripts/generated.mjs'],
    }),
    changedFiles: ['docs/runbooks/runbook.md', 'src/rogue.js'],
    numstatRecords: [],
    baseRef: '',
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /closure_verify_surface_changed:docs\/runbooks\/runbook\.md/);
  assert.match(result.errors.join(' '), /closure_scope_drift:docs\/runbooks\/runbook\.md/);
  assert.match(result.errors.join(' '), /closure_scope_drift:src\/rogue\.js/);
  assert.match(result.errors.join(' '), /closure_missing_update_surface:scripts\/generated\.mjs/);
});

test('worker-preflight: untracked bootstrap-support files still enforce verify and update coupling', async (t) => {
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));

  await fs.mkdir(path.join(repo, 'docs', 'agentic'), { recursive: true });
  await fs.writeFile(path.join(repo, 'docs', 'agentic', 'runtime-note.md'), '# draft\n', 'utf8');
  await fs.writeFile(path.join(repo, 'docs', 'agentic', 'handoff.md'), '# handoff\n', 'utf8');

  const result = await validatePreflightClosure({
    repoRoot: repo,
    approvedPlan: buildPlan({
      touchpoints: ['src/allowed.js'],
      coupledSurfaces: ['verify:docs/agentic/*.md', 'update:docs/agentic/handoff.md'],
    }),
    outputPreflightPlan: buildPlan({
      touchpoints: ['src/allowed.js'],
      coupledSurfaces: ['verify:docs/agentic/*.md', 'update:docs/agentic/handoff.md'],
    }),
    changedFiles: ['docs/agentic/runtime-note.md', 'docs/agentic/handoff.md'],
    numstatRecords: [],
    baseRef: '',
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /closure_verify_surface_changed:docs\/agentic\/runtime-note\.md/);
  assert.doesNotMatch(result.errors.join(' '), /closure_missing_update_surface:docs\/agentic\/handoff\.md/);
});

test('worker-preflight: closure validation reports missing model preflight plan explicitly', async (t) => {
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));

  const result = await validatePreflightClosure({
    repoRoot: repo,
    approvedPlan: buildPlan({
      touchpoints: ['src/allowed.js'],
      coupledSurfaces: [],
    }),
    outputPreflightPlan: null,
    changedFiles: [],
    numstatRecords: [],
    baseRef: '',
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /closure_preflight_plan_missing/);
  assert.doesNotMatch(result.errors.join(' '), /closure_preflight_plan_mismatch/);
});

test('worker-preflight: closure validation reports modularity violations from the actual diff', async (t) => {
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));

  await fs.mkdir(path.join(repo, 'src'), { recursive: true });
  await fs.writeFile(path.join(repo, 'src', 'huge.js'), repeatLines('huge', 301), 'utf8');

  const result = await validatePreflightClosure({
    repoRoot: repo,
    approvedPlan: buildPlan({
      touchpoints: ['src/huge.js'],
      coupledSurfaces: [],
    }),
    outputPreflightPlan: buildPlan({
      touchpoints: ['src/huge.js'],
      coupledSurfaces: [],
    }),
    changedFiles: ['src/huge.js'],
    numstatRecords: readNumstatForBaseRef(repo),
    baseRef: '',
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /closure_modularity_violation:/);
});

test('worker-preflight-runner: tracked mutations during the preflight turn fail execution unlock', async (t) => {
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));

  const taskFile = path.join(repo, 'task.md');
  const outputPath = path.join(repo, 'preflight-output.json');
  await fs.writeFile(taskFile, '# task\n', 'utf8');
  const taskStat = await fs.stat(taskFile);
  let mutationCount = 0;

  let error = null;
  try {
    await runWriterPreflightPhase({
      fs,
      outputPath,
      agentName: 'codex-worker',
      taskId: 'task-1',
      taskCwd: repo,
      repoRoot: repo,
      schemaPath: path.join(repo, 'schema.json'),
      codexBin: 'codex',
      guardEnv: {},
      codexHomeEnv: {},
      autopilotDangerFullAccess: false,
      openedPath: taskFile,
      openedMeta: {},
      taskMarkdown: 'Implement the fix.',
      taskStatMtimeMs: taskStat.mtimeMs,
      taskKindNow: 'EXECUTE',
      taskPhase: 'execute',
      taskTitle: 'Fix runtime drift',
      preflightBaseHead: '',
      preflightWorkBranch: 'wip/test',
      isAutopilot: false,
      skillsSelected: [],
      includeSkills: false,
      contextBlock: '',
      preflightRetryReason: '',
      seedPlan: null,
      resumeSessionId: null,
      lastCodexThreadId: null,
      busRoot: repo,
      roster: {},
      writePane: () => {},
      runCodexAppServer: async ({ outputPath: nextOutputPath }) => {
        mutationCount += 1;
        await fs.writeFile(path.join(repo, 'README.md'), `# mutated ${mutationCount}\n`, 'utf8');
        await fs.writeFile(
          nextOutputPath,
          JSON.stringify({ preflightPlan: buildPlan() }),
          'utf8',
        );
        return { threadId: `thread-${mutationCount}` };
      },
      writeTaskSession: async () => path.join(repo, 'session.json'),
      firstPreflightReasonCode: (errors) => (Array.isArray(errors) && errors[0]) || null,
      createTurnError: (message, extra = {}) => Object.assign(new Error(message), extra),
    });
  } catch (err) {
    error = err;
  }

  assert.ok(error, 'expected the preflight runner to reject tracked mutations');
  assert.match(error.message, /preflight execution unlock failed/i);
  assert.match(`${error.stderrTail || ''}`, /unlock_preflight_mutation_detected/);
});
