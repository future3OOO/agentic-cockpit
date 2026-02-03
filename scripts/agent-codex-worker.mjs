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
import { promises as fs, writeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
import { CodexAppServerClient } from './lib/codex-app-server-client.mjs';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

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

function parsePositiveInt(raw) {
  if (raw == null) return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  return Math.floor(value);
}

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

async function fileExists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

function parseCodexSessionIdFromText(text) {
  const s = String(text || '');
  const m = s.match(/\bsession id:\s*([0-9A-Za-z-]{8,})\b/);
  if (m) return m[1];
  return null;
}

function trimToOneLine(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncateText(value, { maxLen }) {
  const s = String(value ?? '');
  const max = Math.max(1, Number(maxLen) || 1);
  if (s.length <= max) return s;
  return `${s.slice(0, max).trimEnd()}…`;
}

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

async function maybeSendStatusToDaddy({
  busRoot,
  roster,
  fromAgent,
  priority,
  rootId,
  parentId,
  title,
  body,
  throttle,
}) {
  const daddyName = pickDaddyChatName(roster);
  if (!daddyName) return { delivered: false, error: null };

  const key = `${fromAgent}::${String(title || '').slice(0, 80)}`;
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
      phase: 'rate-limit',
      rootId: rootId || id,
      parentId: parentId || rootId || id,
      smoke: false,
      notifyOrchestrator: false,
    },
    references: {},
  };
  try {
    await deliverTask({ busRoot, meta, body: body || '' });
    return { delivered: true, error: null };
  } catch (err) {
    return { delivered: false, error: (err && err.message) || String(err) };
  }
}

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

