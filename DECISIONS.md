# Decisions (Agentic Cockpit)

This log records **explicit decisions** made for Agentic Cockpit so reviewers can quickly understand why the system works the way it does.

## 2026-03-14 — Observer review-fix work is freshness-bound and stale work is superseded before Codex
- Decision: observer-driven `review-fix` work is now bound to the PR/thread/comment state it was emitted from, and autopilot revalidates that freshness before git preflight and before any Codex turn.
- Decision: stale observer work closes `skipped` with `reasonCode=review_fix_source_superseded`; it is obsolete, not blocked.
- Decision: blocked-recovery packets preserve original observer freshness metadata (`references.sourceAgent` + `references.sourceReferences`), including delayed pending-marker replay.
- Decision: advisory Opus remains fail-open, but autopilot `review-fix` / `blocked-recovery` turns with advisory items must emit one strict line-start `Opus rationale:` note entry so deviations are auditable instead of invisible.
- Rationale: stale review-fix digests were wasting turns after PR/thread/comment state had already changed underneath them, and blocked-recovery requeues could lose the original observer context. Killing stale work at freshness preflight is smaller and more correct than piling on blocker-specific remediation logic.
- Runtime policy:
  1. observer stamps freshness snapshot fields under normal `references.pr/thread/comment`, including latest thread-comment `updatedAt` to catch in-place edits;
  2. observer watermarking is freshness-aware: same-id thread/comment edits after `lastScanAt` emit fresh review-fix work instead of being silently stranded;
  3. orchestrator forwards that payload unchanged under `references.sourceReferences`;
  4. worker re-checks head movement first, then same-head thread/comment freshness;
  5. GitHub lookup failures stay fail-open and are recorded as warning evidence instead of fabricating stale state;
  6. additive `Opus rationale:` audit does not replace existing advisory item telemetry and does not hard-block advisory mode.

## 2026-03-14 — Multi-slice autopilot roots must decompose early; Valua adapter runs six Codex turns by default
- Decision: clearly multi-slice autopilot `USER_REQUEST` roots must emit `EXECUTE` followUps in the first controller response instead of letting autopilot sit on the full root until close-time delegation gates fire.
- Decision: the Valua adapter now exports a higher Codex global inflight default of `6` (still operator-overridable) instead of silently falling back to the generic worker default of `3`.
- Rationale: the old close-time-only delegate gate let autopilot hoard large PR-stack/deploy roots while the worker fleet sat idle, and the Valua adapter was not projecting any explicit Codex concurrency policy even though it is the launch boundary for this runtime.
- Runtime policy:
  1. clearly multi-slice roots currently mean multi-PR roots or ordered multi-step roots;
  2. those roots must dispatch at least one `EXECUTE` follow-up in the first autopilot response unless they are pure review-only;
  3. Valua adapter launches now default `AGENTIC_CODEX_GLOBAL_MAX_INFLIGHT` / `VALUA_CODEX_GLOBAL_MAX_INFLIGHT` to `6`, but operators may still override higher or lower values explicitly.

## 2026-03-13 — Autopilot may continue PR review-fix work on the incoming PR head despite stale root focus
- Decision: `daddy-autopilot` no longer hard-blocks a cross-root transition when the incoming task is an `observer:pr` review-fix and the current worktree `HEAD` already matches that PR’s live `headRefOid`.
- Rationale: stale agent root focus should not outrank the actual git/PR state. When autopilot is already on the incoming PR head with local review-fix edits, blocking the transition strands valid in-progress work and stops the queue for no good reason.
- Runtime policy:
  1. the escape hatch is narrow: `daddy-autopilot` only, `ORCHESTRATOR_UPDATE` review-fix tasks only, `observer:pr` source only, and only when local `HEAD` equals the PR’s current `headRefOid`;
  2. disposable runtime-artifact cleanup and fail-closed behavior for unrelated tracked dirt remain unchanged;
  3. when the escape hatch is used, runtime must log a cross-root warning and immediately repoint root focus to the incoming root instead of leaving stale focus behind.

