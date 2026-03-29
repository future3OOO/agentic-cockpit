import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import childProcess from 'node:child_process';
import {
  buildHermeticBaseEnv,
  initRepoWithTrackedCodexDir,
  runGit,
  runCodexWorkerOnce,
  spawnProcess,
  writeExecutable,
  writeRootFocus,
  writeTask,
} from './helpers/codex-worker-harness.mjs';

const BASE_ENV = buildHermeticBaseEnv();

function runWorkerOnce({ repoRoot = process.cwd(), busRoot, rosterPath, agentName, dummyCodex, env }) {
  return runCodexWorkerOnce({
    repoRoot,
    busRoot,
    rosterPath,
    agentName,
    codexBin: dummyCodex,
    env,
  });
}

test('daddy-autopilot context snapshot includes open tasks even without rootId', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'valua-codex-worker-autopilot-context-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const promptPath = path.join(tmp, 'dummy-codex.prompt.txt');

  await writeExecutable(
    dummyCodex,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'promptPath="${DUMMY_PROMPT_PATH}"',
      'cat > "$promptPath"',
      'echo "session id: session-1" >&2',
      'out=""',
      'for ((i=1; i<=$#; i++)); do',
      '  arg="${!i}"',
      '  if [[ "$arg" == "-o" ]]; then j=$((i+1)); out="${!j}"; fi',
      'done',
      'if [[ -n "$out" ]]; then echo \'{"outcome":"done","note":"ok","commitSha":"","followUps":[]}\' > "$out"; fi',
      '',
    ].join('\n'),
  );

  const roster = {
    orchestratorName: 'daddy-orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'daddy-autopilot',
    agents: [
      {
        name: 'daddy-autopilot',
        role: 'autopilot-worker',
        skills: [],
        workdir: '$REPO_ROOT',
        startCommand: 'node scripts/agent-codex-worker.mjs --agent daddy-autopilot',
      },
      {
        name: 'frontend',
        role: 'codex-worker',
        skills: [],
        workdir: '$REPO_ROOT',
        startCommand: 'node scripts/agent-codex-worker.mjs --agent frontend',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');

  await writeTask({
    busRoot,
    agentName: 'frontend',
    taskId: 'front1',
    meta: {
      id: 'front1',
      to: ['frontend'],
      from: 'daddy',
      priority: 'P2',
      title: 'front1',
      signals: { kind: 'USER_REQUEST', rootId: 'root-a' },
    },
    body: 'do front1',
  });

  await writeTask({
    busRoot,
    agentName: 'frontend',
    taskId: 'front2',
    meta: {
      id: 'front2',
      to: ['frontend'],
      from: 'daddy',
      priority: 'P2',
      title: 'front2',
      signals: { kind: 'USER_REQUEST', rootId: 'root-b' },
    },
    body: 'do front2',
  });

  await writeTask({
    busRoot,
    agentName: 'daddy-autopilot',
    taskId: 't1',
    meta: { id: 't1', to: ['daddy-autopilot'], from: 'daddy', title: 't1', signals: { kind: 'USER_REQUEST' } },
    body: 'do t1',
  });

  const env = {
    ...BASE_ENV,
    VALUA_AGENT_BUS_DIR: busRoot,
    DUMMY_PROMPT_PATH: promptPath,
    VALUA_AUTOPILOT_INCLUDE_DEPLOY_JSON: '0',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
  };

  const run = await runWorkerOnce({
    repoRoot,
    busRoot,
    rosterPath,
    agentName: 'daddy-autopilot',
    dummyCodex,
    env,
  });
  assert.equal(run.code, 0, run.stderr || run.stdout);

  const prompt = await fs.readFile(promptPath, 'utf8');
  assert.match(prompt, /\bOpen tasks:\n/);
  assert.match(prompt, /\bfront1\b/);
  assert.match(prompt, /\bfront2\b/);
});

test('daddy-autopilot cross-root transition ignores untracked runtime artifacts', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'valua-codex-worker-cross-root-artifacts-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const taskRepo = path.join(tmp, 'task-repo');
  const dummyCodex = path.join(tmp, 'dummy-codex');

  await initRepoWithTrackedCodexDir(taskRepo);
  await fs.mkdir(path.join(taskRepo, '.codex', 'quality', 'logs'), { recursive: true });
  await fs.mkdir(path.join(taskRepo, '.codex', 'skill-ops', 'logs', '2026-02'), { recursive: true });
  await fs.mkdir(path.join(taskRepo, '.codex-tmp'), { recursive: true });
  await fs.mkdir(path.join(taskRepo, 'artifacts', 'reviews'), { recursive: true });
  await fs.writeFile(path.join(taskRepo, '.codex', 'quality', 'logs', 'quality.md'), 'quality log\n', 'utf8');
  await fs.writeFile(
    path.join(taskRepo, '.codex', 'skill-ops', 'logs', '2026-02', 'skillops.md'),
    [
      '---',
      'id: test-empty-skillops',
      'status: new',
      'skill_updates:',
      '  cockpit-autopilot: []',
      '  cockpit-skillops: []',
      '---',
      '',
    ].join('\n'),
    'utf8',
  );
  await fs.writeFile(path.join(taskRepo, '.codex-tmp', '.codex-git-credentials.test'), 'temp creds\n', 'utf8');
  await fs.writeFile(path.join(taskRepo, 'artifacts', 'reviews', 'previous.md'), 'previous review\n', 'utf8');

  await writeExecutable(
    dummyCodex,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'echo "session id: session-cross-root-allow" >&2',
      'out=""',
      'for ((i=1; i<=$#; i++)); do',
      '  arg="${!i}"',
      '  if [[ "$arg" == "-o" ]]; then j=$((i+1)); out="${!j}"; fi',
      'done',
      'if [[ -n "$out" ]]; then echo \'{"outcome":"done","note":"ok","commitSha":"","followUps":[],"review":null}\' > "$out"; fi',
      '',
    ].join('\n'),
  );

  const roster = {
    orchestratorName: 'daddy-orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'daddy-autopilot',
    agents: [
      {
        name: 'daddy-autopilot',
        role: 'autopilot-worker',
        skills: [],
        workdir: taskRepo,
        startCommand: 'node scripts/agent-codex-worker.mjs --agent daddy-autopilot',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');

  await writeRootFocus({ busRoot, agentName: 'daddy-autopilot', rootId: 'PR108' });

  await writeTask({
    busRoot,
    agentName: 'daddy-autopilot',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['daddy-autopilot'],
      from: 'daddy',
      title: 'cross-root artifact-only dirt',
      signals: { kind: 'USER_REQUEST', rootId: 'root-next' },
    },
    body: 'proceed with artifact-only dirty worktree',
  });

  const env = {
    ...BASE_ENV,
    VALUA_AGENT_BUS_DIR: busRoot,
    AGENTIC_AUTOPILOT_DELEGATE_GATE: '0',
    AGENTIC_RUNTIME_POLICY_SYNC: '0',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
  };

  const run = await runWorkerOnce({
    repoRoot,
    busRoot,
    rosterPath,
    agentName: 'daddy-autopilot',
    dummyCodex,
    env,
  });
  assert.equal(run.code, 0, run.stderr || run.stdout);

  const receiptPath = path.join(busRoot, 'receipts', 'daddy-autopilot', 't1.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(receipt.outcome, 'done');
  assert.doesNotMatch(String(receipt.note || ''), /dirty cross-root transition/i);
});

test('daddy-autopilot cross-root transition still blocks non-empty skillops logs', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'valua-codex-worker-cross-root-skillops-block-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const taskRepo = path.join(tmp, 'task-repo');
  const dummyCodex = path.join(tmp, 'dummy-codex');

  await initRepoWithTrackedCodexDir(taskRepo);
  await fs.mkdir(path.join(taskRepo, '.codex', 'skill-ops', 'logs', '2026-02'), { recursive: true });
  await fs.writeFile(
    path.join(taskRepo, '.codex', 'skill-ops', 'logs', '2026-02', 'skillops.md'),
    [
      '---',
      'id: test-nonempty-skillops',
      'status: new',
      'skill_updates:',
      '  cockpit-autopilot:',
      '    - "Keep the real learning."',
      '---',
      '',
    ].join('\n'),
    'utf8',
  );

  await writeExecutable(
    dummyCodex,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'echo "session id: session-cross-root-skillops-block" >&2',
      'out=""',
      'for ((i=1; i<=$#; i++)); do',
      '  arg="${!i}"',
      '  if [[ "$arg" == "-o" ]]; then j=$((i+1)); out="${!j}"; fi',
      'done',
      'if [[ -n "$out" ]]; then echo \'{"outcome":"done","note":"ok","commitSha":"","followUps":[],"review":null}\' > "$out"; fi',
      '',
    ].join('\n'),
  );

  const roster = {
    orchestratorName: 'daddy-orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'daddy-autopilot',
    agents: [
      {
        name: 'daddy-autopilot',
        role: 'autopilot-worker',
        skills: [],
        workdir: taskRepo,
        startCommand: 'node scripts/agent-codex-worker.mjs --agent daddy-autopilot',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');

  await writeRootFocus({ busRoot, agentName: 'daddy-autopilot', rootId: 'PR108' });

  await writeTask({
    busRoot,
    agentName: 'daddy-autopilot',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['daddy-autopilot'],
      from: 'daddy',
      title: 'cross-root non-empty skillops dirt',
      signals: { kind: 'USER_REQUEST', rootId: 'root-next' },
    },
    body: 'should block on non-empty skillops dirt',
  });

  const env = {
    ...BASE_ENV,
    VALUA_AGENT_BUS_DIR: busRoot,
    AGENTIC_AUTOPILOT_DELEGATE_GATE: '0',
    AGENTIC_RUNTIME_POLICY_SYNC: '0',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
  };

  const run = await runWorkerOnce({
    repoRoot,
    busRoot,
    rosterPath,
    agentName: 'daddy-autopilot',
    dummyCodex,
    env,
  });
  assert.equal(run.code, 0, run.stderr || run.stdout);

  const receiptPath = path.join(busRoot, 'receipts', 'daddy-autopilot', 't1.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(receipt.outcome, 'blocked');
  assert.match(String(receipt.note || ''), /dirty cross-root transition/i);
  assert.match(String(receipt.receiptExtra?.details?.statusPorcelain || ''), /skill-ops/i);
});

test('daddy-autopilot cross-root transition still blocks substantive dirty changes', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'valua-codex-worker-cross-root-blocking-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const taskRepo = path.join(tmp, 'task-repo');
  const dummyCodex = path.join(tmp, 'dummy-codex');

  await initRepoWithTrackedCodexDir(taskRepo);
  await fs.writeFile(path.join(taskRepo, 'README.md'), 'dirty tracked change\n', 'utf8');

  await writeExecutable(
    dummyCodex,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'echo "session id: session-cross-root-block" >&2',
      'out=""',
      'for ((i=1; i<=$#; i++)); do',
      '  arg="${!i}"',
      '  if [[ "$arg" == "-o" ]]; then j=$((i+1)); out="${!j}"; fi',
      'done',
      'if [[ -n "$out" ]]; then echo \'{"outcome":"done","note":"should-not-run","commitSha":"","followUps":[],"review":null}\' > "$out"; fi',
      '',
    ].join('\n'),
  );

  const roster = {
    orchestratorName: 'daddy-orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'daddy-autopilot',
    agents: [
      {
        name: 'daddy-autopilot',
        role: 'autopilot-worker',
        skills: [],
        workdir: taskRepo,
        startCommand: 'node scripts/agent-codex-worker.mjs --agent daddy-autopilot',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');

  await writeRootFocus({ busRoot, agentName: 'daddy-autopilot', rootId: 'PR108' });

  await writeTask({
    busRoot,
    agentName: 'daddy-autopilot',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['daddy-autopilot'],
      from: 'daddy',
      title: 'cross-root tracked dirt',
      signals: { kind: 'USER_REQUEST', rootId: 'root-next' },
    },
    body: 'this should fail preflight',
  });

  const env = {
    ...BASE_ENV,
    VALUA_AGENT_BUS_DIR: busRoot,
    AGENTIC_AUTOPILOT_DELEGATE_GATE: '0',
    AGENTIC_RUNTIME_POLICY_SYNC: '0',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
  };

  const run = await runWorkerOnce({
    repoRoot,
    busRoot,
    rosterPath,
    agentName: 'daddy-autopilot',
    dummyCodex,
    env,
  });
  assert.equal(run.code, 0, run.stderr || run.stdout);

  const receipt = JSON.parse(
    await fs.readFile(path.join(busRoot, 'receipts', 'daddy-autopilot', 't1.json'), 'utf8'),
  );
  assert.equal(receipt.outcome, 'blocked');
  assert.match(String(receipt.note || ''), /dirty cross-root transition/i);
  assert.equal(receipt.receiptExtra?.details?.reasonCode, 'dirty_cross_root_transition');
  assert.match(String(receipt.receiptExtra?.details?.statusPorcelain || ''), /README\.md/);
  assert.equal(receipt.receiptExtra?.autopilotRecovery, undefined);
  assert.doesNotMatch(String(receipt.note || ''), /autopilot_recovery_queued_/);

  const queuedIds = await fs.readdir(path.join(busRoot, 'inbox', 'daddy-autopilot', 'new'));
  assert.equal(queuedIds.length, 1);
  assert.equal(queuedIds[0], 'autopilot_recovery__t1__1.md');
  const queuedRaw = await fs.readFile(path.join(busRoot, 'inbox', 'daddy-autopilot', 'new', queuedIds[0]), 'utf8');
  const queuedMeta = JSON.parse(queuedRaw.split('---\n')[1]);
  assert.equal(queuedMeta.signals?.sourceKind, 'AUTOPILOT_BLOCKED_RECOVERY');
  assert.equal(queuedMeta.signals?.phase, 'blocked-recovery');
  assert.equal(queuedMeta.references?.autopilotRecovery?.attempt, 1);
  assert.equal(queuedMeta.signals?.rootId, 'root-next');
});

test('daddy-autopilot cross-root review-fix continues when already on incoming PR head', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'valua-codex-worker-cross-root-review-fix-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const taskRepo = path.join(tmp, 'task-repo');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const dummyGh = path.join(tmp, 'gh');

  await initRepoWithTrackedCodexDir(taskRepo);
  await fs.writeFile(path.join(taskRepo, 'DECISIONS.md'), 'seed decision\n', 'utf8');
  runGit(taskRepo, ['add', 'DECISIONS.md']);
  runGit(taskRepo, ['commit', '-m', 'add decisions']);
  await fs.writeFile(path.join(taskRepo, 'DECISIONS.md'), 'seed decision\npending review fix\n', 'utf8');
  const headSha = childProcess.execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: taskRepo,
    encoding: 'utf8',
  }).trim();

  await writeExecutable(
    dummyCodex,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'echo "session id: session-cross-root-review-fix" >&2',
      'out=""',
      'for ((i=1; i<=$#; i++)); do',
      '  arg="${!i}"',
      '  if [[ "$arg" == "-o" ]]; then j=$((i+1)); out="${!j}"; fi',
      'done',
      'if [[ -n "$out" ]]; then echo \'{"outcome":"done","note":"review-fix-continued","commitSha":"","followUps":[],"review":null}\' > "$out"; fi',
      '',
    ].join('\n'),
  );

  await fs.writeFile(
    dummyGh,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [ "${1:-}" = "pr" ] && [ "${2:-}" = "view" ] && [ "${3:-}" = "121" ] && [ "${4:-}" = "--json" ] && [ "${5:-}" = "headRefOid" ]; then',
      `  printf '%s\\n' '${headSha}'`,
      '  exit 0',
      'fi',
      'exit 1',
      '',
    ].join('\n'),
    'utf8',
  );
  await fs.chmod(dummyGh, 0o755);

  const roster = {
    orchestratorName: 'daddy-orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'daddy-autopilot',
    agents: [
      {
        name: 'daddy-autopilot',
        role: 'autopilot-worker',
        skills: [],
        workdir: taskRepo,
        startCommand: 'node scripts/agent-codex-worker.mjs --agent daddy-autopilot',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');

  await writeRootFocus({ busRoot, agentName: 'daddy-autopilot', rootId: 'PR120' });

  await writeTask({
    busRoot,
    agentName: 'daddy-autopilot',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['daddy-autopilot'],
      from: 'daddy-orchestrator',
      title: 'pr121 review fix',
      signals: { kind: 'ORCHESTRATOR_UPDATE', rootId: 'PR121', phase: 'review-fix' },
      references: {
        sourceAgent: 'observer:pr',
        sourceReferences: {
          pr: { number: 121 },
        },
      },
    },
    body: 'continue the PR121 review-fix on the current PR head',
  });

  const env = {
    ...BASE_ENV,
    VALUA_AGENT_BUS_DIR: busRoot,
    AGENTIC_AUTOPILOT_DELEGATE_GATE: '0',
    AGENTIC_RUNTIME_POLICY_SYNC: '0',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    PATH: `${tmp}:${BASE_ENV.PATH || ''}`,
  };

  const run = await runWorkerOnce({
    repoRoot,
    busRoot,
    rosterPath,
    agentName: 'daddy-autopilot',
    dummyCodex,
    env,
  });
  assert.equal(run.code, 0, run.stderr || run.stdout);

  const receipt = JSON.parse(
    await fs.readFile(path.join(busRoot, 'receipts', 'daddy-autopilot', 't1.json'), 'utf8'),
  );
  assert.equal(receipt.outcome, 'done');
  assert.doesNotMatch(String(receipt.note || ''), /dirty cross-root transition/i);
  assert.equal(receipt.receiptExtra?.autopilotRecovery, undefined);

  const focus = JSON.parse(
    await fs.readFile(path.join(busRoot, 'state', 'agent-root-focus', 'daddy-autopilot.json'), 'utf8'),
  );
  assert.equal(focus.rootId, 'PR121');
});

