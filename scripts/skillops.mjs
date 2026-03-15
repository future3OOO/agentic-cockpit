import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { readSkillOpsLogSummary } from './lib/skillops-log.mjs';

const LEARNED_BEGIN = '<!-- SKILLOPS:LEARNED:BEGIN -->';
const LEARNED_END = '<!-- SKILLOPS:LEARNED:END -->';
const SIMPLE_SKILL_KEY_RE = /^[A-Za-z0-9_-]+$/;
const SKILLOPS_SCHEMA_VERSION = 2;
const SKILLOPS_CAPABILITIES_VERSION = 2;
const SKILLOPS_CONTRACT_VERSION = 2;
const SUPPORTED_STATUSES = ['pending', 'queued', 'processed', 'skipped'];
const PROMOTION_PLAN_KIND = 'skillops-promotion-plan';
const PROMOTION_PLAN_VERSION = 1;

function normalizeRepoPathLocal(relPath) {
  return String(relPath || '').replace(/\\/g, '/').replace(/^\.\/+/, '').trim();
}

function validateRepoRelativePath(relPath, label) {
  const normalized = normalizeRepoPathLocal(relPath);
  if (!normalized) fail(`Invalid ${label}: path must be non-empty`);
  if (path.isAbsolute(normalized)) fail(`Invalid ${label} ${normalized}: paths must be repo-relative`);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
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
    '  node scripts/skillops.mjs distill [--dry-run] [--mark-empty-skipped]',
    '  node scripts/skillops.mjs plan-promotions --json',
    '  node scripts/skillops.mjs apply-promotions --plan /abs/path/to/plan.json',
    '  node scripts/skillops.mjs mark-promoted --plan /abs/path/to/plan.json --status queued|processed|skipped [--promotion-task-id id]',
    '',
  ].join('\n');
}