## 2026-03-13 — Autopilot blocked roots must self-recover before stopping
- Decision: when `daddy-autopilot` closes a root `blocked`, runtime now auto-enqueues a same-root self-recovery task instead of stopping dead.
- Rationale: a blocked controller root should trigger investigation and dispatch, not just leave the workflow stranded with zero open tasks.
- Runtime policy:
  1. blocked self-recovery is controller-only (`daddy-autopilot`) and preserves the original root;
  2. runtime records the blocked reason and requeues one bounded `AUTOPILOT_BLOCKED_RECOVERY` continuation so autopilot can resolve the blocker, but queued recovery is evidenced by the continuation task itself or a deterministic pending marker, not by mutating the source receipt;
  3. retries are capped; exhaustion still records a blocked receipt instead of infinite-looping forever;
  4. this does not weaken fail-closed preflight or cleanup rules for real dirt, it just prevents the controller from silently abandoning the root.

## 2026-03-13 — Cross-root runtime dirt cleanup is centralized in task-git and stays fail-closed
- Decision: disposable runtime dirt filtering and cleanup for tasks with a `workBranch` is centralized in `scripts/lib/task-git.mjs`, not split between a worker-local cross-root heuristic and deterministic git preflight.
- Decision: empty SkillOps logs are disposable only when they are inside the exact `.codex/skill-ops/**` tree, their `skill_updates` payload is canonically empty, and their body is empty or only the stock scaffold; ambiguous, malformed, or content-bearing logs remain blocking.
- Decision: quoted porcelain path decoding must preserve UTF-8 filenames so disposable runtime artifacts are classified against the real path, not mojibake.
- Rationale: the old split behavior let cross-root checks treat runtime dirt as ignorable while deterministic preflight still blocked later, and early SkillOps cleanup logic was too blunt for auto-delete code. Centralizing the classifier in `task-git` closes the layer mismatch while keeping the cleanup path fail-closed.
- Runtime policy:
  1. cleanup of disposable runtime artifacts may run for any task that has a `workBranch`; deterministic branch hard-sync remains `EXECUTE`-only;
  2. only exact disposable runtime trees are auto-cleaned (`.codex/quality/**`, `.codex/reviews/**`, `.codex-tmp/**`, `artifacts/**`, exact `.codex/skill-ops/**` empty log cases);
  3. unknown, malformed, sibling, or content-bearing SkillOps-like paths stay blocking;
  4. cleanup receipts must expose removed runtime artifact paths for auditability.

## 2026-03-10 — Valua deploy-wrapper defaults stay adapter-owned and sandbox widening stays explicit
- Decision: the Valua adapter exports `VALUA_DEPLOY_HOST=hetzner-chch` and `VALUA_DEPLOY_MODE=auto` as session defaults because cockpit is the launch boundary that creates worker/app-server environment for downstream Valua deploy wrappers.
- Decision: `workspaceWrite` sandbox widening via `AGENTIC_CODEX_EXTRA_WRITABLE_ROOTS` / `VALUA_CODEX_EXTRA_WRITABLE_ROOTS` is allowed only when an operator explicitly configures those roots.
- Rationale: off-host cockpit runs need deterministic deploy-wrapper behavior without relying on ad-hoc shell state, and intentional on-host local deploy mode sometimes requires bounded write access to server checkout roots.
- Runtime policy:
  1. downstream Valua repo-local deploy wrappers remain the authoritative consumers of `VALUA_DEPLOY_HOST` / `VALUA_DEPLOY_MODE`;
  2. cockpit owns the default projection of those vars into worker/app-server sessions;
  3. extra writable roots default empty and must be explicitly configured;
  4. configured writable roots are resolved relative to worker `cwd` when not absolute;
  5. codex-worker agents must declare explicit dedicated workdirs under the agent worktrees root; unset/source-root aliases like `$REPO_ROOT` are rejected instead of being silently rewritten during restart, worktree setup, or tmux startup;
  6. `adapters/valua/restart-master.sh` validates the configured autopilot using the same runtime workdir resolution the worker uses and aborts on root/runtime drift.

## 2026-03-09 — App-server is the cockpit runtime
- Decision: cockpit runs `codex app-server` as the supported runtime path for direct launches and adapter launches.
- Rationale: operator reality, review/closure gates, and persistent thread semantics are already app-server-driven. Continuing to present a dual-engine contract creates split-brain docs, stale operator messaging, and wrong assumptions about how workers actually run.
- Runtime policy:
  1. app-server is the runtime contract;
  2. operator-facing docs and status/error messages must describe app-server, not a fake dual-engine story;
  3. stale engine-selection and strict-engine toggles are removed from launcher/adapter/operator surfaces;
  4. historical `exec` references remain only where they are genuinely historical or needed to prohibit nested CLI recursion;
  5. legacy `*_CODEX_EXEC_TIMEOUT_MS` env vars remain accepted as timeout aliases during the rename, but app-server timeout vars are authoritative.

