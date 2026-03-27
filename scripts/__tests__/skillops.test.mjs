import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import childProcess from 'node:child_process';

const TEMP_DIRS = new Set();

function trackTempDir(dir) {
  if (dir) TEMP_DIRS.add(dir);
  return dir;
}

test.after(async () => {
  await Promise.all(Array.from(TEMP_DIRS, (dir) => fs.rm(dir, { recursive: true, force: true })));
  TEMP_DIRS.clear();
});

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
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function createTempPlanPath(prefix) {
  const dir = trackTempDir(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  return path.join(dir, 'plan.json');
}

async function cleanupTempPlanPath(planPath) {
  await fs.rm(path.dirname(planPath), { recursive: true, force: true });
}

async function createDemoSkillRepo(prefix) {
  const repoRoot = process.cwd();
  const scriptPath = path.join(repoRoot, 'scripts', 'skillops.mjs');
  const tmp = trackTempDir(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
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
      '1. Policy',
      `   <!-- SKILLOPS:SECTION:demo-rules:BEGIN -->`,
      `   <!-- SKILLOPS:SECTION:demo-rules:END -->`,
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

async function createExtraSkill(repoRoot, skillName) {
  const skillDir = path.join(repoRoot, '.codex', 'skills', skillName);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, 'SKILL.md'),
    [
      '---',
      `name: ${skillName}`,
      'description: "Secondary skill"',
      '---',
      '',
      '# Secondary',
      '',
      `<!-- SKILLOPS:SECTION:demo-rules:BEGIN -->`,
      `<!-- SKILLOPS:SECTION:demo-rules:END -->`,
      '',
      '## Learned heuristics (SkillOps)',
      '<!-- SKILLOPS:LEARNED:BEGIN -->',
      '<!-- SKILLOPS:LEARNED:END -->',
      '',
    ].join('\n'),
    'utf8',
  );
  return path.join(skillDir, 'SKILL.md');
}

async function createLog(repoRoot, relPath, lines) {
  const absPath = path.join(repoRoot, relPath);
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, lines.join('\n'), 'utf8');
  return absPath;
}

function buildPlanFixture({
  version = 2,
  schemaVersion = 3,
  sourceLogs = [
    {
      id: 'log-1',
      relativePath: '.codex/skill-ops/logs/2026/03/log-1.md',
      status: 'pending',
      createdAt: '2026-03-15T00:00:00Z',
    },
  ],
  targets = [{ kind: 'skill', path: '.codex/skills/demo-skill/SKILL.md' }],
  items = [
    {
      promotionMode: 'learned_block',
      skill: 'demo-skill',
      targetFile: '.codex/skills/demo-skill/SKILL.md',
      additions: [{ text: 'Reference fixture rule.', logId: 'log-1', createdAt: '2026-03-15T00:00:00Z' }],
      overflowBullets: [],
      nextContents: '# placeholder',
    },
  ],
  skippableLogIds = [],
}) {
  return {
    kind: 'skillops-promotion-plan',
    version,
    schemaVersion,
    generatedAt: '2026-03-15T00:00:00Z',
    sourceRepoRoot: '/tmp/repo',
    maxLearned: 30,
    summary: {
      pendingLogsCount: sourceLogs.length,
      promotableLogsCount: sourceLogs.length,
      missingSkillUpdatesCount: 0,
      emptySkillUpdatesCount: skippableLogIds.length,
      skillsToUpdate: items.length,
      additionsCount: items.reduce((sum, item) => sum + (Array.isArray(item.additions) ? item.additions.length : 0), 0),
    },
    sourceLogs,
    targets,
    items,
    skippableLogIds,
  };
}