test('daddy-autopilot blocked recovery stops requeueing after max attempts', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'valua-codex-worker-recovery-exhausted-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const taskRepo = path.join(tmp, 'task-repo');
  const dummyCodex = path.join(tmp, 'dummy-codex');

  await initRepoWithTrackedCodexDir(taskRepo);
  await fs.writeFile(path.join(taskRepo, 'README.md'), 'dirty tracked change\n', 'utf8');

  await writeExecutable(
    dummyCodex,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'echo "session id: session-recovery-exhausted" >&2',
      'out=""',
      'for ((i=1; i<=$#; i++)); do',
      '  arg="${!i}"',
      '  if [[ "$arg" == "-o" ]]; then j=$((i+1)); out="${!j}"; fi',
      'done',
      'if [[ -n "$out" ]]; then echo \'{"outcome":"done","note":"should-not-run","commitSha":"","followUps":[],"review":null}\' > "$out"; fi',
      '',
    ].join('\n'),
  );

  const roster = {
    orchestratorName: 'daddy-orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'daddy-autopilot',
    agents: [
      {
        name: 'daddy-autopilot',
        role: 'autopilot-worker',
        skills: [],
        workdir: taskRepo,
        startCommand: 'node scripts/agent-codex-worker.mjs --agent daddy-autopilot',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');

  await writeRootFocus({ busRoot, agentName: 'daddy-autopilot', rootId: 'PR108' });

  await writeTask({
    busRoot,
    agentName: 'daddy-autopilot',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['daddy-autopilot'],
      from: 'daddy-autopilot',
      title: 'blocked recovery exhausted',
      signals: { kind: 'ORCHESTRATOR_UPDATE', rootId: 'root-next', phase: 'blocked-recovery' },
      references: { autopilotRecovery: { attempt: 3, maxAttempts: 3, reasonCode: 'dirty_cross_root_transition' } },
    },
    body: 'this blocked recovery has already exhausted retries',
  });

  const env = {
    ...BASE_ENV,
    VALUA_AGENT_BUS_DIR: busRoot,
    AGENTIC_AUTOPILOT_DELEGATE_GATE: '0',
    AGENTIC_RUNTIME_POLICY_SYNC: '0',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
  };

  const run = await runWorkerOnce({
    repoRoot,
    busRoot,
    rosterPath,
    agentName: 'daddy-autopilot',
    dummyCodex,
    env,
  });
  assert.equal(run.code, 0, run.stderr || run.stdout);

  const receipt = JSON.parse(
    await fs.readFile(path.join(busRoot, 'receipts', 'daddy-autopilot', 't1.json'), 'utf8'),
  );
  assert.equal(receipt.outcome, 'blocked');
  assert.equal(receipt.receiptExtra?.autopilotRecovery?.queued, false);
  assert.equal(receipt.receiptExtra?.autopilotRecovery?.reason, 'attempts_exhausted');
  assert.equal(receipt.receiptExtra?.autopilotRecovery?.recoveryKey, 'autopilot_recovery__t1__4');
  assert.match(String(receipt.note || ''), /autopilot_recovery_attempts_exhausted/);

  const queuedDir = path.join(busRoot, 'inbox', 'daddy-autopilot', 'new');
  let queued = [];
  try {
    queued = await fs.readdir(queuedDir);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
    queued = [];
  }
  assert.equal(queued.length, 0);
});

