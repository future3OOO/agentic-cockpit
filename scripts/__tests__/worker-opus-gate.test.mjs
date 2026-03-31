import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveOpusConsultGate } from '../lib/worker-opus-gate.mjs';
import { buildOpusConsultPromptBlock } from '../lib/worker-opus-advice.mjs';

function buildEnv(overrides = {}) {
  return {
    AGENTIC_OPUS_CONSULT_MODE: '',
    AGENTIC_AUTOPILOT_OPUS_GATE: '',
    AGENTIC_AUTOPILOT_OPUS_POST_REVIEW: '',
    AGENTIC_AUTOPILOT_OPUS_ENFORCE_PREEXEC_BARRIER: '',
    ...overrides,
  };
}

test('worker-opus-gate: deriveOpusConsultGate preserves advisory auto-defaults when consult agent exists', () => {
  const gate = deriveOpusConsultGate({
    isAutopilot: true,
    taskKind: 'EXECUTE',
    roster: { agents: [{ name: 'opus-consult' }] },
    env: buildEnv(),
  });

  assert.equal(gate.consultMode, 'advisory');
  assert.equal(gate.preExecRequired, true);
  assert.equal(gate.postReviewRequired, true);
  assert.equal(gate.enforcePreExecBarrier, false);
});

test('worker-opus-gate: explicit gate mode keeps the hard barrier semantics after extraction', () => {
  const gate = deriveOpusConsultGate({
    isAutopilot: true,
    taskKind: 'EXECUTE',
    roster: { agents: [] },
    env: buildEnv({ AGENTIC_OPUS_CONSULT_MODE: 'gate' }),
  });

  assert.equal(gate.consultMode, 'gate');
  assert.equal(gate.preExecRequired, true);
  assert.equal(gate.postReviewRequired, true);
  assert.equal(gate.enforcePreExecBarrier, true);
  assert.equal(gate.requireDecisionRationale, true);
});

test('worker-opus-gate: buildOpusConsultPromptBlock remains autopilot-only', () => {
  assert.match(buildOpusConsultPromptBlock({ isAutopilot: true }), /OPUS ADVISORY HANDLING/);
  assert.equal(buildOpusConsultPromptBlock({ isAutopilot: false }), '');
});