function fail(message) {
  throw new Error(message);
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

function ensureLearnedBlock(contents) {
  if (contents.includes(LEARNED_BEGIN) && contents.includes(LEARNED_END)) return contents;
  return (
    contents.trimEnd() +
    '\n\n## Learned heuristics (SkillOps)\n' +
    `${LEARNED_BEGIN}\n` +
    `${LEARNED_END}\n`
  );
}

function updateLearnedBlock(contents, additions) {
  const input = ensureLearnedBlock(contents);
  const start = input.indexOf(LEARNED_BEGIN);
  const end = input.indexOf(LEARNED_END);
  if (start < 0 || end < 0 || end < start) fail('Malformed SkillOps learned block markers');
  const before = input.slice(0, start + LEARNED_BEGIN.length);
  const middle = input.slice(start + LEARNED_BEGIN.length, end);
  const after = input.slice(end);

  const existingBullets = middle
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2));
  const existingKeys = new Set(existingBullets.map((line) => stripSourceTag(line)));
  const nextBullets = [];
  for (const add of additions) {
    const clean = stripSourceTag(add.text);
    if (!clean || existingKeys.has(clean)) continue;
    existingKeys.add(clean);
    nextBullets.push(`- ${clean} [src:${add.logId}]`);
  }
  const combined = [...nextBullets, ...existingBullets.map((line) => `- ${line}`)];
  const rewrittenMiddle = combined.length ? `\n${combined.join('\n')}\n` : '\n';
  return `${before}${rewrittenMiddle}${after}`;
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
    if (trimmed === 'skills:') {
      i += 1;
      while (i < lines.length && /^\s*-\s+/.test(lines[i])) {
        meta.skills.push(String(lines[i]).replace(/^\s*-\s+/, '').trim().replace(/^["']|["']$/g, ''));
        i += 1;
      }
      continue;
    }
    if (trimmed === 'skill_updates:') {
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
      version: PROMOTION_PLAN_VERSION,
      durableTargetGlobs: ['.codex/skills/*/SKILL.md'],
      sourceLogsRoot: '.codex/skill-ops/logs',
      checkoutScopedMarkPromoted: true,
      markStatuses: ['queued', 'processed', 'skipped'],
    },
    commands: {
      capabilities: { json: true, writes: 'none' },
      lint: { json: false, writes: 'none' },
      log: { json: false, writes: 'raw_logs', requiredFlags: ['--title'], optionalFlags: ['--skills', '--skill-update'] },
      debrief: { json: false, writes: 'raw_logs', requiredFlags: ['--title'], optionalFlags: ['--skills', '--skill-update'] },
      distill: { json: false, writes: 'non_durable_preview', optionalFlags: ['--dry-run', '--mark-empty-skipped'] },
      'plan-promotions': { json: true, writes: 'none' },
      'apply-promotions': { json: false, writes: 'durable_targets', requiredFlags: ['--plan'] },
      'mark-promoted': { json: false, writes: 'raw_logs', requiredFlags: ['--plan', '--status'], optionalFlags: ['--promotion-task-id'] },
    },
  };
}

function buildPromotionPlanPayload({
  generatedAt,
  sourceLogIds,
  sourceLogPaths,
  promotableLogIds,
  emptyLogIds,
  updatesBySkill,
  durableTargets,
}) {
  return {
    kind: PROMOTION_PLAN_KIND,
    version: PROMOTION_PLAN_VERSION,
    schemaVersion: SKILLOPS_SCHEMA_VERSION,
    generatedAt,
    sourceLogIds,
    sourceLogPaths,
    promotableLogIds,
    emptyLogIds,
    updatesBySkill,
    durableTargets,
  };
}

function getNormalizedLogId(meta, logFile) {
  return String(meta?.id || '').trim() || path.basename(logFile, '.md');
}

async function buildPromotionPlan(repoRoot) {
  const byName = await loadSkillsIndex(repoRoot);
  const logs = await listSkillOpsLogs(repoRoot);
  const updatesBySkill = new Map();
  const sourceLogIds = [];
  const sourceLogPaths = [];
  const promotableLogIds = [];
  const emptyLogIds = [];

  for (const logFile of logs) {
    const contents = await fs.readFile(logFile, 'utf8');
    const meta = parseLogMetadata(contents);
    if (!meta) fail(`${logFile}: missing or malformed YAML frontmatter`);
    const summary = readSkillOpsLogSummary(contents);
    if (!summary) fail(`${logFile}: unreadable SkillOps frontmatter`);
    if (!meta.createdAt) fail(`${logFile}: missing created_at`);
    const status = summary.status;
    if (!status) fail(`${logFile}: missing status`);
    if (!SUPPORTED_STATUSES.includes(status) && status !== 'pending') {
      fail(`${logFile}: invalid normalized status '${status}'`);
    }
    if (status !== 'pending') continue;

    const logId = getNormalizedLogId(meta, logFile);
    const relPath = normalizeRepoPathLocal(path.relative(repoRoot, logFile));
    if (!relPath.startsWith('.codex/skill-ops/logs/')) {
      fail(`${logFile}: pending log path must stay under .codex/skill-ops/logs/`);
    }
    sourceLogIds.push(logId);
    sourceLogPaths.push(relPath);

    const skillEntries = Object.entries(meta.skillUpdates || {});
    let hasUpdates = false;
    for (const [skillName, updates] of skillEntries) {
      if (!byName.has(skillName)) fail(`${logFile}: skill_updates references unknown skill '${skillName}'`);
      const usable = Array.isArray(updates) ? updates.map((value) => normalizeSingleLine(value)).filter(Boolean) : [];
      if (!usable.length) continue;
      hasUpdates = true;
      if (!updatesBySkill.has(skillName)) updatesBySkill.set(skillName, []);
      for (const text of usable) {
        updatesBySkill.get(skillName).push({ text, logId });
      }
    }

    if (hasUpdates) promotableLogIds.push(logId);
    else emptyLogIds.push(logId);
  }

  const durableTargets = Array.from(updatesBySkill.keys())
    .sort((a, b) => a.localeCompare(b))
    .map((skillName) => normalizeRepoPathLocal(path.relative(repoRoot, byName.get(skillName))))
    .filter(Boolean);
  for (const target of durableTargets) {
    if (!target.startsWith('.codex/skills/')) fail(`invalid durable target ${target}`);
    if (target.startsWith('.codex/skill-ops/logs/') || target.startsWith('.codex/quality/')) {
      fail(`invalid durable target ${target}`);
    }
  }

  const serializedUpdatesBySkill = {};
  for (const skillName of Array.from(updatesBySkill.keys()).sort((a, b) => a.localeCompare(b))) {
    serializedUpdatesBySkill[skillName] = updatesBySkill
      .get(skillName)
      .map((entry) => ({
        text: normalizeSingleLine(entry.text),
        logId: String(entry.logId || '').trim(),
      }))
      .filter((entry) => entry.text && entry.logId);
  }

  return buildPromotionPlanPayload({
    generatedAt: isoNow(),
    sourceLogIds: sourceLogIds.slice().sort((a, b) => a.localeCompare(b)),
    sourceLogPaths: sourceLogPaths.slice().sort((a, b) => a.localeCompare(b)),
    promotableLogIds: promotableLogIds.slice().sort((a, b) => a.localeCompare(b)),
    emptyLogIds: emptyLogIds.slice().sort((a, b) => a.localeCompare(b)),
    updatesBySkill: serializedUpdatesBySkill,
    durableTargets,
  });
}

function validatePlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) fail('Invalid SkillOps plan: expected object');
  if (plan.kind != null && String(plan.kind) !== PROMOTION_PLAN_KIND) {
    fail(`Invalid SkillOps plan kind ${JSON.stringify(plan.kind)}`);
  }
  if (plan.version != null && Number(plan.version) !== PROMOTION_PLAN_VERSION) {
    fail(`Invalid SkillOps plan version ${JSON.stringify(plan.version)}`);
  }
  if (Number(plan.schemaVersion) !== SKILLOPS_SCHEMA_VERSION) {
    fail(`Invalid SkillOps plan schemaVersion ${JSON.stringify(plan.schemaVersion)}`);
  }
  const sourceLogIds = Array.isArray(plan.sourceLogIds) ? plan.sourceLogIds.map((v) => String(v || '').trim()).filter(Boolean) : [];
  const sourceLogPaths = Array.isArray(plan.sourceLogPaths)
    ? plan.sourceLogPaths.map((v) => validateRepoRelativePath(v, 'source log path'))
    : [];
  const promotableLogIds = Array.isArray(plan.promotableLogIds)
    ? plan.promotableLogIds.map((v) => String(v || '').trim()).filter(Boolean)
    : [];
  const emptyLogIds = Array.isArray(plan.emptyLogIds) ? plan.emptyLogIds.map((v) => String(v || '').trim()).filter(Boolean) : [];
  const durableTargets = Array.isArray(plan.durableTargets)
    ? plan.durableTargets.map((v) => validateRepoRelativePath(v, 'durable target'))
    : [];
  const updatesBySkillInput =
    plan.updatesBySkill && typeof plan.updatesBySkill === 'object' && !Array.isArray(plan.updatesBySkill)
      ? plan.updatesBySkill
      : {};
  const updatesBySkill = {};
  for (const skillName of Object.keys(updatesBySkillInput).sort((a, b) => a.localeCompare(b))) {
    const entries = Array.isArray(updatesBySkillInput[skillName]) ? updatesBySkillInput[skillName] : [];
    updatesBySkill[skillName] = entries
      .map((entry) => ({
        text: normalizeSingleLine(entry?.text),
        logId: String(entry?.logId || '').trim(),
      }))
      .filter((entry) => entry.text && entry.logId);
  }
  for (const sourcePath of sourceLogPaths) {
    if (!sourcePath.startsWith('.codex/skill-ops/logs/')) fail(`Invalid source log path ${sourcePath}`);
  }
  for (const target of durableTargets) {
    if (!target.startsWith('.codex/skills/')) fail(`Invalid durable target ${target}`);
    if (target.startsWith('.codex/skill-ops/logs/') || target.startsWith('.codex/quality/')) {
      fail(`Invalid durable target ${target}`);
    }
  }
  return buildPromotionPlanPayload({
    generatedAt: String(plan.generatedAt || '').trim(),
    sourceLogIds,
    sourceLogPaths,
    promotableLogIds,
    emptyLogIds,
    updatesBySkill,
    durableTargets,
  });
}

