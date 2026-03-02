#!/usr/bin/env node
/**
 * Codex worker.
 *
 * Consumes tasks addressed to a specific agent, runs `codex exec ...` to complete them,
 * then closes the task on the AgentBus with a receipt and (optionally) a completion notice
 * to the configured orchestrator.
 *
 * Skills:
 *   Skills are loaded by Codex automatically; we explicitly invoke them by mentioning
 *   `$skill-name` in the prompt based on the roster configuration.
 */

import { parseArgs } from 'node:util';
import { promises as fs, readFileSync, writeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import childProcess from 'node:child_process';
import {
  getRepoRoot,
  getCockpitRoot,
  loadRoster,
  resolveBusRoot,
  ensureBusRoot,
  listInboxTaskIds,
  openTask,
  claimTask,
  closeTask,
  statusSummary,
  recentReceipts,
  listInboxTasks,
  expandEnvVars,
  deliverTask,
  makeId,
  pickDaddyChatName,
} from './lib/agentbus.mjs';
import {
  acquireGlobalSemaphoreSlot,
  computeBackoffMs,
  isOpenAIRateLimitText,
  isStreamDisconnectedText,
  parseRetryAfterMs,
  readGlobalCooldown,
  writeGlobalCooldown,
} from './lib/codex-limiter.mjs';
import {
  validateOpusConsultResponseMeta,
  validateOpusConsultResponsePayload,
  shouldContinueOpusConsultRound,
} from './lib/opus-consult-schema.mjs';
import { CodexAppServerClient } from './lib/codex-app-server-client.mjs';
import {
  TaskGitPreflightBlockedError,
  readTaskGitContract,
  ensureTaskGitContract,
  getGitSnapshot,
} from './lib/task-git.mjs';
import { verifyCommitShaOnAllowedRemotes } from './lib/commit-verify.mjs';
import { classifyPostMergeResyncTrigger, runPostMergeResync } from './lib/post-merge-resync.mjs';

/**
 * Pauses execution for the requested number of milliseconds.
 */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Writes a line to the active tmux pane when available.
 */
function writePane(text) {
  const s = String(text ?? '');
  if (!s) return;
  try {
    writeSync(2, s);
  } catch {
    // Best-effort fallback; may be buffered in non-TTY tests.
    process.stderr.write(s);
  }
}

class CodexExecError extends Error {
  constructor(message, { exitCode, stderrTail, stdoutTail, threadId }) {
    super(message);
    this.name = 'CodexExecError';
    this.exitCode = exitCode;
    this.stderrTail = stderrTail;
    this.stdoutTail = stdoutTail;
    this.threadId = threadId;
  }
}

/**
 * Parses positive int into a normalized value.
 */
function parsePositiveInt(raw) {
  if (raw == null) return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  return Math.floor(value);
}

/**
 * Helper for format duration ms used by the cockpit workflow runtime.
 */
function formatDurationMs(ms) {
  if (!Number.isFinite(ms)) return `${ms}ms`;
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(ms / 60000);
  if (m < 90) return `${m}m`;
  const h = Math.round(ms / 3600000);
  return `${h}h`;
}

class CodexExecTimeoutError extends Error {
  constructor({ timeoutMs, killGraceMs, pid, threadId, stderrTail, stdoutTail }) {
    super(
      `codex exec timed out after ${formatDurationMs(timeoutMs)} (${timeoutMs}ms); ` +
        `sent SIGTERM (pid ${pid}), will SIGKILL after ${killGraceMs}ms`,
    );
    this.name = 'CodexExecTimeoutError';
    this.timeoutMs = timeoutMs;
    this.killGraceMs = killGraceMs;
    this.pid = pid;
    this.threadId = threadId;
    this.stderrTail = stderrTail;
    this.stdoutTail = stdoutTail;
  }
}

class CodexExecSupersededError extends Error {
  constructor({ reason, pid, threadId, stderrTail, stdoutTail }) {
    super(`codex exec superseded: ${reason} (pid ${pid})`);
    this.name = 'CodexExecSupersededError';
    this.reason = reason;
    this.pid = pid;
    this.threadId = threadId;
    this.stderrTail = stderrTail;
    this.stdoutTail = stdoutTail;
  }
}

class OpusConsultBlockedError extends Error {
  constructor(message, { phase = '', reasonCode = '', details = null } = {}) {
    super(message);
    this.name = 'OpusConsultBlockedError';
    this.phase = String(phase || '').trim();
    this.reasonCode = String(reasonCode || '').trim();
    this.details = details;
  }
}

/**
 * Returns whether truthy env.
 */
function isTruthyEnv(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/**
 * Parses boolean env into a normalized value.
 */
function parseBooleanEnv(value, defaultValue) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return defaultValue;
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') return true;
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false;
  return defaultValue;
}

/**
 * Parses csv-like env value into a normalized array.
 */
function parseCsvEnv(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry || '').trim()).filter(Boolean);
  }
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Returns normalized task kind.
 */
function normalizeTaskKind(value) {
  return String(value || '').trim().toUpperCase();
}

/**
 * Normalizes a repository path for deterministic matching.
 */
function normalizeRepoPath(relPath) {
  return String(relPath || '').replace(/\\/g, '/').replace(/^\.\/+/, '').trim();
}

/**
 * Returns whether path is dependency or lockfile.
 */
function isDependencyOrLockfilePath(relPath) {
  const p = normalizeRepoPath(relPath).toLowerCase();
  if (!p) return false;
  return (
    p === 'package.json' ||
    p === 'package-lock.json' ||
    p === 'pnpm-lock.yaml' ||
    p === 'yarn.lock' ||
    p === 'requirements.txt' ||
    p === 'requirements-dev.txt' ||
    p === 'pyproject.toml' ||
    p === 'poetry.lock' ||
    p === 'pipfile' ||
    p === 'pipfile.lock' ||
    p === 'go.mod' ||
    p === 'go.sum' ||
    p === 'cargo.toml' ||
    p === 'cargo.lock'
  );
}

/**
 * Returns whether path is control-plane/runtime path for tiny-fix disqualification.
 */
function isControlPlanePath(relPath) {
  const p = normalizeRepoPath(relPath).toLowerCase();
  if (!p) return false;
  return p.startsWith('scripts/') || p.startsWith('adapters/') || p.startsWith('docs/agentic/agent-bus/');
}

/**
 * Returns whether path is excluded from source counting.
 */
function isExcludedSourcePath(relPath) {
  const p = normalizeRepoPath(relPath).toLowerCase();
  if (!p) return true;
  if (p.startsWith('.codex/')) return true;
  if (p.startsWith('.codex-tmp/')) return true;
  if (p.startsWith('docs/')) return true;
  if (p.startsWith('tmp/') || p.startsWith('temp/')) return true;
  if (p.startsWith('dist/') || p.startsWith('build/')) return true;
  if (p.includes('/.cache/') || p.includes('/cache/')) return true;
  return false;
}

/**
 * Returns whether a git status --porcelain line is an ignorable runtime artifact entry for cross-root checks.
 */
function isIgnorableCrossRootDirtyLine(line) {
  const raw = String(line || '').trim();
  if (!raw) return true;
  if (!raw.startsWith('?? ')) return false;
  const relPath = normalizeRepoPath(raw.slice(3)).toLowerCase().replace(/\/+$/, '');
  if (!relPath) return false;
  return (
    relPath === '.codex' ||
    relPath.startsWith('.codex/') ||
    relPath === '.codex-tmp' ||
    relPath.startsWith('.codex-tmp/')
  );
}

/**
 * Returns blocking dirty-status lines for cross-root checks.
 */
function summarizeCrossRootBlockingStatus(statusPorcelain) {
  const lines = String(statusPorcelain || '')
    .split(/\r?\n/)
    .map((line) => String(line || '').trimEnd())
    .filter(Boolean);
  const blocking = lines.filter((line) => !isIgnorableCrossRootDirtyLine(line));
  return blocking.join('\n').trim();
}

const UNREADABLE_FILE_LINE_COUNT = 10_000;

/**
 * Parses git --numstat output into file->line delta map.
 */
function parseNumstatMap(raw) {
  const out = new Map();
  const lines = String(raw || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    const parts = line.split(/\t+/);
    if (parts.length < 3) continue;
    const add = Number(parts[0]);
    const del = Number(parts[1]);
    const file = normalizeRepoPath(parts.slice(2).join('\t'));
    if (!file) continue;
    const prev = out.get(file) || 0;
    // git --numstat uses "-" for binary entries; treat those as fail-closed large deltas.
    const delta =
      Number.isFinite(add) && Number.isFinite(del) ? add + del : UNREADABLE_FILE_LINE_COUNT;
    out.set(file, prev + delta);
  }
  return out;
}

/**
 * Returns true when git command stderr indicates the commit object is unavailable locally.
 */
function isCommitObjectMissingError(err) {
  const text = [
    err?.message,
    Buffer.isBuffer(err?.stderr) ? err.stderr.toString('utf8') : err?.stderr,
    Buffer.isBuffer(err?.stdout) ? err.stdout.toString('utf8') : err?.stdout,
  ]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
  if (!text) return false;
  return (
    text.includes('could not get object info') ||
    text.includes('bad object') ||
    text.includes('unknown revision') ||
    text.includes('ambiguous argument')
  );
}

/**
 * Reads changed paths for a specific commit (or working tree when commit is absent).
 */
function readChangedPathsAndNumstat({ cwd, commitSha = '' }) {
  const commit = String(commitSha || '').trim();
  if (commit) {
    const readForCommit = () => {
      const filesRaw = childProcess.execFileSync(
        'git',
        ['show', '--name-only', '--pretty=format:', commit],
        { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const numstatRaw = childProcess.execFileSync(
        'git',
        ['show', '--numstat', '--pretty=format:', commit],
        { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const changedFiles = Array.from(
        new Set(
          String(filesRaw || '')
            .split(/\r?\n/)
            .map((line) => normalizeRepoPath(line))
            .filter(Boolean),
        ),
      );
      return { changedFiles, numstatMap: parseNumstatMap(numstatRaw) };
    };
    try {
      return readForCommit();
    } catch (err) {
      if (!isCommitObjectMissingError(err)) throw err;
      try {
        childProcess.execFileSync('git', ['fetch', '--no-tags', 'origin'], {
          cwd,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch {
        // best-effort hydration only
      }
      try {
        return readForCommit();
      } catch (retryErr) {
        if (!isCommitObjectMissingError(retryErr)) throw retryErr;
        const unavailableErr = new Error('commit object is unavailable in local clone');
        unavailableErr.reasonCode = 'source_delta_commit_unavailable';
        unavailableErr.details = {
          commitSha: commit,
          message: (retryErr && retryErr.message) || String(retryErr),
        };
        throw unavailableErr;
      }
    }
  }

  const filesRaw = childProcess.execFileSync(
    'git',
    ['diff', '--name-only', 'HEAD'],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const numstatRaw = childProcess.execFileSync(
    'git',
    ['diff', '--numstat', 'HEAD'],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const changedFilesFromDiff = Array.from(
    new Set(
      String(filesRaw || '')
        .split(/\r?\n/)
        .map((line) => normalizeRepoPath(line))
        .filter(Boolean),
    ),
  );
  const numstatMap = parseNumstatMap(numstatRaw);
  const untrackedRaw = childProcess.execFileSync(
    'git',
    ['ls-files', '--others', '--exclude-standard'],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const untrackedFiles = Array.from(
    new Set(
      String(untrackedRaw || '')
        .split(/\r?\n/)
        .map((line) => normalizeRepoPath(line))
        .filter(Boolean),
    ),
  );
  for (const file of untrackedFiles) {
    if (numstatMap.has(file)) continue;
    try {
      const raw = readFileSync(path.join(cwd, file), 'utf8');
      const split = raw.split(/\r?\n/);
      const lineCount = raw.length === 0 ? 0 : raw.endsWith('\n') ? split.length - 1 : split.length;
      numstatMap.set(file, Math.max(0, lineCount));
    } catch {
      numstatMap.set(file, UNREADABLE_FILE_LINE_COUNT);
    }
  }
  const changedFiles = Array.from(new Set([...changedFilesFromDiff, ...untrackedFiles]));
  return { changedFiles, numstatMap };
}

/**
 * Computes source delta summary for tiny-fix + delegation gates.
 */
function computeSourceDeltaSummary({ cwd, commitSha = '' }) {
  const { changedFiles, numstatMap } = readChangedPathsAndNumstat({ cwd, commitSha });
  const sourceFiles = changedFiles.filter((p) => !isExcludedSourcePath(p));
  const sourceLineDelta = sourceFiles.reduce((sum, file) => sum + Number(numstatMap.get(file) || 0), 0);
  const dependencyOrLockfileChanged = changedFiles.some(isDependencyOrLockfilePath);
  const controlPlaneChanged = changedFiles.some(isControlPlanePath);
  return {
    changedFiles,
    sourceFiles,
    sourceFilesCount: sourceFiles.length,
    sourceLineDelta,
    dependencyOrLockfileChanged,
    controlPlaneChanged,
    artifactOnlyChange: changedFiles.length > 0 && sourceFiles.length === 0,
    noSourceChange: sourceFiles.length === 0,
  };
}

/**
 * Returns whether language policy skill.
 */
function isLanguagePolicySkill(name) {
  const n = String(name || '').trim().toLowerCase();
  return (
    n === 'valua-ts-quality-policy' ||
    n === 'valua-py-quality-policy' ||
    n.endsWith('-ts-quality-policy') ||
    n.endsWith('-py-quality-policy')
  );
}

/**
 * Returns whether exec skill override includes current skill.
 */
function isNamedExecSkill(name, execOverrides) {
  const normalized = normalizeSkillName(name);
  if (!normalized) return false;
  return Array.isArray(execOverrides) && execOverrides.includes(normalized);
}

/**
 * Resolves default codex bin using current runtime context.
 */
function resolveDefaultCodexBin() {
  const sibling = path.join(path.dirname(process.execPath), 'codex');
  try {
    childProcess.execFileSync(sibling, ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] });
    return sibling;
  } catch {
    // keep probing
  }

  const fromPath = safeExecText('bash', ['-lc', 'command -v codex'], { cwd: process.cwd() });
  if (fromPath) return fromPath;
  return 'codex';
}

/**
 * Helper for create git credential store env used by the cockpit workflow runtime.
 */
async function createGitCredentialStoreEnv(baseEnv, { sandboxCwd }) {
  const env = { ...baseEnv };
  const credRoot = path.join(path.resolve(sandboxCwd || process.cwd()), '.codex-tmp');
  await fs.mkdir(credRoot, { recursive: true });
  const credentialFile = path.join(
    credRoot,
    `.codex-git-credentials.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`,
  );
  await fs.writeFile(credentialFile, '', { mode: 0o600 });
  try {
    await fs.chmod(credentialFile, 0o600);
  } catch {
    // Best effort; writeFile(mode) already applies restrictive permissions on supported platforms.
  }

  const countRaw = Number.parseInt(String(env.GIT_CONFIG_COUNT ?? ''), 10);
  let idx = Number.isFinite(countRaw) && countRaw >= 0 ? countRaw : 0;
  env[`GIT_CONFIG_KEY_${idx}`] = 'credential.helper';
  env[`GIT_CONFIG_VALUE_${idx}`] = `store --file=${credentialFile}`;
  idx += 1;
  env.GIT_CONFIG_COUNT = String(idx);

  // Avoid interactive credential prompts in non-interactive worker runs.
  if (!Object.prototype.hasOwnProperty.call(env, 'GIT_TERMINAL_PROMPT')) {
    env.GIT_TERMINAL_PROMPT = '0';
  }

  const cleanup = async () => {
    try {
      await fs.rm(`${credentialFile}.lock`, { force: true });
    } catch {
      // ignore cleanup failures
    }
    try {
      await fs.rm(credentialFile, { force: true });
    } catch {
      // ignore cleanup failures
    }
  };

  return { env, credentialFile, cleanup };
}

/**
 * Returns whether sandbox permission error text.
 */
function isSandboxPermissionErrorText(value) {
  const s = String(value ?? '').toLowerCase();
  // Keep this conservative: only classify obvious sandbox/permission denials as "blocked".
  if (s.includes('permission denied')) return true;
  if (s.includes('operation not permitted')) return true;
  if (s.includes('read-only file system')) return true;
  if (s.includes('not in writable roots')) return true;
  if (s.includes('sandbox') && (s.includes('denied') || s.includes('not allowed'))) return true;
  if (s.includes('approval') && s.includes('required')) return true;
  return false;
}

/**
 * Gets codex exec timeout ms from the current environment.
 */
function getCodexExecTimeoutMs(env = process.env) {
  // Cockpit tasks can legitimately take hours (staging/prod debugging, PR review closure).
  // Keep this high by default; operators can override with VALUA_CODEX_EXEC_TIMEOUT_MS.
  const defaultMs = 12 * 60 * 60 * 1000;
  const raw = env.VALUA_CODEX_EXEC_TIMEOUT_MS;
  const parsed = parsePositiveInt(raw);
  if (parsed == null) return defaultMs;
  if (parsed <= 0) return defaultMs;
  return parsed;
}

/**
 * Helper for file exists used by the cockpit workflow runtime.
 */
async function fileExists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parses codex session id from text into a normalized value.
 */
function parseCodexSessionIdFromText(text) {
  const s = String(text || '');
  const m = s.match(/\bsession id:\s*([0-9A-Za-z-]{8,})\b/);
  if (m) return m[1];
  return null;
}

/**
 * Helper for trim to one line used by the cockpit workflow runtime.
 */
function trimToOneLine(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Helper for truncate text used by the cockpit workflow runtime.
 */
function truncateText(value, { maxLen }) {
  const s = String(value ?? '');
  const max = Math.max(1, Number(maxLen) || 1);
  if (s.length <= max) return s;
  return `${s.slice(0, max).trimEnd()}…`;
}

/**
 * Helper for summarize command name used by the cockpit workflow runtime.
 */
function summarizeCommandName(value) {
  if (Array.isArray(value)) {
    const first = typeof value[0] === 'string' ? value[0].trim() : '';
    return first ? `${first} …` : '';
  }
  const s = trimToOneLine(value);
  if (!s) return '';
  const first = s.split(' ')[0] || '';
  return first ? `${first} …` : '';
}

/**
 * Helper for format codex json event used by the cockpit workflow runtime.
 */
function formatCodexJsonEvent(evt) {
  const type = typeof evt?.type === 'string' ? evt.type.trim() : '';
  if (!type) return null;

  // Keep this intentionally minimal so tmux panes show liveness without leaking long content.
  if (type === 'thread.started') {
    const tid = typeof evt?.thread_id === 'string' ? evt.thread_id.trim() : '';
    return `[codex] thread.started${tid ? ` ${tid}` : ''}\n`;
  }
  if (type === 'turn.started' || type === 'turn.completed') {
    return `[codex] ${type}\n`;
  }

  if (
    type === 'command_execution.started' ||
    type === 'command_execution.completed' ||
    type === 'tool_execution.started' ||
    type === 'tool_execution.completed'
  ) {
    const cmd =
      summarizeCommandName(evt?.command) ||
      summarizeCommandName(evt?.cmd) ||
      summarizeCommandName(evt?.argv) ||
      '';
    const tool = trimToOneLine(evt?.tool_name || evt?.tool || evt?.name || '');
    const suffix = tool ? ` ${truncateText(tool, { maxLen: 40 })}` : cmd ? ` ${cmd}` : '';
    return `[codex] ${type}${suffix}\n`;
  }

  return null;
}

/**
 * Helper for maybe send status to daddy used by the cockpit workflow runtime.
 */
async function maybeSendStatusToDaddy({
  busRoot,
  roster,
  fromAgent,
  priority,
  rootId,
  parentId,
  title,
  body,
  phase = 'status',
  state = '',
  reasonCode = '',
  nextAction = '',
  idempotencyKey = '',
  throttle,
}) {
  const daddyName = pickDaddyChatName(roster);
  if (!daddyName) return { delivered: false, error: null };

  const key =
    String(idempotencyKey || '').trim() ||
    `${fromAgent}::${String(title || '').slice(0, 80)}::${String(state || '').slice(0, 40)}::${String(reasonCode || '').slice(0, 40)}`;
  const now = Date.now();
  if (throttle?.lastSentAtByKey && typeof throttle?.ms === 'number') {
    const prev = throttle.lastSentAtByKey.get(key) || 0;
    if (now - prev < throttle.ms) return { delivered: false, error: null };
    throttle.lastSentAtByKey.set(key, now);
  }

  const id = makeId('status');
  const meta = {
    id,
    to: [daddyName],
    from: fromAgent,
    priority: priority || 'P2',
    title,
    signals: {
      kind: 'STATUS',
      phase: String(phase || 'status'),
      rootId: rootId || id,
      parentId: parentId || rootId || id,
      smoke: false,
      notifyOrchestrator: false,
    },
    references: {},
  };
  try {
    const payloadText = String(body || '').trim()
      ? String(body || '')
      : JSON.stringify(
          {
            rootId: rootId || null,
            state: state || null,
            reasonCode: reasonCode || null,
            nextAction: nextAction || null,
            updatedAt: new Date().toISOString(),
          },
          null,
          2,
        );
    await deliverTask({ busRoot, meta, body: payloadText });
    return { delivered: true, error: null };
  } catch (err) {
    return { delivered: false, error: (err && err.message) || String(err) };
  }
}

/**
 * Emits proactive autopilot root status updates with idempotency.
 */
async function maybeEmitAutopilotRootStatus({
  enabled,
  busRoot,
  roster,
  fromAgent,
  priority,
  rootId,
  parentId,
  state,
  phase,
  reasonCode = '',
  nextAction = '',
  idempotency = null,
  throttle = null,
}) {
  if (!enabled) return { delivered: false, error: null };
  const rid = readStringField(rootId);
  if (!rid) return { delivered: false, error: null };
  const transitionKey = `${rid}::${String(state || '').trim()}::${String(phase || '').trim()}::${String(reasonCode || '').trim()}`;
  if (idempotency && idempotency.has(transitionKey)) {
    return { delivered: false, error: null };
  }
  if (idempotency) idempotency.add(transitionKey);
  return await maybeSendStatusToDaddy({
    busRoot,
    roster,
    fromAgent,
    priority,
    rootId: rid,
    parentId,
    title: `STATUS: root ${rid} ${state || 'update'}`,
    body: '',
    phase: phase || 'root-status',
    state: state || 'update',
    reasonCode: reasonCode || '',
    nextAction: nextAction || '',
    idempotencyKey: transitionKey,
    throttle,
  });
}

/**
 * Reads task session from disk or process state.
 */
async function readTaskSession({ busRoot, agentName, taskId }) {
  const dir = path.join(busRoot, 'state', 'codex-task-sessions', agentName);
  const p = path.join(dir, `${taskId}.json`);
  try {
    const raw = await fs.readFile(p, 'utf8');
    const parsed = JSON.parse(raw);
    const threadId = typeof parsed?.threadId === 'string' ? parsed.threadId.trim() : '';
    if (!threadId) return null;
    return { path: p, threadId, payload: parsed };
  } catch {
    return null;
  }
}

/**
 * Writes task session to persistent state.
 */
async function writeTaskSession({ busRoot, agentName, taskId, threadId }) {
  if (!threadId || typeof threadId !== 'string') return null;
  const dir = path.join(busRoot, 'state', 'codex-task-sessions', agentName);
  await fs.mkdir(dir, { recursive: true });
  const p = path.join(dir, `${taskId}.json`);
  const tmp = `${p}.tmp.${Math.random().toString(16).slice(2)}`;
  const payload = { updatedAt: new Date().toISOString(), agent: agentName, taskId, threadId };
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, p);
  return p;
}

/**
 * Helper for delete task session used by the cockpit workflow runtime.
 */
async function deleteTaskSession({ busRoot, agentName, taskId }) {
  const dir = path.join(busRoot, 'state', 'codex-task-sessions', agentName);
  const p = path.join(dir, `${taskId}.json`);
  try {
    await fs.unlink(p);
  } catch {
    // ignore
  }
}

/**
 * Helper for safe state basename used by the cockpit workflow runtime.
 */
function safeStateBasename(key) {
  const raw = String(key ?? '').trim();
  if (raw && /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/.test(raw)) return raw;
  const hash = crypto.createHash('sha256').update(raw || 'empty').digest('hex');
  return `k_${hash.slice(0, 32)}`;
}

/**
 * Reads root session from disk or process state.
 */
async function readRootSession({ busRoot, agentName, rootId }) {
  const key = safeStateBasename(rootId);
  const dir = path.join(busRoot, 'state', 'codex-root-sessions', agentName);
  const p = path.join(dir, `${key}.json`);
  try {
    const raw = await fs.readFile(p, 'utf8');
    const parsed = JSON.parse(raw);
    const threadId = typeof parsed?.threadId === 'string' ? parsed.threadId.trim() : '';
    if (!threadId) return null;
    const turnCountRaw = Number(parsed?.turnCount);
    const turnCount = Number.isFinite(turnCountRaw) && turnCountRaw >= 0 ? Math.floor(turnCountRaw) : 0;
    return { path: p, threadId, turnCount, payload: parsed };
  } catch {
    return null;
  }
}

/**
 * Writes root session to persistent state.
 */
async function writeRootSession({ busRoot, agentName, rootId, threadId, turnCount = 0 }) {
  if (!threadId || typeof threadId !== 'string') return null;
  const key = safeStateBasename(rootId);
  const dir = path.join(busRoot, 'state', 'codex-root-sessions', agentName);
  await fs.mkdir(dir, { recursive: true });
  const p = path.join(dir, `${key}.json`);
  const tmp = `${p}.tmp.${Math.random().toString(16).slice(2)}`;
  const payload = {
    updatedAt: new Date().toISOString(),
    agent: agentName,
    rootId,
    threadId,
    turnCount: Math.max(0, Number(turnCount) || 0),
  };
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, p);
  return p;
}

/**
 * Deletes root session pin.
 */
async function deleteRootSession({ busRoot, agentName, rootId }) {
  const key = safeStateBasename(rootId);
  const dir = path.join(busRoot, 'state', 'codex-root-sessions', agentName);
  const p = path.join(dir, `${key}.json`);
  try {
    await fs.unlink(p);
  } catch {
    // ignore
  }
}

/**
 * Reads agent root focus marker.
 */
async function readAgentRootFocus({ busRoot, agentName }) {
  const p = path.join(busRoot, 'state', 'agent-root-focus', `${safeStateBasename(agentName)}.json`);
  try {
    const raw = await fs.readFile(p, 'utf8');
    const parsed = JSON.parse(raw);
    const rootId = readStringField(parsed?.rootId);
    if (!rootId) return null;
    return { rootId, path: p, payload: parsed };
  } catch {
    return null;
  }
}

/**
 * Writes agent root focus marker.
 */
async function writeAgentRootFocus({ busRoot, agentName, rootId }) {
  const dir = path.join(busRoot, 'state', 'agent-root-focus');
  await fs.mkdir(dir, { recursive: true });
  const p = path.join(dir, `${safeStateBasename(agentName)}.json`);
  const tmp = `${p}.tmp.${Math.random().toString(16).slice(2)}`;
  const payload = {
    updatedAt: new Date().toISOString(),
    agent: agentName,
    rootId: readStringField(rootId),
  };
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, p);
  return p;
}

/**
 * Reads prompt bootstrap from disk or process state.
 */
async function readPromptBootstrap({ busRoot, agentName }) {
  const p = path.join(busRoot, 'state', `${agentName}.prompt-bootstrap.json`);
  try {
    const raw = await fs.readFile(p, 'utf8');
    const parsed = JSON.parse(raw);
    const threadId = typeof parsed?.threadId === 'string' ? parsed.threadId.trim() : '';
    const skillsHash = typeof parsed?.skillsHash === 'string' ? parsed.skillsHash.trim() : '';
    if (!threadId || !skillsHash) return null;
    return { path: p, threadId, skillsHash, payload: parsed };
  } catch {
    return null;
  }
}

/**
 * Writes prompt bootstrap to persistent state.
 */
async function writePromptBootstrap({ busRoot, agentName, threadId, skillsHash }) {
  if (!threadId || typeof threadId !== 'string') return null;
  if (!skillsHash || typeof skillsHash !== 'string') return null;
  const dir = path.join(busRoot, 'state');
  await fs.mkdir(dir, { recursive: true });
  const p = path.join(dir, `${agentName}.prompt-bootstrap.json`);
  const tmp = `${p}.tmp.${Math.random().toString(16).slice(2)}`;
  const payload = { updatedAt: new Date().toISOString(), agent: agentName, threadId, skillsHash };
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, p);
  return p;
}

/**
 * Helper for run codex exec used by the cockpit workflow runtime.
 */
async function runCodexExec({
  codexBin,
  repoRoot,
  workdir,
  schemaPath,
  outputPath,
  prompt,
  watchFilePath = null,
  watchFileMtimeMs = null,
  resumeSessionId = null,
  jsonEvents = false,
  extraEnv = {},
  dangerFullAccess = false,
}) {
  // Critical: cockpit workers must be able to reach GitHub (gh pr create, git push).
  //
  // Codex's command sandbox is network-disabled by default; to allow network egress we must
  // opt in via `sandbox_workspace_write.network_access=true` while using `--sandbox workspace-write`.
  //
  // NOTE: We intentionally keep a filesystem sandbox (workspace-write) so worker agents can’t
  // silently modify arbitrary files outside their workdir, while still allowing PR/CI operations.
  const sandbox = 'workspace-write';
  const networkAccess =
    String(process.env.VALUA_CODEX_NETWORK_ACCESS || '').trim() === '0' ? 'false' : 'true';

  const enableChromeDevtools = String(process.env.VALUA_CODEX_ENABLE_CHROME_DEVTOOLS || '').trim() === '1';

  const sandboxCwd = workdir || repoRoot;
  const extraWritableDirs = [];
  const baseEnvForPaths = { ...process.env, ...extraEnv };
  let gitCommonAbs = null;
  {
    const resolveAbs = (value) => {
      const raw = String(value || '').trim();
      if (!raw) return null;
      return path.isAbsolute(raw) ? raw : path.resolve(sandboxCwd, raw);
    };

    // Git worktrees store their real gitdir outside the workdir (".git" is a file pointing at gitdir).
    // In workspace-write sandbox mode, allow writes to the resolved gitdir + common git dir so
    // `git fetch/push` can update FETCH_HEAD, refs, and objects.
    const gitDirAbs = resolveAbs(safeExecText('git', ['rev-parse', '--git-dir'], { cwd: sandboxCwd }));
    gitCommonAbs = resolveAbs(safeExecText('git', ['rev-parse', '--git-common-dir'], { cwd: sandboxCwd }));
    if (gitDirAbs) extraWritableDirs.push(gitDirAbs);
    if (gitCommonAbs && gitCommonAbs !== gitDirAbs) extraWritableDirs.push(gitCommonAbs);
    const codexHomeAbs = resolveAbs(baseEnvForPaths.CODEX_HOME);
    if (codexHomeAbs) extraWritableDirs.push(codexHomeAbs);
  }
  const dedupWritableDirs = Array.from(new Set(extraWritableDirs.filter(Boolean)));

  const args = [
    ...(enableChromeDevtools ? [] : ['--config', 'mcp_servers.chrome-devtools.enabled=false']),
    '--ask-for-approval',
    'never',
    '--sandbox',
    dangerFullAccess ? 'danger-full-access' : sandbox,
    ...(dangerFullAccess ? [] : ['--config', `sandbox_workspace_write.network_access=${networkAccess}`]),
    ...(dangerFullAccess ? [] : dedupWritableDirs.flatMap((d) => ['--add-dir', d])),
    '--no-alt-screen',
  ];

  if (workdir) {
    args.push('--cd', workdir);
  }

  args.push('exec');
  if (jsonEvents) args.push('--json');
  args.push('--output-schema', schemaPath, '-o', outputPath);
  if (resumeSessionId) {
    args.push('resume');
    if (resumeSessionId === 'last') args.push('--last');
    else args.push(resumeSessionId);
  }
  args.push('-');

  let threadId = null;
  let stderrTail = '';
  let stdoutTail = '';

  const credential = await createGitCredentialStoreEnv({ ...process.env, ...extraEnv }, { sandboxCwd });
  const env = credential.env;
  const timeoutMs = getCodexExecTimeoutMs(env);
  const killGraceMs = 10_000;
  const updatePollMsRaw = (env.VALUA_CODEX_TASK_UPDATE_POLL_MS || '').trim();
  const updatePollMs = updatePollMsRaw ? Math.max(200, Number(updatePollMsRaw) || 200) : 1000;

  let exitCode = 1;
  try {
    ({ exitCode } = await new Promise((resolve, reject) => {
      const proc = childProcess.spawn(codexBin, args, {
        cwd: repoRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
      });

    let settled = false;
    let timeoutTimer = null;
    let killTimer = null;
    let updateTimer = null;

    const cleanupTimers = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      timeoutTimer = null;
      if (updateTimer) clearInterval(updateTimer);
      updateTimer = null;
    };

    const finishError = (err) => {
      if (settled) return;
      settled = true;
      cleanupTimers();
      reject(err);
    };

    const finishOk = (value) => {
      if (settled) return;
      settled = true;
      cleanupTimers();
      resolve(value);
    };

    const requestKillWithGrace = () => {
      if (killTimer) clearTimeout(killTimer);
      killTimer = null;
      try {
        proc.kill('SIGTERM');
      } catch {
        // ignore
      }

      killTimer = setTimeout(() => {
        if (proc.exitCode == null && proc.signalCode == null) {
          try {
            proc.kill('SIGKILL');
          } catch {
            // ignore
          }
        }
      }, killGraceMs);
      killTimer.unref?.();
    };

    proc.on('error', (err) => {
      if (killTimer) clearTimeout(killTimer);
      finishError(err);
    });

    proc.stdin.on('error', (err) => {
      // If the child exits quickly (e.g. rate-limit test doubles), writes to stdin can raise EPIPE.
      // We still want to observe exitCode + stderrTail and let the caller decide whether to retry.
      const code = err && typeof err.code === 'string' ? err.code : '';
      if (code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED') return;
      finishError(err);
    });

    /** @type {string} */
    let buffered = '';
    /** @type {string} */
    let stderrHead = '';
    proc.stdout.on('data', (chunk) => {
      const s = chunk.toString('utf8');
      // Keep tail for error parsing.
      stdoutTail = (stdoutTail + s).slice(-64_000);
      if (!jsonEvents) return;
      buffered += s;
      let idx = buffered.indexOf('\n');
      while (idx !== -1) {
        const line = buffered.slice(0, idx).trim();
        buffered = buffered.slice(idx + 1);
        if (line) {
          try {
            const evt = JSON.parse(line);
            const pretty = formatCodexJsonEvent(evt);
            if (pretty) writePane(pretty);
            if (evt?.type === 'thread.started' && typeof evt?.thread_id === 'string') {
              threadId = evt.thread_id;
            }
          } catch {
            // ignore malformed lines
          }
        }
        idx = buffered.indexOf('\n');
      }
    });

    proc.stderr.on('data', (chunk) => {
      const s = chunk.toString('utf8');
      stderrTail = (stderrTail + s).slice(-64_000);
      if (!threadId && stderrHead.length < 16_000) {
        stderrHead = (stderrHead + s).slice(0, 16_000);
        const parsed = parseCodexSessionIdFromText(stderrHead);
        if (parsed) threadId = parsed;
      }
      // Preserve visibility in tmux panes.
      writePane(s);
    });

    proc.stdin.write(prompt);
    proc.stdin.end();

    proc.on('exit', (code) => {
      if (killTimer) clearTimeout(killTimer);
      finishOk({ exitCode: code ?? 1 });
    });

    if (watchFilePath && Number.isFinite(watchFileMtimeMs) && watchFileMtimeMs != null) {
      const baseline = Number(watchFileMtimeMs);
      updateTimer = setInterval(() => {
        if (settled) return;
        fs.stat(watchFilePath)
          .then((st) => {
            if (settled) return;
            const next = Number(st?.mtimeMs);
            if (!Number.isFinite(next)) return;
            if (next <= baseline) return;
            requestKillWithGrace();
            finishError(
              new CodexExecSupersededError({
                reason: 'task updated',
                pid: proc.pid,
                threadId,
                stderrTail,
                stdoutTail,
              }),
            );
          })
          .catch(() => {
            // ignore stat failures
          });
      }, updatePollMs);
      updateTimer.unref?.();
    }

    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        requestKillWithGrace();

        finishError(
          new CodexExecTimeoutError({
            timeoutMs,
            killGraceMs,
            pid: proc.pid,
            threadId,
            stderrTail,
            stdoutTail,
          }),
        );
      }, timeoutMs);
      timeoutTimer.unref?.();
    }
    }));
  } finally {
    await credential.cleanup();
  }

  if (!threadId) {
    threadId = parseCodexSessionIdFromText(stderrTail);
  }

  if (exitCode !== 0) {
    throw new CodexExecError(`codex exec exited with code ${exitCode}`, {
      exitCode,
      stderrTail,
      stdoutTail,
      threadId,
    });
  }

  return { threadId, stderrTail, stdoutTail };
}

/**
 * Writes json atomic to persistent state.
 */
async function writeJsonAtomic(filePath, value) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${filePath}.tmp.${Math.random().toString(16).slice(2)}`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, filePath);
}

/**
 * Resolves review artifact path using current runtime context.
 */
function resolveReviewArtifactPath({ busRoot, requestedPath, agentName, taskId }) {
  const fallback = `artifacts/${agentName}/reviews/${taskId}.review.md`;
  const raw = readStringField(requestedPath) || fallback;
  const normalized = raw.replace(/\\/g, '/');
  if (normalized.startsWith('/')) throw new Error('review.evidence.artifactPath must be bus-root relative');
  const rel = path.posix.normalize(normalized);
  if (!rel || rel === '.' || rel.startsWith('..')) {
    throw new Error('review.evidence.artifactPath must not escape busRoot');
  }
  if (!rel.startsWith('artifacts/')) {
    throw new Error('review.evidence.artifactPath must stay under artifacts/');
  }

  const abs = path.resolve(busRoot, rel);
  const rootAbs = path.resolve(busRoot);
  if (abs !== rootAbs && !abs.startsWith(`${rootAbs}${path.sep}`)) {
    throw new Error('review.evidence.artifactPath resolves outside busRoot');
  }
  return { relativePath: rel, absolutePath: abs };
}

/**
 * Builds review artifact markdown used by workflow automation.
 */
function buildReviewArtifactMarkdown({ taskMeta, review }) {
  const sourceTaskId =
    readStringField(taskMeta?.signals?.reviewTarget?.sourceTaskId) ||
    readStringField(taskMeta?.references?.sourceTaskId) ||
    '(unknown)';
  const sourceAgent =
    readStringField(taskMeta?.signals?.reviewTarget?.sourceAgent) ||
    readStringField(taskMeta?.references?.sourceAgent) ||
    '(unknown)';
  const targetCommit = readStringField(review?.targetCommitSha) || '(not provided)';
  const verdict = readStringField(review?.verdict) || '(unknown)';
  const findingsCount = Number(review?.findingsCount);
  const findingsCountText = Number.isInteger(findingsCount) ? String(findingsCount) : '(unknown)';
  const summary = String(review?.summary ?? '').trim() || '(missing summary)';

  return (
    `# Autopilot Review Artifact\n\n` +
    `## Reviewed Commit\n` +
    `- commit: ${targetCommit}\n` +
    `- sourceTaskId: ${sourceTaskId}\n` +
    `- sourceAgent: ${sourceAgent}\n\n` +
    `## Findings (severity ordered)\n` +
    `${summary}\n\n` +
    `## Required Corrections\n` +
    `${verdict === 'changes_requested' ? 'Corrections requested; see followUps in receipt.' : 'No corrections required.'}\n\n` +
    `## Decision\n` +
    `- verdict: ${verdict}\n` +
    `- findingsCount: ${findingsCountText}\n`
  );
}

