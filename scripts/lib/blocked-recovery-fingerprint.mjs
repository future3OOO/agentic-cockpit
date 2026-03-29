import crypto from 'node:crypto';

const VOLATILE_BLOCKED_RECOVERY_FINGERPRINT_KEYS = new Set([
  'updatedAt',
  'createdAt',
  'startedAt',
  'closedAt',
  'timestamp',
  'retryAtMs',
  'threadId',
  'turnId',
  'sessionId',
  'requestId',
  'responseId',
  'attempt',
  'attempts',
  'stdoutTail',
  'stderrTail',
  'artifactPath',
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeBlockedRecoveryFingerprintText(value) {
  let text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  text = text.replace(/\/tmp\/[^\s)]+/g, '<tmp>');
  text = text.replace(/\bartifacts\/[^\s)]+/g, '<artifact>');
  return text;
}

export function normalizeBlockedRecoveryFingerprintValue(value) {
  if (Array.isArray(value)) return value.map((entry) => normalizeBlockedRecoveryFingerprintValue(entry));
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (VOLATILE_BLOCKED_RECOVERY_FINGERPRINT_KEYS.has(key)) continue;
      out[key] = normalizeBlockedRecoveryFingerprintValue(value[key]);
    }
    return out;
  }
  if (typeof value === 'string') return normalizeBlockedRecoveryFingerprintText(value);
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  return normalizeBlockedRecoveryFingerprintText(value);
}

export function hashBlockedRecoveryFingerprint(value) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(normalizeBlockedRecoveryFingerprintValue(value)))
    .digest('hex');
}
