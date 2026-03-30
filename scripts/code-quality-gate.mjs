#!/usr/bin/env node

import childProcess from 'node:child_process';
import nodeFs from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

function usage() {
  return [
    'code-quality-gate',
    '',
    'Usage:',
    '  node scripts/code-quality-gate.mjs check [--task-kind <KIND>] [--artifact <path>] [--base-ref <ref>] [--exception-id <id>]',
    '',
    'Examples:',
    '  node scripts/code-quality-gate.mjs check --task-kind EXECUTE',
    '  node scripts/code-quality-gate.mjs check --task-kind USER_REQUEST --artifact .codex/quality/logs/custom.md',
    '  node scripts/code-quality-gate.mjs check --task-kind EXECUTE --base-ref origin/main',
    '  node scripts/code-quality-gate.mjs check --task-kind USER_REQUEST --base-ref origin/main --exception-id pr24-opus-consult-subsystem',
  ].join('\n');
}

async function writeStdout(text) {
  nodeFs.writeFileSync(1, text, { encoding: 'utf8', flag: 'a' });
}

function fail(message) {
  throw new Error(message);
}

function run(cmd, args, { cwd } = {}) {
  const res = childProcess.spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (res.error) throw res.error;
  return res;
}

function tryGit(cwd, args) {
  try {
    const res = run('git', args, { cwd });
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

function getHeadRef(cwd) {
  return String(tryGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']) || '').trim();
}

function getArgValue(argv, key) {
  for (let i = 0; i < argv.length; i += 1) {
    const v = argv[i];
    if (v === key) return argv[i + 1];
    if (v.startsWith(`${key}=`)) return v.slice(key.length + 1);
  }
  return null;
}

function normalizePathList(rawList) {
  return Array.from(
    new Set(
      String(rawList || '')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((p) => p.split(path.sep).join('/')),
    ),
  );
}

const GENERAL_QUALITY_ESCAPE_RULES = [
  /\b(?:TODO|FIXME)\b/i,
  /@ts-ignore\b/i,
  /eslint-disable\b/i,
  /#\s*type:\s*ignore\b/i,
  /^\s*except\s*:\s*$/,
  /^\s*except\s+Exception\s*:\s*pass\s*$/,
  /\|\|\s*true\b/,
];

const PYTHON_QUALITY_ESCAPE_RULES = [
  /#\s*noqa\b/i,
  /\btyping\.Any\b/,
  /:\s*Any\b/,
  /\bcast\s*\(/,
];

const TS_QUALITY_ESCAPE_RULES = [
  /:\s*any\b/,
  /<\s*any\s*>/,
  /\bas\s+unknown\s+as\b/,
];

const QUALITY_ESCAPE_BLOCK_RULES = [
  /\bcatch\s*\(\s*[^)]*\s*\)\s*\{\s*\}/g,
  /\bcatch\s*\{\s*\}/g,
  /\.catch\s*\(\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{\s*\}\s*\)/g,
];

function cloneRegex(rule) {
  return new RegExp(rule.source, rule.flags);
}

function ensurePathWithinRepo(repoRoot, candidateAbs) {
  const repoRootAbs = path.resolve(repoRoot);
  const rel = path.relative(repoRootAbs, candidateAbs);
  if (!rel) return '';
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    fail('artifact path must be within repo root');
  }
  return rel;
}

function collectEscapeLineNumbers(text, rules) {
  const linesWithHits = new Set();
  const lines = String(text || '').split(/\r?\n/);
  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx];
    for (const rule of rules) {
      if (!rule.test(line)) continue;
      linesWithHits.add(idx + 1);
      break;
    }
  }
  const full = String(text || '');
  for (const rule of QUALITY_ESCAPE_BLOCK_RULES) {
    const blockRule = cloneRegex(rule);
    for (const match of full.matchAll(blockRule)) {
      const index = Number(match?.index ?? -1);
      if (index < 0) continue;
      const lineNo = full.slice(0, index).split(/\r?\n/).length;
      linesWithHits.add(lineNo);
    }
  }
  return Array.from(linesWithHits).sort((a, b) => a - b);
}

function parseAddedEscapeHitsFromDiff(rawDiff) {
  const hits = new Set();
  let currentFile = '';
  let newLineNo = 0;
  let addedHunkLines = [];
  const lines = String(rawDiff || '').split(/\r?\n/);

  const flushAddedHunk = () => {
    if (!currentFile || addedHunkLines.length === 0 || !shouldScanQualityEscapes(currentFile)) {
      addedHunkLines = [];
      return;
    }
    const addedText = addedHunkLines.map((entry) => entry.text).join('\n');
    for (const rule of QUALITY_ESCAPE_BLOCK_RULES) {
      const blockRule = cloneRegex(rule);
      for (const match of addedText.matchAll(blockRule)) {
        const index = Number(match?.index ?? -1);
        if (index < 0) continue;
        const lineOffset = addedText.slice(0, index).split(/\r?\n/).length - 1;
        const entry = addedHunkLines[Math.max(0, Math.min(lineOffset, addedHunkLines.length - 1))];
        if (!entry) continue;
        hits.add(`${currentFile}:${entry.lineNo}`);
      }
    }
    addedHunkLines = [];
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flushAddedHunk();
      currentFile = '';
      newLineNo = 0;
      continue;
    }
    if (line.startsWith('+++ b/')) {
      flushAddedHunk();
      currentFile = line.slice('+++ b/'.length).trim();
      continue;
    }
    if (line.startsWith('@@ ')) {
      flushAddedHunk();
      const m = line.match(/\+(\d+)(?:,\d+)?/);
      newLineNo = m ? Number(m[1]) : 0;
      continue;
    }
    if (!currentFile || !newLineNo || !shouldScanQualityEscapes(currentFile)) continue;
    if (line.startsWith('+') && !line.startsWith('+++')) {
      const added = line.slice(1);
      for (const rule of qualityEscapeRulesForPath(currentFile)) {
        if (!rule.test(added)) continue;
        hits.add(`${currentFile}:${newLineNo}`);
        break;
      }
      addedHunkLines.push({ lineNo: newLineNo, text: added });
      newLineNo += 1;
      continue;
    }
    flushAddedHunk();
    if (line.startsWith(' ') && !line.startsWith('+++')) {
      newLineNo += 1;
    }
  }
  flushAddedHunk();
  return Array.from(hits);
}

