import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import childProcess from 'node:child_process';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function spawnProcess(cmd, args, { cwd, env }) {
  return new Promise((resolve) => {
    const proc = childProcess.spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d.toString('utf8')));
    proc.stderr.on('data', (d) => (stderr += d.toString('utf8')));
    proc.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

async function writeExecutable(filePath, contents) {
  await fs.writeFile(filePath, contents, 'utf8');
  await fs.chmod(filePath, 0o755);
}

async function writeTask({ busRoot, agentName, taskId, meta, body }) {
  const inbox = path.join(busRoot, 'inbox', agentName, 'new');
  await fs.mkdir(inbox, { recursive: true });
  const p = path.join(inbox, `${taskId}.md`);
  const raw = `---\n${JSON.stringify(meta)}\n---\n\n${body}\n`;
  await fs.writeFile(p, raw, 'utf8');
  return p;
}

async function waitForPath(p, { timeoutMs = 5000, pollMs = 25 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await fs.stat(p);
      return true;
    } catch {
      // ignore
    }
    await sleep(pollMs);
  }
  return false;
}

test('agent-codex-worker: restarts codex exec when task file is updated', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'valua-codex-worker-update-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const countFile = path.join(tmp, 'count.txt');
  const started1 = path.join(tmp, 'attempt1.started');

  await writeExecutable(
    dummyCodex,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `COUNT_FILE=${JSON.stringify(countFile)}`,
      `STARTED1=${JSON.stringify(started1)}`,
      'n=0',
      'if [[ -f "$COUNT_FILE" ]]; then n=$(cat "$COUNT_FILE"); fi',
      'n=$((n+1))',
      'echo "$n" > "$COUNT_FILE"',
      'echo "session id: thread-update" >&2',
      'prompt="$(cat)"',
      'out=""',
      'for ((i=1;i<=$#;i++)); do',
      '  if [[ "${!i}" == "-o" ]]; then',
      '    j=$((i+1))',
      '    out="${!j}"',
      '  fi',
      'done',
      'trap "exit 0" TERM INT',
      'if [[ "$n" == "1" ]]; then',
      '  : > "$STARTED1"',
      '  sleep 5',
      '  exit 0',
      'fi',
      'note="no-update"',
      'if echo "$prompt" | grep -q "SENTINEL_UPDATE"; then note="saw-update"; fi',
      'printf \'{"outcome":"done","note":"%s","commitSha":"","planMarkdown":"","filesToChange":[],"testsToRun":[],"artifacts":[],"riskNotes":"","rollbackPlan":"","followUps":[]}\\n\' "$note" > "$out"',
      'exit 0',
      '',
    ].join('\n'),
  );

  const roster = {
    orchestratorName: 'daddy-orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'daddy-autopilot',
    agents: [
      {
        name: 'backend',
        role: 'codex-worker',
        skills: [],
        workdir: '$REPO_ROOT',
        startCommand: 'node scripts/agent-codex-worker.mjs --agent backend',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');

  await writeTask({
    busRoot,
    agentName: 'backend',
    taskId: 't1',
    meta: { id: 't1', to: ['backend'], from: 'daddy', priority: 'P2', title: 't1', signals: { kind: 'USER_REQUEST' } },
    body: 'do t1',
  });

  const env = {
    ...process.env,
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_EXEC_TIMEOUT_MS: '5000',
    VALUA_CODEX_TASK_UPDATE_POLL_MS: '200',
  };

  const runPromise = spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'backend',
      '--bus-root',
      busRoot,
      '--roster',
      rosterPath,
      '--once',
      '--poll-ms',
      '10',
      '--codex-bin',
      dummyCodex,
    ],
    { cwd: repoRoot, env },
  );

  assert.equal(await waitForPath(started1, { timeoutMs: 4000, pollMs: 25 }), true);
  const inProgressPath = path.join(busRoot, 'inbox', 'backend', 'in_progress', 't1.md');
  assert.equal(await waitForPath(inProgressPath, { timeoutMs: 4000, pollMs: 25 }), true);
  await fs.appendFile(inProgressPath, '\n\nSENTINEL_UPDATE\n', 'utf8');

  const run = await runPromise;
  assert.equal(run.code, 0, run.stderr || run.stdout);

  const receiptPath = path.join(busRoot, 'receipts', 'backend', 't1.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(receipt.outcome, 'done');
  assert.match(receipt.note, /\bsaw-update\b/);

  const invoked = Number(await fs.readFile(countFile, 'utf8'));
  assert.equal(invoked, 2);
});
