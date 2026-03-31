import childProcess from 'node:child_process';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { parseNumstatRecords as parseModularityNumstatRecords, normalizeRepoPath } from './code-quality-modularity.mjs';

function readGitErrorText(err) {
  const parts = [err?.message, err?.stderr, err?.stdout].map((value) => String(value || '').trim()).filter(Boolean);
  return parts.join(' | ');
}

function isMissingHeadRevisionError(err) {
  const text = readGitErrorText(err).toLowerCase();
  return (
    text.includes("ambiguous argument 'head'") ||
    text.includes("bad revision 'head'") ||
    text.includes('needed a single revision') ||
    text.includes('unknown revision or path not in the working tree')
  );
}

function throwGitReadError(label, err) {
  throw new Error(`${label}: ${readGitErrorText(err) || String(err)}`, { cause: err });
}

export function readNumstatRecordsForCommitOrWorkingTree({
  cwd,
  commitSha = '',
  isCommitObjectMissingError,
  unreadableFileLineCount = 10_000,
}) {
  const readNumstat = (args, { ignoreMissingCommit = false } = {}) => {
    try {
      const raw = childProcess.execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return parseModularityNumstatRecords(raw);
    } catch (err) {
      if (ignoreMissingCommit && typeof isCommitObjectMissingError === 'function' && isCommitObjectMissingError(err)) {
        return [];
      }
      throw err;
    }
  };
  const commit = String(commitSha || '').trim();
  if (commit) {
    try {
      return readNumstat(['show', '--numstat', '--pretty=format:', commit], { ignoreMissingCommit: true });
    } catch (err) {
      if (!(typeof isCommitObjectMissingError === 'function' && isCommitObjectMissingError(err))) throw err;
      return [];
    }
  }
  try {
    childProcess.execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    if (isMissingHeadRevisionError(err)) return [];
    throwGitReadError('working-tree preflight git rev-parse failed', err);
  }

  let diffRecords;
  try {
    diffRecords = readNumstat(['diff', '--numstat', 'HEAD']);
  } catch (err) {
    throwGitReadError('working-tree preflight git diff --numstat HEAD failed', err);
  }

  let untrackedRaw = '';
  try {
    untrackedRaw = childProcess.execFileSync(
      'git',
      ['ls-files', '--others', '--exclude-standard'],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (err) {
    throwGitReadError('working-tree preflight git ls-files failed', err);
  }

  const existing = new Set(diffRecords.map((record) => normalizeRepoPath(record.file)));
  const untrackedFiles = Array.from(
    new Set(
      String(untrackedRaw || '')
        .split(/\r?\n/)
        .map((line) => normalizeRepoPath(line))
        .filter(Boolean),
    ),
  );
  for (const file of untrackedFiles) {
    if (existing.has(file)) continue;
    try {
      const raw = readFileSync(path.join(cwd, file), 'utf8');
      const split = raw.split(/\r?\n/);
      const lineCount = raw.length === 0 ? 0 : raw.endsWith('\n') ? split.length - 1 : split.length;
      diffRecords.push({ file, added: Math.max(0, lineCount), deleted: 0 });
    } catch {
      diffRecords.push({ file, added: unreadableFileLineCount, deleted: 0 });
    }
  }
  return diffRecords;
}
