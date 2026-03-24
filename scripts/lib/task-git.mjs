import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readSkillOpsLogSummary } from './skillops-log.mjs';

function trim(value) {
  return String(value ?? '').trim();
}

export function normalizeRepoPath(relPath) {
  return String(relPath || '').replace(/\\/g, '/').replace(/^\.\/+/, '').trim();
}

function decodeQuotedPorcelainPath(rawPath) {
  const text = String(rawPath ?? '');
  if (!text) return '';
  if (!(text.startsWith('"') && text.endsWith('"'))) {
    return normalizeRepoPath(text);
  }
  const bytes = [];
  for (let i = 1; i < text.length - 1; i += 1) {
    const ch = text[i];
    if (ch !== '\\') {
      bytes.push(...Buffer.from(ch, 'utf8'));
      continue;
    }
    i += 1;
    if (i >= text.length - 1) return null;
    const esc = text[i];
    if (/[0-7]/.test(esc)) {
      let octal = esc;
      while (octal.length < 3 && i + 1 < text.length - 1 && /[0-7]/.test(text[i + 1])) {
        i += 1;
        octal += text[i];
      }
      bytes.push(parseInt(octal, 8));
      continue;
    }
    if (esc === '"') bytes.push('"'.charCodeAt(0));
    else if (esc === '\\') bytes.push('\\'.charCodeAt(0));
    else if (esc === 'a') bytes.push(0x07);
    else if (esc === 'b') bytes.push(0x08);
    else if (esc === 'f') bytes.push(0x0c);
    else if (esc === 'n') bytes.push(0x0a);
    else if (esc === 'r') bytes.push(0x0d);
    else if (esc === 't') bytes.push(0x09);
    else if (esc === 'v') bytes.push(0x0b);
    else return null;
  }
  return normalizeRepoPath(Buffer.from(bytes).toString('utf8'));
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isValidBranchName(name) {
  // Conservative validation: allow common git branch characters and slashes.
  // This avoids accidentally passing whitespace or shell-ish content into git.
  return typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/.test(name);
}

function normalizeBranchName(name) {
  const raw = trim(name);
  if (!raw) return null;
  const withoutPrefix = raw.startsWith('refs/heads/') ? raw.slice('refs/heads/'.length) : raw;
  if (!isValidBranchName(withoutPrefix)) return null;
  return withoutPrefix;
}

function isValidSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{7,40}$/i.test(value.trim());
}

function normalizeSha(value) {
  const raw = trim(value);
  if (!raw) return null;
  if (!isValidSha(raw)) return null;
  return raw;
}

function run(cmd, args, { cwd }) {
  const res = childProcess.spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    ok: res.status === 0,
    status: res.status ?? 1,
    stdout: String(res.stdout ?? ''),
    stderr: String(res.stderr ?? ''),
  };
}

function git(args, { cwd }) {
  return run('git', args, { cwd });
}

function gitText(args, { cwd }) {
  const res = git(args, { cwd });
  if (!res.ok) return null;
  const s = res.stdout.trim();
  return s ? s : null;
}

function gitOk(args, { cwd }) {
  const res = git(args, { cwd });
  return res.ok;
}

export function readRepoCommonGitDir({ cwd }) {
  const raw = gitText(['rev-parse', '--git-common-dir'], { cwd });
  if (!raw) return '';
  return path.resolve(cwd, raw);
}

function truncate(value, maxLen = 500) {
  const s = String(value ?? '');
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen).trimEnd() + '…';
}

function isDisposableRuntimeArtifactPath(relPath) {
  const p = normalizeRepoPath(relPath).toLowerCase().replace(/\/+$/, '');
  if (!p) return false;
  return (
    p === '.codex/quality' ||
    p.startsWith('.codex/quality/') ||
    p === '.codex/reviews' ||
    p.startsWith('.codex/reviews/') ||
    p === '.codex-tmp' ||
    p.startsWith('.codex-tmp/') ||
    p === 'artifacts' ||
    p.startsWith('artifacts/')
  );
}

function isSkillOpsLogPath(relPath) {
  const p = normalizeRepoPath(relPath).toLowerCase().replace(/\/+$/, '');
  if (!p) return false;
  if (!p.startsWith('.codex/skill-ops/logs/')) return false;
  if (!p.endsWith('.md')) return false;
  return path.basename(p) !== 'readme.md';
}

function isSkillOpsTreePath(relPath) {
  const p = normalizeRepoPath(relPath).toLowerCase().replace(/\/+$/, '');
  if (!p) return false;
  return p === '.codex/skill-ops' || p.startsWith('.codex/skill-ops/');
}

function splitNonEmptyLines(raw) {
  return String(raw || '')
    .split(/\r?\n/)
    .map((line) => String(line || '').trimEnd())
    .filter(Boolean);
}

function listDirEntries(absPath) {
  return fs.readdirSync(absPath, { withFileTypes: true });
}

function everyDisposableDirEntry(absPath, visitEntry) {
  const entries = listDirEntries(absPath);
  if (!entries.length) return true;
  for (const entry of entries) {
    if (!visitEntry(entry)) return false;
  }
  return true;
}

