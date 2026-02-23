# Agentic Cockpit Reference Index

This is the authoritative navigation entrypoint for runtime behavior, adapter behavior, and operating policy.

Use this file first, then follow links in order.

## 1) Start Here
- Runtime + packet lifecycle: `docs/agentic/CONTROL_LOOP_AND_PACKET_FLOW.md`
- Function-level runtime reference: `docs/agentic/RUNTIME_FUNCTION_REFERENCE.md`
- Valua adapter runtime contract: `docs/agentic/VALUA_ADAPTER_RUNTIME.md`
- Historical decisions/incidents context: `docs/agentic/DECISIONS_AND_INCIDENTS_TIMELINE.md`

## 2) Operator Quick References
- Main quickstart: `README.md`
- Valua adapter quickstart: `adapters/valua/README.md`
- AgentBus protocol contract: `docs/agentic/agent-bus/PROTOCOL.md`
- Roster baseline: `docs/agentic/agent-bus/ROSTER.json`

## 3) Legacy Docs (Consolidated)
These files remain as short summaries and pointers:
- `docs/agentic/BLUEPRINT.md`
- `docs/agentic/AUTOPILOT_RUNTIME_FLOW.md`
- `docs/agentic/CODEX_APP_SERVER.md`

Do not add deep implementation details there. Add/maintain deep details in:
- `docs/agentic/RUNTIME_FUNCTION_REFERENCE.md`
- `docs/agentic/VALUA_ADAPTER_RUNTIME.md`
- `docs/agentic/CONTROL_LOOP_AND_PACKET_FLOW.md`

## 4) Source-of-Truth Rule
When docs disagree, trust order is:
1. Runtime code in `scripts/**` and `adapters/**`
2. `docs/agentic/RUNTIME_FUNCTION_REFERENCE.md`
3. `docs/agentic/CONTROL_LOOP_AND_PACKET_FLOW.md`
4. `README.md` and adapter/operator runbooks

## 5) Required Update Triggers
Update this reference set when changing any of:
- packet routing or task state transitions (`scripts/agent-bus.mjs`, `scripts/lib/agentbus.mjs`)
- worker loop/gates/review behavior (`scripts/agent-codex-worker.mjs`)
- orchestrator forwarding/coalescing (`scripts/agent-orchestrator-worker.mjs`)
- PR observer filters/watermarks (`scripts/observers/watch-pr.mjs`)
- tmux startup/env wiring (`scripts/tmux/*.sh`)
- Valua adapter launch/reset semantics (`adapters/valua/*.sh`)
