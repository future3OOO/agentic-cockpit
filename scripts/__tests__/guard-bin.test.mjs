import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import childProcess from 'node:child_process';

function execFile(cmd, args, { env, cwd }) {
  return new Promise((resolve) => {
    const proc = childProcess.spawn(cmd, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => (out += d.toString('utf8')));
    proc.stderr.on('data', (d) => (err += d.toString('utf8')));
    proc.on('exit', (code) => resolve({ code, stdout: out, stderr: err }));
  });
}

async function writeExecutable(filePath, contents) {
  await fs.writeFile(filePath, contents, 'utf8');
  await fs.chmod(filePath, 0o755);
}

test('guard-bin: gh blocks pr merge by default', async () => {
  const repoRoot = process.cwd();
  const guardGh = path.join(repoRoot, 'scripts', 'agentic', 'guard-bin', 'gh');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'valua-guard-gh-'));

  const realBinDir = path.join(tmp, 'realbin');
  await fs.mkdir(realBinDir, { recursive: true });
  await writeExecutable(
    path.join(realBinDir, 'gh'),
    '#!/usr/bin/env bash\nset -euo pipefail\necho \"REAL_GH_CALLED $*\"\n',
  );

  const env = {
    ...process.env,
    VALUA_REAL_GH: '',
    VALUA_ORIG_PATH: `${realBinDir}:${process.env.PATH || ''}`,
    PATH: `${path.dirname(guardGh)}:${realBinDir}:${process.env.PATH || ''}`,
  };

  const blocked = await execFile(guardGh, ['pr', 'merge', '123'], { env, cwd: repoRoot });
  assert.equal(blocked.code, 49);
  assert.match(blocked.stderr, /blocked 'gh pr merge'/);

  const blockedApi = await execFile(guardGh, ['api', '/repos/o/r/pulls/123/merge'], { env, cwd: repoRoot });
  assert.equal(blockedApi.code, 49);
  assert.match(blockedApi.stderr, /blocked GitHub PR merge/);

  const blockedGraphql = await execFile(
    guardGh,
    ['api', 'graphql', '-f', 'query=mutation{mergePullRequest(input:{pullRequestId:\"PR\"}){pullRequest{number}}}'],
    { env, cwd: repoRoot },
  );
  assert.equal(blockedGraphql.code, 49);
  assert.match(blockedGraphql.stderr, /blocked GitHub PR merge/);

  const ok = await execFile(guardGh, ['pr', 'view', '123'], { env, cwd: repoRoot });
  assert.equal(ok.code, 0);
  assert.match(ok.stdout, /REAL_GH_CALLED pr view 123/);
});

test('guard-bin: git blocks protected pushes by default', async () => {
  const repoRoot = process.cwd();
  const guardGit = path.join(repoRoot, 'scripts', 'agentic', 'guard-bin', 'git');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'valua-guard-git-'));

  const realBinDir = path.join(tmp, 'realbin');
  await fs.mkdir(realBinDir, { recursive: true });
  await writeExecutable(
    path.join(realBinDir, 'git'),
    '#!/usr/bin/env bash\nset -euo pipefail\necho \"REAL_GIT_CALLED $*\"\n',
  );

  const env = {
    ...process.env,
    VALUA_REAL_GIT: '',
    VALUA_ORIG_PATH: `${realBinDir}:${process.env.PATH || ''}`,
    PATH: `${path.dirname(guardGit)}:${realBinDir}:${process.env.PATH || ''}`,
  };

  const blocked = await execFile(guardGit, ['push', 'origin', 'master'], { env, cwd: repoRoot });
  assert.equal(blocked.code, 49);
  assert.match(blocked.stderr, /blocked 'git push' to protected branch/);

  const ok = await execFile(guardGit, ['push', 'origin', 'agent/frontend'], { env, cwd: repoRoot });
  assert.equal(ok.code, 0);
  assert.match(ok.stdout, /REAL_GIT_CALLED push origin agent\/frontend/);
});
