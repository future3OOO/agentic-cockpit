import childProcess from 'node:child_process';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { readSkillOpsLogSummary } from './lib/skillops-log.mjs';

const LEARNED_BEGIN = '<!-- SKILLOPS:LEARNED:BEGIN -->';
const LEARNED_END = '<!-- SKILLOPS:LEARNED:END -->';
const SIMPLE_SKILL_KEY_RE = /^[A-Za-z0-9_-]+$/;
const SKILLOPS_SCHEMA_VERSION = 3;
const SKILLOPS_CAPABILITIES_VERSION = 4;
const SKILLOPS_CONTRACT_VERSION = 4;
const SUPPORTED_STATUSES = ['pending', 'queued', 'processed', 'skipped'];
const PROMOTION_STATUS_VALUES = ['queued', 'processed', 'skipped'];
const PROMOTION_PLAN_KIND = 'skillops-promotion-plan';
const PROMOTION_PLAN_VERSION = 2;
const DURABLE_PROMOTION_TARGET_KINDS = ['skill', 'archive'];
const RAW_LOGS_ROOT = '.codex/skill-ops/logs';
const PROMOTION_MODE_VALUES = ['learned_block', 'canonical_section'];
const LOG_PROMOTION_METADATA_KEYS = ['promotion_mode', 'target_file', 'target_section'];
const SECTION_MARKER_PREFIX = 'SKILLOPS:SECTION:';
const VALID_SECTION_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_LEARNED_DEFAULT = 30;

function normalizeRepoPathLocal(relPath) {
  return String(relPath || '').replace(/\\/g, '/').replace(/^\.\/+/, '').trim();
}

function validateRepoRelativePath(relPath, label) {
  const normalized = normalizeRepoPathLocal(relPath);
  if (!normalized) fail(`Invalid ${label}: path must be non-empty`);
  if (path.isAbsolute(normalized)) fail(`Invalid ${label} ${normalized}: paths must be repo-relative`);
  if (normalized === '.' || normalized.split('/').some((segment) => segment === '..')) {
    fail(`Invalid ${label} ${normalized}: path traversal is not allowed`);
  }
  return normalized;
}

function usage() {
  return [
    'SkillOps',
    '',
    'Usage:',
    '  node scripts/skillops.mjs capabilities --json',
    '  node scripts/skillops.mjs lint',
    '  node scripts/skillops.mjs log --title "..." [--skills a,b,c] [--skill-update skill:rule]...',
    '  node scripts/skillops.mjs debrief --title "..." [--skills a,b,c] [--skill-update skill:rule]...',
    '  node scripts/skillops.mjs distill [--dry-run] [--mark-empty-skipped] [--max-learned N]',
    '  node scripts/skillops.mjs plan-promotions [--max-learned N] --json',
    '  node scripts/skillops.mjs apply-promotions --plan /abs/path/to/plan.json [--json]',
    '  node scripts/skillops.mjs payload-files --plan /abs/path/to/plan.json [--json]',
    '  node scripts/skillops.mjs mark-promoted --plan /abs/path/to/plan.json --status queued|processed|skipped [--promotion-task-id id]',
    '',
    'Notes:',
    '  - plan-promotions auto-emits canonical_section items when logs declare promotion metadata.',
    '  - payload-files reports the exact durable target files described by a promotion plan.',
    '',
  ].join('\n');
}

function fail(message) {
  throw new Error(message);
}

function warn(message) {
  process.stderr.write(`warn: ${message}\n`);
}

function run(cmd, args, opts = {}) {
  const res = childProcess.spawnSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  });
  if (res.error) throw res.error;
  return res;
}

function tryGit(repoRoot, args) {
  try {
    const res = run('git', args, { cwd: repoRoot });
    if (res.status !== 0) return '';
    return String(res.stdout || '').trim();
  } catch {
    return '';
  }
}

function getRepoRoot() {
  const cwd = process.cwd();
  const viaGit = tryGit(cwd, ['rev-parse', '--show-toplevel']);
  return viaGit || cwd;
}

function isoNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function idTimestamp(iso) {
  return iso.replace(/[-:]/g, '');
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function normalizeList(raw) {
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

function normalizeSingleLine(raw) {
  return String(raw || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeMaxLearned(raw, { label, fallbackToDefault = false } = {}) {
  const trimmed = typeof raw === 'string' ? raw.trim() : raw;
  if ((trimmed == null || trimmed === '') && fallbackToDefault) {
    return MAX_LEARNED_DEFAULT;
  }
  const value = typeof trimmed === 'number' ? trimmed : Number(trimmed);
  if (!Number.isInteger(value) || value < 5) {
    fail(`${label} must be a number >= 5 (got ${JSON.stringify(raw ?? 'unset')})`);
  }
  return value;
}

function parseMaxLearned(argv) {
  return normalizeMaxLearned(getArgValue(argv, '--max-learned'), {
    label: '--max-learned',
    fallbackToDefault: true,
  });
}

function resolvePlanMaxLearned(plan) {
  return normalizeMaxLearned(plan?.maxLearned, {
    label: 'plan.maxLearned',
  });
}

function isPlaceholderSkillUpdate(value) {
  return value === ['to', 'do'].join('');
}

function parseSkillUpdatesArg(argv) {
  const updates = new Map();

  function pushValue(raw) {
    const value = String(raw || '').trim();
    if (!value) fail('Missing value for --skill-update');
    const colonIndex = value.indexOf(':');
    if (colonIndex <= 0 || colonIndex === value.length - 1) {
      fail(`Invalid --skill-update ${JSON.stringify(value)} (expected skill:rule)`);
    }
    const skill = value.slice(0, colonIndex).trim();
    const rule = normalizeSingleLine(value.slice(colonIndex + 1));
    if (!skill || !rule) {
      fail(`Invalid --skill-update ${JSON.stringify(value)} (expected skill:rule)`);
    }
    const arr = updates.get(skill) || [];
    arr.push(rule);
    updates.set(skill, arr);
  }

  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === '--skill-update') {
      const next = argv[i + 1];
      if (!next) fail('Missing value for --skill-update');
      i += 1;
      pushValue(next);
      continue;
    }
    if (value.startsWith('--skill-update=')) {
      pushValue(value.slice('--skill-update='.length));
    }
  }

  return updates;
}

function encodeSkillUpdateKey(skill) {
  const value = String(skill || '').trim();
  if (!value) fail('Invalid empty skill name in skill_updates');
  return SIMPLE_SKILL_KEY_RE.test(value) ? value : JSON.stringify(value);
}

function decodeSkillUpdateKey(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/\\'/g, "'");
  }
  return value;
}

function buildSkillUpdatesLines(skills, updatesBySkill) {
  const allSkills = Array.from(new Set([...skills, ...updatesBySkill.keys()]));
  if (!allSkills.length) {
    return { skills: [], lines: ['skill_updates: {}'] };
  }

  const lines = ['skill_updates:'];
  for (const skill of allSkills) {
    const updates = updatesBySkill.get(skill) || [];
    const key = encodeSkillUpdateKey(skill);
    if (!updates.length) {
      lines.push(`  ${key}: []`);
      continue;
    }
    lines.push(`  ${key}:`);
    for (const update of updates) {
      lines.push(`    - ${JSON.stringify(update)}`);
    }
  }
  return { skills: allSkills, lines };
}

function getArgValue(argv, key) {
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === key) return argv[i + 1];
    if (value.startsWith(`${key}=`)) return value.slice(key.length + 1);
  }
  return null;
}

function hasFlag(argv, key) {
  return argv.includes(key);
}

async function collectFilesRecursive(root, { maxDepth, includeFile }) {
  const out = [];

  async function walk(dir, depth = 0) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      if (entry.isFile() && includeFile(entry.name, full)) out.push(full);
    }
  }

  await walk(root, 0);
  out.sort();
  return out;
}

