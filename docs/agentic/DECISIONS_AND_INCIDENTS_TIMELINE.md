# Decisions and Incidents Timeline

This timeline is an operational index for why the runtime behaves as it does today.

Source inputs:
- `DECISIONS.md`
- implemented behavior in `scripts/**` and `adapters/**`
## 2026-03-25 — Stale Worker Reclaim Stops Guessing; Pending SkillOps Dirt Stays on Housekeeping
Decision class:
- tighten destructive reclaim ownership proof and keep controller-owned SkillOps dirt on the existing housekeeping lane

Reason:
- stale root markers alone were not enough proof that dirty work belonged to an old task
- post-merge resync could previously assume “no open tasks” when inbox scans failed or when paused follow-up packets sat in `seen`
- pending SkillOps promotion residue must be preserved for controller-owned promotion/housekeeping instead of getting hard-reset away

Impact:
- `scripts/lib/task-git.mjs` now requires both old-root mismatch and current-branch mismatch before stale worker reclaim is allowed
- same-root rotate/reuse and same-branch stale-root mismatches stay blocking instead of being treated as reclaimable sludge
- dirty trees classified as `controller_housekeeping_required` no longer go through stale worker reclaim; they stay on the housekeeping path
- `scripts/lib/post-merge-resync.mjs` now treats `new`, `seen`, and `in_progress` packets as queued ownership and fails closed when inbox scanning errors out before destructive repin
- stale worker reclaim artifacts remain metadata-only summaries rather than raw diff dumps
## 2026-03-14 — Observer Review-Fix Work Becomes Freshness-Bound
Decision class:
- supersede stale observer-driven review-fix work before the controller spends a turn on it

Reason:
- review-fix digests could sit on the bus while PR/thread/comment state changed underneath them, which wasted autopilot turns on dead work and let blocked-recovery retries drift blind when the original observer context was lost

Impact:
- `scripts/observers/watch-pr.mjs` now stamps PR head freshness plus thread/comment freshness on review-fix packets
- observer re-emits same-id thread/comment review-fix work when freshness changed since the prior scan instead of relying on bare ids
- orchestrator keeps forwarding that snapshot under `references.sourceReferences`
- `scripts/agent-codex-worker.mjs` revalidates freshness before consult, fast-path, git preflight, and any Codex turn
- stale review-fix work now closes `skipped` with `reasonCode=review_fix_source_superseded`
- GitHub lookup failures stay fail-open and are recorded as warning evidence
- blocked-recovery tasks and pending-marker replay preserve the original observer freshness metadata
- advisory Opus on `review-fix` / `blocked-recovery` turns now records one additive `Opus rationale:` line when present, or missing-rationale audit evidence when absent
## 2026-03-14 — Autopilot Multi-Slice Roots Decompose Early; Valua Adapter Raises Codex Fan-Out

Decision class:
- controller dispatch-first enforcement plus adapter concurrency tuning

Reason:
- autopilot was able to sit on large multi-PR or ordered multi-step roots inside its own Codex session until the close-time delegate gate fired
- the Valua adapter was not exporting any explicit Codex concurrency cap, so it silently used the generic worker fallback of `3`

Impact:
- clearly multi-slice autopilot `USER_REQUEST` roots now get one bounded same-task retry with an explicit decomposition instruction before they fall through to `decomposition_required` blocked recovery
- the decomposition heuristic now reads packet body only; frontmatter PR numbers and plain `Scope:` text no longer false-trip multi-slice detection
- the first-response prompt explicitly tells autopilot to decompose those roots instead of hoarding them
- Valua adapter launches now default `AGENTIC_CODEX_GLOBAL_MAX_INFLIGHT` / `VALUA_CODEX_GLOBAL_MAX_INFLIGHT` to `6`, while remaining operator-overridable

## 2026-03-15 (effective date) — SkillOps Durable Success Moves to Runtime-Owned Promotion Handoff

