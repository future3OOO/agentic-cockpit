import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import childProcess from 'node:child_process';

function runNode(scriptPath, args, { cwd }) {
  return new Promise((resolve) => {
    const proc = childProcess.spawn(process.execPath, [scriptPath, ...args], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d.toString('utf8')));
    proc.stderr.on('data', (d) => (stderr += d.toString('utf8')));
    proc.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

test('skillops debrief/distill/lint workflow works in a sandbox repo', async () => {
  const repoRoot = process.cwd();
  const scriptPath = path.join(repoRoot, 'scripts', 'skillops.mjs');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-cockpit-skillops-test-'));

  const skillDir = path.join(tmp, '.codex', 'skills', 'demo-skill');
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, 'SKILL.md'),
    [
      '---',
      'name: demo-skill',
      'description: "Demo skill for tests"',
      '---',
      '',
      '# Demo',
      '',
      '## Learned heuristics (SkillOps)',
      '<!-- SKILLOPS:LEARNED:BEGIN -->',
      '<!-- SKILLOPS:LEARNED:END -->',
      '',
    ].join('\n'),
    'utf8',
  );

  const debrief = await runNode(scriptPath, ['debrief', '--title', 'Test run', '--skills', 'demo-skill'], { cwd: tmp });
  assert.equal(debrief.code, 0, debrief.stderr);
  const createdRel = debrief.stdout.trim();
  assert.match(createdRel, /\.codex\/skill-ops\/logs\/\d{4}\/\d{2}\/.*\.md$/);
  const logPath = path.join(tmp, createdRel);
  let logContents = await fs.readFile(logPath, 'utf8');
  logContents = logContents.replace('  demo-skill: []', '  demo-skill:\n    - "Always capture root cause and exact fix path."');
  await fs.writeFile(logPath, logContents, 'utf8');

  const distill = await runNode(scriptPath, ['distill'], { cwd: tmp });
  assert.equal(distill.code, 0, distill.stderr);
  assert.match(distill.stdout, /Distilled learnings into 1 skill/);

  const lint = await runNode(scriptPath, ['lint'], { cwd: tmp });
  assert.equal(lint.code, 0, lint.stderr);

  const updatedSkill = await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf8');
  assert.match(updatedSkill, /Always capture root cause and exact fix path\./);
  const processedLog = await fs.readFile(logPath, 'utf8');
  assert.match(processedLog, /status:\s*processed/);
  assert.match(processedLog, /processed_at:\s*"/);
});

test('skillops debrief accepts repeated --skill-update values and preserves quoted text', async () => {
  const repoRoot = process.cwd();
  const scriptPath = path.join(repoRoot, 'scripts', 'skillops.mjs');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-cockpit-skillops-fastpath-'));

  const skillDir = path.join(tmp, '.codex', 'skills', 'demo-skill');
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, 'SKILL.md'),
    [
      '---',
      'name: demo-skill',
      'description: "Demo skill for tests"',
      '---',
      '',
      '# Demo',
      '',
      '## Learned heuristics (SkillOps)',
      '<!-- SKILLOPS:LEARNED:BEGIN -->',
      '<!-- SKILLOPS:LEARNED:END -->',
      '',
    ].join('\n'),
    'utf8',
  );

  const debrief = await runNode(
    scriptPath,
    [
      'debrief',
      '--title',
      'Fast path',
      '--skill-update',
      'demo-skill:Use "quoted" text safely in learned rules.',
      '--skill-update',
      'demo-skill:Keep rules on one line.',
    ],
    { cwd: tmp },
  );
  assert.equal(debrief.code, 0, debrief.stderr);

  const distill = await runNode(scriptPath, ['distill'], { cwd: tmp });
  assert.equal(distill.code, 0, distill.stderr);
  assert.match(distill.stdout, /Distilled learnings into 1 skill/);

  const updatedSkill = await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf8');
  assert.match(updatedSkill, /Use "quoted" text safely in learned rules\./);
  assert.match(updatedSkill, /Keep rules on one line\./);
});