async function readPlanFile(planPath) {
  const rawPlanPath = String(planPath || '').trim();
  if (!rawPlanPath) fail('Missing --plan path');
  const resolved = path.isAbsolute(rawPlanPath) ? rawPlanPath : path.resolve(process.cwd(), rawPlanPath);
  const raw = await fs.readFile(resolved, 'utf8');
  return {
    planPath: resolved,
    plan: validatePlan(JSON.parse(raw)),
  };
}

async function loadPlanSourceLogs({ repoRoot, plan, allowedLogIds }) {
  const allowed = new Set(allowedLogIds);
  const out = [];
  const seenIds = new Map();
  for (const relPath of plan.sourceLogPaths) {
    const absPath = path.resolve(repoRoot, relPath);
    const contents = await fs.readFile(absPath, 'utf8');
    const summary = readSkillOpsLogSummary(contents);
    if (!summary) fail(`${relPath}: malformed SkillOps log`);
    if (!summary.id) fail(`${relPath}: missing SkillOps log id`);
    if (!allowed.has(summary.id)) continue;
    seenIds.set(summary.id, (seenIds.get(summary.id) || 0) + 1);
    out.push({ absPath, relPath, contents, summary });
  }
  for (const allowedLogId of allowed) {
    const matchCount = seenIds.get(allowedLogId) || 0;
    if (matchCount !== 1) {
      fail(`SkillOps plan must resolve log id ${allowedLogId} exactly once (got ${matchCount})`);
    }
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
  const plan = await buildPromotionPlan(repoRoot);
  const promotableCount = plan.promotableLogIds.length;
  const emptyCount = plan.emptyLogIds.length;
  const skillCount = Object.keys(plan.updatesBySkill).length;

  if (markEmptySkipped && emptyCount > 0 && !dryRun) {
    const tmpPlanPath = path.join(repoRoot, '.codex', '.tmp-skillops-distill-skip.json');
    try {
      await fs.mkdir(path.dirname(tmpPlanPath), { recursive: true });
      await fs.writeFile(tmpPlanPath, JSON.stringify(plan, null, 2) + '\n', 'utf8');
      const { planPath: resolvedPlanPath, plan: validatedPlan } = await readPlanFile(tmpPlanPath);
      const sourceLogs = await loadPlanSourceLogs({
        repoRoot,
        plan: validatedPlan,
        allowedLogIds: validatedPlan.emptyLogIds,
      });
      const processedAt = isoNow();
      for (const log of sourceLogs) {
        const next = applyPromotionLogStatus(log.contents, {
          status: 'skipped',
          processedAt,
          promotionTaskId: '',
        });
        await fs.writeFile(log.absPath, next, 'utf8');
      }
      await fs.rm(resolvedPlanPath, { force: true });
    } finally {
      await fs.rm(tmpPlanPath, { force: true });
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
  process.stdout.write(
    `${prefix}SkillOps learnings remain pending for promotion: ${promotableCount} log(s), ${skillCount} skill(s); no durable changes applied${skippedText}.\n`,
  );
}

async function cmdPlanPromotions(repoRoot, argv) {
  if (!hasFlag(argv, '--json')) fail('plan-promotions requires --json');
  const plan = await buildPromotionPlan(repoRoot);
  process.stdout.write(`${JSON.stringify(plan)}\n`);
}

async function cmdApplyPromotions(repoRoot, argv) {
  const { plan } = await readPlanFile(getArgValue(argv, '--plan'));
  const byName = await loadSkillsIndex(repoRoot);
  const durableTargetSet = new Set(plan.durableTargets);
  let changedSkills = 0;

  for (const skillName of Object.keys(plan.updatesBySkill)) {
    if (!byName.has(skillName)) fail(`SkillOps plan references unknown skill '${skillName}'`);
    const skillFile = byName.get(skillName);
    const skillRel = normalizeRepoPathLocal(path.relative(repoRoot, skillFile));
    if (!durableTargetSet.has(skillRel)) fail(`SkillOps plan missing durable target for ${skillName}`);
    const additions = plan.updatesBySkill[skillName];
    if (!Array.isArray(additions) || additions.length === 0) continue;
    const contents = await fs.readFile(skillFile, 'utf8');
    const next = updateLearnedBlock(contents, additions);
    if (next !== contents) {
      changedSkills += 1;
      await fs.writeFile(skillFile, next, 'utf8');
    }
  }

  process.stdout.write(
    changedSkills > 0
      ? `Applied SkillOps promotions to ${changedSkills} skill file(s).\n`
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
  const { plan } = await readPlanFile(getArgValue(argv, '--plan'));
  const allowedLogIds = status === 'skipped' ? plan.emptyLogIds : plan.promotableLogIds;
  const logs = await loadPlanSourceLogs({ repoRoot, plan, allowedLogIds });
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
    case 'mark-promoted':
      await cmdMarkPromoted(repoRoot, argv);
      return;
    default:
      fail(
        `SkillOps: unknown command '${cmd}' (expected: capabilities|lint|log|debrief|distill|plan-promotions|apply-promotions|mark-promoted)`,
      );
  }
}

main().catch((err) => {
  process.stderr.write(`${(err && err.message) || String(err)}\n`);
  process.exit(1);
});
