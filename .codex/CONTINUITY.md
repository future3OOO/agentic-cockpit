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
- Current work: app-server engine integrated into `agent-codex-worker` with per-task thread persistence and task-update → interrupt semantics; docs/tests updated.

Done:
- Bootstrapped new repo skeleton with CI + docs + guardrails.
- Ported AgentBus, Codex worker, orchestrator, tmux cockpit scripts, and tests from Valua workflow.
- Added minimal skill set for OSS (operator chat I/O) and kept Valua env var compatibility.
- Added Valua adapter launcher to run cockpit against a Valua checkout.
- Implemented Codex app-server client + worker engine switch (`AGENTIC_CODEX_ENGINE=app-server`) with `turn/interrupt` on AgentBus updates.
- Added deterministic tests for the app-server engine using a dummy JSONL server.
- Added baseline OSS skills + sample roster wiring; added `scripts/init-project.mjs` to scaffold a new downstream repo (roster + skills).
- Added `code-change-verification` skill + scripts; wired into the sample roster and downstream scaffolding.
- Added a local dashboard server + UI on port 3000 (WSL/Windows-friendly): view status/inbox/receipts, send tasks, and append task updates.
- Wired the dashboard into tmux startup (autostart + best-effort auto-open on WSL/Windows).
- Dashboard polish: preserve “Send task → To” selection under auto-refresh; show agent role/kind labels; add “Cancel task” (marks skipped + writes receipt, no deletes).

Now:
- Add and maintain repo-level continuity ledger + decisions log for review/panel critique.
- Harden app-server engine docs + config defaults for downstream adapters.

Next:
- Consider a long-lived per-agent app-server process (reduce spawn churn) while keeping per-task threads by default.
- Decide packaging approach (`npm` packages vs single repo CLI) and confirm OSS license.
- Build the local dashboard (read-only first) on top of AgentBus status + receipts.

Open questions (UNCONFIRMED if needed):
- Should we ship as npm packages (`@agentic-cockpit/core` + `@agentic-cockpit/adapter-valua`) or keep as a single repo/CLI first?
- License confirmation: Apache-2.0 vs MIT.

Working set (files/ids/commands):
- `scripts/agent-codex-worker.mjs`
- `scripts/lib/agentbus.mjs`
- `scripts/tmux/cockpit.sh`
- `adapters/valua/run.sh`
- `node --test`
