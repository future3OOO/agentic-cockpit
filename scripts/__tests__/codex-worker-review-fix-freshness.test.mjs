import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { planAutopilotBlockedRecovery } from '../lib/autopilot-root-recovery.mjs';
import { hashActionableCommentBody } from '../lib/review-fix-comment.mjs';
import {
  buildHermeticBaseEnv,
  initRepoWithTrackedCodexDir,
  runCodexWorkerOnce,
  writeExecutable,
  writeTask,
} from './helpers/codex-worker-harness.mjs';

const BASE_ENV = buildHermeticBaseEnv();

async function setupReviewFixHarness(prefix, { includeOpusConsult = false } = {}) {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const taskRepo = path.join(tmp, 'task-repo');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const prHeadFile = path.join(tmp, 'pr-head.txt');
  const threadResponseFile = path.join(tmp, 'thread.json');
  const commentResponseFile = path.join(tmp, 'comment.json');

  await initRepoWithTrackedCodexDir(taskRepo);
  await writeExecutable(
    dummyCodex,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'countFile="${COUNT_FILE:-}"',
      'if [[ -n "$countFile" ]]; then',
      '  n=0',
      '  if [[ -f "$countFile" ]]; then n="$(cat "$countFile")"; fi',
      '  [[ "$n" =~ ^[0-9]+$ ]] || n=0',
      '  printf "%s" "$((n + 1))" > "$countFile"',
      'fi',
      'cat > /dev/null',
      'echo "session id: session-review-fix" >&2',
      'for ((i=1; i<=$#; i++)); do',
      '  arg="${!i}"',
      '  if [[ "$arg" == "-o" ]]; then',
      '    j=$((i+1))',
      '    printf \'{"outcome":"done","note":"ok","commitSha":"","followUps":[],"review":null}\' > "${!j}"',
      '    break',
      '  fi',
      'done',
      '',
    ].join('\n'),
  );

  await fs.writeFile(
    path.join(tmp, 'gh'),
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [[ "${1:-}" == "pr" && "${2:-}" == "view" ]]; then',
      '  [[ "${GH_FAIL_STAGE:-}" == "pr_head" ]] && { echo "head lookup failed" >&2; exit 1; }',
      '  cat "${GH_PR_HEAD_FILE}"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == "api" && "${2:-}" == "graphql" ]]; then',
      '  [[ "${GH_FAIL_STAGE:-}" == "thread" ]] && { echo "thread lookup failed" >&2; exit 1; }',
      '  cat "${GH_THREAD_RESPONSE_FILE}"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == "api" && "${2:-}" == repos/*/issues/comments/* ]]; then',
      '  [[ "${GH_FAIL_STAGE:-}" == "comment_missing" ]] && { echo "HTTP 404 Not Found" >&2; exit 1; }',
      '  [[ "${GH_FAIL_STAGE:-}" == "comment" ]] && { echo "comment lookup failed" >&2; exit 1; }',
      '  cat "${GH_COMMENT_RESPONSE_FILE}"',
      '  exit 0',
      'fi',
      'exit 1',
      '',
    ].join('\n'),
    'utf8',
  );
  await fs.chmod(path.join(tmp, 'gh'), 0o755);

  await fs.writeFile(
    rosterPath,
    JSON.stringify({
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
        ...(includeOpusConsult
          ? [
              {
                name: 'opus-consult',
                role: 'opus-consult-worker',
                skills: [],
                workdir: taskRepo,
                startCommand: 'node scripts/agent-opus-consult-worker.mjs --agent opus-consult',
              },
            ]
          : []),
      ],
    }, null, 2) + '\n',
    'utf8',
  );

  return {
    repoRoot,
    tmp,
    busRoot,
    rosterPath,
    dummyCodex,
    countFile: path.join(tmp, 'count.txt'),
    prHeadFile,
    threadResponseFile,
    commentResponseFile,
  };
}

function buildWorkerEnv(harness, extra = {}) {
  return {
    ...BASE_ENV,
    VALUA_AGENT_BUS_DIR: harness.busRoot,
    AGENTIC_AUTOPILOT_DELEGATE_GATE: '0',
    AGENTIC_RUNTIME_POLICY_SYNC: '0',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    COUNT_FILE: harness.countFile,
    GH_PR_HEAD_FILE: harness.prHeadFile,
    GH_THREAD_RESPONSE_FILE: harness.threadResponseFile,
    GH_COMMENT_RESPONSE_FILE: harness.commentResponseFile,
    PATH: `${harness.tmp}:${BASE_ENV.PATH || ''}`,
    ...extra,
  };
}

