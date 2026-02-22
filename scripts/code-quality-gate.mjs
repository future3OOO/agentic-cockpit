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
  const linesWithHits = [];
  const lines = String(text || '').split(/\r?\n/);
  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx];
    for (const rule of QUALITY_ESCAPE_RULES) {
      if (!rule.test(line)) continue;
      linesWithHits.push(idx + 1);
      break;
    }
  }
  return linesWithHits;
}

function shouldScanQualityEscapes(relPath) {
  const p = String(relPath || '').replace(/\\/g, '/');
  if (!p) return false;
  if (p === 'scripts/code-quality-gate.mjs') return false;
  if (p.endsWith('.md')) return false;
  if (p.startsWith('.codex/skills/')) return false;
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

  const qualityEscapes = [];
  for (const [rel, contents] of changedFileContents.entries()) {
    if (!shouldScanQualityEscapes(rel)) continue;
    const lineNumbers = collectEscapeLineNumbers(contents);
    for (const line of lineNumbers) {
      qualityEscapes.push(`${rel}:${line}`);
    }
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
    errors,
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
    checks: result.checks,
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
