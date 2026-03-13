import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import * as agentWorkdir from '../lib/agent-workdir.mjs';

const REPO_ROOT = '/repo/valua';
const RUNTIME_ROOT = '/repo/valua-runtime';
const WORKTREES_DIR = '/repo/worktrees';

// [boundary:canonical]
test('validateDedicatedAgentWorkdir accepts explicit dedicated worktree paths', () => {
  const result = agentWorkdir.validateDedicatedAgentWorkdir({
    agentName: 'daddy-autopilot',
    rawWorkdir: '$AGENTIC_WORKTREES_DIR/daddy-autopilot',
    repoRoot: REPO_ROOT,
    runtimeRoot: RUNTIME_ROOT,
    worktreesDir: WORKTREES_DIR,
  });

  assert.equal(result.ok, true);
  assert.equal(result.resolvedWorkdir, path.resolve('/repo/worktrees/daddy-autopilot'));
});

// [boundary:canonical]
test('validateCodexWorkerDedicatedWorkdir accepts explicit dedicated worktree paths', () => {
  const result = agentWorkdir.validateCodexWorkerDedicatedWorkdir({
    agentName: 'frontend',
    rawWorkdir: '$AGENTIC_WORKTREES_DIR/frontend',
    repoRoot: REPO_ROOT,
    worktreesDir: WORKTREES_DIR,
  });

  assert.equal(result.ok, true);
  assert.equal(result.resolvedWorkdir, path.resolve('/repo/worktrees/frontend'));
});

// [boundary:neighbor-valid]
test('resolveConfiguredAgentWorkdir accepts the Valua worktrees alias as a dedicated worktree', () => {
  const result = agentWorkdir.resolveConfiguredAgentWorkdir('$VALUA_AGENT_WORKTREES_DIR/daddy-autopilot', {
    repoRoot: REPO_ROOT,
    worktreesDir: WORKTREES_DIR,
  });

  assert.equal(result, path.resolve('/repo/worktrees/daddy-autopilot'));
});

// [boundary:neighbor-false-positive]
test('validateDedicatedAgentWorkdir rejects source-root aliases that the worker would resolve to repoRoot', () => {
  const result = agentWorkdir.validateDedicatedAgentWorkdir({
    agentName: 'daddy-autopilot',
    rawWorkdir: '$REPO_ROOT',
    repoRoot: REPO_ROOT,
    runtimeRoot: RUNTIME_ROOT,
    worktreesDir: WORKTREES_DIR,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, 'source_root_alias_or_default');
  assert.equal(result.resolvedWorkdir, path.resolve(REPO_ROOT));
  assert.equal(
    agentWorkdir.resolveWorkerRuntimeWorkdir('$REPO_ROOT', { repoRoot: REPO_ROOT, worktreesDir: WORKTREES_DIR }),
    path.resolve(REPO_ROOT),
  );
});

// [boundary:neighbor-false-positive]
test('validateCodexWorkerDedicatedWorkdir rejects unset or source-root alias workdirs', () => {
  for (const rawWorkdir of ['', '$REPO_ROOT', '$AGENTIC_PROJECT_ROOT', '$VALUA_REPO_ROOT']) {
    const result = agentWorkdir.validateCodexWorkerDedicatedWorkdir({
      agentName: 'frontend',
      rawWorkdir,
      repoRoot: REPO_ROOT,
      worktreesDir: WORKTREES_DIR,
    });

    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, 'source_root_alias_or_default');
    assert.equal(result.resolvedWorkdir, path.resolve(REPO_ROOT));
  }
});

// [boundary:malformed]
test('validateDedicatedAgentWorkdir rejects an unset workdir because the worker would fall back to repoRoot', () => {
  const result = agentWorkdir.validateDedicatedAgentWorkdir({
    agentName: 'daddy-autopilot',
    rawWorkdir: '',
    repoRoot: REPO_ROOT,
    runtimeRoot: RUNTIME_ROOT,
    worktreesDir: WORKTREES_DIR,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, 'source_root_alias_or_default');
  assert.equal(result.resolvedWorkdir, path.resolve(REPO_ROOT));
});

// [boundary:content-bearing]
test('validateDedicatedAgentWorkdir rejects explicit paths outside the worktrees root', () => {
  const result = agentWorkdir.validateDedicatedAgentWorkdir({
    agentName: 'daddy-autopilot',
    rawWorkdir: '/srv/valua/daddy-autopilot',
    repoRoot: REPO_ROOT,
    runtimeRoot: RUNTIME_ROOT,
    worktreesDir: WORKTREES_DIR,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, 'outside_worktrees_root');
  assert.equal(result.resolvedWorkdir, path.resolve('/srv/valua/daddy-autopilot'));
});

// [boundary:platform-or-encoding]
test('resolveConfiguredAgentWorkdir preserves unicode and spaces inside dedicated worktree paths', () => {
  const result = agentWorkdir.resolveConfiguredAgentWorkdir('$AGENTIC_WORKTREES_DIR/daddy café', {
    repoRoot: REPO_ROOT,
    worktreesDir: WORKTREES_DIR,
  });

  assert.equal(result, path.resolve('/repo/worktrees/daddy café'));
});