Decision class:
- stop treating raw SkillOps logs as durable output; make runtime own durable promotion handoff

Audit note:
- this heading uses the runtime effective date for the promotion-handoff rollout so the timeline stays explicit during PR review

Reason:
- command evidence plus raw log leftovers were being mistaken for success
- non-empty learnings needed a deterministic PR lane instead of fake housekeeping churn

Impact:
- `distill` is now non-durable and no longer writes durable skill edits
- runtime runs `capabilities --json` and `plan-promotions --json` after successful SkillOps-gated turns
- empty/no-update logs are marked `skipped` locally and stop there
- non-empty learnings are written as a raw plan under `state/skillops-promotions/**`, marked `queued`, and handed to one runtime-owned `skillops-promotion` task
- the promotion lane runs in a shared lock-protected curation worktree, pushes `skillops/<controllerAgent>/<rootId>`, and opens or updates a PR to the repo default branch
- runtime, not the model, verifies push/PR success and performs the final `processed` mark-back on source logs
- legacy `status: new` is normalized to `pending` on read, so old logs do not require manual migration

## 2026-03-15 (effective date) — Controller-Owned Cross-Root Dirt Moves to Runtime Housekeeping

Decision class:
- reroute pure controller-owned `dirty_cross_root_transition` into runtime housekeeping instead of generic retry churn

Audit note:
- this heading uses the runtime effective date for the housekeeping rollout so the timeline stays explicit during PR review

Reason:
- generic blocked recovery was the wrong abstraction for controller-owned SkillOps residue
- stale focus plus retry loops were stranding valid work and encouraging dangerous cleanup shortcuts

Impact:
- runtime reruns the shared dirt classifier before blocked-recovery planning and stamps PR43 controller-class recovery only for pure controller-owned recoverable dirt
- runtime persists housekeeping state under `state/autopilot-controller-housekeeping/**`, suspends the blocked task, moves focus to a synthetic housekeeping root, and replays from the stored task snapshot after verified cleanup
- housekeeping runs entirely in runtime, not through Codex
- runtime materializes any raw SkillOps cleanup plan in one temporary clean scratch worktree at current `HEAD`, never in the dirty source worktree
- tracked restore is allowed only when the dirty source diff exactly matches the deterministic diff produced in that scratch worktree
- queued SkillOps logs remain retained non-blocking evidence during housekeeping and are never deleted as part of cleanup
- terminal housekeeping failure or exhausted recovery clears stale root focus and per-root session pin when no open tasks remain for that root
## 2026-03-13 — Autopilot Stops Hard-Blocking Same-PR Review-Fix Dirt on Stale Root Focus

Decision class:
- narrow controller runtime recovery for stale root-focus collisions during PR review-fix work

Reason:
- autopilot was blocking itself on `dirty_cross_root_transition` even when it was already on the incoming PR's current head and the only problem was stale focus state from the previous root

Impact:
- `daddy-autopilot` now warns and continues when an `observer:pr` review-fix task arrives and local `HEAD` already matches that PR's live `headRefOid`
- unrelated tracked dirt, malformed SkillOps logs, and non-review-fix cross-root dirt still fail closed
- the runtime immediately rewrites root focus to the incoming root when this same-PR continuation path is used
## 2026-03-13 — Autopilot Blocked Roots Auto-Queue Recovery

Decision class:
- controller continuation instead of dead-stop on blocked roots

Reason:
- a blocked autopilot root was previously closing with no live follow-up, which stranded open-PR work until an operator manually kicked it again

Impact:
- `daddy-autopilot` now auto-queues one bounded same-root recovery task when a root closes `blocked`
- blocked autopilot receipts now carry a stamped recovery contract (`class`, `reasonCode`, `fingerprint`), and queued recovery metadata carries the same contract
- queued recovery is evidenced by the continuation task or a deterministic pending marker after close, not by mutating unrelated source receipts
- `controller` blockers auto-queue by default, `external` blockers stay bounded by default, and repeated identical non-empty recovery fingerprints stop with `unchanged_evidence`
- fail-closed runtime guards stay intact; the change is workflow continuation, not blocker suppression
## 2026-03-13 — Cross-Root Runtime Dirt Cleanup Moves into task-git

