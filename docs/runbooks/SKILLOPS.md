# SkillOps

## Intent
Continuously improve skill instructions based on real execution outcomes.

## Basic cycle
1. Capture what changed and what failed.
2. Distill reusable rules into repo-local promotion plans.
3. Let runtime hand off non-empty learnings onto a dedicated promotion lane.
4. Keep instructions concise and operational.
5. Prefer stable policy in runbooks, tactical guidance in skill files.
6. Treat raw SkillOps logs as local runtime evidence, not durable project memory.

## CLI
- `node scripts/skillops.mjs capabilities --json`
- `node scripts/skillops.mjs debrief --skills <skill-a,skill-b> --title "What changed"`
- Fast path when the learning is already obvious:
  - `node scripts/skillops.mjs debrief --skills <skill-a,skill-b> --skill-update "skill-a:1-line rule" --skill-update "skill-b:1-line rule" --title "What changed"`
  - `--skill-update=skill-a:1-line rule` is supported too.
- `node scripts/skillops.mjs distill`
- `node scripts/skillops.mjs plan-promotions --json`
- `node scripts/skillops.mjs apply-promotions --plan /abs/path/to/plan.json`
- `node scripts/skillops.mjs mark-promoted --plan /abs/path/to/plan.json --status queued|processed|skipped [--promotion-task-id id]`
- `node scripts/skillops.mjs lint`

## Ownership
- Workers may capture learnings during execution.
- `distill` is non-durable:
  - it may summarize learnings,
  - it may retire empty/no-update logs locally,
  - it must not patch skill files.
- The controller runtime owns durable handoff:
  - run `plan-promotions --json` after successful SkillOps-gated turns,
  - if there are no promotable learnings, mark the raw logs `skipped` locally and stop,
  - if there are promotable learnings, persist the raw plan under AgentBus state, mark source logs `queued`, and enqueue one runtime-owned `skillops-promotion` task.
- The promotion lane owns durable curation:
  - run in the shared curation worktree, not the source checkout,
  - apply only raw-plan `durableTargets`, which may be learned-block updates or canonical-section doctrine targets,
  - never commit `.codex/skill-ops/logs/**` or `.codex/quality/**`,
  - push `skillops/<controllerAgent>/<rootId>` and open or update a PR to the repo default branch.

## Status semantics
- Legacy `status: new` is treated as `pending` on read.
- New write-back uses only `pending`, `queued`, `processed`, and `skipped`.
- `pending`: non-empty learnings still waiting for promotion handoff.
- `queued`: runtime has durably handed the plan off to the promotion lane; the log stops blocking root closure but stays on disk until processed mark-back succeeds.
- `processed`: promotion branch push, PR creation, and runtime-owned mark-back succeeded.
- `skipped`: empty/no-update logs were retired locally.

## Runtime rules
- `--plan` accepts absolute paths outside the repo checkout because runtime stores raw plans under `${busRoot}/state/skillops-promotions/...`.
- Mixed-version downstream repos are unsupported: runtime first requires `capabilities --json` to report the v2 contract (`plan-promotions`, `apply-promotions`, `mark-promoted`, queued status, and `distillMode=non_durable`).
- `processed` and `skipped` logs are disposable local runtime dirt. `queued` logs are non-blocking local evidence until processed mark-back succeeds. None of them are durable outputs and none of them should trigger housekeeping branches.

## Controller-housekeeping interaction
- `dirty_cross_root_transition` only routes into controller-housekeeping when the shared dirt classifier proves the blocking dirt is controller-owned and recoverable.
- Housekeeping never generates the raw SkillOps plan in the dirty source worktree. Runtime first creates a clean scratch worktree at current `HEAD`, copies only the pending SkillOps logs into it, runs `plan-promotions --json` there, and uses that same scratch worktree for restore proof.
- Restore stays fail-closed: tracked paths are restored only when the dirty source diff exactly matches the deterministic diff produced by `apply-promotions --plan <rawPlanPath>` in the scratch worktree.
- `queued` logs remain retained non-blocking evidence during housekeeping. Runtime may retire only `processed` or `skipped` logs as disposable local dirt.
