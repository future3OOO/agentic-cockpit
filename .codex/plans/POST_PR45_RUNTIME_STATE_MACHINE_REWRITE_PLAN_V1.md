# Post-PR45 Runtime State Machine Rewrite Plan

## Stack Position
`4` after stack position `3` lands or is explicitly abandoned by decision record.

Do not implement this before the worker lifecycle/ownership refactor from stack position `1` is live. This plan assumes ownership state already exists as explicit persisted data rather than branch-name guesswork.

## Summary
The runtime still derives too much behavior from scattered heuristics:
- inbox packet presence
- worker lock state
- root focus/session files
- branch/worktree inspection
- ad hoc call-site checks

This follow-on replaces that with a formal worker ownership state machine so destructive actions, repins, replay decisions, and paused-root handling are driven by explicit states and transitions.

## Required Changes

### 1. Define canonical worker/root states
Create one explicit state model that covers at least:
- `active`
- `paused_followup`
- `paused_review_fix`
- `closed`
- `reclaimable`
- `quarantined`

If different names are chosen during re-review, they must still map one-to-one to these runtime meanings.

### 2. Define legal transitions
Write an explicit transition table for:
- claim
- follow-up queue pause
- review-fix continuation
- root closure
- quarantine
- reclaim
- repin

Illegal transitions must fail closed.

### 3. Centralize transitions in one runtime module
Introduce one state-machine runtime module and route worker lifecycle decisions through it instead of open-coded heuristics in multiple files.

`task-git`, worker preflight, post-merge resync, and autopilot recovery paths must consult the same transition authority.

### 4. Migrate existing ownership state safely
Add a compatibility/migration path from the stack position `1` ownership records into the formal state-machine shape.

Migration must be deterministic and fail closed on unknown persisted state.

### 5. Keep scope surgical
This is not permission to rewrite the whole cockpit runtime. Limit it to:
- worker ownership state
- reclaim/repin/quarantine legality
- paused/closed semantics
- the docs/tests/schema surfaces coupled to those behaviors

## Coupled Docs
Update in the same PR:
- `docs/agentic/RUNTIME_FUNCTION_REFERENCE.md`
- `docs/agentic/CONTROL_LOOP_AND_PACKET_FLOW.md`
- `docs/agentic/AUTOPILOT_RUNTIME_FLOW.md`
- `docs/runbooks/WORKTREES_AND_BRANCHING.md`
- `DECISIONS.md`
- `docs/agentic/DECISIONS_AND_INCIDENTS_TIMELINE.md`

## Verification
Required scenarios:
- valid claim -> pause -> resume -> close transition chain
- same-root rotate remains a legal paused/continued path, not reclaimable
- queued follow-up state stays paused until claim/resume or explicit closure
- review-fix continuation stays paused and cannot jump to reclaim
- quarantine can transition only from reclaimable
- reclaim can transition only after quarantine or an explicitly documented no-quarantine path
- unknown persisted state fails closed

Checks:
- `node --check scripts/lib/worker-runtime-state.mjs`
- `node --check scripts/lib/worker-worktree-lifecycle.mjs`
- `node --check <new state-machine runtime module>`
- `node --test scripts/__tests__/task-git.test.mjs`
- `node --test scripts/__tests__/post-merge-resync.test.mjs`
- `node --test scripts/__tests__/codex-worker-app-server.test.mjs`
- `node scripts/code-quality-gate.mjs check --task-kind USER_REQUEST --base-ref origin/main`
- `npm test`

## Re-review Trigger Before Implementation
Re-review this plan after stack position `3` lands or is explicitly dropped.

If the quarantine model, ownership schema, or paused-state semantics changed during stack position `3`, patch this plan first so the rewrite targets the real stabilized runtime instead of stale assumptions.
