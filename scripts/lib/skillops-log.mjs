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

function forEachSkillUpdatesFrontmatterLine(frontmatter, visitor) {
  const lines = String(frontmatter || '').split(/\r?\n/);
  let inSection = false;
  let sectionIndent = 0;
  let sawSection = false;
  let lastResult = '';

  for (const line of lines) {
    const indent = (line.match(/^ */) || [''])[0].length;
    const trimmed = line.trim();

    if (!inSection) {
      if (/^skill_updates:\s*\{\s*\}\s*$/.test(trimmed)) {
        return { sawSection: false, explicitEmptyObject: true };
      }
      if (trimmed === 'skill_updates:') {
        inSection = true;
        sawSection = true;
        sectionIndent = indent;
      }
      continue;
    }

    if (!trimmed || trimmed.startsWith('#')) continue;
    if (indent <= sectionIndent) break;
    const result = visitor({ indent, trimmed, sectionIndent });
    if (result) lastResult = result;
    if (result === 'break' || result === 'break:true') break;
  }

  return { sawSection, explicitEmptyObject: false, lastResult };
}

export function readNonEmptySkillUpdateSkillNamesFrontmatter(frontmatter) {
  let currentSkillName = '';
  let currentSkillIndent = null;
  const names = new Set();

  const scan = forEachSkillUpdatesFrontmatterLine(frontmatter, ({ indent, trimmed, sectionIndent }) => {
    const skillMatch = indent === sectionIndent + 2 ? trimmed.match(/^([^:#][^:]*)\s*:\s*(.*)$/) : null;
    if (skillMatch) {
      currentSkillName = String(skillMatch[1] || '').trim();
      currentSkillIndent = indent;
      const rest = String(skillMatch[2] || '').trim();
      if (!currentSkillName) return;
      if (!rest) return;
      if (rest === '[]' || rest === '{}') return;
      if (rest.startsWith('[') && rest.endsWith(']')) {
        if (parseInlineSkillUpdateValues(rest.slice(1, -1)).length > 0) names.add(currentSkillName);
        return;
      }
      names.add(currentSkillName);
      return;
    }

    if (currentSkillName && currentSkillIndent != null && indent > currentSkillIndent && /^-\s+/.test(trimmed)) {
      names.add(currentSkillName);
      return;
    }

    if (currentSkillName && currentSkillIndent != null && indent > currentSkillIndent) {
      names.add(currentSkillName);
    }
  });

  if (scan.explicitEmptyObject || !scan.sawSection) return [];
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
  let currentSkillIndent = null;
  let sawTopLevelSkillEntry = false;

  const scan = forEachSkillUpdatesFrontmatterLine(frontmatter, ({ indent, trimmed, sectionIndent }) => {
    const isTopLevelSkillEntry = indent === sectionIndent + 2;

    if (isTopLevelSkillEntry && /^[^:#][^:]*:\s*\[\s*\]\s*$/.test(trimmed)) {
      sawTopLevelSkillEntry = true;
      currentSkillIndent = indent;
      return;
    }
    const inlineMatch = isTopLevelSkillEntry ? trimmed.match(/^[^:#][^:]*:\s*\[(.*)\]\s*$/) : null;
    if (inlineMatch) {
      sawTopLevelSkillEntry = true;
      const inner = String(inlineMatch[1] || '').trim();
      if (inner) return 'break:true';
      currentSkillIndent = indent;
      return;
    }
    if (isTopLevelSkillEntry && /^[^:#][^:]*:\s*$/.test(trimmed)) {
      sawTopLevelSkillEntry = true;
      currentSkillIndent = indent;
      return;
    }
    if (currentSkillIndent != null && indent > currentSkillIndent && /^-\s+/.test(trimmed)) {
      return 'break:true';
    }
    return 'break:true';
  });

  if (scan.explicitEmptyObject) return false;
  if (!scan.sawSection) return true;
  if (scan.lastResult === 'break:true') return true;
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