/**
 * Helper for materialize review artifact used by the cockpit workflow runtime.
 */
async function materializeReviewArtifact({ busRoot, agentName, taskId, taskMeta, review }) {
  const requestedPath = review?.evidence?.artifactPath;
  const { relativePath, absolutePath } = resolveReviewArtifactPath({
    busRoot,
    requestedPath,
    agentName,
    taskId,
  });
  const markdown = buildReviewArtifactMarkdown({ taskMeta, review });
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, markdown, 'utf8');
  return { relativePath, absolutePath };
}

async function materializeOpusConsultArtifact({
  busRoot,
  agentName,
  taskId,
  taskMeta,
  transcript,
}) {
  const relativePath = `artifacts/${agentName}/consult/${taskId}.opus-consult.json`;
  const absolutePath = path.resolve(busRoot, relativePath);
  const payload = {
    generatedAt: new Date().toISOString(),
    taskId,
    rootId: readStringField(taskMeta?.signals?.rootId) || null,
    taskKind: readStringField(taskMeta?.signals?.kind) || null,
    transcript,
  };
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return { relativePath, absolutePath };
}

/**
 * Builds preflight clean artifact markdown used by workflow automation.
 */
function buildPreflightCleanArtifactMarkdown({ taskMeta, preflight }) {
  const git = preflight?.contract || {};
  const details = preflight?.autoCleanDetails || {};
  const rootId = readStringField(taskMeta?.signals?.rootId);
  const taskId = readStringField(taskMeta?.id);
  const statusPorcelain = readStringField(details.statusPorcelain);
  const diffWorking = readStringField(details.diffWorking);
  const diffStaged = readStringField(details.diffStaged);
  return (
    `# Task Git Preflight Auto-Clean\n\n` +
    `- rootId: ${rootId || '(none)'}\n` +
    `- taskId: ${taskId || '(unknown)'}\n` +
    `- baseSha: ${readStringField(git.baseSha) || '(none)'}\n` +
    `- workBranch: ${readStringField(git.workBranch) || '(none)'}\n` +
    `- integrationBranch: ${readStringField(git.integrationBranch) || '(none)'}\n\n` +
    `## Dirty Snapshot (status --porcelain)\n` +
    '```text\n' +
    `${statusPorcelain || '(empty)'}\n` +
    '```\n\n' +
    `## Working Diff Snapshot\n` +
    '```diff\n' +
    `${diffWorking || '(empty)'}\n` +
    '```\n\n' +
    `## Staged Diff Snapshot\n` +
    '```diff\n' +
    `${diffStaged || '(empty)'}\n` +
    '```\n'
  );
}

/**
 * Helper for materialize preflight clean artifact used by the cockpit workflow runtime.
 */
async function materializePreflightCleanArtifact({ busRoot, agentName, taskId, taskMeta, preflight }) {
  if (!preflight?.autoCleaned) return null;
  const relativePath = `artifacts/${agentName}/preflight/${taskId}.clean.md`;
  const absolutePath = path.resolve(busRoot, relativePath);
  const markdown = buildPreflightCleanArtifactMarkdown({ taskMeta, preflight });
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, markdown, 'utf8');
  return { relativePath, absolutePath };
}

/**
 * Normalizes codex home mode for downstream use.
 */
function normalizeCodexHomeMode(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw || raw === '0' || raw === 'off' || raw === 'false') return null;
  if (raw === 'agent' || raw === 'per-agent' || raw === 'per_agent') return 'agent';
  if (raw === 'cockpit' || raw === 'shared' || raw === 'global') return 'cockpit';
  return null;
}

/**
 * Helper for ensure codex home used by the cockpit workflow runtime.
 */
async function ensureCodexHome({ codexHome, sourceCodexHome, log = () => {} }) {
  if (!codexHome) return null;
  if (!sourceCodexHome) return null;
  const src = path.resolve(sourceCodexHome);
  const dst = path.resolve(codexHome);
  await fs.mkdir(dst, { recursive: true });

  const linkOrCopy = async (name) => {
    const from = path.join(src, name);
    const to = path.join(dst, name);
    try {
      await fs.stat(from);
    } catch {
      return;
    }

    try {
      const st = await fs.lstat(to);
      if (st.isSymbolicLink() || st.isFile()) return;
    } catch {
      // continue
    }

    try {
      await fs.symlink(from, to);
    } catch (err) {
      try {
        await fs.copyFile(from, to);
      } catch {
        log(
          `WARN: failed to provision CODEX_HOME file ${name} into ${dst}: ${(err && err.message) || String(err)}\n`,
        );
      }
    }
  };

  // Minimal bootstrap: keep auth+config shared, but isolate internal state (sessions/index).
  await linkOrCopy('auth.json');
  await linkOrCopy('config.toml');
  return dst;
}

/**
 * Helper for clear agent pinned sessions used by the cockpit workflow runtime.
 */
async function clearAgentPinnedSessions({ busRoot, agentName }) {
  try {
    await fs.rm(path.join(busRoot, 'state', `${agentName}.session-id`), { force: true });
  } catch {}
  try {
    await fs.rm(path.join(busRoot, 'state', `${agentName}.prompt-bootstrap.json`), { force: true });
  } catch {}
  try {
    await fs.rm(path.join(busRoot, 'state', 'codex-root-sessions', agentName), { recursive: true, force: true });
  } catch {}
  try {
    await fs.rm(path.join(busRoot, 'state', 'codex-task-sessions', agentName), { recursive: true, force: true });
  } catch {}
}

/**
 * Returns whether pid alive.
 */
function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    if (err && (err.code === 'ESRCH' || err.code === 'EINVAL')) return false;
    return true;
  }
}

/**
 * Helper for acquire agent worker lock used by the cockpit workflow runtime.
 */
async function acquireAgentWorkerLock({ busRoot, agentName }) {
  const lockDir = path.join(busRoot, 'state', 'worker-locks');
  const lockPath = path.join(lockDir, `${agentName}.lock.json`);
  await fs.mkdir(lockDir, { recursive: true });
  const staleUnknownMs = 5_000;

  const lockToken = `${process.pid}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
  const payload = JSON.stringify(
    {
      agent: agentName,
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      token: lockToken,
    },
    null,
    2,
  );

  const tryRelease = async () => {
    try {
      const raw = await fs.readFile(lockPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed?.token !== lockToken || Number(parsed?.pid) !== process.pid) return;
      await fs.rm(lockPath, { force: true });
    } catch {
      // ignore
    }
  };

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const fh = await fs.open(lockPath, 'wx');
      try {
        await fh.writeFile(`${payload}\n`, 'utf8');
      } finally {
        await fh.close();
      }
      return { acquired: true, ownerPid: null, release: tryRelease };
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;

      let ownerPid = null;
      let lockAgeMs = Number.POSITIVE_INFINITY;
      let lockStateKnown = false;
      try {
        const st = await fs.stat(lockPath);
        lockAgeMs = Math.max(0, Date.now() - Number(st.mtimeMs || 0));
      } catch {
        lockAgeMs = Number.POSITIVE_INFINITY;
      }

      try {
        const raw = await fs.readFile(lockPath, 'utf8');
        const parsed = JSON.parse(raw);
        const pid = Number(parsed?.pid);
        if (Number.isFinite(pid) && pid > 0) {
          ownerPid = pid;
          lockStateKnown = true;
        }
      } catch {
        lockStateKnown = false;
      }

      if (ownerPid && isPidAlive(ownerPid)) {
        return { acquired: false, ownerPid, release: async () => {} };
      }

      // Fresh unknown/partially-written lock content can happen during another process's lock write.
      // Do not delete in that case; treat as held and exit duplicate.
      if (!lockStateKnown && lockAgeMs < staleUnknownMs) {
        return { acquired: false, ownerPid: null, release: async () => {} };
      }

      try {
        await fs.rm(lockPath, { force: true });
      } catch {
        // retry
      }
    }
  }

  return { acquired: false, ownerPid: null, release: async () => {} };
}

/** @type {CodexAppServerClient|null} */
let sharedAppServerClient = null;
/** @type {string|null} */
let sharedAppServerKey = null;
/** @type {null|(() => Promise<void>)} */
let sharedAppServerCredentialCleanup = null;

/**
 * Builds app server key used by workflow automation.
 */
function buildAppServerKey({ codexBin, repoRoot, env }) {
  const home = typeof env?.CODEX_HOME === 'string' ? env.CODEX_HOME.trim() : '';
  return `${codexBin}::${repoRoot}::${home}`;
}

/**
 * Gets shared app server client from the current environment.
 */
async function getSharedAppServerClient({ codexBin, repoRoot, env, log, credentialCleanup = null }) {
  const key = buildAppServerKey({ codexBin, repoRoot, env });
  if (sharedAppServerClient && sharedAppServerClient.isRunning && sharedAppServerKey === key) {
    return { client: sharedAppServerClient, reused: true, key };
  }
  if (sharedAppServerClient) {
    try {
      await sharedAppServerClient.stop();
    } catch {
      // ignore
    }
    if (sharedAppServerCredentialCleanup) {
      try {
        await sharedAppServerCredentialCleanup();
      } catch {
        // ignore
      }
    }
    sharedAppServerClient = null;
    sharedAppServerKey = null;
    sharedAppServerCredentialCleanup = null;
  }
  sharedAppServerClient = new CodexAppServerClient({ codexBin, cwd: repoRoot, env, log });
  sharedAppServerKey = key;
  sharedAppServerCredentialCleanup = credentialCleanup;
  await sharedAppServerClient.start();
  return { client: sharedAppServerClient, reused: false, key };
}

/**
 * Helper for stop shared app server client used by the cockpit workflow runtime.
 */
async function stopSharedAppServerClient() {
  if (!sharedAppServerClient) return;
  try {
    await sharedAppServerClient.stop();
  } catch {
    // ignore
  } finally {
    sharedAppServerClient = null;
    sharedAppServerKey = null;
    if (sharedAppServerCredentialCleanup) {
      try {
        await sharedAppServerCredentialCleanup();
      } catch {
        // ignore
      }
    }
    sharedAppServerCredentialCleanup = null;
  }
}

/**
 * Helper for run codex app server used by the cockpit workflow runtime.
 */
async function runCodexAppServer({
  codexBin,
  repoRoot,
  workdir,
  schemaPath,
  outputPath,
  prompt,
  watchFilePath = null,
  watchFileMtimeMs = null,
  resumeSessionId = null,
  reviewGate = null,
  extraEnv = {},
  dangerFullAccess = false,
}) {
  const baseEnv = { ...process.env, ...extraEnv };
  const persist = parseBooleanEnv(
    baseEnv.AGENTIC_CODEX_APP_SERVER_PERSIST ?? baseEnv.VALUA_CODEX_APP_SERVER_PERSIST ?? '',
    true,
  );

  const timeoutMs = getCodexExecTimeoutMs(baseEnv);
  const updatePollMsRaw = (baseEnv.VALUA_CODEX_TASK_UPDATE_POLL_MS || '').trim();
  const updatePollMs = updatePollMsRaw ? Math.max(200, Number(updatePollMsRaw) || 200) : 1000;
  const createTaskUpdateWatcher = () => {
    /** @type {NodeJS.Timeout|null} */
    let timer = null;
    let resolved = false;
    const promise =
      watchFilePath && Number.isFinite(watchFileMtimeMs) && watchFileMtimeMs != null
        ? new Promise((resolve) => {
          const baseline = Number(watchFileMtimeMs);
          timer = setInterval(() => {
            if (resolved) return;
            fs.stat(watchFilePath)
              .then((st) => {
                if (resolved) return;
                const next = Number(st?.mtimeMs);
                if (!Number.isFinite(next)) return;
                if (next <= baseline) return;
                resolved = true;
                if (timer) {
                  clearInterval(timer);
                  timer = null;
                }
                resolve({ kind: 'updated' });
              })
              .catch(() => {
                // ignore
              });
            }, updatePollMs);
            timer.unref?.();
          })
        : new Promise(() => {});
    return {
      promise,
      stop() {
        resolved = true;
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
      },
    };
  };

  const networkAccessRaw = String(
    baseEnv.AGENTIC_CODEX_NETWORK_ACCESS ?? baseEnv.VALUA_CODEX_NETWORK_ACCESS ?? '',
  ).trim();
  const networkAccess = networkAccessRaw === '0' ? false : true;

  const sandboxCwd = workdir || repoRoot;
  const extraWritableDirs = [];
  let gitCommonAbs = null;
  {
    const resolveAbs = (value) => {
      const raw = String(value || '').trim();
      if (!raw) return null;
      return path.isAbsolute(raw) ? raw : path.resolve(sandboxCwd, raw);
    };

    const gitDirAbs = resolveAbs(safeExecText('git', ['rev-parse', '--git-dir'], { cwd: sandboxCwd }));
    gitCommonAbs = resolveAbs(
      safeExecText('git', ['rev-parse', '--git-common-dir'], { cwd: sandboxCwd }),
    );
    if (gitDirAbs) extraWritableDirs.push(gitDirAbs);
    if (gitCommonAbs && gitCommonAbs !== gitDirAbs) extraWritableDirs.push(gitCommonAbs);
    const codexHomeAbs = resolveAbs(baseEnv.CODEX_HOME);
    if (codexHomeAbs) extraWritableDirs.push(codexHomeAbs);
  }

  const credential = await createGitCredentialStoreEnv(baseEnv, { sandboxCwd });
  const env = credential.env;
  const writableRoots = [path.resolve(sandboxCwd), ...Array.from(new Set(extraWritableDirs.filter(Boolean)))];
  /** @type {any} */
  let outputSchema = null;
  try {
    outputSchema = JSON.parse(await fs.readFile(schemaPath, 'utf8'));
  } catch {
    outputSchema = null;
  }

  const sandboxPolicy = dangerFullAccess
    ? { type: 'dangerFullAccess' }
    : {
        type: 'workspaceWrite',
        writableRoots,
        networkAccess,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      };

  /** @type {CodexAppServerClient} */
  let client;
  if (persist) {
    try {
      const shared = await getSharedAppServerClient({
        codexBin,
        repoRoot,
        env,
        log: writePane,
        credentialCleanup: credential.cleanup,
      });
      client = shared.client;
      if (shared.reused) {
        await credential.cleanup();
      }
    } catch (err) {
      await credential.cleanup();
      throw err;
    }
  } else {
    client = new CodexAppServerClient({ codexBin, cwd: repoRoot, env, log: writePane });
    await client.start();
  }

  const pid = client.pid;
  /** @type {string|null} */
  let threadId = null;
  /** @type {string|null} */
  let turnId = null;

  const resolvedResume =
    typeof resumeSessionId === 'string' && resumeSessionId.trim() && resumeSessionId !== 'last'
      ? resumeSessionId.trim()
      : null;
  try {
    let threadResp = null;
    if (resolvedResume) {
      try {
        threadResp = await client.call('thread/resume', { threadId: resolvedResume });
      } catch {
        threadResp = null;
      }
    }
    if (!threadId && !threadResp) {
      threadResp = await client.call('thread/start', {});
    }

    if (!threadId) {
      const threadObj = threadResp?.thread ?? threadResp;
      const tid = typeof threadObj?.id === 'string' ? threadObj.id.trim() : '';
      if (!tid) throw new Error('codex app-server did not return a thread id');
      threadId = tid;
    }

    const runBuiltInReview = async ({ reviewCommitSha }) => {
      let reviewTurnId = null;
      let reviewStatus = null;
      let reviewError = null;
      let sawEnteredReviewMode = false;
      let sawExitedReviewMode = false;
      let reviewAgentMessageText = '';
      let reviewAgentMessageDelta = '';

      /** @type {(value: any) => void} */
      let resolveDone = () => {};
      /** @type {(err: any) => void} */
      let rejectDone = () => {};
      const donePromise = new Promise((resolve, reject) => {
        resolveDone = resolve;
        rejectDone = reject;
      });

      const onReviewNotification = ({ method, params }) => {
        if (method === 'turn/started') {
          const id = typeof params?.turn?.id === 'string' ? params.turn.id.trim() : '';
          if (id) reviewTurnId = id;
          writePane(`[codex] review.started\n`);
          return;
        }

        if (method === 'item/started') {
          const item = params?.item ?? null;
          if (item?.type === 'enteredReviewMode') {
            sawEnteredReviewMode = true;
            writePane(`[codex] review.entered\n`);
          }
          return;
        }

        if (method === 'item/completed') {
          const item = params?.item ?? null;
          if (item?.type === 'exitedReviewMode') {
            sawExitedReviewMode = true;
            writePane(`[codex] review.exited\n`);
          }
          if (item?.type === 'agentMessage' && typeof item?.text === 'string') {
            reviewAgentMessageText = item.text;
          }
          return;
        }

        if (method === 'item/agentMessage/delta') {
          const delta = typeof params?.delta === 'string' ? params.delta : '';
          if (delta) reviewAgentMessageDelta += delta;
          return;
        }

        if (method === 'turn/completed') {
          const id = typeof params?.turn?.id === 'string' ? params.turn.id.trim() : '';
          const status = typeof params?.turn?.status === 'string' ? params.turn.status.trim() : '';
          if (reviewTurnId && id && id !== reviewTurnId) return;
          if (status) reviewStatus = status;
          if (params?.turn?.error) reviewError = params.turn.error;
          writePane(`[codex] review.completed status=${status || 'unknown'}\n`);
          if (status !== 'completed') {
            const state = status || 'unknown';
            const msg = reviewError?.message ? String(reviewError.message) : `review turn ${state}`;
            rejectDone(
              new CodexExecError(`codex app-server review ${state}: ${msg}`, {
                exitCode: 1,
                stderrTail: String(reviewError?.additionalDetails || msg),
                stdoutTail: '',
                threadId,
              }),
            );
            return;
          }
          resolveDone({
            status,
            reviewAssistantText: reviewAgentMessageText || reviewAgentMessageDelta || '',
          });
        }
      };

      client.on('notification', onReviewNotification);
      let reviewTimeoutTimer = null;
      const reviewTimeoutPromise = new Promise((resolve) => {
        reviewTimeoutTimer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
        reviewTimeoutTimer.unref?.();
      });
      const reviewUpdateWatcher = createTaskUpdateWatcher();
      /** @type {string} */
      let reviewAssistantText = '';
      try {
        const target = reviewCommitSha
          ? { type: 'commit', sha: reviewCommitSha, title: `Review commit ${reviewCommitSha}` }
          : { type: 'uncommittedChanges' };
        const started = await client.call('review/start', {
          threadId,
          delivery: 'inline',
          target,
        });
        const id = typeof started?.turn?.id === 'string' ? started.turn.id.trim() : '';
        if (id) reviewTurnId = id;

        const raced = await Promise.race([donePromise, reviewTimeoutPromise, reviewUpdateWatcher.promise]);
        if (raced?.kind === 'updated') {
          if (threadId && reviewTurnId) {
            try {
              await client.call('turn/interrupt', { threadId, turnId: reviewTurnId });
            } catch {
              // ignore
            }
          }
          throw new CodexExecSupersededError({
            reason: 'task updated',
            pid: pid ?? 0,
            threadId,
            stderrTail: '',
            stdoutTail: '',
          });
        }
        if (raced?.kind === 'timeout') {
          throw new CodexExecTimeoutError({
            timeoutMs,
            killGraceMs: 10_000,
            pid: pid ?? 0,
            threadId,
            stderrTail: 'built-in review timed out',
            stdoutTail: '',
          });
        }
        if (typeof raced?.reviewAssistantText === 'string') {
          reviewAssistantText = raced.reviewAssistantText;
        }
      } finally {
        if (reviewTimeoutTimer) clearTimeout(reviewTimeoutTimer);
        reviewUpdateWatcher.stop();
        client.off('notification', onReviewNotification);
      }

      if (reviewStatus !== 'completed') {
        throw new CodexExecError(`codex app-server review did not complete (status=${reviewStatus || 'unknown'})`, {
          exitCode: 1,
          stderrTail: '',
          stdoutTail: '',
          threadId,
        });
      }
      if (!sawEnteredReviewMode || !sawExitedReviewMode) {
        throw new CodexExecError('codex app-server review did not emit review mode events', {
          exitCode: 1,
          stderrTail: '',
          stdoutTail: '',
          threadId,
        });
      }
      return {
        reviewAssistantText: String(reviewAssistantText || '').trim(),
      };
    };

    let turnPrompt = prompt;
    if (reviewGate?.required) {
      const reviewCommitShas = normalizeCommitShaList(reviewGate?.targetCommitShas);
      if (!reviewCommitShas.length && reviewGate?.targetCommitSha) {
        reviewCommitShas.push(reviewGate.targetCommitSha);
      }
      const reviewResolutionError = readStringField(reviewGate?.resolutionError);
      if (reviewGate?.userRequested && reviewResolutionError && !reviewCommitShas.length) {
        throw new CodexExecError(`codex app-server explicit review target resolution failed: ${reviewResolutionError}`, {
          exitCode: 1,
          stderrTail: reviewResolutionError,
          stdoutTail: '',
          threadId,
        });
      }
      const reviewTargets =
        reviewCommitShas.length > 0 ? reviewCommitShas : [''];
      /** @type {string[]} */
      const reviewTextBlocks = [];

      for (let index = 0; index < reviewTargets.length; index += 1) {
        const reviewCommitSha = readStringField(reviewTargets[index]);
        const reviewResult = await runBuiltInReview({ reviewCommitSha });
        const reviewText = readStringField(reviewResult?.reviewAssistantText);
        if (!reviewText) continue;
        const boundedReviewText =
          reviewText.length > 12_000 ? `${reviewText.slice(0, 12_000)}\n[truncated]` : reviewText;
        const label = reviewCommitSha
          ? `Review ${index + 1}/${reviewTargets.length} (commit ${reviewCommitSha})`
          : `Review ${index + 1}/${reviewTargets.length} (uncommitted changes)`;
        reviewTextBlocks.push(`${label}\n${boundedReviewText}`);
      }

      if (reviewTextBlocks.length) {
        turnPrompt =
          `${turnPrompt}\n\n` +
          `BUILT-IN REVIEW RESULT (authoritative):\n` +
          `${reviewTextBlocks.join('\n\n')}\n` +
          `END BUILT-IN REVIEW RESULT.\n`;
      }
    }

    let agentMessageText = null;
    let agentMessageDelta = '';
    let turnStatus = null;
    let turnError = null;

    /** @type {(value: any) => void} */
    let resolveDone = () => {};
    /** @type {(err: any) => void} */
    let rejectDone = () => {};
    const donePromise = new Promise((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });

    const maybeFinish = () => {
      if (turnStatus === 'failed') {
        const msg = turnError?.message ? String(turnError.message) : 'turn failed';
        rejectDone(
          new CodexExecError(`codex app-server turn failed: ${msg}`, {
            exitCode: 1,
            stderrTail: String(turnError?.additionalDetails || msg),
            stdoutTail: '',
            threadId,
          }),
        );
        return;
      }
      if (turnStatus === 'completed') {
        const finalText = agentMessageText || agentMessageDelta || null;
        if (finalText) {
          resolveDone({ agentMessageText: finalText });
          return;
        }
      }
    };

    const onNotification = ({ method, params }) => {
      if (method === 'turn/started') {
        const id = typeof params?.turn?.id === 'string' ? params.turn.id.trim() : '';
        if (id) turnId = id;
        writePane(`[codex] turn.started\n`);
        return;
      }

      if (method === 'turn/completed') {
        const id = typeof params?.turn?.id === 'string' ? params.turn.id.trim() : '';
        const status = typeof params?.turn?.status === 'string' ? params.turn.status.trim() : '';
        if (id && turnId && id !== turnId) return;
        if (status) turnStatus = status;
        if (params?.turn?.error) turnError = params.turn.error;
        writePane(`[codex] turn.completed status=${status || 'unknown'}\n`);
        maybeFinish();
        return;
      }

      if (method === 'item/agentMessage/delta') {
        const delta = typeof params?.delta === 'string' ? params.delta : '';
        if (delta) agentMessageDelta += delta;
        return;
      }

      if (method === 'item/completed') {
        const item = params?.item ?? null;
        if (item?.type === 'agentMessage' && typeof item?.text === 'string') {
          agentMessageText = item.text;
          maybeFinish();
        }
        return;
      }

      if (method === 'item/commandExecution/outputDelta') {
        const delta = typeof params?.delta === 'string' ? params.delta : '';
        if (delta) writePane(delta);
        return;
      }
    };

    client.on('notification', onNotification);

    const startTurn = async (tid) =>
      client.call('turn/start', {
        threadId: tid,
        input: [{ type: 'text', text: turnPrompt }],
        cwd: sandboxCwd,
        approvalPolicy: 'never',
        sandboxPolicy,
        outputSchema,
      });

    let turnStartRes;
    try {
      turnStartRes = await startTurn(threadId);
    } catch (err) {
      const msg = String(err?.message || err || '');
      const missingThread = /thread/i.test(msg) && /(not found|unknown|missing|invalid)/i.test(msg);
      if (!missingThread) throw err;

      let recovered = null;
      if (resolvedResume) {
        try {
          recovered = await client.call('thread/resume', { threadId: resolvedResume });
        } catch {
          recovered = null;
        }
      }
      if (!recovered) recovered = await client.call('thread/start', {});
      const recoveredObj = recovered?.thread ?? recovered;
      const recoveredTid = typeof recoveredObj?.id === 'string' ? recoveredObj.id.trim() : '';
      if (!recoveredTid) throw err;
      threadId = recoveredTid;
      turnStartRes = await startTurn(threadId);
    }

    if (!turnId) {
      const id = typeof turnStartRes?.turn?.id === 'string' ? turnStartRes.turn.id.trim() : '';
      if (id) turnId = id;
    }

    /** @type {NodeJS.Timeout|null} */
    let timeoutTimer = null;

    const updateWatcher = createTaskUpdateWatcher();

    const timeoutPromise =
      timeoutMs > 0
        ? new Promise((resolve) => {
            timeoutTimer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
            timeoutTimer.unref?.();
          })
        : new Promise(() => {});

    let raced;
    try {
      raced = await Promise.race([donePromise, updateWatcher.promise, timeoutPromise]);
    } finally {
      updateWatcher.stop();
      if (timeoutTimer) clearTimeout(timeoutTimer);
      client.off('notification', onNotification);
    }

    if (raced?.kind === 'updated') {
      if (threadId && turnId) {
        try {
          await client.call('turn/interrupt', { threadId, turnId });
        } catch {
          // ignore
        }
      }
      throw new CodexExecSupersededError({
        reason: 'task updated',
        pid: pid ?? 0,
        threadId,
        stderrTail: '',
        stdoutTail: '',
      });
    }

    if (raced?.kind === 'timeout') {
      if (threadId && turnId) {
        try {
          await client.call('turn/interrupt', { threadId, turnId });
        } catch {
          // ignore
        }
      }
      throw new CodexExecTimeoutError({
        timeoutMs,
        killGraceMs: 10_000,
        pid: pid ?? 0,
        threadId,
        stderrTail: '',
        stdoutTail: '',
      });
    }

    const text = raced?.agentMessageText ? String(raced.agentMessageText) : '';
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new CodexExecError('codex app-server returned non-JSON output', {
        exitCode: 1,
        stderrTail: text.slice(-64_000),
        stdoutTail: '',
        threadId,
      });
    }

    await writeJsonAtomic(outputPath, parsed);
    return { threadId, stderrTail: '', stdoutTail: '' };
  } finally {
    if (!persist) {
      try {
        await client.stop();
      } catch {
        // ignore
      }
      await credential.cleanup();
    }
  }
}

/**
 * Helper for wait for global cooldown used by the cockpit workflow runtime.
 */
async function waitForGlobalCooldown({
  busRoot,
  roster,
  fromAgent,
  openedMeta,
  throttle,
  jitterMs = 200,
}) {
  const cd = await readGlobalCooldown({ busRoot });
  if (!cd) return null;
  const now = Date.now();
  if (cd.retryAtMs <= now) return null;

  const waitMs = Math.max(0, cd.retryAtMs - now);
  const retryAtIso = new Date(cd.retryAtMs).toISOString();
  const reason = String(cd?.payload?.reason || '').trim();

  await maybeSendStatusToDaddy({
    busRoot,
    roster,
    fromAgent,
    priority: openedMeta?.priority || 'P2',
    rootId: openedMeta?.signals?.rootId ?? openedMeta?.id ?? null,
    parentId: openedMeta?.id ?? null,
    title: `STATUS: waiting on RPM reset (${fromAgent})`,
    body:
      `Global OpenAI RPM cooldown is active.\n\n` +
      `Agent: ${fromAgent}\n` +
      `Next retry: ${retryAtIso}\n` +
      (reason ? `Reason: ${reason}\n` : '') +
      `\n(Worker will auto-retry.)\n`,
    throttle,
  });

  // Add slight jitter to avoid synchronized wakeups.
  const jitter = Math.floor(Math.random() * Math.max(0, Number(jitterMs) || 0));
  await sleep(waitMs + jitter);
  return cd;
}

/**
 * Normalizes skill name for downstream use.
 */
function normalizeSkillName(name) {
  const raw = String(name ?? '').trim();
  if (!raw) return null;
  return raw.startsWith('$') ? raw.slice(1) : raw;
}

/**
 * Returns whether planning skill.
 */
function isPlanningSkill(name) {
  return (
    name === 'planning' ||
    name === 'valua-planning' ||
    name.endsWith('-planning') ||
    name.endsWith('-plan')
  );
}

/**
 * Returns whether exec skill.
 */
function isExecSkill(name) {
  return name === 'exec-agent' || name === 'valua-exec-agent' || name.endsWith('-exec-agent');
}

/**
 * Resolves autopilot skill profile from task kind + env.
 */
function resolveAutopilotSkillProfile({ taskKind, env = process.env }) {
  const kind = normalizeTaskKind(taskKind);
  const mapped = kind === 'EXECUTE' ? 'execute' : 'controller';
  const overrideRaw = String(env.AGENTIC_AUTOPILOT_SKILL_PROFILE ?? env.VALUA_AUTOPILOT_SKILL_PROFILE ?? '')
    .trim()
    .toLowerCase();
  if (overrideRaw === 'execute' || overrideRaw === 'controller') return overrideRaw;
  return mapped;
}

/**
 * Helper for select skills used by the cockpit workflow runtime.
 */
function selectSkills({ skills, taskKind, isSmoke, isAutopilot, env = process.env }) {
  const rawSkills = Array.isArray(skills) ? skills : [];
  const set = new Set(rawSkills.map(normalizeSkillName).filter(Boolean));

  if (isSmoke) {
    return {
      skillsSelected: [],
      skillProfile: isAutopilot ? resolveAutopilotSkillProfile({ taskKind, env }) : 'default',
      execSkillSelected: false,
    };
  }

  const taskKindNorm = normalizeTaskKind(taskKind);
  const execOverrides = parseCsvEnv(
    env.AGENTIC_AUTOPILOT_EXEC_SKILLS ?? env.VALUA_AUTOPILOT_EXEC_SKILLS ?? 'valua-exec-agent',
  )
    .map(normalizeSkillName)
    .filter(Boolean);
  const enableLangPolicies = parseBooleanEnv(
    env.AGENTIC_AUTOPILOT_ENABLE_LANG_POLICIES ?? env.VALUA_AUTOPILOT_ENABLE_LANG_POLICIES ?? '0',
    false,
  );

  /** @type {string[]} */
  const selected = [];

  const skillProfile = isAutopilot ? resolveAutopilotSkillProfile({ taskKind: taskKindNorm, env }) : 'default';

  if (taskKindNorm === 'PLAN_REQUEST') {
    const planning = Array.from(set).find(isPlanningSkill);
    if (planning) selected.push(planning);
  }

  if (isAutopilot && skillProfile === 'execute') {
    for (const name of execOverrides) {
      if (selected.includes(name)) continue;
      selected.push(name);
    }
    if (!selected.some((name) => isExecSkill(name))) {
      const fallbackExec = Array.from(set).find(isExecSkill);
      if (fallbackExec) selected.push(fallbackExec);
    }
  } else if (!isAutopilot && taskKindNorm === 'EXECUTE') {
    const execAgent = Array.from(set).find((name) => isExecSkill(name) || isNamedExecSkill(name, execOverrides));
    if (execAgent) selected.push(execAgent);
  }

  for (const name of set) {
    if (selected.includes(name)) continue;
    if (isAutopilot && skillProfile !== 'execute' && (isExecSkill(name) || isNamedExecSkill(name, execOverrides))) {
      continue;
    }
    if (isAutopilot && isLanguagePolicySkill(name) && !(skillProfile === 'execute' && enableLangPolicies)) {
      continue;
    }
    selected.push(name);
  }

  return {
    skillsSelected: selected,
    skillProfile,
    execSkillSelected: selected.some((name) => isExecSkill(name) || isNamedExecSkill(name, execOverrides)),
  };
}

/**
 * Helper for compute skills hash used by the cockpit workflow runtime.
 */
async function computeSkillsHash(skillsSelected, { taskCwd } = {}) {
  const normalized = Array.isArray(skillsSelected)
    ? skillsSelected.map(normalizeSkillName).filter(Boolean).sort()
    : [];

  /** @type {Record<string, string>} */
  const fingerprints = {};
  const skillsRoot = taskCwd ? path.join(taskCwd, '.codex', 'skills') : null;

  for (const name of normalized) {
    if (!skillsRoot) {
      fingerprints[name] = 'unknown';
      continue;
    }
    const skillFile = path.join(skillsRoot, name, 'SKILL.md');
    try {
      const raw = await fs.readFile(skillFile);
      fingerprints[name] = `sha256:${crypto.createHash('sha256').update(raw).digest('hex')}`;
    } catch {
      fingerprints[name] = 'missing';
    }
  }

  const payload = JSON.stringify({ skills: normalized, fingerprints });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

/**
 * Reads string field from disk or process state.
 */
function readStringField(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Normalizes commit sha list for review scope.
 */
function normalizeCommitShaList(values) {
  if (!Array.isArray(values)) return [];
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  for (const raw of values) {
    const sha = extractCommitShaFromText(String(raw || ''));
    if (!sha) continue;
    if (seen.has(sha)) continue;
    seen.add(sha);
    out.push(sha);
  }
  return out;
}

/**
 * Normalizes autopilot control payload.
 */
function normalizeAutopilotControl(value) {
  const raw = isPlainObject(value) ? value : {};
  const executionModeRaw = readStringField(raw.executionMode).toLowerCase();
  const executionMode =
    executionModeRaw === 'tiny_fixup' || executionModeRaw === 'delegate' ? executionModeRaw : '';
  const tinyFixJustification = readStringField(raw.tinyFixJustification);
  const workstream = normalizeBranchToken(readStringField(raw.workstream) || 'main') || 'main';
  const branchDecisionRaw = readStringField(raw.branchDecision).toLowerCase();
  const branchDecision =
    branchDecisionRaw === 'reuse' || branchDecisionRaw === 'rotate' || branchDecisionRaw === 'close'
      ? branchDecisionRaw
      : '';
  const branchDecisionReason = readStringField(raw.branchDecisionReason);
  return {
    executionMode,
    tinyFixJustification,
    workstream,
    branchDecision,
    branchDecisionReason,
  };
}

/**
 * Returns whether completion metadata proves delegated execute completion.
 */
function hasDelegatedCompletionEvidence({ taskMeta, workstream = 'main' }) {
  const sourceKind = readStringField(taskMeta?.signals?.sourceKind).toUpperCase();
  const completedTaskKind = readStringField(taskMeta?.references?.completedTaskKind).toUpperCase();
  const receiptOutcome = readStringField(taskMeta?.references?.receiptOutcome).toLowerCase();
  const completionWorkstream = normalizeBranchToken(
    readStringField(taskMeta?.references?.workstream) || 'main',
  );
  if (sourceKind !== 'TASK_COMPLETE') return false;
  if (completedTaskKind !== 'EXECUTE') return false;
  if (receiptOutcome && receiptOutcome !== 'done') return false;
  if (completionWorkstream && workstream && completionWorkstream !== workstream) return false;
  return true;
}

/**
 * Maps code-quality gate errors to stable reason codes.
 */
function mapCodeQualityReasonCodes(errors) {
  const text = String((Array.isArray(errors) ? errors : []).join(' ') || '').toLowerCase();
  const out = new Set();
  if (!text) return [];
  if (text.includes('missing_base_ref')) out.add('missing_base_ref');
  if (text.includes('scope_invalid')) out.add('scope_invalid');
  if (text.includes('scope_mismatch')) out.add('scope_mismatch');
  if (text.includes('artifact_only_mismatch')) out.add('artifact_only_mismatch');
  if (text.includes('evidence_semantic_mismatch')) out.add('evidence_semantic_mismatch');
  if (text.includes('qualityreview evidence is required') || text.includes('qualityreview.') || text.includes('qualityreview ')) {
    out.add('missing_quality_review_fields');
  }
  if (text.includes('timed out') || text.includes('exited with status')) out.add('gate_exec_failed');
  return Array.from(out);
}

/**
 * Returns whether code quality reason is recoverable in-task.
 */
function isRecoverableQualityReason(reasonCode) {
  return (
    reasonCode === 'gate_exec_failed' ||
    reasonCode === 'missing_base_ref' ||
    reasonCode === 'scope_invalid' ||
    reasonCode === 'scope_mismatch' ||
    reasonCode === 'artifact_only_mismatch' ||
    reasonCode === 'evidence_semantic_mismatch' ||
    reasonCode === 'missing_quality_review_fields'
  );
}

/**
 * Appends reason to note with stable formatting.
 */
function appendReasonNote(note, reason) {
  const text = String(reason || '').trim();
  if (!text) return note || '';
  const current = String(note || '').trim();
  return current ? `${current} (${text})` : text;
}

const OPUS_REASON_CODES = new Set([
  'opus_consult_pass',
  'opus_consult_warn',
  'opus_human_input_required',
  'opus_consult_iterate',
  'opus_consult_block',
  'opus_schema_invalid',
  'opus_timeout',
  'opus_claude_not_authenticated',
  'opus_rate_limited',
  'opus_refusal',
  'opus_transient',
]);

const OPUS_DISPOSITION_STATUSES = new Set(['acted', 'skipped', 'deferred']);
const OPUS_CONSULT_RESOLUTION_MAX_ENTRIES = 20_000;
const OPUS_CONSULT_RESOLUTION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Normalizes reasonCode to supported Opus schema values.
 */
function normalizeOpusReasonCode(value, fallback = 'opus_transient') {
  const reason = readStringField(value);
  if (OPUS_REASON_CODES.has(reason)) return reason;
  return fallback;
}

/**
 * Builds advisory fallback consult payload that is always schema-valid.
 */
function buildOpusAdvisoryFallbackPayload({
  consultId,
  round,
  reasonCode,
  rationale,
  suggestedPlan = [],
}) {
  const safeConsultId = readStringField(consultId) || 'consult_missing';
  const safeRound = Math.max(1, Math.min(200, Number(round) || 1));
  const safeReason = normalizeOpusReasonCode(reasonCode, 'opus_transient');
  const safeRationale = readStringField(rationale) || 'Advisory consult fallback applied due to runtime consult failure.';
  const planItems = Array.isArray(suggestedPlan)
    ? suggestedPlan.map((entry) => readStringField(entry)).filter(Boolean).slice(0, 24)
    : [];
  const normalizedPlan = planItems.length > 0 ? planItems : ['Proceed with autopilot decision and record Opus fallback diagnostics.'];
  const payload = {
    version: 'v1',
    consultId: safeConsultId,
    round: safeRound,
    final: true,
    verdict: safeReason === 'opus_consult_pass' ? 'pass' : 'warn',
    rationale: safeRationale.length >= 20 ? safeRationale : `${safeRationale} (fallback advisory)`,
    suggested_plan: normalizedPlan,
    alternatives: [],
    challenge_points: [],
    code_suggestions: [],
    required_questions: [],
    required_actions: [],
    retry_prompt_patch: '',
    unresolved_critical_questions: [],
    reasonCode: safeReason,
  };
  const validated = validateOpusConsultResponsePayload(payload);
  return validated.ok ? validated.value : {
    ...payload,
    reasonCode: 'opus_transient',
    suggested_plan: ['Proceed with autopilot decision and inspect consult logs.'],
  };
}

/**
 * Builds normalized advice items from an Opus response for autopilot disposition handling.
 */
function buildOpusAdviceItems(responsePayload, { maxItems = 12 } = {}) {
  const items = [];
  const suggestedPlan = Array.isArray(responsePayload?.suggested_plan)
    ? responsePayload.suggested_plan
    : [];
  const requiredActions = Array.isArray(responsePayload?.required_actions)
    ? responsePayload.required_actions
    : [];
  const codeSuggestions = Array.isArray(responsePayload?.code_suggestions)
    ? responsePayload.code_suggestions
    : [];

  for (const entry of suggestedPlan) {
    const text = readStringField(entry);
    if (!text) continue;
    items.push({ id: '', category: 'plan', text });
    if (items.length >= maxItems) break;
  }
  if (items.length < maxItems) {
    for (const entry of requiredActions) {
      const text = readStringField(entry);
      if (!text) continue;
      items.push({ id: '', category: 'action', text });
      if (items.length >= maxItems) break;
    }
  }
  if (items.length < maxItems) {
    for (const entry of codeSuggestions) {
      const targetPath = readStringField(entry?.target_path);
      const changeType = readStringField(entry?.change_type);
      const suggestion = readStringField(entry?.suggestion);
      const text = [targetPath ? `${targetPath}` : '', changeType ? `[${changeType}]` : '', suggestion]
        .filter(Boolean)
        .join(' ');
      if (!text) continue;
      items.push({ id: '', category: 'code', text: text.slice(0, 800) });
      if (items.length >= maxItems) break;
    }
  }
  return items.map((item, index) => ({ ...item, id: `OPUS-${index + 1}` }));
}

/**
 * Builds consult advice summary object for receipts/context injection.
 */
function buildOpusConsultAdvice({ mode, phaseResult, phase }) {
  if (!phaseResult || typeof phaseResult !== 'object') {
    return {
      consulted: false,
      phase,
      mode,
      severity: 'none',
      reasonCode: null,
      summary: '',
      items: [],
      consultId: '',
      round: 0,
      responseTaskId: '',
    };
  }
  const response = phaseResult.finalResponse && typeof phaseResult.finalResponse === 'object'
    ? phaseResult.finalResponse
    : null;
  const isSynthetic = phaseResult.finalResponseRuntime?.synthetic === true;
  const reasonCode = readStringField(phaseResult.reasonCode || response?.reasonCode) || null;
  const summary = readStringField(response?.rationale || phaseResult.note || '');
  const items = response && !isSynthetic ? buildOpusAdviceItems(response) : [];
  const severity = phaseResult.ok
    ? (readStringField(response?.verdict) === 'warn' ? 'warn' : 'pass')
    : (mode === 'gate' ? 'block' : 'warn');
  return {
    consulted: true,
    phase,
    mode,
    severity,
    reasonCode,
    summary,
    items,
    consultId: readStringField(phaseResult.consultId),
    round: Number(phaseResult.roundsUsed) || Number(response?.round) || 0,
    responseTaskId: readStringField(phaseResult.finalResponseTaskId),
  };
}

/**
 * Encodes a note field for OPUS_DISPOSITIONS grammar.
 */
function encodeOpusDispositionField(value) {
  return encodeURIComponent(readStringField(value)).replace(/%20/g, ' ');
}

/**
 * Decodes a note field for OPUS_DISPOSITIONS grammar.
 */
function decodeOpusDispositionField(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * Parses OPUS_DISPOSITIONS block from autopilot note.
 */
function parseOpusDispositionsFromNote(noteText) {
  const text = String(noteText || '');
  const lines = text.split(/\r?\n/);
  const markerIndex = lines.findIndex((line) => line.trim() === 'OPUS_DISPOSITIONS:');
  if (markerIndex < 0) return { entries: [], parseErrors: [] };
  const entries = [];
  const parseErrors = [];
  for (let i = markerIndex + 1; i < lines.length; i += 1) {
    const raw = lines[i].trim();
    if (!raw) break;
    if (!raw.startsWith('OPUS-')) break;
    const parts = raw.split('|');
    if (parts.length !== 4) {
      parseErrors.push(`invalid OPUS_DISPOSITIONS line format: ${raw}`);
      continue;
    }
    const id = readStringField(parts[0]);
    const status = readStringField(parts[1]).toLowerCase();
    const action = decodeOpusDispositionField(parts[2]);
    const reason = decodeOpusDispositionField(parts[3]);
    if (!/^OPUS-\d+$/.test(id)) {
      parseErrors.push(`invalid OPUS disposition id: ${id || '(missing)'}`);
      continue;
    }
    if (!OPUS_DISPOSITION_STATUSES.has(status)) {
      parseErrors.push(`invalid OPUS disposition status: ${status || '(missing)'}`);
      continue;
    }
    if (!action || !reason) {
      parseErrors.push(`OPUS disposition requires action and reason: ${id}`);
      continue;
    }
    entries.push({ id, status, action, reason, line: raw });
  }
  return { entries, parseErrors };
}

/**
 * Validates OPUS_DISPOSITIONS note coverage for required advice item ids.
 */
function validateOpusDispositions({ noteText, requiredIds }) {
  const required = Array.isArray(requiredIds)
    ? requiredIds.map((id) => readStringField(id)).filter(Boolean)
    : [];
  if (required.length === 0) {
    return {
      ok: true,
      missingIds: [],
      parseErrors: [],
      entries: [],
    };
  }
  const parsed = parseOpusDispositionsFromNote(noteText);
  const seen = new Set(parsed.entries.map((entry) => entry.id));
  const missingIds = required.filter((id) => !seen.has(id));
  return {
    ok: missingIds.length === 0 && parsed.parseErrors.length === 0,
    missingIds,
    parseErrors: parsed.parseErrors,
    entries: parsed.entries,
  };
}

/**
 * Builds consult resolution key for first-consumed registry.
 */
function buildOpusConsultResolutionKey({ consultId, phase, round }) {
  const cid = readStringField(consultId);
  const ph = readStringField(phase);
  const rd = Math.max(1, Math.min(200, Number(round) || 1));
  return safeStateBasename(`${cid}__${ph}__r${rd}`);
}

/**
 * Returns consult resolution registry file path.
 */
function resolveOpusConsultResolutionPath({ busRoot, consultId, phase, round }) {
  const key = buildOpusConsultResolutionKey({ consultId, phase, round });
  const dir = path.join(busRoot, 'state', 'opus-consult-resolution');
  return {
    key,
    dir,
    path: path.join(dir, `${key}.json`),
  };
}

/**
 * Reads consult resolution registry entry.
 */
async function readOpusConsultResolution({ busRoot, consultId, phase, round }) {
  const p = resolveOpusConsultResolutionPath({ busRoot, consultId, phase, round }).path;
  try {
    const raw = await fs.readFile(p, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Prunes consult resolution registry by age and cap.
 */
async function pruneOpusConsultResolutionRegistry({ busRoot }) {
  const dir = path.join(busRoot, 'state', 'opus-consult-resolution');
  const lockDir = path.join(dir, '.prune.lock');
  await fs.mkdir(dir, { recursive: true });
  try {
    await fs.mkdir(lockDir);
  } catch {
    return;
  }
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const filePath = path.join(dir, entry.name);
      try {
        const st = await fs.stat(filePath);
        files.push({ filePath, mtimeMs: Number(st.mtimeMs) || 0 });
      } catch {
        // ignore missing/removed files
      }
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const now = Date.now();
    for (let i = 0; i < files.length; i += 1) {
      const item = files[i];
      const expired = now - item.mtimeMs > OPUS_CONSULT_RESOLUTION_RETENTION_MS;
      const overCap = i >= OPUS_CONSULT_RESOLUTION_MAX_ENTRIES;
      if (!expired && !overCap) continue;
      try {
        await fs.unlink(item.filePath);
      } catch {
        // ignore
      }
    }
  } finally {
    try {
      await fs.rmdir(lockDir);
    } catch {
      // ignore
    }
  }
}

/**
 * Writes consult resolution entry only if no previous consumed entry exists.
 */
async function writeFirstOpusConsultResolution({
  busRoot,
  consultId,
  phase,
  round,
  responseTaskId,
  from,
  source,
  verdict,
  reasonCode,
  synthetic = false,
  syntheticEmitter = '',
}) {
  const location = resolveOpusConsultResolutionPath({ busRoot, consultId, phase, round });
  const payload = {
    updatedAt: new Date().toISOString(),
    key: location.key,
    consultId: readStringField(consultId),
    phase: readStringField(phase),
    round: Math.max(1, Math.min(200, Number(round) || 1)),
    consumedResponseTaskId: readStringField(responseTaskId),
    consumedFrom: readStringField(from),
    source: readStringField(source) || (synthetic ? 'synthetic' : 'real'),
    verdict: readStringField(verdict),
    reasonCode: normalizeOpusReasonCode(reasonCode, 'opus_transient'),
    synthetic: Boolean(synthetic),
    syntheticEmitter: readStringField(syntheticEmitter),
  };

  await fs.mkdir(location.dir, { recursive: true });
  try {
    const handle = await fs.open(location.path, 'wx');
    try {
      await handle.writeFile(JSON.stringify(payload, null, 2) + '\n', 'utf8');
    } finally {
      await handle.close();
    }
    void pruneOpusConsultResolutionRegistry({ busRoot });
    return { created: true, entry: payload };
  } catch (err) {
    if (readStringField(err?.code) !== 'EEXIST') throw err;
    const existing = await readOpusConsultResolution({ busRoot, consultId, phase, round });
    return { created: false, entry: existing || null };
  }
}

/**
 * Builds deterministic signature for code-quality retry dedupe.
 */
function buildCodeQualityRetrySignature({
  reasonCode,
  codeQualityGateEvidence,
  codeQualityReviewEvidence,
  errors,
}) {
  const payload = {
    reasonCode: readStringField(reasonCode),
    errors: Array.isArray(errors) ? errors.map((v) => String(v)).sort() : [],
    scope: readStringField(codeQualityGateEvidence?.changedScopeReturned),
    files: Array.isArray(codeQualityGateEvidence?.changedFilesSample)
      ? codeQualityGateEvidence.changedFilesSample.map((v) => String(v)).sort()
      : [],
    sourceFilesSeenCount: Number(codeQualityGateEvidence?.sourceFilesSeenCount) || 0,
    artifactOnlyChange: Boolean(codeQualityGateEvidence?.artifactOnlyChange),
    reviewPresent: Boolean(codeQualityReviewEvidence?.present),
    reviewSummary: readStringField(codeQualityReviewEvidence?.summary),
    hardRuleChecks:
      codeQualityReviewEvidence?.hardRuleChecks && typeof codeQualityReviewEvidence.hardRuleChecks === 'object'
        ? codeQualityReviewEvidence.hardRuleChecks
        : {},
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/**
 * Helper for derive review gate used by the cockpit workflow runtime.
 */
function deriveReviewGate({
  isAutopilot,
  taskKind,
  taskMeta,
  userRequestedReview = false,
  userRequestedReviewTargetCommitSha = '',
  userRequestedReviewTargetCommitShas = [],
  userRequestedReviewResolutionError = '',
}) {
  if (!isAutopilot) {
    return {
      required: false,
      targetCommitSha: '',
      targetCommitShas: [],
      sourceTaskId: '',
      sourceAgent: '',
      receiptPath: '',
      sourceKind: '',
      scope: 'none',
    };
  }

  const sourceKind = readStringField(taskMeta?.signals?.sourceKind);
  const completedTaskKind = readStringField(taskMeta?.references?.completedTaskKind);
  const explicitRequired = taskMeta?.signals?.reviewRequired === true;

  const reviewTarget = taskMeta?.signals?.reviewTarget && typeof taskMeta.signals.reviewTarget === 'object'
    ? taskMeta.signals.reviewTarget
    : null;

  const targetCommitSha =
    readStringField(reviewTarget?.commitSha) ||
    readStringField(taskMeta?.references?.commitSha) ||
    readStringField(userRequestedReviewTargetCommitSha);
  const targetCommitShas = normalizeCommitShaList([
    ...(Array.isArray(reviewTarget?.commitShas) ? reviewTarget.commitShas : []),
    ...(Array.isArray(userRequestedReviewTargetCommitShas) ? userRequestedReviewTargetCommitShas : []),
    targetCommitSha,
  ]);
  const reviewableCommit = Boolean(targetCommitShas.length || targetCommitSha);
  const receiptOutcome = readStringField(
    reviewTarget?.receiptOutcome || taskMeta?.references?.receiptOutcome || '',
  ).toLowerCase();
  const receiptDone = receiptOutcome ? receiptOutcome === 'done' : true;
  // Backward-compatible fallback: older orchestrator packets may not set reviewRequired yet.
  const legacyRequired =
    sourceKind === 'TASK_COMPLETE' &&
    completedTaskKind === 'EXECUTE' &&
    receiptDone &&
    reviewableCommit;
  const explicitReviewRequired = explicitRequired && receiptDone && reviewableCommit;
  const required = Boolean(userRequestedReview || explicitReviewRequired || legacyRequired);
  const resolutionError = readStringField(userRequestedReviewResolutionError);

  const sourceTaskId =
    readStringField(reviewTarget?.sourceTaskId) ||
    readStringField(taskMeta?.references?.sourceTaskId) ||
    readStringField(taskMeta?.signals?.rootId);
  const sourceAgent =
    readStringField(reviewTarget?.sourceAgent) ||
    readStringField(taskMeta?.references?.sourceAgent);
  const receiptPath =
    readStringField(reviewTarget?.receiptPath) ||
    readStringField(taskMeta?.references?.receiptPath);
  const sourceTaskKind = readStringField(reviewTarget?.sourceKind) || completedTaskKind;
  const scope = userRequestedReview ? (targetCommitShas.length > 1 ? 'pr' : 'commit') : 'commit';

  return {
    required,
    targetCommitSha: targetCommitShas.length ? targetCommitShas[targetCommitShas.length - 1] : targetCommitSha,
    targetCommitShas,
    userRequested: Boolean(userRequestedReview),
    resolutionError,
    sourceTaskId,
    sourceAgent,
    receiptPath,
    sourceKind: sourceTaskKind,
    scope: required ? scope : 'none',
  };
}

/**
 * Returns whether explicit review request text.
 */
function isExplicitReviewRequestText(value) {
  const text = String(value || '');
  if (!text.trim()) return false;
  return (
    /\b\/review\b/i.test(text) ||
    /\breview\/start\b/i.test(text) ||
    /\breal\s+review\b/i.test(text) ||
    /\btrigger\s+.*\breview\b/i.test(text) ||
    /\brun\s+.*\breview\b/i.test(text)
  );
}

/**
 * Extracts commit sha from text.
 */
function extractCommitShaFromText(value) {
  const text = String(value || '');
  const m = text.match(/\b([0-9a-f]{6,40})\b/i);
  return m ? m[1].toLowerCase() : '';
}

/**
 * Extracts pr number from text.
 */
function extractPrNumberFromText(value) {
  const text = String(value || '');
  const m = text.match(/\b(?:PR|pull\s+request)\s*#?\s*(\d{1,8})\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Infers user-request review target for autopilot workflow tasks.
 */
function inferUserRequestedReviewGate({ taskKind, taskMeta, taskMarkdown, cwd }) {
  if (String(taskKind || '').trim().toUpperCase() !== 'USER_REQUEST') {
    return { requested: false, targetCommitSha: '', targetCommitShas: [], resolutionError: '' };
  }

  const title = readStringField(taskMeta?.title);
  const bodyText = String(taskMarkdown || '');
  const merged = [title, bodyText].filter(Boolean).join('\n');
  if (!isExplicitReviewRequestText(merged)) {
    return { requested: false, targetCommitSha: '', targetCommitShas: [], resolutionError: '' };
  }

  // Prefer explicit commit references in task metadata/body when present.
  let targetCommitSha =
    readStringField(taskMeta?.references?.commitSha) ||
    extractCommitShaFromText(merged) ||
    '';
  /** @type {string[]} */
  let targetCommitShas = targetCommitSha ? [targetCommitSha] : [];

  const prNumber = extractPrNumberFromText(merged);
  // If a PR number is present, prefer full-PR review scope (all commits from base->head).
  if (prNumber) {
    const commitLines = safeExecText(
      'gh',
      ['pr', 'view', String(prNumber), '--json', 'commits', '--jq', '.commits[].oid'],
      { cwd },
    );
    const commitShas = normalizeCommitShaList(String(commitLines || '').split('\n'));
    if (commitShas.length) {
      targetCommitShas = commitShas;
      targetCommitSha = commitShas[commitShas.length - 1];
    } else if (!targetCommitSha) {
      const head = safeExecText(
        'gh',
        ['pr', 'view', String(prNumber), '--json', 'headRefOid', '--jq', '.headRefOid'],
        { cwd },
      );
      targetCommitSha = extractCommitShaFromText(head || '');
      targetCommitShas = targetCommitSha ? [targetCommitSha] : [];
    }
    if (!targetCommitSha && targetCommitShas.length === 0) {
      return {
        requested: true,
        targetCommitSha: '',
        targetCommitShas: [],
        resolutionError: `explicit PR review requested for PR#${prNumber}, but commit targets could not be resolved`,
      };
    }
  }

  return { requested: true, targetCommitSha, targetCommitShas, resolutionError: '' };
}