async function runWorker(harness, envExtra = {}) {
  return runCodexWorkerOnce({
    repoRoot: harness.repoRoot,
    busRoot: harness.busRoot,
    rosterPath: harness.rosterPath,
    agentName: 'daddy-autopilot',
    codexBin: harness.dummyCodex,
    env: buildWorkerEnv(harness, envExtra),
  });
}

async function countPendingConsultRequests(busRoot) {
  try {
    const dir = path.join(busRoot, 'inbox', 'opus-consult', 'new');
    const entries = await fs.readdir(dir);
    return entries.filter((entry) => entry.endsWith('.md')).length;
  } catch (err) {
    if (err?.code === 'ENOENT') return 0;
    throw err;
  }
}

async function readCount(countFile) {
  try {
    const raw = await fs.readFile(countFile, 'utf8');
    const count = Number(raw);
    return Number.isFinite(count) ? count : 0;
  } catch (err) {
    if (err?.code === 'ENOENT') return 0;
    throw err;
  }
}

async function readReceipt(busRoot, taskId) {
  return JSON.parse(await fs.readFile(path.join(busRoot, 'receipts', 'daddy-autopilot', `${taskId}.json`), 'utf8'));
}

function buildThreadRefs(
  headRefOid,
  lastCommentId = 'thread-comment-1',
  lastCommentCreatedAt = '2026-03-14T02:00:00Z',
  lastCommentUpdatedAt = '2026-03-14T02:05:00Z',
) {
  return {
    pr: {
      owner: 'future3OOO',
      repo: 'agentic-cockpit',
      number: 121,
      headRefOid,
      headRefName: 'slice/pr121',
    },
    thread: {
      id: 'THREAD_123',
      url: 'https://example.test/thread/123',
      lastCommentId,
      lastCommentCreatedAt,
      lastCommentUpdatedAt,
    },
  };
}

function buildCommentRefs(headRefOid, body = 'CI failing: tests failing on main') {
  return {
    pr: {
      owner: 'future3OOO',
      repo: 'agentic-cockpit',
      number: 121,
      headRefOid,
      headRefName: 'slice/pr121',
    },
    comment: {
      id: 12345,
      url: 'https://example.test/comment/12345',
      updatedAt: '2026-03-14T02:00:00Z',
      bodyHash: hashActionableCommentBody(body),
    },
  };
}

async function writeThreadState(filePath, state) {
  await fs.writeFile(filePath, JSON.stringify({ data: { node: state } }, null, 2) + '\n', 'utf8');
}