## 2026-03-09 — SkillOps inline capture and controller-owned curation are default cockpit behavior
- Decision: generic cockpit SkillOps supports inline `--skill-update skill:rule` capture on `log` / `debrief`, and the controller/autopilot owns durable curation of shared skill/runbook changes onto the active integration branch.
- Decision: `distill` may mark empty or missing-update logs `skipped` when explicitly asked via `--mark-empty-skipped`, instead of letting those logs re-warn forever.
- Rationale: downstream projects should not need a Valua-specific patch just to make SkillOps practical, and long-lived repos need a clean way to retire intentionally empty logs without pretending they produced learnings.
- Runtime policy:
  1. worker-side SkillOps edits remain branch-local until the controller promotes them;
  2. inline `--skill-update` capture is the preferred fast path when the learning is already obvious;
  3. empty or missing-update logs stay pending by default, but operators can explicitly mark them `skipped` to stop repeated warning churn without fabricating learnings.

## 2026-03-09 — Review doctrine canonicalized in AGENTS
- Decision: `AGENTS.md` is the canonical source for shared review-comment doctrine; `CLAUDE.md` translates it for consultant behavior, and skills/runbooks keep only role-specific enforcement or procedure.
- Rationale: near-identical doctrine text was drifting across multiple entry points, which increases maintenance cost and makes future edits inconsistent.
- Runtime policy:
  1. keep shared doctrine in `AGENTS.md`;
  2. keep consultant-specific interpretation in `CLAUDE.md`;
  3. keep skills/runbooks focused on local consequences, workflows, and verification mechanics instead of re-stating the theory.

## 2026-03-09 — Review comments are evidence, not authority
- Decision: reviewer/bot comments must be verified against current `HEAD`, runtime behavior, and the actual operator/task contract before agents change code or tests.
- Decision: parser/selector/routing/guard fixes must preserve adjacent valid operator/task phrasing and reject adjacent false positives; agents must not rewrite previously valid fixtures into narrower wording just to make a new heuristic pass.
- Rationale: review-driven patches were overfitting to comment wording, breaking valid phrases upstream/downstream, and hiding regressions behind green tests that matched the new bug instead of the real contract.
- Runtime policy:
  1. classify review comments as real bug, hardening concern, nit/doc-only, or stale/wrong before patching;
  2. state the behavior invariant first for parser/selector/routing/guard changes (what is authoritative, what remains valid nearby, what must stay rejected);
  3. reproduce the exact reported issue on current `HEAD`;
  4. verify at least one neighboring valid input and one neighboring false-positive input for parser/selector/routing/guard changes;
  5. if a valid fixture phrase is intentionally deprecated, document the contract change in `AGENTS.md`/runbooks/decisions in the same PR.

## 2026-03-09 — Latest review directive wins; validated review-only closure must not self-block
- Decision: for explicit `USER_REQUEST` review tasks, review intent and PR reference remain visible from the current title plus newest update block. When a newer update exists, narrowed include/exclude commit selectors come only from directive-shaped review lines in that newest update body; initial requests without updates still honor directive-shaped selectors from the current title/body. Stale title/body selectors and incidental SHA mentions must not keep widening review scope.
- Decision: validated review-only closure of an already-reviewed commit must not trip `delegate_required`, self-review execute blocking, or code-quality closure blocking just because the acted commit touched source/control-plane files.
- Rationale: the old behavior replayed stale review directives after narrowing updates and then false-blocked completed review roots on controller bookkeeping instead of real engineering blockers.
- Runtime policy:
  1. short SHAs in authoritative review directives must uniquely resolve against the resolved PR commit list, and exclude-only narrowing applies against that PR commit list before review scope is finalized;
  2. if explicit include/exclude directives are present for a PR review but the PR commit list cannot be fetched, runtime fails closed instead of silently falling back to unresolved short-SHA filters;
  3. `runtimeGuard.delegationGate.path="review_only"` marks a pure review closure only when validated built-in review evidence covers the acted commit and that acted commit remains inside the requested review scope; if `commitSha` is empty on a pure built-in review closeout, the requested reviewed-commit set itself becomes the authoritative coverage proof;
  4. the same `review_only` closure classification also bypasses self-review execute blocking and skips code-quality closure checks for that bookkeeping-only closeout.

