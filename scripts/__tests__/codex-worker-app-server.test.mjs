import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import childProcess from 'node:child_process';
import { ensureBusRoot } from '../lib/agentbus.mjs';
import {
  getControllerHousekeepingStatePath,
  stageControllerHousekeepingSuspension,
} from '../lib/controller-housekeeping.mjs';

function buildHermeticBaseEnv() {
  // Strip ambient runtime toggles so each test controls the worker env explicitly.
  const env = { ...process.env };
  const testOnlyEnvKeys = new Set([
    'SPLIT_REVIEW_TURN_IDS',
    'REVIEW_COMPLETED_BEFORE_EXIT',
    'STALE_COMPLETION_AFTER_UPDATE',
    'STALE_REVIEW_COMPLETION_AFTER_UPDATE',
  ]);
  for (const key of Object.keys(env)) {
    if (key.startsWith('AGENTIC_') || key.startsWith('VALUA_') || testOnlyEnvKeys.has(key)) {
      delete env[key];
    }
  }
  return env;
}

const BASE_ENV = buildHermeticBaseEnv();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function spawnProcess(cmd, args, { cwd, env }) {
  return new Promise((resolve) => {
    const proc = childProcess.spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let killTimer = null;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      resolve(result);
    };
    const timeout = setTimeout(() => {
      stderr += '\n[test helper] timed out waiting for child process\n';
      try {
        proc.kill('SIGTERM');
      } catch (err) {
        if (err?.code !== 'ESRCH') {
          stderr += `\n[test helper] SIGTERM failed: ${(err && err.message) || String(err)}\n`;
        }
      }
      killTimer = setTimeout(() => {
        stderr += '\n[test helper] forced SIGKILL after SIGTERM grace window\n';
        try {
          proc.kill('SIGKILL');
        } catch (err) {
          if (err?.code !== 'ESRCH') {
            stderr += `\n[test helper] SIGKILL failed: ${(err && err.message) || String(err)}\n`;
          }
        }
      }, 1000);
      killTimer.unref?.();
    }, 10_000);
    timeout.unref?.();
    proc.stdout.on('data', (d) => (stdout += d.toString('utf8')));
    proc.stderr.on('data', (d) => (stderr += d.toString('utf8')));
    proc.on('error', (err) => finish({ code: 1, stdout, stderr: `${stderr}\n${(err && err.message) || String(err)}` }));
    proc.on('close', (code, signal) => {
      const exitCode = code ?? (signal ? 1 : 0);
      finish({ code: exitCode, stdout, stderr });
    });
  });
}

async function writeExecutable(filePath, contents) {
  await fs.writeFile(filePath, contents, 'utf8');
  await fs.chmod(filePath, 0o755);
}

async function writeTask({ busRoot, agentName, taskId, meta, body }) {
  const inbox = path.join(busRoot, 'inbox', agentName, 'new');
  await fs.mkdir(inbox, { recursive: true });
  const p = path.join(inbox, `${taskId}.md`);
  const raw = `---\n${JSON.stringify(meta)}\n---\n\n${body}\n`;
  await fs.writeFile(p, raw, 'utf8');
  return p;
}

function parseTaskMeta(rawMarkdown) {
  const match = /^---\n([\s\S]*?)\n---/.exec(String(rawMarkdown || ''));
  if (!match) throw new Error('missing task frontmatter');
  return JSON.parse(match[1]);
}

async function waitForOpusConsultRequestMeta({ busRoot, timeoutMs = 4_000 }) {
  const inboxDir = path.join(busRoot, 'inbox', 'opus-consult', 'new');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    let entries = [];
    try {
      entries = await fs.readdir(inboxDir);
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.md')) continue;
      const raw = await fs.readFile(path.join(inboxDir, entry), 'utf8');
      const meta = parseTaskMeta(raw);
      if (meta?.signals?.kind === 'OPUS_CONSULT_REQUEST') {
        return meta;
      }
    }
    await sleep(25);
  }
  throw new Error('timed out waiting for OPUS_CONSULT_REQUEST');
}

function buildValidConsultResponsePayload({ consultId, round, suggestedPlan = [] }) {
  const payload = {
    version: 'v1',
    consultId,
    round,
    final: true,
    verdict: 'warn',
    rationale:
      'Validated consult response for deterministic writer-preflight challenge coverage with explicit advisory evidence.',
    reasonCode: 'opus_consult_warn',
  };
  payload.suggested_plan = suggestedPlan.length
    ? suggestedPlan
    : ['Challenge the approved preflight before execution and preserve closure evidence.'];
  payload.alternatives = [];
  payload.challenge_points = [];
  payload.code_suggestions = [];
  payload.required_questions = [];
  payload.unresolved_critical_questions = [];
  payload.required_actions = [];
  payload.retry_prompt_patch = '';
  return payload;
}

