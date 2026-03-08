## SkillOps Auto-Curation Plan V4.14-lite (Phase 1, Minimal-Risk)

### 1. Summary
1. Remove `distill`/`lint` from the per-task autopilot hot path.
2. Keep only debrief/log correctness checks at task closure.
3. Enforce ownership in cockpit: when running via adapter, SkillOps commands/log semantics are project-owned (active `AGENTIC_PROJECT_ROOT` / worker `cwd`), not cockpit-owned.
4. Run all distill/lint/commit/push in one dedicated curation flow on `agent/skillops-curation`.
5. Use one simple lock with PID+fingerprint identity; if busy, skip with `warn` and retry next cycle.
6. Enforce `processed` only on real promoted delta via explicit post-distill reconciliation (do not rely on current `skillops.mjs` processed semantics).
7. Bind hot-path log artifacts to the current task/root turn to prevent stale-path reuse.
8. Keep curation branch append-only (no reset-to-base) to avoid unmerged learning loss.
9. Preserve `agent/skillops-curation` in branch hygiene.
10. Enforce post-merge ordering: SkillOps harvest + curation must run before any force-repin of agent worktrees.

### 2. Baseline Policy (implementation-time, non-static)
1. Static commit pins are intentionally omitted from this plan.
2. Implementation PR must record actual `agentic-cockpit` and project-repo base SHAs at implementation start.
3. Line references from reviews are advisory and must be revalidated against current working HEAD.

### 3. Scope

### 3.1 Cockpit repo
1. `scripts/agent-codex-worker.mjs`
2. New lightweight helper: `scripts/lib/skillops-curation-lite.mjs`
3. Tests:
`scripts/__tests__/codex-worker-skillops-gate-lite.test.mjs`
`scripts/__tests__/skillops-curation-lite.test.mjs`
4. Docs:
`docs/agentic/agent-bus/PROTOCOL.md`
`docs/agentic/BLUEPRINT.md`
`docs/agentic/AUTOPILOT_RUNTIME_FLOW.md`
`docs/runbooks/TMUX.md`

### 3.2 Valua repo
1. `scripts/skillops.mjs` (primary runtime target for debrief linkage fields in adapter mode)
2. `scripts/__tests__/skillops.test.mjs`
3. `scripts/branch_hygiene.mjs`
4. `scripts/__tests__/branch_hygiene.test.mjs`
5. `docs/runbooks/WORKTREES_AND_BRANCHING.md`
6. `docs/runbooks/TMUX.md`

### 3.3 Cockpit parity (secondary)
1. `scripts/skillops.mjs` (parity only for non-adapter/local cockpit usage)
2. `scripts/__tests__/skillops.test.mjs`
3. `docs/runbooks/WORKTREES_AND_BRANCHING.md`
4. `docs/runbooks/TMUX.md`

### 4. Runtime Decisions (Phase 1)

### 4.0 Ownership contract (strict, cockpit-enforced)
1. Cockpit gate derives the active project root from worker runtime context (`cwd` + `AGENTIC_PROJECT_ROOT`).
2. In adapter mode, SkillOps command contract and log semantics are sourced from the active project repo (Valua in this deployment).
3. Cockpit must not assume its own `scripts/skillops.mjs` semantics when worker `cwd` points to a project worktree.
4. Same enforcement applies for any future adapter project: project-owned SkillOps semantics, cockpit-owned orchestration.

### 4.1 Hot-path closure gate (autopilot)
1. Required evidence on task closure:
`testsToRun` includes `scripts/skillops.mjs debrief`.
`artifacts` includes a resolvable `.codex/skill-ops/logs/*.md` path.
2. New required content check:
every task must produce debrief evidence, including docs/policy-only tasks.
closure passes when log contains either:
- at least one non-empty, sanitized `skill_updates` bullet, or
- exact sentinel bullet `NO_NOVEL_LEARNING: docs_policy_only`.
sentinel is valid only when it appears as an exact frontmatter `skill_updates` entry value; occurrences in narrative/body text do not satisfy closure.
sentinel-only logs are valid closure evidence but are classified as `no_contentful_updates` during curation.
3. Required linkage check (anti-stale-path):
log frontmatter `source_task_id` must equal current task id,
log frontmatter `source_root_id` must equal current root id,
`created_at` must satisfy:
- `created_at >= taskAcceptedAt - clockSkewMs`
- `created_at <= taskClosedAt + clockSkewMs`
- `(taskClosedAt - created_at) <= maxLogAgeMs`
defaults: `clockSkewMs=300000` (5 min), `maxLogAgeMs=21600000` (6 h).
4. Implementation note for linkage:
extend project-owned `scripts/skillops.mjs debrief` (Valua primary) to accept `--source-task-id` and `--source-root-id` and persist them in frontmatter.
maintain cockpit `scripts/skillops.mjs` parity as secondary follow-up for non-adapter runs.
5. Removed from hot path:
no requirement to run `distill`.
no requirement to run `lint`.
6. If content/linkage check fails: fail closure with `skillops_gate_failed` and explicit reason.

