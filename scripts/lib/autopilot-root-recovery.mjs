import { safeExecText } from './safe-exec.mjs';
import { safeIdToken } from './agentbus.mjs';

export const AUTOPILOT_BLOCKED_RECOVERY_MAX_ATTEMPTS = 3;
export const AUTOPILOT_PR_HEAD_LOOKUP_TIMEOUT_MS = 5_000;

const NON_TERMINAL_AUTOPILOT_RECOVERY_REASON_CODES = new Set([
  'decomposition_required',
  'delegate_required',
  'delegated_completion_missing',
  'review_lifecycle_incomplete',
  'tiny_fix_justification_missing',
  'tiny_fix_threshold_exceeded',
]);

function readStringField(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeShaCandidate(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  return /^[0-9a-f]{7,40}$/i.test(raw) ? raw.toLowerCase() : '';
}

function readPositiveInteger(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 ? value : null;
  }
  const raw = readStringField(value);
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function readAutopilotRecoveryReasonCode(openedMeta, receiptExtra) {
  return (
    readStringField(receiptExtra?.details?.reasonCode) ||
    readStringField(receiptExtra?.reasonCode) ||
    readStringField(receiptExtra?.runtimeGuard?.delegationGate?.reasonCode) ||
    readStringField(receiptExtra?.runtimeGuard?.selfReviewGate?.reasonCode) ||
    readStringField(openedMeta?.references?.autopilotRecovery?.reasonCode) ||
    'blocked'
  );
}

function readAutopilotRecoveryMaxAttempts(reasonCode) {
  return NON_TERMINAL_AUTOPILOT_RECOVERY_REASON_CODES.has(reasonCode)
    ? null
    : AUTOPILOT_BLOCKED_RECOVERY_MAX_ATTEMPTS;
}

function buildAutopilotRecoveryInstruction(reasonCode) {
  switch (reasonCode) {
    case 'decomposition_required':
      return 'Dispatch at least one EXECUTE followUp for this multi-slice root now, or make the closure pure review-only.\n';
    case 'delegate_required':
    case 'tiny_fix_justification_missing':
    case 'tiny_fix_threshold_exceeded':
      return 'Do not close this root with autopilot-owned source changes. Delegate the work now or reduce it to a valid tiny fix with explicit justification.\n';
    case 'delegated_completion_missing':
      return 'Do not close this root done yet. Wait for delegated EXECUTE completion evidence and then continue the controller flow.\n';
    case 'review_lifecycle_incomplete':
      return 'Run the required built-in review to completion before closing this root.\n';
    default:
      return 'Resolve the blocker, dispatch follow-ups if needed, and continue the root instead of stopping.\n';
  }
}

function readObserverPrNumber(taskMeta) {
  if (readStringField(taskMeta?.references?.sourceAgent) !== 'observer:pr') return null;
  const raw =
    taskMeta?.references?.sourceReferences?.pr?.number ??
    taskMeta?.references?.sourceReferences?.prNumber ??
    null;
  return readPositiveInteger(raw);
}

function normalizePrRootId(value) {
  const raw = readStringField(value);
  if (!raw) return '';
  return raw.toUpperCase();
}

export function readIncomingPrHeadSha({ cwd, prNumber, timeoutMs = AUTOPILOT_PR_HEAD_LOOKUP_TIMEOUT_MS }) {
  const normalizedPrNumber = readPositiveInteger(prNumber);
  if (!normalizedPrNumber) return '';
  return normalizeShaCandidate(
    safeExecText('gh', ['pr', 'view', String(normalizedPrNumber), '--json', 'headRefOid', '--jq', '.headRefOid'], {
      cwd,
      timeoutMs,
    }) || '',
  );
}

export function shouldAllowAutopilotDirtyCrossRootReviewFix({
  isAutopilot,
  taskKind,
  taskMeta,
  cwd,
  incomingRootId,
  currentHeadSha,
  prHeadLookupTimeoutMs = AUTOPILOT_PR_HEAD_LOOKUP_TIMEOUT_MS,
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
  const prHeadSha = readIncomingPrHeadSha({ cwd, prNumber, timeoutMs: prHeadLookupTimeoutMs });
  if (!prHeadSha || prHeadSha !== currentHead) return null;
  return { prNumber, prHeadSha };
}

export function planAutopilotBlockedRecovery({ isAutopilot, agentName, openedMeta, outcome, note, receiptExtra }) {
  if (!isAutopilot) return null;
  if (String(outcome || '').trim().toLowerCase() !== 'blocked') return null;
  const rootId = readStringField(openedMeta?.signals?.rootId) || readStringField(openedMeta?.id) || '';
  if (!rootId) return null;
  const parentId = readStringField(openedMeta?.id) || rootId;
  const sourceTaskId = readStringField(openedMeta?.references?.autopilotRecoverySourceTaskId) || parentId;
  const sourceAgent =
    readStringField(openedMeta?.references?.sourceAgent) ||
    (readStringField(openedMeta?.from) === 'observer:pr' ? 'observer:pr' : '');
  const sourceReferences =
    openedMeta?.references?.sourceReferences &&
    typeof openedMeta.references.sourceReferences === 'object' &&
    !Array.isArray(openedMeta.references.sourceReferences)
      ? openedMeta.references.sourceReferences
      : sourceAgent === 'observer:pr' && openedMeta?.references && typeof openedMeta.references === 'object' && !Array.isArray(openedMeta.references)
        ? openedMeta.references
        : null;
  const previousAttemptRaw = Number(openedMeta?.references?.autopilotRecovery?.attempt);
  const previousAttempt =
    Number.isFinite(previousAttemptRaw) && previousAttemptRaw >= 0 ? Math.floor(previousAttemptRaw) : 0;
  const nextAttempt = previousAttempt + 1;
  const recoveryKey = `autopilot_recovery__${sourceTaskId}__${nextAttempt}`;
  const reasonCode = readAutopilotRecoveryReasonCode(openedMeta, receiptExtra);
  const maxAttempts = readAutopilotRecoveryMaxAttempts(reasonCode);
  const recoveryFields = {
    recoveryKey,
    maxAttempts,
    reasonCode,
    rootId,
    parentId,
    sourceTaskId,
  };
  if (maxAttempts !== null && nextAttempt > maxAttempts) {
    return {
      status: 'exhausted',
      reason: 'attempts_exhausted',
      ...recoveryFields,
      attempt: previousAttempt,
    };
  }
  const taskId = safeIdToken(recoveryKey);
  const body =
    `Autopilot blocked on the current root and must resolve it before closure.\n\n` +
    `Blocked task: ${parentId}\n` +
    `Root: ${rootId}\n` +
    `Attempt: ${nextAttempt}/${maxAttempts ?? 'auto'}\n` +
    `Reason: ${reasonCode}\n` +
    `Note: ${String(note || '').trim() || 'blocked'}\n\n` +
    buildAutopilotRecoveryInstruction(reasonCode);
  return {
    status: 'queue',
    reason: 'queued',
    ...recoveryFields,
    taskId,
    attempt: nextAttempt,
    taskMeta: {
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
        ...(sourceAgent ? { sourceAgent } : {}),
        ...(sourceReferences ? { sourceReferences } : {}),
        autopilotRecoverySourceTaskId: sourceTaskId,
        autopilotRecovery: {
          recoveryKey,
          attempt: nextAttempt,
          maxAttempts,
          reasonCode,
        },
      },
    },
    taskBody: body,
  };
}