async function writeCommentState(filePath, state) {
  await fs.writeFile(filePath, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

function buildMeta(taskId, { refs = null, direct = true, phase = 'review-fix', legacy = false } = {}) {
  if (phase === 'blocked-recovery') {
    return {
      id: taskId,
      to: ['daddy-autopilot'],
      from: 'daddy-autopilot',
      title: taskId,
      signals: {
        kind: 'ORCHESTRATOR_UPDATE',
        sourceKind: 'AUTOPILOT_BLOCKED_RECOVERY',
        phase,
        rootId: 'PR121',
        notifyOrchestrator: false,
      },
      references: {
        autopilotRecovery: { recoveryKey: taskId, attempt: 1, maxAttempts: 3, reasonCode: 'blocked' },
        ...(legacy || !refs ? {} : { sourceAgent: 'observer:pr', sourceReferences: refs }),
      },
    };
  }
  return {
    id: taskId,
    to: ['daddy-autopilot'],
    from: direct ? 'observer:pr' : 'daddy-orchestrator',
    title: taskId,
    signals: {
      kind: direct ? 'REVIEW_ACTION_REQUIRED' : 'ORCHESTRATOR_UPDATE',
      ...(direct ? {} : { sourceKind: 'REVIEW_ACTION_REQUIRED' }),
      phase,
      rootId: 'PR121',
    },
    references: legacy
      ? { pr: { owner: 'future3OOO', repo: 'agentic-cockpit', number: 121 } }
      : direct
        ? refs
        : { sourceAgent: 'observer:pr', sourceReferences: refs },
  };
}

async function writeReviewFixTask(harness, taskId, options = {}) {
  await writeTask({
    busRoot: harness.busRoot,
    agentName: 'daddy-autopilot',
    taskId,
    meta: buildMeta(taskId, options),
    body: options.body || taskId,
  });
}

async function runFreshnessCase({
  prefix,
  taskId,
  refs,
  direct = true,
  phase = 'review-fix',
  legacy = false,
  envExtra = {},
  includeOpusConsult = false,
  prepare = async () => {},
}) {
  const harness = await setupReviewFixHarness(prefix, { includeOpusConsult });
  if (!legacy && refs) await prepare(harness, refs);
  await writeReviewFixTask(harness, taskId, { refs, direct, phase, legacy });
  const run = await runWorker(harness, envExtra);
  assert.equal(run.code, 0, run.stderr || run.stdout);
  return {
    harness,
    receipt: await readReceipt(harness.busRoot, taskId),
  };
}

function assertFresh(receipt) {
  assert.equal(receipt.outcome, 'done');
  assert.equal(receipt.receiptExtra?.runtimeGuard?.reviewFixFreshness?.status, 'fresh');
}

function assertSuperseded(receipt, staleCause) {
  assert.equal(receipt.outcome, 'skipped');
  assert.equal(receipt.receiptExtra?.reasonCode, 'review_fix_source_superseded');
  assert.equal(receipt.receiptExtra?.runtimeGuard?.reviewFixFreshness?.staleCause, staleCause);
}

test('legacy observer review-fix packet without freshness fields stays fail-open', async () => {
  const { harness, receipt } = await runFreshnessCase({
    prefix: 'agentic-review-fix-legacy-observer-',
    taskId: 'legacy_direct',
    legacy: true,
  });
  assert.equal(receipt.outcome, 'done');
  assert.equal(await readCount(harness.countFile), 1);
});

test('legacy blocked-recovery packet without freshness fields stays fail-open', async () => {
  const { harness, receipt } = await runFreshnessCase({
    prefix: 'agentic-review-fix-legacy-recovery-',
    taskId: 'legacy_recovery',
    phase: 'blocked-recovery',
    legacy: true,
  });
  assert.equal(receipt.outcome, 'done');
  assert.equal(await readCount(harness.countFile), 1);
});

test('matching head and same live thread state proceeds normally for direct observer packets', async () => {
  const headRefOid = '0123456789abcdef0123456789abcdef01234567';
  const { harness, receipt } = await runFreshnessCase({
    prefix: 'agentic-review-fix-direct-fresh-',
    taskId: 'fresh_direct',
    refs: buildThreadRefs(headRefOid),
    prepare: async (h, refs) => {
      await fs.writeFile(h.prHeadFile, `${refs.pr.headRefOid}\n`, 'utf8');
      await writeThreadState(h.threadResponseFile, {
        __typename: 'PullRequestReviewThread',
        id: refs.thread.id,
        isResolved: false,
        isOutdated: false,
        comments: {
          nodes: [
            {
              id: refs.thread.lastCommentId,
              createdAt: refs.thread.lastCommentCreatedAt,
              updatedAt: refs.thread.lastCommentUpdatedAt,
            },
          ],
        },
      });
    },
  });
  assertFresh(receipt);
  assert.equal(await readCount(harness.countFile), 1);
});

test('matching head and same live actionable comment state proceeds normally for orchestrator digests', async () => {
  const headRefOid = '89abcdef0123456789abcdef0123456789abcdef';
  const { harness, receipt } = await runFreshnessCase({
    prefix: 'agentic-review-fix-digest-fresh-',
    taskId: 'fresh_digest',
    refs: buildCommentRefs(headRefOid),
    direct: false,
    prepare: async (h, refs) => {
      await fs.writeFile(h.prHeadFile, `${refs.pr.headRefOid}\n`, 'utf8');
      await writeCommentState(h.commentResponseFile, {
        id: refs.comment.id,
        body: 'CI failing: tests failing on main',
        updated_at: refs.comment.updatedAt,
      });
    },
  });
  assertFresh(receipt);
  assert.equal(await readCount(harness.countFile), 1);
});

test('thread freshness stale causes supersede before Codex runs', async (t) => {
  const cases = [
    {
      name: 'pr_head_moved',
      prepare: async (h) => fs.writeFile(h.prHeadFile, 'ffffffffffffffffffffffffffffffffffffffff\n', 'utf8'),
    },
    {
      name: 'review_thread_missing',
      prepare: async (h, refs) => {
        await fs.writeFile(h.prHeadFile, `${refs.pr.headRefOid}\n`, 'utf8');
        await writeThreadState(h.threadResponseFile, null);
      },
    },
    {
      name: 'review_thread_resolved',
      prepare: async (h, refs) => {
        await fs.writeFile(h.prHeadFile, `${refs.pr.headRefOid}\n`, 'utf8');
        await writeThreadState(h.threadResponseFile, {
          __typename: 'PullRequestReviewThread',
          id: refs.thread.id,
          isResolved: true,
          isOutdated: false,
          comments: {
            nodes: [
              {
                id: refs.thread.lastCommentId,
                createdAt: refs.thread.lastCommentCreatedAt,
                updatedAt: refs.thread.lastCommentUpdatedAt,
              },
            ],
          },
        });
      },
    },
    {
      name: 'review_thread_outdated',
      prepare: async (h, refs) => {
        await fs.writeFile(h.prHeadFile, `${refs.pr.headRefOid}\n`, 'utf8');
        await writeThreadState(h.threadResponseFile, {
          __typename: 'PullRequestReviewThread',
          id: refs.thread.id,
          isResolved: false,
          isOutdated: true,
          comments: {
            nodes: [
              {
                id: refs.thread.lastCommentId,
                createdAt: refs.thread.lastCommentCreatedAt,
                updatedAt: refs.thread.lastCommentUpdatedAt,
              },
            ],
          },
        });
      },
    },
    {
      name: 'review_thread_updated',
      prepare: async (h, refs) => {
        await fs.writeFile(h.prHeadFile, `${refs.pr.headRefOid}\n`, 'utf8');
        await writeThreadState(h.threadResponseFile, {
          __typename: 'PullRequestReviewThread',
          id: refs.thread.id,
          isResolved: false,
          isOutdated: false,
          comments: {
            nodes: [
              {
                id: refs.thread.lastCommentId,
                createdAt: refs.thread.lastCommentCreatedAt,
                updatedAt: '2026-03-14T02:06:00Z',
              },
            ],
          },
        });
      },
    },
  ];

  for (const direct of [true, false]) {
    for (const scenario of cases) {
      await t.test(`${direct ? 'direct' : 'digest'}:${scenario.name}`, async () => {
        const { harness, receipt } = await runFreshnessCase({
          prefix: `agentic-review-fix-thread-${direct ? 'direct' : 'digest'}-${scenario.name}-`,
          taskId: `${direct ? 'direct' : 'digest'}_${scenario.name}`,
          refs: buildThreadRefs('1111111111111111111111111111111111111111'),
          direct,
          prepare: scenario.prepare,
        });
        assertSuperseded(receipt, scenario.name);
        assert.equal(await readCount(harness.countFile), 0);
      });
    }
  }
});

test('same-head actionable comment stale causes supersede before Codex runs', async (t) => {
  const cases = [
    { name: 'issue_comment_missing', envExtra: { GH_FAIL_STAGE: 'comment_missing' } },
    { name: 'issue_comment_edited', body: 'CI failing: lint broke after latest rerun' },
    { name: 'issue_comment_no_longer_actionable', body: 'Looks good to me, thanks!' },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const { harness, receipt } = await runFreshnessCase({
        prefix: `agentic-review-fix-comment-${scenario.name}-`,
        taskId: scenario.name,
        refs: buildCommentRefs('3333333333333333333333333333333333333333'),
        direct: false,
        envExtra: scenario.envExtra || {},
        prepare: async (h, refs) => {
          await fs.writeFile(h.prHeadFile, `${refs.pr.headRefOid}\n`, 'utf8');
          if (!scenario.envExtra) {
            await writeCommentState(h.commentResponseFile, {
              id: refs.comment.id,
              body: scenario.body,
              updated_at: refs.comment.updatedAt,
            });
          }
        },
      });
      assertSuperseded(receipt, scenario.name);
      assert.equal(await readCount(harness.countFile), 0);
    });
  }
});

