# Minimal Plan: Skip No-Code Autopilot Turns Without Weakening Code-Change Gates

## Summary
Implement a narrow runtime change so `daddy-autopilot` does not execute code-quality gate commands on `outcome="done"` turns when there are zero source-code changes.
Code-changing turns keep full strict behavior (including commit-range checks and retries).

Also answering your worktree question: current dirty-cross-root preflight checks only the current worker's `taskCwd` (that agent's own workdir/worktree), not all agents' worktrees.

## Current Behavior Validation (Ground Truth)
- Code-quality gate is required by default for autopilot kinds (`USER_REQUEST,ORCHESTRATOR_UPDATE,EXECUTE`) via `adapters/valua/run.sh:53` and `adapters/valua/run.sh:54`.
- Worker always executes gate when required and outcome is done (`scripts/agent-codex-worker.mjs:5736`).
- The worker already computes source delta before quality validation (`scripts/agent-codex-worker.mjs:5537`).
- Cross-root dirty guard is per-agent:
  - It checks `getGitSnapshot({ cwd: taskCwd })` (`scripts/agent-codex-worker.mjs:5066`).
  - `taskCwd` resolves from that agent's configured `workdir` (`scripts/agent-codex-worker.mjs:4818`, `scripts/agent-codex-worker.mjs:4597`).
  - Root focus marker is per agent name (`scripts/agent-codex-worker.mjs:817`).

## Scope Decisions Locked
- Skip scope: code-quality gate only.
- SkillOps behavior: unchanged in this patch.
- Runtime strictness on code changes: unchanged.
- No new environment flags (keep implementation minimal and deterministic).

## Implementation Spec

### 1) Add no-source fast skip path for autopilot code-quality runtime validation
File: `scripts/agent-codex-worker.mjs`

At the code-quality validation section:
- Condition for skip:
  - `isAutopilot === true`
  - `codeQualityGate.required === true`
  - `outcome === "done"`
  - `sourceCodeChanged === false` (from existing `sourceDelta`)
- Behavior when condition is true:
  - Do not call `runCodeQualityGateCheck(...)`.
  - Produce synthetic runtime evidence with:
    - `required: true`
    - `executed: false`
    - `scopeMode: "no_code_change"`
    - `skippedReason: "no_source_change"`
    - `taskKind`, `requiredKinds`, `retryCount`, include/exclude scope rules preserved
    - `baseRefUsed` populated consistently
    - `sourceFilesSeenCount: 0`
    - `artifactOnlyChange` from existing `sourceDelta.artifactOnlyChange`
    - `changedFilesSample` from `sourceDelta.changedFiles` (bounded to current sample size policy)
  - Mark validation `ok: true`, `errors: []`.

### 2) Skip qualityReview requirement on the same no-source path
File: `scripts/agent-codex-worker.mjs`

In the `qualityReviewValidation` branch:
- For the same no-source skip condition above, do not run `validateCodeQualityReviewEvidence(...)`.
- Emit evidence:
  - `required: true`
  - `present: false`
  - `skippedReason: "no_source_change"`
  - `hardRuleChecks` default object retained for shape compatibility
- Validation result is `ok: true`, `errors: []`.

This avoids false blocking/retries when no source code exists to validate.

### 3) Tighten operator prompt text (guidance only, no policy expansion)
File: `scripts/agent-codex-worker.mjs` (`buildCodeQualityGatePromptBlock`)

Add one explicit line:
- If no source files changed this turn, runtime may skip code-quality execution and will mark `no_source_change`.

Purpose: reduce unnecessary command execution by the model while keeping runtime authoritative.

### 4) Keep SkillOps untouched
- No changes to `deriveSkillOpsGate`, SkillOps prompt block, or SkillOps evidence validation in this patch.

## Public Interfaces / Contract Impact
- No schema file changes required.
- Runtime receipt semantics update:
  - `receiptExtra.runtimeGuard.codeQualityGate.executed` may be `false` on autopilot done turns with no source changes.
  - `receiptExtra.runtimeGuard.codeQualityGate.skippedReason` adds/uses `"no_source_change"` in this path.
- Existing fields and types remain unchanged.

## Test Plan

### Update/Add tests in `scripts/__tests__/codex-worker-autopilot-context.test.mjs`
1. `no-source done turn skips code-quality execution`
- Setup autopilot task with gate enabled and no source changes.
- Model output omits `qualityReview`.
- Expected:
  - task closes `done`
  - `runtimeGuard.codeQualityGate.required === true`
  - `runtimeGuard.codeQualityGate.executed === false`
  - `runtimeGuard.codeQualityGate.skippedReason === "no_source_change"`
  - no code-quality retry happened.

2. `source-changing done turn still enforces qualityReview`
- Setup autopilot task where source delta is non-zero (commit-backed or deterministic source modification in test repo fixture).
- Omit `qualityReview` on first attempt, provide it on retry.
- Expected:
  - retry path still triggers
  - missing-qualityReview reason code remains enforced
  - final pass only with valid qualityReview.

### Regression checks
Run:
- `scripts/__tests__/codex-worker-autopilot-context.test.mjs`
- `scripts/__tests__/codex-worker-app-server.test.mjs`
- `scripts/__tests__/code-quality-gate.test.mjs`

Acceptance:
- Existing code-changing strict checks remain green.
- New no-source autopilot path passes without gate command execution.

## Edge Cases
- If outcome is not `done`: existing skip-by-outcome behavior remains unchanged.
- If source delta detection fails unexpectedly: fail closed with existing behavior (execute gate).
- `EXECUTE` tasks with real source changes are unaffected.

## Assumptions and Defaults
- "No-code turn" means `sourceDelta.sourceFilesCount === 0` using existing exclusion rules.
- Scope limited to autopilot to avoid changing non-autopilot enforcement semantics in this minimal patch.
- SkillOps optimization is intentionally deferred to a separate change set.
