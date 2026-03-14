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

async function createDemoSkillRepo(prefix) {
  const repoRoot = process.cwd();
  const scriptPath = path.join(repoRoot, 'scripts', 'skillops.mjs');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
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
  return { tmp, scriptPath, skillFile: path.join(skillDir, 'SKILL.md') };
}

async function createLog(repoRoot, relPath, lines) {
  const absPath = path.join(repoRoot, relPath);
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, lines.join('\n'), 'utf8');
  return absPath;
}

test('skillops capabilities reports the v2 non-durable contract', async () => {
  const { tmp, scriptPath } = await createDemoSkillRepo('agentic-cockpit-skillops-capabilities-');
  const res = await runNode(scriptPath, ['capabilities', '--json'], { cwd: tmp });
  assert.equal(res.code, 0, res.stderr);
  const parsed = JSON.parse(res.stdout.trim());
  assert.equal(parsed.skillopsContractVersion, 2);
  assert.equal(parsed.distillMode, 'non_durable');
  assert.ok(parsed.commands.includes('plan-promotions'));
  assert.ok(parsed.commands.includes('apply-promotions'));
  assert.ok(parsed.commands.includes('mark-promoted'));
  assert.deepEqual(parsed.statuses, ['pending', 'queued', 'processed', 'skipped']);
});

test('skillops plan-promotions and apply-promotions use the raw external plan contract', async () => {
  const { tmp, scriptPath, skillFile } = await createDemoSkillRepo('agentic-cockpit-skillops-plan-apply-');
  const debrief = await runNode(
    scriptPath,
    ['debrief', '--title', 'Promotion source', '--skill-update', 'demo-skill:Always capture exact runtime guard evidence.'],
    { cwd: tmp },
  );
  assert.equal(debrief.code, 0, debrief.stderr);

  const qualityDir = path.join(tmp, '.codex', 'quality', 'logs');
  await fs.mkdir(qualityDir, { recursive: true });
  await fs.writeFile(path.join(qualityDir, 'ignored.md'), '# local quality evidence\n', 'utf8');

  const planRes = await runNode(scriptPath, ['plan-promotions', '--json'], { cwd: tmp });
  assert.equal(planRes.code, 0, planRes.stderr);
  const plan = JSON.parse(planRes.stdout.trim());
  assert.equal(plan.promotableLogIds.length, 1);
  assert.equal(plan.emptyLogIds.length, 0);
  assert.deepEqual(plan.durableTargets, ['.codex/skills/demo-skill/SKILL.md']);
  assert.ok(Array.isArray(plan.updatesBySkill['demo-skill']));
  assert.equal(plan.updatesBySkill['demo-skill'][0].text, 'Always capture exact runtime guard evidence.');

  const planPath = path.join(os.tmpdir(), `skillops-plan-${Date.now()}.json`);
  await fs.writeFile(planPath, JSON.stringify(plan, null, 2) + '\n', 'utf8');

  const applyRes = await runNode(scriptPath, ['apply-promotions', '--plan', planPath], { cwd: tmp });
  assert.equal(applyRes.code, 0, applyRes.stderr);
  assert.match(applyRes.stdout, /Applied SkillOps promotions to 1 skill file/);

  const skillContents = await fs.readFile(skillFile, 'utf8');
  assert.match(skillContents, /Always capture exact runtime guard evidence\./);

  const lintRes = await runNode(scriptPath, ['lint'], { cwd: tmp });
  assert.equal(lintRes.code, 0, lintRes.stderr);
  await fs.rm(planPath, { force: true });
});