test('daddy-autopilot cross-root runtime artifacts do not suppress review followUp dispatch', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'valua-codex-worker-cross-root-followup-dispatch-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const taskRepo = path.join(tmp, 'task-repo');
  const dummyCodex = path.join(tmp, 'dummy-codex');

  await initRepoWithTrackedCodexDir(taskRepo);
  await fs.mkdir(path.join(taskRepo, 'artifacts', 'reviews'), { recursive: true });
  await fs.writeFile(path.join(taskRepo, 'artifacts', 'reviews', 'previous.md'), 'old runtime artifact\n', 'utf8');
  const baseSha = childProcess.execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: taskRepo,
    encoding: 'utf8',
  }).trim();

  await writeExecutable(
    dummyCodex,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'echo "session id: session-cross-root-followup-dispatch" >&2',
      'out=""',
      'for ((i=1; i<=$#; i++)); do',
      '  arg="${!i}"',
      '  if [[ "$arg" == "-o" ]]; then j=$((i+1)); out="${!j}"; fi',
      'done',
      'if [[ -n "$out" ]]; then',
      `  echo '{"outcome":"done","note":"reviewed","commitSha":"","followUps":[{"to":["frontend"],"title":"fix","body":"please fix","signals":{"kind":"EXECUTE","phase":"fix","rootId":"root-next","parentId":"t1","smoke":false},"references":{"git":{"baseSha":"${baseSha}","workBranch":"wip/frontend/root-next","integrationBranch":"slice/root-next"},"integration":{"requiredIntegrationBranch":"slice/root-next","integrationMode":"autopilot_integrates"}}}],"review":{"ran":true,"method":"built_in_review","targetCommitSha":"${baseSha}","summary":"P1 src/app.ts:10 - fix required","findingsCount":1,"verdict":"changes_requested","evidence":{"artifactPath":"artifacts/daddy-autopilot/reviews/t1.custom.md","sectionsPresent":["findings","severity","file_refs","actions"]}}}' > "$out"`,
      'fi',
      '',
    ].join('\n'),
  );

  const roster = {
    orchestratorName: 'daddy-orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'daddy-autopilot',
    agents: [
      {
        name: 'daddy-autopilot',
        role: 'autopilot-worker',
        skills: [],
        workdir: taskRepo,
        startCommand: 'node scripts/agent-codex-worker.mjs --agent daddy-autopilot',
      },
      {
        name: 'frontend',
        role: 'codex-worker',
        skills: [],
        workdir: taskRepo,
        startCommand: 'node scripts/agent-codex-worker.mjs --agent frontend',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');

  await fs.mkdir(path.join(busRoot, 'state', 'agent-root-focus'), { recursive: true });
  await fs.writeFile(
    path.join(busRoot, 'state', 'agent-root-focus', 'daddy-autopilot.json'),
    JSON.stringify({ rootId: 'PR114' }, null, 2) + '\n',
    'utf8',
  );

  await writeTask({
    busRoot,
    agentName: 'daddy-autopilot',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['daddy-autopilot'],
      from: 'daddy-orchestrator',
      title: 'digest',
      signals: {
        kind: 'ORCHESTRATOR_UPDATE',
        sourceKind: 'TASK_COMPLETE',
        rootId: 'root-next',
        reviewRequired: true,
        reviewTarget: {
          sourceTaskId: 'exec-1',
          sourceAgent: 'frontend',
          sourceKind: 'EXECUTE',
          commitSha: baseSha,
        },
      },
      references: { completedTaskKind: 'EXECUTE' },
    },
    body: 'dispatch followup during review closeout',
  });

  const env = {
    ...BASE_ENV,
    VALUA_AGENT_BUS_DIR: busRoot,
    AGENTIC_RUNTIME_POLICY_SYNC: '0',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'daddy-autopilot',
      '--bus-root',
      busRoot,
      '--roster',
      rosterPath,
      '--once',
      '--poll-ms',
      '10',
      '--codex-bin',
      dummyCodex,
    ],
    { cwd: repoRoot, env },
  );
  assert.equal(run.code, 0, run.stderr || run.stdout);

  const receipt = JSON.parse(
    await fs.readFile(path.join(busRoot, 'receipts', 'daddy-autopilot', 't1.json'), 'utf8'),
  );
  assert.equal(receipt.outcome, 'done');
  assert.equal(receipt.note, 'reviewed');
  assert.doesNotMatch(String(receipt.note || ''), /dirty cross-root transition/i);
  assert.equal(Array.isArray(receipt.receiptExtra?.dispatchedFollowUps), true);
  assert.equal(receipt.receiptExtra.dispatchedFollowUps.length, 1);
  assert.equal(receipt.receiptExtra.dispatchedFollowUps[0].kind, 'EXECUTE');
  assert.equal(receipt.receiptExtra.runtimeGuard.engineModeGate.pass, true);

  const dispatchedId = receipt.receiptExtra.dispatchedFollowUps[0].id;
  const followUpPath = path.join(busRoot, 'inbox', 'frontend', 'new', `${dispatchedId}.md`);
  const followUpRaw = await fs.readFile(followUpPath, 'utf8');
  assert.match(followUpRaw, /"kind":"EXECUTE"|"kind": "EXECUTE"/);
  assert.match(followUpRaw, /"rootId":"root-next"|"rootId": "root-next"/);
});