test('GH freshness lookup failure stays fail-open, records warning evidence, and does not supersede', async () => {
  const { harness, receipt } = await runFreshnessCase({
    prefix: 'agentic-review-fix-gh-warning-',
    taskId: 'gh_warning',
    refs: buildThreadRefs('4444444444444444444444444444444444444444'),
    envExtra: { GH_FAIL_STAGE: 'pr_head' },
  });
  assert.equal(receipt.outcome, 'done');
  assert.equal(receipt.receiptExtra?.runtimeGuard?.reviewFixFreshness?.status, 'warning');
  assert.equal(receipt.receiptExtra?.runtimeGuard?.reviewFixFreshness?.reasonCode, 'freshness_lookup_failed');
  assert.equal(await readCount(harness.countFile), 1);
});

test('stale review-fix digest supersedes before fast-path side effects', async () => {
  const { harness, receipt } = await runFreshnessCase({
    prefix: 'agentic-review-fix-fastpath-stale-',
    taskId: 'stale_fastpath',
    refs: buildThreadRefs('6666666666666666666666666666666666666666'),
    direct: false,
    envExtra: {
      AGENTIC_AUTOPILOT_DIGEST_FASTPATH: '1',
      AGENTIC_AUTOPILOT_DIGEST_FASTPATH_ALLOWLIST: 'REVIEW_ACTION_REQUIRED:*',
    },
    prepare: async (h) => {
      await fs.writeFile(h.prHeadFile, '7777777777777777777777777777777777777777\n', 'utf8');
    },
  });
  assertSuperseded(receipt, 'pr_head_moved');
  assert.equal(await readCount(harness.countFile), 0);
});

