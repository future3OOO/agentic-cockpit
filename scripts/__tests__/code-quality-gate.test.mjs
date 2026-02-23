import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import childProcess from 'node:child_process';

function spawn(cmd, args, { cwd, env = process.env }) {
  return new Promise((resolve) => {
    const proc = childProcess.spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d.toString('utf8')));
    proc.stderr.on('data', (d) => (stderr += d.toString('utf8')));
    proc.on('exit', (code) => resolve({ code: Number(code || 0), stdout, stderr }));
  });
}

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

async function createRepo() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-code-quality-gate-'));
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.name', 'Test Bot']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  await fs.writeFile(path.join(dir, 'README.md'), '# test\n', 'utf8');
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '-m', 'init']);
  return dir;
}

function parseLastJson(stdout) {
  const lines = String(stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

test('code-quality-gate ignores root __tests__ path from escape scan', async (t) => {
  const repo = await createRepo();
  t.after(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  await fs.mkdir(path.join(repo, '__tests__'), { recursive: true });
  await fs.writeFile(path.join(repo, '__tests__', 'helper.js'), '// TODO: fixture marker\n', 'utf8');

  const script = path.join(process.cwd(), 'scripts', 'code-quality-gate.mjs');
  const run = await spawn('node', [script, 'check', '--task-kind', 'USER_REQUEST'], { cwd: repo });
  assert.equal(run.code, 0, run.stderr || run.stdout);
  const payload = parseLastJson(run.stdout);
  assert.equal(payload.ok, true);
});

test('code-quality-gate ignores .codex/quality/logs path from escape scan', async (t) => {
  const repo = await createRepo();
  t.after(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  await fs.mkdir(path.join(repo, '.codex', 'quality', 'logs'), { recursive: true });
  await fs.writeFile(
    path.join(repo, '.codex', 'quality', 'logs', 'scan-sample.txt'),
    '// eslint-disable-next-line no-console\nconsole.log("sample")\n',
    'utf8',
  );

  const script = path.join(process.cwd(), 'scripts', 'code-quality-gate.mjs');
  const run = await spawn('node', [script, 'check', '--task-kind', 'USER_REQUEST'], { cwd: repo });
  assert.equal(run.code, 0, run.stderr || run.stdout);
  const payload = parseLastJson(run.stdout);
  assert.equal(payload.ok, true);
});

test('code-quality-gate fails when runtime script changes without tests', async (t) => {
  const repo = await createRepo();
  t.after(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  await fs.mkdir(path.join(repo, 'scripts'), { recursive: true });
  await fs.writeFile(path.join(repo, 'scripts', 'worker.mjs'), 'export function run(){return 1}\n', 'utf8');

  const script = path.join(process.cwd(), 'scripts', 'code-quality-gate.mjs');
  const run = await spawn('node', [script, 'check', '--task-kind', 'EXECUTE'], { cwd: repo });
  assert.equal(run.code, 2, run.stderr || run.stdout);
  const payload = parseLastJson(run.stdout);
  assert.equal(payload.ok, false);
  assert.match(String(payload.errors.join(' ')), /runtime script changes require matching scripts\/__tests__/i);
});

test('code-quality-gate passes when runtime script changes include tests', async (t) => {
  const repo = await createRepo();
  t.after(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  await fs.mkdir(path.join(repo, 'scripts', '__tests__'), { recursive: true });
  await fs.writeFile(path.join(repo, 'scripts', 'worker.mjs'), 'export function run(){return 1}\n', 'utf8');
  await fs.writeFile(
    path.join(repo, 'scripts', '__tests__', 'worker.test.mjs'),
    'import test from "node:test";\n',
    'utf8',
  );

  const script = path.join(process.cwd(), 'scripts', 'code-quality-gate.mjs');
  const run = await spawn('node', [script, 'check', '--task-kind', 'EXECUTE'], { cwd: repo });
  assert.equal(run.code, 0, run.stderr || run.stdout);
  const payload = parseLastJson(run.stdout);
  assert.equal(payload.ok, true);
});

test('code-quality-gate flags empty catch blocks as fake-green escapes', async (t) => {
  const repo = await createRepo();
  t.after(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  await fs.mkdir(path.join(repo, 'scripts', '__tests__'), { recursive: true });
  await fs.writeFile(
    path.join(repo, 'scripts', 'cleanup.mjs'),
    'export function f(){ try { return 1 } catch (err) {} }\n',
    'utf8',
  );
  await fs.writeFile(path.join(repo, 'scripts', '__tests__', 'cleanup.test.mjs'), 'import test from "node:test";\n', 'utf8');

  const script = path.join(process.cwd(), 'scripts', 'code-quality-gate.mjs');
  const run = await spawn('node', [script, 'check', '--task-kind', 'EXECUTE'], { cwd: repo });
  assert.equal(run.code, 2, run.stderr || run.stdout);
  const payload = parseLastJson(run.stdout);
  assert.equal(payload.ok, false);
  assert.match(String(payload.errors.join(' ')), /quality escapes detected/i);
});

test('code-quality-gate flags multi-line empty catch blocks as fake-green escapes', async (t) => {
  const repo = await createRepo();
  t.after(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  await fs.mkdir(path.join(repo, 'src'), { recursive: true });
  await fs.writeFile(
    path.join(repo, 'src', 'cleanup.js'),
    'export function f(){\n  try { return 1 }\n  catch (err) {\n  }\n}\n',
    'utf8',
  );

  const script = path.join(process.cwd(), 'scripts', 'code-quality-gate.mjs');
  const run = await spawn('node', [script, 'check', '--task-kind', 'USER_REQUEST'], { cwd: repo });
  assert.equal(run.code, 2, run.stderr || run.stdout);
  const payload = parseLastJson(run.stdout);
  assert.equal(payload.ok, false);
  assert.match(String(payload.errors.join(' ')), /quality escapes detected/i);
});

test('code-quality-gate blocks newly added multi-line empty catch blocks in tracked files', async (t) => {
  const repo = await createRepo();
  t.after(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  await fs.mkdir(path.join(repo, 'src'), { recursive: true });
  await fs.writeFile(path.join(repo, 'src', 'tracked.js'), 'export const marker = 1;\n', 'utf8');
  git(repo, ['add', 'src/tracked.js']);
  git(repo, ['commit', '-m', 'add tracked file']);

  await fs.writeFile(
    path.join(repo, 'src', 'tracked.js'),
    [
      'export function tracked(){',
      '  try {',
      '    return 1;',
      '  } catch (err) {',
      '  }',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );

  const script = path.join(process.cwd(), 'scripts', 'code-quality-gate.mjs');
  const run = await spawn('node', [script, 'check', '--task-kind', 'USER_REQUEST'], { cwd: repo });
  assert.equal(run.code, 2, run.stderr || run.stdout);
  const payload = parseLastJson(run.stdout);
  assert.equal(payload.ok, false);
  assert.match(String(payload.errors.join(' ')), /quality escapes detected/i);
});

test('code-quality-gate reports empty catches in each untracked file', async (t) => {
  const repo = await createRepo();
  t.after(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  await fs.mkdir(path.join(repo, 'src'), { recursive: true });
  await fs.writeFile(path.join(repo, 'src', 'first.js'), 'export function a(){ try { return 1 } catch (err) {} }\n', 'utf8');
  await fs.writeFile(path.join(repo, 'src', 'second.js'), 'export function b(){ try { return 2 } catch (err) {} }\n', 'utf8');

  const script = path.join(process.cwd(), 'scripts', 'code-quality-gate.mjs');
  const run = await spawn('node', [script, 'check', '--task-kind', 'USER_REQUEST'], { cwd: repo });
  assert.equal(run.code, 2, run.stderr || run.stdout);
  const payload = parseLastJson(run.stdout);
  assert.equal(payload.ok, false);
  const noEscapesCheck = (payload.checks || []).find((entry) => entry.name === 'no-quality-escapes');
  assert.equal(Boolean(noEscapesCheck), true);
  const samplePaths = Array.isArray(noEscapesCheck.samplePaths) ? noEscapesCheck.samplePaths : [];
  assert.equal(samplePaths.some((entry) => String(entry).startsWith('src/first.js:')), true);
  assert.equal(samplePaths.some((entry) => String(entry).startsWith('src/second.js:')), true);
});

test('code-quality-gate emits hardRules summary for minimal evidence', async (t) => {
  const repo = await createRepo();
  t.after(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  await fs.mkdir(path.join(repo, 'src'), { recursive: true });
  await fs.writeFile(path.join(repo, 'src', 'ok.js'), 'export const ok = 1;\n', 'utf8');

  const script = path.join(process.cwd(), 'scripts', 'code-quality-gate.mjs');
  const run = await spawn('node', [script, 'check', '--task-kind', 'USER_REQUEST'], { cwd: repo });
  assert.equal(run.code, 0, run.stderr || run.stdout);
  const payload = parseLastJson(run.stdout);
  assert.equal(payload.ok, true);
  assert.equal(typeof payload.hardRules, 'object');
  assert.equal(payload.hardRules.codeVolume.passed, true);
  assert.equal(payload.hardRules.noDuplication.passed, true);
  assert.equal(payload.hardRules.shortestPath.passed, true);
  assert.equal(payload.hardRules.cleanup.passed, true);
  assert.equal(payload.hardRules.anticipateConsequences.passed, true);
  assert.equal(payload.hardRules.simplicity.passed, true);
});

test('code-quality-gate scans only added lines for tracked files', async (t) => {
  const repo = await createRepo();
  t.after(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  await fs.mkdir(path.join(repo, 'src'), { recursive: true });
  await fs.writeFile(
    path.join(repo, 'src', 'legacy.js'),
    'export function legacy(){ try { return 1 } catch (err) {} }\n',
    'utf8',
  );
  git(repo, ['add', 'src/legacy.js']);
  git(repo, ['commit', '-m', 'add legacy file']);

  await fs.writeFile(
    path.join(repo, 'src', 'legacy.js'),
    'export function legacy(){ try { return 1 } catch (err) {} }\nexport const marker = 1;\n',
    'utf8',
  );

  const script = path.join(process.cwd(), 'scripts', 'code-quality-gate.mjs');
  const run = await spawn('node', [script, 'check', '--task-kind', 'USER_REQUEST'], { cwd: repo });
  assert.equal(run.code, 0, run.stderr || run.stdout);
  const payload = parseLastJson(run.stdout);
  assert.equal(payload.ok, true);
  assert.ok(Array.isArray(payload.warnings));
  assert.match(String(payload.warnings.join(' ')), /legacy quality debt/i);
  const legacyCheck = (payload.checks || []).find((entry) => entry.name === 'legacy-quality-debt-advisory');
  assert.equal(Boolean(legacyCheck), true);
  assert.equal(legacyCheck.passed, false);
  assert.equal(legacyCheck.blocking, false);
});

test('code-quality-gate uses commit-range scope when --base-ref is provided', async (t) => {
  const repo = await createRepo();
  t.after(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  await fs.mkdir(path.join(repo, 'src'), { recursive: true });
  await fs.writeFile(path.join(repo, 'src', 'base.js'), 'export const base = 1;\n', 'utf8');
  git(repo, ['add', 'src/base.js']);
  git(repo, ['commit', '-m', 'add base file']);

  const bigAdded = Array.from({ length: 360 }, (_, i) => `export const x${i} = ${i};`).join('\n') + '\n';
  await fs.writeFile(path.join(repo, 'src', 'big.js'), bigAdded, 'utf8');
  git(repo, ['add', 'src/big.js']);
  git(repo, ['commit', '-m', 'add big file']);

  const script = path.join(process.cwd(), 'scripts', 'code-quality-gate.mjs');
  const run = await spawn(
    'node',
    [script, 'check', '--task-kind', 'USER_REQUEST', '--base-ref', 'HEAD~1'],
    { cwd: repo },
  );
  assert.equal(run.code, 2, run.stderr || run.stdout);
  const payload = parseLastJson(run.stdout);
  assert.equal(payload.ok, false);
  assert.match(String(payload.changedScope || ''), /^commit-range:/);
  assert.match(String(payload.errors.join(' ')), /diff volume suggests additive bloat/i);
});

test('code-quality-gate blocks temporary artifact paths', async (t) => {
  const repo = await createRepo();
  t.after(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  await fs.mkdir(path.join(repo, 'tmp'), { recursive: true });
  await fs.writeFile(path.join(repo, 'tmp', 'debug.txt'), 'temporary output\n', 'utf8');

  const script = path.join(process.cwd(), 'scripts', 'code-quality-gate.mjs');
  const run = await spawn('node', [script, 'check', '--task-kind', 'EXECUTE'], { cwd: repo });
  assert.notEqual(run.code, 0, run.stderr || run.stdout);
  const payload = parseLastJson(run.stdout);
  assert.equal(payload.ok, false);
  assert.match(String((payload.errors || []).join(' ')), /temporary artifact paths detected/i);
});

test('code-quality-gate ignores deleted temporary artifact paths', async (t) => {
  const repo = await createRepo();
  t.after(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  await fs.mkdir(path.join(repo, 'tmp'), { recursive: true });
  await fs.writeFile(path.join(repo, 'tmp', 'scratch.log'), 'will be deleted\n', 'utf8');
  git(repo, ['add', 'tmp/scratch.log']);
  git(repo, ['commit', '-m', 'add temp artifact for delete test']);
  await fs.rm(path.join(repo, 'tmp', 'scratch.log'));

  const script = path.join(process.cwd(), 'scripts', 'code-quality-gate.mjs');
  const run = await spawn('node', [script, 'check', '--task-kind', 'EXECUTE'], { cwd: repo });
  assert.equal(run.code, 0, run.stderr || run.stdout);
  const payload = parseLastJson(run.stdout);
  assert.equal(payload.ok, true);
});

test('code-quality-gate blocks SKILL changes when no validator scripts are available', async (t) => {
  const repo = await createRepo();
  t.after(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  const skillPath = path.join(repo, '.codex', 'skills', 'demo-skill', 'SKILL.md');
  await fs.mkdir(path.dirname(skillPath), { recursive: true });
  await fs.writeFile(
    skillPath,
    ['---', 'name: demo-skill', 'description: "demo"', '---', '', '# Demo skill', ''].join('\n'),
    'utf8',
  );

  const script = path.join(process.cwd(), 'scripts', 'code-quality-gate.mjs');
  const run = await spawn('node', [script, 'check', '--task-kind', 'USER_REQUEST'], {
    cwd: repo,
    env: { ...process.env, COCKPIT_ROOT: '' },
  });
  assert.notEqual(run.code, 0, run.stderr || run.stdout);
  const payload = parseLastJson(run.stdout);
  assert.equal(payload.ok, false);
  assert.match(
    String((payload.errors || []).join(' ')),
    /no skill validators available/i,
  );
});

test('code-quality-gate uses cockpit validator scripts when COCKPIT_ROOT is set', async (t) => {
  const repo = await createRepo();
  t.after(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  const skillPath = path.join(repo, '.codex', 'skills', 'demo-skill', 'SKILL.md');
  await fs.mkdir(path.dirname(skillPath), { recursive: true });
  await fs.writeFile(
    skillPath,
    ['---', 'name: demo-skill', 'description: "demo"', '---', '', '# Demo skill', ''].join('\n'),
    'utf8',
  );

  const script = path.join(process.cwd(), 'scripts', 'code-quality-gate.mjs');
  const run = await spawn('node', [script, 'check', '--task-kind', 'USER_REQUEST'], {
    cwd: repo,
    env: { ...process.env, COCKPIT_ROOT: process.cwd() },
  });
  assert.equal(run.code, 0, run.stderr || run.stdout);
  const payload = parseLastJson(run.stdout);
  assert.equal(payload.ok, true);
});
