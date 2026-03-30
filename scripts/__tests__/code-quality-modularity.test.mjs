import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import childProcess from 'node:child_process';
import {
  buildModularityGateChecks,
  countPhysicalLines,
  evaluateModularityPolicy,
  matchRepoPathRule,
  readNumstatForBaseRef,
} from '../lib/code-quality-modularity.mjs';

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
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-modularity-'));
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.name', 'Test Bot']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  await fs.writeFile(path.join(repo, 'README.md'), '# test\n', 'utf8');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-m', 'init']);
  return repo;
}

test('modularity: new non-test source file over 300 lines fails', async (t) => {
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));

  await fs.mkdir(path.join(repo, 'src'), { recursive: true });
  await fs.writeFile(path.join(repo, 'src', 'huge.js'), repeatLines('huge', 301), 'utf8');

  const result = await evaluateModularityPolicy({
    repoRoot: repo,
    changedFiles: ['src/huge.js'],
    numstatRecords: readNumstatForBaseRef(repo),
    baseRef: '',
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /exceeds 300 physical lines/i);
});

test('modularity: exact 300-line new non-test source file passes', async (t) => {
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));

  await fs.mkdir(path.join(repo, 'src'), { recursive: true });
  await fs.writeFile(path.join(repo, 'src', 'borderline.js'), repeatLines('borderline', 300), 'utf8');

  const result = await evaluateModularityPolicy({
    repoRoot: repo,
    changedFiles: ['src/borderline.js'],
    numstatRecords: readNumstatForBaseRef(repo),
    baseRef: '',
  });

  assert.equal(result.ok, true, result.errors.join('; '));
});

test('modularity: touched no-growth file over 500 lines must end smaller than baseline', async (t) => {
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));

  await fs.mkdir(path.join(repo, 'src'), { recursive: true });
  await fs.writeFile(path.join(repo, 'src', 'large.js'), repeatLines('large', 501), 'utf8');
  git(repo, ['add', 'src/large.js']);
  git(repo, ['commit', '-m', 'add large source']);

  await fs.writeFile(path.join(repo, 'src', 'large.js'), repeatLines('large', 502), 'utf8');

  const result = await evaluateModularityPolicy({
    repoRoot: repo,
    changedFiles: ['src/large.js'],
    numstatRecords: readNumstatForBaseRef(repo),
    baseRef: '',
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /must end smaller than baseline/i);
});

test('modularity: exact 500-line baseline is not forced into no-growth mode', async (t) => {
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));

  await fs.mkdir(path.join(repo, 'src'), { recursive: true });
  await fs.writeFile(path.join(repo, 'src', 'borderline.js'), repeatLines('borderline', 500), 'utf8');
  git(repo, ['add', 'src/borderline.js']);
  git(repo, ['commit', '-m', 'add borderline source']);

  await fs.writeFile(path.join(repo, 'src', 'borderline.js'), repeatLines('borderline', 501), 'utf8');

  const result = await evaluateModularityPolicy({
    repoRoot: repo,
    changedFiles: ['src/borderline.js'],
    numstatRecords: readNumstatForBaseRef(repo),
    baseRef: '',
  });

  assert.equal(result.ok, true, result.errors.join('; '));
});

test('modularity: net growth over 120 without paired shrink in same parent directory fails', async (t) => {
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));

  await fs.mkdir(path.join(repo, 'src'), { recursive: true });
  await fs.writeFile(path.join(repo, 'src', 'growing.js'), repeatLines('grow', 20), 'utf8');
  git(repo, ['add', 'src/growing.js']);
  git(repo, ['commit', '-m', 'add growing source']);

  await fs.writeFile(path.join(repo, 'src', 'growing.js'), repeatLines('grow', 170), 'utf8');

  const result = await evaluateModularityPolicy({
    repoRoot: repo,
    changedFiles: ['src/growing.js'],
    numstatRecords: readNumstatForBaseRef(repo),
    baseRef: '',
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /without paired shrink in src/i);
});

test('modularity: exact 120 net growth passes without paired shrink', async (t) => {
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));

  await fs.mkdir(path.join(repo, 'src'), { recursive: true });
  await fs.writeFile(path.join(repo, 'src', 'growing.js'), repeatLines('grow', 20), 'utf8');
  git(repo, ['add', 'src/growing.js']);
  git(repo, ['commit', '-m', 'add growing source']);

  await fs.writeFile(path.join(repo, 'src', 'growing.js'), repeatLines('grow', 140), 'utf8');

  const result = await evaluateModularityPolicy({
    repoRoot: repo,
    changedFiles: ['src/growing.js'],
    numstatRecords: readNumstatForBaseRef(repo),
    baseRef: '',
  });

  assert.equal(result.ok, true, result.errors.join('; '));
});

