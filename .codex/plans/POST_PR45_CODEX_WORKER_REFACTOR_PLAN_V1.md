# Post-PR45 Codex Worker Refactor Plan

## Stack Position
`1` after PR45 merges to `origin/main`.

Do not start the scratch lifecycle completion follow-up until this refactor plan is merged. The whole point is to stop adding more garbage into `scripts/agent-codex-worker.mjs` before the scratch root-cause work lands.

## Summary
The worker is too big, owns too many runtime domains, and is the wrong place to keep shipping more behavior. This PR makes `scripts/agent-codex-worker.mjs` a thin orchestrator and extracts whole runtime subsystems into dedicated modules without changing PR43, PR44, or PR45 behavior.

This refactor must also absorb the worker worktree lifecycle and ownership semantics that PR49 exposed. Do not leave reclaim, repin, and stale-ownership decisions split across `task-git`, post-merge resync, and worker-local catch paths.

The PR is not complete unless:
- `scripts/agent-codex-worker.mjs` is under `8,500` lines
- the worker no longer defines the extracted runtime domains locally
- parity tests prove no review-fix, blocked-recovery, app-runtime, SkillOps promotion, or worker worktree lifecycle regressions

## Required Extractions

### 1. Worker state and focus management
Create `scripts/lib/worker-runtime-state.mjs` and move:
- task session read/write/delete
- root session read/write/delete
- root focus read/write/clear helpers
- stale focus/session cleanup
- prompt bootstrap read/write
- worker ownership state read/write/delete helpers

Worker ownership state must be explicit, not inferred from branch names alone. Persist at least:
- `agent`
- `rootId`
- `taskId`
- `workBranch`
- `status`

Required `status` values:
- `active`
- `paused`
- `closed`
- `reclaimable`

The worker keeps only calls into this module.

### 2. Worker worktree lifecycle runtime
Create `scripts/lib/worker-worktree-lifecycle.mjs` and move the shared worker worktree lifecycle domain out of ad hoc worker/runtime call sites:
- stale worker reclaim eligibility checks
- shared ownership/liveness classification for incoming tasks
- queued packet ownership checks
- worker lock / repo ownership checks
- reclaim evidence capture
- deterministic reclaim execution
- root-close repin helpers
- idle stale worktree repin helpers used by post-merge resync

This module must become the single runtime owner for worker reclaim/reuse/repin decisions. Do not leave destructive reclaim logic duplicated between `scripts/agent-codex-worker.mjs`, `scripts/lib/task-git.mjs`, and `scripts/lib/post-merge-resync.mjs`.

### 3. Review artifact materialization
Create `scripts/lib/worker-review-artifacts.mjs` and move:
- review artifact path resolution
- review artifact markdown builders
- review artifact materialization
- Opus consult artifact materialization
- preflight-clean artifact materialization

### 4. App runtime
Create `scripts/lib/worker-app-runtime.mjs` and move:
- `runCodexAppServer(...)`
- its local helper cluster that only exists to support app-server turns

Do not change app-server behavior in this refactor PR.

### 5. Review-fix freshness runtime
Create `scripts/lib/review-fix-freshness.mjs` and move:
- `evaluateReviewFixFreshness(...)`
- live GitHub thread/comment readers
- freshness evidence/warning/stale/fresh builders
- JSON command helpers used only by freshness

Keep PR44 semantics identical.

### 6. SkillOps promotion runtime
Create `scripts/lib/skillops-promotion-runtime.mjs` and move:
- queued handoff planning/reuse/rollback
- claimed promotion task preparation
- claimed promotion task finalization
- promotion lock handling
- promotion state read/write helpers
- curation worktree prep and validation

Keep these semantics unchanged:
- ordinary post-turn handoff may retry stale `needs_review`
- controller-housekeeping handoff fails closed on `needs_review`
- promotion terminal failure state remains `needs_review`

### 7. Autopilot worker runtime
Create `scripts/lib/autopilot-worker-runtime.mjs` and move worker-local autopilot runtime code that does not belong in the entry file:
- pending blocked-recovery queue/flush helpers
- worker-local blocked-recovery contract builder
- worker-local gate derivation helpers
- worker-local prompt-block builders tied to runtime gates

Keep PR43 blocked-recovery semantics and PR44 freshness ordering intact.

### 8. Housekeeping runtime extraction only
Create `scripts/lib/controller-housekeeping-runtime.mjs` and move the existing housekeeping execution domain out of the worker:
- housekeeping task execution
- scratch lifecycle hooks
- raw-plan generation
- exact restore-proof comparison
- final cleanliness verification
- terminal conclusion assembly

This PR extracts the domain and preserves current behavior. The scratch lifecycle redesign lands in stack position `2`.

