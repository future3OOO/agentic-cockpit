import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import {
  validateOpusConsultRequestPayload,
  validateOpusConsultResponsePayload,
  validateOpusConsultResponseMeta,
  shouldContinueOpusConsultRound,
} from '../lib/opus-consult-schema.mjs';

function buildValidRequestPayload() {
  return {
    version: 'v1',
    consultId: 'consult_abc123',
    round: 1,
    maxRounds: 2,
    mode: 'pre_exec',
    autopilotHypothesis: {
      summary: 'Need to dispatch execution and validate closure constraints.',
      intendedActions: ['Dispatch execute follow-up', 'Validate quality gate'],
      proposedDispatches: [
        {
          to: ['qa'],
          kind: 'EXECUTE',
          phase: 'execute',
          title: 'Run patch and tests',
          reason: 'Need implementation and verification evidence',
        },
      ],
    },
    autopilotMessage: null,
    taskContext: {
      taskId: 't1',
      taskKind: 'USER_REQUEST',
      title: 'Implement plan',
      bodySummary: 'User asked to implement the approved plan.',
      rootId: 'root_1',
      parentId: 'p_1',
      sourceKind: 'USER_REQUEST',
      smoke: false,
      referencesSummary: '{"git":{"baseSha":"abc123"}}',
      packetMeta: {
        id: 't1',
        from: 'autopilot',
        to: ['opus-consult'],
        priority: 'P2',
        title: 'Implement plan',
        kind: 'USER_REQUEST',
        phase: null,
        notifyOrchestrator: false,
      },
      lineage: {
        rootId: 'root_1',
        parentId: 'p_1',
        sourceKind: 'USER_REQUEST',
        from: 'autopilot',
      },
      references: {
        git: {
          baseSha: 'abc123',
        },
      },
    },
    priorRoundSummary: null,
    questions: [],
  };
}

function buildValidResponsePayload() {
  return {
    version: 'v1',
    consultId: 'consult_abc123',
    round: 1,
    final: true,
    verdict: 'pass',
    rationale: 'The plan is internally coherent, bounded, and includes required verification steps.',
    suggested_plan: ['Proceed with execution and preserve gate evidence in receiptExtra.'],
    alternatives: [],
    challenge_points: [],
    code_suggestions: [],
    required_questions: [],
    required_actions: [],
    retry_prompt_patch: '',
    unresolved_critical_questions: [],
    reasonCode: 'opus_consult_pass',
  };
}

function assertSchemaRequiredCoverage(schema) {
  const props = Object.keys(schema.properties || {});
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  for (const key of props) {
    assert.equal(required.has(key), true, `schema missing required coverage for ${key}`);
  }
}

test('opus consult schema files exist and keep full required coverage', async () => {
  const root = process.cwd();
  const requestSchemaPath = path.join(root, 'docs', 'agentic', 'agent-bus', 'OPUS_CONSULT_REQUEST.schema.json');
  const responseSchemaPath = path.join(root, 'docs', 'agentic', 'agent-bus', 'OPUS_CONSULT_RESPONSE.schema.json');
  const providerSchemaPath = path.join(root, 'docs', 'agentic', 'agent-bus', 'OPUS_CONSULT.provider.schema.json');

  const [requestSchema, responseSchema, providerSchema] = await Promise.all([
    fs.readFile(requestSchemaPath, 'utf8').then((raw) => JSON.parse(raw)),
    fs.readFile(responseSchemaPath, 'utf8').then((raw) => JSON.parse(raw)),
    fs.readFile(providerSchemaPath, 'utf8').then((raw) => JSON.parse(raw)),
  ]);

  assertSchemaRequiredCoverage(requestSchema);
  assertSchemaRequiredCoverage(responseSchema);
  assert.deepEqual(
    [...(providerSchema.required || [])].sort(),
    [...(responseSchema.required || [])].sort(),
  );
  assert.equal(Array.isArray(providerSchema.oneOf), false, 'provider schema must not define top-level oneOf');
  assert.equal(Array.isArray(providerSchema.allOf), false, 'provider schema must not define top-level allOf');
  assert.equal(Array.isArray(providerSchema.anyOf), false, 'provider schema must not define top-level anyOf');
});

test('validateOpusConsultRequestPayload accepts valid payload', () => {
  const validated = validateOpusConsultRequestPayload(buildValidRequestPayload());
  assert.equal(validated.ok, true, validated.errors.join('; '));
  assert.equal(validated.value.mode, 'pre_exec');
});

test('validateOpusConsultResponsePayload enforces block semantics and allows advisory warn without questions', () => {
  const warnAdvisory = {
    ...buildValidResponsePayload(),
    final: true,
    verdict: 'warn',
    required_questions: [],
    reasonCode: 'opus_consult_warn',
  };
  const warnResult = validateOpusConsultResponsePayload(warnAdvisory);
  assert.equal(warnResult.ok, true, warnResult.errors.join('; '));

  const blockInvalid = {
    ...buildValidResponsePayload(),
    verdict: 'block',
    final: true,
    required_actions: [],
    retry_prompt_patch: '',
    reasonCode: 'opus_consult_block',
  };
  const blockResult = validateOpusConsultResponsePayload(blockInvalid);
  assert.equal(blockResult.ok, false);
  assert.match(blockResult.errors.join('; '), /block verdict requires required_actions/i);
});

