import {
  buildPreflightPlanHash,
  buildPreflightTaskFingerprint,
  captureTrackedSnapshot,
  validatePreflightExecutionUnlock,
} from './worker-preflight.mjs';
export { readNumstatRecordsForCommitOrWorkingTree } from './worker-preflight-working-tree.mjs';

export function firstPreflightReasonCode(errors) {
  const list = Array.isArray(errors) ? errors.map((value) => String(value || '').trim()).filter(Boolean) : [];
  if (list.length === 0) return '';
  const first = list[0];
  const prefix = first.split(':', 1)[0];
  return prefix || first;
}

export function shouldRequireWriterPreflight({ isAutopilot, taskKind, taskMeta }) {
  const normalizedKind = String(taskKind || '').trim().toUpperCase();
  if (normalizedKind === 'EXECUTE') return true;
  if (!isAutopilot) return false;
  const phase = String(taskMeta?.signals?.phase || '').trim().toLowerCase();
  return phase === 'execute';
}

export function normalizePersistedTrackedSnapshot(value) {
  return value && typeof value === 'object' && typeof value.hash === 'string' && Array.isArray(value.statusLines)
    ? {
        hash: value.hash,
        statusLines: value.statusLines.slice(),
      }
    : null;
}

function emptyApprovedPreflightReuse({ retryReason = '', gateEvidence = null } = {}) {
  return {
    approvedPlan: null,
    approvedPlanHash: '',
    approvedTaskFingerprint: '',
    approvedTrackedSnapshot: null,
    gateEvidence,
    retryReason,
  };
}

function buildCurrentTaskFingerprint({
  taskKind,
  taskPhase,
  taskTitle,
  taskBody,
  taskMeta,
  baseHead,
  workBranch,
}) {
  return buildPreflightTaskFingerprint({
    taskKind,
    taskPhase,
    taskTitle,
    taskBody,
    taskMeta,
    baseHead,
    workBranch,
  });
}

export async function reuseApprovedPreflightFromSession({
  repoRoot,
  approvedPlan,
  storedPlanHash = '',
  storedTaskFingerprint = '',
  storedTrackedSnapshot = null,
  taskKind,
  taskPhase,
  taskTitle,
  taskBody,
  taskMeta = null,
  baseHead,
  workBranch,
}) {
  const normalizedStoredHash = String(storedPlanHash || '').trim();
  const normalizedStoredTaskFingerprint = String(storedTaskFingerprint || '').trim();
  const normalizedTrackedSnapshot = normalizePersistedTrackedSnapshot(storedTrackedSnapshot);
  if (!approvedPlan) {
    return emptyApprovedPreflightReuse();
  }
  const currentPlanHash = buildPreflightPlanHash({
    taskKind,
    taskPhase,
    taskTitle,
    taskBody,
    baseHead,
    workBranch,
    preflightPlan: approvedPlan,
  });
  const currentTaskFingerprint = buildCurrentTaskFingerprint({
    taskKind,
    taskPhase,
    taskTitle,
    taskBody,
    taskMeta,
    baseHead,
    workBranch,
  });
  const canReuse = Boolean(
    normalizedStoredHash &&
      normalizedStoredTaskFingerprint &&
      normalizedTrackedSnapshot &&
      currentPlanHash === normalizedStoredHash &&
      currentTaskFingerprint === normalizedStoredTaskFingerprint,
  );
  if (!canReuse) {
    return emptyApprovedPreflightReuse({
      retryReason:
        normalizedStoredHash || normalizedStoredTaskFingerprint || normalizedTrackedSnapshot
          ? 'persisted preflight session state is stale or incomplete; rerun required'
          : '',
    });
  }
  const reuseValidation = await validatePreflightExecutionUnlock({
    repoRoot,
    approvedPlan,
    trackedSnapshot: normalizedTrackedSnapshot,
    baseRef: baseHead,
  });
  if (!reuseValidation.ok) {
    return emptyApprovedPreflightReuse({
      retryReason: reuseValidation.errors.join('; '),
    });
  }
  return {
    approvedPlan,
    approvedPlanHash: normalizedStoredHash,
    approvedTaskFingerprint: currentTaskFingerprint,
    approvedTrackedSnapshot: normalizedTrackedSnapshot,
    gateEvidence: {
      required: true,
      approved: true,
      noWritePass: reuseValidation.evidence?.noWritePass ?? true,
      planHash: normalizedStoredHash,
      driftDetected: false,
      reasonCode: null,
    },
    retryReason: '',
  };
}

