#!/usr/bin/env node
/**
 * Codex worker.
 *
 * Consumes tasks addressed to a specific agent, drives the configured Codex engine to complete them,
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
  findTaskPath,
  listInboxTaskIds,
  openTask,
  claimTask,
  closeTask,
  statusSummary,
  recentReceipts,
  listInboxTasks,
  deliverTask,
  makeId,
  pickDaddyChatName,
  safeIdToken,
} from './lib/agentbus.mjs';
import {
  resolveConfiguredAgentWorkdir,
  resolveWorktreesRoots,
  validateDedicatedAgentWorkdir,
} from './lib/agent-workdir.mjs';
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
  shouldContinueOpusConsultRound,
} from './lib/opus-consult-schema.mjs';
import { CodexAppServerClient } from './lib/codex-app-server-client.mjs';
import {
  AUTOPILOT_PR_HEAD_LOOKUP_TIMEOUT_MS,
  normalizeAutopilotRecoveryContractClass,
  planAutopilotBlockedRecovery,
  readIncomingPrHeadSha,
  shouldAllowAutopilotDirtyCrossRootReviewFix,
} from './lib/autopilot-root-recovery.mjs';
import {
  createTaskGitPreflightRuntimeError,
  TaskGitPreflightRuntimeError,
} from './lib/worker-git-preflight.mjs';
import {
  hashBlockedRecoveryFingerprint,
  normalizeBlockedRecoveryFingerprintText,
  normalizeBlockedRecoveryFingerprintValue,
} from './lib/blocked-recovery-fingerprint.mjs';
import * as workerCodeQuality from './lib/worker-code-quality.mjs';
import * as workerCodeQualityState from './lib/worker-code-quality-state.mjs';
import { buildPreflightPromptBlock, finalizePreflightClosureGate, normalizePreflightPlan } from './lib/worker-preflight.mjs';
import { runWriterPreflightPhase } from './lib/worker-preflight-runner.mjs';
import {
  firstPreflightReasonCode,
  hydrateApprovedPreflightForTask,
  normalizePersistedTrackedSnapshot,
  shouldRequireWriterPreflight,
} from './lib/worker-preflight-session.mjs';
import {
  buildOpusAdvisoryFallbackPayload,
  buildOpusConsultAdvice,
  buildOpusConsultPromptBlock,
  normalizeOpusReasonCode,
  opusAdviceItemSuggestsDelegation,
  opusDispositionHasLocalJustification,
  parseOpusDispositionLines,
  readOpusRationaleLine,
} from './lib/worker-opus-advice.mjs';
import { deriveOpusConsultGate } from './lib/worker-opus-gate.mjs';
import { runApprovedPreExecConsultPhase } from './lib/worker-opus-preflight.mjs';
import { safeExecText } from './lib/safe-exec.mjs';
import {
  hashActionableCommentBody,
  isActionableComment,
} from './lib/review-fix-comment.mjs';
import {
  attemptStaleWorkerWorktreeReclaim,
  TaskGitPreflightBlockedError,
  classifyControllerDirtyWorktree,
  readTaskGitContract,
  ensureTaskGitContract,
  getGitSnapshot,
  normalizeRepoPath,
} from './lib/task-git.mjs';
import {
  buildControllerHousekeepingReplayTask,
  getControllerHousekeepingStatePath,
  listPendingControllerHousekeepingSuspensions,
  patchControllerHousekeepingSuspendedRootAudit,
  readControllerHousekeepingState,
  stageControllerHousekeepingSuspension,
  updateControllerHousekeepingState,
} from './lib/controller-housekeeping.mjs';
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

class CodexTurnError extends Error {
  constructor(message, { exitCode, stderrTail, stdoutTail, threadId, details = null }) {
    super(message);
    this.name = 'CodexTurnError';
    this.exitCode = exitCode;
    this.stderrTail = stderrTail;
    this.stdoutTail = stdoutTail;
    this.threadId = threadId;
    this.details = details;
  }
}

class SkillOpsPromotionTaskError extends Error {
  constructor(message, { reasonCode = '', details = null } = {}) {
    super(message);
    this.name = 'SkillOpsPromotionTaskError';
    this.reasonCode = readStringField(reasonCode) || 'skillops_promotion_invalid';
    this.details = details;
  }
}

function throwSkillOpsPromotionInvalid(message, details = null) {
  throw new SkillOpsPromotionTaskError(message, {
    reasonCode: 'skillops_promotion_invalid',
    details,
  });
}

function mapSkillOpsPromotionTaskOutcome(reasonCode) {
  const normalized = readStringField(reasonCode);
  if (
    normalized === 'skillops_promotion_busy' ||
    normalized === 'skillops_cli_unsupported_at_claim' ||
    normalized === 'skillops_promotion_legacy_state' ||
    normalized === 'skillops_promotion_invalid' ||
    normalized === 'skillops_promotion_lock_invalid'
  ) {
    return 'blocked';
  }
  return 'failed';
}

function describeSkillOpsPromotionOutcome(outcome) {
  if (outcome === 'blocked') return 'blocked';
  if (outcome === 'failed') return 'failed';
  return 'needs review';
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

class CodexTurnTimeoutError extends Error {
  constructor({ timeoutMs, killGraceMs, pid, threadId, stderrTail, stdoutTail }) {
    super(
      `codex turn timed out after ${formatDurationMs(timeoutMs)} (${timeoutMs}ms); ` +
        `${threadId ? `requested turn/interrupt for thread ${threadId}` : 'requested turn/interrupt'} ` +
        `(pid ${pid}, grace ${killGraceMs}ms)`,
    );
    this.name = 'CodexTurnTimeoutError';
    this.timeoutMs = timeoutMs;
    this.killGraceMs = killGraceMs;
    this.pid = pid;
    this.threadId = threadId;
    this.stderrTail = stderrTail;
    this.stdoutTail = stdoutTail;
  }
}

class CodexTurnSupersededError extends Error {
  constructor({ reason, pid, threadId, stderrTail, stdoutTail }) {
    super(`codex turn superseded: ${reason} (pid ${pid})`);
    this.name = 'CodexTurnSupersededError';
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
 * Reads the first non-empty string value from a set of env keys.
 */
function readStringEnv(env, ...keys) {
  for (const key of keys) {
    const value = String(env?.[key] ?? '').trim();
    if (value) return value;
  }
  return '';
}

/**
 * Appends a TOML string config override for Codex CLI.
 */
function appendCodexTomlStringArg(args, key, value) {
  const normalized = String(value || '').trim();
  if (!normalized) return;
  args.push('-c', `${key}=${JSON.stringify(normalized)}`);
}

/**
 * Builds Codex CLI config overrides from runtime env.
 */
function buildCodexConfigArgs(env = process.env) {
  const args = [];
  appendCodexTomlStringArg(
    args,
    'model',
    readStringEnv(env, 'AGENTIC_CODEX_MODEL', 'VALUA_CODEX_MODEL'),
  );
  appendCodexTomlStringArg(
    args,
    'model_reasoning_effort',
    readStringEnv(
      env,
      'AGENTIC_CODEX_MODEL_REASONING_EFFORT',
      'VALUA_CODEX_MODEL_REASONING_EFFORT',
    ),
  );
  appendCodexTomlStringArg(
    args,
    'plan_mode_reasoning_effort',
    readStringEnv(
      env,
      'AGENTIC_CODEX_PLAN_MODE_REASONING_EFFORT',
      'VALUA_CODEX_PLAN_MODE_REASONING_EFFORT',
    ),
  );
  return args;
}

/**
 * Returns normalized task kind.
 */
