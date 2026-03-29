import childProcess from 'node:child_process';
import path from 'node:path';
import { promises as fs } from 'node:fs';

export const MODULARITY_SOURCE_EXTENSIONS = new Set([
  '.mjs',
  '.js',
  '.cjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.py',
  '.sh',
]);

export const PROTECTED_HOSTS = [
  'scripts/agent-codex-worker.mjs',
  'scripts/agent-orchestrator-worker.mjs',
  'scripts/agent-opus-consult-worker.mjs',
  'scripts/agent-bus.mjs',
  'scripts/code-quality-gate.mjs',
];

export const PROTECTED_HOST_ALLOWED_ROOTS = Object.freeze(
  Object.fromEntries(PROTECTED_HOSTS.map((file) => [file, ['scripts/lib/']])),
);

export const NON_TEST_FILE_CAP = 300;
export const NO_GROWTH_THRESHOLD = 500;
export const NET_GROWTH_THRESHOLD = 120;
export const PROTECTED_HOST_ADD_CAP = 50;

const BINARY_FALLBACK_DELTA = 10_000;
const PROTECTED_HOST_SET = new Set(PROTECTED_HOSTS);

export function gitText(cwd, args) {
  try {
    return childProcess.execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return '';
  }
}

export function normalizeRepoPath(value) {
  return String(value || '').trim().replace(/\\/g, '/');
}

export function countPhysicalLines(text) {
  return String(text).split(/\r?\n/).length;
}

function escapeRegex(value) {
  return String(value || '').replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function globToRegex(rule) {
  const normalized = normalizeRepoPath(rule);
  if (!normalized) return null;
  let pattern = '';
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];
    if (char === '*' && next === '*') {
      pattern += '.*';
      index += 1;
      continue;
    }
    if (char === '*') {
      pattern += '[^/]*';
      continue;
    }
    if (char === '?') {
      pattern += '[^/]';
      continue;
    }
    pattern += escapeRegex(char);
  }
  return new RegExp(`^${pattern}$`);
}

export function matchRepoPathRule(relPath, rule) {
  const pathValue = normalizeRepoPath(relPath);
  const ruleValue = normalizeRepoPath(rule);
  if (!pathValue || !ruleValue) return false;
  if (ruleValue === '**') return true;
  const regex = globToRegex(ruleValue);
  return Boolean(regex && regex.test(pathValue));
}

function isTestLikePath(relPath) {
  const pathValue = normalizeRepoPath(relPath).toLowerCase();
  if (!pathValue) return true;
  return (
    pathValue.startsWith('docs/') ||
    pathValue.startsWith('logs/') ||
    pathValue.includes('/logs/') ||
    pathValue.startsWith('test/') ||
    pathValue.startsWith('tests/') ||
    pathValue.includes('/test/') ||
    pathValue.includes('/tests/') ||
    pathValue.includes('/__tests__/') ||
    pathValue.includes('/__snapshots__/') ||
    pathValue.includes('/snapshots/') ||
    pathValue.includes('/fixtures/') ||
    pathValue.includes('/fixture/') ||
    pathValue.includes('/generated/') ||
    pathValue.endsWith('.schema.json') ||
    /\.test\./.test(pathValue) ||
    /\.spec\./.test(pathValue)
  );
}

export function isModularityScopedSourcePath(relPath) {
  const normalized = normalizeRepoPath(relPath);
  if (!normalized) return false;
  const ext = path.posix.extname(normalized).toLowerCase();
  if (!MODULARITY_SOURCE_EXTENSIONS.has(ext)) return false;
  return !isTestLikePath(normalized);
}

export function isProtectedHostPath(relPath) {
  return PROTECTED_HOST_SET.has(normalizeRepoPath(relPath));
}

export function parseNumstatRecords(raw) {
  return String(raw || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\t+/))
    .filter((parts) => parts.length >= 3)
    .map((parts) => {
      const addedValue = Number(parts[0]);
      const deletedValue = Number(parts[1]);
      return {
        file: normalizeRepoPath(parts.slice(2).join('\t')),
        added: Number.isFinite(addedValue) ? addedValue : BINARY_FALLBACK_DELTA,
        deleted: Number.isFinite(deletedValue) ? deletedValue : BINARY_FALLBACK_DELTA,
      };
    })
    .filter((record) => Boolean(record.file));
}

async function fileExists(filePath) {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readCurrentFileText(repoRoot, relPath) {
  const abs = path.join(repoRoot, relPath);
  if (!(await fileExists(abs))) return null;
  return await fs.readFile(abs, 'utf8');
}

export function readFileTextAtRef(repoRoot, ref, relPath) {
  const normalizedRef = String(ref || '').trim() || 'HEAD';
  try {
    return childProcess.execFileSync('git', ['show', `${normalizedRef}:${relPath}`], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
}

export function buildRecordMap(records) {
  const map = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    map.set(normalizeRepoPath(record.file), {
      file: normalizeRepoPath(record.file),
      added: Number(record.added) || 0,
      deleted: Number(record.deleted) || 0,
    });
  }
  return map;
}

export function sumShrinkCreditsByParentDir(details) {
  const byDir = new Map();
  for (const detail of details) {
    const netChange = detail.added - detail.deleted;
    if (netChange >= 0) continue;
    byDir.set(detail.parentDir, (byDir.get(detail.parentDir) || 0) + Math.abs(netChange));
  }
  return byDir;
}

export function normalizePlanText(value) {
  return String(value || '').trim();
}
