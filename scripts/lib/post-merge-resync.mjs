import childProcess from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function trim(value) {
  return String(value ?? '').trim();
}

function run(cmd, args, { cwd } = {}) {
  const res = childProcess.spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    ok: res.status === 0,
    status: res.status ?? 1,
    stdout: String(res.stdout ?? ''),
    stderr: String(res.stderr ?? ''),
  };
}

function git(cwd, ...args) {
  return run('git', args, { cwd });
}

function gitText(cwd, ...args) {
  const res = git(cwd, ...args);
  if (!res.ok) return '';
  return String(res.stdout || '').trim();
}

async function readJson(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeJsonAtomic(filePath, value) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, filePath);
}

function normalizeAgentBranch(value, name) {
  const raw = trim(value);
  if (raw) return raw;
  return `agent/${name}`;
}

function expandRosterVars(raw, { projectRoot, worktreesDir }) {
  const home = process.env.HOME || os.homedir();
  return String(raw || '')
    .replaceAll('$REPO_ROOT', projectRoot)
    .replaceAll('$AGENTIC_PROJECT_ROOT', projectRoot)
    .replaceAll('$VALUA_REPO_ROOT', projectRoot)
    .replaceAll('$AGENTIC_WORKTREES_DIR', worktreesDir)
    .replaceAll('$VALUA_AGENT_WORKTREES_DIR', worktreesDir)
    .replaceAll('$HOME', home);
}

function hasPrMergeEvidence(text) {
  const value = trim(text);
  if (!value) return false;
  if (/\bnot\s+merged\b/i.test(value)) return false;
  return (
    /\bmerged\s+(?:pr|pull request)\s*#?\d*/i.test(value) ||
    /\bpr\s*#?\d+\s+merged\b/i.test(value) ||
    /\bmerged\b[\s\S]*https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/i.test(value)
  );
}

export function classifyPostMergeResyncTrigger({ taskTitle, taskBody, note, commitSha }) {
  const titleText = trim(taskTitle);
  const bodyText = trim(taskBody);
  const noteText = trim(note);
  const commit = trim(commitSha);
  const mergedInNote = hasPrMergeEvidence(noteText);
  const mergeRequestedInTask = /\bmerge\s+(?:pr|pull request)\s*#?\d*/i.test(
    [titleText, bodyText].filter(Boolean).join('\n'),
  );
  const shouldRun = Boolean(commit && mergedInNote);
  return {
    shouldRun,
    reasonCode: shouldRun
      ? 'pr_merge_detected'
      : (commit ? (mergeRequestedInTask ? 'merge_requested_not_completed' : 'not_pr_merge_completion') : 'missing_commit_sha'),
    mergedInNote,
    mergeRequestedInTask,
    commitShaPresent: Boolean(commit),
  };
}

export function resolvePostMergeResyncTargets({ roster, projectRoot, worktreesDir, excludeAgentName = '' }) {
  const targets = [];
  const agents = Array.isArray(roster?.agents) ? roster.agents : [];
  const excluded = trim(excludeAgentName);
  for (const agent of agents) {
    if (!agent || (agent.kind !== 'codex-worker' && agent.kind !== 'codex-chat')) continue;
    const name = trim(agent.name);
    if (!name) continue;
    if (excluded && name === excluded) continue;

    const branch = normalizeAgentBranch(agent.branch, name);
    const rawWorkdir = trim(agent.workdir);
    const legacyRootWorkdir =
      rawWorkdir === '$REPO_ROOT' ||
      rawWorkdir === '$AGENTIC_PROJECT_ROOT' ||
      rawWorkdir === '$VALUA_REPO_ROOT';
    const candidateWorkdir = !rawWorkdir || legacyRootWorkdir ? `$AGENTIC_WORKTREES_DIR/${name}` : rawWorkdir;
    const expanded = expandRosterVars(candidateWorkdir, { projectRoot, worktreesDir });
    const workdir = path.resolve(expanded);

    targets.push({
      name,
      kind: agent.kind,
      branch,
      workdir,
    });
  }
  return targets;
}

function toIso(value = Date.now()) {
  try {
    return new Date(value).toISOString();
  } catch {
    return new Date().toISOString();
  }
}

async function acquireLock(lockPath) {
  const payload = {
    pid: process.pid,
    host: os.hostname(),
    createdAt: toIso(),
  };
  try {
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(lockPath, `${JSON.stringify(payload)}\n`, { flag: 'wx' });
    return { acquired: true, payload };
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      return { acquired: false, payload: await readJson(lockPath) };
    }
    throw err;
  }
}

async function releaseLock(lockPath) {
  try {
    await fs.unlink(lockPath);
  } catch {
    // Best-effort cleanup.
  }
}