function normalizeTaskKind(value) {
  return String(value || '').trim().toUpperCase();
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
          timeout: 30_000,
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
 * Normalizes reviewed commit shas from a review object.
 */
function normalizeReviewedCommitShas(review) {
  return normalizeCommitShaList([
    ...(Array.isArray(review?.reviewedCommits) ? review.reviewedCommits : []),
    readStringField(review?.targetCommitSha),
  ]);
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
async function createGitCredentialStoreEnv(baseEnv) {
  const env = { ...baseEnv };

  const countRaw = Number.parseInt(String(env.GIT_CONFIG_COUNT ?? ''), 10);
  let idx = Number.isFinite(countRaw) && countRaw >= 0 ? countRaw : 0;
  // Reset inherited helper chain (global/local `store`, etc.) and enforce gh helper only.
  env[`GIT_CONFIG_KEY_${idx}`] = 'credential.helper';
  env[`GIT_CONFIG_VALUE_${idx}`] = '';
  idx += 1;
  env[`GIT_CONFIG_KEY_${idx}`] = 'credential.helper';
  env[`GIT_CONFIG_VALUE_${idx}`] = '!gh auth git-credential';
  idx += 1;
  env.GIT_CONFIG_COUNT = String(idx);

  // Avoid interactive credential prompts in non-interactive worker runs.
  if (!Object.prototype.hasOwnProperty.call(env, 'GIT_TERMINAL_PROMPT')) {
    env.GIT_TERMINAL_PROMPT = '0';
  }

  return { env, credentialFile: '', cleanup: async () => {} };
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
 * Gets Codex app-server timeout ms from the current environment.
 */
function getCodexTurnTimeoutMs(env = process.env) {
  // Cockpit tasks can legitimately take hours (staging/prod debugging, PR review closure).
  // App-server is the only supported runtime path.
  const defaultMs = 12 * 60 * 60 * 1000;
  const raw =
    env.AGENTIC_CODEX_APP_SERVER_TIMEOUT_MS ||
    env.VALUA_CODEX_APP_SERVER_TIMEOUT_MS ||
    env.AGENTIC_CODEX_EXEC_TIMEOUT_MS ||
    env.VALUA_CODEX_EXEC_TIMEOUT_MS;
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

function getAutopilotBlockedRecoveryStateDir({ busRoot, agentName }) {
  return path.join(busRoot, 'state', 'autopilot-blocked-recovery', safeIdToken(agentName));
}

function getAutopilotBlockedRecoveryStatePath({ busRoot, agentName, recoveryKey }) {
  return path.join(
    getAutopilotBlockedRecoveryStateDir({ busRoot, agentName }),
    `${safeIdToken(recoveryKey)}.json`,
  );
}

async function clearAutopilotBlockedRecoveryPending({ busRoot, agentName, recoveryKey }) {
  try {
    await fs.rm(getAutopilotBlockedRecoveryStatePath({ busRoot, agentName, recoveryKey }), { force: true });
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
}

async function queueAutopilotBlockedRecovery({ busRoot, agentName, recovery }) {
  const existing = await findTaskPath({ busRoot, agentName, taskId: recovery.taskId });
  if (existing) {
    await clearAutopilotBlockedRecoveryPending({ busRoot, agentName, recoveryKey: recovery.recoveryKey });
    return { queued: false, reason: 'already_present', path: existing.path };
  }
  const delivered = await deliverTask({ busRoot, meta: recovery.taskMeta, body: recovery.taskBody });
  await clearAutopilotBlockedRecoveryPending({ busRoot, agentName, recoveryKey: recovery.recoveryKey });
  return { queued: true, reason: 'queued', path: delivered.paths[0] ?? null };
}

async function writeAutopilotBlockedRecoveryPending({
  busRoot,
  agentName,
  recovery,
}) {
  const statePath = getAutopilotBlockedRecoveryStatePath({
    busRoot,
    agentName,
    recoveryKey: recovery.recoveryKey,
  });
  await writeJsonAtomic(statePath, {
    updatedAt: new Date().toISOString(),
    recoveryKey: recovery.recoveryKey,
    taskId: recovery.taskId,
    contractClass: recovery.contractClass,
    fingerprint: recovery.fingerprint,
    meta: recovery.taskMeta,
    body: recovery.taskBody,
  });
  return statePath;
}

function normalizePendingAutopilotRecoveryPayload(payload, meta) {
  const references = isPlainObject(meta?.references) ? meta.references : {};
  const recoveryRef = isPlainObject(references.autopilotRecovery) ? references.autopilotRecovery : {};
  const contractClass =
    normalizeAutopilotRecoveryContractClass(payload?.contractClass || recoveryRef?.contractClass) || 'external';
  const fingerprint = readStringField(payload?.fingerprint || recoveryRef?.fingerprint);
  const normalizedMeta = {
    ...meta,
    references: {
      ...references,
      autopilotRecovery: {
        ...recoveryRef,
        contractClass,
        fingerprint,
      },
    },
  };
  return {
    payload: {
      ...payload,
      contractClass,
      fingerprint,
      meta: normalizedMeta,
    },
    contractClass,
    fingerprint,
  };
}

async function flushPendingAutopilotBlockedRecoveries({ busRoot, agentName }) {
  const dir = getAutopilotBlockedRecoveryStateDir({ busRoot, agentName });
  let files = [];
  try {
    files = (await fs.readdir(dir)).filter((file) => file.endsWith('.json')).sort();
  } catch (err) {
    if (err?.code === 'ENOENT') return;
    throw err;
  }
  for (const file of files) {
    const statePath = path.join(dir, file);
    let payload = null;
    try {
      payload = JSON.parse(await fs.readFile(statePath, 'utf8'));
    } catch (err) {
      writePane(
        `[worker] ${agentName} recovery warn: dropping malformed pending marker ${file}: ${(err && err.message) || String(err)}\n`,
      );
      await fs.rm(statePath, { force: true });
      continue;
    }
    const recoveryKey = readStringField(payload?.recoveryKey);
    const taskId = readStringField(payload?.taskId);
    const meta = payload?.meta && typeof payload.meta === 'object' && !Array.isArray(payload.meta) ? payload.meta : null;
    const body = typeof payload?.body === 'string' ? payload.body : '';
    const normalized = meta ? normalizePendingAutopilotRecoveryPayload(payload, meta) : null;
    const normalizedPayload = normalized?.payload || payload;
    const normalizedMeta = normalizedPayload?.meta;
    const metaTo = Array.isArray(meta?.to) ? meta.to.map((value) => readStringField(value)).filter(Boolean) : [];
    const metaFrom = readStringField(meta?.from);
    const metaKind = normalizeTaskKind(meta?.signals?.kind);
    const metaSourceKind = normalizeTaskKind(meta?.signals?.sourceKind);
    const metaPhase = readStringField(meta?.signals?.phase);
    const recoveryRef =
      meta?.references?.autopilotRecovery &&
      typeof meta.references.autopilotRecovery === 'object' &&
      !Array.isArray(meta.references.autopilotRecovery)
        ? meta.references.autopilotRecovery
        : null;
    const recoveryAttemptRaw = Number(recoveryRef?.attempt);
    const recoveryAttempt = Number.isInteger(recoveryAttemptRaw) && recoveryAttemptRaw > 0 ? recoveryAttemptRaw : null;
    if (
      !recoveryKey ||
      !taskId ||
      !meta ||
      taskId !== safeIdToken(recoveryKey) ||
      readStringField(meta.id) !== taskId ||
      metaTo.length !== 1 ||
      metaTo[0] !== agentName ||
      metaFrom !== agentName ||
      metaKind !== 'ORCHESTRATOR_UPDATE' ||
      metaSourceKind !== 'AUTOPILOT_BLOCKED_RECOVERY' ||
      metaPhase !== 'blocked-recovery' ||
      meta?.signals?.notifyOrchestrator !== false ||
      readStringField(recoveryRef?.recoveryKey) !== recoveryKey ||
      recoveryAttempt === null ||
      !normalized ||
      readStringField(normalizedMeta?.references?.autopilotRecovery?.contractClass) !== normalized.contractClass ||
      readStringField(normalizedMeta?.references?.autopilotRecovery?.fingerprint) !== normalized.fingerprint
    ) {
      writePane(`[worker] ${agentName} recovery warn: dropping invalid pending marker ${file}\n`);
      await fs.rm(statePath, { force: true });
      continue;
    }
    try {
      const result = await queueAutopilotBlockedRecovery({
        busRoot,
        agentName,
        recovery: {
          recoveryKey,
          taskId,
          contractClass: normalized.contractClass,
          fingerprint: normalized.fingerprint,
          taskMeta: normalizedMeta,
          taskBody: body,
        },
      });
      if (result.queued) {
        writePane(`[worker] ${agentName} flushed pending blocked recovery ${taskId}\n`);
      }
    } catch (err) {
      if (
        payload?.contractClass !== normalized.contractClass ||
        readStringField(payload?.fingerprint) !== normalized.fingerprint ||
        normalizedMeta !== meta
      ) {
        await writeJsonAtomic(statePath, normalizedPayload);
      }
      writePane(
        `[worker] ${agentName} recovery warn: pending enqueue failed for ${taskId}: ${(err && err.message) || String(err)}\n`,
      );
    }
  }
}

async function readTaskSession({ busRoot, agentName, taskId }) {
  const dir = path.join(busRoot, 'state', 'codex-task-sessions', agentName);
  const p = path.join(dir, `${taskId}.json`);
  return readThreadSessionStateFile(p);
}

async function writeTaskSession({ busRoot, agentName, taskId, threadId, extra = null }) {
  if (!threadId || typeof threadId !== 'string') return null;
  const dir = path.join(busRoot, 'state', 'codex-task-sessions', agentName);
  await fs.mkdir(dir, { recursive: true });
  const p = path.join(dir, `${taskId}.json`);
  const existing = (await readJsonFileOrNull(p)) || {};
  const extraPayload = extra && typeof extra === 'object' ? extra : {};
  const payload = {
    ...(existing && typeof existing === 'object' ? existing : {}),
    ...extraPayload,
    updatedAt: new Date().toISOString(),
    agent: agentName,
    taskId,
    threadId,
  };
  await writeJsonAtomic(p, payload);
  return p;
}

async function deleteTaskSession({ busRoot, agentName, taskId }) {
  const dir = path.join(busRoot, 'state', 'codex-task-sessions', agentName);
  const p = path.join(dir, `${taskId}.json`);
  try {
    await fs.unlink(p);
  } catch {
    // ignore
  }
}

function safeStateBasename(key) {
  return safeIdToken(key);
}

async function readRootSession({ busRoot, agentName, rootId }) {
  const key = safeStateBasename(rootId);
  const dir = path.join(busRoot, 'state', 'codex-root-sessions', agentName);
  const p = path.join(dir, `${key}.json`);
  const record = await readThreadSessionStateFile(p);
  if (!record) return null;
  const turnCountRaw = Number(record.payload?.turnCount);
  const turnCount = Number.isFinite(turnCountRaw) && turnCountRaw >= 0 ? Math.floor(turnCountRaw) : 0;
  return { ...record, turnCount };
}

async function writeRootSession({ busRoot, agentName, rootId, threadId, turnCount = 0 }) {
  if (!threadId || typeof threadId !== 'string') return null;
  const key = safeStateBasename(rootId);
  const dir = path.join(busRoot, 'state', 'codex-root-sessions', agentName);
  await fs.mkdir(dir, { recursive: true });
  const p = path.join(dir, `${key}.json`);
  const payload = {
    updatedAt: new Date().toISOString(),
    agent: agentName,
    rootId,
    threadId,
    turnCount: Math.max(0, Number(turnCount) || 0),
  };
  await writeJsonAtomic(p, payload);
  return p;
}

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

async function readAgentRootFocus({ busRoot, agentName }) {
  const p = path.join(busRoot, 'state', 'agent-root-focus', `${safeStateBasename(agentName)}.json`);
  const parsed = await readJsonFileOrNull(p);
  const rootId = readStringField(parsed?.rootId);
  if (!rootId) return null;
  const branch = readStringField(parsed?.branch) || null;
  return { rootId, branch, path: p, payload: parsed };
}

async function writeAgentRootFocus({ busRoot, agentName, rootId, branch = '' }) {
  const dir = path.join(busRoot, 'state', 'agent-root-focus');
  await fs.mkdir(dir, { recursive: true });
  const p = path.join(dir, `${safeStateBasename(agentName)}.json`);
  const payload = {
    updatedAt: new Date().toISOString(),
    agent: agentName,
    rootId: readStringField(rootId),
    branch: readStringField(branch) || null,
  };
  await writeJsonAtomic(p, payload);
  return p;
}

async function clearAgentRootFocusIfMatches({ busRoot, agentName, rootId }) {
  const current = await readAgentRootFocus({ busRoot, agentName });
  if (!current?.path || readStringField(current?.rootId) !== readStringField(rootId)) return false;
  try {
    await fs.rm(current.path, { force: true });
  } catch {
    // ignore
  }
  return true;
}

async function clearStaleRootFocusAndSessionIfNoOpenTasks({ busRoot, agentName, rootId }) {
  const normalizedRootId = readStringField(rootId);
  if (!normalizedRootId) return { cleared: false, openTaskIds: [] };
  const openTasks = [];
  for (const state of ['new', 'seen', 'in_progress']) {
    const tasks = await listInboxTasks({ busRoot, agentName, state, limit: 'all' });
    for (const task of tasks) {
      if (readStringField(task?.meta?.signals?.rootId) !== normalizedRootId) continue;
      openTasks.push(readStringField(task?.taskId));
    }
  }
  if (openTasks.length > 0) {
    return { cleared: false, openTaskIds: openTasks };
  }
  await clearAgentRootFocusIfMatches({ busRoot, agentName, rootId: normalizedRootId });
  await deleteRootSession({ busRoot, agentName, rootId: normalizedRootId });
  return { cleared: true, openTaskIds: [] };
}

async function readPromptBootstrap({ busRoot, agentName }) {
  const p = path.join(busRoot, 'state', `${agentName}.prompt-bootstrap.json`);
  const parsed = await readJsonFileOrNull(p);
  const threadId = typeof parsed?.threadId === 'string' ? parsed.threadId.trim() : '';
  const skillsHash = typeof parsed?.skillsHash === 'string' ? parsed.skillsHash.trim() : '';
  if (!threadId || !skillsHash) return null;
  return { path: p, threadId, skillsHash, payload: parsed };
}

async function readThreadSessionStateFile(filePath) {
  const parsed = await readJsonFileOrNull(filePath);
  const threadId = typeof parsed?.threadId === 'string' ? parsed.threadId.trim() : '';
  if (!threadId) return null;
  return { path: filePath, threadId, payload: parsed };
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
  const payload = { updatedAt: new Date().toISOString(), agent: agentName, threadId, skillsHash };
  await writeJsonAtomic(p, payload);
  return p;
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

async function readJsonFileOrNull(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

const SKILLOPS_PROMOTION_CLI_TIMEOUT_MS = 60_000;
const SKILLOPS_PROMOTION_CONTRACT_VERSION = 4;
const SKILLOPS_PROMOTION_SCHEMA_VERSION = 3;
const SKILLOPS_PROMOTION_PLAN_VERSION = 2;
const SKILLOPS_PROMOTION_STATE_VERSION = 2;
const SKILLOPS_PROMOTION_CAPABILITIES_KIND = 'skillops-capabilities';
const SKILLOPS_PROMOTION_PLAN_KIND = 'skillops-promotion-plan';
const SKILLOPS_PROMOTION_COMMANDS = [
  'capabilities',
  'lint',
  'log',
  'debrief',
  'distill',
  'plan-promotions',
  'apply-promotions',
  'payload-files',
  'mark-promoted',
];
const SKILLOPS_RAW_LOG_COMMAND_METADATA = {
  json: false,
  writes: 'raw_logs',
  requiredFlags: ['--title'],
  optionalFlags: ['--skills', '--skill-update'],
};
const SKILLOPS_PROMOTION_COMMAND_METADATA = {
  capabilities: { json: true, writes: 'none', requiredFlags: [], optionalFlags: [] },
  lint: { json: false, writes: 'none', requiredFlags: [], optionalFlags: [] },
  log: SKILLOPS_RAW_LOG_COMMAND_METADATA,
  debrief: SKILLOPS_RAW_LOG_COMMAND_METADATA,
  distill: {
    json: false,
    writes: 'non_durable_local',
    requiredFlags: [],
    optionalFlags: ['--dry-run', '--mark-empty-skipped', '--max-learned'],
  },
  'plan-promotions': {
    json: true,
    writes: 'none',
    requiredFlags: [],
    optionalFlags: ['--max-learned'],
  },
  'apply-promotions': {
    json: true,
    writes: 'durable_targets',
    requiredFlags: ['--plan'],
    optionalFlags: ['--json'],
  },
  'payload-files': {
    json: true,
    writes: 'none',
    requiredFlags: ['--plan'],
    optionalFlags: ['--json'],
  },
  'mark-promoted': {
    json: false,
    writes: 'raw_logs',
    requiredFlags: ['--plan', '--status'],
    optionalFlags: ['--promotion-task-id'],
  },
};
const SKILLOPS_PROMOTION_STATUSES = ['pending', 'queued', 'processed', 'skipped'];
const SKILLOPS_PROMOTION_MARK_STATUSES = ['queued', 'processed', 'skipped'];
const SKILLOPS_PROMOTION_TARGET_KINDS = ['skill', 'archive'];
const SKILLOPS_PROMOTION_MODES = ['learned_block', 'canonical_section'];
const SKILLOPS_PROMOTION_LOG_METADATA_KEYS = ['promotion_mode', 'target_file', 'target_section'];
const SKILLOPS_PROMOTION_CANONICAL_SECTION_MARKER_PREFIX = 'SKILLOPS:SECTION:';
const SKILLOPS_PROMOTION_LOCK_STALE_MS = 5_000;

function getSkillOpsPromotionStateRoot({ busRoot }) {
  return path.join(busRoot, 'state', 'skillops-promotions');
}

function getSkillOpsPromotionStateDir({ busRoot, agentName }) {
  return path.join(getSkillOpsPromotionStateRoot({ busRoot }), safeIdToken(agentName));
}

function getSkillOpsPromotionPlanPath({ busRoot, agentName, rootId }) {
  return path.join(getSkillOpsPromotionStateDir({ busRoot, agentName }), `${safeIdToken(rootId)}.plan.json`);
}

function getSkillOpsPromotionStatePath({ busRoot, agentName, rootId }) {
  return path.join(getSkillOpsPromotionStateDir({ busRoot, agentName }), `${safeIdToken(rootId)}.json`);
}

function getSkillOpsPromotionLockPath({ busRoot, agentName }) {
  return path.join(getSkillOpsPromotionStateRoot({ busRoot }), `${safeIdToken(agentName)}.lock`);
}

function buildSkillOpsPromotionTaskId({ agentName, rootId }) {
  return `skillops_promotion__${safeIdToken(agentName)}__${safeIdToken(rootId)}`;
}

function buildSkillOpsPromotionBranchName({ agentName, rootId }) {
  return `skillops/${safeIdToken(agentName)}/${safeIdToken(rootId)}`;
}

function buildSkillOpsPromotionCurationWorkdir({ worktreesDir, agentName }) {
  return path.join(worktreesDir, `${safeIdToken(agentName)}-skillops-promotion`);
}

function parseLastJsonLine(raw) {
  const lines = String(raw || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return null;
  const candidate = lines[lines.length - 1];
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function sameStringMembers(actualValues, expectedValues) {
  const actual = Array.from(new Set((actualValues || []).map(readStringField).filter(Boolean))).sort();
  const expected = Array.from(new Set((expectedValues || []).map(readStringField).filter(Boolean))).sort();
  if (actual.length !== expected.length) return false;
  return actual.every((value, index) => value === expected[index]);
}

function isSkillOpsPromotionTargetPathAllowed(kind, repoPath) {
  if (kind === 'skill') {
    return /^\.codex\/skills\/[^/]+\/SKILL\.md$/.test(repoPath);
  }
  if (kind === 'archive') {
    return /^\.codex\/skill-ops\/archive\/[^/]+\.md$/.test(repoPath);
  }
  return false;
}

function normalizeSkillOpsPromotionTargets(targets) {
  const seen = new Set();
  const normalized = [];
  for (const [index, target] of (Array.isArray(targets) ? targets : []).entries()) {
    if (!isPlainObject(target)) {
      return { ok: false, detail: `targets[${index}] must be an object` };
    }
    const kind = readStringField(target.kind);
    const repoPath = normalizeRepoPath(readStringField(target.path));
    if (!SKILLOPS_PROMOTION_TARGET_KINDS.includes(kind)) {
      return { ok: false, detail: `targets[${index}] has invalid kind ${JSON.stringify(target.kind)}` };
    }
    if (!repoPath) {
      return { ok: false, detail: `targets[${index}] is missing path` };
    }
    if (repoPath.startsWith('.codex/skill-ops/logs/') || repoPath.startsWith('.codex/quality/')) {
      return { ok: false, detail: `targets[${index}] must not include raw logs or .codex/quality: ${repoPath}` };
    }
    if (!isSkillOpsPromotionTargetPathAllowed(kind, repoPath)) {
      return { ok: false, detail: `targets[${index}] path not in durable SkillOps globs: ${repoPath}` };
    }
    const key = `${kind}:${repoPath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({ kind, path: repoPath });
  }
  return { ok: true, targets: normalized };
}

function normalizeSkillOpsPromotionPlanPayload(payload) {
  if (!isPlainObject(payload)) {
    return { ok: false, detail: 'plan-promotions output must be an object' };
  }
  if (readStringField(payload.kind) !== SKILLOPS_PROMOTION_PLAN_KIND) {
    return { ok: false, detail: `unexpected plan kind ${JSON.stringify(payload.kind)}` };
  }
  if (Number(payload.schemaVersion) !== SKILLOPS_PROMOTION_SCHEMA_VERSION) {
    return { ok: false, detail: `plan schemaVersion must be ${SKILLOPS_PROMOTION_SCHEMA_VERSION}` };
  }
  if (Number(payload.version) !== SKILLOPS_PROMOTION_PLAN_VERSION) {
    return { ok: false, detail: `plan version must be ${SKILLOPS_PROMOTION_PLAN_VERSION}` };
  }
  if (!Array.isArray(payload.sourceLogs)) {
    return { ok: false, detail: 'plan is missing sourceLogs[]' };
  }
  if (!Array.isArray(payload.targets)) {
    return { ok: false, detail: 'plan is missing targets[]' };
  }
  if (!Array.isArray(payload.items)) {
    return { ok: false, detail: 'plan is missing items[]' };
  }

  const normalizedSourceLogs = [];
  const sourceLogIds = [];
  const sourceLogIdSet = new Set();
  for (const [index, entry] of payload.sourceLogs.entries()) {
    if (!isPlainObject(entry)) return { ok: false, detail: `sourceLogs[${index}] must be an object` };
    const id = readStringField(entry.id);
    const relativePath = normalizeRepoPath(readStringField(entry.relativePath));
    if (!id) return { ok: false, detail: `sourceLogs[${index}] is missing id` };
    if (!relativePath || !relativePath.startsWith('.codex/skill-ops/logs/')) {
      return { ok: false, detail: `sourceLogs[${index}] must stay under .codex/skill-ops/logs/` };
    }
    if (sourceLogIdSet.has(id)) return { ok: false, detail: `sourceLogs contains duplicate id ${id}` };
    sourceLogIdSet.add(id);
    sourceLogIds.push(id);
    normalizedSourceLogs.push({
      id,
      relativePath,
      path: readStringField(entry.path),
      status: readStringField(entry.status),
      createdAt: readStringField(entry.createdAt) || '',
    });
  }

  const targetResult = normalizeSkillOpsPromotionTargets(payload.targets);
  if (!targetResult.ok) return targetResult;
  const targetKeySet = new Set(targetResult.targets.map((entry) => `${entry.kind}:${entry.path}`));
  const referencedTargetKeys = new Set();
  const referencedLogIds = new Set();

  for (const [index, item] of payload.items.entries()) {
    if (!isPlainObject(item)) return { ok: false, detail: `items[${index}] must be an object` };
    const mode = readStringField(item.promotionMode) || 'learned_block';
    const targetFile = normalizeRepoPath(readStringField(item.targetFile));
    if (!SKILLOPS_PROMOTION_MODES.includes(mode)) {
      return { ok: false, detail: `items[${index}] has invalid promotionMode ${JSON.stringify(item.promotionMode)}` };
    }
    if (!targetFile) return { ok: false, detail: `items[${index}] is missing targetFile` };
    if (!targetKeySet.has(`skill:${targetFile}`)) {
      return { ok: false, detail: `items[${index}] targetFile is not declared in targets[]: ${targetFile}` };
    }
    referencedTargetKeys.add(`skill:${targetFile}`);
    const additions = Array.isArray(item.additions) ? item.additions : [];
    if (additions.length === 0) return { ok: false, detail: `items[${index}] is missing additions[]` };
    for (const [additionIndex, addition] of additions.entries()) {
      if (!isPlainObject(addition)) {
        return { ok: false, detail: `items[${index}].additions[${additionIndex}] must be an object` };
      }
      const logId = readStringField(addition.logId);
      if (!logId || !sourceLogIdSet.has(logId)) {
        return {
          ok: false,
          detail: `items[${index}].additions[${additionIndex}] references unknown source log ${JSON.stringify(addition?.logId)}`,
        };
      }
      referencedLogIds.add(logId);
    }
    if (mode === 'canonical_section') {
      if (!readStringField(item.targetSection)) {
        return { ok: false, detail: `items[${index}] canonical_section is missing targetSection` };
      }
    } else {
      const archiveFile = normalizeRepoPath(readStringField(item.archiveFile));
      if (archiveFile && !targetKeySet.has(`archive:${archiveFile}`)) {
        return { ok: false, detail: `items[${index}] archiveFile is not declared in targets[]: ${archiveFile}` };
      }
      if (archiveFile) {
        referencedTargetKeys.add(`archive:${archiveFile}`);
      }
    }
  }

  for (const target of targetResult.targets) {
    const key = `${target.kind}:${target.path}`;
    if (!referencedTargetKeys.has(key)) {
      return { ok: false, detail: `targets[] contains unreferenced durable target ${target.path}` };
    }
  }
  for (const logId of sourceLogIds) {
    if (!referencedLogIds.has(logId)) {
      return { ok: false, detail: `sourceLogs contains unreferenced log id ${logId}` };
    }
  }

  return {
    ok: true,
    plan: {
      ...payload,
      kind: SKILLOPS_PROMOTION_PLAN_KIND,
      schemaVersion: SKILLOPS_PROMOTION_SCHEMA_VERSION,
      version: SKILLOPS_PROMOTION_PLAN_VERSION,
      sourceLogs: normalizedSourceLogs,
      sourceLogIds: sourceLogIds.sort((a, b) => a.localeCompare(b)),
      targets: targetResult.targets,
      targetPaths: targetResult.targets.map((entry) => entry.path).sort((a, b) => a.localeCompare(b)),
      skippableLogIds: Array.from(
        new Set((Array.isArray(payload.skippableLogIds) ? payload.skippableLogIds : []).map(readStringField).filter(Boolean)),
      ).sort((a, b) => a.localeCompare(b)),
    },
  };
}

function runSkillOpsCli({ cwd, args, timeoutMs = SKILLOPS_PROMOTION_CLI_TIMEOUT_MS }) {
  const command = ['scripts/skillops.mjs', ...args];
  try {
    const stdout = childProcess.execFileSync('node', command, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });
    return {
      ok: true,
      command: `node ${command.map((value) => JSON.stringify(value)).join(' ')}`,
      stdout: String(stdout || ''),
      stderr: '',
      exitCode: 0,
    };
  } catch (err) {
    return {
      ok: false,
      command: `node ${command.map((value) => JSON.stringify(value)).join(' ')}`,
      stdout: String(err?.stdout || ''),
      stderr: String(err?.stderr || ''),
      exitCode: Number(err?.status ?? 1) || 1,
    };
  }
}

function validateSkillOpsCapabilitiesPayload(payload) {
  const commandPayload = isPlainObject(payload?.commands) ? payload.commands : null;
  const commands = commandPayload ? Object.keys(commandPayload).map((value) => readStringField(value)).filter(Boolean) : [];
  const statuses = Array.isArray(payload?.statuses)
    ? payload.statuses.map((value) => readStringField(value)).filter(Boolean)
    : [];
  const contractVersion = Number(payload?.skillopsContractVersion);
  const capabilitiesVersion = Number(payload?.version);
  const distillMode =
    readStringField(payload?.distillMode) ||
    (['non_durable_preview', 'non_durable_local'].includes(readStringField(payload?.commands?.distill?.writes))
      ? 'non_durable'
      : '');
  const planKind = readStringField(payload?.plan?.kind);
  const planVersion = Number(payload?.plan?.version);
  const durableTargetKinds = Array.isArray(payload?.plan?.durableTargetKinds) ? payload.plan.durableTargetKinds : [];
  const markStatuses = Array.isArray(payload?.plan?.markStatuses) ? payload.plan.markStatuses : [];
  const promotionModes = Array.isArray(payload?.plan?.promotionModes) ? payload.plan.promotionModes : [];
  const logMetadataKeys = Array.isArray(payload?.plan?.logMetadataKeys) ? payload.plan.logMetadataKeys : [];
  if (readStringField(payload?.kind) !== SKILLOPS_PROMOTION_CAPABILITIES_KIND) {
    return { ok: false, reasonCode: 'skillops_cli_unsupported', detail: 'unexpected capabilities kind' };
  }
  if (Number(payload?.schemaVersion) !== SKILLOPS_PROMOTION_SCHEMA_VERSION) {
    return {
      ok: false,
      reasonCode: 'skillops_cli_unsupported',
      detail: `schemaVersion must be ${SKILLOPS_PROMOTION_SCHEMA_VERSION}`,
    };
  }
  if (
    !Number.isFinite(contractVersion) ||
    contractVersion !== SKILLOPS_PROMOTION_CONTRACT_VERSION ||
    !Number.isFinite(capabilitiesVersion) ||
    capabilitiesVersion !== SKILLOPS_PROMOTION_CONTRACT_VERSION
  ) {
    return {
      ok: false,
      reasonCode: 'skillops_cli_unsupported',
      detail: `skillops capabilities version mismatch; expected ${SKILLOPS_PROMOTION_CONTRACT_VERSION}`,
    };
  }
  if (!sameStringMembers(commands, SKILLOPS_PROMOTION_COMMANDS)) {
    return { ok: false, reasonCode: 'skillops_cli_unsupported', detail: 'commands surface mismatch' };
  }
  for (const commandName of SKILLOPS_PROMOTION_COMMANDS) {
    const expected = SKILLOPS_PROMOTION_COMMAND_METADATA[commandName];
    const actual = isPlainObject(commandPayload?.[commandName]) ? commandPayload[commandName] : null;
    if (!actual) {
      return { ok: false, reasonCode: 'skillops_cli_unsupported', detail: `${commandName} command surface mismatch` };
    }
    if (actual.json !== expected.json || readStringField(actual.writes) !== expected.writes) {
      return { ok: false, reasonCode: 'skillops_cli_unsupported', detail: `${commandName} command surface mismatch` };
    }
    const requiredFlags = Array.isArray(actual.requiredFlags) ? actual.requiredFlags : [];
    if (!sameStringMembers(requiredFlags, expected.requiredFlags)) {
      return { ok: false, reasonCode: 'skillops_cli_unsupported', detail: `${commandName} command surface mismatch` };
    }
    const optionalFlags = Array.isArray(actual.optionalFlags) ? actual.optionalFlags : [];
    if (!sameStringMembers(optionalFlags, expected.optionalFlags)) {
      return { ok: false, reasonCode: 'skillops_cli_unsupported', detail: `${commandName} command surface mismatch` };
    }
  }
  if (!sameStringMembers(statuses, SKILLOPS_PROMOTION_STATUSES)) {
    return { ok: false, reasonCode: 'skillops_cli_unsupported', detail: 'statuses surface mismatch' };
  }
  if (distillMode !== 'non_durable') {
    return { ok: false, reasonCode: 'skillops_cli_unsupported', detail: 'distillMode must be non_durable' };
  }
  if (planKind !== SKILLOPS_PROMOTION_PLAN_KIND || planVersion !== SKILLOPS_PROMOTION_PLAN_VERSION) {
    return { ok: false, reasonCode: 'skillops_cli_unsupported', detail: 'plan kind/version mismatch' };
  }
  if (!sameStringMembers(durableTargetKinds, SKILLOPS_PROMOTION_TARGET_KINDS)) {
    return { ok: false, reasonCode: 'skillops_cli_unsupported', detail: 'plan durableTargetKinds mismatch' };
  }
  if (!sameStringMembers(markStatuses, SKILLOPS_PROMOTION_MARK_STATUSES)) {
    return { ok: false, reasonCode: 'skillops_cli_unsupported', detail: 'plan markStatuses mismatch' };
  }
  if (!sameStringMembers(promotionModes, SKILLOPS_PROMOTION_MODES)) {
    return { ok: false, reasonCode: 'skillops_cli_unsupported', detail: 'plan promotionModes mismatch' };
  }
  if (!sameStringMembers(logMetadataKeys, SKILLOPS_PROMOTION_LOG_METADATA_KEYS)) {
    return { ok: false, reasonCode: 'skillops_cli_unsupported', detail: 'plan logMetadataKeys mismatch' };
  }
  if (payload?.plan?.checkoutScopedMarkPromoted !== true) {
    return { ok: false, reasonCode: 'skillops_cli_unsupported', detail: 'plan checkoutScopedMarkPromoted must be true' };
  }
  if (readStringField(payload?.plan?.canonicalSectionMarkerPrefix) !== SKILLOPS_PROMOTION_CANONICAL_SECTION_MARKER_PREFIX) {
    return { ok: false, reasonCode: 'skillops_cli_unsupported', detail: 'plan canonicalSectionMarkerPrefix mismatch' };
  }
  return {
    ok: true,
    reasonCode: '',
    detail: '',
    capabilities: {
      kind: readStringField(payload?.kind) || null,
      schemaVersion: Number(payload?.schemaVersion) || null,
      skillopsContractVersion: contractVersion,
      version: capabilitiesVersion,
      commands,
      statuses,
      distillMode,
    },
  };
}

function runSkillOpsCapabilitiesPreflight({ cwd, reasonCode = 'skillops_cli_unsupported' }) {
  const commandResult = runSkillOpsCli({ cwd, args: ['capabilities', '--json'] });
  if (!commandResult.ok) {
    return {
      ok: false,
      reasonCode,
      detail: commandResult.stderr || commandResult.stdout || 'capabilities command failed',
      command: commandResult.command,
      exitCode: commandResult.exitCode,
    };
  }
  const payload = parseLastJsonLine(commandResult.stdout);
  if (!payload) {
    return {
      ok: false,
      reasonCode,
      detail: 'capabilities output missing JSON',
      command: commandResult.command,
      exitCode: commandResult.exitCode,
    };
  }
  const validation = validateSkillOpsCapabilitiesPayload(payload);
  if (!validation.ok) {
    return {
      ok: false,
      reasonCode,
      detail: validation.detail,
      command: commandResult.command,
      exitCode: commandResult.exitCode,
      capabilities: payload,
    };
  }
  return {
    ok: true,
    reasonCode: '',
    detail: '',
    command: commandResult.command,
    exitCode: 0,
    capabilities: validation.capabilities,
  };
}

function runSkillOpsPlanPromotions({ cwd }) {
  const commandResult = runSkillOpsCli({ cwd, args: ['plan-promotions', '--json'] });
  if (!commandResult.ok) {
    return {
      ok: false,
      reasonCode: 'skillops_promotion_handoff_failed',
      detail: commandResult.stderr || commandResult.stdout || 'plan-promotions failed',
      command: commandResult.command,
      exitCode: commandResult.exitCode,
      plan: null,
    };
  }
  const payload = parseLastJsonLine(commandResult.stdout);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {
      ok: false,
      reasonCode: 'skillops_promotion_handoff_failed',
      detail: 'plan-promotions output missing JSON',
      command: commandResult.command,
      exitCode: commandResult.exitCode,
      plan: null,
    };
  }
  return {
    ...(function () {
      const normalizedPlan = normalizeSkillOpsPromotionPlanPayload(payload);
      if (!normalizedPlan.ok) {
        return {
          ok: false,
          reasonCode: 'skillops_promotion_handoff_failed',
          detail: normalizedPlan.detail,
          command: commandResult.command,
          exitCode: commandResult.exitCode,
          plan: null,
        };
      }
      return {
        ok: true,
        reasonCode: '',
        detail: '',
        command: commandResult.command,
        exitCode: 0,
        plan: normalizedPlan.plan,
      };
    })(),
  };
}

function runSkillOpsMarkPromoted({ cwd, planPath, status, promotionTaskId = '' }) {
  const args = ['mark-promoted', '--plan', planPath, '--status', status];
  if (status === 'queued') args.push('--promotion-task-id', promotionTaskId);
  const result = runSkillOpsCli({ cwd, args });
  const failureReasonCode =
    status === 'skipped'
      ? 'skillops_skip_mark_failed'
      : status === 'queued'
        ? 'skillops_promotion_handoff_failed'
        : 'skillops_promotion_mark_processed_failed';
  return {
    ok: result.ok,
    reasonCode: result.ok ? '' : failureReasonCode,
    detail: result.ok ? '' : result.stderr || result.stdout || `mark-promoted ${status} failed`,
    command: result.command,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function runSkillOpsApplyPromotions({ cwd, planPath }) {
  const args = ['scripts/skillops.mjs', 'apply-promotions', '--plan', planPath];
  const result = childProcess.spawnSync('node', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: SKILLOPS_PROMOTION_CLI_TIMEOUT_MS,
  });
  return {
    ok: result.status === 0,
    reasonCode: result.status === 0 ? '' : 'controller_housekeeping_restore_failed',
    detail: result.status === 0 ? '' : result.stderr || result.stdout || 'apply-promotions failed',
    command: `node ${args.join(' ')}`,
    exitCode: result.status ?? null,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
  };
}

function readGitCommonDir(cwd) {
  const raw = safeExecText('git', ['rev-parse', '--git-common-dir'], { cwd }) || '';
  if (!raw) return '';
  return path.resolve(cwd, raw);
}

function parseGitWorktreePaths(raw) {
  return String(raw || '')
    .split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length).trim())
    .filter(Boolean)
    .map((value) => path.resolve(value));
}

function getControllerHousekeepingPlanPath({ busRoot, agentName, fingerprint, generation }) {
  return path.join(
    path.dirname(getControllerHousekeepingStatePath({ busRoot, agentName, fingerprint })),
    `${safeIdToken(fingerprint)}__g${Math.max(1, Number(generation) || 1)}.plan.json`,
  );
}

function buildControllerHousekeepingScratchWorkdir({ worktreesDir, agentName, fingerprint }) {
  return path.join(
    worktreesDir,
    `${safeIdToken(agentName)}-controller-housekeeping-${safeIdToken(fingerprint).slice(0, 32)}`,
  );
}

function runGitSync(args, { cwd }) {
  const result = childProcess.spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    ok: result.status === 0,
    status: result.status ?? 1,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
    command: `git ${args.join(' ')}`,
  };
}

function normalizeRepoPathsList(repoPaths, { sort = true } = {}) {
  const normalizedPaths = Array.isArray(repoPaths)
    ? repoPaths.map((value) => readStringField(value)).filter(Boolean)
    : [];
  return sort ? normalizedPaths.sort((a, b) => a.localeCompare(b)) : normalizedPaths;
}

function readGitSyncError(result) {
  return result.ok ? '' : result.stderr || result.stdout || result.command;
}

function readGitDiffForPaths({ cwd, repoPaths }) {
  const normalizedPaths = normalizeRepoPathsList(repoPaths);
  if (normalizedPaths.length === 0) return { ok: true, diff: '' };
  const result = runGitSync(['diff', '--no-ext-diff', '--binary', 'HEAD', '--', ...normalizedPaths], { cwd });
  return {
    ok: result.ok,
    diff: result.ok ? result.stdout : '',
    error: readGitSyncError(result),
  };
}

function restoreHeadPaths({ cwd, repoPaths }) {
  const normalizedPaths = normalizeRepoPathsList(repoPaths);
  if (normalizedPaths.length === 0) return { ok: true, error: '' };
  const result = runGitSync(['checkout', 'HEAD', '--', ...normalizedPaths], { cwd });
  return {
    ok: result.ok,
    error: readGitSyncError(result),
  };
}

async function ensureControllerHousekeepingScratchWorkdir({
  repoRoot,
  runtimeRoot,
  worktreesDir,
  agenticWorktreesDir,
  valuaWorktreesDir,
  agentName,
  sourceWorkdir,
  fingerprint,
  headSha,
}) {
  const sourceCommonDir = readGitCommonDirOrThrow({
    cwd: sourceWorkdir, onMissing: () => { throw new Error('controller housekeeping source workdir is not a git repo'); },
  });
  const scratchWorkdir = buildControllerHousekeepingScratchWorkdir({ worktreesDir, agentName, fingerprint });
  const validation = validateDedicatedAgentWorkdir({
    agentName,
    rawWorkdir: scratchWorkdir,
    repoRoot,
    runtimeRoot,
    worktreesDir,
    agenticWorktreesDir,
    valuaWorktreesDir,
  });
  if (!validation.ok) {
    throw new Error(`controller housekeeping scratch workdir invalid: ${validation.reasonCode}`);
  }
  const listedBefore = new Set(
    parseGitWorktreePaths(safeExecText('git', ['worktree', 'list', '--porcelain'], { cwd: sourceWorkdir }) || ''),
  );
  const resolvedScratch = path.resolve(scratchWorkdir);
  let scratchExists = false;
  try {
    await fs.stat(resolvedScratch);
    scratchExists = true;
  } catch {
    scratchExists = false;
  }
  if (!listedBefore.has(resolvedScratch)) {
    if (scratchExists) {
      throw new Error('controller housekeeping scratch workdir exists but is not a registered worktree');
    }
    const add = runGitSync(['worktree', 'add', '--detach', resolvedScratch, headSha || 'HEAD'], { cwd: sourceWorkdir });
    if (!add.ok) {
      throw new Error(add.stderr || add.stdout || 'failed to create controller housekeeping scratch worktree');
    }
  }
  const listedAfter = new Set(
    parseGitWorktreePaths(safeExecText('git', ['worktree', 'list', '--porcelain'], { cwd: sourceWorkdir }) || ''),
  );
  if (!listedAfter.has(resolvedScratch)) {
    throw new Error('controller housekeeping scratch workdir is not a registered worktree');
  }
  const scratchCommonDir = readGitCommonDir(resolvedScratch);
  if (!scratchCommonDir || scratchCommonDir !== sourceCommonDir) {
    throw new Error('controller housekeeping scratch workdir points at a different repository');
  }
  for (const args of [
    ['reset', '--hard', headSha || 'HEAD'],
    ['clean', '-fdx'],
  ]) {
    const result = runGitSync(args, { cwd: resolvedScratch });
    if (!result.ok) {
      throw new Error(result.stderr || result.stdout || `failed to prepare scratch workdir via ${result.command}`);
    }
  }
  const actualHead = normalizeShaCandidate(safeExecText('git', ['rev-parse', 'HEAD'], { cwd: resolvedScratch }) || '');
  if (headSha && actualHead !== normalizeShaCandidate(headSha)) {
    throw new Error(`controller housekeeping scratch workdir did not reset to ${headSha}`);
  }
  return resolvedScratch;
}

async function cleanupControllerHousekeepingScratchWorkdir({ sourceWorkdir, scratchWorkdir }) {
  const resolvedScratch = path.resolve(scratchWorkdir);
  const result = runGitSync(['worktree', 'remove', '--force', resolvedScratch], { cwd: sourceWorkdir });
  if (result.ok) {
    return { ok: true, detail: '' };
  }
  const pruneBeforeFallback = runGitSync(['worktree', 'prune'], { cwd: sourceWorkdir });
  if (!pruneBeforeFallback.ok) {
    return {
      ok: false,
      detail: `failed to prune scratch worktree metadata after remove failure: ${readGitSyncError(pruneBeforeFallback) || readGitSyncError(result)}`,
    };
  }
  const listed = runGitSync(['worktree', 'list', '--porcelain'], { cwd: sourceWorkdir });
  if (!listed.ok) {
    return {
      ok: false,
      detail: `failed to inspect scratch worktree registration after remove failure: ${readGitSyncError(listed)}`,
    };
  }
  if (new Set(parseGitWorktreePaths(listed.stdout)).has(resolvedScratch)) {
    return {
      ok: false,
      detail: `scratch worktree still registered after remove failure: ${readGitSyncError(result)}`,
    };
  }
  try {
    await fs.rm(resolvedScratch, { recursive: true, force: true });
  } catch (err) {
    return {
      ok: false,
      detail: `scratch worktree filesystem cleanup failed: ${(err && err.message) || String(err)}`,
    };
  }
  const pruneAfterFallback = runGitSync(['worktree', 'prune'], { cwd: sourceWorkdir });
  if (!pruneAfterFallback.ok) {
    return {
      ok: false,
      detail: `failed to prune scratch worktree metadata after filesystem fallback: ${readGitSyncError(pruneAfterFallback)}`,
    };
  }
  return { ok: true, detail: '' };
}

async function copyRepoPathsBetweenWorktrees({ sourceWorkdir, targetWorkdir, repoPaths }) {
  const normalizedPaths = normalizeRepoPathsList(repoPaths, { sort: false });
  for (const repoPath of normalizedPaths) {
    const sourcePath = path.join(sourceWorkdir, repoPath);
    const targetPath = path.join(targetWorkdir, repoPath);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.copyFile(sourcePath, targetPath);
  }
}

function resolveSkillOpsPromotionBase({ cwd }) {
  const candidates = [
    safeExecText('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd }) || '',
    'origin/main',
    'origin/master',
    safeExecText('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd }) || '',
  ].filter(Boolean);
  const seen = new Set();
  for (const candidate of candidates) {
    const branch = parseRemoteBranchRef(candidate).branch || normalizeBranchRefText(candidate);
    if (!branch || seen.has(branch)) continue;
    seen.add(branch);
    const shaCandidates = Array.from(
      new Set([candidate, `refs/remotes/origin/${branch}`, `origin/${branch}`, branch]),
    );
    for (const shaRef of shaCandidates) {
      const sha = normalizeShaCandidate(safeExecText('git', ['rev-parse', shaRef], { cwd }) || '');
      if (!sha) continue;
      return { baseRef: branch, baseSha: sha };
    }
  }
  return { baseRef: '', baseSha: '' };
}

function resolveRequiredSkillOpsPromotionBase({ cwd, reasonCode, detail }) {
  const { baseRef, baseSha } = resolveSkillOpsPromotionBase({ cwd });
  if (baseRef && baseSha) {
    return { ok: true, baseRef, baseSha };
  }
  return {
    ok: false,
    reasonCode,
    detail,
  };
}

function failControllerHousekeepingPromotionHandoff(
  detail,
  reasonCode = 'controller_housekeeping_promotion_handoff_failed',
  evidence = null,
) {
  return {
    ok: false,
    reasonCode,
    detail,
    evidence,
  };
}

async function readSkillOpsPromotionState({ busRoot, agentName, rootId }) {
  const statePath = getSkillOpsPromotionStatePath({ busRoot, agentName, rootId });
  try {
    const parsed = JSON.parse(await fs.readFile(statePath, 'utf8'));
    return { path: statePath, payload: parsed };
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

async function writeSkillOpsPromotionState({
  busRoot,
  agentName,
  rootId,
  patch,
}) {
  const statePath = getSkillOpsPromotionStatePath({ busRoot, agentName, rootId });
  const existing = (await readSkillOpsPromotionState({ busRoot, agentName, rootId }))?.payload || {};
  const next = {
    ...existing,
    ...(isPlainObject(patch) ? patch : {}),
  };
  await writeJsonAtomic(statePath, next);
  return { statePath, payload: next };
}

function validateActiveSkillOpsPromotionStatePayload(payload) {
  if (!isPlainObject(payload)) {
    return { ok: false, reasonCode: 'skillops_promotion_legacy_state', detail: 'skillops promotion state is missing or invalid' };
  }
  if (Number(payload.stateVersion) !== SKILLOPS_PROMOTION_STATE_VERSION) {
    return {
      ok: false,
      reasonCode: 'skillops_promotion_legacy_state',
      detail: `skillops promotion stateVersion must be ${SKILLOPS_PROMOTION_STATE_VERSION}`,
    };
  }
  if (Number(payload.planVersion) !== SKILLOPS_PROMOTION_PLAN_VERSION) {
    return {
      ok: false,
      reasonCode: 'skillops_promotion_legacy_state',
      detail: `skillops promotion planVersion must be ${SKILLOPS_PROMOTION_PLAN_VERSION}`,
    };
  }
  return { ok: true };
}

async function readNormalizedSkillOpsPromotionPlanFile(planPath, reasonCode) {
  try {
    const parsed = JSON.parse(await fs.readFile(planPath, 'utf8'));
    const normalized = normalizeSkillOpsPromotionPlanPayload(parsed);
    if (!normalized.ok) {
      return { ok: false, reasonCode, detail: normalized.detail, plan: null };
    }
    return { ok: true, reasonCode: '', detail: '', plan: normalized.plan };
  } catch (err) {
    return {
      ok: false,
      reasonCode,
      detail: `failed to read promotion plan: ${(err && err.message) || String(err)}`,
      plan: null,
    };
  }
}

function isSkillOpsPromotionTask(openedMeta) {
  return (
    normalizeTaskKind(openedMeta?.signals?.sourceKind) === 'SKILLOPS_PROMOTION' &&
    readStringField(openedMeta?.signals?.phase) === 'skillops-promotion'
  );
}

function isControllerHousekeepingTask(openedMeta) {
  return (
    normalizeTaskKind(openedMeta?.signals?.sourceKind) === 'AUTOPILOT_CONTROLLER_HOUSEKEEPING' &&
    readStringField(openedMeta?.signals?.phase) === 'controller-housekeeping'
  );
}

function isProcessAlive(pid) {
  const numeric = Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 0) return false;
  try {
    process.kill(numeric, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

async function acquireSkillOpsPromotionLock({ busRoot, agentName, ownerTaskId }) {
  const lockPath = getSkillOpsPromotionLockPath({ busRoot, agentName });
  const lockToken = crypto.randomUUID();
  const payload = {
    lockToken,
    ownerTaskId,
    ownerPid: process.pid,
    controllerAgent: agentName,
    acquiredAt: new Date().toISOString(),
  };
  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await fs.writeFile(lockPath, JSON.stringify(payload, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
      return {
        ok: true,
        path: lockPath,
        release: async () => {
          try {
            const current = JSON.parse(await fs.readFile(lockPath, 'utf8'));
            if (readStringField(current?.lockToken) !== lockToken) return;
            if (readStringField(current?.ownerTaskId) !== ownerTaskId) return;
            if (Number(current?.ownerPid) !== process.pid) return;
            await fs.rm(lockPath, { force: true });
          } catch {
            // ignore
          }
        },
      };
    } catch (err) {
      if (err?.code !== 'EEXIST') {
        return {
          ok: false,
          reasonCode: 'skillops_promotion_lock_invalid',
          detail: (err && err.message) || String(err),
        };
      }
    }

    let stat = null;
    try {
      stat = await fs.stat(lockPath);
    } catch {
      continue;
    }
    try {
      const existing = JSON.parse(await fs.readFile(lockPath, 'utf8'));
      if (isProcessAlive(existing?.ownerPid)) {
        return {
          ok: false,
          reasonCode: 'skillops_promotion_busy',
          detail: `lock held by ${readStringField(existing?.ownerTaskId) || 'unknown_task'}`,
        };
      }
      await fs.rm(lockPath, { force: true });
      continue;
    } catch {
      const ageMs = Date.now() - Number(stat?.mtimeMs || 0);
      if (Number.isFinite(ageMs) && ageMs < SKILLOPS_PROMOTION_LOCK_STALE_MS) {
        return {
          ok: false,
          reasonCode: 'skillops_promotion_busy',
          detail: 'fresh unreadable promotion lock present',
        };
      }
      try {
        await fs.rm(lockPath, { force: true });
      } catch (rmErr) {
        return {
          ok: false,
          reasonCode: 'skillops_promotion_lock_invalid',
          detail: (rmErr && rmErr.message) || String(rmErr),
        };
      }
    }
  }

  return {
    ok: false,
    reasonCode: 'skillops_promotion_lock_invalid',
    detail: 'failed to acquire promotion lock after stale-lock cleanup',
  };
}

async function ensureSkillOpsPromotionCurationWorkdir({
  sourceWorkdir,
  curationWorkdir,
  workBranch,
  baseRef,
  baseSha,
}) {
  const sourceCommonDir = readGitCommonDirOrThrow({
    cwd: sourceWorkdir,
    onMissing: () => {
      throwSkillOpsPromotionInvalid('skillops promotion source workdir is not a git repo', { sourceWorkdir });
    },
  });
  const listedWorktrees = new Set(
    parseGitWorktreePaths(safeExecText('git', ['worktree', 'list', '--porcelain'], { cwd: sourceWorkdir }) || ''),
  );
  const resolvedCurationWorkdir = path.resolve(curationWorkdir);
  let curationExists = false;
  try {
    await fs.stat(resolvedCurationWorkdir);
    curationExists = true;
  } catch {
    curationExists = false;
  }

  if (!listedWorktrees.has(resolvedCurationWorkdir)) {
    if (curationExists) {
      throwSkillOpsPromotionInvalid('skillops promotion curation workdir exists but is not a registered worktree', {
        curationWorkdir: resolvedCurationWorkdir,
      });
    }
    const targetRef = baseSha || baseRef || 'HEAD';
    const add = childProcess.spawnSync('git', ['worktree', 'add', '--force', '-B', workBranch, resolvedCurationWorkdir, targetRef], {
      cwd: sourceWorkdir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (add.status !== 0) {
      throwSkillOpsPromotionInvalid('failed to create skillops promotion curation worktree', {
        curationWorkdir: resolvedCurationWorkdir,
        stderr: String(add.stderr || '').trim(),
      });
    }
  }

  const curationCommonDir = readGitCommonDir(resolvedCurationWorkdir);
  if (!curationCommonDir || curationCommonDir !== sourceCommonDir) {
    throwSkillOpsPromotionInvalid('skillops promotion curation workdir points at a different repository', {
      sourceWorkdir,
      curationWorkdir: resolvedCurationWorkdir,
    });
  }
  const targetRef = baseSha || baseRef || 'HEAD';
  for (const args of [
    ['reset', '--hard'],
    ['clean', '-fdx'],
    ['checkout', '-B', workBranch, targetRef],
    ['reset', '--hard', targetRef],
    ['clean', '-fdx'],
  ]) {
    const result = childProcess.spawnSync('git', args, {
      cwd: resolvedCurationWorkdir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.status !== 0) {
      throwSkillOpsPromotionInvalid('failed to prepare deterministic skillops promotion curation workdir', {
        curationWorkdir: resolvedCurationWorkdir,
        command: `git ${args.join(' ')}`,
        stderr: String(result.stderr || '').trim(),
      });
    }
  }
  if (baseSha) {
    const headSha = normalizeShaCandidate(safeExecText('git', ['rev-parse', 'HEAD'], { cwd: resolvedCurationWorkdir }) || '');
    if (!headSha || headSha !== normalizeShaCandidate(baseSha)) {
      throwSkillOpsPromotionInvalid('skillops promotion curation workdir did not reset to baseSha', {
        curationWorkdir: resolvedCurationWorkdir,
        expectedBaseSha: baseSha,
        headSha,
      });
    }
  }
  return resolvedCurationWorkdir;
}

async function verifySkillOpsPromotionResult({ cwd, workBranch, baseBranch, commitSha }) {
  const normalizedCommitSha = normalizeShaCandidate(commitSha);
  const normalizedWorkBranch = normalizeBranchRefText(workBranch);
  const normalizedBaseBranch = normalizeBranchRefText(baseBranch);
  if (!normalizedCommitSha) {
    return { ok: false, reasonCode: 'skillops_promotion_commit_missing', detail: 'commitSha is required' };
  }
  if (!normalizedWorkBranch || !normalizedBaseBranch) {
    return { ok: false, reasonCode: 'skillops_promotion_invalid', detail: 'missing workBranch or baseBranch' };
  }
  childProcess.spawnSync('git', ['fetch', 'origin', '--prune', normalizedWorkBranch], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const branchContains = childProcess.spawnSync(
    'git',
    ['merge-base', '--is-ancestor', normalizedCommitSha, `origin/${normalizedWorkBranch}`],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (branchContains.status !== 0) {
    return {
      ok: false,
      reasonCode: 'skillops_promotion_push_unverified',
      detail: `origin/${normalizedWorkBranch} does not contain ${normalizedCommitSha}`,
    };
  }
  const prList = childProcess.spawnSync(
    'gh',
    ['pr', 'list', '--head', normalizedWorkBranch, '--base', normalizedBaseBranch, '--state', 'open', '--json', 'number,url'],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (prList.status !== 0) {
    return {
      ok: false,
      reasonCode: 'skillops_promotion_pr_unverified',
      detail: String(prList.stderr || '').trim() || 'gh pr list failed',
    };
  }
  let prs = [];
  try {
    prs = JSON.parse(String(prList.stdout || '[]'));
  } catch {
    prs = [];
  }
  const openPr = Array.isArray(prs) ? prs[0] : null;
  if (!openPr?.number || !openPr?.url) {
    return {
      ok: false,
      reasonCode: 'skillops_promotion_pr_unverified',
      detail: `no open PR from ${normalizedWorkBranch} to ${normalizedBaseBranch}`,
    };
  }
  return {
    ok: true,
    reasonCode: '',
    detail: '',
    prNumber: Number(openPr.number) || null,
    prUrl: readStringField(openPr.url) || null,
    remoteCommitSha: normalizedCommitSha,
  };
}

async function queueSkillOpsPromotionTask({ busRoot, meta, body }) {
  const existing = await findTaskPath({ busRoot, agentName: meta.to?.[0], taskId: meta.id });
  if (existing && existing.state !== 'processed') {
    return { queued: false, reason: 'already_present', path: existing.path };
  }
  if (existing?.state === 'processed') {
    await fs.rm(existing.path, { force: true });
  }
  const delivered = await deliverTask({ busRoot, meta, body });
  return { queued: true, reason: existing ? 'requeued' : 'queued', path: delivered.paths[0] ?? null };
}

function buildSkillOpsPromotionTaskBody({
  rootId,
  sourceTaskId,
  branch,
  baseRef,
  planPath,
}) {
  return (
    `SkillOps promotion lane for root ${rootId}.\n\n` +
    `Source task: ${sourceTaskId}\n` +
    `Promotion plan: ${planPath}\n` +
    `Base branch: ${baseRef}\n` +
    `Branch: ${branch}\n\n` +
    `Run only this flow in the dedicated curation worktree:\n` +
    `1. Run \`node scripts/skillops.mjs apply-promotions --plan ${planPath}\`\n` +
    `2. Run \`node scripts/skillops.mjs lint\`\n` +
    `3. Commit only manifest durableTargets\n` +
    `4. Never commit .codex/skill-ops/logs/** or .codex/quality/**\n` +
    `5. Push ${branch}\n` +
    `6. Open or update a PR from ${branch} to ${baseRef}\n`
  );
}

function readOpenedRootSourceTaskIds(openedMeta) {
  const rootId = readOpenedRootId(openedMeta);
  return {
    rootId,
    sourceTaskId: readStringField(openedMeta?.id) || rootId,
  };
}

function readRequiredGitCommonDir(cwd) {
  return readGitCommonDir(cwd) || '';
}

function readGitCommonDirOrThrow({ cwd, onMissing }) {
  const commonDir = readGitCommonDir(cwd);
  if (commonDir) return commonDir;
  onMissing();
  return '';
}

function isPathWithinRoot(rootPath, candidatePath) {
  const relativePath = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return (
    relativePath !== '' &&
    relativePath !== '.' &&
    !relativePath.startsWith('..') &&
    !path.isAbsolute(relativePath)
  );
}

function buildSkillOpsPromotionIdentity({ agentName, rootId, worktreesDir }) {
  return {
    promotionTaskId: buildSkillOpsPromotionTaskId({ agentName, rootId }),
    branch: buildSkillOpsPromotionBranchName({ agentName, rootId }),
    curationWorkdir: buildSkillOpsPromotionCurationWorkdir({ worktreesDir, agentName }),
  };
}

function buildSkillOpsPromotionTaskMeta({
  agentName,
  openedMeta,
  rootId,
  sourceTaskId,
  sourceWorkdir,
  planPath,
  promotionTaskId,
  curationWorkdir,
  branch,
  baseRef,
  baseSha,
}) {
  return {
    id: promotionTaskId,
    to: [agentName],
    from: agentName,
    priority: readStringField(openedMeta?.priority) || 'P2',
    title: `SKILLOPS_PROMOTION: ${readStringField(openedMeta?.title) || rootId}`,
    signals: {
      kind: 'EXECUTE', sourceKind: 'SKILLOPS_PROMOTION', phase: 'skillops-promotion',
      rootId,
      parentId: sourceTaskId,
      smoke: Boolean(openedMeta?.signals?.smoke),
      notifyOrchestrator: false,
    },
    references: {
      parentTaskId: sourceTaskId,
      parentRootId: rootId,
      sourceTaskId,
      sourceWorkdir,
      skillopsPromotion: {
        promotionTaskId,
        planPath,
        sourceWorkdir,
        curationWorkdir,
      },
      git: {
        baseBranch: baseRef,
        baseSha,
        workBranch: branch,
        integrationBranch: baseRef,
      },
    },
  };
}

function classifyControllerDirtySnapshot({
  busRoot,
  cwd,
  agentName,
  snapshot,
  autoCleanRuntimeArtifacts = false,
}) {
  const repoCommonGitDir = readGitCommonDir(cwd);
  return {
    repoCommonGitDir,
    dirtyClassification: classifyControllerDirtyWorktree({
      cwd,
      statusPorcelain: String(snapshot?.statusPorcelain || ''),
      agentName,
      branch: readStringField(snapshot?.branch),
      repoCommonGitDir,
      headSha: readStringField(snapshot?.headSha),
      skillOpsPromotionStateDir: getSkillOpsPromotionStateDir({ busRoot, agentName }),
      autoCleanRuntimeArtifacts,
    }),
  };
}

function resolveSkillOpsPromotionDispatchContext({
  cwd,
  agentName,
  rootId,
  worktreesDir,
  reasonCode,
  detail,
}) {
  const promotionBase = resolveRequiredSkillOpsPromotionBase({ cwd, reasonCode, detail });
  if (!promotionBase.ok) return promotionBase;
  return {
    ok: true,
    ...promotionBase,
    ...buildSkillOpsPromotionIdentity({ agentName, rootId, worktreesDir }),
  };
}

async function queueSkillOpsPromotionDispatch({
  busRoot,
  taskMeta,
  rootId,
  sourceTaskId,
  branch,
  baseRef,
  planPath,
}) {
  return queueSkillOpsPromotionTask({
    busRoot,
    meta: taskMeta,
    body: buildSkillOpsPromotionTaskBody({
      rootId,
      sourceTaskId,
      branch,
      baseRef,
      planPath,
    }),
  });
}

function normalizeSkillOpsPromotionSourceLogIds(sourceLogIds) {
  return Array.isArray(sourceLogIds)
    ? sourceLogIds.map(readStringField).filter(Boolean).sort((a, b) => a.localeCompare(b))
    : [];
}

async function findLiveSkillOpsPromotionTaskPacket({ busRoot, agentName, taskId }) {
  const existing = await findTaskPath({ busRoot, agentName, taskId });
  return existing && existing.state !== 'processed' ? existing : null;
}

async function rollbackQueuedSkillOpsPromotionDispatch({
  busRoot,
  agentName,
  promotionTaskId,
  queuedTask,
  statePath,
  previousState,
}) {
  const rollback = {
    queuedTask: {
      status: queuedTask?.queued ? 'pending_removal' : 'reused_not_removed',
      path: readStringField(queuedTask?.path),
      detail: '',
    },
    state: {
      status: 'pending_restore',
      path: readStringField(statePath),
      detail: '',
    },
  };

  if (queuedTask?.queued) {
    const packetPath = readStringField(queuedTask?.path);
    if (!packetPath) {
      rollback.queuedTask.status = 'missing';
      rollback.queuedTask.detail = 'newly queued promotion task path missing during rollback';
    } else {
      try {
        await fs.rm(packetPath, { force: false });
        rollback.queuedTask.status = 'removed';
      } catch (err) {
        if (err?.code === 'ENOENT') {
          rollback.queuedTask.status = 'missing';
          rollback.queuedTask.detail = 'newly queued promotion task disappeared before rollback';
        } else {
          rollback.queuedTask.status = 'failed';
          rollback.queuedTask.detail = (err && err.message) || String(err);
        }
      }
    }
  }

  try {
    if (previousState) {
      await writeJsonAtomic(statePath, previousState);
      rollback.state.status = 'restored';
    } else {
      await fs.rm(statePath, { force: true });
      rollback.state.status = 'deleted';
    }
  } catch (err) {
    rollback.state.status = 'failed';
    rollback.state.detail = (err && err.message) || String(err);
  }

  const livePacket = queuedTask?.queued
    ? await findLiveSkillOpsPromotionTaskPacket({ busRoot, agentName, taskId: promotionTaskId })
    : null;
  if (queuedTask?.queued && livePacket) {
    rollback.queuedTask.status = 'failed';
    rollback.queuedTask.detail = `newly queued promotion task still present at ${livePacket.path}`;
  }

  const packetRollbackOk = !queuedTask?.queued || rollback.queuedTask.status === 'removed';
  const stateRollbackOk = rollback.state.status === 'restored' || rollback.state.status === 'deleted';
  return {
    ok: packetRollbackOk && stateRollbackOk && !livePacket,
    rollback,
  };
}

function buildMissingSkillOpsPromotionSourceFailure(reasonCode) {
  return {
    ok: false,
    reasonCode,
    detail: 'missing rootId or sourceTaskId',
    evidence: null,
  };
}

function readRequiredOpenedRootSourceTaskIds(openedMeta, reasonCode) {
  const { rootId, sourceTaskId } = readOpenedRootSourceTaskIds(openedMeta);
  if (!rootId || !sourceTaskId) {
    return buildMissingSkillOpsPromotionSourceFailure(reasonCode);
  }
  return {
    ok: true,
    rootId,
    sourceTaskId,
  };
}

function buildSkillOpsPromotionStateEvidence({
  existingState,
  sourceLogIds = null,
  targetPaths = null,
  promotionTaskId = '',
}) {
  return {
    existingState,
    ...(Array.isArray(sourceLogIds) ? { sourceLogIds } : {}),
    ...(Array.isArray(targetPaths) ? { targetPaths } : {}),
    ...(promotionTaskId ? { promotionTaskId } : {}),
  };
}

function buildSkillOpsPromotionRuntimeContext({
  busRoot,
  agentName,
  openedMeta,
  taskCwd,
  worktreesDir,
}) {
  return {
    busRoot,
    agentName,
    openedMeta,
    taskCwd,
    worktreesDir,
  };
}

function normalizeSkillOpsPromotionPinnedPath(value) {
  const normalized = readStringField(value);
  return normalized ? path.resolve(normalized) : '';
}

function validateClaimedSkillOpsPromotionQueuedState({
  payload,
  promotionTaskId,
  planPath,
  sourceWorkdir,
  curationWorkdir,
  branch,
  baseRef,
  baseSha,
}) {
  const activeValidation = validateActiveSkillOpsPromotionStatePayload(payload);
  if (!activeValidation.ok) {
    return activeValidation;
  }
  const status = readStringField(payload?.status);
  if (status !== 'queued') {
    return {
      ok: false,
      reasonCode: 'skillops_promotion_legacy_state',
      detail: `skillops promotion state must stay queued until claim (got ${JSON.stringify(status || '')})`,
    };
  }
  const fieldMismatches = [
    ['promotionTaskId', readStringField(payload?.promotionTaskId), readStringField(promotionTaskId)],
    ['planPath', normalizeSkillOpsPromotionPinnedPath(payload?.planPath), normalizeSkillOpsPromotionPinnedPath(planPath)],
    ['sourceWorkdir', normalizeSkillOpsPromotionPinnedPath(payload?.sourceWorkdir), normalizeSkillOpsPromotionPinnedPath(sourceWorkdir)],
    ['curationWorkdir', normalizeSkillOpsPromotionPinnedPath(payload?.curationWorkdir), normalizeSkillOpsPromotionPinnedPath(curationWorkdir)],
    ['branch', readStringField(payload?.branch), readStringField(branch)],
    ['baseRef', normalizeBranchRefText(payload?.baseRef), normalizeBranchRefText(baseRef)],
    ['baseSha', normalizeShaCandidate(payload?.baseSha), normalizeShaCandidate(baseSha)],
  ];
  for (const [fieldName, actual, expected] of fieldMismatches) {
    if (!actual || actual !== expected) {
      return {
        ok: false,
        reasonCode: 'skillops_promotion_legacy_state',
        detail: `skillops promotion queued state is no longer pinned to ${fieldName}`,
      };
    }
  }
  return {
    ok: true,
    sourceLogIds: normalizeSkillOpsPromotionSourceLogIds(payload?.sourceLogIds),
    targetPaths: normalizeRepoPathsList(payload?.targetPaths),
  };
}

async function inspectExistingSkillOpsPromotionHandoff({
  busRoot,
  agentName,
  rootId,
  taskCwd,
  worktreesDir,
  sourceLogIds,
  targetPaths = [],
  handoffReasonCode,
  integrityMismatchReasonCode = handoffReasonCode,
}) {
  const dispatchContext = resolveSkillOpsPromotionDispatchContext({
    cwd: taskCwd,
    agentName,
    rootId,
    worktreesDir,
    reasonCode: handoffReasonCode,
    detail: 'failed to resolve promotion base ref',
  });
  if (!dispatchContext.ok) {
    return {
      ok: false,
      reasonCode: dispatchContext.reasonCode,
      detail: dispatchContext.detail,
      evidence: { dispatchContext },
    };
  }

  const { baseRef, baseSha, promotionTaskId, branch, curationWorkdir } = dispatchContext;
  const normalizedSourceLogIds = normalizeSkillOpsPromotionSourceLogIds(sourceLogIds);
  const normalizedTargetPaths = normalizeRepoPathsList(targetPaths);
  const existingState = await readSkillOpsPromotionState({ busRoot, agentName, rootId });
  const existingPayload = existingState?.payload || null;
  const sameScopeEvidence = buildSkillOpsPromotionStateEvidence({
    existingState: existingPayload,
    sourceLogIds: normalizedSourceLogIds,
    targetPaths: normalizedTargetPaths,
  });
  if (existingPayload) {
    const existingValidation = validateActiveSkillOpsPromotionStatePayload(existingPayload);
    if (!existingValidation.ok) {
      return {
        ok: false,
        reasonCode: existingValidation.reasonCode,
        detail: existingValidation.detail,
        evidence: sameScopeEvidence,
      };
    }
  }

  const existingStatus = readStringField(existingPayload?.status);
  const existingSourceLogIds = normalizeSkillOpsPromotionSourceLogIds(existingPayload?.sourceLogIds);
  const existingTargetPaths = normalizeRepoPathsList(existingPayload?.targetPaths);
  const existingPromotionTaskId = readStringField(existingPayload?.promotionTaskId) || promotionTaskId;
  const matchingLogSet = normalizedSourceLogIds.join('\n') === existingSourceLogIds.join('\n');
  const matchingTargetSet = normalizedTargetPaths.join('\n') === existingTargetPaths.join('\n');
  const existingStateEvidence = buildSkillOpsPromotionStateEvidence({ existingState: existingPayload });
  const sameScopeTaskEvidence = { ...sameScopeEvidence, promotionTaskId: existingPromotionTaskId };

  if (existingStatus === 'queued' || existingStatus === 'running') {
    if (normalizedSourceLogIds.length > 0 && !matchingLogSet) {
      return {
        ok: false,
        reasonCode: handoffReasonCode,
        detail: `existing skillops promotion state ${existingStatus} points at a different pending log set`,
        evidence: sameScopeEvidence,
      };
    }
    if (normalizedSourceLogIds.length > 0 && !matchingTargetSet) {
      return {
        ok: false,
        reasonCode: handoffReasonCode,
        detail: `existing skillops promotion state ${existingStatus} points at a different durable target set`,
        evidence: sameScopeEvidence,
      };
    }
    if (existingPromotionTaskId !== promotionTaskId) {
      return {
        ok: false,
        reasonCode: handoffReasonCode,
        detail: `existing skillops promotion state ${existingStatus} uses non-deterministic task id ${existingPromotionTaskId}`,
        evidence: { ...sameScopeEvidence, promotionTaskId },
      };
    }
    const liveQueuedTask = await findLiveSkillOpsPromotionTaskPacket({
      busRoot,
      agentName,
      taskId: existingPromotionTaskId,
    });
    if (liveQueuedTask) {
      return {
        ok: true,
        status: existingStatus,
        promotionTaskId: existingPromotionTaskId,
        statePath: existingState.path,
        planPath: readStringField(existingPayload?.planPath),
        branch: readStringField(existingPayload?.branch) || branch,
        baseRef: readStringField(existingPayload?.baseRef) || baseRef,
        baseSha: readStringField(existingPayload?.baseSha) || baseSha,
        curationWorkdir: readStringField(existingPayload?.curationWorkdir) || curationWorkdir,
        normalizedSourceLogIds,
        normalizedTargetPaths,
        previousState: existingPayload,
        reused: true,
      };
    }
    return {
      ok: false,
      reasonCode: 'skillops_promotion_orphan_state',
      detail: `existing skillops promotion state ${existingStatus} has no live task packet`,
      evidence: sameScopeTaskEvidence,
    };
  }

  if (existingStatus === 'needs_review') {
    return {
      ok: false,
      reasonCode: handoffReasonCode,
      detail: 'existing skillops promotion state requires review',
      evidence: existingStateEvidence,
    };
  }
  if (existingStatus === 'done' && normalizedSourceLogIds.length > 0 && matchingLogSet) {
    return {
      ok: false,
      reasonCode: integrityMismatchReasonCode,
      detail: 'completed promotion state still points at the same pending SkillOps logs',
      evidence: sameScopeEvidence,
    };
  }

  return {
    ok: true,
    status: 'not_present',
    promotionTaskId,
    statePath: existingState?.path || getSkillOpsPromotionStatePath({ busRoot, agentName, rootId }),
    planPath: readStringField(existingPayload?.planPath),
    branch,
    baseRef,
    baseSha,
    curationWorkdir,
    normalizedSourceLogIds,
    normalizedTargetPaths,
    previousState: existingPayload,
    reused: false,
  };
}

async function buildQueuedSkillOpsPromotionRollbackFailure({
  busRoot,
  agentName,
  promotionTaskId,
  queuedTask,
  statePath,
  previousState,
  reasonCode,
  detail,
  evidence = {},
}) {
  const rollbackResult = await rollbackQueuedSkillOpsPromotionDispatch({
    busRoot,
    agentName,
    promotionTaskId,
    queuedTask,
    statePath,
    previousState,
  });
  return {
    ok: false,
    reasonCode,
    detail,
    evidence: {
      ...evidence,
      queuedTask,
      rollback: rollbackResult.rollback,
      rollbackOk: rollbackResult.ok,
    },
  };
}

async function performSkillOpsPromotionQueuedHandoff({
  busRoot,
  agentName,
  openedMeta,
  rootId,
  sourceTaskId,
  taskCwd,
  worktreesDir,
  planPath,
  sourceLogIds,
  targetPaths = [],
  handoffReasonCode,
  integrityMismatchReasonCode = handoffReasonCode,
}) {
  const inspection = await inspectExistingSkillOpsPromotionHandoff({
    busRoot,
    agentName,
    rootId,
    taskCwd,
    worktreesDir,
    sourceLogIds,
    targetPaths,
    handoffReasonCode,
    integrityMismatchReasonCode,
  });
  if (!inspection.ok) {
    return inspection;
  }
  if (inspection.status === 'queued' || inspection.status === 'running') {
    return inspection;
  }

  const {
    baseRef,
    baseSha,
    promotionTaskId,
    branch,
    curationWorkdir,
    normalizedSourceLogIds,
    normalizedTargetPaths,
    previousState,
    statePath,
  } = inspection;

  const taskMeta = buildSkillOpsPromotionTaskMeta({
    agentName,
    openedMeta,
    rootId,
    sourceTaskId,
    sourceWorkdir: taskCwd,
    planPath,
    promotionTaskId,
    curationWorkdir,
    branch,
    baseRef,
    baseSha,
  });
  const queuedTask = await queueSkillOpsPromotionDispatch({
    busRoot,
    taskMeta,
    rootId,
    sourceTaskId,
    branch,
    baseRef,
    planPath,
  });
  if (!queuedTask.queued && queuedTask.reason !== 'already_present') {
    return {
      ok: false,
      reasonCode: handoffReasonCode,
      detail: 'failed to enqueue skillops promotion task',
      evidence: { queuedTask },
    };
  }

  const previousStateSnapshot = previousState ? JSON.parse(JSON.stringify(previousState)) : {};
  try {
    await writeSkillOpsPromotionState({
      busRoot,
      agentName,
      rootId,
      patch: {
        ...previousStateSnapshot,
        stateVersion: SKILLOPS_PROMOTION_STATE_VERSION,
        planVersion: SKILLOPS_PROMOTION_PLAN_VERSION,
        rootId,
        sourceTaskId,
        controllerAgent: agentName,
        sourceWorkdir: taskCwd,
        curationWorkdir,
        promotionTaskId,
        planPath,
        branch,
        baseRef,
        baseSha,
        sourceLogIds: normalizedSourceLogIds,
        targetPaths: normalizedTargetPaths,
        status: 'queued',
        queuedAt: readStringField(previousState?.queuedAt) || new Date().toISOString(),
      },
    });
  } catch (err) {
    return buildQueuedSkillOpsPromotionRollbackFailure({
      busRoot,
      agentName,
      promotionTaskId,
      queuedTask,
      statePath,
      previousState,
      reasonCode: handoffReasonCode,
      detail: `failed to persist queued promotion state: ${(err && err.message) || String(err)}`,
    });
  }

  const queueMark = runSkillOpsMarkPromoted({
    cwd: taskCwd,
    planPath,
    status: 'queued',
    promotionTaskId,
  });
  if (!queueMark.ok) {
    return buildQueuedSkillOpsPromotionRollbackFailure({
      busRoot,
      agentName,
      promotionTaskId,
      queuedTask,
      statePath,
      previousState,
      reasonCode: handoffReasonCode,
      detail: queueMark.detail || 'failed to mark source logs queued',
      evidence: { queueMark },
    });
  }

  return {
    ok: true,
    status: 'queued',
    planPath,
    statePath,
    promotionTaskId,
    branch,
    baseRef,
    curationWorkdir,
    reused: queuedTask.reason === 'already_present',
  };
}

async function enqueueSkillOpsPromotionFromOpenedRoot(
  runtimeContext,
  {
    planPath,
    sourceLogIds,
    targetPaths = [],
    handoffReasonCode,
    integrityMismatchReasonCode,
  },
) {
  const { busRoot, agentName, openedMeta, taskCwd, worktreesDir } = runtimeContext;
  const sourceContext = readRequiredOpenedRootSourceTaskIds(openedMeta, handoffReasonCode);
  if (!sourceContext.ok) {
    return sourceContext;
  }
  return performSkillOpsPromotionQueuedHandoff({
    busRoot,
    agentName,
    openedMeta,
    rootId: sourceContext.rootId,
    sourceTaskId: sourceContext.sourceTaskId,
    taskCwd,
    worktreesDir,
    planPath,
    sourceLogIds,
    targetPaths,
    handoffReasonCode,
    integrityMismatchReasonCode: integrityMismatchReasonCode || handoffReasonCode,
  });
}

async function planSkillOpsPromotionHandoff({
  busRoot,
  agentName,
  openedMeta,
  taskCwd,
  worktreesDir,
}) {
  const sourceContext = readRequiredOpenedRootSourceTaskIds(openedMeta, 'skillops_promotion_handoff_failed');
  if (!sourceContext.ok) {
    return sourceContext;
  }
  const { rootId } = sourceContext;

  const capability = runSkillOpsCapabilitiesPreflight({ cwd: taskCwd, reasonCode: 'skillops_cli_unsupported' });
  if (!capability.ok) {
    return {
      ok: false,
      reasonCode: capability.reasonCode,
      detail: capability.detail,
      evidence: { capability },
    };
  }

  const planResult = runSkillOpsPlanPromotions({ cwd: taskCwd });
  if (!planResult.ok) {
    return {
      ok: false,
      reasonCode: planResult.reasonCode,
      detail: planResult.detail,
      evidence: { capability, plan: planResult },
    };
  }

  const planPath = getSkillOpsPromotionPlanPath({ busRoot, agentName, rootId });
  const rawPlan = planResult.plan && typeof planResult.plan === 'object' ? planResult.plan : {};
  const sourceLogIds = Array.isArray(rawPlan.sourceLogIds)
    ? rawPlan.sourceLogIds.map((value) => readStringField(value)).filter(Boolean)
    : [];
  const targetPaths = Array.isArray(rawPlan.targetPaths)
    ? rawPlan.targetPaths.map((value) => readStringField(value)).filter(Boolean)
    : [];
  const skippableLogIds = Array.isArray(rawPlan.skippableLogIds)
    ? rawPlan.skippableLogIds.map((value) => readStringField(value)).filter(Boolean)
    : [];
  const runtimeContext = buildSkillOpsPromotionRuntimeContext({
    busRoot,
    agentName,
    openedMeta,
    taskCwd,
    worktreesDir,
  });
  const existingLane = await inspectExistingSkillOpsPromotionHandoff({
    busRoot,
    agentName,
    rootId,
    taskCwd,
    worktreesDir,
    sourceLogIds,
    targetPaths,
    handoffReasonCode: 'skillops_promotion_handoff_failed',
    integrityMismatchReasonCode: 'skillops_promotion_handoff_failed',
  });
  if (!existingLane.ok) {
    return {
      ok: false,
      reasonCode: existingLane.reasonCode,
      detail: existingLane.detail,
      evidence: { capability, plan: planResult, ...(existingLane.evidence ? { handoff: existingLane.evidence } : {}) },
      planPath,
    };
  }
  if (existingLane.status === 'queued' || existingLane.status === 'running') {
    const handoffRefs = {
      planPath: existingLane.planPath || planPath,
      statePath: existingLane.statePath,
      promotionTaskId: existingLane.promotionTaskId,
    };
    return {
      ok: true,
      status: existingLane.status,
      ...handoffRefs,
      runtimeGuard: {
        status: existingLane.status,
        promotableLogCount: sourceLogIds.length,
        emptyLogCount: skippableLogIds.length,
        ...handoffRefs,
        branch: existingLane.branch,
        baseRef: existingLane.baseRef,
        curationWorkdir: existingLane.curationWorkdir,
        capability,
      },
    };
  }

  if (sourceLogIds.length === 0) {
    if (skippableLogIds.length > 0) {
      await writeJsonAtomic(planPath, planResult.plan);
      const skipMark = runSkillOpsMarkPromoted({ cwd: taskCwd, planPath, status: 'skipped' });
      if (!skipMark.ok) {
        return {
          ok: false,
          reasonCode: skipMark.reasonCode,
          detail: skipMark.detail,
          evidence: { capability, plan: planResult, skipMark },
          planPath,
        };
      }
    }
    try {
      await fs.rm(planPath, { force: true });
      await fs.rm(existingLane.statePath, { force: true });
    } catch (err) {
      return {
        ok: false,
        reasonCode: 'skillops_promotion_state_cleanup_failed',
        detail: (err && err.message) || String(err),
        evidence: { capability, plan: planResult },
        planPath,
      };
    }
    return {
      ok: true,
      status: 'not_required',
      planPath: '',
      runtimeGuard: {
        status: 'not_required',
        promotableLogCount: 0,
        emptyLogCount: skippableLogIds.length,
        capability,
      },
    };
  }

  await writeJsonAtomic(planPath, planResult.plan);
  const handoff = await enqueueSkillOpsPromotionFromOpenedRoot(runtimeContext, {
      planPath,
      sourceLogIds,
      targetPaths,
      handoffReasonCode: 'skillops_promotion_handoff_failed',
    });
  if (!handoff.ok) {
    return {
      ok: false,
      reasonCode: handoff.reasonCode,
      detail: handoff.detail,
      evidence: { capability, plan: planResult, ...(handoff.evidence ? { handoff: handoff.evidence } : {}) },
      planPath,
    };
  }
  const handoffRefs = {
    planPath,
    statePath: handoff.statePath,
    promotionTaskId: handoff.promotionTaskId,
  };

  return {
    ok: true,
    status: handoff.status,
    ...handoffRefs,
    runtimeGuard: {
      status: handoff.status,
      promotableLogCount: sourceLogIds.length,
      emptyLogCount: skippableLogIds.length,
      ...handoffRefs,
      branch: handoff.branch,
      baseRef: handoff.baseRef,
      curationWorkdir: handoff.curationWorkdir,
      capability,
    },
  };
}

async function prepareClaimedSkillOpsPromotionTask({
  busRoot,
  agentName,
  openedMeta,
  sourceTaskCwd,
  worktreesDir,
}) {
  const refs = isPlainObject(openedMeta?.references?.skillopsPromotion) ? openedMeta.references.skillopsPromotion : {};
  const gitRefs = isPlainObject(openedMeta?.references?.git) ? openedMeta.references.git : {};
  const rootId = readOpenedRootId(openedMeta);
  const planPath = readStringField(refs?.planPath) || getSkillOpsPromotionPlanPath({ busRoot, agentName, rootId });
  const trustedSourceWorkdir = await fs.realpath(path.resolve(sourceTaskCwd));
  const trustedCurationWorkdir = path.resolve(buildSkillOpsPromotionCurationWorkdir({ worktreesDir, agentName }));
  const claimedSourceWorkdir = readStringField(refs?.sourceWorkdir);
  const claimedCurationWorkdir = readStringField(refs?.curationWorkdir);
  const workBranch = normalizeBranchRefText(gitRefs?.workBranch) || buildSkillOpsPromotionBranchName({ agentName, rootId });
  const requestedBaseRef = normalizeBranchRefText(gitRefs?.baseBranch || gitRefs?.integrationBranch) || '';
  const promotionTaskId =
    readStringField(refs?.promotionTaskId) || buildSkillOpsPromotionTaskId({ agentName, rootId });

  if (claimedSourceWorkdir) {
    let resolvedClaimedSourceWorkdir = '';
    try {
      resolvedClaimedSourceWorkdir = await fs.realpath(path.resolve(claimedSourceWorkdir));
    } catch (err) {
      throw new SkillOpsPromotionTaskError('skillops promotion sourceWorkdir is invalid', {
        reasonCode: 'skillops_promotion_invalid',
        details: { sourceWorkdir: claimedSourceWorkdir, error: (err && err.message) || String(err) },
      });
    }
    if (resolvedClaimedSourceWorkdir !== trustedSourceWorkdir) {
      throw new SkillOpsPromotionTaskError('skillops promotion sourceWorkdir does not match worker runtime workdir', {
        reasonCode: 'skillops_promotion_invalid',
        details: { sourceWorkdir: resolvedClaimedSourceWorkdir, trustedSourceWorkdir },
      });
    }
  }
  if (claimedCurationWorkdir && path.resolve(claimedCurationWorkdir) !== trustedCurationWorkdir) {
    throw new SkillOpsPromotionTaskError('skillops promotion curationWorkdir does not match deterministic runtime path', {
      reasonCode: 'skillops_promotion_invalid',
      details: { curationWorkdir: path.resolve(claimedCurationWorkdir), trustedCurationWorkdir },
    });
  }

  if (!readGitCommonDir(trustedSourceWorkdir)) {
    throw new SkillOpsPromotionTaskError('skillops promotion sourceWorkdir is not a git repo', {
      reasonCode: 'skillops_promotion_invalid',
      details: { sourceWorkdir: trustedSourceWorkdir },
    });
  }
  if (!isPathWithinRoot(worktreesDir, trustedCurationWorkdir)) {
    throw new SkillOpsPromotionTaskError('skillops promotion curationWorkdir is outside the shared worktrees root', {
      reasonCode: 'skillops_promotion_invalid',
      details: { curationWorkdir: trustedCurationWorkdir, worktreesDir },
    });
  }

  const previousState = (await readSkillOpsPromotionState({ busRoot, agentName, rootId }))?.payload || null;
  const expectedBaseRef = requestedBaseRef || normalizeBranchRefText(previousState?.baseRef) || '';
  const expectedBaseSha = normalizeShaCandidate(gitRefs?.baseSha) || normalizeShaCandidate(previousState?.baseSha) || '';
  const queuedStateValidation = validateClaimedSkillOpsPromotionQueuedState({
    payload: previousState,
    promotionTaskId,
    planPath,
    sourceWorkdir: trustedSourceWorkdir,
    curationWorkdir: trustedCurationWorkdir,
    branch: workBranch,
    baseRef: expectedBaseRef,
    baseSha: expectedBaseSha,
  });
  if (!queuedStateValidation.ok) {
    throw new SkillOpsPromotionTaskError(queuedStateValidation.detail, {
      reasonCode: queuedStateValidation.reasonCode,
      details: { rootId, statePath: getSkillOpsPromotionStatePath({ busRoot, agentName, rootId }) },
    });
  }
  const normalizedPlan = await readNormalizedSkillOpsPromotionPlanFile(planPath, 'skillops_promotion_legacy_state');
  if (!normalizedPlan.ok) {
    throw new SkillOpsPromotionTaskError(normalizedPlan.detail, {
      reasonCode: normalizedPlan.reasonCode,
      details: { planPath },
    });
  }
  if (queuedStateValidation.sourceLogIds.join('\n') !== normalizedPlan.plan.sourceLogIds.join('\n')) {
    throw new SkillOpsPromotionTaskError('skillops promotion plan sourceLogIds drifted after queue', {
      reasonCode: 'skillops_promotion_legacy_state',
      details: { planPath },
    });
  }
  if (queuedStateValidation.targetPaths.join('\n') !== normalizedPlan.plan.targetPaths.join('\n')) {
    throw new SkillOpsPromotionTaskError('skillops promotion plan targetPaths drifted after queue', {
      reasonCode: 'skillops_promotion_legacy_state',
      details: { planPath },
    });
  }
  const lock = await acquireSkillOpsPromotionLock({ busRoot, agentName, ownerTaskId: promotionTaskId });
  if (!lock.ok) {
    throw new SkillOpsPromotionTaskError(lock.detail || 'skillops promotion lock unavailable', {
      reasonCode: lock.reasonCode,
      details: { lockPath: getSkillOpsPromotionLockPath({ busRoot, agentName }) },
    });
  }
  const baseRef = expectedBaseRef;
  const resolvedBaseSha = expectedBaseSha;
  try {
    const preparedCurationWorkdir = await ensureSkillOpsPromotionCurationWorkdir({
      sourceWorkdir: trustedSourceWorkdir,
      curationWorkdir: trustedCurationWorkdir,
      workBranch,
      baseRef: baseRef || 'HEAD',
      baseSha: resolvedBaseSha,
    });
    const capability = runSkillOpsCapabilitiesPreflight({
      cwd: preparedCurationWorkdir,
      reasonCode: 'skillops_cli_unsupported_at_claim',
    });
    if (!capability.ok) {
      throw new SkillOpsPromotionTaskError(capability.detail || 'skillops capability preflight failed at claim', {
        reasonCode: capability.reasonCode,
        details: capability,
      });
    }

    const writtenState = await writeSkillOpsPromotionState({
      busRoot,
      agentName,
      rootId,
      patch: {
        ...previousState,
        stateVersion: SKILLOPS_PROMOTION_STATE_VERSION,
        planVersion: SKILLOPS_PROMOTION_PLAN_VERSION,
        rootId,
        sourceTaskId:
          readStringField(previousState?.sourceTaskId) ||
          readStringField(openedMeta?.references?.sourceTaskId) ||
          readStringField(openedMeta?.id),
        controllerAgent: agentName,
        sourceWorkdir: trustedSourceWorkdir,
        curationWorkdir: preparedCurationWorkdir,
        promotionTaskId,
        planPath,
        branch: workBranch,
        baseRef,
        baseSha: resolvedBaseSha,
        sourceLogIds: queuedStateValidation.sourceLogIds,
        targetPaths: queuedStateValidation.targetPaths,
        status: 'running',
        queuedAt: readStringField(previousState?.queuedAt) || new Date().toISOString(),
        startedAt: new Date().toISOString(),
      },
    });

    return {
      taskCwd: preparedCurationWorkdir,
      sourceWorkdir: trustedSourceWorkdir,
      curationWorkdir: preparedCurationWorkdir,
      planPath,
      promotionTaskId,
      branch: workBranch,
      baseRef,
      baseSha: resolvedBaseSha,
      statePath: writtenState.statePath,
      capability,
      releaseLock: lock.release,
    };
  } catch (err) {
    await lock.release();
    throw err;
  }
}

function setSkillOpsPromotionRuntimeGuard(parsed, skillOpsPromotion) {
  parsed.runtimeGuard = {
    ...(parsed.runtimeGuard && typeof parsed.runtimeGuard === 'object' ? parsed.runtimeGuard : {}),
    skillOpsPromotion,
  };
}

function blockSkillOpsPromotionDone({ parsed, note, detail, durableTargets = null, changedFiles = null }) {
  setSkillOpsPromotionRuntimeGuard(parsed, {
    status: 'blocked',
    reasonCode: 'skillops_promotion_scope_invalid',
    detail,
    ...(Array.isArray(durableTargets) ? { durableTargets } : {}),
    ...(Array.isArray(changedFiles) ? { changedFiles } : {}),
  });
  return {
    outcome: 'blocked',
    note: appendReasonNote(note, 'skillops_promotion_scope_invalid'),
  };
}

async function writeSkillOpsPromotionFailureState({
  busRoot,
  agentName,
  rootId,
  reasonCode,
  detail = '',
}) {
  await writeSkillOpsPromotionState({
    busRoot,
    agentName,
    rootId,
    patch: {
      status: 'needs_review',
      reasonCode,
      failedAt: new Date().toISOString(),
      error: detail || '',
    },
  });
}

async function finalizeSuccessfulSkillOpsPromotionTask({
  busRoot,
  agentName,
  rootId,
  promotionTask,
  commitSha,
}) {
  const verification = await verifySkillOpsPromotionResult({
    cwd: promotionTask.curationWorkdir,
    workBranch: promotionTask.branch,
    baseBranch: promotionTask.baseRef,
    commitSha,
  });
  if (!verification.ok) {
    await writeSkillOpsPromotionFailureState({
      busRoot,
      agentName,
      rootId,
      reasonCode: verification.reasonCode,
      detail: verification.detail,
    });
    return {
      ok: false,
      reasonCode: verification.reasonCode,
      detail: verification.detail,
      verification,
    };
  }
  const processedMark = runSkillOpsMarkPromoted({
    cwd: promotionTask.sourceWorkdir,
    planPath: promotionTask.planPath,
    status: 'processed',
  });
  if (!processedMark.ok) {
    await writeSkillOpsPromotionFailureState({
      busRoot,
      agentName,
      rootId,
      reasonCode: processedMark.reasonCode,
      detail: processedMark.detail,
    });
    return {
      ok: false,
      reasonCode: processedMark.reasonCode,
      detail: processedMark.detail,
      verification,
    };
  }
  await writeSkillOpsPromotionState({
    busRoot,
    agentName,
    rootId,
    patch: {
      status: 'done',
      doneAt: new Date().toISOString(),
      prNumber: verification.prNumber,
      prUrl: verification.prUrl,
      remoteCommitSha: verification.remoteCommitSha,
    },
  });
  return {
    ok: true,
    verification,
  };
}

async function queueControllerHousekeepingPromotionHandoff({
  busRoot,
  agentName,
  openedMeta,
  taskCwd,
  worktreesDir,
  rawPlanPath,
  rawPlan,
}) {
  const sourceLogIds = Array.isArray(rawPlan?.sourceLogIds)
    ? rawPlan.sourceLogIds.map(readStringField).filter(Boolean)
    : [];
  const targetPaths = Array.isArray(rawPlan?.targetPaths)
    ? rawPlan.targetPaths.map(readStringField).filter(Boolean)
    : [];
  const handoff = await enqueueSkillOpsPromotionFromOpenedRoot(
    buildSkillOpsPromotionRuntimeContext({ busRoot, agentName, openedMeta, taskCwd, worktreesDir }),
    {
      planPath: rawPlanPath,
      sourceLogIds,
      targetPaths,
      handoffReasonCode: 'controller_housekeeping_promotion_handoff_failed',
      integrityMismatchReasonCode: 'controller_housekeeping_promotion_integrity_mismatch',
    },
  );
  if (!handoff.ok) {
    return failControllerHousekeepingPromotionHandoff(handoff.detail, handoff.reasonCode, handoff.evidence);
  }

  return {
    ok: true,
    status: handoff.status,
    promotionTaskId: handoff.promotionTaskId,
    statePath: handoff.statePath,
    reused: handoff.reused,
  };
}

async function writeControllerHousekeepingTerminalState({
  busRoot,
  agentName,
  fingerprint,
  terminalReasonCode,
  done = false,
}) {
  await updateControllerHousekeepingState({
    busRoot,
    agentName,
    fingerprint,
    mutate: (current) => ({
      ...current,
      status: done ? 'done' : 'needs_review',
      reasonCode: readStringField(terminalReasonCode),
      doneAt: done ? new Date().toISOString() : '',
      failedAt: done ? '' : new Date().toISOString(),
    }),
  });
}

function classifyControllerHousekeepingSnapshot({
  busRoot,
  cwd,
  agentName,
  snapshot,
  autoCleanRuntimeArtifacts = false,
}) {
  return classifyControllerDirtySnapshot({
    busRoot,
    cwd,
    agentName,
    snapshot,
    autoCleanRuntimeArtifacts,
  }).dirtyClassification;
}

function buildControllerHousekeepingTaskResult({
  outcome,
  note,
  reasonCode = '',
  details = null,
  cleanupSyntheticRootId = '',
}) {
  const receiptExtra = { reasonCode: readStringField(reasonCode) };
  if (details != null) receiptExtra.details = details;
  return {
    outcome,
    note,
    receiptExtra,
    ...(readStringField(cleanupSyntheticRootId) ? { cleanupSyntheticRootId: readStringField(cleanupSyntheticRootId) } : {}),
  };
}

async function concludeControllerHousekeeping({
  busRoot,
  agentName,
  fingerprint,
  outcome,
  note,
  reasonCode = '',
  details = null,
  cleanupSyntheticRootId = '',
  done = false,
}) {
  await writeControllerHousekeepingTerminalState({
    busRoot,
    agentName,
    fingerprint,
    terminalReasonCode: reasonCode,
    done,
  });
  return buildControllerHousekeepingTaskResult({
    outcome,
    note,
    reasonCode,
    details,
    cleanupSyntheticRootId,
  });
}

async function finalizeControllerHousekeepingSuccess({
  busRoot,
  agentName,
  fingerprint,
  cleanupSyntheticRootId = '',
}) {
  await writeControllerHousekeepingTerminalState({
    busRoot,
    agentName,
    fingerprint,
    terminalReasonCode: '',
    done: true,
  });
  try {
    await replayControllerHousekeepingSuspensions({ busRoot, agentName, fingerprint });
  } catch (err) {
    return concludeControllerHousekeeping({
      busRoot,
      agentName,
      fingerprint,
      outcome: 'failed',
      note: `controller housekeeping failed: ${(err && err.message) || String(err)}`,
      reasonCode: 'controller_housekeeping_replay_failed',
      cleanupSyntheticRootId,
    });
  }
  return buildControllerHousekeepingTaskResult({
    outcome: 'done',
    note: 'controller housekeeping done',
  });
}

async function replayControllerHousekeepingSuspensions({ busRoot, agentName, fingerprint }) {
  const current = await readControllerHousekeepingState({ busRoot, agentName, fingerprint });
  if (!current?.payload) throw new Error('controller housekeeping state missing during replay');
  const generation = Number(current.payload.generation) || 1;
  const pending = listPendingControllerHousekeepingSuspensions(current.payload);
  for (const suspendedRoot of pending) {
    const replay = buildControllerHousekeepingReplayTask({
      suspendedRoot,
      fingerprint,
      generation,
    });
    await deliverTask({ busRoot, meta: replay.meta, body: replay.body });
    await updateControllerHousekeepingState({
      busRoot,
      agentName,
      fingerprint,
      mutate: (state) => ({
        ...state,
        suspendedRoots: Array.isArray(state.suspendedRoots)
          ? state.suspendedRoots.map((entry) => {
              if (readStringField(entry?.originalTaskId) !== readStringField(suspendedRoot?.originalTaskId)) {
                return entry;
              }
              return {
                ...entry,
                replayStatus: 'replayed',
                replayTaskId: replay.id,
                replayedAt: new Date().toISOString(),
              };
            })
          : [],
      }),
    });
  }
}

async function runControllerHousekeepingTask({
  busRoot,
  agentName,
  openedMeta,
  taskCwd,
  repoRoot,
  worktreesDir,
  agenticWorktreesDir,
  valuaWorktreesDir,
}) {
  const housekeepingRef = isPlainObject(openedMeta?.references?.controllerHousekeeping)
    ? openedMeta.references.controllerHousekeeping
    : {};
  const fingerprint = readStringField(housekeepingRef?.fingerprint);
  const cleanupSyntheticRootId = readStringField(openedMeta?.signals?.rootId);
  const corruptHousekeepingState = (note) =>
    buildControllerHousekeepingTaskResult({
      outcome: 'needs_review',
      note,
      reasonCode: 'controller_housekeeping_state_corrupt',
      cleanupSyntheticRootId,
    });
  const concludeHousekeeping = ({ outcome, note, reasonCode = '', details = null }) =>
    concludeControllerHousekeeping({
      busRoot,
      agentName,
      fingerprint,
      outcome,
      note,
      reasonCode,
      details,
      cleanupSyntheticRootId,
    });
  if (!fingerprint) {
    return corruptHousekeepingState('controller housekeeping needs review: missing fingerprint');
  }

  const stateRecord = await readControllerHousekeepingState({ busRoot, agentName, fingerprint });
  if (!stateRecord?.payload) {
    return corruptHousekeepingState('controller housekeeping needs review: state missing');
  }

  const dirtySnapshot = getGitSnapshot({ cwd: taskCwd });
  const repoCommonGitDir = readGitCommonDir(taskCwd);
  if (!repoCommonGitDir || readStringField(stateRecord.payload.repoCommonGitDir) !== repoCommonGitDir) {
    return concludeHousekeeping({
      outcome: 'failed',
      note: 'controller housekeeping failed: git common dir mismatch',
      reasonCode: 'controller_housekeeping_verification_failed',
    });
  }

  await updateControllerHousekeepingState({
    busRoot,
    agentName,
    fingerprint,
    mutate: (current) => ({
      ...current,
      status: 'running',
      startedAt: readStringField(current.startedAt) || new Date().toISOString(),
      branch: readStringField(dirtySnapshot?.branch),
      headSha: readStringField(dirtySnapshot?.headSha),
      recoverableStatusPorcelain: readStringField(current.recoverableStatusPorcelain),
    }),
  });

  const initialClassification = classifyControllerHousekeepingSnapshot({
    busRoot,
    cwd: taskCwd,
    agentName,
    snapshot: dirtySnapshot,
  });

  if (initialClassification.classification === 'substantive_dirty_block') {
    return concludeControllerHousekeeping({
      busRoot,
      agentName,
      fingerprint,
      outcome: 'blocked',
      note: 'controller housekeeping blocked: substantive dirty worktree',
      reasonCode: 'controller_housekeeping_substantive_dirty',
      details: { statusPorcelain: initialClassification.blockingStatusPorcelain.slice(0, 2000) },
      cleanupSyntheticRootId,
    });
  }

  if (!initialClassification.blockingStatusPorcelain) {
    return finalizeControllerHousekeepingSuccess({
      busRoot,
      agentName,
      fingerprint,
      cleanupSyntheticRootId,
    });
  }

  const capability = runSkillOpsCapabilitiesPreflight({
    cwd: taskCwd,
    reasonCode: 'controller_housekeeping_cli_unsupported',
  });
  if (!capability.ok) {
    return concludeControllerHousekeeping({
      busRoot,
      agentName,
      fingerprint,
      outcome: 'blocked',
      note: `controller housekeeping blocked: ${capability.detail}`,
      reasonCode: 'controller_housekeeping_cli_unsupported',
      details: capability,
      cleanupSyntheticRootId,
    });
  }

  let scratchWorkdir = '';
  let pendingResult = null;
  try {
    scratchWorkdir = await ensureControllerHousekeepingScratchWorkdir({
      repoRoot,
      runtimeRoot: repoRoot,
      worktreesDir,
      agenticWorktreesDir,
      valuaWorktreesDir,
      agentName,
      sourceWorkdir: taskCwd,
      fingerprint,
      headSha: readStringField(dirtySnapshot?.headSha),
    });

    await copyRepoPathsBetweenWorktrees({
      sourceWorkdir: taskCwd,
      targetWorkdir: scratchWorkdir,
      repoPaths: initialClassification.pendingSkillOpsLogPaths,
    });

    const planResult = runSkillOpsPlanPromotions({ cwd: scratchWorkdir });
    if (!planResult.ok) {
      throw new Error(planResult.detail || 'plan-promotions failed');
    }
    const rawPlanPath = getControllerHousekeepingPlanPath({
      busRoot,
      agentName,
      fingerprint,
      generation: Number(stateRecord.payload.generation) || 1,
    });
    await writeJsonAtomic(rawPlanPath, planResult.plan);
    const rawPlan = isPlainObject(planResult.plan) ? planResult.plan : {};
    const targetResult = normalizeSkillOpsPromotionTargets(rawPlan.targets);
    if (!targetResult.ok) {
      throw new Error(targetResult.detail || 'controller housekeeping plan targets invalid');
    }
    const durableTargets = targetResult.targets
      .filter((target) => target.kind === 'skill')
      .map((target) => target.path)
      .sort((a, b) => a.localeCompare(b));

    const appliedScratchPlan = runSkillOpsApplyPromotions({ cwd: scratchWorkdir, planPath: rawPlanPath });
    if (!appliedScratchPlan.ok) {
      throw new Error(appliedScratchPlan.detail || 'apply-promotions failed in scratch worktree');
    }
    const expectedDiffResult = readGitDiffForPaths({ cwd: scratchWorkdir, repoPaths: durableTargets });
    if (!expectedDiffResult.ok) {
      throw new Error(expectedDiffResult.error || 'failed to read scratch diff');
    }
    const sourceDiffResult = readGitDiffForPaths({ cwd: taskCwd, repoPaths: durableTargets });
    if (!sourceDiffResult.ok) {
      throw new Error(sourceDiffResult.error || 'failed to read source diff');
    }
    if (expectedDiffResult.diff !== sourceDiffResult.diff) {
      pendingResult = {
        type: 'conclude',
        args: {
        outcome: 'failed',
        note: 'controller housekeeping failed: restore proof mismatch',
        reasonCode: 'controller_housekeeping_restore_failed',
        },
      };
    } else {
      const sourceLogIds = Array.isArray(rawPlan.sourceLogIds)
        ? rawPlan.sourceLogIds.map(readStringField).filter(Boolean)
        : [];
      if (sourceLogIds.length === 0) {
        const skipMark = runSkillOpsMarkPromoted({ cwd: taskCwd, planPath: rawPlanPath, status: 'skipped' });
        if (!skipMark.ok) {
          throw new Error(skipMark.detail || 'mark-promoted skipped failed');
        }
      } else {
        const promotion = await queueControllerHousekeepingPromotionHandoff({
          busRoot,
          agentName,
          openedMeta,
          taskCwd,
          worktreesDir,
          rawPlanPath,
          rawPlan,
        });
        if (!promotion.ok) {
          pendingResult = {
            type: 'conclude',
            args: {
              outcome: 'failed',
              note: `controller housekeeping failed: ${promotion.detail || promotion.reasonCode}`,
              reasonCode: promotion.reasonCode,
              details: promotion.evidence ? { promotionHandoff: promotion.evidence } : null,
            },
          };
        }
      }
    }

    if (!pendingResult) {
      const restoreResult = restoreHeadPaths({ cwd: taskCwd, repoPaths: durableTargets });
      if (!restoreResult.ok) {
        pendingResult = {
          type: 'conclude',
          args: {
            outcome: 'failed',
            note: `controller housekeeping failed: ${restoreResult.error || 'restore failed'}`,
            reasonCode: 'controller_housekeeping_restore_failed',
          },
        };
      }
    }

    if (!pendingResult) {
      const cleanupSnapshot = getGitSnapshot({ cwd: taskCwd });
      classifyControllerHousekeepingSnapshot({
        busRoot,
        cwd: taskCwd,
        agentName,
        snapshot: cleanupSnapshot,
        autoCleanRuntimeArtifacts: true,
      });

      const finalSnapshot = getGitSnapshot({ cwd: taskCwd });
      const finalClassification = classifyControllerHousekeepingSnapshot({
        busRoot,
        cwd: taskCwd,
        agentName,
        snapshot: finalSnapshot,
      });
      if (finalClassification.blockingStatusPorcelain) {
        pendingResult = {
          type: 'conclude',
          args: {
            outcome: 'failed',
            note: 'controller housekeeping failed: worktree still dirty after restore',
            reasonCode: 'controller_housekeeping_verification_failed',
            details: { statusPorcelain: finalClassification.blockingStatusPorcelain.slice(0, 2000) },
          },
        };
      } else {
        pendingResult = { type: 'success' };
      }
    }
  } catch (err) {
    pendingResult = {
      type: 'conclude',
      args: {
        outcome: 'failed',
        note: `controller housekeeping failed: ${(err && err.message) || String(err)}`,
        reasonCode: 'controller_housekeeping_verification_failed',
      },
    };
  }

  if (scratchWorkdir) {
    const scratchCleanup = await cleanupControllerHousekeepingScratchWorkdir({ sourceWorkdir: taskCwd, scratchWorkdir });
    if (!scratchCleanup.ok) {
      return concludeHousekeeping({
        outcome: 'failed',
        note: `controller housekeeping failed: ${scratchCleanup.detail}`,
        reasonCode: 'controller_housekeeping_verification_failed',
        details: {
          scratchCleanup,
          priorOutcome: pendingResult?.type === 'success' ? 'done' : readStringField(pendingResult?.args?.outcome),
          priorReasonCode: readStringField(pendingResult?.args?.reasonCode),
        },
      });
    }
  }

  if (pendingResult?.type === 'success') {
    return finalizeControllerHousekeepingSuccess({
      busRoot,
      agentName,
      fingerprint,
      cleanupSyntheticRootId,
    });
  }
  if (pendingResult?.type === 'conclude') {
    return concludeHousekeeping(pendingResult.args);
  }
  return concludeHousekeeping({
    outcome: 'failed',
    note: 'controller housekeeping failed: missing terminal result',
    reasonCode: 'controller_housekeeping_state_corrupt',
  });
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
  const statusPorcelain = typeof details.statusPorcelain === 'string' ? details.statusPorcelain : '';
  const diffWorking = typeof details.diffWorking === 'string' ? details.diffWorking : '';
  const diffStaged = typeof details.diffStaged === 'string' ? details.diffStaged : '';
  const removedPaths = Array.isArray(details.removedPaths)
    ? details.removedPaths.map((value) => readStringField(value)).filter(Boolean)
    : [];
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
    `## Removed Runtime Artifacts\n` +
    '```text\n' +
    `${removedPaths.length ? removedPaths.join('\n') : '(none)'}\n` +
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

function sanitizeDiffSummaryForReceipt(summary) {
  return isPlainObject(summary)
    ? {
        captured: Boolean(summary.captured),
        byteCount: Number.isFinite(summary.byteCount) ? Math.max(0, Math.trunc(summary.byteCount)) : 0,
        sha256: readStringField(summary.sha256) || null,
        fileCount: Number.isFinite(summary.fileCount) ? Math.max(0, Math.trunc(summary.fileCount)) : 0,
        files: Array.isArray(summary.files)
          ? summary.files.map((value) => readStringField(value)).filter(Boolean).slice(0, 200)
          : [],
      }
    : null;
}

function sanitizeStaleWorkerReclaimForReceipt(reclaim) {
  if (!isPlainObject(reclaim) || reclaim.reclaimed !== true) return null;
  return {
    reclaimed: true,
    reason: readStringField(reclaim.reason) || null,
    reasonCode: readStringField(reclaim.reasonCode) || null,
    currentBranch: readStringField(reclaim.currentBranch) || null,
    targetBranch: readStringField(reclaim.targetBranch) || null,
    baseSha: readStringField(reclaim.baseSha) || null,
    incomingRootId: readStringField(reclaim.incomingRootId) || null,
    previousRootId: readStringField(reclaim.previousRootId) || null,
    recordedFocusBranch: readStringField(reclaim.recordedFocusBranch) || null,
    otherOpenTaskIds: Array.isArray(reclaim.otherOpenTaskIds)
      ? reclaim.otherOpenTaskIds.map((value) => readStringField(value)).filter(Boolean)
      : [],
    statusPorcelain:
      typeof reclaim.statusPorcelain === 'string' && reclaim.statusPorcelain.length ? reclaim.statusPorcelain : null,
    workingDiffSummary: sanitizeDiffSummaryForReceipt(reclaim.workingDiffSummary),
    stagedDiffSummary: sanitizeDiffSummaryForReceipt(reclaim.stagedDiffSummary),
  };
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
  for (const target of [
    path.join(busRoot, 'state', `${agentName}.session-id`),
    path.join(busRoot, 'state', `${agentName}.prompt-bootstrap.json`),
    path.join(busRoot, 'state', 'codex-root-sessions', agentName),
    path.join(busRoot, 'state', 'codex-task-sessions', agentName),
  ]) {
    try {
      await fs.rm(target, { recursive: true, force: true });
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
  }
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
  const configArgs = buildCodexConfigArgs(env).join('\0');
  return `${codexBin}::${repoRoot}::${home}::${configArgs}`;
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
  sharedAppServerClient = new CodexAppServerClient({
    codexBin,
    cwd: repoRoot,
    env,
    log,
    globalArgs: buildCodexConfigArgs(env),
  });
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
  outputSchemaOverride = null,
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
  const codexConfigArgs = buildCodexConfigArgs(baseEnv);
  const persist = parseBooleanEnv(
    baseEnv.AGENTIC_CODEX_APP_SERVER_PERSIST ?? baseEnv.VALUA_CODEX_APP_SERVER_PERSIST ?? '',
    true,
  );

  const timeoutMs = getCodexTurnTimeoutMs(baseEnv);
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
    for (const configuredRoot of parseCsvEnv(
      baseEnv.AGENTIC_CODEX_EXTRA_WRITABLE_ROOTS ?? baseEnv.VALUA_CODEX_EXTRA_WRITABLE_ROOTS ?? '',
    )) {
      const resolved = resolveAbs(configuredRoot);
      if (resolved) extraWritableDirs.push(resolved);
    }
  }

  const credential = await createGitCredentialStoreEnv(baseEnv);
  const env = credential.env;
  const writableRoots = [path.resolve(sandboxCwd), ...Array.from(new Set(extraWritableDirs.filter(Boolean)))];
  /** @type {any} */
  let outputSchema = null;
  if (outputSchemaOverride && typeof outputSchemaOverride === 'object' && !Array.isArray(outputSchemaOverride)) {
    outputSchema = outputSchemaOverride;
  } else {
    try {
      outputSchema = JSON.parse(await fs.readFile(schemaPath, 'utf8'));
    } catch {
      outputSchema = null;
    }
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
    client = new CodexAppServerClient({
      codexBin,
      cwd: repoRoot,
      env,
      log: writePane,
      globalArgs: codexConfigArgs,
    });
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
      let reviewStartedTurnId = null;
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

      const maybeFinishReview = () => {
        if (reviewStatus !== 'completed') return;
        if (!sawExitedReviewMode) return;
        resolveDone({
          status: reviewStatus,
          reviewAssistantText: reviewAgentMessageText || reviewAgentMessageDelta || '',
        });
      };

      const onReviewNotification = ({ method, params }) => {
        if (method === 'turn/started') {
          const id = typeof params?.turn?.id === 'string' ? params.turn.id.trim() : '';
          if (id && !reviewStartedTurnId) reviewStartedTurnId = id;
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
            maybeFinishReview();
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
          if (id && id !== reviewTurnId && id !== reviewStartedTurnId) return;
          if (status) reviewStatus = status;
          if (params?.turn?.error) reviewError = params.turn.error;
          writePane(`[codex] review.completed status=${status || 'unknown'}\n`);
          if (status !== 'completed') {
            const state = status || 'unknown';
            const msg = reviewError?.message ? String(reviewError.message) : `review turn ${state}`;
            rejectDone(
              new CodexTurnError(`codex app-server review ${state}: ${msg}`, {
                exitCode: 1,
                stderrTail: String(reviewError?.additionalDetails || msg),
                stdoutTail: '',
                threadId,
              }),
            );
            return;
          }
          maybeFinishReview();
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
          const activeReviewTurnId = reviewStartedTurnId || reviewTurnId;
          if (threadId && activeReviewTurnId) {
            try {
              await client.call('turn/interrupt', { threadId, turnId: activeReviewTurnId });
            } catch {
              // ignore
            }
          }
          throw new CodexTurnSupersededError({
            reason: 'task updated',
            pid: pid ?? 0,
            threadId,
            stderrTail: '',
            stdoutTail: '',
          });
        }
        if (raced?.kind === 'timeout') {
          throw new CodexTurnTimeoutError({
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
        throw new CodexTurnError(`codex app-server review did not complete (status=${reviewStatus || 'unknown'})`, {
          exitCode: 1,
          stderrTail: '',
          stdoutTail: '',
          threadId,
        });
      }
      if (!sawEnteredReviewMode || !sawExitedReviewMode) {
        throw new CodexTurnError('codex app-server review did not emit review mode events', {
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
        throw new CodexTurnError(`codex app-server explicit review target resolution failed: ${reviewResolutionError}`, {
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
          new CodexTurnError(`codex app-server turn failed: ${msg}`, {
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
      throw new CodexTurnSupersededError({
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
      throw new CodexTurnTimeoutError({
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
      throw new CodexTurnError('codex app-server returned non-JSON output', {
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
 * Appends reason to note with stable formatting.
 */
function appendReasonNote(note, reason) {
  const text = String(reason || '').trim();
  if (!text) return note || '';
  const current = String(note || '').trim();
  return current ? `${current} (${text})` : text;
}

/**
 * Reads positive integer from value.
 */
function readPositiveInteger(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 ? value : null;
  }
  const raw = readStringField(value);
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Reads review-fix freshness source from direct or forwarded observer references.
 */
function readReviewFixFreshnessSource(taskMeta) {
  const phase = readStringField(taskMeta?.signals?.phase);
  if (phase !== 'review-fix' && phase !== 'blocked-recovery') return null;
  const refs = isPlainObject(taskMeta?.references) ? taskMeta.references : {};
  const sourceRefs = isPlainObject(refs?.sourceReferences) ? refs.sourceReferences : null;
  const directObserver = readStringField(taskMeta?.from) === 'observer:pr';
  const forwardedObserver = readStringField(refs?.sourceAgent) === 'observer:pr';
  const candidateRefs = directObserver ? refs : forwardedObserver ? sourceRefs : null;
  if (!isPlainObject(candidateRefs)) return null;

  const pr = isPlainObject(candidateRefs?.pr) ? candidateRefs.pr : {};
  const owner = readStringField(pr?.owner);
  const repo = readStringField(pr?.repo);
  const prNumber = readPositiveInteger(pr?.number);
  const headRefOid = normalizeShaCandidate(pr?.headRefOid);
  const headRefName = normalizeBranchRefText(pr?.headRefName);
  if (!owner || !repo || !prNumber || !headRefOid) return null;

  const thread = isPlainObject(candidateRefs?.thread) ? candidateRefs.thread : null;
  if (thread) {
    const threadId = readStringField(thread?.id);
    const lastCommentId = readStringField(thread?.lastCommentId);
    const lastCommentCreatedAt = readStringField(thread?.lastCommentCreatedAt);
    const lastCommentUpdatedAt = readStringField(thread?.lastCommentUpdatedAt);
    if (!threadId || !lastCommentId || !lastCommentCreatedAt || !lastCommentUpdatedAt) return null;
    return {
      phase,
      sourcePath: directObserver ? 'direct' : 'sourceReferences',
      owner,
      repo,
      prNumber,
      headRefOid,
      headRefName,
      thread: {
        id: threadId,
        url: readStringField(thread?.url) || null,
        lastCommentId,
        lastCommentCreatedAt,
        lastCommentUpdatedAt,
      },
      comment: null,
    };
  }

  const comment = isPlainObject(candidateRefs?.comment) ? candidateRefs.comment : null;
  if (comment) {
    const commentId = readPositiveInteger(comment?.id);
    const bodyHash = readStringField(comment?.bodyHash);
    if (!commentId || !bodyHash) return null;
    return {
      phase,
      sourcePath: directObserver ? 'direct' : 'sourceReferences',
      owner,
      repo,
      prNumber,
      headRefOid,
      headRefName,
      thread: null,
      comment: {
        id: commentId,
        url: readStringField(comment?.url) || null,
        updatedAt: readStringField(comment?.updatedAt) || null,
        bodyHash,
      },
    };
  }

  return null;
}

/**
 * Builds shared review-fix freshness evidence payload.
 */
function buildReviewFixFreshnessEvidence(source, extra = {}) {
  return {
    sourcePath: source.sourcePath,
    phase: source.phase,
    prNumber: source.prNumber,
    expectedHeadRefOid: source.headRefOid,
    ...extra,
  };
}

/**
 * Builds review-fix freshness warning result.
 */
function buildReviewFixFreshnessWarning(source, warningStage, extra = {}) {
  return {
    status: 'warning',
    reasonCode: 'freshness_lookup_failed',
    evidence: {
      status: 'warning',
      reasonCode: 'freshness_lookup_failed',
      warningStage,
      ...buildReviewFixFreshnessEvidence(source, extra),
    },
  };
}

/**
 * Builds review-fix freshness stale result.
 */
function buildReviewFixFreshnessStale(source, staleCause, extra = {}) {
  return {
    status: 'stale',
    reasonCode: 'review_fix_source_superseded',
    staleCause,
    evidence: {
      status: 'stale',
      staleCause,
      ...buildReviewFixFreshnessEvidence(source, extra),
    },
  };
}

/**
 * Builds review-fix freshness fresh result.
 */
function buildReviewFixFreshnessFresh(source, sourceType, extra = {}) {
  return {
    status: 'fresh',
    evidence: {
      status: 'fresh',
      sourceType,
      ...buildReviewFixFreshnessEvidence(source, extra),
    },
  };
}

/**
 * Executes a command and returns parsed JSON or a structured error.
 */
function runJsonCommand(cmd, args, { cwd, timeoutMs = 5_000 } = {}) {
  try {
    const raw = childProcess.execFileSync(cmd, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });
    const text = String(raw ?? '').trim();
    return { ok: true, value: text ? JSON.parse(text) : null, error: null };
  } catch (err) {
    const stderr =
      typeof err?.stderr === 'string'
        ? err.stderr
        : Buffer.isBuffer(err?.stderr)
          ? err.stderr.toString('utf8')
          : '';
    const stdout =
      typeof err?.stdout === 'string'
        ? err.stdout
        : Buffer.isBuffer(err?.stdout)
          ? err.stdout.toString('utf8')
          : '';
    return {
      ok: false,
      value: null,
      error: {
        message: readStringField(err?.message) || 'command_failed',
        stderr: stderr.trim(),
        stdout: stdout.trim(),
      },
    };
  }
}

/**
 * Reads live review thread freshness state from GitHub.
 */
function readLiveReviewThreadState({ cwd, threadId, timeoutMs = 5_000 }) {
  const query = [
    'query($threadId:ID!){',
    '  node(id:$threadId){',
    '    __typename',
    '    ... on PullRequestReviewThread {',
    '      id',
    '      isResolved',
    '      isOutdated',
    '      comments(last:1){nodes{id createdAt updatedAt}}',
    '    }',
    '  }',
    '}',
  ].join('\n');
  return runJsonCommand(
    'gh',
    ['api', 'graphql', '-f', `query=${query}`, '-F', `threadId=${threadId}`],
    { cwd, timeoutMs },
  );
}

/**
 * Reads live issue comment freshness state from GitHub.
 */
function readLiveIssueCommentState({ cwd, owner, repo, commentId, timeoutMs = 5_000 }) {
  return runJsonCommand(
    'gh',
    ['api', `repos/${owner}/${repo}/issues/comments/${commentId}`],
    { cwd, timeoutMs },
  );
}

/**
 * Evaluates whether observer-driven review-fix work is stale before Codex runs.
 */
function evaluateReviewFixFreshness({ taskMeta, cwd, headLookupTimeoutMs = AUTOPILOT_PR_HEAD_LOOKUP_TIMEOUT_MS }) {
  const source = readReviewFixFreshnessSource(taskMeta);
  if (!source) return { status: 'not_applicable' };

  const liveHeadRefOid = readIncomingPrHeadSha({
    cwd,
    prNumber: source.prNumber,
    timeoutMs: headLookupTimeoutMs,
  });
  if (!liveHeadRefOid) {
    return buildReviewFixFreshnessWarning(source, 'pr_head');
  }
  if (liveHeadRefOid !== source.headRefOid) {
    return buildReviewFixFreshnessStale(source, 'pr_head_moved', { liveHeadRefOid });
  }

  if (source.thread) {
    const threadEvidence = {
      threadId: source.thread.id,
      liveHeadRefOid,
    };
    const threadState = readLiveReviewThreadState({
      cwd,
      threadId: source.thread.id,
      timeoutMs: headLookupTimeoutMs,
    });
    if (!threadState.ok) {
      return buildReviewFixFreshnessWarning(source, 'review_thread', {
        ...threadEvidence,
        error: threadState.error,
      });
    }
    const liveThread = isPlainObject(threadState.value?.data?.node) ? threadState.value.data.node : null;
    if (!liveThread || readStringField(liveThread.__typename) !== 'PullRequestReviewThread') {
      return buildReviewFixFreshnessStale(source, 'review_thread_missing', threadEvidence);
    }
    if (liveThread.isResolved === true) {
      return buildReviewFixFreshnessStale(source, 'review_thread_resolved', threadEvidence);
    }
    if (liveThread.isOutdated === true) {
      return buildReviewFixFreshnessStale(source, 'review_thread_outdated', threadEvidence);
    }
    const liveLastComment = liveThread?.comments?.nodes?.[0] ?? null;
    const liveLastCommentId = readStringField(liveLastComment?.id);
    const liveLastCommentCreatedAt = readStringField(liveLastComment?.createdAt);
    const liveLastCommentUpdatedAt = readStringField(liveLastComment?.updatedAt);
    if (
      liveLastCommentId !== source.thread.lastCommentId ||
      liveLastCommentCreatedAt !== source.thread.lastCommentCreatedAt ||
      liveLastCommentUpdatedAt !== source.thread.lastCommentUpdatedAt
    ) {
      return buildReviewFixFreshnessStale(source, 'review_thread_updated', {
        ...threadEvidence,
        expectedLastCommentId: source.thread.lastCommentId,
        expectedLastCommentCreatedAt: source.thread.lastCommentCreatedAt,
        expectedLastCommentUpdatedAt: source.thread.lastCommentUpdatedAt,
        liveLastCommentId: liveLastCommentId || null,
        liveLastCommentCreatedAt: liveLastCommentCreatedAt || null,
        liveLastCommentUpdatedAt: liveLastCommentUpdatedAt || null,
      });
    }
    return buildReviewFixFreshnessFresh(source, 'thread', threadEvidence);
  }

  if (source.comment) {
    const commentEvidence = {
      commentId: source.comment.id,
      liveHeadRefOid,
    };
    const commentState = readLiveIssueCommentState({
      cwd,
      owner: source.owner,
      repo: source.repo,
      commentId: source.comment.id,
      timeoutMs: headLookupTimeoutMs,
    });
    if (!commentState.ok) {
      const errorText = `${commentState.error?.message || ''}\n${commentState.error?.stderr || ''}`.trim();
      if (/404|not found/i.test(errorText)) {
        return buildReviewFixFreshnessStale(source, 'issue_comment_missing', commentEvidence);
      }
      return buildReviewFixFreshnessWarning(source, 'issue_comment', {
        ...commentEvidence,
        error: commentState.error,
      });
    }
    const liveComment = isPlainObject(commentState.value) ? commentState.value : null;
    if (!liveComment) {
      return buildReviewFixFreshnessStale(source, 'issue_comment_missing', commentEvidence);
    }
    const liveBody = typeof liveComment.body === 'string' ? liveComment.body : '';
    if (!isActionableComment(liveBody)) {
      return buildReviewFixFreshnessStale(source, 'issue_comment_no_longer_actionable', commentEvidence);
    }
    const liveBodyHash = hashActionableCommentBody(liveBody);
    if (liveBodyHash !== source.comment.bodyHash) {
      return buildReviewFixFreshnessStale(source, 'issue_comment_edited', {
        ...commentEvidence,
        expectedBodyHash: source.comment.bodyHash,
        liveBodyHash,
      });
    }
    return buildReviewFixFreshnessFresh(source, 'comment', commentEvidence);
  }

  return { status: 'not_applicable' };
}

const EXTERNAL_CODE_QUALITY_REASON_CODES = new Set([
  'gate_exec_failed',
  'missing_base_ref',
  'scope_invalid',
  'scope_mismatch',
]);

function buildAutopilotModelOutputSignature({
  parsedAutopilotControl,
  parsedFollowUps,
  sourceDelta,
  commitSha,
}) {
  const followUpTargets = new Set();
  for (const followUp of Array.isArray(parsedFollowUps) ? parsedFollowUps : []) {
    if (normalizeTaskKind(followUp?.signals?.kind) !== 'EXECUTE') continue;
    for (const target of normalizeToArray(followUp?.to).map(readStringField).filter(Boolean)) {
      followUpTargets.add(target);
    }
  }
  return {
    executionMode: readStringField(parsedAutopilotControl?.executionMode) || '',
    hasExecuteFollowUp: followUpTargets.size > 0,
    sourceFilesCount: Number(sourceDelta?.sourceFilesCount) || 0,
    commitShaPresent: Boolean(readStringField(commitSha)),
    followUpCount: Array.isArray(parsedFollowUps) ? parsedFollowUps.length : 0,
    followUpTargets: Array.from(followUpTargets).sort(),
  };
}

function classifyBlockedRecoveryCodeQuality(reasonCodes) {
  const normalized = Array.from(
    new Set((Array.isArray(reasonCodes) ? reasonCodes : []).map(readStringField).filter(Boolean)),
  ).sort();
  const contractClass =
    normalized.length === 0 || normalized.some((reasonCode) => EXTERNAL_CODE_QUALITY_REASON_CODES.has(reasonCode))
      ? 'external'
      : 'controller';
  return {
    contractClass,
    reasonCode: normalized[0] || 'code_quality_gate_failed',
    normalizedReasonCodes: normalized,
  };
}
const OPUS_CONSULT_RESOLUTION_MAX_ENTRIES = 20_000;
const OPUS_CONSULT_RESOLUTION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function buildOpusConsultResolutionKey({ consultId, phase, round }) {
  const cid = readStringField(consultId);
  const ph = readStringField(phase);
  const rd = Math.max(1, Math.min(200, Number(round) || 1));
  return safeStateBasename(`${cid}__${ph}__r${rd}`);
}

function resolveOpusConsultResolutionPath({ busRoot, consultId, phase, round }) {
  const key = buildOpusConsultResolutionKey({ consultId, phase, round });
  const dir = path.join(busRoot, 'state', 'opus-consult-resolution');
  return {
    key,
    dir,
    path: path.join(dir, `${key}.json`),
  };
}

async function readOpusConsultResolution({ busRoot, consultId, phase, round }) {
  const p = resolveOpusConsultResolutionPath({ busRoot, consultId, phase, round }).path;
  const parsed = await readJsonFileOrNull(p);
  return parsed && typeof parsed === 'object' ? parsed : null;
}

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

function buildAutopilotBlockedRecoveryContract({
  openedMeta,
  receiptExtra,
  note,
  parsedAutopilotControl,
  parsedFollowUps,
  sourceDelta,
  commitSha,
  cwd,
  agentName,
  skillOpsPromotionStateDir = '',
}) {
  const runtimeGuard = isPlainObject(receiptExtra?.runtimeGuard) ? receiptExtra.runtimeGuard : {};
  const recoveryRef = isPlainObject(openedMeta?.references?.autopilotRecovery)
    ? openedMeta.references.autopilotRecovery
    : {};
  const modelOutput = buildAutopilotModelOutputSignature({
    parsedAutopilotControl,
    parsedFollowUps,
    sourceDelta,
    commitSha,
  });
  const buildContract = (contractClass, gate, reasonCode, details = {}, noteText = '') => {
    const normalizedReasonCode = readStringField(reasonCode) || 'blocked';
    return {
      class: contractClass,
      reasonCode: normalizedReasonCode,
      fingerprint: hashBlockedRecoveryFingerprint({
        gate,
        reasonCode: normalizedReasonCode,
        details,
        modelOutput: contractClass === 'controller' ? modelOutput : null,
        note: details && Object.keys(details).length ? '' : normalizeBlockedRecoveryFingerprintText(noteText),
      }),
    };
  };

  const delegationGate = isPlainObject(runtimeGuard.delegationGate) ? runtimeGuard.delegationGate : {};
  if (readStringField(delegationGate.status) === 'blocked') {
    return buildContract('controller', readStringField(delegationGate.path) || 'delegation', delegationGate.reasonCode, {
      path: readStringField(delegationGate.path),
      decompositionRequired: Boolean(delegationGate.decompositionRequired),
      decompositionReasonCode: readStringField(delegationGate.decompositionReasonCode),
    });
  }

  const selfReviewGate = isPlainObject(runtimeGuard.selfReviewGate) ? runtimeGuard.selfReviewGate : {};
  if (readStringField(selfReviewGate.status) === 'blocked') {
    return buildContract('controller', 'self_review', selfReviewGate.reasonCode, {
      runtimeReviewPrimedFor: Boolean(readStringField(selfReviewGate.runtimeReviewPrimedFor)),
    });
  }

  const skillOpsGate = isPlainObject(runtimeGuard.skillOpsGate) ? runtimeGuard.skillOpsGate : {};
  if (Array.isArray(skillOpsGate.errors) && skillOpsGate.errors.length > 0) {
    return buildContract('controller', 'skillops', 'skillops_gate_failed', {
      errors: skillOpsGate.errors.map((entry) => normalizeBlockedRecoveryFingerprintText(entry)).sort(),
      commandChecks: normalizeBlockedRecoveryFingerprintValue(skillOpsGate.commandChecks ?? null),
    });
  }

  const codeQualityGate = isPlainObject(runtimeGuard.codeQualityGate) ? runtimeGuard.codeQualityGate : {};
  const codeQualityReview = isPlainObject(runtimeGuard.codeQualityReview) ? runtimeGuard.codeQualityReview : {};
  if (Array.isArray(codeQualityGate.errors) && codeQualityGate.errors.length > 0) {
    const classification = classifyBlockedRecoveryCodeQuality(codeQualityGate.reasonCodes);
    const signature = workerCodeQualityState.buildCodeQualityRetrySignature({
      reasonCode: classification.reasonCode,
      codeQualityGateEvidence: { ...codeQualityGate, reasonCodes: classification.normalizedReasonCodes },
      codeQualityReviewEvidence: codeQualityReview,
      errors: codeQualityGate.errors,
    });
    return classification.contractClass === 'controller'
      ? buildContract('controller', 'code_quality', classification.reasonCode, { signature })
      : buildContract('external', 'code_quality', classification.reasonCode, { signature }, note);
  }

  const observerDrainGate = isPlainObject(runtimeGuard.observerDrainGate) ? runtimeGuard.observerDrainGate : {};
  if (Array.isArray(observerDrainGate.errors) && observerDrainGate.errors.length > 0) {
    return buildContract('controller', 'observer_drain', 'observer_drain_gate_failed', {
      rootId: readStringField(observerDrainGate.rootId),
      pendingCount: Number(observerDrainGate.pendingCount) || 0,
      pendingTaskIds: Array.isArray(observerDrainGate.pendingTaskIds)
        ? observerDrainGate.pendingTaskIds.map(readStringField).filter(Boolean).sort()
        : [],
    });
  }

  const integrationGate = isPlainObject(runtimeGuard.integrationGate) ? runtimeGuard.integrationGate : {};
  if (integrationGate.reason || runtimeGuard.commitPushVerification) {
    return buildContract('external', 'integration', integrationGate.reason || 'commit_push_verification_failed', {
      requiredBranch: readStringField(integrationGate.requiredBranch),
      reachable: integrationGate.reachable,
      matchedRefs: Array.isArray(integrationGate.matchedRefs)
        ? integrationGate.matchedRefs.map(readStringField).filter(Boolean).sort()
        : [],
    }, note);
  }

  if (Number.isFinite(Number(receiptExtra?.timeoutMs)) && Number(receiptExtra.timeoutMs) > 0) {
    return buildContract(
      'external',
      'timeout',
      'codex_turn_timeout',
      { timeoutBucketMs: Math.max(1000, Math.round(Number(receiptExtra.timeoutMs) / 1000) * 1000) },
      note,
    );
  }

  if (readStringField(receiptExtra?.reasonCode).startsWith('opus_')) {
    return buildContract('external', 'opus_consult', receiptExtra.reasonCode, receiptExtra?.details, note);
  }

  if (readStringField(receiptExtra?.details?.reasonCode) === 'dirty_cross_root_transition') {
    const dirtySnapshot = cwd ? getGitSnapshot({ cwd }) : null;
    const controllerDirty = cwd
      ? classifyControllerDirtyWorktree({
          cwd,
          statusPorcelain: String(dirtySnapshot?.statusPorcelain || receiptExtra?.details?.statusPorcelain || ''),
          agentName,
          branch: readStringField(dirtySnapshot?.branch),
          repoCommonGitDir: readGitCommonDir(cwd),
          headSha: readStringField(dirtySnapshot?.headSha),
          skillOpsPromotionStateDir,
          autoCleanRuntimeArtifacts: false,
        })
      : null;
    if (controllerDirty?.classification === 'controller_housekeeping_required') {
      return {
        class: 'controller',
        reasonCode: 'dirty_cross_root_transition',
        fingerprint: controllerDirty.fingerprint,
      };
    }
    return buildContract(
      'external',
      'git_preflight',
      'dirty_cross_root_transition',
      receiptExtra?.details,
      note,
    );
  }

  if (readStringField(receiptExtra?.error).startsWith('git preflight blocked:')) {
    return buildContract('external', 'git_preflight', 'git_preflight_blocked', receiptExtra?.details, note);
  }

  if (readStringField(receiptExtra?.error).startsWith('codex app-server blocked by sandbox/permissions:')) {
    return buildContract('external', 'sandbox', 'sandbox_blocked', { stderrTail: receiptExtra?.stderrTail || null }, note);
  }

  const inheritedClass = normalizeAutopilotRecoveryContractClass(recoveryRef?.contractClass) || 'external';
  const inheritedReasonCode = readStringField(recoveryRef?.reasonCode) || readStringField(receiptExtra?.reasonCode) || 'blocked';
  if (recoveryRef?.recoveryKey) {
    if (inheritedClass === 'controller') {
      return {
        class: 'controller',
        reasonCode: inheritedReasonCode,
        fingerprint:
          readStringField(recoveryRef?.fingerprint) ||
          buildContract('controller', 'blocked_recovery', inheritedReasonCode).fingerprint,
      };
    }
    return buildContract('external', 'blocked_recovery', inheritedReasonCode, receiptExtra?.details, note);
  }

  return buildContract('external', 'blocked', readStringField(receiptExtra?.reasonCode) || 'blocked', receiptExtra?.details, note);
}

function markAutopilotBlockedContract({ receiptExtra, contract }) {
  if (!contract) return receiptExtra;
  const base = isPlainObject(receiptExtra) ? receiptExtra : {};
  return {
    ...base,
    reasonCode: readStringField(base.reasonCode) || contract.reasonCode,
    blockedRecoveryContract: contract,
  };
}

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

  const userRequestedTargetCommitSha = readStringField(userRequestedReviewTargetCommitSha);
  const userRequestedTargetCommitShas = normalizeCommitShaList(userRequestedReviewTargetCommitShas);
  const reviewTargetCommitSha =
    readStringField(reviewTarget?.commitSha) ||
    readStringField(taskMeta?.references?.commitSha);
  const reviewTargetCommitShas = normalizeCommitShaList([
    ...(Array.isArray(reviewTarget?.commitShas) ? reviewTarget.commitShas : []),
    reviewTargetCommitSha,
  ]);
  const targetCommitShas = userRequestedReview
    ? normalizeCommitShaList([...userRequestedTargetCommitShas, userRequestedTargetCommitSha])
    : reviewTargetCommitShas;
  const targetCommitSha = targetCommitShas.length
    ? targetCommitShas[targetCommitShas.length - 1]
    : (userRequestedReview ? userRequestedTargetCommitSha : reviewTargetCommitSha);
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
    targetCommitSha,
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

function isExplicitReviewExcludeDirectiveLine(value) {
  const line = String(value || '').trim().toLowerCase();
  return (
    /\b(?:re-?review|review)\b/.test(line) &&
    /^(?:[-*]\s*)?(?:(?:current\s+expectation|latest\s+request|override|update)\s*:\s*)?(?:do not|don't|skip)\b/.test(line)
  );
}

function isExplicitReviewIncludeDirectiveLine(value) {
  const line = String(value || '').trim().toLowerCase();
  return /^(?:[-*]\s*)?(?:(?:current\s+expectation|latest\s+request|override|update)\s*:\s*)?(?:please\s+)?(?:re-?review|review)\b/.test(line);
}

function extractCommitShaFromText(value) {
  const text = String(value || '');
  const m = text.match(/\b([0-9a-f]{6,40})\b/i);
  return m ? m[1].toLowerCase() : '';
}

function extractPrNumberFromText(value) {
  const text = String(value || '');
  const m = text.match(/\b(?:PR|pull\s+request)\s*#?\s*(\d{1,8})\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function inferUserRequestedReviewGate({ taskKind, taskMeta, taskMarkdown, cwd }) {
  if (String(taskKind || '').trim().toUpperCase() !== 'USER_REQUEST') {
    return { requested: false, targetCommitSha: '', targetCommitShas: [], resolutionError: '' };
  }

  const title = readStringField(taskMeta?.title);
  const fullBodyText = String(taskMarkdown || '');
  const fullText = [title, fullBodyText].filter(Boolean).join('\n');
  let latestBodyText = fullBodyText;
  let hasUpdateBlock = false;
  if (fullBodyText.trim()) {
    const marker = /^### Update \([^)]+\) from [^\n]+\n\n/gm;
    let match = null;
    for (;;) {
      const next = marker.exec(fullBodyText);
      if (!next) break;
      match = next;
    }
    if (match) {
      latestBodyText = fullBodyText.slice(match.index + match[0].length).trim();
      hasUpdateBlock = true;
    }
  }
  const selectorText = hasUpdateBlock ? latestBodyText : fullText;
  const directiveText = [title, latestBodyText].filter(Boolean).join('\n');
  if (!isExplicitReviewRequestText(directiveText) && !isExplicitReviewRequestText(fullText)) {
    return { requested: false, targetCommitSha: '', targetCommitShas: [], resolutionError: '' };
  }

  /** @type {string[]} */
  const explicitInclude = [];
  /** @type {string[]} */
  const explicitExclude = [];
  for (const rawLine of selectorText.split(/\r?\n/)) {
    const shas = normalizeCommitShaList(rawLine.match(/\b[0-9a-f]{6,40}\b/ig) || []);
    if (!shas.length) continue;
    if (isExplicitReviewExcludeDirectiveLine(rawLine)) {
      explicitExclude.push(...shas);
      continue;
    }
    if (isExplicitReviewIncludeDirectiveLine(rawLine)) {
      explicitInclude.push(...shas);
    }
  }
  let targetCommitSha = '';
  /** @type {string[]} */
  let targetCommitShas = [];
  const prNumber = extractPrNumberFromText(directiveText) || extractPrNumberFromText(fullText);
  let prCommitShas = [];
  let resolutionError = '';
  const resolveExplicitLocalTargets = (values, label) => {
    const resolved = [];
    for (const value of normalizeCommitShaList(values)) {
      const localResolved =
        value.length === 40
          ? value
          : normalizeShaCandidate(
              safeExecText('git', ['rev-parse', '--verify', `${value}^{commit}`], { cwd }) || '',
            );
      if (!localResolved) {
        resolutionError = `explicit review requested, but ${label} commit target ${value} could not be resolved locally`;
        return [];
      }
      resolved.push(localResolved);
    }
    return normalizeCommitShaList(resolved);
  };
  if (prNumber) {
    const commitLines = safeExecText(
      'gh',
      ['pr', 'view', String(prNumber), '--json', 'commits', '--jq', '.commits[].oid'],
      { cwd },
    );
    prCommitShas = normalizeCommitShaList(String(commitLines || '').split('\n'));
    if (explicitInclude.length || explicitExclude.length) {
      if (!prCommitShas.length) {
        resolutionError =
          `explicit PR review requested for PR#${prNumber}, but PR commit list could not be fetched to resolve directive SHAs`;
      } else {
        const resolveExplicit = (values, label) => {
          const resolved = [];
          for (const value of normalizeCommitShaList(values)) {
            const matches = prCommitShas.filter((sha) => sha === value || sha.startsWith(value));
            if (matches.length !== 1) {
              resolutionError =
                `explicit PR review requested for PR#${prNumber}, but ${label} commit target ${value} did not uniquely resolve`;
              return [];
            }
            resolved.push(matches[0]);
          }
          return normalizeCommitShaList(resolved);
        };
        explicitInclude.splice(0, explicitInclude.length, ...resolveExplicit(explicitInclude, 'included'));
        if (!resolutionError) {
          explicitExclude.splice(0, explicitExclude.length, ...resolveExplicit(explicitExclude, 'excluded'));
        }
      }
    }
  } else if (explicitInclude.length || explicitExclude.length) {
    explicitInclude.splice(0, explicitInclude.length, ...resolveExplicitLocalTargets(explicitInclude, 'included'));
    if (!resolutionError) {
      explicitExclude.splice(0, explicitExclude.length, ...resolveExplicitLocalTargets(explicitExclude, 'excluded'));
    }
  }
  if (resolutionError) {
    return { requested: true, targetCommitSha: '', targetCommitShas: [], resolutionError };
  }
  if (explicitInclude.length) {
    targetCommitShas = explicitInclude.slice();
    targetCommitSha = targetCommitShas[targetCommitShas.length - 1] || '';
  } else if (prNumber && prCommitShas.length && explicitExclude.length) {
    targetCommitShas = prCommitShas.slice();
    targetCommitSha = targetCommitShas[targetCommitShas.length - 1] || '';
  } else if (prNumber) {
    targetCommitSha = '';
    targetCommitShas = [];
  } else {
    const fallbackTargetCommitSha =
      readStringField(taskMeta?.references?.commitSha) ||
      extractCommitShaFromText(selectorText) ||
      extractCommitShaFromText(fullText) ||
      '';
    const resolvedFallbackTargets = fallbackTargetCommitSha
      ? resolveExplicitLocalTargets([fallbackTargetCommitSha], 'requested')
      : [];
    if (resolutionError) {
      return { requested: true, targetCommitSha: '', targetCommitShas: [], resolutionError };
    }
    targetCommitSha = resolvedFallbackTargets[0] || fallbackTargetCommitSha;
    targetCommitShas = targetCommitSha ? [targetCommitSha] : [];
  }

  const hadResolvedTargetsBeforeExclude = targetCommitShas.length > 0;

  if (prNumber && targetCommitShas.length === 0) {
    if (prCommitShas.length) {
      targetCommitShas = prCommitShas;
      targetCommitSha = prCommitShas[prCommitShas.length - 1];
    } else if (!targetCommitSha) {
      const head = safeExecText(
        'gh',
        ['pr', 'view', String(prNumber), '--json', 'headRefOid', '--jq', '.headRefOid'],
        { cwd, timeoutMs: 5_000 },
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

  if (explicitExclude.length) {
    const excluded = new Set(explicitExclude);
    targetCommitShas = targetCommitShas.filter((sha) => !excluded.has(sha));
    targetCommitSha = targetCommitShas[targetCommitShas.length - 1] || '';
  }

  if (!prNumber && hadResolvedTargetsBeforeExclude && explicitExclude.length && !targetCommitSha && targetCommitShas.length === 0) {
    return {
      requested: true,
      targetCommitSha: '',
      targetCommitShas: [],
      resolutionError: 'explicit review requested, but no commit targets remained after explicit review filters',
    };
  }

  if (prNumber && !targetCommitSha && targetCommitShas.length === 0) {
    return {
      requested: true,
      targetCommitSha: '',
      targetCommitShas: [],
      resolutionError: `explicit PR review requested for PR#${prNumber}, but no commit targets remained after explicit review filters`,
    };
  }

  return { requested: true, targetCommitSha, targetCommitShas, resolutionError: '' };
}

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

function deriveAutopilotDecompositionGate({ isAutopilot, taskKind, taskMeta, taskBody, env = process.env }) {
  const kind = readStringField(taskKind)?.toUpperCase() || '';
  const enabled = parseBooleanEnv(
    env.AGENTIC_AUTOPILOT_EARLY_DECOMPOSITION_GATE ??
      env.VALUA_AUTOPILOT_EARLY_DECOMPOSITION_GATE ??
      '1',
    true,
  );
  if (!(isAutopilot && enabled && kind === 'USER_REQUEST')) {
    return { required: false, reasonCode: null };
  }

  const title = readStringField(taskMeta?.title);
  const body = String(taskBody || '');
  const distinctPrCount = new Set(Array.from(body.matchAll(/\bPR\s*#?\s*(\d{1,8})\b/gi), (m) => m[1])).size;
  const checklistCount = body
    .split(/\r?\n/)
    .filter((line) => /^\s*(?:[-*]|\d+\.)\s+\S+/.test(line))
    .length;
  const hasOrderedSection = /(?:^|\n)\s*required\s+order\s*:/i.test(body);

  let reasonCode = '';
  if (distinctPrCount >= 2) {
    reasonCode = 'multi_pr_root';
  } else if (hasOrderedSection && checklistCount >= 3) {
    reasonCode = 'ordered_multistep_root';
  }

  return { required: Boolean(reasonCode), reasonCode: reasonCode || null };
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
          preflightPlan:
            candidateOutput?.preflightPlan && typeof candidateOutput.preflightPlan === 'object'
              ? candidateOutput.preflightPlan
              : null,
          preflightPlanHash:
            candidateOutput?.runtimeGuard?.preflightGate &&
            typeof candidateOutput.runtimeGuard.preflightGate === 'object'
              ? readStringField(candidateOutput.runtimeGuard.preflightGate.planHash) || null
              : null,
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
  const rootId = readOpenedRootId(openedMeta, makeId('root'));
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
  const rootId = readOpenedRootId(openedMeta, makeId('root'));
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
      const items = await listInboxTasks({ busRoot, agentName, state, limit: 'all' });
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
  const consultMode = readStringField(gate?.consultMode) || 'advisory';
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
  // Only active sibling review-fix digests should block closeout.
  // `seen` means the packet was opened, not that unresolved review work is still queued.
  for (const state of ['in_progress', 'new']) {
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

function reviewGatePrimeKey(reviewGate) {
  if (!reviewGate?.required) return '__none__';
  const commits = Array.isArray(reviewGate?.targetCommitShas)
    ? reviewGate.targetCommitShas.map((s) => readStringField(s)).filter(Boolean)
    : [];
  if (commits.length) return commits.join(',');
  return reviewGate?.targetCommitSha || '__required__';
}

function buildSkillOpsGatePromptBlock({ skillOpsGate }) {
  if (!skillOpsGate?.required) return '';
  return (
    `MANDATORY SKILLOPS GATE:\n` +
    `Before returning outcome="done", run and report all SkillOps commands:\n` +
    `- node scripts/skillops.mjs debrief --skills <skill-a,skill-b> --title "..." \n` +
    `  Fast path when the learning is already clear: add --skill-update "skill-a:1-line rule" during debrief.\n` +
    `- node scripts/skillops.mjs distill\n` +
    `- node scripts/skillops.mjs lint\n` +
    `SkillOps distill is non-durable. Raw logs stay local. Runtime will retire empty logs locally and automatically queue a dedicated promotion lane when learnings are non-empty.\n` +
    `Required output evidence:\n` +
    `- testsToRun must include those commands.\n` +
    `- artifacts must include the debrief markdown path under .codex/skill-ops/logs/.\n\n`
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

function hasNestedCodexCliUsage(value) {
  return /\bcodex\s+(review|exec|app-server|resume)\b/i.test(String(value ?? ''));
}

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
  const reviewedCommits = normalizeReviewedCommitShas(review);
  if (scope === 'commit' && reviewGate.targetCommitSha && !reviewedCommits.includes(reviewGate.targetCommitSha)) {
    errors.push(`review.reviewedCommits must include ${reviewGate.targetCommitSha}`);
  }
  if (scope === 'commit' && reviewGate.targetCommitSha) {
    const extras = reviewedCommits.filter((sha) => sha !== reviewGate.targetCommitSha);
    if (extras.length) {
      errors.push('review.reviewedCommits must not include commits outside the requested commit target');
    }
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
      for (const sha of reviewedCommits) {
        if (!expectedCommits.includes(sha)) {
          errors.push(`review.reviewedCommits must not include commit ${sha} outside requested PR scope`);
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

function normalizeArtifactPaths(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => readStringField(entry)).filter(Boolean);
}

function isSkillOpsLogPath(value) {
  const normalized = String(value || '').trim().replace(/\\/g, '/');
  if (!normalized) return false;
  if (normalized.includes('/.codex/skill-ops/logs/')) return true;
  if (normalized.startsWith('.codex/skill-ops/logs/')) return true;
  return false;
}

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
 * Builds prompt used by workflow automation.
 */
function buildPrompt({
  agentName,
  skillsSelected,
  includeSkills,
  taskKind,
  isSmoke,
  isAutopilot,
  preflightRequired,
  approvedPreflightPlan,
  approvedPreflightPlanHash,
  reviewGate,
  reviewRetryReason,
  decompositionRetryReason,
  codeQualityRetryReasonCode,
  codeQualityRetryReason,
  skillOpsGate,
  codeQualityGate,
  observerDrainGate,
  decompositionGate,
  opusConsultAdvice,
  requireOpusDisposition,
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
        `- If a decision is missing, choose the safest default, proceed, and record it in your note.\n` +
        (decompositionGate?.required
          ? `- This root is clearly multi-slice. In your first response, dispatch at least one EXECUTE followUp unless it is pure review-only.\n` +
            `  Do not sit on the whole root yourself; use autopilotControl.executionMode="delegate" for normal worker fan-out.\n` +
            (decompositionRetryReason
              ? `- DECOMPOSITION RETRY REQUIREMENT:\n` +
                `  Your previous output still tried to close this multi-slice root without the required EXECUTE followUp.\n` +
                `  Fix it now by dispatching at least one EXECUTE followUp, or make the closure pure review-only.\n` +
                `  reasonCode=${decompositionRetryReason}\n`
              : '')
          : '') +
        `\n`
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
    buildPreflightPromptBlock({
      required: preflightRequired,
      approvedPlan: approvedPreflightPlan,
      planHash: approvedPreflightPlanHash,
    }) +
    buildReviewGatePromptBlock({ reviewGate, reviewRetryReason }) +
    buildSkillOpsGatePromptBlock({ skillOpsGate }) +
    workerCodeQuality.buildCodeQualityGatePromptBlock({
      codeQualityGate,
      cockpitRoot,
      codeQualityRetryReasonCode,
      codeQualityRetryReason,
    }) +
    buildObserverDrainGatePromptBlock({ observerDrainGate }) +
    buildOpusConsultPromptBlock({
      isAutopilot,
      preExecAdvice: opusConsultAdvice?.preExec || null,
      requireDisposition: requireOpusDisposition,
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
  await writeJsonAtomic(outPath, payload);
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
function buildReceiptGitExtra({
  cwd,
  preflight,
  preflightCleanArtifactPath = null,
  staleWorkerReclaim = null,
}) {
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
    staleWorkerReclaim: sanitizeStaleWorkerReclaimForReceipt(staleWorkerReclaim),
  };
}

function maybeBuildReceiptGitExtra({
  cwd,
  preflight,
  preflightCleanArtifactPath = null,
  staleWorkerReclaim = null,
}) {
  if (!cwd) return null;
  if (!preflight && !preflightCleanArtifactPath && !staleWorkerReclaim) return null;
  return buildReceiptGitExtra({
    cwd,
    preflight,
    preflightCleanArtifactPath,
    staleWorkerReclaim,
  });
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
  const parsed = await readJsonFileOrNull(p);
  const generationRaw = Number(parsed?.generation);
  const generation = Number.isFinite(generationRaw) && generationRaw >= 0 ? Math.floor(generationRaw) : 0;
  return { path: p, generation, payload: parsed };
}

/**
 * Writes branch continuity state.
 */
async function writeBranchContinuityState({ busRoot, targetAgent, rootId, workstream, generation }) {
  const key = safeStateBasename(buildBranchContinuityKey({ targetAgent, rootId, workstream }));
  const dir = path.join(busRoot, 'state', 'branch-continuity');
  await fs.mkdir(dir, { recursive: true });
  const p = path.join(dir, `${key}.json`);
  const payload = {
    updatedAt: new Date().toISOString(),
    targetAgent,
    rootId,
    workstream,
    generation: Math.max(0, Number(generation) || 0),
  };
  await writeJsonAtomic(p, payload);
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

function readOpenedRootId(openedMeta, fallback = '') {
  return readStringField(openedMeta?.signals?.rootId) || readStringField(openedMeta?.id) || readStringField(fallback);
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
  const combinedGateRetryBudgetRaw =
    process.env.AGENTIC_GATE_TOTAL_RETRY_BUDGET ??
    process.env.VALUA_GATE_TOTAL_RETRY_BUDGET ??
    '2';
  const combinedGateRetryBudgetParsed = Number(combinedGateRetryBudgetRaw);
  const combinedGateRetryBudget = Number.isFinite(combinedGateRetryBudgetParsed)
    ? Math.max(0, Math.floor(combinedGateRetryBudgetParsed))
    : 2;
  const appServerPersistEnabled = parseBooleanEnv(
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
  const { agenticWorktreesDir, valuaWorktreesDir } = resolveWorktreesRoots({
    worktreesDir:
      process.env.AGENTIC_WORKTREES_DIR?.trim() ||
      process.env.VALUA_AGENT_WORKTREES_DIR?.trim() ||
      defaultWorktreesDir,
    agenticWorktreesDir: process.env.AGENTIC_WORKTREES_DIR?.trim() || '',
    valuaWorktreesDir: process.env.VALUA_AGENT_WORKTREES_DIR?.trim() || '',
  });
  const worktreesDir = agenticWorktreesDir;

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

  let workdir =
    resolveConfiguredAgentWorkdir(agentCfg.workdir, {
      repoRoot,
      worktreesDir,
      agenticWorktreesDir,
      valuaWorktreesDir,
    }) || repoRoot;
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

  const globalMaxInflightRaw = (
    process.env.AGENTIC_CODEX_GLOBAL_MAX_INFLIGHT ||
    process.env.VALUA_CODEX_GLOBAL_MAX_INFLIGHT ||
    ''
  ).trim();
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
      if (isAutopilot) {
        try {
          await flushPendingAutopilotBlockedRecoveries({ busRoot, agentName });
        } catch (err) {
          writePane(
            `[worker] ${agentName} recovery warn: failed to flush pending blocked recovery state: ${(err && err.message) || String(err)}\n`,
          );
        }
      }
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
      let taskCwd = workdir || repoRoot;
      let taskStartHead = safeExecText('git', ['rev-parse', 'HEAD'], { cwd: taskCwd }) || '';
      let skillOpsPromotionTask = null;
      let releaseSkillOpsPromotionLock = null;
      /** @type {any} */
      let lastGitPreflight = null;
      let lastPreflightCleanArtifactPath = null;
      let lastStaleWorkerReclaim = null;
      let buildCurrentGitReceipt = () => null;
      let runtimeSkillProfile = 'default';
      let runtimeExecSkillSelected = false;
      /** @type {string[]} */
      let runtimeSkillsSelected = [];
      let reviewFixFreshnessEvidence = null;
      let runtimeSessionScope = 'task';
      let runtimeSessionRotated = false;
      let runtimeSessionRotationReason = '';
      let runtimeBranchContinuityGate = { status: 'pass', errors: [], applied: [] };
      const proactiveStatusSeen = new Set();
      let codeQualityRetryCount = 0;
      const gateRetryConsumption = {
        review: 0,
        decomposition: 0,
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
      const opusConsultTranscript = { preExec: null, postReview: null };
      let controllerHousekeepingStage = null;
      let skipAutopilotRecoveryPlan = false;
      let lastParsedAutopilotControl = normalizeAutopilotControl(null);
      let lastParsedFollowUps = [];
      let lastSourceDelta = null;
      let runtimePreflightRequired = false;
      let seededPreflightPlanFromSession = null;
      let seededPreflightPlanHashFromSession = '';
      let seededPreflightTaskFingerprintFromSession = '';
      let seededPreflightTrackedSnapshotFromSession = null;
      let approvedPreflightPlan = null;
      let approvedPreflightPlanHash = '';
      let approvedPreflightTaskFingerprint = '';
      let approvedPreflightTrackedSnapshot = null;
      let preflightBaseHead = '';
      let preflightWorkBranch = '';
      let preflightRetryReason = '';
      let preflightGateEvidence = { required: false, approved: false, noWritePass: null, planHash: null, driftDetected: false, reasonCode: null };
      let preflightClosureBlocked = false;

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
        const taskSessionPreflight =
          taskSession?.payload?.preflight && typeof taskSession.payload.preflight === 'object'
            ? taskSession.payload.preflight
            : null;
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
        seededPreflightPlanFromSession = taskSessionPreflight?.approvedPlan && typeof taskSessionPreflight.approvedPlan === 'object'
          ? normalizePreflightPlan(taskSessionPreflight.approvedPlan)
          : null;
        seededPreflightPlanHashFromSession = readStringField(taskSessionPreflight?.planHash);
        seededPreflightTaskFingerprintFromSession = readStringField(taskSessionPreflight?.taskFingerprint);
        seededPreflightTrackedSnapshotFromSession = normalizePersistedTrackedSnapshot(taskSessionPreflight?.trackedSnapshot);
        approvedPreflightPlanHash = ''; approvedPreflightTaskFingerprint = ''; approvedPreflightTrackedSnapshot = null;
        let promptBootstrap = warmStartEnabled ? await readPromptBootstrap({ busRoot, agentName }) : null; let parsedOutput = null;
        let reviewRetryReason = '';
        let decompositionRetryReason = ''; let codeQualityRetryReasonCode = ''; let codeQualityRetryReason = '';
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
            taskCwd = workdir || repoRoot;
            taskStartHead = safeExecText('git', ['rev-parse', 'HEAD'], { cwd: taskCwd }) || '';
            if (isSkillOpsPromotionTask(opened.meta)) {
              if (!skillOpsPromotionTask) {
                const preparedSkillOpsPromotionTask = await prepareClaimedSkillOpsPromotionTask({
                  busRoot,
                  agentName,
                  openedMeta: opened.meta,
                  sourceTaskCwd: workdir || repoRoot,
                  worktreesDir,
                });
                skillOpsPromotionTask = preparedSkillOpsPromotionTask;
                releaseSkillOpsPromotionLock = preparedSkillOpsPromotionTask.releaseLock;
              }
              taskCwd = skillOpsPromotionTask.taskCwd;
              taskStartHead = safeExecText('git', ['rev-parse', 'HEAD'], { cwd: taskCwd }) || '';
            }
            if (isControllerHousekeepingTask(opened.meta)) {
              const housekeepingResult = await runControllerHousekeepingTask({
                busRoot,
                agentName,
                openedMeta: opened.meta,
                taskCwd,
                repoRoot,
                worktreesDir,
                agenticWorktreesDir,
                valuaWorktreesDir,
              });
              outcome = housekeepingResult.outcome;
              note = housekeepingResult.note;
              receiptExtra = {
                ...defaultReceiptExtra,
                ...(isPlainObject(housekeepingResult.receiptExtra) ? housekeepingResult.receiptExtra : {}),
              };
              await deleteTaskSession({ busRoot, agentName, taskId: id });
              if (housekeepingResult.cleanupSyntheticRootId) {
                receiptExtra.controllerHousekeepingCleanupRootId = housekeepingResult.cleanupSyntheticRootId;
              }
              break taskRunLoop;
            }
            const isSmokeNow = Boolean(opened.meta?.signals?.smoke);
            const reviewFixFreshness = await evaluateReviewFixFreshness({
              taskMeta: opened?.meta,
              cwd: taskCwd,
            });
            if (reviewFixFreshness.status === 'stale') {
              outcome = 'skipped';
              note = appendReasonNote(
                `review-fix source superseded: ${reviewFixFreshness.staleCause || 'stale_source'}`,
                'review_fix_source_superseded',
              );
              receiptExtra = {
                ...defaultReceiptExtra,
                reasonCode: reviewFixFreshness.reasonCode || 'review_fix_source_superseded',
                skippedReason: reviewFixFreshness.reasonCode || 'review_fix_source_superseded',
                runtimeGuard: {
                  reviewFixFreshness: reviewFixFreshness.evidence,
                },
              };
              await deleteTaskSession({ busRoot, agentName, taskId: id });
              break taskRunLoop;
            }
            reviewFixFreshnessEvidence =
              reviewFixFreshness.status === 'warning' || reviewFixFreshness.status === 'fresh'
                ? reviewFixFreshness.evidence
                : null;
            const userRequestedReviewGate = inferUserRequestedReviewGate({
              taskKind: taskKindNow,
              taskMeta: opened.meta,
              taskMarkdown: opened.markdown,
              cwd: taskCwd,
            });
            let reviewGateNow = deriveReviewGate({
              isAutopilot,
              taskKind: taskKindNow,
              taskMeta: opened.meta,
              userRequestedReview: userRequestedReviewGate.requested,
              userRequestedReviewTargetCommitSha: userRequestedReviewGate.targetCommitSha,
              userRequestedReviewTargetCommitShas: userRequestedReviewGate.targetCommitShas,
              userRequestedReviewResolutionError: userRequestedReviewGate.resolutionError,
            });
            if (isAutopilot && selfReviewRetryCommitSha) {
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
            const decompositionGateNow = deriveAutopilotDecompositionGate({
              isAutopilot,
              taskKind: taskKindNow,
              taskMeta: opened?.meta,
              taskBody: opened?.body,
              env: process.env,
            });
            const opusGateNow = deriveOpusConsultGate({
              isAutopilot,
              taskKind: taskKindNow,
              roster,
              env: process.env,
            });
            runtimePreflightRequired = shouldRequireWriterPreflight({
              isAutopilot,
              taskKind: taskKindNow,
              taskMeta: opened.meta,
            });
            const preExecConsultNeedsApprovedPreflight = Boolean(
              opusGateNow.preExecRequired && runtimePreflightRequired,
            );

            if (opusGateNow.preExecRequired && !preExecConsultNeedsApprovedPreflight) {
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
            } else if (preExecConsultNeedsApprovedPreflight) {
              opusConsultBarrier = {
                locked: false,
                consultId: '',
                roundsUsed: 0,
                unlockReason: 'awaiting_approved_preflight',
              };
              opusGateEvidence = {
                enabled: true,
                required: true,
                phase: 'pre_exec',
                consultAgent: opusGateNow.consultAgent || null,
                consultMode: readStringField(opusGateNow?.consultMode) || 'advisory',
                protocolMode: readStringField(opusGateNow?.protocolMode) || 'freeform_only',
                status: 'pending_preflight',
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
            const incomingRootId = readStringField(opened?.meta?.signals?.rootId);
            const skillOpsPromotionStateDir = getSkillOpsPromotionStateDir({ busRoot, agentName });
            let deferredGitPreflightBlockedError = null;
            let deferredGitPreflightRuntimeError = null;
            let pendingRootFocus = null;
            let pendingStaleWorkerReclaim = null;
            let pendingStaleWorkerReclaimMessage = '';
            buildCurrentGitReceipt = () =>
              maybeBuildReceiptGitExtra({
                cwd: taskCwd,
                preflight: lastGitPreflight,
                preflightCleanArtifactPath: lastPreflightCleanArtifactPath,
                staleWorkerReclaim: lastStaleWorkerReclaim,
              }) ||
              buildReceiptGitExtra({
                cwd: taskCwd,
                preflight: lastGitPreflight,
                preflightCleanArtifactPath: lastPreflightCleanArtifactPath,
                staleWorkerReclaim: lastStaleWorkerReclaim,
              });
            try {
              const focusState = await readAgentRootFocus({ busRoot, agentName });
              let focusedRootId = readStringField(focusState?.rootId);
              let focusedBranch = readStringField(focusState?.branch);
              let crossRootReviewFixAllowed = false;
              const dirtySnapshot = getGitSnapshot({ cwd: taskCwd });
              const { dirtyClassification } = classifyControllerDirtySnapshot({
                busRoot,
                cwd: taskCwd,
                agentName,
                snapshot: dirtySnapshot,
                autoCleanRuntimeArtifacts: true,
              });
              const blockingDirtyStatus = dirtyClassification.blockingStatusPorcelain;
              if (
                incomingRootId &&
                focusedRootId &&
                focusedRootId !== incomingRootId &&
                Boolean(blockingDirtyStatus)
              ) {
                const reviewFixContinuation = shouldAllowAutopilotDirtyCrossRootReviewFix({
                  isAutopilot,
                  taskKind: taskKindNow,
                  taskMeta: opened?.meta,
                  cwd: taskCwd,
                  incomingRootId,
                  currentHeadSha: dirtySnapshot?.headSha,
                });
                if (reviewFixContinuation) {
                  crossRootReviewFixAllowed = true;
                  writePane(
                    `[worker] ${agentName} cross-root warning: continuing on incoming PR${reviewFixContinuation.prNumber} head ${reviewFixContinuation.prHeadSha.slice(0, 7)} despite stale root focus ${focusedRootId}\n`,
                  );
                  pendingRootFocus = {
                    rootId: incomingRootId,
                    branch: readStringField(dirtySnapshot?.branch) || '',
                  };
                  focusedRootId = incomingRootId;
                  focusedBranch = readStringField(dirtySnapshot?.branch) || '';
                } else {
                  const reclaimed = attemptStaleWorkerWorktreeReclaim({
                    cwd: taskCwd,
                    busRoot,
                    agentName,
                    currentTaskId: id,
                    incomingRootId,
                    previousRootId: focusedRootId,
                    previousFocusBranch: focusedBranch,
                    contract: gitContract,
                    reasonCode: 'dirty_cross_root_transition',
                    skillOpsPromotionStateDir,
                  });
                  if (reclaimed.reclaimed) {
                    pendingStaleWorkerReclaim = reclaimed;
                    lastStaleWorkerReclaim = reclaimed;
                    pendingStaleWorkerReclaimMessage = `[worker] ${agentName} reclaimed stale worktree dirt from root ${focusedRootId} before switching to ${incomingRootId}\n`;
                  } else {
                    throw new TaskGitPreflightBlockedError(
                      'dirty cross-root transition: worktree has uncommitted changes from another root',
                      {
                        cwd: taskCwd,
                        taskKind: taskKindNow,
                        contract: gitContract,
                        details: {
                          reasonCode: 'dirty_cross_root_transition',
                          previousRootId: focusedRootId,
                          incomingRootId,
                          statusPorcelain: blockingDirtyStatus.slice(0, 2000),
                          controllerDirtyClassification: dirtyClassification.classification,
                          fingerprint: dirtyClassification.fingerprint,
                          staleWorkerReclaim: {
                            attempted: true,
                            reason: reclaimed.reason,
                            recordedFocusBranch: reclaimed.recordedFocusBranch || null,
                            otherOpenTaskIds: reclaimed.otherOpenTaskIds || [],
                            controllerDirtyClassification: reclaimed.controllerDirtyClassification || null,
                            pendingSkillOpsLogPaths: reclaimed.pendingSkillOpsLogPaths || [],
                            recoverableTrackedPaths: reclaimed.recoverableTrackedPaths || [],
                          },
                        },
                      },
                    );
                  }
                }
              }
              lastGitPreflight = null;
              try {
                lastGitPreflight = ensureTaskGitContract({
                  cwd: taskCwd,
                  taskKind: taskKindNow,
                  contract: gitContract,
                  enforce: enforceTaskGitRef,
                  allowFetch: allowTaskGitFetch,
                  autoCleanDirtyExecute: autoCleanDirtyExecuteWorktree,
                  log: writePane,
                  skillOpsPromotionStateDir,
                });
              } catch (err) {
                if (
                  !crossRootReviewFixAllowed &&
                  err instanceof TaskGitPreflightBlockedError &&
                  err.code === 'dirty_worktree_sync_refused'
                ) {
                  const reclaimed = attemptStaleWorkerWorktreeReclaim({
                    cwd: taskCwd,
                    busRoot,
                    agentName,
                    currentTaskId: id,
                    incomingRootId,
                    previousRootId: focusedRootId,
                    previousFocusBranch: focusedBranch,
                    contract: gitContract,
                    reasonCode: 'stale_worker_worktree_reclaim',
                    skillOpsPromotionStateDir,
                  });
                  if (reclaimed.reclaimed) {
                    pendingStaleWorkerReclaim = reclaimed;
                    lastStaleWorkerReclaim = reclaimed;
                    pendingStaleWorkerReclaimMessage =
                      `[worker] ${agentName} reclaimed stale worker worktree ${reclaimed.currentBranch || '(unknown)'} before syncing ${readStringField(gitContract?.workBranch) || '(none)'}\n`;
                    lastGitPreflight = ensureTaskGitContract({
                      cwd: taskCwd,
                      taskKind: taskKindNow,
                      contract: gitContract,
                      enforce: enforceTaskGitRef,
                      allowFetch: allowTaskGitFetch,
                      autoCleanDirtyExecute: autoCleanDirtyExecuteWorktree,
                      log: writePane,
                      skillOpsPromotionStateDir,
                    });
                  } else {
                    err.details = {
                      ...(isPlainObject(err.details) ? err.details : {}),
                      staleWorkerReclaim: {
                        attempted: true,
                        reason: reclaimed.reason,
                        recordedFocusBranch: reclaimed.recordedFocusBranch || null,
                        otherOpenTaskIds: reclaimed.otherOpenTaskIds || [],
                        controllerDirtyClassification: reclaimed.controllerDirtyClassification || null,
                        pendingSkillOpsLogPaths: reclaimed.pendingSkillOpsLogPaths || [],
                        recoverableTrackedPaths: reclaimed.recoverableTrackedPaths || [],
                      },
                    };
                    throw err;
                  }
                } else {
                  throw err;
                }
              }
              if (!pendingRootFocus && pendingStaleWorkerReclaim?.reclaimed && incomingRootId) {
                const syncedSnapshot = getGitSnapshot({ cwd: taskCwd });
                pendingRootFocus = {
                  rootId: incomingRootId,
                  branch: readStringField(syncedSnapshot?.branch) || readStringField(gitContract?.workBranch) || '',
                };
              }
            } catch (err) {
              if (err instanceof TaskGitPreflightBlockedError) {
                deferredGitPreflightBlockedError = err;
              } else {
                deferredGitPreflightRuntimeError = err;
              }
            }
            if (pendingRootFocus?.rootId) {
              await writeAgentRootFocus({
                busRoot,
                agentName,
                rootId: pendingRootFocus.rootId,
                branch: pendingRootFocus.branch || '',
              });
            }
            if (pendingStaleWorkerReclaim?.reclaimed) {
              if (pendingStaleWorkerReclaimMessage) {
                writePane(pendingStaleWorkerReclaimMessage);
              }
            }
            if (lastGitPreflight?.autoCleaned) {
              const cleanArtifact = await materializePreflightCleanArtifact({
                busRoot,
                agentName,
                taskId: id,
                taskMeta: opened?.meta,
                preflight: lastGitPreflight,
              });
              if (!lastPreflightCleanArtifactPath && cleanArtifact?.relativePath) {
                lastPreflightCleanArtifactPath = cleanArtifact.relativePath;
              }
            }
            if (deferredGitPreflightBlockedError) {
              throw deferredGitPreflightBlockedError;
            }
            if (deferredGitPreflightRuntimeError) {
              throw createTaskGitPreflightRuntimeError({
                error: deferredGitPreflightRuntimeError,
                cwd: taskCwd,
                taskKind: taskKindNow,
                contract: gitContract,
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
            const taskStat = await fs.stat(opened.path);

            preflightBaseHead =
              readStringField(gitContract?.baseSha) || readStringField(taskStartHead);
            preflightWorkBranch = readStringField(gitContract?.workBranch);
            const hydratedPreflight = await hydrateApprovedPreflightForTask({
              repoRoot: taskCwd,
              runtimePreflightRequired,
              seededApprovedPlan: seededPreflightPlanFromSession,
              seededPlanHash: seededPreflightPlanHashFromSession,
              seededTaskFingerprint: seededPreflightTaskFingerprintFromSession,
              seededTrackedSnapshot: seededPreflightTrackedSnapshotFromSession,
              approvedPlan: approvedPreflightPlan,
              approvedPlanHash: approvedPreflightPlanHash,
              approvedTaskFingerprint: approvedPreflightTaskFingerprint,
              approvedTrackedSnapshot: approvedPreflightTrackedSnapshot,
              taskKind: taskKindNow,
              taskPhase: opened?.meta?.signals?.phase,
              taskTitle: opened?.meta?.title,
              taskBody: opened.markdown,
              taskMeta: opened?.meta,
              baseHead: preflightBaseHead,
              workBranch: preflightWorkBranch,
            });
            approvedPreflightPlan = hydratedPreflight.approvedPlan;
            approvedPreflightPlanHash = hydratedPreflight.approvedPlanHash;
            approvedPreflightTaskFingerprint = hydratedPreflight.approvedTaskFingerprint;
            approvedPreflightTrackedSnapshot = hydratedPreflight.approvedTrackedSnapshot;
            preflightGateEvidence = hydratedPreflight.gateEvidence || preflightGateEvidence;
            if (hydratedPreflight.retryReason) preflightRetryReason = hydratedPreflight.retryReason;
            if (runtimePreflightRequired && !approvedPreflightPlan) {
              const preflightPhase = await runWriterPreflightPhase({
                fs,
                outputPath,
                agentName,
                taskId: id,
                taskCwd,
                repoRoot,
                schemaPath,
                codexBin,
                guardEnv,
                codexHomeEnv,
                autopilotDangerFullAccess,
                openedPath: opened.path,
                openedMeta: opened.meta,
                taskMarkdown: opened.markdown,
                taskStatMtimeMs: taskStat.mtimeMs,
                taskKindNow,
                taskPhase: opened?.meta?.signals?.phase,
                taskTitle: opened?.meta?.title,
                preflightBaseHead,
                preflightWorkBranch,
                isAutopilot,
                skillsSelected,
                includeSkills,
                contextBlock: combinedContextBlock,
                preflightRetryReason,
                seedPlan: seededPreflightPlanFromSession,
                resumeSessionId,
                lastCodexThreadId,
                busRoot,
                roster,
                writePane,
                runCodexAppServer,
                writeTaskSession,
                firstPreflightReasonCode,
                createTurnError: (message, details) => new CodexTurnError(message, details),
              });
              approvedPreflightPlan = preflightPhase.approvedPlan;
              approvedPreflightPlanHash = preflightPhase.approvedPlanHash;
              approvedPreflightTaskFingerprint = preflightPhase.approvedTaskFingerprint;
              approvedPreflightTrackedSnapshot = preflightPhase.approvedTrackedSnapshot;
              preflightRetryReason = preflightPhase.preflightRetryReason;
              preflightGateEvidence = preflightPhase.preflightGateEvidence;
              resumeSessionId = preflightPhase.resumeSessionId;
              lastCodexThreadId = preflightPhase.lastCodexThreadId;
            }

            if (preExecConsultNeedsApprovedPreflight) {
              const preExecConsultPhase = await runApprovedPreExecConsultPhase({
                approvedPlan: approvedPreflightPlan,
                approvedPlanHash: approvedPreflightPlanHash,
                preExecConsultCached,
                gate: opusGateNow,
                busRoot,
                roster,
                agentName,
                openedMeta: opened.meta,
                taskMarkdown: opened.markdown,
                taskKind: taskKindNow,
                existingConsultAdvice: opusConsultAdvice,
                runOpusConsultPhase,
                runWriterPreflightPhase,
                writerPreflightArgs: {
                  fs,
                  outputPath,
                  agentName,
                  taskId: id,
                  taskCwd,
                  repoRoot,
                  schemaPath,
                  codexBin,
                  guardEnv,
                  codexHomeEnv,
                  autopilotDangerFullAccess,
                  openedPath: opened.path,
                  openedMeta: opened.meta,
                  taskMarkdown: opened.markdown,
                  taskStatMtimeMs: taskStat.mtimeMs,
                  taskKindNow,
                  taskPhase: opened?.meta?.signals?.phase,
                  taskTitle: opened?.meta?.title,
                  preflightBaseHead,
                  preflightWorkBranch,
                  isAutopilot,
                  skillsSelected,
                  includeSkills,
                  contextBlock: combinedContextBlock,
                  preflightRetryReason,
                  resumeSessionId,
                  lastCodexThreadId,
                  busRoot,
                  roster,
                  writePane,
                  runCodexAppServer,
                  writeTaskSession,
                  firstPreflightReasonCode,
                  preflightGateEvidence,
                  createTurnError: (message, details) => new CodexTurnError(message, details),
                },
              });
              preExecConsultCached = preExecConsultPhase.phaseResult;
              approvedPreflightPlan = preExecConsultPhase.approvedPlan;
              approvedPreflightPlanHash = preExecConsultPhase.approvedPlanHash;
              preflightRetryReason = preExecConsultPhase.preflightRetryReason;
              preflightGateEvidence = preExecConsultPhase.preflightGateEvidence;
              resumeSessionId = preExecConsultPhase.resumeSessionId;
              lastCodexThreadId = preExecConsultPhase.lastCodexThreadId;
              opusConsultBarrier = preExecConsultPhase.barrier;
              opusConsultTranscript.preExec = preExecConsultPhase.transcript;
              opusGateEvidence = preExecConsultPhase.gateEvidence;
              opusDecisionEvidence = {
                preExec: preExecConsultPhase.preExecDecision,
                postReview: null,
              };
              opusConsultAdvice = preExecConsultPhase.consultAdvice;
            }

            const prompt = buildPrompt({
              agentName,
              skillsSelected,
              includeSkills,
              taskKind: taskKindNow,
              isSmoke: isSmokeNow,
              isAutopilot,
              preflightRequired: runtimePreflightRequired,
              approvedPreflightPlan,
              approvedPreflightPlanHash,
              reviewGate: reviewGateNow,
              reviewRetryReason,
              decompositionRetryReason,
              codeQualityRetryReasonCode,
              codeQualityRetryReason,
              skillOpsGate: skillOpsGateNow,
              codeQualityGate: codeQualityGateNow,
              observerDrainGate: observerDrainGateNow,
              decompositionGate: decompositionGateNow,
              opusConsultAdvice,
              requireOpusDisposition:
                Boolean(isAutopilot && runtimePreflightRequired) &&
                Array.isArray(opusConsultAdvice?.preExec?.items) &&
                opusConsultAdvice.preExec.items.length > 0,
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
            writePane(
              `[worker] ${agentName} codex app-server attempt=${attempt}${resumeSessionId ? ` resume=${resumeSessionId}` : ''}\n`,
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

            const res = await runCodexAppServer({
              codexBin,
              repoRoot,
              workdir: taskCwd,
              schemaPath,
              outputPath,
              prompt,
              watchFilePath: opened.path,
              watchFileMtimeMs: taskStat.mtimeMs,
              resumeSessionId,
              reviewGate: reviewGateNow.required ? reviewGateNow : null,
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
              throw new CodexTurnError(`codex output parse failed: ${(err && err.message) || String(err)}`, {
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
              throw new CodexTurnError(`review gate validation failed: ${reason}`, {
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
            if (err instanceof CodexTurnSupersededError) {
              preExecConsultCached = null;
              if (!resumeSessionId && err.threadId) {
                resumeSessionId = err.threadId;
                lastCodexThreadId = err.threadId;
                await writeTaskSession({ busRoot, agentName, taskId: id, threadId: err.threadId });
              }
              writePane(`[worker] ${agentName} task updated; restarting codex app-server turn\n`);
              continue;
            }

            if (err instanceof CodexTurnError) {
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
                    `codex app-server hit a transient rate limit / stream disconnect.\n\n` +
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
        const userRequestedReviewGateForValidation = inferUserRequestedReviewGate({
          taskKind: opened?.meta?.signals?.kind ?? taskKind,
          taskMeta: opened?.meta,
          taskMarkdown: opened?.markdown || '',
          cwd: taskCwd,
        });
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
        const decompositionGate = deriveAutopilotDecompositionGate({
          isAutopilot,
          taskKind: opened?.meta?.signals?.kind ?? taskKind,
          taskMeta: opened?.meta,
          taskBody: opened?.body,
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
        lastParsedAutopilotControl = parsedAutopilotControl;
        const postMergeResyncTrigger = classifyPostMergeResyncTrigger({
          taskTitle: opened?.meta?.title,
          taskBody: opened?.markdown,
          note,
          commitSha,
        });
        lastSourceDelta = null;
        try {
          lastSourceDelta = computeSourceDeltaSummary({ cwd: taskCwd, commitSha });
        } catch (err) {
          if (err?.reasonCode !== 'source_delta_commit_unavailable') throw err;
          lastSourceDelta = {
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
        const sourceDelta = lastSourceDelta;
        if (runtimePreflightRequired && approvedPreflightPlan) {
          const closureResult = await finalizePreflightClosureGate({
            repoRoot: taskCwd,
            approvedPlan: approvedPreflightPlan,
            outputPreflightPlan: parsed.preflightPlan,
            sourceDelta,
            commitSha,
            isCommitObjectMissingError,
            unreadableFileLineCount: UNREADABLE_FILE_LINE_COUNT,
            baseRef: preflightBaseHead,
            gateEvidence: preflightGateEvidence,
            outcome,
          });
          preflightGateEvidence = closureResult.gateEvidence;
          parsed.runtimeGuard = {
            ...(parsed.runtimeGuard && typeof parsed.runtimeGuard === 'object' ? parsed.runtimeGuard : {}),
            preflightGate: preflightGateEvidence,
          };
          if (closureResult.noteReason) {
            note = appendReasonNote(note, closureResult.noteReason);
          }
          if (closureResult.blocked) {
            preflightClosureBlocked = true;
            outcome = 'blocked';
            note = appendReasonNote(note, `writer preflight closure failed: ${closureResult.blockDetail}`);
          }
        }
        if (isSkillOpsPromotionTask(opened.meta) && outcome === 'done') {
          const promotionPlanPath =
            readStringField(opened?.meta?.references?.skillopsPromotion?.planPath) ||
            readStringField(skillOpsPromotionTask?.planPath);
          let durableTargets = [];
          const normalizedPlan = await readNormalizedSkillOpsPromotionPlanFile(
            promotionPlanPath,
            'skillops_promotion_legacy_state',
          );
          if (!normalizedPlan.ok) {
            const blockedPromotion = blockSkillOpsPromotionDone({
              parsed,
              note,
              detail: normalizedPlan.detail,
            });
            outcome = blockedPromotion.outcome;
            note = blockedPromotion.note;
          } else {
            durableTargets = normalizedPlan.plan.targetPaths;
          }
          if (outcome === 'done') {
            const durableTargetSet = new Set(durableTargets);
            const changedFiles = Array.isArray(sourceDelta?.changedFiles)
              ? sourceDelta.changedFiles.map((value) => normalizeRepoPath(value)).filter(Boolean)
              : [];
            const invalidChangedFile = changedFiles.find((file) => {
              if (file.startsWith('.codex/skill-ops/logs/')) return true;
              if (file.startsWith('.codex/quality/')) return true;
              return !durableTargetSet.has(file);
            });
            if (!commitSha || invalidChangedFile) {
              const blockedPromotion = blockSkillOpsPromotionDone({
                parsed,
                note,
                detail: !commitSha
                  ? 'skillops promotion done output is missing commitSha'
                  : `skillops promotion changed invalid target ${invalidChangedFile}`,
                durableTargets,
                changedFiles,
              });
              outcome = blockedPromotion.outcome;
              note = blockedPromotion.note;
            }
          }
          if (outcome === 'done') {
            const promotionRootId =
              readStringField(opened?.meta?.signals?.rootId) || readStringField(opened?.meta?.id);
            const finalizedSkillOpsPromotion = await finalizeSuccessfulSkillOpsPromotionTask({
              busRoot,
              agentName,
              rootId: promotionRootId,
              promotionTask: skillOpsPromotionTask || {
                sourceWorkdir: readStringField(opened?.meta?.references?.skillopsPromotion?.sourceWorkdir),
                curationWorkdir: taskCwd,
                planPath: promotionPlanPath,
                branch: readStringField(opened?.meta?.references?.git?.workBranch),
                baseRef: readStringField(opened?.meta?.references?.git?.baseBranch),
              },
              commitSha,
            });
            setSkillOpsPromotionRuntimeGuard(
              parsed,
              finalizedSkillOpsPromotion.ok
                ? {
                    status: 'done',
                    prNumber: finalizedSkillOpsPromotion.verification?.prNumber ?? null,
                    prUrl: finalizedSkillOpsPromotion.verification?.prUrl ?? null,
                    remoteCommitSha: finalizedSkillOpsPromotion.verification?.remoteCommitSha ?? null,
                  }
                : {
                    status: 'needs_review',
                    reasonCode: finalizedSkillOpsPromotion.reasonCode,
                    detail: finalizedSkillOpsPromotion.detail,
                  },
            );
            if (!finalizedSkillOpsPromotion.ok) {
              outcome = 'needs_review';
              note = appendReasonNote(note, finalizedSkillOpsPromotion.reasonCode || 'skillops_promotion_needs_review');
              receiptExtra.reasonCode = finalizedSkillOpsPromotion.reasonCode || 'skillops_promotion_needs_review';
            }
          }
        }
        const sourceCodeChanged = sourceDelta.sourceFilesCount > 0;
        const parsedFollowUps = Array.isArray(parsed.followUps) ? parsed.followUps : [];
        lastParsedFollowUps = parsedFollowUps;
        const hasExecuteFollowUp = parsedFollowUps.some(
          (fu) => normalizeTaskKind(fu?.signals?.kind) === 'EXECUTE',
        );
        const preExecAdviceItems = Array.isArray(opusConsultAdvice?.preExec?.items)
          ? opusConsultAdvice.preExec.items
          : [];
        const advisoryOpusItemIds = preExecAdviceItems
          .map((item) => readStringField(item?.id))
          .filter(Boolean);
        const requiresOpusDisposition =
          isAutopilot && runtimePreflightRequired && advisoryOpusItemIds.length > 0;
        const taskPhaseCurrent = readStringField(opened?.meta?.signals?.phase);
        const requiresOpusRationale =
          isAutopilot &&
          advisoryOpusItemIds.length > 0 &&
          (taskPhaseCurrent === 'review-fix' || taskPhaseCurrent === 'blocked-recovery');
        const opusRationale = requiresOpusRationale ? readOpusRationaleLine(note) : '';
        const opusRationaleMissing = requiresOpusRationale && !opusRationale;
        if (opusRationaleMissing) {
          note = appendReasonNote(note, 'opus_advisory_rationale_missing');
        }
        const parsedOpusDispositions = parseOpusDispositionLines(note);
        const dispositionMap = new Map(
          parsedOpusDispositions.entries.map((entry) => [readStringField(entry?.id), entry]),
        );
        const acknowledgedOpusItemIds = advisoryOpusItemIds.filter((idValue) => dispositionMap.has(idValue));
        const missingOpusItemIds = advisoryOpusItemIds.filter((idValue) => !dispositionMap.has(idValue));
        const localCodeExecutionWithoutDispatch = sourceCodeChanged && !hasExecuteFollowUp;
        const delegationJustificationMissingIds =
          requiresOpusDisposition && localCodeExecutionWithoutDispatch
            ? preExecAdviceItems
                .filter((item) => opusAdviceItemSuggestsDelegation(item))
                .map((item) => readStringField(item?.id))
                .filter((itemId) => {
                  const disposition = dispositionMap.get(itemId);
                  return !opusDispositionHasLocalJustification(disposition?.rationale);
                })
            : [];
        parsed.runtimeGuard = {
          ...(parsed.runtimeGuard && typeof parsed.runtimeGuard === 'object' ? parsed.runtimeGuard : {}),
          ...(reviewFixFreshnessEvidence
            ? {
                reviewFixFreshness: reviewFixFreshnessEvidence,
              }
            : {}),
          opusDisposition: {
            consultMode: readStringField(opusConsultAdvice?.mode) || readStringField(opusGate?.consultMode) || null,
            advisoryOnly: !requiresOpusDisposition,
            advisoryItemCount: advisoryOpusItemIds.length,
            advisoryItemIds: advisoryOpusItemIds,
            requiredCount: requiresOpusDisposition ? advisoryOpusItemIds.length : 0,
            requiredIds: requiresOpusDisposition ? advisoryOpusItemIds : [],
            acknowledgedIds: acknowledgedOpusItemIds,
            missingIds: requiresOpusDisposition ? missingOpusItemIds : [],
            parseErrors: parsedOpusDispositions.parseErrors,
            retryCount: 0,
            autoApplied: false,
            rationale: opusRationale || null,
            missingRationale: opusRationaleMissing,
            delegationJustificationMissingIds,
          },
        };
        if (requiresOpusDisposition && outcome === 'done') {
          if (missingOpusItemIds.length > 0) {
            outcome = 'blocked';
            parsed.reasonCode = readStringField(parsed.reasonCode) || 'opus_disposition_missing';
            note = appendReasonNote(note, `opus_disposition_missing:${missingOpusItemIds.join(',')}`);
          } else if (delegationJustificationMissingIds.length > 0) {
            outcome = 'blocked';
            parsed.reasonCode = readStringField(parsed.reasonCode) || 'opus_delegation_disposition_missing';
            note = appendReasonNote(
              note,
              `opus_delegation_disposition_missing:${delegationJustificationMissingIds.join(',')}`,
            );
          }
        }
        const delegatedCompletion = hasDelegatedCompletionEvidence({
          taskMeta: opened?.meta,
          workstream: parsedAutopilotControl.workstream || 'main',
        });
        const normalizedCommitSha = readStringField(commitSha).toLowerCase();
        const reviewedCommits = normalizeReviewedCommitShas(parsed?.review);
        const requestedReviewedCommits =
          readStringField(reviewGate?.scope) === 'pr'
            ? normalizeCommitShaList(Array.isArray(reviewGate?.targetCommitShas) ? reviewGate.targetCommitShas : [])
            : normalizeCommitShaList([readStringField(reviewGate?.targetCommitSha)]);
        const reviewOnlyCoverageSatisfied = normalizedCommitSha
          ? requestedReviewedCommits.includes(normalizedCommitSha) && reviewedCommits.includes(normalizedCommitSha)
          : requestedReviewedCommits.length > 0 &&
            requestedReviewedCommits.every((sha) => reviewedCommits.includes(sha));
        const reviewOnlyCompletion =
          outcome === 'done' &&
          runtimeSkillProfile === 'controller' &&
          Boolean(reviewGate?.required) &&
          parsed?.review?.ran === true &&
          readStringField(parsed?.review?.method) === 'built_in_review' &&
          readStringField(parsed?.review?.verdict) === 'pass' &&
          !parsedAutopilotControl.executionMode &&
          !hasExecuteFollowUp &&
          !delegatedCompletion &&
          reviewOnlyCoverageSatisfied;

        if (taskKindCurrent === 'PLAN_REQUEST') {
          // Plan tasks must not claim commits.
          commitSha = '';
        }

        if (
          isAutopilot &&
          taskKindCurrent === 'USER_REQUEST' &&
          outcome === 'done' &&
          (autopilotDelegateGateEnabled || decompositionGate.required)
        ) {
          let delegationPath = decompositionGate.required ? 'early_decomposition' : 'invalid';
          let delegationStatus = 'pass';
          let delegationReasonCode = '';
          if (!(decompositionGate.required && !hasExecuteFollowUp && !reviewOnlyCompletion)) {
            decompositionRetryReason = '';
          }

          if (decompositionGate.required && !hasExecuteFollowUp && !reviewOnlyCompletion) {
            if (gateAutoremediateRetries > 0 && canConsumeGateRetry('decomposition', 1)) {
              decompositionRetryReason = decompositionGate.reasonCode || 'decomposition_required';
              await maybeEmitAutopilotRootStatus({
                enabled: autopilotProactiveStatusEnabled,
                busRoot,
                roster,
                fromAgent: agentName,
                priority: opened.meta?.priority || 'P2',
                rootId: opened.meta?.signals?.rootId ?? opened.meta?.id ?? null,
                parentId: opened.meta?.id ?? null,
                state: 'retrying',
                phase: 'decomposition',
                reasonCode: decompositionRetryReason,
                nextAction: 'dispatch_execute_followups',
                idempotency: proactiveStatusSeen,
                throttle: statusThrottle,
              });
              writePane(`[worker] ${agentName} decomposition retry 1/1: ${decompositionRetryReason}\n`);
              parsedOutput = null;
              continue taskRunLoop;
            }
            outcome = 'blocked';
            delegationStatus = 'blocked';
            delegationPath = 'early_decomposition';
            delegationReasonCode = 'decomposition_required';
            note = appendReasonNote(note, delegationReasonCode);
          } else if (autopilotDelegateGateEnabled && sourceCodeChanged) {
            if (reviewOnlyCompletion) {
              delegationPath = 'review_only';
            } else if (parsedAutopilotControl.executionMode !== 'tiny_fixup') {
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
          } else if (autopilotDelegateGateEnabled && hasExecuteFollowUp && !delegatedCompletion) {
            outcome = 'needs_review';
            delegationStatus = 'needs_review';
            delegationPath = 'delegate_pending';
            delegationReasonCode = 'delegated_completion_missing';
            note = appendReasonNote(note, delegationReasonCode);
          } else if (autopilotDelegateGateEnabled && hasExecuteFollowUp && delegatedCompletion) {
            delegationPath = 'delegate_complete';
          } else if (decompositionGate.required) {
            delegationPath = reviewOnlyCompletion
              ? 'review_only'
              : hasExecuteFollowUp
                ? 'delegate_complete'
                : 'no_code_change';
          } else if (autopilotDelegateGateEnabled) {
            delegationPath = 'no_code_change';
          } else {
            delegationPath = 'delegate_gate_disabled';
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
              decompositionRequired: decompositionGate.required,
              decompositionReasonCode: decompositionGate.reasonCode || null,
              workstream: parsedAutopilotControl.workstream || 'main',
            },
          };
        }

        if (isAutopilot && taskKindCurrent === 'USER_REQUEST' && outcome === 'done' && commitSha && sourceCodeChanged) {
          const reviewPrimedForCommit = runtimeReviewPrimedFor === commitSha;
          let selfReviewGate = { status: 'pass', reasonCode: null };
          if (reviewOnlyCompletion) {
            selfReviewGate = { status: 'pass', reasonCode: null };
          } else if (parsedAutopilotControl.executionMode !== 'tiny_fixup') {
            outcome = 'blocked';
            selfReviewGate = { status: 'blocked', reasonCode: 'delegate_required' };
            note = appendReasonNote(note, 'delegate_required');
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
              effectiveMode: 'app-server',
              pass: true,
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
          const skipCodeQualityForReviewOnly =
            outcome === 'done' && reviewOnlyCompletion;
          const codeQualitySkippedReason = skipCodeQualityForReviewOnly
            ? 'review_only'
            : `outcome_${String(outcome || '').toLowerCase() || 'unknown'}`;
          const codeQualityValidation =
            outcome === 'done' && !skipCodeQualityForReviewOnly
              ? await workerCodeQuality.runCodeQualityGateCheck({
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
                    skippedReason: codeQualitySkippedReason,
                  },
                };
          const qualityReviewValidation =
            outcome === 'done' && !skipCodeQualityForReviewOnly
              ? workerCodeQuality.validateCodeQualityReviewEvidence({ parsed, codeQualityGate })
              : {
                  ok: true,
                  errors: [],
                  evidence: {
                    required: true,
                    present: false,
                    summary: '',
                    legacyDebtWarnings: null,
                    hardRuleChecks: Object.fromEntries(
                      workerCodeQualityState.CODE_QUALITY_HARD_RULE_KEYS.map((key) => [key, false]),
                    ),
                    skippedReason: codeQualitySkippedReason,
                  },
                };
          const combinedCodeQualityErrors = [
            ...(codeQualityValidation.ok ? [] : codeQualityValidation.errors),
            ...(qualityReviewValidation.ok ? [] : qualityReviewValidation.errors),
          ];
          const qualityReasonCodes = workerCodeQualityState.mapCodeQualityReasonCodes(combinedCodeQualityErrors);
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
            const recoverableReason = qualityReasonCodes.find((code) => workerCodeQualityState.isRecoverableQualityReason(code));
            const retrySignature = workerCodeQualityState.buildCodeQualityRetrySignature({
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
            effectiveMode: 'app-server',
            pass: true,
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
              decomposition: gateRetryConsumption.decomposition || 0,
              code_quality: gateRetryConsumption.code_quality || 0,
              consult_ack: gateRetryConsumption.consult_ack || 0,
            },
          },
          opusConsultBarrier:
            (isPlainObject(opusConsultBarrier) ? opusConsultBarrier : null) ||
            previousRuntimeGuard.opusConsultBarrier ||
            null,
          preflightGate: runtimePreflightRequired ? preflightGateEvidence : null,
        };

        const gitExtra = buildCurrentGitReceipt();
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
        if (preflightClosureBlocked) {
          dispatchableFollowUps = [];
        }
        if (isAutopilot && opusConsultBarrier?.locked) {
          dispatchableFollowUps = [];
        }
        if (!preflightClosureBlocked && outcome === 'blocked' && !isAutopilot) {
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
            preflightClosureBlocked
              ? 'preflight_closure_failed'
              : isAutopilot && opusConsultBarrier?.locked
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
                agenticWorktreesDir,
                valuaWorktreesDir,
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

        if (
          isAutopilot &&
          skillOpsGate.required &&
          !isSkillOpsPromotionTask(opened.meta) &&
          outcome === 'done'
        ) {
          const skillOpsPromotion = await planSkillOpsPromotionHandoff({
            busRoot,
            agentName,
            openedMeta: opened.meta,
            taskCwd,
            worktreesDir,
          });
          parsed.runtimeGuard = {
            ...(parsed.runtimeGuard && typeof parsed.runtimeGuard === 'object' ? parsed.runtimeGuard : {}),
            skillOpsPromotion: skillOpsPromotion.ok
              ? skillOpsPromotion.runtimeGuard
              : {
                  status: 'needs_review',
                  reasonCode: skillOpsPromotion.reasonCode,
                  detail: skillOpsPromotion.detail,
                },
          };
          receiptExtra.runtimeGuard = parsed.runtimeGuard;
          if (skillOpsPromotion.ok) {
            if (skillOpsPromotion.planPath) receiptExtra.skillOpsPromotionPlanPath = skillOpsPromotion.planPath;
            if (skillOpsPromotion.statePath) receiptExtra.skillOpsPromotionStatePath = skillOpsPromotion.statePath;
            if (skillOpsPromotion.promotionTaskId) receiptExtra.skillOpsPromotionTaskId = skillOpsPromotion.promotionTaskId;
          } else {
            outcome = 'needs_review';
            note = appendReasonNote(note, skillOpsPromotion.reasonCode || 'skillops_promotion_handoff_failed');
            receiptExtra.reasonCode = skillOpsPromotion.reasonCode || 'skillops_promotion_handoff_failed';
            receiptExtra.details = {
              ...(isPlainObject(receiptExtra.details) ? receiptExtra.details : {}),
              skillOpsPromotion: {
                reasonCode: skillOpsPromotion.reasonCode || 'skillops_promotion_handoff_failed',
                detail: skillOpsPromotion.detail || '',
              },
            };
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
                decomposition: gateRetryConsumption.decomposition || 0,
                code_quality: gateRetryConsumption.code_quality || 0,
                consult_ack: gateRetryConsumption.consult_ack || 0,
              },
            },
            details: err.details ?? null,
          };
          await deleteTaskSession({ busRoot, agentName, taskId: id });
        } else if (err instanceof SkillOpsPromotionTaskError) {
          outcome = mapSkillOpsPromotionTaskOutcome(err.reasonCode);
          note = `skillops promotion ${describeSkillOpsPromotionOutcome(outcome)}: ${err.message}`;
          const rootId = readStringField(opened?.meta?.signals?.rootId) || readStringField(opened?.meta?.id);
          if (rootId) {
            await writeSkillOpsPromotionFailureState({
              busRoot,
              agentName,
              rootId,
              reasonCode: err.reasonCode,
              detail: (err && err.message) || String(err),
            });
          }
          receiptExtra = {
            ...defaultReceiptExtra,
            error: note,
            reasonCode: err.reasonCode,
            details: err.details ?? null,
          };
          await deleteTaskSession({ busRoot, agentName, taskId: id });
        } else if (err instanceof TaskGitPreflightBlockedError) {
          outcome = 'blocked';
          note = `git preflight blocked: ${err.message}`;
          const gitExtra = buildCurrentGitReceipt();
          receiptExtra = {
            ...defaultReceiptExtra,
            error: note,
            ...(gitExtra ? { git: gitExtra } : {}),
            details: err.details ?? null,
          };
          await deleteTaskSession({ busRoot, agentName, taskId: id });
        } else if (err instanceof TaskGitPreflightRuntimeError) {
          outcome = 'failed';
          note = err.message;
          const gitExtra = buildCurrentGitReceipt();
          receiptExtra = {
            ...defaultReceiptExtra,
            error: note,
            ...(gitExtra ? { git: gitExtra } : {}),
            details: err.details ?? null,
          };
          await deleteTaskSession({ busRoot, agentName, taskId: id });
        } else
        if (err instanceof CodexTurnTimeoutError) {
          outcome = 'blocked';
          note = `codex app-server timed out after ${formatDurationMs(err.timeoutMs)} (${err.timeoutMs}ms)`;
          const gitExtra = buildCurrentGitReceipt();
          receiptExtra = {
            ...defaultReceiptExtra,
            error: note,
            ...(gitExtra ? { git: gitExtra } : {}),
            timeoutMs: err.timeoutMs,
          };

          await maybeSendStatusToDaddy({
            busRoot,
            roster,
            fromAgent: agentName,
            priority: opened.meta?.priority || 'P2',
            rootId: opened.meta?.signals?.rootId ?? opened.meta?.id ?? null,
            parentId: opened.meta?.id ?? null,
            title: `STATUS: codex app-server timed out (${agentName})`,
            body:
              `codex app-server hit the watchdog timeout and was terminated.\n\n` +
              `Agent: ${agentName}\n` +
              `Task: ${id}\n` +
              (err.threadId ? `Codex thread: ${err.threadId}\n` : '') +
              `Attempt: ${Number.isFinite(Number(err.attempt)) ? err.attempt : 'unknown'}\n` +
              `Timeout: ${err.timeoutMs}ms\n` +
              `\nOutcome will be recorded as blocked.\n`,
            throttle: null,
          });
        } else {
          if (err instanceof CodexTurnError) {
            const errorPreflightGate =
              runtimePreflightRequired && isPlainObject(err.details?.preflightGateEvidence)
                ? err.details.preflightGateEvidence
                : null;
            if (errorPreflightGate) {
              preflightGateEvidence = {
                required: true,
                approved: errorPreflightGate.approved === true,
                noWritePass:
                  typeof errorPreflightGate.noWritePass === 'boolean' ? errorPreflightGate.noWritePass : null,
                planHash: readStringField(errorPreflightGate.planHash) || null,
                driftDetected: errorPreflightGate.driftDetected === true,
                reasonCode: readStringField(errorPreflightGate.reasonCode) || null,
              };
            }
            const runtimeGuard =
              runtimePreflightRequired
                ? {
                    preflightGate: preflightGateEvidence,
                  }
                : null;
            const combined = `${err.message}\n${err.stderrTail || ''}\n${err.stdoutTail || ''}`;
            if (isSandboxPermissionErrorText(combined)) {
              outcome = 'blocked';
              note = `codex app-server blocked by sandbox/permissions: ${err.message}`;
              const gitExtra = buildCurrentGitReceipt();
              receiptExtra = {
                ...defaultReceiptExtra,
                error: note,
                ...(runtimeGuard ? { runtimeGuard } : {}),
                ...(gitExtra ? { git: gitExtra } : {}),
                threadId: err.threadId || null,
                stderrTail: typeof err.stderrTail === 'string' ? err.stderrTail.slice(-16_000) : null,
                details: err.details ?? null,
              };
            } else {
              outcome = 'failed';
              note = `codex app-server failed: ${(err && err.message) || String(err)}`;
              const gitExtra = buildCurrentGitReceipt();
              receiptExtra = {
                ...defaultReceiptExtra,
                error: note,
                ...(runtimeGuard ? { runtimeGuard } : {}),
                ...(gitExtra ? { git: gitExtra } : {}),
                details: err.details ?? null,
              };
            }
          } else {
            outcome = 'failed';
            note = `codex app-server failed: ${(err && err.message) || String(err)}`;
            const gitExtra = buildCurrentGitReceipt();
            receiptExtra = {
              ...defaultReceiptExtra,
              error: note,
              ...(gitExtra ? { git: gitExtra } : {}),
            };
          }
        }
        await deleteTaskSession({ busRoot, agentName, taskId: id });
      }

      writePane(
        `[worker] ${agentName} task done ${id} outcome=${outcome}${commitSha ? ` commit=${commitSha}` : ''}\n`,
      );

      if (isAutopilot && outcome === 'blocked') {
        receiptExtra = markAutopilotBlockedContract({
          receiptExtra,
          contract: buildAutopilotBlockedRecoveryContract({
            openedMeta: opened.meta,
            receiptExtra,
            note,
            parsedAutopilotControl: lastParsedAutopilotControl,
            parsedFollowUps: lastParsedFollowUps,
            sourceDelta: lastSourceDelta,
            commitSha,
            cwd: taskCwd,
            agentName,
            skillOpsPromotionStateDir: getSkillOpsPromotionStateDir({ busRoot, agentName }),
          }),
        });
        const blockedRecoveryContract = isPlainObject(receiptExtra?.blockedRecoveryContract)
          ? receiptExtra.blockedRecoveryContract
          : null;
        if (
          blockedRecoveryContract &&
          normalizeAutopilotRecoveryContractClass(blockedRecoveryContract.class) === 'controller' &&
          readStringField(blockedRecoveryContract.reasonCode) === 'dirty_cross_root_transition' &&
          !isControllerHousekeepingTask(opened.meta)
        ) {
          let stagedFingerprint = '';
          try {
            const dirtySnapshot = getGitSnapshot({ cwd: taskCwd });
            const { repoCommonGitDir, dirtyClassification: classifiedDirty } = classifyControllerDirtySnapshot({
              busRoot,
              cwd: taskCwd,
              agentName,
              snapshot: dirtySnapshot,
              autoCleanRuntimeArtifacts: false,
            });
            if (classifiedDirty.classification !== 'controller_housekeeping_required') {
              writePane(
                `[worker] ${agentName} skip stale controller housekeeping dispatch ${id}: classification=${
                  classifiedDirty.classification || 'runtime_artifacts_only'
                }\n`,
              );
            } else {
              stagedFingerprint = readStringField(blockedRecoveryContract.fingerprint) || classifiedDirty.fingerprint;
              const staged = await stageControllerHousekeepingSuspension({
                busRoot,
                agentName,
                fingerprint: stagedFingerprint,
                branch: readStringField(dirtySnapshot?.branch),
                headSha: readStringField(dirtySnapshot?.headSha),
                repoCommonGitDir,
                recoverableStatusPorcelain: classifiedDirty.recoverableStatusPorcelain,
                openedMeta: opened.meta,
                openedBody: opened.body,
              });
              if (staged.action === 'queue' && staged.taskMeta) {
                await deliverTask({ busRoot, meta: staged.taskMeta, body: staged.taskBody });
              }
              skipAutopilotRecoveryPlan = true;
              controllerHousekeepingStage = {
                action: staged.action,
                fingerprint: stagedFingerprint,
                syntheticRootId: staged.syntheticRootId,
              };
              if (staged.action === 'unchanged') {
                note = appendReasonNote(note, 'controller_housekeeping_unchanged');
                receiptExtra.reasonCode = 'controller_housekeeping_unchanged';
              } else {
                await writeAgentRootFocus({
                  busRoot,
                  agentName,
                  rootId: staged.syntheticRootId,
                  branch: readStringField((getGitSnapshot({ cwd: taskCwd }) || {}).branch) || '',
                });
                note = appendReasonNote(note, 'controller_housekeeping_pending');
                receiptExtra.reasonCode = 'controller_housekeeping_pending';
              }
              receiptExtra.controllerHousekeeping = {
                fingerprint: controllerHousekeepingStage.fingerprint,
                rootId: staged.syntheticRootId,
              };
            }
          } catch (err) {
            if (stagedFingerprint) {
              try {
                await writeControllerHousekeepingTerminalState({
                  busRoot,
                  agentName,
                  fingerprint: stagedFingerprint,
                  terminalReasonCode: 'controller_housekeeping_enqueue_failed',
                });
              } catch {
                // ignore follow-on state write failure; original task still fails closed below
              }
            }
            outcome = 'needs_review';
            note = appendReasonNote(
              `controller housekeeping enqueue failed: ${(err && err.message) || String(err)}`,
              'controller_housekeeping_enqueue_failed',
            );
            receiptExtra.reasonCode = 'controller_housekeeping_enqueue_failed';
            receiptExtra.details = {
              ...(isPlainObject(receiptExtra.details) ? receiptExtra.details : {}),
              controllerHousekeeping: {
                error: (err && err.message) || String(err),
              },
            };
            skipAutopilotRecoveryPlan = true;
          }
        }
      }

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
            ? readStringField(receiptExtra?.reasonCode) || workerCodeQualityState.mapCodeQualityReasonCodes([note])[0] || ''
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
      const autopilotRecoveryPlan = skipAutopilotRecoveryPlan
        ? null
        : planAutopilotBlockedRecovery({
            isAutopilot,
            agentName,
            openedMeta: opened.meta,
            outcome,
            note,
            receiptExtra,
          });

      try {
        if (autopilotRecoveryPlan?.status === 'exhausted') {
          receiptExtra = {
            ...(receiptExtra && typeof receiptExtra === 'object' ? receiptExtra : {}),
            autopilotRecovery: {
              queued: false,
              reason: autopilotRecoveryPlan.reason,
              recoveryKey: autopilotRecoveryPlan.recoveryKey,
              attempt: autopilotRecoveryPlan.attempt,
              maxAttempts: autopilotRecoveryPlan.maxAttempts,
              reasonCode: autopilotRecoveryPlan.reasonCode,
            },
          };
          note = appendReasonNote(note, `autopilot_recovery_${autopilotRecoveryPlan.reason}`);
        }
        const closeResult = await closeTask({
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
        if (controllerHousekeepingStage?.fingerprint) {
          await patchControllerHousekeepingSuspendedRootAudit({
            busRoot,
            agentName,
            fingerprint: controllerHousekeepingStage.fingerprint,
            originalTaskId: id,
            closedReceiptPath: path.relative(busRoot, closeResult.receiptPath),
            closedProcessedPath: path.relative(busRoot, closeResult.processedPath),
          });
        }
        const closedRootId = readStringField(opened.meta?.signals?.rootId);
        if (closedRootId && !controllerHousekeepingStage) {
          await writeAgentRootFocus({
            busRoot,
            agentName,
            rootId: closedRootId,
            branch: readStringField((getGitSnapshot({ cwd: taskCwd }) || {}).branch) || '',
          });
        }
        if (autopilotRecoveryPlan?.status === 'queue') {
          try {
            const result = await queueAutopilotBlockedRecovery({
              busRoot,
              agentName,
              recovery: autopilotRecoveryPlan,
            });
            if (result.queued) {
              writePane(
                `[worker] ${agentName} queued blocked recovery ${autopilotRecoveryPlan.taskId} for root ${autopilotRecoveryPlan.rootId}\n`,
              );
            }
          } catch (err) {
            try {
              const pendingPath = await writeAutopilotBlockedRecoveryPending({
                busRoot,
                agentName,
                recovery: autopilotRecoveryPlan,
              });
              writePane(
                `[worker] ${agentName} recovery warn: deferred blocked recovery ${autopilotRecoveryPlan.taskId} at ${path.relative(busRoot, pendingPath)}: ${(err && err.message) || String(err)}\n`,
              );
            } catch (pendingErr) {
              writePane(
                `[worker] ${agentName} recovery warn: failed to persist blocked recovery ${autopilotRecoveryPlan.taskId}: ${(pendingErr && pendingErr.message) || String(pendingErr)}\n`,
              );
            }
          }
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
        if (autopilotRecoveryPlan?.status === 'exhausted' && closedRootId) {
          await clearStaleRootFocusAndSessionIfNoOpenTasks({ busRoot, agentName, rootId: closedRootId });
        }
        if (
          receiptExtra?.controllerHousekeepingCleanupRootId &&
          outcome !== 'done'
        ) {
          await clearStaleRootFocusAndSessionIfNoOpenTasks({
            busRoot,
            agentName,
            rootId: readStringField(receiptExtra.controllerHousekeepingCleanupRootId),
          });
        }
      } catch (err) {
        writePane(
          `[worker] ERROR: failed to close task ${id} for ${agentName}: ${(err && err.message) || String(err)}\n`,
        );
      }
      if (releaseSkillOpsPromotionLock) {
        await releaseSkillOpsPromotionLock();
        releaseSkillOpsPromotionLock = null;
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