### 4.2 Dedicated curation flow
1. Single branch/worktree target: `agent/skillops-curation`.
2. Trigger: deterministic once-per-root-cycle attempt in autopilot done-path, after all closure gates pass and before final `closeTask(...)` emission (never on every `ORCHESTRATOR_UPDATE` digest).
3. Trigger guard: max one curation attempt per `rootId` lifecycle (idempotency key persisted in runtime state).
4. Batch steps:
acquire curation lock,
resolve base ref in order: env override -> `origin/HEAD` -> `origin/main` -> `origin/master`,
`git fetch origin <resolvedBaseBranch> agent/skillops-curation`,
checkout curation branch from `origin/agent/skillops-curation` when it exists; otherwise create it from resolved base,
never reset curation branch to base on subsequent runs (append-only branch model),
collect candidate logs with normalized status `new|pending` (canonical write-back remains `new|processed|failed` in runtime model),
run `node scripts/skillops.mjs distill` then `node scripts/skillops.mjs lint`,
if distill or lint fails:
- rollback curation worktree to pre-run HEAD (`git reset --hard <preRunHead>` + `git clean -fd`),
- do not persist terminal log status changes from this run,
- mark curation attempt `warn` and keep candidate logs replayable as `new`,
run post-distill status reconciliation wrapper:
- compute promoted deltas per log (`[src:<logId>]` additions and/or archive append lines),
- force logs without promoted delta to `failed/no_contentful_updates`,
- keep only logs with promoted delta as `processed`,
commit only if diff exists,
push policy: `git push origin agent/skillops-curation` (fast-forward only, no force),
on non-fast-forward push rejection: perform exactly one auto-reconcile attempt (`git fetch origin agent/skillops-curation` + `git rebase origin/agent/skillops-curation` + single push retry),
if rebase conflicts or retry push still rejects: rollback curation worktree to pre-run HEAD, emit `warn/needs_review`, and leave candidate logs replayable on next run,
status finalization rule: treat `processed/failed` as final only after successful push.

### 4.3 Minimal coordination
1. One lock file: `${busRoot}/state/skillops-curation.lock`.
2. No heartbeat and no scheduler in phase 1.
3. Lock identity payload includes:
`host`, `pid`, `procStartTime`, `cmdlineHash`, `createdAt`.
4. Lock behavior:
if lock host matches current host and lock PID is alive and process fingerprint (`procStartTime` + `cmdlineHash`) matches, treat as active and skip with `warn`,
if lock host matches current host and PID is dead or fingerprint mismatch (PID reuse), treat as stale and remove,
if lock host differs (or host unknown), use age-only fallback: stale when age > TTL, otherwise skip with `warn`.
5. Default lock TTL: 15 minutes.

### 4.4 Correctness check for processed vs failed
1. A log is `processed` only if curation observes a real promoted delta tied to that log (`[src:<logId>]` in learned block or archive append).
2. A log without promoted delta is `failed` with `reasonCode=no_contentful_updates` (including sentinel-only logs and contentful-but-duplicate logs).
3. No per-entry retry scheduler in phase 1; failed logs are terminal until user/manual edit creates new content.
4. Implementation note:
phase-1 must include explicit status reconciliation (wrapper or `skillops.mjs` patch); plain `distill` behavior alone is insufficient.
5. Status dialect compatibility:
ingest parser accepts both `status: new` and legacy `status: pending`; normalization must be deterministic and lossless.
normalization (`pending` -> `new`) happens before status validation in curation ingestion.
6. Canonical status contract implementation:
project-owned `scripts/skillops.mjs` (Valua primary) and cockpit parity script must both accept `status: new|processed|failed` in lint/parser paths.

### 4.5 Batch semantics
1. Phase 1 uses one batch run.
2. If batch distill/lint fails, enforce explicit rollback to pre-run HEAD + clean, mark curation run `warn`, and keep candidate logs replayable as `new` (except logs already deterministically classified as `no_contentful_updates` before distill run via the existing sanitized `skill_updates` scan plus sentinel-only detection; no new validation layer).
3. No per-entry isolation fallback in phase 1.