## Required Worktree Lifecycle Invariants
These invariants must be codified in the extracted lifecycle runtime and treated as parity-preserving behavior, not optional heuristics:

- Same-root `reuse` and same-root `rotate` are not stale ownership. A branch-generation change on the same root must preserve local dirt for inspection/migration instead of triggering reclaim.
- Queued packets in `inbox/<agent>/new`, `seen`, or `in_progress` keep ownership alive. Those states are `paused`, not idle.
- Autopilot review-fix continuation is paused ownership, not stale dirt. Review-fix follow-ups must not fall into a second destructive reclaim path.
- Reclaim is legal only after a proven old-root mismatch plus:
  - no queued packets for the old owner
  - no active worker lock
  - same repository/common git dir ownership
- Reclaim evidence must be sanitized metadata only:
  - branch
  - head sha
  - status porcelain
  - file lists
  - hashes / byte counts
  - no raw diff payloads by default
- True root closure must repin immediately. Post-merge resync remains fallback cleanup, not the main mechanism for discovering stale non-roster worker branches later.

## Worker Ownership After Refactor
After this PR:
- `scripts/agent-codex-worker.mjs` owns bootstrap, claim/open/close flow, top-level dispatch, and final receipt wiring
- `scripts/lib/worker-runtime-state.mjs` owns persisted worker ownership/focus state
- `scripts/lib/worker-worktree-lifecycle.mjs` owns reclaim, repin, and stale-ownership safety decisions
- extracted modules own their runtime domains
- no new domain helper clusters get added back into the worker

Hard failure condition:
- if a helper moved into a module is reintroduced locally in the worker during review fixes, the refactor is not done

## Coupled Docs
Update in the same PR:
- `docs/agentic/RUNTIME_FUNCTION_REFERENCE.md`
- `docs/agentic/AUTOPILOT_RUNTIME_FLOW.md`
- `docs/agentic/CONTROL_LOOP_AND_PACKET_FLOW.md`
- `docs/runbooks/SKILLOPS.md`
- `docs/runbooks/WORKTREES_AND_BRANCHING.md`
- `DECISIONS.md`
- `docs/agentic/DECISIONS_AND_INCIDENTS_TIMELINE.md`

Those docs must explicitly describe the new worker/module ownership so the next engineer does not put more shit back into the entry file.

## Verification
Structural checks:
- `wc -l scripts/agent-codex-worker.mjs`
- `rg` proves extracted helper definitions are gone from the worker

Runtime parity:
- `node --check scripts/agent-codex-worker.mjs`
- `node --check scripts/lib/worker-runtime-state.mjs`
- `node --check scripts/lib/worker-worktree-lifecycle.mjs`
- `node --check scripts/lib/worker-review-artifacts.mjs`
- `node --check scripts/lib/worker-app-runtime.mjs`
- `node --check scripts/lib/review-fix-freshness.mjs`
- `node --check scripts/lib/skillops-promotion-runtime.mjs`
- `node --check scripts/lib/autopilot-worker-runtime.mjs`
- `node --check scripts/lib/controller-housekeeping-runtime.mjs`
- `node --check scripts/lib/task-git.mjs`
- `node --check scripts/lib/post-merge-resync.mjs`
- `node --test scripts/__tests__/codex-worker-app-server.test.mjs`
- `node --test scripts/__tests__/codex-worker-review-fix-freshness.test.mjs`
- `node --test scripts/__tests__/codex-worker-autopilot-recovery.test.mjs`
- `node --test scripts/__tests__/task-git.test.mjs`
- `node --test scripts/__tests__/post-merge-resync.test.mjs`
- `node --test scripts/__tests__/orchestrator-worker.test.mjs`
- `node --test scripts/__tests__/skillops.test.mjs`
- `node scripts/code-quality-gate.mjs check --task-kind USER_REQUEST --base-ref origin/main`
- `npm test`

Required reclaim/ownership regressions:
- same-root `rotate` preserves dirty state and does not trigger reclaim
- queued `new` / `seen` follow-ups preserve paused ownership on non-roster branches
- review-fix continuation does not fall into a second reclaim path
- inbox scan errors fail closed instead of being treated as empty ownership state
- reclaim artifacts persist sanitized metadata only, not raw diff content

## Assumptions
- This is a new PR after PR45 merges, not an amendment to PR45.
- The goal is de-bloat and ownership cleanup first, while carrying forward the production-safe reclaim and repin behavior already proven necessary by PR49-class bugs.
- Scratch lifecycle root-cause work is intentionally deferred to stack position `2` so it lands inside the extracted housekeeping runtime module instead of bloating the worker again.
