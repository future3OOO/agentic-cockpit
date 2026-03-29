import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPreExecConsultCandidateOutput,
  derivePreExecConsultRevision,
} from '../lib/worker-opus-preflight.mjs';

function buildPlan(overrides = {}) {
  return {
    goal: 'Keep the fix scoped before tracked edits.',
    reusePath: 'Extend the existing runtime path in place.',
    modularityPlan: 'boundary-only:no-extraction-needed',
    chosenApproach: 'Use the existing narrow runtime path.',
    rejectedApproaches: [
      {
        approach: 'Rewrite the subsystem from scratch.',
        reason: 'That would blow scope and add pointless risk.',
      },
    ],
    touchpoints: ['scripts/agent-codex-worker.mjs'],
    coupledSurfaces: ['update:docs/agentic/RUNTIME_FUNCTION_REFERENCE.md'],
    riskChecks: ['Verify runtime guards before done.'],
    openQuestions: [],
    ...overrides,
  };
}

test('worker-opus-preflight: consult candidate output carries approved preflight evidence', () => {
  const output = buildPreExecConsultCandidateOutput({
    approvedPlan: buildPlan(),
    approvedPlanHash: 'abc123hash',
  });

  assert.equal(output.preflightPlan.goal, 'Keep the fix scoped before tracked edits.');
  assert.equal(output.runtimeGuard.preflightGate.required, true);
  assert.equal(output.runtimeGuard.preflightGate.approved, true);
  assert.equal(output.runtimeGuard.preflightGate.planHash, 'abc123hash');
});

test('worker-opus-preflight: consult required questions force a preflight revision seed', () => {
  const revision = derivePreExecConsultRevision({
    approvedPlan: buildPlan(),
    phaseResult: {
      ok: true,
      reasonCode: 'opus_human_input_required',
      finalResponse: {
        verdict: 'warn',
        reasonCode: 'opus_human_input_required',
        rationale:
          'Human input is still required before execution can proceed with confidence on the writer path.',
        suggested_plan: ['Clarify whether the controller should delegate this slice.'],
        challenge_points: [],
        code_suggestions: [],
        required_questions: ['Should this change stay local or dispatch to EXECUTE?'],
        required_actions: ['Clarify the execution boundary before edits begin.'],
        unresolved_critical_questions: [],
      },
    },
  });

  assert.equal(revision.needsRevision, true);
  assert.deepEqual(revision.requiredQuestions, ['Should this change stay local or dispatch to EXECUTE?']);
  assert.deepEqual(revision.seedPlan.openQuestions, ['Should this change stay local or dispatch to EXECUTE?']);
  assert.match(revision.retryReason, /Resolve required questions before execution/);
});