/**
 * Helper for derive skill ops gate used by the cockpit workflow runtime.
 */
function deriveSkillOpsGate({ isAutopilot, taskKind, env = process.env }) {
  const kind = readStringField(taskKind)?.toUpperCase() || '';
  const enabled = parseBooleanEnv(
    env.AGENTIC_AUTOPILOT_SKILLOPS_GATE ??
      env.VALUA_AUTOPILOT_SKILLOPS_GATE ??
      env.AGENTIC_AUTOPILOT_REQUIRE_SKILLOPS ??
      env.VALUA_AUTOPILOT_REQUIRE_SKILLOPS ??
      '',
    false,
  );
  const requiredKindsRaw =
    env.AGENTIC_AUTOPILOT_SKILLOPS_GATE_KINDS ??
    env.VALUA_AUTOPILOT_SKILLOPS_GATE_KINDS ??
    'USER_REQUEST';
  const requiredKinds = normalizeToArray(requiredKindsRaw).map((v) => v.toUpperCase());
  const required = Boolean(isAutopilot && enabled && kind && requiredKinds.includes(kind));
  return {
    enabled,
    required,
    taskKind: kind,
    requiredKinds,
  };
}

/**
 * Helper for derive post-merge resync gate used by the cockpit workflow runtime.
 */
function derivePostMergeResyncGate({ isAutopilot, env = process.env }) {
  const enabled = parseBooleanEnv(
    env.AGENTIC_AUTOPILOT_POST_MERGE_RESYNC ??
      env.VALUA_AUTOPILOT_POST_MERGE_RESYNC ??
      env.AGENTIC_POST_MERGE_RESYNC ??
      env.VALUA_POST_MERGE_RESYNC ??
      '',
    false,
  );
  const required = Boolean(isAutopilot && enabled);
  return {
    enabled,
    required,
  };
}

/**
 * Helper for derive code quality gate used by the cockpit workflow runtime.
 */
function deriveCodeQualityGate({ isAutopilot = false, taskKind, env = process.env }) {
  const kind = readStringField(taskKind)?.toUpperCase() || '';
  const enabledRaw = env.AGENTIC_CODE_QUALITY_GATE ?? env.VALUA_CODE_QUALITY_GATE ?? '';
  const enabled = enabledRaw === '' ? false : parseBooleanEnv(enabledRaw, false);
  const defaultKinds = isAutopilot ? 'USER_REQUEST,ORCHESTRATOR_UPDATE,EXECUTE' : 'EXECUTE';
  const requiredKindsRaw =
    env.AGENTIC_CODE_QUALITY_GATE_KINDS ??
    env.VALUA_CODE_QUALITY_GATE_KINDS ??
    defaultKinds;
  const requiredKinds = normalizeToArray(requiredKindsRaw).map((v) => v.toUpperCase());
  const required = Boolean(enabled && kind && requiredKinds.includes(kind));
  const strictCommitScoped = parseBooleanEnv(
    env.AGENTIC_STRICT_COMMIT_SCOPED_GATE ?? env.VALUA_STRICT_COMMIT_SCOPED_GATE ?? (isAutopilot ? '1' : '0'),
    isAutopilot,
  );
  const defaultIncludeRules = ['**'];
  const defaultExcludeRules = [
    '.codex/quality/logs/**',
    '.codex/skill-ops/logs/**',
    '.codex-tmp/**',
    'docs/**',
    'build/**',
    'dist/**',
    'tmp/**',
    'temp/**',
  ];
  const scopeIncludeRules = parseCsvEnv(
    env.AGENTIC_CODE_QUALITY_SCOPE_INCLUDE ??
      env.VALUA_CODE_QUALITY_SCOPE_INCLUDE ??
      defaultIncludeRules.join(','),
  );
  const scopeExcludeRules = parseCsvEnv(
    env.AGENTIC_CODE_QUALITY_SCOPE_EXCLUDE ??
      env.VALUA_CODE_QUALITY_SCOPE_EXCLUDE ??
      defaultExcludeRules.join(','),
  );
  return {
    enabled,
    required,
    taskKind: kind,
    requiredKinds,
    strictCommitScoped,
    scopeIncludeRules,
    scopeExcludeRules,
  };
}

/**
 * Derives observer-drain gate for autopilot review-fix digests.
 */
function deriveObserverDrainGate({ isAutopilot, taskKind, taskMeta, env = process.env }) {
  const kind = readStringField(taskKind)?.toUpperCase() || '';
  const sourceKind = readStringField(taskMeta?.signals?.sourceKind).toUpperCase();
  const rootId = readStringField(taskMeta?.signals?.rootId);
  const enabled = parseBooleanEnv(
    env.AGENTIC_AUTOPILOT_OBSERVER_DRAIN_GATE ??
      env.VALUA_AUTOPILOT_OBSERVER_DRAIN_GATE ??
      '1',
    true,
  );
  const required = Boolean(
    isAutopilot &&
      enabled &&
      kind === 'ORCHESTRATOR_UPDATE' &&
      sourceKind === 'REVIEW_ACTION_REQUIRED' &&
      rootId,
  );
  return {
    enabled,
    required,
    rootId,
    sourceKind,
    taskKind: kind,
  };
}

/**
 * Derives Opus consult gate policy for the current task.
 */
function deriveOpusConsultGate({ isAutopilot, taskKind, roster, env = process.env }) {
  const kind = readStringField(taskKind).toUpperCase();
  const consultAgent = readStringField(
    env.AGENTIC_AUTOPILOT_OPUS_CONSULT_AGENT ??
      env.VALUA_AUTOPILOT_OPUS_CONSULT_AGENT ??
      'opus-consult',
  );
  const consultAgentExists = Boolean(
    consultAgent &&
      Array.isArray(roster?.agents) &&
      roster.agents.some((agent) => readStringField(agent?.name) === consultAgent),
  );

  const parseAutoEnabled = (rawValue, fallback) => {
    const raw = String(rawValue ?? '').trim().toLowerCase();
    if (!raw || raw === 'auto') return fallback;
    if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') return true;
    if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false;
    return fallback;
  };
  const legacyPreExecRaw = readStringField(
    env.AGENTIC_AUTOPILOT_OPUS_GATE ?? env.VALUA_AUTOPILOT_OPUS_GATE ?? '',
  );
  const legacyPostReviewRaw = readStringField(
    env.AGENTIC_AUTOPILOT_OPUS_POST_REVIEW ?? env.VALUA_AUTOPILOT_OPUS_POST_REVIEW ?? '',
  );
  const legacyBarrierRaw = readStringField(
    env.AGENTIC_AUTOPILOT_OPUS_ENFORCE_PREEXEC_BARRIER ??
      env.VALUA_AUTOPILOT_OPUS_ENFORCE_PREEXEC_BARRIER ??
      '',
  );
  const legacyPreExecEnabled = parseAutoEnabled(legacyPreExecRaw || 'auto', consultAgentExists);
  const legacyPostReviewEnabled = parseAutoEnabled(legacyPostReviewRaw || 'auto', consultAgentExists);
  const legacyBarrierEnabled = parseBooleanEnv(legacyBarrierRaw || '1', true);

  let consultMode = 'advisory';
  let modeSource = 'default';
  {
    const modeRaw = readStringField(
      env.AGENTIC_OPUS_CONSULT_MODE ?? env.VALUA_OPUS_CONSULT_MODE ?? '',
    ).toLowerCase();
    if (modeRaw === 'off' || modeRaw === 'disabled' || modeRaw === 'false' || modeRaw === '0') {
      consultMode = 'off';
      modeSource = 'explicit';
    } else if (modeRaw === 'gate' || modeRaw === 'strict') {
      consultMode = 'gate';
      modeSource = 'explicit';
    } else if (modeRaw === 'advisory' || modeRaw === 'warn' || modeRaw === 'advice') {
      consultMode = 'advisory';
      modeSource = 'explicit';
    } else {
      const hasLegacyModeSignal = Boolean(legacyPreExecRaw || legacyPostReviewRaw || legacyBarrierRaw);
      if (hasLegacyModeSignal) {
        if (!legacyPreExecEnabled && !legacyPostReviewEnabled) {
          consultMode = 'off';
        } else if (legacyBarrierEnabled) {
          consultMode = 'gate';
        } else {
          consultMode = 'advisory';
        }
        modeSource = 'legacy';
      }
    }
  }

  const preExecEnabled = consultMode !== 'off' && legacyPreExecEnabled;
  const postReviewEnabled = consultMode !== 'off' && legacyPostReviewEnabled;

  const preExecKinds = parseCsvEnv(
    env.AGENTIC_AUTOPILOT_OPUS_GATE_KINDS ??
      env.VALUA_AUTOPILOT_OPUS_GATE_KINDS ??
      'USER_REQUEST,PLAN_REQUEST,ORCHESTRATOR_UPDATE,EXECUTE',
  ).map((entry) => entry.toUpperCase());
  const postReviewKinds = parseCsvEnv(
    env.AGENTIC_AUTOPILOT_OPUS_POST_REVIEW_KINDS ??
      env.VALUA_AUTOPILOT_OPUS_POST_REVIEW_KINDS ??
      'USER_REQUEST,PLAN_REQUEST,ORCHESTRATOR_UPDATE,EXECUTE',
  ).map((entry) => entry.toUpperCase());

  const configuredGateTimeoutMs = Math.max(
    1_000,
    Number(
      env.AGENTIC_AUTOPILOT_OPUS_GATE_TIMEOUT_MS ??
        env.VALUA_AUTOPILOT_OPUS_GATE_TIMEOUT_MS ??
        '3600000',
    ) || 3_600_000,
  );
  const opusTimeoutMs = Math.max(
    1_000,
    Number(
      env.AGENTIC_OPUS_TIMEOUT_MS ??
        env.VALUA_OPUS_TIMEOUT_MS ??
        '3600000',
    ) || 3_600_000,
  );
  const opusMaxRetries = Math.max(
    0,
    Number(
      env.AGENTIC_OPUS_MAX_RETRIES ??
        env.VALUA_OPUS_MAX_RETRIES ??
        '0',
    ) || 0,
  );
  const opusProtocolModeRaw = readStringField(
    env.AGENTIC_OPUS_PROTOCOL_MODE ??
      env.VALUA_OPUS_PROTOCOL_MODE ??
      (consultMode === 'gate' ? 'dual_pass' : 'freeform_only'),
  ).toLowerCase();
  const opusProtocolMode = (
    opusProtocolModeRaw === 'strict_only' ||
    opusProtocolModeRaw === 'dual_pass' ||
    opusProtocolModeRaw === 'freeform_only'
  )
    ? opusProtocolModeRaw
    : (consultMode === 'gate' ? 'dual_pass' : 'freeform_only');
  const opusStagesPerRound = opusProtocolMode === 'dual_pass' ? 2 : 1;
  let retryBackoffBudgetMs = 0;
  for (let attempt = 1; attempt <= opusMaxRetries; attempt += 1) {
    retryBackoffBudgetMs += Math.min(1000 * attempt, 5000);
  }
  const consultRuntimeBudgetMs =
    opusTimeoutMs * (opusMaxRetries + 1) * opusStagesPerRound +
    retryBackoffBudgetMs * opusStagesPerRound +
    5_000;
  const gateTimeoutMs = Math.max(configuredGateTimeoutMs, consultRuntimeBudgetMs);
  const configuredMaxRounds = Math.max(
    1,
    Number(
      env.AGENTIC_AUTOPILOT_OPUS_MAX_ROUNDS ??
        env.VALUA_AUTOPILOT_OPUS_MAX_ROUNDS ??
        '200',
    ) || 200,
  );
  const maxRounds = consultMode === 'advisory' ? 1 : configuredMaxRounds;

  const enforcePreExecBarrier = consultMode === 'gate' && parseBooleanEnv(
    env.AGENTIC_AUTOPILOT_OPUS_ENFORCE_PREEXEC_BARRIER ??
      env.VALUA_AUTOPILOT_OPUS_ENFORCE_PREEXEC_BARRIER ??
      '1',
    true,
  );
  const warnRequiresAck = consultMode === 'gate' && parseBooleanEnv(
    env.AGENTIC_AUTOPILOT_OPUS_WARN_REQUIRES_ACK ??
      env.VALUA_AUTOPILOT_OPUS_WARN_REQUIRES_ACK ??
      '0',
    false,
  );
  const requireDecisionRationale = consultMode === 'gate' && parseBooleanEnv(
    env.AGENTIC_AUTOPILOT_OPUS_REQUIRE_DECISION_RATIONALE ??
      env.VALUA_AUTOPILOT_OPUS_REQUIRE_DECISION_RATIONALE ??
      '1',
    true,
  );

  const preExecRequired = Boolean(isAutopilot && preExecEnabled && kind && preExecKinds.includes(kind));
  const postReviewRequired = Boolean(isAutopilot && postReviewEnabled && kind && postReviewKinds.includes(kind));

  return {
    taskKind: kind,
    consultAgent,
    consultAgentExists,
    consultMode,
    consultModeSource: modeSource,
    preExecEnabled: Boolean(preExecEnabled),
    postReviewEnabled: Boolean(postReviewEnabled),
    preExecRequired,
    postReviewRequired,
    preExecKinds,
    postReviewKinds,
    gateTimeoutMs,
    protocolMode: opusProtocolMode,
    stagesPerRound: opusStagesPerRound,
    maxRounds,
    enforcePreExecBarrier,
    warnRequiresAck,
    requireDecisionRationale,
  };
}

