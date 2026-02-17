#!/usr/bin/env node

import { parseArgs } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import childProcess from 'node:child_process';
import { getRepoRoot, loadRoster } from '../lib/agentbus.mjs';

const SINGLE_FILES = [
  'AGENTS.md',
  '.codex/README.md',
  'docs/agentic/BLUEPRINT.md',
  'docs/agentic/agent-bus/ROSTER.json',
];

const RECURSIVE_DIRS = [
  '.codex/skills',
  'docs/runbooks',
];

const LEGACY_ROOT_WORKDIRS = new Set(['$REPO_ROOT', '$AGENTIC_PROJECT_ROOT', '$VALUA_REPO_ROOT']);

/**
 * Helper for expand workdir used by the cockpit workflow runtime.
 */
function expandWorkdir(raw, { repoRoot, worktreesDir }) {
  const s = String(raw ?? '').trim();
  if (!s) return repoRoot;

  if (LEGACY_ROOT_WORKDIRS.has(s)) return repoRoot;

  return s
    .replaceAll('$REPO_ROOT', repoRoot)
    .replaceAll('$AGENTIC_PROJECT_ROOT', repoRoot)
    .replaceAll('$VALUA_REPO_ROOT', repoRoot)
    .replaceAll('$AGENTIC_WORKTREES_DIR', worktreesDir)
    .replaceAll('$VALUA_AGENT_WORKTREES_DIR', worktreesDir)
    .replaceAll('$HOME', os.homedir());
}

/**
 * Helper for path exists used by the cockpit workflow runtime.
 */
async function pathExists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Lists files recursive from available sources.
 */
async function listFilesRecursive(rootAbs, relPrefix) {
  if (!(await pathExists(rootAbs))) return [];
  const out = [];
  const stack = [rootAbs];
  while (stack.length > 0) {
    const dir = stack.pop();
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const relFromRoot = path.join(relPrefix, path.relative(rootAbs, abs));
      out.push(relFromRoot.split(path.sep).join('/'));
    }
  }
  out.sort();
  return out;
}

/**
 * Helper for collect canonical policy files used by the cockpit workflow runtime.
 */
async function collectCanonicalPolicyFiles(repoRoot) {
  const files = new Set();

  for (const rel of SINGLE_FILES) {
    const abs = path.join(repoRoot, rel);
    if (await pathExists(abs)) files.add(rel);
  }

  for (const dirRel of RECURSIVE_DIRS) {
    const abs = path.join(repoRoot, dirRel);
    const nested = await listFilesRecursive(abs, dirRel);
    for (const rel of nested) files.add(rel);
  }

  return Array.from(files).sort();
}

/**
 * Helper for collect dirty tracked paths in worktree used by the cockpit workflow runtime.
 */
function collectDirtyTrackedPathsInWorktree(workdir) {
  try {
    const output = childProcess.execFileSync(
      'git',
      ['-C', workdir, 'status', '--porcelain=v1', '-z', '--untracked-files=no'],
      {
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf8',
      },
    );
    const dirty = new Set();
    const records = String(output ?? '').split('\0').filter(Boolean);
    for (let i = 0; i < records.length; i += 1) {
      const record = records[i];
      if (!record || record.length < 4) continue;
      const x = record[0];
      const pathOne = record.slice(3);
      if (pathOne) dirty.add(pathOne.split(path.sep).join('/'));

      // In porcelain -z mode, renames/copies carry a second NUL-terminated path.
      if (x === 'R' || x === 'C') {
        const pathTwo = records[i + 1] || '';
        if (pathTwo) dirty.add(pathTwo.split(path.sep).join('/'));
        i += 1;
      }
    }
    return dirty;
  } catch {
    // If this is not a git repo/worktree, best effort: treat as clean.
    return new Set();
  }
}

/**
 * Helper for unique used by the cockpit workflow runtime.
 */
function unique(values) {
  return Array.from(new Set(values));
}

/**
 * Resolves target workdirs using current runtime context.
 */