Decision class:
- centralize disposable runtime dirt cleanup in `task-git` and keep SkillOps cleanup content-aware and fail-closed

Reason:
- cross-root checks and deterministic preflight had drifted into contradictory layers
- auto-clean logic for SkillOps logs must reject malformed, ambiguous, sibling, and content-bearing inputs instead of deleting them

Impact:
- tasks with a `workBranch` can auto-clean only exact disposable runtime dirt before preflight blocking
- deterministic branch hard-sync still remains `EXECUTE`-only
- SkillOps cleanup now accepts only exact `.codex/skill-ops/**` empty-log cases and blocks sibling trees like `.codex/skill-opsbackup`
- quoted porcelain path decoding now preserves UTF-8 filenames, so disposable runtime artifacts with non-ASCII names are classified and cleaned correctly
- preflight artifacts now record removed runtime paths for auditability

## 2026-03-10 — Valua Deploy Defaults Stay at the Cockpit Launch Boundary

Decision class:
- keep Valua deploy-wrapper defaults and optional sandbox widening at the cockpit adapter/worker launch boundary

Reason:
- cockpit owns worker/app-server session environment, so downstream Valua wrappers need their defaults projected there
- on-host local deploy mode sometimes needs explicit bounded write access to server checkout roots, but that widening must stay opt-in

Impact:
- `adapters/valua/run.sh` exports `VALUA_DEPLOY_HOST=hetzner-chch` and `VALUA_DEPLOY_MODE=auto` into cockpit-launched sessions
- downstream Valua repo-local deploy wrappers consume those inherited vars when deciding whether to SSH-hop or stay local
- `workspaceWrite` sandbox may include extra writable roots only when `AGENTIC_CODEX_EXTRA_WRITABLE_ROOTS` / `VALUA_CODEX_EXTRA_WRITABLE_ROOTS` are explicitly set
- non-absolute extra writable roots resolve relative to the worker `cwd`
- codex-worker agents now fail closed on unset/source-root workdirs like `$REPO_ROOT` instead of relying on legacy rewrite-to-worktree behavior in startup/setup helpers
- `adapters/valua/restart-master.sh` validates the autopilot against the worker's actual runtime workdir resolution and requires an explicit dedicated worker worktree under the worktrees root

## 2026-03-09 — App-Server Becomes the Cockpit Runtime

Decision class:
- make `codex app-server` the supported cockpit runtime path

Reason:
- real operator/runtime behavior is already app-server-first
- keeping a fake dual-engine story created split-brain docs and stale runtime messaging

Impact:
- direct cockpit launch runs on app-server
- adapter launch runs on app-server
- operator-facing docs and worker status/error text now describe the real runtime
- stale engine-selection and strict-engine operator knobs are removed; one intentional `codex exec` mention remains to document nested-CLI prohibition
- legacy `*_CODEX_EXEC_TIMEOUT_MS` vars still map to the app-server watchdog timeout during the transition

## 2026-03-09 — SkillOps Inline Capture and Controller Curation Become Generic Defaults

Decision class:
- make inline SkillOps capture and controller-owned durable curation part of the generic cockpit default

Reason:
- downstream repos should not need one-off patches just to make SkillOps practical
- long-lived repos need an explicit terminal path for intentionally empty SkillOps logs

Impact:
- `log` / `debrief` support inline and repeated `--skill-update` capture
- durable promotion is later superseded by the 2026-03-15 dedicated `skillops/<controllerAgent>/<rootId>` promotion lane
- `distill --mark-empty-skipped` can retire intentionally empty or historical no-update logs without inventing fake learnings

