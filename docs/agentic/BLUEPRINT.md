# Agentic Cockpit Blueprint (Summary)

This is the architecture summary for quick orientation.

Authoritative references:
- `docs/agentic/REFERENCE_INDEX.md`
- `docs/agentic/CONTROL_LOOP_AND_PACKET_FLOW.md`
- `docs/agentic/RUNTIME_FUNCTION_REFERENCE.md`

## Roles

- `daddy`: user-facing chat
- `orchestrator`: deterministic digest forwarder
- `autopilot`: controller and follow-up dispatcher
- worker agents: execution specialists

## Core Loop

1. User request enters bus.
2. Autopilot plans/dispatches follow-ups.
3. Workers execute and close with receipts.
4. Orchestrator forwards digests.
5. Autopilot iterates until completion criteria are met.

## Governance

- review closure gate
- quality/evidence gates
- continuity/decision logging discipline

Deep implementation details are intentionally maintained in the new reference set.