function summarizeForOpus(value, maxLen = 1200) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)} [truncated]`;
}

function buildOpusConsultRequestPayload({
  openedMeta,
  taskMarkdown,
  taskKind,
  roster = null,
  consultId,
  round,
  maxRounds,
  phase,
  priorRoundSummary = null,
  autopilotMessage = null,
  candidateOutput = null,
}) {
  const parsedFollowUps = Array.isArray(candidateOutput?.followUps) ? candidateOutput.followUps : [];
  const proposedDispatches = parsedFollowUps.slice(0, 8).map((fu) => ({
    to: normalizeToArray(fu?.to).slice(0, 8),
    kind: readStringField(fu?.signals?.kind),
    phase: readStringField(fu?.signals?.phase),
    title: summarizeForOpus(fu?.title, 280),
    reason: summarizeForOpus(fu?.body, 600),
  }));
  const intendedActions = [
    phase === 'pre_exec' ? 'Prepare execution/dispatch plan.' : 'Decide closure readiness after output validation.',
    phase === 'pre_exec' ? 'Preserve deterministic task flow before model execution.' : 'Block done closure when unresolved critical risk exists.',
  ];
  const references = isPlainObject(openedMeta?.references) ? openedMeta.references : {};
  const referenceSummary = {
    taskReferences: references,
    rootId: readStringField(openedMeta?.signals?.rootId) || null,
    parentId: readStringField(openedMeta?.signals?.parentId) || null,
    sourceKind: readStringField(openedMeta?.signals?.sourceKind) || null,
    from: readStringField(openedMeta?.from) || null,
  };
  const packetMeta = {
    id: readStringField(openedMeta?.id),
    from: readStringField(openedMeta?.from),
    to: normalizeToArray(openedMeta?.to).map((entry) => readStringField(entry)).filter(Boolean).slice(0, 8),
    priority: readStringField(openedMeta?.priority) || 'P2',
    title: readStringField(openedMeta?.title),
    kind: readStringField(taskKind).toUpperCase(),
    phase: readStringField(openedMeta?.signals?.phase) || null,
    notifyOrchestrator: Boolean(openedMeta?.signals?.notifyOrchestrator),
  };
  const lineage = {
    rootId: referenceSummary.rootId,
    parentId: referenceSummary.parentId,
    sourceKind: referenceSummary.sourceKind,
    from: referenceSummary.from,
  };
  const availableAgents = Array.isArray(roster?.agents)
    ? roster.agents.slice(0, 24).map((agent) => ({
        name: readStringField(agent?.name),
        role: readStringField(agent?.role),
        kind: readStringField(agent?.kind),
      })).filter((agent) => agent.name)
    : [];
  const workflowConstraints = [
    'dispatchAuthority=autopilot_only',
    'consultant_never_dispatches_agentbus_tasks',
    'protected_branch_actions_require_explicit_human_approval',
    'autopilot_makes_final_execution_decisions',
  ];
  const referencesSnapshot = {
    taskReferences: references,
    dispatchAuthority: 'autopilot_only',
    workflowConstraints,
    availableAgents,
    candidateOutput: isPlainObject(candidateOutput)
      ? {
          note: summarizeForOpus(candidateOutput?.note || '', 1200),
          outcome: readStringField(candidateOutput?.outcome) || null,
          followUpCount: Array.isArray(candidateOutput?.followUps) ? candidateOutput.followUps.length : 0,
        }
      : null,
  };
  return {
    version: 'v1',
    consultId,
    round,
    maxRounds,
    mode: phase,
    autopilotHypothesis: {
      summary: summarizeForOpus(candidateOutput?.note || openedMeta?.title || 'autopilot consult', 1200),
      intendedActions,
      proposedDispatches,
    },
    autopilotMessage: autopilotMessage ? summarizeForOpus(autopilotMessage, 3000) : null,
    taskContext: {
      taskId: readStringField(openedMeta?.id),
      taskKind: readStringField(taskKind).toUpperCase(),
      title: readStringField(openedMeta?.title),
      bodySummary: summarizeForOpus(taskMarkdown, 6000),
      rootId: readStringField(openedMeta?.signals?.rootId) || null,
      parentId: readStringField(openedMeta?.signals?.parentId) || null,
      sourceKind: readStringField(openedMeta?.signals?.sourceKind) || null,
      smoke: Boolean(openedMeta?.signals?.smoke),
      referencesSummary: summarizeForOpus(JSON.stringify(referenceSummary), 6000),
      packetMeta,
      lineage,
      references: referencesSnapshot,
    },
    priorRoundSummary: priorRoundSummary ? summarizeForOpus(priorRoundSummary, 4000) : null,
    questions: [],
  };
}

async function dispatchOpusConsultRequest({
  busRoot,
  agentName,
  openedMeta,
  consultAgent,
  phase,
  payload,
}) {
  const rootId = readStringField(openedMeta?.signals?.rootId) || readStringField(openedMeta?.id) || makeId('root');
  const parentId = readStringField(openedMeta?.id) || rootId;
  const title = `OPUS_CONSULT_REQUEST: ${readStringField(openedMeta?.title) || parentId} (${phase})`;
  const body =
    `Consult phase=${phase} round=${payload.round}/${payload.maxRounds}\n` +
    `consultId=${payload.consultId}\n` +
    `task=${readStringField(openedMeta?.id)}\n`;
  const id = makeId('msg');
  await deliverTask({
    busRoot,
    meta: {
      id,
      to: [consultAgent],
      from: agentName,
      priority: readStringField(openedMeta?.priority) || 'P2',
      title,
      signals: {
        kind: 'OPUS_CONSULT_REQUEST',
        phase,
        rootId,
        parentId,
        smoke: Boolean(openedMeta?.signals?.smoke),
        notifyOrchestrator: false,
      },
      references: {
        opus: payload,
        parentTaskId: parentId,
      },
    },
    body,
  });
  return id;
}

/**
 * Emits synthetic advisory OPUS_CONSULT_RESPONSE for fail-open consult mode.
 */
async function emitSyntheticOpusConsultResponse({
  busRoot,
  agentName,
  openedMeta,
  consultId,
  round,
  phase,
  parentTaskId = '',
  reasonCode,
  rationale,
  suggestedPlan = [],
}) {
  const rootId = readStringField(openedMeta?.signals?.rootId) || readStringField(openedMeta?.id) || makeId('root');
  const parentId = readStringField(parentTaskId) || readStringField(openedMeta?.id) || rootId;
  const responseTaskId = makeId('msg');
  const responsePayload = buildOpusAdvisoryFallbackPayload({
    consultId,
    round,
    reasonCode,
    rationale,
    suggestedPlan,
  });
  const responseRuntime = {
    synthetic: true,
    syntheticEmitter: agentName,
    syntheticReasonCode: normalizeOpusReasonCode(reasonCode, 'opus_transient'),
    protocolMode: 'freeform_only',
    source: 'autopilot_runtime_fallback',
  };
  await deliverTask({
    busRoot,
    meta: {
      id: responseTaskId,
      to: [agentName],
      from: agentName,
      priority: readStringField(openedMeta?.priority) || 'P2',
      title: `OPUS_CONSULT_RESPONSE (synthetic): ${readStringField(openedMeta?.title) || parentId}`,
      signals: {
        kind: 'OPUS_CONSULT_RESPONSE',
        phase,
        rootId,
        parentId,
        smoke: Boolean(openedMeta?.signals?.smoke),
        notifyOrchestrator: false,
      },
      references: {
        opus: responsePayload,
        opusRuntime: responseRuntime,
        consultRequestId: parentId,
      },
    },
    body:
      `Synthetic advisory OPUS_CONSULT_RESPONSE emitted by autopilot runtime.\n` +
      `consultId=${responsePayload.consultId}\n` +
      `round=${responsePayload.round}\n` +
      `reasonCode=${responsePayload.reasonCode}\n`,
  });
  return {
    responseTaskId,
    response: responsePayload,
    responseRuntime,
  };
}

async function waitForOpusConsultResponse({
  busRoot,
  roster,
  agentName,
  consultAgent,
  consultId,
  round,
  phase,
  timeoutMs,
  advisoryMode = false,
  pollMs = 200,
}) {
  const deadline = Date.now() + Math.max(1_000, Number(timeoutMs) || 3_600_000);
  while (Date.now() <= deadline) {
    for (const state of ['in_progress', 'new', 'seen']) {
      const items = await listInboxTasks({ busRoot, agentName, state, limit: 0 });
      for (const item of items) {
        const candidateMeta = item?.meta || {};
        if (normalizeTaskKind(candidateMeta?.signals?.kind) !== 'OPUS_CONSULT_RESPONSE') continue;
        const candidateFrom = readStringField(candidateMeta?.from);
        const candidateRuntime = isPlainObject(candidateMeta?.references?.opusRuntime)
          ? candidateMeta.references.opusRuntime
          : null;
        const candidateSyntheticAllowed = Boolean(
          candidateRuntime?.synthetic === true &&
          readStringField(candidateRuntime?.syntheticEmitter) === agentName &&
          candidateFrom === agentName,
        );
        if (consultAgent && candidateFrom !== consultAgent && !candidateSyntheticAllowed) continue;
        if (readStringField(candidateMeta?.signals?.phase) !== phase) continue;
        const candidatePayload = candidateMeta?.references?.opus;
        if (readStringField(candidatePayload?.consultId) !== consultId) continue;
        if (Number(candidatePayload?.round) !== Number(round)) continue;

        let opened = null;
        try {
          opened =
            state === 'in_progress'
              ? await openTask({ busRoot, agentName, taskId: item.taskId, markSeen: false })
              : await claimTask({ busRoot, agentName, taskId: item.taskId });
        } catch (err) {
          const code = readStringField(err?.code).toUpperCase();
          if (code === 'ENOENT') continue;
          throw new OpusConsultBlockedError('failed to open/claim OPUS_CONSULT_RESPONSE', {
            phase,
            reasonCode: 'opus_consult_response_read_failed',
            details: {
              taskId: item.taskId,
              state,
              error: (err && err.message) || String(err),
            },
          });
        }

        const validated = validateOpusConsultResponseMeta(opened.meta);
        const responseTaskId = readStringField(opened.meta?.id) || item.taskId;
        const responseRuntime = isPlainObject(opened.meta?.references?.opusRuntime)
          ? opened.meta.references.opusRuntime
          : null;
        const actualFrom = readStringField(opened.meta?.from);
        const isSyntheticResponse = responseRuntime?.synthetic === true;
        const syntheticEmitter = readStringField(responseRuntime?.syntheticEmitter);
        const syntheticSenderAllowed = Boolean(
          isSyntheticResponse &&
          syntheticEmitter === agentName &&
          actualFrom === agentName,
        );
        if (consultAgent && actualFrom !== consultAgent && !syntheticSenderAllowed) {
          await closeTask({
            busRoot,
            roster,
            agentName,
            taskId: responseTaskId,
            outcome: 'blocked',
            note: `invalid OPUS_CONSULT_RESPONSE ignored: sender mismatch (${readStringField(opened.meta?.from) || '(unknown)'})`,
            commitSha: '',
            receiptExtra: {
              reasonCode: 'opus_consult_response_sender_mismatch',
              expectedFrom: consultAgent,
              actualFrom: actualFrom || null,
            },
            notifyOrchestrator: false,
          });
          if (advisoryMode) {
            return {
              ok: false,
              reasonCode: 'opus_consult_response_sender_mismatch',
              response: null,
              responseRuntime,
              responseTaskId,
            };
          }
          continue;
        }
        if (!validated.ok || !validated.value?.payload) {
          await closeTask({
            busRoot,
            roster,
            agentName,
            taskId: responseTaskId,
            outcome: 'blocked',
            note: `invalid OPUS_CONSULT_RESPONSE ignored: ${validated.errors.join('; ')}`,
            commitSha: '',
            receiptExtra: {
              reasonCode: 'opus_consult_response_schema_invalid',
              errors: validated.errors,
            },
            notifyOrchestrator: false,
          });
          if (advisoryMode) {
            return {
              ok: false,
              reasonCode: 'opus_consult_response_schema_invalid',
              response: null,
              responseRuntime,
              responseTaskId,
            };
          }
          continue;
        }

        const signalsPhase = readStringField(validated.value.signals?.phase);
        const response = validated.value.payload;
        if (
          readStringField(response?.consultId) !== consultId ||
          Number(response?.round) !== Number(round) ||
          signalsPhase !== phase
        ) {
          await closeTask({
            busRoot,
            roster,
            agentName,
            taskId: responseTaskId,
            outcome: 'blocked',
            note: 'mismatched OPUS_CONSULT_RESPONSE ignored',
            commitSha: '',
            receiptExtra: {
              reasonCode: 'opus_consult_protocol_invalid',
            },
            notifyOrchestrator: false,
          });
          if (advisoryMode) {
            return {
              ok: false,
              reasonCode: 'opus_consult_protocol_invalid',
              response: null,
              responseRuntime,
              responseTaskId,
            };
          }
          continue;
        }

        const existingResolution = await readOpusConsultResolution({
          busRoot,
          consultId,
          phase,
          round,
        });
        if (existingResolution?.consumedResponseTaskId && existingResolution.consumedResponseTaskId !== responseTaskId) {
          const lateReasonCode =
            existingResolution.source === 'synthetic' && !isSyntheticResponse
              ? 'late_real_response_after_synthetic'
              : 'late_consult_response_superseded';
          await closeTask({
            busRoot,
            roster,
            agentName,
            taskId: responseTaskId,
            outcome: 'skipped',
            note: `late OPUS_CONSULT_RESPONSE ignored: ${lateReasonCode}`,
            commitSha: '',
            receiptExtra: {
              reasonCode: lateReasonCode,
              consultId,
              round,
              phase,
              canonicalResponseTaskId: existingResolution.consumedResponseTaskId,
              canonicalSource: existingResolution.source || null,
            },
            notifyOrchestrator: false,
          });
          continue;
        }

        const registered = await writeFirstOpusConsultResolution({
          busRoot,
          consultId,
          phase,
          round,
          responseTaskId,
          from: actualFrom,
          source: isSyntheticResponse ? 'synthetic' : 'real',
          verdict: response?.verdict,
          reasonCode: response?.reasonCode,
          synthetic: isSyntheticResponse,
          syntheticEmitter,
        });
        if (
          !registered.created &&
          registered.entry?.consumedResponseTaskId &&
          registered.entry.consumedResponseTaskId !== responseTaskId
        ) {
          const lateReasonCode =
            registered.entry.source === 'synthetic' && !isSyntheticResponse
              ? 'late_real_response_after_synthetic'
              : 'late_consult_response_superseded';
          await closeTask({
            busRoot,
            roster,
            agentName,
            taskId: responseTaskId,
            outcome: 'skipped',
            note: `late OPUS_CONSULT_RESPONSE ignored: ${lateReasonCode}`,
            commitSha: '',
            receiptExtra: {
              reasonCode: lateReasonCode,
              consultId,
              round,
              phase,
              canonicalResponseTaskId: registered.entry.consumedResponseTaskId,
              canonicalSource: registered.entry.source || null,
            },
            notifyOrchestrator: false,
          });
          continue;
        }

        await closeTask({
          busRoot,
          roster,
          agentName,
          taskId: responseTaskId,
          outcome: 'done',
          note: `accepted OPUS_CONSULT_RESPONSE consultId=${consultId} round=${round}`,
          commitSha: '',
          receiptExtra: {
            reasonCode: 'accepted_opus_consult_response',
            consultId,
            round,
            phase,
            syntheticResponseAccepted: isSyntheticResponse,
            syntheticEmitter: syntheticEmitter || null,
          },
          notifyOrchestrator: false,
        });
        return {
          ok: true,
          response,
          responseRuntime,
          responseTaskId,
          synthetic: isSyntheticResponse,
          resolution: registered.entry || null,
        };
      }
    }
    await sleep(Math.min(Math.max(50, pollMs), 1000));
  }
  return {
    ok: false,
    reasonCode: 'opus_consult_response_timeout',
    response: null,
    responseRuntime: null,
    responseTaskId: '',
  };
}

async function runOpusConsultPhase({
  busRoot,
  roster,
  agentName,
  openedMeta,
  taskMarkdown,
  taskKind,
  gate,
  phase,
  candidateOutput = null,
}) {
  const consultMode = readStringField(gate?.consultMode) || 'gate';
  const advisoryMode = consultMode === 'advisory';

  const emitAdvisoryFallback = async ({ consultId, round, parentTaskId, reasonCode, note }) => {
    const fallback = await emitSyntheticOpusConsultResponse({
      busRoot,
      agentName,
      openedMeta,
      consultId,
      round,
      phase,
      parentTaskId,
      reasonCode,
      rationale: note,
      suggestedPlan: [
        'Proceed with autopilot decision path while recording advisory fallback diagnostics.',
      ],
    });
    let waitedFallback = null;
    try {
      waitedFallback = await waitForOpusConsultResponse({
        busRoot,
        roster,
        agentName,
        consultAgent: gate?.consultAgent,
        consultId,
        round,
        phase,
        timeoutMs: 2_000,
        advisoryMode: true,
      });
    } catch {
      waitedFallback = null;
    }
    if (waitedFallback?.ok && waitedFallback?.response) {
      return {
        response: waitedFallback.response,
        responseRuntime: waitedFallback.responseRuntime || fallback.responseRuntime,
        responseTaskId: waitedFallback.responseTaskId || fallback.responseTaskId,
      };
    }
    return {
      response: fallback.response,
      responseRuntime: fallback.responseRuntime,
      responseTaskId: fallback.responseTaskId,
    };
  };

  if (!gate?.consultAgent || !gate?.consultAgentExists) {
    if (advisoryMode) {
      const consultId = makeId(`opus_${phase}`);
      const fallback = await emitAdvisoryFallback({
        consultId,
        round: 1,
        parentTaskId: readStringField(openedMeta?.id),
        reasonCode: 'opus_transient',
        note: `Opus consult agent not available: ${gate?.consultAgent || '(unset)'}`,
      });
      return {
        ok: false,
        reasonCode: 'opus_consult_dispatch_failed',
        note: `Opus consult agent not available: ${gate?.consultAgent || '(unset)'}`,
        phase,
        consultId,
        protocolMode: readStringField(gate?.protocolMode) || 'freeform_only',
        roundsUsed: 1,
        rounds: [{
          round: 1,
          requestTaskId: '',
          responseTaskId: fallback.responseTaskId,
          response: fallback.response,
          responseRuntime: fallback.responseRuntime || null,
        }],
        finalResponse: fallback.response,
        finalResponseRuntime: fallback.responseRuntime || null,
        finalResponseTaskId: fallback.responseTaskId,
        decision: {
          acceptedSuggestions: Array.isArray(fallback.response?.suggested_plan)
            ? fallback.response.suggested_plan.filter(Boolean).slice(0, 24)
            : [],
          rejectedSuggestions: [],
          rejectionRationale: '',
        },
      };
    }
    return {
      ok: false,
      reasonCode: 'opus_consult_dispatch_failed',
      note: `Opus consult agent not available: ${gate?.consultAgent || '(unset)'}`,
      phase,
      consultId: '',
      protocolMode: readStringField(gate?.protocolMode) || 'freeform_only',
      roundsUsed: 0,
      rounds: [],
      finalResponse: null,
      finalResponseRuntime: null,
      finalResponseTaskId: '',
      decision: {
        acceptedSuggestions: [],
        rejectedSuggestions: [],
        rejectionRationale: '',
      },
    };
  }

  const maxRounds = Math.max(1, Number(gate.maxRounds) || 1);
  const consultId = makeId(`opus_${phase}`);
  const protocolMode = readStringField(gate?.protocolMode) || 'freeform_only';
  /** @type {any[]} */
  const rounds = [];
  let priorRoundSummary = null;
  let autopilotMessage = null;

  for (let round = 1; round <= maxRounds; round += 1) {
    const payload = buildOpusConsultRequestPayload({
      openedMeta,
      taskMarkdown,
      taskKind,
      roster,
      consultId,
      round,
      maxRounds,
      phase,
      priorRoundSummary,
      autopilotMessage,
      candidateOutput,
    });
    let requestTaskId = '';
    try {
      requestTaskId = await dispatchOpusConsultRequest({
        busRoot,
        agentName,
        openedMeta,
        consultAgent: gate.consultAgent,
        phase,
        payload,
      });
    } catch (err) {
      if (!advisoryMode) {
        return {
          ok: false,
          reasonCode: 'opus_consult_dispatch_failed',
          note: `Opus consult request dispatch failed: ${(err && err.message) || String(err)}`,
          phase,
          consultId,
          protocolMode,
          roundsUsed: round,
          rounds,
          finalResponse: null,
          finalResponseRuntime: null,
          finalResponseTaskId: '',
          decision: {
            acceptedSuggestions: [],
            rejectedSuggestions: [],
            rejectionRationale: '',
          },
        };
      }
      const fallback = await emitAdvisoryFallback({
        consultId,
        round,
        parentTaskId: readStringField(openedMeta?.id),
        reasonCode: 'opus_transient',
        note: `Opus consult request dispatch failed: ${(err && err.message) || String(err)}`,
      });
      rounds.push({
        round,
        requestTaskId: '',
        responseTaskId: fallback.responseTaskId,
        response: fallback.response,
        responseRuntime: fallback.responseRuntime || null,
      });
      return {
        ok: false,
        reasonCode: 'opus_consult_dispatch_failed',
        note: `Opus consult request dispatch failed: ${(err && err.message) || String(err)}`,
        phase,
        consultId,
        protocolMode,
        roundsUsed: round,
        rounds,
        finalResponse: fallback.response,
        finalResponseRuntime: fallback.responseRuntime || null,
        finalResponseTaskId: fallback.responseTaskId,
        decision: {
          acceptedSuggestions: Array.isArray(fallback.response?.suggested_plan)
            ? fallback.response.suggested_plan.filter(Boolean).slice(0, 24)
            : [],
          rejectedSuggestions: [],
          rejectionRationale: '',
        },
      };
    }

    let waited = null;
    try {
      waited = await waitForOpusConsultResponse({
        busRoot,
        roster,
        agentName,
        consultAgent: gate.consultAgent,
        consultId,
        round,
        phase,
        timeoutMs: gate.gateTimeoutMs,
        advisoryMode,
      });
    } catch (err) {
      if (!advisoryMode) throw err;
      waited = {
        ok: false,
        reasonCode: readStringField(err?.reasonCode) || 'opus_consult_response_read_failed',
        response: null,
        responseRuntime: null,
        responseTaskId: '',
      };
    }

    if (!waited.ok || !waited.response) {
      if (advisoryMode) {
        const fallback = await emitAdvisoryFallback({
          consultId,
          round,
          parentTaskId: requestTaskId,
          reasonCode: waited.reasonCode || 'opus_timeout',
          note: `Opus consult fallback: phase=${phase} round=${round} reason=${waited.reasonCode || 'opus_consult_response_timeout'}`,
        });
        waited = {
          ok: true,
          reasonCode: '',
          response: fallback.response,
          responseRuntime: fallback.responseRuntime,
          responseTaskId: fallback.responseTaskId,
          synthetic: true,
        };
      }
    }

    if (!waited?.ok || !waited?.response) {
      return {
        ok: false,
        reasonCode: waited.reasonCode || 'opus_consult_response_timeout',
        note: `Opus consult response timeout for phase=${phase} round=${round}`,
        phase,
        consultId,
        protocolMode,
        roundsUsed: round,
        rounds,
        finalResponse: null,
        finalResponseRuntime: null,
        finalResponseTaskId: '',
        decision: {
          acceptedSuggestions: [],
          rejectedSuggestions: [],
          rejectionRationale: '',
        },
      };
    }

    const response = waited.response;
    rounds.push({
      round,
      requestTaskId,
      responseTaskId: waited.responseTaskId,
      response,
      responseRuntime: waited.responseRuntime || null,
    });

    const verdict = readStringField(response?.verdict);
    const reasonCode = readStringField(response?.reasonCode);
    const unresolved = Array.isArray(response?.unresolved_critical_questions)
      ? response.unresolved_critical_questions.filter(Boolean)
      : [];
    const requiredQuestions = Array.isArray(response?.required_questions)
      ? response.required_questions.filter(Boolean)
      : [];
    const needsAnotherRound = shouldContinueOpusConsultRound(response);

    if (verdict === 'block') {
      return {
        ok: false,
        reasonCode: phase === 'post_review' ? 'opus_post_review_block' : 'opus_consult_block',
        note: `Opus ${phase} consult blocked: ${readStringField(response?.reasonCode) || 'block'}`,
        phase,
        consultId,
        protocolMode,
        roundsUsed: round,
        rounds,
        finalResponse: response,
        finalResponseRuntime: waited.responseRuntime || null,
        finalResponseTaskId: readStringField(waited.responseTaskId),
        decision: {
          acceptedSuggestions: [],
          rejectedSuggestions: [],
          rejectionRationale: '',
        },
      };
    }

    if (verdict === 'warn' && gate.warnRequiresAck) {
      return {
        ok: false,
        reasonCode: 'opus_warn_requires_ack',
        note: `Opus ${phase} consult warn requires acknowledgement`,
        phase,
        consultId,
        protocolMode,
        roundsUsed: round,
        rounds,
        finalResponse: response,
        finalResponseRuntime: waited.responseRuntime || null,
        finalResponseTaskId: readStringField(waited.responseTaskId),
        decision: {
          acceptedSuggestions: [],
          rejectedSuggestions: [],
          rejectionRationale: '',
        },
      };
    }

    if (reasonCode === 'opus_human_input_required') {
      return {
        ok: false,
        reasonCode: 'opus_human_input_required',
        note: `Opus ${phase} consult requires human input: ${requiredQuestions.join(' | ') || 'questions required'}`,
        phase,
        consultId,
        protocolMode,
        roundsUsed: round,
        rounds,
        finalResponse: response,
        finalResponseRuntime: waited.responseRuntime || null,
        finalResponseTaskId: readStringField(waited.responseTaskId),
        decision: {
          acceptedSuggestions: [],
          rejectedSuggestions: [],
          rejectionRationale: '',
        },
      };
    }

    if (!needsAnotherRound) {
      const acceptedSuggestions = Array.isArray(response?.suggested_plan)
        ? response.suggested_plan.filter(Boolean).slice(0, 24)
        : [];
      const rejectedSuggestions = [];
      const rejectionRationale = '';
      return {
        ok: true,
        reasonCode: '',
        note: '',
        phase,
        consultId,
        protocolMode,
        roundsUsed: round,
        rounds,
        finalResponse: response,
        finalResponseRuntime: waited.responseRuntime || null,
        finalResponseTaskId: readStringField(waited.responseTaskId),
        decision: {
          acceptedSuggestions,
          rejectedSuggestions,
          rejectionRationale,
        },
      };
    }

    if (round >= maxRounds) {
      return {
        ok: false,
        reasonCode: 'opus_max_turns',
        note: `Opus ${phase} consult exhausted max rounds (${maxRounds})`,
        phase,
        consultId,
        protocolMode,
        roundsUsed: round,
        rounds,
        finalResponse: response,
        finalResponseRuntime: waited.responseRuntime || null,
        finalResponseTaskId: readStringField(waited.responseTaskId),
        decision: {
          acceptedSuggestions: [],
          rejectedSuggestions: [],
          rejectionRationale: '',
        },
      };
    }

    priorRoundSummary = summarizeForOpus(
      `verdict=${verdict}; reasonCode=${reasonCode}; rationale=${readStringField(response?.rationale)}`,
      3000,
    );
    autopilotMessage = summarizeForOpus(
      `Need clarification on: ${requiredQuestions.join(' | ') || unresolved.join(' | ') || 'unspecified'}`,
      3000,
    );
  }

  return {
    ok: false,
    reasonCode: 'opus_consult_not_finalized',
    note: `Opus ${phase} consult not finalized`,
    phase,
    consultId,
    protocolMode,
    roundsUsed: maxRounds,
    rounds,
    finalResponse: null,
    finalResponseRuntime: null,
    finalResponseTaskId: '',
    decision: {
      acceptedSuggestions: [],
      rejectedSuggestions: [],
      rejectionRationale: '',
    },
  };
}

/**
 * Verifies that no sibling observer review-fix digests remain queued for the same root.
 */
async function validateObserverDrainGate({ observerDrainGate, busRoot, agentName, taskId }) {
  const evidence = {
    required: Boolean(observerDrainGate?.required),
    enabled: Boolean(observerDrainGate?.enabled),
    rootId: readStringField(observerDrainGate?.rootId),
    sourceKind: readStringField(observerDrainGate?.sourceKind),
    taskKind: readStringField(observerDrainGate?.taskKind),
    pendingCount: 0,
    pendingTaskIds: [],
  };
  if (!observerDrainGate?.required) {
    return { ok: true, errors: [], evidence };
  }

  const rootId = evidence.rootId;
  if (!rootId) {
    return {
      ok: false,
      errors: ['observer drain gate missing rootId'],
      evidence,
    };
  }

  const pending = [];
  for (const state of ['in_progress', 'new', 'seen']) {
    const ids = await listInboxTaskIds({ busRoot, agentName, state });
    for (const itemIdRaw of ids) {
      const itemId = readStringField(itemIdRaw);
      if (!itemId || itemId === taskId) continue;
      let opened = null;
      try {
        opened = await openTask({ busRoot, agentName, taskId: itemId, markSeen: false });
      } catch {
        continue;
      }
      const meta = opened?.meta ?? {};
      const itemKind = readStringField(meta?.signals?.kind).toUpperCase();
      const itemSourceKind = readStringField(meta?.signals?.sourceKind).toUpperCase();
      const itemRootId = readStringField(meta?.signals?.rootId);
      if (itemKind !== 'ORCHESTRATOR_UPDATE') continue;
      if (itemSourceKind !== 'REVIEW_ACTION_REQUIRED') continue;
      if (itemRootId !== rootId) continue;
      pending.push(itemId);
    }
  }

  evidence.pendingTaskIds = pending.slice(0, 50);
  evidence.pendingCount = pending.length;
  if (pending.length === 0) return { ok: true, errors: [], evidence };
  return {
    ok: false,
    errors: [
      `observer drain gate failed: pending review-fix digests remain for root ${rootId} (${pending.length})`,
    ],
    evidence,
  };
}

/**
 * Builds review gate prompt block used by workflow automation.
 */
function buildReviewGatePromptBlock({ reviewGate, reviewRetryReason = '' }) {
  if (!reviewGate?.required) return '';
  const scopeLine = reviewGate?.scope ? `- Review scope: ${reviewGate.scope}\n` : '';
  const commitShas = Array.isArray(reviewGate?.targetCommitShas)
    ? reviewGate.targetCommitShas.map((s) => readStringField(s)).filter(Boolean)
    : [];
  const commitLine = reviewGate.targetCommitSha
    ? `- Review target commit: ${reviewGate.targetCommitSha}\n`
    : '';
  const commitScopeLine =
    commitShas.length > 1 ? `- Review scope commits (${commitShas.length}): ${commitShas.join(', ')}\n` : '';
  const receiptLine = reviewGate.receiptPath
    ? `- Receipt path: ${reviewGate.receiptPath}\n`
    : '';
  const taskLine = reviewGate.sourceTaskId
    ? `- Source task id: ${reviewGate.sourceTaskId}\n`
    : '';
  const agentLine = reviewGate.sourceAgent
    ? `- Source agent: ${reviewGate.sourceAgent}\n`
    : '';
  const retryLine = reviewRetryReason
    ? `\nRETRY REQUIREMENT:\nYour previous output failed review-gate validation: ${reviewRetryReason}\nFix it now.\n`
    : '';
  return (
    `MANDATORY REVIEW GATE:\n` +
    `Built-in review evidence is mandatory before deciding closure.\n` +
    `When running on app-server, runtime executes review/start before this turn; use those findings.\n` +
    `Do NOT run nested Codex CLI commands (\`codex review\`, \`codex exec\`, \`codex app-server\`) from shell.\n` +
    `${scopeLine}` +
    `${commitLine}` +
    `${commitScopeLine}` +
    `${receiptLine}` +
    `${taskLine}` +
    `${agentLine}` +
    `Required output contract:\n` +
    `- Set review.ran=true and review.method="built_in_review".\n` +
    `- Set review.scope to "commit" for task-completion reviews, or "pr" for explicit PR reviews.\n` +
    `- Set review.reviewedCommits to the exact commit(s) reviewed.\n` +
    `- Set review.verdict to "pass" or "changes_requested".\n` +
    `- Include findings summary with severity + file references.\n` +
    `- If verdict is "changes_requested", dispatch corrective followUps.\n` +
    `- Include review.evidence.artifactPath and sectionsPresent containing findings,severity,file_refs,actions.\n` +
    `${retryLine}\n`
  );
}

/**
 * Builds stable review gate key for runtime dedupe.
 */
function reviewGatePrimeKey(reviewGate) {
  if (!reviewGate?.required) return '__none__';
  const commits = Array.isArray(reviewGate?.targetCommitShas)
    ? reviewGate.targetCommitShas.map((s) => readStringField(s)).filter(Boolean)
    : [];
  if (commits.length) return commits.join(',');
  return reviewGate?.targetCommitSha || '__required__';
}

/**
 * Builds skill ops gate prompt block used by workflow automation.
 */
function buildSkillOpsGatePromptBlock({ skillOpsGate }) {
  if (!skillOpsGate?.required) return '';
  return (
    `MANDATORY SKILLOPS GATE:\n` +
    `Before returning outcome="done", run and report all SkillOps commands:\n` +
    `- node scripts/skillops.mjs debrief --skills <skill-a,skill-b> --title "..." \n` +
    `- node scripts/skillops.mjs distill\n` +
    `- node scripts/skillops.mjs lint\n` +
    `Required output evidence:\n` +
    `- testsToRun must include those commands.\n` +
    `- artifacts must include the debrief markdown path under .codex/skill-ops/logs/.\n\n`
  );
}

/**
 * Builds code quality gate prompt block used by workflow automation.
 */
function buildCodeQualityGatePromptBlock({
  codeQualityGate,
  cockpitRoot,
  codeQualityRetryReasonCode = '',
  codeQualityRetryReason = '',
}) {
  if (!codeQualityGate?.required) return '';
  const gateScriptPath = path.join(cockpitRoot || getCockpitRoot(), 'scripts', 'code-quality-gate.mjs');
  const codeQualityCommand = `node "${gateScriptPath}" check --task-kind ${codeQualityGate.taskKind || 'TASK'}`;
  const retryLine = codeQualityRetryReasonCode
    ? `\nRETRY REQUIREMENT:\n` +
      `Your previous output failed runtime code-quality validation.\n` +
      `reasonCode=${codeQualityRetryReasonCode}\n` +
      `detail=${codeQualityRetryReason || 'unspecified'}\n` +
      `Fix the issue and return corrected output.\n`
    : '';
  return (
    `MANDATORY CODE QUALITY GATE:\n` +
    `Before returning outcome="done", run:\n` +
    `- ${codeQualityCommand}\n` +
    `Then include explicit quality activation evidence in output. Set qualityReview with:\n` +
    `- summary (single-line),\n` +
    `- legacyDebtWarnings (integer),\n` +
    `- hardRuleChecks.{codeVolume,noDuplication,shortestPath,cleanup,anticipateConsequences,simplicity} (single-line notes).\n` +
    `Runtime enforcement is authoritative: script pass alone is not enough; missing qualityReview evidence rejects outcome="done".\n` +
    `${retryLine}\n`
  );
}

/**
 * Builds observer drain gate prompt block.
 */
function buildObserverDrainGatePromptBlock({ observerDrainGate }) {
  if (!observerDrainGate?.required) return '';
  return (
    `MANDATORY OBSERVER DRAIN GATE:\n` +
    `Before returning outcome="done" for this review-fix digest, ensure no sibling REVIEW_ACTION_REQUIRED digests remain for the same rootId.\n` +
    `If siblings remain queued/in_progress, dispatch needed followUps and return outcome="blocked" until queue is drained.\n\n`
  );
}

/**
 * Builds Opus consult advisory prompt block.
 */
function buildOpusConsultPromptBlock({ isAutopilot, consultDispositionRetryReason = '' }) {
  if (!isAutopilot) return '';
  const retryLine = consultDispositionRetryReason
    ? `\nRETRY REQUIREMENT:\n` +
      `Your previous output did not acknowledge all required Opus advisory items.\n` +
      `Fix now: ${consultDispositionRetryReason}\n`
    : '';
  return (
    `OPUS ADVISORY HANDLING:\n` +
    `- When context includes "Opus consult advisory (focusRootId)", acknowledge each OPUS-* item.\n` +
    `- You may act, defer, or skip each item, but never ignore suggestions silently.\n` +
    `- Record dispositions in note using this exact grammar:\n` +
    `  OPUS_DISPOSITIONS:\n` +
    `  OPUS-1|acted|<percent-encoded action>|<percent-encoded reason>\n` +
    `  OPUS-2|deferred|<percent-encoded action>|<percent-encoded reason>\n` +
    `- Encode delimiter/newline safely with percent-encoding (e.g. %7C, %0A).\n` +
    `- Opus advice is advisory; autopilot remains decision authority.\n` +
    `${retryLine}\n`
  );
}

/**
 * Returns whether nested codex cli usage.
 */
function hasNestedCodexCliUsage(value) {
  return /\bcodex\s+(review|exec|app-server|resume)\b/i.test(String(value ?? ''));
}

/**
 * Helper for validate autopilot review output used by the cockpit workflow runtime.
 */
function validateAutopilotReviewOutput({ parsed, reviewGate, busRoot, agentName, taskId }) {
  if (!reviewGate?.required) return { ok: true, errors: [] };

  const errors = [];
  const review = parsed?.review && typeof parsed.review === 'object' ? parsed.review : null;
  if (!review) {
    errors.push('missing review object');
    return { ok: false, errors };
  }

  if (review.ran !== true) errors.push('review.ran must be true');
  if (readStringField(review.method) !== 'built_in_review') {
    errors.push('review.method must be "built_in_review"');
  }

  const targetCommitSha = readStringField(review.targetCommitSha);
  if (reviewGate.targetCommitSha && targetCommitSha !== reviewGate.targetCommitSha) {
    errors.push(`review.targetCommitSha must match ${reviewGate.targetCommitSha}`);
  }
  const scope = readStringField(review.scope) || readStringField(reviewGate.scope) || 'commit';
  if (scope !== 'commit' && scope !== 'pr') {
    errors.push('review.scope must be "commit" or "pr"');
  }
  if (reviewGate.scope && scope !== reviewGate.scope) {
    errors.push(`review.scope must match ${reviewGate.scope}`);
  }
  const reviewedCommitsRaw = Array.isArray(review.reviewedCommits) ? review.reviewedCommits : [];
  const reviewedCommits = normalizeCommitShaList([
    ...reviewedCommitsRaw,
    targetCommitSha,
  ]);
  if (scope === 'commit' && reviewGate.targetCommitSha && !reviewedCommits.includes(reviewGate.targetCommitSha)) {
    errors.push(`review.reviewedCommits must include ${reviewGate.targetCommitSha}`);
  }
  if (scope === 'pr') {
    const expectedCommits = normalizeCommitShaList(Array.isArray(reviewGate.targetCommitShas) ? reviewGate.targetCommitShas : []);
    if (expectedCommits.length === 0) {
      errors.push('review.scope=pr requires non-empty reviewGate.targetCommitShas');
    } else {
      for (const sha of expectedCommits) {
        if (!reviewedCommits.includes(sha)) {
          errors.push(`review.reviewedCommits missing ${sha}`);
        }
      }
    }
  }
  review.scope = scope;
  review.reviewedCommits = reviewedCommits;

  const summary = readStringField(review.summary);
  if (!summary) errors.push('review.summary is required');

  const findingsCount = Number(review.findingsCount);
  if (!Number.isInteger(findingsCount) || findingsCount < 0) {
    errors.push('review.findingsCount must be a non-negative integer');
  }

  const verdict = readStringField(review.verdict);
  if (verdict !== 'pass' && verdict !== 'changes_requested') {
    errors.push('review.verdict must be "pass" or "changes_requested"');
  }

  const evidence = review?.evidence && typeof review.evidence === 'object' ? review.evidence : null;
  if (!evidence) {
    errors.push('review.evidence is required');
  } else {
    const artifactPath = readStringField(evidence.artifactPath);
    if (!artifactPath) errors.push('review.evidence.artifactPath is required');
    if (artifactPath) {
      try {
        const resolved = resolveReviewArtifactPath({
          busRoot,
          requestedPath: artifactPath,
          agentName,
          taskId,
        });
        // Normalize so downstream artifact materialization uses the same validated path.
        evidence.artifactPath = resolved.relativePath;
      } catch (err) {
        errors.push((err && err.message) || 'review.evidence.artifactPath is invalid');
      }
    }

    const sections = Array.isArray(evidence.sectionsPresent)
      ? evidence.sectionsPresent.map((s) => readStringField(s)).filter(Boolean)
      : [];
    const sectionSet = new Set(sections);
    for (const requiredSection of ['findings', 'severity', 'file_refs', 'actions']) {
      if (!sectionSet.has(requiredSection)) {
        errors.push(`review.evidence.sectionsPresent missing "${requiredSection}"`);
      }
    }
  }

  const followUps = Array.isArray(parsed?.followUps) ? parsed.followUps : [];
  if (verdict === 'changes_requested' && followUps.length === 0) {
    errors.push('changes_requested requires at least one corrective followUp');
  }

  const candidateText = [
    readStringField(parsed?.note),
    Array.isArray(parsed?.testsToRun)
      ? parsed.testsToRun
          .map((entry) => {
            if (typeof entry === 'string') return entry;
            if (entry && typeof entry === 'object') return String(entry.command || '');
            return '';
          })
          .join('\n')
      : '',
  ].join('\n');
  if (hasNestedCodexCliUsage(candidateText)) {
    errors.push('review-gated tasks must not run nested codex CLI commands; use built-in /review');
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Normalizes tests to run commands for downstream use.
 */
function normalizeTestsToRunCommands(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      if (entry && typeof entry === 'object') return readStringField(entry.command) || '';
      return '';
    })
    .map((s) => String(s || '').trim())
    .filter(Boolean);
}

/**
 * Normalizes artifact paths for downstream use.
 */
function normalizeArtifactPaths(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => readStringField(entry)).filter(Boolean);
}

/**
 * Returns whether skill ops log path.
 */
function isSkillOpsLogPath(value) {
  const normalized = String(value || '').trim().replace(/\\/g, '/');
  if (!normalized) return false;
  if (normalized.includes('/.codex/skill-ops/logs/')) return true;
  if (normalized.startsWith('.codex/skill-ops/logs/')) return true;
  return false;
}