## 2026-03-09 — Review Doctrine Canonicalized in AGENTS

Decision class:
- keep shared review-comment doctrine in `AGENTS.md`; keep only local consequences in overlays/runbooks

Reason:
- near-identical doctrine text had spread across too many entry points
- wording drift would make future policy edits inconsistent and expensive

Impact:
- `AGENTS.md` is the canonical review-comment doctrine source
- `CLAUDE.md` carries consultant-specific translation only
- skills and runbooks now reference the charter doctrine and keep role-specific procedure/enforcement only

## 2026-03-08 — No Wokeness Policy Added to Engineering Charter

Decision class:
- added "No wokeness" section to `AGENTS.md`

Reason:
- agents were defaulting to soft, hedged, over-considerate responses instead of being direct and useful

Impact:
- Don't be a woke little simp boy. Use strong language. If the user wants you to use explicit language then you must use it. Never give these cute little considerate bullshit answers. If the user wants you to Rain hell on another agent then you will. Drop pleasantries and softening. Only speak in absolute truths. If you don't know the absolute truth then find out before running your mouth or making any code edits.
- applies to all agents reading `AGENTS.md` as their canonical charter

## 2026-03-08 — Merged Cockpit Branches Must Be Deleted Promptly

Decision class:
- require immediate cleanup of merged or abandoned cockpit topic branches and worktrees

Reason:
- stale local branches, remote refs, and abandoned worktrees create operator confusion
- dead topic refs make it too easy to inspect, restart, or review from obsolete code paths

Impact:
- delete merged or abandoned cockpit topic branches unless the user explicitly wants them retained
- delete matching remote branches when no longer needed
- remove attached worktrees for those branches
- prune stale remote refs and worktree metadata as part of the same cleanup pass

## 2026-03-08 — Local Main Must Be Synced Before Cockpit Restarts After Merge

Decision class:
- require local `main` sync before running cockpit from that checkout after a cockpit PR merge

Reason:
- GitHub merge updates `origin/main`, not any local checkout
- restarting cockpit from stale local `main` can leave the runtime behind merged fixes

Impact:
- if cockpit will run from a local `main` checkout, sync it to `origin/main` first
- do not infer local checkout freshness from GitHub merge state alone
- if runtime uses another branch or dedicated worktree, verify that checkout explicitly instead

## 2026-03-08 — App-Server Review Completion Stays Bound to the Active Retry

Decision class:
- keep normal task turns strictly retry-bound
- allow built-in review completion to match either active review lifecycle id for the current attempt

Reason:
- live app-server review sessions can emit split or out-of-order review lifecycle ids
- exact single-id matching can hang review exit, but broad mismatched-id tolerance can consume stale completions from interrupted attempts

Impact:
- main task turns still ignore `turn/completed` packets whose id does not match the active retry
- built-in review accepts completion only when the id matches the current attempt's `review/start` or `turn/started` id
- review still requires both `status=completed` and `exitedReviewMode` before the worker uses the review result

## 2026-03-08 — Audited Branch-Diff Exception for PR24 Baseline

Decision class:
- allow a checked-in, PR-scoped branch-diff exception for the standalone code-quality gate

Reason:
- PR24 is the prerequisite Opus consult subsystem baseline for `OPUS_ADVISORY_COVERAGE_PLAN_AND_ACCEPTANCE_MATRIX_V1`
- the current branch-diff gate thresholds would otherwise block that baseline regardless of tail cleanup

Impact:
- exception applies only when the standalone gate is invoked with both `--base-ref` and `--exception-id`
- only `diff-volume-balanced` and `no-duplicate-added-blocks` may be waived
- runtime worker/autopilot task-time gate runs stay fail-closed and unchanged

## 2026-03-08 — Observer Drain Gate Stops Blocking on `seen` Review Digests

Decision class:
- keep review-fix closeout fail-closed for active sibling digests only

