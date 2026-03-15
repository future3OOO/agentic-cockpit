# Post-PR45 Codex Worker Refactor Plan

## Stack Position
`1` after PR45 merges to `origin/main`.

Do not start the scratch lifecycle completion follow-up until this refactor plan is merged. The whole point is to stop adding more garbage into `scripts/agent-codex-worker.mjs` before the scratch root-cause work lands.

## Summary
The worker is too big, owns too many runtime domains, and is the wrong place to keep shipping more behavior. This PR makes `scripts/agent-codex-worker.mjs` a thin orchestrator and extracts whole runtime subsystems into dedicated modules without changing PR43, PR44, or PR45 behavior.

The PR is not complete unless:
- `scripts/agent-codex-worker.mjs` is under `8,500` lines
- the worker no longer defines the extracted runtime domains locally
- parity tests prove no review-fix, blocked-recovery, app-runtime, or SkillOps promotion regressions

## Required Extractions

### 1. Worker state and focus management
Create `scripts/lib/worker-runtime-state.mjs` and move:
- task session read/write/delete
- root session read/write/delete
- root focus read/write/clear helpers
- stale focus/session cleanup
- prompt bootstrap read/write

The worker keeps only calls into this module.

### 2. Review artifact materialization
Create `scripts/lib/worker-review-artifacts.mjs` and move:
- review artifact path resolution
- review artifact markdown builders
- review artifact materialization
- Opus consult artifact materialization
- preflight-clean artifact materialization

### 3. App runtime
Create `scripts/lib/worker-app-runtime.mjs` and move:
- `runCodexAppServer(...)`
- its local helper cluster that only exists to support app-server turns

Do not change app-server behavior in this refactor PR.

### 4. Review-fix freshness runtime
Create `scripts/lib/review-fix-freshness.mjs` and move:
- `evaluateReviewFixFreshness(...)`
- live GitHub thread/comment readers
- freshness evidence/warning/stale/fresh builders
- JSON command helpers used only by freshness

Keep PR44 semantics identical.

### 5. SkillOps promotion runtime
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

### 6. Autopilot worker runtime
Create `scripts/lib/autopilot-worker-runtime.mjs` and move worker-local autopilot runtime code that does not belong in the entry file:
- pending blocked-recovery queue/flush helpers
- worker-local blocked-recovery contract builder
- worker-local gate derivation helpers
- worker-local prompt-block builders tied to runtime gates

Keep PR43 blocked-recovery semantics and PR44 freshness ordering intact.

### 7. Housekeeping runtime extraction only
Create `scripts/lib/controller-housekeeping-runtime.mjs` and move the existing housekeeping execution domain out of the worker:
- housekeeping task execution
- scratch lifecycle hooks
- raw-plan generation
- exact restore-proof comparison
- final cleanliness verification
- terminal conclusion assembly

This PR extracts the domain and preserves current behavior. The scratch lifecycle redesign lands in stack position `2`.

## Worker Ownership After Refactor
After this PR:
- `scripts/agent-codex-worker.mjs` owns bootstrap, claim/open/close flow, top-level dispatch, and final receipt wiring
- extracted modules own their runtime domains
- no new domain helper clusters get added back into the worker

Hard failure condition:
- if a helper moved into a module is reintroduced locally in the worker during review fixes, the refactor is not done

## Coupled Docs
Update in the same PR:
- `docs/agentic/RUNTIME_FUNCTION_REFERENCE.md`
- `docs/agentic/AUTOPILOT_RUNTIME_FLOW.md`
- `docs/runbooks/SKILLOPS.md`
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
- `node --check scripts/lib/worker-review-artifacts.mjs`
- `node --check scripts/lib/worker-app-runtime.mjs`
- `node --check scripts/lib/review-fix-freshness.mjs`
- `node --check scripts/lib/skillops-promotion-runtime.mjs`
- `node --check scripts/lib/autopilot-worker-runtime.mjs`
- `node --check scripts/lib/controller-housekeeping-runtime.mjs`
- `node --test scripts/__tests__/codex-worker-app-server.test.mjs`
- `node --test scripts/__tests__/codex-worker-review-fix-freshness.test.mjs`
- `node --test scripts/__tests__/codex-worker-autopilot-recovery.test.mjs`
- `node --test scripts/__tests__/orchestrator-worker.test.mjs`
- `node --test scripts/__tests__/skillops.test.mjs`
- `node scripts/code-quality-gate.mjs check --task-kind USER_REQUEST --base-ref origin/main`
- `npm test`

## Assumptions
- This is a new PR after PR45 merges, not an amendment to PR45.
- The goal is de-bloat and ownership cleanup first, not new behavior.
- Scratch lifecycle root-cause work is intentionally deferred to stack position `2` so it lands inside the extracted housekeeping runtime module instead of bloating the worker again.