test('skillops capabilities reports the portable v4 contract', async () => {
  const { tmp, scriptPath } = await createDemoSkillRepo('agentic-cockpit-skillops-capabilities-');
  const res = await runNode(scriptPath, ['capabilities', '--json'], { cwd: tmp });
  assert.equal(res.code, 0, res.stderr);
  const parsed = JSON.parse(res.stdout.trim());
  assert.equal(parsed.kind, 'skillops-capabilities');
  assert.equal(parsed.version, 4);
  assert.equal(parsed.skillopsContractVersion, 4);
  assert.equal(parsed.schemaVersion, 3);
  assert.equal(parsed.distillMode, 'non_durable');
  assert.deepEqual(parsed.statuses, ['pending', 'queued', 'processed', 'skipped']);
  assert.deepEqual(Object.keys(parsed.commands).sort(), [
    'apply-promotions',
    'capabilities',
    'debrief',
    'distill',
    'lint',
    'log',
    'mark-promoted',
    'payload-files',
    'plan-promotions',
  ]);
  assert.equal(parsed.plan.kind, 'skillops-promotion-plan');
  assert.equal(parsed.plan.schemaVersion, 3);
  assert.equal(parsed.plan.version, 2);
  assert.deepEqual(parsed.plan.durableTargetKinds, ['skill', 'archive']);
  assert.deepEqual(parsed.plan.markStatuses, ['queued', 'processed', 'skipped']);
  assert.deepEqual(parsed.plan.promotionModes, ['learned_block', 'canonical_section']);
  assert.deepEqual(parsed.plan.logMetadataKeys, ['promotion_mode', 'target_file', 'target_section']);
  assert.equal(parsed.plan.canonicalSectionMarkerPrefix, 'SKILLOPS:SECTION:');
  assert.equal(parsed.commands.distill.writes, 'non_durable_local');
  assert.deepEqual(parsed.commands.distill.optionalFlags, ['--dry-run', '--mark-empty-skipped', '--max-learned']);
  assert.deepEqual(parsed.commands['plan-promotions'].optionalFlags, ['--max-learned']);
  assert.equal(parsed.commands['apply-promotions'].json, true);
  assert.deepEqual(parsed.commands['apply-promotions'].optionalFlags, ['--json']);
});

test('skillops plan-promotions, payload-files, and apply-promotions use the portable v4 plan', async () => {
  const { tmp, scriptPath, skillFile } = await createDemoSkillRepo('agentic-cockpit-skillops-plan-apply-');
  const debrief = await runNode(
    scriptPath,
    ['debrief', '--title', 'Promotion source', '--skill-update', 'demo-skill:Always capture exact runtime guard evidence.'],
    { cwd: tmp },
  );
  assert.equal(debrief.code, 0, debrief.stderr);

  const planRes = await runNode(scriptPath, ['plan-promotions', '--json'], { cwd: tmp });
  assert.equal(planRes.code, 0, planRes.stderr);
  const plan = JSON.parse(planRes.stdout.trim());
  assert.equal(plan.version, 2);
  assert.equal(plan.schemaVersion, 3);
  assert.equal(plan.sourceLogs.length, 1);
  assert.equal(plan.sourceLogs[0].id.length > 0, true);
  assert.deepEqual(plan.targets, [{ kind: 'skill', path: '.codex/skills/demo-skill/SKILL.md' }]);
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].promotionMode, 'learned_block');
  assert.equal(plan.items[0].targetFile, '.codex/skills/demo-skill/SKILL.md');
  assert.equal(plan.items[0].additions[0].text, 'Always capture exact runtime guard evidence.');
  assert.deepEqual(plan.skippableLogIds, []);

  const planPath = await createTempPlanPath('skillops-plan-');
  try {
    await fs.writeFile(planPath, JSON.stringify(plan, null, 2) + '\n', 'utf8');

    const payloadRes = await runNode(scriptPath, ['payload-files', '--plan', planPath, '--json'], { cwd: tmp });
    assert.equal(payloadRes.code, 0, payloadRes.stderr);
    assert.deepEqual(JSON.parse(payloadRes.stdout.trim()).payloadFiles, ['.codex/skills/demo-skill/SKILL.md']);

    const applyRes = await runNode(scriptPath, ['apply-promotions', '--plan', planPath, '--json'], { cwd: tmp });
    assert.equal(applyRes.code, 0, applyRes.stderr);
    const applied = JSON.parse(applyRes.stdout.trim());
    assert.equal(applied.skillsApplied, 1);
    assert.deepEqual(applied.payloadFiles, ['.codex/skills/demo-skill/SKILL.md']);

    const skillContents = await fs.readFile(skillFile, 'utf8');
    assert.match(skillContents, /Always capture exact runtime guard evidence\./);
  } finally {
    await cleanupTempPlanPath(planPath);
  }
});

