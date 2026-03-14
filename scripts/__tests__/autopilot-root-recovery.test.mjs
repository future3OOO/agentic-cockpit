import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { safeIdToken } from '../lib/agentbus.mjs';
import {
  AUTOPILOT_BLOCKED_RECOVERY_MAX_ATTEMPTS,
  planAutopilotBlockedRecovery,
  shouldAllowAutopilotDirtyCrossRootReviewFix,
} from '../lib/autopilot-root-recovery.mjs';

test('planAutopilotBlockedRecovery returns a deterministic queued plan', () => {
  const plan = planAutopilotBlockedRecovery({
    isAutopilot: true,
    agentName: 'daddy-autopilot',
    openedMeta: {
      id: 't1',
      title: 'review root',
      priority: 'P1',
      signals: { rootId: 'PR121', smoke: false },
    },
    outcome: 'blocked',
    note: 'dirty root',
    receiptExtra: { details: { reasonCode: 'dirty_cross_root_transition' } },
  });
  assert.equal(plan?.status, 'queue');
  assert.equal(plan?.recoveryKey, 'autopilot_recovery__t1__1');
  assert.equal(plan?.taskId, 'autopilot_recovery__t1__1');
  assert.equal(plan?.attempt, 1);
  assert.equal(plan?.maxAttempts, AUTOPILOT_BLOCKED_RECOVERY_MAX_ATTEMPTS);
  assert.equal(plan?.reasonCode, 'dirty_cross_root_transition');
  assert.equal(plan?.taskMeta?.id, 'autopilot_recovery__t1__1');
  assert.equal(plan?.taskMeta?.references?.autopilotRecoverySourceTaskId, 't1');
  assert.equal(plan?.taskMeta?.references?.autopilotRecovery?.recoveryKey, 'autopilot_recovery__t1__1');
  assert.match(String(plan?.taskBody || ''), /Attempt: 1\/3/);
});

test('planAutopilotBlockedRecovery keeps the blocked task id as the recovery source key', () => {
  const plan = planAutopilotBlockedRecovery({
    isAutopilot: true,
    agentName: 'daddy-autopilot',
    openedMeta: {
      id: 't1',
      references: {
        parentTaskId: 'observer-parent',
      },
      signals: { rootId: 'PR121' },
    },
    outcome: 'blocked',
    note: 'dirty root',
    receiptExtra: { details: { reasonCode: 'dirty_cross_root_transition' } },
  });
  assert.equal(plan?.recoveryKey, 'autopilot_recovery__t1__1');
  assert.equal(plan?.taskMeta?.references?.autopilotRecoverySourceTaskId, 't1');
});

test('planAutopilotBlockedRecovery preserves observer source freshness metadata for replay', () => {
  const plan = planAutopilotBlockedRecovery({
    isAutopilot: true,
    agentName: 'daddy-autopilot',
    openedMeta: {
      id: 't1',
      from: 'daddy-orchestrator',
      references: {
        sourceAgent: 'observer:pr',
        sourceReferences: {
          pr: {
            owner: 'future3OOO',
            repo: 'agentic-cockpit',
            number: 121,
            headRefOid: '0123456789abcdef0123456789abcdef01234567',
            headRefName: 'slice/pr121',
          },
          thread: {
            id: 'THREAD_123',
            lastCommentId: 'COMMENT_456',
            lastCommentCreatedAt: '2026-03-14T02:00:00Z',
            lastCommentUpdatedAt: '2026-03-14T02:05:00Z',
          },
        },
      },
      signals: { rootId: 'PR121' },
    },
    outcome: 'blocked',
    note: 'still blocked',
    receiptExtra: { details: { reasonCode: 'blocked' } },
  });
  assert.equal(plan?.taskMeta?.references?.sourceAgent, 'observer:pr');
  assert.equal(
    plan?.taskMeta?.references?.sourceReferences?.pr?.headRefOid,
    '0123456789abcdef0123456789abcdef01234567',
  );
  assert.equal(plan?.taskMeta?.references?.sourceReferences?.thread?.lastCommentId, 'COMMENT_456');
  assert.equal(plan?.taskMeta?.references?.sourceReferences?.thread?.lastCommentUpdatedAt, '2026-03-14T02:05:00Z');
});