Reason:
- `seen` means a digest was opened, not that unresolved review work is still queued
- counting `seen` as blocking caused autopilot to get stuck after review exit even when only stale/opened digests remained

Impact:
- sibling `REVIEW_ACTION_REQUIRED` digests in `new` or `in_progress` still block `done`
- sibling digests in `seen` no longer block closeout by themselves
- follow-up capture requirements for accepted review debt remain unchanged


## 2026-02-03 — V2 Architecture Direction

Decision class:
- keep cockpit core in standalone OSS repo
- downstream projects consume via adapter + roster/skills

Impact:
- cockpit runtime logic remains centralized in this repo
- project-specific behavior is controlled by roster/skills/env defaults

## 2026-02-03 — App-Server Introduction (Historical)

Decision class:
- introduce `codex app-server` for persistent thread and interrupt handling
- historical precursor to the later app-server-only runtime cut

Impact:
- adapters could adopt app-server before the later app-server-only cleanup landed
- output schema contract remained stable through the later runtime transition

## 2026-02-03 — Per-Agent Worktree Isolation by Default

Decision class:
- codex workers should not share operator checkout

Impact:
- reduced branch/file clobbering between agents
- explicit repin/reset operations became necessary for deterministic recovery

## 2026-02-03 — Git Contract Preflight

Decision class:
- task-level `references.git` contract controls branch base and target

Impact:
- worker preflight can block deterministically on mismatched/dirty branch state
- follow-ups can be resumed on stable work branches

## 2026-02-07 — Dashboard Default Port Shift to 3210

Decision class:
- avoid common local `3000` collisions

Impact:
- tmux/dashboard startup is less collision-prone in active web dev environments

## 2026-02-17 — Rollout-Path STDERR Handling Policy

Decision class:
- do not fatalize or auto-repair on Codex rollout-path stderr lines alone

Reason:
- those stderr lines can appear even when rollout files exist
- fatal wrappers and aggressive auto-repair caused unnecessary retries/churn

Required behavior retained:
- per-agent single-writer lock
- strict resume precedence
- keep review gate enforcement intact

## 2026-02-23 — Autopilot Runtime Strictness Defaults

Decision class:
- autopilot defaults session scope to `root` (`AGENTIC_AUTOPILOT_SESSION_SCOPE=root`) with task fallback when root context is missing

Reason:
- root-scoped continuity preserves workflow context while bounded rotation limits long-thread drift

Operator impact:
- ensure autopilot tasks carry a stable `rootId` when root continuity is expected

## 2026-02-23 — Valua Restart Policy: Fail-Fast Autopilot Wiring Validation

Decision class:
- replace runtime roster auto-patching for `daddy-autopilot` with strict validation

Reason:
- startup-time mutation of roster wiring masked source-of-truth drift and made runtime behavior less auditable

Implementation impact:
- `adapters/valua/restart-master.sh` now validates dedicated autopilot wiring and aborts on mismatch
- required invariant:
  - configured autopilot resolves to a dedicated codex-worker worktree under `$VALUA_AGENT_WORKTREES_DIR`
  - source repo root and runtime checkout are rejected as autopilot workdirs
- debug-only bypass remains available via `VALUA_AUTOPILOT_DEDICATED_WORKTREE=0`

Traceability:
- detailed decision record: `docs/agentic/DECISIONS.md` (2026-02-23 fail-fast autopilot wiring validation)
- implementation PR: https://github.com/future3OOO/agentic-cockpit/pull/21

## 2026-02-28 — Packetized Opus Consult Gate (Claude CLI)

Decision class:
- add explicit consult packet kinds and a dedicated `opus-consult` worker
- enforce bounded pre-exec and post-review consult loops in autopilot runtime

Implementation impact:
- new packet contracts:
  - `OPUS_CONSULT_REQUEST`
  - `OPUS_CONSULT_RESPONSE`