async function listSkillFiles(skillsRoot) {
  return collectFilesRecursive(skillsRoot, {
    maxDepth: 2,
    includeFile: (name, full) => {
      if (name !== 'SKILL.md') return false;
      const rel = path.relative(skillsRoot, full);
      if (!rel || rel.startsWith('..')) return false;
      const parts = rel.split(path.sep).filter(Boolean);
      return parts.length === 2 && parts[1] === 'SKILL.md';
    },
  });
}

function parseFrontmatter(contents) {
  const lines = String(contents || '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return null;
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') {
      end = i;
      break;
    }
  }
  if (end < 0) return null;
  return {
    lines,
    frontmatterLines: lines.slice(1, end),
    bodyLines: lines.slice(end + 1),
    endLine: end,
  };
}

function parseSimpleYaml(frontmatterLines) {
  const result = {};
  for (const raw of frontmatterLines) {
    const line = String(raw || '').trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    let value = match[2].trim();
    value = value.replace(/^["']|["']$/g, '');
    result[key] = value;
  }
  return result;
}

function stripSourceTag(text) {
  return String(text || '').replace(/\s*\[src:[^\]]+\]\s*$/, '').trim();
}

function normalizePromotionMode(value) {
  const mode = String(value || '').trim();
  return mode || 'learned_block';
}

function classifyPromotionTarget(relativePath) {
  const rel = normalizeRepoPathLocal(relativePath);
  const parts = rel.split('/').filter(Boolean);
  if (
    parts.length === 4 &&
    parts[0] === '.codex' &&
    parts[1] === 'skills' &&
    parts[2] &&
    parts[3] === 'SKILL.md'
  ) {
    return 'skill';
  }
  if (
    parts.length === 4 &&
    parts[0] === '.codex' &&
    parts[1] === 'skill-ops' &&
    parts[2] === 'archive' &&
    parts[3].endsWith('.md')
  ) {
    return 'archive';
  }
  return '';
}

function resolvePromotionTargetPath(repoRoot, rawPath, fieldName, expectedKind = '') {
  const relativePath = validateRepoRelativePath(rawPath, fieldName);
  if (relativePath.startsWith(`${RAW_LOGS_ROOT}/`) || relativePath.startsWith('.codex/quality/')) {
    fail(`${fieldName} must not target raw SkillOps logs or .codex/quality: ${relativePath}`);
  }
  const kind = classifyPromotionTarget(relativePath);
  if (!kind) {
    fail(`${fieldName} must target .codex/skills/*/SKILL.md or .codex/skill-ops/archive/*.md: ${relativePath}`);
  }
  if (expectedKind && kind !== expectedKind) {
    fail(`${fieldName} must target a ${expectedKind} file: ${relativePath}`);
  }
  return {
    kind,
    path: path.resolve(repoRoot, relativePath),
    relativePath,
  };
}

function buildSkillArchivePath(skillName) {
  return normalizeRepoPathLocal(path.join('.codex', 'skill-ops', 'archive', `${skillName}.md`));
}

function resolveCanonicalSectionMarkers(sectionId, fieldName = 'targetSection') {
  const normalized = String(sectionId || '').trim();
  if (!VALID_SECTION_ID_RE.test(normalized)) {
    fail(`Promotion plan ${fieldName} must match ${VALID_SECTION_ID_RE.toString()}: ${JSON.stringify(sectionId)}`);
  }
  return {
    id: normalized,
    begin: `<!-- ${SECTION_MARKER_PREFIX}${normalized}:BEGIN -->`,
    end: `<!-- ${SECTION_MARKER_PREFIX}${normalized}:END -->`,
  };
}

function assertCanonicalSectionMarkersExist(contents, sectionId, fieldName = 'targetSection', targetFile = null) {
  const markers = resolveCanonicalSectionMarkers(sectionId, fieldName);
  const beginIdx = contents.indexOf(markers.begin);
  const endIdx = contents.indexOf(markers.end);
  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) {
    if (targetFile) fail(`${fieldName}: canonical section markers for '${markers.id}' not found in ${targetFile}`);
    fail(`SkillOps canonical section markers are malformed or missing for ${markers.id}.`);
  }
  return { markers, beginIdx, endIdx };
}

function collectExistingBulletLines(blockContents) {
  return blockContents
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .filter((line) => /^[ \t]*- /.test(line));
}

function canonicalBulletKey(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed.startsWith('- ')) return null;
  return stripSourceTag(trimmed.slice(2));
}

function inferCanonicalSectionIndentation(contents, beginIdx, existingBulletLines) {
  const existingIndent = existingBulletLines[0]?.match(/^([ \t]*)- /)?.[1];
  if (existingIndent !== undefined) return existingIndent;
  const lineStart = contents.lastIndexOf('\n', Math.max(0, beginIdx - 1));
  const indent = contents.slice(lineStart === -1 ? 0 : lineStart + 1, beginIdx);
  return /^[ \t]*$/.test(indent) ? indent : '';
}

function prependUniqueBulletLines(existingBulletLines, newBulletLines) {
  const existingKeys = new Set(existingBulletLines.map(canonicalBulletKey).filter(Boolean));
  const uniqueNew = [];
  for (const line of newBulletLines) {
    const rawLine = String(line || '').trimEnd();
    const key = canonicalBulletKey(rawLine);
    if (!key || existingKeys.has(key)) continue;
    existingKeys.add(key);
    uniqueNew.push(rawLine);
  }
  return [...uniqueNew, ...existingBulletLines];
}

function buildCanonicalBulletLines(item, index) {
  const additions = Array.isArray(item.additions) ? item.additions : [];
  const lines = [];
  const seen = new Set();
  for (const entry of additions) {
    if (!entry || typeof entry !== 'object') continue;
    const text = normalizeSingleLine(String(entry.text || ''));
    if (!text) continue;
    const key = stripSourceTag(text);
    if (seen.has(key)) continue;
    seen.add(key);
    const logId = normalizeSingleLine(String(entry.logId || ''));
    lines.push(logId ? `- ${text} [src:${logId}]` : `- ${text}`);
  }
  if (lines.length === 0) {
    fail(`Promotion plan item[${index}] canonical_section requires additions[]`);
  }
  return lines;
}

function updateCanonicalSectionBlock(contents, { sectionId, bulletLines }) {
  const { markers, beginIdx, endIdx } = assertCanonicalSectionMarkersExist(contents, sectionId);
  const before = contents.slice(0, beginIdx + markers.begin.length);
  const middle = contents.slice(beginIdx + markers.begin.length, endIdx);
  const after = contents.slice(endIdx);
  const existingBulletLines = collectExistingBulletLines(middle);
  const sectionIndent = inferCanonicalSectionIndentation(contents, beginIdx, existingBulletLines);
  const indentedNewBulletLines = bulletLines.map((line) => {
    const trimmed = String(line || '').trim();
    return trimmed.startsWith('- ') ? `${sectionIndent}${trimmed}` : trimmed;
  });
  const combined = prependUniqueBulletLines(existingBulletLines, indentedNewBulletLines);
  const rewrittenMiddle = combined.length ? `\n${combined.join('\n')}\n${sectionIndent}` : `\n${sectionIndent}`;
  return `${before}${rewrittenMiddle}${after}`;
}

function ensureLearnedBlock(contents) {
  if (contents.includes(LEARNED_BEGIN) && contents.includes(LEARNED_END)) {
    return contents;
  }
  const suffix = ['', '## Learned heuristics (SkillOps)', LEARNED_BEGIN, LEARNED_END, ''].join('\n');
  return `${contents.trimEnd()}\n${suffix}`;
}

