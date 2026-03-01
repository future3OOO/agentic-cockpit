import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const LEARNED_BEGIN = '<!-- SKILLOPS:LEARNED:BEGIN -->';
const LEARNED_END = '<!-- SKILLOPS:LEARNED:END -->';
const MAX_LEARNED_DEFAULT = 30;

/**
 * Prints CLI usage and exits.
 */
function usage() {
  return [
    'SkillOps',
    '',
    'Usage:',
    '  node scripts/skillops.mjs lint',
    '  node scripts/skillops.mjs log --title "..." [--skills a,b,c]',
    '  node scripts/skillops.mjs debrief --title "..." [--skills a,b,c]',
    '  node scripts/skillops.mjs distill [--dry-run] [--max-learned 30]',
    '',
  ].join('\n');
}

/**
 * Helper for fail used by the cockpit workflow runtime.
 */
function fail(message) {
  throw new Error(message);
}

/**
 * Helper for run used by the cockpit workflow runtime.
 */
function run(cmd, args, opts = {}) {
  const res = childProcess.spawnSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  });
  if (res.error) throw res.error;
  return res;
}

/**
 * Best-effort helper for git without throwing hard failures.
 */
function tryGit(repoRoot, args) {
  try {
    const res = run('git', args, { cwd: repoRoot });
    if (res.status !== 0) return '';
    return String(res.stdout || '').trim();
  } catch {
    return '';
  }
}

/**
 * Gets repo root from the current environment.
 */
function getRepoRoot() {
  const cwd = process.cwd();
  const viaGit = tryGit(cwd, ['rev-parse', '--show-toplevel']);
  return viaGit || cwd;
}

/**
 * Helper for iso now used by the cockpit workflow runtime.
 */
function isoNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Helper for id timestamp used by the cockpit workflow runtime.
 */
function idTimestamp(iso) {
  return iso.replace(/[-:]/g, '');
}

/**
 * Helper for slugify used by the cockpit workflow runtime.
 */
function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/**
 * Normalizes list for downstream use.
 */
function normalizeList(raw) {
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

/**
 * Gets arg value from the current environment.
 */
function getArgValue(argv, key) {
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === key) return argv[i + 1];
    if (value.startsWith(`${key}=`)) return value.slice(key.length + 1);
  }
  return null;
}

/**
 * Returns whether flag.
 */
function hasFlag(argv, key) {
  return argv.includes(key);
}

/**
 * Collects files recursively under a root with depth and filename filtering.
 */
async function collectFilesRecursive(root, { maxDepth, includeFile }) {
  const out = [];
  /**
   * Helper for walk used by the cockpit workflow runtime.
   */
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

/**
 * Lists skill files from available sources.
 */
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

/**
 * Parses frontmatter into a normalized value.
 */
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

/**
 * Parses simple yaml into a normalized value.
 */
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

/**
 * Helper for strip source tag used by the cockpit workflow runtime.
 */
function stripSourceTag(text) {
  return String(text || '').replace(/\s*\[src:[^\]]+\]\s*$/, '').trim();
}

/**
 * Helper for ensure learned block used by the cockpit workflow runtime.
 */
function ensureLearnedBlock(contents) {
  if (contents.includes(LEARNED_BEGIN) && contents.includes(LEARNED_END)) return contents;
  return (
    contents.trimEnd() +
    '\n\n## Learned heuristics (SkillOps)\n' +
    `${LEARNED_BEGIN}\n` +
    `${LEARNED_END}\n`
  );
}

/**
 * Helper for update learned block used by the cockpit workflow runtime.
 */
function updateLearnedBlock(contents, additions, maxLearned) {
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
    if (!clean) continue;
    if (existingKeys.has(clean)) continue;
    existingKeys.add(clean);
    nextBullets.push(`- ${clean} [src:${add.logId}]`);
  }
  const combined = [...nextBullets, ...existingBullets.map((line) => `- ${line}`)];
  const kept = combined.slice(0, maxLearned);
  const rewrittenMiddle = kept.length ? `\n${kept.join('\n')}\n` : '\n';
  return `${before}${rewrittenMiddle}${after}`;
}

