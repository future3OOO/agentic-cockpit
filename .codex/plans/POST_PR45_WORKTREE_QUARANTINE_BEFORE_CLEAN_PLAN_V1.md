# Post-PR45 Worktree Quarantine-before-Clean Plan

## Stack Position
`3` after stack positions `1` and `2` are implemented and merged.

Do not implement this before the worker lifecycle extraction from stack position `1` exists on `main`. This plan assumes reclaim and repin are already centralized in one lifecycle module.

## Summary
The runtime still cleans reclaimable worker worktrees in place. That is safer than the old scattered reclaim logic, but it still makes the active worker checkout the place where preservation and destruction happen together.

This follow-on changes the reclaim model to:
1. prove stale old-root ownership
2. preserve dirty state into quarantine
3. only then clean and repin the active worker worktree

The point is to stop "delete in place after some checks" from being the only recovery option.

## Required Changes

### 1. Add a runtime-owned quarantine model
Introduce quarantine state owned by the extracted worker lifecycle/runtime-state modules. Each quarantine record must capture at least:
- `agent`
- `rootId`
- `taskId`
- `workBranch`
- `headSha`
- `reason`
- `createdAt`
- artifact paths / hashes

Quarantine records must be separate from ordinary task receipts.

### 2. Preserve before reclaim
When a worker worktree is proven reclaimable:
- staged/tracked changes must be captured into patch artifacts
- untracked content must be copied into a quarantine artifact directory
- the quarantine record must be persisted before any destructive clean step runs

If quarantine capture is incomplete or cannot be written, reclaim fails closed.

### 3. Keep active worktree cleanup in the lifecycle module
After quarantine succeeds, the existing lifecycle module performs the reclaim:
- reset / clean
- deterministic checkout of the incoming branch/root
- repin bookkeeping

Do not duplicate the destructive sequence outside the lifecycle module.

### 4. Add operator retrieval and prune discipline
Document:
- where quarantine artifacts live
- how operators inspect them
- how explicit prune works

First version should be conservative:
- no silent auto-delete of quarantine artifacts
- prune only through an explicit runtime path or operator procedure

### 5. Keep scope tight
This plan is not a generic incident-forensics system. It only covers:
- worker stale-root reclaim
- preserving reclaimable dirty state before cleanup
- enough operator retrieval to avoid accidental loss

## Behavioral Invariants
Do not change:
- same-root `reuse` / `rotate` protection
- queued `new` / `seen` / `in_progress` paused ownership semantics
- review-fix continuation protection
- sanitized reclaim evidence for ordinary receipts/state

Quarantine is an extra preservation layer on top of the stack position `1` lifecycle rules, not a replacement for them.

## Coupled Docs
Update in the same PR:
- `docs/agentic/RUNTIME_FUNCTION_REFERENCE.md`
- `docs/agentic/CONTROL_LOOP_AND_PACKET_FLOW.md`
- `docs/runbooks/WORKTREES_AND_BRANCHING.md`
- `DECISIONS.md`
- `docs/agentic/DECISIONS_AND_INCIDENTS_TIMELINE.md`

## Verification
Required scenarios:
- reclaimable old-root dirt is quarantined before cleanup
- failed quarantine capture blocks reclaim
- same-root rotate still does not quarantine/reclaim
- queued paused follow-up roots still do not quarantine/reclaim
- review-fix continuation still does not quarantine/reclaim
- operator prune only removes explicit quarantine artifacts, not live worker state

Checks:
- `node --check scripts/lib/worker-worktree-lifecycle.mjs`
- `node --check scripts/lib/worker-runtime-state.mjs`
- `node --test scripts/__tests__/task-git.test.mjs`
- `node --test scripts/__tests__/post-merge-resync.test.mjs`
- `node --test scripts/__tests__/codex-worker-app-server.test.mjs`
- `node scripts/code-quality-gate.mjs check --task-kind USER_REQUEST --base-ref origin/main`
- `npm test`

## Re-review Trigger Before Implementation
Re-review this plan immediately after stack positions `1` and `2` land.

If module names, ownership state shape, or repin hooks changed during those implementations, patch this plan first, then implement it.
