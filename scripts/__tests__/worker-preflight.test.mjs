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
import {
  validatePreflightExecutionUnlock,
  validatePreflightClosure,
  captureTrackedSnapshot,
} from '../lib/worker-preflight-runtime.mjs';
import { readNumstatForBaseRef } from '../lib/code-quality-modularity.mjs';

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