async function writeAgentRootFocusState({ busRoot, agentName, rootId, branch = '' }) {
  const dir = path.join(busRoot, 'state', 'agent-root-focus');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${agentName}.json`),
    `${JSON.stringify({ updatedAt: new Date().toISOString(), agent: agentName, rootId, branch: branch || null }, null, 2)}\n`,
    'utf8',
  );
}

function runGit(cwd, args) {
  childProcess.execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
}

async function createTestGitWorkdir({
  rootDir,
  dirtyFilePath = '',
  dirtyFileContents = '',
}) {
  const workdir = path.join(rootDir, 'work');
  await fs.mkdir(workdir, { recursive: true });
  runGit(workdir, ['init']);
  runGit(workdir, ['config', 'user.email', 'test@example.com']);
  runGit(workdir, ['config', 'user.name', 'Test User']);
  await fs.writeFile(path.join(workdir, 'README.md'), 'seed\n', 'utf8');
  runGit(workdir, ['add', 'README.md']);
  runGit(workdir, ['commit', '-m', 'seed']);
  if (dirtyFilePath) {
    const abs = path.join(workdir, dirtyFilePath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, dirtyFileContents, 'utf8');
  }
  return workdir;
}

async function installSupportedSkillOpsRuntime({ repoRoot, workdir, skillName = 'cockpit-autopilot' }) {
  await fs.mkdir(path.join(workdir, 'scripts', 'lib'), { recursive: true });
  await fs.copyFile(path.join(repoRoot, 'scripts', 'skillops.mjs'), path.join(workdir, 'scripts', 'skillops.mjs'));
  await fs.copyFile(
    path.join(repoRoot, 'scripts', 'lib', 'skillops-log.mjs'),
    path.join(workdir, 'scripts', 'lib', 'skillops-log.mjs'),
  );
  const skillDir = path.join(workdir, '.codex', 'skills', skillName);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, 'SKILL.md'),
    [
      '---',
      `name: ${skillName}`,
      'description: "SkillOps test skill"',
      '---',
      '',
      '# Skill',
      '',
      '## Learned heuristics (SkillOps)',
      '<!-- SKILLOPS:LEARNED:BEGIN -->',
      '<!-- SKILLOPS:LEARNED:END -->',
      '',
    ].join('\n'),
    'utf8',
  );
}

async function installUnsupportedSkillOpsRuntime({ workdir }) {
  await fs.mkdir(path.join(workdir, 'scripts'), { recursive: true });
  await fs.writeFile(
    path.join(workdir, 'scripts', 'skillops.mjs'),
    [
      'const [, , cmd] = process.argv;',
      'if (cmd === "capabilities") {',
      '  process.stdout.write(JSON.stringify({',
      '    schemaVersion: 1,',
      '    skillopsContractVersion: 1,',
      '    commands: ["lint", "log", "debrief", "distill"],',
      '    statuses: ["new", "processed"],',
      '    distillMode: "durable"',
      '  }) + "\\n");',
      '  process.exit(0);',
      '}',
      'process.stderr.write("unsupported\\n");',
      'process.exit(1);',
      '',
    ].join('\n'),
    'utf8',
  );
}

async function writeSkillOpsProofLog({
  workdir,
  updates = [],
  status = 'pending',
  skillName = 'cockpit-autopilot',
  bodyLines = [],
}) {
  const logPath = path.join(workdir, '.codex', 'skill-ops', 'logs', '2026', '02', 'skillops-proof.md');
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  const updateLines =
    updates.length === 0
      ? [`  ${skillName}: []`]
      : [`  ${skillName}:`, ...updates.map((value) => `    - ${JSON.stringify(value)}`)];
  await fs.writeFile(
    logPath,
    [
      '---',
      'id: skillops-proof',
      'created_at: "2026-02-01T00:00:00Z"',
      `status: ${status}`,
      'processed_at: null',
      'queued_at: null',
      'promotion_task_id: null',
      'skills:',
      `  - ${skillName}`,
      'skill_updates:',
      ...updateLines,
      'title: "SkillOps proof"',
      '---',
      '',
      ...bodyLines,
      '',
    ].join('\n'),
    'utf8',
  );
  return logPath;
}

function buildSingleAutopilotRoster(workdir) {
  return {
    orchestratorName: 'orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'autopilot',
    agents: [
      {
        name: 'autopilot',
        role: 'autopilot-worker',
        skills: [],
        workdir,
        startCommand: 'node scripts/agent-codex-worker.mjs --agent autopilot',
      },
    ],
  };
}

async function setupSkillOpsAutopilotHarness({
  prefix,
  runtime = 'supported',
  skillName = 'cockpit-autopilot',
}) {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const workdir = await createTestGitWorkdir({ rootDir: tmp });
  const worktreesDir = path.join(tmp, 'worktrees');

  if (runtime === 'supported') {
    await installSupportedSkillOpsRuntime({ repoRoot, workdir, skillName });
  } else if (runtime === 'unsupported') {
    await installUnsupportedSkillOpsRuntime({ workdir });
  } else {
    throw new Error(`unsupported skillops runtime fixture: ${runtime}`);
  }

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);
  await fs.writeFile(rosterPath, JSON.stringify(buildSingleAutopilotRoster(workdir), null, 2) + '\n', 'utf8');
  return { repoRoot, tmp, busRoot, rosterPath, dummyCodex, workdir, worktreesDir };
}

async function writeBasicAutopilotUserTask({
  busRoot,
  taskId = 't1',
  rootId = 'root1',
  title = 't1',
  body = 'do t1',
} = {}) {
  return writeTask({
    busRoot,
    agentName: 'autopilot',
    taskId,
    meta: {
      id: taskId,
      to: ['autopilot'],
      from: 'daddy',
      priority: 'P2',
      title,
      signals: { kind: 'USER_REQUEST', rootId },
    },
    body,
  });
}

function buildSkillOpsAutopilotEnv({ busRoot, worktreesDir = '', dummyMode = 'skillops-ok' }) {
  return {
    ...BASE_ENV,
    AGENTIC_AUTOPILOT_DELEGATE_GATE: '0',
    AGENTIC_AUTOPILOT_SKILLOPS_GATE: '1',
    AGENTIC_AUTOPILOT_SKILLOPS_GATE_KINDS: 'USER_REQUEST',
    ...(worktreesDir ? { AGENTIC_WORKTREES_DIR: worktreesDir } : {}),
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_APP_SERVER_TIMEOUT_MS: '2000',
    DUMMY_MODE: dummyMode,
  };
}

async function runAutopilotWorkerOnce({ repoRoot, busRoot, rosterPath, dummyCodex, env }) {
  return spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'autopilot',
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
}

async function runAutopilotWorkerAndReadReceipt({
  repoRoot,
  busRoot,
  rosterPath,
  dummyCodex,
  env,
  taskId = 't1',
}) {
  const run = await runAutopilotWorkerOnce({ repoRoot, busRoot, rosterPath, dummyCodex, env });
  assert.equal(run.code, 0, run.stderr || run.stdout);
  const receiptPath = path.join(busRoot, 'receipts', 'autopilot', `${taskId}.json`);
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  return { run, receipt, receiptPath };
}

test('skillops queued-state fixture threads rootId through deterministic identifiers', () => {
  const state = buildSkillOpsPromotionStateFixture({
    workdir: process.cwd(),
    busRoot: '/tmp/skillops-bus',
    worktreesDir: '/tmp/skillops-worktrees',
    status: 'queued',
    rootId: 'root99',
  });
  assert.equal(state.rootId, 'root99');
  assert.equal(state.promotionTaskId, 'skillops_promotion__autopilot__root99');
  assert.equal(state.planPath, '/tmp/skillops-bus/state/skillops-promotions/autopilot/root99.plan.json');
  assert.equal(state.branch, 'skillops/autopilot/root99');
});

function buildSkillOpsPromotionStateFixture({
  workdir,
  busRoot,
  worktreesDir,
  status,
  queuedAt = '2026-03-15T00:00:00Z',
  failedAt = '',
  reasonCode = '',
  rootId = 'root1',
  sourceTaskId = 't1',
  sourceLogIds = ['skillops-proof'],
  targetPaths = ['.codex/skills/cockpit-autopilot/SKILL.md'],
  promotionTaskId = `skillops_promotion__autopilot__${rootId}`,
}) {
  const state = {
    stateVersion: 2,
    planVersion: 2,
    rootId,
    sourceTaskId,
    controllerAgent: 'autopilot',
    sourceWorkdir: workdir,
    curationWorkdir: path.join(worktreesDir, 'autopilot-skillops-promotion'),
    promotionTaskId,
    planPath: path.join(busRoot, 'state', 'skillops-promotions', 'autopilot', `${rootId}.plan.json`),
    branch: `skillops/autopilot/${rootId}`,
    baseRef: 'main',
    baseSha: childProcess.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workdir, encoding: 'utf8' }).trim(),
    sourceLogIds,
    targetPaths,
    status,
    queuedAt,
  };
  if (failedAt) state.failedAt = failedAt;
  if (reasonCode) state.reasonCode = reasonCode;
  return state;
}

function buildSkillOpsPromotionPlanFixture({
  text,
  skillName = 'cockpit-autopilot',
  logId = 'skillops-proof',
  logPath = '.codex/skill-ops/logs/2026/02/skillops-proof.md',
  durableTarget = '.codex/skills/cockpit-autopilot/SKILL.md',
  sourceLogs = null,
  targets = null,
  targetPaths = null,
  items = null,
  skippableLogIds = [],
} = {}) {
  const effectiveSourceLogs = Array.isArray(sourceLogs)
    ? sourceLogs
    : [
        {
          id: logId,
          relativePath: logPath,
          status: 'pending',
          createdAt: '2026-03-15T00:00:00Z',
        },
      ];
  const effectiveTargets = Array.isArray(targets) ? targets : [{ kind: 'skill', path: durableTarget }];
  const effectiveItems = Array.isArray(items)
    ? items
    : [
        {
          promotionMode: 'learned_block',
          skill: skillName,
          targetFile: durableTarget,
          additions: [{ text, logId, createdAt: '2026-03-15T00:00:00Z' }],
          overflowBullets: [],
          nextContents: '# placeholder',
        },
      ];
  return {
    kind: 'skillops-promotion-plan',
    version: 2,
    schemaVersion: 3,
    generatedAt: '2026-03-15T00:00:00Z',
    sourceRepoRoot: '/tmp/repo',
    maxLearned: 30,
    summary: {
      pendingLogsCount: effectiveSourceLogs.length,
      promotableLogsCount: effectiveSourceLogs.length,
      missingSkillUpdatesCount: 0,
      emptySkillUpdatesCount: skippableLogIds.length,
      skillsToUpdate: effectiveItems.length,
      additionsCount: effectiveItems.reduce((sum, item) => sum + (Array.isArray(item.additions) ? item.additions.length : 0), 0),
    },
    sourceLogs: effectiveSourceLogs,
    targets: effectiveTargets,
    targetPaths: Array.isArray(targetPaths) ? targetPaths : effectiveTargets.map((entry) => entry.path),
    sourceLogIds: effectiveSourceLogs.map((entry) => entry.id),
    items: effectiveItems,
    skippableLogIds,
  };
}

async function writeSkillOpsPromotionPlanFixture({
  busRoot,
  rootId = 'root1',
  text,
  skillName,
  logId,
  logPath,
  durableTarget,
  sourceLogs,
  targets,
  targetPaths,
  items,
  skippableLogIds,
}) {
  const planPath = path.join(busRoot, 'state', 'skillops-promotions', 'autopilot', `${rootId}.plan.json`);
  await fs.mkdir(path.dirname(planPath), { recursive: true });
  await fs.writeFile(
    planPath,
    JSON.stringify(
      buildSkillOpsPromotionPlanFixture({
        text,
        skillName,
        logId,
        logPath,
        durableTarget,
        sourceLogs,
        targets,
        targetPaths,
        items,
        skippableLogIds,
      }),
      null,
      2,
    ) + '\n',
    'utf8',
  );
  return planPath;
}

async function writeQueuedSkillOpsPromotionTask({
  busRoot,
  workdir,
  planPath,
  curationWorkdir,
  sourceWorkdir = workdir,
  title = 'SKILLOPS_PROMOTION: root1',
  body = 'promotion lane',
  taskId = 'skillops_promotion__autopilot__root1',
  rootId = 'root1',
  parentTaskId = 't1',
  workBranch = 'skillops/autopilot/root1',
  baseBranch = 'main',
  baseShaOverride = '',
}) {
  const baseSha =
    String(baseShaOverride || '').trim() ||
    childProcess.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workdir, encoding: 'utf8' }).trim();
  return writeTask({
    busRoot,
    agentName: 'autopilot',
    taskId,
    meta: {
      id: taskId,
      to: ['autopilot'],
      from: 'autopilot',
      priority: 'P2',
      title,
      signals: {
        kind: 'EXECUTE',
        sourceKind: 'SKILLOPS_PROMOTION',
        phase: 'skillops-promotion',
        rootId,
        parentId: parentTaskId,
        notifyOrchestrator: false,
      },
      references: {
        parentTaskId,
        parentRootId: rootId,
        sourceTaskId: parentTaskId,
        sourceWorkdir,
        skillopsPromotion: {
          promotionTaskId: taskId,
          planPath,
          sourceWorkdir,
          curationWorkdir,
        },
        git: {
          baseBranch,
          baseSha,
          workBranch,
          integrationBranch: baseBranch,
        },
      },
    },
    body,
  });
}

async function makeSkillOpsMarkQueuedFail({ workdir }) {
  const scriptPath = path.join(workdir, 'scripts', 'skillops.mjs');
  const original = await fs.readFile(scriptPath, 'utf8');
  await fs.writeFile(
    scriptPath,
    [
      'const statusIndex = process.argv.indexOf("--status");',
      'const requestedStatus = statusIndex >= 0 ? String(process.argv[statusIndex + 1] || "").trim() : "";',
      'if (process.env.FAIL_SKILLOPS_MARK_QUEUED === "1" && process.argv[2] === "mark-promoted" && requestedStatus === "queued") {',
      '  process.stderr.write("simulated queued mark failure\\n");',
      '  process.exit(1);',
      '}',
      '',
      original,
    ].join('\n'),
    'utf8',
  );
}

async function makeSkillOpsCapabilitiesOmitKind({ workdir }) {
  const scriptPath = path.join(workdir, 'scripts', 'skillops.mjs');
  const original = await fs.readFile(scriptPath, 'utf8');
  const next = original.replace("    kind: 'skillops-capabilities',\n", '');
  assert.notEqual(next, original);
  await fs.writeFile(scriptPath, next, 'utf8');
}

async function makeSkillOpsCapabilitiesPayloadFilesMetadataDrift({ workdir }) {
  const scriptPath = path.join(workdir, 'scripts', 'skillops.mjs');
  const original = await fs.readFile(scriptPath, 'utf8');
  const next = original.replace(
    "      'payload-files': { json: true, writes: 'none', requiredFlags: ['--plan'], optionalFlags: ['--json'] },\n",
    "      'payload-files': { json: true, writes: 'none', requiredFlags: ['--plan'] },\n",
  );
  assert.notEqual(next, original);
  await fs.writeFile(scriptPath, next, 'utf8');
}

function commitSkillOpsRuntimeFixture({ workdir, message }) {
  runGit(workdir, ['add', '.']);
  runGit(workdir, ['commit', '-m', message]);
}

async function makeGitWrapperThatFailsScratchRemove({ tmp }) {
  const wrapperDir = path.join(tmp, 'git-wrapper');
  const realGit = childProcess.execFileSync('bash', ['-lc', 'command -v git'], { encoding: 'utf8' }).trim();
  await fs.mkdir(wrapperDir, { recursive: true });
  await writeExecutable(
    path.join(wrapperDir, 'git'),
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `REAL_GIT=${JSON.stringify(realGit)}`,
      'if [[ "${1:-}" == "worktree" && "${2:-}" == "remove" && "${3:-}" == "--force" && "${4:-}" == *"controller-housekeeping"* ]]; then',
      '  echo "simulated scratch remove failure" >&2',
      '  exit 1',
      'fi',
      'exec "$REAL_GIT" "$@"',
      '',
    ].join('\n'),
  );
  return wrapperDir;
}

async function waitForPath(p, { timeoutMs = 5000, pollMs = 25 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await fs.stat(p);
      return true;
    } catch {
      // ignore
    }
    await sleep(pollMs);
  }
  return false;
}

const DUMMY_APP_SERVER = String.raw`#!/usr/bin/env python3
import json
import os
import signal
import sys
import threading
import time
from pathlib import Path

signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
signal.signal(signal.SIGINT, lambda *_: sys.exit(0))

args = sys.argv[1:]
if not args or args[0] != "app-server":
    sys.stderr.write("dummy-codex: expected app-server\n")
    sys.stderr.flush()
    raise SystemExit(2)

arg_log_file = os.environ.get("ARG_LOG_FILE", "")
if arg_log_file:
    Path(arg_log_file).write_text(json.dumps(args), encoding="utf-8")

mode = os.environ.get("DUMMY_MODE", "basic")
count_file = os.environ.get("COUNT_FILE", "")
review_count_file = os.environ.get("REVIEW_COUNT_FILE", "")
server_start_count_file = os.environ.get("SERVER_START_COUNT_FILE", "")
resume_count_file = os.environ.get("RESUME_COUNT_FILE", "")
review_target_sha = os.environ.get("REVIEW_TARGET_SHA", "abc123")
review_scope = os.environ.get("REVIEW_SCOPE", "commit")
review_commits = [part.strip() for part in os.environ.get("REVIEWED_COMMITS", "").split(",") if part.strip()]
review_delay_ms = max(0, int(os.environ.get("REVIEW_DELAY_MS", "0") or "0"))
split_review_turn_ids = os.environ.get("SPLIT_REVIEW_TURN_IDS") == "1"
review_completed_before_exit = os.environ.get("REVIEW_COMPLETED_BEFORE_EXIT") == "1"
stale_completion_after_update = os.environ.get("STALE_COMPLETION_AFTER_UPDATE") == "1"
stale_review_completion_after_update = os.environ.get("STALE_REVIEW_COMPLETION_AFTER_UPDATE") == "1"
started1 = os.environ.get("STARTED1", "")
thread_id = os.environ.get("THREAD_ID", "thread-app")
policy_file = os.environ.get("POLICY_FILE", "")
cwd_log_file = os.environ.get("CWD_LOG_FILE", "")
prompt_log_file = os.environ.get("PROMPT_LOG_FILE", "")

send_lock = threading.Lock()
pending_interrupted = set()
started_written = False
latest_review_completion_sent = False


def read_counter(file_path):
    if not file_path:
        return 0
    try:
        return int(Path(file_path).read_text(encoding="utf-8").strip() or "0")
    except Exception:
        return 0


def write_counter(file_path, value):
    if not file_path:
        return
    Path(file_path).write_text(str(value), encoding="utf-8")


def bump_counter(file_path):
    if not file_path:
        return 0
    value = read_counter(file_path) + 1
    write_counter(file_path, value)
    return value


def send(obj):
    with send_lock:
        sys.stdout.write(json.dumps(obj) + "\n")
        sys.stdout.flush()


def schedule(delay_ms, func):
    timer = threading.Timer(delay_ms / 1000.0, func)
    timer.daemon = True
    timer.start()


def build_preflight_plan(current_mode):
    preflight_plan = {
        "goal": "Investigate scope before tracked edits.",
        "reusePath": "Extend the existing worker path in place.",
        "modularityPlan": "boundary-only:no-extraction-needed",
        "chosenApproach": "Use the existing runtime path with narrow scoped edits.",
        "rejectedApproaches": [
            {
                "approach": "Skip investigation and code immediately.",
                "reason": "That would bypass the required preflight contract.",
            }
        ],
        "touchpoints": ["README.md"],
        "coupledSurfaces": [],
        "riskChecks": ["Verify runtime guards before done."],
        "openQuestions": [],
    }
    if current_mode == "preflight-open-questions":
        preflight_plan["openQuestions"] = ["Still unclear whether reuse covers the touched path."]
    elif current_mode == "preflight-protected-host-missing-extraction":
        preflight_plan["touchpoints"] = ["scripts/agent-codex-worker.mjs"]
        preflight_plan["modularityPlan"] = "Edit the worker file directly without extraction."
    return preflight_plan


def wait_for_interrupt(turn_ids, func, delay_ms=0):
    ids = {str(value) for value in turn_ids if value}

    def worker():
        while True:
            if any(turn_id in pending_interrupted for turn_id in ids):
                if delay_ms:
                    time.sleep(delay_ms / 1000.0)
                func()
                return
            time.sleep(0.02)

    thread = threading.Thread(target=worker, daemon=True)
    thread.start()


if server_start_count_file:
    bump_counter(server_start_count_file)

for raw in sys.stdin:
    try:
        msg = json.loads(raw)
    except Exception:
        continue

    method = msg.get("method")
    msg_id = msg.get("id")

    if msg_id is not None and method == "initialize":
        send({"id": msg_id, "result": {}})
        continue

    if method == "initialized":
        continue

    if msg_id is not None and method == "thread/start":
        send({"id": msg_id, "result": {"thread": {"id": thread_id}}})
        continue

    if msg_id is not None and method == "thread/resume":
        if resume_count_file:
            bump_counter(resume_count_file)
        resumed_thread_id = str(msg.get("params", {}).get("threadId") or thread_id)
        send({"id": msg_id, "result": {"thread": {"id": resumed_thread_id}}})
        continue

    if msg_id is not None and method == "turn/interrupt":
        pending_interrupted.add(str(msg.get("params", {}).get("turnId") or ""))
        send({"id": msg_id, "result": {}})
        continue

    if msg_id is not None and method == "review/start":
        review_attempt = bump_counter(review_count_file)
        turn_id = f"review-{int(time.time() * 1000)}-{review_attempt}"
        started_turn_id = f"{turn_id}-started" if split_review_turn_ids else turn_id
        review_text = f"Built-in review findings attempt {review_attempt}"

        def emit_review_completion():
            global latest_review_completion_sent
            if (not stale_review_completion_after_update) or review_attempt > 1:
                latest_review_completion_sent = True
            send({"method": "turn/completed", "params": {"threadId": thread_id, "turn": {"id": started_turn_id, "status": "completed", "items": []}}})

        send({"id": msg_id, "result": {"turn": {"id": turn_id, "status": "inProgress", "items": []}}})
        send({"method": "turn/started", "params": {"threadId": thread_id, "turn": {"id": started_turn_id, "status": "inProgress", "items": []}}})
        send({"method": "item/started", "params": {"threadId": thread_id, "turnId": turn_id, "item": {"id": f"item-enter-{turn_id}", "type": "enteredReviewMode"}}})
        send({"method": "item/agentMessage/delta", "params": {"threadId": thread_id, "turnId": turn_id, "itemId": f"review-msg-{turn_id}", "delta": review_text}})
        send({"method": "item/completed", "params": {"threadId": thread_id, "turnId": turn_id, "item": {"id": f"review-msg-{turn_id}", "type": "agentMessage", "text": review_text}}})

        if stale_review_completion_after_update and review_attempt == 1:
            wait_for_interrupt([turn_id, started_turn_id], emit_review_completion, 80)
            continue

        if review_delay_ms > 0:
            time.sleep(review_delay_ms / 1000.0)
        if review_completed_before_exit:
            emit_review_completion()
        send({"method": "item/completed", "params": {"threadId": thread_id, "turnId": turn_id, "item": {"id": f"item-exit-{turn_id}", "type": "exitedReviewMode", "review": "Built-in review findings"}}})
        if not review_completed_before_exit:
            if stale_review_completion_after_update and review_attempt > 1:
                time.sleep(0.16)
            emit_review_completion()
        continue

    if msg_id is not None and method == "turn/start":
        bump_counter(count_file)
        prompt = str(((msg.get("params", {}) or {}).get("input") or [{}])[0].get("text") or "")
        current_turn_id = f"turn-{int(time.time() * 1000)}"

        if policy_file:
            Path(policy_file).write_text(json.dumps(msg.get("params", {}).get("sandboxPolicy", None)), encoding="utf-8")
        if cwd_log_file:
            Path(cwd_log_file).write_text(str(msg.get("params", {}).get("cwd") or ""), encoding="utf-8")
        if prompt_log_file:
            prompt_phase = "preflight" if "MANDATORY no-write preflight turn" in prompt else "execute"
            with Path(prompt_log_file).open("a", encoding="utf-8") as handle:
                handle.write(prompt_phase + "\n")

        send({"id": msg_id, "result": {"turn": {"id": current_turn_id, "status": "inProgress", "items": []}}})
        send({"method": "turn/started", "params": {"threadId": thread_id, "turn": {"id": current_turn_id, "status": "inProgress", "items": []}}})

        if (not started_written) and started1:
            started_written = True
            Path(started1).write_text("", encoding="utf-8")

        if "MANDATORY no-write preflight turn" in prompt:
            preflight_plan = build_preflight_plan(mode)
            text = json.dumps({"preflightPlan": preflight_plan})
            send({"method": "item/agentMessage/delta", "params": {"delta": text, "itemId": "am1", "threadId": thread_id, "turnId": current_turn_id}})
            send({"method": "item/completed", "params": {"threadId": thread_id, "turnId": current_turn_id, "item": {"id": "am1", "type": "agentMessage", "text": text}}})
            send({"method": "turn/completed", "params": {"threadId": thread_id, "turn": {"id": current_turn_id, "status": "completed", "items": []}}})
            continue

        if mode == "update" and "SENTINEL_UPDATE" not in prompt:
            stale_turn_id = current_turn_id

            def emit_stale_completion():
                status = "completed" if stale_completion_after_update else "interrupted"
                send({"method": "turn/completed", "params": {"threadId": thread_id, "turn": {"id": stale_turn_id, "status": status, "items": []}}})

            wait_for_interrupt([stale_turn_id], emit_stale_completion, 80 if stale_completion_after_update else 0)
            continue

        if mode == "update" and "SENTINEL_UPDATE" in prompt and stale_completion_after_update:
            payload = {"outcome": "done", "note": "saw-update", "commitSha": "", "followUps": []}
            if "MANDATORY PREFLIGHT CONTRACT" in prompt and "Approved plan hash:" in prompt:
                payload["preflightPlan"] = build_preflight_plan(mode)
            text = json.dumps(payload)
            partial = "{\"outcome\":\"done\",\"note\":\"saw-update\""
            rest = text[len(partial):]
            send({"method": "item/agentMessage/delta", "params": {"delta": partial, "itemId": "am1", "threadId": thread_id, "turnId": current_turn_id}})

            def finish_update():
                send({"method": "item/agentMessage/delta", "params": {"delta": rest, "itemId": "am1", "threadId": thread_id, "turnId": current_turn_id}})
                send({"method": "item/completed", "params": {"threadId": thread_id, "turnId": current_turn_id, "item": {"id": "am1", "type": "agentMessage", "text": text}}})
                send({"method": "turn/completed", "params": {"threadId": thread_id, "turn": {"id": current_turn_id, "status": "completed", "items": []}}})

            schedule(160, finish_update)
            continue

        if mode == "invalid-json":
            text = '{"outcome":"done","note":"broken"'
            send({"method": "item/agentMessage/delta", "params": {"delta": text, "itemId": "am1", "threadId": thread_id, "turnId": current_turn_id}})
            send({"method": "item/completed", "params": {"threadId": thread_id, "turnId": current_turn_id, "item": {"id": "am1", "type": "agentMessage", "text": text}}})
            send({"method": "turn/completed", "params": {"threadId": thread_id, "turn": {"id": current_turn_id, "status": "completed", "items": []}}})
            continue

        note = "saw-update" if "SENTINEL_UPDATE" in prompt else "ok"
        payload = {
            "outcome": "done",
            "note": note,
            "commitSha": os.environ.get("DUMMY_COMMIT_SHA", ""),
            "followUps": [],
        }
        if "MANDATORY PREFLIGHT CONTRACT:" in prompt:
            payload["preflightPlan"] = build_preflight_plan(mode)

        if "Current Opus pre-exec advisory for this turn:" in prompt:
            if mode == "opus-disposition-present":
                payload["note"] = (
                    "ok\n"
                    "Opus disposition OPUS-1: reject - local execution is narrower than dispatch because the change stays inside this worker turn."
                )
            elif mode == "opus-disposition-missing":
                payload["note"] = "ok"

        if mode == "merge-commit-missing-local":
            payload = {
                "outcome": "done",
                "note": os.environ.get("MERGE_NOTE") or "Merged PR112 on master.",
                "commitSha": os.environ.get("MERGE_COMMIT_SHA") or "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "followUps": [],
            }
        elif mode == "skillops-ok":
            payload = {
                "outcome": "done",
                "note": "skillops evidence recorded",
                "commitSha": "",
                "planMarkdown": "",
                "filesToChange": [],
                "testsToRun": [
                    "node scripts/skillops.mjs debrief --skills cockpit-autopilot --title \"autopilot debrief\"",
                    "node scripts/skillops.mjs distill",
                    "node scripts/skillops.mjs lint",
                ],
                "artifacts": [".codex/skill-ops/logs/2026/02/skillops-proof.md"],
                "riskNotes": "",
                "rollbackPlan": "",
                "followUps": [],
                "review": None,
            }
        elif mode == "skillops-missing":
            payload = {
                "outcome": "done",
                "note": "missing skillops evidence",
                "commitSha": "",
                "planMarkdown": "",
                "filesToChange": [],
                "testsToRun": [],
                "artifacts": [],
                "riskNotes": "",
                "rollbackPlan": "",
                "followUps": [],
                "review": None,
            }
        elif mode == "quality-ok":
            payload = {
                "outcome": "done",
                "note": "quality evidence recorded",
                "commitSha": "",
                "planMarkdown": "",
                "filesToChange": [],
                "testsToRun": ["node scripts/code-quality-gate.mjs check --task-kind USER_REQUEST"],
                "artifacts": [".codex/quality/logs/quality-proof.md"],
                "qualityReview": {
                    "summary": "extended existing code-quality path and verified coupled tests/docs",
                    "legacyDebtWarnings": 0,
                    "hardRuleChecks": {
                        "codeVolume": "trimmed the worker quality path in place; no additive-only gate branch",
                        "noDuplication": "reuse=scripts/agent-codex-worker.mjs",
                        "shortestPath": "kept direct gate-to-receipt flow; no extra artifact stage added",
                        "cleanup": "left .codex/quality/logs as the only quality artifact path; no temp state added",
                        "anticipateConsequences": "coupled=scripts/__tests__/codex-worker-app-server.test.mjs,docs/agentic/RUNTIME_FUNCTION_REFERENCE.md",
                        "simplicity": "edited prompt and validation in place; no new review subsystem",
                    },
                },
                "riskNotes": "",
                "rollbackPlan": "",
                "followUps": [],
                "review": None,
            }
        elif mode == "quality-script-only":
            payload = {
                "outcome": "done",
                "note": "script run without explicit quality activation",
                "commitSha": "",
                "planMarkdown": "",
                "filesToChange": [],
                "testsToRun": ["node scripts/code-quality-gate.mjs check --task-kind USER_REQUEST"],
                "artifacts": [".codex/quality/logs/quality-proof.md"],
                "riskNotes": "",
                "rollbackPlan": "",
                "followUps": [],
                "review": None,
            }
        elif mode == "quality-missing":
            payload = {
                "outcome": "done",
                "note": "missing quality evidence",
                "commitSha": "",
                "planMarkdown": "",
                "filesToChange": [],
                "testsToRun": [],
                "artifacts": [],
                "riskNotes": "",
                "rollbackPlan": "",
                "followUps": [],
                "review": None,
            }
        elif mode == "followup-execute":
            payload = {
                "outcome": "done",
                "note": "followup dispatched",
                "commitSha": "",
                "planMarkdown": "",
                "filesToChange": [],
                "testsToRun": [],
                "artifacts": [],
                "riskNotes": "",
                "rollbackPlan": "",
                "followUps": [
                    {
                        "to": ["frontend"],
                        "title": "execute child",
                        "body": "implement child task",
                        "signals": {"kind": "EXECUTE", "phase": "execute", "rootId": "root1", "parentId": "t1", "smoke": False},
                    }
                ],
                "review": None,
            }
        elif mode == "decomposition-gate-first-pass":
            if "This root is clearly multi-slice." in prompt:
                payload = {
                    "outcome": "done",
                    "note": "decomposition first pass satisfied",
                    "commitSha": "",
                    "planMarkdown": "",
                    "filesToChange": [],
                    "testsToRun": [],
                    "artifacts": [],
                    "riskNotes": "",
                    "rollbackPlan": "",
                    "followUps": [
                        {
                            "to": ["frontend"],
                            "title": "execute child",
                            "body": "implement child task",
                            "signals": {"kind": "EXECUTE", "phase": "execute", "rootId": "root-stack", "parentId": "t1", "smoke": False},
                        }
                    ],
                    "review": None,
                }
            else:
                payload = {
                    "outcome": "done",
                    "note": "missing decomposition guidance on first pass",
                    "commitSha": "",
                    "followUps": [],
                    "review": None,
                }
        elif mode == "decomposition-gate-retry":
            if "DECOMPOSITION RETRY REQUIREMENT" in prompt:
                payload = {
                    "outcome": "done",
                    "note": "decomposition retry satisfied",
                    "commitSha": "",
                    "planMarkdown": "",
                    "filesToChange": [],
                    "testsToRun": [],
                    "artifacts": [],
                    "riskNotes": "",
                    "rollbackPlan": "",
                    "followUps": [
                        {
                            "to": ["frontend"],
                            "title": "execute child",
                            "body": "implement child task",
                            "signals": {"kind": "EXECUTE", "phase": "execute", "rootId": "root-stack", "parentId": "t1", "smoke": False},
                        }
                    ],
                    "review": None,
                }
            else:
                payload = {
                    "outcome": "done",
                    "note": "missing decomposition on first pass",
                    "commitSha": "",
                    "followUps": [],
                    "review": None,
                }
        elif mode == "followup-blocked-mixed":
            payload = {
                "outcome": "blocked",
                "note": "blocked with mixed followups",
                "commitSha": "",
                "planMarkdown": "",
                "filesToChange": [],
                "testsToRun": [],
                "artifacts": [],
                "riskNotes": "",
                "rollbackPlan": "",
                "followUps": [
                    {
                        "to": ["daddy"],
                        "title": "status unblock",
                        "body": "run guarded master push",
                        "signals": {"kind": "STATUS", "phase": "execute", "rootId": "root1", "parentId": "t1", "smoke": False},
                    },
                    {
                        "to": ["frontend"],
                        "title": "execute child",
                        "body": "should be suppressed while blocked",
                        "signals": {"kind": "EXECUTE", "phase": "execute", "rootId": "root1", "parentId": "t1", "smoke": False},
                    },
                ],
                "review": None,
            }
        elif mode == "blocked-basic":
            payload = {
                "outcome": "blocked",
                "note": "still blocked",
                "commitSha": "",
                "followUps": [],
                "review": None,
            }
        elif mode == "review-gate":
            review_verdict = os.environ.get("REVIEW_VERDICT", "pass")
            review_followups = (
                [{
                    "to": ["daddy"],
                    "title": "status follow-up",
                    "body": "review requested changes",
                    "signals": {"kind": "STATUS", "phase": "review", "rootId": "root1", "parentId": "t1", "smoke": False},
                }]
                if review_verdict == "changes_requested" and os.environ.get("REVIEW_STATUS_FOLLOWUP") == "1"
                else []
            )
            payload = {
                "outcome": "done",
                "note": "started-before-review-completion" if stale_review_completion_after_update and not latest_review_completion_sent else "review gate satisfied",
                "commitSha": os.environ.get("COMMIT_SHA", ""),
                "planMarkdown": "",
                "filesToChange": [],
                "testsToRun": [],
                "artifacts": [],
                "riskNotes": "",
                "rollbackPlan": "",
                "followUps": review_followups,
                "review": {
                    "ran": True,
                    "method": "built_in_review",
                    "targetCommitSha": review_target_sha,
                    "scope": review_scope,
                    "reviewedCommits": review_commits or [review_target_sha],
                    "summary": "No blocking findings.",
                    "findingsCount": 0,
                    "verdict": review_verdict,
                    "evidence": {
                        "artifactPath": "artifacts/autopilot/reviews/t1.md",
                        "sectionsPresent": ["findings", "severity", "file_refs", "actions"],
                    },
                },
            }
        elif mode == "review-gate-retry":
            if "RETRY REQUIREMENT" in prompt:
                payload = {
                    "outcome": "done",
                    "note": "review gate retry satisfied",
                    "commitSha": "",
                    "planMarkdown": "",
                    "filesToChange": [],
                    "testsToRun": [],
                    "artifacts": [],
                    "riskNotes": "",
                    "rollbackPlan": "",
                    "followUps": [],
                    "review": {
                        "ran": True,
                        "method": "built_in_review",
                        "targetCommitSha": review_target_sha,
                        "scope": review_scope,
                        "reviewedCommits": review_commits or [review_target_sha],
                        "summary": "Retry passed.",
                        "findingsCount": 0,
                        "verdict": "pass",
                        "evidence": {
                            "artifactPath": "artifacts/autopilot/reviews/t1.retry.md",
                            "sectionsPresent": ["findings", "severity", "file_refs", "actions"],
                        },
                    },
                }
            else:
                payload = {
                    "outcome": "done",
                    "note": "missing review on first pass",
                    "commitSha": "",
                    "followUps": [],
                    "review": None,
                }

        if "MANDATORY PREFLIGHT CONTRACT" in prompt and "Approved plan hash:" in prompt:
            payload["preflightPlan"] = build_preflight_plan(mode)

        text = json.dumps(payload)
        send({"method": "item/agentMessage/delta", "params": {"delta": text, "itemId": "am1", "threadId": thread_id, "turnId": current_turn_id}})
        send({"method": "item/completed", "params": {"threadId": thread_id, "turnId": current_turn_id, "item": {"id": "am1", "type": "agentMessage", "text": text}}})
        send({"method": "turn/completed", "params": {"threadId": thread_id, "turn": {"id": current_turn_id, "status": "completed", "items": []}}})
        continue
`;

const DUMMY_APP_SERVER_START_COUNT = DUMMY_APP_SERVER;
const DUMMY_APP_SERVER_CAPTURE_POLICY = DUMMY_APP_SERVER;

test('agent-codex-worker: app-server engine completes a task', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-basic-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);

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
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');
  await ensureBusRoot(busRoot, roster);

  await writeTask({
    busRoot,
    agentName: 'backend',
    taskId: 't1',
    meta: { id: 't1', to: ['backend'], from: 'daddy', priority: 'P2', title: 't1', signals: { kind: 'USER_REQUEST' } },
    body: 'do t1',
  });

  const env = {
    ...BASE_ENV,
    AGENTIC_AUTOPILOT_DELEGATE_GATE: '0',
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_APP_SERVER_TIMEOUT_MS: '2000',
    DUMMY_MODE: 'basic',
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
  assert.match(receipt.note, /\bok\b/);
});

test('agent-codex-worker: app-server forwards model and reasoning defaults via config args', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-model-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const argLogFile = path.join(tmp, 'app-server-args.json');

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);

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
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');
  await ensureBusRoot(busRoot, roster);

  await writeTask({
    busRoot,
    agentName: 'backend',
    taskId: 't1',
    meta: { id: 't1', to: ['backend'], from: 'daddy', priority: 'P2', title: 't1', signals: { kind: 'USER_REQUEST' } },
    body: 'do t1',
  });

  const env = {
    ...BASE_ENV,
    AGENTIC_CODEX_MODEL: 'gpt-5.4',
    AGENTIC_CODEX_MODEL_REASONING_EFFORT: 'xhigh',
    AGENTIC_CODEX_PLAN_MODE_REASONING_EFFORT: 'xhigh',
    AGENTIC_AUTOPILOT_DELEGATE_GATE: '0',
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_APP_SERVER_TIMEOUT_MS: '2000',
    DUMMY_MODE: 'basic',
    ARG_LOG_FILE: argLogFile,
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

  const args = JSON.parse(await fs.readFile(argLogFile, 'utf8'));
  assert.ok(args.includes('app-server'), JSON.stringify(args));
  assert.ok(args.includes('model="gpt-5.4"'), JSON.stringify(args));
  assert.ok(args.includes('model_reasoning_effort="xhigh"'), JSON.stringify(args));
  assert.ok(args.includes('plan_mode_reasoning_effort="xhigh"'), JSON.stringify(args));
});

test('agent-codex-worker: merge-like done outcome does not fail when commit object is not local yet', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-merge-sha-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const workdir = await createTestGitWorkdir({ rootDir: tmp });

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);

  const roster = {
    orchestratorName: 'daddy-orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'daddy-autopilot',
    agents: [
      {
        name: 'backend',
        role: 'codex-worker',
        skills: [],
        workdir,
        startCommand: 'node scripts/agent-codex-worker.mjs --agent backend',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');
  await ensureBusRoot(busRoot, roster);

  await writeTask({
    busRoot,
    agentName: 'backend',
    taskId: 't1',
    meta: { id: 't1', to: ['backend'], from: 'daddy', priority: 'P2', title: 'merge completion', signals: { kind: 'USER_REQUEST' } },
    body: 'merge completion task',
  });

  const env = {
    ...BASE_ENV,
    AGENTIC_AUTOPILOT_DELEGATE_GATE: '0',
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_APP_SERVER_TIMEOUT_MS: '2000',
    DUMMY_MODE: 'merge-commit-missing-local',
    MERGE_COMMIT_SHA: 'ffffffffffffffffffffffffffffffffffffffff',
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
  assert.match(receipt.note, /Merged PR112 on master\./);
});

test('daddy-autopilot: EXECUTE followUp synthesizes references.git and references.integration', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-followup-contract-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const workdir = await createTestGitWorkdir({ rootDir: tmp });

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);

  const roster = {
    orchestratorName: 'orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'autopilot',
    agents: [
      {
        name: 'autopilot',
        role: 'autopilot-worker',
        skills: [],
        workdir,
        startCommand: 'node scripts/agent-codex-worker.mjs --agent autopilot',
      },
      { name: 'frontend', role: 'codex-worker', skills: [], workdir: '$REPO_ROOT' },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');
  await ensureBusRoot(busRoot, roster);

  await writeTask({
    busRoot,
    agentName: 'autopilot',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['autopilot'],
      from: 'daddy',
      priority: 'P2',
      title: 'dispatch execute followup',
      signals: { kind: 'USER_REQUEST', rootId: 'root1' },
      references: {},
    },
    body:
      'Clear PR118 and PR119 in order.\n\n' +
      'Required order:\n' +
      '1. verify PR118\n' +
      '2. merge PR118\n' +
      '3. verify PR119\n' +
      '4. merge PR119\n',
  });

  const env = {
    ...BASE_ENV,
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_APP_SERVER_TIMEOUT_MS: '5000',
    AGENTIC_RUNTIME_POLICY_SYNC: '0',
    DUMMY_MODE: 'followup-execute',
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'autopilot',
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
  assert.ok(files.length >= 1, 'expected execute followup in frontend inbox');
  const raw = await fs.readFile(path.join(frontendNewDir, files[0]), 'utf8');
  const parts = raw.match(/^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/);
  assert.ok(parts, 'expected packet frontmatter');
  const meta = JSON.parse(parts[1]);
  const refs = meta.references || {};
  const git = refs.git || {};
  const integration = refs.integration || {};

  assert.equal(meta.signals.kind, 'EXECUTE');
  assert.equal(typeof git.baseSha, 'string');
  assert.ok(git.baseSha.length >= 6);
  assert.equal(git.integrationBranch, 'slice/root1');
  assert.equal(git.workBranch, 'wip/frontend/root1/main');
  assert.equal(integration.requiredIntegrationBranch, 'slice/root1');
  assert.equal(integration.integrationMode, 'autopilot_integrates');

  const receiptPath = path.join(busRoot, 'receipts', 'autopilot', 't1.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.doesNotMatch(String(receipt.note || ''), /decomposition_required/i);
  assert.equal(receipt.receiptExtra.runtimeGuard?.delegationGate?.reasonCode, 'delegated_completion_missing');
});

test('daddy-autopilot: multi-pr USER_REQUEST without EXECUTE followUps fails early decomposition', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-early-decomposition-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const countFile = path.join(tmp, 'turn-count.txt');
  const workdir = await createTestGitWorkdir({ rootDir: tmp });

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);

  const roster = {
    orchestratorName: 'orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'autopilot',
    agents: [
      {
        name: 'autopilot',
        role: 'autopilot-worker',
        skills: [],
        workdir,
        startCommand: 'node scripts/agent-codex-worker.mjs --agent autopilot',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');
  await ensureBusRoot(busRoot, roster);

  await writeTask({
    busRoot,
    agentName: 'autopilot',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['autopilot'],
      from: 'daddy',
      priority: 'P2',
      title: 'Clear Valua PR stack and finish PR114',
      signals: { kind: 'USER_REQUEST', rootId: 'root-stack' },
      references: {},
    },
    body:
      'Scope:\n' +
      '- PR118 deploy wrapper\n' +
      '- PR119 SSR perimeter\n' +
      '- PR114 nginx parity\n\n' +
      'Required order:\n' +
      '1. verify PR118 and PR119\n' +
      '2. merge PR118 and PR119\n' +
      '3. finish PR114\n',
  });

  const env = {
    ...BASE_ENV,
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_APP_SERVER_TIMEOUT_MS: '5000',
    AGENTIC_RUNTIME_POLICY_SYNC: '0',
    DUMMY_MODE: 'basic',
    COUNT_FILE: countFile,
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'autopilot',
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
  assert.match(run.stderr, /decomposition retry 1\/1: multi_pr_root/);

  const receiptPath = path.join(busRoot, 'receipts', 'autopilot', 't1.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  const turnCalls = Number(await fs.readFile(countFile, 'utf8'));
  assert.equal(turnCalls, 2);
  assert.equal(receipt.outcome, 'blocked');
  assert.match(String(receipt.note || ''), /decomposition_required/i);
  assert.equal(receipt.receiptExtra.runtimeGuard?.delegationGate?.path, 'early_decomposition');
  assert.equal(receipt.receiptExtra.runtimeGuard?.delegationGate?.reasonCode, 'decomposition_required');
  assert.equal(receipt.receiptExtra.runtimeGuard?.delegationGate?.decompositionReasonCode, 'multi_pr_root');
  assert.equal(receipt.receiptExtra.blockedRecoveryContract?.class, 'controller');
  assert.equal(receipt.receiptExtra.blockedRecoveryContract?.reasonCode, 'decomposition_required');

  const recoveryRun = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'autopilot',
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
    { cwd: repoRoot, env: { ...env, DUMMY_MODE: 'blocked-basic' } },
  );
  assert.equal(recoveryRun.code, 0, recoveryRun.stderr || recoveryRun.stdout);

  const recoveryReceipt = JSON.parse(
    await fs.readFile(path.join(busRoot, 'receipts', 'autopilot', 'autopilot_recovery__t1__1.json'), 'utf8'),
  );
  assert.equal(recoveryReceipt.outcome, 'blocked');
  assert.equal(recoveryReceipt.receiptExtra?.autopilotRecovery?.reason, 'unchanged_evidence');
  await assert.rejects(
    fs.access(path.join(busRoot, 'inbox', 'autopilot', 'new', 'autopilot_recovery__t1__2.md')),
  );
});

test('daddy-autopilot: early decomposition gate still blocks when delegate gate is disabled', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-early-decomposition-independent-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const countFile = path.join(tmp, 'turn-count.txt');
  const workdir = await createTestGitWorkdir({ rootDir: tmp });

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);

  const roster = {
    orchestratorName: 'orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'autopilot',
    agents: [
      {
        name: 'autopilot',
        role: 'autopilot-worker',
        skills: [],
        workdir,
        startCommand: 'node scripts/agent-codex-worker.mjs --agent autopilot',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');
  await ensureBusRoot(busRoot, roster);

  await writeTask({
    busRoot,
    agentName: 'autopilot',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['autopilot'],
      from: 'daddy',
      priority: 'P2',
      title: 'Clear Valua PR stack and finish PR114',
      signals: { kind: 'USER_REQUEST', rootId: 'root-stack' },
      references: {},
    },
    body:
      'Scope:\n' +
      '- PR118 deploy wrapper\n' +
      '- PR119 SSR perimeter\n' +
      '- PR114 nginx parity\n\n' +
      'Required order:\n' +
      '1. verify PR118 and PR119\n' +
      '2. merge PR118 and PR119\n' +
      '3. finish PR114\n',
  });

  const env = {
    ...BASE_ENV,
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_APP_SERVER_TIMEOUT_MS: '5000',
    AGENTIC_RUNTIME_POLICY_SYNC: '0',
    AGENTIC_AUTOPILOT_DELEGATE_GATE: '0',
    AGENTIC_AUTOPILOT_EARLY_DECOMPOSITION_GATE: '1',
    DUMMY_MODE: 'basic',
    COUNT_FILE: countFile,
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'autopilot',
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
  assert.match(run.stderr, /decomposition retry 1\/1: multi_pr_root/);

  const receiptPath = path.join(busRoot, 'receipts', 'autopilot', 't1.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  const turnCalls = Number(await fs.readFile(countFile, 'utf8'));
  assert.equal(turnCalls, 2);
  assert.equal(receipt.outcome, 'blocked');
  assert.match(String(receipt.note || ''), /decomposition_required/i);
  assert.equal(receipt.receiptExtra.runtimeGuard?.delegationGate?.path, 'early_decomposition');
  assert.equal(receipt.receiptExtra.runtimeGuard?.delegationGate?.reasonCode, 'decomposition_required');
  assert.equal(receipt.receiptExtra.runtimeGuard?.delegationGate?.decompositionReasonCode, 'multi_pr_root');
  assert.equal(receipt.receiptExtra.blockedRecoveryContract?.class, 'controller');
});

test('daddy-autopilot: frontmatter PRs and plain Scope do not false-trip early decomposition', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-early-decomposition-simple-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const workdir = await createTestGitWorkdir({ rootDir: tmp });

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);

  const roster = {
    orchestratorName: 'orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'autopilot',
    agents: [
      {
        name: 'autopilot',
        role: 'autopilot-worker',
        skills: [],
        workdir,
        startCommand: 'node scripts/agent-codex-worker.mjs --agent autopilot',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');
  await ensureBusRoot(busRoot, roster);

  await writeTask({
    busRoot,
    agentName: 'autopilot',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['autopilot'],
      from: 'daddy',
      priority: 'P2',
      title: 'Summarize PR118 and PR119 staging status',
      signals: { kind: 'USER_REQUEST', rootId: 'root-status' },
      references: {
        sourceReferences: {
          pr: { number: 118 },
          related: [{ prNumber: 119 }],
        },
      },
    },
    body:
      'Scope:\n' +
      '- summarize staging status\n' +
      '- list blockers\n' +
      '- name the owner\n\n' +
      '1. gather current status\n' +
      '2. write one summary note\n' +
      '3. post the note\n',
  });

  const env = {
    ...BASE_ENV,
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_APP_SERVER_TIMEOUT_MS: '5000',
    AGENTIC_RUNTIME_POLICY_SYNC: '0',
    DUMMY_MODE: 'basic',
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'autopilot',
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

  const receiptPath = path.join(busRoot, 'receipts', 'autopilot', 't1.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(receipt.outcome, 'done');
  assert.doesNotMatch(String(receipt.note || ''), /decomposition_required/i);
  assert.equal(receipt.receiptExtra.runtimeGuard?.delegationGate?.decompositionRequired, false);
});

test('daddy-autopilot: early decomposition retry keeps moving when the retry dispatches EXECUTE followUps', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-early-decomposition-retry-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const countFile = path.join(tmp, 'turn-count.txt');
  const workdir = await createTestGitWorkdir({ rootDir: tmp });

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);

  const roster = {
    orchestratorName: 'orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'autopilot',
    agents: [
      {
        name: 'autopilot',
        role: 'autopilot-worker',
        skills: [],
        workdir,
        startCommand: 'node scripts/agent-codex-worker.mjs --agent autopilot',
      },
      {
        name: 'frontend',
        role: 'codex-worker',
        skills: [],
        workdir,
        startCommand: 'node scripts/agent-codex-worker.mjs --agent frontend',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');
  await ensureBusRoot(busRoot, roster);

  await writeTask({
    busRoot,
    agentName: 'autopilot',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['autopilot'],
      from: 'daddy',
      priority: 'P2',
      title: 'Clear Valua PR stack and finish PR114',
      signals: { kind: 'USER_REQUEST', rootId: 'root-stack' },
      references: {},
    },
    body:
      'Scope:\n' +
      '- PR118 deploy wrapper\n' +
      '- PR119 SSR perimeter\n' +
      '- PR114 nginx parity\n\n' +
      'Required order:\n' +
      '1. verify PR118 and PR119\n' +
      '2. merge PR118 and PR119\n' +
      '3. finish PR114\n',
  });

  const env = {
    ...BASE_ENV,
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_APP_SERVER_TIMEOUT_MS: '5000',
    AGENTIC_RUNTIME_POLICY_SYNC: '0',
    DUMMY_MODE: 'decomposition-gate-retry',
    COUNT_FILE: countFile,
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'autopilot',
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
  assert.match(run.stderr, /decomposition retry 1\/1: multi_pr_root/);

  const turnCalls = Number(await fs.readFile(countFile, 'utf8'));
  assert.equal(turnCalls, 2);

  const frontendNewDir = path.join(busRoot, 'inbox', 'frontend', 'new');
  const files = await fs.readdir(frontendNewDir);
  assert.equal(files.length, 1);

  const receiptPath = path.join(busRoot, 'receipts', 'autopilot', 't1.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(receipt.outcome, 'needs_review');
  assert.doesNotMatch(String(receipt.note || ''), /decomposition_required/i);
  assert.equal(receipt.receiptExtra.runtimeGuard?.delegationGate?.path, 'delegate_pending');
  assert.equal(receipt.receiptExtra.runtimeGuard?.delegationGate?.reasonCode, 'delegated_completion_missing');
});

test('daddy-autopilot: early decomposition prompt injects first-pass guidance from task body', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-early-decomposition-first-pass-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const countFile = path.join(tmp, 'turn-count.txt');
  const workdir = await createTestGitWorkdir({ rootDir: tmp });

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);

  const roster = {
    orchestratorName: 'orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'autopilot',
    agents: [
      {
        name: 'autopilot',
        role: 'autopilot-worker',
        skills: [],
        workdir,
        startCommand: 'node scripts/agent-codex-worker.mjs --agent autopilot',
      },
      {
        name: 'frontend',
        role: 'codex-worker',
        skills: [],
        workdir,
        startCommand: 'node scripts/agent-codex-worker.mjs --agent frontend',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');
  await ensureBusRoot(busRoot, roster);

  await writeTask({
    busRoot,
    agentName: 'autopilot',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['autopilot'],
      from: 'daddy',
      priority: 'P2',
      title: 'Clear Valua PR stack and finish PR114',
      signals: { kind: 'USER_REQUEST', rootId: 'root-stack' },
      references: {},
    },
    body:
      'Scope:\n' +
      '- PR118 deploy wrapper\n' +
      '- PR119 SSR perimeter\n' +
      '- PR114 nginx parity\n\n' +
      'Required order:\n' +
      '1. verify PR118 and PR119\n' +
      '2. merge PR118 and PR119\n' +
      '3. finish PR114\n',
  });

  const env = {
    ...BASE_ENV,
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_APP_SERVER_TIMEOUT_MS: '5000',
    AGENTIC_RUNTIME_POLICY_SYNC: '0',
    DUMMY_MODE: 'decomposition-gate-first-pass',
    COUNT_FILE: countFile,
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'autopilot',
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
  assert.doesNotMatch(run.stderr, /decomposition retry 1\/1: multi_pr_root/);

  const turnCalls = Number(await fs.readFile(countFile, 'utf8'));
  assert.equal(turnCalls, 1);

  const frontendNewDir = path.join(busRoot, 'inbox', 'frontend', 'new');
  const files = await fs.readdir(frontendNewDir);
  assert.equal(files.length, 1);

  const receiptPath = path.join(busRoot, 'receipts', 'autopilot', 't1.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(receipt.outcome, 'needs_review');
  assert.doesNotMatch(String(receipt.note || ''), /decomposition_required/i);
  assert.equal(receipt.receiptExtra.runtimeGuard?.delegationGate?.decompositionReasonCode, 'multi_pr_root');
  assert.equal(receipt.receiptExtra.runtimeGuard?.delegationGate?.reasonCode, 'delegated_completion_missing');
});

test('daddy-autopilot: blocked outcome dispatches both STATUS and EXECUTE followUps', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-followup-blocked-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);

  const roster = {
    orchestratorName: 'orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'autopilot',
    agents: [
      {
        name: 'autopilot',
        role: 'autopilot-worker',
        skills: [],
        workdir: '$REPO_ROOT',
        startCommand: 'node scripts/agent-codex-worker.mjs --agent autopilot',
      },
      { name: 'frontend', role: 'codex-worker', skills: [], workdir: '$REPO_ROOT' },
      { name: 'daddy', role: 'chat-io', skills: [], workdir: '$REPO_ROOT' },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');
  await ensureBusRoot(busRoot, roster);

  await writeTask({
    busRoot,
    agentName: 'autopilot',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['autopilot'],
      from: 'daddy',
      priority: 'P2',
      title: 'blocked mixed followups',
      signals: { kind: 'USER_REQUEST', rootId: 'root1' },
      references: {},
    },
    body: 'dispatch blocked mixed followups',
  });

  const env = {
    ...BASE_ENV,
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_APP_SERVER_TIMEOUT_MS: '5000',
    DUMMY_MODE: 'followup-blocked-mixed',
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'autopilot',
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

  const receiptPath = path.join(busRoot, 'receipts', 'autopilot', 't1.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(receipt.outcome, 'blocked');
  assert.equal(Array.isArray(receipt.receiptExtra.dispatchedFollowUps), true);
  assert.equal(receipt.receiptExtra.dispatchedFollowUps.length, 2);
  assert.deepEqual(
    receipt.receiptExtra.dispatchedFollowUps.map((fu) => fu.kind).sort(),
    ['EXECUTE', 'STATUS'],
  );

  const daddyNewDir = path.join(busRoot, 'inbox', 'daddy', 'new');
  const daddyPackets = await fs.readdir(daddyNewDir);
  assert.ok(daddyPackets.length >= 1, 'expected STATUS follow-up in daddy inbox');

  const frontendNewDir = path.join(busRoot, 'inbox', 'frontend', 'new');
  const frontendPackets = await fs.readdir(frontendNewDir);
  assert.ok(frontendPackets.length >= 1, 'expected EXECUTE follow-up in frontend inbox');
});

test('non-autopilot: blocked outcome suppresses non-STATUS followUps', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-followup-blocked-worker-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);

  const roster = {
    orchestratorName: 'orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'autopilot',
    agents: [
      { name: 'autopilot', role: 'autopilot-worker', skills: [], workdir: '$REPO_ROOT' },
      { name: 'frontend', role: 'codex-worker', skills: [], workdir: '$REPO_ROOT' },
      { name: 'daddy', role: 'chat-io', skills: [], workdir: '$REPO_ROOT' },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');
  await ensureBusRoot(busRoot, roster);

  await writeTask({
    busRoot,
    agentName: 'frontend',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['frontend'],
      from: 'daddy',
      priority: 'P2',
      title: 'blocked mixed followups',
      signals: { kind: 'USER_REQUEST', rootId: 'root1' },
      references: {},
    },
    body: 'dispatch blocked mixed followups',
  });

  const env = {
    ...BASE_ENV,
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_APP_SERVER_TIMEOUT_MS: '5000',
    DUMMY_MODE: 'followup-blocked-mixed',
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'frontend',
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

  const receiptPath = path.join(busRoot, 'receipts', 'frontend', 't1.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(receipt.outcome, 'blocked');
  assert.equal(receipt.receiptExtra.followUpsSuppressed, true);
  assert.equal(receipt.receiptExtra.followUpsSuppressedReason, 'blocked_outcome_non_autopilot');
  assert.equal(receipt.receiptExtra.followUpsSuppressedCount, 1);
  assert.equal(Array.isArray(receipt.receiptExtra.dispatchedFollowUps), true);
  assert.equal(receipt.receiptExtra.dispatchedFollowUps.length, 1);
  assert.equal(receipt.receiptExtra.dispatchedFollowUps[0].kind, 'STATUS');

  const daddyNewDir = path.join(busRoot, 'inbox', 'daddy', 'new');
  const daddyPackets = await fs.readdir(daddyNewDir);
  assert.ok(daddyPackets.length >= 1, 'expected STATUS follow-up in daddy inbox');

  const frontendNewDir = path.join(busRoot, 'inbox', 'frontend', 'new');
  let frontendPackets = [];
  try {
    frontendPackets = await fs.readdir(frontendNewDir);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  assert.equal(frontendPackets.length, 0, 'non-autopilot blocked EXECUTE follow-up must be suppressed');
});

test('non-autopilot EXECUTE: blocked outcome suppresses non-STATUS followUps after writer preflight', async () => {
  const { receipt, busRoot } = await runExecutePreflightScenario({
    mode: 'followup-blocked-mixed',
    title: 'blocked execute followups',
    body: 'Implement the runtime fix and emit the required follow-ups.',
  });

  assert.equal(receipt.outcome, 'blocked');
  assert.equal(receipt.receiptExtra.runtimeGuard?.preflightGate?.required, true);
  assert.equal(receipt.receiptExtra.runtimeGuard?.preflightGate?.approved, true);
  assert.equal(receipt.receiptExtra.runtimeGuard?.preflightGate?.noWritePass, true);
  assert.equal(receipt.receiptExtra.followUpsSuppressed, true);
  assert.equal(receipt.receiptExtra.followUpsSuppressedReason, 'blocked_outcome_non_autopilot');
  assert.equal(receipt.receiptExtra.followUpsSuppressedCount, 1);
  assert.equal(Array.isArray(receipt.receiptExtra.dispatchedFollowUps), true);
  assert.equal(receipt.receiptExtra.dispatchedFollowUps.length, 1);
  assert.equal(receipt.receiptExtra.dispatchedFollowUps[0].kind, 'STATUS');

  const daddyNewDir = path.join(busRoot, 'inbox', 'daddy', 'new');
  const daddyPackets = await fs.readdir(daddyNewDir);
  assert.ok(daddyPackets.length >= 1, 'expected STATUS follow-up in daddy inbox');

  const frontendNewDir = path.join(busRoot, 'inbox', 'frontend', 'new');
  const frontendPackets = (await fs.readdir(frontendNewDir)).filter((name) => name !== 't1.md');
  assert.equal(frontendPackets.length, 0, 'non-autopilot blocked EXECUTE follow-up must stay suppressed after preflight');
});

test('daddy-autopilot: skillops gate blocks done closure when evidence is missing', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-skillops-missing-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);

  const roster = {
    orchestratorName: 'orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'autopilot',
    agents: [
      {
        name: 'autopilot',
        role: 'autopilot-worker',
        skills: [],
        workdir: '$REPO_ROOT',
        startCommand: 'node scripts/agent-codex-worker.mjs --agent autopilot',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');

  await writeTask({
    busRoot,
    agentName: 'autopilot',
    taskId: 't1',
    meta: { id: 't1', to: ['autopilot'], from: 'daddy', priority: 'P2', title: 't1', signals: { kind: 'USER_REQUEST' } },
    body: 'do t1',
  });

  const env = {
    ...BASE_ENV,
    AGENTIC_AUTOPILOT_DELEGATE_GATE: '0',
    AGENTIC_AUTOPILOT_SKILLOPS_GATE: '1',
    AGENTIC_AUTOPILOT_SKILLOPS_GATE_KINDS: 'USER_REQUEST',
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_APP_SERVER_TIMEOUT_MS: '2000',
    DUMMY_MODE: 'skillops-missing',
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'autopilot',
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

  const receiptPath = path.join(busRoot, 'receipts', 'autopilot', 't1.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(receipt.outcome, 'blocked');
  assert.match(receipt.note, /skillops gate failed/i);
  assert.equal(receipt.receiptExtra.runtimeGuard.skillOpsGate.required, true);
  assert.equal(receipt.receiptExtra.runtimeGuard.skillOpsGate.commandChecks.debrief, false);
});

test('daddy-autopilot: skillops gate accepts done closure when evidence is present', async () => {
  const { repoRoot, busRoot, rosterPath, dummyCodex, workdir } = await setupSkillOpsAutopilotHarness({
    prefix: 'agentic-codex-app-server-skillops-ok-',
  });
  await writeSkillOpsProofLog({ workdir, updates: [] });
  await writeBasicAutopilotUserTask({ busRoot, rootId: '' });

  const { receipt } = await runAutopilotWorkerAndReadReceipt({
    repoRoot,
    busRoot,
    rosterPath,
    dummyCodex,
    env: buildSkillOpsAutopilotEnv({ busRoot }),
  });
  assert.equal(receipt.outcome, 'done');
  assert.equal(receipt.receiptExtra.runtimeGuard.skillOpsGate.required, true);
  assert.equal(receipt.receiptExtra.runtimeGuard.skillOpsGate.commandChecks.debrief, true);
  assert.equal(receipt.receiptExtra.runtimeGuard.skillOpsGate.logArtifactExists, true);
  assert.equal(receipt.receiptExtra.runtimeGuard.skillOpsPromotion.status, 'not_required');
});

test('daddy-autopilot: skillops gate retires empty logs locally without queuing a promotion task', async () => {
  const { repoRoot, tmp, busRoot, rosterPath, dummyCodex, workdir, worktreesDir } = await setupSkillOpsAutopilotHarness({
    prefix: 'agentic-codex-app-server-skillops-skip-',
  });
  const statePath = path.join(busRoot, 'state', 'skillops-promotions', 'autopilot', 'root1.json');

  const logPath = await writeSkillOpsProofLog({ workdir, updates: [] });
  await writeBasicAutopilotUserTask({ busRoot });

  const { receipt } = await runAutopilotWorkerAndReadReceipt({
    repoRoot,
    busRoot,
    rosterPath,
    dummyCodex,
    env: buildSkillOpsAutopilotEnv({ busRoot, worktreesDir }),
  });
  assert.equal(receipt.outcome, 'done');
  assert.equal(receipt.receiptExtra.runtimeGuard.skillOpsPromotion.status, 'not_required');
  const logContents = await fs.readFile(logPath, 'utf8');
  assert.match(logContents, /status:\s*skipped/);
  assert.match(logContents, /processed_at:\s*"/);
  await assert.rejects(
    fs.stat(path.join(busRoot, 'state', 'skillops-promotions', 'autopilot', 'root1.plan.json')),
    /ENOENT/,
  );
  await assert.rejects(fs.stat(statePath), /ENOENT/);
  let queuedPackets = [];
  try {
    queuedPackets = await fs.readdir(path.join(busRoot, 'inbox', 'autopilot', 'new'));
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  assert.deepEqual(queuedPackets, []);
});

test('daddy-autopilot: content-bearing pending skillops logs without learnings stop closure instead of being auto-skipped', async () => {
  const { repoRoot, tmp, busRoot, rosterPath, dummyCodex, workdir, worktreesDir } = await setupSkillOpsAutopilotHarness({
    prefix: 'agentic-codex-app-server-skillops-content-bearing-',
  });
  const logPath = await writeSkillOpsProofLog({
    workdir,
    updates: [],
    bodyLines: [
      '# Summary',
      '- What changed: Runtime handoff drifted on retry.',
      '- Why: This debrief still needs operator review.',
      '',
    ],
  });
  await writeBasicAutopilotUserTask({ busRoot });

  const { receipt } = await runAutopilotWorkerAndReadReceipt({
    repoRoot,
    busRoot,
    rosterPath,
    dummyCodex,
    env: buildSkillOpsAutopilotEnv({ busRoot, worktreesDir }),
  });
  assert.equal(receipt.outcome, 'needs_review');
  assert.equal(receipt.receiptExtra.reasonCode, 'skillops_promotion_handoff_failed');
  assert.equal(receipt.receiptExtra.runtimeGuard.skillOpsPromotion.reasonCode, 'skillops_promotion_handoff_failed');

  const logContents = await fs.readFile(logPath, 'utf8');
  assert.match(logContents, /status:\s*pending/);

  await assert.rejects(
    fs.stat(path.join(busRoot, 'state', 'skillops-promotions', 'autopilot', 'root1.plan.json')),
    /ENOENT/,
  );
  let queuedPackets = [];
  try {
    queuedPackets = await fs.readdir(path.join(busRoot, 'inbox', 'autopilot', 'new'));
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  assert.deepEqual(queuedPackets, []);
});

test('daddy-autopilot: skillops gate queues a deterministic promotion task for promotable learnings', async () => {
  const { repoRoot, tmp, busRoot, rosterPath, dummyCodex, workdir, worktreesDir } = await setupSkillOpsAutopilotHarness({
    prefix: 'agentic-codex-app-server-skillops-queue-',
  });
  const logPath = await writeSkillOpsProofLog({
    workdir,
    updates: ['Durably hand off learnings before original root closure.'],
  });
  await writeBasicAutopilotUserTask({ busRoot });

  const { receipt } = await runAutopilotWorkerAndReadReceipt({
    repoRoot,
    busRoot,
    rosterPath,
    dummyCodex,
    env: buildSkillOpsAutopilotEnv({ busRoot, worktreesDir }),
  });
  assert.equal(receipt.outcome, 'done');
  assert.equal(receipt.receiptExtra.runtimeGuard.skillOpsPromotion.status, 'queued');
  assert.equal(receipt.receiptExtra.skillOpsPromotionTaskId, 'skillops_promotion__autopilot__root1');
  assert.equal(
    receipt.receiptExtra.skillOpsPromotionPlanPath,
    path.join(busRoot, 'state', 'skillops-promotions', 'autopilot', 'root1.plan.json'),
  );

  const promotionTaskPath = path.join(busRoot, 'inbox', 'autopilot', 'new', 'skillops_promotion__autopilot__root1.md');
  assert.equal(await waitForPath(promotionTaskPath), true);
  const promotionTaskRaw = await fs.readFile(promotionTaskPath, 'utf8');
  assert.match(promotionTaskRaw, /SKILLOPS_PROMOTION/);

  const queuedLog = await fs.readFile(logPath, 'utf8');
  assert.match(queuedLog, /status:\s*queued/);
  assert.match(queuedLog, /promotion_task_id:\s*"skillops_promotion__autopilot__root1"/);

  const statePath = path.join(busRoot, 'state', 'skillops-promotions', 'autopilot', 'root1.json');
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  assert.equal(state.status, 'queued');
  assert.equal(state.promotionTaskId, 'skillops_promotion__autopilot__root1');
  assert.deepEqual(state.sourceLogIds, ['skillops-proof']);
});

test('daddy-autopilot: skillops gate blocks when root-scoped needs_review promotion state already exists', async () => {
  const { repoRoot, tmp, busRoot, rosterPath, dummyCodex, workdir, worktreesDir } = await setupSkillOpsAutopilotHarness({
    prefix: 'agentic-codex-app-server-skillops-requeue-',
  });
  const statePath = path.join(busRoot, 'state', 'skillops-promotions', 'autopilot', 'root1.json');

  const logPath = await writeSkillOpsProofLog({
    workdir,
    updates: ['Retry queued promotion tasks when prior handoff state is stranded.'],
  });
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(
    statePath,
    JSON.stringify(
      buildSkillOpsPromotionStateFixture({
        workdir,
        busRoot,
        worktreesDir,
        status: 'needs_review',
        failedAt: '2026-03-15T00:01:00Z',
        reasonCode: 'skillops_promotion_handoff_failed',
      }),
      null,
      2,
    ) + '\n',
    'utf8',
  );
  await writeBasicAutopilotUserTask({ busRoot });

  const { receipt } = await runAutopilotWorkerAndReadReceipt({
    repoRoot,
    busRoot,
    rosterPath,
    dummyCodex,
    env: buildSkillOpsAutopilotEnv({ busRoot, worktreesDir }),
  });
  assert.equal(receipt.outcome, 'needs_review');
  assert.equal(receipt.receiptExtra.reasonCode, 'skillops_promotion_handoff_failed');
  assert.equal(receipt.receiptExtra.runtimeGuard.skillOpsPromotion.reasonCode, 'skillops_promotion_handoff_failed');
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  assert.equal(state.status, 'needs_review');
  const queuedLog = await fs.readFile(logPath, 'utf8');
  assert.match(queuedLog, /status:\s*pending/);
  await assert.rejects(
    fs.stat(path.join(busRoot, 'inbox', 'autopilot', 'new', 'skillops_promotion__autopilot__root1.md')),
    /ENOENT/,
  );
});

test('daddy-autopilot: skillops gate blocks orphaned queued promotion state when the queued packet is missing', async () => {
  const { repoRoot, busRoot, rosterPath, dummyCodex, workdir, worktreesDir } = await setupSkillOpsAutopilotHarness({
    prefix: 'agentic-codex-app-server-skillops-stale-queued-',
  });
  const statePath = path.join(busRoot, 'state', 'skillops-promotions', 'autopilot', 'root1.json');
  const queuedAt = '2026-03-15T00:02:00Z';
  const logPath = await writeSkillOpsProofLog({
    workdir,
    updates: ['Replace stale queued promotion state when the queued packet is gone.'],
  });
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(
    statePath,
    JSON.stringify(
      buildSkillOpsPromotionStateFixture({
        workdir,
        busRoot,
        worktreesDir,
        status: 'queued',
        queuedAt,
      }),
      null,
      2,
    ) + '\n',
    'utf8',
  );
  await writeBasicAutopilotUserTask({ busRoot });

  const { receipt } = await runAutopilotWorkerAndReadReceipt({
    repoRoot,
    busRoot,
    rosterPath,
    dummyCodex,
    env: buildSkillOpsAutopilotEnv({ busRoot, worktreesDir }),
  });
  assert.equal(receipt.outcome, 'needs_review');
  assert.equal(receipt.receiptExtra.reasonCode, 'skillops_promotion_orphan_state');
  assert.equal(receipt.receiptExtra.runtimeGuard.skillOpsPromotion.reasonCode, 'skillops_promotion_orphan_state');
  await assert.rejects(
    fs.stat(path.join(busRoot, 'inbox', 'autopilot', 'new', 'skillops_promotion__autopilot__root1.md')),
    /ENOENT/,
  );
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  assert.equal(state.status, 'queued');
  assert.equal(state.promotionTaskId, 'skillops_promotion__autopilot__root1');
  assert.equal(state.queuedAt, queuedAt);
  const queuedLog = await fs.readFile(logPath, 'utf8');
  assert.match(queuedLog, /status:\s*pending/);
});

test('daddy-autopilot: skillops gate rolls back queued promotion dispatch when mark-promoted queued fails', async () => {
  const { repoRoot, busRoot, rosterPath, dummyCodex, workdir, worktreesDir } = await setupSkillOpsAutopilotHarness({
    prefix: 'agentic-codex-app-server-skillops-rollback-',
  });
  const statePath = path.join(busRoot, 'state', 'skillops-promotions', 'autopilot', 'root1.json');
  const queuedTaskPath = path.join(busRoot, 'inbox', 'autopilot', 'new', 'skillops_promotion__autopilot__root1.md');
  const logPath = await writeSkillOpsProofLog({
    workdir,
    updates: ['Fail closed when queued mark persistence breaks after enqueue.'],
  });
  await makeSkillOpsMarkQueuedFail({ workdir });
  await writeBasicAutopilotUserTask({ busRoot });

  const { receipt } = await runAutopilotWorkerAndReadReceipt({
    repoRoot,
    busRoot,
    rosterPath,
    dummyCodex,
    env: {
      ...buildSkillOpsAutopilotEnv({ busRoot, worktreesDir }),
      FAIL_SKILLOPS_MARK_QUEUED: '1',
    },
  });
  assert.equal(receipt.outcome, 'needs_review');
  assert.equal(receipt.receiptExtra.reasonCode, 'skillops_promotion_handoff_failed');
  assert.equal(receipt.receiptExtra.runtimeGuard.skillOpsPromotion.reasonCode, 'skillops_promotion_handoff_failed');
  await assert.rejects(fs.stat(statePath), /ENOENT/);
  await assert.rejects(fs.stat(queuedTaskPath), /ENOENT/);
  const pendingLog = await fs.readFile(logPath, 'utf8');
  assert.match(pendingLog, /status:\s*pending/);
});

test('daddy-autopilot: skillops gate reuses a live queued promotion lane instead of deleting deterministic plan state on zero-log reruns', async () => {
  const { repoRoot, busRoot, rosterPath, dummyCodex, workdir, worktreesDir } = await setupSkillOpsAutopilotHarness({
    prefix: 'agentic-codex-app-server-skillops-reuse-live-queued-',
  });
  const curationWorkdir = path.join(worktreesDir, 'autopilot-skillops-promotion');
  const planPath = await writeSkillOpsPromotionPlanFixture({
    busRoot,
    text: 'Reuse the live queued promotion lane when the source checkout is already marked queued.',
  });
  const originalPlan = await fs.readFile(planPath, 'utf8');
  const statePath = path.join(busRoot, 'state', 'skillops-promotions', 'autopilot', 'root1.json');
  await fs.writeFile(
    statePath,
    JSON.stringify(buildSkillOpsPromotionStateFixture({ workdir, busRoot, worktreesDir, status: 'queued' }), null, 2) + '\n',
    'utf8',
  );
  const queuedTaskPath = await writeQueuedSkillOpsPromotionTask({
    busRoot,
    workdir,
    planPath,
    curationWorkdir,
  });
  await fs.mkdir(path.join(busRoot, 'inbox', 'autopilot', 'seen'), { recursive: true });
  await fs.rename(
    queuedTaskPath,
    path.join(busRoot, 'inbox', 'autopilot', 'seen', path.basename(queuedTaskPath)),
  );
  await writeSkillOpsProofLog({
    workdir,
    status: 'queued',
    updates: ['Reuse the live queued promotion lane without deleting deterministic state.'],
  });
  await writeBasicAutopilotUserTask({ busRoot });

  const { receipt } = await runAutopilotWorkerAndReadReceipt({
    repoRoot,
    busRoot,
    rosterPath,
    dummyCodex,
    env: buildSkillOpsAutopilotEnv({ busRoot, worktreesDir }),
  });
  assert.equal(receipt.outcome, 'done');
  assert.equal(receipt.receiptExtra.runtimeGuard.skillOpsPromotion.status, 'queued');
  assert.equal(receipt.receiptExtra.skillOpsPromotionPlanPath, planPath);
  assert.equal(receipt.receiptExtra.skillOpsPromotionStatePath, statePath);
  assert.equal(await fs.readFile(planPath, 'utf8'), originalPlan);

  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  assert.equal(state.planPath, planPath);
});

test('daddy-autopilot: skillops gate fails closed before overwriting a live queued promotion lane with different targetPaths', async () => {
  const { repoRoot, busRoot, rosterPath, dummyCodex, workdir, worktreesDir } = await setupSkillOpsAutopilotHarness({
    prefix: 'agentic-codex-app-server-skillops-target-drift-',
  });
  const mismatchedTarget = '.codex/skills/cockpit-exec-agent/SKILL.md';
  const curationWorkdir = path.join(worktreesDir, 'autopilot-skillops-promotion');
  const planPath = await writeSkillOpsPromotionPlanFixture({
    busRoot,
    text: 'Keep the original queued plan intact when a rerun targets a different durable scope.',
    durableTarget: mismatchedTarget,
  });
  const originalPlan = await fs.readFile(planPath, 'utf8');
  const statePath = path.join(busRoot, 'state', 'skillops-promotions', 'autopilot', 'root1.json');
  await fs.writeFile(
    statePath,
    JSON.stringify(
      buildSkillOpsPromotionStateFixture({
        workdir,
        busRoot,
        worktreesDir,
        status: 'queued',
        targetPaths: [mismatchedTarget],
      }),
      null,
      2,
    ) + '\n',
    'utf8',
  );
  const queuedTaskPath = await writeQueuedSkillOpsPromotionTask({
    busRoot,
    workdir,
    planPath,
    curationWorkdir,
  });
  await fs.mkdir(path.join(busRoot, 'inbox', 'autopilot', 'seen'), { recursive: true });
  await fs.rename(
    queuedTaskPath,
    path.join(busRoot, 'inbox', 'autopilot', 'seen', path.basename(queuedTaskPath)),
  );
  const logPath = await writeSkillOpsProofLog({
    workdir,
    updates: ['Current rerun should target cockpit-autopilot, not the live queued lane target.'],
  });
  await writeBasicAutopilotUserTask({ busRoot });

  const { receipt } = await runAutopilotWorkerAndReadReceipt({
    repoRoot,
    busRoot,
    rosterPath,
    dummyCodex,
    env: buildSkillOpsAutopilotEnv({ busRoot, worktreesDir }),
  });
  assert.equal(receipt.outcome, 'needs_review');
  assert.equal(receipt.receiptExtra.reasonCode, 'skillops_promotion_handoff_failed');
  assert.equal(receipt.receiptExtra.runtimeGuard.skillOpsPromotion.reasonCode, 'skillops_promotion_handoff_failed');
  assert.match(String(receipt.receiptExtra.runtimeGuard.skillOpsPromotion.detail || ''), /different durable target set/);
  assert.equal(await fs.readFile(planPath, 'utf8'), originalPlan);

  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  assert.deepEqual(state.targetPaths, [mismatchedTarget]);
  const pendingLog = await fs.readFile(logPath, 'utf8');
  assert.match(pendingLog, /status:\s*pending/);
});

test('daddy-autopilot: unsupported SkillOps CLI closes the original root needs_review instead of fake-closing done', async () => {
  const { repoRoot, tmp, busRoot, rosterPath, dummyCodex, workdir, worktreesDir } = await setupSkillOpsAutopilotHarness({
    prefix: 'agentic-codex-app-server-skillops-unsupported-',
    runtime: 'unsupported',
  });
  await writeSkillOpsProofLog({
    workdir,
    updates: ['This repo still speaks the old durable-distill contract.'],
  });
  await writeBasicAutopilotUserTask({ busRoot });

  const { receipt } = await runAutopilotWorkerAndReadReceipt({
    repoRoot,
    busRoot,
    rosterPath,
    dummyCodex,
    env: buildSkillOpsAutopilotEnv({ busRoot, worktreesDir }),
  });
  assert.equal(receipt.outcome, 'needs_review');
  assert.equal(receipt.receiptExtra.reasonCode, 'skillops_cli_unsupported');
  assert.equal(receipt.receiptExtra.runtimeGuard.skillOpsPromotion.reasonCode, 'skillops_cli_unsupported');
});

test('daddy-autopilot: queued skillops-promotion task fails at claim when capability preflight drifts', async () => {
  const { repoRoot, busRoot, rosterPath, dummyCodex, workdir, worktreesDir } = await setupSkillOpsAutopilotHarness({
    prefix: 'agentic-codex-app-server-skillops-claim-fail-',
    runtime: 'unsupported',
  });
  const curationWorkdir = path.join(worktreesDir, 'autopilot-skillops-promotion');
  const planPath = await writeSkillOpsPromotionPlanFixture({
    busRoot,
    text: 'Keep promotion handoff durable.',
  });
  const statePath = path.join(busRoot, 'state', 'skillops-promotions', 'autopilot', 'root1.json');
  await fs.writeFile(
    statePath,
    JSON.stringify(buildSkillOpsPromotionStateFixture({ workdir, busRoot, worktreesDir, status: 'queued' }), null, 2) + '\n',
    'utf8',
  );
  await writeQueuedSkillOpsPromotionTask({
    busRoot,
    workdir,
    planPath,
    curationWorkdir,
  });

  const { receipt } = await runAutopilotWorkerAndReadReceipt({
    repoRoot,
    busRoot,
    rosterPath,
    dummyCodex,
    env: buildSkillOpsAutopilotEnv({ busRoot, worktreesDir, dummyMode: 'basic' }),
    taskId: 'skillops_promotion__autopilot__root1',
  });
  assert.equal(receipt.outcome, 'blocked');
  assert.equal(receipt.receiptExtra.reasonCode, 'skillops_cli_unsupported_at_claim');

  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  assert.equal(state.status, 'needs_review');
  assert.equal(state.reasonCode, 'skillops_cli_unsupported_at_claim');
  await assert.rejects(
    fs.stat(path.join(busRoot, 'state', 'skillops-promotions', 'autopilot.lock')),
    /ENOENT/,
  );
});

test('daddy-autopilot: queued skillops-promotion task fails at claim when capabilities omit the discriminator kind', async () => {
  const { repoRoot, busRoot, rosterPath, dummyCodex, workdir, worktreesDir } = await setupSkillOpsAutopilotHarness({
    prefix: 'agentic-codex-app-server-skillops-claim-missing-kind-',
  });
  const curationWorkdir = path.join(worktreesDir, 'autopilot-skillops-promotion');
  await makeSkillOpsCapabilitiesOmitKind({ workdir });
  commitSkillOpsRuntimeFixture({ workdir, message: 'drift capabilities kind fixture' });
  const planPath = await writeSkillOpsPromotionPlanFixture({
    busRoot,
    text: 'Require the portable capability discriminator.',
  });
  const statePath = path.join(busRoot, 'state', 'skillops-promotions', 'autopilot', 'root1.json');
  await fs.writeFile(
    statePath,
    JSON.stringify(buildSkillOpsPromotionStateFixture({ workdir, busRoot, worktreesDir, status: 'queued' }), null, 2) + '\n',
    'utf8',
  );
  await writeQueuedSkillOpsPromotionTask({
    busRoot,
    workdir,
    planPath,
    curationWorkdir,
  });

  const { receipt } = await runAutopilotWorkerAndReadReceipt({
    repoRoot,
    busRoot,
    rosterPath,
    dummyCodex,
    env: buildSkillOpsAutopilotEnv({ busRoot, worktreesDir, dummyMode: 'basic' }),
    taskId: 'skillops_promotion__autopilot__root1',
  });
  assert.equal(receipt.outcome, 'blocked');
  assert.equal(receipt.receiptExtra.reasonCode, 'skillops_cli_unsupported_at_claim');

  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  assert.equal(state.status, 'needs_review');
  assert.equal(state.reasonCode, 'skillops_cli_unsupported_at_claim');
});

test('daddy-autopilot: queued skillops-promotion task fails at claim when capability command metadata drifts', async () => {
  const { repoRoot, busRoot, rosterPath, dummyCodex, workdir, worktreesDir } = await setupSkillOpsAutopilotHarness({
    prefix: 'agentic-codex-app-server-skillops-claim-command-metadata-drift-',
  });
  const curationWorkdir = path.join(worktreesDir, 'autopilot-skillops-promotion');
  await makeSkillOpsCapabilitiesPayloadFilesMetadataDrift({ workdir });
  commitSkillOpsRuntimeFixture({ workdir, message: 'drift payload-files capability fixture' });
  const planPath = await writeSkillOpsPromotionPlanFixture({
    busRoot,
    text: 'Require exact payload-files command metadata during claim preflight.',
  });
  const statePath = path.join(busRoot, 'state', 'skillops-promotions', 'autopilot', 'root1.json');
  await fs.writeFile(
    statePath,
    JSON.stringify(buildSkillOpsPromotionStateFixture({ workdir, busRoot, worktreesDir, status: 'queued' }), null, 2) + '\n',
    'utf8',
  );
  await writeQueuedSkillOpsPromotionTask({
    busRoot,
    workdir,
    planPath,
    curationWorkdir,
  });

  const { receipt } = await runAutopilotWorkerAndReadReceipt({
    repoRoot,
    busRoot,
    rosterPath,
    dummyCodex,
    env: buildSkillOpsAutopilotEnv({ busRoot, worktreesDir, dummyMode: 'basic' }),
    taskId: 'skillops_promotion__autopilot__root1',
  });
  assert.equal(receipt.outcome, 'blocked');
  assert.equal(receipt.receiptExtra.reasonCode, 'skillops_cli_unsupported_at_claim');

  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  assert.equal(state.status, 'needs_review');
  assert.equal(state.reasonCode, 'skillops_cli_unsupported_at_claim');
  assert.match(String(state.error || ''), /payload-files command surface mismatch/);
});

test('daddy-autopilot: queued skillops-promotion task rejects packets that are no longer pinned to queued state', async () => {
  const { repoRoot, busRoot, rosterPath, dummyCodex, workdir, worktreesDir } = await setupSkillOpsAutopilotHarness({
    prefix: 'agentic-codex-app-server-skillops-missing-state-',
  });
  const curationWorkdir = path.join(worktreesDir, 'autopilot-skillops-promotion');
  const planPath = await writeSkillOpsPromotionPlanFixture({
    busRoot,
    text: 'Reject stale queued packets without pinned state.',
  });
  const statePath = path.join(busRoot, 'state', 'skillops-promotions', 'autopilot', 'root1.json');
  await writeQueuedSkillOpsPromotionTask({
    busRoot,
    workdir,
    planPath,
    curationWorkdir,
  });

  const { receipt } = await runAutopilotWorkerAndReadReceipt({
    repoRoot,
    busRoot,
    rosterPath,
    dummyCodex,
    env: buildSkillOpsAutopilotEnv({ busRoot, worktreesDir, dummyMode: 'basic' }),
    taskId: 'skillops_promotion__autopilot__root1',
  });
  assert.equal(receipt.outcome, 'blocked');
  assert.equal(receipt.receiptExtra.reasonCode, 'skillops_promotion_legacy_state');

  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  assert.equal(state.status, 'needs_review');
  assert.equal(state.reasonCode, 'skillops_promotion_legacy_state');
  assert.match(String(state.error || ''), /missing or invalid/);
  await assert.rejects(
    fs.stat(path.join(busRoot, 'state', 'skillops-promotions', 'autopilot.lock')),
    /ENOENT/,
  );
  await assert.rejects(fs.stat(curationWorkdir), /ENOENT/);
});

test('daddy-autopilot: queued skillops-promotion task rejects packets whose baseRef drifted after queue', async () => {
  const { repoRoot, busRoot, rosterPath, dummyCodex, workdir, worktreesDir } = await setupSkillOpsAutopilotHarness({
    prefix: 'agentic-codex-app-server-skillops-base-ref-drift-',
  });
  const curationWorkdir = path.join(worktreesDir, 'autopilot-skillops-promotion');
  const planPath = await writeSkillOpsPromotionPlanFixture({
    busRoot,
    text: 'Keep queued promotion claim pinned to the original base branch.',
  });
  const statePath = path.join(busRoot, 'state', 'skillops-promotions', 'autopilot', 'root1.json');
  await fs.writeFile(
    statePath,
    JSON.stringify(buildSkillOpsPromotionStateFixture({ workdir, busRoot, worktreesDir, status: 'queued' }), null, 2) + '\n',
    'utf8',
  );
  await writeQueuedSkillOpsPromotionTask({
    busRoot,
    workdir,
    planPath,
    curationWorkdir,
    baseBranch: 'release/root1',
  });

  const { receipt } = await runAutopilotWorkerAndReadReceipt({
    repoRoot,
    busRoot,
    rosterPath,
    dummyCodex,
    env: buildSkillOpsAutopilotEnv({ busRoot, worktreesDir, dummyMode: 'basic' }),
    taskId: 'skillops_promotion__autopilot__root1',
  });
  assert.equal(receipt.outcome, 'blocked');
  assert.equal(receipt.receiptExtra.reasonCode, 'skillops_promotion_legacy_state');

  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  assert.equal(state.status, 'needs_review');
  assert.equal(state.reasonCode, 'skillops_promotion_legacy_state');
  assert.match(String(state.error || ''), /baseRef/);
  await assert.rejects(
    fs.stat(path.join(busRoot, 'state', 'skillops-promotions', 'autopilot.lock')),
    /ENOENT/,
  );
  await assert.rejects(fs.stat(curationWorkdir), /ENOENT/);
});

test('daddy-autopilot: queued skillops-promotion task rejects plans whose source log scope drifted after queue', async () => {
  const { repoRoot, busRoot, rosterPath, dummyCodex, workdir, worktreesDir } = await setupSkillOpsAutopilotHarness({
    prefix: 'agentic-codex-app-server-skillops-claim-plan-drift-',
  });
  const curationWorkdir = path.join(worktreesDir, 'autopilot-skillops-promotion');
  const planPath = await writeSkillOpsPromotionPlanFixture({
    busRoot,
    text: 'Keep queued promotion scope pinned to the original source logs.',
  });
  const statePath = path.join(busRoot, 'state', 'skillops-promotions', 'autopilot', 'root1.json');
  await fs.writeFile(
    statePath,
    JSON.stringify(buildSkillOpsPromotionStateFixture({ workdir, busRoot, worktreesDir, status: 'queued' }), null, 2) + '\n',
    'utf8',
  );
  await writeQueuedSkillOpsPromotionTask({
    busRoot,
    workdir,
    planPath,
    curationWorkdir,
  });
  await fs.writeFile(
    planPath,
    JSON.stringify(
      buildSkillOpsPromotionPlanFixture({
        text: 'Mutated queued plan should not be re-pinned at claim time.',
        logId: 'drifted-log',
        logPath: '.codex/skill-ops/logs/2026/02/drifted-log.md',
      }),
      null,
      2,
    ) + '\n',
    'utf8',
  );

  const { receipt } = await runAutopilotWorkerAndReadReceipt({
    repoRoot,
    busRoot,
    rosterPath,
    dummyCodex,
    env: buildSkillOpsAutopilotEnv({ busRoot, worktreesDir, dummyMode: 'basic' }),
    taskId: 'skillops_promotion__autopilot__root1',
  });
  assert.equal(receipt.outcome, 'blocked');
  assert.equal(receipt.receiptExtra.reasonCode, 'skillops_promotion_legacy_state');

  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  assert.equal(state.status, 'needs_review');
  assert.equal(state.reasonCode, 'skillops_promotion_legacy_state');
  assert.match(String(state.error || ''), /sourceLogIds drifted after queue/);
  await assert.rejects(
    fs.stat(path.join(busRoot, 'state', 'skillops-promotions', 'autopilot.lock')),
    /ENOENT/,
  );
  await assert.rejects(fs.stat(curationWorkdir), /ENOENT/);
});

test('daddy-autopilot: queued skillops-promotion task rejects packets whose baseSha drifted after queue', async () => {
  const { repoRoot, busRoot, rosterPath, dummyCodex, workdir, worktreesDir } = await setupSkillOpsAutopilotHarness({
    prefix: 'agentic-codex-app-server-skillops-base-sha-drift-',
  });
  const curationWorkdir = path.join(worktreesDir, 'autopilot-skillops-promotion');
  const planPath = await writeSkillOpsPromotionPlanFixture({
    busRoot,
    text: 'Keep queued promotion claim pinned to the original base SHA.',
  });
  const statePath = path.join(busRoot, 'state', 'skillops-promotions', 'autopilot', 'root1.json');
  await fs.writeFile(
    statePath,
    JSON.stringify(buildSkillOpsPromotionStateFixture({ workdir, busRoot, worktreesDir, status: 'queued' }), null, 2) + '\n',
    'utf8',
  );
  await writeQueuedSkillOpsPromotionTask({
    busRoot,
    workdir,
    planPath,
    curationWorkdir,
    baseShaOverride: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
  });

  const { receipt } = await runAutopilotWorkerAndReadReceipt({
    repoRoot,
    busRoot,
    rosterPath,
    dummyCodex,
    env: buildSkillOpsAutopilotEnv({ busRoot, worktreesDir, dummyMode: 'basic' }),
    taskId: 'skillops_promotion__autopilot__root1',
  });
  assert.equal(receipt.outcome, 'blocked');
  assert.equal(receipt.receiptExtra.reasonCode, 'skillops_promotion_legacy_state');

  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  assert.equal(state.status, 'needs_review');
  assert.equal(state.reasonCode, 'skillops_promotion_legacy_state');
  assert.match(String(state.error || ''), /baseSha/);
  await assert.rejects(
    fs.stat(path.join(busRoot, 'state', 'skillops-promotions', 'autopilot.lock')),
    /ENOENT/,
  );
  await assert.rejects(fs.stat(curationWorkdir), /ENOENT/);
});

test('daddy-autopilot: queued skillops-promotion task rejects hand-edited targets outside durable SkillOps globs', async () => {
  const { repoRoot, busRoot, rosterPath, dummyCodex, workdir, worktreesDir } = await setupSkillOpsAutopilotHarness({
    prefix: 'agentic-codex-app-server-skillops-invalid-target-',
  });
  const invalidTarget = 'README.md';
  const curationWorkdir = path.join(worktreesDir, 'autopilot-skillops-promotion');
  const planPath = await writeSkillOpsPromotionPlanFixture({
    busRoot,
    text: 'Reject hand-edited promotion targets outside durable scope.',
    durableTarget: invalidTarget,
    targetPaths: [invalidTarget],
  });
  const statePath = path.join(busRoot, 'state', 'skillops-promotions', 'autopilot', 'root1.json');
  await fs.writeFile(
    statePath,
    JSON.stringify(
      buildSkillOpsPromotionStateFixture({
        workdir,
        busRoot,
        worktreesDir,
        status: 'queued',
        targetPaths: [invalidTarget],
      }),
      null,
      2,
    ) + '\n',
    'utf8',
  );
  await writeQueuedSkillOpsPromotionTask({
    busRoot,
    workdir,
    planPath,
    curationWorkdir,
  });

  const { receipt } = await runAutopilotWorkerAndReadReceipt({
    repoRoot,
    busRoot,
    rosterPath,
    dummyCodex,
    env: buildSkillOpsAutopilotEnv({ busRoot, worktreesDir, dummyMode: 'basic' }),
    taskId: 'skillops_promotion__autopilot__root1',
  });
  assert.equal(receipt.outcome, 'blocked');
  assert.equal(receipt.receiptExtra.reasonCode, 'skillops_promotion_legacy_state');

  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  assert.equal(state.status, 'needs_review');
  assert.equal(state.reasonCode, 'skillops_promotion_legacy_state');
  assert.match(String(state.error || ''), /README\.md/);
});

test('daddy-autopilot: queued skillops-promotion task rejects forged claimed sourceWorkdir before lock or worktree mutation', async () => {
  const { repoRoot, tmp, busRoot, rosterPath, dummyCodex, workdir, worktreesDir } = await setupSkillOpsAutopilotHarness({
    prefix: 'agentic-codex-app-server-skillops-forged-source-',
  });
  const forgedWorkdir = await createTestGitWorkdir({ rootDir: path.join(tmp, 'forged-source') });
  const curationWorkdir = path.join(worktreesDir, 'autopilot-skillops-promotion');
  const planPath = await writeSkillOpsPromotionPlanFixture({
    busRoot,
    text: 'Reject forged promotion packet workdirs before mutation.',
  });
  const statePath = path.join(busRoot, 'state', 'skillops-promotions', 'autopilot', 'root1.json');
  await fs.writeFile(
    statePath,
    JSON.stringify(buildSkillOpsPromotionStateFixture({ workdir, busRoot, worktreesDir, status: 'queued' }), null, 2) + '\n',
    'utf8',
  );
  await writeQueuedSkillOpsPromotionTask({
    busRoot,
    workdir,
    planPath,
    curationWorkdir,
    sourceWorkdir: forgedWorkdir,
  });

  const { receipt } = await runAutopilotWorkerAndReadReceipt({
    repoRoot,
    busRoot,
    rosterPath,
    dummyCodex,
    env: buildSkillOpsAutopilotEnv({ busRoot, worktreesDir, dummyMode: 'basic' }),
    taskId: 'skillops_promotion__autopilot__root1',
  });
  assert.equal(receipt.outcome, 'blocked');
  assert.equal(receipt.receiptExtra.reasonCode, 'skillops_promotion_invalid');
  assert.match(String(receipt.note || ''), /sourceworkdir/i);

  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  assert.equal(state.status, 'needs_review');
  assert.equal(state.reasonCode, 'skillops_promotion_invalid');
  await assert.rejects(
    fs.stat(path.join(busRoot, 'state', 'skillops-promotions', 'autopilot.lock')),
    /ENOENT/,
  );
  await assert.rejects(fs.stat(curationWorkdir), /ENOENT/);
});

test('daddy-autopilot: controller housekeeping fails closed when scratch cleanup cannot remove the scratch worktree', async () => {
  const { repoRoot, tmp, busRoot, rosterPath, dummyCodex, workdir, worktreesDir } = await setupSkillOpsAutopilotHarness({
    prefix: 'agentic-codex-app-server-housekeeping-scratch-fail-',
  });
  for (const [srcRel, destRel] of [
    ['.codex/skills', '.codex/skills'],
    ['.codex/opus', '.codex/opus'],
    ['docs', 'docs'],
  ]) {
    try {
      await fs.cp(path.join(repoRoot, srcRel), path.join(workdir, destRel), { recursive: true, force: true });
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
  }
  for (const fileName of ['AGENTS.md', 'CLAUDE.md']) {
    try {
      await fs.copyFile(path.join(repoRoot, fileName), path.join(workdir, fileName));
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
  }
  await installSupportedSkillOpsRuntime({ repoRoot, workdir });
  runGit(workdir, ['add', '.']);
  runGit(workdir, ['commit', '-m', 'install supported skillops runtime']);

  await writeSkillOpsProofLog({
    workdir,
    updates: ['Fail closed when controller-housekeeping scratch cleanup leaves registered metadata behind.'],
  });
  const sourcePlanPath = path.join(tmp, 'source-plan.json');
  const sourcePlan = childProcess.execFileSync('node', ['scripts/skillops.mjs', 'plan-promotions', '--json'], {
    cwd: workdir,
    encoding: 'utf8',
  });
  await fs.writeFile(sourcePlanPath, sourcePlan, 'utf8');
  childProcess.execFileSync('node', ['scripts/skillops.mjs', 'apply-promotions', '--plan', sourcePlanPath], {
    cwd: workdir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const fixtureSupportPaths = childProcess
    .execFileSync('git', ['status', '--porcelain=v1'], { cwd: workdir, encoding: 'utf8' })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('?? '))
    .map((line) => line.slice(3).trim())
    .filter((repoPath) => repoPath && !repoPath.startsWith('.codex/skill-ops/'));
  if (fixtureSupportPaths.length > 0) {
    childProcess.execFileSync('git', ['add', '--', ...fixtureSupportPaths], {
      cwd: workdir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    runGit(workdir, ['commit', '-m', 'hydrate fixture support files']);
  }

  const headSha = childProcess.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workdir, encoding: 'utf8' }).trim();
  const branch = childProcess.execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: workdir, encoding: 'utf8' }).trim();
  const repoCommonGitDir = path.resolve(
    workdir,
    childProcess.execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: workdir, encoding: 'utf8' }).trim(),
  );
  const recoverableStatusPorcelain = childProcess.execFileSync('git', ['status', '--porcelain'], {
    cwd: workdir,
    encoding: 'utf8',
  }).trim();
  const staged = await stageControllerHousekeepingSuspension({
    busRoot,
    agentName: 'autopilot',
    fingerprint: 'fp-scratch-fail',
    branch,
    headSha,
    repoCommonGitDir,
    recoverableStatusPorcelain,
    openedMeta: {
      id: 't1',
      to: ['autopilot'],
      from: 'daddy',
      priority: 'P2',
      title: 'blocked root',
      signals: {
        kind: 'USER_REQUEST',
        rootId: 'root1',
        parentId: '',
        smoke: false,
      },
      references: {},
    },
    openedBody: 'resume me later',
  });
  assert.equal(staged.action, 'queue');
  await writeTask({
    busRoot,
    agentName: 'autopilot',
    taskId: staged.taskMeta.id,
    meta: staged.taskMeta,
    body: staged.taskBody,
  });
  const wrapperDir = await makeGitWrapperThatFailsScratchRemove({ tmp });

  const { receipt } = await runAutopilotWorkerAndReadReceipt({
    repoRoot,
    busRoot,
    rosterPath,
    dummyCodex,
    env: {
      ...buildSkillOpsAutopilotEnv({ busRoot, worktreesDir, dummyMode: 'basic' }),
      PATH: `${wrapperDir}:${process.env.PATH || ''}`,
    },
    taskId: staged.taskMeta.id,
  });
  assert.equal(receipt.outcome, 'failed');
  assert.equal(receipt.receiptExtra.reasonCode, 'controller_housekeeping_verification_failed');
  assert.match(String(receipt.receiptExtra.details?.scratchCleanup?.detail || ''), /scratch worktree/i);
  await assert.rejects(
    fs.stat(path.join(busRoot, 'inbox', 'autopilot', 'new', 'controller_resume__t1__fp-scratch-fail__g1.md')),
    /ENOENT/,
  );
});

test('daddy-autopilot: controller housekeeping ignores new overflow archive targets when restoring HEAD paths', async () => {
  const { repoRoot, tmp, busRoot, rosterPath, dummyCodex, workdir, worktreesDir } = await setupSkillOpsAutopilotHarness({
    prefix: 'agentic-codex-app-server-housekeeping-overflow-archive-',
  });
  for (const [srcRel, destRel] of [
    ['.codex/skills', '.codex/skills'],
    ['.codex/opus', '.codex/opus'],
    ['docs', 'docs'],
  ]) {
    try {
      await fs.cp(path.join(repoRoot, srcRel), path.join(workdir, destRel), { recursive: true, force: true });
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
  }
  for (const fileName of ['AGENTS.md', 'CLAUDE.md']) {
    try {
      await fs.copyFile(path.join(repoRoot, fileName), path.join(workdir, fileName));
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
  }
  await installSupportedSkillOpsRuntime({ repoRoot, workdir });
  const skillPath = path.join(workdir, '.codex', 'skills', 'cockpit-autopilot', 'SKILL.md');
  const crowdedSkill = (await fs.readFile(skillPath, 'utf8')).replace(
    '<!-- SKILLOPS:LEARNED:BEGIN -->\n<!-- SKILLOPS:LEARNED:END -->',
    [
      '<!-- SKILLOPS:LEARNED:BEGIN -->',
      ...Array.from({ length: 30 }, (_, index) => `- Existing learned rule ${index + 1}. [src:seed-${index + 1}]`),
      '<!-- SKILLOPS:LEARNED:END -->',
    ].join('\n'),
  );
  await fs.writeFile(skillPath, crowdedSkill, 'utf8');
  runGit(workdir, ['add', '.']);
  runGit(workdir, ['commit', '-m', 'seed supported skillops runtime with crowded autopilot skill']);

  await writeSkillOpsProofLog({
    workdir,
    updates: ['Newest overflow rule should not make restoreHeadPaths choke on a brand-new archive target.'],
  });
  const sourcePlanPath = path.join(tmp, 'source-plan.json');
  const sourcePlan = childProcess.execFileSync('node', ['scripts/skillops.mjs', 'plan-promotions', '--json'], {
    cwd: workdir,
    encoding: 'utf8',
  });
  await fs.writeFile(sourcePlanPath, sourcePlan, 'utf8');
  childProcess.execFileSync('node', ['scripts/skillops.mjs', 'apply-promotions', '--plan', sourcePlanPath], {
    cwd: workdir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await fs.rm(path.join(workdir, '.codex', 'skill-ops', 'archive', 'cockpit-autopilot.md'), { force: true });

  const headSha = childProcess.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workdir, encoding: 'utf8' }).trim();
  const branch = childProcess.execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: workdir, encoding: 'utf8' }).trim();
  const repoCommonGitDir = path.resolve(
    workdir,
    childProcess.execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: workdir, encoding: 'utf8' }).trim(),
  );
  const recoverableStatusPorcelain = childProcess.execFileSync('git', ['status', '--porcelain'], {
    cwd: workdir,
    encoding: 'utf8',
  }).trim();

  const staged = await stageControllerHousekeepingSuspension({
    busRoot,
    agentName: 'autopilot',
    fingerprint: 'fp-overflow-archive',
    branch,
    headSha,
    repoCommonGitDir,
    recoverableStatusPorcelain,
    openedMeta: {
      id: 't1',
      to: ['autopilot'],
      from: 'daddy',
      priority: 'P2',
      title: 'blocked root',
      signals: {
        kind: 'USER_REQUEST',
        rootId: 'root1',
        parentId: '',
        smoke: false,
      },
      references: {},
    },
    openedBody: 'resume me later',
  });
  assert.equal(staged.action, 'queue');
  await writeTask({
    busRoot,
    agentName: 'autopilot',
    taskId: staged.taskMeta.id,
    meta: staged.taskMeta,
    body: staged.taskBody,
  });

  const { receipt } = await runAutopilotWorkerAndReadReceipt({
    repoRoot,
    busRoot,
    rosterPath,
    dummyCodex,
    env: buildSkillOpsAutopilotEnv({ busRoot, worktreesDir, dummyMode: 'basic' }),
    taskId: staged.taskMeta.id,
  });
  assert.equal(receipt.outcome, 'done');
  assert.equal(receipt.receiptExtra.reasonCode, '');
  assert.equal(
    await waitForPath(path.join(busRoot, 'inbox', 'autopilot', 'new', 'controller_resume__t1__fp-overflow-archive__g1.md')),
    true,
  );
  await assert.rejects(
    fs.stat(path.join(workdir, '.codex', 'skill-ops', 'archive', 'cockpit-autopilot.md')),
    /ENOENT/,
  );
});

test('daddy-autopilot: stale dirty controller recovery refs do not queue controller-housekeeping after current dirt is gone', async () => {
  const { repoRoot, busRoot, rosterPath, dummyCodex, workdir, worktreesDir } = await setupSkillOpsAutopilotHarness({
    prefix: 'agentic-codex-app-server-housekeeping-stale-controller-',
  });
  const taskId = 'autopilot_recovery__t1__1';
  const fingerprint = 'fp-stale-controller';
  const housekeepingStatePath = getControllerHousekeepingStatePath({
    busRoot,
    agentName: 'autopilot',
    fingerprint,
  });
  await writeTask({
    busRoot,
    agentName: 'autopilot',
    taskId,
    meta: {
      id: taskId,
      to: ['autopilot'],
      from: 'autopilot',
      priority: 'P2',
      title: 'retry blocked root',
      signals: {
        kind: 'USER_REQUEST',
        sourceKind: 'AUTOPILOT_BLOCKED_RECOVERY',
        phase: 'blocked-recovery',
        rootId: 'root1',
        parentId: 't1',
        smoke: false,
        notifyOrchestrator: false,
      },
      references: {
        parentTaskId: 't1',
        parentRootId: 'root1',
        autopilotRecoverySourceTaskId: 't1',
        autopilotRecovery: {
          recoveryKey: taskId,
          attempt: 1,
          maxAttempts: null,
          contractClass: 'controller',
          reasonCode: 'dirty_cross_root_transition',
          fingerprint,
        },
      },
    },
    body: 'retry blocked root',
  });

  const { receipt } = await runAutopilotWorkerAndReadReceipt({
    repoRoot,
    busRoot,
    rosterPath,
    dummyCodex,
    env: {
      ...buildSkillOpsAutopilotEnv({ busRoot, worktreesDir, dummyMode: 'blocked-basic' }),
      AGENTIC_AUTOPILOT_SKILLOPS_GATE: '0',
    },
    taskId,
  });
  assert.equal(receipt.outcome, 'blocked');
  assert.equal(receipt.receiptExtra.blockedRecoveryContract?.class, 'controller');
  assert.equal(receipt.receiptExtra.blockedRecoveryContract?.reasonCode, 'dirty_cross_root_transition');
  assert.equal(receipt.receiptExtra.autopilotRecovery?.reason, 'unchanged_evidence');
  assert.doesNotMatch(String(receipt.note || ''), /controller_housekeeping_(pending|unchanged)/);
  await assert.rejects(fs.stat(housekeepingStatePath), /ENOENT/);

  let queuedPackets = [];
  try {
    queuedPackets = await fs.readdir(path.join(busRoot, 'inbox', 'autopilot', 'new'));
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  assert.deepEqual(
    queuedPackets.filter((name) => name.startsWith('controller_housekeeping__')),
    [],
  );
});

test('daddy-autopilot: skillops-promotion task starts Codex in the shared curation worktree', async () => {
  const { repoRoot, tmp, busRoot, rosterPath, dummyCodex, workdir, worktreesDir } = await setupSkillOpsAutopilotHarness({
    prefix: 'agentic-codex-app-server-skillops-cwd-',
  });
  const cwdLogFile = path.join(tmp, 'turn-cwd.txt');
  const curationWorkdir = path.join(worktreesDir, 'autopilot-skillops-promotion');
  const statePath = path.join(busRoot, 'state', 'skillops-promotions', 'autopilot', 'root1.json');

  await writeSkillOpsProofLog({
    workdir,
    updates: ['Run the promotion lane in the shared curation worktree only.'],
  });
  runGit(workdir, ['add', '.']);
  runGit(workdir, ['commit', '-m', 'install skillops runtime']);
  const planPath = await writeSkillOpsPromotionPlanFixture({
    busRoot,
    text: 'Run the promotion lane in the shared curation worktree only.',
  });
  await fs.writeFile(
    statePath,
    JSON.stringify(buildSkillOpsPromotionStateFixture({ workdir, busRoot, worktreesDir, status: 'queued' }), null, 2) + '\n',
    'utf8',
  );
  await writeQueuedSkillOpsPromotionTask({
    busRoot,
    workdir,
    planPath,
    curationWorkdir,
  });

  const { receipt } = await runAutopilotWorkerAndReadReceipt({
    repoRoot,
    busRoot,
    rosterPath,
    dummyCodex,
    env: {
      ...buildSkillOpsAutopilotEnv({ busRoot, worktreesDir, dummyMode: 'basic' }),
      CWD_LOG_FILE: cwdLogFile,
    },
    taskId: 'skillops_promotion__autopilot__root1',
  });

  assert.equal(await fs.readFile(cwdLogFile, 'utf8'), curationWorkdir);
  assert.equal(receipt.outcome, 'blocked');
  assert.equal(receipt.receiptExtra.runtimeGuard.skillOpsPromotion.reasonCode, 'skillops_promotion_scope_invalid');
});

async function runCodeQualityGateScenario({ mode, dirtyFilePath, dirtyFileContents }) {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), `agentic-codex-app-server-${mode}-`));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const workdir = await createTestGitWorkdir({
    rootDir: tmp,
    dirtyFilePath,
    dirtyFileContents,
  });
  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);
  const roster = {
    orchestratorName: 'orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'autopilot',
    agents: [
      {
        name: 'autopilot',
        role: 'autopilot-worker',
        skills: [],
        workdir,
        startCommand: 'node scripts/agent-codex-worker.mjs --agent autopilot',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');

  await writeTask({
    busRoot,
    agentName: 'autopilot',
    taskId: 't1',
    meta: { id: 't1', to: ['autopilot'], from: 'daddy', priority: 'P2', title: 't1', signals: { kind: 'USER_REQUEST' } },
    body: 'do t1',
  });
  const env = {
    ...BASE_ENV,
    COCKPIT_ROOT: repoRoot,
    AGENTIC_CODE_QUALITY_GATE: '1',
    AGENTIC_CODE_QUALITY_GATE_KINDS: 'USER_REQUEST',
    AGENTIC_AUTOPILOT_DELEGATE_GATE: '0',
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_APP_SERVER_TIMEOUT_MS: '2000',
    DUMMY_MODE: mode,
  };
  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'autopilot',
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
  const receiptPath = path.join(busRoot, 'receipts', 'autopilot', 't1.json');
  return JSON.parse(await fs.readFile(receiptPath, 'utf8'));
}

async function runExecutePreflightScenario({
  mode = 'basic',
  mergeCommitSha = '',
  integrationGateStrict = '1',
  title = 'execute with writer preflight',
  body = 'Implement the runtime fix.',
}) {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-preflight-execute-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const promptLogFile = path.join(tmp, 'prompts.log');
  const workdir = await createTestGitWorkdir({ rootDir: tmp });

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);

  const roster = {
    orchestratorName: 'orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'autopilot',
    agents: [
      {
        name: 'frontend',
        role: 'codex-worker',
        skills: [],
        workdir,
        startCommand: 'node scripts/agent-codex-worker.mjs --agent frontend',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');
  await ensureBusRoot(busRoot, roster);

  await writeTask({
    busRoot,
    agentName: 'frontend',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['frontend'],
      from: 'daddy',
      priority: 'P2',
      title,
      signals: { kind: 'EXECUTE', rootId: 'root1', phase: 'execute' },
      references: {},
    },
    body,
  });

  const env = {
    ...BASE_ENV,
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_APP_SERVER_TIMEOUT_MS: '5000',
    DUMMY_MODE: mode,
    MERGE_COMMIT_SHA: mergeCommitSha,
    AGENTIC_INTEGRATION_GATE_STRICT: integrationGateStrict,
    PROMPT_LOG_FILE: promptLogFile,
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'frontend',
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

  const receiptPath = path.join(busRoot, 'receipts', 'frontend', 't1.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  const promptLog = await fs.readFile(promptLogFile, 'utf8');
  const prompts = promptLog.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return { receipt, prompts, busRoot };
}

test('agent-codex-worker: EXECUTE turn injects writer preflight before execution and records preflightGate evidence', async () => {
  const { receipt, prompts } = await runExecutePreflightScenario({});
  assert.equal(receipt.outcome, 'done');
  const preflightGate = receipt.receiptExtra.runtimeGuard?.preflightGate;
  assert.deepEqual(Object.keys(preflightGate || {}).sort(), [
    'approved',
    'driftDetected',
    'noWritePass',
    'planHash',
    'reasonCode',
    'required',
  ]);
  assert.equal(preflightGate.required, true);
  assert.equal(preflightGate.approved, true);
  assert.equal(preflightGate.noWritePass, true);
  assert.equal(typeof preflightGate.planHash, 'string');
  assert.equal(preflightGate.planHash.length > 10, true);
  assert.equal(preflightGate.driftDetected, false);
  assert.equal(preflightGate.reasonCode, null);

  const preflightIndex = prompts.indexOf('preflight');
  const executionIndex = prompts.indexOf('execute');
  assert.equal(preflightIndex >= 0, true);
  assert.equal(executionIndex >= 0, true);
  assert.equal(preflightIndex < executionIndex, true);
});

test('agent-codex-worker: EXECUTE turn marks preflight closure unverified when commit delta is unavailable locally', async () => {
  const { receipt } = await runExecutePreflightScenario({
    mode: 'merge-commit-missing-local',
    mergeCommitSha: 'ffffffffffffffffffffffffffffffffffffffff',
    integrationGateStrict: '0',
    title: 'execute with unavailable source delta',
    body: 'Implement the runtime fix and return the remote commit SHA.',
  });
  assert.equal(receipt.outcome, 'done');
  assert.match(receipt.note, /closure_source_delta_unavailable/);
  assert.equal(receipt.receiptExtra.runtimeGuard?.preflightGate?.required, true);
  assert.equal(receipt.receiptExtra.runtimeGuard?.preflightGate?.approved, true);
  assert.equal(receipt.receiptExtra.runtimeGuard?.preflightGate?.noWritePass, true);
  assert.equal(receipt.receiptExtra.runtimeGuard?.preflightGate?.driftDetected, true);
  assert.equal(receipt.receiptExtra.runtimeGuard?.preflightGate?.reasonCode, 'closure_source_delta_unavailable');
});

test('agent-codex-worker: EXECUTE turn with open questions proceeds and keeps them visible in receipt preflightPlan', async () => {
  const { receipt, prompts } = await runExecutePreflightScenario({
    mode: 'preflight-open-questions',
    title: 'execute with unresolved preflight questions',
    body: 'Investigate first and do not edit until preflight is approved.',
  });
  assert.equal(receipt.outcome, 'done');
  assert.equal(receipt.receiptExtra.runtimeGuard?.preflightGate?.required, true);
  assert.equal(receipt.receiptExtra.runtimeGuard?.preflightGate?.approved, true);
  assert.equal(receipt.receiptExtra.runtimeGuard?.preflightGate?.noWritePass, true);
  assert.equal(receipt.receiptExtra.runtimeGuard?.preflightGate?.driftDetected, false);
  assert.deepEqual(receipt.receiptExtra.preflightPlan?.openQuestions, [
    'Still unclear whether reuse covers the touched path.',
  ]);
  assert.equal(prompts.filter((entry) => entry === 'preflight').length, 1);
  assert.equal(prompts.includes('execute'), true);
});

test('agent-codex-worker: autopilot EXECUTE turn fails open on missing consult agent after approved preflight', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-preflight-opus-missing-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const promptLogFile = path.join(tmp, 'prompts.log');
  const countFile = path.join(tmp, 'count.txt');
  const workdir = await createTestGitWorkdir({ rootDir: tmp });

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);

  const roster = {
    orchestratorName: 'orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'autopilot',
    agents: [
      {
        name: 'autopilot',
        role: 'autopilot-worker',
        skills: [],
        workdir,
        startCommand: 'node scripts/agent-codex-worker.mjs --agent autopilot',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');
  await ensureBusRoot(busRoot, roster);

  await writeTask({
    busRoot,
    agentName: 'autopilot',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['autopilot'],
      from: 'daddy',
      priority: 'P2',
      title: 'autopilot execute preflight consult fail-open',
      signals: { kind: 'EXECUTE', rootId: 'root1', phase: 'execute' },
      references: {},
    },
    body: 'Implement the runtime fix locally.',
  });

  const env = {
    ...BASE_ENV,
    AGENTIC_AUTOPILOT_DELEGATE_GATE: '0',
    AGENTIC_OPUS_CONSULT_MODE: 'advisory',
    AGENTIC_AUTOPILOT_OPUS_GATE: '1',
    AGENTIC_AUTOPILOT_OPUS_GATE_KINDS: 'EXECUTE',
    AGENTIC_AUTOPILOT_OPUS_POST_REVIEW: '0',
    AGENTIC_AUTOPILOT_OPUS_CONSULT_AGENT: 'opus-consult',
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_APP_SERVER_TIMEOUT_MS: '5000',
    DUMMY_MODE: 'basic',
    PROMPT_LOG_FILE: promptLogFile,
    COUNT_FILE: countFile,
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'autopilot',
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

  const receipt = JSON.parse(await fs.readFile(path.join(busRoot, 'receipts', 'autopilot', 't1.json'), 'utf8'));
  assert.equal(receipt.outcome, 'done');
  assert.equal(receipt.receiptExtra.opusConsult.status, 'warn');
  assert.equal(receipt.receiptExtra.opusConsult.reasonCode, 'opus_consult_dispatch_failed');
  assert.match(String(receipt.receiptExtra.opusConsultBarrier?.unlockReason || ''), /^pre_exec_fail_open:/);
  const turnCount = Number(await fs.readFile(countFile, 'utf8'));
  assert.equal(turnCount, 2);
  const prompts = (await fs.readFile(promptLogFile, 'utf8'))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  assert.deepEqual(prompts, ['preflight', 'execute']);
});

test('agent-codex-worker: autopilot EXECUTE turn blocks done closure when Opus dispositions are missing', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-preflight-opus-missing-disposition-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const promptLogFile = path.join(tmp, 'prompts.log');
  const countFile = path.join(tmp, 'count.txt');
  const workdir = await createTestGitWorkdir({ rootDir: tmp });

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);

  const roster = {
    orchestratorName: 'orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'autopilot',
    agents: [
      {
        name: 'autopilot',
        role: 'autopilot-worker',
        skills: [],
        workdir,
        startCommand: 'node scripts/agent-codex-worker.mjs --agent autopilot',
      },
      {
        name: 'opus-consult',
        role: 'opus-consult-worker',
        skills: [],
        workdir,
        startCommand: 'node scripts/agent-opus-consult-worker.mjs --agent opus-consult',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');
  await ensureBusRoot(busRoot, roster);

  await writeTask({
    busRoot,
    agentName: 'autopilot',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['autopilot'],
      from: 'daddy',
      priority: 'P2',
      title: 'autopilot execute preflight consult disposition required',
      signals: { kind: 'EXECUTE', rootId: 'root1', phase: 'execute' },
      references: {},
    },
    body: 'Implement the runtime fix locally.',
  });

  const env = {
    ...BASE_ENV,
    AGENTIC_AUTOPILOT_DELEGATE_GATE: '0',
    AGENTIC_OPUS_CONSULT_MODE: 'advisory',
    AGENTIC_AUTOPILOT_OPUS_GATE: '1',
    AGENTIC_AUTOPILOT_OPUS_GATE_KINDS: 'EXECUTE',
    AGENTIC_AUTOPILOT_OPUS_POST_REVIEW: '0',
    AGENTIC_AUTOPILOT_OPUS_CONSULT_AGENT: 'opus-consult',
    AGENTIC_AUTOPILOT_OPUS_GATE_TIMEOUT_MS: '1200',
    AGENTIC_OPUS_TIMEOUT_MS: '800',
    AGENTIC_OPUS_MAX_RETRIES: '0',
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_APP_SERVER_TIMEOUT_MS: '5000',
    DUMMY_MODE: 'opus-disposition-missing',
    PROMPT_LOG_FILE: promptLogFile,
    COUNT_FILE: countFile,
  };

  const runPromise = spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'autopilot',
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

  const consultRequestMeta = await waitForOpusConsultRequestMeta({ busRoot, timeoutMs: 4_000 });
  const requestPayload = consultRequestMeta?.references?.opus ?? {};
  assert.equal(typeof requestPayload?.taskContext?.references?.candidateOutput?.preflightPlan, 'object');
  await writeTask({
    busRoot,
    agentName: 'autopilot',
    taskId: 'resp_missing_disposition',
    meta: {
      id: 'resp_missing_disposition',
      to: ['autopilot'],
      from: 'opus-consult',
      priority: 'P2',
      title: 'advisory consult response',
      signals: {
        kind: 'OPUS_CONSULT_RESPONSE',
        phase: consultRequestMeta?.signals?.phase || 'pre_exec',
        rootId: consultRequestMeta?.signals?.rootId || null,
        parentId: consultRequestMeta?.id || null,
        smoke: false,
        notifyOrchestrator: false,
      },
      references: {
        opus: buildValidConsultResponsePayload({
          consultId: requestPayload.consultId,
          round: requestPayload.round,
        }),
      },
    },
    body: 'advisory consult response',
  });

  const run = await runPromise;
  assert.equal(run.code, 0, run.stderr || run.stdout);

  const receipt = JSON.parse(await fs.readFile(path.join(busRoot, 'receipts', 'autopilot', 't1.json'), 'utf8'));
  assert.equal(receipt.outcome, 'blocked');
  assert.equal(receipt.receiptExtra.reasonCode, 'opus_disposition_missing');
  assert.match(String(receipt.note || ''), /opus_disposition_missing:OPUS-1/);
  assert.deepEqual(receipt.receiptExtra.runtimeGuard?.opusDisposition?.missingIds, ['OPUS-1']);
  assert.deepEqual(receipt.receiptExtra.runtimeGuard?.opusDisposition?.acknowledgedIds, []);
  const turnCount = Number(await fs.readFile(countFile, 'utf8'));
  assert.equal(turnCount, 3);
  const prompts = (await fs.readFile(promptLogFile, 'utf8'))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  assert.deepEqual(prompts, ['preflight', 'preflight', 'execute']);
});

test('agent-codex-worker: autopilot EXECUTE turn accepts explicit Opus dispositions after consult challenge', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-preflight-opus-with-disposition-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const countFile = path.join(tmp, 'count.txt');
  const workdir = await createTestGitWorkdir({ rootDir: tmp });

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);

  const roster = {
    orchestratorName: 'orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'autopilot',
    agents: [
      {
        name: 'autopilot',
        role: 'autopilot-worker',
        skills: [],
        workdir,
        startCommand: 'node scripts/agent-codex-worker.mjs --agent autopilot',
      },
      {
        name: 'opus-consult',
        role: 'opus-consult-worker',
        skills: [],
        workdir,
        startCommand: 'node scripts/agent-opus-consult-worker.mjs --agent opus-consult',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');
  await ensureBusRoot(busRoot, roster);

  await writeTask({
    busRoot,
    agentName: 'autopilot',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['autopilot'],
      from: 'daddy',
      priority: 'P2',
      title: 'autopilot execute preflight consult disposition present',
      signals: { kind: 'EXECUTE', rootId: 'root1', phase: 'execute' },
      references: {},
    },
    body: 'Implement the runtime fix locally.',
  });

  const env = {
    ...BASE_ENV,
    AGENTIC_AUTOPILOT_DELEGATE_GATE: '0',
    AGENTIC_OPUS_CONSULT_MODE: 'advisory',
    AGENTIC_AUTOPILOT_OPUS_GATE: '1',
    AGENTIC_AUTOPILOT_OPUS_GATE_KINDS: 'EXECUTE',
    AGENTIC_AUTOPILOT_OPUS_POST_REVIEW: '0',
    AGENTIC_AUTOPILOT_OPUS_CONSULT_AGENT: 'opus-consult',
    AGENTIC_AUTOPILOT_OPUS_GATE_TIMEOUT_MS: '1200',
    AGENTIC_OPUS_TIMEOUT_MS: '800',
    AGENTIC_OPUS_MAX_RETRIES: '0',
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_APP_SERVER_TIMEOUT_MS: '5000',
    DUMMY_MODE: 'opus-disposition-present',
    COUNT_FILE: countFile,
  };

  const runPromise = spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'autopilot',
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

  const consultRequestMeta = await waitForOpusConsultRequestMeta({ busRoot, timeoutMs: 4_000 });
  const requestPayload = consultRequestMeta?.references?.opus ?? {};
  await writeTask({
    busRoot,
    agentName: 'autopilot',
    taskId: 'resp_present_disposition',
    meta: {
      id: 'resp_present_disposition',
      to: ['autopilot'],
      from: 'opus-consult',
      priority: 'P2',
      title: 'advisory consult response',
      signals: {
        kind: 'OPUS_CONSULT_RESPONSE',
        phase: consultRequestMeta?.signals?.phase || 'pre_exec',
        rootId: consultRequestMeta?.signals?.rootId || null,
        parentId: consultRequestMeta?.id || null,
        smoke: false,
        notifyOrchestrator: false,
      },
      references: {
        opus: buildValidConsultResponsePayload({
          consultId: requestPayload.consultId,
          round: requestPayload.round,
        }),
      },
    },
    body: 'advisory consult response',
  });

  const run = await runPromise;
  assert.equal(run.code, 0, run.stderr || run.stdout);

  const receipt = JSON.parse(await fs.readFile(path.join(busRoot, 'receipts', 'autopilot', 't1.json'), 'utf8'));
  assert.equal(receipt.outcome, 'done');
  assert.deepEqual(receipt.receiptExtra.runtimeGuard?.opusDisposition?.acknowledgedIds, ['OPUS-1']);
  assert.deepEqual(receipt.receiptExtra.runtimeGuard?.opusDisposition?.missingIds, []);
  const turnCount = Number(await fs.readFile(countFile, 'utf8'));
  assert.equal(turnCount, 3);
});

test('code-quality gate blocks done closure after bounded retry when qualityReview evidence is missing', async () => {
  const receipt = await runCodeQualityGateScenario({
    mode: 'quality-missing',
    dirtyFilePath: 'src/escape.js',
    dirtyFileContents: '/* eslint-disable */\nexport const value = 1;\n',
  });
  assert.equal(receipt.outcome, 'blocked');
  assert.match(receipt.note, /code quality gate failed/i);
  assert.equal(receipt.receiptExtra.runtimeGuard.codeQualityGate.required, true);
  assert.equal(receipt.receiptExtra.runtimeGuard.codeQualityGate.executed, true);
  assert.equal(receipt.receiptExtra.runtimeGuard.codeQualityGate.exitCode, 0);
  assert.equal(receipt.receiptExtra.runtimeGuard.codeQualityGate.retryCount, 1);
  assert.equal(receipt.receiptExtra.runtimeGuard.codeQualityGate.autoRemediationStopReason, 'unchanged_evidence');
  assert.match(
    String((receipt.receiptExtra.runtimeGuard.codeQualityGate.errors || []).join(' ')),
    /qualityReview evidence is required/i,
  );
});

test('code-quality gate accepts done closure when runtime check passes', async () => {
  const receipt = await runCodeQualityGateScenario({
    mode: 'quality-ok',
    dirtyFilePath: 'src/clean.js',
    dirtyFileContents: 'export const value = 1;\n',
  });
  assert.equal(receipt.outcome, 'done');
  assert.equal(receipt.receiptExtra.runtimeGuard.codeQualityGate.required, true);
  assert.equal(receipt.receiptExtra.runtimeGuard.codeQualityGate.executed, true);
  assert.equal(receipt.receiptExtra.runtimeGuard.codeQualityGate.exitCode, 0);
  assert.match(
    String(receipt.receiptExtra.runtimeGuard.codeQualityGate.artifactPath || ''),
    /\.codex\/quality\/logs\//,
  );
  assert.equal(receipt.receiptExtra.runtimeGuard.codeQualityReview.present, true);
  assert.equal(
    receipt.receiptExtra.runtimeGuard.codeQualityReview.summary,
    'extended existing code-quality path and verified coupled tests/docs',
  );
  assert.deepEqual(
    Object.keys(receipt.receiptExtra.runtimeGuard.codeQualityReview.hardRuleChecks).sort(),
    ['anticipateConsequences', 'cleanup', 'codeVolume', 'noDuplication', 'shortestPath', 'simplicity'].sort(),
  );
  assert.equal(
    receipt.receiptExtra.runtimeGuard.codeQualityReview.hardRuleChecks.codeVolume,
    true,
  );
});

test('code-quality gate rejects done closure when explicit qualityReview evidence is missing', async () => {
  const receipt = await runCodeQualityGateScenario({
    mode: 'quality-script-only',
    dirtyFilePath: 'src/clean.js',
    dirtyFileContents: 'export const value = 1;\n',
  });
  assert.equal(receipt.outcome, 'blocked');
  assert.equal(receipt.receiptExtra.runtimeGuard.codeQualityGate.exitCode, 0);
  assert.equal(receipt.receiptExtra.runtimeGuard.codeQualityReview.present, false);
  assert.match(
    String((receipt.receiptExtra.runtimeGuard.codeQualityGate.errors || []).join(' ')),
    /qualityReview evidence is required/i,
  );
});

test('daddy-autopilot: observer drain gate blocks ready closure until sibling digests drain', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-observer-drain-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);

  const roster = {
    orchestratorName: 'orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'autopilot',
    agents: [
      {
        name: 'autopilot',
        role: 'autopilot-worker',
        skills: [],
        workdir: '$REPO_ROOT',
        startCommand: 'node scripts/agent-codex-worker.mjs --agent autopilot',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');
  await ensureBusRoot(busRoot, roster);

  const taskMetaBase = {
    to: ['autopilot'],
    from: 'daddy-orchestrator',
    priority: 'P1',
    signals: {
      kind: 'ORCHESTRATOR_UPDATE',
      sourceKind: 'REVIEW_ACTION_REQUIRED',
      rootId: 'PR104',
      phase: 'review-fix',
    },
    references: {},
  };

  await writeTask({
    busRoot,
    agentName: 'autopilot',
    taskId: 't1',
    meta: {
      ...taskMetaBase,
      id: 't1',
      title: 'review digest A',
    },
    body: 'digest A',
  });
  await writeTask({
    busRoot,
    agentName: 'autopilot',
    taskId: 't2',
    meta: {
      ...taskMetaBase,
      id: 't2',
      title: 'review digest B',
    },
    body: 'digest B',
  });

  const env = {
    ...BASE_ENV,
    AGENTIC_AUTOPILOT_OBSERVER_DRAIN_GATE: '1',
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_APP_SERVER_TIMEOUT_MS: '4000',
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'autopilot',
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

  const receiptT1Path = path.join(busRoot, 'receipts', 'autopilot', 't1.json');
  const receiptT2Path = path.join(busRoot, 'receipts', 'autopilot', 't2.json');
  const receiptT1 = JSON.parse(await fs.readFile(receiptT1Path, 'utf8'));
  const receiptT2 = JSON.parse(await fs.readFile(receiptT2Path, 'utf8'));
  const receiptsById = { t1: receiptT1, t2: receiptT2 };
  const blockedEntry = Object.entries(receiptsById).find(([, r]) => r?.outcome === 'blocked');
  const doneEntry = Object.entries(receiptsById).find(([, r]) => r?.outcome === 'done');
  assert.ok(blockedEntry && doneEntry, 'expected one blocked and one done receipt');

  const [blockedId, blockedReceipt] = blockedEntry;
  const [doneId, doneReceipt] = doneEntry;
  assert.notEqual(blockedId, doneId);

  assert.match(String(blockedReceipt.note || ''), /observer drain gate failed/i);
  assert.equal(blockedReceipt.receiptExtra.runtimeGuard.observerDrainGate.required, true);
  assert.equal(blockedReceipt.receiptExtra.runtimeGuard.observerDrainGate.pendingCount, 1);
  assert.deepEqual(blockedReceipt.receiptExtra.runtimeGuard.observerDrainGate.pendingTaskIds, [doneId]);

  assert.equal(doneReceipt.receiptExtra.runtimeGuard.observerDrainGate.required, true);
  assert.equal(doneReceipt.receiptExtra.runtimeGuard.observerDrainGate.pendingCount, 0);
});

test('daddy-autopilot: observer drain gate ignores sibling digests that are only seen', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-observer-seen-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);

  const roster = {
    orchestratorName: 'orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'autopilot',
    agents: [{ name: 'autopilot', role: 'autopilot-worker' }],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');
  await ensureBusRoot(busRoot, roster);

  const taskMetaBase = {
    to: ['autopilot'],
    from: 'daddy-orchestrator',
    priority: 'P1',
    signals: {
      kind: 'ORCHESTRATOR_UPDATE',
      sourceKind: 'REVIEW_ACTION_REQUIRED',
      rootId: 'PR105',
      phase: 'review-fix',
    },
    references: {},
  };

  await writeTask({
    busRoot,
    agentName: 'autopilot',
    taskId: 't1',
    meta: {
      ...taskMetaBase,
      id: 't1',
      title: 'review digest active',
    },
    body: 'digest active',
  });
  const t2Path = await writeTask({
    busRoot,
    agentName: 'autopilot',
    taskId: 't2',
    meta: {
      ...taskMetaBase,
      id: 't2',
      title: 'review digest seen',
    },
    body: 'digest seen',
  });
  await fs.mkdir(path.join(busRoot, 'inbox', 'autopilot', 'seen'), { recursive: true });
  await fs.rename(t2Path, path.join(busRoot, 'inbox', 'autopilot', 'seen', 't2.md'));

  const env = {
    ...BASE_ENV,
    AGENTIC_AUTOPILOT_OBSERVER_DRAIN_GATE: '1',
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_APP_SERVER_TIMEOUT_MS: '4000',
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'autopilot',
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

  const receiptT1Path = path.join(busRoot, 'receipts', 'autopilot', 't1.json');
  const receiptT2Path = path.join(busRoot, 'receipts', 'autopilot', 't2.json');
  const receiptT1 = JSON.parse(await fs.readFile(receiptT1Path, 'utf8'));
  const receiptT2 = JSON.parse(await fs.readFile(receiptT2Path, 'utf8'));

  // The worker drains in_progress -> new -> seen, so the active `new` digest
  // closes before the sibling `seen` digest is claimed.
  assert.equal(receiptT1.outcome, 'done');
  assert.equal(receiptT1.receiptExtra.runtimeGuard.observerDrainGate.required, true);
  assert.equal(receiptT1.receiptExtra.runtimeGuard.observerDrainGate.pendingCount, 0);

  // By the time the `seen` digest runs, the active `new` sibling is already gone.
  assert.equal(receiptT2.outcome, 'done');
  assert.equal(receiptT2.receiptExtra.runtimeGuard.observerDrainGate.required, true);
  assert.equal(receiptT2.receiptExtra.runtimeGuard.observerDrainGate.pendingCount, 0);
});

test('daddy-autopilot: review-fix continuation preserves dirty worktree when deterministic sync still blocks', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-review-fix-preserve-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const dummyGh = path.join(tmp, 'gh');
  const workdir = await createTestGitWorkdir({ rootDir: tmp });
  const headSha = childProcess.execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: workdir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const branch = childProcess.execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: workdir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

  await fs.writeFile(path.join(workdir, 'README.md'), 'review-fix dirt\n', 'utf8');
  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);
  await writeExecutable(
    dummyGh,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [ "${1:-}" = "pr" ] && [ "${2:-}" = "view" ] && [ "${3:-}" = "104" ] && [ "${4:-}" = "--json" ] && [ "${5:-}" = "headRefOid" ]; then',
      `  printf '%s\\n' '${headSha}'`,
      '  exit 0',
      'fi',
      'echo "unexpected gh args: $*" >&2',
      'exit 1',
    ].join('\n'),
  );

  await fs.writeFile(rosterPath, JSON.stringify(buildSingleAutopilotRoster(workdir), null, 2) + '\n', 'utf8');
  await ensureBusRoot(busRoot, buildSingleAutopilotRoster(workdir));
  await writeAgentRootFocusState({ busRoot, agentName: 'autopilot', rootId: 'PR103' });

  await writeTask({
    busRoot,
    agentName: 'autopilot',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['autopilot'],
      from: 'daddy-orchestrator',
      priority: 'P1',
      title: 'review digest',
      signals: {
        kind: 'ORCHESTRATOR_UPDATE',
        sourceKind: 'REVIEW_ACTION_REQUIRED',
        rootId: 'PR104',
        phase: 'review-fix',
      },
      references: {
        sourceAgent: 'observer:pr',
        sourceReferences: {
          pr: { number: 104 },
        },
        git: {
          baseSha: headSha,
          baseBranch: branch,
          workBranch: branch,
        },
      },
    },
    body: 'continue review fix',
  });

  const env = {
    ...BASE_ENV,
    PATH: `${tmp}:${BASE_ENV.PATH || ''}`,
    AGENTIC_AUTOPILOT_DELEGATE_GATE: '0',
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_APP_SERVER_TIMEOUT_MS: '4000',
  };

  const { run, receipt } = await runAutopilotWorkerAndReadReceipt({
    repoRoot,
    busRoot,
    rosterPath,
    dummyCodex,
    env,
    taskId: 't1',
  });
  assert.equal(run.code, 0, run.stderr || run.stdout);
  assert.match(run.stderr, /cross-root warning: continuing on incoming PR104/i);
  assert.equal(receipt.outcome, 'blocked');
  assert.match(String(receipt.note || ''), /worktree has uncommitted changes/i);
  assert.equal(receipt.receiptExtra.git.branch, branch);
  assert.equal(receipt.receiptExtra.git.headSha, headSha);
  assert.equal(receipt.receiptExtra.git.isDirty, true);
  assert.match(
    childProcess.execFileSync('git', ['status', '--porcelain'], {
      cwd: workdir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
    /M README\.md/,
  );
  const focusState = JSON.parse(
    await fs.readFile(path.join(busRoot, 'state', 'agent-root-focus', 'autopilot.json'), 'utf8'),
  );
  assert.equal(focusState.rootId, 'PR104');
  await assert.rejects(
    fs.stat(path.join(busRoot, 'state', 'worker-reclaim', 'autopilot', 't1.json')),
    /ENOENT/,
  );
});

test('daddy-autopilot: root-focus bookkeeping failures surface as runtime failures, not preflight blocks', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-review-fix-root-focus-fail-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const dummyGh = path.join(tmp, 'gh');
  const workdir = await createTestGitWorkdir({ rootDir: tmp });
  const headSha = childProcess.execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: workdir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const branch = childProcess.execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: workdir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

  await fs.writeFile(path.join(workdir, 'README.md'), 'review-fix dirt\n', 'utf8');
  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);
  await writeExecutable(
    dummyGh,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [ "${1:-}" = "pr" ] && [ "${2:-}" = "view" ] && [ "${3:-}" = "104" ] && [ "${4:-}" = "--json" ] && [ "${5:-}" = "headRefOid" ]; then',
      `  printf '%s\\n' '${headSha}'`,
      '  exit 0',
      'fi',
      'echo "unexpected gh args: $*" >&2',
      'exit 1',
    ].join('\n'),
  );

  await fs.writeFile(rosterPath, JSON.stringify(buildSingleAutopilotRoster(workdir), null, 2) + '\n', 'utf8');
  await ensureBusRoot(busRoot, buildSingleAutopilotRoster(workdir));
  await writeAgentRootFocusState({ busRoot, agentName: 'autopilot', rootId: 'PR103' });
  const rootFocusDir = path.join(busRoot, 'state', 'agent-root-focus');
  await fs.chmod(rootFocusDir, 0o555);

  await writeTask({
    busRoot,
    agentName: 'autopilot',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['autopilot'],
      from: 'daddy-orchestrator',
      priority: 'P1',
      title: 'review digest with root-focus write failure',
      signals: {
        kind: 'ORCHESTRATOR_UPDATE',
        sourceKind: 'REVIEW_ACTION_REQUIRED',
        rootId: 'PR104',
        phase: 'review-fix',
      },
      references: {
        sourceAgent: 'observer:pr',
        sourceReferences: {
          pr: { number: 104 },
        },
        git: {
          baseSha: headSha,
          baseBranch: branch,
          workBranch: branch,
        },
      },
    },
    body: 'continue review fix',
  });

  const env = {
    ...BASE_ENV,
    PATH: `${tmp}:${BASE_ENV.PATH || ''}`,
    AGENTIC_AUTOPILOT_DELEGATE_GATE: '0',
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_APP_SERVER_TIMEOUT_MS: '4000',
  };

  const { run, receipt } = await runAutopilotWorkerAndReadReceipt({
    repoRoot,
    busRoot,
    rosterPath,
    dummyCodex,
    env,
    taskId: 't1',
  });
  assert.equal(run.code, 0, run.stderr || run.stdout);
  assert.equal(receipt.outcome, 'failed');
  assert.match(String(receipt.note || ''), /codex app-server failed:/i);
  assert.doesNotMatch(String(receipt.note || ''), /git preflight blocked/i);
  assert.equal(receipt.receiptExtra.git.branch, branch);
  assert.equal(receipt.receiptExtra.git.headSha, headSha);
  assert.equal(receipt.receiptExtra.git.isDirty, true);
  const focusState = JSON.parse(
    await fs.readFile(path.join(busRoot, 'state', 'agent-root-focus', 'autopilot.json'), 'utf8'),
  );
  assert.equal(focusState.rootId, 'PR103');
  await fs.chmod(rootFocusDir, 0o755);
});

test('daddy-autopilot: app-server review gate triggers built-in review/start', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-review-gate-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const reviewCountFile = path.join(tmp, 'review-count.txt');

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);

  const roster = {
    orchestratorName: 'orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'autopilot',
    agents: [
      {
        name: 'autopilot',
        role: 'autopilot-worker',
        skills: [],
        workdir: '$REPO_ROOT',
        startCommand: 'node scripts/agent-codex-worker.mjs --agent autopilot',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');
  await ensureBusRoot(busRoot, roster);

  await writeTask({
    busRoot,
    agentName: 'autopilot',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['autopilot'],
      from: 'daddy-orchestrator',
      priority: 'P2',
      title: 'review gate',
      signals: {
        kind: 'ORCHESTRATOR_UPDATE',
        sourceKind: 'TASK_COMPLETE',
        reviewRequired: true,
        reviewTarget: {
          sourceTaskId: 'exec-1',
          sourceAgent: 'frontend',
          sourceKind: 'EXECUTE',
          commitSha: 'abc123',
          receiptPath: 'receipts/frontend/exec-1.json',
          repoRoot,
        },
      },
      references: {
        completedTaskKind: 'EXECUTE',
        commitSha: 'abc123',
        receiptPath: 'receipts/frontend/exec-1.json',
      },
    },
    body: 'review completion and decide',
  });

  const env = {
    ...BASE_ENV,
    AGENTIC_AUTOPILOT_DELEGATE_GATE: '0',
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_APP_SERVER_TIMEOUT_MS: '5000',
    DUMMY_MODE: 'review-gate',
    REVIEW_COUNT_FILE: reviewCountFile,
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'autopilot',
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
  assert.match(run.stderr, /\[codex\] review.entered/);
  assert.match(run.stderr, /\[codex\] review.exited/);
  assert.match(run.stderr, /\[codex\] review.completed status=completed/);

  const reviewCalls = Number(await fs.readFile(reviewCountFile, 'utf8'));
  assert.equal(reviewCalls, 1);

  const receiptPath = path.join(busRoot, 'receipts', 'autopilot', 't1.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(receipt.outcome, 'done');
  assert.equal(receipt.receiptExtra.review.method, 'built_in_review');
  assert.equal(receipt.receiptExtra.review.targetCommitSha, 'abc123');
  assert.equal(receipt.receiptExtra.reviewArtifactPath, 'artifacts/autopilot/reviews/t1.md');
});

test('daddy-autopilot: app-server review gate accepts split review turn ids when completion arrives before exit', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-review-split-turn-ids-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const reviewCountFile = path.join(tmp, 'review-count.txt');

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);

  const roster = {
    orchestratorName: 'orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'autopilot',
    agents: [
      {
        name: 'autopilot',
        role: 'autopilot-worker',
        skills: [],
        workdir: '$REPO_ROOT',
        startCommand: 'node scripts/agent-codex-worker.mjs --agent autopilot',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');
  await ensureBusRoot(busRoot, roster);

  await writeTask({
    busRoot,
    agentName: 'autopilot',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['autopilot'],
      from: 'daddy-orchestrator',
      priority: 'P2',
      title: 'review gate split turn ids',
      signals: {
        kind: 'ORCHESTRATOR_UPDATE',
        sourceKind: 'TASK_COMPLETE',
        reviewRequired: true,
        reviewTarget: {
          sourceTaskId: 'exec-1',
          sourceAgent: 'frontend',
          sourceKind: 'EXECUTE',
          commitSha: 'abc123',
          receiptPath: 'receipts/frontend/exec-1.json',
          repoRoot,
        },
      },
      references: {
        completedTaskKind: 'EXECUTE',
        commitSha: 'abc123',
        receiptPath: 'receipts/frontend/exec-1.json',
      },
    },
    body: 'review completion and decide',
  });

  const env = {
    ...BASE_ENV,
    AGENTIC_AUTOPILOT_DELEGATE_GATE: '0',
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_APP_SERVER_TIMEOUT_MS: '5000',
    DUMMY_MODE: 'review-gate',
    REVIEW_COUNT_FILE: reviewCountFile,
    SPLIT_REVIEW_TURN_IDS: '1',
    REVIEW_COMPLETED_BEFORE_EXIT: '1',
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'autopilot',
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
  assert.match(run.stderr, /\[codex\] review.entered/);
  assert.match(run.stderr, /\[codex\] review.exited/);
  assert.match(run.stderr, /\[codex\] review.completed status=completed/);

  const reviewCalls = Number(await fs.readFile(reviewCountFile, 'utf8'));
  assert.equal(reviewCalls, 1);

  const receiptPath = path.join(busRoot, 'receipts', 'autopilot', 't1.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(receipt.outcome, 'done');
  assert.equal(receipt.receiptExtra.review.method, 'built_in_review');
  assert.equal(receipt.receiptExtra.review.targetCommitSha, 'abc123');
});

test('daddy-autopilot: explicit USER_REQUEST review prompt triggers built-in review/start', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-user-review-gate-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const reviewCountFile = path.join(tmp, 'review-count.txt');

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);

  const roster = {
    orchestratorName: 'orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'autopilot',
    agents: [
      {
        name: 'autopilot',
        role: 'autopilot-worker',
        skills: [],
        workdir: '$REPO_ROOT',
        startCommand: 'node scripts/agent-codex-worker.mjs --agent autopilot',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');
  await ensureBusRoot(busRoot, roster);

  await writeTask({
    busRoot,
    agentName: 'autopilot',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['autopilot'],
      from: 'daddy',
      priority: 'P2',
      title: 'real review start',
      signals: { kind: 'USER_REQUEST' },
      references: {},
    },
    body: 'Tell the autopilot to run a real /review review/start now.',
  });

  const env = {
    ...BASE_ENV,
    AGENTIC_AUTOPILOT_DELEGATE_GATE: '0',
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_APP_SERVER_TIMEOUT_MS: '5000',
    DUMMY_MODE: 'review-gate',
    REVIEW_COUNT_FILE: reviewCountFile,
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'autopilot',
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
  assert.match(run.stderr, /\[codex\] review.entered/);
  assert.match(run.stderr, /\[codex\] review.exited/);
  assert.match(run.stderr, /\[codex\] review.completed status=completed/);

  const reviewCalls = Number(await fs.readFile(reviewCountFile, 'utf8'));
  assert.equal(reviewCalls, 1);

  const receiptPath = path.join(busRoot, 'receipts', 'autopilot', 't1.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(receipt.outcome, 'done');
  assert.equal(receipt.receiptExtra.review.method, 'built_in_review');
});

test('daddy-autopilot: explicit USER_REQUEST commit review resolves local short SHAs before validation', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-user-review-short-sha-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const reviewCountFile = path.join(tmp, 'review-count.txt');
  const taskRepo = await createTestGitWorkdir({ rootDir: tmp });
  const reviewedCommit = childProcess.execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: taskRepo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const shortSha = reviewedCommit.slice(0, 7);

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);

  const roster = {
    orchestratorName: 'orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'autopilot',
    agents: [
      {
        name: 'autopilot',
        role: 'autopilot-worker',
        skills: [],
        workdir: taskRepo,
        startCommand: 'node scripts/agent-codex-worker.mjs --agent autopilot',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');
  await ensureBusRoot(busRoot, roster);

  await writeTask({
    busRoot,
    agentName: 'autopilot',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['autopilot'],
      from: 'daddy',
      priority: 'P2',
      title: `Review ${shortSha}`,
      signals: { kind: 'USER_REQUEST' },
      references: {},
    },
    body:
      'Tell the autopilot to run a real /review review/start now.\n' +
      `Review ${shortSha} only.\n`,
  });

  const env = {
    ...BASE_ENV,
    AGENTIC_AUTOPILOT_DELEGATE_GATE: '0',
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_APP_SERVER_TIMEOUT_MS: '5000',
    DUMMY_MODE: 'review-gate',
    REVIEW_TARGET_SHA: reviewedCommit,
    REVIEW_SCOPE: 'commit',
    REVIEWED_COMMITS: reviewedCommit,
    REVIEW_COUNT_FILE: reviewCountFile,
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'autopilot',
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

  const reviewCalls = Number(await fs.readFile(reviewCountFile, 'utf8'));
  assert.equal(reviewCalls, 1);

  const receiptPath = path.join(busRoot, 'receipts', 'autopilot', 't1.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(receipt.outcome, 'done');
  assert.equal(receipt.receiptExtra.review.targetCommitSha, reviewedCommit);
  assert.deepEqual(receipt.receiptExtra.review.reviewedCommits, [reviewedCommit]);
});

test('daddy-autopilot: fallback USER_REQUEST commit review resolves local short SHAs before validation', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-user-review-fallback-short-sha-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const reviewCountFile = path.join(tmp, 'review-count.txt');
  const taskRepo = await createTestGitWorkdir({ rootDir: tmp });
  const reviewedCommit = childProcess.execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: taskRepo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const shortSha = reviewedCommit.slice(0, 7);

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);

  const roster = {
    orchestratorName: 'orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'autopilot',
    agents: [
      {
        name: 'autopilot',
        role: 'autopilot-worker',
        skills: [],
        workdir: taskRepo,
        startCommand: 'node scripts/agent-codex-worker.mjs --agent autopilot',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');
  await ensureBusRoot(busRoot, roster);

  await writeTask({
    busRoot,
    agentName: 'autopilot',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['autopilot'],
      from: 'daddy',
      priority: 'P2',
      title: `Review ${shortSha}`,
      signals: { kind: 'USER_REQUEST' },
      references: {},
    },
    body: 'Tell the autopilot to run a real /review review/start now.\n',
  });

  const env = {
    ...BASE_ENV,
    AGENTIC_AUTOPILOT_DELEGATE_GATE: '0',
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_APP_SERVER_TIMEOUT_MS: '5000',
    DUMMY_MODE: 'review-gate',
    REVIEW_TARGET_SHA: reviewedCommit,
    REVIEW_SCOPE: 'commit',
    REVIEWED_COMMITS: reviewedCommit,
    REVIEW_COUNT_FILE: reviewCountFile,
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'autopilot',
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

  const reviewCalls = Number(await fs.readFile(reviewCountFile, 'utf8'));
  assert.equal(reviewCalls, 1);

  const receiptPath = path.join(busRoot, 'receipts', 'autopilot', 't1.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(receipt.outcome, 'done');
  assert.equal(receipt.receiptExtra.review.targetCommitSha, reviewedCommit);
  assert.deepEqual(receipt.receiptExtra.review.reviewedCommits, [reviewedCommit]);
});

test('daddy-autopilot: initial USER_REQUEST PR review honors directive-shaped title selector when no update block exists', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-user-pr-review-initial-title-selector-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const dummyGh = path.join(tmp, 'gh');
  const reviewCountFile = path.join(tmp, 'review-count.txt');
  const commitA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const commitB = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const commitC = 'cccccccccccccccccccccccccccccccccccccccc';

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);
  await writeExecutable(
    dummyGh,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [ "${1:-}" = "pr" ] && [ "${2:-}" = "view" ] && [ "${4:-}" = "--json" ] && [ "${5:-}" = "commits" ]; then',
      `  printf '%s\\n' '${commitA}' '${commitB}' '${commitC}'`,
      '  exit 0',
      'fi',
      'if [ "${1:-}" = "pr" ] && [ "${2:-}" = "view" ] && [ "${4:-}" = "--json" ] && [ "${5:-}" = "headRefOid" ]; then',
      `  printf '%s\\n' '${commitC}'`,
      '  exit 0',
      'fi',
      'echo "unexpected gh args: $*" >&2',
      'exit 1',
    ].join('\n'),
  );

  const roster = {
    orchestratorName: 'orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'autopilot',
    agents: [
      {
        name: 'autopilot',
        role: 'autopilot-worker',
        skills: [],
        workdir: '$REPO_ROOT',
        startCommand: 'node scripts/agent-codex-worker.mjs --agent autopilot',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');
  await ensureBusRoot(busRoot, roster);

  await writeTask({
    busRoot,
    agentName: 'autopilot',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['autopilot'],
      from: 'daddy',
      priority: 'P2',
      title: `Review ${commitC.slice(0, 7)} PR94`,
      signals: { kind: 'USER_REQUEST' },
      references: {},
    },
    body: 'Tell the autopilot to run a real /review review/start on PR94.\n',
  });

  const env = {
    ...BASE_ENV,
    PATH: `${tmp}:${BASE_ENV.PATH || ''}`,
    AGENTIC_AUTOPILOT_DELEGATE_GATE: '0',
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_APP_SERVER_TIMEOUT_MS: '5000',
    DUMMY_MODE: 'review-gate',
    REVIEW_TARGET_SHA: commitC,
    REVIEW_SCOPE: 'commit',
    REVIEWED_COMMITS: commitC,
    REVIEW_COUNT_FILE: reviewCountFile,
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'autopilot',
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

  const reviewCalls = Number(await fs.readFile(reviewCountFile, 'utf8'));
  assert.equal(reviewCalls, 1);

  const receiptPath = path.join(busRoot, 'receipts', 'autopilot', 't1.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(receipt.outcome, 'done');
  assert.equal(receipt.receiptExtra.review.targetCommitSha, commitC);
  assert.deepEqual(receipt.receiptExtra.review.reviewedCommits, [commitC]);
});

test('daddy-autopilot: non-PR USER_REQUEST review fails closed when explicit exclude removes the only local target', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-user-review-local-exclude-empty-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const reviewCountFile = path.join(tmp, 'review-count.txt');
  const taskRepo = await createTestGitWorkdir({ rootDir: tmp });
  const reviewedCommit = childProcess.execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: taskRepo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const shortSha = reviewedCommit.slice(0, 7);

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);

  const roster = {
    orchestratorName: 'orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'autopilot',
    agents: [
      {
        name: 'autopilot',
        role: 'autopilot-worker',
        skills: [],
        workdir: taskRepo,
        startCommand: 'node scripts/agent-codex-worker.mjs --agent autopilot',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');
  await ensureBusRoot(busRoot, roster);

  await writeTask({
    busRoot,
    agentName: 'autopilot',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['autopilot'],
      from: 'daddy',
      priority: 'P2',
      title: `Review ${shortSha}`,
      signals: { kind: 'USER_REQUEST' },
      references: {
        commitSha: reviewedCommit,
      },
    },
    body:
      'Tell the autopilot to run a real /review review/start now.\n' +
      `Do not review ${shortSha}.\n`,
  });

  const env = {
    ...BASE_ENV,
    AGENTIC_AUTOPILOT_DELEGATE_GATE: '0',
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_APP_SERVER_TIMEOUT_MS: '5000',
    DUMMY_MODE: 'review-gate',
    REVIEW_TARGET_SHA: reviewedCommit,
    REVIEW_SCOPE: 'commit',
    REVIEWED_COMMITS: reviewedCommit,
    REVIEW_COUNT_FILE: reviewCountFile,
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'autopilot',
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

  const receiptPath = path.join(busRoot, 'receipts', 'autopilot', 't1.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(receipt.outcome, 'failed');
  assert.match(
    String(receipt.note || ''),
    /explicit review target resolution failed: explicit review requested, but no commit targets remained after explicit review filters/i,
  );

  const reviewCountExists = await waitForPath(reviewCountFile, { timeoutMs: 250, pollMs: 25 });
  assert.equal(reviewCountExists, false);
});

test('daddy-autopilot: USER_REQUEST PR review runs built-in review/start for every PR commit', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-user-pr-review-scope-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const dummyGh = path.join(tmp, 'gh');
  const reviewCountFile = path.join(tmp, 'review-count.txt');
  const commitA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const commitB = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);
  await writeExecutable(
    dummyGh,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [ "${1:-}" = "pr" ] && [ "${2:-}" = "view" ] && [ "${4:-}" = "--json" ] && [ "${5:-}" = "commits" ]; then',
      `  printf '%s\\n' '${commitA}' '${commitB}'`,
      '  exit 0',
      'fi',
      'if [ "${1:-}" = "pr" ] && [ "${2:-}" = "view" ] && [ "${4:-}" = "--json" ] && [ "${5:-}" = "headRefOid" ]; then',
      `  printf '%s\\n' '${commitB}'`,
      '  exit 0',
      'fi',
      'echo "unexpected gh args: $*" >&2',
      'exit 1',
    ].join('\n'),
  );

  const roster = {
    orchestratorName: 'orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'autopilot',
    agents: [
      {
        name: 'autopilot',
        role: 'autopilot-worker',
        skills: [],
        workdir: '$REPO_ROOT',
        startCommand: 'node scripts/agent-codex-worker.mjs --agent autopilot',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');
  await ensureBusRoot(busRoot, roster);

  await writeTask({
    busRoot,
    agentName: 'autopilot',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['autopilot'],
      from: 'daddy',
      priority: 'P2',
      title: 'PR94 real review start',
      signals: { kind: 'USER_REQUEST' },
      references: {},
    },
    body: 'Tell the autopilot to run a real /review review/start on PR94.',
  });

  const env = {
    ...BASE_ENV,
    PATH: `${tmp}:${BASE_ENV.PATH || ''}`,
    AGENTIC_AUTOPILOT_DELEGATE_GATE: '0',
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_APP_SERVER_TIMEOUT_MS: '5000',
    DUMMY_MODE: 'review-gate',
    REVIEW_TARGET_SHA: commitB,
    REVIEW_SCOPE: 'pr',
    REVIEWED_COMMITS: `${commitA},${commitB}`,
    REVIEW_COUNT_FILE: reviewCountFile,
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'autopilot',
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
  assert.match(run.stderr, /\[codex\] review.completed status=completed/);

  const reviewCalls = Number(await fs.readFile(reviewCountFile, 'utf8'));
  assert.equal(reviewCalls, 2);

  const receiptPath = path.join(busRoot, 'receipts', 'autopilot', 't1.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(receipt.outcome, 'done');
  assert.equal(receipt.receiptExtra.review.method, 'built_in_review');
  assert.equal(receipt.receiptExtra.review.scope, 'pr');
  assert.deepEqual(receipt.receiptExtra.review.reviewedCommits, [commitA, commitB]);
  assert.equal(receipt.receiptExtra.review.targetCommitSha, commitB);
});

test('daddy-autopilot: USER_REQUEST PR review honors plain exclude-only narrowed selection over full PR replay', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-user-pr-review-narrowed-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const dummyGh = path.join(tmp, 'gh');
  const reviewCountFile = path.join(tmp, 'review-count.txt');
  const commitA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const commitB = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const commitC = 'cccccccccccccccccccccccccccccccccccccccc';

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);
  await writeExecutable(
    dummyGh,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [ "${1:-}" = "pr" ] && [ "${2:-}" = "view" ] && [ "${4:-}" = "--json" ] && [ "${5:-}" = "commits" ]; then',
      `  printf '%s\\n' '${commitA}' '${commitB}' '${commitC}'`,
      '  exit 0',
      'fi',
      'if [ "${1:-}" = "pr" ] && [ "${2:-}" = "view" ] && [ "${4:-}" = "--json" ] && [ "${5:-}" = "headRefOid" ]; then',
      `  printf '%s\\n' '${commitC}'`,
      '  exit 0',
      'fi',
      'echo "unexpected gh args: $*" >&2',
      'exit 1',
    ].join('\n'),
  );

  const roster = {
    orchestratorName: 'orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'autopilot',
    agents: [
      {
        name: 'autopilot',
        role: 'autopilot-worker',
        skills: [],
        workdir: '$REPO_ROOT',
        startCommand: 'node scripts/agent-codex-worker.mjs --agent autopilot',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');
  await ensureBusRoot(busRoot, roster);

  await writeTask({
    busRoot,
    agentName: 'autopilot',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['autopilot'],
      from: 'daddy',
      priority: 'P2',
      title: 'PR94 narrowed',
      signals: { kind: 'USER_REQUEST' },
      references: {},
    },
    body:
      `Tell the autopilot to run a real /review review/start on PR94.\n` +
      `Initial expectation: review the full PR from oldest to newest.\n` +
      `\n---\n\n### Update (2026-03-09T00:00:00.000Z) from daddy\n\n` +
      `Current expectation: continue the remaining PR tail without re-reviewing the old commit.\n` +
      `Do not review ${commitA}.\n`,
  });

  const env = {
    ...BASE_ENV,
    PATH: `${tmp}:${BASE_ENV.PATH || ''}`,
    AGENTIC_AUTOPILOT_DELEGATE_GATE: '0',
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_APP_SERVER_TIMEOUT_MS: '5000',
    DUMMY_MODE: 'review-gate',
    REVIEW_TARGET_SHA: commitC,
    REVIEW_SCOPE: 'pr',
    REVIEWED_COMMITS: `${commitB},${commitC}`,
    REVIEW_COUNT_FILE: reviewCountFile,
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'autopilot',
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
  assert.match(run.stderr, /\[codex\] review.completed status=completed/);

  const reviewCalls = Number(await fs.readFile(reviewCountFile, 'utf8'));
  assert.equal(reviewCalls, 2);

  const receiptPath = path.join(busRoot, 'receipts', 'autopilot', 't1.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(receipt.outcome, 'done');
  assert.equal(receipt.receiptExtra.review.method, 'built_in_review');
  assert.equal(receipt.receiptExtra.review.scope, 'pr');
  assert.deepEqual(receipt.receiptExtra.review.reviewedCommits, [commitB, commitC]);
  assert.equal(receipt.receiptExtra.review.targetCommitSha, commitC);
});

