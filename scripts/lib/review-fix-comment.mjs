import crypto from 'node:crypto';

const ACTIONABLE_COMMENT_KEYWORDS = [
  'blocking',
  'must fix',
  'regression',
  'security',
  'vulnerability',
  'exploit',
  'ci failing',
  'tests failing',
  'typecheck',
  'lint',
  'fix this',
  'please fix',
  'needs change',
];

/**
 * Normalizes issue-comment body text for stable actionability checks and hashing.
 */
export function normalizeActionableCommentBody(body) {
  return String(body ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/**
 * Returns whether issue comment text is actionable for review-fix dispatch.
 */
export function isActionableComment(body) {
  const normalized = normalizeActionableCommentBody(body);
  if (!normalized) return false;
  return ACTIONABLE_COMMENT_KEYWORDS.some((keyword) => normalized.includes(keyword));
}

/**
 * Computes stable hash of actionable-comment body text.
 */
export function hashActionableCommentBody(body) {
  const normalized = normalizeActionableCommentBody(body);
  if (!normalized) return '';
  return crypto.createHash('sha256').update(normalized).digest('hex');
}
