import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import childProcess from 'node:child_process';

function spawn(cmd, args, { cwd, env = process.env }) {
  const res = childProcess.spawnSync(cmd, args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const code = res.status != null ? Number(res.status) : res.signal ? 128 : 1;
  const stderr =
    String(res.stderr || '') +
    (res.signal ? `${res.stderr ? '\n' : ''}killed by ${res.signal}` : '');
  return Promise.resolve({
    code,
    stdout: String(res.stdout || ''),
    stderr,
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

async function writeExceptionRegistry(repo, exceptions) {
  const registryPath = path.join(repo, 'docs', 'agentic', 'CODE_QUALITY_EXCEPTIONS.json');
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  await fs.writeFile(
    registryPath,
    JSON.stringify({ version: 1, exceptions }, null, 2) + '\n',
    'utf8',
  );
}

async function writeRepoFile(repo, relPath, contents) {
  const absPath = path.join(repo, relPath);
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, contents, 'utf8');
}

function buildProtectedHostBaseline(prefix) {
  return Array.from({ length: 14 }, (_, index) => `export const ${prefix}${index} = ${index};`).join('\n') + '\n';
}

async function commitProtectedHostBaseline(repo, relPath, prefix) {
  await writeRepoFile(repo, relPath, buildProtectedHostBaseline(prefix));
  git(repo, ['add', relPath]);
  git(repo, ['commit', '-m', `seed ${path.basename(relPath)}`]);
}

async function addScriptsLibExtraction(repo, relPath = 'scripts/lib/extracted.mjs') {
  await writeRepoFile(repo, relPath, 'export const extracted = 1;\n');
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

test('code-quality-gate passes when internal gate helpers change and include the gate test', async (t) => {
  const repo = await createRepo();
  t.after(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  await writeRepoFile(repo, 'scripts/lib/code-quality-gate-helper.mjs', 'export function gateHelper(){ return 1; }\n');
  await writeRepoFile(repo, 'scripts/__tests__/code-quality-gate.test.mjs', 'import test from "node:test";\n');

  const script = path.join(process.cwd(), 'scripts', 'code-quality-gate.mjs');
  const run = await spawn('node', [script, 'check', '--task-kind', 'USER_REQUEST'], { cwd: repo });
  assert.equal(run.code, 0, run.stderr || run.stdout);
  const payload = parseLastJson(run.stdout);
  assert.equal(payload.ok, true);
  assert.equal(
    Boolean(
      (payload.checks || []).find((check) => check.name === 'code-quality-gate-contract-change-has-runtime-reference'),
    ),
    false,
  );
});

test('code-quality-gate fails when gate contract changes without runtime reference and decisions', async (t) => {
  const repo = await createRepo();
  t.after(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  await commitProtectedHostBaseline(repo, 'scripts/code-quality-gate.mjs', 'gate');
  await writeRepoFile(
    repo,
    'scripts/code-quality-gate.mjs',
    [
      "const missingCoupledPaths = listMissingCoupledPaths(changedFileContents, ['docs/runbooks/POLICY.md']);",
      'checks.push({',
      "  name: 'gate-contract-change',",
      '  passed: missingCoupledPaths.length === 0,',
      "  details: missingCoupledPaths.length ? `missing coupled updates: ${missingCoupledPaths.join(', ')}` : 'ok',",
      '});',
      'const codeQualityPolicyChanged = gateContractChanged;',
      '',
    ].join('\n'),
  );
  await addScriptsLibExtraction(repo);
  await writeRepoFile(repo, 'scripts/__tests__/code-quality-gate.test.mjs', 'import test from "node:test";\n');

  const script = path.join(process.cwd(), 'scripts', 'code-quality-gate.mjs');
  const run = await spawn('node', [script, 'check', '--task-kind', 'USER_REQUEST'], { cwd: repo });
  assert.equal(run.code, 2, run.stderr || run.stdout);
  const payload = parseLastJson(run.stdout);
  assert.equal(payload.ok, false);
  assert.match(
    String((payload.errors || []).join(' ')),
    /scripts\/code-quality-gate\.mjs contract or policy changes require docs\/agentic\/RUNTIME_FUNCTION_REFERENCE\.md/i,
  );
  assert.equal(payload.hardRules.anticipateConsequences.passed, false);
});

test('code-quality-gate passes when gate contract changes with all coupled docs present', async (t) => {
  const repo = await createRepo();
  t.after(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  await commitProtectedHostBaseline(repo, 'scripts/code-quality-gate.mjs', 'gate');
  await writeRepoFile(
    repo,
    'scripts/code-quality-gate.mjs',
    [
      "const missingCoupledPaths = listMissingCoupledPaths(changedFileContents, ['docs/runbooks/POLICY.md']);",
      'checks.push({',
      "  name: 'gate-contract-change',",
      '  passed: missingCoupledPaths.length === 0,',
      "  details: missingCoupledPaths.length ? `missing coupled updates: ${missingCoupledPaths.join(', ')}` : 'ok',",
      '});',
      'const codeQualityPolicyChanged = gateContractChanged;',
      '',
    ].join('\n'),
  );
  await addScriptsLibExtraction(repo);
  await writeRepoFile(repo, 'scripts/__tests__/code-quality-gate.test.mjs', 'import test from "node:test";\n');
  await writeRepoFile(repo, 'docs/agentic/RUNTIME_FUNCTION_REFERENCE.md', '# runtime ref\n');
  await writeRepoFile(repo, 'DECISIONS.md', '# decisions\n');
  await writeRepoFile(repo, 'docs/agentic/DECISIONS_AND_INCIDENTS_TIMELINE.md', '# timeline\n');

  const script = path.join(process.cwd(), 'scripts', 'code-quality-gate.mjs');
  const run = await spawn('node', [script, 'check', '--task-kind', 'USER_REQUEST'], { cwd: repo });
  assert.equal(run.code, 0, run.stderr || run.stdout);
  const payload = parseLastJson(run.stdout);
  assert.equal(payload.ok, true);
  assert.equal(
    (payload.checks || []).find((check) => check.name === 'code-quality-gate-contract-change-has-runtime-reference')
      ?.passed,
    true,
  );
  assert.equal(payload.hardRules.anticipateConsequences.passed, true);
});

test('code-quality-gate treats plain policy-branch edits as contract changes', async (t) => {
  const repo = await createRepo();
  t.after(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  await commitProtectedHostBaseline(repo, 'scripts/code-quality-gate.mjs', 'gate');
  await writeRepoFile(
    repo,
    'scripts/code-quality-gate.mjs',
    [
      'function listMissingCoupledPaths(changedFileContents, requiredPaths) {',
      '  return requiredPaths.filter((relPath) => !changedFileContents.has(relPath));',
      '}',
      'async function resolveCodeQualityException() {}',
      'async function check() {',
      "  const gateScriptChanged = changedFiles.includes('scripts/code-quality-gate.mjs');",
      '  const gateContractChanged = gateScriptChanged;',
      '  if (gateContractChanged) {',
      "    const missingCoupledPaths = listMissingCoupledPaths(changedFileContents, ['docs/agentic/RUNTIME_FUNCTION_REFERENCE.md']);",
      '    checks.push({',
      "      name: 'code-quality-gate-contract-change-has-runtime-reference',",
      '      passed: missingCoupledPaths.length === 0,',
      "      details: missingCoupledPaths.length ? `missing coupled updates: ${missingCoupledPaths.join(', ')}` : 'ok',",
      '    });',
      "    if (missingCoupledPaths.length) errors.push('runtime reference updates are mandatory for gate policy edits');",
      '  }',
      '  const codeQualityPolicyChanged = gateContractChanged;',
      '  if (codeQualityPolicyChanged) {',
      "    const missingPolicyPaths = listMissingCoupledPaths(changedFileContents, ['DECISIONS.md', 'docs/agentic/DECISIONS_AND_INCIDENTS_TIMELINE.md']);",
      "    if (missingPolicyPaths.length) errors.push('code quality policy changes require DECISIONS.md and DECISIONS_AND_INCIDENTS_TIMELINE.md updates');",
      '  }',
      '  // Anti-bloat volume check.',
      '}',
      '',
    ].join('\n'),
  );
  await addScriptsLibExtraction(repo);
  await writeRepoFile(repo, 'scripts/__tests__/code-quality-gate.test.mjs', 'import test from "node:test";\n');

  const script = path.join(process.cwd(), 'scripts', 'code-quality-gate.mjs');
  const run = await spawn('node', [script, 'check', '--task-kind', 'USER_REQUEST'], { cwd: repo });
  assert.equal(run.code, 2, run.stderr || run.stdout);
  const payload = parseLastJson(run.stdout);
  assert.equal(payload.ok, false);
  assert.match(
    String((payload.errors || []).join(' ')),
    /scripts\/code-quality-gate\.mjs contract or policy changes require docs\/agentic\/RUNTIME_FUNCTION_REFERENCE\.md/i,
  );
});

test('code-quality-gate treats new coupling checks as policy changes even when the check name is new', async (t) => {
  const repo = await createRepo();
  t.after(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  await writeRepoFile(repo, 'scripts/code-quality-gate.mjs', 'export function gate(){ return 1; }\n');
  git(repo, ['add', 'scripts/code-quality-gate.mjs']);
  git(repo, ['commit', '-m', 'add gate script']);
  await writeRepoFile(
    repo,
    'scripts/code-quality-gate.mjs',
    [
      "const missingFuturePaths = listMissingCoupledPaths(changedFileContents, ['docs/runbooks/FUTURE_POLICY.md']);",
      'checks.push({',
      "  name: 'future-coupling-check',",
      '  passed: missingFuturePaths.length === 0,',
      "  details: missingFuturePaths.length ? `missing coupled updates: ${missingFuturePaths.join(', ')}` : 'ok',",
      '});',
      'const codeQualityPolicyChanged = gateContractChanged || workerQualityPathChanged;',
      '',
    ].join('\n'),
  );
  await writeRepoFile(repo, 'scripts/__tests__/code-quality-gate.test.mjs', 'import test from "node:test";\n');

  const script = path.join(process.cwd(), 'scripts', 'code-quality-gate.mjs');
  const run = await spawn('node', [script, 'check', '--task-kind', 'USER_REQUEST'], { cwd: repo });
  assert.equal(run.code, 2, run.stderr || run.stdout);
  const payload = parseLastJson(run.stdout);
  assert.equal(payload.ok, false);
  assert.match(
    String((payload.errors || []).join(' ')),
    /scripts\/code-quality-gate\.mjs contract or policy changes require docs\/agentic\/RUNTIME_FUNCTION_REFERENCE\.md/i,
  );
  assert.match(
    String((payload.errors || []).join(' ')),
    /code quality policy changes require DECISIONS\.md and DECISIONS_AND_INCIDENTS_TIMELINE\.md updates/i,
  );
});

test('code-quality-gate fails when cockpit code-quality skill changes without matching skill/test coupling', async (t) => {
  const repo = await createRepo();
  t.after(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  await writeRepoFile(
    repo,
    '.codex/skills/cockpit-code-quality-gate/SKILL.md',
    [
      '---',
      'name: cockpit-code-quality-gate',
      'description: "demo"',
      'version: 1.0.0',
      'tags:',
      '  - cockpit',
      '---',
      '',
      '# Demo skill',
      '',
    ].join('\n'),
  );
  await writeRepoFile(repo, 'DECISIONS.md', '# decisions\n');
  await writeRepoFile(repo, 'docs/agentic/DECISIONS_AND_INCIDENTS_TIMELINE.md', '# timeline\n');

  const script = path.join(process.cwd(), 'scripts', 'code-quality-gate.mjs');
  const run = await spawn('node', [script, 'check', '--task-kind', 'USER_REQUEST'], {
    cwd: repo,
    env: { ...process.env, COCKPIT_ROOT: process.cwd() },
  });
  assert.equal(run.code, 2, run.stderr || run.stdout);
  const payload = parseLastJson(run.stdout);
  assert.equal(payload.ok, false);
  assert.match(
    String((payload.errors || []).join(' ')),
    /closure-only quality-gate change requires matching skill\/test updates/i,
  );
});

test('code-quality-gate fails when worker quality path changes without coupled app-server test and runtime reference updates', async (t) => {
  const repo = await createRepo();
  t.after(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  await writeRepoFile(repo, 'scripts/agent-codex-worker.mjs', 'export function worker(){ return 1; }\n');
  git(repo, ['add', 'scripts/agent-codex-worker.mjs']);
  git(repo, ['commit', '-m', 'add worker file']);
  await writeRepoFile(
    repo,
    'scripts/agent-codex-worker.mjs',
    'function validateCodeQualityReviewEvidence(){ return "qualityReview.summary is required"; }\n',
  );
  await writeRepoFile(repo, 'scripts/__tests__/worker.test.mjs', 'import test from "node:test";\n');
  await writeRepoFile(repo, 'DECISIONS.md', '# decisions\n');
  await writeRepoFile(repo, 'docs/agentic/DECISIONS_AND_INCIDENTS_TIMELINE.md', '# timeline\n');

  const script = path.join(process.cwd(), 'scripts', 'code-quality-gate.mjs');
  const run = await spawn('node', [script, 'check', '--task-kind', 'USER_REQUEST'], { cwd: repo });
  assert.equal(run.code, 2, run.stderr || run.stdout);
  const payload = parseLastJson(run.stdout);
  assert.equal(payload.ok, false);
  assert.match(
    String((payload.errors || []).join(' ')),
    /agent-codex-worker\.mjs code-quality prompt\/validation changes require app-server tests and runtime reference updates/i,
  );
  assert.equal(payload.hardRules.anticipateConsequences.passed, false);
});

test('code-quality-gate treats plain prompt-step edits inside worker quality section as coupled changes', async (t) => {
  const repo = await createRepo();
  t.after(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  await writeRepoFile(
    repo,
    'scripts/agent-codex-worker.mjs',
    [
      'function buildCodeQualityGatePromptBlock() {',
      "  return 'Before returning outcome=\"done\"\\n1. reuse: keep it tight';",
      '}',
      'function buildObserverDrainGatePromptBlock() {',
      "  return '';",
      '}',
      '',
    ].join('\n'),
  );
  git(repo, ['add', 'scripts/agent-codex-worker.mjs']);
  git(repo, ['commit', '-m', 'add worker file']);
  await writeRepoFile(
    repo,
    'scripts/agent-codex-worker.mjs',
    [
      'function buildCodeQualityGatePromptBlock() {',
      "  return 'Before returning outcome=\"done\"\\n1. reuse path: keep it tight';",
      '}',
      'function buildObserverDrainGatePromptBlock() {',
      "  return '';",
      '}',
      '',
    ].join('\n'),
  );
  await writeRepoFile(repo, 'scripts/__tests__/worker.test.mjs', 'import test from "node:test";\n');
  await writeRepoFile(repo, 'DECISIONS.md', '# decisions\n');
  await writeRepoFile(repo, 'docs/agentic/DECISIONS_AND_INCIDENTS_TIMELINE.md', '# timeline\n');

  const script = path.join(process.cwd(), 'scripts', 'code-quality-gate.mjs');
  const run = await spawn('node', [script, 'check', '--task-kind', 'USER_REQUEST'], { cwd: repo });
  assert.equal(run.code, 2, run.stderr || run.stdout);
  const payload = parseLastJson(run.stdout);
  assert.equal(payload.ok, false);
  assert.match(
    String((payload.errors || []).join(' ')),
    /agent-codex-worker\.mjs code-quality prompt\/validation changes require app-server tests and runtime reference updates/i,
  );
});

test('code-quality-gate ignores unrelated worker changes outside the code-quality prompt and validation path', async (t) => {
  const repo = await createRepo();
  t.after(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  await commitProtectedHostBaseline(repo, 'scripts/agent-codex-worker.mjs', 'worker');
  await writeRepoFile(
    repo,
    'scripts/agent-codex-worker.mjs',
    'export function worker(){ const note = "qualityReview metadata"; return note; }\n',
  );
  await addScriptsLibExtraction(repo);
  await writeRepoFile(repo, 'scripts/__tests__/worker.test.mjs', 'import test from "node:test";\n');

  const script = path.join(process.cwd(), 'scripts', 'code-quality-gate.mjs');
  const run = await spawn('node', [script, 'check', '--task-kind', 'USER_REQUEST'], { cwd: repo });
  assert.equal(run.code, 0, run.stderr || run.stdout);
  const payload = parseLastJson(run.stdout);
  assert.equal(payload.ok, true);
  assert.equal(
    Boolean((payload.checks || []).find((check) => check.name === 'worker-code-quality-path-change-is-coupled')),
    false,
  );
});

test('code-quality-gate fallback matcher ignores SkillOps-only worker prompt edits', async (t) => {
  const repo = await createRepo();
  t.after(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  await commitProtectedHostBaseline(repo, 'scripts/agent-codex-worker.mjs', 'worker');
  await writeRepoFile(
    repo,
    'scripts/agent-codex-worker.mjs',
    [
      'function buildSkillOpsGatePromptBlock() {',
      "  return 'Before returning outcome=\"done\", run and report all SkillOps verification commands:';",
      '}',
      'function buildObserverDrainGatePromptBlock() {',
      "  return 'Before returning outcome=\"done\" for this review-fix digest, ensure no sibling digests remain.';",
      '}',
      '',
    ].join('\n'),
  );
  await addScriptsLibExtraction(repo);
  await writeRepoFile(repo, 'scripts/__tests__/worker.test.mjs', 'import test from "node:test";\n');

  const script = path.join(process.cwd(), 'scripts', 'code-quality-gate.mjs');
  const run = await spawn('node', [script, 'check', '--task-kind', 'USER_REQUEST'], { cwd: repo });
  assert.equal(run.code, 0, run.stderr || run.stdout);
  const payload = parseLastJson(run.stdout);
  assert.equal(payload.ok, true);
  assert.equal(
    Boolean((payload.checks || []).find((check) => check.name === 'worker-code-quality-path-change-is-coupled')),
    false,
  );
});

test('code-quality-gate fallback matcher still catches worker quality changes when one section anchor no longer resolves', async (t) => {
  const repo = await createRepo();
  t.after(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  await writeRepoFile(
    repo,
    'scripts/agent-codex-worker.mjs',
    [
      'function buildCodeQualityGatePromptBlock() {',
      "  return 'Before returning outcome=\"done\", run this self-review.';",
      '}',
      '',
      'function validateCodeQualityReviewEvidence() {',
      "  return 'missing qualityReview evidence rejects outcome=\"done\"';",
      '}',
      '',
      'function buildPrompt() {',
      "  return '';",
      '}',
      '',
    ].join('\n'),
  );
  git(repo, ['add', 'scripts/agent-codex-worker.mjs']);
  git(repo, ['commit', '-m', 'add worker quality file']);
  await writeRepoFile(
    repo,
    'scripts/agent-codex-worker.mjs',
    [
      'function buildCodeQualityGatePromptBlock() {',
      "  return 'Before returning outcome=\"done\", run this self-review.';",
      '}',
      '',
      'function validateQualityReviewEvidenceRenamed() {',
      "  return 'missing qualityReview evidence rejects outcome=\"done\" after rename';",
      '}',
      '',
      'function buildPrompt() {',
      "  return '';",
      '}',
      '',
    ].join('\n'),
  );
  await writeRepoFile(repo, 'scripts/__tests__/worker.test.mjs', 'import test from "node:test";\n');
  await writeRepoFile(repo, 'DECISIONS.md', '# decisions\n');
  await writeRepoFile(repo, 'docs/agentic/DECISIONS_AND_INCIDENTS_TIMELINE.md', '# timeline\n');

  const script = path.join(process.cwd(), 'scripts', 'code-quality-gate.mjs');
  const run = await spawn('node', [script, 'check', '--task-kind', 'USER_REQUEST'], { cwd: repo });
  assert.equal(run.code, 2, run.stderr || run.stdout);
  const payload = parseLastJson(run.stdout);
  assert.equal(payload.ok, false);
  assert.match(
    String((payload.errors || []).join(' ')),
    /agent-codex-worker\.mjs code-quality prompt\/validation changes require app-server tests and runtime reference updates/i,
  );
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
  assert.equal(typeof payload.sourceFilesSeenCount, 'number');
  assert.equal(typeof payload.sourceFilesCount, 'number');
  assert.equal(payload.sourceFilesSeenCount, 1);
  assert.equal(payload.sourceFilesCount, 1);
  assert.equal(payload.sourceFilesSeenCount, payload.sourceFilesCount);
  assert.equal(typeof payload.hardRules, 'object');
  assert.equal(payload.hardRules.codeVolume.passed, true);
  assert.equal(payload.hardRules.noDuplication.passed, true);
  assert.equal(payload.hardRules.shortestPath.passed, true);
  assert.equal(payload.hardRules.cleanup.passed, true);
  assert.equal(payload.hardRules.anticipateConsequences.passed, true);
  assert.equal(payload.hardRules.simplicity.passed, true);
});

test('code-quality-gate supports audited branch-diff exceptions for volume and duplication only', async (t) => {
  const repo = await createRepo();
  t.after(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  git(repo, ['checkout', '-b', 'feature-audit']);
  await writeExceptionRegistry(repo, [
    {
      id: 'feature-audit',
      baseRef: 'main',
      headRef: 'feature-audit',
      checks: ['diff-volume-balanced', 'no-duplicate-added-blocks'],
      decisionRef: 'DECISIONS.md#feature-audit',
      reason: 'Large subsystem baseline PR',
      expiresAt: '2026-04-30T23:59:59Z',
    },
  ]);

  await fs.mkdir(path.join(repo, 'src'), { recursive: true });
  const repeatedBlock = [
    'export const sharedAlphaDescription = "deterministic repeated block alpha for duplication scanning";',
    'export const sharedBetaDescription = "deterministic repeated block beta for duplication scanning";',
    'export const sharedGammaDescription = "deterministic repeated block gamma for duplication scanning";',
  ];
  const hugeBody = [];
  for (let i = 0; i < 90; i += 1) {
    hugeBody.push(...repeatedBlock);
  }
  await fs.writeFile(path.join(repo, 'src', 'huge.js'), hugeBody.join('\n') + '\n', 'utf8');
  await fs.writeFile(path.join(repo, 'src', 'huge-copy.js'), hugeBody.join('\n') + '\n', 'utf8');
  git(repo, ['add', 'src/huge.js', 'src/huge-copy.js', 'docs/agentic/CODE_QUALITY_EXCEPTIONS.json']);
  git(repo, ['commit', '-m', 'feature audit delta']);

  const script = path.join(process.cwd(), 'scripts', 'code-quality-gate.mjs');
  const run = await spawn(
    'node',
    [
      script,
      'check',
      '--task-kind',
      'USER_REQUEST',
      '--base-ref',
      'main',
      '--exception-id',
      'feature-audit',
    ],
    { cwd: repo },
  );
  assert.equal(run.code, 0, run.stderr || run.stdout);
  const payload = parseLastJson(run.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.exception.id, 'feature-audit');
  const volumeCheck = (payload.checks || []).find((entry) => entry.name === 'diff-volume-balanced');
  const dupCheck = (payload.checks || []).find((entry) => entry.name === 'no-duplicate-added-blocks');
  assert.equal(volumeCheck.passed, false);
  assert.equal(volumeCheck.blocking, false);
  assert.equal(volumeCheck.waived, true);
  assert.equal(dupCheck.passed, false);
  assert.equal(dupCheck.blocking, false);
  assert.equal(dupCheck.waived, true);
  assert.equal(payload.hardRules.codeVolume.passed, true);
  assert.equal(payload.hardRules.noDuplication.passed, true);
  assert.equal(payload.hardRules.shortestPath.passed, true);
  assert.equal(payload.hardRules.simplicity.passed, true);
});

test('code-quality-gate fails closed when exception id does not match branch context', async (t) => {
  const repo = await createRepo();
  t.after(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  await writeExceptionRegistry(repo, [
    {
      id: 'feature-audit',
      baseRef: 'main',
      headRef: 'feature/not-current',
      checks: ['diff-volume-balanced'],
      decisionRef: 'DECISIONS.md#feature-audit',
      reason: 'intentional mismatch',
      expiresAt: '2026-04-30T23:59:59Z',
    },
  ]);

  await fs.mkdir(path.join(repo, 'src'), { recursive: true });
  const bigAdded = Array.from({ length: 720 }, (_, i) => `export const x${i} = ${i};`).join('\n') + '\n';
  await fs.writeFile(path.join(repo, 'src', 'big.js'), bigAdded, 'utf8');

  const script = path.join(process.cwd(), 'scripts', 'code-quality-gate.mjs');
  const run = await spawn(
    'node',
    [
      script,
      'check',
      '--task-kind',
      'USER_REQUEST',
      '--base-ref',
      'main',
      '--exception-id',
      'feature-audit',
    ],
    { cwd: repo },
  );
  assert.equal(run.code, 2, run.stderr || run.stdout);
  const payload = parseLastJson(run.stdout);
  assert.equal(payload.ok, false);
  assert.match(String((payload.errors || []).join(' ')), /expects headRef=/i);
});

test('code-quality-gate exceptions do not bypass unrelated blocking failures', async (t) => {
  const repo = await createRepo();
  t.after(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  git(repo, ['checkout', '-b', 'feature-audit']);
  await writeExceptionRegistry(repo, [
    {
      id: 'feature-audit',
      baseRef: 'main',
      headRef: 'feature-audit',
      checks: ['diff-volume-balanced', 'no-duplicate-added-blocks'],
      decisionRef: 'DECISIONS.md#feature-audit',
      reason: 'Large subsystem baseline PR',
      expiresAt: '2026-04-30T23:59:59Z',
    },
  ]);

  await fs.mkdir(path.join(repo, 'src'), { recursive: true });
  const hugeBody = Array.from({ length: 720 }, (_, i) => `export const x${i} = ${i};`).join('\n') + '\n';
  await fs.writeFile(path.join(repo, 'src', 'big.js'), hugeBody, 'utf8');
  await fs.writeFile(
    path.join(repo, 'src', 'cleanup.js'),
    'export function cleanup(){ try { return 1 } catch (err) {} }\n',
    'utf8',
  );
  git(repo, ['add', 'src/big.js', 'src/cleanup.js', 'docs/agentic/CODE_QUALITY_EXCEPTIONS.json']);
  git(repo, ['commit', '-m', 'feature audit with quality escape']);

  const script = path.join(process.cwd(), 'scripts', 'code-quality-gate.mjs');
  const run = await spawn(
    'node',
    [
      script,
      'check',
      '--task-kind',
      'USER_REQUEST',
      '--base-ref',
      'main',
      '--exception-id',
      'feature-audit',
    ],
    { cwd: repo },
  );
  assert.equal(run.code, 2, run.stderr || run.stdout);
  const payload = parseLastJson(run.stdout);
  assert.equal(payload.ok, false);
  assert.match(String((payload.errors || []).join(' ')), /quality escapes detected/i);
});

test('code-quality-gate exceptions do not bypass new coupling checks', async (t) => {
  const repo = await createRepo();
  t.after(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  git(repo, ['checkout', '-b', 'feature-audit']);
  await writeExceptionRegistry(repo, [
    {
      id: 'feature-audit',
      baseRef: 'main',
      headRef: 'feature-audit',
      checks: ['diff-volume-balanced', 'no-duplicate-added-blocks'],
      decisionRef: 'DECISIONS.md#feature-audit',
      reason: 'intentional exception for coupling test',
      expiresAt: '2026-04-30T23:59:59Z',
    },
  ]);

  await writeRepoFile(
    repo,
    'scripts/code-quality-gate.mjs',
    [
      "const missingCoupledPaths = listMissingCoupledPaths(changedFileContents, ['docs/runbooks/POLICY.md']);",
      'checks.push({',
      "  name: 'gate-contract-change',",
      '  passed: missingCoupledPaths.length === 0,',
      "  details: missingCoupledPaths.length ? `missing coupled updates: ${missingCoupledPaths.join(', ')}` : 'ok',",
      '});',
      'const codeQualityPolicyChanged = gateContractChanged;',
      '',
    ].join('\n'),
  );
  await writeRepoFile(repo, 'scripts/__tests__/code-quality-gate.test.mjs', 'import test from "node:test";\n');
  git(repo, [
    'add',
    'scripts/code-quality-gate.mjs',
    'scripts/__tests__/code-quality-gate.test.mjs',
    'docs/agentic/CODE_QUALITY_EXCEPTIONS.json',
  ]);
  git(repo, ['commit', '-m', 'gate coupling exception test']);

  const script = path.join(process.cwd(), 'scripts', 'code-quality-gate.mjs');
  const run = await spawn(
    'node',
    [
      script,
      'check',
      '--task-kind',
      'USER_REQUEST',
      '--base-ref',
      'main',
      '--exception-id',
      'feature-audit',
    ],
    { cwd: repo },
  );
  assert.equal(run.code, 2, run.stderr || run.stdout);
  const payload = parseLastJson(run.stdout);
  assert.equal(payload.ok, false);
  assert.match(
    String((payload.errors || []).join(' ')),
    /scripts\/code-quality-gate\.mjs contract or policy changes require docs\/agentic\/RUNTIME_FUNCTION_REFERENCE\.md/i,
  );
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

test('code-quality-gate preserves empty diff when --base-ref resolves to HEAD', async (t) => {
  const repo = await createRepo();
  t.after(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  const script = path.join(process.cwd(), 'scripts', 'code-quality-gate.mjs');
  const run = await spawn(
    'node',
    [script, 'check', '--task-kind', 'USER_REQUEST', '--base-ref', 'HEAD'],
    { cwd: repo },
  );
  assert.equal(run.code, 0, run.stderr || run.stdout);
  const payload = parseLastJson(run.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.changedScope, 'commit-range:HEAD...HEAD');
  assert.ok(Object.prototype.hasOwnProperty.call(payload, 'changedFilesSample'));
  assert.deepEqual(payload.changedFilesSample, []);
  assert.ok(Object.prototype.hasOwnProperty.call(payload, 'sourceFilesCount'));
  assert.equal(Number(payload.sourceFilesCount), 0);
});

test('code-quality-gate fails closed when --base-ref is invalid', async (t) => {
  const repo = await createRepo();
  t.after(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  const script = path.join(process.cwd(), 'scripts', 'code-quality-gate.mjs');
  const run = await spawn(
    'node',
    [script, 'check', '--task-kind', 'USER_REQUEST', '--base-ref', 'definitely-not-a-ref'],
    { cwd: repo },
  );
  assert.equal(run.code, 2, run.stderr || run.stdout);
  const payload = parseLastJson(run.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.changedScope, 'commit-range:definitely-not-a-ref...HEAD');
  assert.match(String((payload.errors || []).join(' ')), /base-ref not found/i);
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

test('code-quality-gate requires modularity policy coupling when the modularity module changes', async (t) => {
  const repo = await createRepo();
  t.after(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  const modulePath = path.join(repo, 'scripts', 'lib', 'code-quality-modularity.mjs');
  await fs.mkdir(path.dirname(modulePath), { recursive: true });
  await fs.writeFile(modulePath, 'export const marker = 1;\n', 'utf8');

  const script = path.join(process.cwd(), 'scripts', 'code-quality-gate.mjs');
  const run = await spawn('node', [script, 'check', '--task-kind', 'USER_REQUEST'], { cwd: repo });
  assert.equal(run.code, 2, run.stderr || run.stdout);
  const payload = parseLastJson(run.stdout);
  assert.equal(payload.ok, false);
  assert.match(
    String((payload.errors || []).join(' ')),
    /modularity-policy change requires matching decision\/docs\/test\/skill updates/i,
  );
});

test('code-quality-gate requires shared modularity policy coupling when the shared modularity helper changes', async (t) => {
  const repo = await createRepo();
  t.after(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  const modulePath = path.join(repo, 'scripts', 'lib', 'code-quality-modularity-shared.mjs');
  await fs.mkdir(path.dirname(modulePath), { recursive: true });
  await fs.writeFile(modulePath, 'export const marker = 1;\n', 'utf8');

  const script = path.join(process.cwd(), 'scripts', 'code-quality-gate.mjs');
  const run = await spawn('node', [script, 'check', '--task-kind', 'USER_REQUEST'], { cwd: repo });
  assert.equal(run.code, 2, run.stderr || run.stdout);
  const payload = parseLastJson(run.stdout);
  assert.equal(payload.ok, false);
  assert.match(String((payload.errors || []).join(' ')), /modularity-policy change requires matching decision\/docs\/test\/skill updates/i);
  const details = String((payload.checks || []).find((check) => check.name === 'modularity-policy-coupling')?.details || '');
  assert.match(details, /code-quality-modularity\.test\.mjs/);
  assert.match(details, /DECISIONS\.md/);
});

test('code-quality-gate requires closure-only quality gate coupling when the cockpit gate skill changes', async (t) => {
  const repo = await createRepo();
  t.after(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  const skillPath = path.join(repo, '.codex', 'skills', 'cockpit-code-quality-gate', 'SKILL.md');
  await fs.mkdir(path.dirname(skillPath), { recursive: true });
  await fs.writeFile(skillPath, '# changed\n', 'utf8');

  const script = path.join(process.cwd(), 'scripts', 'code-quality-gate.mjs');
  const run = await spawn('node', [script, 'check', '--task-kind', 'USER_REQUEST'], {
    cwd: repo,
    env: { ...process.env, COCKPIT_ROOT: process.cwd() },
  });
  assert.equal(run.code, 2, run.stderr || run.stdout);
  const payload = parseLastJson(run.stdout);
  assert.equal(payload.ok, false);
  assert.match(
    String((payload.errors || []).join(' ')),
    /closure-only quality-gate change requires matching skill\/test updates/i,
  );
});