test('skillops distill summarizes skipped empty logs instead of spamming', async () => {
  const repoRoot = process.cwd();
  const scriptPath = path.join(repoRoot, 'scripts', 'skillops.mjs');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-cockpit-skillops-warn-'));

  const skillDir = path.join(tmp, '.codex', 'skills', 'demo-skill');
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, 'SKILL.md'),
    [
      '---',
      'name: demo-skill',
      'description: "Demo skill for tests"',
      '---',
      '',
      '# Demo',
      '',
      '## Learned heuristics (SkillOps)',
      '<!-- SKILLOPS:LEARNED:BEGIN -->',
      '<!-- SKILLOPS:LEARNED:END -->',
      '',
    ].join('\n'),
    'utf8',
  );

  const debrief = await runNode(scriptPath, ['debrief', '--title', 'Empty log', '--skills', 'demo-skill'], { cwd: tmp });
  assert.equal(debrief.code, 0, debrief.stderr);

  const distill = await runNode(scriptPath, ['distill', '--dry-run'], { cwd: tmp });
  assert.equal(distill.code, 0, distill.stderr);
  assert.match(distill.stderr, /warn: skipped 1 log\(s\) with empty skill_updates/);
  assert.match(distill.stdout, /No new SkillOps learnings to distill\./);
});

test('skillops supports quoted skill_updates keys for non-simple skill names', async () => {
  const repoRoot = process.cwd();
  const scriptPath = path.join(repoRoot, 'scripts', 'skillops.mjs');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-cockpit-skillops-quoted-key-'));

  const skillDir = path.join(tmp, '.codex', 'skills', 'demo.skill');
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, 'SKILL.md'),
    [
      '---',
      'name: "demo.skill"',
      'description: "Demo skill for tests"',
      '---',
      '',
      '# Demo',
      '',
      '## Learned heuristics (SkillOps)',
      '<!-- SKILLOPS:LEARNED:BEGIN -->',
      '<!-- SKILLOPS:LEARNED:END -->',
      '',
    ].join('\n'),
    'utf8',
  );

  const debrief = await runNode(
    scriptPath,
    ['debrief', '--title', 'Quoted key', '--skill-update', 'demo.skill:Round-trip non-simple skill keys safely.'],
    { cwd: tmp },
  );
  assert.equal(debrief.code, 0, debrief.stderr);

  const distill = await runNode(scriptPath, ['distill'], { cwd: tmp });
  assert.equal(distill.code, 0, distill.stderr);

  const lint = await runNode(scriptPath, ['lint'], { cwd: tmp });
  assert.equal(lint.code, 0, lint.stderr);

  const updatedSkill = await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf8');
  assert.match(updatedSkill, /Round-trip non-simple skill keys safely\./);
});

test('skillops can mark empty and missing-update logs skipped to stop repeated warnings', async () => {
  const repoRoot = process.cwd();
  const scriptPath = path.join(repoRoot, 'scripts', 'skillops.mjs');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-cockpit-skillops-skip-empty-'));

  const skillDir = path.join(tmp, '.codex', 'skills', 'demo-skill');
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, 'SKILL.md'),
    [
      '---',
      'name: demo-skill',
      'description: "Demo skill for tests"',
      '---',
      '',
      '# Demo',
      '',
      '## Learned heuristics (SkillOps)',
      '<!-- SKILLOPS:LEARNED:BEGIN -->',
      '<!-- SKILLOPS:LEARNED:END -->',
      '',
    ].join('\n'),
    'utf8',
  );

  const debrief = await runNode(scriptPath, ['debrief', '--title', 'Empty log', '--skills', 'demo-skill'], { cwd: tmp });
  assert.equal(debrief.code, 0, debrief.stderr);
  const emptyLogPath = path.join(tmp, debrief.stdout.trim());

  const monthDir = path.join(tmp, '.codex', 'skill-ops', 'logs', '2026', '03');
  await fs.mkdir(monthDir, { recursive: true });
  const missingLogPath = path.join(monthDir, '20260309T000000Z__missing-skill-updates.md');
  await fs.writeFile(
    missingLogPath,
    [
      '---',
      'id: 20260309T000000Z__missing-skill-updates',
      'created_at: "2026-03-09T00:00:00Z"',
      'status: pending',
      'processed_at: null',
      'branch: ""',
      'head_sha: ""',
      'skills:',
      '  - demo-skill',
      'title: "Missing skill_updates"',
      '---',
      '',
    ].join('\n'),
    'utf8',
  );

  const distill = await runNode(scriptPath, ['distill', '--mark-empty-skipped'], { cwd: tmp });
  assert.equal(distill.code, 0, distill.stderr);
  assert.match(distill.stdout, /No new SkillOps learnings to distill; marked 2 log\(s\) skipped\./);

  const emptyLog = await fs.readFile(emptyLogPath, 'utf8');
  const missingLog = await fs.readFile(missingLogPath, 'utf8');
  assert.match(emptyLog, /status:\s*skipped/);
  assert.match(emptyLog, /processed_at:\s*"/);
  assert.match(missingLog, /status:\s*skipped/);
  assert.match(missingLog, /processed_at:\s*"/);
});
