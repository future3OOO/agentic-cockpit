# Decisions (Agentic Cockpit)

This log records **explicit decisions** made for Agentic Cockpit so reviewers can quickly understand why the system works the way it does.

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