function loadSkillOpsPromotionStateIndex(skillOpsPromotionStateDir) {
  const index = new Map();
  if (!skillOpsPromotionStateDir) return index;
  let files = [];
  try {
    files = fs
      .readdirSync(skillOpsPromotionStateDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => path.join(skillOpsPromotionStateDir, entry.name));
  } catch {
    return index;
  }
  for (const file of files) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const promotionTaskId = trim(parsed?.promotionTaskId);
      const sourceLogIds = Array.isArray(parsed?.sourceLogIds)
        ? parsed.sourceLogIds.map((value) => trim(value)).filter(Boolean)
        : [];
      if (!promotionTaskId || sourceLogIds.length === 0) continue;
      for (const logId of sourceLogIds) {
        index.set(`${promotionTaskId}::${logId}`, true);
      }
    } catch {
      // malformed state stays blocking
    }
  }
  return index;
}

function isDisposableEmptySkillOpsLog(absPath) {
  const summary = readSkillOpsLogSummarySafe(absPath);
  if (!summary) return false;
  if (summary.hasNonEmptySkillUpdates) return false;
  return !summary.hasMeaningfulBody;
}

function readSkillOpsLogSummarySafe(absPath) {
  try {
    return readSkillOpsLogSummary(fs.readFileSync(absPath, 'utf8'));
  } catch {
    return null;
  }
}

function collectSkillOpsLogDetails(absPath, relPath) {
  const details = [];
  try {
    const st = fs.statSync(absPath);
    if (st.isFile()) {
      if (!isSkillOpsLogPath(relPath)) return details;
      const summary = readSkillOpsLogSummarySafe(absPath);
      if (!summary) return details;
      details.push({ relPath: normalizeRepoPath(relPath), summary });
      return details;
    }
    if (!st.isDirectory()) return details;
    for (const entry of fs.readdirSync(absPath, { withFileTypes: true })) {
      const childAbs = path.join(absPath, entry.name);
      const childRel = normalizeRepoPath(path.posix.join(relPath, entry.name));
      if (entry.isDirectory()) {
        details.push(...collectSkillOpsLogDetails(childAbs, childRel));
        continue;
      }
      if (!entry.isFile()) continue;
      const summary = isSkillOpsLogPath(childRel) ? readSkillOpsLogSummarySafe(childAbs) : null;
      if (!summary) continue;
      details.push({ relPath: childRel, summary });
    }
  } catch {
    return details;
  }
  return details;
}

function isTerminalHandledSkillOpsStatus(summary) {
  return summary?.status === 'processed' || summary?.status === 'skipped';
}

function isNonBlockingHandledSkillOpsLog(absPath, skillOpsPromotionStateIndex) {
  const summary = readSkillOpsLogSummarySafe(absPath);
  if (!summary) return false;
  if (summary.status === 'queued') {
    if (!summary.queuedAt || !summary.promotionTaskId || !summary.id) return false;
    return skillOpsPromotionStateIndex.has(`${summary.promotionTaskId}::${summary.id}`);
  }
  return isTerminalHandledSkillOpsStatus(summary);
}

function isCleanableHandledSkillOpsLog(absPath) {
  return isTerminalHandledSkillOpsStatus(readSkillOpsLogSummarySafe(absPath));
}

function isNonBlockingSkillOpsEntry(absPath, skillOpsPromotionStateIndex) {
  try {
    const st = fs.statSync(absPath);
    if (st.isFile()) {
      return (
        isNonBlockingHandledSkillOpsLog(absPath, skillOpsPromotionStateIndex) ||
        isDisposableEmptySkillOpsLog(absPath)
      );
    }
    if (!st.isDirectory()) return false;
    return everyDisposableDirEntry(absPath, (entry) => {
      const childPath = path.join(absPath, entry.name);
      if (entry.isDirectory()) {
        return isNonBlockingSkillOpsEntry(childPath, skillOpsPromotionStateIndex);
      }
      if (!entry.isFile()) return false;
      if (entry.name.toLowerCase() === 'readme.md') return true;
      return (
        isNonBlockingHandledSkillOpsLog(childPath, skillOpsPromotionStateIndex) ||
        isDisposableEmptySkillOpsLog(childPath)
      );
    });
  } catch {
    return false;
  }
}

function isRemovableSkillOpsEntry(absPath) {
  try {
    const st = fs.statSync(absPath);
    if (st.isFile()) {
      return isCleanableHandledSkillOpsLog(absPath) || isDisposableEmptySkillOpsLog(absPath);
    }
    if (!st.isDirectory()) return false;
    return everyDisposableDirEntry(absPath, (entry) => {
      const childPath = path.join(absPath, entry.name);
      if (entry.isDirectory()) {
        return isRemovableSkillOpsEntry(childPath);
      }
      if (!entry.isFile()) return false;
      if (entry.name.toLowerCase() === 'readme.md') return true;
      return isCleanableHandledSkillOpsLog(childPath) || isDisposableEmptySkillOpsLog(childPath);
    });
  } catch {
    return false;
  }
}

function isNonBlockingRuntimeEntry(absPath, relPath, { skillOpsPromotionStateIndex } = {}) {
  const p = normalizeRepoPath(relPath).toLowerCase().replace(/\/+$/, '');
  if (!p) return false;
  try {
    const st = fs.statSync(absPath);
    if (st.isFile()) {
      if (isDisposableRuntimeArtifactPath(p)) return true;
      if (isSkillOpsLogPath(p)) {
        return isNonBlockingHandledSkillOpsLog(absPath, skillOpsPromotionStateIndex) || isDisposableEmptySkillOpsLog(absPath);
      }
      return false;
    }
    if (!st.isDirectory()) return false;
    if (isDisposableRuntimeArtifactPath(p)) return true;
    if (isSkillOpsTreePath(p)) return isNonBlockingSkillOpsEntry(absPath, skillOpsPromotionStateIndex);
    if (p !== '.codex') return false;

    return everyDisposableDirEntry(absPath, (entry) => {
      const childAbs = path.join(absPath, entry.name);
      const childRel = normalizeRepoPath(path.posix.join(p, entry.name));
      return isNonBlockingRuntimeEntry(childAbs, childRel, { skillOpsPromotionStateIndex });
    });
  } catch {
    return false;
  }
}

