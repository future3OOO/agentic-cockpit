import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';

function spawnProcess(cmd, args, { cwd, stdinText = null }) {
  return new Promise((resolve) => {
    const proc = childProcess.spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d.toString('utf8')));
    proc.stderr.on('data', (d) => (stderr += d.toString('utf8')));
    proc.on('exit', (code) => resolve({ code, stdout, stderr }));
    if (stdinText != null) proc.stdin.end(stdinText);
    else proc.stdin.end();
  });
}

async function mkTmpDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'agent-bus-cli-test-'));
}

async function writeRosterFile(dir) {
  const rosterPath = path.join(dir, 'ROSTER.json');
  const roster = {
    schemaVersion: 2,
    sessionName: 'test-cockpit',
    orchestratorName: 'daddy-orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'daddy-autopilot',
    agents: [
      { name: 'daddy', kind: 'codex-chat' },
      { name: 'daddy-orchestrator', kind: 'codex-worker' },
      { name: 'daddy-autopilot', kind: 'codex-worker' },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2), 'utf8');
  return rosterPath;
}

test('agent-bus send-text accepts --body values that start with dash', async () => {
  const repoRoot = process.cwd();
  const tmp = await mkTmpDir();
  const rosterPath = await writeRosterFile(tmp);
  const busRoot = path.join(tmp, 'bus');

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-bus.mjs',
      'send-text',
      '--bus-root',
      busRoot,
      '--roster',
      rosterPath,
      '--to',
      'daddy-autopilot',
      '--title',
      'dash body',
      '--body',
      '-starts-with-dash',
    ],
    { cwd: repoRoot },
  );

  assert.equal(run.code, 0, run.stderr || run.stdout);
  const parsed = JSON.parse(run.stdout);
  const taskPath = parsed?.paths?.[0];
  assert.ok(taskPath, run.stdout);
  const taskRaw = await fs.readFile(taskPath, 'utf8');
  assert.match(taskRaw, /-starts-with-dash/);
});

test('agent-bus send-text supports --body-stdin for literal user text', async () => {
  const repoRoot = process.cwd();
  const tmp = await mkTmpDir();
  const rosterPath = await writeRosterFile(tmp);
  const busRoot = path.join(tmp, 'bus');
  const userBody = '$valua-daddy-chat-io\nliteral line\n';

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-bus.mjs',
      'send-text',
      '--bus-root',
      busRoot,
      '--roster',
      rosterPath,
      '--to',
      'daddy-autopilot',
      '--title',
      'stdin body',
      '--body-stdin',
    ],
    { cwd: repoRoot, stdinText: userBody },
  );

  assert.equal(run.code, 0, run.stderr || run.stdout);
  const parsed = JSON.parse(run.stdout);
  const taskPath = parsed?.paths?.[0];
  assert.ok(taskPath, run.stdout);
  const taskRaw = await fs.readFile(taskPath, 'utf8');
  assert.match(taskRaw, /\$valua-daddy-chat-io/);
  assert.match(taskRaw, /literal line/);
});