function listUntrackedPaths(cwd) {
  const raw = tryGit(cwd, ['ls-files', '--others', '--exclude-standard']);
  return normalizePathList(raw);
}

function listUnifiedDiff(cwd, baseRef = '') {
  const ref = String(baseRef || '').trim();
  const args = ref
    ? ['diff', '--unified=0', '--no-color', `${ref}...HEAD`]
    : ['diff', '--unified=0', '--no-color', 'HEAD'];
  return String(tryGit(cwd, args) || '');
}

function listQualityEscapesFromDiff(rawDiff) {
  return parseAddedEscapeHitsFromDiff(String(rawDiff || ''));
}

function shouldScanQualityEscapes(relPath) {
  const p = String(relPath || '').replace(/\\/g, '/');
  if (!p) return false;
  if (p === 'scripts/code-quality-gate.mjs') return false;
  if (p.endsWith('.md')) return false;
  if (p.startsWith('.codex/skills/')) return false;
  if (p === '.codex/quality/logs' || p.startsWith('.codex/quality/logs/')) return false;
  if (p.startsWith('__tests__/')) return false;
  if (p.includes('/__tests__/')) return false;
  if (/\.test\./.test(p)) return false;
  return true;
}

function qualityEscapeRulesForPath(relPath) {
  const p = String(relPath || '').replace(/\\/g, '/').toLowerCase();
  const rules = [...GENERAL_QUALITY_ESCAPE_RULES];
  if (p.endsWith('.py')) rules.push(...PYTHON_QUALITY_ESCAPE_RULES);
  if (p.endsWith('.ts') || p.endsWith('.tsx') || p.endsWith('.mts') || p.endsWith('.cts')) {
    rules.push(...TS_QUALITY_ESCAPE_RULES);
  }
  return rules;
}

function isTempArtifactPath(relPath) {
  const p = String(relPath || '').replace(/\\/g, '/').toLowerCase();
  if (!p) return false;
  if (/^\.codex-tmp\/\.codex-git-credentials\./.test(p)) return false;
  if (/(^|\/)(?:\.codex-tmp|\.tmp|tmp|temp)\//.test(p)) return true;
  return /\.(?:orig|rej|bak|tmp)$/.test(p);
}

function listChangedPathsFromCommitRange(cwd, baseRef) {
  const hasHead = tryGit(cwd, ['rev-parse', '--verify', 'HEAD']);
  if (!hasHead) return [];

  const base = String(baseRef || '').trim();
  let names = '';
  if (base) {
    const hasBase = tryGit(cwd, ['rev-parse', '--verify', base]);
    if (!hasBase) return null;
    names = tryGit(cwd, ['diff', '--name-only', `${base}...HEAD`]);
    return normalizePathList(names);
  }

  const hasHeadParent = Boolean(tryGit(cwd, ['rev-parse', '--verify', 'HEAD~1']));
  if (hasHeadParent) {
    names = tryGit(cwd, ['diff', '--name-only', 'HEAD~1..HEAD']);
    if (names) return normalizePathList(names);
  }

  names = tryGit(cwd, ['show', '--name-only', '--pretty=format:', 'HEAD']);
  return normalizePathList(names);
}

function listNumstat(cwd, baseRef = '') {
  const ref = String(baseRef || '').trim();
  const args = ref ? ['diff', '--numstat', `${ref}...HEAD`] : ['diff', '--numstat', 'HEAD'];
  return String(tryGit(cwd, args) || '');
}

function parseNumstat(raw) {
  let added = 0;
  let deleted = 0;
  const records = [];
  const lines = String(raw || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    const parts = line.split(/\t+/);
    if (parts.length < 3) continue;
    const add = Number(parts[0]);
    const del = Number(parts[1]);
    const file = parts.slice(2).join('\t');
    const addSafe = Number.isFinite(add) ? add : 0;
    const delSafe = Number.isFinite(del) ? del : 0;
    added += addSafe;
    deleted += delSafe;
    records.push({ file: file.split(path.sep).join('/'), added: addSafe, deleted: delSafe });
  }
  return { added, deleted, records };
}

function listAddedCodeWindowsFromDiff(raw) {
  if (!raw) return [];

  const windows = [];
  let currentFile = '';
  let hunk = [];

  const flushHunk = () => {
    if (hunk.length < 3 || !currentFile) {
      hunk = [];
      return;
    }
    const normalized = hunk
      .map((line) => line.trim().replace(/\s+/g, ' ').replace(/[;,]\s*$/, ''))
      .filter(Boolean)
      .filter((line) => !/^[/#*]/.test(line));
    for (let i = 0; i <= normalized.length - 3; i += 1) {
      const chunk = normalized.slice(i, i + 3);
      const key = chunk.join(' | ');
      if (key.length < 80) continue;
      windows.push({ file: currentFile, key });
    }
    hunk = [];
  };

  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      flushHunk();
      currentFile = '';
      continue;
    }
    if (line.startsWith('+++ b/')) {
      currentFile = line.slice('+++ b/'.length).trim();
      continue;
    }
    if (line.startsWith('@@ ')) {
      flushHunk();
      continue;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      hunk.push(line.slice(1));
    }
  }
  flushHunk();
  return windows;
}

function parseChangedLineRanges(rawDiff, relPath) {
  const targetPath = String(relPath || '').replace(/\\/g, '/');
  if (!targetPath || !rawDiff) return [];
  const ranges = [];
  let currentFile = '';
  for (const line of String(rawDiff).split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      currentFile = '';
      continue;
    }
    if (line.startsWith('+++ b/')) {
      currentFile = line.slice('+++ b/'.length).trim().replace(/\\/g, '/');
      continue;
    }
    if (currentFile !== targetPath || !line.startsWith('@@ ')) continue;
    const match = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (!match) continue;
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    if (!Number.isFinite(start) || start < 0) continue;
    const normalizedCount = Number.isFinite(count) && count > 0 ? count : 0;
    ranges.push({
      start,
      end: normalizedCount > 0 ? start + normalizedCount - 1 : start,
    });
  }
  return ranges;
}

