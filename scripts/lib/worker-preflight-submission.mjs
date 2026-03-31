import crypto from 'node:crypto';
import { normalizeRepoPath } from './code-quality-modularity.mjs';
import {
  readStringField,
  normalizeCoupledSurfaces,
  normalizeRejectedApproaches,
  sha256Stable,
  sortRejectedApproachEntries,
  sortStrings,
  trimString,
  validateSingleLineField,
  validateUniqueStringArray,
} from './worker-preflight-shared.mjs';

export function normalizePreflightPlan(plan) {
  if (!plan || typeof plan !== 'object') return null;
  return {
    goal: trimString(plan.goal),
    reusePath: trimString(plan.reusePath),
    modularityPlan: trimString(plan.modularityPlan),
    chosenApproach: trimString(plan.chosenApproach),
    rejectedApproaches: Array.isArray(plan.rejectedApproaches)
      ? sortRejectedApproachEntries(
          plan.rejectedApproaches
            .map((entry) => ({
              approach: trimString(entry?.approach),
              reason: trimString(entry?.reason),
            }))
            .filter((entry) => entry.approach || entry.reason),
        )
      : [],
    touchpoints: sortStrings(plan.touchpoints),
    coupledSurfaces: sortStrings(plan.coupledSurfaces),
    riskChecks: sortStrings(plan.riskChecks),
    openQuestions: sortStrings(plan.openQuestions),
  };
}

function cloneHashableTaskMeta(taskMeta) {
  if (!taskMeta || typeof taskMeta !== 'object' || Array.isArray(taskMeta)) return null;
  return JSON.parse(JSON.stringify(taskMeta));
}

function hashTaskBody(taskBody) {
  return crypto.createHash('sha256').update(String(taskBody || '')).digest('hex');
}

export function buildPreflightTaskFingerprint({
  taskKind,
  taskPhase,
  taskTitle,
  taskBody,
  taskMeta,
  baseHead,
  workBranch,
}) {
  return sha256Stable({
    version: 1,
    taskKind: readStringField(taskKind),
    taskPhase: readStringField(taskPhase),
    taskTitle: readStringField(taskTitle),
    taskBodySha256: hashTaskBody(taskBody),
    taskMeta: cloneHashableTaskMeta(taskMeta),
    baseHead: readStringField(baseHead),
    workBranch: readStringField(workBranch),
  });
}

export function buildPreflightPlanHash({
  taskKind,
  taskPhase,
  taskTitle,
  taskBody,
  baseHead,
  workBranch,
  preflightPlan,
}) {
  return sha256Stable({
    version: 1,
    taskTitle: readStringField(taskTitle),
    taskKind: readStringField(taskKind),
    taskPhase: readStringField(taskPhase),
    taskBodySha256: hashTaskBody(taskBody),
    workBranch: readStringField(workBranch),
    baseHead: readStringField(baseHead),
    preflightPlan: normalizePreflightPlan(preflightPlan),
  });
}

function normalizeAndValidateTouchpoints(errors, touchpoints) {
  const normalized = [];
  const seen = new Set();
  for (const entry of validateUniqueStringArray(errors, 'preflightPlan.touchpoints', touchpoints, {
    min: 1,
    max: 12,
    maxItemLength: 240,
  })) {
    const canonical = normalizeRepoPath(entry);
    if (seen.has(canonical)) {
      errors.push(`preflightPlan.touchpoints contains duplicate canonical path: ${canonical}`);
      continue;
    }
    seen.add(canonical);
    normalized.push(canonical);
  }
  return normalized;
}

export function validatePreflightSubmission({
  preflightPlan,
  taskKind,
  taskPhase,
  taskTitle,
  taskBody,
  baseHead,
  workBranch,
}) {
  const errors = [];
  if (!preflightPlan || typeof preflightPlan !== 'object' || Array.isArray(preflightPlan)) {
    errors.push('preflightPlan must be an object');
    return { ok: false, errors, normalizedPlan: null, planHash: '' };
  }

  const normalizedPlan = {
    goal: validateSingleLineField(errors, 'preflightPlan.goal', preflightPlan.goal, { maxLength: 200 }),
    reusePath: validateSingleLineField(errors, 'preflightPlan.reusePath', preflightPlan.reusePath, {
      maxLength: 200,
      allowSentinel: true,
    }),
    modularityPlan: validateSingleLineField(errors, 'preflightPlan.modularityPlan', preflightPlan.modularityPlan, {
      maxLength: 200,
      allowSentinel: true,
    }),
    chosenApproach: validateSingleLineField(errors, 'preflightPlan.chosenApproach', preflightPlan.chosenApproach, {
      maxLength: 200,
    }),
    rejectedApproaches: normalizeRejectedApproaches(errors, preflightPlan.rejectedApproaches),
    touchpoints: normalizeAndValidateTouchpoints(errors, preflightPlan.touchpoints),
    coupledSurfaces: normalizeCoupledSurfaces(errors, preflightPlan.coupledSurfaces),
    riskChecks: validateUniqueStringArray(errors, 'preflightPlan.riskChecks', preflightPlan.riskChecks, {
      min: 1,
      max: 8,
      maxItemLength: 160,
    }),
    openQuestions: validateUniqueStringArray(errors, 'preflightPlan.openQuestions', preflightPlan.openQuestions, {
      min: 0,
      max: 8,
      maxItemLength: 160,
    }),
  };

  const planHash = errors.length
    ? ''
    : buildPreflightPlanHash({
        taskKind,
        taskPhase,
        taskTitle,
        taskBody,
        baseHead,
        workBranch,
        preflightPlan: normalizedPlan,
      });

  return {
    ok: errors.length === 0,
    errors,
    normalizedPlan,
    planHash,
  };
}
