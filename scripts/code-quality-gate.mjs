#!/usr/bin/env node

import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

function usage() {
  return [
    'code-quality-gate',
    '',
    'Usage:',
    '  node scripts/code-quality-gate.mjs check [--task-kind <KIND>] [--artifact <path>] [--base-ref <ref>]',
    '',
    'Examples:',
    '  node scripts/code-quality-gate.mjs check --task-kind EXECUTE',
    '  node scripts/code-quality-gate.mjs check --task-kind USER_REQUEST --artifact .codex/quality/logs/custom.md',
    '  node scripts/code-quality-gate.mjs check --task-kind EXECUTE --base-ref origin/main',
  ].join('\n');
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

const QUALITY_ESCAPE_RULES = [
  /\b(?:TODO|FIXME)\b/i,
  /@ts-ignore\b/i,
  /eslint-disable\b/i,
  /#\s*type:\s*ignore\b/i,
  /^\s*except\s*:\s*$/,
  /^\s*except\s+Exception\s*:\s*pass\s*$/,
  /\|\|\s*true\b/,
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

function collectEscapeLineNumbers(text) {
  const linesWithHits = new Set();
  const lines = String(text || '').split(/\r?\n/);
  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx];
    for (const rule of QUALITY_ESCAPE_RULES) {
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
      for (const rule of QUALITY_ESCAPE_RULES) {
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

function listQualityEscapes(cwd, baseRef = '') {
  const ref = String(baseRef || '').trim();
  const qualityEscapes = [];
  if (ref) {
    const raw = tryGit(cwd, ['diff', '--unified=0', '--no-color', `${ref}...HEAD`]);
    qualityEscapes.push(...parseAddedEscapeHitsFromDiff(raw));
  } else {
    const raw = tryGit(cwd, ['diff', '--unified=0', '--no-color', 'HEAD']);
    qualityEscapes.push(...parseAddedEscapeHitsFromDiff(raw));
  }
  return qualityEscapes;
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

function listChangedPathsFromCommitRange(cwd, baseRef) {
  const hasHead = tryGit(cwd, ['rev-parse', '--verify', 'HEAD']);
  if (!hasHead) return [];

  let names = '';
  if (baseRef) {
    names = tryGit(cwd, ['diff', '--name-only', `${baseRef}...HEAD`]);
    if (names) return normalizePathList(names);
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

function listAddedCodeWindows(cwd, baseRef = '') {
  const ref = String(baseRef || '').trim();
  const args = ref
    ? ['diff', '--unified=0', '--no-color', `${ref}...HEAD`]
    : ['diff', '--unified=0', '--no-color', 'HEAD'];
  const raw = String(tryGit(cwd, args) || '');
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

async function runNodeScriptIfPresent(repoRoot, scriptRelPath, args = []) {
  const scriptAbs = path.join(repoRoot, scriptRelPath);
  if (!(await fileExists(scriptAbs))) {
    return { skipped: true, ok: true, command: null, stderr: '', stdout: '' };
  }
  const command = `node ${scriptRelPath}${args.length ? ` ${args.join(' ')}` : ''}`;
  const res = run('node', [scriptAbs, ...args], { cwd: repoRoot });
  return {
    skipped: false,
    ok: res.status === 0,
    command,
    stderr: String(res.stderr || ''),
    stdout: String(res.stdout || ''),
  };
}

async function check({ repoRoot, taskKind, artifactPathRel, baseRef = '' }) {
  const errors = [];
  const warnings = [];
  const checks = [];

  const resolvedBaseRef = String(baseRef || '').trim();
  let changedPaths = listChangedPaths(repoRoot);
  let changedScope = 'working-tree';
  if (changedPaths.length === 0) {
    const commitRangePaths = listChangedPathsFromCommitRange(repoRoot, resolvedBaseRef || null);
    if (commitRangePaths.length > 0) {
      changedPaths = commitRangePaths;
      changedScope = resolvedBaseRef ? `commit-range:${resolvedBaseRef}...HEAD` : 'commit-range:HEAD~1..HEAD';
    }
  }
  const changedFiles = changedPaths.filter((p) => !p.endsWith('/'));
  const diffRef = changedScope.startsWith('commit-range:') ? (resolvedBaseRef || 'HEAD~1') : '';
  const skillFilesChanged = changedFiles.some((p) => /^\.codex\/skills\/.+\/SKILL\.md$/.test(p));
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
  checks.push({
    name: 'no-merge-conflict-markers',
    passed: conflictMarkers.length === 0,
    details: conflictMarkers.length ? `found markers in: ${conflictMarkers.join(', ')}` : 'ok',
  });
  if (conflictMarkers.length) errors.push(`merge conflict markers found in ${conflictMarkers.length} file(s)`);

  const qualityEscapes = listQualityEscapes(repoRoot, diffRef);
  const qualityEscapeSet = new Set(qualityEscapes);
  const untracked = new Set(listUntrackedPaths(repoRoot));
  for (const [rel, contents] of changedFileContents.entries()) {
    if (!untracked.has(rel) || !shouldScanQualityEscapes(rel)) continue;
    const lineNumbers = collectEscapeLineNumbers(contents);
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
    const lineNumbers = collectEscapeLineNumbers(contents);
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

  // Anti-bloat volume check.
  const numstat = parseNumstat(listNumstat(repoRoot, diffRef));
  const additiveNoDeletion = numstat.added >= 350 && numstat.deleted === 0;
  const unbalancedGrowth = numstat.added >= 700 && numstat.added > numstat.deleted * 10;
  const volumeOk = !(additiveNoDeletion || unbalancedGrowth);
  checks.push({
    name: 'diff-volume-balanced',
    passed: volumeOk,
    details: `added=${numstat.added} deleted=${numstat.deleted}`,
  });
  if (!volumeOk) {
    errors.push('diff volume suggests additive bloat; trim redundant code and remove dead paths');
  }

  // Duplicate added block check (candidate repeated logic in same delta).
  const windows = listAddedCodeWindows(repoRoot, diffRef);
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
    details: duplicateBlocks.length ? `found ${duplicateBlocks.length} repeated added code block(s)` : 'ok',
    sampleBlocks: duplicateBlocks.slice(0, 4),
  });
  if (duplicateBlocks.length) {
    errors.push('duplicate added code blocks detected; consolidate shared logic');
  }

  const checkByName = new Map(checks.map((c) => [c.name, c]));
  const pass = (name) => Boolean(checkByName.get(name)?.passed === true);
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
      passed: pass('runtime-script-change-has-tests'),
      check: 'runtime-script-change-has-tests',
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
  }

  const result = {
    ok: errors.length === 0,
    taskKind,
    repoRoot,
    checkedAt: new Date().toISOString(),
    changedScope,
    changedFilesCount: changedFiles.length,
    skillFilesChanged,
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
    errors: result.errors,
    warnings: result.warnings,
    checks: result.checks,
    hardRules: result.hardRules,
  };
  process.stdout.write(`${JSON.stringify(out)}\n`);
  if (!result.ok) process.exitCode = 2;
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] || '';
  if (!cmd || cmd === '--help' || cmd === '-h') {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (cmd !== 'check') {
    fail(`unknown command: ${cmd}`);
  }

  const repoRoot = getRepoRoot();
  const taskKind = String(getArgValue(argv, '--task-kind') || '').trim().toUpperCase() || 'UNKNOWN';
  const artifactArg = String(getArgValue(argv, '--artifact') || '').trim();
  const baseRef = String(getArgValue(argv, '--base-ref') || '').trim();
  const artifactPathRel =
    artifactArg ||
    path.join('.codex', 'quality', 'logs', `${nowId()}__${toSlug(taskKind) || 'quality-check'}.md`);
  await check({ repoRoot, taskKind, artifactPathRel, baseRef });
}

main().catch((err) => {
  process.stderr.write(`ERROR: ${(err && err.stack) || String(err)}\n`);
  process.exitCode = 1;
});