/**
 * Returns whether resolve artifact path.
 */
async function canResolveArtifactPath({ cwd, artifactPath }) {
  const raw = String(artifactPath || '').trim();
  if (!raw) return false;
  const abs = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
  try {
    const st = await fs.stat(abs);
    return st.isFile();
  } catch {
    return false;
  }
}

/**
 * Helper for validate autopilot skill ops evidence used by the cockpit workflow runtime.
 */
async function validateAutopilotSkillOpsEvidence({ parsed, skillOpsGate, taskCwd }) {
  const evidence = {
    required: Boolean(skillOpsGate?.required),
    taskKind: readStringField(skillOpsGate?.taskKind) || '',
    requiredKinds: Array.isArray(skillOpsGate?.requiredKinds) ? skillOpsGate.requiredKinds : [],
    commandChecks: {
      debrief: false,
      distill: false,
      lint: false,
    },
    logArtifactPath: null,
    logArtifactExists: false,
  };
  if (!skillOpsGate?.required) return { ok: true, errors: [], evidence };

  const errors = [];
  const commands = normalizeTestsToRunCommands(parsed?.testsToRun);
  const hasDebrief = commands.some((c) => /\bscripts\/skillops\.mjs\s+debrief\b/i.test(c));
  const hasDistill = commands.some((c) => /\bscripts\/skillops\.mjs\s+distill\b/i.test(c));
  const hasLint = commands.some((c) => /\bscripts\/skillops\.mjs\s+lint\b/i.test(c));
  evidence.commandChecks = {
    debrief: hasDebrief,
    distill: hasDistill,
    lint: hasLint,
  };
  if (!hasDebrief) errors.push('testsToRun missing `scripts/skillops.mjs debrief`');
  if (!hasDistill) errors.push('testsToRun missing `scripts/skillops.mjs distill`');
  if (!hasLint) errors.push('testsToRun missing `scripts/skillops.mjs lint`');

  const artifacts = normalizeArtifactPaths(parsed?.artifacts);
  const logArtifacts = artifacts.filter((a) => isSkillOpsLogPath(a));
  if (logArtifacts.length === 0) {
    errors.push('artifacts missing .codex/skill-ops/logs/* debrief evidence');
  } else {
    evidence.logArtifactPath = logArtifacts[0];
    for (const artifactPath of logArtifacts) {
      if (await canResolveArtifactPath({ cwd: taskCwd, artifactPath })) {
        evidence.logArtifactPath = artifactPath;
        evidence.logArtifactExists = true;
        break;
      }
    }
    if (!evidence.logArtifactExists) {
      errors.push('SkillOps debrief artifact path does not exist on disk');
    }
  }

  return { ok: errors.length === 0, errors, evidence };
}

/**
 * Runs the code quality gate script directly and returns normalized status/evidence.
 */
