# Codex App-Server Engine (Summary)

This file is a summary.

Authoritative references:
- `docs/agentic/RUNTIME_FUNCTION_REFERENCE.md` (worker functions, app-server path)
- `docs/agentic/VALUA_ADAPTER_RUNTIME.md` (adapter defaults)
- `docs/agentic/CONTROL_LOOP_AND_PACKET_FLOW.md` (control loop/gates)

## Engine Modes

- `exec`: process-per-attempt model (`codex exec`)
- `app-server`: persistent server model with turn/review lifecycle support

## Key Behavior

- App-server path supports interrupt/update in the same thread.
- Worker keeps output schema contract aligned with AgentBus receipt expectations.
- Valua adapter defaults to app-server profile.

## Key Knobs

- `AGENTIC_CODEX_ENGINE=exec|app-server`
- `AGENTIC_CODEX_APP_SERVER_PERSIST=0|1`
- `AGENTIC_CODEX_WARM_START=0|1`
- `AGENTIC_CODEX_NETWORK_ACCESS=0|1`
- `AGENTIC_AUTOPILOT_DANGER_FULL_ACCESS=0|1`

## Operational Recovery

If rollout-path/session state becomes inconsistent, use deterministic reset flow:
- `adapters/valua/restart-master.sh`
- optional: `RESET_STATE=1`

Detailed reset semantics are in `docs/agentic/VALUA_ADAPTER_RUNTIME.md`.
