import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import childProcess from 'node:child_process';

function run(args, { cwd } = {}) {
  const res = childProcess.spawnSync(process.execPath, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (res.status !== 0) {
    throw new Error(`command failed (${res.status}): ${process.execPath} ${args.join(' ')}\n${res.stderr || res.stdout}`);
  }
  return { stdout: res.stdout, stderr: res.stderr };
}

async function exists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

test('init-project bootstraps blueprint, runbooks, and cockpit skills', async () => {
  const repoRoot = process.cwd();
  const scriptPath = path.join(repoRoot, 'scripts', 'init-project.mjs');

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-init-project-'));
  const projectRoot = path.join(tmp, 'project');
  await fs.mkdir(projectRoot, { recursive: true });

  run([scriptPath, '--project', projectRoot], { cwd: repoRoot });

  assert.equal(await exists(path.join(projectRoot, 'docs', 'agentic', 'agent-bus', 'ROSTER.json')), true);
  assert.equal(await exists(path.join(projectRoot, 'docs', 'agentic', 'BLUEPRINT.md')), true);
  assert.equal(await exists(path.join(projectRoot, 'docs', 'runbooks', 'PR_REVIEW_LOOP.md')), true);
  assert.equal(await exists(path.join(projectRoot, '.codex', 'skills', 'cockpit-autopilot', 'SKILL.md')), true);
  assert.equal(
    await exists(path.join(projectRoot, '.codex', 'skills', 'cockpit-pr-review-closure-gate', 'SKILL.md')),
    true,
  );
});

test('init-project --skip-runbooks leaves docs/runbooks uncreated', async () => {
  const repoRoot = process.cwd();
  const scriptPath = path.join(repoRoot, 'scripts', 'init-project.mjs');

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-init-project-norunbooks-'));
  const projectRoot = path.join(tmp, 'project');
  await fs.mkdir(projectRoot, { recursive: true });

  run([scriptPath, '--project', projectRoot, '--skip-runbooks'], { cwd: repoRoot });

  assert.equal(await exists(path.join(projectRoot, 'docs', 'agentic', 'BLUEPRINT.md')), true);
  assert.equal(await exists(path.join(projectRoot, 'docs', 'runbooks')), false);
});