export async function runPostMergeResync({
  projectRoot,
  busRoot,
  rosterPath,
  roster,
  agentName,
  worktreesDir,
}) {
  const startedAt = Date.now();
  const result = {
    attempted: false,
    status: 'skipped',
    reasonCode: 'not_required',
    startedAt: toIso(startedAt),
    completedAt: null,
    durationMs: 0,
    projectRoot: path.resolve(projectRoot || ''),
    originMaster: '',
    lastSyncedOriginMaster: '',
    localMasterUpdated: false,
    repin: {
      attempted: 0,
      updated: 0,
      skipped: 0,
      skippedReasons: [],
      errors: [],
    },
  };

  const finalize = (status, reasonCode) => {
    result.status = status;
    result.reasonCode = reasonCode;
    result.completedAt = toIso();
    result.durationMs = Math.max(0, Date.now() - startedAt);
    return result;
  };

  if (!projectRoot || !busRoot || !roster || !worktreesDir) {
    return finalize('skipped', 'missing_inputs');
  }

  if (!git(projectRoot, 'rev-parse', '--is-inside-work-tree').ok) {
    return finalize('skipped', 'project_not_git_repo');
  }

  const stateDir = path.join(busRoot, 'state', 'post-merge-resync');
  const statePath = path.join(stateDir, `${agentName || 'autopilot'}.json`);
  const lockPath = path.join(stateDir, `${agentName || 'autopilot'}.lock`);

  const lock = await acquireLock(lockPath);
  if (!lock.acquired) {
    result.lock = { busy: true, owner: lock.payload || null };
    return finalize('skipped', 'lock_busy');
  }

  try {
    const previousState = (await readJson(statePath)) || {};
    result.lastSyncedOriginMaster = trim(previousState.lastSyncedOriginMaster);

    const fetched = git(projectRoot, 'fetch', 'origin', 'master');
    if (!fetched.ok) {
      result.repin.errors.push(`fetch failed: ${trim(fetched.stderr) || trim(fetched.stdout) || 'unknown'}`);
      return finalize('needs_review', 'fetch_failed');
    }

    const originMaster = gitText(projectRoot, 'rev-parse', 'origin/master');
    if (!originMaster) {
      result.repin.errors.push('origin/master SHA unavailable after fetch');
      return finalize('needs_review', 'origin_master_unresolved');
    }
    result.originMaster = originMaster;

    if (result.lastSyncedOriginMaster && result.lastSyncedOriginMaster === originMaster) {
      return finalize('skipped', 'already_synced');
    }

    result.attempted = true;

    const updateMaster = git(projectRoot, 'branch', '-f', 'master', 'origin/master');
    if (updateMaster.ok) {
      result.localMasterUpdated = true;
    } else {
      result.repin.errors.push(
        `local master update failed: ${trim(updateMaster.stderr) || trim(updateMaster.stdout) || 'unknown'}`,
      );
    }

    const targets = resolvePostMergeResyncTargets({ roster, projectRoot, worktreesDir, excludeAgentName: agentName });
    for (const target of targets) {
      result.repin.attempted += 1;

      const gitPath = path.join(target.workdir, '.git');
      try {
        await fs.stat(gitPath);
      } catch {
        result.repin.skipped += 1;
        result.repin.skippedReasons.push(`${target.name}:missing_worktree`);
        continue;
      }

      const steps = [
        ['reset', '--hard'],
        ['clean', '-fd'],
        ['checkout', '-B', target.branch, 'origin/master'],
        ['reset', '--hard', 'origin/master'],
        ['clean', '-fd'],
      ];

      let ok = true;
      for (const args of steps) {
        const res = git(target.workdir, ...args);
        if (!res.ok) {
          ok = false;
          result.repin.errors.push(
            `${target.name}:${target.workdir}:${args.join(' ')} failed: ${trim(res.stderr) || trim(res.stdout) || 'unknown'}`,
          );
          break;
        }
      }

      if (ok) {
        result.repin.updated += 1;
      }
    }

    if (result.repin.errors.length > 0) {
      return finalize('needs_review', 'repin_partial_failure');
    }

    await writeJsonAtomic(statePath, {
      agentName: agentName || 'autopilot',
      syncedAt: toIso(),
      lastSyncedOriginMaster: originMaster,
      localMasterUpdated: result.localMasterUpdated,
      repin: {
        attempted: result.repin.attempted,
        updated: result.repin.updated,
        skipped: result.repin.skipped,
      },
      rosterPath: trim(rosterPath) || null,
      projectRoot: path.resolve(projectRoot),
    });

    return finalize('synced', 'synced_to_origin_master');
  } finally {
    await releaseLock(lockPath);
  }
}