test('planAutopilotBlockedRecovery derives a safe task id from an unsafe recovery key', () => {
  const plan = planAutopilotBlockedRecovery({
    isAutopilot: true,
    agentName: 'daddy-autopilot',
    openedMeta: {
      id: 't1',
      references: {
        autopilotRecoverySourceTaskId: 't 1',
      },
      signals: { rootId: 'PR121' },
    },
    outcome: 'blocked',
    note: 'dirty root',
    receiptExtra: { details: { reasonCode: 'dirty_cross_root_transition' } },
  });
  assert.equal(plan?.recoveryKey, 'autopilot_recovery__t 1__1');
  assert.equal(plan?.taskId, safeIdToken('autopilot_recovery__t 1__1'));
  assert.equal(plan?.taskMeta?.id, safeIdToken('autopilot_recovery__t 1__1'));
  assert.equal(plan?.taskMeta?.references?.autopilotRecovery?.recoveryKey, 'autopilot_recovery__t 1__1');
});

test('planAutopilotBlockedRecovery returns exhausted once retries are spent', () => {
  const plan = planAutopilotBlockedRecovery({
    isAutopilot: true,
    agentName: 'daddy-autopilot',
    openedMeta: {
      id: 'autopilot_recovery__t1__3',
      references: {
        parentTaskId: 't1',
        autopilotRecoverySourceTaskId: 't1',
        autopilotRecovery: { attempt: 3, maxAttempts: 3, reasonCode: 'dirty_cross_root_transition' },
      },
      signals: { rootId: 'PR121' },
    },
    outcome: 'blocked',
    note: 'still blocked',
    receiptExtra: { details: { reasonCode: 'dirty_cross_root_transition' } },
  });
  assert.equal(plan?.status, 'exhausted');
  assert.equal(plan?.recoveryKey, 'autopilot_recovery__t1__4');
  assert.equal(plan?.attempt, 3);
  assert.equal(plan?.maxAttempts, AUTOPILOT_BLOCKED_RECOVERY_MAX_ATTEMPTS);
});

test('shouldAllowAutopilotDirtyCrossRootReviewFix rejects non-integer PR numbers', () => {
  const allowed = shouldAllowAutopilotDirtyCrossRootReviewFix({
    isAutopilot: true,
    taskKind: 'ORCHESTRATOR_UPDATE',
    taskMeta: {
      signals: { phase: 'review-fix' },
      references: {
        sourceAgent: 'observer:pr',
        sourceReferences: {
          pr: { number: 121.5 },
        },
      },
    },
    cwd: process.cwd(),
    incomingRootId: 'PR121',
    currentHeadSha: '0123456789abcdef0',
    prHeadLookupTimeoutMs: 50,
  });
  assert.equal(allowed, null);
});

test('shouldAllowAutopilotDirtyCrossRootReviewFix rejects scientific-notation PR numbers', () => {
  const allowed = shouldAllowAutopilotDirtyCrossRootReviewFix({
    isAutopilot: true,
    taskKind: 'ORCHESTRATOR_UPDATE',
    taskMeta: {
      signals: { phase: 'review-fix' },
      references: {
        sourceAgent: 'observer:pr',
        sourceReferences: {
          prNumber: '1e2',
        },
      },
    },
    cwd: process.cwd(),
    incomingRootId: 'PR100',
    currentHeadSha: '0123456789abcdef0',
    prHeadLookupTimeoutMs: 50,
  });
  assert.equal(allowed, null);
});

test('shouldAllowAutopilotDirtyCrossRootReviewFix fails closed when gh lookup stalls', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-root-recovery-timeout-'));
  const ghPath = path.join(tmp, 'gh');
  await fs.writeFile(
    ghPath,
    ['#!/usr/bin/env bash', 'set -euo pipefail', 'sleep 1', 'printf "deadbeef\\n"'].join('\n'),
    'utf8',
  );
  await fs.chmod(ghPath, 0o755);
  const cwd = path.join(tmp, 'repo');
  await fs.mkdir(cwd, { recursive: true });
  const originalPath = process.env.PATH || '';
  process.env.PATH = `${tmp}:${originalPath}`;
  try {
    const allowed = shouldAllowAutopilotDirtyCrossRootReviewFix({
      isAutopilot: true,
      taskKind: 'ORCHESTRATOR_UPDATE',
      taskMeta: {
        signals: { phase: 'review-fix' },
        references: {
          sourceAgent: 'observer:pr',
          sourceReferences: {
            pr: { number: 121 },
          },
        },
      },
      cwd,
      incomingRootId: 'PR121',
      currentHeadSha: 'deadbeef',
      prHeadLookupTimeoutMs: 50,
    });
    assert.equal(allowed, null);
  } finally {
    process.env.PATH = originalPath;
  }
});
