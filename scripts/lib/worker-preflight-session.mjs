import childProcess from 'node:child_process';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { parseNumstatRecords as parseModularityNumstatRecords, normalizeRepoPath } from './code-quality-modularity.mjs';
import { buildPreflightPlanHash, validatePreflightExecutionUnlock } from './worker-preflight.mjs';

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

export function readNumstatRecordsForCommitOrWorkingTree({
  cwd,
  commitSha = '',
  isCommitObjectMissingError,
  unreadableFileLineCount = 10_000,
}) {
  const readNumstat = (args, { ignoreMissingCommit = false } = {}) => {
    try {
      const raw = childProcess.execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return parseModularityNumstatRecords(raw);
    } catch (err) {
      if (ignoreMissingCommit && typeof isCommitObjectMissingError === 'function' && isCommitObjectMissingError(err)) {
        return [];
      }
      throw err;
    }
  };
  const commit = String(commitSha || '').trim();
  if (commit) {
    try {
      return readNumstat(['show', '--numstat', '--pretty=format:', commit], { ignoreMissingCommit: true });
    } catch (err) {
      if (!(typeof isCommitObjectMissingError === 'function' && isCommitObjectMissingError(err))) throw err;
      return [];
    }
  }
  let diffRecords;
  try {
    diffRecords = readNumstat(['diff', '--numstat', 'HEAD']);
  } catch {
    return [];
  }
  let untrackedRaw = '';
  try {
    untrackedRaw = childProcess.execFileSync(
      'git',
      ['ls-files', '--others', '--exclude-standard'],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch {
    return diffRecords;
  }
  const existing = new Set(diffRecords.map((record) => normalizeRepoPath(record.file)));
  const untrackedFiles = Array.from(
    new Set(
      String(untrackedRaw || '')
        .split(/\r?\n/)
        .map((line) => normalizeRepoPath(line))
        .filter(Boolean),
    ),
  );
  for (const file of untrackedFiles) {
    if (existing.has(file)) continue;
    try {
      const raw = readFileSync(path.join(cwd, file), 'utf8');
      const split = raw.split(/\r?\n/);
      const lineCount = raw.length === 0 ? 0 : raw.endsWith('\n') ? split.length - 1 : split.length;
      diffRecords.push({ file, added: Math.max(0, lineCount), deleted: 0 });
    } catch {
      diffRecords.push({ file, added: unreadableFileLineCount, deleted: 0 });
    }
  }
  return diffRecords;
}

export async function reuseApprovedPreflightFromSession({
  repoRoot,
  approvedPlan,
  storedPlanHash = '',
  storedTrackedSnapshot = null,
  taskKind,
  taskPhase,
  taskTitle,
  taskBody,
  baseHead,
  workBranch,
}) {
  const normalizedStoredHash = String(storedPlanHash || '').trim();
  const normalizedTrackedSnapshot = normalizePersistedTrackedSnapshot(storedTrackedSnapshot);
  if (!approvedPlan) {
    return {
      approvedPlan: null,
      approvedPlanHash: '',
      gateEvidence: null,
      retryReason: '',
    };
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
  const canReuse = Boolean(
    normalizedStoredHash &&
      normalizedTrackedSnapshot &&
      currentPlanHash === normalizedStoredHash,
  );
  if (!canReuse) {
    return {
      approvedPlan: null,
      approvedPlanHash: '',
      gateEvidence: null,
      retryReason:
        normalizedStoredHash || normalizedTrackedSnapshot
          ? 'persisted preflight session state is stale or incomplete; rerun required'
          : '',
    };
  }
  const reuseValidation = await validatePreflightExecutionUnlock({
    repoRoot,
    approvedPlan,
    trackedSnapshot: normalizedTrackedSnapshot,
    baseRef: baseHead,
  });
  if (!reuseValidation.ok) {
    return {
      approvedPlan: null,
      approvedPlanHash: '',
      gateEvidence: null,
      retryReason: reuseValidation.errors.join('; '),
    };
  }
  return {
    approvedPlan,
    approvedPlanHash: normalizedStoredHash,
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
