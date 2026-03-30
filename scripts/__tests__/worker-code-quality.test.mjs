import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCodeQualityGatePromptBlock, validateCodeQualityReviewEvidence } from '../lib/worker-code-quality.mjs';
import { buildCodeQualityRetrySignature } from '../lib/worker-code-quality-state.mjs';

test('buildCodeQualityRetrySignature preserves blocked-recovery normalization semantics for whitespace and temp paths', () => {
  const left = buildCodeQualityRetrySignature({
    reasonCode: 'missing_quality_review_fields',
    codeQualityGateEvidence: {
      changedScopeReturned: 'commit-range:abc...def',
      changedFilesSample: ['scripts/agent-codex-worker.mjs', '/tmp/review-artifact.txt'],
      sourceFilesSeenCount: 2,
      artifactOnlyChange: false,
      reasonCodes: ['missing_quality_review_fields'],
    },
    codeQualityReviewEvidence: {
      present: true,
      summary: '  trimmed worker quality path  ',
      hardRuleChecks: {
        codeVolume: 'artifacts/run-1/report.md',
      },
    },
    errors: ['qualityReview summary missing', '  /tmp/codex-run-1/log.txt  '],
  });
  const right = buildCodeQualityRetrySignature({
    reasonCode: 'missing_quality_review_fields',
    codeQualityGateEvidence: {
      changedScopeReturned: 'commit-range:abc...def',
      changedFilesSample: ['scripts/agent-codex-worker.mjs', '/tmp/another-run/report.txt'],
      sourceFilesSeenCount: 2,
      artifactOnlyChange: false,
      reasonCodes: ['missing_quality_review_fields'],
    },
    codeQualityReviewEvidence: {
      present: true,
      summary: 'trimmed   worker quality path',
      hardRuleChecks: {
        codeVolume: 'artifacts/run-2/output.md',
      },
    },
    errors: ['qualityReview summary missing', '/tmp/codex-run-2/log.txt'],
  });

  assert.equal(left, right);
});

test('buildCodeQualityGatePromptBlock keeps the PR52 closure prompt wording after extraction', () => {
  const prompt = buildCodeQualityGatePromptBlock({
    codeQualityGate: { required: true, taskKind: 'USER_REQUEST' },
    cockpitRoot: '/repo',
  });

  assert.match(
    prompt,
    /Follow the active repo\/adapter quality skill guidance already listed above before returning outcome="done"\./,
  );
  assert.match(prompt, /Run node "\/repo\/scripts\/code-quality-gate\.mjs" check --task-kind USER_REQUEST before outcome="done"\./);
  assert.doesNotMatch(prompt, /Do not dump planning doctrine here/i);
});

test('validateCodeQualityReviewEvidence preserves legacy legacyDebtWarnings coercion semantics after extraction', () => {
  const parsed = {
    qualityReview: {
      summary: 'tightened the runtime path',
      legacyDebtWarnings: '0',
      hardRuleChecks: {
        codeVolume: 'trimmed the touched path in place',
        noDuplication: 'reused the existing worker quality helper',
        shortestPath: 'kept the existing gate execution path',
        cleanup: 'did not add temp state',
        anticipateConsequences: 'updated coupled test coverage',
        simplicity: 'kept the implementation direct',
      },
    },
  };

  const result = validateCodeQualityReviewEvidence({
    parsed,
    codeQualityGate: { required: true },
  });

  assert.equal(result.ok, true);
  assert.equal(result.evidence.legacyDebtWarnings, 0);
});
