import childProcess from 'node:child_process';
import { evaluateModularityPlan, evaluateModularityPolicy, matchRepoPathRule, normalizeRepoPath, parseNumstatRecords } from './code-quality-modularity.mjs';
import { normalizePreflightPlan } from './worker-preflight-submission.mjs';
import { firstPreflightReasonCode, readStringField, sha256Stable, stableStringify } from './worker-preflight-shared.mjs';
import { readNumstatRecordsForCommitOrWorkingTree } from './worker-preflight-working-tree.mjs';

function isBootstrapSupportPath(relPath) {
  const normalized = normalizeRepoPath(relPath);
  if (!normalized) return false;
  return (
    normalized === 'AGENTS.md' ||
    normalized === 'CLAUDE.md' ||
    normalized === '.codex/README.md' ||
    normalized.startsWith('.codex/opus/') ||
    normalized.startsWith('.codex/skills/') ||
    normalized.startsWith('docs/agentic/') ||
    normalized.startsWith('docs/runbooks/')
  );
}

function readBootstrapSupportUntrackedFiles({ cwd }) {
  let raw = '';
  try {
    raw = childProcess.execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return new Set();
  }
  return new Set(
    String(raw || '')
      .split(/\r?\n/)
      .map((line) => normalizeRepoPath(line))
      .filter((line) => line && isBootstrapSupportPath(line)),
  );
}

function coupledRulesForPrefix(plan, prefix) {
  return Array.isArray(plan?.coupledSurfaces)
    ? plan.coupledSurfaces
        .filter((entry) => entry.startsWith(prefix))
        .map((entry) => entry.slice(prefix.length))
    : [];
}

export function captureTrackedSnapshot({ cwd }) {
  const text = childProcess.execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const normalized = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
  return {
    statusLines: normalized,
    hash: sha256Stable(normalized),
  };
}

export async function validatePreflightExecutionUnlock({
  repoRoot,
  approvedPlan,
  trackedSnapshot,
  baseRef = '',
}) {
  const errors = [];
  const currentSnapshot = captureTrackedSnapshot({ cwd: repoRoot });
  const noWritePass = currentSnapshot.hash === trackedSnapshot.hash;
  if (!noWritePass) {
    errors.push('unlock_preflight_mutation_detected');
  }
  const openQuestions = Array.isArray(approvedPlan?.openQuestions) ? approvedPlan.openQuestions.filter(Boolean) : [];
  const modularity = await evaluateModularityPlan({
    repoRoot,
    touchpoints: approvedPlan?.touchpoints,
    modularityPlan: approvedPlan?.modularityPlan,
    baseRef,
  });
  if (!modularity.ok) {
    errors.push(...modularity.errors.map((error) => `unlock_${error}`));
  }
  return {
    ok: errors.length === 0,
    errors,
    evidence: {
      noWritePass,
      openQuestions,
      modularity: modularity.evidence,
    },
  };
}

export async function validatePreflightClosure({
  repoRoot,
  approvedPlan,
  outputPreflightPlan,
  changedFiles,
  numstatRecords,
  baseRef = '',
}) {
  const errors = [];
  const normalizedApprovedPlan = normalizePreflightPlan(approvedPlan);
  const normalizedOutputPlan =
    outputPreflightPlan && typeof outputPreflightPlan === 'object'
      ? normalizePreflightPlan(outputPreflightPlan)
      : null;
  if (!normalizedOutputPlan) {
    errors.push('closure_preflight_plan_missing');
  } else if (stableStringify(normalizedApprovedPlan) !== stableStringify(normalizedOutputPlan)) {
    errors.push('closure_preflight_plan_mismatch');
  }

  const bootstrapSupportUntracked = readBootstrapSupportUntrackedFiles({ cwd: repoRoot });
  const normalizedChangedFiles = Array.from(
    new Set(
      (Array.isArray(changedFiles) ? changedFiles : [])
        .map(normalizeRepoPath)
        .filter(Boolean),
    ),
  );
  const allowedRules = [
    ...(Array.isArray(normalizedApprovedPlan?.touchpoints) ? normalizedApprovedPlan.touchpoints : []),
    ...coupledRulesForPrefix(normalizedApprovedPlan, 'update:'),
  ];
  const verifyRules = coupledRulesForPrefix(normalizedApprovedPlan, 'verify:');
  const updateRules = coupledRulesForPrefix(normalizedApprovedPlan, 'update:');

  for (const file of normalizedChangedFiles) {
    const matchesUpdateRule = updateRules.some((rule) => matchRepoPathRule(file, rule));
    if (!matchesUpdateRule && verifyRules.some((rule) => matchRepoPathRule(file, rule))) {
      errors.push(`closure_verify_surface_changed:${file}`);
    }
    if (bootstrapSupportUntracked.has(file)) {
      continue;
    }
    if (!allowedRules.some((rule) => matchRepoPathRule(file, rule))) {
      errors.push(`closure_scope_drift:${file}`);
    }
  }
  for (const rule of updateRules) {
    if (!normalizedChangedFiles.some((file) => matchRepoPathRule(file, rule))) {
      errors.push(`closure_missing_update_surface:${rule}`);
    }
  }

  const modularity = await evaluateModularityPolicy({
    repoRoot,
    changedFiles: normalizedChangedFiles,
    numstatRecords: Array.isArray(numstatRecords) ? numstatRecords : parseNumstatRecords(''),
    baseRef,
  });
  if (!modularity.ok) {
    errors.push(...modularity.errors.map((error) => `closure_modularity_violation:${error}`));
  }

  return {
    ok: errors.length === 0,
    errors,
    evidence: {
      driftDetected: errors.some((error) => error.startsWith('closure_')),
      modularity: modularity.evidence,
    },
  };
}

export async function finalizePreflightClosureGate({
  repoRoot,
  approvedPlan,
  outputPreflightPlan,
  sourceDelta,
  commitSha,
  isCommitObjectMissingError,
  unreadableFileLineCount,
  baseRef = '',
  gateEvidence,
  outcome,
}) {
  if (readStringField(sourceDelta?.inspectError?.reasonCode) === 'source_delta_commit_unavailable') {
    return {
      gateEvidence: {
        ...gateEvidence,
        driftDetected: true,
        reasonCode: gateEvidence.reasonCode || 'closure_source_delta_unavailable',
      },
      blocked: false,
      noteReason: outcome === 'done' ? 'closure_source_delta_unavailable' : '',
      blockDetail: '',
    };
  }

  const closureValidation = await validatePreflightClosure({
    repoRoot,
    approvedPlan,
    outputPreflightPlan,
    changedFiles: Array.isArray(sourceDelta?.changedFiles) ? sourceDelta.changedFiles : [],
    numstatRecords: readNumstatRecordsForCommitOrWorkingTree({
      cwd: repoRoot,
      commitSha,
      isCommitObjectMissingError,
      unreadableFileLineCount,
    }),
    baseRef,
  });
  return {
    gateEvidence: {
      ...gateEvidence,
      driftDetected: closureValidation.evidence?.driftDetected === true,
      reasonCode: closureValidation.ok
        ? gateEvidence.reasonCode
        : firstPreflightReasonCode(closureValidation.errors) || 'closure_scope_drift',
    },
    blocked: outcome !== 'blocked' && outcome !== 'failed' && !closureValidation.ok,
    noteReason: '',
    blockDetail: closureValidation.errors.join('; '),
  };
}