async function runCodeQualityGateCheck({
  codeQualityGate,
  taskCwd,
  cockpitRoot,
  baseRef = '',
  taskStartHead = '',
  expectedSourceChanges = false,
  scopeIncludeRules = [],
  scopeExcludeRules = [],
  retryCount = 0,
}) {
  const evidence = {
    required: Boolean(codeQualityGate?.required),
    taskKind: readStringField(codeQualityGate?.taskKind) || '',
    requiredKinds: Array.isArray(codeQualityGate?.requiredKinds) ? codeQualityGate.requiredKinds : [],
    command: '',
    executed: false,
    exitCode: null,
    artifactPath: null,
    warningCount: 0,
    scopeMode: 'invalid',
    baseRefUsed: '',
    taskStartHead: readStringField(taskStartHead),
    changedScopeReturned: '',
    changedFilesSample: [],
    sourceFilesSeenCount: 0,
    artifactOnlyChange: false,
    retryCount: Math.max(0, Number(retryCount) || 0),
    scopeIncludeRules: Array.isArray(scopeIncludeRules) ? scopeIncludeRules : [],
    scopeExcludeRules: Array.isArray(scopeExcludeRules) ? scopeExcludeRules : [],
    hardRules: {
      codeVolume: false,
      noDuplication: false,
      shortestPath: false,
      cleanup: false,
      anticipateConsequences: false,
      simplicity: false,
    },
  };
  if (!codeQualityGate?.required) return { ok: true, errors: [], evidence };

  const scriptPath = path.join(cockpitRoot, 'scripts', 'code-quality-gate.mjs');
  const resolvedBaseRef = readStringField(baseRef) || readStringField(taskStartHead);
  evidence.baseRefUsed = resolvedBaseRef;
  evidence.command =
    `node "${scriptPath}" check --task-kind ${evidence.taskKind || 'TASK'}` +
    (resolvedBaseRef ? ` --base-ref ${resolvedBaseRef}` : '');

  const args = [scriptPath, 'check', '--task-kind', evidence.taskKind || 'TASK'];
  if (resolvedBaseRef) args.push('--base-ref', resolvedBaseRef);
  let stdout = '';
  let stderr = '';
  let exitCode = 0;
  const timeoutRaw =
    process.env.AGENTIC_CODE_QUALITY_GATE_TIMEOUT_MS ?? process.env.VALUA_CODE_QUALITY_GATE_TIMEOUT_MS ?? '90000';
  const timeoutMs = Math.max(1_000, Number(timeoutRaw) || 90_000);
  let timedOut = false;
  try {
    stdout = childProcess.execFileSync('node', args, {
      cwd: taskCwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });
  } catch (err) {
    timedOut = err?.code === 'ETIMEDOUT';
    exitCode = Number(err?.status ?? 1) || 1;
    stdout = String(err?.stdout || '');
    stderr = String(err?.stderr || '');
  }

  let parsed = null;
  {
    const lines = String(stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const candidate = lines.length > 0 ? lines[lines.length - 1] : '';
    if (candidate) {
      try {
        parsed = JSON.parse(candidate);
      } catch {
        parsed = null;
      }
    }
  }
  const parsedErrors = Array.isArray(parsed?.errors)
    ? parsed.errors.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  const parsedWarnings = Array.isArray(parsed?.warnings)
    ? parsed.warnings.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  const parsedChangedScope = readStringField(parsed?.changedScope);
  const parsedChangedFilesSample = Array.isArray(parsed?.changedFilesSample)
    ? parsed.changedFilesSample.map((value) => readStringField(value)).filter(Boolean).slice(0, 20)
    : [];
  const parsedSourceFilesCount = Number(parsed?.sourceFilesCount ?? parsed?.sourceFilesSeenCount);
  const parsedArtifactOnlyChange = parsed?.artifactOnlyChange === true;
  const parsedScopeMode = parsedChangedScope.startsWith('commit-range:')
    ? 'commit_range'
    : parsedChangedScope === 'working-tree'
      ? expectedSourceChanges
        ? 'invalid'
        : 'no_code_change'
      : 'invalid';
  evidence.scopeMode = parsedScopeMode;
  evidence.changedScopeReturned = parsedChangedScope;
  evidence.changedFilesSample = parsedChangedFilesSample;
  evidence.sourceFilesSeenCount = Number.isFinite(parsedSourceFilesCount) ? Math.max(0, Math.floor(parsedSourceFilesCount)) : 0;
  evidence.artifactOnlyChange = parsedArtifactOnlyChange;

  const parsedHardRules = parsed?.hardRules && typeof parsed.hardRules === 'object' ? parsed.hardRules : null;
  for (const key of CODE_QUALITY_HARD_RULE_KEYS) {
    evidence.hardRules[key] = parsedHardRules?.[key]?.passed === true;
  }
  const errors = [];
  if (exitCode !== 0) {
    if (parsedErrors.length > 0) {
      errors.push(...parsedErrors);
    } else if (timedOut) {
      errors.push(`code quality gate timed out after ${timeoutMs}ms`);
    } else {
      const stderrTail = String(stderr || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(-1)[0];
      errors.push(
        stderrTail
          ? `code quality gate exited with status ${exitCode}: ${stderrTail}`
          : `code quality gate exited with status ${exitCode}`,
      );
    }
  }

  if (expectedSourceChanges && !resolvedBaseRef) {
    errors.push('missing_base_ref');
  }
  if (expectedSourceChanges && resolvedBaseRef && parsedScopeMode === 'invalid') {
    errors.push('scope_invalid');
  } else if (expectedSourceChanges && resolvedBaseRef && parsedScopeMode !== 'commit_range') {
    errors.push('scope_mismatch');
  }
  if (expectedSourceChanges && parsedArtifactOnlyChange) {
    errors.push('artifact_only_mismatch');
  }
  if (exitCode === 0) {
    if (!parsedHardRules) {
      errors.push('code quality gate missing hardRules evidence');
    } else {
      for (const key of CODE_QUALITY_HARD_RULE_KEYS) {
        if (parsedHardRules?.[key]?.passed !== true) {
          errors.push(`hard rule not satisfied: ${key}`);
        }
      }
    }
  }

  return {
    ok: exitCode === 0 && errors.length === 0,
    errors,
    evidence: {
      ...evidence,
      executed: true,
      exitCode,
      artifactPath: readStringField(parsed?.artifactPath) || null,
      warningCount: parsedWarnings.length,
    },
  };
}

const CODE_QUALITY_HARD_RULE_KEYS = [
  'codeVolume',
  'noDuplication',
  'shortestPath',
  'cleanup',
  'anticipateConsequences',
  'simplicity',
];

/**
 * Validates explicit quality skill activation evidence from model output.
 */
function validateCodeQualityReviewEvidence({ parsed, codeQualityGate }) {
  const evidence = {
    required: Boolean(codeQualityGate?.required),
    present: false,
    summary: '',
    legacyDebtWarnings: null,
    hardRuleChecks: Object.fromEntries(CODE_QUALITY_HARD_RULE_KEYS.map((key) => [key, false])),
  };
  if (!codeQualityGate?.required) return { ok: true, errors: [], evidence };

  const errors = [];
  const qualityReview = parsed?.qualityReview && typeof parsed.qualityReview === 'object' ? parsed.qualityReview : null;
  evidence.present = Boolean(qualityReview);
  if (!qualityReview) {
    errors.push('qualityReview evidence is required');
    return { ok: false, errors, evidence };
  }

  const summary = readStringField(qualityReview.summary);
  evidence.summary = summary;
  if (!summary) {
    errors.push('qualityReview.summary is required');
  } else if (/[\r\n]/.test(summary)) {
    errors.push('qualityReview.summary must be single-line');
  }

  const legacyDebtWarnings = Number(qualityReview.legacyDebtWarnings);
  if (!Number.isInteger(legacyDebtWarnings) || legacyDebtWarnings < 0) {
    errors.push('qualityReview.legacyDebtWarnings must be a non-negative integer');
  } else {
    evidence.legacyDebtWarnings = legacyDebtWarnings;
  }

  const hardRuleChecks =
    qualityReview.hardRuleChecks && typeof qualityReview.hardRuleChecks === 'object'
      ? qualityReview.hardRuleChecks
      : null;
  if (!hardRuleChecks) {
    errors.push('qualityReview.hardRuleChecks is required');
    return { ok: false, errors, evidence };
  }

  for (const key of CODE_QUALITY_HARD_RULE_KEYS) {
    const note = readStringField(hardRuleChecks[key]);
    evidence.hardRuleChecks[key] = Boolean(note);
    if (!note) {
      errors.push(`qualityReview.hardRuleChecks.${key} is required`);
      continue;
    }
    if (/[\r\n]/.test(note)) {
      errors.push(`qualityReview.hardRuleChecks.${key} must be single-line`);
    }
    if (note.length > 200) {
      errors.push(`qualityReview.hardRuleChecks.${key} must be <=200 chars`);
    }
  }

  return { ok: errors.length === 0, errors, evidence };
}

/**
 * Builds prompt used by workflow automation.
 */
function buildPrompt({
  agentName,
  skillsSelected,
  includeSkills,
  taskKind,
  isSmoke,
  isAutopilot,
  reviewGate,
  reviewRetryReason,
  codeQualityRetryReasonCode,
  codeQualityRetryReason,
  consultDispositionRetryReason,
  skillOpsGate,
  codeQualityGate,
  observerDrainGate,
  taskMarkdown,
  contextBlock,
  cockpitRoot,
}) {
  const invocations =
    includeSkills && Array.isArray(skillsSelected) && skillsSelected.length
      ? skillsSelected.map((s) => `$${s}`).join('\n')
      : '';

  return (
    (invocations ? `${invocations}\n\n` : '') +
    (contextBlock ? `${contextBlock}\n\n` : '') +
    `You are the agent "${agentName}" running inside Agentic Cockpit.\n\n` +
    `You have received an AgentBus task packet below (JSON frontmatter + body).\n` +
    `Follow the protocol implied by signals.kind:\n` +
    `- PLAN_REQUEST: produce a structured plan ONLY. Do NOT commit.\n` +
    `- EXECUTE: implement the changes, run tests/linters, commit + push.\n` +
    `- ORCHESTRATOR_UPDATE: if you are a controller (e.g. autopilot), emit followUps to progress the workflow automatically.\n` +
    `- Otherwise: follow the task body.\n\n` +
    (isAutopilot
      ? `AUTOPILOT MODE (controller):\n` +
        `- You are the central authority; keep the workflow moving end-to-end.\n` +
        `- Do NOT wait for extra human confirmation between PLAN receipts and dispatching EXECUTE tasks.\n` +
        `- Only require explicit human approval for merging PRs or irreversible production actions.\n` +
        `- If a decision is missing, choose the safest default, proceed, and record it in your note.\n\n`
      : '') +
    (isSmoke
      ? `SMOKE MODE:\n` +
        `- Keep it minimal and fast.\n` +
        `- Do ONLY what the task asks.\n` +
        `- Do NOT run extra checks.\n` +
        `- Do NOT update docs/runbooks/ledgers unless explicitly required.\n\n`
      : '') +
    `SANDBOX + PERMISSIONS:\n` +
    `- Shell commands run in a constrained sandbox (workspace-write).\n` +
    `- If you hit a permission/sandbox denial, do NOT loop or retry in circles.\n` +
    `  Return outcome="blocked" with the exact missing permission/path and one concrete fix.\n\n` +
    `- When editing with patch tools, use workspace-relative paths only (for example \`.codex/CONTINUITY.md\`).\n` +
    `  Absolute filesystem paths (for example \`/home/.../file\`) are commonly rejected.\n\n` +
    `- Assume \`jq\` may be unavailable; prefer \`gh --json/--jq\`, \`node -e\`, or \`python -c\` for JSON parsing.\n` +
    `  Do not fail a task solely due to missing \`jq\`.\n\n` +
    buildReviewGatePromptBlock({ reviewGate, reviewRetryReason }) +
    buildSkillOpsGatePromptBlock({ skillOpsGate }) +
    buildCodeQualityGatePromptBlock({
      codeQualityGate,
      cockpitRoot,
      codeQualityRetryReasonCode,
      codeQualityRetryReason,
    }) +
    buildObserverDrainGatePromptBlock({ observerDrainGate }) +
    buildOpusConsultPromptBlock({
      isAutopilot,
      consultDispositionRetryReason,
    }) +
    `IMPORTANT OUTPUT RULE:\n` +
    `Return ONLY a JSON object that matches the provided output schema.\n\n` +
    `Always include the top-level "review" field:\n` +
    `- use \`null\` when no review gate is required,\n` +
    `- use a populated object when review gate is required.\n\n` +
    `You MAY include "followUps" (see schema) to dispatch additional AgentBus tasks automatically.\n\n` +
    `For every followUp, include references.git and references.integration.\n` +
    `For non-EXECUTE followUps, set both to null.\n` +
    `For followUps where signals.kind="EXECUTE", include references.git and references.integration values:\n` +
    `- references.git.baseSha (required)\n` +
    `- references.git.workBranch (required)\n` +
    `- references.git.integrationBranch (required)\n` +
    `- references.integration.requiredIntegrationBranch (required)\n` +
    `- references.integration.integrationMode="autopilot_integrates"\n\n` +
    `--- TASK PACKET ---\n` +
    `${taskMarkdown}\n`
  );
}

/**
 * Normalizes to array for downstream use.
 */
function normalizeToArray(value) {
  if (Array.isArray(value)) return value.map((s) => String(s)).map((s) => s.trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

/**
 * Returns whether follow-up is status.
 */
function isStatusFollowUp(followUp) {
  const kind = readStringField(followUp?.signals?.kind).toUpperCase();
  return kind === 'STATUS';
}

/**
 * Helper for safe exec text used by the cockpit workflow runtime.
 */
function safeExecText(cmd, args, { cwd }) {
  try {
    const raw = childProcess.execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return String(raw ?? '').trim() || null;
  } catch {
    return null;
  }
}

/**
 * Helper for safe exec ok used by the cockpit workflow runtime.
 */
function safeExecOk(cmd, args, { cwd }) {
  try {
    childProcess.execFileSync(cmd, args, { cwd, stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

const DEPLOY_JSON_CACHE_TTL_MS = 15_000;
/** @type {Map<string, { fetchedAtMs: number, summary: string | null }>} */
const deployJsonSummaryCache = new Map();

/**
 * Reads deploy json summary cached from disk or process state.
 */
function readDeployJsonSummaryCached(url, { cwd }) {
  const cached = deployJsonSummaryCache.get(url);
  const now = Date.now();
  if (cached && now - cached.fetchedAtMs < DEPLOY_JSON_CACHE_TTL_MS) return cached.summary;

  const raw = safeExecText('bash', ['-lc', `curl -fsS --max-time 2 ${url}`], { cwd });
  if (!raw) {
    deployJsonSummaryCache.set(url, { fetchedAtMs: now, summary: null });
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    const branch = typeof parsed?.branch === 'string' ? parsed.branch.trim() : '';
    const sha = typeof parsed?.sha === 'string' ? parsed.sha.trim() : '';
    const productionSha = typeof parsed?.productionSha === 'string' ? parsed.productionSha.trim() : '';
    const builtAt = typeof parsed?.builtAt === 'string' ? parsed.builtAt.trim() : '';
    const parts = [];
    if (branch) parts.push(`branch=${branch}`);
    if (sha) parts.push(`sha=${sha}`);
    if (productionSha && productionSha !== sha) parts.push(`productionSha=${productionSha}`);
    if (builtAt) parts.push(`builtAt=${builtAt}`);
    const summary = parts.length ? parts.join(' ') : null;
    deployJsonSummaryCache.set(url, { fetchedAtMs: now, summary });
    return summary;
  } catch {
    deployJsonSummaryCache.set(url, { fetchedAtMs: now, summary: null });
    return null;
  }
}

/**
 * Reads text file if exists from disk or process state.
 */
async function readTextFileIfExists(filePath, { maxBytes }) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const max = Math.max(1, Number(maxBytes) || 64_000);
    if (raw.length <= max) return raw;
    return raw.slice(0, max) + '\n…(truncated)…\n';
  } catch {
    return null;
  }
}

/**
 * Writes agent state file to persistent state.
 */
async function writeAgentStateFile({ busRoot, agentName, payload }) {
  const dir = path.join(busRoot, 'state');
  await fs.mkdir(dir, { recursive: true });
  const outPath = path.join(dir, `${agentName}.json`);
  const tmp = `${outPath}.tmp.${Math.random().toString(16).slice(2)}`;
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, outPath);
  return outPath;
}

/**
 * Helper for inbox has task id used by the cockpit workflow runtime.
 */
async function inboxHasTaskId({ busRoot, agentName, state, taskId }) {
  const dir = path.join(busRoot, 'inbox', agentName, state);

  const direct = path.join(dir, `${taskId}.md`);
  if (await fileExists(direct)) return true;

  let files = [];
  try {
    files = await fs.readdir(dir);
  } catch {
    return false;
  }

  return files.some(
    (f) => f === `${taskId}.md` || (f.startsWith(`${taskId}__`) && f.endsWith('.md')),
  );
}

/**
 * Returns whether task in inbox states.
 */
async function isTaskInInboxStates({
  busRoot,
  agentName,
  taskId,
  states = ['new', 'seen', 'in_progress'],
}) {
  for (const state of states) {
    if (await inboxHasTaskId({ busRoot, agentName, state, taskId })) return true;
  }
  return false;
}

/**
 * Builds basic context block used by workflow automation.
 */
function buildBasicContextBlock({ workdir }) {
  const cwd = workdir || process.cwd();
  const gitBranch = safeExecText('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
  const gitHead = safeExecText('git', ['rev-parse', 'HEAD'], { cwd });
  return (
    `--- CONTEXT SNAPSHOT (deterministic) ---\n` +
    `workdir: ${cwd}\n` +
    `git.branch: ${gitBranch || 'UNAVAILABLE'}\n` +
    `git.head: ${gitHead || 'UNAVAILABLE'}\n` +
    `--- END CONTEXT ---`
  );
}

/**
 * Builds git contract block used by workflow automation.
 */
function buildGitContractBlock({ contract }) {
  if (!contract) return '';
  const lines = [];
  if (contract.baseBranch) lines.push(`task.git.baseBranch: ${contract.baseBranch}`);
  if (contract.baseSha) lines.push(`task.git.baseSha: ${contract.baseSha}`);
  if (contract.workBranch) lines.push(`task.git.workBranch: ${contract.workBranch}`);
  if (contract.integrationBranch) lines.push(`task.git.integrationBranch: ${contract.integrationBranch}`);
  return lines.length ? `--- TASK GIT CONTRACT ---\n${lines.join('\n')}\n--- END TASK GIT CONTRACT ---` : '';
}

/**
 * Builds receipt git extra used by workflow automation.
 */
function buildReceiptGitExtra({ cwd, preflight, preflightCleanArtifactPath = null }) {
  const snap = getGitSnapshot({ cwd }) || {};
  const c = preflight?.contract || null;
  return {
    workdir: cwd,
    branch: snap.branch ?? null,
    headSha: snap.headSha ?? null,
    isDirty: typeof snap.isDirty === 'boolean' ? snap.isDirty : null,
    baseBranch: c?.baseBranch ?? null,
    baseSha: c?.baseSha ?? null,
    workBranch: c?.workBranch ?? null,
    integrationBranch: c?.integrationBranch ?? null,
    preflightApplied: Boolean(preflight?.applied),
    preflightCreated: Boolean(preflight?.created),
    preflightFetched: Boolean(preflight?.fetched),
    preflightHardSynced: Boolean(preflight?.hardSynced),
    preflightAutoCleaned: Boolean(preflight?.autoCleaned),
    preflightCleanArtifactPath: preflightCleanArtifactPath || null,
  };
}

/**
 * Resolves required integration branch from task metadata.
 */
function readRequiredIntegrationBranch(taskMeta) {
  const refs = isPlainObject(taskMeta?.references) ? taskMeta.references : {};
  const integration = isPlainObject(refs?.integration) ? refs.integration : {};
  const git = isPlainObject(refs?.git) ? refs.git : {};
  const sourceRefs = isPlainObject(refs?.sourceReferences) ? refs.sourceReferences : {};
  const sourceGit = isPlainObject(sourceRefs?.git) ? sourceRefs.git : {};
  const sourceIntegration = isPlainObject(sourceRefs?.integration) ? sourceRefs.integration : {};
  const candidates = [
    integration.requiredIntegrationBranch,
    git.integrationBranch,
    sourceIntegration.requiredIntegrationBranch,
    sourceGit.integrationBranch,
    sourceRefs.headRefName,
  ];
  for (const candidate of candidates) {
    const branch = normalizeBranchRefText(candidate);
    if (branch) return branch;
  }
  return '';
}

/**
 * Builds context lines for Opus consult advisory tied to focus root.
 */
async function buildOpusConsultAdviceContext({ busRoot, receipts, focusRootId, maxItems = 8 }) {
  const list = Array.isArray(receipts) ? receipts : [];
  const expectedRoot = readStringField(focusRootId);
  for (const receipt of list) {
    const receiptRootId = readStringField(receipt?.task?.signals?.rootId);
    if (expectedRoot && receiptRootId !== expectedRoot) continue;
    const advice = isPlainObject(receipt?.receiptExtra?.opusConsultAdvice)
      ? receipt.receiptExtra.opusConsultAdvice
      : null;
    if (!advice) continue;

    const pickPhase = async (phaseAdvice) => {
      if (!isPlainObject(phaseAdvice) || phaseAdvice.consulted !== true) return null;
      const consultId = readStringField(phaseAdvice.consultId);
      const round = Number(phaseAdvice.round) || 0;
      const responseTaskId = readStringField(phaseAdvice.responseTaskId);
      if (consultId && round > 0 && responseTaskId) {
        const resolution = await readOpusConsultResolution({
          busRoot,
          consultId,
          phase: readStringField(phaseAdvice.phase) || 'pre_exec',
          round,
        });
        if (
          resolution?.consumedResponseTaskId &&
          resolution.consumedResponseTaskId !== responseTaskId
        ) {
          return null;
        }
      }
      return phaseAdvice;
    };

    const preExec = await pickPhase(advice.preExec);
    const postReview = await pickPhase(advice.postReview);
    if (!preExec && !postReview) continue;

    const lines = [];
    const appendPhase = (label, phaseAdvice) => {
      if (!phaseAdvice) return;
      lines.push(
        `- ${label}: severity=${readStringField(phaseAdvice.severity) || 'none'} reasonCode=${readStringField(phaseAdvice.reasonCode) || 'none'}`,
      );
      const summary = readStringField(phaseAdvice.summary);
      if (summary) lines.push(`  summary: ${summary.slice(0, 360)}`);
      const items = Array.isArray(phaseAdvice.items) ? phaseAdvice.items.slice(0, maxItems) : [];
      for (const item of items) {
        const itemId = readStringField(item?.id);
        const category = readStringField(item?.category);
        const itemText = readStringField(item?.text).slice(0, 260);
        if (!itemId || !itemText) continue;
        lines.push(`  ${itemId} [${category || 'note'}] ${itemText}`);
      }
    };
    appendPhase('pre_exec', preExec);
    appendPhase('post_review', postReview);
    if (lines.length === 0) continue;

    return {
      text: lines.join('\n'),
      preExecRequiredIds: Array.isArray(preExec?.items)
        ? preExec.items.map((item) => readStringField(item?.id)).filter(Boolean)
        : [],
    };
  }
  return null;
}

/**
 * Builds autopilot context block used by workflow automation.
 */
async function buildAutopilotContextBlock({ repoRoot, busRoot, roster, taskMeta, agentName }) {
  const rootIdSignal = typeof taskMeta?.signals?.rootId === 'string' ? taskMeta.signals.rootId.trim() : '';
  const taskId = typeof taskMeta?.id === 'string' ? taskMeta.id.trim() : '';
  const focusRootId = rootIdSignal || taskId || null;

  const gitBranch = safeExecText('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot });
  const gitHead = safeExecText('git', ['rev-parse', 'HEAD'], { cwd: repoRoot });

  const ghInstalled = Boolean(safeExecText('bash', ['-lc', 'command -v gh'], { cwd: repoRoot }));
  const ghAuthed = ghInstalled ? safeExecOk('gh', ['auth', 'status', '-h', 'github.com'], { cwd: repoRoot }) : false;

  const includeDeployJson = String(process.env.VALUA_AUTOPILOT_INCLUDE_DEPLOY_JSON || '').trim() === '1';
  const stagingDeploy = includeDeployJson
    ? readDeployJsonSummaryCached('https://staging.valua.co.nz/deploy.json', { cwd: repoRoot })
    : null;
  const prodDeploy = includeDeployJson
    ? readDeployJsonSummaryCached('https://valua.co.nz/deploy.json', { cwd: repoRoot })
    : null;

  const statusRows = await statusSummary({ busRoot, roster });
  const statusLines = statusRows
    .map((r) => `${r.agent}: new=${r.new} seen=${r.seen} in_progress=${r.in_progress} processed=${r.processed}`)
    .join('\n');

  /** @type {{ state: string, id: string, title: string, kind: string|null, phase: string|null, rootId: string|null, from: string, priority: string, mtimeMs: number }[]} */
  const autopilotQueue = [];
  for (const state of ['in_progress', 'new', 'seen']) {
    const items = await listInboxTasks({ busRoot, agentName, state, limit: 50 });
    for (const it of items) {
      const meta = it.meta ?? {};
      autopilotQueue.push({
        state,
        id: meta.id ?? it.taskId,
        title: meta.title ?? '',
        kind: meta?.signals?.kind ?? null,
        phase: meta?.signals?.phase ?? null,
        rootId: typeof meta?.signals?.rootId === 'string' ? meta.signals.rootId.trim() : null,
        from: meta.from ?? '',
        priority: meta.priority ?? 'P2',
        mtimeMs: it.mtimeMs ?? 0,
      });
    }
  }
  autopilotQueue.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const autopilotQueueLines = autopilotQueue
    .slice(0, 35)
    .map(
      (t) =>
        `- [${t.state}] prio=${t.priority} kind=${t.kind ?? 'UNKNOWN'} phase=${t.phase ?? ''} rootId=${t.rootId ?? ''} id=${t.id} from=${t.from} — ${t.title}`,
    )
    .join('\n');

  const agents = Array.isArray(roster?.agents) ? roster.agents.map((a) => a?.name).filter(Boolean) : [];
  const states = ['in_progress', 'new', 'seen'];
  /** @type {{ agent: string, state: string, id: string, title: string, kind: string|null, phase: string|null, rootId: string|null, mtimeMs: number }[]} */
  const openTasks = [];
  for (const agent of agents) {
    for (const state of states) {
      const items = await listInboxTasks({ busRoot, agentName: agent, state, limit: 50 });
      for (const it of items) {
        const meta = it.meta ?? {};
        const taskRootId = typeof meta?.signals?.rootId === 'string' ? meta.signals.rootId.trim() : null;
        openTasks.push({
          agent,
          state,
          id: meta.id ?? it.taskId,
          title: meta.title ?? '',
          kind: meta?.signals?.kind ?? null,
          phase: meta?.signals?.phase ?? null,
          rootId: taskRootId,
          mtimeMs: it.mtimeMs ?? 0,
        });
      }
    }
  }
  openTasks.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const openLines = openTasks
    .slice(0, 25)
    .map(
      (t) =>
        `- [${t.state}] ${t.agent} kind=${t.kind ?? 'UNKNOWN'} phase=${t.phase ?? ''} rootId=${t.rootId ?? ''} id=${t.id} — ${t.title}`,
    )
    .join('\n');

  const focusOpenLines = focusRootId
    ? openTasks
        .filter((t) => t.rootId === focusRootId)
        .slice(0, 25)
        .map(
          (t) =>
            `- [${t.state}] ${t.agent} kind=${t.kind ?? 'UNKNOWN'} phase=${t.phase ?? ''} id=${t.id} — ${t.title}`,
        )
        .join('\n')
    : '';

  const receipts = await recentReceipts({ busRoot, agentName: null, limit: 50 });
  const receiptLines = receipts
    .slice(0, 15)
    .map(
      (r) =>
        `- ${r.agent}/${r.taskId}: outcome=${r.outcome} commitSha=${r.commitSha || ''} rootId=${r.task?.signals?.rootId ?? ''} title=${r.task?.title || ''}`,
    )
    .join('\n');

  const focusReceiptLines = focusRootId
    ? receipts
        .filter((r) => r?.task?.signals?.rootId === focusRootId)
        .slice(0, 15)
        .map(
          (r) =>
            `- ${r.agent}/${r.taskId}: outcome=${r.outcome} commitSha=${r.commitSha || ''} title=${r.task?.title || ''}`,
        )
        .join('\n')
    : '';
  const focusOpusAdvice = focusRootId
    ? await buildOpusConsultAdviceContext({ busRoot, receipts, focusRootId })
    : null;

  const ledgerPath = path.join(repoRoot, '.codex', 'CONTINUITY.md');
  const ledger = await readTextFileIfExists(ledgerPath, { maxBytes: 16_000 });

  const statePath = path.join(busRoot, 'state', `${agentName}.json`);
  const apState = await readTextFileIfExists(statePath, { maxBytes: 8_000 });

  return (
    `--- CONTEXT SNAPSHOT (deterministic) ---\n` +
    `repoRoot: ${repoRoot}\n` +
    `busRoot: ${busRoot}\n` +
    `git.branch: ${gitBranch || 'UNAVAILABLE'}\n` +
    `git.head: ${gitHead || 'UNAVAILABLE'}\n` +
    `gh.installed: ${ghInstalled}\n` +
    `gh.authed: ${ghAuthed}\n` +
    (taskId ? `taskId: ${taskId}\n` : '') +
    (focusRootId ? `focusRootId: ${focusRootId}\n` : '') +
    (stagingDeploy ? `staging.deploy: ${stagingDeploy}\n` : '') +
    (prodDeploy ? `prod.deploy: ${prodDeploy}\n` : '') +
    (autopilotQueueLines ? `\nAutopilot inbox queue:\n${autopilotQueueLines}\n` : '') +
    `\nAgentBus status:\n${statusLines || '(no agents)'}\n` +
    `\nOpen tasks:\n` +
    `${openLines || '(none)'}\n` +
    (focusRootId ? `\nOpen tasks (focusRootId):\n${focusOpenLines || '(none)'}\n` : '') +
    `\nRecent receipts:\n` +
    `${receiptLines || '(none)'}\n` +
    (focusRootId ? `\nRecent receipts (focusRootId):\n${focusReceiptLines || '(none)'}\n` : '') +
    (focusOpusAdvice?.text
      ? `\nOpus consult advisory (focusRootId):\n${focusOpusAdvice.text}\n`
      : '') +
    `\nAutopilot state (last run):\n` +
    `${apState || '(missing)'}\n` +
    `\nContinuity ledger (.codex/CONTINUITY.md):\n` +
    `${ledger || '(missing)'}\n` +
    `--- END CONTEXT ---`
  );
}

/**
 * Builds autopilot context block thin used by workflow automation.
 */
async function buildAutopilotContextBlockThin({ repoRoot, busRoot, roster, taskMeta, agentName }) {
  const rootIdSignal = typeof taskMeta?.signals?.rootId === 'string' ? taskMeta.signals.rootId.trim() : '';
  const taskId = typeof taskMeta?.id === 'string' ? taskMeta.id.trim() : '';
  const focusRootId = rootIdSignal || taskId || null;

  const gitBranch = safeExecText('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot });
  const gitHead = safeExecText('git', ['rev-parse', 'HEAD'], { cwd: repoRoot });

  const ghInstalled = Boolean(safeExecText('bash', ['-lc', 'command -v gh'], { cwd: repoRoot }));
  const ghAuthed = ghInstalled ? safeExecOk('gh', ['auth', 'status', '-h', 'github.com'], { cwd: repoRoot }) : false;

  /** @type {{ state: string, id: string, title: string, kind: string|null, phase: string|null, rootId: string|null, from: string, priority: string, mtimeMs: number }[]} */
  const autopilotQueue = [];
  for (const state of ['in_progress', 'new', 'seen']) {
    const items = await listInboxTasks({ busRoot, agentName, state, limit: 20 });
    for (const it of items) {
      const meta = it.meta ?? {};
      autopilotQueue.push({
        state,
        id: meta.id ?? it.taskId,
        title: meta.title ?? '',
        kind: meta?.signals?.kind ?? null,
        phase: meta?.signals?.phase ?? null,
        rootId: typeof meta?.signals?.rootId === 'string' ? meta.signals.rootId.trim() : null,
        from: meta.from ?? '',
        priority: meta.priority ?? 'P2',
        mtimeMs: it.mtimeMs ?? 0,
      });
    }
  }
  autopilotQueue.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const autopilotQueueLines = autopilotQueue
    .slice(0, 12)
    .map(
      (t) =>
        `- [${t.state}] prio=${t.priority} kind=${t.kind ?? 'UNKNOWN'} phase=${t.phase ?? ''} rootId=${t.rootId ?? ''} id=${t.id} from=${t.from} — ${t.title}`,
    )
    .join('\n');

  const agents = Array.isArray(roster?.agents) ? roster.agents.map((a) => a?.name).filter(Boolean) : [];
  const states = ['in_progress', 'new', 'seen'];
  /** @type {{ agent: string, state: string, id: string, title: string, kind: string|null, phase: string|null, rootId: string|null, mtimeMs: number }[]} */
  const focusOpen = [];
  if (focusRootId) {
    for (const agent of agents) {
      for (const state of states) {
        const items = await listInboxTasks({ busRoot, agentName: agent, state, limit: 30 });
        for (const it of items) {
          const meta = it.meta ?? {};
          const taskRootId = typeof meta?.signals?.rootId === 'string' ? meta.signals.rootId.trim() : null;
          if (taskRootId !== focusRootId) continue;
          focusOpen.push({
            agent,
            state,
            id: meta.id ?? it.taskId,
            title: meta.title ?? '',
            kind: meta?.signals?.kind ?? null,
            phase: meta?.signals?.phase ?? null,
            rootId: taskRootId,
            mtimeMs: it.mtimeMs ?? 0,
          });
        }
      }
    }
  }
  focusOpen.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const focusOpenLines = focusOpen
    .slice(0, 25)
    .map(
      (t) =>
        `- [${t.state}] ${t.agent} kind=${t.kind ?? 'UNKNOWN'} phase=${t.phase ?? ''} id=${t.id} — ${t.title}`,
    )
    .join('\n');

  const receipts = await recentReceipts({ busRoot, agentName: null, limit: 25 });
  const focusReceiptLines = focusRootId
    ? receipts
        .filter((r) => r?.task?.signals?.rootId === focusRootId)
        .slice(0, 10)
        .map(
          (r) =>
            `- ${r.agent}/${r.taskId}: outcome=${r.outcome} commitSha=${r.commitSha || ''} title=${r.task?.title || ''}`,
        )
        .join('\n')
    : '';
  const focusOpusAdvice = focusRootId
    ? await buildOpusConsultAdviceContext({ busRoot, receipts, focusRootId, maxItems: 4 })
    : null;

  const statePath = path.join(busRoot, 'state', `${agentName}.json`);
  const apState = await readTextFileIfExists(statePath, { maxBytes: 2_000 });

  const ledgerPath = path.join(repoRoot, '.codex', 'CONTINUITY.md');

  return (
    `--- CONTEXT SNAPSHOT (deterministic, thin) ---\n` +
    `repoRoot: ${repoRoot}\n` +
    `busRoot: ${busRoot}\n` +
    `git.branch: ${gitBranch || 'UNAVAILABLE'}\n` +
    `git.head: ${gitHead || 'UNAVAILABLE'}\n` +
    `gh.installed: ${ghInstalled}\n` +
    `gh.authed: ${ghAuthed}\n` +
    (taskId ? `taskId: ${taskId}\n` : '') +
    (focusRootId ? `focusRootId: ${focusRootId}\n` : '') +
    (autopilotQueueLines ? `\nAutopilot inbox queue:\n${autopilotQueueLines}\n` : '') +
    (focusRootId ? `\nOpen tasks (focusRootId):\n${focusOpenLines || '(none)'}\n` : '') +
    (focusRootId ? `\nRecent receipts (focusRootId):\n${focusReceiptLines || '(none)'}\n` : '') +
    (focusOpusAdvice?.text
      ? `\nOpus consult advisory (focusRootId):\n${focusOpusAdvice.text}\n`
      : '') +
    `\nAutopilot state (last run):\n` +
    `${apState || '(missing)'}\n` +
    `\nContinuity ledger path: ${ledgerPath}\n` +
    `--- END CONTEXT ---`
  );
}

/**
 * Normalizes resume session id for downstream use.
 */
function normalizeResumeSessionId(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (raw === 'last') return 'last';
  // If an env placeholder wasn't expanded, treat it as unset.
  if (raw.startsWith('$')) return null;
  return raw;
}

/**
 * Normalizes codex engine for downstream use.
 */
function normalizeCodexEngine(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return null;
  if (raw === 'exec') return 'exec';
  if (raw === 'app-server' || raw === 'app_server' || raw === 'appserver') return 'app-server';
  return null;
}

/**
 * Normalizes autopilot context mode for downstream use.
 */
function normalizeAutopilotContextMode(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return null;
  if (raw === 'auto') return 'auto';
  if (raw === 'full') return 'full';
  if (raw === 'thin' || raw === 'minimal') return 'thin';
  return null;
}

/**
 * Normalizes autopilot session scope mode.
 */
function normalizeAutopilotSessionScope(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return null;
  if (raw === 'root') return 'root';
  if (raw === 'task') return 'task';
  return null;
}

/**
 * Reads session id file from disk or process state.
 */
async function readSessionIdFile({ busRoot, agentName }) {
  const p = path.join(busRoot, 'state', `${agentName}.session-id`);
  try {
    const raw = await fs.readFile(p, 'utf8');
    const lines = raw.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith('#')) continue;
      return trimmed;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Writes session id file to persistent state.
 */
async function writeSessionIdFile({ busRoot, agentName, sessionId }) {
  const cleaned = normalizeResumeSessionId(sessionId);
  if (!cleaned || cleaned === 'last') return null;
  const dir = path.join(busRoot, 'state');
  await fs.mkdir(dir, { recursive: true });
  const p = path.join(dir, `${agentName}.session-id`);
  await fs.writeFile(p, `${cleaned}\n`, 'utf8');
  return p;
}

/**
 * Returns whether plain object.
 */
function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Normalizes branch token for naming.
 */
function normalizeBranchToken(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const cleaned = raw.replace(/[^A-Za-z0-9._/-]/g, '-').replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '');
  return cleaned.slice(0, 200);
}

/**
 * Normalizes root id for branch naming.
 */
function normalizeRootIdForBranch(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  return raw.replace(/[^A-Za-z0-9._-]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120);
}

/**
 * Normalizes sha candidate.
 */
function normalizeShaCandidate(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  return /^[0-9a-f]{7,40}$/i.test(raw) ? raw.toLowerCase() : '';
}

/**
 * Normalizes branch ref text.
 */
function normalizeBranchRefText(value) {
  const raw = String(value ?? '').trim().replace(/\\/g, '/');
  if (!raw) return '';
  if (raw.startsWith('refs/heads/')) return raw.slice('refs/heads/'.length);
  if (raw.startsWith('refs/remotes/')) {
    const rest = raw.slice('refs/remotes/'.length);
    const slash = rest.indexOf('/');
    return slash > 0 ? rest.slice(slash + 1) : rest;
  }
  return raw;
}

/**
 * Parses branch ref with optional remote prefix.
 */
function parseRemoteBranchRef(value) {
  const raw = String(value ?? '').trim().replace(/\\/g, '/');
  if (!raw) return { remote: '', branch: '' };
  if (raw.startsWith('refs/remotes/')) {
    const rest = raw.slice('refs/remotes/'.length);
    const slash = rest.indexOf('/');
    if (slash <= 0) return { remote: '', branch: normalizeBranchRefText(rest) };
    return { remote: rest.slice(0, slash), branch: normalizeBranchRefText(rest.slice(slash + 1)) };
  }
  for (const knownRemote of ['origin', 'github']) {
    const prefix = `${knownRemote}/`;
    if (raw.startsWith(prefix)) {
      return { remote: knownRemote, branch: normalizeBranchRefText(raw.slice(prefix.length)) };
    }
  }
  return { remote: '', branch: normalizeBranchRefText(raw) };
}

/**
 * Picks first valid positive int-like pr number.
 */
function readPrNumberCandidate(values) {
  for (const value of values) {
    const n = Number(String(value ?? '').trim());
    if (Number.isInteger(n) && n > 0) return n;
  }
  return null;
}

/**
 * Resolves integration branch for follow-up dispatch.
 */
function resolveIntegrationBranchForFollowUp({ referencesIn, openedMeta, rootId, cwd }) {
  const parentRefs = isPlainObject(openedMeta?.references) ? openedMeta.references : {};
  const sourceRefs = isPlainObject(parentRefs?.sourceReferences) ? parentRefs.sourceReferences : {};
  const parentGit = isPlainObject(parentRefs?.git) ? parentRefs.git : {};
  const sourceGit = isPlainObject(sourceRefs?.git) ? sourceRefs.git : {};
  const parentIntegration = isPlainObject(parentRefs?.integration) ? parentRefs.integration : {};
  const sourceIntegration = isPlainObject(sourceRefs?.integration) ? sourceRefs.integration : {};
  const inGit = isPlainObject(referencesIn?.git) ? referencesIn.git : {};
  const inIntegration = isPlainObject(referencesIn?.integration) ? referencesIn.integration : {};

  const directCandidates = [
    inIntegration.requiredIntegrationBranch,
    inGit.integrationBranch,
    parentIntegration.requiredIntegrationBranch,
    parentGit.integrationBranch,
    sourceIntegration.requiredIntegrationBranch,
    sourceGit.integrationBranch,
    sourceRefs.headRefName,
    parentRefs.headRefName,
  ]
    .map((v) => normalizeBranchRefText(v))
    .filter(Boolean);
  if (directCandidates.length) return directCandidates[0];

  const prNumber = readPrNumberCandidate([
    inIntegration.requiredPrNumber,
    referencesIn?.prNumber,
    sourceRefs.prNumber,
    parentRefs.prNumber,
  ]);
  if (prNumber) {
    const headRef = safeExecText(
      'gh',
      ['pr', 'view', String(prNumber), '--json', 'headRefName', '--jq', '.headRefName'],
      { cwd },
    );
    const normalized = normalizeBranchRefText(headRef || '');
    if (normalized) return normalized;
  }

  const rootToken = normalizeRootIdForBranch(rootId);
  if (rootToken) return `slice/${rootToken}`;

  return normalizeBranchRefText(safeExecText('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd }) || '');
}

/**
 * Resolves base sha for follow-up dispatch.
 */
function resolveBaseShaForFollowUp({ referencesIn, openedMeta, integrationBranch, cwd }) {
  const parentRefs = isPlainObject(openedMeta?.references) ? openedMeta.references : {};
  const sourceRefs = isPlainObject(parentRefs?.sourceReferences) ? parentRefs.sourceReferences : {};
  const parentGit = isPlainObject(parentRefs?.git) ? parentRefs.git : {};
  const sourceGit = isPlainObject(sourceRefs?.git) ? sourceRefs.git : {};
  const inGit = isPlainObject(referencesIn?.git) ? referencesIn.git : {};

  const directSha = [
    inGit.baseSha,
    parentGit.baseSha,
    sourceGit.baseSha,
  ]
    .map((v) => normalizeShaCandidate(v))
    .find(Boolean);
  if (directSha) return directSha;

  const parsed = parseRemoteBranchRef(integrationBranch);
  const remotePref = String(
    process.env.AGENTIC_INTEGRATION_REQUIRED_REMOTE ??
      process.env.VALUA_INTEGRATION_REQUIRED_REMOTE ??
      'origin',
  )
    .trim()
    .toLowerCase();
  const remote = parsed.remote || remotePref || 'origin';
  const branch = parsed.branch || integrationBranch;
  const candidateRefs = [
    branch ? `${remote}/${branch}` : '',
    branch || '',
    'HEAD',
  ].filter(Boolean);
  for (const ref of candidateRefs) {
    const sha = normalizeShaCandidate(safeExecText('git', ['rev-parse', ref], { cwd }) || '');
    if (sha) return sha;
  }
  return '';
}

/**
 * Builds default work branch for follow-up dispatch.
 */
function buildDefaultWorkBranch({ targetAgent, rootId }) {
  const agentToken = normalizeBranchToken(targetAgent || 'worker').replace(/\//g, '-');
  const rootToken = normalizeRootIdForBranch(rootId || 'root');
  return `wip/${agentToken}/${rootToken || 'root'}`;
}

/**
 * Builds deterministic branch key text.
 */
function buildBranchContinuityKey({ targetAgent, rootId, workstream }) {
  return [
    normalizeBranchToken(targetAgent || '').replace(/\//g, '-'),
    normalizeRootIdForBranch(rootId || ''),
    normalizeBranchToken(workstream || 'main').replace(/\//g, '-'),
  ].join('::');
}

/**
 * Reads branch continuity state.
 */
async function readBranchContinuityState({ busRoot, targetAgent, rootId, workstream }) {
  const key = safeStateBasename(buildBranchContinuityKey({ targetAgent, rootId, workstream }));
  const dir = path.join(busRoot, 'state', 'branch-continuity');
  const p = path.join(dir, `${key}.json`);
  try {
    const raw = await fs.readFile(p, 'utf8');
    const parsed = JSON.parse(raw);
    const generationRaw = Number(parsed?.generation);
    const generation = Number.isFinite(generationRaw) && generationRaw >= 0 ? Math.floor(generationRaw) : 0;
    return { path: p, generation, payload: parsed };
  } catch {
    return { path: p, generation: 0, payload: null };
  }
}

/**
 * Writes branch continuity state.
 */
async function writeBranchContinuityState({ busRoot, targetAgent, rootId, workstream, generation }) {
  const key = safeStateBasename(buildBranchContinuityKey({ targetAgent, rootId, workstream }));
  const dir = path.join(busRoot, 'state', 'branch-continuity');
  await fs.mkdir(dir, { recursive: true });
  const p = path.join(dir, `${key}.json`);
  const tmp = `${p}.tmp.${Math.random().toString(16).slice(2)}`;
  const payload = {
    updatedAt: new Date().toISOString(),
    targetAgent,
    rootId,
    workstream,
    generation: Math.max(0, Number(generation) || 0),
  };
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, p);
  return p;
}

/**
 * Removes branch continuity state for a key.
 */
async function deleteBranchContinuityState({ busRoot, targetAgent, rootId, workstream }) {
  const key = safeStateBasename(buildBranchContinuityKey({ targetAgent, rootId, workstream }));
  const dir = path.join(busRoot, 'state', 'branch-continuity');
  const p = path.join(dir, `${key}.json`);
  try {
    await fs.unlink(p);
  } catch {
    // ignore
  }
}

/**
 * Builds deterministic work branch with optional rotation generation.
 */
function buildDeterministicWorkBranch({ targetAgent, rootId, workstream = 'main', generation = 0 }) {
  const base = buildDefaultWorkBranch({ targetAgent, rootId });
  const ws = normalizeBranchToken(workstream || 'main').replace(/\//g, '-').slice(0, 40) || 'main';
  const gen = Math.max(0, Number(generation) || 0);
  return gen > 0 ? `${base}/${ws}/r${gen}` : `${base}/${ws}`;
}

/**
 * Derives branch continuity reason code from structured errors.
 */
function deriveBranchContinuityReasonCode(branchContinuity) {
  const errors = Array.isArray(branchContinuity?.errors) ? branchContinuity.errors : [];
  for (const err of errors) {
    const code = String(err || '').trim();
    if (/^branch_[a-z0-9_]+$/.test(code)) return code;
  }
  return null;
}

/**
 * Dispatches follow ups to target agents.
 */
async function dispatchFollowUps({
  busRoot,
  agentName,
  openedMeta,
  followUps,
  cwd,
  autopilotControl = {},
  enforceBranchContinuity = false,
}) {
  const rootIdDefault = openedMeta?.signals?.rootId || openedMeta?.id || null;
  const parentIdDefault = openedMeta?.id || null;
  const priority = openedMeta?.priority || 'P2';
  const smokeDefault = Boolean(openedMeta?.signals?.smoke);

  const items = Array.isArray(followUps) ? followUps : [];
  const limit = 5;
  const dispatched = [];
  const errors = [];
  const branchContinuity = {
    status: 'pass',
    errors: [],
    applied: [],
  };
  const control = normalizeAutopilotControl(autopilotControl);

  for (const fu of items.slice(0, limit)) {
    try {
      const to = normalizeToArray(fu?.to);
      const title = typeof fu?.title === 'string' ? fu.title.trim() : '';
      const body = typeof fu?.body === 'string' ? fu.body : '';
      const signalsIn = fu?.signals && typeof fu.signals === 'object' ? fu.signals : null;

      if (!to.length) throw new Error('followUp.to must be a non-empty array');
      if (!title) throw new Error('followUp.title must be non-empty');
      if (!body.trim()) throw new Error('followUp.body must be non-empty');
      if (!signalsIn) throw new Error('followUp.signals must be an object');

      // Loop breaker: never allow self-targeting followUps.
      if (to.includes(agentName)) throw new Error(`followUp targets self (${agentName})`);

      const kind = typeof signalsIn.kind === 'string' ? signalsIn.kind.trim() : '';
      const phase = typeof signalsIn.phase === 'string' ? signalsIn.phase.trim() : '';
      if (!kind) throw new Error('followUp.signals.kind must be non-empty');
      if (!phase) throw new Error('followUp.signals.phase must be non-empty');

      const rootId =
        typeof signalsIn.rootId === 'string' && signalsIn.rootId.trim() ? signalsIn.rootId.trim() : rootIdDefault;
      const parentId =
        typeof signalsIn.parentId === 'string' && signalsIn.parentId.trim() ? signalsIn.parentId.trim() : parentIdDefault;
      const smoke = typeof signalsIn.smoke === 'boolean' ? signalsIn.smoke : smokeDefault;

      if (!rootId) throw new Error('followUp.signals.rootId missing and no default rootId available');
      if (!parentId) throw new Error('followUp.signals.parentId missing and no default parentId available');

      const id = makeId(`fu_${agentName}`);
      const signals = { ...signalsIn, kind, phase, rootId, parentId, smoke };
      const referencesIn = isPlainObject(fu?.references) ? fu.references : {};
      const references = {
        ...referencesIn,
        parentTaskId: parentIdDefault,
        parentRootId: rootIdDefault,
      };

      if (kind.toUpperCase() === 'EXECUTE') {
        const targetAgent = to[0] || '';
        const gitIn = isPlainObject(references.git) ? references.git : {};
        const integrationIn = isPlainObject(references.integration) ? references.integration : {};
        let workBranch = normalizeBranchRefText(gitIn.workBranch) || buildDefaultWorkBranch({ targetAgent, rootId });
        let workstream = readStringField(gitIn.workstream) || '';
        const integrationBranch =
          normalizeBranchRefText(integrationIn.requiredIntegrationBranch || gitIn.integrationBranch) ||
          resolveIntegrationBranchForFollowUp({
            referencesIn,
            openedMeta,
            rootId,
            cwd,
          });
        if (enforceBranchContinuity) {
          workstream = control.workstream || 'main';
          const branchDecision = control.branchDecision || 'reuse';
          const branchDecisionReason = control.branchDecisionReason || '';
          if (branchDecision === 'rotate' && !branchDecisionReason) {
            throw new Error('branch_rotate_reason_missing');
          }
          const continuity = await readBranchContinuityState({ busRoot, targetAgent, rootId, workstream });
          const generation = branchDecision === 'rotate' ? continuity.generation + 1 : continuity.generation;
          workBranch = buildDeterministicWorkBranch({
            targetAgent,
            rootId,
            workstream,
            generation,
          });
          if (branchDecision === 'close') {
            await deleteBranchContinuityState({ busRoot, targetAgent, rootId, workstream });
          } else {
            await writeBranchContinuityState({ busRoot, targetAgent, rootId, workstream, generation });
          }
          branchContinuity.applied.push({
            targetAgent,
            rootId,
            workstream,
            branchDecision: branchDecision || 'reuse',
            generation,
            workBranch,
          });
        }
        const baseSha =
          normalizeShaCandidate(gitIn.baseSha) ||
          resolveBaseShaForFollowUp({
            referencesIn,
            openedMeta,
            integrationBranch,
            cwd,
          });
        if (!baseSha) throw new Error('followUp EXECUTE must resolve references.git.baseSha');

        const baseBranch = normalizeBranchRefText(gitIn.baseBranch || integrationBranch) || integrationBranch;
        references.git = {
          ...gitIn,
          baseBranch,
          baseSha,
          workBranch,
          integrationBranch,
          ...(enforceBranchContinuity ? { workstream } : {}),
        };
        references.integration = {
          ...integrationIn,
          requiredIntegrationBranch: integrationBranch,
          integrationMode: readStringField(integrationIn.integrationMode) || 'autopilot_integrates',
        };
      }

      const meta = {
        id,
        to,
        from: agentName,
        priority,
        title,
        signals,
        references,
      };

      await deliverTask({ busRoot, meta, body });
      dispatched.push({ id, to, title, kind });
    } catch (err) {
      errors.push((err && err.message) || String(err));
      branchContinuity.status = 'blocked';
      branchContinuity.errors.push((err && err.message) || String(err));
    }
  }

  if (items.length > limit) {
    errors.push(`followUps truncated: ${items.length} provided, max ${limit} dispatched`);
  }

  return { dispatched, errors, branchContinuity };
}

/**
 * CLI entrypoint for this script.
 */
async function main() {
  const repoRoot = getRepoRoot();
  const cockpitRoot = getCockpitRoot();
  const { values } = parseArgs({
    allowPositionals: true,
    options: {
      agent: { type: 'string' },
      'bus-root': { type: 'string' },
      roster: { type: 'string' },
      'poll-ms': { type: 'string' },
      once: { type: 'boolean' },
      'codex-bin': { type: 'string' },
    },
  });

  const agentName = values.agent?.trim();
  if (!agentName) throw new Error('--agent is required');

  const rosterInfo = await loadRoster({ repoRoot, rosterPath: values.roster });
  const roster = rosterInfo.roster;
  const busRoot = resolveBusRoot({ busRoot: values['bus-root'], repoRoot });
  await ensureBusRoot(busRoot, roster);

  const agentCfg = roster.agents.find((a) => a.name === agentName);
  if (!agentCfg) throw new Error(`Agent "${agentName}" not found in roster ${rosterInfo.path}`);

  const autopilotName = (typeof roster?.autopilotName === 'string' && roster.autopilotName.trim()) || 'autopilot';
  const isAutopilot = agentName === autopilotName || agentCfg.role === 'autopilot-worker';
  const autopilotDangerFullAccess =
    isAutopilot &&
    parseBooleanEnv(
      process.env.AGENTIC_AUTOPILOT_DANGER_FULL_ACCESS ??
        process.env.VALUA_AUTOPILOT_DANGER_FULL_ACCESS ??
        '1',
      true,
    );

  const codexBin =
    values['codex-bin']?.trim() ||
    process.env.AGENTIC_CODEX_BIN ||
    process.env.VALUA_CODEX_BIN ||
    resolveDefaultCodexBin();
  const codexEngine =
    normalizeCodexEngine(
      process.env.AGENTIC_CODEX_ENGINE || process.env.VALUA_CODEX_ENGINE || agentCfg?.codexEngine,
    ) || 'exec';
  const codexEngineStrict = parseBooleanEnv(
    process.env.AGENTIC_CODEX_ENGINE_STRICT ?? process.env.VALUA_CODEX_ENGINE_STRICT ?? (isAutopilot ? '1' : '0'),
    isAutopilot,
  );
  if (isAutopilot && !codexEngineStrict) {
    throw new Error('AGENTIC_CODEX_ENGINE_STRICT must be enabled for autopilot worker');
  }
  const autopilotSessionScope =
    normalizeAutopilotSessionScope(
      process.env.AGENTIC_AUTOPILOT_SESSION_SCOPE ?? process.env.VALUA_AUTOPILOT_SESSION_SCOPE ?? 'root',
    ) || (isAutopilot ? 'root' : 'task');
  const autopilotSessionRotateTurnsRaw =
    process.env.AGENTIC_AUTOPILOT_SESSION_ROTATE_TURNS ??
    process.env.VALUA_AUTOPILOT_SESSION_ROTATE_TURNS ??
    '40';
  const autopilotSessionRotateTurnsParsed = Number(autopilotSessionRotateTurnsRaw);
  const autopilotSessionRotateTurns = Number.isFinite(autopilotSessionRotateTurnsParsed)
    ? Math.max(0, Math.floor(autopilotSessionRotateTurnsParsed))
    : 40;
  const autopilotDelegateGateEnabled = parseBooleanEnv(
    process.env.AGENTIC_AUTOPILOT_DELEGATE_GATE ?? process.env.VALUA_AUTOPILOT_DELEGATE_GATE ?? '1',
    true,
  );
  const autopilotSelfReviewGateEnabled = parseBooleanEnv(
    process.env.AGENTIC_AUTOPILOT_SELF_REVIEW_GATE ?? process.env.VALUA_AUTOPILOT_SELF_REVIEW_GATE ?? '1',
    true,
  );
  const autopilotProactiveStatusEnabled = parseBooleanEnv(
    process.env.AGENTIC_AUTOPILOT_PROACTIVE_STATUS ?? process.env.VALUA_AUTOPILOT_PROACTIVE_STATUS ?? '1',
    true,
  );
  const gateAutoremediateRetriesRaw =
    process.env.AGENTIC_GATE_AUTOREMEDIATE_RETRIES ??
    process.env.VALUA_GATE_AUTOREMEDIATE_RETRIES ??
    '2';
  const gateAutoremediateRetriesParsed = Number(gateAutoremediateRetriesRaw);
  const gateAutoremediateRetries = Number.isFinite(gateAutoremediateRetriesParsed)
    ? Math.max(0, Math.floor(gateAutoremediateRetriesParsed))
    : 2;
  const consultDispositionRetriesRaw =
    process.env.AGENTIC_OPUS_CONSULT_ACK_RETRIES ??
    process.env.VALUA_OPUS_CONSULT_ACK_RETRIES ??
    '1';
  const consultDispositionRetriesParsed = Number(consultDispositionRetriesRaw);
  const consultDispositionRetries = Number.isFinite(consultDispositionRetriesParsed)
    ? Math.max(0, Math.floor(consultDispositionRetriesParsed))
    : 1;
  const combinedGateRetryBudgetRaw =
    process.env.AGENTIC_GATE_TOTAL_RETRY_BUDGET ??
    process.env.VALUA_GATE_TOTAL_RETRY_BUDGET ??
    '2';
  const combinedGateRetryBudgetParsed = Number(combinedGateRetryBudgetRaw);
  const combinedGateRetryBudget = Number.isFinite(combinedGateRetryBudgetParsed)
    ? Math.max(0, Math.floor(combinedGateRetryBudgetParsed))
    : 2;
  const appServerPersistEnabled =
    codexEngine === 'app-server' &&
    parseBooleanEnv(
      process.env.AGENTIC_CODEX_APP_SERVER_PERSIST ?? process.env.VALUA_CODEX_APP_SERVER_PERSIST ?? '',
      true,
    );
  const appServerResumePersisted = parseBooleanEnv(
    process.env.AGENTIC_CODEX_APP_SERVER_RESUME_PERSISTED ??
      process.env.VALUA_CODEX_APP_SERVER_RESUME_PERSISTED ??
      '0',
    false,
  );
  const pollMs = values['poll-ms'] ? Math.max(50, Number(values['poll-ms'])) : 300;

  const schemaPath = path.join(cockpitRoot, 'docs', 'agentic', 'agent-bus', 'CODEX_WORKER_OUTPUT.schema.json');

  const defaultWorktreesDir = path.join(os.homedir(), '.agentic-cockpit', 'worktrees');
  const worktreesDir =
    process.env.AGENTIC_WORKTREES_DIR?.trim() || process.env.VALUA_AGENT_WORKTREES_DIR?.trim() || defaultWorktreesDir;

  // Guardrails: non-autopilot workers must not merge PRs or push to protected branches.
  // Daddy-autopilot can opt into guard overrides so it can self-remediate blocked tasks.
  // We implement this as PATH wrappers for `git` and `gh` (interactive DADDY CHAT is not launched through this worker).
  const guardBin = path.join(cockpitRoot, 'scripts', 'agentic', 'guard-bin');
  let guardEnv = {};
  try {
    await fs.stat(guardBin);
    const origPath = process.env.PATH || '';
    const realGit = safeExecText('bash', ['-lc', 'command -v git'], { cwd: cockpitRoot });
    const realGh = safeExecText('bash', ['-lc', 'command -v gh'], { cwd: cockpitRoot });
    const autopilotGuardAllowProtectedPush =
      isAutopilot &&
      parseBooleanEnv(
        process.env.AGENTIC_AUTOPILOT_GUARD_ALLOW_PROTECTED_PUSH ??
          process.env.VALUA_AUTOPILOT_GUARD_ALLOW_PROTECTED_PUSH ??
          '0',
        false,
      );
    const autopilotGuardAllowPrMerge =
      isAutopilot &&
      parseBooleanEnv(
        process.env.AGENTIC_AUTOPILOT_GUARD_ALLOW_PR_MERGE ??
          process.env.VALUA_AUTOPILOT_GUARD_ALLOW_PR_MERGE ??
          '0',
        false,
      );
    const autopilotGuardAllowForcePush =
      isAutopilot &&
      parseBooleanEnv(
        process.env.AGENTIC_AUTOPILOT_GUARD_ALLOW_FORCE_PUSH ??
          process.env.VALUA_AUTOPILOT_GUARD_ALLOW_FORCE_PUSH ??
          '0',
        false,
      );

    guardEnv = {
      VALUA_ORIG_PATH: origPath,
      VALUA_REAL_GIT: realGit || '',
      VALUA_REAL_GH: realGh || '',
      VALUA_PROTECTED_BRANCHES: 'master,production',
      VALUA_GUARD_ALLOW_PROTECTED_PUSH: autopilotGuardAllowProtectedPush ? '1' : '0',
      VALUA_GUARD_ALLOW_PR_MERGE: autopilotGuardAllowPrMerge ? '1' : '0',
      VALUA_GUARD_ALLOW_FORCE_PUSH: autopilotGuardAllowForcePush ? '1' : '0',
      PATH: `${guardBin}:${origPath}`,
    };
  } catch {
    guardEnv = {};
  }

  let workdir = agentCfg.workdir
    ? path.resolve(
        expandEnvVars(agentCfg.workdir, {
          REPO_ROOT: repoRoot,
          AGENTIC_WORKTREES_DIR: worktreesDir,
          VALUA_AGENT_WORKTREES_DIR: worktreesDir,
        }),
      )
    : null;
  if (workdir) {
    try {
      await fs.stat(workdir);
    } catch {
      writePane(
        `WARN: configured workdir does not exist for ${agentName}: ${workdir} (falling back to repoRoot)\n`,
      );
      workdir = repoRoot;
    }
  }

  const globalMaxInflightRaw = (process.env.VALUA_CODEX_GLOBAL_MAX_INFLIGHT || '').trim();
  const globalMaxInflight = globalMaxInflightRaw ? Math.max(1, Number(globalMaxInflightRaw) || 1) : 3;
  const statusThrottleMsRaw = (process.env.VALUA_CODEX_RATE_LIMIT_STATUS_THROTTLE_MS || '').trim();
  const statusThrottleMs = statusThrottleMsRaw ? Math.max(250, Number(statusThrottleMsRaw) || 250) : 5_000;
  const retryBaseMsRaw = (process.env.VALUA_CODEX_RETRY_BASE_MS || '').trim();
  const retryBaseMs = retryBaseMsRaw ? Math.max(1, Number(retryBaseMsRaw) || 1) : 250;
  const retryMaxMsRaw = (process.env.VALUA_CODEX_RETRY_MAX_MS || '').trim();
  const retryMaxMs = retryMaxMsRaw ? Math.max(retryBaseMs, Number(retryMaxMsRaw) || retryBaseMs) : 30_000;
  const retryJitterMsRaw = (process.env.VALUA_CODEX_RETRY_JITTER_MS || '').trim();
  const retryJitterMs = retryJitterMsRaw ? Math.max(0, Number(retryJitterMsRaw) || 0) : 250;
  const rateLimitMinMsRaw = (process.env.VALUA_CODEX_RATE_LIMIT_MIN_MS || '').trim();
  // When OpenAI returns "try again in 20ms", hammering immediately is counterproductive in a multi-agent cockpit.
  // Default to a small-but-visible delay so the system recovers without user intervention.
  const rateLimitMinMs = rateLimitMinMsRaw ? Math.max(0, Number(rateLimitMinMsRaw) || 0) : 10_000;
  const cooldownJitterMsRaw = (process.env.VALUA_CODEX_COOLDOWN_JITTER_MS || '').trim();
  const cooldownJitterMs = cooldownJitterMsRaw ? Math.max(0, Number(cooldownJitterMsRaw) || 0) : 200;

  const enforceTaskGitRef = isTruthyEnv(
    process.env.AGENTIC_ENFORCE_TASK_GIT_REF ||
      process.env.AGENTIC_AGENT_ENFORCE_TASK_GIT_REF ||
      process.env.VALUA_AGENT_ENFORCE_TASK_GIT_REF ||
      '0',
  );
  const integrationGateStrict = parseBooleanEnv(
    process.env.AGENTIC_INTEGRATION_GATE_STRICT ?? process.env.VALUA_INTEGRATION_GATE_STRICT ?? '1',
    true,
  );
  const allowTaskGitFetch = !(
    String(process.env.AGENTIC_TASK_GIT_ALLOW_FETCH ?? process.env.VALUA_TASK_GIT_ALLOW_FETCH ?? '')
      .trim()
      .toLowerCase() === '0'
  );
  const autoCleanDirtyExecuteWorktree = parseBooleanEnv(
    process.env.AGENTIC_EXEC_PREFLIGHT_AUTOCLEAN_DIRTY ??
      process.env.VALUA_EXEC_PREFLIGHT_AUTOCLEAN_DIRTY ??
      '0',
    true,
  );

  const warmStartEnabled = isTruthyEnv(
    process.env.AGENTIC_CODEX_WARM_START ?? process.env.VALUA_CODEX_WARM_START ?? '0',
  );
  const resetSessionsEnabled = isTruthyEnv(
    process.env.AGENTIC_CODEX_RESET_SESSIONS ?? process.env.VALUA_CODEX_RESET_SESSIONS ?? '0',
  );
  const runtimePolicySyncEnabled = parseBooleanEnv(
    process.env.AGENTIC_RUNTIME_POLICY_SYNC ?? process.env.VALUA_RUNTIME_POLICY_SYNC ?? '1',
    true,
  );
  const runtimePolicySyncVerbose = parseBooleanEnv(
    process.env.AGENTIC_RUNTIME_POLICY_SYNC_VERBOSE ?? process.env.VALUA_RUNTIME_POLICY_SYNC_VERBOSE ?? '0',
    false,
  );
  // Tunable for large policy/skill trees via *_RUNTIME_POLICY_SYNC_TIMEOUT_MS.
  const runtimePolicySyncTimeoutMs = Math.max(
    5_000,
    Number(
      process.env.AGENTIC_RUNTIME_POLICY_SYNC_TIMEOUT_MS ??
        process.env.VALUA_RUNTIME_POLICY_SYNC_TIMEOUT_MS ??
        '30000',
    ) || 30_000,
  );
  const workerLock = await acquireAgentWorkerLock({ busRoot, agentName });
  if (!workerLock.acquired) {
    const ownerMsg = workerLock.ownerPid ? ` (pid=${workerLock.ownerPid})` : '';
    writePane(`[worker] ${agentName} already running; exiting duplicate worker${ownerMsg}\n`);
    return;
  }

  try {
    const autopilotContextMode =
      normalizeAutopilotContextMode(
        process.env.AGENTIC_AUTOPILOT_CONTEXT_MODE ?? process.env.VALUA_AUTOPILOT_CONTEXT_MODE ?? '',
      ) || (warmStartEnabled ? 'auto' : 'full');

    // Optional: isolate Codex internal state/index per cockpit or per agent.
    // This reduces cross-project/session contamination and can reduce Codex rollout/index reconciliation noise.
    const codexHomeMode = normalizeCodexHomeMode(
      process.env.AGENTIC_CODEX_HOME_MODE ?? process.env.VALUA_CODEX_HOME_MODE ?? '',
    );
    const sourceCodexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    const codexHome =
      codexHomeMode === 'agent'
        ? path.join(busRoot, 'state', 'codex-home', agentName)
        : codexHomeMode === 'cockpit'
          ? path.join(busRoot, 'state', 'codex-home', 'cockpit')
          : null;
    if (codexHome) {
      await ensureCodexHome({ codexHome, sourceCodexHome, log: writePane });
    }
    const codexHomeBindXdg =
      codexHome &&
      parseBooleanEnv(
        process.env.AGENTIC_CODEX_HOME_BIND_XDG ?? process.env.VALUA_CODEX_HOME_BIND_XDG ?? '1',
        true,
      );
    const codexHomeEnv = codexHome ? { CODEX_HOME: codexHome } : {};
    if (codexHomeBindXdg) {
      codexHomeEnv.XDG_DATA_HOME = codexHome;
      codexHomeEnv.XDG_STATE_HOME = codexHome;
      codexHomeEnv.XDG_CACHE_HOME = path.join(codexHome, '.cache');
    }
    writePane(
      `[worker] ${agentName} codex env: HOME=${process.env.HOME || ''} CODEX_HOME=${
        codexHomeEnv.CODEX_HOME || process.env.CODEX_HOME || sourceCodexHome
      } mode=${codexHomeMode || 'default'}\n`,
    );

    const workdirForSync = path.resolve(workdir || repoRoot);
    const repoRootResolved = path.resolve(repoRoot);
    const runtimeProjectRoot = path.resolve(
      process.env.AGENTIC_PROJECT_ROOT?.trim() ||
        process.env.VALUA_REPO_ROOT?.trim() ||
        repoRootResolved,
    );
    // repoRootResolved is authoritative; if workdir already equals repo root, policy/skills are read there directly.
    // Sync is only needed when agent runs from a separate workdir/worktree copy.
    if (runtimePolicySyncEnabled && workdirForSync !== repoRootResolved) {
      const syncScript = path.join(cockpitRoot, 'scripts', 'agentic', 'sync-policy-to-worktrees.mjs');
      const syncArgs = [
        syncScript,
        '--repo-root',
        repoRootResolved,
        '--roster',
        rosterInfo.path,
        '--workdir',
        workdirForSync,
      ];
      const policySyncSourceRef = String(
        process.env.AGENTIC_POLICY_SYNC_SOURCE_REF ?? process.env.VALUA_POLICY_SYNC_SOURCE_REF ?? '',
      ).trim();
      if (policySyncSourceRef) syncArgs.push('--source-ref', policySyncSourceRef);
      if (worktreesDir) syncArgs.push('--worktrees-dir', worktreesDir);
      if (runtimePolicySyncVerbose) syncArgs.push('--verbose');
      try {
        const stdout = childProcess.execFileSync('node', syncArgs, {
          cwd: repoRootResolved,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: runtimePolicySyncTimeoutMs,
        });
        const summary = String(stdout || '')
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .slice(-1)[0];
        writePane(`[worker] ${agentName} policy sync: ${summary || 'ok'}\n`);
      } catch (err) {
        const timedOut = err?.code === 'ETIMEDOUT';
        const stderr = String(err?.stderr || '').trim();
        const stdout = String(err?.stdout || '').trim();
        const detail = timedOut
          ? `timed out after ${runtimePolicySyncTimeoutMs}ms`
          : stderr || stdout || (err?.message ? String(err.message) : 'failed');
        writePane(`[worker] ${agentName} policy sync warn: ${detail}\n`);
      }
    }

    let resetSessionsApplied = false;
    let appServerLegacyPinsCleared = false;
    let appServerProcessThreadId = null;
    let appServerResumeSkipLogged = false;

    while (true) {
      const idsInProgress = await listInboxTaskIds({ busRoot, agentName, state: 'in_progress' });
      const idsNew = await listInboxTaskIds({ busRoot, agentName, state: 'new' });
      const idsSeen = await listInboxTaskIds({ busRoot, agentName, state: 'seen' });
      const inProgressSet = new Set(idsInProgress);
      // Prefer resuming in_progress tasks first, then new, then seen.
      const ids = Array.from(new Set([...idsInProgress, ...idsNew, ...idsSeen]));

      for (const id of ids) {
      // Claim immediately (move to in_progress) to avoid double-processing.
      let opened = null;
      try {
        opened = inProgressSet.has(id)
          ? await openTask({ busRoot, agentName, taskId: id, markSeen: false })
          : await claimTask({ busRoot, agentName, taskId: id });
      } catch (err) {
        writePane(
          `WARN: could not claim task ${id} for ${agentName}: ${(err && err.message) || String(err)}\n`,
        );
        continue;
      }
      const taskKind = opened.meta?.signals?.kind ?? null;

      if (isAutopilot && normalizeTaskKind(taskKind) === 'OPUS_CONSULT_RESPONSE') {
        const consultPayload = isPlainObject(opened.meta?.references?.opus)
          ? opened.meta.references.opus
          : {};
        const orphanConsultId = readStringField(consultPayload?.consultId);
        const orphanRound = Math.max(1, Math.min(200, Number(consultPayload?.round) || 1));
        const orphanPhase = readStringField(opened.meta?.signals?.phase) || 'pre_exec';
        const existingResolution = orphanConsultId
          ? await readOpusConsultResolution({
              busRoot,
              consultId: orphanConsultId,
              phase: orphanPhase,
              round: orphanRound,
            })
          : null;
        const orphanReasonCode = existingResolution?.consumedResponseTaskId
          ? (
              existingResolution.source === 'synthetic'
                ? 'late_real_response_after_synthetic'
                : 'late_consult_response_superseded'
            )
          : 'opus_consult_protocol_invalid';
        await closeTask({
          busRoot,
          roster,
          agentName,
          taskId: readStringField(opened.meta?.id) || id,
          outcome: 'skipped',
          note: `orphan OPUS_CONSULT_RESPONSE packet consumed by autopilot runtime (${orphanReasonCode})`,
          commitSha: '',
          receiptExtra: {
            reasonCode: orphanReasonCode,
            consultResponseOrphan: true,
            consultId: orphanConsultId || null,
            round: orphanRound,
            phase: orphanPhase,
            canonicalResponseTaskId: readStringField(existingResolution?.consumedResponseTaskId) || null,
            canonicalSource: readStringField(existingResolution?.source) || null,
          },
          notifyOrchestrator: false,
        });
        continue;
      }

      {
        const title = truncateText(trimToOneLine(opened.meta?.title || ''), { maxLen: 120 });
        const prio = trimToOneLine(opened.meta?.priority || '') || 'P2';
        writePane(
          `[worker] ${agentName} task start ${id} (kind=${taskKind || 'unknown'} priority=${prio}) ${title}\n`,
        );
      }

      const outputDir = path.join(busRoot, 'artifacts', agentName);
      await fs.mkdir(outputDir, { recursive: true });
      const outputPath = path.join(outputDir, `${id}.codex.json`);

      let outcome = 'done';
      let note = '';
      let commitSha = '';
      const defaultReceiptExtra = {
        autopilotControl: null,
        runtimeGuard: null,
      };
      let receiptExtra = { ...defaultReceiptExtra };
      const taskCwd = workdir || repoRoot;
      const taskStartHead = safeExecText('git', ['rev-parse', 'HEAD'], { cwd: taskCwd }) || '';
      /** @type {any} */
      let lastGitPreflight = null;
      let lastPreflightCleanArtifactPath = null;
      let runtimeSkillProfile = 'default';
      let runtimeExecSkillSelected = false;
      /** @type {string[]} */
      let runtimeSkillsSelected = [];
      let runtimeSessionScope = 'task';
      let runtimeSessionRotated = false;
      let runtimeSessionRotationReason = '';
      let runtimeBranchContinuityGate = { status: 'pass', errors: [], applied: [] };
      const proactiveStatusSeen = new Set();
      let codeQualityRetryCount = 0;
      let consultDispositionRetryCount = 0;
      const gateRetryConsumption = {
        review: 0,
        code_quality: 0,
        consult_ack: 0,
      };
      let gateRetryConsumedTotal = 0;
      let opusGateEvidence = null;
      let opusPostReviewEvidence = null;
      let opusDecisionEvidence = null;
      let opusConsultAdvice = {
        mode: null,
        preExec: null,
        postReview: null,
      };
      let opusConsultBarrier = {
        locked: false,
        consultId: '',
        roundsUsed: 0,
        unlockReason: '',
      };
      let opusConsultTranscriptPath = null;
      const opusConsultTranscript = {
        preExec: null,
        postReview: null,
      };

      try {
        const statusThrottle = { ms: statusThrottleMs, lastSentAtByKey: new Map() };

        if (resetSessionsEnabled && !resetSessionsApplied) {
          resetSessionsApplied = true;
          writePane(`[worker] ${agentName} reset: clearing pinned codex sessions/state\n`);
          await clearAgentPinnedSessions({ busRoot, agentName });
        }

        const rootIdSignal =
          typeof opened?.meta?.signals?.rootId === 'string' ? opened.meta.signals.rootId.trim() : '';
        const focusRootId = rootIdSignal || readStringField(opened?.meta?.id) || null;
        const sessionRootId = rootIdSignal || null;
        const isRootScopedAutopilotSession =
          Boolean(isAutopilot && autopilotSessionScope === 'root' && sessionRootId);

        const sessionIdEnvRaw =
          (isAutopilot && (process.env.VALUA_AUTOPILOT_CODEX_SESSION_ID || process.env.VALUA_AUTOPILOT_SESSION_ID)) ||
          process.env.VALUA_CODEX_SESSION_ID ||
          '';
        const sessionIdEnv = normalizeResumeSessionId(sessionIdEnvRaw);
        if (appServerPersistEnabled && !appServerResumePersisted && !sessionIdEnv && !appServerLegacyPinsCleared) {
          appServerLegacyPinsCleared = true;
          await clearAgentPinnedSessions({ busRoot, agentName });
        }
        const sessionIdFile = normalizeResumeSessionId(await readSessionIdFile({ busRoot, agentName }));
        const sessionIdCfg = normalizeResumeSessionId(agentCfg?.sessionId);
        const taskSession = await readTaskSession({ busRoot, agentName, taskId: id });
        const rootSession =
          (isAutopilot ? sessionRootId : focusRootId) && (isRootScopedAutopilotSession || (warmStartEnabled && !isAutopilot))
            ? await readRootSession({ busRoot, agentName, rootId: isAutopilot ? sessionRootId : focusRootId })
            : null;
        let rootSessionTurnCount = Number(rootSession?.turnCount || 0);

        let resumeSessionId = null;
        if (isAutopilot && isRootScopedAutopilotSession) {
          runtimeSessionScope = 'root';
          if (autopilotSessionRotateTurns > 0 && rootSessionTurnCount >= autopilotSessionRotateTurns) {
            runtimeSessionRotated = true;
            runtimeSessionRotationReason = 'session_rotated_for_scope';
            rootSessionTurnCount = 0;
            resumeSessionId = null;
          } else {
            resumeSessionId = sessionIdEnv || sessionIdCfg || rootSession?.threadId || taskSession?.threadId || null;
          }
        } else if (isAutopilot) {
          runtimeSessionScope = 'task';
          resumeSessionId = sessionIdEnv || sessionIdCfg || taskSession?.threadId || null;
        } else if (warmStartEnabled) {
          // Prefer root-scoped continuity first (keeps multi-step workflows warm without mixing roots).
          runtimeSessionScope = focusRootId ? 'root' : 'task';
          resumeSessionId =
            sessionIdEnv ||
            sessionIdCfg ||
            rootSession?.threadId ||
            sessionIdFile ||
            taskSession?.threadId ||
            null;
        } else {
          runtimeSessionScope = 'task';
          resumeSessionId = sessionIdEnv || sessionIdFile || sessionIdCfg || taskSession?.threadId || null;
        }

        // Root cause guard: app-server default mode should reuse only in-process thread state.
        // Persisted pins are ignored unless explicitly enabled (AGENTIC_CODEX_APP_SERVER_RESUME_PERSISTED=1).
        if (
          appServerPersistEnabled &&
          !appServerResumePersisted &&
          !sessionIdEnv &&
          !(isAutopilot && runtimeSessionScope === 'root')
        ) {
          if (!appServerResumeSkipLogged && (sessionIdEnv || sessionIdFile || sessionIdCfg || taskSession?.threadId)) {
            appServerResumeSkipLogged = true;
            writePane(
              `[worker] ${agentName} app-server: ignoring persisted resume pins (resume persisted=off)\n`,
            );
          }
          resumeSessionId = appServerProcessThreadId;
        }

        let lastCodexThreadId = resumeSessionId || taskSession?.threadId || null;
        let promptBootstrap = warmStartEnabled ? await readPromptBootstrap({ busRoot, agentName }) : null;
        let parsedOutput = null;
        let reviewRetryReason = '';
        let codeQualityRetryReasonCode = '';
        let codeQualityRetryReason = '';
        let consultDispositionRetryReason = '';
        let lastCodeQualityRetrySignature = '';
        let runtimeReviewPrimedFor = null;
        let selfReviewRetryCommitSha = '';
        let selfReviewRetryCount = 0;
        const canConsumeGateRetry = (category, maxPerCategory = 1) => {
          const key = readStringField(category);
          if (!key) return false;
          if (gateRetryConsumedTotal >= combinedGateRetryBudget) return false;
          if ((gateRetryConsumption[key] || 0) >= Math.max(0, Number(maxPerCategory) || 0)) return false;
          gateRetryConsumption[key] = (gateRetryConsumption[key] || 0) + 1;
          gateRetryConsumedTotal += 1;
          return true;
        };
        let attempt = 0;
        let taskCanceled = false;
        let canceledNote = '';
        let preExecConsultCached = null;

        await maybeEmitAutopilotRootStatus({
          enabled: isAutopilot && autopilotProactiveStatusEnabled,
          busRoot,
          roster,
          fromAgent: agentName,
          priority: opened.meta?.priority || 'P2',
          rootId: focusRootId,
          parentId: opened.meta?.id || null,
          state: 'accepted',
          phase: 'task_start',
          nextAction: 'processing',
          idempotency: proactiveStatusSeen,
          throttle: statusThrottle,
        });

        taskRunLoop: while (true) {
          while (true) {
            attempt += 1;

          const stillQueued = await isTaskInInboxStates({ busRoot, agentName, taskId: id });
          if (!stillQueued) {
            taskCanceled = true;
            canceledNote = 'task canceled while running (no longer in inbox states)';
            break;
          }

          // Cross-agent global cooldown (written when any worker is rate-limited).
          await waitForGlobalCooldown({
            busRoot,
            roster,
            fromAgent: agentName,
            openedMeta: opened.meta,
            throttle: statusThrottle,
            jitterMs: cooldownJitterMs,
          });

          let slot = null;

          try {
            // Reload task packet each attempt so AgentBus `update` changes are applied immediately.
            opened = await openTask({ busRoot, agentName, taskId: id, markSeen: false });
            const taskKindNow = opened.meta?.signals?.kind ?? null;
            const isSmokeNow = Boolean(opened.meta?.signals?.smoke);
            const userRequestedReviewGate =
              codexEngine === 'app-server'
                ? inferUserRequestedReviewGate({
                    taskKind: taskKindNow,
                    taskMeta: opened.meta,
                    taskMarkdown: opened.markdown,
                    cwd: taskCwd,
                  })
                : { requested: false, targetCommitSha: '', targetCommitShas: [], resolutionError: '' };
            let reviewGateNow = deriveReviewGate({
              isAutopilot,
              taskKind: taskKindNow,
              taskMeta: opened.meta,
              userRequestedReview: userRequestedReviewGate.requested,
              userRequestedReviewTargetCommitSha: userRequestedReviewGate.targetCommitSha,
              userRequestedReviewTargetCommitShas: userRequestedReviewGate.targetCommitShas,
              userRequestedReviewResolutionError: userRequestedReviewGate.resolutionError,
            });
            if (isAutopilot && selfReviewRetryCommitSha && codexEngine === 'app-server') {
              reviewGateNow = {
                ...reviewGateNow,
                required: true,
                userRequested: true,
                targetCommitSha: selfReviewRetryCommitSha,
                targetCommitShas: [selfReviewRetryCommitSha],
                scope: 'commit',
              };
            }
            const skillOpsGateNow = deriveSkillOpsGate({
              isAutopilot,
              taskKind: taskKindNow,
              env: process.env,
            });
            const codeQualityGateNow = deriveCodeQualityGate({
              isAutopilot,
              taskKind: taskKindNow,
              env: process.env,
            });
            const observerDrainGateNow = deriveObserverDrainGate({
              isAutopilot,
              taskKind: taskKindNow,
              taskMeta: opened?.meta,
              env: process.env,
            });
            const opusGateNow = deriveOpusConsultGate({
              isAutopilot,
              taskKind: taskKindNow,
              roster,
              env: process.env,
            });

            if (opusGateNow.preExecRequired) {
              opusConsultBarrier = {
                locked: Boolean(opusGateNow.consultMode === 'gate' && opusGateNow.enforcePreExecBarrier),
                consultId: '',
                roundsUsed: 0,
                unlockReason: '',
              };
              let phaseA = preExecConsultCached;
              if (!phaseA) {
                phaseA = await runOpusConsultPhase({
                  busRoot,
                  roster,
                  agentName,
                  openedMeta: opened.meta,
                  taskMarkdown: opened.markdown,
                  taskKind: taskKindNow,
                  gate: opusGateNow,
                  phase: 'pre_exec',
                  candidateOutput: null,
                });
                preExecConsultCached = phaseA;
              }
              opusConsultBarrier.consultId = readStringField(phaseA?.consultId);
              opusConsultBarrier.roundsUsed = Number(phaseA?.roundsUsed) || 0;
              opusConsultTranscript.preExec = {
                consulted: true,
                ...phaseA,
              };
              const phaseAVerdict = readStringField(phaseA?.finalResponse?.verdict);
              const phaseAStatus = !phaseA?.ok
                ? (opusGateNow.consultMode === 'gate' ? 'blocked' : 'warn')
                : (phaseAVerdict === 'warn' ? 'warn' : 'pass');
              opusGateEvidence = {
                enabled: true,
                required: true,
                phase: 'pre_exec',
                consultAgent: opusGateNow.consultAgent,
                consultMode: readStringField(opusGateNow?.consultMode) || 'advisory',
                protocolMode: readStringField(phaseA?.protocolMode) || readStringField(opusGateNow?.protocolMode) || 'freeform_only',
                consultId: readStringField(phaseA?.consultId) || null,
                roundsUsed: Number(phaseA?.roundsUsed) || 0,
                verdict: readStringField(phaseA?.finalResponse?.verdict) || null,
                reasonCode: readStringField(phaseA?.reasonCode) || null,
                status: phaseAStatus,
              };
              opusDecisionEvidence = {
                preExec: phaseA?.decision ?? {
                  acceptedSuggestions: [],
                  rejectedSuggestions: [],
                  rejectionRationale: '',
                },
                postReview: null,
              };
              opusConsultAdvice = {
                ...opusConsultAdvice,
                mode: readStringField(opusGateNow?.consultMode) || 'advisory',
                preExec: buildOpusConsultAdvice({
                  mode: readStringField(opusGateNow?.consultMode) || 'advisory',
                  phaseResult: phaseA,
                  phase: 'pre_exec',
                }),
              };
              if (!phaseA.ok) {
                const reasonCode = readStringField(phaseA?.reasonCode) || 'opus_consult_block';
                const enforced = Boolean(opusGateNow.consultMode === 'gate' && opusGateNow.enforcePreExecBarrier);
                opusConsultBarrier.locked = enforced;
                opusConsultBarrier.unlockReason = enforced
                  ? reasonCode
                  : `pre_exec_not_enforced:${reasonCode}`;
                opusGateEvidence.status = enforced ? 'blocked' : 'warn';
                opusGateEvidence.reasonCode = reasonCode;
                opusGateEvidence.enforced = enforced;
                if (enforced) {
                  throw new OpusConsultBlockedError(`Opus pre-exec consult blocked: ${phaseA?.note || phaseA?.reasonCode || 'unknown'}`, {
                    phase: 'pre_exec',
                    reasonCode,
                    details: phaseA,
                  });
                }
              } else if (phaseAStatus === 'warn') {
                opusConsultBarrier.locked = false;
                opusConsultBarrier.unlockReason = 'opus_pre_exec_consult_warn_non_blocking';
              }
              if (!opusConsultBarrier.unlockReason) {
                opusConsultBarrier.locked = false;
                opusConsultBarrier.unlockReason = 'opus_pre_exec_consult_finalized';
              }
            } else {
              preExecConsultCached = null;
              opusGateEvidence = {
                enabled: Boolean(opusGateNow.preExecEnabled),
                required: false,
                phase: 'pre_exec',
                consultAgent: opusGateNow.consultAgent || null,
                consultMode: readStringField(opusGateNow?.consultMode) || 'advisory',
                protocolMode: readStringField(opusGateNow?.protocolMode) || 'freeform_only',
                status: 'skipped',
              };
              opusConsultBarrier = {
                locked: false,
                consultId: '',
                roundsUsed: 0,
                unlockReason: 'not_required',
              };
              opusConsultAdvice = {
                ...opusConsultAdvice,
                mode: readStringField(opusGateNow?.consultMode) || 'advisory',
                preExec: buildOpusConsultAdvice({
                  mode: readStringField(opusGateNow?.consultMode) || 'advisory',
                  phaseResult: null,
                  phase: 'pre_exec',
                }),
              };
            }

            // Optional: fast-path some controller digests without invoking the model.
            // Guarded behind an allowlist; default off.
            const fastpathEnabled = isTruthyEnv(
              process.env.AGENTIC_AUTOPILOT_DIGEST_FASTPATH ?? process.env.VALUA_AUTOPILOT_DIGEST_FASTPATH ?? '0',
            );
            if (fastpathEnabled && isAutopilot && taskKindNow === 'ORCHESTRATOR_UPDATE' && !reviewGateNow.required) {
              const allowRaw = String(
                process.env.AGENTIC_AUTOPILOT_DIGEST_FASTPATH_ALLOWLIST ??
                  process.env.VALUA_AUTOPILOT_DIGEST_FASTPATH_ALLOWLIST ??
                  '',
              ).trim();
              const allow = new Set(allowRaw.split(',').map((s) => s.trim()).filter(Boolean));
              const sourceKind =
                typeof opened?.meta?.signals?.sourceKind === 'string' ? opened.meta.signals.sourceKind.trim() : '';
              const completedTaskKind =
                typeof opened?.meta?.references?.completedTaskKind === 'string'
                  ? opened.meta.references.completedTaskKind.trim()
                  : '';
              const sourceReceiptOutcome =
                typeof opened?.meta?.references?.receiptOutcome === 'string'
                  ? opened.meta.references.receiptOutcome.trim().toLowerCase()
                  : '';
              const nonDoneCompletionDigest =
                sourceKind === 'TASK_COMPLETE' &&
                Boolean(sourceReceiptOutcome) &&
                sourceReceiptOutcome !== 'done';

              const key = `${sourceKind}:${completedTaskKind || '*'}`;
              const keyAny = `${sourceKind}:*`;
              if (sourceKind && !nonDoneCompletionDigest && (allow.has(key) || allow.has(keyAny))) {
                await writeJsonAtomic(outputPath, {
                  outcome: 'done',
                  note: `fastpath ack (${key})`,
                  commitSha: '',
                  followUps: [],
                });
                writePane(`[worker] ${agentName} fastpath: skipped codex for ${key}\n`);
                break;
              }
            }

            const gitContract = readTaskGitContract(opened.meta);
            try {
              const incomingRootId =
                readStringField(opened?.meta?.signals?.rootId);
              const focusState = await readAgentRootFocus({ busRoot, agentName });
              const dirtySnapshot = getGitSnapshot({ cwd: taskCwd });
              const statusPorcelain = readStringField(dirtySnapshot?.statusPorcelain);
              const blockingDirtyStatus = summarizeCrossRootBlockingStatus(statusPorcelain);
              if (
                incomingRootId &&
                focusState?.rootId &&
                focusState.rootId !== incomingRootId &&
                Boolean(blockingDirtyStatus)
              ) {
                throw new TaskGitPreflightBlockedError(
                  'dirty cross-root transition: worktree has uncommitted changes from another root',
                  {
                    cwd: taskCwd,
                    taskKind: taskKindNow,
                    contract: gitContract,
                    details: {
                      reasonCode: 'dirty_cross_root_transition',
                      previousRootId: focusState.rootId,
                      incomingRootId,
                      statusPorcelain: blockingDirtyStatus.slice(0, 2000),
                    },
                  },
                );
              }
              lastPreflightCleanArtifactPath = null;
              lastGitPreflight = ensureTaskGitContract({
                cwd: taskCwd,
                taskKind: taskKindNow,
                contract: gitContract,
                enforce: enforceTaskGitRef,
                allowFetch: allowTaskGitFetch,
                autoCleanDirtyExecute: autoCleanDirtyExecuteWorktree,
                log: writePane,
              });
              if (lastGitPreflight?.autoCleaned) {
                const cleanArtifact = await materializePreflightCleanArtifact({
                  busRoot,
                  agentName,
                  taskId: id,
                  taskMeta: opened?.meta,
                  preflight: lastGitPreflight,
                });
                lastPreflightCleanArtifactPath = cleanArtifact?.relativePath || null;
              }
            } catch (err) {
              if (err instanceof TaskGitPreflightBlockedError) throw err;
              throw new TaskGitPreflightBlockedError('Git preflight failed', {
                cwd: taskCwd,
                taskKind: taskKindNow,
                contract: gitContract,
                details: { error: (err && err.message) || String(err) },
              });
            }

            const skillSelection = selectSkills({
              skills: agentCfg.skills || [],
              taskKind: taskKindNow,
              isSmoke: isSmokeNow,
              isAutopilot,
              env: process.env,
            });
            const skillsSelected = Array.isArray(skillSelection?.skillsSelected) ? skillSelection.skillsSelected : [];
            runtimeSkillsSelected = skillsSelected.slice();
            runtimeSkillProfile = readStringField(skillSelection?.skillProfile) || (isAutopilot ? 'controller' : 'default');
            runtimeExecSkillSelected = skillSelection?.execSkillSelected === true;
            const skillsHash = await computeSkillsHash(skillsSelected, { taskCwd });

            const warmResumeOk =
              warmStartEnabled &&
              typeof resumeSessionId === 'string' &&
              resumeSessionId !== 'last' &&
              promptBootstrap?.threadId === resumeSessionId &&
              promptBootstrap?.skillsHash === skillsHash;
            const includeSkills = !warmResumeOk;

            const contextBlock = isAutopilot
              ? await (async () => {
                  if (autopilotContextMode === 'full') {
                    return await buildAutopilotContextBlock({
                      repoRoot,
                      busRoot,
                      roster,
                      taskMeta: opened.meta,
                      agentName,
                    });
                  }

                  if (autopilotContextMode === 'thin') {
                    return await buildAutopilotContextBlockThin({
                      repoRoot,
                      busRoot,
                      roster,
                      taskMeta: opened.meta,
                      agentName,
                    });
                  }

                  // auto: thin context only for warm-resumed ORCHESTRATOR_UPDATE packets.
                  const shouldThin = warmResumeOk && taskKindNow === 'ORCHESTRATOR_UPDATE';
                  return await (shouldThin ? buildAutopilotContextBlockThin : buildAutopilotContextBlock)({
                    repoRoot,
                    busRoot,
                    roster,
                    taskMeta: opened.meta,
                    agentName,
                  });
                })()
              : buildBasicContextBlock({ workdir });
            const gitBlock = buildGitContractBlock({ contract: gitContract });
            const combinedContextBlock = gitBlock ? `${contextBlock}\n\n${gitBlock}` : contextBlock;

            const prompt = buildPrompt({
              agentName,
              skillsSelected,
              includeSkills,
              taskKind: taskKindNow,
              isSmoke: isSmokeNow,
              isAutopilot,
              reviewGate: reviewGateNow,
              reviewRetryReason,
              codeQualityRetryReasonCode,
              codeQualityRetryReason,
              consultDispositionRetryReason,
              skillOpsGate: skillOpsGateNow,
              codeQualityGate: codeQualityGateNow,
              observerDrainGate: observerDrainGateNow,
              taskMarkdown: opened.markdown,
              contextBlock: combinedContextBlock,
              cockpitRoot,
            });

            if (!slot) {
              slot = await acquireGlobalSemaphoreSlot({
                busRoot,
                name: `${agentName}:${id}`,
                maxSlots: globalMaxInflight,
              });
            }
            const taskStat = await fs.stat(opened.path);

            writePane(
              `[worker] ${agentName} codex ${codexEngine} attempt=${attempt}${resumeSessionId ? ` resume=${resumeSessionId}` : ''}\n`,
            );
            if (reviewGateNow.required && runtimeReviewPrimedFor !== reviewGatePrimeKey(reviewGateNow)) {
              await maybeEmitAutopilotRootStatus({
                enabled: isAutopilot && autopilotProactiveStatusEnabled,
                busRoot,
                roster,
                fromAgent: agentName,
                priority: opened.meta?.priority || 'P2',
                rootId: opened.meta?.signals?.rootId ?? opened.meta?.id ?? null,
                parentId: opened.meta?.id ?? null,
                state: 'review_started',
                phase: 'review',
                nextAction: 'run_builtin_review',
                idempotency: proactiveStatusSeen,
                throttle: statusThrottle,
              });
            }
            // Avoid reading stale output if a prior attempt produced a file.
            try {
              await fs.rm(outputPath, { force: true });
            } catch {
              // ignore
            }

            const res =
              codexEngine === 'app-server'
                ? await runCodexAppServer({
                    codexBin,
                    repoRoot,
                    workdir,
                    schemaPath,
                    outputPath,
                    prompt,
                    watchFilePath: opened.path,
                    watchFileMtimeMs: taskStat.mtimeMs,
                    resumeSessionId,
                    reviewGate:
                      reviewGateNow.required &&
                      runtimeReviewPrimedFor !== reviewGatePrimeKey(reviewGateNow)
                        ? reviewGateNow
                        : null,
                    extraEnv: { ...guardEnv, ...codexHomeEnv },
                    dangerFullAccess: autopilotDangerFullAccess,
                  })
                : await runCodexExec({
                    codexBin,
                    repoRoot,
                    workdir,
                    schemaPath,
                    outputPath,
                    prompt,
                    watchFilePath: opened.path,
                    watchFileMtimeMs: taskStat.mtimeMs,
                    resumeSessionId,
                    jsonEvents: false,
                    extraEnv: { ...guardEnv, ...codexHomeEnv },
                    dangerFullAccess: autopilotDangerFullAccess,
                  });

            if (res?.threadId && typeof res.threadId === 'string') {
              lastCodexThreadId = res.threadId;
              await writeTaskSession({ busRoot, agentName, taskId: id, threadId: res.threadId });
            }
            if (reviewGateNow.required) {
              runtimeReviewPrimedFor = reviewGatePrimeKey(reviewGateNow);
              await maybeEmitAutopilotRootStatus({
                enabled: isAutopilot && autopilotProactiveStatusEnabled,
                busRoot,
                roster,
                fromAgent: agentName,
                priority: opened.meta?.priority || 'P2',
                rootId: opened.meta?.signals?.rootId ?? opened.meta?.id ?? null,
                parentId: opened.meta?.id ?? null,
                state: 'review_completed',
                phase: 'review',
                nextAction: 'evaluate_closure',
                idempotency: proactiveStatusSeen,
                throttle: statusThrottle,
              });
            }
            if (res?.threadId && typeof res.threadId === 'string') {
              writePane(`[worker] ${agentName} codex thread=${res.threadId}\n`);
            }

            if (warmStartEnabled && res?.threadId && typeof res.threadId === 'string') {
              await writePromptBootstrap({ busRoot, agentName, threadId: res.threadId, skillsHash });
              promptBootstrap = { threadId: res.threadId, skillsHash, path: null, payload: null };
            }

            if (
              res?.threadId &&
              typeof res.threadId === 'string' &&
              ((isAutopilot && runtimeSessionScope === 'root') || (warmStartEnabled && !isAutopilot))
            ) {
              const rootIdNowSignal =
                typeof opened?.meta?.signals?.rootId === 'string' ? opened.meta.signals.rootId.trim() : '';
              const focusRootIdNow = rootIdNowSignal || readStringField(opened?.meta?.id) || null;
              const rootSessionIdNow = isAutopilot ? rootIdNowSignal : focusRootIdNow;
              if (rootSessionIdNow) {
                rootSessionTurnCount = Math.max(0, Number(rootSessionTurnCount) || 0) + 1;
                await writeRootSession({
                  busRoot,
                  agentName,
                  rootId: rootSessionIdNow,
                  threadId: res.threadId,
                  turnCount: rootSessionTurnCount,
                });
              }
            }

            // Session persistence / stale-pin self-heal:
            // - If not explicitly configured via env/roster, align the persisted session-id with
            //   the latest successful thread for:
            //   1) autopilot (always), and
            //   2) non-autopilot warm-start workers (non-smoke).
            // This prevents repeated stale-resume churn across all agents.
            const successfulThreadId = normalizeResumeSessionId(res?.threadId);
            if (appServerPersistEnabled && !appServerResumePersisted && successfulThreadId) {
              appServerProcessThreadId = successfulThreadId;
            }
            const allowSessionRepin =
              !sessionIdEnv &&
              !sessionIdCfg &&
              (isAutopilot ? runtimeSessionScope !== 'root' : warmStartEnabled && !isSmokeNow);
            const allowPersistedPinWrite =
              !appServerPersistEnabled || appServerResumePersisted || Boolean(sessionIdEnv);
            if (
              allowSessionRepin &&
              allowPersistedPinWrite &&
              successfulThreadId &&
              successfulThreadId !== sessionIdFile
            ) {
              await writeSessionIdFile({ busRoot, agentName, sessionId: successfulThreadId });
            }

            const rawOutput = await fs.readFile(outputPath, 'utf8');
            let parsedCandidate = null;
            try {
              parsedCandidate = JSON.parse(rawOutput);
            } catch (err) {
              throw new CodexExecError(`codex output parse failed: ${(err && err.message) || String(err)}`, {
                exitCode: 1,
                stderrTail: '',
                stdoutTail: rawOutput.slice(-16_000),
                threadId: res?.threadId || null,
              });
            }

            const reviewValidation = validateAutopilotReviewOutput({
              parsed: parsedCandidate,
              reviewGate: reviewGateNow,
              busRoot,
              agentName,
              taskId: id,
            });
            if (!reviewValidation.ok) {
              const reason = reviewValidation.errors.join('; ');
              if (
                reviewGateNow.required &&
                !reviewRetryReason &&
                canConsumeGateRetry('review', 1)
              ) {
                reviewRetryReason = reason;
                writePane(`[worker] ${agentName} review gate retry: ${reason}\n`);
                continue;
              }
              throw new CodexExecError(`review gate validation failed: ${reason}`, {
                exitCode: 1,
                stderrTail: reason,
                stdoutTail: rawOutput.slice(-16_000),
                threadId: res?.threadId || null,
              });
            }

            if (isAutopilot && autopilotSelfReviewGateEnabled && normalizeTaskKind(taskKindNow) === 'USER_REQUEST') {
              const candidateOutcome = readStringField(parsedCandidate?.outcome) || 'done';
              const candidateCommitSha = readStringField(parsedCandidate?.commitSha);
              const candidateControl = normalizeAutopilotControl(parsedCandidate?.autopilotControl);
              let candidateDelta = null;
              try {
                candidateDelta = computeSourceDeltaSummary({ cwd: taskCwd, commitSha: candidateCommitSha });
              } catch (err) {
                if (err?.reasonCode !== 'source_delta_commit_unavailable') throw err;
                candidateDelta = {
                  changedFiles: [],
                  sourceFiles: [],
                  sourceFilesCount: 0,
                  sourceLineDelta: 0,
                  dependencyOrLockfileChanged: false,
                  controlPlaneChanged: false,
                  artifactOnlyChange: false,
                  noSourceChange: true,
                };
              }
              const hasSourceDelta = candidateDelta.sourceFilesCount > 0;
              const runtimePrimedForCommit = runtimeReviewPrimedFor === candidateCommitSha;
              if (
                candidateOutcome === 'done' &&
                candidateCommitSha &&
                hasSourceDelta &&
                candidateControl.executionMode === 'tiny_fixup' &&
                codexEngine === 'app-server' &&
                !runtimePrimedForCommit &&
                selfReviewRetryCount < 1
              ) {
                selfReviewRetryCommitSha = candidateCommitSha;
                selfReviewRetryCount += 1;
                reviewRetryReason = `self-review required for commit ${candidateCommitSha}`;
                await maybeEmitAutopilotRootStatus({
                  enabled: autopilotProactiveStatusEnabled,
                  busRoot,
                  roster,
                  fromAgent: agentName,
                  priority: opened.meta?.priority || 'P2',
                  rootId: opened.meta?.signals?.rootId ?? opened.meta?.id ?? null,
                  parentId: opened.meta?.id ?? null,
                  state: 'retrying',
                  phase: 'self_review',
                  reasonCode: 'review_lifecycle_incomplete',
                  nextAction: 'rerun_with_builtin_review',
                  idempotency: proactiveStatusSeen,
                  throttle: statusThrottle,
                });
                writePane(`[worker] ${agentName} self-review retry for commit ${candidateCommitSha}\n`);
                continue;
              }
            }
            reviewRetryReason = '';
            parsedOutput = parsedCandidate;

            break;
          } catch (err) {
            if (err instanceof CodexExecSupersededError) {
              preExecConsultCached = null;
              if (!resumeSessionId && err.threadId) {
                resumeSessionId = err.threadId;
                lastCodexThreadId = err.threadId;
                await writeTaskSession({ busRoot, agentName, taskId: id, threadId: err.threadId });
              }
              writePane(`[worker] ${agentName} task updated; restarting codex exec\n`);
              continue;
            }

            if (err instanceof CodexExecError) {
              const combined = `${err.message}\n${err.stderrTail || ''}\n${err.stdoutTail || ''}`;
                const isRateLimited = isOpenAIRateLimitText(combined);
                const isStreamDisconnected = isStreamDisconnectedText(combined);
                const retryAfterMs = parseRetryAfterMs(combined);
                const shouldRetry = isRateLimited || isStreamDisconnected;

              if (shouldRetry) {
                const backoffMs = computeBackoffMs(attempt, { baseMs: retryBaseMs, maxMs: retryMaxMs, jitterMs: retryJitterMs });
                const waitMs = Math.max(0, retryAfterMs ?? 0, backoffMs, isRateLimited ? rateLimitMinMs : 0);
                const retryAtMs = Date.now() + waitMs;

                if (!resumeSessionId && err.threadId) {
                  resumeSessionId = err.threadId;
                  lastCodexThreadId = err.threadId;
                  await writeTaskSession({ busRoot, agentName, taskId: id, threadId: err.threadId });
                }

                if (isRateLimited) {
                  const reason = combined.trim().slice(0, 500);
                  await writeGlobalCooldown({
                    busRoot,
                    retryAtMs,
                    reason,
                    sourceAgent: agentName,
                    taskId: id,
                  });
                }

                await maybeSendStatusToDaddy({
                  busRoot,
                  roster,
                  fromAgent: agentName,
                  priority: opened.meta?.priority || 'P2',
                  rootId: opened.meta?.signals?.rootId ?? opened.meta?.id ?? null,
                  parentId: opened.meta?.id ?? null,
                  title: `STATUS: waiting on RPM reset (${agentName})`,
                  body:
                    `codex exec hit a transient rate limit / stream disconnect.\n\n` +
                    `Agent: ${agentName}\n` +
                    `Task: ${id}\n` +
                    (lastCodexThreadId ? `Codex thread: ${lastCodexThreadId}\n` : '') +
                    `Attempt: ${attempt}\n` +
                    `Next retry: ${new Date(retryAtMs).toISOString()}\n` +
                    (retryAfterMs != null ? `Retry-After: ${retryAfterMs}ms\n` : '') +
                    `\n(Worker will auto-retry.)\n`,
                  throttle: statusThrottle,
                });

                await sleep(waitMs);
                continue;
              }
            }

            throw err;
          } finally {
            if (slot) await slot.release();
          }
          }

          if (taskCanceled) {
          outcome = 'skipped';
          note = canceledNote;
          receiptExtra = {
            ...defaultReceiptExtra,
            skippedReason: 'not_in_inbox_states',
          };
          await deleteTaskSession({ busRoot, agentName, taskId: id });
            break taskRunLoop;
          } else {
        const parsed = parsedOutput ?? JSON.parse(await fs.readFile(outputPath, 'utf8'));
        const userRequestedReviewGateForValidation =
          codexEngine === 'app-server'
            ? inferUserRequestedReviewGate({
                taskKind: opened?.meta?.signals?.kind ?? taskKind,
                taskMeta: opened?.meta,
                taskMarkdown: opened?.markdown || '',
                cwd: taskCwd,
              })
            : { requested: false, targetCommitSha: '', targetCommitShas: [], resolutionError: '' };
        const reviewGate = deriveReviewGate({
          isAutopilot,
          taskKind: opened?.meta?.signals?.kind ?? taskKind,
          taskMeta: opened?.meta,
          userRequestedReview: userRequestedReviewGateForValidation.requested,
          userRequestedReviewTargetCommitSha: userRequestedReviewGateForValidation.targetCommitSha,
          userRequestedReviewTargetCommitShas: userRequestedReviewGateForValidation.targetCommitShas,
          userRequestedReviewResolutionError: userRequestedReviewGateForValidation.resolutionError,
        });
        const skillOpsGate = deriveSkillOpsGate({
          isAutopilot,
          taskKind: opened?.meta?.signals?.kind ?? taskKind,
          env: process.env,
        });
        const codeQualityGate = deriveCodeQualityGate({
          isAutopilot,
          taskKind: opened?.meta?.signals?.kind ?? taskKind,
          env: process.env,
        });
        const observerDrainGate = deriveObserverDrainGate({
          isAutopilot,
          taskKind: opened?.meta?.signals?.kind ?? taskKind,
          taskMeta: opened?.meta,
          env: process.env,
        });
        const opusGate = deriveOpusConsultGate({
          isAutopilot,
          taskKind: opened?.meta?.signals?.kind ?? taskKind,
          roster,
          env: process.env,
        });

        // Normalize some common fields.
        outcome = typeof parsed.outcome === 'string' ? parsed.outcome : 'done';
        note = typeof parsed.note === 'string' ? parsed.note : '';
        commitSha = typeof parsed.commitSha === 'string' ? parsed.commitSha : '';
        const taskKindCurrent = String(opened?.meta?.signals?.kind ?? taskKind ?? '')
          .trim()
          .toUpperCase();
        const postMergeResyncGate = derivePostMergeResyncGate({ isAutopilot, env: process.env });
        const parsedAutopilotControl = normalizeAutopilotControl(parsed?.autopilotControl);
        const postMergeResyncTrigger = classifyPostMergeResyncTrigger({
          taskTitle: opened?.meta?.title,
          taskBody: opened?.markdown,
          note,
          commitSha,
        });
        let sourceDelta = null;
        try {
          sourceDelta = computeSourceDeltaSummary({ cwd: taskCwd, commitSha });
        } catch (err) {
          if (err?.reasonCode !== 'source_delta_commit_unavailable') throw err;
          if (!postMergeResyncTrigger.shouldRun) throw err;
          sourceDelta = {
            changedFiles: [],
            sourceFiles: [],
            sourceFilesCount: 0,
            sourceLineDelta: 0,
            dependencyOrLockfileChanged: false,
            controlPlaneChanged: false,
            artifactOnlyChange: false,
            noSourceChange: true,
            inspectError: {
              reasonCode: 'source_delta_commit_unavailable',
              details: isPlainObject(err?.details) ? err.details : {},
            },
          };
        }
        const sourceCodeChanged = sourceDelta.sourceFilesCount > 0;
        const parsedFollowUps = Array.isArray(parsed.followUps) ? parsed.followUps : [];
        const hasExecuteFollowUp = parsedFollowUps.some(
          (fu) => normalizeTaskKind(fu?.signals?.kind) === 'EXECUTE',
        );
        const preExecAdviceItems = Array.isArray(opusConsultAdvice?.preExec?.items)
          ? opusConsultAdvice.preExec.items
          : [];
        const requiredOpusDispositionIds = preExecAdviceItems
          .map((item) => readStringField(item?.id))
          .filter(Boolean);
        const opusDispositionValidation = validateOpusDispositions({
          noteText: note,
          requiredIds: requiredOpusDispositionIds,
        });
        let opusDispositionAutoApplied = false;
        if (isAutopilot && outcome === 'done' && requiredOpusDispositionIds.length > 0 && !opusDispositionValidation.ok) {
          const dispositionReason = [
            opusDispositionValidation.parseErrors.length > 0
              ? `parse=${opusDispositionValidation.parseErrors.join(' | ')}`
              : '',
            opusDispositionValidation.missingIds.length > 0
              ? `missing=${opusDispositionValidation.missingIds.join(',')}`
              : '',
          ].filter(Boolean).join('; ');
          if (
            consultDispositionRetryCount < consultDispositionRetries &&
            canConsumeGateRetry('consult_ack', consultDispositionRetries)
          ) {
            consultDispositionRetryCount += 1;
            consultDispositionRetryReason = dispositionReason || 'opus_dispositions_missing';
            await maybeEmitAutopilotRootStatus({
              enabled: autopilotProactiveStatusEnabled,
              busRoot,
              roster,
              fromAgent: agentName,
              priority: opened.meta?.priority || 'P2',
              rootId: opened.meta?.signals?.rootId ?? opened.meta?.id ?? null,
              parentId: opened.meta?.id ?? null,
              state: 'retrying',
              phase: 'opus_ack',
              reasonCode: 'opus_disposition_ack_missing',
              nextAction: 'rerun_with_opus_dispositions',
              idempotency: proactiveStatusSeen,
              throttle: statusThrottle,
            });
            writePane(
              `[worker] ${agentName} opus disposition retry ${consultDispositionRetryCount}/${consultDispositionRetries}: ${consultDispositionRetryReason}\n`,
            );
            parsedOutput = null;
            continue taskRunLoop;
          }
          const missingEntries = preExecAdviceItems.filter((item) =>
            opusDispositionValidation.missingIds.includes(readStringField(item?.id)),
          );
          const autoDispositionLines = missingEntries.map((item) => {
            const itemId = readStringField(item?.id);
            const itemText = readStringField(item?.text).slice(0, 240);
            return [
              itemId || 'OPUS-UNKNOWN',
              'deferred',
              encodeOpusDispositionField('runtime_auto_fallback'),
              encodeOpusDispositionField(itemText || 'auto-annotated fallback because explicit disposition was missing'),
            ].join('|');
          });
          if (autoDispositionLines.length > 0) {
            const trimmed = String(note || '').trim();
            const suffix = ['OPUS_DISPOSITIONS:', ...autoDispositionLines].join('\n');
            note = trimmed ? `${trimmed}\n${suffix}` : suffix;
            opusDispositionAutoApplied = true;
          }
          consultDispositionRetryReason = '';
        } else {
          consultDispositionRetryReason = '';
        }
        parsed.runtimeGuard = {
          ...(parsed.runtimeGuard && typeof parsed.runtimeGuard === 'object' ? parsed.runtimeGuard : {}),
          opusDisposition: {
            requiredCount: requiredOpusDispositionIds.length,
            requiredIds: requiredOpusDispositionIds,
            acknowledgedIds: opusDispositionValidation.entries.map((entry) => entry.id),
            missingIds: opusDispositionValidation.missingIds,
            parseErrors: opusDispositionValidation.parseErrors,
            retryCount: consultDispositionRetryCount,
            autoApplied: opusDispositionAutoApplied,
          },
        };
        const delegatedCompletion = hasDelegatedCompletionEvidence({
          taskMeta: opened?.meta,
          workstream: parsedAutopilotControl.workstream || 'main',
        });

        if (taskKindCurrent === 'PLAN_REQUEST') {
          // Plan tasks must not claim commits.
          commitSha = '';
        }

        if (isAutopilot && reviewGate.required && outcome === 'done' && codexEngine !== 'app-server') {
          outcome = 'blocked';
          note = appendReasonNote(note, 'engine_not_app_server_for_review');
          parsed.runtimeGuard = {
            ...(parsed.runtimeGuard && typeof parsed.runtimeGuard === 'object' ? parsed.runtimeGuard : {}),
            engineModeGate: {
              requiredMode: 'app-server',
              effectiveMode: codexEngine,
              pass: false,
              reasonCode: 'engine_not_app_server_for_review',
            },
          };
        }

        if (isAutopilot && taskKindCurrent === 'USER_REQUEST' && outcome === 'done' && autopilotDelegateGateEnabled) {
          let delegationPath = 'invalid';
          let delegationStatus = 'pass';
          let delegationReasonCode = '';

          if (sourceCodeChanged) {
            if (parsedAutopilotControl.executionMode !== 'tiny_fixup') {
              outcome = 'blocked';
              delegationStatus = 'blocked';
              delegationPath = 'invalid';
              delegationReasonCode = 'delegate_required';
              note = appendReasonNote(note, 'delegate_required');
            } else if (!parsedAutopilotControl.tinyFixJustification) {
              outcome = 'blocked';
              delegationStatus = 'blocked';
              delegationPath = 'tiny_fixup';
              delegationReasonCode = 'tiny_fix_justification_missing';
              note = appendReasonNote(note, delegationReasonCode);
            } else if (
              sourceDelta.sourceFilesCount > 2 ||
              sourceDelta.sourceLineDelta > 30 ||
              sourceDelta.dependencyOrLockfileChanged ||
              sourceDelta.controlPlaneChanged
            ) {
              outcome = 'blocked';
              delegationStatus = 'blocked';
              delegationPath = 'tiny_fixup';
              delegationReasonCode = 'tiny_fix_threshold_exceeded';
              note = appendReasonNote(note, delegationReasonCode);
            } else {
              delegationPath = 'tiny_fixup';
            }
          } else if (hasExecuteFollowUp && !delegatedCompletion) {
            outcome = 'needs_review';
            delegationStatus = 'needs_review';
            delegationPath = 'delegate_pending';
            delegationReasonCode = 'delegated_completion_missing';
            note = appendReasonNote(note, delegationReasonCode);
          } else if (hasExecuteFollowUp && delegatedCompletion) {
            delegationPath = 'delegate_complete';
          } else {
            delegationPath = 'no_code_change';
          }

          parsed.runtimeGuard = {
            ...(parsed.runtimeGuard && typeof parsed.runtimeGuard === 'object' ? parsed.runtimeGuard : {}),
            delegationGate: {
              status: delegationStatus,
              path: delegationPath,
              reasonCode: delegationReasonCode || null,
              sourceFilesCount: sourceDelta.sourceFilesCount,
              sourceLineDelta: sourceDelta.sourceLineDelta,
              controlPlaneChanged: sourceDelta.controlPlaneChanged,
              dependencyOrLockfileChanged: sourceDelta.dependencyOrLockfileChanged,
              hasExecuteFollowUp,
              delegatedCompletion,
              workstream: parsedAutopilotControl.workstream || 'main',
            },
          };
        }

        if (isAutopilot && taskKindCurrent === 'USER_REQUEST' && outcome === 'done' && commitSha && sourceCodeChanged) {
          const reviewPrimedForCommit = runtimeReviewPrimedFor === commitSha;
          let selfReviewGate = { status: 'pass', reasonCode: null };
          if (parsedAutopilotControl.executionMode !== 'tiny_fixup') {
            outcome = 'blocked';
            selfReviewGate = { status: 'blocked', reasonCode: 'delegate_required' };
            note = appendReasonNote(note, 'delegate_required');
          } else if (codexEngine !== 'app-server') {
            outcome = 'blocked';
            selfReviewGate = { status: 'blocked', reasonCode: 'engine_not_app_server_for_review' };
            note = appendReasonNote(note, 'engine_not_app_server_for_review');
          } else if (!reviewPrimedForCommit) {
            outcome = 'blocked';
            selfReviewGate = { status: 'blocked', reasonCode: 'review_lifecycle_incomplete' };
            note = appendReasonNote(note, 'review_lifecycle_incomplete');
          }
          parsed.runtimeGuard = {
            ...(parsed.runtimeGuard && typeof parsed.runtimeGuard === 'object' ? parsed.runtimeGuard : {}),
            selfReviewGate: {
              ...selfReviewGate,
              commitSha,
              runtimeReviewPrimedFor: runtimeReviewPrimedFor || null,
            },
            engineModeGate: {
              requiredMode: 'app-server',
              effectiveMode: codexEngine,
              pass: codexEngine === 'app-server',
            },
          };
        }

        if (outcome === 'done' && commitSha) {
          const requiredIntegrationBranch = readRequiredIntegrationBranch(opened?.meta);
          const verification = await verifyCommitShaOnAllowedRemotes({
            cwd: taskCwd,
            commitSha,
            env: process.env,
            requiredIntegrationBranch,
          });
          const integrationGate = {
            strict: integrationGateStrict,
            requiredBranch: requiredIntegrationBranch || null,
            checked: Boolean(verification?.integration?.checked),
            reachable:
              typeof verification?.integration?.reachable === 'boolean'
                ? verification.integration.reachable
                : null,
            reason: readStringField(verification?.integration?.reason) || 'not_checked',
            matchedRefs: Array.isArray(verification?.integration?.matchedRefs)
              ? verification.integration.matchedRefs
              : [],
          };

          if (verification.checked && !verification.reachable) {
            outcome = 'blocked';
            const remediation =
              `commitSha ${commitSha} is not reachable on allowed remotes ` +
              `(${verification.attemptedRemotes.join(', ') || 'none'}); push branch then retry.`;
            note = note ? `${note} ${remediation}` : remediation;
          }
          if (
            integrationGateStrict &&
            taskKindCurrent === 'EXECUTE' &&
            !requiredIntegrationBranch
          ) {
            outcome = 'blocked';
            const remediation =
              'integration gate missing required target branch (references.integration.requiredIntegrationBranch or references.git.integrationBranch)';
            note = note ? `${note} ${remediation}` : remediation;
            integrationGate.reason = 'missing_required_branch';
          } else if (integrationGateStrict && requiredIntegrationBranch) {
            const integrationPassed = verification?.integration?.checked && verification?.integration?.reachable === true;
            if (!integrationPassed) {
              outcome = 'blocked';
              const remediation =
                `commitSha ${commitSha} is not verified on required integration branch ${requiredIntegrationBranch}` +
                ` (${integrationGate.reason}); integrate/push target branch then retry.`;
              note = note ? `${note} ${remediation}` : remediation;
            }
          }

          parsed.runtimeGuard = {
            ...(parsed.runtimeGuard && typeof parsed.runtimeGuard === 'object' ? parsed.runtimeGuard : {}),
            commitPushVerification: verification,
            integrationGate,
          };
        }

        const skillOpsValidation = await validateAutopilotSkillOpsEvidence({
          parsed,
          skillOpsGate,
          taskCwd,
        });
        if (skillOpsGate.required) {
          parsed.runtimeGuard = {
            ...(parsed.runtimeGuard && typeof parsed.runtimeGuard === 'object' ? parsed.runtimeGuard : {}),
            skillOpsGate: {
              ...skillOpsValidation.evidence,
              errors: skillOpsValidation.ok ? [] : skillOpsValidation.errors,
            },
          };
          if (outcome === 'done' && !skillOpsValidation.ok) {
            outcome = 'blocked';
            const reason = `skillops gate failed: ${skillOpsValidation.errors.join('; ')}`;
            note = note ? `${note} (${reason})` : reason;
          }
        }

        if (codeQualityGate.required) {
          const codeQualityBaseRef =
            readStringField(opened?.meta?.references?.git?.baseSha) || readStringField(taskStartHead);
          const qualityExpectedSourceChanges = Boolean(
            codeQualityGate.strictCommitScoped && sourceCodeChanged && commitSha,
          );
          const codeQualityValidation =
            outcome === 'done'
              ? await runCodeQualityGateCheck({
                  codeQualityGate,
                  taskCwd,
                  cockpitRoot,
                  baseRef: codeQualityBaseRef,
                  taskStartHead,
                  expectedSourceChanges: qualityExpectedSourceChanges,
                  scopeIncludeRules: codeQualityGate.scopeIncludeRules || [],
                  scopeExcludeRules: codeQualityGate.scopeExcludeRules || [],
                  retryCount: codeQualityRetryCount,
                })
              : {
                  ok: true,
                  errors: [],
                  evidence: {
                    required: true,
                    taskKind: readStringField(codeQualityGate?.taskKind) || '',
                    requiredKinds: Array.isArray(codeQualityGate?.requiredKinds) ? codeQualityGate.requiredKinds : [],
                    executed: false,
                    scopeMode: 'skipped',
                    baseRefUsed: codeQualityBaseRef || '',
                    taskStartHead,
                    changedScopeReturned: '',
                    changedFilesSample: [],
                    sourceFilesSeenCount: 0,
                    artifactOnlyChange: false,
                    retryCount: codeQualityRetryCount,
                    scopeIncludeRules: codeQualityGate.scopeIncludeRules || [],
                    scopeExcludeRules: codeQualityGate.scopeExcludeRules || [],
                    skippedReason: `outcome_${String(outcome || '').toLowerCase() || 'unknown'}`,
                  },
                };
          const qualityReviewValidation =
            outcome === 'done'
              ? validateCodeQualityReviewEvidence({ parsed, codeQualityGate })
              : {
                  ok: true,
                  errors: [],
                  evidence: {
                    required: true,
                    present: false,
                    summary: '',
                    legacyDebtWarnings: null,
                    hardRuleChecks: Object.fromEntries(
                      CODE_QUALITY_HARD_RULE_KEYS.map((key) => [key, false]),
                    ),
                    skippedReason: `outcome_${String(outcome || '').toLowerCase() || 'unknown'}`,
                  },
                };
          const combinedCodeQualityErrors = [
            ...(codeQualityValidation.ok ? [] : codeQualityValidation.errors),
            ...(qualityReviewValidation.ok ? [] : qualityReviewValidation.errors),
          ];
          const qualityReasonCodes = mapCodeQualityReasonCodes(combinedCodeQualityErrors);
          parsed.runtimeGuard = {
            ...(parsed.runtimeGuard && typeof parsed.runtimeGuard === 'object' ? parsed.runtimeGuard : {}),
            codeQualityGate: {
              ...codeQualityValidation.evidence,
              errors: combinedCodeQualityErrors,
              reasonCodes: qualityReasonCodes,
            },
            codeQualityReview: qualityReviewValidation.evidence,
          };
          if (outcome === 'done' && combinedCodeQualityErrors.length > 0) {
            const recoverableReason = qualityReasonCodes.find((code) => isRecoverableQualityReason(code));
            const retrySignature = buildCodeQualityRetrySignature({
              reasonCode: recoverableReason || '',
              codeQualityGateEvidence: codeQualityValidation.evidence,
              codeQualityReviewEvidence: qualityReviewValidation.evidence,
              errors: combinedCodeQualityErrors,
            });
            const repeatedUnchangedEvidence =
              Boolean(lastCodeQualityRetrySignature) && lastCodeQualityRetrySignature === retrySignature;
            if (
              isAutopilot &&
              recoverableReason &&
              !repeatedUnchangedEvidence &&
              codeQualityRetryCount < gateAutoremediateRetries &&
              canConsumeGateRetry('code_quality', gateAutoremediateRetries)
            ) {
              codeQualityRetryCount += 1;
              codeQualityRetryReasonCode = recoverableReason;
              codeQualityRetryReason = combinedCodeQualityErrors.join('; ');
              lastCodeQualityRetrySignature = retrySignature;
              parsed.runtimeGuard.codeQualityGate.retryCount = codeQualityRetryCount;
              parsed.runtimeGuard.codeQualityGate.autoRemediationAttempted = true;
              parsed.runtimeGuard.codeQualityGate.autoRemediationReason = recoverableReason;
              parsed.runtimeGuard.codeQualityGate.autoRemediationStopReason = null;

              await maybeEmitAutopilotRootStatus({
                enabled: autopilotProactiveStatusEnabled,
                busRoot,
                roster,
                fromAgent: agentName,
                priority: opened.meta?.priority || 'P2',
                rootId: opened.meta?.signals?.rootId ?? opened.meta?.id ?? null,
                parentId: opened.meta?.id ?? null,
                state: 'retrying',
                phase: 'code_quality',
                reasonCode: recoverableReason,
                nextAction: 'rerun_with_quality_fixes',
                idempotency: proactiveStatusSeen,
                throttle: statusThrottle,
              });
              writePane(
                `[worker] ${agentName} code-quality retry ${codeQualityRetryCount}/${gateAutoremediateRetries}: ${recoverableReason}\n`,
              );
              parsedOutput = null;
              continue taskRunLoop;
            }
            if (repeatedUnchangedEvidence) {
              parsed.runtimeGuard.codeQualityGate.autoRemediationStopReason = 'unchanged_evidence';
            } else if (recoverableReason && codeQualityRetryCount >= gateAutoremediateRetries) {
              parsed.runtimeGuard.codeQualityGate.autoRemediationStopReason = 'retry_budget_exhausted';
            }
            outcome = 'blocked';
            const reason = `code quality gate failed: ${combinedCodeQualityErrors.join('; ')}`;
            note = appendReasonNote(note, reason);
          } else {
            codeQualityRetryReasonCode = '';
            codeQualityRetryReason = '';
            lastCodeQualityRetrySignature = '';
          }
        }

        const observerDrainValidation =
          outcome === 'done'
            ? await validateObserverDrainGate({
                observerDrainGate,
                busRoot,
                agentName,
                taskId: id,
              })
            : {
                ok: true,
                errors: [],
                evidence: {
                  required: Boolean(observerDrainGate?.required),
                  enabled: Boolean(observerDrainGate?.enabled),
                  rootId: readStringField(observerDrainGate?.rootId),
                  sourceKind: readStringField(observerDrainGate?.sourceKind),
                  taskKind: readStringField(observerDrainGate?.taskKind),
                  pendingCount: 0,
                  pendingTaskIds: [],
                  skippedReason: `outcome_${String(outcome || '').toLowerCase() || 'unknown'}`,
                },
              };
        if (observerDrainGate.required) {
          parsed.runtimeGuard = {
            ...(parsed.runtimeGuard && typeof parsed.runtimeGuard === 'object' ? parsed.runtimeGuard : {}),
            observerDrainGate: {
              ...observerDrainValidation.evidence,
              errors: observerDrainValidation.ok ? [] : observerDrainValidation.errors,
            },
          };
          if (outcome === 'done' && !observerDrainValidation.ok) {
            outcome = 'blocked';
            const reason = observerDrainValidation.errors.join('; ');
            note = note ? `${note} (${reason})` : reason;
          }
        }

        if (outcome === 'done' && opusGate.postReviewRequired) {
          const phaseB = await runOpusConsultPhase({
            busRoot,
            roster,
            agentName,
            openedMeta: opened.meta,
            taskMarkdown: opened.markdown,
            taskKind: taskKindCurrent,
            gate: opusGate,
            phase: 'post_review',
            candidateOutput: parsed,
          });
          opusConsultTranscript.postReview = {
            consulted: true,
            ...phaseB,
          };
          const phaseBVerdict = readStringField(phaseB?.finalResponse?.verdict);
          const phaseBStatus = !phaseB?.ok
            ? (opusGate.consultMode === 'gate' ? 'blocked' : 'warn')
            : (phaseBVerdict === 'warn' ? 'warn' : 'pass');
          opusPostReviewEvidence = {
            enabled: true,
            required: true,
            phase: 'post_review',
            consultAgent: opusGate.consultAgent,
            consultMode: readStringField(opusGate?.consultMode) || 'advisory',
            protocolMode: readStringField(phaseB?.protocolMode) || readStringField(opusGate?.protocolMode) || 'freeform_only',
            consultId: readStringField(phaseB?.consultId) || null,
            roundsUsed: Number(phaseB?.roundsUsed) || 0,
            verdict: readStringField(phaseB?.finalResponse?.verdict) || null,
            reasonCode: readStringField(phaseB?.reasonCode) || null,
            status: phaseBStatus,
          };
          const existingDecision = isPlainObject(opusDecisionEvidence) ? opusDecisionEvidence : {};
          const preExecDecision =
            isPlainObject(existingDecision.preExec) ? existingDecision.preExec : null;
          opusDecisionEvidence = {
            preExec: preExecDecision,
            postReview: phaseB?.decision ?? {
              acceptedSuggestions: [],
              rejectedSuggestions: [],
              rejectionRationale: '',
            },
          };
          opusConsultAdvice = {
            ...opusConsultAdvice,
            mode: readStringField(opusGate?.consultMode) || 'advisory',
            postReview: buildOpusConsultAdvice({
              mode: readStringField(opusGate?.consultMode) || 'advisory',
              phaseResult: phaseB,
              phase: 'post_review',
            }),
          };
          if (!phaseB.ok) {
            const postReason = readStringField(phaseB?.reasonCode) || 'opus_post_review_block';
            note = appendReasonNote(note, postReason);
            if (opusGate.consultMode === 'gate') {
              outcome = 'blocked';
            }
          }
        } else if (!opusPostReviewEvidence) {
          opusPostReviewEvidence = {
            enabled: Boolean(opusGate.postReviewEnabled),
            required: false,
            phase: 'post_review',
            consultAgent: opusGate.consultAgent || null,
            consultMode: readStringField(opusGate?.consultMode) || 'advisory',
            protocolMode: readStringField(opusGate?.protocolMode) || 'freeform_only',
            status: 'skipped',
          };
          if (!isPlainObject(opusDecisionEvidence)) {
            opusDecisionEvidence = {
              preExec: null,
              postReview: null,
            };
          }
          opusConsultAdvice = {
            ...opusConsultAdvice,
            mode: readStringField(opusGate?.consultMode) || 'advisory',
            postReview: buildOpusConsultAdvice({
              mode: readStringField(opusGate?.consultMode) || 'advisory',
              phaseResult: null,
              phase: 'post_review',
            }),
          };
        }

        const previousRuntimeGuard =
          parsed.runtimeGuard && typeof parsed.runtimeGuard === 'object' ? parsed.runtimeGuard : {};
        const previousEngineModeGate =
          previousRuntimeGuard.engineModeGate && typeof previousRuntimeGuard.engineModeGate === 'object'
            ? previousRuntimeGuard.engineModeGate
            : {};
        parsed.runtimeGuard = {
          ...previousRuntimeGuard,
          skillProfile: runtimeSkillProfile,
          skillsSelected: runtimeSkillsSelected.slice(0, 8),
          skillsSelectedTotal: runtimeSkillsSelected.length,
          execSkillSelected: runtimeExecSkillSelected,
          sessionScope: runtimeSessionScope,
          sessionRotated: runtimeSessionRotated,
          sessionRotationReason: runtimeSessionRotationReason || null,
          branchContinuityGate: previousRuntimeGuard.branchContinuityGate || runtimeBranchContinuityGate,
          engineModeGate: {
            ...previousEngineModeGate,
            requiredMode: 'app-server',
            effectiveMode: codexEngine,
            pass: codexEngine === 'app-server',
          },
          opusGate: opusGateEvidence || previousRuntimeGuard.opusGate || null,
          opusPostReviewGate: opusPostReviewEvidence || previousRuntimeGuard.opusPostReviewGate || null,
          opusDecision: opusDecisionEvidence || previousRuntimeGuard.opusDecision || null,
          opusConsultAdvice:
            (isPlainObject(opusConsultAdvice) ? opusConsultAdvice : null) ||
            previousRuntimeGuard.opusConsultAdvice ||
            null,
          gateRetryBudget: {
            totalBudget: combinedGateRetryBudget,
            consumed: gateRetryConsumedTotal,
            perCategory: {
              review: gateRetryConsumption.review || 0,
              code_quality: gateRetryConsumption.code_quality || 0,
              consult_ack: gateRetryConsumption.consult_ack || 0,
            },
          },
          opusConsultBarrier:
            (isPlainObject(opusConsultBarrier) ? opusConsultBarrier : null) ||
            previousRuntimeGuard.opusConsultBarrier ||
            null,
        };

        const gitExtra = buildReceiptGitExtra({
          cwd: taskCwd,
          preflight: lastGitPreflight,
          preflightCleanArtifactPath: lastPreflightCleanArtifactPath,
        });
        receiptExtra = {
          ...defaultReceiptExtra,
          ...parsed,
          git: { ...(parsed.git && typeof parsed.git === 'object' ? parsed.git : {}), ...gitExtra },
        };

        if (reviewGate.required) {
          const artifact = await materializeReviewArtifact({
            busRoot,
            agentName,
            taskId: id,
            taskMeta: opened?.meta,
            review: parsed.review,
          });
          if (!parsed.review.evidence || typeof parsed.review.evidence !== 'object') {
            parsed.review.evidence = {};
          }
          parsed.review.evidence.artifactPath = artifact.relativePath;
          receiptExtra.review = parsed.review;
          receiptExtra.reviewArtifactPath = artifact.relativePath;
        }

        if (opusConsultTranscript.preExec || opusConsultTranscript.postReview) {
          const consultArtifact = await materializeOpusConsultArtifact({
            busRoot,
            agentName,
            taskId: id,
            taskMeta: opened?.meta,
            transcript: opusConsultTranscript,
          });
          opusConsultTranscriptPath = consultArtifact.relativePath;
          receiptExtra.opusConsultTranscriptPath = consultArtifact.relativePath;
        }
        receiptExtra.opusConsult = opusGateEvidence;
        receiptExtra.opusPostReview = opusPostReviewEvidence;
        receiptExtra.opusDecision = opusDecisionEvidence;
        receiptExtra.opusConsultAdvice = opusConsultAdvice;
        receiptExtra.opusConsultBarrier = opusConsultBarrier;

        // If the agent emitted followUps, dispatch them automatically.
        // In blocked state, only daddy-autopilot can continue the remediation loop;
        // other workers must not fan out additional tasks.
        let dispatchableFollowUps = parsedFollowUps;
        if (isAutopilot && opusConsultBarrier?.locked) {
          dispatchableFollowUps = [];
        }
        if (outcome === 'blocked' && !isAutopilot) {
          dispatchableFollowUps = parsedFollowUps.filter((fu) => isStatusFollowUp(fu));
        }
        if (dispatchableFollowUps.length > 0) {
          const fu = await dispatchFollowUps({
            busRoot,
            agentName,
            openedMeta: opened.meta,
            followUps: dispatchableFollowUps,
            cwd: taskCwd,
            autopilotControl: parsedAutopilotControl,
            enforceBranchContinuity: isAutopilot,
          });
          runtimeBranchContinuityGate = fu?.branchContinuity || runtimeBranchContinuityGate;
          receiptExtra.dispatchedFollowUps = fu.dispatched;
          if (fu.errors.length) receiptExtra.followUpDispatchErrors = fu.errors;
          if (fu?.branchContinuity) {
            parsed.runtimeGuard = {
              ...(parsed.runtimeGuard && typeof parsed.runtimeGuard === 'object' ? parsed.runtimeGuard : {}),
              branchContinuityGate: {
                ...fu.branchContinuity,
                reasonCode: deriveBranchContinuityReasonCode(fu.branchContinuity),
              },
            };
            receiptExtra.runtimeGuard = parsed.runtimeGuard;
          }
          if (fu.errors.length && outcome === 'done') {
            outcome = 'needs_review';
            note = note ? `${note} (followUp dispatch errors)` : 'followUp dispatch errors';
          }
          if (isAutopilot && dispatchableFollowUps.some((fuItem) => normalizeTaskKind(fuItem?.signals?.kind) === 'EXECUTE')) {
            await maybeEmitAutopilotRootStatus({
              enabled: autopilotProactiveStatusEnabled,
              busRoot,
              roster,
              fromAgent: agentName,
              priority: opened.meta?.priority || 'P2',
              rootId: opened.meta?.signals?.rootId ?? opened.meta?.id ?? null,
              parentId: opened.meta?.id ?? null,
              state: 'dispatch_issued',
              phase: 'dispatch',
              nextAction: 'await_execute_completion',
              idempotency: proactiveStatusSeen,
              throttle: null,
            });
          }
        }
        if (outcome === 'blocked' && parsedFollowUps.length > dispatchableFollowUps.length) {
          receiptExtra.followUpsSuppressed = true;
          receiptExtra.followUpsSuppressedReason =
            isAutopilot && opusConsultBarrier?.locked
              ? 'opus_preexec_barrier_locked'
              : isAutopilot
                ? 'blocked_outcome'
                : 'blocked_outcome_non_autopilot';
          receiptExtra.followUpsSuppressedCount = parsedFollowUps.length - dispatchableFollowUps.length;
        }

        if (outcome === 'done' && postMergeResyncGate.required) {
          const trigger = postMergeResyncTrigger;
          let postMergeResync = {
            attempted: false,
            status: 'skipped',
            reasonCode: trigger.reasonCode,
            trigger,
          };
          if (trigger.shouldRun) {
            try {
              postMergeResync = await runPostMergeResync({
                projectRoot: runtimeProjectRoot,
                busRoot,
                rosterPath: rosterInfo.path,
                roster,
                agentName,
                worktreesDir,
              });
              postMergeResync = {
                ...postMergeResync,
                trigger,
              };
            } catch (err) {
              postMergeResync = {
                attempted: true,
                status: 'needs_review',
                reasonCode: 'exception',
                error: (err && err.message) || String(err),
                trigger,
              };
            }
          }
          parsed.runtimeGuard = {
            ...(parsed.runtimeGuard && typeof parsed.runtimeGuard === 'object' ? parsed.runtimeGuard : {}),
            postMergeResync: {
              ...postMergeResync,
              required: true,
              projectRoot: runtimeProjectRoot,
            },
          };
          receiptExtra.runtimeGuard = parsed.runtimeGuard;
          if (postMergeResync?.status === 'needs_review') {
            note = appendReasonNote(note, `post_merge_resync_${postMergeResync.reasonCode || 'needs_review'}`);
          }
        }

        await deleteTaskSession({ busRoot, agentName, taskId: id });
          break taskRunLoop;
        }
        }
      } catch (err) {
        if (err instanceof OpusConsultBlockedError) {
          outcome = 'blocked';
          note = `opus consult blocked: ${err.message}`;
          if (opusConsultTranscript.preExec || opusConsultTranscript.postReview) {
            try {
              const consultArtifact = await materializeOpusConsultArtifact({
                busRoot,
                agentName,
                taskId: id,
                taskMeta: opened?.meta,
                transcript: opusConsultTranscript,
              });
              opusConsultTranscriptPath = consultArtifact.relativePath;
            } catch {
              opusConsultTranscriptPath = null;
            }
          }
          receiptExtra = {
            ...defaultReceiptExtra,
            error: note,
            reasonCode: readStringField(err.reasonCode) || 'opus_consult_block',
            opusConsult: opusGateEvidence,
            opusPostReview: opusPostReviewEvidence,
            opusDecision: opusDecisionEvidence,
            opusConsultAdvice,
            opusConsultBarrier,
            opusConsultTranscriptPath: opusConsultTranscriptPath || null,
            gateRetryBudget: {
              totalBudget: combinedGateRetryBudget,
              consumed: gateRetryConsumedTotal,
              perCategory: {
                review: gateRetryConsumption.review || 0,
                code_quality: gateRetryConsumption.code_quality || 0,
                consult_ack: gateRetryConsumption.consult_ack || 0,
              },
            },
            details: err.details ?? null,
          };
          await deleteTaskSession({ busRoot, agentName, taskId: id });
        } else if (err instanceof TaskGitPreflightBlockedError) {
          outcome = 'blocked';
          note = `git preflight blocked: ${err.message}`;
          const gitExtra = buildReceiptGitExtra({
            cwd: taskCwd,
            preflight: lastGitPreflight,
            preflightCleanArtifactPath: lastPreflightCleanArtifactPath,
          });
          receiptExtra = {
            ...defaultReceiptExtra,
            error: note,
            git: gitExtra,
            details: err.details ?? null,
          };
          await deleteTaskSession({ busRoot, agentName, taskId: id });
        } else
        if (err instanceof CodexExecTimeoutError) {
          outcome = 'blocked';
          note = `codex exec timed out after ${formatDurationMs(err.timeoutMs)} (${err.timeoutMs}ms)`;
          receiptExtra = {
            ...defaultReceiptExtra,
            error: note,
            timeoutMs: err.timeoutMs,
          };

          await maybeSendStatusToDaddy({
            busRoot,
            roster,
            fromAgent: agentName,
            priority: opened.meta?.priority || 'P2',
            rootId: opened.meta?.signals?.rootId ?? opened.meta?.id ?? null,
            parentId: opened.meta?.id ?? null,
            title: `STATUS: codex exec timed out (${agentName})`,
            body:
              `codex exec hit the watchdog timeout and was terminated.\n\n` +
              `Agent: ${agentName}\n` +
              `Task: ${id}\n` +
              (err.threadId ? `Codex thread: ${err.threadId}\n` : '') +
              `Attempt: ${Number.isFinite(Number(err.attempt)) ? err.attempt : 'unknown'}\n` +
              `Timeout: ${err.timeoutMs}ms\n` +
              `\nOutcome will be recorded as blocked.\n`,
            throttle: null,
          });
        } else {
          if (err instanceof CodexExecError) {
            const combined = `${err.message}\n${err.stderrTail || ''}\n${err.stdoutTail || ''}`;
            if (isSandboxPermissionErrorText(combined)) {
              outcome = 'blocked';
              note = `codex exec blocked by sandbox/permissions: ${err.message}`;
              receiptExtra = {
                ...defaultReceiptExtra,
                error: note,
                threadId: err.threadId || null,
                stderrTail: typeof err.stderrTail === 'string' ? err.stderrTail.slice(-16_000) : null,
              };
            } else {
              outcome = 'failed';
              note = `codex exec failed: ${(err && err.message) || String(err)}`;
              receiptExtra = {
                ...defaultReceiptExtra,
                error: note,
              };
            }
          } else {
            outcome = 'failed';
            note = `codex exec failed: ${(err && err.message) || String(err)}`;
            receiptExtra = {
              ...defaultReceiptExtra,
              error: note,
            };
          }
        }
        await deleteTaskSession({ busRoot, agentName, taskId: id });
      }

      writePane(
        `[worker] ${agentName} task done ${id} outcome=${outcome}${commitSha ? ` commit=${commitSha}` : ''}\n`,
      );

      await maybeEmitAutopilotRootStatus({
        enabled: isAutopilot && autopilotProactiveStatusEnabled,
        busRoot,
        roster,
        fromAgent: agentName,
        priority: opened.meta?.priority || 'P2',
        rootId: opened.meta?.signals?.rootId ?? opened.meta?.id ?? null,
        parentId: opened.meta?.id ?? null,
        state: outcome,
        phase: 'root_completion',
        reasonCode:
          outcome === 'blocked'
            ? readStringField(receiptExtra?.reasonCode) || mapCodeQualityReasonCodes([note])[0] || ''
            : '',
        nextAction:
          outcome === 'needs_review'
            ? 'await_delegated_completion'
            : outcome === 'blocked'
              ? 'manual_or_followup_remediation'
              : 'none',
        idempotency: proactiveStatusSeen,
        throttle: null,
      });

      if (isAutopilot) {
        try {
          await writeAgentStateFile({
            busRoot,
            agentName,
            payload: {
              updatedAt: new Date().toISOString(),
              agent: agentName,
              taskId: id,
              taskKind,
              rootId: opened.meta?.signals?.rootId ?? opened.meta?.id ?? null,
              outcome,
              note,
              commitSha,
              dispatchedFollowUps: receiptExtra?.dispatchedFollowUps ?? [],
              followUpDispatchErrors: receiptExtra?.followUpDispatchErrors ?? [],
            },
          });
        } catch (err) {
          // Best-effort; state file is for continuity, not correctness.
        }
      }

      const notifyOrchestrator =
        typeof opened.meta?.signals?.notifyOrchestrator === 'boolean'
          ? opened.meta.signals.notifyOrchestrator
          : true;

      try {
        await closeTask({
          busRoot,
          roster,
          agentName,
          taskId: id,
          outcome,
          note,
          commitSha,
          receiptExtra,
          notifyOrchestrator,
        });
        const closedRootId = readStringField(opened.meta?.signals?.rootId);
        if (closedRootId) {
          await writeAgentRootFocus({ busRoot, agentName, rootId: closedRootId });
        }
        const autopilotBranchDecision = readStringField(receiptExtra?.autopilotControl?.branchDecision).toLowerCase();
        if (
          isAutopilot &&
          runtimeSessionScope === 'root' &&
          closedRootId &&
          autopilotBranchDecision === 'close' &&
          (outcome === 'done' || outcome === 'blocked' || outcome === 'failed')
        ) {
          await deleteRootSession({ busRoot, agentName, rootId: closedRootId });
        }
      } catch (err) {
        writePane(
          `[worker] ERROR: failed to close task ${id} for ${agentName}: ${(err && err.message) || String(err)}\n`,
        );
      }
    }

      if (values.once) break;
      await sleep(pollMs);
    }
  } finally {
    // Ensure app-server doesn't keep the event loop alive when running `--once` (tests/one-shots).
    await stopSharedAppServerClient();
    await workerLock.release();
  }
}

main().catch((err) => {
  writePane(`ERROR: ${(err && err.stack) || String(err)}\n`);
  process.exit(1);
});