async function resolveTargetWorkdirs({ roster, repoRoot, worktreesDir }) {
  const targets = [];

  for (const agent of roster.agents ?? []) {
    const kind = String(agent?.kind ?? '').trim();
    if (kind !== 'codex-worker' && kind !== 'codex-chat') continue;

    const name = String(agent?.name ?? '').trim();
    if (!name) continue;

    const raw = String(agent?.workdir ?? '').trim();
    const expanded = expandWorkdir(raw, { repoRoot, worktreesDir });
    const resolved = path.resolve(expanded || repoRoot);
    if (resolved === repoRoot) continue;
    targets.push(resolved);
  }

  return unique(targets);
}

/**
 * Helper for sync into workdir used by the cockpit workflow runtime.
 */
async function syncIntoWorkdir({
  repoRoot,
  workdir,
  files,
  dryRun,
  verbose,
}) {
  const stat = {
    workdir,
    updated: 0,
    unchanged: 0,
    created: 0,
    skippedDirty: 0,
    missingSource: 0,
  };
  const dirtyTrackedPaths = collectDirtyTrackedPathsInWorktree(workdir);

  for (const rel of files) {
    const src = path.join(repoRoot, rel);
    const dst = path.join(workdir, rel);

    if (!(await pathExists(src))) {
      stat.missingSource += 1;
      continue;
    }

    const srcBuf = await fs.readFile(src);
    const dstExists = await pathExists(dst);
    if (dstExists) {
      const dstBuf = await fs.readFile(dst);
      if (Buffer.compare(srcBuf, dstBuf) === 0) {
        stat.unchanged += 1;
        continue;
      }
    }

    if (dirtyTrackedPaths.has(rel)) {
      stat.skippedDirty += 1;
      if (verbose) {
        process.stderr.write(`WARN: policy sync skipped dirty file in ${workdir}: ${rel}\n`);
      }
      continue;
    }

    if (!dryRun) {
      await fs.mkdir(path.dirname(dst), { recursive: true });
      await fs.writeFile(dst, srcBuf);
      if (dstExists) {
        stat.updated += 1;
      } else {
        stat.created += 1;
      }
    } else if (dstExists) {
      stat.updated += 1;
    } else {
      stat.created += 1;
    }
  }

  return stat;
}

/**
 * CLI entrypoint for this script.
 */
async function main() {
  const { values } = parseArgs({
    options: {
      'repo-root': { type: 'string' },
      roster: { type: 'string' },
      'worktrees-dir': { type: 'string' },
      'dry-run': { type: 'boolean' },
      verbose: { type: 'boolean' },
    },
  });

  const repoRoot = path.resolve(values['repo-root'] || getRepoRoot());
  const worktreesDir = path.resolve(
    values['worktrees-dir'] ||
      process.env.AGENTIC_WORKTREES_DIR ||
      process.env.VALUA_AGENT_WORKTREES_DIR ||
      path.join(os.homedir(), '.agentic-cockpit', 'worktrees'),
  );
  const dryRun = Boolean(values['dry-run']);
  const verbose = Boolean(values.verbose);

  const rosterInfo = await loadRoster({ repoRoot, rosterPath: values.roster || null });
  const roster = rosterInfo.roster;

  const files = await collectCanonicalPolicyFiles(repoRoot);
  const workdirs = await resolveTargetWorkdirs({ roster, repoRoot, worktreesDir });

  let scanned = 0;
  let synced = 0;
  const totals = {
    updated: 0,
    unchanged: 0,
    created: 0,
    skippedDirty: 0,
    missingSource: 0,
  };

  for (const workdir of workdirs) {
    scanned += 1;
    if (!(await pathExists(workdir))) {
      if (verbose) process.stderr.write(`WARN: policy sync skipped missing workdir: ${workdir}\n`);
      continue;
    }
    synced += 1;
    const s = await syncIntoWorkdir({ repoRoot, workdir, files, dryRun, verbose });
    totals.updated += s.updated;
    totals.unchanged += s.unchanged;
    totals.created += s.created;
    totals.skippedDirty += s.skippedDirty;
    totals.missingSource += s.missingSource;
  }

  const mode = dryRun ? 'dry-run' : 'apply';
  process.stdout.write(
    `policy-sync mode=${mode} repo=${repoRoot} scannedWorkdirs=${scanned} syncedWorkdirs=${synced} files=${files.length} created=${totals.created} updated=${totals.updated} unchanged=${totals.unchanged} skippedDirty=${totals.skippedDirty}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`ERROR: ${(err && err.stack) || String(err)}\n`);
  process.exit(1);
});