test('stale review-fix digest supersedes before Opus consult side effects', async () => {
  const { harness, receipt } = await runFreshnessCase({
    prefix: 'agentic-review-fix-opus-stale-',
    taskId: 'stale_opus',
    refs: buildThreadRefs('8888888888888888888888888888888888888888'),
    direct: false,
    includeOpusConsult: true,
    envExtra: {
      AGENTIC_OPUS_CONSULT_MODE: 'advisory',
      AGENTIC_AUTOPILOT_OPUS_GATE: '1',
      AGENTIC_AUTOPILOT_OPUS_POST_REVIEW: '0',
      AGENTIC_AUTOPILOT_OPUS_CONSULT_AGENT: 'opus-consult',
      AGENTIC_AUTOPILOT_OPUS_GATE_KINDS: 'ORCHESTRATOR_UPDATE',
      AGENTIC_AUTOPILOT_OPUS_GATE_TIMEOUT_MS: '1000',
      AGENTIC_OPUS_TIMEOUT_MS: '1000',
      AGENTIC_OPUS_MAX_RETRIES: '0',
    },
    prepare: async (h) => {
      await fs.writeFile(h.prHeadFile, '9999999999999999999999999999999999999999\n', 'utf8');
    },
  });
  assertSuperseded(receipt, 'pr_head_moved');
  assert.equal(await readCount(harness.countFile), 0);
  assert.equal(await countPendingConsultRequests(harness.busRoot), 0);
});

test('pending blocked-recovery replay preserves freshness metadata and supersedes stale work before Codex runs', async () => {
  const harness = await setupReviewFixHarness('agentic-review-fix-pending-replay-');
  const refs = buildThreadRefs('5555555555555555555555555555555555555555');
  const recoveryPlan = planAutopilotBlockedRecovery({
    isAutopilot: true,
    agentName: 'daddy-autopilot',
    openedMeta: {
      id: 'observer_task_1',
      title: 'observer review-fix source',
      priority: 'P1',
      from: 'observer:pr',
      signals: { kind: 'REVIEW_ACTION_REQUIRED', phase: 'review-fix', rootId: 'PR121', notifyOrchestrator: false },
      references: refs,
    },
    outcome: 'blocked',
    note: 'blocked on stale observer work',
    receiptExtra: { details: { reasonCode: 'blocked' } },
  });
  assert.equal(recoveryPlan?.status, 'queue');

  const pendingDir = path.join(harness.busRoot, 'state', 'autopilot-blocked-recovery', 'daddy-autopilot');
  await fs.mkdir(pendingDir, { recursive: true });
  await fs.writeFile(
    path.join(pendingDir, `${recoveryPlan.taskId}.json`),
    JSON.stringify({
      updatedAt: new Date().toISOString(),
      recoveryKey: recoveryPlan.recoveryKey,
      taskId: recoveryPlan.taskId,
      meta: recoveryPlan.taskMeta,
      body: recoveryPlan.taskBody,
    }, null, 2),
    'utf8',
  );

  await fs.writeFile(harness.prHeadFile, `${refs.pr.headRefOid}\n`, 'utf8');
  await writeThreadState(harness.threadResponseFile, {
    __typename: 'PullRequestReviewThread',
    id: refs.thread.id,
    isResolved: true,
    isOutdated: false,
    comments: {
      nodes: [
        {
          id: refs.thread.lastCommentId,
          createdAt: refs.thread.lastCommentCreatedAt,
          updatedAt: refs.thread.lastCommentUpdatedAt,
        },
      ],
    },
  });

  const run = await runWorker(harness);
  assert.equal(run.code, 0, run.stderr || run.stdout);

  const receipt = await readReceipt(harness.busRoot, recoveryPlan.taskId);
  assertSuperseded(receipt, 'review_thread_resolved');
  assert.equal(await readCount(harness.countFile), 0);
});
