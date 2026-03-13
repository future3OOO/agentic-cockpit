import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { promises as fs } from 'node:fs';

export function buildHermeticBaseEnv({ extraKeys = [] } = {}) {
  const env = { ...process.env };
  const blockedKeys = new Set(extraKeys);
  for (const key of Object.keys(env)) {
    if (key.startsWith('AGENTIC_') || key.startsWith('VALUA_') || blockedKeys.has(key)) {
      delete env[key];
    }
  }
  return env;
}

const LEGACY_EXEC_APP_SERVER_WRAPPER = String.raw`#!/usr/bin/env node
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const legacyBin = process.env.LEGACY_EXEC_BIN || '';
const args = process.argv.slice(2);
if (!args.length || args[0] !== 'app-server') {
  process.stderr.write('dummy-codex: expected app-server\n');
  process.exit(2);
}
if (!legacyBin) {
  process.stderr.write('dummy-codex: missing LEGACY_EXEC_BIN\n');
  process.exit(2);
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

let currentThreadId = 'thread-legacy';
let turnSequence = 0;
const activeTurns = new Map();

function nextTurnId(prefix) {
  turnSequence += 1;
  return prefix + '-' + String(turnSequence);
}

function shutdown() {
  for (const state of activeTurns.values()) {
    try {
      state.proc && state.proc.kill('SIGTERM');
    } catch {
      // ignore
    }
  }
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

async function runLegacy(prompt, state) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-cockpit-legacy-codex-'));
  const outputPath = path.join(tmpDir, 'output.json');
  try {
    return await new Promise((resolve, reject) => {
      const proc = spawn(legacyBin, ['-o', outputPath], {
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      state.proc = proc;
      let stderr = '';
      proc.stderr.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        stderr += text;
        process.stderr.write(text);
        const match = text.match(/session id:\s*(\S+)/i);
        if (match) currentThreadId = match[1];
      });
      proc.on('error', reject);
      proc.on('close', async (code, signal) => {
        if (state.proc === proc) state.proc = null;
        let text = '';
        try {
          text = await fs.readFile(outputPath, 'utf8');
        } catch {
          text = '';
        }
        resolve({ code: code ?? 1, signal, text, stderr });
      });
      proc.stdin.end(prompt);
    });
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function completeTurnFromLegacy(turnId, prompt) {
  const state = activeTurns.get(turnId);
  try {
    const result = await runLegacy(prompt, state);
    if (state?.interrupted) {
      send({
        method: 'turn/completed',
        params: { threadId: currentThreadId, turn: { id: turnId, status: 'interrupted', items: [] } },
      });
      return;
    }
    const text = String(result.text || '').trim();
    if (result.code !== 0 || !text) {
      send({
        method: 'turn/completed',
        params: {
          threadId: currentThreadId,
          turn: {
            id: turnId,
            status: 'failed',
            error: {
              message: result.code !== 0 ? ('legacy double exited ' + String(result.code)) : 'legacy double produced no output',
              additionalDetails: result.stderr || '',
            },
            items: [],
          },
        },
      });
      return;
    }
    send({
      method: 'item/agentMessage/delta',
      params: { delta: text, itemId: 'am1', threadId: currentThreadId, turnId },
    });
    send({
      method: 'item/completed',
      params: {
        threadId: currentThreadId,
        turnId,
        item: { id: 'am1', type: 'agentMessage', text },
      },
    });
    send({
      method: 'turn/completed',
      params: { threadId: currentThreadId, turn: { id: turnId, status: 'completed', items: [] } },
    });
  } catch (err) {
    send({
      method: 'turn/completed',
      params: {
        threadId: currentThreadId,
        turn: {
          id: turnId,
          status: 'failed',
          error: {
            message: String((err && err.message) || err || 'legacy double failed'),
            additionalDetails: '',
          },
          items: [],
        },
      },
    });
  } finally {
    activeTurns.delete(turnId);
  }
}

const rl = createInterface({ input: process.stdin });
process.stdin.resume();
rl.on('close', shutdown);
rl.on('line', async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg?.id != null && msg.method === 'initialize') {
    send({ id: msg.id, result: {} });
    return;
  }
  if (msg?.method === 'initialized') return;
  if (msg?.id != null && msg.method === 'thread/start') {
    send({ id: msg.id, result: { thread: { id: currentThreadId } } });
    return;
  }
  if (msg?.id != null && msg.method === 'thread/resume') {
    currentThreadId = String(msg?.params?.threadId || currentThreadId || 'thread-legacy');
    send({ id: msg.id, result: { thread: { id: currentThreadId } } });
    return;
  }
  if (msg?.id != null && msg.method === 'review/start') {
    const turnId = nextTurnId('review');
    send({ id: msg.id, result: { turn: { id: turnId, status: 'inProgress', items: [] } } });
    send({ method: 'turn/started', params: { threadId: currentThreadId, turn: { id: turnId, status: 'inProgress', items: [] } } });
    send({ method: 'item/started', params: { threadId: currentThreadId, turnId, item: { id: 'entered-review', type: 'enteredReviewMode' } } });
    const reviewText = process.env.REVIEW_ASSISTANT_TEXT || 'review ok';
    send({ method: 'item/completed', params: { threadId: currentThreadId, turnId, item: { id: 'review-msg', type: 'agentMessage', text: reviewText } } });
    send({ method: 'item/completed', params: { threadId: currentThreadId, turnId, item: { id: 'exited-review', type: 'exitedReviewMode' } } });
    send({ method: 'turn/completed', params: { threadId: currentThreadId, turn: { id: turnId, status: 'completed', items: [] } } });
    return;
  }
  if (msg?.id != null && msg.method === 'turn/interrupt') {
    const turnId = String(msg?.params?.turnId || '');
    send({ id: msg.id, result: {} });
    const state = activeTurns.get(turnId);
    if (state) {
      state.interrupted = true;
      if (state.proc) {
        state.proc.kill('SIGTERM');
      }
    }
    return;
  }
  if (msg?.id != null && msg.method === 'turn/start') {
    const turnId = nextTurnId('turn');
    activeTurns.set(turnId, { proc: null, interrupted: false });
    const prompt = String((((msg?.params || {}).input) || [{}])[0]?.text || '');
    send({ id: msg.id, result: { turn: { id: turnId, status: 'inProgress', items: [] } } });
    send({ method: 'turn/started', params: { threadId: currentThreadId, turn: { id: turnId, status: 'inProgress', items: [] } } });
    void completeTurnFromLegacy(turnId, prompt);
  }
});
`;

