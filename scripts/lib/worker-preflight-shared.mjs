import crypto from 'node:crypto';

const BANNED_FILLER_VALUES = new Set([
  'ok',
  'passed',
  'looks good',
  'good',
  'fine',
  'minimal',
  'minimal change',
  'check impacts',
  'review impacts',
  'tbd',
  ['to', 'do'].join(''),
  'unknown',
  'n/a',
  'na',
  'none',
  'local-only',
]);

const ALLOWED_SENTINELS = new Set([
  'none:new-surface-required',
  'boundary-only:no-extraction-needed',
]);

export function readStringField(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function trimString(value) {
  return String(value ?? '').trim();
}

function normalizeLower(value) {
  return trimString(value).toLowerCase();
}

export function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256Stable(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

export function uniqStrings(values) {
  return Array.from(new Set((Array.isArray(values) ? values : []).map(trimString).filter(Boolean)));
}

function isBannedFiller(value, { allowSentinel = false } = {}) {
  const normalized = normalizeLower(value);
  if (!normalized) return false;
  if (allowSentinel && ALLOWED_SENTINELS.has(normalized)) return false;
  return BANNED_FILLER_VALUES.has(normalized);
}

export function validateSingleLineField(errors, fieldName, value, { maxLength, allowSentinel = false } = {}) {
  const normalized = trimString(value);
  if (!normalized) {
    errors.push(`${fieldName} is required`);
    return '';
  }
  if (/[\r\n]/.test(normalized)) {
    errors.push(`${fieldName} must be single-line`);
  }
  if (maxLength && normalized.length > maxLength) {
    errors.push(`${fieldName} must be <=${maxLength} chars`);
  }
  if (isBannedFiller(normalized, { allowSentinel })) {
    errors.push(`${fieldName} must not be filler`);
  }
  return normalized;
}

export function validateUniqueStringArray(errors, fieldName, values, { min = 0, max = 0, maxItemLength = 0 } = {}) {
  const raw = Array.isArray(values) ? values : [];
  const normalized = raw.map(trimString).filter(Boolean);
  const unique = uniqStrings(normalized);
  if (normalized.length !== unique.length) {
    errors.push(`${fieldName} must not contain duplicates`);
  }
  if (min && unique.length < min) {
    errors.push(`${fieldName} must contain at least ${min} item(s)`);
  }
  if (max && unique.length > max) {
    errors.push(`${fieldName} must contain at most ${max} item(s)`);
  }
  for (const item of unique) {
    if (/[\r\n]/.test(item)) {
      errors.push(`${fieldName} items must be single-line`);
    }
    if (maxItemLength && item.length > maxItemLength) {
      errors.push(`${fieldName} items must be <=${maxItemLength} chars`);
    }
    if (isBannedFiller(item)) {
      errors.push(`${fieldName} items must not be filler`);
    }
  }
  return unique;
}

export function normalizeRejectedApproaches(errors, value) {
  const items = Array.isArray(value) ? value : [];
  if (items.length < 1 || items.length > 3) {
    errors.push('preflightPlan.rejectedApproaches must contain 1-3 items');
  }
  const normalized = items
    .map((entry, index) => {
      const approach = validateSingleLineField(
        errors,
        `preflightPlan.rejectedApproaches[${index}].approach`,
        entry?.approach,
        { maxLength: 200 },
      );
      const reason = validateSingleLineField(
        errors,
        `preflightPlan.rejectedApproaches[${index}].reason`,
        entry?.reason,
        { maxLength: 200 },
      );
      return { approach, reason };
    })
    .filter((entry) => entry.approach || entry.reason);
  const dedupeKey = new Set();
  for (const entry of normalized) {
    const key = `${entry.approach}::${entry.reason}`;
    if (dedupeKey.has(key)) {
      errors.push('preflightPlan.rejectedApproaches must not contain duplicates');
      break;
    }
    dedupeKey.add(key);
  }
  return normalized.sort((left, right) => {
    const leftKey = `${left.approach}\u0000${left.reason}`;
    const rightKey = `${right.approach}\u0000${right.reason}`;
    return leftKey.localeCompare(rightKey);
  });
}

export function normalizeCoupledSurfaces(errors, value) {
  const items = validateUniqueStringArray(errors, 'preflightPlan.coupledSurfaces', value, {
    min: 0,
    max: 12,
    maxItemLength: 240,
  });
  for (const item of items) {
    if (!(item.startsWith('verify:') || item.startsWith('update:'))) {
      errors.push(`preflightPlan.coupledSurfaces entry must start with verify: or update: (${item})`);
    }
  }
  return items;
}

export function sortStrings(values) {
  return uniqStrings(values).sort((left, right) => left.localeCompare(right));
}