test('validateOpusConsultResponsePayload rejects insufficient-context reason code', () => {
  const invalid = {
    ...buildValidResponsePayload(),
    reasonCode: 'INSUFFICIENT_CONTEXT',
  };
  const result = validateOpusConsultResponsePayload(invalid);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('; '), /supported consult reason codes|insufficient-context/i);
});

test('validateOpusConsultResponsePayload enforces human-input and iterate semantics', () => {
  const humanInput = {
    ...buildValidResponsePayload(),
    verdict: 'warn',
    final: true,
    required_questions: ['Please confirm business priority.'],
    reasonCode: 'opus_human_input_required',
  };
  const humanInputOk = validateOpusConsultResponsePayload(humanInput);
  assert.equal(humanInputOk.ok, true, humanInputOk.errors.join('; '));

  const iterate = {
    ...buildValidResponsePayload(),
    verdict: 'warn',
    final: false,
    required_questions: ['Need autopilot clarification on rollback scope.'],
    reasonCode: 'opus_consult_iterate',
  };
  const iterateOk = validateOpusConsultResponsePayload(iterate);
  assert.equal(iterateOk.ok, true, iterateOk.errors.join('; '));
});

test('validateOpusConsultResponsePayload rejects contradictory final/verdict/reason combinations', () => {
  const blockNonFinal = {
    ...buildValidResponsePayload(),
    verdict: 'block',
    final: false,
    reasonCode: 'opus_consult_block',
    required_actions: ['Stop execution and request autopilot acknowledgement.'],
    retry_prompt_patch: 'Re-evaluate risk posture with explicit rollback plan.',
  };
  const blockNonFinalResult = validateOpusConsultResponsePayload(blockNonFinal);
  assert.equal(blockNonFinalResult.ok, false);
  assert.match(blockNonFinalResult.errors.join('; '), /block verdict must set final=true/i);

  const iterateFinal = {
    ...buildValidResponsePayload(),
    verdict: 'warn',
    final: true,
    reasonCode: 'opus_consult_iterate',
    required_questions: ['Need autopilot clarification on release rollback boundary.'],
  };
  const iterateFinalResult = validateOpusConsultResponsePayload(iterateFinal);
  assert.equal(iterateFinalResult.ok, false);
  assert.match(
    iterateFinalResult.errors.join('; '),
    /opus_consult_iterate requires final=false|final consult response cannot use reasonCode=opus_consult_iterate/i,
  );

  const nonFinalNonIterate = {
    ...buildValidResponsePayload(),
    verdict: 'warn',
    final: false,
    reasonCode: 'opus_consult_warn',
    required_questions: ['Need explicit confirmation before proceeding.'],
  };
  const nonFinalNonIterateResult = validateOpusConsultResponsePayload(nonFinalNonIterate);
  assert.equal(nonFinalNonIterateResult.ok, false);
  assert.match(
    nonFinalNonIterateResult.errors.join('; '),
    /non-final consult response must use reasonCode=opus_consult_iterate/i,
  );

  const iterateNoQuestions = {
    ...buildValidResponsePayload(),
    verdict: 'warn',
    final: false,
    reasonCode: 'opus_consult_iterate',
    required_questions: [],
    unresolved_critical_questions: [],
  };
  const iterateNoQuestionsResult = validateOpusConsultResponsePayload(iterateNoQuestions);
  assert.equal(iterateNoQuestionsResult.ok, false);
  assert.match(
    iterateNoQuestionsResult.errors.join('; '),
    /opus_consult_iterate requires unresolved or required questions/i,
  );
});

test('validateOpusConsultResponseMeta validates signal contract and payload', () => {
  const meta = {
    id: 'msg_1',
    to: ['autopilot'],
    from: 'opus-consult',
    priority: 'P2',
    title: 'response',
    signals: {
      kind: 'OPUS_CONSULT_RESPONSE',
      phase: 'pre_exec',
      rootId: 'root_1',
      parentId: 't1',
      smoke: false,
      notifyOrchestrator: false,
    },
    references: {
      opus: buildValidResponsePayload(),
    },
  };

  const ok = validateOpusConsultResponseMeta(meta);
  assert.equal(ok.ok, true, ok.errors.join('; '));

  const bad = validateOpusConsultResponseMeta({
    ...meta,
    signals: { ...meta.signals, notifyOrchestrator: true },
  });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join('; '), /notifyOrchestrator must be false/i);
});

test('shouldContinueOpusConsultRound only continues on explicit iterate responses', () => {
  assert.equal(
    shouldContinueOpusConsultRound({
      verdict: 'warn',
      final: false,
      reasonCode: 'opus_consult_iterate',
      required_questions: ['Need clarification'],
    }),
    true,
  );
  assert.equal(
    shouldContinueOpusConsultRound({
      verdict: 'warn',
      final: true,
      reasonCode: 'opus_human_input_required',
      required_questions: ['needs acknowledgement'],
      unresolved_critical_questions: [],
    }),
    false,
  );
  assert.equal(
    shouldContinueOpusConsultRound({
      verdict: 'pass',
      final: false,
      reasonCode: 'opus_consult_pass',
      required_questions: [],
      unresolved_critical_questions: [],
    }),
    false,
  );
});
