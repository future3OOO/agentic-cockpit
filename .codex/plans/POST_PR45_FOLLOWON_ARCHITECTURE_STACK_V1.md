# Post-PR45 Follow-on Architecture Stack

## Purpose
PR48 defines the first two stack items:
- stack position `1`: `POST_PR45_CODEX_WORKER_REFACTOR_PLAN_V1.md`
- stack position `2`: `POST_PR45_SCRATCH_LIFECYCLE_ROBUSTNESS_PLAN_V1.md`

This follow-on stack adds the two larger architecture moves that should only happen after those first two implementation PRs land and stabilize.

## Stack Order
1. Merge PR48 so the stack definition is tracked on `main`.
2. Implement stack position `1` from `POST_PR45_CODEX_WORKER_REFACTOR_PLAN_V1.md`.
3. Implement stack position `2` from `POST_PR45_SCRATCH_LIFECYCLE_ROBUSTNESS_PLAN_V1.md`.
4. Re-review stack position `3` on latest `main`, then implement `POST_PR45_WORKTREE_QUARANTINE_BEFORE_CLEAN_PLAN_V1.md`.
5. Re-review stack position `4` on latest `main`, then implement `POST_PR45_RUNTIME_STATE_MACHINE_REWRITE_PLAN_V1.md`.

## Re-review Gates

### Stack position `3` — quarantine-before-clean
Do not implement directly from this plan off stale branch context. Re-review it after stack positions `1` and `2` are both merged.

The re-review must verify:
- `scripts/lib/worker-worktree-lifecycle.mjs` really exists and owns reclaim/repin decisions
- `scripts/lib/worker-runtime-state.mjs` really owns persisted worker ownership state
- scratch lifecycle changes from stack position `2` are live and did not reintroduce worker-specific side logic
- any runtime naming/schema drift since this plan was written is patched in the plan before implementation starts

### Stack position `4` — formal runtime state machine rewrite
Do not implement directly from this plan off stale branch context. Re-review it only after stack position `3` lands or is explicitly abandoned by decision record.

The re-review must verify:
- the post-stack-`3` ownership/quarantine model is actually stable
- state names and transitions in this plan still match current runtime semantics
- any overlap between stack positions `3` and `4` has been removed before implementation starts

## Non-goals
- Do not merge stack positions `3` or `4` into the stack position `1` or `2` implementation PRs.
- Do not treat these follow-on plans as approval to start coding before the re-review gates above are satisfied.
- Do not re-open PR48 just to stuff these larger architecture moves into the first two plan files.

## Expected Future PRs
- PR A: implement stack position `1`
- PR B: implement stack position `2`
- PR C: implement stack position `3` after re-review
- PR D: implement stack position `4` after re-review
