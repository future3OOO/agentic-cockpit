import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import childProcess from 'node:child_process';

function exec(cmd, args, { cwd, env } = {}) {
  const res = childProcess.spawnSync(cmd, args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (res.status !== 0) {
    throw new Error(
      `Command failed: ${cmd} ${args.join(' ')}\n` + (res.stderr || res.stdout || ''),
    );
  }
  return res.stdout.trim();
}

async function writeJson(p, value) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

test('setup-worktrees: defaults branch/workdir for codex-worker agents', async () => {
  const cockpitRoot = process.cwd();
  const scriptPath = path.join(cockpitRoot, 'scripts', 'agentic', 'setup-worktrees.sh');

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-setup-worktrees-'));
  const repoRoot = path.join(tmp, 'repo');
  const worktreesDir = path.join(tmp, 'worktrees');
  await fs.mkdir(repoRoot, { recursive: true });

  try {
    exec('git', ['init', '-b', 'main'], { cwd: repoRoot });
  } catch {
    exec('git', ['init'], { cwd: repoRoot });
    exec('git', ['checkout', '-b', 'main'], { cwd: repoRoot });
  }
  exec('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot });
  exec('git', ['config', 'user.name', 'Test'], { cwd: repoRoot });
  await fs.writeFile(path.join(repoRoot, 'README.md'), 'hello\n', 'utf8');
  exec('git', ['add', 'README.md'], { cwd: repoRoot });
  exec('git', ['commit', '-m', 'init'], { cwd: repoRoot });

  const rosterPath = path.join(repoRoot, 'docs', 'agentic', 'agent-bus', 'ROSTER.json');
  await writeJson(rosterPath, {
    schemaVersion: 2,
    sessionName: 'test',
    agents: [
      {
        name: 'autopilot',
        kind: 'codex-worker',
        // Intentionally omit branch/workdir; script must default them.
        startCommand: 'true',
        skills: [],
      },
    ],
  });

  const env = {
    ...process.env,
    AGENTIC_WORKTREES_DIR: worktreesDir,
  };

  exec('bash', [scriptPath, '--roster', rosterPath], { cwd: repoRoot, env });

  const autopilotWt = path.join(worktreesDir, 'autopilot');
  await fs.stat(autopilotWt);

  const branch = exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: autopilotWt, env });
  assert.equal(branch, 'agent/autopilot');

  exec('git', ['show-ref', '--verify', '--quiet', 'refs/heads/agent/autopilot'], { cwd: repoRoot, env });
});