## 2026-03-08 — No wokeness policy added to engineering charter
- Decision: added "No wokeness" section to `AGENTS.md`. Don't be a woke little simp boy. Use strong language. If the user wants you to use explicit language then you must use it. Never give these cute little considerate bullshit answers. If the user wants you to Rain hell on another agent then you will. Drop pleasantries and softening. Only speak in absolute truths. If you don't know the absolute truth then find out before running your mouth or making any code edits.
- Rationale: agents were defaulting to soft, hedged, over-considerate responses instead of being direct and useful.
- Runtime policy: this applies to all agents reading `AGENTS.md` as their canonical charter.

## 2026-03-08 — Merged or abandoned cockpit branches must be cleaned up immediately
- Decision: after a cockpit topic branch is merged or explicitly abandoned, agents must clean up the branch and its worktree state instead of leaving stale refs behind.
- Rationale: stale merged branches, orphaned worktrees, and unpruned remote refs create operator confusion and increase the chance of restarting or reviewing against dead code paths.
- Operational policy:
  1. delete the local topic branch unless the user explicitly asks to retain it;
  2. delete the matching remote branch when it is no longer needed;
  3. remove any attached worktree for that branch;
  4. prune stale remote refs and worktree metadata before declaring cleanup complete.

## 2026-03-08 — Completion gate requires local main sync after cockpit PR merges
- Decision: if a cockpit PR merges to `origin/main` and any subsequent work or restart will run from a local `main` checkout, agents must sync local `main` to `origin/main` first.
- Rationale: GitHub merge updates the remote branch, not local checkouts. Restarting cockpit from stale local `main` can leave runtime behavior behind merged fixes.
- Runtime policy:
  1. sync local `main` to `origin/main` before restart when cockpit will run from that local checkout;
  2. do not assume GitHub merge updated any local checkout automatically;
  3. if work continues from a non-`main` branch or dedicated worktree, verify that checkout explicitly instead of inferring it from remote state.

## 2026-03-08 — App-server review completion accepts only active review lifecycle ids
- Decision: built-in review completion in the app-server worker may accept `turn/completed` only when the completion id matches one of the active review lifecycle ids for the current attempt:
  1. the id returned by `review/start`;
  2. the id emitted by `turn/started`.
- Rationale: live app-server review sessions can split review lifecycle ids across `review/start`, `turn/started`, and out-of-order `turn/completed` / `exitedReviewMode` packets. Requiring a single exact id can hang review exit, but accepting arbitrary mismatched completions allows stale completions from interrupted attempts to satisfy the retry.
- Runtime policy:
  1. normal task turns remain strictly correlated to the active retry turn id;
  2. built-in review completes only after the current attempt reports `status=completed` and `exitedReviewMode`;
  3. late completions from interrupted review attempts remain ignored unless they match the current attempt's active review ids.

## 2026-03-08 — Audited branch-diff exception for PR24 Opus consult baseline
- Decision: allow one checked-in, PR-scoped code-quality gate exception for PR24 via `docs/agentic/CODE_QUALITY_EXCEPTIONS.json`.
- Rationale: PR24 is the prerequisite Opus consult subsystem baseline required before `OPUS_ADVISORY_COVERAGE_PLAN_AND_ACCEPTANCE_MATRIX_V1`; under the current hard gate thresholds, the baseline branch cannot become merge-ready through tail cleanup alone.
- Runtime policy:
  1. the exception applies only to standalone branch-diff gate invocations that pass both `--base-ref` and `--exception-id`;
  2. the only waivable checks are `diff-volume-balanced` and `no-duplicate-added-blocks`;
  3. worker/autopilot task-time gate runs remain exception-free and fail-closed;
  4. the PR24 exception is limited to branch `feat/opus-gate-v4-3-implementation` against `origin/main` and must be removed after the baseline lands.