test('daddy-autopilot fast-path skips codex for allowlisted ORCHESTRATOR_UPDATE', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'valua-codex-worker-autopilot-fastpath-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const countFile = path.join(tmp, 'count.txt');
  const promptPath = path.join(tmp, 'dummy-codex.prompt.txt');

  await writeExecutable(
    dummyCodex,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `COUNT_FILE=${JSON.stringify(countFile)}`,
      'n=0',
      'if [[ -f "$COUNT_FILE" ]]; then n=$(cat "$COUNT_FILE"); fi',
      'n=$((n+1))',
      'echo "$n" > "$COUNT_FILE"',
      'cat > "${DUMMY_PROMPT_PATH}"',
      'echo "session id: session-fastpath" >&2',
      'out=""',
      'for ((i=1; i<=$#; i++)); do',
      '  arg="${!i}"',
      '  if [[ "$arg" == "-o" ]]; then j=$((i+1)); out="${!j}"; fi',
      'done',
      'if [[ -n "$out" ]]; then echo \'{"outcome":"done","note":"ran-codex","commitSha":"","followUps":[]}\' > "$out"; fi',
      '',
    ].join('\n'),
  );

  const roster = {
    orchestratorName: 'daddy-orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'daddy-autopilot',
    agents: [
      {
        name: 'daddy-autopilot',
        role: 'autopilot-worker',
        skills: [],
        workdir: '$REPO_ROOT',
        startCommand: 'node scripts/agent-codex-worker.mjs --agent daddy-autopilot',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');

  await writeTask({
    busRoot,
    agentName: 'daddy-autopilot',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['daddy-autopilot'],
      from: 'daddy-orchestrator',
      title: 'digest',
      signals: { kind: 'ORCHESTRATOR_UPDATE', sourceKind: 'TASK_COMPLETE' },
      references: { completedTaskKind: 'STATUS' },
    },
    body: 'digest body',
  });

  const env = {
    ...BASE_ENV,
    VALUA_AGENT_BUS_DIR: busRoot,
    DUMMY_PROMPT_PATH: promptPath,
    AGENTIC_AUTOPILOT_DIGEST_FASTPATH: '1',
    AGENTIC_AUTOPILOT_DIGEST_FASTPATH_ALLOWLIST: 'TASK_COMPLETE:STATUS',
    VALUA_AUTOPILOT_INCLUDE_DEPLOY_JSON: '0',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'daddy-autopilot',
      '--bus-root',
      busRoot,
      '--roster',
      rosterPath,
      '--once',
      '--poll-ms',
      '10',
      '--codex-bin',
      dummyCodex,
    ],
    { cwd: repoRoot, env },
  );
  assert.equal(run.code, 0, run.stderr || run.stdout);

  const receiptPath = path.join(busRoot, 'receipts', 'daddy-autopilot', 't1.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(receipt.outcome, 'done');
  assert.match(receipt.note, /fastpath ack \(TASK_COMPLETE:STATUS\)/);
  assert.deepEqual(receipt.receiptExtra.followUps, []);

  // Ensure codex was not invoked.
  await assert.rejects(fs.stat(promptPath));
  await assert.rejects(fs.stat(countFile));
});

test('daddy-autopilot fast-path does not auto-ack non-done TASK_COMPLETE digests', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'valua-codex-worker-autopilot-fastpath-nondone-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const countFile = path.join(tmp, 'count.txt');
  const promptPath = path.join(tmp, 'dummy-codex.prompt.txt');

  await writeExecutable(
    dummyCodex,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `COUNT_FILE=${JSON.stringify(countFile)}`,
      'n=0',
      'if [[ -f "$COUNT_FILE" ]]; then n=$(cat "$COUNT_FILE"); fi',
      'n=$((n+1))',
      'echo "$n" > "$COUNT_FILE"',
      'cat > "${DUMMY_PROMPT_PATH}"',
      'echo "session id: session-nondone-fastpath" >&2',
      'out=""',
      'for ((i=1; i<=$#; i++)); do',
      '  arg="${!i}"',
      '  if [[ "$arg" == "-o" ]]; then j=$((i+1)); out="${!j}"; fi',
      'done',
      'if [[ -n "$out" ]]; then echo \'{"outcome":"done","note":"ran-codex","commitSha":"","followUps":[]}\' > "$out"; fi',
      '',
    ].join('\n'),
  );

  const roster = {
    orchestratorName: 'daddy-orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'daddy-autopilot',
    agents: [
      {
        name: 'daddy-autopilot',
        role: 'autopilot-worker',
        skills: [],
        workdir: '$REPO_ROOT',
        startCommand: 'node scripts/agent-codex-worker.mjs --agent daddy-autopilot',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');

  await writeTask({
    busRoot,
    agentName: 'daddy-autopilot',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['daddy-autopilot'],
      from: 'daddy-orchestrator',
      title: 'digest',
      signals: { kind: 'ORCHESTRATOR_UPDATE', sourceKind: 'TASK_COMPLETE' },
      references: { completedTaskKind: 'STATUS', receiptOutcome: 'needs_review' },
    },
    body: 'digest body',
  });

  const env = {
    ...BASE_ENV,
    VALUA_AGENT_BUS_DIR: busRoot,
    DUMMY_PROMPT_PATH: promptPath,
    AGENTIC_AUTOPILOT_DIGEST_FASTPATH: '1',
    AGENTIC_AUTOPILOT_DIGEST_FASTPATH_ALLOWLIST: 'TASK_COMPLETE:STATUS',
    VALUA_AUTOPILOT_INCLUDE_DEPLOY_JSON: '0',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'daddy-autopilot',
      '--bus-root',
      busRoot,
      '--roster',
      rosterPath,
      '--once',
      '--poll-ms',
      '10',
      '--codex-bin',
      dummyCodex,
    ],
    { cwd: repoRoot, env },
  );
  assert.equal(run.code, 0, run.stderr || run.stdout);

  const receiptPath = path.join(busRoot, 'receipts', 'daddy-autopilot', 't1.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(receipt.outcome, 'done');
  assert.equal(receipt.note, 'ran-codex');
  assert.deepEqual(receipt.receiptExtra.followUps, []);

  assert.equal(Number(await fs.readFile(countFile, 'utf8')), 1);
  assert.match(await fs.readFile(promptPath, 'utf8'), /ORCHESTRATOR_UPDATE/);
});

test('daddy-autopilot fast-path falls back to codex when not allowlisted', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'valua-codex-worker-autopilot-fastpath-fallback-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const countFile = path.join(tmp, 'count.txt');
  const promptPath = path.join(tmp, 'dummy-codex.prompt.txt');

  await writeExecutable(
    dummyCodex,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `COUNT_FILE=${JSON.stringify(countFile)}`,
      'n=0',
      'if [[ -f "$COUNT_FILE" ]]; then n=$(cat "$COUNT_FILE"); fi',
      'n=$((n+1))',
      'echo "$n" > "$COUNT_FILE"',
      'cat > "${DUMMY_PROMPT_PATH}"',
      'echo "session id: session-fallback" >&2',
      'out=""',
      'for ((i=1; i<=$#; i++)); do',
      '  arg="${!i}"',
      '  if [[ "$arg" == "-o" ]]; then j=$((i+1)); out="${!j}"; fi',
      'done',
      'if [[ -n "$out" ]]; then echo \'{"outcome":"done","note":"ran-codex","commitSha":"","followUps":[]}\' > "$out"; fi',
      '',
    ].join('\n'),
  );

  const roster = {
    orchestratorName: 'daddy-orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'daddy-autopilot',
    agents: [
      {
        name: 'daddy-autopilot',
        role: 'autopilot-worker',
        skills: [],
        workdir: '$REPO_ROOT',
        startCommand: 'node scripts/agent-codex-worker.mjs --agent daddy-autopilot',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');

  await writeTask({
    busRoot,
    agentName: 'daddy-autopilot',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['daddy-autopilot'],
      from: 'daddy-orchestrator',
      title: 'digest',
      signals: { kind: 'ORCHESTRATOR_UPDATE', sourceKind: 'TASK_COMPLETE' },
      references: { completedTaskKind: 'STATUS' },
    },
    body: 'digest body',
  });

  const env = {
    ...BASE_ENV,
    VALUA_AGENT_BUS_DIR: busRoot,
    DUMMY_PROMPT_PATH: promptPath,
    AGENTIC_AUTOPILOT_DIGEST_FASTPATH: '1',
    AGENTIC_AUTOPILOT_DIGEST_FASTPATH_ALLOWLIST: 'REVIEW_ACTION_REQUIRED:*',
    VALUA_AUTOPILOT_INCLUDE_DEPLOY_JSON: '0',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'daddy-autopilot',
      '--bus-root',
      busRoot,
      '--roster',
      rosterPath,
      '--once',
      '--poll-ms',
      '10',
      '--codex-bin',
      dummyCodex,
    ],
    { cwd: repoRoot, env },
  );
  assert.equal(run.code, 0, run.stderr || run.stdout);

  const receiptPath = path.join(busRoot, 'receipts', 'daddy-autopilot', 't1.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(receipt.outcome, 'done');
  assert.equal(receipt.note, 'ran-codex');
  assert.deepEqual(receipt.receiptExtra.followUps, []);

  assert.equal(Number(await fs.readFile(countFile, 'utf8')), 1);
  assert.match(await fs.readFile(promptPath, 'utf8'), /ORCHESTRATOR_UPDATE/);
});