function diffTouchesPatterns(rawDiff, relPath, patterns) {
  const targetPath = String(relPath || '').replace(/\\/g, '/');
  if (!targetPath || !rawDiff) return false;
  const matchers = Array.isArray(patterns)
    ? patterns
        .map((value) => {
          if (value instanceof RegExp) return value;
          const text = String(value || '').toLowerCase();
          return text ? text : null;
        })
        .filter(Boolean)
    : [];
  if (matchers.length === 0) return false;
  let currentFile = '';
  for (const line of String(rawDiff).split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      currentFile = '';
      continue;
    }
    if (line.startsWith('+++ b/')) {
      currentFile = line.slice('+++ b/'.length).trim().replace(/\\/g, '/');
      continue;
    }
    if (currentFile !== targetPath) continue;
    if (
      (line.startsWith('+') && !line.startsWith('+++')) ||
      (line.startsWith('-') && !line.startsWith('---'))
    ) {
      const text = line.slice(1).toLowerCase();
      if (matchers.some((matcher) => (matcher instanceof RegExp ? matcher.test(text) : text.includes(matcher)))) {
        return true;
      }
    }
  }
  return false;
}

function lineMatchesPattern(line, pattern) {
  if (pattern instanceof RegExp) return pattern.test(line);
  return line.includes(String(pattern || ''));
}

function resolveAnchoredSectionRanges(sourceText, sections) {
  const lines = String(sourceText || '').split(/\r?\n/);
  if (!Array.isArray(sections) || sections.length === 0 || lines.length === 0) return [];
  const findLineIndex = (pattern, fromIndex = 0) => {
    for (let idx = Math.max(0, fromIndex); idx < lines.length; idx += 1) {
      if (lineMatchesPattern(lines[idx], pattern)) return idx;
    }
    return -1;
  };
  const ranges = [];
  for (const section of sections) {
    const startIndex = findLineIndex(section?.startPattern, 0);
    if (startIndex === -1) continue;
    const endIndex =
      section?.endPattern !== undefined ? findLineIndex(section.endPattern, startIndex + 1) : -1;
    ranges.push({
      start: startIndex + 1,
      end: endIndex === -1 ? lines.length : Math.max(startIndex + 1, endIndex),
    });
  }
  return ranges;
}

function diffTouchesAnchoredSections(rawDiff, relPath, { sourceText, sections, fallbackPatterns = [] }) {
  const touchedRanges = parseChangedLineRanges(rawDiff, relPath);
  if (touchedRanges.length === 0) return false;
  const sectionRanges = resolveAnchoredSectionRanges(sourceText, sections);
  const touchedAnchoredSection =
    sectionRanges.length > 0 &&
    touchedRanges.some((range) =>
      sectionRanges.some((section) => range.start <= section.end && range.end >= section.start),
    );
  if (touchedAnchoredSection) return true;
  return diffTouchesPatterns(rawDiff, relPath, fallbackPatterns);
}