export async function hydrateApprovedPreflightForTask({
  repoRoot,
  runtimePreflightRequired,
  seededApprovedPlan = null,
  seededPlanHash = '',
  seededTaskFingerprint = '',
  seededTrackedSnapshot = null,
  approvedPlan = null,
  approvedPlanHash = '',
  approvedTaskFingerprint = '',
  approvedTrackedSnapshot = null,
  taskKind,
  taskPhase,
  taskTitle,
  taskBody,
  taskMeta = null,
  baseHead,
  workBranch,
}) {
  let nextApprovedPlan = approvedPlan;
  let nextApprovedPlanHash = String(approvedPlanHash || '').trim();
  let nextApprovedTaskFingerprint = String(approvedTaskFingerprint || '').trim();
  let nextApprovedTrackedSnapshot = normalizePersistedTrackedSnapshot(approvedTrackedSnapshot);
  let retryReason = '';
  let gateEvidence = null;
  const currentTaskFingerprint = buildCurrentTaskFingerprint({
    taskKind,
    taskPhase,
    taskTitle,
    taskBody,
    taskMeta,
    baseHead,
    workBranch,
  });

  if (runtimePreflightRequired && nextApprovedPlan) {
    const currentTrackedSnapshot = nextApprovedTrackedSnapshot ? captureTrackedSnapshot({ cwd: repoRoot }) : null;
    const fingerprintMatches =
      Boolean(nextApprovedTaskFingerprint) &&
      nextApprovedTaskFingerprint === currentTaskFingerprint;
    const trackedSnapshotMatches =
      Boolean(nextApprovedTrackedSnapshot?.hash) &&
      Boolean(currentTrackedSnapshot?.hash) &&
      nextApprovedTrackedSnapshot.hash === currentTrackedSnapshot.hash;
    if (!fingerprintMatches || !trackedSnapshotMatches) {
      nextApprovedPlan = null;
      nextApprovedPlanHash = '';
      nextApprovedTaskFingerprint = '';
      nextApprovedTrackedSnapshot = null;
      retryReason = !fingerprintMatches
        ? 'approved preflight became stale after task packet drift; rerun required'
        : 'approved preflight became stale after tracked snapshot drift; rerun required';
    }
  }

  if (runtimePreflightRequired && !nextApprovedPlan && seededApprovedPlan) {
    const reusedPreflight = await reuseApprovedPreflightFromSession({
      repoRoot,
      approvedPlan: seededApprovedPlan,
      storedPlanHash: seededPlanHash,
      storedTaskFingerprint: seededTaskFingerprint,
      storedTrackedSnapshot: seededTrackedSnapshot,
      taskKind,
      taskPhase,
      taskTitle,
      taskBody,
      taskMeta,
      baseHead,
      workBranch,
    });
    nextApprovedPlan = reusedPreflight.approvedPlan;
    nextApprovedPlanHash = reusedPreflight.approvedPlanHash;
    nextApprovedTaskFingerprint = reusedPreflight.approvedTaskFingerprint;
    nextApprovedTrackedSnapshot = reusedPreflight.approvedTrackedSnapshot;
    gateEvidence = reusedPreflight.gateEvidence;
    if (reusedPreflight.retryReason) retryReason = reusedPreflight.retryReason;
  }

  return {
    currentTaskFingerprint,
    approvedPlan: nextApprovedPlan,
    approvedPlanHash: nextApprovedPlanHash,
    approvedTaskFingerprint: nextApprovedTaskFingerprint,
    approvedTrackedSnapshot: nextApprovedTrackedSnapshot,
    retryReason,
    gateEvidence,
  };
}
