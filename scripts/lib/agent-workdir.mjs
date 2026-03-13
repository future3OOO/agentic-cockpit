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

function expandWorkdirVars(rawWorkdir, { repoRoot, worktreesDir }) {
  return expandEnvVars(rawWorkdir, {
    REPO_ROOT: repoRoot,
    AGENTIC_PROJECT_ROOT: repoRoot,
    VALUA_REPO_ROOT: repoRoot,
    AGENTIC_WORKTREES_DIR: worktreesDir,
    VALUA_AGENT_WORKTREES_DIR: worktreesDir,
  });
}

export function resolveConfiguredAgentWorkdir(rawWorkdir, { repoRoot, worktreesDir }) {
  const trimmed = normalizeWorkdir(rawWorkdir);
  if (!trimmed) return null;
  return path.resolve(expandWorkdirVars(trimmed, { repoRoot, worktreesDir }));
}

export function resolveWorkerRuntimeWorkdir(rawWorkdir, { repoRoot, worktreesDir }) {
  return resolveConfiguredAgentWorkdir(rawWorkdir, { repoRoot, worktreesDir }) || path.resolve(repoRoot);
}

export function validateCodexWorkerDedicatedWorkdir({
  agentName,
  rawWorkdir,
  repoRoot,
  worktreesDir,
}) {
  const raw = normalizeWorkdir(rawWorkdir);
  const sourceRoot = path.resolve(repoRoot);
  const resolvedWorkdir = resolveWorkerRuntimeWorkdir(raw, { repoRoot: sourceRoot, worktreesDir });
  const resolvedWorktreesDir = path.resolve(worktreesDir);
  const relativeToWorktrees = path.relative(resolvedWorktreesDir, resolvedWorkdir);
  const isWithinWorktrees =
    relativeToWorktrees !== '' &&
    relativeToWorktrees !== '.' &&
    !relativeToWorktrees.startsWith('..') &&
    !path.isAbsolute(relativeToWorktrees);

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
}) {
  const validation = validateCodexWorkerDedicatedWorkdir({
    agentName,
    rawWorkdir,
    repoRoot,
    worktreesDir,
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