export function spawnProcess(cmd, args, { cwd, env, timeoutMs = 10000 } = {}) {
  return new Promise((resolve) => {
    const proc = childProcess.spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let killTimer = null;
    const timeout = setTimeout(() => {
      stderr += '\n[test harness] timed out waiting for child process\n';
      try {
        proc.kill('SIGTERM');
      } catch {
        // ignore
      }
      killTimer = setTimeout(() => {
        stderr += '\n[test harness] forced SIGKILL after SIGTERM grace window\n';
        try {
          proc.kill('SIGKILL');
        } catch {
          // ignore
        }
      }, 1000);
      killTimer.unref?.();
    }, timeoutMs);
    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    proc.on('exit', (code, signal) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

export async function writeExecutable(filePath, contents) {
  const expectsAppServer =
    /\bapp-server\b/.test(contents) && /(thread\/start|turn\/start|review\/start|initialize)/.test(contents);
  if (expectsAppServer) {
    await fs.writeFile(filePath, contents, 'utf8');
    await fs.chmod(filePath, 0o755);
    return;
  }
  const legacyPath = `${filePath}.legacy`;
  await fs.writeFile(legacyPath, contents, 'utf8');
  await fs.chmod(legacyPath, 0o755);
  const wrapper = LEGACY_EXEC_APP_SERVER_WRAPPER.replace(
    "process.env.LEGACY_EXEC_BIN || ''",
    JSON.stringify(legacyPath),
  );
  await fs.writeFile(filePath, wrapper, 'utf8');
  await fs.chmod(filePath, 0o755);
}

export async function writeTask({ busRoot, agentName, taskId, meta, body }) {
  const inbox = path.join(busRoot, 'inbox', agentName, 'new');
  await fs.mkdir(inbox, { recursive: true });
  const outPath = path.join(inbox, `${taskId}.md`);
  const raw = `---\n${JSON.stringify(meta)}\n---\n\n${body}\n`;
  await fs.writeFile(outPath, raw, 'utf8');
  return outPath;
}

export function runGit(cwd, args) {
  childProcess.execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
}

export async function initRepoWithTrackedCodexDir(repoRoot) {
  await fs.mkdir(repoRoot, { recursive: true });
  runGit(repoRoot, ['init']);
  runGit(repoRoot, ['config', 'user.email', 'test@example.com']);
  runGit(repoRoot, ['config', 'user.name', 'Test User']);
  await fs.mkdir(path.join(repoRoot, '.codex', 'skills'), { recursive: true });
  await fs.writeFile(path.join(repoRoot, '.codex', 'skills', '.keep'), 'tracked\n', 'utf8');
  await fs.writeFile(path.join(repoRoot, 'README.md'), 'seed\n', 'utf8');
  runGit(repoRoot, ['add', '.']);
  runGit(repoRoot, ['commit', '-m', 'seed']);
}

export async function writeRootFocus({ busRoot, agentName, rootId }) {
  const dir = path.join(busRoot, 'state', 'agent-root-focus');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${agentName}.json`),
    JSON.stringify({ rootId }, null, 2) + '\n',
    'utf8',
  );
}

export async function runCodexWorkerOnce({
  repoRoot,
  busRoot,
  rosterPath,
  agentName,
  codexBin,
  env,
  extraArgs = [],
}) {
  return spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      agentName,
      '--bus-root',
      busRoot,
      '--roster',
      rosterPath,
      '--once',
      '--poll-ms',
      '10',
      '--codex-bin',
      codexBin,
      ...extraArgs,
    ],
    { cwd: repoRoot, env },
  );
}

export function makeTempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}