test('non-autopilot follow-up preserves explicit references.git.workBranch', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'valua-codex-worker-explicit-work-branch-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');

  await writeExecutable(
    dummyCodex,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'echo "session id: session-explicit-branch" >&2',
      'out=""',
      'for ((i=1; i<=$#; i++)); do',
      '  arg="${!i}"',
      '  if [[ "$arg" == "-o" ]]; then j=$((i+1)); out="${!j}"; fi',
      'done',
      'if [[ -n "$out" ]]; then',
      '  echo \'{"outcome":"done","note":"followup","commitSha":"","followUps":[{"to":["frontend"],"title":"execute","body":"run","signals":{"kind":"EXECUTE","phase":"execute","rootId":"root-branch","parentId":"t1","smoke":false},"references":{"git":{"workBranch":"feature/custom-explicit"}}}]}\' > "$out"',
      'fi',
      '',
    ].join('\n'),
  );

  const roster = {
    orchestratorName: 'daddy-orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'daddy-autopilot',
    agents: [
      {
        name: 'backend',
        role: 'codex-worker',
        skills: [],
        workdir: '$REPO_ROOT',
        startCommand: 'node scripts/agent-codex-worker.mjs --agent backend',
      },
      {
        name: 'frontend',
        role: 'codex-worker',
        skills: [],
        workdir: '$REPO_ROOT',
        startCommand: 'node scripts/agent-codex-worker.mjs --agent frontend',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');

  await writeTask({
    busRoot,
    agentName: 'backend',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['backend'],
      from: 'daddy',
      title: 'explicit branch',
      signals: { kind: 'USER_REQUEST', rootId: 'root-branch' },
    },
    body: 'emit execute follow-up',
  });

  const env = {
    ...BASE_ENV,
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'backend',
      '--bus-root',
      busRoot,
      '--roster',
      rosterPath,
      '--once',
      '--poll-ms',
      '10',
      '--codex-bin',
      dummyCodex,
    ],
    { cwd: repoRoot, env },
  );
  assert.equal(run.code, 0, run.stderr || run.stdout);

  const frontendNewDir = path.join(busRoot, 'inbox', 'frontend', 'new');
  const files = await fs.readdir(frontendNewDir);
  assert.ok(files.length >= 1, 'expected execute follow-up in frontend inbox');
  const raw = await fs.readFile(path.join(frontendNewDir, files[0]), 'utf8');
  const parts = raw.match(/^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/);
  assert.ok(parts, 'expected packet frontmatter');
  const meta = JSON.parse(parts[1]);
  assert.equal(meta.references?.git?.workBranch, 'feature/custom-explicit');
});

test('branch continuity reasonCode is null for non-branch follow-up dispatch errors', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'valua-codex-worker-branch-reasoncode-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');

  await writeExecutable(
    dummyCodex,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'echo "session id: session-reasoncode" >&2',
      'out=""',
      'for ((i=1; i<=$#; i++)); do',
      '  arg="${!i}"',
      '  if [[ "$arg" == "-o" ]]; then j=$((i+1)); out="${!j}"; fi',
      'done',
      'if [[ -n "$out" ]]; then',
      '  echo \'{"outcome":"done","note":"followup-error","commitSha":"","followUps":[{"to":["frontend"],"title":"","body":"run","signals":{"kind":"EXECUTE","phase":"execute","rootId":"root-errors","parentId":"t1","smoke":false}}]}\' > "$out"',
      'fi',
      '',
    ].join('\n'),
  );

  const roster = {
    orchestratorName: 'daddy-orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'daddy-autopilot',
    agents: [
      {
        name: 'backend',
        role: 'codex-worker',
        skills: [],
        workdir: '$REPO_ROOT',
        startCommand: 'node scripts/agent-codex-worker.mjs --agent backend',
      },
      {
        name: 'frontend',
        role: 'codex-worker',
        skills: [],
        workdir: '$REPO_ROOT',
        startCommand: 'node scripts/agent-codex-worker.mjs --agent frontend',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');

  await writeTask({
    busRoot,
    agentName: 'backend',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['backend'],
      from: 'daddy',
      title: 'invalid follow-up',
      signals: { kind: 'USER_REQUEST', rootId: 'root-errors' },
    },
    body: 'emit invalid follow-up',
  });

  const env = {
    ...BASE_ENV,
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'backend',
      '--bus-root',
      busRoot,
      '--roster',
      rosterPath,
      '--once',
      '--poll-ms',
      '10',
      '--codex-bin',
      dummyCodex,
    ],
    { cwd: repoRoot, env },
  );
  assert.equal(run.code, 0, run.stderr || run.stdout);

  const receiptPath = path.join(busRoot, 'receipts', 'backend', 't1.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(receipt.outcome, 'needs_review');
  assert.ok(
    Array.isArray(receipt.receiptExtra.followUpDispatchErrors) &&
      receipt.receiptExtra.followUpDispatchErrors.some((entry) => String(entry).includes('followUp.title must be non-empty')),
  );
  assert.equal(receipt.receiptExtra.runtimeGuard.branchContinuityGate.status, 'blocked');
  assert.equal(receipt.receiptExtra.runtimeGuard.branchContinuityGate.reasonCode, null);
});

test('daddy-autopilot branchDecision close deletes continuity state without re-persisting', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'valua-codex-worker-branch-close-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const baseSha = childProcess
    .execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    .trim();

  const outputPayload = {
    outcome: 'done',
    note: 'close continuity',
    commitSha: '',
    autopilotControl: {
      workstream: 'main',
      branchDecision: 'close',
      branchDecisionReason: 'workstream_complete',
    },
    followUps: [
      {
        to: ['frontend'],
        title: 'execute follow-up',
        body: 'run it',
        signals: {
          kind: 'EXECUTE',
          phase: 'execute',
          rootId: 'root-close',
          parentId: 't1',
          smoke: false,
        },
        references: {
          git: {
            baseSha,
            baseBranch: 'main',
            integrationBranch: 'main',
          },
          integration: {
            requiredIntegrationBranch: 'main',
          },
        },
      },
    ],
  };

  await writeExecutable(
    dummyCodex,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'echo "session id: session-branch-close" >&2',
      'out=""',
      'for ((i=1; i<=$#; i++)); do',
      '  arg="${!i}"',
      '  if [[ "$arg" == "-o" ]]; then j=$((i+1)); out="${!j}"; fi',
      'done',
      'if [[ -n "$out" ]]; then',
      "  cat > \"$out\" <<'JSON'",
      JSON.stringify(outputPayload),
      'JSON',
      'fi',
      '',
    ].join('\n'),
  );

  const roster = {
    orchestratorName: 'daddy-orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'daddy-autopilot',
    agents: [
      {
        name: 'daddy-autopilot',
        role: 'autopilot-worker',
        skills: [],
        workdir: '$REPO_ROOT',
        startCommand: 'node scripts/agent-codex-worker.mjs --agent daddy-autopilot',
      },
      {
        name: 'frontend',
        role: 'codex-worker',
        skills: [],
        workdir: '$REPO_ROOT',
        startCommand: 'node scripts/agent-codex-worker.mjs --agent frontend',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');

  await writeTask({
    busRoot,
    agentName: 'daddy-autopilot',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['daddy-autopilot'],
      from: 'daddy',
      title: 'close branch continuity',
      signals: { kind: 'USER_REQUEST', rootId: 'root-close' },
    },
    body: 'close this workstream',
  });

  const env = {
    ...BASE_ENV,
    VALUA_AGENT_BUS_DIR: busRoot,
    AGENTIC_AUTOPILOT_DELEGATE_GATE: '0',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'daddy-autopilot',
      '--bus-root',
      busRoot,
      '--roster',
      rosterPath,
      '--once',
      '--poll-ms',
      '10',
      '--codex-bin',
      dummyCodex,
    ],
    { cwd: repoRoot, env },
  );
  assert.equal(run.code, 0, run.stderr || run.stdout);

  const frontendNewDir = path.join(busRoot, 'inbox', 'frontend', 'new');
  const files = await fs.readdir(frontendNewDir);
  assert.ok(files.length >= 1, 'expected execute follow-up');
  const raw = await fs.readFile(path.join(frontendNewDir, files[0]), 'utf8');
  const parts = raw.match(/^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/);
  assert.ok(parts, 'expected follow-up frontmatter');
  const meta = JSON.parse(parts[1]);
  assert.equal(meta.references?.git?.workBranch, 'wip/frontend/root-close/main');

  const continuityDir = path.join(busRoot, 'state', 'branch-continuity');
  let continuityFiles = [];
  try {
    continuityFiles = await fs.readdir(continuityDir);
  } catch {
    continuityFiles = [];
  }
  assert.equal(continuityFiles.length, 0);
});

