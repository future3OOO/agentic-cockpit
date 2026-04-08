# Post-PR45 Scratch Lifecycle Robustness Plan

## Stack Position
`2` after the Post-PR45 Codex Worker Refactor PR merges.

Do not start this PR until the worker refactor is merged. This work belongs in the extracted housekeeping runtime module, not back in the giant worker entry file.

## Summary
This PR finishes the real scratch lifecycle fix for controller-housekeeping. The current fail-closed cleanup behavior is correct, but it is not the full root-cause fix because deterministic scratch reuse can still poison later attempts when old worktree state leaks.

Worker reclaim / worker ownership semantics are out of scope here. Those belong to stack position `1` in `POST_PR45_CODEX_WORKER_REFACTOR_PLAN_V1.md` and must not be re-implemented as scratch-specific side logic in this PR.

The fix is:
- attempt-scoped scratch worktrees instead of one deterministic path per fingerprint
- stale-family scavenging before each claim
- strict current-attempt cleanup after execution
- no change to controller-housekeeping routing, replay, restore-proof, or promotion-state semantics

## Required Scratch Lifecycle Changes

### 1. Replace deterministic reuse with attempt-scoped scratch
Scratch path becomes:
- `<shared-worktrees-root>/<safeAgent>-controller-housekeeping-<fingerprint32>-g<generation>-a<attempt>`

Do not reuse a prior attempt path.

Housekeeping state must add:
- `runAttempt`
- `activeScratch`
- `lastScratchCleanup`

`activeScratch` must record:
- `attempt`
- `workdir`
- `claimedAt`

`lastScratchCleanup` must record:
- `ok`
- `at`
- `detail`

### 2. Scavenge stale family state before creating the new scratch
Before creating the current attempt scratch:
1. increment and persist `runAttempt`
2. persist `activeScratch` for the new attempt
3. run `git worktree prune`
4. scan the scratch family for the same `agent + fingerprint + generation`
5. remove every stale sibling except the current attempt path

Removal rules:
- registered sibling in the same repo/common-dir:
  - remove with `git worktree remove --force`
- unregistered sibling directory:
  - remove with `fs.rm(..., recursive: true, force: true)`
- sibling outside the shared worktrees root:
  - fail closed
- sibling registered to the wrong repo/common-dir:
  - fail closed

### 3. Prepare the new scratch cleanly
After scavenging:
- create the new attempt scratch worktree
- verify it belongs to the same repo/common-dir as the source worktree
- reset hard to the current `headSha`
- clean `-fdx`

If any of that fails:
- current housekeeping attempt fails closed
- no replay

### 4. Keep strict current-attempt cleanup
On success, blocked, failed, and interrupted exits:
- remove the current attempt scratch
- run `git worktree prune`
- clear `activeScratch`
- persist `lastScratchCleanup`

If cleanup fails:
- current attempt still fails closed
- suspended roots do not replay

The difference from the current behavior is this:
- the next attempt gets a fresh path and scavenges stale family leftovers first, so one leaked scratch path no longer wedges future housekeeping attempts

## Behavioral Invariants
Do not change:
- controller-housekeeping task routing
- replay contract
- exact restore-proof requirement
- final cleanliness gate before `done` + replay
- queued-log retention
- promotion-state reuse semantics

This PR changes only scratch lifecycle robustness and the housekeeping runtime internals that own it.

## Coupled Docs
Update in the same PR:
- `docs/agentic/RUNTIME_FUNCTION_REFERENCE.md`
- `docs/agentic/AUTOPILOT_RUNTIME_FLOW.md`
- `docs/runbooks/SKILLOPS.md`
- `DECISIONS.md`
- `docs/agentic/DECISIONS_AND_INCIDENTS_TIMELINE.md`

Those docs must explain:
- why the current-attempt cleanup still fails closed
- why later attempts are no longer poisoned by leaked scratch state
- that scratch identity is now attempt-scoped, not fingerprint-scoped

## Verification
Scratch regressions:
- stale registered scratch from attempt `1` does not wedge attempt `2`
- stale unregistered scratch directory is removed before attempt `2`
- wrong-repo or outside-root sibling scratch fails closed
- cleanup failure blocks current replay
- later attempt still succeeds with a fresh scratch path after prior leaked scratch state

Checks:
- `node --check scripts/lib/controller-housekeeping-runtime.mjs`
- `node --test scripts/__tests__/controller-housekeeping.test.mjs`
- `node --test scripts/__tests__/codex-worker-autopilot-recovery.test.mjs`
- `node scripts/code-quality-gate.mjs check --task-kind USER_REQUEST --base-ref origin/main`
- `npm test`

## Assumptions
- The refactor PR from stack position `1` has already landed.
- Housekeeping runtime code already lives in `scripts/lib/controller-housekeeping-runtime.mjs`.
- This PR must not dump new helper clusters back into `scripts/agent-codex-worker.mjs`.
