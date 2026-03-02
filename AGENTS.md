# Agentic Cockpit Engineering Charter

This repository is production orchestration infrastructure. Every change must preserve deterministic behavior, auditability, and operator safety.

## Mission

Ship the smallest correct implementation that improves reliability and operator control without introducing workflow regressions.

## Current Runtime Focus (2026-03)

- Opus consult runs as consultant infrastructure; autopilot remains final decision authority.
- Source-delta inspection is metadata only; task success must not fail solely because a commit object is not yet hydrated in the local worker clone.
- Post-merge resync can run destructive git steps only on worktrees owned by the same repository and not currently locked by an active worker.

## Policy Topology

- `AGENTS.md` is the canonical shared engineering charter for all agents.
- `CLAUDE.md` is a Claude/Opus consultant overlay and must stay scoped to consultant behavior.
- Protocol-level packet/source-of-truth contracts live in:
  - `docs/agentic/agent-bus/PROTOCOL.md`
  - `docs/agentic/agent-bus/OPUS_CONSULT_REQUEST.schema.json`
  - `docs/agentic/agent-bus/OPUS_CONSULT_RESPONSE.schema.json`
  - `docs/agentic/agent-bus/OPUS_CONSULT.provider.schema.json`

## Hard Rules (Fail-Closed)

1. Every line must earn its place.
- Prefer deletion over wrappers.
- Do not add abstraction for one-off logic.

2. No duplicate logic.
- Reuse existing runtime paths before adding new branches.
- If behavior already exists, extend it in-place.

3. Shortest correct path.
- Remove unnecessary hops in task routing/state transitions.
- Do not add extra control-plane packets unless required.

4. No fake green.
- No `|| true` in verification flows.
- No broad catch/pass that hides failures.
- No suppression patterns that bypass root-cause fixes.

5. Boundary-only validation.
- Validate at network/file/env/third-party boundaries.
- Keep internal flow simple and explicit.

6. Mandatory cleanup.
- Startup, pre-task, and post-task cleanup behavior must remain deterministic.
- No orphaned temp state, stale runtime markers, or silent leftovers.

## Runtime Safety Contract

These safety contracts must remain true unless an explicit decision entry says otherwise:

- Guard wrappers in `scripts/agentic/guard-bin/` remain enabled by default.
- Autopilot destructive guard overrides remain opt-in (default off).
- Worker single-writer lock per agent remains enabled.
- Task closure must continue writing receipts and preserving traceability.
- Observer/orchestrator/autopilot loops must avoid silent packet loss.

## Required Change Coupling

When changing a core runtime path, update all coupled surfaces in the same PR.

1. AgentBus state model changes (`scripts/lib/agentbus.mjs`, `scripts/agent-bus.mjs`)
- Update protocol docs: `docs/agentic/agent-bus/PROTOCOL.md`
- Update flow docs: `docs/agentic/CONTROL_LOOP_AND_PACKET_FLOW.md`

2. Worker gate/review/output contract changes (`scripts/agent-codex-worker.mjs`)
- Update output schema/docs references if affected.
- Update runtime reference: `docs/agentic/RUNTIME_FUNCTION_REFERENCE.md`

3. Orchestrator digest/routing changes (`scripts/agent-orchestrator-worker.mjs`)
- Update flow docs and gate semantics docs.

4. PR observer logic changes (`scripts/observers/watch-pr.mjs`)
- Update observer behavior notes and incident/timeline docs.

5. tmux launch/env wiring changes (`scripts/tmux/*.sh`)
- Update operator commands in `README.md`.

6. Valua adapter changes (`adapters/valua/*.sh`)
- Update `adapters/valua/README.md` and `docs/agentic/VALUA_ADAPTER_RUNTIME.md`.

## Cross-Repo Ownership Contract (Cockpit + Downstream Project)

When running via an adapter (for example Valua), do not mix ownership boundaries:

- Cockpit repo owns:
  - runtime code (`scripts/**`)
  - adapter launch plumbing (`adapters/**`)
  - protocol/schema contracts (`docs/agentic/agent-bus/**`)
- Downstream project repo owns:
  - effective runtime roster (`docs/agentic/agent-bus/ROSTER.json`)
  - project agent skills/instructions (`.codex/skills/**`, project `AGENTS.md`/`CLAUDE.md`)
  - project-specific runbooks and branch policy

If behavior is wrong under adapter runtime, verify the downstream roster/skills first; cockpit defaults are only fallback bootstrap assets.

## Completion Gate (Required Before `done`)

1. Implement root-cause fix (not symptom patch).
2. Run relevant tests/checks for changed runtime surfaces.
3. Verify no queue/state regressions for touched control loop.
4. Provide concise closure evidence:
- one-line summary
- commands run
- key outcomes
- blockers/follow-ups if any

Do not paste large logs in receipts/comments.

## Outcome Semantics

Use strict closure semantics:
- `done`: all required checks/gates passed for scope.
- `needs_review`: implementation complete but external reviewer/approval needed.
- `blocked`: missing dependency/access/input prevents completion.
- `failed`: attempted path invalid or runtime error without valid fallback.

Never mark `done` when critical follow-up work is still required.

## Documentation and Decision Discipline

- Any behavior change in runtime policy must be recorded in `DECISIONS.md`.
- Keep operational summary current in `docs/agentic/DECISIONS_AND_INCIDENTS_TIMELINE.md`.
- Keep runtime references current in `docs/agentic/RUNTIME_FUNCTION_REFERENCE.md`.

## Security and Secrets

- Never commit secrets/tokens/credentials.
- Never emit secrets into receipts, logs, or dashboard payloads.
- Preserve existing fail-closed behavior for credential and guard paths.
