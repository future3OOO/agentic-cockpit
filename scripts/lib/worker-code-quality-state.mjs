import { hashBlockedRecoveryFingerprint } from './blocked-recovery-fingerprint.mjs';

export const CODE_QUALITY_HARD_RULE_KEYS = [
  'codeVolume',
  'noDuplication',
  'shortestPath',
  'cleanup',
  'anticipateConsequences',
  'simplicity',
];

export function readStringField(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function mapCodeQualityReasonCodes(errors) {
  const text = String((Array.isArray(errors) ? errors : []).join(' ') || '').toLowerCase();
  const out = new Set();
  if (!text) return [];
  if (text.includes('missing_base_ref')) out.add('missing_base_ref');
  if (text.includes('scope_invalid')) out.add('scope_invalid');
  if (text.includes('scope_mismatch')) out.add('scope_mismatch');
  if (text.includes('artifact_only_mismatch')) out.add('artifact_only_mismatch');
  if (text.includes('evidence_semantic_mismatch')) out.add('evidence_semantic_mismatch');
  if (text.includes('qualityreview evidence is required') || text.includes('qualityreview.') || text.includes('qualityreview ')) {
    out.add('missing_quality_review_fields');
  }
  if (text.includes('timed out') || text.includes('exited with status')) out.add('gate_exec_failed');
  return Array.from(out);
}

export function isRecoverableQualityReason(reasonCode) {
  return [
    'gate_exec_failed',
    'missing_base_ref',
    'scope_invalid',
    'scope_mismatch',
    'artifact_only_mismatch',
    'evidence_semantic_mismatch',
    'missing_quality_review_fields',
  ].includes(reasonCode);
}

export function buildCodeQualityRetrySignature({
  reasonCode,
  codeQualityGateEvidence,
  codeQualityReviewEvidence,
  errors,
}) {
  return hashBlockedRecoveryFingerprint({
    reasonCode: readStringField(reasonCode),
    errors: Array.isArray(errors) ? errors.map((value) => String(value)).sort() : [],
    scope: readStringField(codeQualityGateEvidence?.changedScopeReturned),
    files: Array.isArray(codeQualityGateEvidence?.changedFilesSample)
      ? codeQualityGateEvidence.changedFilesSample.map((value) => String(value)).sort()
      : [],
    sourceFilesSeenCount: Number(codeQualityGateEvidence?.sourceFilesSeenCount) || 0,
    artifactOnlyChange: Boolean(codeQualityGateEvidence?.artifactOnlyChange),
    reviewPresent: Boolean(codeQualityReviewEvidence?.present),
    reviewSummary: readStringField(codeQualityReviewEvidence?.summary),
    reasonCodes: Array.isArray(codeQualityGateEvidence?.reasonCodes)
      ? codeQualityGateEvidence.reasonCodes.map(readStringField).filter(Boolean).sort()
      : [],
    hardRuleChecks:
      codeQualityReviewEvidence?.hardRuleChecks && typeof codeQualityReviewEvidence.hardRuleChecks === 'object'
        ? codeQualityReviewEvidence.hardRuleChecks
        : {},
  });
}
