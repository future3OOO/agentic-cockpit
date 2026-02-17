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
