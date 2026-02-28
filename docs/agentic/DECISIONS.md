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

## 2026-02-28 — Packetized Opus Consult Gate (Claude CLI)

Decision:
- Autopilot uses explicit consult packet kinds (`OPUS_CONSULT_REQUEST` / `OPUS_CONSULT_RESPONSE`) with a dedicated `opus-consult` worker.
- Pre-exec consult can block Codex execution when not finalized.
- Post-review consult can block `done` closure when critical issues remain.

Affected components:
- `scripts/agent-codex-worker.mjs`
- `scripts/agent-opus-consult-worker.mjs`
- `scripts/lib/opus-client.mjs`
- `scripts/lib/opus-consult-schema.mjs`
- `docs/agentic/agent-bus/OPUS_CONSULT_*.json`

Rationale:
- Make consult exchange auditable and deterministic on AgentBus.
- Enforce strict pre-action and pre-closure guarantees without hidden side channels.
- Keep Opus advisory-only and preserve autopilot as execution authority.

Implementation summary:
- Added packetized consult loop with `consultId + round + phase` matching and bounded rounds.
- Added response packet consumption hygiene (accepted responses are closed with `notifyOrchestrator=false`).
- Added consult transcript artifact + receipt/runtimeGuard fields for observability.
- Added Valua/tmux defaults and roster wiring for `opus-consult`.

## 2026-02-28 — Opus Consult Runtime Hardening (Fail-Fast + Response Repair)

Decision:
- Keep `opus-consult` startup fail-fast when dedicated worker script is missing.
- Make tmux worker startup independent of pane-local env assumptions by always propagating and expanding `COCKPIT_ROOT`.
- Repair known malformed provider output class before schema validation:
  - if consult response is `verdict=block` and `final!==true`, coerce `final=true`.

Affected components:
- `scripts/tmux/agents-up.sh`
- `scripts/agent-opus-consult-worker.mjs`
- `scripts/__tests__/opus-consult-worker.test.mjs`

Rationale:
- Prevent false startup failures caused by missing `COCKPIT_ROOT` in pane env.
- Prevent unnecessary `opus_schema_invalid` hard-stops for a known single-field malformed block response.
- Ensure this behavior is test-backed, not manual/operator memory.

Implementation summary:
- tmux session env now sets `COCKPIT_ROOT` and startup command expansion resolves `$COCKPIT_ROOT` eagerly.
- consult worker now normalizes block responses to enforce `final=true` before schema validation.
- regression test added for malformed provider output mode (`block-final-false`) and asserts repaired payload.

## 2026-02-28 — Opus Consult Skill Contract + No Insufficient-Context Outcomes

Decision:
- Remove bespoke Opus skill sidecar (`.codex/opus/OPUS_SKILLS.md`) from consult runtime.
- Opus now loads consultant context from roster-defined `SKILL.md` files (same skill system shape as other agents).
- Treat insufficient-context reason codes as protocol-invalid; Opus must either:
  - return an explicit iterate response (`opus_consult_iterate`, `final=false`), or
  - return explicit human-input requirements (`opus_human_input_required`, `final=true`).

Affected components:
- `scripts/agent-opus-consult-worker.mjs`
- `scripts/lib/opus-client.mjs`
- `scripts/lib/opus-consult-schema.mjs`
- `scripts/agent-codex-worker.mjs`
- `adapters/valua/run.sh`
- `docs/agentic/agent-bus/OPUS_CONSULT_*.json`
- `docs/agentic/agent-bus/ROSTER.json`

Rationale:
- Prevent brittle side-channel prompt assets and align Opus with roster-governed skill configuration.
- Eliminate ambiguous "insufficient context" blocks when runtime/tool access is available.
- Keep autopilot consult flow deterministic by requiring explicit iterate/human-input reason semantics.

Implementation summary:
- consult worker prompt assembly now loads `OPUS_INSTRUCTIONS.md` + roster skills from `.codex/skills` / `.claude/skills`.
- Claude CLI consult invocation no longer disables skill/slash layer; tools and add-dir scope are explicitly passed.
- consult response reason codes are now a closed set in schema + runtime validators.
- preflight startup validation now checks consultant skill assets instead of `OPUS_SKILLS.md`.