/**
 * Loads skills index required for this execution.
 */
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

/**
 * Parses log metadata into a normalized value.
 */
function parseLogMetadata(contents) {
  const fmBlock = parseFrontmatter(contents);
  if (!fmBlock) return null;
  const meta = {
    id: '',
    createdAt: '',
    status: '',
    processedAt: null,
    skills: [],
    skillUpdates: {},
  };
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
        const m = String(lines[i]).match(/^\s{2}([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
        if (!m) break;
        const skillName = m[1];
        const rhs = m[2].trim();
        meta.skillUpdates[skillName] = [];
        i += 1;
        if (rhs && rhs !== '[]' && rhs !== '{}') continue;
        while (i < lines.length && /^\s{4}-\s+/.test(lines[i])) {
          const update = String(lines[i]).replace(/^\s{4}-\s+/, '').trim().replace(/^["']|["']$/g, '');
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

/**
 * Helper for rewrite frontmatter key used by the cockpit workflow runtime.
 */
function rewriteFrontmatterKey(contents, key, valueLiteral) {
  const block = parseFrontmatter(contents);
  if (!block) fail('Log missing YAML frontmatter');
  const lines = block.lines.slice();
  let replaced = false;
  for (let i = 1; i < block.endLine; i += 1) {
    const trimmed = lines[i].trimStart();
    if (!trimmed.startsWith(`${key}:`)) continue;
    const indent = lines[i].match(/^(\s*)/)?.[1] || '';
    lines[i] = `${indent}${key}: ${valueLiteral}`;
    replaced = true;
    break;
  }
  if (!replaced) fail(`Log missing frontmatter key: ${key}`);
  return lines.join('\n');
}

/**
 * Lists skill ops logs from available sources.
 */
async function listSkillOpsLogs(repoRoot) {
  const root = path.join(repoRoot, '.codex', 'skill-ops', 'logs');
  return collectFilesRecursive(root, {
    maxDepth: 5,
    includeFile: (name) => name.endsWith('.md') && name.toLowerCase() !== 'readme.md',
  });
}

/**
 * Implements the lint subcommand.
 */
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
    if (!meta) {
      errors.push(`${file}: missing or malformed YAML frontmatter`);
      continue;
    }
    if (!meta.id) errors.push(`${file}: missing id`);
    if (!meta.createdAt) errors.push(`${file}: missing created_at`);
    if (!meta.status) errors.push(`${file}: missing status`);
    if (meta.status && meta.status !== 'pending' && meta.status !== 'processed') {
      errors.push(`${file}: invalid status '${meta.status}'`);
    }
    if (meta.status === 'processed' && !meta.processedAt) {
      errors.push(`${file}: processed log must include processed_at`);
    }
    for (const skillName of meta.skills) {
      if (!byName.has(skillName)) {
        errors.push(`${file}: unknown skill '${skillName}'`);
      }
    }
    for (const skillName of Object.keys(meta.skillUpdates || {})) {
      if (!byName.has(skillName)) {
        errors.push(`${file}: skill_updates references unknown skill '${skillName}'`);
      }
    }
  }

  if (errors.length) fail(errors.join('\n'));
  process.stdout.write(`OK: ${byName.size} skills valid; ${logs.length} log file(s) checked.\n`);
}

/**
 * Builds log template used by workflow automation.
 */
function buildLogTemplate({ id, createdAt, branch, headSha, title, skills }) {
  const skillList = skills.length ? skills : [];
  const updatesBlock = skillList.length
    ? skillList.map((skill) => `  ${skill}: []`).join('\n')
    : '  {}';
  const skillsBlock = skillList.length ? skillList.map((skill) => `  - ${skill}`).join('\n') : '  []';

  return [
    '---',
    `id: ${id}`,
    `created_at: "${createdAt}"`,
    'status: pending',
    'processed_at: null',
    `branch: "${branch || ''}"`,
    `head_sha: "${headSha || ''}"`,
    'skills:',
    skillsBlock,
    'skill_updates:',
    updatesBlock,
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

/**
 * Implements the debrief subcommand.
 */
async function cmdDebrief(repoRoot, argv) {
  const byName = await loadSkillsIndex(repoRoot);
  const title = getArgValue(argv, '--title') || 'Session debrief';
  const skills = normalizeList(getArgValue(argv, '--skills') || '');
  for (const skill of skills) {
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
  const markdown = buildLogTemplate({ id, createdAt, branch, headSha, title, skills });
  await fs.writeFile(filePath, markdown, 'utf8');
  process.stdout.write(`${path.relative(repoRoot, filePath) || filePath}\n`);
}

/**
 * Implements the distill subcommand.
 */
async function cmdDistill(repoRoot, argv) {
  const dryRun = hasFlag(argv, '--dry-run');
  const maxLearnedRaw = Number(getArgValue(argv, '--max-learned') || MAX_LEARNED_DEFAULT);
  const maxLearned = Number.isInteger(maxLearnedRaw) && maxLearnedRaw > 0 ? maxLearnedRaw : MAX_LEARNED_DEFAULT;
  const byName = await loadSkillsIndex(repoRoot);
  const logs = await listSkillOpsLogs(repoRoot);

  const additionsBySkill = new Map();
  const logsToMarkProcessed = [];
  for (const logFile of logs) {
    const contents = await fs.readFile(logFile, 'utf8');
    const meta = parseLogMetadata(contents);
    if (!meta || meta.status !== 'pending') continue;

    let hasUpdates = false;
    for (const [skillName, updates] of Object.entries(meta.skillUpdates || {})) {
      if (!byName.has(skillName)) fail(`${logFile}: unknown skill '${skillName}'`);
      const usable = Array.isArray(updates) ? updates.map((u) => String(u || '').trim()).filter(Boolean) : [];
      if (!usable.length) continue;
      hasUpdates = true;
      if (!additionsBySkill.has(skillName)) additionsBySkill.set(skillName, []);
      for (const text of usable) {
        additionsBySkill.get(skillName).push({ text, logId: meta.id || path.basename(logFile, '.md') });
      }
    }
    if (hasUpdates) logsToMarkProcessed.push(logFile);
  }

  if (additionsBySkill.size === 0) {
    process.stdout.write('No new SkillOps learnings to distill.\n');
    return;
  }

  for (const [skillName, additions] of additionsBySkill.entries()) {
    const skillFile = byName.get(skillName);
    const contents = await fs.readFile(skillFile, 'utf8');
    const next = updateLearnedBlock(contents, additions, maxLearned);
    if (!dryRun) await fs.writeFile(skillFile, next, 'utf8');
  }

  if (!dryRun) {
    const processedAt = isoNow();
    for (const logFile of logsToMarkProcessed) {
      let contents = await fs.readFile(logFile, 'utf8');
      contents = rewriteFrontmatterKey(contents, 'status', 'processed');
      contents = rewriteFrontmatterKey(contents, 'processed_at', `"${processedAt}"`);
      await fs.writeFile(logFile, contents, 'utf8');
    }
  }

  process.stdout.write(
    `${dryRun ? 'DRY RUN: ' : ''}Distilled learnings into ${additionsBySkill.size} skill(s) and marked ${logsToMarkProcessed.length} log(s) processed.\n`,
  );
}

/**
 * CLI entrypoint for this script.
 */
async function main() {
  const [, , cmd, ...argv] = process.argv;
  const repoRoot = getRepoRoot();
  if (!cmd || cmd === '-h' || cmd === '--help') {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  switch (cmd) {
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
    default:
      fail(`SkillOps: unknown command '${cmd}' (expected: lint|log|debrief|distill)`);
  }
}

main().catch((err) => {
  process.stderr.write(`${(err && err.message) || String(err)}\n`);
  process.exit(1);
});