async function deleteTaskSession({ busRoot, agentName, taskId }) {
  const dir = path.join(busRoot, 'state', 'codex-task-sessions', agentName);
  const p = path.join(dir, `${taskId}.json`);
  try {
    await fs.unlink(p);
  } catch {
    // ignore
  }
}

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
    const gitCommonAbs = resolveAbs(safeExecText('git', ['rev-parse', '--git-common-dir'], { cwd: sandboxCwd }));
    if (gitDirAbs) extraWritableDirs.push(gitDirAbs);
    if (gitCommonAbs && gitCommonAbs !== gitDirAbs) extraWritableDirs.push(gitCommonAbs);
  }

  const args = [
    ...(enableChromeDevtools ? [] : ['--config', 'mcp_servers.chrome-devtools.enabled=false']),
    '--config',
    `sandbox_workspace_write.network_access=${networkAccess}`,
    '--ask-for-approval',
    'never',
    '--sandbox',
    sandbox,
    ...extraWritableDirs.flatMap((d) => ['--add-dir', d]),
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

  const env = { ...process.env, ...extraEnv };
  const timeoutMs = getCodexExecTimeoutMs(env);
  const killGraceMs = 10_000;
  const updatePollMsRaw = (env.VALUA_CODEX_TASK_UPDATE_POLL_MS || '').trim();
  const updatePollMs = updatePollMsRaw ? Math.max(200, Number(updatePollMsRaw) || 200) : 1000;

  const { exitCode } = await new Promise((resolve, reject) => {
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
  });

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

async function writeJsonAtomic(filePath, value) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${filePath}.tmp.${Math.random().toString(16).slice(2)}`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, filePath);
}

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
  extraEnv = {},
}) {
  const env = { ...process.env, ...extraEnv };
  const timeoutMs = getCodexExecTimeoutMs(env);
  const updatePollMsRaw = (env.VALUA_CODEX_TASK_UPDATE_POLL_MS || '').trim();
  const updatePollMs = updatePollMsRaw ? Math.max(200, Number(updatePollMsRaw) || 200) : 1000;

  const networkAccessRaw = String(env.AGENTIC_CODEX_NETWORK_ACCESS ?? env.VALUA_CODEX_NETWORK_ACCESS ?? '').trim();
  const networkAccess = networkAccessRaw === '0' ? false : true;

  const sandboxCwd = workdir || repoRoot;
  const extraWritableDirs = [];
  {
    const resolveAbs = (value) => {
      const raw = String(value || '').trim();
      if (!raw) return null;
      return path.isAbsolute(raw) ? raw : path.resolve(sandboxCwd, raw);
    };

    const gitDirAbs = resolveAbs(safeExecText('git', ['rev-parse', '--git-dir'], { cwd: sandboxCwd }));
    const gitCommonAbs = resolveAbs(
      safeExecText('git', ['rev-parse', '--git-common-dir'], { cwd: sandboxCwd }),
    );
    if (gitDirAbs) extraWritableDirs.push(gitDirAbs);
    if (gitCommonAbs && gitCommonAbs !== gitDirAbs) extraWritableDirs.push(gitCommonAbs);
  }

  const writableRoots = [path.resolve(sandboxCwd), ...extraWritableDirs];
  /** @type {any} */
  let outputSchema = null;
  try {
    outputSchema = JSON.parse(await fs.readFile(schemaPath, 'utf8'));
  } catch {
    outputSchema = null;
  }

  const client = new CodexAppServerClient({ codexBin, cwd: repoRoot, env, log: writePane });
  await client.start();

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
    if (!threadResp) {
      threadResp = await client.call('thread/start', {});
    }

    const threadObj = threadResp?.thread ?? threadResp;
    const tid = typeof threadObj?.id === 'string' ? threadObj.id.trim() : '';
    if (!tid) throw new Error('codex app-server did not return a thread id');
    threadId = tid;

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

    const turnStartRes = await client.call('turn/start', {
      threadId,
      input: [{ type: 'text', text: prompt }],
      cwd: sandboxCwd,
      approvalPolicy: 'never',
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots,
        networkAccess,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
      outputSchema,
    });

    if (!turnId) {
      const id = typeof turnStartRes?.turn?.id === 'string' ? turnStartRes.turn.id.trim() : '';
      if (id) turnId = id;
    }

    /** @type {NodeJS.Timeout|null} */
    let updateTimer = null;
    /** @type {NodeJS.Timeout|null} */
    let timeoutTimer = null;

    const updatePromise =
      watchFilePath && Number.isFinite(watchFileMtimeMs) && watchFileMtimeMs != null
        ? new Promise((resolve) => {
            const baseline = Number(watchFileMtimeMs);
            updateTimer = setInterval(() => {
              fs.stat(watchFilePath)
                .then((st) => {
                  const next = Number(st?.mtimeMs);
                  if (!Number.isFinite(next)) return;
                  if (next <= baseline) return;
                  resolve({ kind: 'updated' });
                })
                .catch(() => {
                  // ignore
                });
            }, updatePollMs);
            updateTimer.unref?.();
          })
        : new Promise(() => {});

    const timeoutPromise =
      timeoutMs > 0
        ? new Promise((resolve) => {
            timeoutTimer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
            timeoutTimer.unref?.();
          })
        : new Promise(() => {});

    let raced;
    try {
      raced = await Promise.race([donePromise, updatePromise, timeoutPromise]);
    } finally {
      if (updateTimer) clearInterval(updateTimer);
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
    try {
      await client.stop();
    } catch {
      // ignore
    }
  }
}

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

function normalizeSkillName(name) {
  const raw = String(name ?? '').trim();
  if (!raw) return null;
  return raw.startsWith('$') ? raw.slice(1) : raw;
}

function isPlanningSkill(name) {
  return (
    name === 'planning' ||
    name === 'valua-planning' ||
    name.endsWith('-planning') ||
    name.endsWith('-plan')
  );
}

function isExecSkill(name) {
  return name === 'exec-agent' || name === 'valua-exec-agent' || name.endsWith('-exec-agent');
}

function selectSkills({ skills, taskKind, isSmoke, isAutopilot }) {
  const rawSkills = Array.isArray(skills) ? skills : [];
  const set = new Set(rawSkills.map(normalizeSkillName).filter(Boolean));

  if (isSmoke) return [];

  /** @type {string[]} */
  const selected = [];

  if (taskKind === 'PLAN_REQUEST') {
    const planning = Array.from(set).find(isPlanningSkill);
    if (planning) selected.push(planning);
  }
  if (taskKind === 'EXECUTE' || isAutopilot) {
    const execAgent = Array.from(set).find(isExecSkill);
    if (execAgent) selected.push(execAgent);
  }

  for (const name of set) {
    if (selected.includes(name)) continue;
    selected.push(name);
  }

  return selected;
}

function buildPrompt({ agentName, skills, taskKind, isSmoke, isAutopilot, taskMarkdown, contextBlock }) {
  const invocations = selectSkills({ skills, taskKind, isSmoke, isAutopilot })
    .map((s) => `$${s}`)
    .join('\n');

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
    `IMPORTANT OUTPUT RULE:\n` +
    `Return ONLY a JSON object that matches the provided output schema.\n\n` +
    `You MAY include "followUps" (see schema) to dispatch additional AgentBus tasks automatically.\n\n` +
    `--- TASK PACKET ---\n` +
    `${taskMarkdown}\n`
  );
}

function normalizeToArray(value) {
  if (Array.isArray(value)) return value.map((s) => String(s)).map((s) => s.trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

function safeExecText(cmd, args, { cwd }) {
  try {
    const raw = childProcess.execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return String(raw ?? '').trim() || null;
  } catch {
    return null;
  }
}

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

async function writeAgentStateFile({ busRoot, agentName, payload }) {
  const dir = path.join(busRoot, 'state');
  await fs.mkdir(dir, { recursive: true });
  const outPath = path.join(dir, `${agentName}.json`);
  const tmp = `${outPath}.tmp.${Math.random().toString(16).slice(2)}`;
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, outPath);
  return outPath;
}

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
    `\nAutopilot state (last run):\n` +
    `${apState || '(missing)'}\n` +
    `\nContinuity ledger (.codex/CONTINUITY.md):\n` +
    `${ledger || '(missing)'}\n` +
    `--- END CONTEXT ---`
  );
}

function normalizeResumeSessionId(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (raw === 'last') return 'last';
  // If an env placeholder wasn't expanded, treat it as unset.
  if (raw.startsWith('$')) return null;
  return raw;
}

function normalizeCodexEngine(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return null;
  if (raw === 'exec') return 'exec';
  if (raw === 'app-server' || raw === 'app_server' || raw === 'appserver') return 'app-server';
  return null;
}

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

async function writeSessionIdFile({ busRoot, agentName, sessionId }) {
  const cleaned = normalizeResumeSessionId(sessionId);
  if (!cleaned || cleaned === 'last') return null;
  const dir = path.join(busRoot, 'state');
  await fs.mkdir(dir, { recursive: true });
  const p = path.join(dir, `${agentName}.session-id`);
  await fs.writeFile(p, `${cleaned}\n`, 'utf8');
  return p;
}

async function dispatchFollowUps({ busRoot, agentName, openedMeta, followUps }) {
  const rootIdDefault = openedMeta?.signals?.rootId || openedMeta?.id || null;
  const parentIdDefault = openedMeta?.id || null;
  const priority = openedMeta?.priority || 'P2';
  const smokeDefault = Boolean(openedMeta?.signals?.smoke);

  const items = Array.isArray(followUps) ? followUps : [];
  const limit = 5;
  const dispatched = [];
  const errors = [];

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

      const meta = {
        id,
        to,
        from: agentName,
        priority,
        title,
        signals,
        references: {
          parentTaskId: parentIdDefault,
          parentRootId: rootIdDefault,
        },
      };

      await deliverTask({ busRoot, meta, body });
      dispatched.push({ id, to, title, kind });
    } catch (err) {
      errors.push((err && err.message) || String(err));
    }
  }

  if (items.length > limit) {
    errors.push(`followUps truncated: ${items.length} provided, max ${limit} dispatched`);
  }

  return { dispatched, errors };
}

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

  const codexBin =
    values['codex-bin']?.trim() || process.env.AGENTIC_CODEX_BIN || process.env.VALUA_CODEX_BIN || 'codex';
  const codexEngine =
    normalizeCodexEngine(
      process.env.AGENTIC_CODEX_ENGINE || process.env.VALUA_CODEX_ENGINE || agentCfg?.codexEngine,
    ) || 'exec';
  const pollMs = values['poll-ms'] ? Math.max(50, Number(values['poll-ms'])) : 300;

  const schemaPath = path.join(cockpitRoot, 'docs', 'agentic', 'agent-bus', 'CODEX_WORKER_OUTPUT.schema.json');

  const defaultWorktreesDir = path.join(os.homedir(), '.agentic-cockpit', 'worktrees');
  const worktreesDir =
    process.env.AGENTIC_WORKTREES_DIR?.trim() || process.env.VALUA_AGENT_WORKTREES_DIR?.trim() || defaultWorktreesDir;

  // Guardrails: worker agents must NOT merge PRs or push to protected branches.
  // We implement this as PATH wrappers for `git` and `gh` (interactive DADDY CHAT is not launched through this worker).
  const guardBin = path.join(cockpitRoot, 'scripts', 'agentic', 'guard-bin');
  let guardEnv = {};
  try {
    await fs.stat(guardBin);
    const origPath = process.env.PATH || '';
    const realGit = safeExecText('bash', ['-lc', 'command -v git'], { cwd: cockpitRoot });
    const realGh = safeExecText('bash', ['-lc', 'command -v gh'], { cwd: cockpitRoot });
    guardEnv = {
      VALUA_ORIG_PATH: origPath,
      VALUA_REAL_GIT: realGit || '',
      VALUA_REAL_GH: realGh || '',
      VALUA_PROTECTED_BRANCHES: 'master,production',
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
      let receiptExtra = {};

      try {
        const statusThrottle = { ms: statusThrottleMs, lastSentAtByKey: new Map() };

        const sessionIdEnvRaw =
          (isAutopilot && (process.env.VALUA_AUTOPILOT_CODEX_SESSION_ID || process.env.VALUA_AUTOPILOT_SESSION_ID)) ||
          process.env.VALUA_CODEX_SESSION_ID ||
          '';
        const sessionIdEnv = normalizeResumeSessionId(sessionIdEnvRaw);
        const sessionIdFile = normalizeResumeSessionId(await readSessionIdFile({ busRoot, agentName }));
        const sessionIdCfg = normalizeResumeSessionId(agentCfg?.sessionId);
        const taskSession = await readTaskSession({ busRoot, agentName, taskId: id });
        let resumeSessionId = sessionIdEnv || sessionIdFile || sessionIdCfg || taskSession?.threadId || null;

        let lastCodexThreadId = taskSession?.threadId || null;
        let attempt = 0;
        let taskCanceled = false;
        let canceledNote = '';

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

          const slot = await acquireGlobalSemaphoreSlot({
            busRoot,
            name: `${agentName}:${id}`,
            maxSlots: globalMaxInflight,
          });

          try {
            // Reload task packet each attempt so AgentBus `update` changes are applied immediately.
            opened = await openTask({ busRoot, agentName, taskId: id, markSeen: false });
            const taskKindNow = opened.meta?.signals?.kind ?? null;
            const isSmokeNow = Boolean(opened.meta?.signals?.smoke);

            const contextBlock = isAutopilot
              ? await buildAutopilotContextBlock({ repoRoot, busRoot, roster, taskMeta: opened.meta, agentName })
              : buildBasicContextBlock({ workdir });

            const prompt = buildPrompt({
              agentName,
              skills: agentCfg.skills || [],
              taskKind: taskKindNow,
              isSmoke: isSmokeNow,
              isAutopilot,
              taskMarkdown: opened.markdown,
              contextBlock,
            });

            const taskStat = await fs.stat(opened.path);

            writePane(
              `[worker] ${agentName} codex ${codexEngine} attempt=${attempt}${resumeSessionId ? ` resume=${resumeSessionId}` : ''}\n`,
            );
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
                    extraEnv: guardEnv,
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
                    extraEnv: guardEnv,
                  });

            if (res?.threadId && typeof res.threadId === 'string') {
              lastCodexThreadId = res.threadId;
              await writeTaskSession({ busRoot, agentName, taskId: id, threadId: res.threadId });
            }
            if (res?.threadId && typeof res.threadId === 'string') {
              writePane(`[worker] ${agentName} codex thread=${res.threadId}\n`);
            }

            // Autopilot session persistence:
            // - If not explicitly configured via env/roster, auto-pin the first created thread id.
            if (isAutopilot && !sessionIdEnv && !sessionIdCfg && !sessionIdFile) {
              await writeSessionIdFile({ busRoot, agentName, sessionId: res?.threadId || null });
            }

            break;
          } catch (err) {
            if (err instanceof CodexExecSupersededError) {
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
            await slot.release();
          }
        }

        if (taskCanceled) {
          outcome = 'skipped';
          note = canceledNote;
          receiptExtra = { skippedReason: 'not_in_inbox_states' };
          await deleteTaskSession({ busRoot, agentName, taskId: id });
        } else {
        const raw = await fs.readFile(outputPath, 'utf8');
        const parsed = JSON.parse(raw);

        // Normalize some common fields.
        outcome = typeof parsed.outcome === 'string' ? parsed.outcome : 'done';
        note = typeof parsed.note === 'string' ? parsed.note : '';
        commitSha = typeof parsed.commitSha === 'string' ? parsed.commitSha : '';

        if (taskKind === 'PLAN_REQUEST') {
          // Plan tasks must not claim commits.
          commitSha = '';
        }

        receiptExtra = parsed;

        // If the agent emitted followUps, dispatch them automatically.
        const fu = await dispatchFollowUps({
          busRoot,
          agentName,
          openedMeta: opened.meta,
          followUps: parsed.followUps,
        });
        receiptExtra.dispatchedFollowUps = fu.dispatched;
        if (fu.errors.length) receiptExtra.followUpDispatchErrors = fu.errors;
        if (fu.errors.length && outcome === 'done') {
          outcome = 'needs_review';
          note = note ? `${note} (followUp dispatch errors)` : 'followUp dispatch errors';
        }

        await deleteTaskSession({ busRoot, agentName, taskId: id });
        }
      } catch (err) {
        if (err instanceof CodexExecTimeoutError) {
          outcome = 'blocked';
          note = `codex exec timed out after ${formatDurationMs(err.timeoutMs)} (${err.timeoutMs}ms)`;
          receiptExtra = { error: note, timeoutMs: err.timeoutMs };

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
          outcome = 'failed';
          note = `codex exec failed: ${(err && err.message) || String(err)}`;
          receiptExtra = { error: note };
        }
        await deleteTaskSession({ busRoot, agentName, taskId: id });
      }

      writePane(
        `[worker] ${agentName} task done ${id} outcome=${outcome}${commitSha ? ` commit=${commitSha}` : ''}\n`,
      );

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
      } catch (err) {
        writePane(
          `[worker] ERROR: failed to close task ${id} for ${agentName}: ${(err && err.message) || String(err)}\n`,
        );
      }
    }

    if (values.once) break;
    await sleep(pollMs);
  }
}

main().catch((err) => {
  writePane(`ERROR: ${(err && err.stack) || String(err)}\n`);
  process.exit(1);
});
