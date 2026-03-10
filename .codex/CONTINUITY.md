Goal (incl. success criteria):
- Build “Agentic Cockpit V2” as a standalone OSS repo that runs a persistent Codex app-server per agent for reliable mid-task updates (interrupt/continue), better streaming observability, and reduced looping/confusion.
- Keep a working “exec engine” fallback and maintain safety guardrails (no secrets, no accidental merges/protected pushes).

Constraints/Assumptions:
- No secrets in git/logs. Any example env values must be placeholders.
- Cross-platform: WSL/Linux first; Windows native optional.
- Repo is OSS and should not depend on Valua internals; Valua is supported via an adapter.

Key decisions:
- Repo strategy: new standalone OSS repo with adapter system; Valua is first downstream consumer.
- License: Apache-2.0 (can be changed early if needed).
- Default paths: `~/.agentic-cockpit/bus` and `~/.agentic-cockpit/worktrees` (Valua adapter preserves Valua defaults).

State:
- Current work: reduce downstream Valua token burn + startup thrash by making app-server truly persistent per agent, adding warm-start prompting (skip skills on warm resume), and making orchestrator → autopilot digests compact by default.

Done:
- Bootstrapped new repo skeleton with CI + docs + guardrails.
- Ported AgentBus, Codex worker, orchestrator, tmux cockpit scripts, and tests from Valua workflow.
- Added minimal skill set for OSS (operator chat I/O) and kept Valua env var compatibility.
- Added Valua adapter launcher to run cockpit against a Valua checkout.
- Implemented Codex app-server client + worker engine switch (`AGENTIC_CODEX_ENGINE=app-server`) with `turn/interrupt` on AgentBus updates.
- Made app-server persistent per agent (shared client in `agent-codex-worker`; stopped automatically on `--once`).
- Added warm-start prompt bootstrap state (skillsHash + thread pin) so resumed threads can skip `$skill` invocations.
- Added autopilot context modes (`full|thin|auto`) and thin context fast-path for warm-resumed `ORCHESTRATOR_UPDATE`.
- Orchestrator now sends compact digests to autopilot by default; daddy digests are configurable (`AGENTIC_ORCH_*`).
- Added root-scoped Codex session pins (`state/codex-root-sessions/<agent>/<rootId>.json`) + optional per-agent pins for all workers (behind `AGENTIC_CODEX_WARM_START=1`).
- Added `CODEX_HOME` isolation support (`AGENTIC_CODEX_HOME_MODE=agent|cockpit`) with auth/config bootstrapping.
- tmux startup now sources `scripts/tmux/agents.conf` (mouse on, ergonomics) and supports hard reset env (`AGENTIC_TMUX_HARD_RESET=1`).
- Added `scripts/rollout-metrics.mjs` to quantify token burn by agent/kind from rollout JSONL.
- Added optional autopilot digest fast-path (`AGENTIC_AUTOPILOT_DIGEST_FASTPATH=1`) with allowlist; includes tests.
- Hardened `runCodexExec` stdin handling to ignore benign `EPIPE` when a child exits early (prevents retry-loop crashes in doubles/tests).
- Fixed `scripts/rollout-metrics.mjs` parsing bug (comment contained `*/`) and extended output with invocation counts, rootId hot-spots, and ORCHESTRATOR_UPDATE source breakdown.
- Added Valua-specific exec budget report + fix plan in `docs/agentic/VALUA_EXEC_BUDGET_WASTE_ROUTES.md`.
- Valua adapter now enables app-server + warm-start + compact digests + per-agent CODEX_HOME by default.
- Added deterministic tests for the app-server engine using a dummy JSONL server.
- Added baseline OSS skills + sample roster wiring; added `scripts/init-project.mjs` to scaffold a new downstream repo (roster + skills).
- Added `code-change-verification` skill + scripts; wired into the sample roster and downstream scaffolding.
- Added a local dashboard server + UI on port 3000 (WSL/Windows-friendly): view status/inbox/receipts, send tasks, and append task updates.
- Wired the dashboard into tmux startup (autostart + best-effort auto-open on WSL/Windows).
- Dashboard polish: preserve “Send task → To” selection under auto-refresh; show agent role/kind labels; add “Cancel task” (marks skipped + writes receipt, no deletes).
- Worktrees by default: codex-worker agents run in per-agent git worktrees (`agent/<name>` under `~/.agentic-cockpit/worktrees/<name>`), with opt-out via `AGENTIC_WORKTREES_DISABLE=1`.
- Git Contract: add `references.git` conventions and worker git preflight (checkout/create `workBranch` from `baseSha`) to prevent stale-head regressions and make follow-ups resumable.
- Opus consult runtime hardened after live incident:
  - tmux now sets `COCKPIT_ROOT` at session scope and eagerly expands `$COCKPIT_ROOT` in worker `startCommand`.
  - consult worker repairs malformed provider output (`verdict=block` + `final!=true` => coerced `final=true`) before schema validation.
  - added regression coverage in `scripts/__tests__/opus-consult-worker.test.mjs` for `block-final-false`.

Now:
- Keep Opus consult barrier deterministic under live queue traffic and verify no false `opus_schema_invalid` for repaired block payloads.
- Keep launcher behavior explicit and avoid reliance on pane-local env assumptions.

Next:
- Validate the token-reduction deltas on a real Valua run (before/after via `scripts/rollout-metrics.mjs`).
- Decide packaging approach (`npm` packages vs single repo CLI) and confirm OSS license.
- Build the local dashboard (read-only first) on top of AgentBus status + receipts.
- Add one end-to-end test path that exercises autopilot -> consult -> schema-repaired block -> autopilot block reason propagation.

Open questions (UNCONFIRMED if needed):
- Should we ship as npm packages (`@agentic-cockpit/core` + `@agentic-cockpit/adapter-valua`) or keep as a single repo/CLI first?
- License confirmation: Apache-2.0 vs MIT.

Working set (files/ids/commands):
- `scripts/agent-codex-worker.mjs`
- `scripts/lib/agentbus.mjs`
- `scripts/tmux/cockpit.sh`
- `adapters/valua/run.sh`
- `scripts/rollout-metrics.mjs`
- `node --test`