function isRemovableRuntimeEntry(absPath, relPath) {
  const p = normalizeRepoPath(relPath).toLowerCase().replace(/\/+$/, '');
  if (!p) return false;
  try {
    const st = fs.statSync(absPath);
    if (st.isFile()) {
      if (isDisposableRuntimeArtifactPath(p)) return true;
      if (isSkillOpsLogPath(p)) {
        return isCleanableHandledSkillOpsLog(absPath) || isDisposableEmptySkillOpsLog(absPath);
      }
      return false;
    }
    if (!st.isDirectory()) return false;
    if (isDisposableRuntimeArtifactPath(p)) return true;
    if (isSkillOpsTreePath(p)) return isRemovableSkillOpsEntry(absPath);
    if (p !== '.codex') return false;

    return everyDisposableDirEntry(absPath, (entry) => {
      const childAbs = path.join(absPath, entry.name);
      const childRel = normalizeRepoPath(path.posix.join(p, entry.name));
      return isRemovableRuntimeEntry(childAbs, childRel);
    });
  } catch {
    return false;
  }
}

function extractUntrackedPorcelainPath(line) {
  const raw = String(line || '').trimEnd();
  if (!raw.startsWith('?? ')) return null;
  const relPath = decodeQuotedPorcelainPath(raw.slice(3));
  if (!relPath) return relPath;
  return relPath.replace(/\/+$/, '');
}

function parsePorcelainPaths(rawPath, { splitRenameArrow = false } = {}) {
  const raw = String(rawPath || '').trim();
  if (!raw) return { primary: '', secondary: '' };
  const arrowIdx = splitRenameArrow ? raw.lastIndexOf(' -> ') : -1;
  if (arrowIdx > 0) {
    const before = decodeQuotedPorcelainPath(raw.slice(0, arrowIdx));
    const after = decodeQuotedPorcelainPath(raw.slice(arrowIdx + 4));
    return {
      primary: normalizeRepoPath(after || before).replace(/\/+$/, ''),
      secondary: normalizeRepoPath(before).replace(/\/+$/, ''),
    };
  }
  return {
    primary: normalizeRepoPath(decodeQuotedPorcelainPath(raw)).replace(/\/+$/, ''),
    secondary: '',
  };
}

function parsePorcelainStatusLine(line) {
  const raw = String(line || '').trimEnd();
  if (raw.length < 3) return null;
  if (raw[1] === ' ' && raw[2] !== ' ' && raw[0] !== '?' && raw[0] !== '!') {
    const splitRenameArrow = raw[0] === 'R' || raw[0] === 'C';
    const { primary, secondary } = parsePorcelainPaths(raw.slice(2), { splitRenameArrow });
    return {
      line: raw,
      x: ' ',
      y: raw[0],
      relPath: primary,
      fromPath: secondary,
      untracked: false,
      ignored: false,
    };
  }
  const x = raw[0];
  const y = raw[1];
  const splitRenameArrow = x === 'R' || x === 'C' || y === 'R' || y === 'C';
  const { primary, secondary } = parsePorcelainPaths(raw.slice(3), { splitRenameArrow });
  return {
    line: raw,
    x,
    y,
    relPath: primary,
    fromPath: secondary,
    untracked: x === '?' && y === '?',
    ignored: x === '!' && y === '!',
  };
}

function buildSyntheticUntrackedStatusLine(relPath) {
  return `?? ${normalizeRepoPath(relPath).replace(/\/+$/, '')}`;
}

function buildSyntheticUntrackedParsedLine(relPath) {
  const normalized = normalizeRepoPath(relPath).replace(/\/+$/, '');
  return {
    line: buildSyntheticUntrackedStatusLine(normalized),
    x: '?',
    y: '?',
    relPath: normalized,
    fromPath: '',
    untracked: true,
    ignored: false,
  };
}

function isControllerRecoverableAllowlistPath(relPath) {
  const normalized = normalizeRepoPath(relPath).replace(/\/+$/, '');
  if (!normalized) return false;
  return (
    normalized === 'AGENTS.md' ||
    normalized === 'DECISIONS.md' ||
    normalized === '.codex/README.md' ||
    normalized.startsWith('.codex/skills/') ||
    normalized.startsWith('docs/runbooks/') ||
    normalized.startsWith('docs/agentic/')
  );
}

function derivePendingSkillOpsDurableTargets({ cwd, pendingSummaries }) {
  const targets = new Set();
  for (const summary of pendingSummaries) {
    const names = Array.isArray(summary?.skillUpdateSkillNames) ? summary.skillUpdateSkillNames : [];
    for (const skillName of names) {
      const normalizedName = trim(skillName);
      if (!normalizedName) continue;
      const relTarget = normalizeRepoPath(path.posix.join('.codex', 'skills', normalizedName, 'SKILL.md'));
      const absTarget = path.join(cwd, relTarget);
      if (!fs.existsSync(absTarget)) continue;
      targets.add(relTarget);
    }
  }
  return targets;
}