### 4.6 Post-merge sync ordering (force-repin safe)
1. Hook location: autopilot merge-complete runtime path (merge confirmed).
2. Strict ordering:
- harvest SkillOps logs from all roster `codex-worker` workdirs (`.codex/skill-ops/logs/**`),
- run one curation pass (distill/lint/reconcile),
- only then execute force-repin of agent worktrees to `origin/master`.
3. Failure behavior:
- if harvest or curation fails, skip force-repin for that merge cycle,
- emit explicit `warn/needs_review` with failure reason and leave logs replayable.
4. Scope guard:
- this flow must not fast-forward or repin runtime/cockpit refs/worktrees,
- runtime/cockpit updates remain restart-gated.

### 5. Public Interfaces / Env
1. Keep existing `AGENTIC_SKILLOPS_AUTOCURATE*` names where already introduced.
2. Add/confirm:
`AGENTIC_SKILLOPS_CURATION_LOCK_TTL_MS` (default 900000),
`AGENTIC_SKILLOPS_AUTOCURATE_BASE_REF` override.
3. Add debrief CLI linkage flags:
`node scripts/skillops.mjs debrief --source-task-id <taskId> --source-root-id <rootId>`
4. Add linkage window controls:
`AGENTIC_SKILLOPS_LOG_MAX_AGE_MS` (default 21600000),
`AGENTIC_SKILLOPS_LOG_CLOCK_SKEW_MS` (default 300000).
5. No changes to `CODEX_WORKER_OUTPUT.schema.json`.

### 6. Telemetry (minimal)
1. `receiptExtra.runtimeGuard.skillops` on hot-path checks:
`debriefCommandPresent`, `logArtifactPresent`, `contentfulSkillUpdates`, `sourceTaskMatch`, `sourceRootMatch`, `createdAtWindowMatch`, `projectRootUsed`, `reasonCode`.
2. `receiptExtra.runtimeGuard.skillopsCuration` on curation runs:
`attempted`, `attemptRootId`, `skippedBusy`, `skippedAlreadyAttemptedForRoot`, `lockStaleRecovered`, `busyPidAlive`, `busyFingerprintMatch`, `baseRefResolved`, `candidateLogs`, `normalizedPendingCount`, `processedLogs`, `failedNoContentful`, `rolledBackOnBatchFailure`, `rollbackFromHead`, `commitSha`, `pushMode`, `pushSucceeded`, `pushRejected`, `pushReconcileAttempted`, `pushReconcileSucceeded`, `preRepinHarvested`, `forceRepinExecuted`, `forceRepinDeferredReason`, `runtimeRefsUntouched`, `errors`.

### 7. Branch Hygiene Update
1. Add `agent/skillops-curation` to canonical keep list in:
`Valua/scripts/branch_hygiene.mjs`
`Valua/docs/runbooks/WORKTREES_AND_BRANCHING.md`
2. Add/adjust tests accordingly.

### 8. Test Plan

### 8.1 Cockpit tests
1. Hot-path pass: debrief + artifact + non-empty `skill_updates`.
2. Hot-path fail: missing or empty `skill_updates` without valid sentinel marker.
3. Hot-path pass: sentinel-only docs/policy debrief (`NO_NOVEL_LEARNING: docs_policy_only`).
4. Hot-path fail: sentinel phrase appears only in body/narrative text (not in frontmatter `skill_updates`).
5. Hot-path fail: artifact linkage mismatch (`source_task_id` or `source_root_id` mismatch / stale `created_at` window).
6. Ensure hot path no longer requires `distill` or `lint` commands.
7. Ownership enforcement: in adapter mode, gate/parser resolve project-owned SkillOps semantics from active task `cwd` / project root.
8. Curation trigger idempotency: at most one attempt per root lifecycle.
9. Curation busy lock with live same-host PID + matching fingerprint -> skip with `warn`.
10. PID reuse case (same PID, fingerprint mismatch) -> treated stale and recovered.
11. Stale lock (dead PID or aged cross-host lock) -> recovered and run continues.
12. Curation reconciliation: plain distill-marked logs without promoted delta are rewritten to `failed/no_contentful_updates`.
13. Curation success marks log `processed` only when promoted delta exists.
14. Status normalization: `pending` inputs are accepted and normalized deterministically before status validation.
15. Lint/parser status acceptance: `new|processed|failed` accepted in Valua primary and cockpit parity `skillops.mjs`.
16. Base ref fallback chain includes `origin/main` before `origin/master`.
17. Push mode assertion: curation branch uses fast-forward push (no force).
18. Append-only history assertion: prior unmerged curation commits remain in branch ancestry after subsequent runs.
19. Push rejection assertion: one auto-reconcile attempt is executed; on second failure/conflict no terminal status finalization is committed.
20. Distill/lint failure rollback assertion: curation worktree is reset/clean to pre-run HEAD and candidate logs remain replayable as `new`.
21. Post-merge ordering assertion: `harvest -> curation -> force repin` executes in strict sequence.
22. Post-merge failure assertion: curation/harvest failure skips force repin and emits `warn/needs_review`.
23. Post-merge scope guard assertion: runtime/cockpit refs/worktrees are untouched by merge-time force-repin flow.

