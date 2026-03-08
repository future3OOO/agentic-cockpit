# Decisions (Agentic Cockpit)

This log records **explicit decisions** made for Agentic Cockpit so reviewers can quickly understand why the system works the way it does.

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
- Decision: Autopilot workers enforce `AGENTIC_CODEX_ENGINE_STRICT=1` at runtime and fail fast when strict mode is disabled.
- Rationale: Autopilot review/closure gates depend on deterministic app-server semantics; permissive fallback risks false-green closure paths.
- Decision: Autopilot session scope defaults to `root` (`AGENTIC_AUTOPILOT_SESSION_SCOPE=root`) with task-scope fallback only when no root context is available.
- Rationale: Root-scoped continuity preserves workflow context while bounded rotation limits long-thread drift.
- Operator impact:
  1. Keep engine strict mode enabled in adapter/runtime env for autopilot agents.
  2. Ensure autopilot tasks carry a stable `rootId` when root continuity is expected.

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

## 2026-02-03 — Execution engine direction
- Decision: Add a new “Codex app-server engine” while keeping `codex exec` as a fallback.
- Rationale: App-server enables true “interrupt/continue on same thread” semantics and structured streaming events, improving reliability and reducing loop/compaction issues.

## 2026-02-03 — Engine switch + schema contract
- Decision: Select the engine via `AGENTIC_CODEX_ENGINE` (or `VALUA_CODEX_ENGINE`), defaulting to `exec` for compatibility.
- Rationale: App-server is still experimental; keeping `exec` as default avoids surprising breakage for downstream repos while allowing opt-in.
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
