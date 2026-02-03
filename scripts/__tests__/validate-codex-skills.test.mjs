import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import childProcess from 'node:child_process';

test('validate-codex-skills: all skills are YAML-frontmatter compliant', async () => {
  const repoRoot = process.cwd();
  const scriptPath = path.join(repoRoot, 'scripts', 'validate-codex-skills.mjs');

  // NOTE: In some sandboxed environments, `node` child processes can write to inherited stdio but
  // not reliably to `pipe` stdio. Redirect to files so output is captured deterministically.
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'valua-validate-codex-skills-'));
  const outPath = path.join(tmp, 'stdout.txt');
  const errPath = path.join(tmp, 'stderr.txt');

  const res = await new Promise((resolve, reject) => {
    const cmd = `${process.execPath} '${scriptPath.replace(/'/g, "'\\''")}' > '${outPath}' 2> '${errPath}'`;
    const proc = childProcess.spawn('bash', ['-lc', cmd], { stdio: ['ignore', 'pipe', 'pipe'] });
    proc.on('error', reject);
    proc.on('close', (code) => resolve({ code }));
  });

  const out = await fs.readFile(outPath, 'utf8').catch(() => '');
  const err = await fs.readFile(errPath, 'utf8').catch(() => '');

  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${out}\nstderr:\n${err}`);
  assert.match(out, /OK:/);
});