test('skillops mark-promoted supports queued then processed with v4 sourceLogs', async () => {
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
  const planPath = await createTempPlanPath('skillops-mark-');
  try {
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

    const processedRes = await runNode(scriptPath, ['mark-promoted', '--plan', planPath, '--status', 'processed'], { cwd: tmp });
    assert.equal(processedRes.code, 0, processedRes.stderr);
    const processedLog = await fs.readFile(logPath, 'utf8');
    assert.match(processedLog, /status:\s*processed/);
    assert.match(processedLog, /processed_at:\s*"/);
    assert.match(processedLog, /queued_at:\s*null/);
    assert.match(processedLog, /promotion_task_id:\s*null/);
  } finally {
    await cleanupTempPlanPath(planPath);
  }
});

test('skillops distill can retire skippable logs locally without durable promotion work', async () => {
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
});

test('skillops distill can locally apply pending learnings while source logs stay pending for runtime handoff', async () => {
  const { tmp, scriptPath, skillFile } = await createDemoSkillRepo('agentic-cockpit-skillops-distill-local-');
  const logPath = await createLog(tmp, '.codex/skill-ops/logs/2026/03/local-apply.md', [
    '---',
    'id: local-apply-log',
    'created_at: "2026-03-10T00:00:00Z"',
    'status: pending',
    'processed_at: null',
    'queued_at: null',
    'promotion_task_id: null',
    'skills:',
    '  - demo-skill',
    'skill_updates:',
    '  demo-skill:',
    '    - "Apply local checkout edits without claiming durable promotion."',
    'title: "Local distill apply"',
    '---',
    '',
  ]);

  const res = await runNode(scriptPath, ['distill'], { cwd: tmp });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /locally updated 1 skill file\(s\) in this checkout/);
  assert.match(res.stdout, /source logs stay pending until runtime handoff succeeds/);

  const skillContents = await fs.readFile(skillFile, 'utf8');
  assert.match(skillContents, /Apply local checkout edits without claiming durable promotion\./);
  const logContents = await fs.readFile(logPath, 'utf8');
  assert.match(logContents, /status:\s*pending/);
});

test('skillops fails closed on content-bearing pending logs without promotable skill_updates', async () => {
  const { tmp, scriptPath } = await createDemoSkillRepo('agentic-cockpit-skillops-content-bearing-');
  await createLog(tmp, '.codex/skill-ops/logs/2026/03/contentful.md', [
    '---',
    'id: contentful-log',
    'created_at: "2026-03-10T00:00:00Z"',
    'status: pending',
    'processed_at: null',
    'queued_at: null',
    'promotion_task_id: null',
    'skills:',
    '  - demo-skill',
    'skill_updates:',
    '  demo-skill: []',
    'title: "Content-bearing log"',
    '---',
    '',
    '# Summary',
    '- What changed: Runtime promotion handoff drifted on retry.',
    '- Why: Operator note worth review even without distilled heuristics.',
    '',
  ]);

  const planRes = await runNode(scriptPath, ['plan-promotions', '--json'], { cwd: tmp });
  assert.equal(planRes.code, 1);
  assert.match(planRes.stderr, /meaningful body but no promotable skill_updates/);
});

