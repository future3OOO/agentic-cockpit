import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import childProcess from 'node:child_process';
import {
  buildPreflightPlanHash,
  normalizePreflightPlan,
  validatePreflightSubmission,
} from '../lib/worker-preflight-submission.mjs';
import { buildPreflightTaskFingerprint } from '../lib/worker-preflight-submission.mjs';
import {
  validatePreflightExecutionUnlock,
  validatePreflightClosure,
  captureTrackedSnapshot,
  finalizePreflightClosureGate,
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

const BASE_SUBMISSION_CONTEXT = Object.freeze({
  taskKind: 'EXECUTE',
  taskPhase: 'execute',
  taskTitle: 'Fix runtime drift',
  taskBody: 'Implement the fix.',
  baseHead: 'abc123',
  workBranch: 'wip/backend/root/main',
});

const BASE_FINGERPRINT_CONTEXT = Object.freeze({
  taskKind: 'EXECUTE',
  taskPhase: 'execute',
  taskTitle: 'Fix runtime drift',
  taskBody: 'Implement the fix.',
  baseHead: 'abc123',
  workBranch: 'wip/test',
});

async function initRepo(repo) {
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.name', 'Test Bot']);
  git(repo, ['config', 'user.email', 'test@example.com']);
}

async function createRepo() {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-preflight-'));
  await initRepo(repo);
  await fs.writeFile(path.join(repo, 'README.md'), '# test\n', 'utf8');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-m', 'init']);
  return repo;
}

function buildSubmissionArgs(preflightPlan, overrides = {}) {
  return {
    preflightPlan,
    ...BASE_SUBMISSION_CONTEXT,
    ...overrides,
  };
}

async function validateClosure(repoRoot, {
  approvedPlan,
  outputPreflightPlan = approvedPlan,
  changedFiles = [],
  numstatRecords = [],
  baseRef = '',
}) {
  return validatePreflightClosure({
    repoRoot,
    approvedPlan,
    outputPreflightPlan,
    changedFiles,
    numstatRecords,
    baseRef,
  });
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
  const first = validatePreflightSubmission(buildSubmissionArgs(plan));
  const secondHash = buildPreflightPlanHash({
    ...BASE_SUBMISSION_CONTEXT,
    preflightPlan: first.normalizedPlan,
  });

  assert.equal(first.ok, true, first.errors.join('; '));
  assert.equal(first.planHash.length > 10, true);
  assert.equal(first.planHash, secondHash);
});

test('worker-preflight: task fingerprint changes when task metadata drifts', async () => {
  const base = buildPreflightTaskFingerprint({
    ...BASE_FINGERPRINT_CONTEXT,
    taskMeta: {
      id: 't1',
      title: 'Fix runtime drift',
      signals: { kind: 'EXECUTE', phase: 'execute' },
      references: { git: { baseSha: 'abc123', workBranch: 'wip/test' } },
    },
  });
  const changed = buildPreflightTaskFingerprint({
    ...BASE_FINGERPRINT_CONTEXT,
    taskMeta: {
      id: 't1',
      title: 'Fix runtime drift',
      signals: { kind: 'EXECUTE', phase: 'execute', sourceKind: 'AUTOPILOT_BLOCKED_RECOVERY' },
      references: { git: { baseSha: 'abc123', workBranch: 'wip/test' } },
    },
  });

  assert.notEqual(base, changed);
});

test('worker-preflight: banned filler values fail submission validation', async () => {
  const result = validatePreflightSubmission(buildSubmissionArgs(buildPlan({ reusePath: 'tbd' })));

  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /must not be filler/i);
});

test('worker-preflight: touchpoints fail when distinct raw paths collapse to the same canonical repo path', async () => {
  const result = validatePreflightSubmission(buildSubmissionArgs(buildPlan({
      touchpoints: ['src\\worker.js', 'src/worker.js'],
    })));

  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /duplicate canonical path: src\/worker\.js/i);
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
      ...BASE_SUBMISSION_CONTEXT,
      preflightPlan: ordered,
    }),
    buildPreflightPlanHash({
      ...BASE_SUBMISSION_CONTEXT,
      preflightPlan: reordered,
    }),
  );
});

test('worker-preflight: execution unlock surfaces open questions in evidence without blocking', async (t) => {
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));

  const snapshot = captureTrackedSnapshot({ cwd: repo });

  const result = await validatePreflightExecutionUnlock({
    repoRoot: repo,
    approvedPlan: buildPlan({ openQuestions: ['Need a real answer first.'] }),
    trackedSnapshot: snapshot,
    baseRef: '',
  });

  assert.equal(result.ok, true);
  assert.deepStrictEqual(result.evidence.openQuestions, ['Need a real answer first.']);
});

