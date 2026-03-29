import crypto from 'node:crypto';
import { normalizeRepoPath } from './code-quality-modularity.mjs';
import {
  readStringField,
  normalizeCoupledSurfaces,
  normalizeRejectedApproaches,
  sha256Stable,
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
      ? plan.rejectedApproaches.map((entry) => ({
          approach: trimString(entry?.approach),
          reason: trimString(entry?.reason),
        })).filter((entry) => entry.approach || entry.reason)
      : [],
    touchpoints: sortStrings(plan.touchpoints),
    coupledSurfaces: sortStrings(plan.coupledSurfaces),
    riskChecks: sortStrings(plan.riskChecks),
    openQuestions: sortStrings(plan.openQuestions),
  };
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
    taskKind: readStringField(taskKind),
    taskPhase: readStringField(taskPhase),
    taskTitle: readStringField(taskTitle),
    taskBodySha256: crypto.createHash('sha256').update(String(taskBody || '')).digest('hex'),
    baseHead: readStringField(baseHead),
    workBranch: readStringField(workBranch),
    preflightPlan: normalizePreflightPlan(preflightPlan),
  });
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
    touchpoints: validateUniqueStringArray(errors, 'preflightPlan.touchpoints', preflightPlan.touchpoints, {
      min: 1,
      max: 12,
      maxItemLength: 240,
    }).map(normalizeRepoPath),
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