test('skillops treats legacy new as pending and exposes skippableLogIds', async () => {
  const { tmp, scriptPath } = await createDemoSkillRepo('agentic-cockpit-skillops-legacy-new-');
  const legacyLogPath = await createLog(tmp, '.codex/skill-ops/logs/2026/03/legacy.md', [
    '---',
    'id: legacy-log',
    'created_at: "2026-03-10T00:00:00Z"',
    'status: new',
    'processed_at: null',
    'queued_at: null',
    'promotion_task_id: null',
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
  assert.deepEqual(plan.skippableLogIds, ['legacy-log']);
  assert.equal(plan.sourceLogs.length, 0);

  const planPath = await createTempPlanPath('skillops-legacy-');
  try {
    await fs.writeFile(planPath, planRes.stdout, 'utf8');
    const skipRes = await runNode(scriptPath, ['mark-promoted', '--plan', planPath, '--status', 'skipped'], { cwd: tmp });
    assert.equal(skipRes.code, 0, skipRes.stderr);

    const updated = await fs.readFile(legacyLogPath, 'utf8');
  assert.match(updated, /status:\s*skipped/);
  assert.doesNotMatch(updated, /status:\s*new/);
  } finally {
    await cleanupTempPlanPath(planPath);
  }
});

test('skillops plan-promotions normalizes legacy new to pending in sourceLogs', async () => {
  const { tmp, scriptPath } = await createDemoSkillRepo('agentic-cockpit-skillops-legacy-source-status-');
  await createLog(tmp, '.codex/skill-ops/logs/2026/03/legacy-promotable.md', [
    '---',
    'id: legacy-promotable-log',
    'created_at: "2026-03-10T00:00:00Z"',
    'status: new',
    'processed_at: null',
    'queued_at: null',
    'promotion_task_id: null',
    'skills:',
    '  - demo-skill',
    'skill_updates:',
    '  demo-skill:',
    '    - "Normalize legacy pending status in portable plans."',
    'title: "Legacy promotable log"',
    '---',
    '',
  ]);

  const planRes = await runNode(scriptPath, ['plan-promotions', '--json'], { cwd: tmp });
  assert.equal(planRes.code, 0, planRes.stderr);
  const plan = JSON.parse(planRes.stdout.trim());
  assert.equal(plan.sourceLogs.length, 1);
  assert.equal(plan.sourceLogs[0].id, 'legacy-promotable-log');
  assert.equal(plan.sourceLogs[0].status, 'pending');
});

test('skillops canonical_section preserves nested indentation and supports payload-files', async () => {
  const { tmp, scriptPath, skillFile } = await createDemoSkillRepo('agentic-cockpit-skillops-canonical-');
  await createLog(tmp, '.codex/skill-ops/logs/2026/03/canonical.md', [
    '---',
    'id: canonical-log',
    'created_at: "2026-03-11T00:00:00Z"',
    'status: pending',
    'processed_at: null',
    'queued_at: null',
    'promotion_task_id: null',
    'promotion_mode: canonical_section',
    'target_file: ".codex/skills/demo-skill/SKILL.md"',
    'target_section: "demo-rules"',
    'skills:',
    '  - demo-skill',
    'skill_updates:',
    '  demo-skill:',
    '    - "Preserve nested marker indentation when prepending rules."',
    'title: "Canonical section log"',
    '---',
    '',
  ]);

  const planRes = await runNode(scriptPath, ['plan-promotions', '--json'], { cwd: tmp });
  assert.equal(planRes.code, 0, planRes.stderr);
  const plan = JSON.parse(planRes.stdout.trim());
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].promotionMode, 'canonical_section');
  assert.equal(plan.items[0].targetSection, 'demo-rules');
  assert.deepEqual(plan.targets, [{ kind: 'skill', path: '.codex/skills/demo-skill/SKILL.md' }]);

  const planPath = await createTempPlanPath('skillops-canonical-');
  try {
    await fs.writeFile(planPath, planRes.stdout, 'utf8');
    const applyRes = await runNode(scriptPath, ['apply-promotions', '--plan', planPath], { cwd: tmp });
    assert.equal(applyRes.code, 0, applyRes.stderr);

    const payloadRes = await runNode(scriptPath, ['payload-files', '--plan', planPath, '--json'], { cwd: tmp });
    assert.equal(payloadRes.code, 0, payloadRes.stderr);
    assert.deepEqual(JSON.parse(payloadRes.stdout.trim()).payloadFiles, ['.codex/skills/demo-skill/SKILL.md']);

    const updatedSkill = await fs.readFile(skillFile, 'utf8');
    assert.match(updatedSkill, /1\. Policy\n   <!-- SKILLOPS:SECTION:demo-rules:BEGIN -->\n   - Preserve nested marker indentation when prepending rules\. \[src:canonical-log\]/);
    assert.match(updatedSkill, /<!-- SKILLOPS:SECTION:demo-rules:END -->/);
  } finally {
    await cleanupTempPlanPath(planPath);
  }
});

test('skillops rejects canonical logs whose skill key disagrees with target_file', async () => {
  const { tmp, scriptPath } = await createDemoSkillRepo('agentic-cockpit-skillops-canonical-mismatch-');
  await createExtraSkill(tmp, 'other-skill');
  await createLog(tmp, '.codex/skill-ops/logs/2026/03/canonical-mismatch.md', [
    '---',
    'id: canonical-mismatch',
    'created_at: "2026-03-11T00:00:00Z"',
    'status: pending',
    'processed_at: null',
    'queued_at: null',
    'promotion_task_id: null',
    'promotion_mode: canonical_section',
    'target_file: ".codex/skills/other-skill/SKILL.md"',
    'target_section: "demo-rules"',
    'skills:',
    '  - demo-skill',
    'skill_updates:',
    '  demo-skill:',
    '    - "Reject copied target mismatches."',
    'title: "Canonical mismatch"',
    '---',
    '',
  ]);

  const planRes = await runNode(scriptPath, ['plan-promotions', '--json'], { cwd: tmp });
  assert.equal(planRes.code, 1);
  assert.match(planRes.stderr, /must match the lone skill_updates key 'demo-skill'/);
});

