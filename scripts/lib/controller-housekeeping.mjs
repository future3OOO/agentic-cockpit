import { promises as fs } from 'node:fs';
import path from 'node:path';

import { safeIdToken } from './agentbus.mjs';

function readStringField(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneJsonSafe(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function normalizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((entry) => isPlainObject(entry))
    .slice(-5);
}

function buildHistoryEntry(state) {
  return {
    generation: Number(state?.generation) || 1,
    taskId: readStringField(state?.taskId),
    status: readStringField(state?.status),
    reasonCode: readStringField(state?.reasonCode),
    queuedAt: readStringField(state?.queuedAt),
    startedAt: readStringField(state?.startedAt),
    doneAt: readStringField(state?.doneAt),
    failedAt: readStringField(state?.failedAt),
  };
}

function readSuspendedSourceReferences(meta) {
  return isPlainObject(meta?.references?.sourceReferences) ? cloneJsonSafe(meta.references.sourceReferences) : null;
}

function readSuspendedSourceAgent(meta) {
  return readStringField(meta?.references?.sourceAgent);
}

function buildSuspendedRootRecord({ openedMeta, openedBody }) {
  const originalTaskId = readStringField(openedMeta?.id);
  return {
    originalTaskId,
    originalRootId: readStringField(openedMeta?.signals?.rootId) || originalTaskId,
    originalTitle: readStringField(openedMeta?.title),
    originalTo: Array.isArray(openedMeta?.to) ? openedMeta.to.map(readStringField).filter(Boolean) : [],
    originalFrom: readStringField(openedMeta?.from),
    originalKind: readStringField(openedMeta?.signals?.kind),
    originalPhase: readStringField(openedMeta?.signals?.phase),
    originalParentId: readStringField(openedMeta?.signals?.parentId),
    originalMeta: cloneJsonSafe(openedMeta),
    originalBody: typeof openedBody === 'string' ? openedBody : '',
    sourceAgent: readSuspendedSourceAgent(openedMeta),
    sourceReferences: readSuspendedSourceReferences(openedMeta),
    blockedAt: new Date().toISOString(),
    replayStatus: 'pending',
    replayTaskId: '',
    replayedAt: '',
    closedReceiptPath: '',
    closedProcessedPath: '',
  };
}

async function writeJsonAtomic(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp.${Math.random().toString(16).slice(2)}`;
  await fs.writeFile(tempPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  await fs.rename(tempPath, filePath);
}

export function getControllerHousekeepingStateDir({ busRoot, agentName }) {
  return path.join(busRoot, 'state', 'autopilot-controller-housekeeping', safeIdToken(agentName));
}

export function getControllerHousekeepingStatePath({ busRoot, agentName, fingerprint }) {
  return path.join(getControllerHousekeepingStateDir({ busRoot, agentName }), `${safeIdToken(fingerprint)}.json`);
}

export function buildControllerHousekeepingRootId({ agentName, fingerprint }) {
  return `CONTROLLER_HOUSEKEEPING::${agentName}::${fingerprint}`;
}

export function buildControllerHousekeepingTaskId({ agentName, fingerprint, generation }) {
  const base = `controller_housekeeping__${safeIdToken(agentName)}__${safeIdToken(fingerprint)}`;
  return Number(generation) > 1 ? `${base}__g${Number(generation)}` : base;
}

export function buildControllerHousekeepingReplayTaskId({ originalTaskId, fingerprint, generation }) {
  return `controller_resume__${safeIdToken(originalTaskId)}__${safeIdToken(fingerprint)}__g${Number(generation) || 1}`;
}

export async function readControllerHousekeepingState({ busRoot, agentName, fingerprint }) {
  const statePath = getControllerHousekeepingStatePath({ busRoot, agentName, fingerprint });
  try {
    const payload = JSON.parse(await fs.readFile(statePath, 'utf8'));
    return { statePath, payload };
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

export async function writeControllerHousekeepingState({ busRoot, agentName, fingerprint, payload }) {
  const statePath = getControllerHousekeepingStatePath({ busRoot, agentName, fingerprint });
  await writeJsonAtomic(statePath, payload);
  return { statePath, payload };
}

export async function stageControllerHousekeepingSuspension({
  busRoot,
  agentName,
  fingerprint,
  branch,
  headSha,
  repoCommonGitDir,
  recoverableStatusPorcelain,
  openedMeta,
  openedBody,
}) {
  const existingState = await readControllerHousekeepingState({ busRoot, agentName, fingerprint });
  const existing = existingState?.payload || null;
  if (existing && !isPlainObject(existing)) {
    throw new Error('controller-housekeeping state corrupt');
  }

  if (readStringField(existing?.status) === 'needs_review') {
    return {
      action: 'unchanged',
      statePath: existingState?.statePath || getControllerHousekeepingStatePath({ busRoot, agentName, fingerprint }),
      payload: existing,
      syntheticRootId: buildControllerHousekeepingRootId({ agentName, fingerprint }),
    };
  }

  const suspendedRoot = buildSuspendedRootRecord({ openedMeta, openedBody });
  const previousGeneration = Number(existing?.generation) || 0;
  const reuseExistingGeneration = readStringField(existing?.status) === 'queued' || readStringField(existing?.status) === 'running';
  const generation = reuseExistingGeneration ? previousGeneration || 1 : previousGeneration + 1 || 1;
  const taskId = buildControllerHousekeepingTaskId({ agentName, fingerprint, generation });
  const syntheticRootId = buildControllerHousekeepingRootId({ agentName, fingerprint });
  const history = existing && readStringField(existing?.status) === 'done'
    ? [...normalizeHistory(existing?.history), buildHistoryEntry(existing)].slice(-5)
    : normalizeHistory(existing?.history);
  const currentSuspendedRoots = reuseExistingGeneration && Array.isArray(existing?.suspendedRoots)
    ? existing.suspendedRoots.map((entry) => cloneJsonSafe(entry))
    : [];
  const alreadyPresent = currentSuspendedRoots.some(
    (entry) => readStringField(entry?.originalTaskId) === suspendedRoot.originalTaskId,
  );
  if (!alreadyPresent) currentSuspendedRoots.push(suspendedRoot);
  const firstSuspended = currentSuspendedRoots[0] || suspendedRoot;

  const next = {
    fingerprint,
    generation,
    agentName,
    branch: readStringField(branch),
    headSha: readStringField(headSha),
    repoCommonGitDir: readStringField(repoCommonGitDir),
    taskId,
    status: reuseExistingGeneration ? readStringField(existing?.status) || 'queued' : 'queued',
    queuedAt: reuseExistingGeneration ? readStringField(existing?.queuedAt) || new Date().toISOString() : new Date().toISOString(),
    startedAt: reuseExistingGeneration ? readStringField(existing?.startedAt) : '',
    doneAt: '',
    failedAt: '',
    reasonCode: '',
    recoverableStatusPorcelain: String(recoverableStatusPorcelain || '').trim(),
    suspendedRoots: currentSuspendedRoots,
    history,
  };

  const written = await writeControllerHousekeepingState({ busRoot, agentName, fingerprint, payload: next });
  const shouldQueueTask = !reuseExistingGeneration;
  return {
    action: shouldQueueTask ? 'queue' : 'reuse',
    statePath: written.statePath,
    payload: written.payload,
    syntheticRootId,
    taskMeta: shouldQueueTask
      ? buildControllerHousekeepingTaskMeta({
          agentName,
          taskId,
          fingerprint,
          generation,
          syntheticRootId,
          firstSuspended,
          openedMeta,
          statePath: written.statePath,
        })
      : null,
    taskBody: shouldQueueTask
      ? buildControllerHousekeepingTaskBody({
          fingerprint,
          generation,
          firstSuspended,
          recoverableStatusPorcelain,
        })
      : '',
  };
}

function buildControllerHousekeepingTaskMeta({
  agentName,
  taskId,
  fingerprint,
  generation,
  syntheticRootId,
  firstSuspended,
  openedMeta,
  statePath,
}) {
  return {
    id: taskId,
    to: [agentName],
    from: agentName,
    priority: readStringField(openedMeta?.priority) || 'P1',
    title: `CONTROLLER_HOUSEKEEPING: ${readStringField(firstSuspended?.originalTitle) || fingerprint}`,
    signals: {
      kind: 'ORCHESTRATOR_UPDATE',
      sourceKind: 'AUTOPILOT_CONTROLLER_HOUSEKEEPING',
      phase: 'controller-housekeeping',
      rootId: syntheticRootId,
      parentId: readStringField(firstSuspended?.originalTaskId) || readStringField(openedMeta?.id),
      smoke: Boolean(openedMeta?.signals?.smoke),
      notifyOrchestrator: false,
    },
    references: {
      parentTaskId: readStringField(firstSuspended?.originalTaskId) || readStringField(openedMeta?.id),
      parentRootId: readStringField(firstSuspended?.originalRootId),
      controllerHousekeeping: {
        fingerprint,
        generation,
        statePath,
      },
    },
  };
}

function buildControllerHousekeepingTaskBody({ fingerprint, generation, firstSuspended, recoverableStatusPorcelain }) {
  return (
    `Runtime-owned controller housekeeping for autopilot recoverable dirt.\n\n` +
    `Fingerprint: ${fingerprint}\n` +
    `Generation: ${generation}\n` +
    `Blocked task: ${readStringField(firstSuspended?.originalTaskId) || 'unknown'}\n` +
    `Blocked root: ${readStringField(firstSuspended?.originalRootId) || 'unknown'}\n\n` +
    `Recoverable status lines:\n${String(recoverableStatusPorcelain || '').trim() || '(none)'}\n`
  );
}

export async function patchControllerHousekeepingSuspendedRootAudit({
  busRoot,
  agentName,
  fingerprint,
  originalTaskId,
  closedReceiptPath,
  closedProcessedPath,
}) {
  const existing = await readControllerHousekeepingState({ busRoot, agentName, fingerprint });
  if (!existing?.payload || !Array.isArray(existing.payload.suspendedRoots)) return existing;
  const next = cloneJsonSafe(existing.payload);
  next.suspendedRoots = next.suspendedRoots.map((entry) => {
    if (readStringField(entry?.originalTaskId) !== readStringField(originalTaskId)) return entry;
    return {
      ...entry,
      closedReceiptPath: readStringField(closedReceiptPath),
      closedProcessedPath: readStringField(closedProcessedPath),
    };
  });
  return writeControllerHousekeepingState({ busRoot, agentName, fingerprint, payload: next });
}

export async function updateControllerHousekeepingState({
  busRoot,
  agentName,
  fingerprint,
  mutate,
}) {
  const existing = await readControllerHousekeepingState({ busRoot, agentName, fingerprint });
  const current = existing?.payload;
  if (!current || !isPlainObject(current)) {
    throw new Error('controller-housekeeping state missing or corrupt');
  }
  const next = mutate(cloneJsonSafe(current));
  return writeControllerHousekeepingState({ busRoot, agentName, fingerprint, payload: next });
}

export function listPendingControllerHousekeepingSuspensions(statePayload) {
  return Array.isArray(statePayload?.suspendedRoots)
    ? statePayload.suspendedRoots.filter((entry) => readStringField(entry?.replayStatus) !== 'replayed')
    : [];
}

export function buildControllerHousekeepingReplayTask({ suspendedRoot, fingerprint, generation }) {
  const originalMeta = isPlainObject(suspendedRoot?.originalMeta) ? cloneJsonSafe(suspendedRoot.originalMeta) : {};
  const originalReferences = isPlainObject(originalMeta.references) ? cloneJsonSafe(originalMeta.references) : {};
  const replayTaskId = buildControllerHousekeepingReplayTaskId({
    originalTaskId: readStringField(suspendedRoot?.originalTaskId),
    fingerprint,
    generation,
  });
  return {
    id: replayTaskId,
    meta: {
      ...originalMeta,
      id: replayTaskId,
      to: Array.isArray(originalMeta.to) ? originalMeta.to : [],
      from: readStringField(originalMeta.from),
      title: readStringField(originalMeta.title),
      references: {
        ...originalReferences,
        ...(readStringField(suspendedRoot?.sourceAgent) ? { sourceAgent: readStringField(suspendedRoot.sourceAgent) } : {}),
        ...(isPlainObject(suspendedRoot?.sourceReferences) ? { sourceReferences: cloneJsonSafe(suspendedRoot.sourceReferences) } : {}),
        controllerHousekeeping: {
          fingerprint,
          generation,
          resumedFromTaskId: readStringField(suspendedRoot?.originalTaskId),
        },
      },
    },
    body: typeof suspendedRoot?.originalBody === 'string' ? suspendedRoot.originalBody : '',
  };
}