function shouldTreatTrackedPathAsRecoverable(parsedLine, durableTargetSet) {
  if (!parsedLine?.relPath) return false;
  if (!isControllerRecoverableAllowlistPath(parsedLine.relPath)) return false;
  if (!durableTargetSet.has(parsedLine.relPath)) return false;
  const statusPair = `${parsedLine.x}${parsedLine.y}`;
  if (statusPair === '??' || statusPair === '!!') return false;
  if (parsedLine.x === 'D' || parsedLine.y === 'D') return false;
  if (parsedLine.x === 'R' || parsedLine.y === 'R') return false;
  if (parsedLine.x === 'C' || parsedLine.y === 'C') return false;
  if (parsedLine.x === 'U' || parsedLine.y === 'U') return false;
  return true;
}

function isNonBlockingRuntimeStatusLine(parsedLine, { cwd, skillOpsPromotionStateIndex }) {
  if (!parsedLine?.relPath) return false;
  if (!parsedLine.untracked && isDisposableRuntimeArtifactPath(parsedLine.relPath)) return false;
  return isNonBlockingRuntimeEntry(path.join(cwd, parsedLine.relPath), parsedLine.relPath, {
    skillOpsPromotionStateIndex,
  });
}

function isCleanableRuntimeArtifactStatusLine(line, { cwd }) {
  const relPath = extractUntrackedPorcelainPath(line);
  if (!relPath) return false;
  return isRemovableRuntimeEntry(path.join(cwd, relPath), relPath);
}

function normalizeRecoverableFingerprintInput({
  agentName,
  repoCommonGitDir,
  branch,
  headSha,
  recoverableStatusPorcelain,
}) {
  return JSON.stringify({
    agentName: trim(agentName),
    repoCommonGitDir: trim(repoCommonGitDir),
    branch: trim(branch),
    headSha: trim(headSha),
    recoverableStatusPorcelain: splitNonEmptyLines(recoverableStatusPorcelain).sort((a, b) => a.localeCompare(b)),
  });
}