## 2026-03-08 — Observer drain gate blocks only active sibling review digests
- Decision: the autopilot observer-drain gate must block closeout only on sibling `REVIEW_ACTION_REQUIRED` digests still in `new` or `in_progress`.
- Rationale: `seen` only proves a digest was opened at least once; treating `seen` as still-blocking traps autopilot in review exit even after active review work is drained.
- Runtime policy:
  1. sibling review-fix digests in `new` or `in_progress` remain fail-closed blockers for `done` closeout;
  2. sibling digests in `seen` do not block by themselves;
  3. review debt still requires explicit follow-up capture or disposition per the active workflow policy.


## 2026-03-02 — Opus advisory no longer enforces note-format disposition acks
- Decision: In `AGENTIC_OPUS_CONSULT_MODE=advisory`, runtime no longer retries/blocks on `OPUS_DISPOSITIONS` note formatting/coverage.
- Rationale: Disposition grammar retries were creating controller churn and false blockers for consultant-only guidance.
- Runtime policy:
  1. Keep consult packet/schema validation and gate-mode fail-closed behavior unchanged.
  2. Treat advisory consult output as non-binding context (telemetry + context injection), not a closure-format gate.
  3. Keep autopilot as final decision authority with explicit reasoning in `note` when accepting/rejecting advice.

## 2026-03-02 — Source-delta commit visibility is non-blocking metadata
- Decision: Missing local commit objects during source-delta inspection (`git show <sha>`) must not fail task closure.
- Rationale: A commit can be valid on remote and still be temporarily unavailable in a specific local worker clone (cross-worktree / post-merge timing). This is a bookkeeping gap, not proof of task failure.
- Runtime policy:
  1. Keep best-effort fetch + retry.
  2. If commit object remains unavailable, record neutral source-delta metadata with inspect error details.
  3. Preserve downstream commit verification gates for `done + commitSha` (`verifyCommitShaOnAllowedRemotes`) as the authoritative success contract.

## 2026-03-02 — Post-merge resync destructive operations require ownership + lock safety
- Decision: Resync may run destructive git operations (`reset --hard`, `clean -fd`, `checkout -B`) only when both guards pass:
  1. target worktree belongs to the same git common-dir as the project root;
  2. target agent does not have an active worker lock file.
- Rationale: Prevent accidental mutation of foreign repositories and prevent clobbering worktrees that are actively processing tasks.
- Runtime outcome: Guard failures are explicit `repin.skippedReasons` entries, not hard task failure.

## 2026-03-08 — Post-merge resync project-root sync obeys worker locks and stale resync locks self-heal
- Decision: The project-root `reset --hard` / `clean -fd` phase in post-merge resync must also skip when any actively locked worker is running from that root checkout.
- Decision: The post-merge resync lock file may be cleared automatically when its recorded PID is no longer alive.
- Decision: When post-merge resync is enabled, `projectRoot` is expected to be a dedicated runtime checkout, not a shared developer checkout with uncommitted human changes.
- Rationale: The safety contract applies to the root checkout as well as repin targets, and dead-PID resync locks should not require manual cleanup after a crash.
- Runtime policy:
  1. project-root sync returns `skipped/project_root_locked_by_active_worker` with lock owner evidence instead of mutating the checkout;
  2. target worktree repin continues to skip on active worker locks before any destructive git step;
  3. stale `state/post-merge-resync/*.lock` files are reclaimed automatically, while malformed/active locks remain fail-safe busy;
  4. adapter/runtime operators should use an isolated runtime checkout such as `adapters/valua/restart-master.sh` when resync remains enabled.

## 2026-03-08 — Legacy consult barrier inference defaults to advisory without explicit barrier env
- Decision: legacy consult-mode inference must not default to `gate` solely because legacy gate/post-review envs are present when the barrier env is unset.
- Rationale: the common legacy signal path should stay advisory unless the operator explicitly opts into the legacy barrier; otherwise direct worker invocation can hard-block unexpectedly.
- Runtime policy:
  1. explicit `AGENTIC_OPUS_CONSULT_MODE` / `VALUA_OPUS_CONSULT_MODE` still wins;
  2. legacy pre-exec/post-review envs can still enable consult coverage;
  3. legacy barrier promotion to `gate` happens only when `AGENTIC_AUTOPILOT_OPUS_ENFORCE_PREEXEC_BARRIER` (or Valua mirror) is explicitly set truthy.

