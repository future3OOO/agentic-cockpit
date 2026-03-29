import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import childProcess from 'node:child_process';
import {
  evaluateModularityPolicy,
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