function buildControllerDirtyFingerprint(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function classifyControllerDirtyWorktree({
  cwd,
  statusPorcelain,
  agentName = '',
  branch = '',
  repoCommonGitDir = '',
  headSha = '',
  skillOpsPromotionStateDir = '',
  autoCleanRuntimeArtifacts = false,
} = {}) {
  const statusBeforeCleanup = String(statusPorcelain || '');
  const disposableRemovedPaths = autoCleanRuntimeArtifacts
    ? cleanupIgnorableRuntimeArtifacts({ cwd, statusPorcelain: statusBeforeCleanup }).removedPaths
    : [];
  const statusAfterCleanup =
    autoCleanRuntimeArtifacts && disposableRemovedPaths.length
      ? gitText(['status', '--porcelain'], { cwd }) || ''
      : statusBeforeCleanup;
  const skillOpsPromotionStateIndex = loadSkillOpsPromotionStateIndex(skillOpsPromotionStateDir);
  const lines = splitNonEmptyLines(statusAfterCleanup);
  const parsedLines = lines.map(parsePorcelainStatusLine).filter(Boolean);
  const pendingSummaries = [];
  const pendingSkillOpsLogPaths = [];
  const handledQueuedLogPaths = [];
  const blockingLines = [];
  const recoverableBlockingLineSet = new Set();

  for (const parsedLine of parsedLines) {
    if (parsedLine.ignored || !parsedLine.relPath) continue;
    const absPath = path.join(cwd, parsedLine.relPath);
    const isLogPath = isSkillOpsLogPath(parsedLine.relPath);
    const summary = isLogPath ? readSkillOpsLogSummarySafe(absPath) : null;
    const nestedSkillOpsLogs =
      !summary && isSkillOpsTreePath(parsedLine.relPath) ? collectSkillOpsLogDetails(absPath, parsedLine.relPath) : [];

    if (isNonBlockingRuntimeStatusLine(parsedLine, { cwd, skillOpsPromotionStateIndex })) {
      if (summary?.status === 'queued') handledQueuedLogPaths.push(parsedLine.relPath);
      for (const entry of nestedSkillOpsLogs) {
        if (entry.summary?.status === 'queued') handledQueuedLogPaths.push(entry.relPath);
      }
      continue;
    }

    if (summary?.status === 'pending' && summary.hasNonEmptySkillUpdates) {
      pendingSummaries.push(summary);
      pendingSkillOpsLogPaths.push(parsedLine.relPath);
      blockingLines.push(parsedLine);
      recoverableBlockingLineSet.add(parsedLine.line);
      continue;
    }

    const nestedPending = nestedSkillOpsLogs.filter(
      (entry) => entry.summary?.status === 'pending' && entry.summary.hasNonEmptySkillUpdates,
    );
    const nestedSubstantive = nestedSkillOpsLogs.some((entry) => {
      if (entry.summary?.status === 'pending' && entry.summary.hasNonEmptySkillUpdates) return false;
      if (entry.summary?.status === 'queued' && entry.summary.queuedAt && entry.summary.promotionTaskId && entry.summary.id) {
        return !skillOpsPromotionStateIndex.has(`${entry.summary.promotionTaskId}::${entry.summary.id}`);
      }
      if (isTerminalHandledSkillOpsStatus(entry.summary)) return false;
      if (entry.summary && !entry.summary.hasNonEmptySkillUpdates && !entry.summary.hasMeaningfulBody) return false;
      return true;
    });
    if (nestedPending.length > 0 && !nestedSubstantive) {
      for (const entry of nestedPending) {
        pendingSummaries.push(entry.summary);
        pendingSkillOpsLogPaths.push(entry.relPath);
        const nestedLine = buildSyntheticUntrackedParsedLine(entry.relPath);
        blockingLines.push(nestedLine);
        recoverableBlockingLineSet.add(nestedLine.line);
      }
      continue;
    }

    if (nestedSkillOpsLogs.length > 0) {
      for (const entry of nestedSkillOpsLogs) {
        blockingLines.push(buildSyntheticUntrackedParsedLine(entry.relPath));
      }
      continue;
    }

    blockingLines.push(parsedLine);
  }

  const durableTargetSet = derivePendingSkillOpsDurableTargets({ cwd, pendingSummaries });
  const recoverableLines = [];
  const recoverableTrackedPaths = new Set();
  let sawSubstantiveDirty = false;

  for (const parsedLine of blockingLines) {
    if (isSkillOpsLogPath(parsedLine.relPath)) {
      const summary = readSkillOpsLogSummarySafe(path.join(cwd, parsedLine.relPath));
      if (summary?.status === 'pending' && summary.hasNonEmptySkillUpdates) {
        recoverableLines.push(parsedLine.line);
        continue;
      }
      sawSubstantiveDirty = true;
      continue;
    }

    if (recoverableBlockingLineSet.has(parsedLine.line)) {
      recoverableLines.push(parsedLine.line);
      continue;
    }

    if (shouldTreatTrackedPathAsRecoverable(parsedLine, durableTargetSet)) {
      recoverableLines.push(parsedLine.line);
      recoverableTrackedPaths.add(parsedLine.relPath);
      continue;
    }

    sawSubstantiveDirty = true;
  }

  const blockingStatusNormalized = blockingLines.map((entry) => entry.line).join('\n').trim();
  const recoverableStatusNormalized = recoverableLines.sort((a, b) => a.localeCompare(b)).join('\n').trim();
  const fingerprint = buildControllerDirtyFingerprint(
    normalizeRecoverableFingerprintInput({
      agentName,
      repoCommonGitDir,
      branch,
      headSha,
      recoverableStatusPorcelain: recoverableStatusNormalized,
    }),
  );

  let classification = 'runtime_artifacts_only';
  if (blockingLines.length > 0) {
    classification =
      !sawSubstantiveDirty && recoverableLines.length === blockingLines.length && pendingSkillOpsLogPaths.length > 0
        ? 'controller_housekeeping_required'
        : 'substantive_dirty_block';
  }

  return {
    classification,
    fingerprint,
    blockingStatusPorcelain: blockingStatusNormalized,
    recoverableStatusPorcelain: recoverableStatusNormalized,
    recoverableTrackedPaths: Array.from(recoverableTrackedPaths).sort((a, b) => a.localeCompare(b)),
    pendingSkillOpsLogPaths: pendingSkillOpsLogPaths.sort((a, b) => a.localeCompare(b)),
    handledQueuedLogPaths: handledQueuedLogPaths.sort((a, b) => a.localeCompare(b)),
    disposableRemovedPaths,
  };
}

export function summarizeBlockingGitStatusPorcelain({ cwd, statusPorcelain, skillOpsPromotionStateDir = '' }) {
  return classifyControllerDirtyWorktree({
    cwd,
    statusPorcelain,
    skillOpsPromotionStateDir,
    autoCleanRuntimeArtifacts: false,
  }).blockingStatusPorcelain;
}

function cleanupIgnorableRuntimeArtifacts({ cwd, statusPorcelain }) {
  const lines = splitNonEmptyLines(statusPorcelain);
  const removedPaths = [];
  for (const line of lines) {
    if (!isCleanableRuntimeArtifactStatusLine(line, { cwd })) continue;
    const relPath = extractUntrackedPorcelainPath(line);
    if (!relPath) continue;
    try {
      fs.rmSync(path.join(cwd, relPath), { recursive: true, force: true });
      removedPaths.push(relPath);
    } catch {
      // best effort; if cleanup fails, normal preflight will still block later
    }
  }
  removedPaths.sort((a, b) => a.localeCompare(b));
  return { removedPaths };
}

export class TaskGitPreflightBlockedError extends Error {
  constructor(message, { cwd, taskKind, contract, details } = {}) {
    super(message);
    this.name = 'TaskGitPreflightBlockedError';
    this.cwd = cwd || null;
    this.taskKind = taskKind || null;
    this.contract = contract || null;
    this.details = details || null;
  }
}

export function readTaskGitContract(meta) {
  const refs = isObject(meta?.references) ? meta.references : null;
  const gitRefs = isObject(refs?.git) ? refs.git : null;
  if (!gitRefs) return null;

  const baseBranchRaw = trim(gitRefs.baseBranch);
  const baseBranch = baseBranchRaw ? baseBranchRaw : null;
  const baseSha = normalizeSha(gitRefs.baseSha);
  const workBranch = normalizeBranchName(gitRefs.workBranch);
  const integrationBranchRaw = trim(gitRefs.integrationBranch);
  const integrationBranch = integrationBranchRaw ? integrationBranchRaw : null;
  const expectedDeploy = isObject(gitRefs.expectedDeploy) ? gitRefs.expectedDeploy : null;

  return {
    baseBranch,
    baseSha,
    workBranch,
    integrationBranch,
    expectedDeploy,
  };
}

export function getGitSnapshot({ cwd }) {
  const isRepo = gitOk(['rev-parse', '--is-inside-work-tree'], { cwd });
  if (!isRepo) return null;
  const branch = gitText(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
  const headSha = gitText(['rev-parse', 'HEAD'], { cwd });
  const statusPorcelain = gitText(['status', '--porcelain'], { cwd }) || '';
  return {
    branch: branch || null,
    headSha: headSha || null,
    isDirty: Boolean(statusPorcelain.trim()),
    statusPorcelain,
  };
}

function taskFileMatchesId(filename, taskId) {
  const normalizedTaskId = trim(taskId);
  if (!filename.endsWith('.md')) return false;
  if (!normalizedTaskId) return false;
  return filename === `${normalizedTaskId}.md` || filename.startsWith(`${normalizedTaskId}__`);
}

function listOtherOpenTaskIds({ busRoot, agentName, currentTaskId = '', states = ['new', 'seen', 'in_progress'] }) {
  const out = [];
  const seen = new Set();
  for (const state of states) {
    const dir = path.join(busRoot, 'inbox', agentName, state);
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      if (taskFileMatchesId(entry.name, currentTaskId)) continue;
      const taskId = entry.name.replace(/\.md$/, '');
      if (seen.has(taskId)) continue;
      seen.add(taskId);
      out.push(taskId);
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

export function attemptStaleWorkerWorktreeReclaim({
  cwd,
  busRoot,
  agentName,
  currentTaskId = '',
  incomingRootId = '',
  previousRootId = '',
  contract = null,
  reasonCode = '',
  skillOpsPromotionStateDir = '',
} = {}) {
  const workBranch = normalizeBranchName(contract?.workBranch);
  const baseSha = normalizeSha(contract?.baseSha);
  if (!cwd || !busRoot || !agentName || !workBranch || !baseSha) {
    return { reclaimed: false, reason: 'missing_inputs' };
  }

  let snapshot = getGitSnapshot({ cwd });
  if (!snapshot?.isDirty) {
    return { reclaimed: false, reason: 'not_dirty' };
  }

  const blockingStatus = summarizeBlockingGitStatusPorcelain({
    cwd,
    statusPorcelain: snapshot.statusPorcelain,
    skillOpsPromotionStateDir,
  });
  snapshot = {
    ...snapshot,
    isDirty: Boolean(blockingStatus),
    statusPorcelain: blockingStatus,
  };
  if (!snapshot.isDirty) {
    return { reclaimed: false, reason: 'non_blocking_runtime_artifacts_only' };
  }

  const currentBranch = normalizeBranchName(snapshot.branch);
  const otherOpenTaskIds = listOtherOpenTaskIds({ busRoot, agentName, currentTaskId });
  if (otherOpenTaskIds.length > 0) {
    return { reclaimed: false, reason: 'other_open_tasks_present', otherOpenTaskIds };
  }

  const normalizedIncomingRootId = trim(incomingRootId);
  const normalizedPreviousRootId = trim(previousRootId);
  const staleRootTransition =
    Boolean(normalizedIncomingRootId) &&
    Boolean(normalizedPreviousRootId) &&
    normalizedIncomingRootId !== normalizedPreviousRootId;
  if (!staleRootTransition) {
    return {
      reclaimed: false,
      reason:
        Boolean(currentBranch) && currentBranch !== workBranch && normalizedIncomingRootId && normalizedPreviousRootId
          ? 'same_root_branch_transition_not_stale'
          : 'stale_ownership_not_proven',
      currentBranch,
      targetBranch: workBranch,
    };
  }

  const diffWorking = gitText(['diff', '--no-ext-diff', '--binary'], { cwd }) || '';
  const diffStaged = gitText(['diff', '--cached', '--no-ext-diff', '--binary'], { cwd }) || '';
  const reset = git(['reset', '--hard'], { cwd });
  if (!reset.ok) {
    return {
      reclaimed: false,
      reason: 'reset_failed',
      currentBranch,
      stderr: truncate(reset.stderr, 1200),
      statusPorcelain: truncate(snapshot.statusPorcelain, 1200),
      otherOpenTaskIds,
    };
  }
  const clean = git(['clean', '-fd'], { cwd });
  if (!clean.ok) {
    return {
      reclaimed: false,
      reason: 'clean_failed',
      currentBranch,
      stderr: truncate(clean.stderr, 1200),
      statusPorcelain: truncate(snapshot.statusPorcelain, 1200),
      otherOpenTaskIds,
    };
  }
  const snapshotAfter = getGitSnapshot({ cwd }) || snapshot;
  if (snapshotAfter.isDirty) {
    return {
      reclaimed: false,
      reason: 'still_dirty_after_reclaim',
      currentBranch,
      statusPorcelain: truncate(snapshotAfter.statusPorcelain, 1200),
      otherOpenTaskIds,
    };
  }

  return {
    reclaimed: true,
    reason: 'stale_worktree_reclaimed',
    reasonCode: trim(reasonCode) || null,
    currentBranch,
    targetBranch: workBranch,
    baseSha,
    incomingRootId: normalizedIncomingRootId || null,
    previousRootId: normalizedPreviousRootId || null,
    statusPorcelain: truncate(snapshot.statusPorcelain, 16_000),
    diffWorking: truncate(diffWorking, 200_000),
    diffStaged: truncate(diffStaged, 200_000),
    otherOpenTaskIds,
    snapshotBefore: snapshot,
    snapshotAfter,
  };
}

function ensureBaseShaPresent({ cwd, baseSha, baseBranch, allowFetch }) {
  if (!baseSha) return { ok: false, fetched: false, note: 'missing baseSha' };

  const exists = gitOk(['cat-file', '-e', `${baseSha}^{commit}`], { cwd });
  if (exists) return { ok: true, fetched: false, note: null };
  if (!allowFetch) return { ok: false, fetched: false, note: 'baseSha not found locally' };

  // Best-effort fetch: fetch all remotes (works even when baseBranch is a local-only label like slice/*).
  const fetchedOk = gitOk(['fetch', '--all', '--prune'], { cwd });

  const existsAfter = gitOk(['cat-file', '-e', `${baseSha}^{commit}`], { cwd });
  if (existsAfter) return { ok: true, fetched: true, note: null };

  return {
    ok: false,
    fetched: fetchedOk,
    note: 'baseSha not found (even after fetch)',
  };
}

function ensureAncestor({ cwd, baseSha }) {
  if (!baseSha) return true;
  return gitOk(['merge-base', '--is-ancestor', baseSha, 'HEAD'], { cwd });
}

export function ensureTaskGitContract({
  cwd,
  taskKind,
  contract,
  enforce = false,
  allowFetch = true,
  autoCleanDirtyExecute = false,
  log = null,
  skillOpsPromotionStateDir = '',
} = {}) {
  const contractObj = contract || null;

  if (!contractObj) {
    if (enforce && taskKind === 'EXECUTE') {
      throw new TaskGitPreflightBlockedError('Missing references.git for EXECUTE task', {
        cwd,
        taskKind,
        contract: null,
        details: { required: ['baseSha', 'workBranch'] },
      });
    }
    return { applied: false, snapshot: getGitSnapshot({ cwd }), contract: null };
  }

  const { baseBranch, baseSha, workBranch } = contractObj;
  const normalizedTaskKind = String(taskKind || '').trim().toUpperCase();
  const requiresHardSync = normalizedTaskKind === 'EXECUTE' && Boolean(workBranch) && Boolean(baseSha);

  if (enforce && taskKind === 'EXECUTE') {
    if (!baseSha || !workBranch) {
      throw new TaskGitPreflightBlockedError('EXECUTE task missing required references.git fields', {
        cwd,
        taskKind,
        contract: contractObj,
        details: { missing: [!baseSha ? 'baseSha' : null, !workBranch ? 'workBranch' : null].filter(Boolean) },
      });
    }
  }
  if (normalizedTaskKind === 'EXECUTE' && workBranch && !baseSha) {
    throw new TaskGitPreflightBlockedError('EXECUTE task requires references.git.baseSha for deterministic branch sync', {
      cwd,
      taskKind,
      contract: contractObj,
      details: { missing: ['baseSha'] },
    });
  }

  let snap0 = getGitSnapshot({ cwd });
  if (!snap0) {
    throw new TaskGitPreflightBlockedError('Task workdir is not a git repo', {
      cwd,
      taskKind,
      contract: contractObj,
    });
  }

  let autoCleaned = false;
  /** @type {null|{statusPorcelain: string, diffWorking: string, diffStaged: string, removedPaths: string[]}} */
  let autoCleanDetails = null;

  if (!workBranch) {
    // Nothing to check out; still validate ancestor if baseSha was provided.
    if (baseSha && !ensureAncestor({ cwd, baseSha })) {
      throw new TaskGitPreflightBlockedError('Current HEAD does not include baseSha (git drift)', {
        cwd,
        taskKind,
        contract: contractObj,
        details: { branch: snap0.branch, headSha: snap0.headSha, baseSha },
      });
    }
    return { applied: false, snapshot: snap0, contract: contractObj };
  }

  // Disposable runtime junk is safe to clean for any task with a workBranch.
  // Deterministic hard-sync remains EXECUTE-only.
  if (snap0.isDirty) {
    const statusBeforeDisposableCleanup = String(snap0.statusPorcelain || '');
    const controllerDirty = classifyControllerDirtyWorktree({
      cwd,
      statusPorcelain: statusBeforeDisposableCleanup,
      agentName: '',
      branch: snap0.branch || '',
      repoCommonGitDir: readRepoCommonGitDir({ cwd }),
      headSha: snap0.headSha || '',
      skillOpsPromotionStateDir,
      autoCleanRuntimeArtifacts: true,
    });
    if (controllerDirty.disposableRemovedPaths.length) {
      autoCleaned = true;
      autoCleanDetails = {
        statusPorcelain: truncate(statusBeforeDisposableCleanup, 16_000),
        diffWorking: '',
        diffStaged: '',
        removedPaths: controllerDirty.disposableRemovedPaths.slice(),
      };
      snap0 = getGitSnapshot({ cwd }) || snap0;
      if (log) {
        log(
          `[worker] git preflight auto-cleaned runtime artifacts: ${controllerDirty.disposableRemovedPaths.join(', ')}\n`,
        );
      }
    }
  }

  if (snap0.isDirty) {
    const blockingStatus = summarizeBlockingGitStatusPorcelain({
      cwd,
      statusPorcelain: snap0.statusPorcelain,
      skillOpsPromotionStateDir,
    });
    snap0 = {
      ...snap0,
      isDirty: Boolean(blockingStatus),
      statusPorcelain: blockingStatus,
    };
  }

  if (snap0.isDirty) {
    if (autoCleanDirtyExecute && requiresHardSync) {
      const statusBefore = String(snap0.statusPorcelain || '');
      const diffWorking = gitText(['diff', '--no-ext-diff', '--binary'], { cwd }) || '';
      const diffStaged = gitText(['diff', '--cached', '--no-ext-diff', '--binary'], { cwd }) || '';
      const reset = git(['reset', '--hard'], { cwd });
      if (!reset.ok) {
        throw new TaskGitPreflightBlockedError('Failed to auto-clean dirty worktree (git reset --hard)', {
          cwd,
          taskKind,
          contract: contractObj,
          details: {
            currentBranch: snap0.branch,
            statusPorcelain: truncate(snap0.statusPorcelain, 1200),
            stderr: truncate(reset.stderr, 1200),
          },
        });
      }
      const clean = git(['clean', '-fd'], { cwd });
      if (!clean.ok) {
        throw new TaskGitPreflightBlockedError('Failed to auto-clean dirty worktree (git clean -fd)', {
          cwd,
          taskKind,
          contract: contractObj,
          details: {
            currentBranch: snap0.branch,
            statusPorcelain: truncate(snap0.statusPorcelain, 1200),
            stderr: truncate(clean.stderr, 1200),
          },
        });
      }
      snap0 = getGitSnapshot({ cwd }) || snap0;
      if (snap0.isDirty) {
        throw new TaskGitPreflightBlockedError('Worktree remains dirty after auto-clean', {
          cwd,
          taskKind,
          contract: contractObj,
          details: { currentBranch: snap0.branch, statusPorcelain: truncate(snap0.statusPorcelain, 1200) },
        });
      }
      autoCleaned = true;
      autoCleanDetails = {
        statusPorcelain: truncate(statusBefore, 16_000),
        diffWorking: truncate(diffWorking, 200_000),
        diffStaged: truncate(diffStaged, 200_000),
        removedPaths: autoCleanDetails?.removedPaths || [],
      };
    } else {
      throw new TaskGitPreflightBlockedError(
        'Worktree has uncommitted changes; refusing deterministic branch sync for task',
        {
          cwd,
          taskKind,
          contract: contractObj,
          details: { currentBranch: snap0.branch, statusPorcelain: truncate(snap0.statusPorcelain, 1200) },
        },
      );
    }
  }

  const branchExists = gitOk(['show-ref', '--verify', '--quiet', `refs/heads/${workBranch}`], { cwd });
  let created = false;
  let fetched = false;
  let hardSynced = false;

  if (baseSha && (requiresHardSync || !branchExists)) {
    const base = ensureBaseShaPresent({ cwd, baseSha, baseBranch, allowFetch });
    fetched = Boolean(base.fetched);
    if (!base.ok) {
      throw new TaskGitPreflightBlockedError(`baseSha ${baseSha} is not available locally`, {
        cwd,
        taskKind,
        contract: contractObj,
        details: { baseBranch, baseSha, note: base.note },
      });
    }
  }

  if (branchExists) {
    const checkout = git(['checkout', workBranch], { cwd });
    if (!checkout.ok) {
      throw new TaskGitPreflightBlockedError(`Failed to checkout workBranch ${workBranch}`, {
        cwd,
        taskKind,
        contract: contractObj,
        details: { stderr: truncate(checkout.stderr, 1200) },
      });
    }
  } else {
    if (!baseSha) {
      throw new TaskGitPreflightBlockedError(`workBranch ${workBranch} does not exist and baseSha is missing`, {
        cwd,
        taskKind,
        contract: contractObj,
      });
    }
    const checkout = git(['checkout', '-b', workBranch, baseSha], { cwd });
    if (!checkout.ok) {
      throw new TaskGitPreflightBlockedError(`Failed to create workBranch ${workBranch} at ${baseSha}`, {
        cwd,
        taskKind,
        contract: contractObj,
        details: { stderr: truncate(checkout.stderr, 1200) },
      });
    }
    created = true;
  }

  if (requiresHardSync && baseSha) {
    const reset = git(['reset', '--hard', baseSha], { cwd });
    if (!reset.ok) {
      throw new TaskGitPreflightBlockedError(`Failed to hard-sync workBranch ${workBranch} to ${baseSha}`, {
        cwd,
        taskKind,
        contract: contractObj,
        details: { stderr: truncate(reset.stderr, 1200) },
      });
    }
    hardSynced = true;
  }

  const snap1 = getGitSnapshot({ cwd }) || snap0;
  if (baseSha) {
    if (requiresHardSync) {
      if (String(snap1.headSha || '').toLowerCase() !== String(baseSha).toLowerCase()) {
        throw new TaskGitPreflightBlockedError('Checked out branch is not pinned to required baseSha after hard sync', {
          cwd,
          taskKind,
          contract: contractObj,
          details: { branch: snap1.branch, headSha: snap1.headSha, baseSha },
        });
      }
    } else if (!ensureAncestor({ cwd, baseSha })) {
      throw new TaskGitPreflightBlockedError('Checked out branch does not include baseSha (git drift)', {
        cwd,
        taskKind,
        contract: contractObj,
        details: { branch: snap1.branch, headSha: snap1.headSha, baseSha },
      });
    }
  }

  if (log) {
    const baseMsg = baseSha ? ` baseSha=${baseSha}` : '';
    const createdMsg = created ? ' created' : '';
    const fetchedMsg = fetched ? ' fetched' : '';
    const syncMsg = hardSynced ? ' hardSynced' : '';
    log(`[worker] git preflight ok: workBranch=${workBranch}${baseMsg}${createdMsg}${fetchedMsg}${syncMsg}\n`);
  }

  return {
    applied: true,
    created,
    fetched,
    hardSynced,
    autoCleaned,
    autoCleanDetails,
    snapshot: snap1,
    contract: contractObj,
  };
}