test('non-autopilot tolerates missing local commit object during source delta lookup', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'valua-codex-worker-source-delta-git-error-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const taskRepo = path.join(tmp, 'task-repo');
  const dummyCodex = path.join(tmp, 'dummy-codex');

  await fs.mkdir(taskRepo, { recursive: true });
  childProcess.execFileSync('git', ['init'], { cwd: taskRepo, stdio: ['ignore', 'ignore', 'ignore'] });
  childProcess.execFileSync('git', ['config', 'user.email', 'ci@example.com'], {
    cwd: taskRepo,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  childProcess.execFileSync('git', ['config', 'user.name', 'CI'], { cwd: taskRepo, stdio: ['ignore', 'ignore', 'ignore'] });
  await fs.writeFile(path.join(taskRepo, 'README.md'), '# temp repo\n', 'utf8');
  childProcess.execFileSync('git', ['add', 'README.md'], { cwd: taskRepo, stdio: ['ignore', 'ignore', 'ignore'] });
  childProcess.execFileSync('git', ['commit', '-m', 'init'], {
    cwd: taskRepo,
    stdio: ['ignore', 'ignore', 'ignore'],
  });

  await writeExecutable(
    dummyCodex,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'echo "session id: session-source-delta-error" >&2',
      'out=""',
      'for ((i=1; i<=$#; i++)); do',
      '  arg="${!i}"',
      '  if [[ "$arg" == "-o" ]]; then j=$((i+1)); out="${!j}"; fi',
      'done',
      'if [[ -n "$out" ]]; then echo \'{"outcome":"done","note":"candidate","commitSha":"not-a-real-commit","followUps":[]}\' > "$out"; fi',
      '',
    ].join('\n'),
  );

  const roster = {
    orchestratorName: 'daddy-orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'daddy-autopilot',
    agents: [
      {
        name: 'backend',
        role: 'codex-worker',
        skills: [],
        workdir: taskRepo,
        startCommand: 'node scripts/agent-codex-worker.mjs --agent backend',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');

  await writeTask({
    busRoot,
    agentName: 'backend',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['backend'],
      from: 'daddy',
      title: 'source delta should fail closed',
      signals: { kind: 'USER_REQUEST', rootId: 'root-source-delta-error' },
    },
    body: 'attempt done with invalid commit sha',
  });

  const env = {
    ...BASE_ENV,
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'backend',
      '--bus-root',
      busRoot,
      '--roster',
      rosterPath,
      '--once',
      '--poll-ms',
      '10',
      '--codex-bin',
      dummyCodex,
    ],
    { cwd: repoRoot, env },
  );
  assert.equal(run.code, 0, run.stderr || run.stdout);

  const receiptPath = path.join(busRoot, 'receipts', 'backend', 't1.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(receipt.outcome, 'done');
  assert.match(receipt.note, /candidate/i);
});

test('daddy-autopilot delegate gate treats untracked source files as source delta', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'valua-codex-worker-autopilot-untracked-source-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const taskRepo = path.join(tmp, 'task-repo');
  const dummyCodex = path.join(tmp, 'dummy-codex');

  await fs.mkdir(taskRepo, { recursive: true });
  childProcess.execFileSync('git', ['init'], { cwd: taskRepo, stdio: ['ignore', 'ignore', 'ignore'] });
  childProcess.execFileSync('git', ['config', 'user.email', 'ci@example.com'], {
    cwd: taskRepo,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  childProcess.execFileSync('git', ['config', 'user.name', 'CI'], { cwd: taskRepo, stdio: ['ignore', 'ignore', 'ignore'] });
  await fs.writeFile(path.join(taskRepo, 'README.md'), '# temp repo\n', 'utf8');
  childProcess.execFileSync('git', ['add', 'README.md'], { cwd: taskRepo, stdio: ['ignore', 'ignore', 'ignore'] });
  childProcess.execFileSync('git', ['commit', '-m', 'init'], {
    cwd: taskRepo,
    stdio: ['ignore', 'ignore', 'ignore'],
  });

  await fs.mkdir(path.join(taskRepo, 'src'), { recursive: true });
  await fs.writeFile(path.join(taskRepo, 'src', 'new-feature.js'), 'export const value = 1;\n', 'utf8');

  await writeExecutable(
    dummyCodex,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'echo "session id: session-untracked-source" >&2',
      'out=""',
      'for ((i=1; i<=$#; i++)); do',
      '  arg="${!i}"',
      '  if [[ "$arg" == "-o" ]]; then j=$((i+1)); out="${!j}"; fi',
      'done',
      'if [[ -n "$out" ]]; then echo \'{"outcome":"done","note":"candidate","commitSha":"","followUps":[]}\' > "$out"; fi',
      '',
    ].join('\n'),
  );

  const roster = {
    orchestratorName: 'daddy-orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'daddy-autopilot',
    agents: [
      {
        name: 'daddy-autopilot',
        role: 'autopilot-worker',
        skills: [],
        workdir: taskRepo,
        startCommand: 'node scripts/agent-codex-worker.mjs --agent daddy-autopilot',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');

  await writeTask({
    busRoot,
    agentName: 'daddy-autopilot',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['daddy-autopilot'],
      from: 'daddy',
      title: 'delegate check',
      signals: { kind: 'USER_REQUEST', rootId: 'root-untracked' },
    },
    body: 'handle untracked source change',
  });

  const env = {
    ...BASE_ENV,
    VALUA_AGENT_BUS_DIR: busRoot,
    AGENTIC_AUTOPILOT_DELEGATE_GATE: '1',
    AGENTIC_CODE_QUALITY_GATE: '0',
    VALUA_AUTOPILOT_INCLUDE_DEPLOY_JSON: '0',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'daddy-autopilot',
      '--bus-root',
      busRoot,
      '--roster',
      rosterPath,
      '--once',
      '--poll-ms',
      '10',
      '--codex-bin',
      dummyCodex,
    ],
    { cwd: repoRoot, env },
  );
  assert.equal(run.code, 0, run.stderr || run.stdout);

  const receiptPath = path.join(busRoot, 'receipts', 'daddy-autopilot', 't1.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(receipt.outcome, 'blocked');
  assert.match(receipt.note, /delegate_required/);
  assert.equal(receipt.receiptExtra.runtimeGuard.delegationGate.reasonCode, 'delegate_required');
  assert.ok(receipt.receiptExtra.runtimeGuard.delegationGate.sourceFilesCount >= 1);
});

test('daddy-autopilot delegate gate fails closed for unreadable untracked source files', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'valua-codex-worker-autopilot-unreadable-untracked-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const taskRepo = path.join(tmp, 'task-repo');
  const dummyCodex = path.join(tmp, 'dummy-codex');

  await fs.mkdir(taskRepo, { recursive: true });
  childProcess.execFileSync('git', ['init'], { cwd: taskRepo, stdio: ['ignore', 'ignore', 'ignore'] });
  childProcess.execFileSync('git', ['config', 'user.email', 'ci@example.com'], {
    cwd: taskRepo,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  childProcess.execFileSync('git', ['config', 'user.name', 'CI'], { cwd: taskRepo, stdio: ['ignore', 'ignore', 'ignore'] });
  await fs.writeFile(path.join(taskRepo, 'README.md'), '# temp repo\n', 'utf8');
  childProcess.execFileSync('git', ['add', 'README.md'], { cwd: taskRepo, stdio: ['ignore', 'ignore', 'ignore'] });
  childProcess.execFileSync('git', ['commit', '-m', 'init'], {
    cwd: taskRepo,
    stdio: ['ignore', 'ignore', 'ignore'],
  });

  await fs.mkdir(path.join(taskRepo, 'src'), { recursive: true });
  const unreadablePath = path.join(taskRepo, 'src', 'secret-change.js');
  await fs.writeFile(unreadablePath, 'export const value = 1;\n', 'utf8');
  await fs.chmod(unreadablePath, 0);

  const outputPayload = {
    outcome: 'done',
    note: 'candidate',
    commitSha: '',
    followUps: [],
    autopilotControl: {
      executionMode: 'tiny_fixup',
      tinyFixJustification: 'small safe change',
    },
  };

  await writeExecutable(
    dummyCodex,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'echo "session id: session-unreadable-untracked" >&2',
      'out=""',
      'for ((i=1; i<=$#; i++)); do',
      '  arg="${!i}"',
      '  if [[ "$arg" == "-o" ]]; then j=$((i+1)); out="${!j}"; fi',
      'done',
      'if [[ -n "$out" ]]; then',
      "  cat > \"$out\" <<'JSON'",
      JSON.stringify(outputPayload),
      'JSON',
      'fi',
      '',
    ].join('\n'),
  );

  const roster = {
    orchestratorName: 'daddy-orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'daddy-autopilot',
    agents: [
      {
        name: 'daddy-autopilot',
        role: 'autopilot-worker',
        skills: [],
        workdir: taskRepo,
        startCommand: 'node scripts/agent-codex-worker.mjs --agent daddy-autopilot',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');

  await writeTask({
    busRoot,
    agentName: 'daddy-autopilot',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['daddy-autopilot'],
      from: 'daddy',
      title: 'delegate check unreadable',
      signals: { kind: 'USER_REQUEST', rootId: 'root-unreadable' },
    },
    body: 'handle unreadable untracked source change',
  });

  const env = {
    ...BASE_ENV,
    VALUA_AGENT_BUS_DIR: busRoot,
    AGENTIC_AUTOPILOT_DELEGATE_GATE: '1',
    AGENTIC_CODE_QUALITY_GATE: '0',
    VALUA_AUTOPILOT_INCLUDE_DEPLOY_JSON: '0',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'daddy-autopilot',
      '--bus-root',
      busRoot,
      '--roster',
      rosterPath,
      '--once',
      '--poll-ms',
      '10',
      '--codex-bin',
      dummyCodex,
    ],
    { cwd: repoRoot, env },
  );
  assert.equal(run.code, 0, run.stderr || run.stdout);

  const receiptPath = path.join(busRoot, 'receipts', 'daddy-autopilot', 't1.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(receipt.outcome, 'blocked');
  assert.match(receipt.note, /tiny_fix_threshold_exceeded/);
  assert.equal(receipt.receiptExtra.runtimeGuard.delegationGate.reasonCode, 'tiny_fix_threshold_exceeded');
  assert.ok(receipt.receiptExtra.runtimeGuard.delegationGate.sourceLineDelta > 30);
});

test('daddy-autopilot code-quality gate does not retry when AGENTIC_GATE_AUTOREMEDIATE_RETRIES=0', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'valua-codex-worker-autopilot-quality-no-retry-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const countFile = path.join(tmp, 'count.txt');

  await writeExecutable(
    dummyCodex,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `COUNT_FILE=${JSON.stringify(countFile)}`,
      'n=0',
      'if [[ -f "$COUNT_FILE" ]]; then n=$(cat "$COUNT_FILE"); fi',
      'n=$((n+1))',
      'echo "$n" > "$COUNT_FILE"',
      'echo "session id: session-quality-no-retry" >&2',
      'out=""',
      'for ((i=1; i<=$#; i++)); do',
      '  arg="${!i}"',
      '  if [[ "$arg" == "-o" ]]; then j=$((i+1)); out="${!j}"; fi',
      'done',
      'if [[ -n "$out" ]]; then echo \'{"outcome":"done","note":"first-pass","commitSha":"","followUps":[],"review":null}\' > "$out"; fi',
      '',
    ].join('\n'),
  );

  const roster = {
    orchestratorName: 'daddy-orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'daddy-autopilot',
    agents: [
      {
        name: 'daddy-autopilot',
        role: 'autopilot-worker',
        skills: [],
        workdir: '$REPO_ROOT',
        startCommand: 'node scripts/agent-codex-worker.mjs --agent daddy-autopilot',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');

  await writeTask({
    busRoot,
    agentName: 'daddy-autopilot',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['daddy-autopilot'],
      from: 'daddy',
      title: 'quality no retry',
      signals: { kind: 'USER_REQUEST', rootId: 'root-quality-no-retry' },
    },
    body: 'handle quality gate no-retry path',
  });

  const env = {
    ...BASE_ENV,
    VALUA_AGENT_BUS_DIR: busRoot,
    AGENTIC_CODE_QUALITY_GATE: '1',
    AGENTIC_CODE_QUALITY_GATE_KINDS: 'USER_REQUEST',
    AGENTIC_GATE_AUTOREMEDIATE_RETRIES: '0',
    AGENTIC_AUTOPILOT_DELEGATE_GATE: '0',
    VALUA_AUTOPILOT_INCLUDE_DEPLOY_JSON: '0',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'daddy-autopilot',
      '--bus-root',
      busRoot,
      '--roster',
      rosterPath,
      '--once',
      '--poll-ms',
      '10',
      '--codex-bin',
      dummyCodex,
    ],
    { cwd: repoRoot, env },
  );
  assert.equal(run.code, 0, run.stderr || run.stdout);

  assert.equal(Number(await fs.readFile(countFile, 'utf8')), 1);

  const receiptPath = path.join(busRoot, 'receipts', 'daddy-autopilot', 't1.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(receipt.outcome, 'blocked');
  assert.equal(receipt.receiptExtra.runtimeGuard.codeQualityGate.retryCount, 0);
});

test('daddy-autopilot code-quality gate retries once for recoverable missing qualityReview fields', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'valua-codex-worker-autopilot-quality-retry-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const countFile = path.join(tmp, 'count.txt');
  const promptPath = path.join(tmp, 'dummy-codex.prompt.txt');

  await writeExecutable(
    dummyCodex,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `COUNT_FILE=${JSON.stringify(countFile)}`,
      'n=0',
      'if [[ -f "$COUNT_FILE" ]]; then n=$(cat "$COUNT_FILE"); fi',
      'n=$((n+1))',
      'echo "$n" > "$COUNT_FILE"',
      'cat > "${DUMMY_PROMPT_PATH}.${n}"',
      'echo "session id: session-quality-retry" >&2',
      'out=""',
      'for ((i=1; i<=$#; i++)); do',
      '  arg="${!i}"',
      '  if [[ "$arg" == "-o" ]]; then j=$((i+1)); out="${!j}"; fi',
      'done',
      'if [[ -z "$out" ]]; then exit 0; fi',
      'if [[ "$n" -eq 1 ]]; then',
      '  echo \'{"outcome":"done","note":"first-pass","commitSha":"","followUps":[],"review":null}\' > "$out"',
      'else',
      '  echo \'{"outcome":"done","note":"quality-fixed","commitSha":"","followUps":[],"review":null,"qualityReview":{"summary":"extended the existing worker quality path and checked coupled coverage","legacyDebtWarnings":0,"hardRuleChecks":{"codeVolume":"trimmed the worker quality path in place; no additive-only gate branch","noDuplication":"reused scripts/agent-codex-worker.mjs instead of adding a new helper","shortestPath":"kept the direct gate call and receipt flow together","cleanup":"did not add temp state beyond .codex/quality/logs artifacts","anticipateConsequences":"checked app-server tests and runtime docs in the same patch","simplicity":"edited the existing prompt and validation path in place"}}}\' > "$out"',
      'fi',
      '',
    ].join('\n'),
  );

  const roster = {
    orchestratorName: 'daddy-orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'daddy-autopilot',
    agents: [
      {
        name: 'daddy-autopilot',
        role: 'autopilot-worker',
        skills: [],
        workdir: '$REPO_ROOT',
        startCommand: 'node scripts/agent-codex-worker.mjs --agent daddy-autopilot',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');

  await writeTask({
    busRoot,
    agentName: 'daddy-autopilot',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['daddy-autopilot'],
      from: 'daddy',
      title: 'quality retry',
      signals: { kind: 'USER_REQUEST', rootId: 'root-quality' },
    },
    body: 'handle quality gate retry',
  });

  const env = {
    ...BASE_ENV,
    VALUA_AGENT_BUS_DIR: busRoot,
    DUMMY_PROMPT_PATH: promptPath,
    AGENTIC_CODE_QUALITY_GATE: '1',
    AGENTIC_CODE_QUALITY_GATE_KINDS: 'USER_REQUEST',
    AGENTIC_AUTOPILOT_DELEGATE_GATE: '0',
    VALUA_AUTOPILOT_INCLUDE_DEPLOY_JSON: '0',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'daddy-autopilot',
      '--bus-root',
      busRoot,
      '--roster',
      rosterPath,
      '--once',
      '--poll-ms',
      '10',
      '--codex-bin',
      dummyCodex,
    ],
    { cwd: repoRoot, env },
  );
  assert.equal(run.code, 0, run.stderr || run.stdout);

  assert.equal(Number(await fs.readFile(countFile, 'utf8')), 2);
  const prompt2 = await fs.readFile(`${promptPath}.2`, 'utf8');
  assert.match(prompt2, /RETRY REQUIREMENT/);
  assert.match(prompt2, /reasonCode=missing_quality_review_fields/);
  assert.match(prompt2, /active repo\/adapter quality skill guidance already listed above/i);
  assert.match(prompt2, /Before editing, inspect the current implementation, search for reuse targets, trace coupled docs\/tests\/contracts, then implement the smallest direct fix/i);
  assert.match(prompt2, /Before returning outcome="done", run this self-review in order:/i);
  assert.match(prompt2, /1\. reuse:/i);
  assert.match(prompt2, /2\. quality:/i);
  assert.match(prompt2, /3\. dependency impact:/i);

  const receiptPath = path.join(busRoot, 'receipts', 'daddy-autopilot', 't1.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(receipt.outcome, 'done');
  assert.equal(receipt.note, 'quality-fixed');
  assert.equal(receipt.receiptExtra.runtimeGuard.codeQualityGate.retryCount, 1);
  assert.deepEqual(receipt.receiptExtra.runtimeGuard.codeQualityGate.reasonCodes, []);
});

test('daddy-autopilot review gate bypasses fast-path and retries once for invalid review output', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'valua-codex-worker-autopilot-review-gate-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const countFile = path.join(tmp, 'count.txt');
  const promptPath = path.join(tmp, 'dummy-codex.prompt.txt');

  await writeExecutable(
    dummyCodex,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `COUNT_FILE=${JSON.stringify(countFile)}`,
      'n=0',
      'if [[ -f "$COUNT_FILE" ]]; then n=$(cat "$COUNT_FILE"); fi',
      'n=$((n+1))',
      'echo "$n" > "$COUNT_FILE"',
      'cat > "${DUMMY_PROMPT_PATH}.${n}"',
      'echo "session id: session-review-gate" >&2',
      'out=""',
      'for ((i=1; i<=$#; i++)); do',
      '  arg="${!i}"',
      '  if [[ "$arg" == "-o" ]]; then j=$((i+1)); out="${!j}"; fi',
      'done',
      'if [[ -z "$out" ]]; then exit 0; fi',
      'if [[ "$n" -eq 1 ]]; then',
      '  echo \'{"outcome":"done","note":"missing-review","commitSha":"","followUps":[]}\' > "$out"',
      'else',
      '  echo \'{"outcome":"done","note":"reviewed","commitSha":"","followUps":[{"to":["frontend"],"title":"fix","body":"please fix","signals":{"kind":"EXECUTE","phase":"fix","rootId":"root-1","parentId":"t1","smoke":false}}],"review":{"ran":true,"method":"built_in_review","targetCommitSha":"abc123","summary":"P1 src/app.ts:10 - fix required","findingsCount":1,"verdict":"changes_requested","evidence":{"artifactPath":"artifacts/daddy-autopilot/reviews/t1.custom.md","sectionsPresent":["findings","severity","file_refs","actions"]}}}\' > "$out"',
      'fi',
      '',
    ].join('\n'),
  );

  const roster = {
    orchestratorName: 'daddy-orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'daddy-autopilot',
    agents: [
      {
        name: 'daddy-autopilot',
        role: 'autopilot-worker',
        skills: [],
        workdir: '$REPO_ROOT',
        startCommand: 'node scripts/agent-codex-worker.mjs --agent daddy-autopilot',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');

  await writeTask({
    busRoot,
    agentName: 'daddy-autopilot',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['daddy-autopilot'],
      from: 'daddy-orchestrator',
      title: 'digest',
      signals: {
        kind: 'ORCHESTRATOR_UPDATE',
        sourceKind: 'TASK_COMPLETE',
        reviewRequired: true,
        reviewTarget: { sourceTaskId: 'exec-1', sourceAgent: 'frontend', sourceKind: 'EXECUTE', commitSha: 'abc123' },
      },
      references: { completedTaskKind: 'EXECUTE' },
    },
    body: 'digest body',
  });

  const env = {
    ...BASE_ENV,
    VALUA_AGENT_BUS_DIR: busRoot,
    DUMMY_PROMPT_PATH: promptPath,
    AGENTIC_AUTOPILOT_DIGEST_FASTPATH: '1',
    AGENTIC_AUTOPILOT_DIGEST_FASTPATH_ALLOWLIST: 'TASK_COMPLETE:EXECUTE',
    VALUA_AUTOPILOT_INCLUDE_DEPLOY_JSON: '0',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'daddy-autopilot',
      '--bus-root',
      busRoot,
      '--roster',
      rosterPath,
      '--once',
      '--poll-ms',
      '10',
      '--codex-bin',
      dummyCodex,
    ],
    { cwd: repoRoot, env },
  );
  assert.equal(run.code, 0, run.stderr || run.stdout);

  // One invalid attempt + one retry with review contract.
  assert.equal(Number(await fs.readFile(countFile, 'utf8')), 2);

  const prompt1 = await fs.readFile(`${promptPath}.1`, 'utf8');
  const prompt2 = await fs.readFile(`${promptPath}.2`, 'utf8');
  assert.match(prompt1, /MANDATORY REVIEW GATE/);
  assert.match(prompt2, /RETRY REQUIREMENT/);

  const receiptPath = path.join(busRoot, 'receipts', 'daddy-autopilot', 't1.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(receipt.outcome, 'done');
  assert.equal(receipt.note, 'reviewed');
  assert.equal(receipt.receiptExtra.outcome, 'done');
  assert.equal(receipt.receiptExtra.note, 'reviewed');
  assert.equal(receipt.receiptExtra.review.verdict, 'changes_requested');
  assert.equal(receipt.receiptExtra.dispatchedFollowUps.length, 1);
  assert.equal(receipt.receiptExtra.reviewArtifactPath, 'artifacts/daddy-autopilot/reviews/t1.custom.md');
  assert.equal(receipt.receiptExtra.runtimeGuard.engineModeGate.requiredMode, 'app-server');
  assert.equal(receipt.receiptExtra.runtimeGuard.engineModeGate.pass, true);

  const artifact = await fs.readFile(path.join(busRoot, 'artifacts', 'daddy-autopilot', 'reviews', 't1.custom.md'), 'utf8');
  assert.match(artifact, /Reviewed Commit/);
  assert.match(artifact, /Decision/);
});

test('daddy-autopilot review gate retries when review artifactPath escapes artifacts subtree', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'valua-codex-worker-autopilot-review-artifact-path-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const countFile = path.join(tmp, 'count.txt');
  const promptPath = path.join(tmp, 'dummy-codex.prompt.txt');

  await writeExecutable(
    dummyCodex,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `COUNT_FILE=${JSON.stringify(countFile)}`,
      'n=0',
      'if [[ -f "$COUNT_FILE" ]]; then n=$(cat "$COUNT_FILE"); fi',
      'n=$((n+1))',
      'echo "$n" > "$COUNT_FILE"',
      'cat > "${DUMMY_PROMPT_PATH}.${n}"',
      'echo "session id: session-review-artifact-path" >&2',
      'out=""',
      'for ((i=1; i<=$#; i++)); do',
      '  arg="${!i}"',
      '  if [[ "$arg" == "-o" ]]; then j=$((i+1)); out="${!j}"; fi',
      'done',
      'if [[ -z "$out" ]]; then exit 0; fi',
      'if [[ "$n" -eq 1 ]]; then',
      '  echo \'{"outcome":"done","note":"outside-artifacts","commitSha":"","followUps":[{"to":["frontend"],"title":"fix","body":"please fix","signals":{"kind":"EXECUTE","phase":"fix","rootId":"root-1","parentId":"t1","smoke":false}}],"review":{"ran":true,"method":"built_in_review","targetCommitSha":"abc123","summary":"P1 src/app.ts:10 - fix required","findingsCount":1,"verdict":"changes_requested","evidence":{"artifactPath":"state/review.md","sectionsPresent":["findings","severity","file_refs","actions"]}}}\' > "$out"',
      'else',
      '  echo \'{"outcome":"done","note":"reviewed","commitSha":"","followUps":[{"to":["frontend"],"title":"fix","body":"please fix","signals":{"kind":"EXECUTE","phase":"fix","rootId":"root-1","parentId":"t1","smoke":false}}],"review":{"ran":true,"method":"built_in_review","targetCommitSha":"abc123","summary":"P1 src/app.ts:10 - fix required","findingsCount":1,"verdict":"changes_requested","evidence":{"artifactPath":"artifacts/daddy-autopilot/reviews/t1.custom.md","sectionsPresent":["findings","severity","file_refs","actions"]}}}\' > "$out"',
      'fi',
      '',
    ].join('\n'),
  );

  const roster = {
    orchestratorName: 'daddy-orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'daddy-autopilot',
    agents: [
      {
        name: 'daddy-autopilot',
        role: 'autopilot-worker',
        skills: [],
        workdir: '$REPO_ROOT',
        startCommand: 'node scripts/agent-codex-worker.mjs --agent daddy-autopilot',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');

  await writeTask({
    busRoot,
    agentName: 'daddy-autopilot',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['daddy-autopilot'],
      from: 'daddy-orchestrator',
      title: 'digest',
      signals: {
        kind: 'ORCHESTRATOR_UPDATE',
        sourceKind: 'TASK_COMPLETE',
        reviewRequired: true,
        reviewTarget: { sourceTaskId: 'exec-1', sourceAgent: 'frontend', sourceKind: 'EXECUTE', commitSha: 'abc123' },
      },
      references: { completedTaskKind: 'EXECUTE' },
    },
    body: 'digest body',
  });

  const env = {
    ...BASE_ENV,
    VALUA_AGENT_BUS_DIR: busRoot,
    DUMMY_PROMPT_PATH: promptPath,
    AGENTIC_AUTOPILOT_DIGEST_FASTPATH: '1',
    AGENTIC_AUTOPILOT_DIGEST_FASTPATH_ALLOWLIST: 'TASK_COMPLETE:EXECUTE',
    VALUA_AUTOPILOT_INCLUDE_DEPLOY_JSON: '0',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'daddy-autopilot',
      '--bus-root',
      busRoot,
      '--roster',
      rosterPath,
      '--once',
      '--poll-ms',
      '10',
      '--codex-bin',
      dummyCodex,
    ],
    { cwd: repoRoot, env },
  );
  assert.equal(run.code, 0, run.stderr || run.stdout);

  // First attempt fails review-gate path validation; second succeeds.
  assert.equal(Number(await fs.readFile(countFile, 'utf8')), 2);
  const prompt2 = await fs.readFile(`${promptPath}.2`, 'utf8');
  assert.match(prompt2, /RETRY REQUIREMENT/);
  assert.match(prompt2, /artifactPath/i);

  const receiptPath = path.join(busRoot, 'receipts', 'daddy-autopilot', 't1.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(receipt.outcome, 'done');
  assert.equal(receipt.note, 'reviewed');
  assert.equal(receipt.receiptExtra.outcome, 'done');
  assert.equal(receipt.receiptExtra.note, 'reviewed');
  assert.equal(receipt.receiptExtra.reviewArtifactPath, 'artifacts/daddy-autopilot/reviews/t1.custom.md');
  assert.equal(receipt.receiptExtra.runtimeGuard.engineModeGate.requiredMode, 'app-server');
  assert.equal(receipt.receiptExtra.runtimeGuard.engineModeGate.pass, true);
});
