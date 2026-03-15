const DEFAULT_SKILLOPS_BODY_LINES = new Set([
  '# Summary',
  '- What changed:',
  '- Why:',
  '# Verification',
  '- Commands run:',
  '- Results:',
  '# Learnings',
  '- Add concise reusable rules into `skill_updates` in frontmatter before running distill.',
]);

function parseInlineSkillUpdateValues(raw) {
  const inner = String(raw || '').trim();
  if (!inner) return [];
  return inner
    .split(',')
    .map((value) => value.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

export function readNonEmptySkillUpdateSkillNamesFrontmatter(frontmatter) {
  const lines = String(frontmatter || '').split(/\r?\n/);
  let inSection = false;
  let sectionIndent = 0;
  let currentSkillName = '';
  let currentSkillIndent = null;
  let sawSection = false;
  const names = new Set();

  for (const line of lines) {
    const indent = (line.match(/^ */) || [''])[0].length;
    const trimmed = line.trim();

    if (!inSection) {
      if (/^skill_updates:\s*\{\s*\}\s*$/.test(trimmed)) {
        return [];
      }
      if (trimmed === 'skill_updates:') {
        inSection = true;
        sawSection = true;
        sectionIndent = indent;
        currentSkillName = '';
        currentSkillIndent = null;
      }
      continue;
    }

    if (!trimmed || trimmed.startsWith('#')) continue;
    if (indent <= sectionIndent) break;

    const skillMatch = indent === sectionIndent + 2 ? trimmed.match(/^([^:#][^:]*)\s*:\s*(.*)$/) : null;
    if (skillMatch) {
      currentSkillName = String(skillMatch[1] || '').trim();
      currentSkillIndent = indent;
      const rest = String(skillMatch[2] || '').trim();
      if (!currentSkillName) continue;
      if (!rest) continue;
      if (rest === '[]' || rest === '{}') continue;
      if (rest.startsWith('[') && rest.endsWith(']')) {
        if (parseInlineSkillUpdateValues(rest.slice(1, -1)).length > 0) names.add(currentSkillName);
        continue;
      }
      names.add(currentSkillName);
      continue;
    }

    if (currentSkillName && currentSkillIndent != null && indent > currentSkillIndent && /^-\s+/.test(trimmed)) {
      names.add(currentSkillName);
      continue;
    }

    if (currentSkillName && currentSkillIndent != null && indent > currentSkillIndent) {
      names.add(currentSkillName);
    }
  }

  if (!sawSection) return [];
  return Array.from(names).sort((a, b) => a.localeCompare(b));
}

export function normalizeSkillOpsStatus(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw === 'new') return 'pending';
  return raw;
}

export function parseSkillOpsFrontmatterParts(raw) {
  const text = String(raw ?? '');
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/);
  if (!match) return null;
  return {
    frontmatter: match[1] || '',
    body: match[2] || '',
  };
}

export function hasNonEmptySkillUpdatesFrontmatter(frontmatter) {
  const lines = String(frontmatter || '').split(/\r?\n/);
  let inSection = false;
  let sectionIndent = 0;
  let currentSkillIndent = null;
  let sawSection = false;
  let sawTopLevelSkillEntry = false;

  for (const line of lines) {
    const indent = (line.match(/^ */) || [''])[0].length;
    const trimmed = line.trim();

    if (!inSection) {
      if (/^skill_updates:\s*\{\s*\}\s*$/.test(trimmed)) {
        return false;
      }
      if (trimmed === 'skill_updates:') {
        inSection = true;
        sawSection = true;
        sectionIndent = indent;
        currentSkillIndent = null;
      }
      continue;
    }

    if (!trimmed) continue;
    if (trimmed.startsWith('#')) continue;
    if (indent <= sectionIndent) break;

    const isTopLevelSkillEntry = indent === sectionIndent + 2;

    if (isTopLevelSkillEntry && /^[^:#][^:]*:\s*\[\s*\]\s*$/.test(trimmed)) {
      sawTopLevelSkillEntry = true;
      currentSkillIndent = indent;
      continue;
    }
    const inlineMatch = isTopLevelSkillEntry ? trimmed.match(/^[^:#][^:]*:\s*\[(.*)\]\s*$/) : null;
    if (inlineMatch) {
      sawTopLevelSkillEntry = true;
      const inner = String(inlineMatch[1] || '').trim();
      if (inner) return true;
      currentSkillIndent = indent;
      continue;
    }
    if (isTopLevelSkillEntry && /^[^:#][^:]*:\s*$/.test(trimmed)) {
      sawTopLevelSkillEntry = true;
      currentSkillIndent = indent;
      continue;
    }
    if (currentSkillIndent != null && indent > currentSkillIndent && /^-\s+/.test(trimmed)) {
      return true;
    }
    return true;
  }

  if (!sawSection) return true;
  return sawTopLevelSkillEntry ? false : true;
}

export function hasMeaningfulSkillOpsBody(body) {
  const lines = String(body || '')
    .split(/\r?\n/)
    .map((line) => String(line || '').trim())
    .filter(Boolean);
  for (const line of lines) {
    if (DEFAULT_SKILLOPS_BODY_LINES.has(line)) continue;
    return true;
  }
  return false;
}

function readFrontmatterScalar(frontmatter, key) {
  const lines = String(frontmatter || '').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(`${key}:`)) continue;
    return trimmed
      .slice(key.length + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
  }
  return '';
}

export function readSkillOpsLogSummary(raw) {
  const parts = parseSkillOpsFrontmatterParts(raw);
  if (!parts) return null;
  const id = readFrontmatterScalar(parts.frontmatter, 'id');
  const rawStatus = readFrontmatterScalar(parts.frontmatter, 'status');
  const processedAt = readFrontmatterScalar(parts.frontmatter, 'processed_at');
  const queuedAt = readFrontmatterScalar(parts.frontmatter, 'queued_at');
  const promotionTaskId = readFrontmatterScalar(parts.frontmatter, 'promotion_task_id');
  return {
    frontmatter: parts.frontmatter,
    body: parts.body,
    id,
    rawStatus,
    status: normalizeSkillOpsStatus(rawStatus),
    processedAt: processedAt && processedAt !== 'null' ? processedAt : null,
    queuedAt: queuedAt && queuedAt !== 'null' ? queuedAt : null,
    promotionTaskId: promotionTaskId && promotionTaskId !== 'null' ? promotionTaskId : '',
    hasNonEmptySkillUpdates: hasNonEmptySkillUpdatesFrontmatter(parts.frontmatter),
    skillUpdateSkillNames: readNonEmptySkillUpdateSkillNamesFrontmatter(parts.frontmatter),
    hasMeaningfulBody: hasMeaningfulSkillOpsBody(parts.body),
  };
}