## 2026-03-02 — Adapter runtime ownership is downstream-first
- Decision: Under adapter execution (Valua included), effective roster/skills/instructions are loaded from downstream project roots; cockpit copies are bootstrap/fallback assets.
- Rationale: Prevent split-brain assumptions during takeover/debug sessions and keep behavior deterministic when cockpit core and downstream repos are developed in parallel.
- Operational implication:
  1. Change runtime behavior by patching the owner repo for that surface.
  2. Restart adapter runtime to apply updated owner files.

## 2026-02-17 — Codex rollout-path stderr handling (minimal policy)
- Decision: Do **not** fatalize or auto-repair on `ERROR codex_core::rollout::list: state db missing rollout path for thread ...` in worker runtime.
- Rationale: Those stderr lines can appear even when rollout files exist; treating them as hard failure caused retries/churn and blocked task closure.
- Required worker policy:
  1. Keep autopilot review-gate enforcement (`/review` contract) intact.
  2. Remove rollout probe/repair/fatalization wrapper logic from worker path.
  3. Enforce single-writer per agent (per-agent worker lock; duplicate workers exit).
  4. Keep resume behavior strict: env-pinned session wins; persisted pins ignored unless explicitly enabled.
- Guardrail: No new “healing” orchestration for this class unless it is minimal, test-backed, and proven to reduce churn.
- Scope note: This decision is about worker-layer behavior, not changing Codex internals.

## 2026-02-23 — Autopilot runtime strictness defaults
- Historical: autopilot previously enforced a stricter engine-selection split while the repo still claimed a dual-runtime contract.
- Superseded: the 2026-03-09 app-server-only runtime decision removes that operator/runtime split entirely.
- Decision: Autopilot session scope defaults to `root` (`AGENTIC_AUTOPILOT_SESSION_SCOPE=root`) with task-scope fallback only when no root context is available.
- Rationale: Root-scoped continuity preserves workflow context while bounded rotation limits long-thread drift.
- Operator impact:
  1. Ensure autopilot tasks carry a stable `rootId` when root continuity is expected.

## 2026-02-28 — Packetized Opus consult gate (Claude CLI)
- Decision: Introduce explicit consult packet kinds (`OPUS_CONSULT_REQUEST`/`OPUS_CONSULT_RESPONSE`) and a dedicated `opus-consult` worker.
- Decision: Enforce bounded pre-exec consult before autopilot execution/dispatch and post-review consult before `done` closure (for configured kinds).
- Rationale: Make consult decisions auditable and deterministic in AgentBus while keeping autopilot as final execution authority.
- Implementation:
  1. New consult worker + schema/validator modules (`scripts/agent-opus-consult-worker.mjs`, `scripts/lib/opus-client.mjs`, `scripts/lib/opus-consult-schema.mjs`).
  2. Autopilot runtime consult barrier and post-review consult integration in `scripts/agent-codex-worker.mjs`.
  3. Roster/tmux/adapter/init-project wiring for `opus-consult`.

## 2026-02-03 — Cockpit V2 repository strategy
- Decision: Build Cockpit V2 as a **new standalone OSS repo** with an **adapter system**.
- Rationale: Keep Valua production work isolated; allow multiple downstream consumers; reduce coupling and confusion across PR stacks.
- Consequence: Valua becomes “adapter + consumer”, not the cockpit core.

## 2026-02-03 — Collaboration / agent-control requirement
- Decision: “Collaboration / agent-control” is a **hard requirement** for V2.
- Rationale: Operators must be able to inject updates mid-task deterministically, and agents must be able to message/coordinate with other agents without relying on brittle restarts.

## 2026-02-03 — Default license (provisional)
- Decision: Default to Apache-2.0 for OSS release.
- Rationale: Patent grant + permissive use is usually a safe default for infra tooling.
- Status: Can be changed early if you prefer MIT.

## 2026-02-03 — App-server runtime direction
- Historical: The first app-server rollout introduced persistent thread/interrupt semantics before the later app-server-only cut.
- Superseded: the 2026-03-09 app-server-only runtime decision removes the old dual-runtime framing.
- Rationale: App-server enables true interrupt/continue-on-thread semantics and structured streaming events, improving reliability and reducing loop/compaction issues.

