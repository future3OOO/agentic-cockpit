import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import childProcess from 'node:child_process';

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

test('agent-codex-worker retries on OpenAI RPM rate limit', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'valua-codex-worker-ratelimit-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const dummyLog = path.join(tmp, 'dummy-codex.log');
  const dummyCount = path.join(tmp, 'dummy-codex.count');

  await writeExecutable(
    dummyCodex,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'log="${DUMMY_CODEX_LOG}"',
      'countFile="${DUMMY_CODEX_COUNT}"',
      'echo "$*" >> "$log"',
      'echo "session id: thread-test" >&2',
      'out=""',
      'for ((i=1; i<=$#; i++)); do',
      '  arg="${!i}"',
      '  if [[ "$arg" == "-o" ]]; then j=$((i+1)); out="${!j}"; fi',
      'done',
      'count=0',
      'if [[ -f "$countFile" ]]; then count="$(cat "$countFile")"; fi',
      'count=$((count+1))',
      'echo "$count" > "$countFile"',
      'if [[ "$count" == "1" ]]; then',
      '  echo \'stream disconnected before completion: Rate limit reached for organization org-test on requests per min (RPM): Limit 3000, Used 3000, Requested 1. Please try again in 1ms.\' >&2',
      '  exit 1',
      'fi',
      'if [[ -n "$out" ]]; then echo \'{"outcome":"done","note":"ok","commitSha":"","followUps":[]}\' > "$out"; fi',
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
    DUMMY_CODEX_LOG: dummyLog,
    DUMMY_CODEX_COUNT: dummyCount,
    VALUA_CODEX_RETRY_BASE_MS: '1',
    VALUA_CODEX_RETRY_MAX_MS: '5',
    VALUA_CODEX_RETRY_JITTER_MS: '0',
    VALUA_CODEX_RATE_LIMIT_MIN_MS: '0',
    VALUA_CODEX_COOLDOWN_JITTER_MS: '0',
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_RATE_LIMIT_STATUS_THROTTLE_MS: '250',
  };

  const run = await spawnProcess(
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
  assert.equal(run.code, 0, run.stderr || run.stdout);

  const log = await fs.readFile(dummyLog, 'utf8');
  const calls = log.trim().split(/\r?\n/).filter(Boolean);
  assert.ok(calls.length >= 2, `expected >=2 codex invocations, got ${calls.length}`);

  const receiptPath = path.join(busRoot, 'receipts', 'backend', 't1.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(receipt.outcome, 'done');

  const processedPath = path.join(busRoot, 'inbox', 'backend', 'processed', 't1.md');
  await fs.stat(processedPath);
});