function updateLearnedBlock(contents, { additions, maxLearned }) {
  const updated = ensureLearnedBlock(contents);
  const beginIdx = updated.indexOf(LEARNED_BEGIN);
  const endIdx = updated.indexOf(LEARNED_END);
  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) {
    fail('SkillOps learned block markers are malformed.');
  }

  const before = updated.slice(0, beginIdx + LEARNED_BEGIN.length);
  const middle = updated.slice(beginIdx + LEARNED_BEGIN.length, endIdx);
  const after = updated.slice(endIdx);

  const existingLines = middle
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const existingBullets = existingLines
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2));
  const existingKeys = new Set(existingBullets.map((bullet) => stripSourceTag(bullet)));

  const newBulletLines = [];
  for (const add of additions) {
    const base = stripSourceTag(add.text);
    if (!base || existingKeys.has(base)) continue;
    existingKeys.add(base);
    newBulletLines.push(`- ${add.text} [src:${add.logId}]`);
  }

  const combined = [...newBulletLines, ...existingBullets.map((bullet) => `- ${bullet}`)];
  const kept = combined.slice(0, maxLearned);
  const overflow = combined.slice(maxLearned);
  const rewrittenMiddle = kept.length ? `\n${kept.join('\n')}\n` : '\n';
  return {
    nextContents: `${before}${rewrittenMiddle}${after}`,
    overflow,
  };
}

async function loadSkillsIndex(repoRoot) {
  const skillsRoot = path.join(repoRoot, '.codex', 'skills');
  const files = await listSkillFiles(skillsRoot);
  if (!files.length) fail(`No skills found under ${skillsRoot}`);

  const byName = new Map();
  const errors = [];
  for (const file of files) {
    const contents = await fs.readFile(file, 'utf8');
    const fmBlock = parseFrontmatter(contents);
    if (!fmBlock) {
      errors.push(`${file}: missing YAML frontmatter`);
      continue;
    }
    const fm = parseSimpleYaml(fmBlock.frontmatterLines);
    const name = String(fm.name || '').trim();
    const description = String(fm.description || '').trim();
    if (!name) errors.push(`${file}: missing frontmatter name`);
    if (!description) errors.push(`${file}: missing frontmatter description`);
    const dirName = path.basename(path.dirname(file));
    if (name && dirName !== name) {
      errors.push(`${file}: directory '${dirName}' must match frontmatter name '${name}'`);
    }
    if (name && byName.has(name)) {
      errors.push(`${file}: duplicate skill name '${name}'`);
    } else if (name) {
      byName.set(name, file);
    }
  }
  if (errors.length) fail(errors.join('\n'));
  return byName;
}