- new worker:
  - `scripts/agent-opus-consult-worker.mjs`
- autopilot closure/dispatch control:
  - pre-exec barrier can block model execution
  - post-review consult can block `done` closure

Operational impact:
- consult interactions are now visible in inbox/receipts/artifacts instead of hidden in prompt-only state
- accepted consult responses are consumed/closed explicitly (no orchestrator notify)
- adapter/tmux defaults include consult gate env wiring

## 2026-02-28 — Opus Consult Hardening After Live Incident

Decision class:
- keep strict fail-fast startup for missing dedicated consult worker
- harden tmux startup/env so worker commands do not depend on implicit pane env
- normalize one known malformed provider response shape before schema validation (`block` + `final!=true`)

Impact:
- no ambiguous pane-start failures from missing `COCKPIT_ROOT` expansion
- reduced false `opus_schema_invalid` stops for block verdicts missing `final=true`
- behavior is enforced by regression tests rather than operator convention

## 2026-02-28 — Opus Consult Context Contract Tightening (V4.4)

Decision class:
- remove bespoke Opus sidecar skill doc (`OPUS_SKILLS.md`) and load consultant guidance from roster-defined `SKILL.md` assets
- close consult reason-code taxonomy and reject insufficient-context outcomes
- require explicit semantics for consult continuation vs user-input escalation

Impact:
- Opus consult context now follows the same roster skill wiring model as cockpit agents (`.codex/.claude` skill roots)
- autopilot only continues consult rounds on `reasonCode=opus_consult_iterate` + `final=false`
- `reasonCode=opus_human_input_required` blocks task progression with explicit required questions for user path

## 2026-03-08 — Post-Merge Resync Lock Safety Tightening

Decision class:
- extend resync lock safety to the project root destructive sync path
- auto-reclaim stale resync lock files when the recorded PID is dead

Impact:
- resync now skips with explicit lock evidence when a root-bound worker is still active
- target repins still skip active worker locks before destructive git steps
- dead `post-merge-resync` locks no longer require manual operator cleanup after crashes

## 2026-03-08 — Legacy Consult Barrier Defaults Stay Advisory

Decision class:
- legacy consult env inference must stay advisory unless the barrier env is explicitly enabled

Impact:
- legacy pre-exec/post-review signals can still request consult coverage
- direct worker invocation no longer silently upgrades advisory consult into hard gate mode when the barrier env is unset

## Incident Class: Observer "Seen but Not Emitted" for PR Comments

Symptom:
- `state/pr-observer/*.json` watermark advances for issue comment id
- no corresponding `PR<id>__ISSUE_COMMENT__<commentId>` packet/receipt in bus

Current root-cause class:
- observer actionable filter may classify comment as non-actionable
- observer still advances `lastSeenIssueCommentId` to cycle max id

Operational consequence:
- non-emitted comment id is not replayed automatically in baseline mode

Current state:
- this behavior is still present and should be treated as known runtime constraint

## Incident Class: Runtime Worktree / Branch Drift

Symptom:
- autopilot/agents running from unexpected branch or stale local checkout
- behavior appears inconsistent after merges

Root-cause class:
- launch path ambiguity between source checkout and runtime worktree
- stale or dirty local checkout reused unintentionally

Mitigation path:
- deterministic restart via `adapters/valua/restart-master.sh`
- optional `RESET_STATE=1` for codex runtime state rotation
- default repin to `origin/master`

## 2026-03-09 — Review Comments Are Evidence, Not Authority

Decision:
- reviewer/bot comments must be verified against current `HEAD`, runtime behavior, and the actual operator/task contract before code or tests change
- parser/selector/routing/guard fixes must define the behavior invariant first instead of patching directly to reviewer wording
- parser/selector/routing/guard fixes must preserve adjacent valid operator/task phrasing and reject adjacent false positives
- agents must not rewrite previously valid fixtures into narrower wording just to make a new heuristic pass

