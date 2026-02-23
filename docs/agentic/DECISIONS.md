# Decisions Log

This file records behavior-changing runtime decisions.

## 2026-02-23 — Valua Restart Policy: Fail-Fast Autopilot Wiring Validation

Decision:
- `adapters/valua/restart-master.sh` must validate dedicated `daddy-autopilot` roster wiring and abort startup on drift when `VALUA_AUTOPILOT_DEDICATED_WORKTREE=1`.

Affected components:
- Valua adapter restart preflight (`adapters/valua/restart-master.sh`).
- Runtime roster handling for `daddy-autopilot`.

Rationale:
- Runtime auto-patching hid source-of-truth drift between Valua source roster and runtime behavior.
- Fail-fast validation keeps operator intent explicit and prevents silent configuration mutation.

Implementation summary:
- Startup now validates the runtime roster entry for `daddy-autopilot` (`name + kind` lookup) against canonical values:
  - `branch: agent/daddy-autopilot`
  - `workdir: $VALUA_AGENT_WORKTREES_DIR/daddy-autopilot`
- Validation errors now include `rosterPath` and expected/actual values and abort restart.
- Runtime no longer rewrites the roster entry during startup.

Migration and compatibility notes:
- Keep Valua source roster (`docs/agentic/agent-bus/ROSTER.json`) aligned with canonical dedicated-worktree wiring.
- Temporary debug bypass remains available via `VALUA_AUTOPILOT_DEDICATED_WORKTREE=0`.

Testing and rollout:
- Validate restart behavior in two modes:
  - drifted roster: restart aborts with explicit validation error
  - canonical roster: restart proceeds and worktree repin/reset flow remains deterministic
- Regression checks covered by PR #21 touched-suite runs for worker schema/runtime behavior.

Reference:
- PR: https://github.com/future3OOO/agentic-cockpit/pull/21