function parseLogMetadata(contents) {
  const fmBlock = parseFrontmatter(contents);
  if (!fmBlock) return null;
  const meta = {
    id: '',
    createdAt: '',
    status: '',
    processedAt: null,
    queuedAt: null,
    promotionTaskId: '',
    skills: [],
    skillUpdates: {},
    promotionMode: '',
    targetFile: '',
    targetSection: '',
    hasSkillUpdatesBlock: false,
  };

  function decodeSkillUpdateItem(item) {
    const value = String(item || '').trim();
    if (!value) return '';
    if (value.startsWith('"') && value.endsWith('"')) {
      try {
        return JSON.parse(value);
      } catch {
        // Fall through to legacy stripping.
      }
    }
    return value.replace(/^["']|["']$/g, '');
  }

  const lines = fmBlock.frontmatterLines;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = String(line || '').trim();
    if (!trimmed) {
      i += 1;
      continue;
    }
    if (trimmed.startsWith('id:')) {
      meta.id = trimmed.slice(3).trim().replace(/^["']|["']$/g, '');
      i += 1;
      continue;
    }
    if (trimmed.startsWith('created_at:')) {
      meta.createdAt = trimmed.slice('created_at:'.length).trim().replace(/^["']|["']$/g, '');
      i += 1;
      continue;
    }
    if (trimmed.startsWith('status:')) {
      meta.status = trimmed.slice('status:'.length).trim().replace(/^["']|["']$/g, '');
      i += 1;
      continue;
    }
    if (trimmed.startsWith('processed_at:')) {
      const raw = trimmed.slice('processed_at:'.length).trim().replace(/^["']|["']$/g, '');
      meta.processedAt = raw && raw !== 'null' ? raw : null;
      i += 1;
      continue;
    }
    if (trimmed.startsWith('queued_at:')) {
      const raw = trimmed.slice('queued_at:'.length).trim().replace(/^["']|["']$/g, '');
      meta.queuedAt = raw && raw !== 'null' ? raw : null;
      i += 1;
      continue;
    }
    if (trimmed.startsWith('promotion_task_id:')) {
      meta.promotionTaskId = trimmed
        .slice('promotion_task_id:'.length)
        .trim()
        .replace(/^["']|["']$/g, '');
      i += 1;
      continue;
    }
    if (trimmed.startsWith('promotion_mode:')) {
      meta.promotionMode = trimmed.slice('promotion_mode:'.length).trim().replace(/^["']|["']$/g, '');
      i += 1;
      continue;
    }
    if (trimmed.startsWith('target_file:')) {
      meta.targetFile = trimmed.slice('target_file:'.length).trim().replace(/^["']|["']$/g, '');
      i += 1;
      continue;
    }
    if (trimmed.startsWith('target_section:')) {
      meta.targetSection = trimmed.slice('target_section:'.length).trim().replace(/^["']|["']$/g, '');
      i += 1;
      continue;
    }
    if (trimmed === 'skills:') {
      i += 1;
      while (i < lines.length && /^\s*-\s+/.test(lines[i])) {
        meta.skills.push(String(lines[i]).replace(/^\s*-\s+/, '').trim().replace(/^["']|["']$/g, ''));
        i += 1;
      }
      continue;
    }
    if (trimmed === 'skill_updates:' || trimmed === 'skill_updates: {}') {
      meta.hasSkillUpdatesBlock = true;
      if (trimmed === 'skill_updates: {}') {
        i += 1;
        continue;
      }
      i += 1;
      while (i < lines.length) {
        const m = String(lines[i]).match(/^\s{2}((?:[A-Za-z0-9_-]+)|"(?:[^"\\]|\\.)+"|'(?:[^'\\]|\\.)+')\s*:\s*(.*)$/);
        if (!m) break;
        const skillName = decodeSkillUpdateKey(m[1]);
        const rhs = m[2].trim();
        meta.skillUpdates[skillName] = [];
        i += 1;
        if (rhs && rhs !== '[]' && rhs !== '{}') continue;
        while (i < lines.length && /^\s{4}-\s+/.test(lines[i])) {
          const update = decodeSkillUpdateItem(String(lines[i]).replace(/^\s{4}-\s+/, ''));
          if (update) meta.skillUpdates[skillName].push(update);
          i += 1;
        }
      }
      continue;
    }
    i += 1;
  }
  return meta;
}

function hasPromotionMetadata(meta) {
  return Boolean(
    normalizeSingleLine(String(meta?.promotionMode || '')) ||
      normalizeSingleLine(String(meta?.targetFile || '')) ||
      normalizeSingleLine(String(meta?.targetSection || '')),
  );
}

function collectPromotableSkillEntries(meta, logFile, byName) {
  const promotableEntries = [];
  for (const [skillName, updates] of Object.entries(meta.skillUpdates || {})) {
    if (!byName.has(skillName)) {
      fail(`${logFile}: skill_updates references unknown skill '${skillName}'`);
    }
    const sanitized = [];
    for (const update of updates || []) {
      const normalized = normalizeSingleLine(update);
      const collapsed = normalized.toLowerCase().replace(/\s+/g, '');
      if (!normalized || isPlaceholderSkillUpdate(collapsed)) continue;
      sanitized.push(normalized);
    }
    if (sanitized.length === 0) continue;
    promotableEntries.push({ skillName, updates: sanitized });
  }
  return promotableEntries;
}

function findSkillNameByPath(byName, targetPath) {
  const expected = path.resolve(targetPath);
  for (const [skillName, skillFile] of byName.entries()) {
    if (path.resolve(skillFile) === expected) return skillName;
  }
  return '';
}

function resolveLogPromotionDirective({ repoRoot, logFile, meta, promotableEntries, byName }) {
  const relativeLogPath = normalizeRepoPathLocal(path.relative(repoRoot, logFile));
  const promotionModeRaw = normalizeSingleLine(String(meta?.promotionMode || ''));
  const targetFileRaw = normalizeSingleLine(String(meta?.targetFile || ''));
  const targetSectionRaw = normalizeSingleLine(String(meta?.targetSection || ''));
  const hasTargetMetadata = Boolean(targetFileRaw || targetSectionRaw);

  if (!promotionModeRaw) {
    if (hasTargetMetadata) {
      fail(`${relativeLogPath}: target_file/target_section require promotion_mode`);
    }
    return { promotionMode: 'learned_block' };
  }
  if (!PROMOTION_MODE_VALUES.includes(promotionModeRaw)) {
    fail(
      `${relativeLogPath}: promotion_mode must be one of ${PROMOTION_MODE_VALUES.join('|')} (got ${JSON.stringify(promotionModeRaw)})`,
    );
  }
  const promotionMode = normalizePromotionMode(promotionModeRaw);
  if (promotionMode === 'learned_block') {
    if (hasTargetMetadata) fail(`${relativeLogPath}: learned_block logs must not set target_file/target_section`);
    return { promotionMode };
  }
  if (promotableEntries.length !== 1) {
    fail(`${relativeLogPath}: promotion_mode=canonical_section requires exactly one skill_updates entry with non-empty updates`);
  }
  if (!targetFileRaw || !targetSectionRaw) {
    fail(`${relativeLogPath}: promotion_mode=canonical_section requires target_file and target_section`);
  }
  const target = resolvePromotionTargetPath(repoRoot, targetFileRaw, `${relativeLogPath} target_file`, 'skill');
  let targetContents = '';
  try {
    targetContents = readFileSync(target.path, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') fail(`${relativeLogPath}: target_file not found: ${target.relativePath}`);
    fail(`${relativeLogPath}: unable to read target_file ${target.relativePath}: ${err?.message || String(err)}`);
  }
  assertCanonicalSectionMarkersExist(
    targetContents,
    targetSectionRaw,
    `${relativeLogPath} target_section`,
    target.relativePath,
  );
  const targetSkillName = findSkillNameByPath(byName, target.path) || path.basename(path.dirname(target.path));
  const sourceSkillName = promotableEntries[0].skillName;
  if (sourceSkillName !== targetSkillName) {
    fail(
      `${relativeLogPath}: promotion_mode=canonical_section target_file skill '${targetSkillName}' must match the lone skill_updates key '${sourceSkillName}'`,
    );
  }
  return {
    promotionMode,
    targetFile: target.relativePath,
    targetSection: resolveCanonicalSectionMarkers(targetSectionRaw, `${relativeLogPath} target_section`).id,
    targetSkillName,
  };
}

function upsertFrontmatterKey(contents, key, valueLiteral) {
  const block = parseFrontmatter(contents);
  if (!block) fail('Log missing YAML frontmatter');
  const lines = block.lines.slice();
  for (let i = 1; i < block.endLine; i += 1) {
    const trimmed = lines[i].trimStart();
    if (!trimmed.startsWith(`${key}:`)) continue;
    const indent = lines[i].match(/^(\s*)/)?.[1] || '';
    lines[i] = `${indent}${key}: ${valueLiteral}`;
    return lines.join('\n');
  }
  lines.splice(block.endLine, 0, `${key}: ${valueLiteral}`);
  return lines.join('\n');
}

async function listSkillOpsLogs(repoRoot) {
  const root = path.join(repoRoot, '.codex', 'skill-ops', 'logs');
  return collectFilesRecursive(root, {
    maxDepth: 5,
    includeFile: (name) => name.endsWith('.md') && name.toLowerCase() !== 'readme.md',
  });
}

function buildCapabilities() {
  return {
    kind: 'skillops-capabilities',
    version: SKILLOPS_CAPABILITIES_VERSION,
    schemaVersion: SKILLOPS_SCHEMA_VERSION,
    skillopsContractVersion: SKILLOPS_CONTRACT_VERSION,
    statuses: SUPPORTED_STATUSES.slice(),
    distillMode: 'non_durable',
    plan: {
      kind: PROMOTION_PLAN_KIND,
      schemaVersion: SKILLOPS_SCHEMA_VERSION,
      version: PROMOTION_PLAN_VERSION,
      durableTargetKinds: DURABLE_PROMOTION_TARGET_KINDS.slice(),
      durableTargetGlobs: ['.codex/skills/*/SKILL.md', '.codex/skill-ops/archive/*.md'],
      sourceLogsRoot: RAW_LOGS_ROOT,
      checkoutScopedMarkPromoted: true,
      markStatuses: PROMOTION_STATUS_VALUES.slice(),
      promotionModes: PROMOTION_MODE_VALUES.slice(),
      logMetadataKeys: LOG_PROMOTION_METADATA_KEYS.slice(),
      canonicalSectionMarkerPrefix: SECTION_MARKER_PREFIX,
    },
    commands: {
      capabilities: { json: true, writes: 'none' },
      lint: { json: false, writes: 'none' },
      log: { json: false, writes: 'raw_logs', requiredFlags: ['--title'], optionalFlags: ['--skills', '--skill-update'] },
      debrief: { json: false, writes: 'raw_logs', requiredFlags: ['--title'], optionalFlags: ['--skills', '--skill-update'] },
      distill: {
        json: false,
        writes: 'non_durable_local',
        optionalFlags: ['--dry-run', '--mark-empty-skipped', '--max-learned'],
      },
      'plan-promotions': { json: true, writes: 'none', optionalFlags: ['--max-learned'] },
      'apply-promotions': { json: true, writes: 'durable_targets', requiredFlags: ['--plan'], optionalFlags: ['--json'] },
      'payload-files': { json: true, writes: 'none', requiredFlags: ['--plan'], optionalFlags: ['--json'] },
      'mark-promoted': { json: false, writes: 'raw_logs', requiredFlags: ['--plan', '--status'], optionalFlags: ['--promotion-task-id'] },
    },
  };
}

function getNormalizedLogId(meta, logFile) {
  const logId = String(meta?.id || '').trim();
  if (!logId) fail(`${logFile}: missing id`);
  return logId;
}

async function buildPromotionPlan(repoRoot, { maxLearned = MAX_LEARNED_DEFAULT } = {}) {
  const byName = await loadSkillsIndex(repoRoot);
  const logs = await listSkillOpsLogs(repoRoot);
  const learnedAdditionsBySkill = new Map();
  const canonicalGroups = new Map();
  const sourceLogsByPath = new Map();
  const skippableLogIds = [];
  let pendingLogsCount = 0;
  let missingSkillUpdatesCount = 0;
  let emptySkillUpdatesCount = 0;

  for (const logFile of logs) {
    const contents = await fs.readFile(logFile, 'utf8');
    const meta = parseLogMetadata(contents);
    if (!meta) fail(`${logFile}: missing or malformed YAML frontmatter`);
    const summary = readSkillOpsLogSummary(contents);
    if (!summary) fail(`${logFile}: unreadable SkillOps frontmatter`);
    if (!meta.createdAt) fail(`${logFile}: missing created_at`);
    const status = summary.status;
    if (!status || !SUPPORTED_STATUSES.includes(status)) fail(`${logFile}: invalid normalized status '${status || ''}'`);
    if (status !== 'pending') continue;
    pendingLogsCount += 1;

    if (!meta.hasSkillUpdatesBlock) {
      if (hasPromotionMetadata(meta)) fail(`${logFile}: promotion metadata requires a non-empty skill_updates block`);
      if (summary.hasMeaningfulBody) fail(`${logFile}: pending SkillOps log has meaningful body but no promotable skill_updates`);
      missingSkillUpdatesCount += 1;
      skippableLogIds.push(getNormalizedLogId(meta, logFile));
      continue;
    }

    const promotableEntries = collectPromotableSkillEntries(meta, logFile, byName);
    if (promotableEntries.length === 0) {
      if (hasPromotionMetadata(meta)) fail(`${logFile}: promotion metadata requires at least one non-placeholder skill update`);
      if (summary.hasMeaningfulBody) fail(`${logFile}: pending SkillOps log has meaningful body but no promotable skill_updates`);
      emptySkillUpdatesCount += 1;
      skippableLogIds.push(getNormalizedLogId(meta, logFile));
      continue;
    }

    const promotion = resolveLogPromotionDirective({
      repoRoot,
      logFile,
      meta,
      promotableEntries,
      byName,
    });

    const sourceLogEntry = {
      path: logFile,
      relativePath: normalizeRepoPathLocal(path.relative(repoRoot, logFile)),
      id: getNormalizedLogId(meta, logFile),
      status,
      createdAt: meta.createdAt || null,
    };
    sourceLogsByPath.set(logFile, sourceLogEntry);

    if (promotion.promotionMode === 'canonical_section') {
      const key = `${promotion.targetFile}#${promotion.targetSection}`;
      const group = canonicalGroups.get(key) || {
        skill: promotion.targetSkillName,
        targetFile: promotion.targetFile,
        targetSection: promotion.targetSection,
        additions: [],
      };
      for (const text of promotableEntries[0].updates) {
        group.additions.push({ text, logId: sourceLogEntry.id, createdAt: meta.createdAt || null });
      }
      canonicalGroups.set(key, group);
      continue;
    }

    for (const entry of promotableEntries) {
      const arr = learnedAdditionsBySkill.get(entry.skillName) || [];
      for (const text of entry.updates) {
        arr.push({ text, logId: sourceLogEntry.id, createdAt: meta.createdAt || null });
      }
      learnedAdditionsBySkill.set(entry.skillName, arr);
    }
  }

  const items = [];
  const targets = [];
  let additionsCount = 0;

  for (const skillName of Array.from(learnedAdditionsBySkill.keys()).sort()) {
    const additions = learnedAdditionsBySkill.get(skillName) || [];
    additions.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    const skillPath = byName.get(skillName);
    const current = await fs.readFile(skillPath, 'utf8');
    const { nextContents, overflow } = updateLearnedBlock(current, { additions, maxLearned });
    const targetFile = normalizeRepoPathLocal(path.relative(repoRoot, skillPath));
    const archiveFile = overflow.length > 0 ? buildSkillArchivePath(skillName) : null;
    additionsCount += additions.length;
    items.push({
      promotionMode: 'learned_block',
      skill: skillName,
      targetFile,
      archiveFile,
      additions: additions.map(({ text, logId, createdAt }) => ({ text, logId, createdAt })),
      overflowBullets: overflow.map((line) => line.replace(/^- /, '')),
      nextContents,
    });
    targets.push({ kind: 'skill', path: targetFile });
    if (archiveFile) targets.push({ kind: 'archive', path: archiveFile });
  }

  for (const key of Array.from(canonicalGroups.keys()).sort()) {
    const group = canonicalGroups.get(key);
    group.additions.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    additionsCount += group.additions.length;
    items.push({
      skill: group.skill,
      targetFile: group.targetFile,
      targetSection: group.targetSection,
      promotionMode: 'canonical_section',
      additions: group.additions.map(({ text, logId, createdAt }) => ({ text, logId, createdAt })),
      overflowBullets: [],
    });
    targets.push({ kind: 'skill', path: group.targetFile });
  }

  const uniqueTargets = [];
  const seenTargetKeys = new Set();
  for (const target of targets) {
    const key = `${target.kind}:${target.path}`;
    if (seenTargetKeys.has(key)) continue;
    seenTargetKeys.add(key);
    uniqueTargets.push(target);
  }

  return {
    kind: PROMOTION_PLAN_KIND,
    version: PROMOTION_PLAN_VERSION,
    schemaVersion: SKILLOPS_SCHEMA_VERSION,
    generatedAt: isoNow(),
    sourceRepoRoot: repoRoot,
    maxLearned,
    summary: {
      pendingLogsCount,
      promotableLogsCount: sourceLogsByPath.size,
      missingSkillUpdatesCount,
      emptySkillUpdatesCount,
      skillsToUpdate: items.length,
      additionsCount,
    },
    sourceLogs: Array.from(sourceLogsByPath.values()).sort((a, b) => String(a.relativePath).localeCompare(String(b.relativePath))),
    targets: uniqueTargets,
    items,
    skippableLogIds: Array.from(new Set(skippableLogIds)).sort((a, b) => a.localeCompare(b)),
  };
}

function validatePlanTargets(repoRoot, plan) {
  const uniqueTargets = new Map();
  for (const [index, target] of (plan.targets || []).entries()) {
    if (!target || typeof target !== 'object') fail(`Promotion plan target[${index}] must be an object`);
    const kind = String(target.kind || '').trim();
    if (!DURABLE_PROMOTION_TARGET_KINDS.includes(kind)) {
      fail(`Promotion plan target[${index}] has invalid kind ${JSON.stringify(target.kind)}`);
    }
    const resolved = resolvePromotionTargetPath(repoRoot, target.path, `targets[${index}].path`, kind);
    uniqueTargets.set(`${resolved.kind}:${resolved.relativePath}`, resolved);
  }
  return Array.from(uniqueTargets.values());
}

function normalizePlanAdditions(item, index) {
  if (!Array.isArray(item.additions) || item.additions.length === 0) {
    fail(`Promotion plan item[${index}] requires additions[]`);
  }
  return item.additions.map((entry, entryIndex) => {
    if (!entry || typeof entry !== 'object') {
      fail(`Promotion plan item[${index}].additions[${entryIndex}] must be an object`);
    }
    const text = normalizeSingleLine(String(entry.text || ''));
    const logId = normalizeSingleLine(String(entry.logId || ''));
    const createdAt = normalizeSingleLine(String(entry.createdAt || '')) || null;
    if (!text) fail(`Promotion plan item[${index}].additions[${entryIndex}] is missing text`);
    if (!logId) fail(`Promotion plan item[${index}].additions[${entryIndex}] is missing logId`);
    return { text, logId, createdAt };
  });
}

function collectPayloadTargets(repoRoot, plan) {
  return validatePlanTargets(repoRoot, plan).map((entry) => entry.relativePath).sort();
}

async function appendArchiveEntries(archivePath, skillName, bullets) {
  const normalizedBullets = Array.from(new Set(bullets.map((bullet) => normalizeSingleLine(bullet)).filter(Boolean)));
  if (normalizedBullets.length === 0) return false;
  await fs.mkdir(path.dirname(archivePath), { recursive: true });
  const header = `# Archive: ${skillName}\n\n`;
  const body = normalizedBullets.map((bullet) => `- ${bullet}`).join('\n') + '\n';
  try {
    const existing = await fs.readFile(archivePath, 'utf8');
    const existingBullets = new Set(
      existing
        .split(/\r?\n/)
        .map((line) => line.match(/^\s*-\s+(.*)\s*$/)?.[1] || '')
        .map((line) => normalizeSingleLine(line))
        .filter(Boolean),
    );
    const newBullets = normalizedBullets.filter((bullet) => !existingBullets.has(bullet));
    if (newBullets.length === 0) return false;
    await fs.writeFile(archivePath, `${existing.trimEnd()}\n${newBullets.map((bullet) => `- ${bullet}`).join('\n')}\n`, 'utf8');
    return true;
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
    await fs.writeFile(archivePath, header + body, 'utf8');
    return true;
  }
}

async function preparePromotionWrites(repoRoot, plan) {
  const validatedTargets = validatePlanTargets(repoRoot, plan);
  const writes = [];
  const pendingContents = new Map();
  const effectiveTargets = new Set();
  const maxLearned = resolvePlanMaxLearned(plan);

  for (const [index, item] of (plan.items || []).entries()) {
    const target = resolvePromotionTargetPath(repoRoot, item.targetFile, `items[${index}].targetFile`, 'skill');
    const promotionMode = normalizePromotionMode(item.promotionMode);
    const skillName = normalizeSingleLine(String(item.skill || '')) || path.basename(path.dirname(target.path));
    effectiveTargets.add(target.relativePath);
    if (promotionMode === 'canonical_section') {
      const bulletLines = buildCanonicalBulletLines(item, index);
      let current = pendingContents.get(target.path);
      if (current === undefined) current = await fs.readFile(target.path, 'utf8');
      const nextContents = updateCanonicalSectionBlock(current, {
        sectionId: resolveCanonicalSectionMarkers(item.targetSection, `items[${index}].targetSection`).id,
        bulletLines,
      });
      pendingContents.set(target.path, nextContents);
      writes.push({ targetPath: target.path, nextContents, overflowBullets: [], archivePath: null, skillName });
      continue;
    }

    const additions = normalizePlanAdditions(item, index);
    let current = pendingContents.get(target.path);
    if (current === undefined) current = await fs.readFile(target.path, 'utf8');
    const { nextContents, overflow } = updateLearnedBlock(current, {
      additions,
      maxLearned,
    });
    pendingContents.set(target.path, nextContents);
    let archivePath = null;
    if (overflow.length > 0) {
      if (!String(item.archiveFile || '').trim()) {
        fail(`Promotion plan item[${index}] learned_block overflow requires archiveFile`);
      }
      archivePath = resolvePromotionTargetPath(repoRoot, item.archiveFile, `items[${index}].archiveFile`, 'archive').path;
    }
    if (archivePath) effectiveTargets.add(normalizeRepoPathLocal(path.relative(repoRoot, archivePath)));
    writes.push({
      targetPath: target.path,
      nextContents,
      overflowBullets: overflow.map((line) => line.replace(/^- /, '')),
      archivePath,
      skillName,
    });
  }

  return { writes, targetCount: effectiveTargets.size, payloadFiles: Array.from(effectiveTargets).sort() };
}

async function applyPreparedPromotionWrites(prepared) {
  let archiveUpdates = 0;
  for (const write of prepared.writes) {
    await fs.mkdir(path.dirname(write.targetPath), { recursive: true });
    await fs.writeFile(write.targetPath, write.nextContents, 'utf8');
    if (!write.archivePath || write.overflowBullets.length === 0) continue;
    const updated = await appendArchiveEntries(write.archivePath, write.skillName, write.overflowBullets);
    if (updated) archiveUpdates += 1;
  }
  return archiveUpdates;
}

function validatePlan(repoRoot, plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) fail('Invalid SkillOps plan: expected object');
  if (String(plan.kind || '') !== PROMOTION_PLAN_KIND) fail(`Invalid SkillOps plan kind ${JSON.stringify(plan.kind)}`);
  if (Number(plan.version) !== PROMOTION_PLAN_VERSION) fail(`Invalid SkillOps plan version ${JSON.stringify(plan.version)}`);
  if (Number(plan.schemaVersion) !== SKILLOPS_SCHEMA_VERSION) {
    fail(`Invalid SkillOps plan schemaVersion ${JSON.stringify(plan.schemaVersion)}`);
  }
  if (!Array.isArray(plan.sourceLogs)) fail('Invalid SkillOps plan: missing sourceLogs[]');
  if (!Array.isArray(plan.targets)) fail('Invalid SkillOps plan: missing targets[]');
  if (!Array.isArray(plan.items)) fail('Invalid SkillOps plan: missing items[]');
  const maxLearned = resolvePlanMaxLearned(plan);

  const sourceLogIdSet = new Set();
  const sourceLogs = plan.sourceLogs.map((entry, index) => {
    if (!entry || typeof entry !== 'object') fail(`Promotion plan sourceLogs[${index}] must be an object`);
    const relativePath = validateRepoRelativePath(entry.relativePath, `sourceLogs[${index}].relativePath`);
    if (!relativePath.startsWith(`${RAW_LOGS_ROOT}/`)) {
      fail(`Promotion plan sourceLogs[${index}] must stay under ${RAW_LOGS_ROOT}: ${relativePath}`);
    }
    const id = String(entry.id || '').trim();
    if (!id) fail(`Promotion plan sourceLogs[${index}] is missing id`);
    if (sourceLogIdSet.has(id)) {
      fail(`Promotion plan sourceLogs contains duplicate id ${id}`);
    }
    sourceLogIdSet.add(id);
    return {
      path: String(entry.path || '').trim(),
      relativePath,
      id,
      status: String(entry.status || '').trim(),
      createdAt: String(entry.createdAt || '').trim() || null,
    };
  });
  const sourceLogIds = new Set(sourceLogs.map((entry) => entry.id));
  const skippableLogIds = Array.isArray(plan.skippableLogIds)
    ? Array.from(new Set(plan.skippableLogIds.map((value) => String(value || '').trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b))
    : [];
  const validatedTargets = validatePlanTargets(repoRoot, plan);
  const targetKeys = new Set(validatedTargets.map((entry) => `${entry.kind}:${entry.relativePath}`));

  const referencedTargetKeys = new Set();
  const referencedLogIds = new Set();
  for (const [index, item] of plan.items.entries()) {
    if (!item || typeof item !== 'object') fail(`Promotion plan item[${index}] must be an object`);
    const target = resolvePromotionTargetPath(repoRoot, item.targetFile, `items[${index}].targetFile`, 'skill');
    if (!targetKeys.has(`skill:${target.relativePath}`)) {
      fail(`Promotion plan item[${index}] targetFile is not declared in targets[]: ${target.relativePath}`);
    }
    referencedTargetKeys.add(`skill:${target.relativePath}`);
    const mode = normalizePromotionMode(item.promotionMode);
    if (!PROMOTION_MODE_VALUES.includes(mode)) {
      fail(`Promotion plan item[${index}] has invalid promotionMode ${JSON.stringify(item.promotionMode)}`);
    }
    const additions = normalizePlanAdditions(item, index);
    for (const addition of additions) {
      if (!sourceLogIds.has(addition.logId)) {
        fail(`Promotion plan item[${index}] references unknown source log id ${addition.logId}`);
      }
      referencedLogIds.add(addition.logId);
    }
    if (mode === 'canonical_section') {
      if (!String(item.targetSection || '').trim()) {
        fail(`Promotion plan item[${index}] canonical_section is missing targetSection`);
      }
    } else {
      if (String(item.archiveFile || '').trim()) {
        const archiveTarget = resolvePromotionTargetPath(repoRoot, item.archiveFile, `items[${index}].archiveFile`, 'archive');
        if (!targetKeys.has(`archive:${archiveTarget.relativePath}`)) {
          fail(`Promotion plan item[${index}] archiveFile is not declared in targets[]: ${archiveTarget.relativePath}`);
        }
        referencedTargetKeys.add(`archive:${archiveTarget.relativePath}`);
      }
    }
  }
  for (const target of validatedTargets) {
    const key = `${target.kind}:${target.relativePath}`;
    if (!referencedTargetKeys.has(key)) {
      fail(`Promotion plan target is not referenced by any item: ${target.relativePath}`);
    }
  }
  for (const sourceLog of sourceLogs) {
    if (!referencedLogIds.has(sourceLog.id)) {
      fail(`Promotion plan sourceLogs summary entry is not referenced by any promotion item: ${sourceLog.relativePath}`);
    }
  }
  return {
    ...plan,
    maxLearned,
    sourceLogs,
    targets: validatedTargets.map((entry) => ({ kind: entry.kind, path: entry.relativePath })),
    skippableLogIds,
  };
}

async function readPlanFile(repoRoot, planPath) {
  const rawPlanPath = String(planPath || '').trim();
  if (!rawPlanPath) fail('Missing --plan path');
  const resolved = path.isAbsolute(rawPlanPath) ? rawPlanPath : path.resolve(process.cwd(), rawPlanPath);
  const raw = await fs.readFile(resolved, 'utf8');
  return {
    planPath: resolved,
    plan: validatePlan(repoRoot, JSON.parse(raw)),
  };
}

async function loadPlanSourceLogs({ repoRoot, plan, allowedLogIds, includeAllLogs = false }) {
  const allowed = new Set(allowedLogIds);
  const out = [];
  const seenIds = new Map();
  const entries = includeAllLogs
    ? (await listSkillOpsLogs(repoRoot)).map((file) => ({
        relativePath: normalizeRepoPathLocal(path.relative(repoRoot, file)),
        path: file,
      }))
    : (plan.sourceLogs || []);
  for (const entry of entries) {
    const relPath = includeAllLogs ? entry.relativePath : entry.relativePath;
    const absPath = includeAllLogs ? entry.path : path.resolve(repoRoot, relPath);
    const contents = await fs.readFile(absPath, 'utf8');
    const summary = readSkillOpsLogSummary(contents);
    if (!summary || !summary.id) fail(`${relPath}: malformed SkillOps log`);
    if (!allowed.has(summary.id)) continue;
    seenIds.set(summary.id, (seenIds.get(summary.id) || 0) + 1);
    out.push({ absPath, relPath, contents, summary });
  }
  for (const allowedLogId of allowed) {
    const matchCount = seenIds.get(allowedLogId) || 0;
    if (matchCount !== 1) fail(`SkillOps plan must resolve log id ${allowedLogId} exactly once (got ${matchCount})`);
  }
  return out;
}

async function cmdCapabilities(argv) {
  if (!hasFlag(argv, '--json')) fail('capabilities requires --json');
  process.stdout.write(`${JSON.stringify(buildCapabilities())}\n`);
}

async function cmdLint(repoRoot) {
  const byName = await loadSkillsIndex(repoRoot);
  const errors = [];
  for (const [, file] of byName.entries()) {
    const contents = await fs.readFile(file, 'utf8');
    if (!contents.includes(LEARNED_BEGIN) || !contents.includes(LEARNED_END)) {
      errors.push(`${file}: missing ${LEARNED_BEGIN}/${LEARNED_END}`);
    }
    if (contents.indexOf(LEARNED_END) < contents.indexOf(LEARNED_BEGIN)) {
      errors.push(`${file}: learned markers are out of order`);
    }
  }

  const logs = await listSkillOpsLogs(repoRoot);
  for (const file of logs) {
    const contents = await fs.readFile(file, 'utf8');
    const meta = parseLogMetadata(contents);
    const summary = readSkillOpsLogSummary(contents);
    if (!meta || !summary) {
      errors.push(`${file}: missing or malformed YAML frontmatter`);
      continue;
    }
    if (!meta.id) errors.push(`${file}: missing id`);
    if (!meta.createdAt) errors.push(`${file}: missing created_at`);
    if (!summary.rawStatus) errors.push(`${file}: missing status`);
    if (!summary.status || !SUPPORTED_STATUSES.includes(summary.status)) {
      errors.push(`${file}: invalid status '${summary.rawStatus || summary.status || ''}'`);
    }
    if (summary.status === 'queued') {
      if (!summary.queuedAt) errors.push(`${file}: queued log must include queued_at`);
      if (!summary.promotionTaskId) errors.push(`${file}: queued log must include promotion_task_id`);
    } else {
      if (summary.queuedAt) errors.push(`${file}: non-queued log must not include queued_at`);
      if (summary.promotionTaskId) errors.push(`${file}: non-queued log must not include promotion_task_id`);
    }
    if ((summary.status === 'processed' || summary.status === 'skipped') && !summary.processedAt) {
      errors.push(`${file}: ${summary.status} log must include processed_at`);
    }
    for (const skillName of meta.skills) {
      if (!byName.has(skillName)) errors.push(`${file}: unknown skill '${skillName}'`);
    }
    for (const skillName of Object.keys(meta.skillUpdates || {})) {
      if (!byName.has(skillName)) errors.push(`${file}: skill_updates references unknown skill '${skillName}'`);
    }
    const promotableEntries = collectPromotableSkillEntries(meta, file, byName);
    try {
      resolveLogPromotionDirective({
        repoRoot,
        logFile: file,
        meta,
        promotableEntries,
        byName,
      });
    } catch (err) {
      errors.push(err?.message || String(err));
    }
  }

  if (errors.length) fail(errors.join('\n'));
  process.stdout.write(`OK: ${byName.size} skills valid; ${logs.length} log file(s) checked.\n`);
}

function buildLogTemplate({ id, createdAt, branch, headSha, title, skills, skillUpdatesLines }) {
  const skillList = skills.length ? skills : [];
  const skillsBlock = skillList.length ? skillList.map((skill) => `  - ${skill}`).join('\n') : '  []';
  return [
    '---',
    `id: ${id}`,
    `created_at: "${createdAt}"`,
    'status: pending',
    'processed_at: null',
    'queued_at: null',
    'promotion_task_id: null',
    `branch: "${branch || ''}"`,
    `head_sha: "${headSha || ''}"`,
    'skills:',
    skillsBlock,
    ...skillUpdatesLines,
    `title: "${title.replace(/"/g, '\\"')}"`,
    '---',
    '',
    '# Summary',
    '- What changed:',
    '- Why:',
    '',
    '# Verification',
    '- Commands run:',
    '- Results:',
    '',
    '# Learnings',
    '- Add concise reusable rules into `skill_updates` in frontmatter before running distill.',
    '',
  ].join('\n');
}

async function cmdDebrief(repoRoot, argv) {
  const byName = await loadSkillsIndex(repoRoot);
  const title = getArgValue(argv, '--title') || 'Session debrief';
  const skills = normalizeList(getArgValue(argv, '--skills') || '');
  const updatesBySkill = parseSkillUpdatesArg(argv);
  for (const skill of new Set([...skills, ...updatesBySkill.keys()])) {
    if (!byName.has(skill)) fail(`Unknown skill '${skill}'`);
  }

  const createdAt = isoNow();
  const id = `${idTimestamp(createdAt)}__${slugify(title) || 'debrief'}`;
  const monthDir = createdAt.slice(0, 7).replace('-', '/');
  const logsDir = path.join(repoRoot, '.codex', 'skill-ops', 'logs', monthDir);
  await fs.mkdir(logsDir, { recursive: true });
  const filePath = path.join(logsDir, `${id}.md`);

  const branch = tryGit(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const headSha = tryGit(repoRoot, ['rev-parse', 'HEAD']);
  const { skills: allSkills, lines: skillUpdatesLines } = buildSkillUpdatesLines(skills, updatesBySkill);
  const markdown = buildLogTemplate({
    id,
    createdAt,
    branch,
    headSha,
    title,
    skills: allSkills,
    skillUpdatesLines,
  });
  await fs.writeFile(filePath, markdown, 'utf8');
  process.stdout.write(`${path.relative(repoRoot, filePath) || filePath}\n`);
}

async function cmdDistill(repoRoot, argv) {
  const dryRun = hasFlag(argv, '--dry-run');
  const markEmptySkipped = hasFlag(argv, '--mark-empty-skipped');
  const maxLearned = parseMaxLearned(argv);
  const plan = await buildPromotionPlan(repoRoot, { maxLearned });
  const promotableCount = plan.sourceLogs.length;
  const emptyCount = plan.skippableLogIds.length;
  const skillCount = plan.items.length;

  if (markEmptySkipped && emptyCount > 0 && !dryRun) {
    const logs = await loadPlanSourceLogs({
      repoRoot,
      plan,
      allowedLogIds: plan.skippableLogIds,
      includeAllLogs: true,
    });
    const processedAt = isoNow();
    for (const log of logs) {
      const next = applyPromotionLogStatus(log.contents, {
        status: 'skipped',
        processedAt,
        promotionTaskId: '',
      });
      await fs.writeFile(log.absPath, next, 'utf8');
    }
  }

  let localWriteSummary = null;
  if (!dryRun && plan.items.length > 0) {
    const safeLocalItems = plan.items.filter((item) => {
      if (normalizePromotionMode(item?.promotionMode) === 'canonical_section') return true;
      return !(
        Boolean(normalizeSingleLine(item?.archiveFile)) ||
        (Array.isArray(item?.overflowBullets) && item.overflowBullets.length > 0)
      );
    });
    if (safeLocalItems.length > 0) {
      const prepared = await preparePromotionWrites(repoRoot, {
        ...plan,
        items: safeLocalItems,
      });
      const archiveUpdates = await applyPreparedPromotionWrites(prepared);
      localWriteSummary = {
        skillWrites: prepared.writes.length,
        archiveUpdates,
      };
    }
  }

  const prefix = dryRun ? 'DRY RUN: ' : '';
  if (promotableCount === 0) {
    const skippedText =
      markEmptySkipped && emptyCount > 0
        ? `; ${dryRun ? 'would mark' : 'marked'} ${emptyCount} log(s) skipped`
        : '';
    process.stdout.write(`${prefix}No new SkillOps learnings to distill${skippedText}.\n`);
    return;
  }
  const skippedText =
    markEmptySkipped && emptyCount > 0
      ? `; ${dryRun ? 'would mark' : 'marked'} ${emptyCount} empty log(s) skipped`
      : '';
  const localWriteText = localWriteSummary
    ? `; locally updated ${localWriteSummary.skillWrites} skill file(s)${
      localWriteSummary.archiveUpdates > 0 ? ` and ${localWriteSummary.archiveUpdates} archive file(s)` : ''
    } in this checkout`
    : '';
  process.stdout.write(
    `${prefix}SkillOps learnings remain pending for promotion: ${promotableCount} log(s), ${skillCount} skill(s)${localWriteText}; source logs stay pending until runtime handoff succeeds${skippedText}.\n`,
  );
}

async function cmdPlanPromotions(repoRoot, argv) {
  if (!hasFlag(argv, '--json')) fail('plan-promotions requires --json');
  const maxLearned = parseMaxLearned(argv);
  const plan = await buildPromotionPlan(repoRoot, { maxLearned });
  process.stdout.write(`${JSON.stringify(plan)}\n`);
}

async function cmdApplyPromotions(repoRoot, argv) {
  const jsonOutput = hasFlag(argv, '--json');
  const { plan } = await readPlanFile(repoRoot, getArgValue(argv, '--plan'));
  const prepared = await preparePromotionWrites(repoRoot, plan);
  const archiveUpdates = await applyPreparedPromotionWrites(prepared);

  const result = {
    ok: true,
    skillsApplied: prepared.writes.length,
    archiveUpdates,
    targetCount: prepared.targetCount,
    payloadFiles: prepared.payloadFiles,
  };

  if (jsonOutput) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  process.stdout.write(
    prepared.writes.length > 0
      ? `Applied ${prepared.writes.length} promotion item(s) across ${prepared.targetCount} durable target(s).\n`
      : 'No promotable SkillOps learnings to apply.\n',
  );
}

function applyPromotionLogStatus(contents, { status, processedAt, promotionTaskId }) {
  let next = upsertFrontmatterKey(contents, 'status', status);
  if (status === 'queued') {
    next = upsertFrontmatterKey(next, 'processed_at', 'null');
    next = upsertFrontmatterKey(next, 'queued_at', `"${processedAt}"`);
    next = upsertFrontmatterKey(next, 'promotion_task_id', JSON.stringify(promotionTaskId));
    return next;
  }
  next = upsertFrontmatterKey(next, 'processed_at', `"${processedAt}"`);
  next = upsertFrontmatterKey(next, 'queued_at', 'null');
  next = upsertFrontmatterKey(next, 'promotion_task_id', 'null');
  return next;
}

function resolveMarkedLogState({ summary, requestedStatus, logPath, processedAt, promotionTaskId }) {
  const currentStatus = String(summary?.status || '').trim();
  if (!currentStatus || !SUPPORTED_STATUSES.includes(currentStatus)) {
    fail(`Promotion source log has invalid status at ${logPath}`);
  }
  if ((currentStatus === 'processed' || currentStatus === 'skipped') && currentStatus !== requestedStatus) {
    fail(`Promotion source log cannot change terminal status from ${currentStatus} to ${requestedStatus}: ${logPath}`);
  }
  if (requestedStatus === 'queued') {
    const unchanged =
      currentStatus === 'queued' &&
      Boolean(summary?.queuedAt) &&
      String(summary?.promotionTaskId || '') === promotionTaskId;
    return {
      status: requestedStatus,
      processedAt: null,
      queuedAt: unchanged ? summary.queuedAt : processedAt,
      promotionTaskId,
      unchanged,
    };
  }
  const resolvedProcessedAt = summary?.processedAt || processedAt;
  return {
    status: requestedStatus,
    processedAt: resolvedProcessedAt,
    queuedAt: null,
    promotionTaskId: '',
    unchanged: currentStatus === requestedStatus && Boolean(summary?.processedAt),
  };
}

async function cmdMarkPromoted(repoRoot, argv) {
  const status = String(getArgValue(argv, '--status') || '').trim().toLowerCase();
  if (!['queued', 'processed', 'skipped'].includes(status)) {
    fail('mark-promoted requires --status queued|processed|skipped');
  }
  const promotionTaskId = String(getArgValue(argv, '--promotion-task-id') || '').trim();
  if (status === 'queued' && !promotionTaskId) fail('mark-promoted queued requires --promotion-task-id');
  const { plan } = await readPlanFile(repoRoot, getArgValue(argv, '--plan'));
  const allowedLogIds = status === 'skipped' ? plan.skippableLogIds : plan.sourceLogs.map((entry) => entry.id);
  const logs = await loadPlanSourceLogs({
    repoRoot,
    plan,
    allowedLogIds,
    includeAllLogs: status === 'skipped',
  });
  const processedAt = isoNow();
  let updatedLogs = 0;

  for (const log of logs) {
    const nextState = resolveMarkedLogState({
      summary: log.summary,
      requestedStatus: status,
      logPath: log.relPath,
      processedAt,
      promotionTaskId,
    });
    if (nextState.unchanged) continue;
    const next = applyPromotionLogStatus(log.contents, {
      status: nextState.status,
      processedAt: nextState.queuedAt || nextState.processedAt,
      promotionTaskId: nextState.promotionTaskId,
    });
    await fs.writeFile(log.absPath, next, 'utf8');
    updatedLogs += 1;
  }

  process.stdout.write(`Marked ${updatedLogs} SkillOps log(s) ${status}.\n`);
}

async function cmdPayloadFiles(repoRoot, argv) {
  const jsonOutput = hasFlag(argv, '--json');
  const { plan } = await readPlanFile(repoRoot, getArgValue(argv, '--plan'));
  const payloadFiles = collectPayloadTargets(repoRoot, plan);
  if (jsonOutput) {
    process.stdout.write(`${JSON.stringify({ ok: true, payloadFiles, targetCount: payloadFiles.length })}\n`);
    return;
  }
  if (payloadFiles.length > 0) {
    process.stdout.write(`${payloadFiles.join('\n')}\n`);
  }
}

async function main() {
  const [, , cmd, ...argv] = process.argv;
  const repoRoot = getRepoRoot();
  if (!cmd || cmd === '-h' || cmd === '--help') {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  switch (cmd) {
    case 'capabilities':
      await cmdCapabilities(argv);
      return;
    case 'lint':
      await cmdLint(repoRoot);
      return;
    case 'log':
    case 'debrief':
      await cmdDebrief(repoRoot, argv);
      return;
    case 'distill':
      await cmdDistill(repoRoot, argv);
      return;
    case 'plan-promotions':
      await cmdPlanPromotions(repoRoot, argv);
      return;
    case 'apply-promotions':
      await cmdApplyPromotions(repoRoot, argv);
      return;
    case 'payload-files':
      await cmdPayloadFiles(repoRoot, argv);
      return;
    case 'mark-promoted':
      await cmdMarkPromoted(repoRoot, argv);
      return;
    default:
      fail(
        `SkillOps: unknown command '${cmd}' (expected: capabilities|lint|log|debrief|distill|plan-promotions|apply-promotions|payload-files|mark-promoted)`,
      );
  }
}

main().catch((err) => {
  process.stderr.write(`${(err && err.message) || String(err)}\n`);
  process.exit(1);
});