const WORKER_CODE_QUALITY_PATH_SECTION_DEFS = [
  {
    startPattern: /^function buildCodeQualityGatePromptBlock\(/,
    endPattern: /^function buildObserverDrainGatePromptBlock\(/,
  },
  {
    startPattern: /^async function runCodeQualityGateCheck\(/,
    endPattern: /^const CODE_QUALITY_HARD_RULE_KEYS = \[/,
  },
  {
    startPattern: /^const CODE_QUALITY_HARD_RULE_KEYS = \[/,
    endPattern: /^function validateCodeQualityReviewEvidence\(/,
  },
  {
    startPattern: /^function validateCodeQualityReviewEvidence\(/,
    endPattern: /^function buildPrompt\(/,
  },
];

const WORKER_CODE_QUALITY_PATH_FALLBACK_PATTERNS = [
  /buildcodequalitygatepromptblock/,
  /follow the active repo\/adapter quality skill guidance/,
  /before editing, inspect the current implementation/,
  /before returning outcome="done", run this self-review/,
  /hardrulechecks\.\{codevolume,noduplication,shortestpath,cleanup,anticipateconsequences,simplicity\}/,
  /missing qualityreview evidence rejects outcome="done"/,
  /runcodequalitygatecheck/,
  /parsedhardrules/,
  /code quality gate missing hardrules evidence/,
  /hard rule not satisfied:/,
  /code_quality_hard_rule_keys/,
  /validatecodequalityreviewevidence/,
  /qualityreview\.(summary|legacydebtwarnings|hardrulechecks)/,
];

const WORKER_CODE_QUALITY_EXTRACTED_FILES = [
  'scripts/lib/worker-code-quality.mjs',
  'scripts/lib/worker-code-quality-state.mjs',
  'scripts/lib/blocked-recovery-fingerprint.mjs',
];

const CODE_QUALITY_GATE_POLICY_SECTION_DEFS = [
  {
    startPattern: /^function parseChangedLineRanges\(/,
    endPattern: /^function toSlug\(/,
  },
  {
    startPattern: /^function listMissingCoupledPaths\(/,
    endPattern: /^async function resolveCodeQualityException\(/,
  },
  {
    startPattern: /^\s*const gateScriptChanged = /,
    endPattern: /^\s*\/\/ Anti-bloat volume check\./,
  },
  {
    startPattern: /^\s*const anticipateConsequencesChecks = \[/,
    endPattern: /^\s*\/\/ Skill file formatting\/lint checks only when SKILL\.md changed\./,
  },
];

const CODE_QUALITY_GATE_POLICY_FALLBACK_PATTERNS = [
  /(?:gatecontractchanged|cockpitcodequalityskillchanged|workerqualitypathchanged|codequalitypolicychanged)/,
  /listmissingcoupledpaths\(/,
  /\bmissing\w*paths\.(?:length|join|slice)\b/,
  /name:\s*'(?:code-quality-gate-script-has-tests|code-quality-gate-contract-change-has-runtime-reference|cockpit-code-quality-skill-change-is-coupled|worker-code-quality-path-change-is-coupled|code-quality-policy-change-has-decisions)'/,
  /(?:scripts\/__tests__\/code-quality-gate\.test\.mjs|docs\/agentic\/runtime_function_reference\.md|docs\/runbooks\/code_review_checklist\.md|docs\/runbooks\/quality_bar\.md|scripts\/__tests__\/codex-worker-app-server\.test\.mjs|docs\/agentic\/decisions_and_incidents_timeline\.md|decisions\.md)/,
  /(?:scripts\/code-quality-gate\.mjs changes require|contract or policy changes require|runtime reference updates|quality_bar updates|policy changes require)/,
];

function toSlug(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function nowId() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function listChangedPaths(cwd) {
  try {
    const raw = childProcess.execFileSync(
      'git',
      ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const out = new Set();
    const records = String(raw || '').split('\0').filter(Boolean);
    for (let i = 0; i < records.length; i += 1) {
      const record = records[i];
      if (!record || record.length < 4) continue;
      const x = record[0];
      const pathOne = record.slice(3);
      if (pathOne) out.add(pathOne.split(path.sep).join('/'));
      if (x === 'R' || x === 'C') {
        const pathTwo = records[i + 1] || '';
        if (pathTwo) out.add(pathTwo.split(path.sep).join('/'));
        i += 1;
      }
    }
    return Array.from(out);
  } catch {
    return [];
  }
}

function defaultScopeIncludeRules() {
  return ['**'];
}

function defaultScopeExcludeRules() {
  return [
    '.codex/quality/logs/**',
    '.codex/skill-ops/logs/**',
    '.codex-tmp/**',
    'docs/**',
    'build/**',
    'dist/**',
    'tmp/**',
    'temp/**',
  ];
}

function parseScopeRules(raw, fallback) {
  const items = String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length > 0 ? items : fallback.slice();
}

function matchRule(relPath, rule) {
  const p = String(relPath || '').replace(/\\/g, '/');
  const r = String(rule || '').replace(/\\/g, '/').trim();
  if (!r) return false;
  if (r === '**') return true;
  if (r.endsWith('/**')) {
    const base = r.slice(0, -3);
    return p === base || p.startsWith(`${base}/`);
  }
  return p === r;
}

function isPathInSourceScope(relPath, includeRules, excludeRules) {
  const p = String(relPath || '').replace(/\\/g, '/');
  if (!p) return false;
  const included = includeRules.some((rule) => matchRule(p, rule));
  if (!included) return false;
  const excluded = excludeRules.some((rule) => matchRule(p, rule));
  return !excluded;
}

async function fileExists(filePath) {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readText(filePath) {
  return await fs.readFile(filePath, 'utf8');
}

async function resolveScriptCandidate(repoRoot, scriptRelPath, { allowCockpitFallback = true } = {}) {
  const localPath = path.join(repoRoot, scriptRelPath);
  if (await fileExists(localPath)) {
    return { scriptAbs: localPath, commandPath: scriptRelPath };
  }
  if (!allowCockpitFallback) return null;
  const cockpitRootRaw = String(process.env.COCKPIT_ROOT || '').trim();
  if (!cockpitRootRaw) return null;
  const cockpitPath = path.join(path.resolve(cockpitRootRaw), scriptRelPath);
  if (!(await fileExists(cockpitPath))) return null;
  return { scriptAbs: cockpitPath, commandPath: `"${cockpitPath}"` };
}

async function runNodeScriptIfPresent(
  repoRoot,
  scriptRelPath,
  args = [],
  { allowCockpitFallback = true } = {},
) {
  const resolved = await resolveScriptCandidate(repoRoot, scriptRelPath, { allowCockpitFallback });
  if (!resolved) {
    return { skipped: true, ok: true, command: null, stderr: '', stdout: '' };
  }
  const command = `node ${resolved.commandPath}${args.length ? ` ${args.join(' ')}` : ''}`;
  const res = run('node', [resolved.scriptAbs, ...args], { cwd: repoRoot });
  return {
    skipped: false,
    ok: res.status === 0,
    command,
    stderr: String(res.stderr || ''),
    stdout: String(res.stdout || ''),
  };
}

const SUPPORTED_EXCEPTION_CHECKS = new Set([
  'diff-volume-balanced',
  'no-duplicate-added-blocks',
]);

async function loadCodeQualityException(repoRoot, exceptionId) {
  const registryPath = path.join(repoRoot, 'docs', 'agentic', 'CODE_QUALITY_EXCEPTIONS.json');
  let registryRaw = '';
  try {
    registryRaw = await readText(registryPath);
  } catch (err) {
    throw new Error(
      `code-quality exception registry missing: ${path.relative(repoRoot, registryPath) || registryPath}`,
    );
  }

  let parsed = null;
  try {
    parsed = JSON.parse(registryRaw);
  } catch (err) {
    throw new Error(`code-quality exception registry invalid JSON: ${(err && err.message) || String(err)}`);
  }

  if (!parsed || typeof parsed !== 'object' || parsed.version !== 1 || !Array.isArray(parsed.exceptions)) {
    throw new Error('code-quality exception registry must contain {"version":1,"exceptions":[...]}');
  }

  const entry = parsed.exceptions.find(
    (candidate) => candidate && typeof candidate === 'object' && String(candidate.id || '').trim() === exceptionId,
  );
  if (!entry) {
    throw new Error(`code-quality exception not found: ${exceptionId}`);
  }

  const checks = Array.isArray(entry.checks)
    ? entry.checks.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  if (checks.length === 0) {
    throw new Error(`code-quality exception ${exceptionId} must declare at least one waived check`);
  }
  const unsupportedChecks = checks.filter((name) => !SUPPORTED_EXCEPTION_CHECKS.has(name));
  if (unsupportedChecks.length > 0) {
    throw new Error(
      `code-quality exception ${exceptionId} attempts to waive unsupported checks: ${unsupportedChecks.join(', ')}`,
    );
  }

  return {
    id: exceptionId,
    baseRef: String(entry.baseRef || '').trim(),
    headRef: String(entry.headRef || '').trim(),
    checks,
    decisionRef: String(entry.decisionRef || '').trim(),
    reason: String(entry.reason || '').trim(),
    expiresAt: String(entry.expiresAt || '').trim(),
    registryPath: path.relative(repoRoot, registryPath).split(path.sep).join('/'),
  };
}

function isExpiredException(expiresAt) {
  const raw = String(expiresAt || '').trim();
  if (!raw) return false;
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`code-quality exception expiresAt must be valid ISO timestamp: ${raw}`);
  }
  return Date.now() > parsed;
}

function listMissingCoupledPaths(changedFileContents, requiredPaths) {
  const existingChanges = changedFileContents instanceof Map ? changedFileContents : new Map();
  return Array.isArray(requiredPaths)
    ? requiredPaths.filter((relPath) => !existingChanges.has(String(relPath || '')))
    : [];
}

async function resolveCodeQualityException(repoRoot, { exceptionId, baseRef }) {
  const id = String(exceptionId || '').trim();
  if (!id) return null;

  const resolvedBaseRef = String(baseRef || '').trim();
  if (!resolvedBaseRef) {
    throw new Error('--exception-id requires --base-ref');
  }

  const entry = await loadCodeQualityException(repoRoot, id);
  if (entry.baseRef !== resolvedBaseRef) {
    throw new Error(
      `code-quality exception ${id} expects baseRef=${entry.baseRef || '(unset)'}, got ${resolvedBaseRef}`,
    );
  }

  const headRef = getHeadRef(repoRoot);
  if (!headRef || headRef === 'HEAD') {
    throw new Error(`code-quality exception ${id} requires a named branch checkout`);
  }
  if (entry.headRef !== headRef) {
    throw new Error(
      `code-quality exception ${id} expects headRef=${entry.headRef || '(unset)'}, got ${headRef}`,
    );
  }
  if (isExpiredException(entry.expiresAt)) {
    throw new Error(`code-quality exception ${id} expired at ${entry.expiresAt}`);
  }

  return {
    ...entry,
    currentHeadRef: headRef,
  };
}

async function check({ repoRoot, taskKind, artifactPathRel, baseRef = '', exceptionId = '' }) {
  const errors = [];
  const warnings = [];
  const checks = [];

  const resolvedBaseRef = String(baseRef || '').trim();
  let resolvedException = null;
  if (String(exceptionId || '').trim()) {
    try {
      resolvedException = await resolveCodeQualityException(repoRoot, {
        exceptionId,
        baseRef: resolvedBaseRef,
      });
    } catch (err) {
      errors.push((err && err.message) || String(err));
    }
  }
  const waivedChecks = new Set(resolvedException?.checks || []);
  const scopeIncludeRules = parseScopeRules(
    process.env.AGENTIC_CODE_QUALITY_SCOPE_INCLUDE ?? process.env.VALUA_CODE_QUALITY_SCOPE_INCLUDE ?? '',
    defaultScopeIncludeRules(),
  );
  const scopeExcludeRules = parseScopeRules(
    process.env.AGENTIC_CODE_QUALITY_SCOPE_EXCLUDE ?? process.env.VALUA_CODE_QUALITY_SCOPE_EXCLUDE ?? '',
    defaultScopeExcludeRules(),
  );
  let changedPaths = [];
  let changedScope = 'working-tree';
  if (resolvedBaseRef) {
    const commitRangePaths = listChangedPathsFromCommitRange(repoRoot, resolvedBaseRef);
    if (commitRangePaths === null) {
      errors.push(`base-ref not found: ${resolvedBaseRef}`);
      changedPaths = [];
    } else {
      changedPaths = commitRangePaths;
    }
    changedScope = `commit-range:${resolvedBaseRef}...HEAD`;
  } else {
    changedPaths = listChangedPaths(repoRoot);
    if (changedPaths.length === 0) {
      const commitRangePaths = listChangedPathsFromCommitRange(repoRoot, null);
      if (commitRangePaths.length > 0) {
        changedPaths = commitRangePaths;
        changedScope = 'commit-range:HEAD~1..HEAD';
      }
    }
  }
  const changedFiles = changedPaths.filter((p) => !p.endsWith('/'));
  const changedFilesSample = changedFiles.slice(0, 20);
  const sourceFiles = changedFiles.filter((p) => isPathInSourceScope(p, scopeIncludeRules, scopeExcludeRules));
  const sourceFilesCount = sourceFiles.length;
  const artifactOnlyChange = changedFiles.length > 0 && sourceFilesCount === 0;
  const diffRef = changedScope.startsWith('commit-range:') ? (resolvedBaseRef || 'HEAD~1') : '';
  const rawDiff = listUnifiedDiff(repoRoot, diffRef);
  const skillFilesChanged = changedFiles.some((p) => /^\.codex\/skills\/.+\/SKILL\.md$/.test(p));
  const gateScriptChanged = changedFiles.includes('scripts/code-quality-gate.mjs');
  const cockpitCodeQualitySkillChanged = changedFiles.includes('.codex/skills/cockpit-code-quality-gate/SKILL.md');
  /** @type {Map<string,string>} */
  const changedFileContents = new Map();

  // Deterministic low-noise checks to enforce production hygiene.
  const conflictMarkers = [];
  for (const rel of changedFiles) {
    const abs = path.join(repoRoot, rel);
    if (!(await fileExists(abs))) continue;
    let contents = '';
    try {
      contents = await readText(abs);
    } catch {
      continue;
    }
    changedFileContents.set(rel, contents);
    if (/^<{7} |^={7}$|^>{7} /m.test(contents)) {
      conflictMarkers.push(rel);
    }
  }
  const gateScriptSource = changedFileContents.get('scripts/code-quality-gate.mjs') || '';
  const gateContractChanged =
    gateScriptChanged &&
    (gateScriptSource
      ? diffTouchesAnchoredSections(rawDiff, 'scripts/code-quality-gate.mjs', {
          sourceText: gateScriptSource,
          sections: CODE_QUALITY_GATE_POLICY_SECTION_DEFS,
          fallbackPatterns: CODE_QUALITY_GATE_POLICY_FALLBACK_PATTERNS,
        })
      : true);
  const workerSource = changedFileContents.get('scripts/agent-codex-worker.mjs') || '';
  const workerQualityPathChanged =
    WORKER_CODE_QUALITY_EXTRACTED_FILES.some((file) => changedFiles.includes(file)) ||
    (changedFiles.includes('scripts/agent-codex-worker.mjs') &&
      (workerSource
        ? diffTouchesAnchoredSections(rawDiff, 'scripts/agent-codex-worker.mjs', {
            sourceText: workerSource,
            sections: WORKER_CODE_QUALITY_PATH_SECTION_DEFS,
            fallbackPatterns: WORKER_CODE_QUALITY_PATH_FALLBACK_PATTERNS,
          })
        : true));
  checks.push({
    name: 'no-merge-conflict-markers',
    passed: conflictMarkers.length === 0,
    details: conflictMarkers.length ? `found markers in: ${conflictMarkers.join(', ')}` : 'ok',
  });
  if (conflictMarkers.length) errors.push(`merge conflict markers found in ${conflictMarkers.length} file(s)`);

  const qualityEscapes = listQualityEscapesFromDiff(rawDiff);
  const qualityEscapeSet = new Set(qualityEscapes);
  const untracked = new Set(listUntrackedPaths(repoRoot));
  for (const [rel, contents] of changedFileContents.entries()) {
    if (!untracked.has(rel) || !shouldScanQualityEscapes(rel)) continue;
    const lineNumbers = collectEscapeLineNumbers(contents, qualityEscapeRulesForPath(rel));
    for (const line of lineNumbers) qualityEscapes.push(`${rel}:${line}`);
  }
  checks.push({
    name: 'no-quality-escapes',
    passed: qualityEscapes.length === 0,
    details: qualityEscapes.length ? `found ${qualityEscapes.length} candidate escape(s)` : 'ok',
    samplePaths: qualityEscapes.slice(0, 10),
  });
  if (qualityEscapes.length) {
    errors.push('quality escapes detected in changed files');
  }

  const legacyQualityDebt = [];
  for (const [rel, contents] of changedFileContents.entries()) {
    if (untracked.has(rel) || !shouldScanQualityEscapes(rel)) continue;
    const lineNumbers = collectEscapeLineNumbers(contents, qualityEscapeRulesForPath(rel));
    for (const line of lineNumbers) {
      const marker = `${rel}:${line}`;
      if (!qualityEscapeSet.has(marker)) legacyQualityDebt.push(marker);
    }
  }
  checks.push({
    name: 'legacy-quality-debt-advisory',
    passed: legacyQualityDebt.length === 0,
    blocking: false,
    details: legacyQualityDebt.length
      ? `found ${legacyQualityDebt.length} legacy escape(s) in touched tracked files`
      : 'none',
    samplePaths: legacyQualityDebt.slice(0, 10),
  });
  if (legacyQualityDebt.length) {
    warnings.push('legacy quality debt found in touched tracked files (non-blocking): remediate in this change or file a follow-up');
  }

  const tempArtifacts = [];
  for (const rel of changedFiles) {
    if (!isTempArtifactPath(rel)) continue;
    if (!(await fileExists(path.join(repoRoot, rel)))) continue;
    tempArtifacts.push(rel);
  }
  checks.push({
    name: 'no-temp-artifacts',
    passed: tempArtifacts.length === 0,
    details: tempArtifacts.length ? `found ${tempArtifacts.length} temporary artifact path(s)` : 'ok',
    samplePaths: tempArtifacts.slice(0, 10),
  });
  if (tempArtifacts.length) {
    errors.push('temporary artifact paths detected in changed files');
  }

  // Downstream consequence check: runtime script changes must include tests in the same delta.
  const runtimeScriptChanges = changedFiles.filter(
    (p) => p.startsWith('scripts/') && p.endsWith('.mjs') && !p.startsWith('scripts/__tests__/'),
  );
  const runtimeTestsChanged = changedFiles.some((p) => p.startsWith('scripts/__tests__/') && p.endsWith('.test.mjs'));
  const runtimeCoverageOk = runtimeScriptChanges.length === 0 || runtimeTestsChanged;
  checks.push({
    name: 'runtime-script-change-has-tests',
    passed: runtimeCoverageOk,
    details: runtimeCoverageOk
      ? 'ok'
      : `runtime scripts changed without script tests: ${runtimeScriptChanges.slice(0, 8).join(', ')}`,
  });
  if (!runtimeCoverageOk) {
    errors.push('runtime script changes require matching scripts/__tests__ coverage in same delta');
  }

  if (gateScriptChanged) {
    const missingCoupledPaths = listMissingCoupledPaths(changedFileContents, [
      'scripts/__tests__/code-quality-gate.test.mjs',
    ]);
    checks.push({
      name: 'code-quality-gate-script-has-tests',
      passed: missingCoupledPaths.length === 0,
      details: missingCoupledPaths.length
        ? `missing coupled updates: ${missingCoupledPaths.join(', ')}`
        : 'ok',
      samplePaths: missingCoupledPaths.slice(0, 10),
    });
    if (missingCoupledPaths.length) {
      errors.push(
        'scripts/code-quality-gate.mjs changes require scripts/__tests__/code-quality-gate.test.mjs in the same delta',
      );
    }
  }

  if (gateContractChanged) {
    const missingCoupledPaths = listMissingCoupledPaths(changedFileContents, [
      'docs/agentic/RUNTIME_FUNCTION_REFERENCE.md',
    ]);
    checks.push({
      name: 'code-quality-gate-contract-change-has-runtime-reference',
      passed: missingCoupledPaths.length === 0,
      details: missingCoupledPaths.length
        ? `missing coupled updates: ${missingCoupledPaths.join(', ')}`
        : 'ok',
      samplePaths: missingCoupledPaths.slice(0, 10),
    });
    if (missingCoupledPaths.length) {
      errors.push(
        'scripts/code-quality-gate.mjs contract or policy changes require docs/agentic/RUNTIME_FUNCTION_REFERENCE.md',
      );
    }
  }

  if (cockpitCodeQualitySkillChanged) {
    const missingCoupledPaths = listMissingCoupledPaths(changedFileContents, [
      'docs/runbooks/CODE_REVIEW_CHECKLIST.md',
      'docs/runbooks/QUALITY_BAR.md',
    ]);
    checks.push({
      name: 'cockpit-code-quality-skill-change-is-coupled',
      passed: missingCoupledPaths.length === 0,
      details: missingCoupledPaths.length
        ? `missing coupled updates: ${missingCoupledPaths.join(', ')}`
        : 'ok',
      samplePaths: missingCoupledPaths.slice(0, 10),
    });
    if (missingCoupledPaths.length) {
      errors.push(
        '.codex/skills/cockpit-code-quality-gate/SKILL.md changes require CODE_REVIEW_CHECKLIST and QUALITY_BAR updates',
      );
    }
  }

  if (workerQualityPathChanged) {
    const missingCoupledPaths = listMissingCoupledPaths(changedFileContents, [
      'scripts/__tests__/codex-worker-app-server.test.mjs',
      'docs/agentic/RUNTIME_FUNCTION_REFERENCE.md',
    ]);
    checks.push({
      name: 'worker-code-quality-path-change-is-coupled',
      passed: missingCoupledPaths.length === 0,
      details: missingCoupledPaths.length
        ? `missing coupled updates: ${missingCoupledPaths.join(', ')}`
        : 'ok',
      samplePaths: missingCoupledPaths.slice(0, 10),
    });
    if (missingCoupledPaths.length) {
      errors.push(
        'scripts/agent-codex-worker.mjs code-quality prompt/validation changes require app-server tests and runtime reference updates',
      );
    }
  }

  const codeQualityPolicyChanged =
    gateContractChanged || cockpitCodeQualitySkillChanged || workerQualityPathChanged;
  if (codeQualityPolicyChanged) {
    const missingPolicyPaths = listMissingCoupledPaths(changedFileContents, [
      'DECISIONS.md',
      'docs/agentic/DECISIONS_AND_INCIDENTS_TIMELINE.md',
    ]);
    checks.push({
      name: 'code-quality-policy-change-has-decisions',
      passed: missingPolicyPaths.length === 0,
      details: missingPolicyPaths.length
        ? `missing policy updates: ${missingPolicyPaths.join(', ')}`
        : 'ok',
      samplePaths: missingPolicyPaths.slice(0, 10),
    });
    if (missingPolicyPaths.length) {
      errors.push(
        'code quality policy changes require DECISIONS.md and DECISIONS_AND_INCIDENTS_TIMELINE.md updates',
      );
    }
  }

  // Anti-bloat volume check.
  const numstat = parseNumstat(listNumstat(repoRoot, diffRef));
  const additiveNoDeletion = numstat.added >= 350 && numstat.deleted === 0;
  const unbalancedGrowth = numstat.added >= 700 && numstat.added > numstat.deleted * 10;
  const volumeOk = !(additiveNoDeletion || unbalancedGrowth);
  checks.push({
    name: 'diff-volume-balanced',
    passed: volumeOk,
    blocking: !waivedChecks.has('diff-volume-balanced'),
    details: `added=${numstat.added} deleted=${numstat.deleted}`,
    waived: waivedChecks.has('diff-volume-balanced'),
    waivedBy: waivedChecks.has('diff-volume-balanced') ? resolvedException?.id || '' : '',
    decisionRef: waivedChecks.has('diff-volume-balanced') ? resolvedException?.decisionRef || '' : '',
  });
  if (!volumeOk && !waivedChecks.has('diff-volume-balanced')) {
    errors.push('diff volume suggests additive bloat; trim redundant code and remove dead paths');
  }

  // Duplicate added block check (candidate repeated logic in same delta).
  const windows = listAddedCodeWindowsFromDiff(rawDiff);
  const counts = new Map();
  for (const item of windows) {
    const prev = counts.get(item.key) || { count: 0, files: new Set() };
    prev.count += 1;
    prev.files.add(item.file);
    counts.set(item.key, prev);
  }
  const duplicateBlocks = Array.from(counts.entries())
    .filter(([, data]) => data.count > 1)
    .map(([key, data]) => ({
      count: data.count,
      files: Array.from(data.files),
      sample: key.slice(0, 180),
    }))
    .filter((item) => item.files.some((file) => shouldScanQualityEscapes(file)));
  checks.push({
    name: 'no-duplicate-added-blocks',
    passed: duplicateBlocks.length === 0,
    blocking: !waivedChecks.has('no-duplicate-added-blocks'),
    details: duplicateBlocks.length ? `found ${duplicateBlocks.length} repeated added code block(s)` : 'ok',
    sampleBlocks: duplicateBlocks.slice(0, 4),
    waived: waivedChecks.has('no-duplicate-added-blocks'),
    waivedBy: waivedChecks.has('no-duplicate-added-blocks') ? resolvedException?.id || '' : '',
    decisionRef: waivedChecks.has('no-duplicate-added-blocks') ? resolvedException?.decisionRef || '' : '',
  });
  if (duplicateBlocks.length && !waivedChecks.has('no-duplicate-added-blocks')) {
    errors.push('duplicate added code blocks detected; consolidate shared logic');
  }

  const checkByName = new Map(checks.map((c) => [c.name, c]));
  const pass = (name) => {
    const check = checkByName.get(name);
    return Boolean(check && (check.passed === true || check.blocking === false));
  };
  const anticipateConsequencesChecks = [
    'runtime-script-change-has-tests',
    'code-quality-gate-script-has-tests',
    'code-quality-gate-contract-change-has-runtime-reference',
    'cockpit-code-quality-skill-change-is-coupled',
    'worker-code-quality-path-change-is-coupled',
    'code-quality-policy-change-has-decisions',
  ].filter((name) => checkByName.has(name));
  const hardRules = {
    codeVolume: {
      passed: pass('diff-volume-balanced'),
      check: 'diff-volume-balanced',
    },
    noDuplication: {
      passed: pass('no-duplicate-added-blocks'),
      check: 'no-duplicate-added-blocks',
    },
    shortestPath: {
      passed: pass('diff-volume-balanced') && pass('no-duplicate-added-blocks'),
      checks: ['diff-volume-balanced', 'no-duplicate-added-blocks'],
    },
    cleanup: {
      passed: pass('no-quality-escapes'),
      check: 'no-quality-escapes',
    },
    anticipateConsequences: {
      passed: anticipateConsequencesChecks.every((name) => pass(name)),
      checks: anticipateConsequencesChecks,
    },
    simplicity: {
      passed: pass('diff-volume-balanced') && pass('no-duplicate-added-blocks'),
      checks: ['diff-volume-balanced', 'no-duplicate-added-blocks'],
    },
  };

  // Skill file formatting/lint checks only when SKILL.md changed.
  if (skillFilesChanged) {
    const validate = await runNodeScriptIfPresent(repoRoot, 'scripts/validate-codex-skills.mjs');
    checks.push({
      name: 'validate-codex-skills',
      passed: validate.ok,
      details: validate.skipped ? 'script missing (skipped)' : validate.ok ? 'ok' : 'failed',
      command: validate.command,
    });
    if (!validate.ok) {
      errors.push('scripts/validate-codex-skills.mjs failed');
    }

    const formatCheck = await runNodeScriptIfPresent(repoRoot, 'scripts/skills-format.mjs', ['--check']);
    checks.push({
      name: 'skills-format-check',
      passed: formatCheck.ok,
      details: formatCheck.skipped ? 'script missing (skipped)' : formatCheck.ok ? 'ok' : 'failed',
      command: formatCheck.command,
    });
    if (!formatCheck.ok) {
      errors.push('scripts/skills-format.mjs --check failed');
    }

    const skillopsLint = await runNodeScriptIfPresent(
      repoRoot,
      'scripts/skillops.mjs',
      ['lint'],
      { allowCockpitFallback: false },
    );
    checks.push({
      name: 'skillops-lint',
      passed: skillopsLint.ok,
      details: skillopsLint.skipped ? 'script missing (skipped)' : skillopsLint.ok ? 'ok' : 'failed',
      command: skillopsLint.command,
    });
    if (!skillopsLint.ok) {
      errors.push('scripts/skillops.mjs lint failed');
    }

    const anyValidatorPresent = [validate, formatCheck, skillopsLint].some((runResult) => !runResult.skipped);
    if (!anyValidatorPresent) {
      errors.push('no skill validators available (expected validate-codex-skills, skills-format, or skillops lint)');
    }
  }

  const result = {
    ok: errors.length === 0,
    taskKind,
    repoRoot,
    checkedAt: new Date().toISOString(),
    changedScope,
    changedFilesCount: changedFiles.length,
    changedFilesSample,
    sourceFilesCount,
    sourceFilesSeenCount: sourceFilesCount,
    artifactOnlyChange,
    scopeIncludeRules,
    scopeExcludeRules,
    skillFilesChanged,
    exception: resolvedException
      ? {
          id: resolvedException.id,
          baseRef: resolvedException.baseRef,
          headRef: resolvedException.headRef,
          decisionRef: resolvedException.decisionRef,
          registryPath: resolvedException.registryPath,
          checks: resolvedException.checks,
          reason: resolvedException.reason,
          expiresAt: resolvedException.expiresAt,
        }
      : null,
    checks,
    hardRules,
    errors,
    warnings,
  };

  const markdown = [
    '# Code Quality Gate Report',
    '',
    `- taskKind: ${taskKind || '(unknown)'}`,
    `- checkedAt: ${result.checkedAt}`,
    `- changedScope: ${changedScope}`,
    `- changedFilesCount: ${changedFiles.length}`,
    `- skillFilesChanged: ${skillFilesChanged ? 'yes' : 'no'}`,
    ...(resolvedException
      ? [
          `- exception: ${resolvedException.id}`,
          `- exceptionDecisionRef: ${resolvedException.decisionRef || '(none)'}`,
          `- exceptionChecks: ${resolvedException.checks.join(', ')}`,
        ]
      : []),
    `- verdict: ${result.ok ? 'pass' : 'fail'}`,
    '',
    '## Checks',
    ...checks.map((c) => `- ${c.name}: ${c.passed ? 'pass' : 'fail'} (${c.details})`),
    '',
    '## Errors',
    ...(errors.length ? errors.map((e) => `- ${e}`) : ['- none']),
    '',
    '## Warnings',
    ...(warnings.length ? warnings.map((w) => `- ${w}`) : ['- none']),
    '',
    '## Changed Files (sample)',
    ...(changedFiles.length ? changedFiles.slice(0, 200).map((p) => `- ${p}`) : ['- none']),
    '',
    '## Machine Readable',
    '```json',
    JSON.stringify(result, null, 2),
    '```',
    '',
  ].join('\n');

  const artifactAbs = path.resolve(repoRoot, artifactPathRel);
  const artifactRel = ensurePathWithinRepo(repoRoot, artifactAbs);
  await fs.mkdir(path.dirname(artifactAbs), { recursive: true });
  await fs.writeFile(artifactAbs, markdown, 'utf8');

  const out = {
    ok: result.ok,
    artifactPath: (artifactRel || path.basename(artifactAbs)).split(path.sep).join('/'),
    changedScope: result.changedScope,
    changedFilesSample: result.changedFilesSample,
    sourceFilesCount: result.sourceFilesCount,
    sourceFilesSeenCount: result.sourceFilesSeenCount,
    artifactOnlyChange: result.artifactOnlyChange,
    errors: result.errors,
    warnings: result.warnings,
    checks: result.checks,
    hardRules: result.hardRules,
    exception: result.exception,
  };
  await writeStdout(`${JSON.stringify(out)}\n`);
  if (!result.ok) process.exitCode = 2;
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] || '';
  if (!cmd || cmd === '--help' || cmd === '-h') {
    await writeStdout(`${usage()}\n`);
    return;
  }
  if (cmd !== 'check') {
    fail(`unknown command: ${cmd}`);
  }

  const repoRoot = getRepoRoot();
  const taskKind = String(getArgValue(argv, '--task-kind') || '').trim().toUpperCase() || 'UNKNOWN';
  const artifactArg = String(getArgValue(argv, '--artifact') || '').trim();
  const baseRef = String(getArgValue(argv, '--base-ref') || '').trim();
  const exceptionId = String(getArgValue(argv, '--exception-id') || '').trim();
  const artifactPathRel =
    artifactArg ||
    path.join('.codex', 'quality', 'logs', `${nowId()}__${toSlug(taskKind) || 'quality-check'}.md`);
  await check({ repoRoot, taskKind, artifactPathRel, baseRef, exceptionId });
}

try {
  await main();
} catch (err) {
  process.stderr.write(`ERROR: ${(err && err.stack) || String(err)}\n`);
  process.exitCode = 1;
}
