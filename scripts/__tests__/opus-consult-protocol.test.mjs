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
  assert.deepEqual(providerSchema.required, responseSchema.required);
});

test('validateOpusConsultRequestPayload accepts valid payload', () => {
  const validated = validateOpusConsultRequestPayload(buildValidRequestPayload());
  assert.equal(validated.ok, true, validated.errors.join('; '));
  assert.equal(validated.value.mode, 'pre_exec');
});

test('validateOpusConsultResponsePayload enforces warn/block semantics', () => {
  const warnInvalid = {
    ...buildValidResponsePayload(),
    final: true,
    verdict: 'warn',
    required_questions: [],
    reasonCode: 'opus_warn_requires_ack',
  };
  const warnResult = validateOpusConsultResponsePayload(warnInvalid);
  assert.equal(warnResult.ok, false);
  assert.match(warnResult.errors.join('; '), /warn verdict requires required_questions/i);

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

test('shouldContinueOpusConsultRound continues until final response has no pending questions', () => {
  assert.equal(
    shouldContinueOpusConsultRound({
      verdict: 'pass',
      final: true,
      required_questions: ['advisory question'],
      unresolved_critical_questions: [],
    }),
    true,
  );
  assert.equal(
    shouldContinueOpusConsultRound({
      verdict: 'warn',
      final: true,
      required_questions: ['needs acknowledgement'],
      unresolved_critical_questions: [],
    }),
    true,
  );
  assert.equal(
    shouldContinueOpusConsultRound({
      verdict: 'pass',
      final: false,
      required_questions: [],
      unresolved_critical_questions: [],
    }),
    true,
  );
});
