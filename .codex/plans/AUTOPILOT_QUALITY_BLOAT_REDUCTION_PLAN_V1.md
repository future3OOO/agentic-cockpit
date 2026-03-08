# Autopilot Quality + Bloat Reduction Plan (Decision-Complete, Minimal-Change)

## 1. Goal

1. Remove low-signal restart/reconsult churn in autopilot turns.
2. Preserve correctness and safety gates while reducing context/token waste.
3. Ensure Opus advice is fully visible and consumed without brittle over-enforcement.
4. Keep implementation minimal and deterministic.

## 2. Current Baseline (Validated)

1. Mid-task updates force codex restart and clear pre-exec consult cache.
2. ORCHESTRATOR_UPDATE is currently broadly eligible for consult and can over-trigger consult loops.
3. Blocked execute receipts can carry commit SHAs but may skip review-targeting.
4. Follow-ups can inherit stale integration branch refs from parent/source packet lineage.
5. Opus auth failures (Claude 401 expired token) are being misclassified as `opus_schema_invalid`.

## 3. Scope

## 3.1 Runtime files

1. `scripts/agent-codex-worker.mjs`
2. `scripts/agent-orchestrator-worker.mjs`
3. `scripts/agent-opus-consult-worker.mjs`
4. `scripts/lib/opus-client.mjs`

## 3.2 Tests

1. `scripts/__tests__/codex-worker-autopilot-context.test.mjs`
2. `scripts/__tests__/codex-worker-app-server.test.mjs`
3. `scripts/__tests__/codex-worker-output-schema.test.mjs`
4. `scripts/__tests__/agent-orchestrator-worker.test.mjs`
5. `scripts/__tests__/agent-opus-consult-worker.test.mjs`

## 4. Implementation

## 4.1 Correctness-first fixes

1. Fix Opus auth classification:
   - classify Claude CLI auth-expired and auth-missing failures as auth/transport (`opus_auth_invalid`), not schema.
2. Keep review gate coverage for commit-bearing blocked receipts:
   - if execute receipt carries `commitSha`, preserve review targeting path.
3. Stop stale branch inheritance in follow-up routing:
   - when building follow-up branch context, prefer explicit current task branch and reject unrelated inherited branch refs.
4. Make Opus disposition accounting truthful:
   - only require dispositions for actionable advisory items surfaced to autopilot.

## 4.2 Performance and bloat reduction

1. Consult scope narrowing on digests:
   - ORCHESTRATOR_UPDATE consult only for critical digest classes (merge-close, review-close, integration-critical).
2. Thin-context warm loop:
   - for supersede updates in same root/task intent, rebuild minimal delta context (not full skill/runbook re-injection every time).
3. Semantic pre-exec consult cache:
   - invalidate cache only on meaningful task-shape changes (intent, target PR/branch, blocking evidence delta), not every update timestamp.
4. SkillOps gating on digest loops:
   - run heavy SkillOps checks on critical-only digest paths; preserve full behavior on root completion and code-changing turns.

## 5. Contract decisions (No protocol churn)

1. No new packet kinds.
2. No JSON schema shape expansion for agent bus packets.
3. Behavior changes are runtime gating/routing only.
4. Advisory remains non-blocking by default unless explicit gate mode is configured.

## 6. Acceptance Matrix

## 6.1 Consult and update behavior

1. Mid-task update with non-critical digest:
   - expected: no consult restart loop; thin context path; no full skills re-injection.
2. Mid-task update with critical digest:
   - expected: consult runs once with current context and no stale cache reuse.
3. Consecutive supersedes with unchanged task intent:
   - expected: pre-exec consult cache reused.
4. Supersede with changed intent/PR/branch:
   - expected: consult cache invalidated and recomputed.

## 6.2 Review and follow-up correctness

1. Blocked execute receipt containing `commitSha`:
   - expected: review targeting still created.
2. Follow-up generated from packet lineage with stale integration branch:
   - expected: stale branch rejected; branch resolves to current explicit task branch or safe default.

## 6.3 Opus failure handling

1. Claude 401 expired token during consult:
   - expected: `opus_auth_invalid` classification, advisory-safe handling, accurate receipt reason code.
2. Non-auth malformed payload:
   - expected: `opus_schema_invalid` remains unchanged.

## 6.4 Bounded retries and output quality

1. Advisory items count > 0 and actionable:
   - expected: corresponding dispositions present.
2. Advisory items non-actionable/meta only:
   - expected: no false missing-disposition retry spam.

## 7. Rollout sequence

1. Apply correctness fixes (Section 4.1).
2. Add/adjust tests for corrected classifications and follow-up/review routing.
3. Apply performance changes (Section 4.2).
4. Run targeted test suite, then changed-suite run.
5. Validate in live cockpit with one non-critical update loop and one critical merge/review flow.

## 8. Non-goals

1. No redesign of AgentBus protocol.
2. No new enforcement schema for Opus advisory payloads.
3. No changes to merge policy semantics outside current safety rules.

## 9. Default policy values

1. Consult scope for ORCHESTRATOR_UPDATE: critical-only.
2. SkillOps on digest loops: critical-only.
3. Blocked execute with commit SHA: review after correct slice.

## 10. Done criteria

1. No repeated full-context re-injection on thin supersede updates.
2. No false `opus_schema_invalid` for auth errors.
3. No commit-bearing blocked receipt that bypasses review-targeting.
4. No stale inherited integration branch in follow-up packets.
5. Advisory disposition retries occur only for truly actionable missing items.