### 8.2 Valua tests
1. `debrief --source-task-id/--source-root-id` persists linkage fields in frontmatter.
2. Existing Valua distill usable-update predicate remains trim/non-empty based, with explicit sentinel-only exclusion (`NO_NOVEL_LEARNING: docs_policy_only`) for `no_contentful_updates`.
3. Hygiene keeps `agent/skillops-curation`.
4. Existing canonical keep behavior unchanged.

### 9. Implementation Sequence
1. Update Valua `scripts/skillops.mjs debrief` to persist `source_task_id` and `source_root_id` (primary runtime path).
2. Update Valua `scripts/skillops.mjs` lint/parser status handling to accept `new|processed|failed`; mirror in cockpit parity script/tests.
3. Update hot-path skillops gate in `agent-codex-worker.mjs` to remove distill/lint requirement, add contentful `skill_updates` or sentinel validation, enforce task/root/time linkage, and enforce adapter project ownership semantics.
4. Add lite curation helper and wire single-run batch curation with PID+fingerprint lock identity, deterministic once-per-root trigger, and base-ref resolution.
5. Add curation post-distill status reconciliation wrapper (promoted-delta required for processed) with `new|pending` read normalization and sentinel-only classification to `no_contentful_updates`.
6. Add explicit fast-forward push policy, one auto-reconcile attempt on non-FF rejection, and failure replay behavior.
7. Add telemetry fields.
8. Patch Valua branch hygiene + docs/tests.
9. Add cockpit `scripts/skillops.mjs` parity for non-adapter mode.
10. Wire merge-complete hook with strict `harvest -> curation -> force repin` ordering; skip repin on harvest/curation failure.
11. Ensure merge-time force-repin path excludes runtime/cockpit refs/worktrees (restart-only for runtime/cockpit updates).
12. Update coupled docs (`PROTOCOL.md`, `BLUEPRINT.md`, runtime flow, TMUX).

### 10. Acceptance Criteria
1. Root-task closure no longer runs distill/lint.
2. Root-task closure still enforces real debrief + valid log evidence (`contentful skill_updates` or sentinel-only docs/policy marker) + strict task/root linkage.
3. Cockpit strictly enforces adapter project ownership of SkillOps semantics (Valua now, same behavior for future adapter projects).
4. Curation runs only in dedicated flow/worktree on `agent/skillops-curation`, with max one attempt per root lifecycle.
5. Lock contention never blocks autopilot; live-lock detection uses PID+fingerprint and avoids PID-reuse false positives.
6. Logs only become `processed` with a verified promoted learning delta via explicit reconciliation.
7. Curation branch history is append-only across runs; prior unmerged curation commits are not dropped by reset/rewrite.
8. Distill/lint failures leave no partial mutations (explicit reset/clean rollback to pre-run HEAD).
9. Non-FF push rejection gets exactly one auto-reconcile attempt; unresolved conflicts/rejections escalate without terminalizing logs.
10. `agent/skillops-curation` is preserved by hygiene tooling.
11. Status contract is coherent across Valua primary and cockpit parity scripts (`new|processed|failed` accepted in lint/parser paths).
12. After any merged PR, SkillOps harvest+curation runs before agent-worktree force repin, preventing learning loss.
13. Merge-time force-repin does not mutate runtime/cockpit refs/worktrees.

### 11. Assumptions
1. Phase 1 optimizes for low operational risk and implementation speed, not maximal throughput under all failure modes.
2. Single-host runtime is primary target; cross-host lock handling is age-based fallback when host/pid fingerprint cannot be validated.
3. Per-entry isolation fallback, heartbeat locks, and queue scheduler are deferred to Phase 2 if needed.