test('skillops mark-promoted supports queued then processed with external raw plan paths', async () => {
  const { tmp, scriptPath } = await createDemoSkillRepo('agentic-cockpit-skillops-mark-promoted-');
  const debrief = await runNode(
    scriptPath,
    ['debrief', '--title', 'Queued promotion', '--skill-update', 'demo-skill:Queue durable learnings before closing the root.'],
    { cwd: tmp },
  );
  assert.equal(debrief.code, 0, debrief.stderr);
  const logPath = path.join(tmp, debrief.stdout.trim());

  const planRes = await runNode(scriptPath, ['plan-promotions', '--json'], { cwd: tmp });
  assert.equal(planRes.code, 0, planRes.stderr);
  const planPath = path.join(os.tmpdir(), `skillops-mark-${Date.now()}.json`);
  await fs.writeFile(planPath, planRes.stdout, 'utf8');

  const queueRes = await runNode(
    scriptPath,
    ['mark-promoted', '--plan', planPath, '--status', 'queued', '--promotion-task-id', 'skillops_promotion__autopilot__root1'],
    { cwd: tmp },
  );
  assert.equal(queueRes.code, 0, queueRes.stderr);
  const queuedLog = await fs.readFile(logPath, 'utf8');
  assert.match(queuedLog, /status:\s*queued/);
  assert.match(queuedLog, /queued_at:\s*"/);
  assert.match(queuedLog, /promotion_task_id:\s*"skillops_promotion__autopilot__root1"/);

  const lintQueued = await runNode(scriptPath, ['lint'], { cwd: tmp });
  assert.equal(lintQueued.code, 0, lintQueued.stderr);

  const processedRes = await runNode(scriptPath, ['mark-promoted', '--plan', planPath, '--status', 'processed'], { cwd: tmp });
  assert.equal(processedRes.code, 0, processedRes.stderr);
  const processedLog = await fs.readFile(logPath, 'utf8');
  assert.match(processedLog, /status:\s*processed/);
  assert.match(processedLog, /processed_at:\s*"/);
  assert.match(processedLog, /queued_at:\s*null/);
  assert.match(processedLog, /promotion_task_id:\s*null/);

  const lintProcessed = await runNode(scriptPath, ['lint'], { cwd: tmp });
  assert.equal(lintProcessed.code, 0, lintProcessed.stderr);
  await fs.rm(planPath, { force: true });
});

test('skillops distill is non-durable and can retire empty logs locally', async () => {
  const { tmp, scriptPath, skillFile } = await createDemoSkillRepo('agentic-cockpit-skillops-distill-');
  const emptyLogPath = await createLog(tmp, '.codex/skill-ops/logs/2026/03/empty.md', [
    '---',
    'id: empty-log',
    'created_at: "2026-03-10T00:00:00Z"',
    'status: pending',
    'processed_at: null',
    'queued_at: null',
    'promotion_task_id: null',
    'skills:',
    '  - demo-skill',
    'skill_updates:',
    '  demo-skill: []',
    'title: "Empty log"',
    '---',
    '',
  ]);

  const res = await runNode(scriptPath, ['distill', '--mark-empty-skipped'], { cwd: tmp });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /No new SkillOps learnings to distill; marked 1 log\(s\) skipped\./);

  const skillContents = await fs.readFile(skillFile, 'utf8');
  assert.doesNotMatch(skillContents, /Empty log/);
  const logContents = await fs.readFile(emptyLogPath, 'utf8');
  assert.match(logContents, /status:\s*skipped/);
  assert.match(logContents, /processed_at:\s*"/);
});

test('skillops treats legacy new as pending on read and writes back normalized statuses only', async () => {
  const { tmp, scriptPath } = await createDemoSkillRepo('agentic-cockpit-skillops-legacy-new-');
  const legacyLogPath = await createLog(tmp, '.codex/skill-ops/logs/2026/03/legacy.md', [
    '---',
    'id: legacy-log',
    'created_at: "2026-03-10T00:00:00Z"',
    'status: new',
    'processed_at: null',
    'skills:',
    '  - demo-skill',
    'skill_updates: {}',
    'title: "Legacy new log"',
    '---',
    '',
  ]);

  const planRes = await runNode(scriptPath, ['plan-promotions', '--json'], { cwd: tmp });
  assert.equal(planRes.code, 0, planRes.stderr);
  const plan = JSON.parse(planRes.stdout.trim());
  assert.deepEqual(plan.emptyLogIds, ['legacy-log']);
  assert.equal(plan.promotableLogIds.length, 0);

  const planPath = path.join(os.tmpdir(), `skillops-legacy-${Date.now()}.json`);
  await fs.writeFile(planPath, planRes.stdout, 'utf8');
  const skipRes = await runNode(scriptPath, ['mark-promoted', '--plan', planPath, '--status', 'skipped'], { cwd: tmp });
  assert.equal(skipRes.code, 0, skipRes.stderr);

  const updated = await fs.readFile(legacyLogPath, 'utf8');
  assert.match(updated, /status:\s*skipped/);
  assert.doesNotMatch(updated, /status:\s*new/);

  const lintRes = await runNode(scriptPath, ['lint'], { cwd: tmp });
  assert.equal(lintRes.code, 0, lintRes.stderr);
  await fs.rm(planPath, { force: true });
});