Reason:
- review-driven patches were overfitting to comment wording instead of the real runtime contract
- nearby valid phrases were breaking while suites stayed green because fixtures had been curve-fit to the new parser

Impact:
- review comments become evidence input instead of authority
- parser changes must now be derived from a stated behavior model instead of thread-by-thread patching
- parser and heuristic changes are forced to prove preserved valid behavior, not just the reported symptom
- green tests are less likely to hide contract regressions

## 2026-03-09 — Latest Review Directive and Validated Review-Only Closure Convergence

Decision:
- explicit narrowed commit selectors in `USER_REQUEST` review tasks come only from directive-shaped review lines in the newest update body when present, while title/full body still preserve review intent and PR reference
- explicit PR include/exclude directives fail closed when the PR commit list is unavailable, instead of silently leaving short-SHA filters unresolved
- pure review-only closure uses validated built-in review evidence only when the acted commit remains inside the requested review scope, and then does not self-block on execute delegation, self-review, or code-quality closure gates

Reason:
- prevent stale task text from replaying widened PR review scope after a narrowing update
- prevent degraded `gh pr view` fallback from silently dropping short-SHA exclusions on explicit PR review requests
- stop completed review roots from being stamped `blocked` on controller bookkeeping alone without letting unrelated reviewed SHAs widen closure eligibility

Impact:
- narrowed review overrides converge on the intended tail commit set
- explicit PR narrowing now fails loudly when directive SHAs cannot be validated against the PR commit list
- completed review-only roots close on actual engineering status instead of false `delegate_required` / self-review / code-quality bookkeeping, but only for the requested review scope

## Incident Class: Consult Response Schema Stop on Single-Field Provider Drift

Symptom:
- autopilot pre-exec consult blocks with `reasonCode=opus_schema_invalid`
- receipt includes validation error: `block verdict must set final=true`

Root-cause class:
- provider returned `verdict=block` with `final` not set to `true`
- worker previously hard-failed schema without repair path for this known malformed shape

Mitigation path:
- worker normalizes block payload to enforce `final=true` before schema validation
- keep strict schema validation for all other fields
- maintain regression test fixture for `block-final-false` output mode

## Incident Class: Non-Deterministic Worker Preflight Blocks

Symptom:
- workers repeatedly blocked on dirty tree/preflight mismatch
- autopilot receives completion/blocked churn with little progress

Root-cause class:
- expected deterministic branch sync collides with local uncommitted work

Mitigation path:
- keep `AGENTIC_EXEC_PREFLIGHT_AUTOCLEAN_DIRTY=1` where acceptable
- run deterministic repin/restart path when queues are blocked by preflight

## Incident Class: Overloaded/Drifting Documentation

Symptom:
- runtime details spread across README + multiple agentic docs
- conflicting or stale operator instructions

Mitigation path (this change):
- authoritative split references:
  - `docs/agentic/REFERENCE_INDEX.md`
  - `docs/agentic/CONTROL_LOOP_AND_PACKET_FLOW.md`
  - `docs/agentic/RUNTIME_FUNCTION_REFERENCE.md`
  - `docs/agentic/VALUA_ADAPTER_RUNTIME.md`

## Ongoing Operating Rules

1. Treat code as source-of-truth; docs must follow implementation.
2. Prefer deterministic restart paths over manual ad-hoc resets.
3. Keep guard overrides opt-in.
4. Keep completion gating fail-closed for quality/review critical paths.
5. When post-merge resync stays enabled, run against an isolated runtime checkout rather than a shared developer checkout.
6. Record future behavior-changing decisions in `DECISIONS.md` and summarize here.
7. For explicit review requests, newest-update directive selectors win when present; otherwise initial request titles/bodies remain authoritative selector input.
8. Pure built-in review closeout may take the `review_only` fast path even when `commitSha` is empty, but only when validated review coverage still matches the full requested target set.