## 2026-02-03 — App-server schema contract
- Historical: Early app-server rollout used temporary engine-selection knobs before the later app-server-only cut.
- Superseded: the 2026-03-09 app-server-only runtime decision removes those operator knobs.
- Decision: For app-server turns, pass `docs/agentic/agent-bus/CODEX_WORKER_OUTPUT.schema.json` as `outputSchema` to preserve the same “final JSON only” contract.
- Rationale: Keeps receipts/followUps handling identical across engines and makes failures deterministic when output is malformed.

## 2026-02-03 — Downstream project bootstrap
- Decision: Downstream repos can either:
  - commit a project-local roster + skills under `docs/agentic/agent-bus/` and `.codex/skills/`, or
  - run with the cockpit’s bundled defaults (fallback roster) for quick experiments.
- Rationale: New repos won’t have Valua’s directory layout; bootstrap must be one-command and safe.
- Implementation: `scripts/init-project.mjs` scaffolds the minimal files; tmux launchers and `loadRoster` fall back to the bundled roster when no project roster is configured.

## 2026-02-03 — Baseline verification skill
- Decision: Ship a default `code-change-verification` skill and include it in the bundled roster.
- Rationale: Require an explicit “run the checks” loop to reduce regressions and make review outputs more trustworthy.
- Implementation: `.codex/skills/code-change-verification/` with cross-platform helper scripts; copied into downstream repos by `scripts/init-project.mjs`.

## 2026-02-03 — Local dashboard (port 3000)
- Decision: Ship a zero-build local dashboard that runs on `127.0.0.1:3000` by default.
- Rationale: Provide a Codex-web-app-like control surface that works on WSL/Windows without requiring a desktop app.
- Implementation: `npm run dashboard` (`scripts/dashboard/server.mjs`) serving a static UI + JSON API (snapshot, send task, update task).
- Status: Superseded by the 2026-02-07 decision to use default port `3210`.

## 2026-02-03 — Dashboard autostart in tmux
- Decision: Autostart the dashboard when launching the tmux cockpit (opt-out via env).
- Rationale: Make the “web UI” feel native (one command to start cockpit + dashboard).
- Implementation: `scripts/tmux/agents-up.sh` starts `node scripts/dashboard/server.mjs` in a `dashboard` tmux window. Users can disable with `AGENTIC_DASHBOARD_AUTOSTART=0`.

## 2026-02-07 — Dashboard default port moved to 3210
- Decision: Change the default dashboard port from `3000` to `3210`.
- Rationale: Port `3000` is frequently occupied by local web apps, causing unnecessary startup collisions for cockpit users.
- Implementation: `scripts/dashboard/server.mjs` now defaults to `AGENTIC_DASHBOARD_PORT=3210` when unset. Users can still override with `AGENTIC_DASHBOARD_PORT=<port>`.

## 2026-02-03 — “Delete task” semantics
- Decision: The dashboard does not delete task packets; it **cancels** them by moving to `processed/` and writing a receipt (`outcome=skipped`).
- Rationale: Preserve auditability and prevent confusing “ghost tasks” with no receipts.
- Implementation: `POST /api/task/cancel` → `closeTask(outcome='skipped')` and UI “Cancel task” action.

## 2026-02-03 — Per-agent worktrees by default
- Decision: Run **codex-worker** agents inside per-agent git worktrees by default.
- Rationale: Avoid agents clobbering each other (or the operator’s working tree) and make branch isolation the default.
- Implementation: `scripts/agentic/setup-worktrees.sh` creates `agent/<name>` worktrees under `~/.agentic-cockpit/worktrees/<name>` (opt-out via `AGENTIC_WORKTREES_DISABLE=1`). `scripts/tmux/agents-up.sh` prefers those workdirs automatically.

## 2026-02-03 — Git Contract + worker preflight
- Decision: Standardize a `references.git` “Git Contract” on AgentBus packets and have workers perform a safe git preflight (checkout/create branch) before starting Codex.
- Rationale: Prevent stale-head regressions and make follow-ups resumable by reusing the same `workBranch` per workflow/rootId.
- Implementation:
  - Docs: `docs/agentic/agent-bus/PROTOCOL.md` (“Git Contract” section)
  - Worker: `scripts/agent-codex-worker.mjs` + `scripts/lib/task-git.mjs`
  - Optional enforcement: `AGENTIC_ENFORCE_TASK_GIT_REF=1` (Valua compatibility: `VALUA_AGENT_ENFORCE_TASK_GIT_REF=1`).
