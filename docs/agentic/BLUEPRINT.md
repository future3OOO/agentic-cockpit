# Agentic Cockpit Blueprint

This blueprint defines the baseline architecture for a cockpit-driven project.

## Core roles
- `daddy`: human I/O front-end.
- `orchestrator`: deterministic completion/alert forwarder.
- `autopilot`: controller that dispatches follow-ups.
- worker agents: execution specialists (frontend/backend/qa/etc).

## Control loop
1. User request enters via Daddy Chat and is queued to AgentBus.
2. Autopilot triages and emits PLAN/EXECUTE/REVIEW follow-ups.
3. Workers close tasks with receipts.
4. Orchestrator forwards compact updates to autopilot.
5. Autopilot iterates until acceptance criteria are met.

Implementation-aligned runtime diagram:
- `docs/agentic/AUTOPILOT_RUNTIME_FLOW.md`

## Governance gates
- Review closure gate: no done state while PR feedback is still actionable.
- Verification gate: changed code must pass project checks.
- Continuity gate: maintain `.codex/CONTINUITY.md` for compact-safe state.
- Opus consult gate mode is explicit: `advisory` is non-blocking consultant input, `gate` is fail-closed enforcement.

## Branching model
- Root workflow branch: `slice/<rootId>`.
- Per-agent work branch: `wip/<agent>/<rootId>` or project equivalent.
- Protected branch merges remain human approved.
