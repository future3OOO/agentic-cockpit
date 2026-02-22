import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import childProcess from 'node:child_process';

function spawn(cmd, args, { cwd }) {
  return new Promise((resolve) => {
    const proc = childProcess.spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
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
