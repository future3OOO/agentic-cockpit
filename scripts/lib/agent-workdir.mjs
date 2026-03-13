import path from 'node:path';

import { expandEnvVars } from './agentbus.mjs';

const SOURCE_ROOT_WORKDIR_ALIASES = new Set([
  '$REPO_ROOT',
  '$AGENTIC_PROJECT_ROOT',
  '$VALUA_REPO_ROOT',
]);

function normalizeWorkdir(rawWorkdir) {
  return typeof rawWorkdir === 'string' ? rawWorkdir.trim() : '';
}

export function isSourceRootWorkdirAlias(rawWorkdir) {
  return SOURCE_ROOT_WORKDIR_ALIASES.has(normalizeWorkdir(rawWorkdir));
}

export function resolveWorktreesRoots({ worktreesDir, agenticWorktreesDir, valuaWorktreesDir }) {
  const resolvedAgenticWorktreesDir = path.resolve(agenticWorktreesDir || worktreesDir);
  const resolvedValuaWorktreesDir = path.resolve(
    valuaWorktreesDir || agenticWorktreesDir || worktreesDir,
  );
  return {
    agenticWorktreesDir: resolvedAgenticWorktreesDir,
    valuaWorktreesDir: resolvedValuaWorktreesDir,
  };
}

export function resolveWorkdirOptions(options) {
  const repoRoot = options.repoRoot;
  const worktreesRoots = resolveWorktreesRoots(options);
  return {
    repoRoot,
    worktreesDir: worktreesRoots.agenticWorktreesDir,
    agenticWorktreesDir: worktreesRoots.agenticWorktreesDir,
    valuaWorktreesDir: worktreesRoots.valuaWorktreesDir,
    worktreesRoots,
  };
}

function expandWorkdirVars(rawWorkdir, { repoRoot, worktreesDir, agenticWorktreesDir, valuaWorktreesDir }) {
  const { worktreesRoots } = resolveWorkdirOptions({
    repoRoot,
    worktreesDir,
    agenticWorktreesDir,
    valuaWorktreesDir,
  });
  return expandEnvVars(rawWorkdir, {
    REPO_ROOT: repoRoot,
    AGENTIC_PROJECT_ROOT: repoRoot,
    VALUA_REPO_ROOT: repoRoot,
    AGENTIC_WORKTREES_DIR: worktreesRoots.agenticWorktreesDir,
    VALUA_AGENT_WORKTREES_DIR: worktreesRoots.valuaWorktreesDir,
  });
}

export function resolveConfiguredAgentWorkdir(rawWorkdir, { repoRoot, worktreesDir, agenticWorktreesDir, valuaWorktreesDir }) {
  const trimmed = normalizeWorkdir(rawWorkdir);
  if (!trimmed) return null;
  return path.resolve(
    expandWorkdirVars(trimmed, { repoRoot, worktreesDir, agenticWorktreesDir, valuaWorktreesDir }),
  );
}

export function resolveWorkerRuntimeWorkdir(rawWorkdir, { repoRoot, worktreesDir, agenticWorktreesDir, valuaWorktreesDir }) {
  return (
    resolveConfiguredAgentWorkdir(rawWorkdir, {
      repoRoot,
      worktreesDir,
      agenticWorktreesDir,
      valuaWorktreesDir,
    }) || path.resolve(repoRoot)
  );
}

export function validateCodexWorkerDedicatedWorkdir({
  agentName,
  rawWorkdir,
  repoRoot,
  worktreesDir,
  agenticWorktreesDir,
  valuaWorktreesDir,
}) {
  const raw = normalizeWorkdir(rawWorkdir);
  const sourceRoot = path.resolve(repoRoot);
  const { worktreesRoots } = resolveWorkdirOptions({
    repoRoot: sourceRoot,
    worktreesDir,
    agenticWorktreesDir,
    valuaWorktreesDir,
  });
  const resolvedWorkdir = resolveWorkerRuntimeWorkdir(raw, {
    repoRoot: sourceRoot,
    worktreesDir,
    agenticWorktreesDir: worktreesRoots.agenticWorktreesDir,
    valuaWorktreesDir: worktreesRoots.valuaWorktreesDir,
  });
  const isWithinWorktrees = [worktreesRoots.agenticWorktreesDir, worktreesRoots.valuaWorktreesDir].some(
    (resolvedWorktreesDir) => {
      const relativeToWorktrees = path.relative(resolvedWorktreesDir, resolvedWorkdir);
      return (
        relativeToWorktrees !== '' &&
        relativeToWorktrees !== '.' &&
        !relativeToWorktrees.startsWith('..') &&
        !path.isAbsolute(relativeToWorktrees)
      );
    },
  );

  if (!raw || isSourceRootWorkdirAlias(raw) || resolvedWorkdir === sourceRoot) {
    return {
      ok: false,
      reasonCode: 'source_root_alias_or_default',
      agentName,
      rawWorkdir: raw,
      resolvedWorkdir,
    };
  }
  if (!isWithinWorktrees) {
    return {
      ok: false,
      reasonCode: 'outside_worktrees_root',
      agentName,
      rawWorkdir: raw,
      resolvedWorkdir,
    };
  }
  return {
    ok: true,
    reasonCode: '',
    agentName,
    rawWorkdir: raw,
    resolvedWorkdir,
  };
}

export function validateDedicatedAgentWorkdir({
  agentName,
  rawWorkdir,
  repoRoot,
  runtimeRoot,
  worktreesDir,
  agenticWorktreesDir,
  valuaWorktreesDir,
}) {
  const validation = validateCodexWorkerDedicatedWorkdir({
    agentName,
    rawWorkdir,
    repoRoot,
    worktreesDir,
    agenticWorktreesDir,
    valuaWorktreesDir,
  });
  if (!validation.ok) return validation;
  const resolvedWorkdir = validation.resolvedWorkdir;
  const resolvedRuntimeRoot = path.resolve(runtimeRoot);
  if (resolvedWorkdir === resolvedRuntimeRoot) {
    return {
      ok: false,
      reasonCode: 'runtime_root',
      agentName,
      rawWorkdir: validation.rawWorkdir,
      resolvedWorkdir,
    };
  }
  return {
    ok: true,
    reasonCode: '',
    agentName,
    rawWorkdir: validation.rawWorkdir,
    resolvedWorkdir,
  };
}