test('modularity: paired shrink in exact same parent directory allows a legitimate extraction refactor', async (t) => {
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));

  await fs.mkdir(path.join(repo, 'src'), { recursive: true });
  await fs.writeFile(path.join(repo, 'src', 'growing.js'), repeatLines('grow', 20), 'utf8');
  await fs.writeFile(path.join(repo, 'src', 'old.js'), repeatLines('old', 220), 'utf8');
  git(repo, ['add', 'src/growing.js', 'src/old.js']);
  git(repo, ['commit', '-m', 'add paired refactor sources']);

  await fs.writeFile(path.join(repo, 'src', 'growing.js'), repeatLines('grow', 170), 'utf8');
  await fs.writeFile(path.join(repo, 'src', 'old.js'), repeatLines('old', 40), 'utf8');

  const result = await evaluateModularityPolicy({
    repoRoot: repo,
    changedFiles: ['src/growing.js', 'src/old.js'],
    numstatRecords: readNumstatForBaseRef(repo),
    baseRef: '',
  });

  assert.equal(result.ok, true, result.errors.join('; '));
});

test('modularity: shrink credit is consumed across multiple growing files in the same parent directory', async (t) => {
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));

  await fs.mkdir(path.join(repo, 'src'), { recursive: true });
  await fs.writeFile(path.join(repo, 'src', 'grow-a.js'), repeatLines('growa', 20), 'utf8');
  await fs.writeFile(path.join(repo, 'src', 'grow-b.js'), repeatLines('growb', 20), 'utf8');
  await fs.writeFile(path.join(repo, 'src', 'old.js'), repeatLines('old', 220), 'utf8');
  git(repo, ['add', 'src/grow-a.js', 'src/grow-b.js', 'src/old.js']);
  git(repo, ['commit', '-m', 'add modularity fixtures']);

  await fs.writeFile(path.join(repo, 'src', 'grow-a.js'), repeatLines('growa', 150), 'utf8');
  await fs.writeFile(path.join(repo, 'src', 'grow-b.js'), repeatLines('growb', 150), 'utf8');
  await fs.writeFile(path.join(repo, 'src', 'old.js'), repeatLines('old', 60), 'utf8');

  const result = await evaluateModularityPolicy({
    repoRoot: repo,
    changedFiles: ['src/grow-a.js', 'src/grow-b.js', 'src/old.js'],
    numstatRecords: readNumstatForBaseRef(repo),
    baseRef: '',
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /without paired shrink in src/i);
});

test('modularity: protected host growth without scripts/lib extraction fails', async (t) => {
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));

  await fs.mkdir(path.join(repo, 'scripts'), { recursive: true });
  await fs.writeFile(
    path.join(repo, 'scripts', 'agent-codex-worker.mjs'),
    ['export function run(){', '  return 1;', '}', ''].join('\n'),
    'utf8',
  );
  git(repo, ['add', 'scripts/agent-codex-worker.mjs']);
  git(repo, ['commit', '-m', 'add protected host']);

  await fs.writeFile(
    path.join(repo, 'scripts', 'agent-codex-worker.mjs'),
    [
      'export function run(){',
      '  return 1;',
      '}',
      '',
      'export function extra(){',
      '  return 2;',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );

  const result = await evaluateModularityPolicy({
    repoRoot: repo,
    changedFiles: ['scripts/agent-codex-worker.mjs'],
    numstatRecords: readNumstatForBaseRef(repo),
    baseRef: '',
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /requires a paired module extraction under scripts\/lib\//i);
});

test('modularity: audited standalone waiver suppresses modularity-policy blocking while preserving evidence', async (t) => {
  const repo = await createRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));

  await fs.mkdir(path.join(repo, 'src'), { recursive: true });
  await fs.writeFile(path.join(repo, 'src', 'huge.js'), repeatLines('huge', 301), 'utf8');

  const result = await buildModularityGateChecks({
    repoRoot: repo,
    changedFiles: ['src/huge.js'],
    numstatRecords: readNumstatForBaseRef(repo),
    baseRef: '',
    gateContractChanged: false,
    rawDiff: '',
    changedFileContents: new Map([['src/huge.js', repeatLines('huge', 301)]]),
    diffTouchesPatterns: () => false,
    listMissingCoupledPaths: () => [],
    waivedChecks: new Set(['modularity-policy']),
    resolvedException: {
      id: 'pr51-skillops-portable-v4-baseline',
      decisionRef: 'DECISIONS.md#2026-03-31--audited-branch-diff-exception-for-pr51-skillops-portable-v4-baseline',
    },
  });

  assert.equal(result.errors.length, 0);
  const check = result.checks.find((entry) => entry.name === 'modularity-policy');
  assert.ok(check);
  assert.equal(check.passed, false);
  assert.equal(check.blocking, false);
  assert.equal(check.waived, true);
  assert.equal(check.waivedBy, 'pr51-skillops-portable-v4-baseline');
  assert.match(String(check.decisionRef || ''), /pr51-skillops-portable-v4-baseline/i);
});

test('modularity: countPhysicalLines ignores newline-only terminator inflation', () => {
  assert.equal(countPhysicalLines(''), 0);
  assert.equal(countPhysicalLines('one'), 1);
  assert.equal(countPhysicalLines('one\n'), 1);
  assert.equal(countPhysicalLines('one\r\ntwo\r\n'), 2);
});

test('modularity: repo path rules treat **/ as zero-or-more directories', () => {
  assert.equal(matchRepoPathRule('docs/agentic/runtime-note.md', 'docs/agentic/**/*.md'), true);
  assert.equal(matchRepoPathRule('docs/agentic/nested/runtime-note.md', 'docs/agentic/**/*.md'), true);
  assert.equal(matchRepoPathRule('docs/runtime-note.md', 'docs/agentic/**/*.md'), false);
});