test('skillops apply-promotions rejects old flat plans and forged source log ids', async () => {
  const { tmp, scriptPath, skillFile } = await createDemoSkillRepo('agentic-cockpit-skillops-invalid-plan-');
  const planPath = await createTempPlanPath('skillops-invalid-plan-');
  try {
    await fs.writeFile(
      planPath,
      JSON.stringify(
        buildPlanFixture({
          sourceLogs: [
            {
              id: 'log-1',
              relativePath: '.codex/skill-ops/logs/2026/03/log-1.md',
              status: 'pending',
              createdAt: '2026-03-15T00:00:00Z',
            },
          ],
          items: [
            {
              promotionMode: 'learned_block',
              skill: 'demo-skill',
              targetFile: '.codex/skills/demo-skill/SKILL.md',
              additions: [{ text: 'Reject forged provenance.', logId: 'forged-log', createdAt: '2026-03-15T00:00:00Z' }],
              overflowBullets: [],
              nextContents: '# placeholder',
            },
          ],
        }),
        null,
        2,
      ) + '\n',
      'utf8',
    );

    const applyRes = await runNode(scriptPath, ['apply-promotions', '--plan', planPath], { cwd: tmp });
    assert.equal(applyRes.code, 1);
    assert.match(applyRes.stderr, /references unknown source log id forged-log/);
    const skillContents = await fs.readFile(skillFile, 'utf8');
    assert.doesNotMatch(skillContents, /Reject forged provenance/);

    await fs.writeFile(
      planPath,
      JSON.stringify(
        buildPlanFixture({
          targets: [
            { kind: 'skill', path: '.codex/skills/demo-skill/SKILL.md' },
            { kind: 'archive', path: '.codex/skill-ops/archive/demo-skill.md' },
          ],
        }),
        null,
        2,
      ) + '\n',
      'utf8',
    );
    const unusedTargetRes = await runNode(scriptPath, ['apply-promotions', '--plan', planPath], { cwd: tmp });
    assert.equal(unusedTargetRes.code, 1);
    assert.match(unusedTargetRes.stderr, /target is not referenced by any item: \.codex\/skill-ops\/archive\/demo-skill\.md/);

    await fs.writeFile(
      planPath,
      JSON.stringify(
        {
          kind: 'skillops-promotion-plan',
          version: 1,
          schemaVersion: 2,
          sourceLogs: [],
          targets: [],
          items: [],
        },
        null,
        2,
      ) + '\n',
      'utf8',
    );
    const oldPlanRes = await runNode(scriptPath, ['apply-promotions', '--plan', planPath], { cwd: tmp });
    assert.equal(oldPlanRes.code, 1);
    assert.match(oldPlanRes.stderr, /Invalid SkillOps plan version 1/);
  } finally {
    await cleanupTempPlanPath(planPath);
  }
});

test('skillops rejects traversal segments in portable plan paths', async () => {
  const { tmp, scriptPath } = await createDemoSkillRepo('agentic-cockpit-skillops-traversal-');
  const planPath = await createTempPlanPath('skillops-traversal-');
  try {
    await fs.writeFile(
      planPath,
      JSON.stringify(
        buildPlanFixture({
          sourceLogs: [
            {
              id: 'log-1',
              relativePath: '.codex/skill-ops/logs/2026/03/../../evil.md',
              status: 'pending',
              createdAt: '2026-03-15T00:00:00Z',
            },
          ],
        }),
        null,
        2,
      ) + '\n',
      'utf8',
    );

    const applyRes = await runNode(scriptPath, ['apply-promotions', '--plan', planPath], { cwd: tmp });
    assert.equal(applyRes.code, 1);
    assert.match(applyRes.stderr, /path traversal is not allowed/);
  } finally {
    await cleanupTempPlanPath(planPath);
  }
});
