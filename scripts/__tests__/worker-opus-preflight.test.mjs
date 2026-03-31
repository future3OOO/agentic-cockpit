import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOpusConsultAdvice } from '../lib/worker-opus-advice.mjs';
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

test('worker-opus-preflight: bare warn without substantive feedback does not trigger a pointless revision round', () => {
  const revision = derivePreExecConsultRevision({
    approvedPlan: buildPlan(),
    phaseResult: {
      ok: true,
      reasonCode: 'opus_consult_warn',
      finalResponse: {
        verdict: 'warn',
        reasonCode: 'opus_consult_warn',
        rationale: 'This is only a high-level caution with no concrete revision request.',
        suggested_plan: [],
        challenge_points: [],
        code_suggestions: [],
        required_questions: [],
        required_actions: [],
        unresolved_critical_questions: [],
      },
    },
  });

  assert.equal(revision.needsRevision, false);
  assert.equal(revision.retryReason, '');
  assert.deepEqual(revision.seedPlan.openQuestions, []);
});

test('worker-opus-preflight: substantive feedback without reasonCode still reuses verdict in retry reason', () => {
  const revision = derivePreExecConsultRevision({
    approvedPlan: buildPlan(),
    phaseResult: {
      ok: true,
      finalResponse: {
        verdict: 'warn',
        rationale: 'Tighten the approach before editing.',
        suggested_plan: ['Split the helper before touching the host.'],
        challenge_points: [],
        code_suggestions: [],
        required_questions: [],
        required_actions: [],
        unresolved_critical_questions: [],
      },
    },
  });

  assert.equal(revision.needsRevision, true);
  assert.match(revision.retryReason, /opus_consult_feedback|warn/i);
  assert.match(revision.retryReason, /Split the helper before touching the host/);
});

test('worker-opus-advice: gate-mode consult failures and block verdicts keep block severity', () => {
  const dispatchFailure = buildOpusConsultAdvice({
    mode: 'gate',
    phase: 'pre_exec',
    phaseResult: {
      ok: false,
      reasonCode: 'opus_consult_dispatch_failed',
      note: 'Consult agent missing.',
      finalResponse: null,
      finalResponseRuntime: null,
      roundsUsed: 0,
    },
  });
  assert.equal(dispatchFailure.severity, 'block');

  const advisoryBlock = buildOpusConsultAdvice({
    mode: 'advisory',
    phase: 'pre_exec',
    phaseResult: {
      ok: true,
      finalResponse: {
        verdict: 'block',
        reasonCode: 'opus_consult_block',
        rationale: 'This should not hard-block in advisory mode.',
        suggested_plan: ['Dispatch the slice instead.'],
        challenge_points: [],
        code_suggestions: [],
        required_questions: [],
        required_actions: [],
      },
      finalResponseRuntime: null,
      roundsUsed: 1,
    },
  });
  assert.equal(advisoryBlock.severity, 'warn');
});
