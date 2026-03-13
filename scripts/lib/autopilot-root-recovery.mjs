import childProcess from 'node:child_process';

export const AUTOPILOT_BLOCKED_RECOVERY_MAX_ATTEMPTS = 3;

function readStringField(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function safeExecText(cmd, args, { cwd }) {
  try {
    const raw = childProcess.execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return String(raw ?? '').trim() || null;
  } catch {
    return null;
  }
}

function normalizeShaCandidate(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  return /^[0-9a-f]{7,40}$/i.test(raw) ? raw.toLowerCase() : '';
}

function readObserverPrNumber(taskMeta) {
  if (readStringField(taskMeta?.references?.sourceAgent) !== 'observer:pr') return null;
  const raw =
    taskMeta?.references?.sourceReferences?.pr?.number ??
    taskMeta?.references?.sourceReferences?.prNumber ??
    null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.floor(value);
}

function normalizePrRootId(value) {
  const raw = readStringField(value);
  if (!raw) return '';
  return raw.toUpperCase();
}

function readIncomingPrHeadSha({ cwd, prNumber }) {
  if (!Number.isFinite(Number(prNumber)) || Number(prNumber) <= 0) return '';
  return normalizeShaCandidate(
    safeExecText('gh', ['pr', 'view', String(prNumber), '--json', 'headRefOid', '--jq', '.headRefOid'], { cwd }) || '',
  );
}

export function shouldAllowAutopilotDirtyCrossRootReviewFix({
  isAutopilot,
  taskKind,
  taskMeta,
  cwd,
  incomingRootId,
  currentHeadSha,
}) {
  if (!isAutopilot) return null;
  if (String(taskKind || '').trim().toUpperCase() !== 'ORCHESTRATOR_UPDATE') return null;
  if (readStringField(taskMeta?.signals?.phase) !== 'review-fix') return null;
  const prNumber = readObserverPrNumber(taskMeta);
  if (!prNumber) return null;
  const expectedRootId = normalizePrRootId(`PR${prNumber}`);
  const normalizedIncomingRootId = normalizePrRootId(incomingRootId);
  if (normalizedIncomingRootId && normalizedIncomingRootId !== expectedRootId) return null;
  const currentHead = normalizeShaCandidate(currentHeadSha);
  if (!currentHead) return null;
  const prHeadSha = readIncomingPrHeadSha({ cwd, prNumber });
  if (!prHeadSha || prHeadSha !== currentHead) return null;
  return { prNumber, prHeadSha };
}

export function buildAutopilotBlockedRecoveryTask({ agentName, openedMeta, outcome, note, receiptExtra, makeId }) {
  if (agentName !== 'daddy-autopilot') {
    return {
      queued: false,
      reason: 'not_autopilot',
      taskId: null,
      attempt: 0,
      maxAttempts: AUTOPILOT_BLOCKED_RECOVERY_MAX_ATTEMPTS,
      task: null,
    };
  }
  if (String(outcome || '').trim().toLowerCase() !== 'blocked') {
    return {
      queued: false,
      reason: 'outcome_not_blocked',
      taskId: null,
      attempt: 0,
      maxAttempts: AUTOPILOT_BLOCKED_RECOVERY_MAX_ATTEMPTS,
      task: null,
    };
  }
  const rootId = readStringField(openedMeta?.signals?.rootId) || readStringField(openedMeta?.id) || '';
  if (!rootId) {
    return {
      queued: false,
      reason: 'missing_root',
      taskId: null,
      attempt: 0,
      maxAttempts: AUTOPILOT_BLOCKED_RECOVERY_MAX_ATTEMPTS,
      task: null,
    };
  }
  const parentId = readStringField(openedMeta?.id) || rootId;
  const previousAttemptRaw = Number(openedMeta?.references?.autopilotRecovery?.attempt);
  const previousAttempt =
    Number.isFinite(previousAttemptRaw) && previousAttemptRaw >= 0 ? Math.floor(previousAttemptRaw) : 0;
  const nextAttempt = previousAttempt + 1;
  if (nextAttempt > AUTOPILOT_BLOCKED_RECOVERY_MAX_ATTEMPTS) {
    return {
      queued: false,
      reason: 'attempts_exhausted',
      taskId: null,
      attempt: previousAttempt,
      maxAttempts: AUTOPILOT_BLOCKED_RECOVERY_MAX_ATTEMPTS,
      task: null,
    };
  }
  const reasonCode =
    readStringField(receiptExtra?.details?.reasonCode) ||
    readStringField(receiptExtra?.reasonCode) ||
    'blocked';
  const taskId = makeId('msg');
  const body =
    `Autopilot blocked on the current root and must resolve it before closure.\n\n` +
    `Blocked task: ${parentId}\n` +
    `Root: ${rootId}\n` +
    `Attempt: ${nextAttempt}/${AUTOPILOT_BLOCKED_RECOVERY_MAX_ATTEMPTS}\n` +
    `Reason: ${reasonCode}\n` +
    `Note: ${String(note || '').trim() || 'blocked'}\n\n` +
    `Resolve the blocker, dispatch follow-ups if needed, and continue the root instead of stopping.\n`;
  return {
    queued: true,
    reason: 'queued',
    taskId,
    attempt: nextAttempt,
    maxAttempts: AUTOPILOT_BLOCKED_RECOVERY_MAX_ATTEMPTS,
    task: {
      meta: {
        id: taskId,
        to: [agentName],
        from: agentName,
        priority: readStringField(openedMeta?.priority) || 'P1',
        title: `AUTOPILOT_BLOCKED_RECOVERY: ${readStringField(openedMeta?.title) || rootId}`,
        signals: {
          kind: 'ORCHESTRATOR_UPDATE',
          sourceKind: 'AUTOPILOT_BLOCKED_RECOVERY',
          phase: 'blocked-recovery',
          rootId,
          parentId,
          smoke: Boolean(openedMeta?.signals?.smoke),
          notifyOrchestrator: false,
        },
        references: {
          parentTaskId: parentId,
          parentRootId: rootId,
          autopilotRecovery: {
            attempt: nextAttempt,
            maxAttempts: AUTOPILOT_BLOCKED_RECOVERY_MAX_ATTEMPTS,
            reasonCode,
          },
        },
      },
      body,
    },
  };
}