test('worker-preflight: execution unlock still blocks on tracked mutation alongside open questions', async (t) => {
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
  assert.match(result.errors.join(' '), /unlock_preflight_mutation_detected/);
  assert.ok(!result.errors.join(' ').includes('unlock_open_questions'));
  assert.deepStrictEqual(result.evidence.openQuestions, ['Need a real answer first.']);
});

test('worker-preflight: closure gate hard-blocks completed non-done outcomes when scope drift is detected', async (t) => {
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));

  await fs.mkdir(path.join(repo, 'src'), { recursive: true });
  await fs.writeFile(path.join(repo, 'src', 'rogue.js'), 'export const rogue = true;\n', 'utf8');

  const result = await finalizePreflightClosureGate({
    repoRoot: repo,
    approvedPlan: buildPlan({
      touchpoints: ['src/allowed.js'],
      coupledSurfaces: [],
    }),
    outputPreflightPlan: buildPlan({
      touchpoints: ['src/allowed.js'],
      coupledSurfaces: [],
    }),
    sourceDelta: {
      changedFiles: ['src/rogue.js'],
      inspectError: null,
    },
    commitSha: '',
    isCommitObjectMissingError: () => false,
    unreadableFileLineCount: -1,
    baseRef: '',
    gateEvidence: {
      required: true,
      approved: true,
      noWritePass: true,
      planHash: 'plan-hash',
      driftDetected: false,
      reasonCode: null,
    },
    outcome: 'needs_review',
  });

  assert.equal(result.blocked, true);
  assert.equal(result.gateEvidence.driftDetected, true);
  assert.equal(result.gateEvidence.reasonCode, 'closure_scope_drift');
  assert.match(result.blockDetail, /closure_scope_drift:src\/rogue\.js/);
});

test('worker-preflight-session: working-tree numstat falls back to [] before the first commit exists', async (t) => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-preflight-no-head-'));
  t.after(() => fs.rm(repo, { recursive: true, force: true }));

  await initRepo(repo);
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

  const result = await validateClosure(repo, {
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
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /closure_verify_surface_changed:docs\/runbooks\/runbook\.md/);
  assert.doesNotMatch(result.errors.join(' '), /closure_scope_drift:docs\/runbooks\/runbook\.md/);
  assert.match(result.errors.join(' '), /closure_scope_drift:src\/rogue\.js/);
  assert.match(result.errors.join(' '), /closure_missing_update_surface:scripts\/generated\.mjs/);
});

test('worker-preflight: untracked bootstrap-support files still enforce verify and update coupling', async (t) => {
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));

  await fs.mkdir(path.join(repo, 'docs', 'agentic'), { recursive: true });
  await fs.writeFile(path.join(repo, 'docs', 'agentic', 'runtime-note.md'), '# draft\n', 'utf8');
  await fs.writeFile(path.join(repo, 'docs', 'agentic', 'handoff.md'), '# handoff\n', 'utf8');

  const result = await validateClosure(repo, {
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
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /closure_verify_surface_changed:docs\/agentic\/runtime-note\.md/);
  assert.doesNotMatch(result.errors.join(' '), /closure_missing_update_surface:docs\/agentic\/handoff\.md/);
});

test('worker-preflight: update surfaces win over overlapping verify globs during closure validation', async (t) => {
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));

  const result = await validateClosure(repo, {
    approvedPlan: buildPlan({
      touchpoints: ['src/allowed.js'],
      coupledSurfaces: ['verify:docs/agentic/*.md', 'update:docs/agentic/handoff.md'],
    }),
    outputPreflightPlan: buildPlan({
      touchpoints: ['src/allowed.js'],
      coupledSurfaces: ['verify:docs/agentic/*.md', 'update:docs/agentic/handoff.md'],
    }),
    changedFiles: ['docs/agentic/handoff.md'],
    numstatRecords: [],
  });

  assert.equal(result.ok, true, result.errors.join('; '));
  assert.doesNotMatch(result.errors.join(' '), /closure_verify_surface_changed/);
  assert.doesNotMatch(result.errors.join(' '), /closure_missing_update_surface/);
});

test('worker-preflight: closure validation reports missing model preflight plan explicitly', async (t) => {
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));

  const result = await validateClosure(repo, {
    approvedPlan: buildPlan({
      touchpoints: ['src/allowed.js'],
      coupledSurfaces: [],
    }),
    outputPreflightPlan: null,
    changedFiles: [],
    numstatRecords: [],
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

  const result = await validateClosure(repo, {
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
  assert.equal(error.threadId, 'thread-1');
});