test('daddy-autopilot: USER_REQUEST PR review ignores stale title include when latest update narrows to a new commit', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-user-pr-review-latest-include-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const dummyGh = path.join(tmp, 'gh');
  const reviewCountFile = path.join(tmp, 'review-count.txt');
  const commitA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const commitB = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const commitC = 'cccccccccccccccccccccccccccccccccccccccc';

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);
  await writeExecutable(
    dummyGh,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [ "${1:-}" = "pr" ] && [ "${2:-}" = "view" ] && [ "${4:-}" = "--json" ] && [ "${5:-}" = "commits" ]; then',
      `  printf '%s\\n' '${commitA}' '${commitB}' '${commitC}'`,
      '  exit 0',
      'fi',
      'if [ "${1:-}" = "pr" ] && [ "${2:-}" = "view" ] && [ "${4:-}" = "--json" ] && [ "${5:-}" = "headRefOid" ]; then',
      `  printf '%s\\n' '${commitC}'`,
      '  exit 0',
      'fi',
      'echo "unexpected gh args: $*" >&2',
      'exit 1',
    ].join('\n'),
  );

  const roster = {
    orchestratorName: 'orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'autopilot',
    agents: [
      {
        name: 'autopilot',
        role: 'autopilot-worker',
        skills: [],
        workdir: '$REPO_ROOT',
        startCommand: 'node scripts/agent-codex-worker.mjs --agent autopilot',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');
  await ensureBusRoot(busRoot, roster);

  await writeTask({
    busRoot,
    agentName: 'autopilot',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['autopilot'],
      from: 'daddy',
      priority: 'P2',
      title: `Review ${commitA.slice(0, 7)} PR94`,
      signals: { kind: 'USER_REQUEST' },
      references: {},
    },
    body:
      'Tell the autopilot to run a real /review review/start on PR94.\n' +
      '\n---\n\n### Update (2026-03-09T00:00:00.000Z) from daddy\n\n' +
      `Review ${commitC} only.\n`,
  });

  const env = {
    ...BASE_ENV,
    PATH: `${tmp}:${BASE_ENV.PATH || ''}`,
    AGENTIC_AUTOPILOT_DELEGATE_GATE: '0',
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_APP_SERVER_TIMEOUT_MS: '5000',
    DUMMY_MODE: 'review-gate',
    REVIEW_TARGET_SHA: commitC,
    REVIEW_SCOPE: 'commit',
    REVIEWED_COMMITS: commitC,
    REVIEW_COUNT_FILE: reviewCountFile,
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'autopilot',
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

  const reviewCalls = Number(await fs.readFile(reviewCountFile, 'utf8'));
  assert.equal(reviewCalls, 1);

  const receiptPath = path.join(busRoot, 'receipts', 'autopilot', 't1.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(receipt.outcome, 'done');
  assert.equal(receipt.receiptExtra.review.targetCommitSha, commitC);
  assert.deepEqual(receipt.receiptExtra.review.reviewedCommits, [commitC]);
});

test('daddy-autopilot: USER_REQUEST PR review ignores non-directive review mentions on SHA lines', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-user-pr-review-feedback-mention-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const dummyGh = path.join(tmp, 'gh');
  const reviewCountFile = path.join(tmp, 'review-count.txt');
  const commitA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const commitB = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const commitC = 'cccccccccccccccccccccccccccccccccccccccc';

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);
  await writeExecutable(
    dummyGh,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [ "${1:-}" = "pr" ] && [ "${2:-}" = "view" ] && [ "${4:-}" = "--json" ] && [ "${5:-}" = "commits" ]; then',
      `  printf '%s\\n' '${commitA}' '${commitB}' '${commitC}'`,
      '  exit 0',
      'fi',
      'if [ "${1:-}" = "pr" ] && [ "${2:-}" = "view" ] && [ "${4:-}" = "--json" ] && [ "${5:-}" = "headRefOid" ]; then',
      `  printf '%s\\n' '${commitC}'`,
      '  exit 0',
      'fi',
      'echo "unexpected gh args: $*" >&2',
      'exit 1',
    ].join('\n'),
  );

  const roster = {
    orchestratorName: 'orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'autopilot',
    agents: [
      {
        name: 'autopilot',
        role: 'autopilot-worker',
        skills: [],
        workdir: '$REPO_ROOT',
        startCommand: 'node scripts/agent-codex-worker.mjs --agent autopilot',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');
  await ensureBusRoot(busRoot, roster);

  await writeTask({
    busRoot,
    agentName: 'autopilot',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['autopilot'],
      from: 'daddy',
      priority: 'P2',
      title: 'PR94 narrowed',
      signals: { kind: 'USER_REQUEST' },
      references: {},
    },
    body:
      'Tell the autopilot to run a real /review review/start on PR94.\n' +
      '\n---\n\n### Update (2026-03-09T00:00:00.000Z) from daddy\n\n' +
      `Commit ${commitA} addressed the review feedback already.\n`,
  });

  const env = {
    ...BASE_ENV,
    PATH: `${tmp}:${BASE_ENV.PATH || ''}`,
    AGENTIC_AUTOPILOT_DELEGATE_GATE: '0',
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_APP_SERVER_TIMEOUT_MS: '5000',
    DUMMY_MODE: 'review-gate',
    REVIEW_TARGET_SHA: commitC,
    REVIEW_SCOPE: 'pr',
    REVIEWED_COMMITS: `${commitA},${commitB},${commitC}`,
    REVIEW_COUNT_FILE: reviewCountFile,
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'autopilot',
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
  assert.match(run.stderr, /\[codex\] review.completed status=completed/);

  const reviewCalls = Number(await fs.readFile(reviewCountFile, 'utf8'));
  assert.equal(reviewCalls, 3);

  const receiptPath = path.join(busRoot, 'receipts', 'autopilot', 't1.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(receipt.outcome, 'done');
  assert.equal(receipt.receiptExtra.review.scope, 'pr');
  assert.equal(receipt.receiptExtra.review.targetCommitSha, commitC);
  assert.deepEqual(receipt.receiptExtra.review.reviewedCommits, [commitA, commitB, commitC]);
});

test('daddy-autopilot: explicit review-only closures do not trip delegate_required on reviewed control-plane commits', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-review-only-delegate-gate-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const dummyGh = path.join(tmp, 'gh');
  const reviewCountFile = path.join(tmp, 'review-count.txt');
  const taskRepo = await createTestGitWorkdir({ rootDir: tmp });

  await fs.mkdir(path.join(taskRepo, 'scripts'), { recursive: true });
  await fs.writeFile(path.join(taskRepo, 'scripts', 'nginx-ssr-apply.sh'), '#!/usr/bin/env bash\nexit 0\n', 'utf8');
  runGit(taskRepo, ['add', 'scripts/nginx-ssr-apply.sh']);
  runGit(taskRepo, ['commit', '-m', 'add control plane script']);
  const reviewedCommit = childProcess.execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: taskRepo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);
  await writeExecutable(
    dummyGh,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [ "${1:-}" = "pr" ] && [ "${2:-}" = "view" ] && [ "${4:-}" = "--json" ] && [ "${5:-}" = "commits" ]; then',
      `  printf '%s\\n' '${reviewedCommit}'`,
      '  exit 0',
      'fi',
      'if [ "${1:-}" = "pr" ] && [ "${2:-}" = "view" ] && [ "${4:-}" = "--json" ] && [ "${5:-}" = "headRefOid" ]; then',
      `  printf '%s\\n' '${reviewedCommit}'`,
      '  exit 0',
      'fi',
      'echo "unexpected gh args: $*" >&2',
      'exit 1',
    ].join('\n'),
  );

  const roster = {
    orchestratorName: 'orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'autopilot',
    agents: [
      {
        name: 'autopilot',
        role: 'autopilot-worker',
        skills: [],
        workdir: taskRepo,
        startCommand: 'node scripts/agent-codex-worker.mjs --agent autopilot',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');
  await ensureBusRoot(busRoot, roster);

  await writeTask({
    busRoot,
    agentName: 'autopilot',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['autopilot'],
      from: 'daddy',
      priority: 'P2',
      title: `Review ${reviewedCommit.slice(0, 7)} PR94 tail`,
      signals: { kind: 'USER_REQUEST' },
      references: {},
    },
    body:
      `Tell the autopilot to run a real /review review/start on PR94.\n` +
      `Current expectation: review ${reviewedCommit} only.\n`,
  });

  const env = {
    ...BASE_ENV,
    PATH: `${tmp}:${BASE_ENV.PATH || ''}`,
    AGENTIC_AUTOPILOT_DELEGATE_GATE: '1',
    AGENTIC_CODE_QUALITY_GATE: '1',
    AGENTIC_CODE_QUALITY_GATE_KINDS: 'USER_REQUEST',
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_APP_SERVER_TIMEOUT_MS: '5000',
    DUMMY_MODE: 'review-gate',
    REVIEW_TARGET_SHA: reviewedCommit,
    REVIEW_SCOPE: 'commit',
    REVIEWED_COMMITS: reviewedCommit,
    REVIEW_COUNT_FILE: reviewCountFile,
    COMMIT_SHA: reviewedCommit,
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'autopilot',
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
  assert.match(run.stderr, /\[codex\] review.completed status=completed/);

  const receiptPath = path.join(busRoot, 'receipts', 'autopilot', 't1.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(receipt.outcome, 'done');
  assert.doesNotMatch(String(receipt.note || ''), /delegate_required/);
  assert.equal(receipt.receiptExtra.runtimeGuard.delegationGate.path, 'review_only');
  assert.equal(receipt.receiptExtra.runtimeGuard.delegationGate.reasonCode, null);
  assert.equal(receipt.receiptExtra.runtimeGuard.selfReviewGate.status, 'pass');
  assert.equal(receipt.receiptExtra.runtimeGuard.codeQualityGate.executed, false);
  assert.equal(receipt.receiptExtra.runtimeGuard.codeQualityGate.skippedReason, 'review_only');
  assert.equal(receipt.receiptExtra.runtimeGuard.codeQualityReview.skippedReason, 'review_only');
  assert.equal(receipt.receiptExtra.review.targetCommitSha, reviewedCommit);
});

test('daddy-autopilot: review-only closure skips code-quality gate when commitSha is empty but requested review coverage matches', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-review-only-empty-commit-sha-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const reviewCountFile = path.join(tmp, 'review-count.txt');
  const taskRepo = await createTestGitWorkdir({ rootDir: tmp });

  await fs.mkdir(path.join(taskRepo, 'scripts'), { recursive: true });
  await fs.writeFile(path.join(taskRepo, 'scripts', 'nginx-ssr-apply.sh'), '#!/usr/bin/env bash\nexit 0\n', 'utf8');
  runGit(taskRepo, ['add', 'scripts/nginx-ssr-apply.sh']);
  runGit(taskRepo, ['commit', '-m', 'add control plane script']);
  const reviewedCommit = childProcess.execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: taskRepo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);

  const roster = {
    orchestratorName: 'orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'autopilot',
    agents: [
      {
        name: 'autopilot',
        role: 'autopilot-worker',
        skills: [],
        workdir: taskRepo,
        startCommand: 'node scripts/agent-codex-worker.mjs --agent autopilot',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');
  await ensureBusRoot(busRoot, roster);

  await writeTask({
    busRoot,
    agentName: 'autopilot',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['autopilot'],
      from: 'daddy',
      priority: 'P2',
      title: `Review ${reviewedCommit.slice(0, 7)} only`,
      signals: { kind: 'USER_REQUEST' },
      references: {},
    },
    body:
      'Tell the autopilot to run a real /review review/start now.\n' +
      `Review ${reviewedCommit} only.\n` +
      'No execute follow-up is required.\n',
  });

  const env = {
    ...BASE_ENV,
    AGENTIC_AUTOPILOT_DELEGATE_GATE: '1',
    AGENTIC_CODE_QUALITY_GATE: '1',
    AGENTIC_CODE_QUALITY_GATE_KINDS: 'USER_REQUEST',
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_APP_SERVER_TIMEOUT_MS: '5000',
    DUMMY_MODE: 'review-gate',
    REVIEW_TARGET_SHA: reviewedCommit,
    REVIEW_SCOPE: 'commit',
    REVIEWED_COMMITS: reviewedCommit,
    REVIEW_COUNT_FILE: reviewCountFile,
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'autopilot',
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
  assert.match(run.stderr, /\[codex\] review.completed status=completed/);

  const reviewCalls = Number(await fs.readFile(reviewCountFile, 'utf8'));
  assert.equal(reviewCalls, 1);

  const receiptPath = path.join(busRoot, 'receipts', 'autopilot', 't1.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(receipt.outcome, 'done');
  assert.equal(receipt.commitSha, '');
  assert.equal(receipt.receiptExtra.runtimeGuard.codeQualityGate.executed, false);
  assert.equal(receipt.receiptExtra.runtimeGuard.codeQualityGate.skippedReason, 'review_only');
  assert.equal(receipt.receiptExtra.runtimeGuard.codeQualityReview.skippedReason, 'review_only');
});

test('daddy-autopilot: review-only closure rejects reviewed commits outside the requested commit target', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-review-only-reviewed-commits-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const taskRepo = await createTestGitWorkdir({ rootDir: tmp });

  await fs.mkdir(path.join(taskRepo, 'scripts'), { recursive: true });
  const scriptPath = path.join(taskRepo, 'scripts', 'nginx-ssr-apply.sh');
  await fs.writeFile(scriptPath, '#!/usr/bin/env bash\nexit 0\n', 'utf8');
  runGit(taskRepo, ['add', 'scripts/nginx-ssr-apply.sh']);
  runGit(taskRepo, ['commit', '-m', 'add control plane script']);
  const reviewedTailCommit = childProcess.execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: taskRepo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  await fs.chmod(scriptPath, 0o755);
  runGit(taskRepo, ['add', 'scripts/nginx-ssr-apply.sh']);
  runGit(taskRepo, ['commit', '-m', 'restore exec bit']);
  const actedCommit = childProcess.execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: taskRepo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);

  const roster = {
    orchestratorName: 'orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'autopilot',
    agents: [
      {
        name: 'autopilot',
        role: 'autopilot-worker',
        skills: [],
        workdir: taskRepo,
        startCommand: 'node scripts/agent-codex-worker.mjs --agent autopilot',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');
  await ensureBusRoot(busRoot, roster);

  await writeTask({
    busRoot,
    agentName: 'autopilot',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['autopilot'],
      from: 'daddy',
      priority: 'P2',
      title: 'Close reviewed tail commit cleanly',
      signals: {
        kind: 'USER_REQUEST',
        reviewRequired: true,
        reviewTarget: {
          commitSha: reviewedTailCommit,
          commitShas: [reviewedTailCommit],
        },
      },
      references: {},
    },
    body:
      `Built-in review already covered ${reviewedTailCommit} and the acted tail commit.\n` +
      `Then emit the closure receipt for the acted tail commit.\n`,
  });

  const env = {
    ...BASE_ENV,
    AGENTIC_AUTOPILOT_DELEGATE_GATE: '1',
    AGENTIC_CODE_QUALITY_GATE: '1',
    AGENTIC_CODE_QUALITY_GATE_KINDS: 'USER_REQUEST',
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_APP_SERVER_TIMEOUT_MS: '5000',
    DUMMY_MODE: 'review-gate',
    COMMIT_SHA: actedCommit,
    REVIEW_TARGET_SHA: reviewedTailCommit,
    REVIEW_SCOPE: 'commit',
    REVIEWED_COMMITS: `${reviewedTailCommit},${actedCommit}`,
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'autopilot',
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

  const receiptPath = path.join(busRoot, 'receipts', 'autopilot', 't1.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(receipt.outcome, 'failed');
  assert.match(
    String(receipt.note || ''),
    /review\.reviewedCommits must not include commits outside the requested commit target/i,
  );
  assert.notEqual(receipt.receiptExtra.runtimeGuard?.delegationGate?.path, 'review_only');
});

test('daddy-autopilot: review-only closure blocks when built-in review verdict is not pass', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-review-only-verdict-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const taskRepo = await createTestGitWorkdir({ rootDir: tmp });
  await fs.mkdir(path.join(taskRepo, 'scripts'), { recursive: true });
  const scriptPath = path.join(taskRepo, 'scripts', 'nginx-ssr-apply.sh');
  await fs.writeFile(scriptPath, '#!/usr/bin/env bash\nexit 0\n', 'utf8');
  runGit(taskRepo, ['add', 'scripts/nginx-ssr-apply.sh']);
  runGit(taskRepo, ['commit', '-m', 'add control plane script']);
  await fs.chmod(scriptPath, 0o755);
  runGit(taskRepo, ['add', 'scripts/nginx-ssr-apply.sh']);
  runGit(taskRepo, ['commit', '-m', 'restore exec bit']);
  const actedCommit = childProcess.execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: taskRepo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);

  const roster = {
    orchestratorName: 'orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'autopilot',
    agents: [
      {
        name: 'autopilot',
        role: 'autopilot-worker',
        skills: [],
        workdir: taskRepo,
        startCommand: 'node scripts/agent-codex-worker.mjs --agent autopilot',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');
  await ensureBusRoot(busRoot, roster);

  await writeTask({
    busRoot,
    agentName: 'autopilot',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['autopilot'],
      from: 'daddy',
      priority: 'P2',
      title: 'Close reviewed tail closure under patched runtime',
      signals: { kind: 'USER_REQUEST' },
      references: {
        git: {
          commitSha: actedCommit,
        },
      },
    },
    body:
      `Run a real /review review/start on ${actedCommit} only.\n` +
      'No execute follow-up is required.\n',
  });

  const env = {
    ...BASE_ENV,
    AGENTIC_AUTOPILOT_DELEGATE_GATE: '1',
    AGENTIC_AUTOPILOT_SELF_REVIEW_GATE: '1',
    AGENTIC_CODE_QUALITY_GATE: '1',
    AGENTIC_CODE_QUALITY_GATE_KINDS: 'USER_REQUEST',
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_APP_SERVER_TIMEOUT_MS: '5000',
    DUMMY_MODE: 'review-gate',
    COMMIT_SHA: actedCommit,
    REVIEW_TARGET_SHA: actedCommit,
    REVIEW_SCOPE: 'commit',
    REVIEWED_COMMITS: actedCommit,
    REVIEW_VERDICT: 'changes_requested',
    REVIEW_STATUS_FOLLOWUP: '1',
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'autopilot',
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

  const receiptPath = path.join(busRoot, 'receipts', 'autopilot', 't1.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(receipt.outcome, 'blocked');
  assert.match(String(receipt.note || ''), /delegate_required/i);
  assert.notEqual(receipt.receiptExtra.runtimeGuard?.delegationGate?.path, 'review_only');
});

test('daddy-autopilot: USER_REQUEST PR review fails when an explicit PR commit selector is ambiguous', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-user-pr-review-unresolved-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const dummyGh = path.join(tmp, 'gh');
  const reviewCountFile = path.join(tmp, 'review-count.txt');

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);
  const commitA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const commitB = 'aaaaaabbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const shortSha = commitA.slice(0, 6);
  await writeExecutable(
    dummyGh,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [ "${1:-}" = "pr" ] && [ "${2:-}" = "view" ] && [ "${4:-}" = "--json" ] && [ "${5:-}" = "commits" ]; then',
      `  printf '%s\\n' '${commitA}' '${commitB}'`,
      '  exit 0',
      'fi',
      'echo "unexpected gh args: $*" >&2',
      'exit 1',
    ].join('\n'),
  );

  const roster = {
    orchestratorName: 'orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'autopilot',
    agents: [
      {
        name: 'autopilot',
        role: 'autopilot-worker',
        skills: [],
        workdir: '$REPO_ROOT',
        startCommand: 'node scripts/agent-codex-worker.mjs --agent autopilot',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');
  await ensureBusRoot(busRoot, roster);

  await writeTask({
    busRoot,
    agentName: 'autopilot',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['autopilot'],
      from: 'daddy',
      priority: 'P2',
      title: `Review ${shortSha} PR94`,
      signals: { kind: 'USER_REQUEST' },
      references: {},
    },
    body:
      'Tell the autopilot to run a real /review review/start on PR94.\n' +
      `Review ${shortSha} only.\n`,
  });

  const env = {
    ...BASE_ENV,
    PATH: `${tmp}:${BASE_ENV.PATH || ''}`,
    AGENTIC_AUTOPILOT_DELEGATE_GATE: '0',
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_APP_SERVER_TIMEOUT_MS: '5000',
    DUMMY_MODE: 'review-gate',
    REVIEW_COUNT_FILE: reviewCountFile,
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'autopilot',
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

  const receiptPath = path.join(busRoot, 'receipts', 'autopilot', 't1.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(receipt.outcome, 'failed');
  assert.match(
    String(receipt.note || ''),
    /explicit review target resolution failed|did not uniquely resolve/i,
  );

  const reviewCountExists = await waitForPath(reviewCountFile, { timeoutMs: 250, pollMs: 25 });
  assert.equal(reviewCountExists, false);
});

test('daddy-autopilot: USER_REQUEST PR review fails when explicit PR filters cannot be resolved without a PR commit list', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-user-pr-review-gh-fail-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const dummyGh = path.join(tmp, 'gh');
  const reviewCountFile = path.join(tmp, 'review-count.txt');
  const commitB = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const shortSha = commitB.slice(0, 6);

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);
  await writeExecutable(
    dummyGh,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [ "${1:-}" = "pr" ] && [ "${2:-}" = "view" ] && [ "${4:-}" = "--json" ] && [ "${5:-}" = "headRefOid" ]; then',
      `  printf '%s\\n' '${commitB}'`,
      '  exit 0',
      'fi',
      'exit 1',
    ].join('\n'),
  );

  const roster = {
    orchestratorName: 'orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'autopilot',
    agents: [
      {
        name: 'autopilot',
        role: 'autopilot-worker',
        skills: [],
        workdir: '$REPO_ROOT',
        startCommand: 'node scripts/agent-codex-worker.mjs --agent autopilot',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');
  await ensureBusRoot(busRoot, roster);

  await writeTask({
    busRoot,
    agentName: 'autopilot',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['autopilot'],
      from: 'daddy',
      priority: 'P2',
      title: `PR94 narrowed ${shortSha}`,
      signals: { kind: 'USER_REQUEST' },
      references: {},
    },
    body:
      'Tell the autopilot to run a real /review review/start on PR94.\n' +
      `Do not re-review ${shortSha}.\n`,
  });

  const env = {
    ...BASE_ENV,
    PATH: `${tmp}:${BASE_ENV.PATH || ''}`,
    AGENTIC_AUTOPILOT_DELEGATE_GATE: '0',
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_APP_SERVER_TIMEOUT_MS: '5000',
    DUMMY_MODE: 'review-gate',
    REVIEW_COUNT_FILE: reviewCountFile,
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'autopilot',
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

  const receiptPath = path.join(busRoot, 'receipts', 'autopilot', 't1.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(receipt.outcome, 'failed');
  assert.match(
    String(receipt.note || ''),
    /PR commit list could not be fetched to resolve directive SHAs/i,
  );

  const reviewCountExists = await waitForPath(reviewCountFile, { timeoutMs: 250, pollMs: 25 });
  assert.equal(reviewCountExists, false);
});

test('daddy-autopilot: USER_REQUEST PR review interrupts and restarts when task is updated mid-review', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-user-pr-review-update-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const dummyGh = path.join(tmp, 'gh');
  const reviewCountFile = path.join(tmp, 'review-count.txt');
  const commitA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const commitB = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);
  await writeExecutable(
    dummyGh,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [ "${1:-}" = "pr" ] && [ "${2:-}" = "view" ] && [ "${4:-}" = "--json" ] && [ "${5:-}" = "commits" ]; then',
      `  printf '%s\\n' '${commitA}' '${commitB}'`,
      '  exit 0',
      'fi',
      'if [ "${1:-}" = "pr" ] && [ "${2:-}" = "view" ] && [ "${4:-}" = "--json" ] && [ "${5:-}" = "headRefOid" ]; then',
      `  printf '%s\\n' '${commitB}'`,
      '  exit 0',
      'fi',
      'echo "unexpected gh args: $*" >&2',
      'exit 1',
    ].join('\n'),
  );

  const roster = {
    orchestratorName: 'orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'autopilot',
    agents: [
      {
        name: 'autopilot',
        role: 'autopilot-worker',
        skills: [],
        workdir: '$REPO_ROOT',
        startCommand: 'node scripts/agent-codex-worker.mjs --agent autopilot',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');
  await ensureBusRoot(busRoot, roster);

  await writeTask({
    busRoot,
    agentName: 'autopilot',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['autopilot'],
      from: 'daddy',
      priority: 'P2',
      title: 'PR94 real review start',
      signals: { kind: 'USER_REQUEST' },
      references: {},
    },
    body: 'Tell the autopilot to run a real /review review/start on PR94.',
  });

  const env = {
    ...BASE_ENV,
    PATH: `${tmp}:${BASE_ENV.PATH || ''}`,
    AGENTIC_AUTOPILOT_DELEGATE_GATE: '0',
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_APP_SERVER_TIMEOUT_MS: '10000',
    VALUA_CODEX_TASK_UPDATE_POLL_MS: '50',
    DUMMY_MODE: 'review-gate',
    REVIEW_DELAY_MS: '1200',
    REVIEW_TARGET_SHA: commitB,
    REVIEW_SCOPE: 'pr',
    REVIEWED_COMMITS: `${commitA},${commitB}`,
    REVIEW_COUNT_FILE: reviewCountFile,
    STALE_REVIEW_COMPLETION_AFTER_UPDATE: '1',
  };

  const runPromise = spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'autopilot',
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

  const inProgressPath = path.join(busRoot, 'inbox', 'autopilot', 'in_progress', 't1.md');
  assert.equal(await waitForPath(inProgressPath, { timeoutMs: 4000, pollMs: 25 }), true);
  {
    const start = Date.now();
    let ready = false;
    while (Date.now() - start < 5000) {
      try {
        const n = Number(await fs.readFile(reviewCountFile, 'utf8'));
        if (Number.isFinite(n) && n >= 1) {
          ready = true;
          break;
        }
      } catch {
        // ignore until file appears
      }
      await sleep(25);
    }
    assert.equal(ready, true);
  }
  await fs.appendFile(inProgressPath, '\n\nSENTINEL_UPDATE\ninterrupt now\n', 'utf8');

  const run = await runPromise;
  assert.equal(run.code, 0, run.stderr || run.stdout);
  assert.match(run.stderr, /task updated; restarting codex app-server turn/);

  const receiptPath = path.join(busRoot, 'receipts', 'autopilot', 't1.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(receipt.outcome, 'done');
  assert.notEqual(receipt.note, 'started-before-review-completion');
  const reviewCount = Number(await fs.readFile(reviewCountFile, 'utf8'));
  assert.ok(Number.isFinite(reviewCount) && reviewCount >= 2, `expected review count >= 2, got ${reviewCount}`);
});

test('daddy-autopilot: app-server review gate retry reruns review/start for the retry attempt', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-review-gate-retry-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const reviewCountFile = path.join(tmp, 'review-count.txt');
  const countFile = path.join(tmp, 'turn-count.txt');

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);

  const roster = {
    orchestratorName: 'orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'autopilot',
    agents: [
      {
        name: 'autopilot',
        role: 'autopilot-worker',
        skills: [],
        workdir: '$REPO_ROOT',
        startCommand: 'node scripts/agent-codex-worker.mjs --agent autopilot',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');
  await ensureBusRoot(busRoot, roster);

  await writeTask({
    busRoot,
    agentName: 'autopilot',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['autopilot'],
      from: 'daddy-orchestrator',
      priority: 'P2',
      title: 'review gate retry',
      signals: {
        kind: 'ORCHESTRATOR_UPDATE',
        sourceKind: 'TASK_COMPLETE',
        reviewRequired: true,
        reviewTarget: {
          sourceTaskId: 'exec-1',
          sourceAgent: 'frontend',
          sourceKind: 'EXECUTE',
          commitSha: 'abc123',
          receiptPath: 'receipts/frontend/exec-1.json',
          repoRoot,
        },
      },
      references: {
        completedTaskKind: 'EXECUTE',
        commitSha: 'abc123',
        receiptPath: 'receipts/frontend/exec-1.json',
      },
    },
    body: 'review completion and decide',
  });

  const env = {
    ...BASE_ENV,
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_APP_SERVER_TIMEOUT_MS: '5000',
    DUMMY_MODE: 'review-gate-retry',
    REVIEW_COUNT_FILE: reviewCountFile,
    COUNT_FILE: countFile,
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'autopilot',
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
  assert.match(run.stderr, /review gate retry:/);

  const reviewCalls = Number(await fs.readFile(reviewCountFile, 'utf8'));
  assert.equal(reviewCalls, 2);
  const turnCalls = Number(await fs.readFile(countFile, 'utf8'));
  assert.equal(turnCalls, 2);

  const receiptPath = path.join(busRoot, 'receipts', 'autopilot', 't1.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(receipt.outcome, 'done');
  assert.equal(receipt.receiptExtra.review.summary, 'Retry passed.');
  assert.equal(receipt.receiptExtra.reviewArtifactPath, 'artifacts/autopilot/reviews/t1.retry.md');
});

test('agent-codex-worker: exits duplicate worker when lock is already held', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-lock-held-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);

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
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');

  await writeTask({
    busRoot,
    agentName: 'backend',
    taskId: 't1',
    meta: { id: 't1', to: ['backend'], from: 'daddy', priority: 'P2', title: 't1', signals: { kind: 'USER_REQUEST' } },
    body: 'do t1',
  });

  const lockDir = path.join(busRoot, 'state', 'worker-locks');
  await fs.mkdir(lockDir, { recursive: true });
  await fs.writeFile(
    path.join(lockDir, 'backend.lock.json'),
    JSON.stringify({ agent: 'backend', pid: process.pid, acquiredAt: new Date().toISOString(), token: 'held' }) + '\n',
    'utf8',
  );

  const env = {
    ...BASE_ENV,
    AGENTIC_CODEX_HOME_MODE: 'agent',
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_APP_SERVER_TIMEOUT_MS: '3000',
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
  assert.match(run.stderr, /already running; exiting duplicate worker/);

  const receiptPath = path.join(busRoot, 'receipts', 'backend', 't1.json');
  await assert.rejects(fs.stat(receiptPath));
  const codexHomePath = path.join(busRoot, 'state', 'codex-home', 'backend');
  await assert.rejects(fs.stat(codexHomePath));
});

test('agent-codex-worker: fresh corrupted lock is treated as held (no takeover)', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-lock-corrupt-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);

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
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');

  await writeTask({
    busRoot,
    agentName: 'backend',
    taskId: 't1',
    meta: { id: 't1', to: ['backend'], from: 'daddy', priority: 'P2', title: 't1', signals: { kind: 'USER_REQUEST' } },
    body: 'do t1',
  });

  const lockDir = path.join(busRoot, 'state', 'worker-locks');
  await fs.mkdir(lockDir, { recursive: true });
  const lockPath = path.join(lockDir, 'backend.lock.json');
  await fs.writeFile(lockPath, '{', 'utf8');

  const env = {
    ...BASE_ENV,
    AGENTIC_CODEX_HOME_MODE: 'agent',
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_APP_SERVER_TIMEOUT_MS: '3000',
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
  assert.match(run.stderr, /already running; exiting duplicate worker/);

  assert.equal(await fs.readFile(lockPath, 'utf8'), '{');
  const receiptPath = path.join(busRoot, 'receipts', 'backend', 't1.json');
  await assert.rejects(fs.stat(receiptPath));
  const codexHomePath = path.join(busRoot, 'state', 'codex-home', 'backend');
  await assert.rejects(fs.stat(codexHomePath));
});

test('agent-codex-worker: app-server engine restarts when task is updated', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-update-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const countFile = path.join(tmp, 'count.txt');
  const started1 = path.join(tmp, 'attempt1.started');

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);

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
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');

  await writeTask({
    busRoot,
    agentName: 'backend',
    taskId: 't1',
    meta: { id: 't1', to: ['backend'], from: 'daddy', priority: 'P2', title: 't1', signals: { kind: 'USER_REQUEST' } },
    body: 'do t1',
  });

  const env = {
    ...BASE_ENV,
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_APP_SERVER_TIMEOUT_MS: '5000',
    VALUA_CODEX_TASK_UPDATE_POLL_MS: '50',
    DUMMY_MODE: 'update',
    STALE_COMPLETION_AFTER_UPDATE: '1',
    COUNT_FILE: countFile,
    STARTED1: started1,
  };

  const runPromise = spawnProcess(
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

  assert.equal(await waitForPath(started1, { timeoutMs: 4000, pollMs: 25 }), true);
  const inProgressPath = path.join(busRoot, 'inbox', 'backend', 'in_progress', 't1.md');
  assert.equal(await waitForPath(inProgressPath, { timeoutMs: 4000, pollMs: 25 }), true);
  await fs.appendFile(inProgressPath, '\n\nSENTINEL_UPDATE\n', 'utf8');

  const run = await runPromise;
  assert.equal(run.code, 0, run.stderr || run.stdout);

  const receiptPath = path.join(busRoot, 'receipts', 'backend', 't1.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(receipt.outcome, 'done');
  assert.match(receipt.note, /\bsaw-update\b/);

  const invoked = Number(await fs.readFile(countFile, 'utf8'));
  assert.equal(invoked, 2);
});

test('agent-codex-worker: first preflight clean artifact path survives later task retries', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-preflight-clean-retry-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const countFile = path.join(tmp, 'count.txt');
  const started1 = path.join(tmp, 'attempt1.started');
  const promptLogFile = path.join(tmp, 'prompts.log');
  const workdir = await createTestGitWorkdir({ rootDir: tmp });
  const baseSha = childProcess.execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: workdir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const branch = childProcess.execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: workdir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

  await fs.writeFile(path.join(workdir, 'README.md'), 'dirty execute before retry\n', 'utf8');
  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);

  const roster = {
    orchestratorName: 'daddy-orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'daddy-autopilot',
    agents: [
      {
        name: 'backend',
        role: 'codex-worker',
        skills: [],
        workdir,
        startCommand: 'node scripts/agent-codex-worker.mjs --agent backend',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');
  await ensureBusRoot(busRoot, roster);

  await writeTask({
    busRoot,
    agentName: 'backend',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['backend'],
      from: 'daddy',
      priority: 'P2',
      title: 'execute with retry after preflight clean',
      signals: { kind: 'EXECUTE' },
      references: {
        git: {
          baseSha,
          baseBranch: branch,
          workBranch: branch,
        },
      },
    },
    body: 'execute and handle task update',
  });

  const env = {
    ...BASE_ENV,
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_APP_SERVER_TIMEOUT_MS: '5000',
    VALUA_CODEX_TASK_UPDATE_POLL_MS: '50',
    AGENTIC_EXEC_PREFLIGHT_AUTOCLEAN_DIRTY: '1',
    DUMMY_MODE: 'update',
    STALE_COMPLETION_AFTER_UPDATE: '1',
    COUNT_FILE: countFile,
    STARTED1: started1,
    PROMPT_LOG_FILE: promptLogFile,
  };

  const runPromise = spawnProcess(
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

  assert.equal(await waitForPath(started1, { timeoutMs: 4000, pollMs: 25 }), true);
  const inProgressPath = path.join(busRoot, 'inbox', 'backend', 'in_progress', 't1.md');
  assert.equal(await waitForPath(inProgressPath, { timeoutMs: 4000, pollMs: 25 }), true);
  await fs.appendFile(inProgressPath, '\n\nSENTINEL_UPDATE\n', 'utf8');

  const run = await runPromise;
  assert.equal(run.code, 0, run.stderr || run.stdout);

  const receiptPath = path.join(busRoot, 'receipts', 'backend', 't1.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(receipt.outcome, 'done');
  assert.match(receipt.note, /\bsaw-update\b/);
  assert.equal(receipt.receiptExtra.git.preflightCleanArtifactPath, 'artifacts/backend/preflight/t1.clean.md');
  assert.equal(
    await waitForPath(path.join(busRoot, 'artifacts', 'backend', 'preflight', 't1.clean.md'), {
      timeoutMs: 1000,
      pollMs: 25,
    }),
    true,
  );

  const promptLog = await fs.readFile(promptLogFile, 'utf8');
  const prompts = promptLog.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  assert.deepEqual(prompts, ['preflight', 'execute', 'preflight', 'execute']);

  const invoked = Number(await fs.readFile(countFile, 'utf8'));
  assert.equal(invoked, 4);
});

test('agent-codex-worker: timeout receipts preserve preflight clean artifact evidence', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-timeout-preflight-clean-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const workdir = await createTestGitWorkdir({ rootDir: tmp });
  const baseSha = childProcess.execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: workdir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const branch = childProcess.execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: workdir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

  await fs.writeFile(path.join(workdir, 'README.md'), 'dirty execute before timeout\n', 'utf8');
  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);

  const roster = {
    orchestratorName: 'daddy-orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'daddy-autopilot',
    agents: [
      {
        name: 'backend',
        role: 'codex-worker',
        skills: [],
        workdir,
        startCommand: 'node scripts/agent-codex-worker.mjs --agent backend',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');
  await ensureBusRoot(busRoot, roster);

  await writeTask({
    busRoot,
    agentName: 'backend',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['backend'],
      from: 'daddy',
      priority: 'P2',
      title: 'execute with timeout after preflight clean',
      signals: { kind: 'EXECUTE' },
      references: {
        git: {
          baseSha,
          baseBranch: branch,
          workBranch: branch,
        },
      },
    },
    body: 'execute and time out',
  });

  const env = {
    ...BASE_ENV,
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_APP_SERVER_TIMEOUT_MS: '200',
    AGENTIC_EXEC_PREFLIGHT_AUTOCLEAN_DIRTY: '1',
    DUMMY_MODE: 'update',
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

  const receipt = JSON.parse(await fs.readFile(path.join(busRoot, 'receipts', 'backend', 't1.json'), 'utf8'));
  assert.equal(receipt.outcome, 'blocked');
  assert.match(String(receipt.note || ''), /timed out after/i);
  assert.equal(receipt.receiptExtra.git.preflightCleanArtifactPath, 'artifacts/backend/preflight/t1.clean.md');
  assert.equal(receipt.receiptExtra.git.staleWorkerReclaim, null);
  assert.equal(
    await waitForPath(path.join(busRoot, 'artifacts', 'backend', 'preflight', 't1.clean.md'), {
      timeoutMs: 1000,
      pollMs: 25,
    }),
    true,
  );
});

test('agent-codex-worker: generic runtime failures preserve stale worker reclaim evidence', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-stale-reclaim-fail-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const workdir = await createTestGitWorkdir({ rootDir: tmp });
  const baseSha = childProcess.execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: workdir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const branch = childProcess.execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: workdir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const targetBranch = `slice/${branch}-r1`;

  await fs.writeFile(path.join(workdir, 'README.md'), 'stale reclaim dirt\n', 'utf8');
  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);

  const roster = {
    orchestratorName: 'daddy-orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'daddy-autopilot',
    agents: [
      {
        name: 'backend',
        role: 'codex-worker',
        skills: [],
        workdir,
        startCommand: 'node scripts/agent-codex-worker.mjs --agent backend',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');
  await ensureBusRoot(busRoot, roster);
  await writeAgentRootFocusState({ busRoot, agentName: 'backend', rootId: 'root-old', branch });

  await writeTask({
    busRoot,
    agentName: 'backend',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['backend'],
      from: 'daddy',
      priority: 'P2',
      title: 'execute after stale reclaim',
      signals: { kind: 'EXECUTE', rootId: 'root-new' },
      references: {
        git: {
          baseSha,
          baseBranch: branch,
          workBranch: targetBranch,
        },
      },
    },
    body: 'execute after reclaim',
  });

  const env = {
    ...BASE_ENV,
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_APP_SERVER_TIMEOUT_MS: '2000',
    DUMMY_MODE: 'invalid-json',
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

  const receipt = JSON.parse(await fs.readFile(path.join(busRoot, 'receipts', 'backend', 't1.json'), 'utf8'));
  assert.equal(receipt.outcome, 'failed');
  assert.match(String(receipt.note || ''), /codex app-server failed:/i);
  assert.equal(receipt.receiptExtra.git.staleWorkerReclaim.reclaimed, true);
  assert.equal(receipt.receiptExtra.git.staleWorkerReclaim.currentBranch, branch);
  assert.equal(receipt.receiptExtra.git.staleWorkerReclaim.recordedFocusBranch, branch);
  assert.equal(receipt.receiptExtra.git.staleWorkerReclaim.targetBranch, targetBranch);
  await assert.rejects(
    fs.access(path.join(busRoot, 'artifacts', 'backend', 'preflight', 't1.stale-reclaim.md')),
    /ENOENT/,
  );
});

test('AGENTIC_CODEX_APP_SERVER_PERSIST=false disables persistence (accepts common falsy strings)', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-persist-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const startCountFile = path.join(tmp, 'server-start-count.txt');

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER_START_COUNT);

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
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');

  await writeTask({
    busRoot,
    agentName: 'backend',
    taskId: 't1',
    meta: { id: 't1', to: ['backend'], from: 'daddy', priority: 'P2', title: 't1', signals: { kind: 'USER_REQUEST' } },
    body: 'do t1',
  });
  await writeTask({
    busRoot,
    agentName: 'backend',
    taskId: 't2',
    meta: { id: 't2', to: ['backend'], from: 'daddy', priority: 'P2', title: 't2', signals: { kind: 'USER_REQUEST' } },
    body: 'do t2',
  });

  const env = {
    ...BASE_ENV,
    AGENTIC_CODEX_APP_SERVER_PERSIST: 'false',
    SERVER_START_COUNT_FILE: startCountFile,
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_APP_SERVER_TIMEOUT_MS: '5000',
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

  const startCount = Number((await fs.readFile(startCountFile, 'utf8')).trim() || '0');
  assert.equal(startCount, 2, `expected 2 app-server starts when persist=false, got ${startCount}`);
});

test('app-server persistence resumes persisted thread only when explicitly enabled', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-resume-reuse-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const resumeCountFile = path.join(tmp, 'resume-count.txt');

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER_START_COUNT);

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
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');

  await writeTask({
    busRoot,
    agentName: 'backend',
    taskId: 't1',
    meta: { id: 't1', to: ['backend'], from: 'daddy', priority: 'P2', title: 't1', signals: { kind: 'USER_REQUEST' } },
    body: 'do t1',
  });
  await writeTask({
    busRoot,
    agentName: 'backend',
    taskId: 't2',
    meta: { id: 't2', to: ['backend'], from: 'daddy', priority: 'P2', title: 't2', signals: { kind: 'USER_REQUEST' } },
    body: 'do t2',
  });
  await fs.mkdir(path.join(busRoot, 'state'), { recursive: true });
  await fs.writeFile(path.join(busRoot, 'state', 'backend.session-id'), 'thread-app\n', 'utf8');

  const env = {
    ...BASE_ENV,
    AGENTIC_CODEX_APP_SERVER_PERSIST: '1',
    AGENTIC_CODEX_APP_SERVER_RESUME_PERSISTED: '1',
    RESUME_COUNT_FILE: resumeCountFile,
    THREAD_ID: 'thread-app',
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_APP_SERVER_TIMEOUT_MS: '3000',
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

  const resumeCount = Number((await fs.readFile(resumeCountFile, 'utf8')).trim() || '0');
  assert.equal(
    resumeCount,
    2,
    `expected thread/resume to be called per task when persisted resume is enabled, got ${resumeCount}`,
  );
});

test('daddy-autopilot: app-server uses dangerFullAccess sandbox policy by default', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-autopilot-policy-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const policyFile = path.join(tmp, 'policy.json');

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER_CAPTURE_POLICY);

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
    meta: { id: 't1', to: ['daddy-autopilot'], from: 'daddy', priority: 'P2', title: 't1', signals: { kind: 'USER_REQUEST' } },
    body: 'do t1',
  });

  const env = {
    ...BASE_ENV,
    POLICY_FILE: policyFile,
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_APP_SERVER_TIMEOUT_MS: '3000',
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

  const policy = JSON.parse(await fs.readFile(policyFile, 'utf8'));
  assert.equal(policy?.type, 'dangerFullAccess');
  assert.equal(Object.prototype.hasOwnProperty.call(policy ?? {}, 'writableRoots'), false);
});

test('workspaceWrite sandbox includes configured extra writable roots when explicitly set', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-extra-writable-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const policyFile = path.join(tmp, 'policy.json');
  const workdir = await createTestGitWorkdir({ rootDir: tmp });
  const extraWritableA = path.join(tmp, 'apps', 'Valua_staging');
  const extraWritableB = path.join(tmp, 'apps', 'Valua');

  await fs.mkdir(extraWritableA, { recursive: true });
  await fs.mkdir(extraWritableB, { recursive: true });
  await writeExecutable(dummyCodex, DUMMY_APP_SERVER_CAPTURE_POLICY);

  const roster = {
    agents: [
      {
        name: 'infra',
        role: 'worker',
        skills: [],
        workdir,
        startCommand: 'node scripts/agent-codex-worker.mjs --agent infra',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');

  await writeTask({
    busRoot,
    agentName: 'infra',
    taskId: 't1',
    meta: { id: 't1', to: ['infra'], from: 'daddy-autopilot', priority: 'P2', title: 't1', signals: { kind: 'EXECUTE' } },
    body: 'do t1',
  });

  const env = {
    ...BASE_ENV,
    POLICY_FILE: policyFile,
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_APP_SERVER_TIMEOUT_MS: '3000',
    VALUA_CODEX_EXTRA_WRITABLE_ROOTS: `${extraWritableA},${extraWritableB}`,
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'infra',
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

  const policy = JSON.parse(await fs.readFile(policyFile, 'utf8'));
  assert.equal(policy?.type, 'workspaceWrite');
  assert.ok(Array.isArray(policy?.writableRoots));
  assert.ok(policy.writableRoots.includes(path.resolve(workdir)));
  assert.ok(policy.writableRoots.includes(path.resolve(extraWritableA)));
  assert.ok(policy.writableRoots.includes(path.resolve(extraWritableB)));
});

test('workspaceWrite sandbox resolves VALUA_AGENT_WORKTREES_DIR separately from AGENTIC_WORKTREES_DIR', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-valua-worktrees-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const policyFile = path.join(tmp, 'policy.json');
  const agenticWorktreesDir = path.join(tmp, 'agentic-worktrees');
  const valuaWorktreesDir = path.join(tmp, 'valua-worktrees');
  const workdir = await createTestGitWorkdir({ rootDir: valuaWorktreesDir });

  await fs.mkdir(agenticWorktreesDir, { recursive: true });
  await writeExecutable(dummyCodex, DUMMY_APP_SERVER_CAPTURE_POLICY);

  const roster = {
    agents: [
      {
        name: 'infra',
        role: 'worker',
        skills: [],
        workdir: '$VALUA_AGENT_WORKTREES_DIR/work',
        startCommand: 'node scripts/agent-codex-worker.mjs --agent infra',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');

  await writeTask({
    busRoot,
    agentName: 'infra',
    taskId: 't1',
    meta: { id: 't1', to: ['infra'], from: 'daddy-autopilot', priority: 'P2', title: 't1', signals: { kind: 'EXECUTE' } },
    body: 'do t1',
  });

  const env = {
    ...BASE_ENV,
    POLICY_FILE: policyFile,
    AGENTIC_WORKTREES_DIR: agenticWorktreesDir,
    VALUA_AGENT_WORKTREES_DIR: valuaWorktreesDir,
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_APP_SERVER_TIMEOUT_MS: '3000',
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'infra',
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

  const policy = JSON.parse(await fs.readFile(policyFile, 'utf8'));
  assert.equal(policy?.type, 'workspaceWrite');
  assert.ok(Array.isArray(policy?.writableRoots));
  assert.ok(policy.writableRoots.includes(path.resolve(workdir)));
  assert.ok(!policy.writableRoots.includes(path.resolve(path.join(agenticWorktreesDir, 'work'))));
});
