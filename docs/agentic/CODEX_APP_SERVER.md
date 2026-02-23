# Codex app-server engine (Agentic Cockpit)

Supplemental references:
- `docs/agentic/CONTROL_LOOP_AND_PACKET_FLOW.md`
- `docs/agentic/RUNTIME_FUNCTION_REFERENCE.md`
- `docs/agentic/VALUA_ADAPTER_RUNTIME.md`

Agentic Cockpit supports two Codex execution engines:

- **`exec`** (default): runs `codex exec` per attempt.
- **`app-server`**: runs `codex app-server` and drives turns via JSONL requests (supports true mid-turn interrupts).

Adapter note:
- The Valua adapter (`adapters/valua/run.sh`) sets `AGENTIC_CODEX_ENGINE=app-server` by default, so adapter launches are app-server-first unless explicitly overridden.

## Enable

```bash
export AGENTIC_CODEX_ENGINE=app-server
```

Back-compat (downstream): `VALUA_CODEX_ENGINE=app-server` is also accepted.

## Why app-server?

When a task is updated (via `agent-bus update`), the worker:

- detects the task file mtime change,
- calls `turn/interrupt`,
- and starts a fresh `turn/start` in the **same thread**.

This keeps context coherent and avoids the “kill + restart + rehydrate from scratch” behavior that can cause looping when prompts compact.

For autopilot review-gated `ORCHESTRATOR_UPDATE` tasks, the worker also runs a built-in app-server review before normal closure logic:

- `review/start` with `delivery:"inline"` and the target commit,
- requires review mode lifecycle events (`enteredReviewMode` + `exitedReviewMode`),
- then validates structured review evidence in worker output.

For explicit user review requests (for example, when task text/title includes `/review` or `review/start`), autopilot applies the same built-in review path on app-server runs.

## Output schema

For app-server turns, the worker passes `docs/agentic/agent-bus/CODEX_WORKER_OUTPUT.schema.json` as `outputSchema`, so the final assistant message must be a JSON object matching that schema (same contract as `codex exec --output-schema`).

## Thread/session persistence

- Per-task thread id is stored under:
  - `busRoot/state/codex-task-sessions/<agent>/<taskId>.json`
- Autopilot root-scoped pins (default) are stored under:
  - `busRoot/state/codex-root-sessions/<agent>/<rootId>.json`
- Legacy global pin (task-scoped / override path):
  - `busRoot/state/<agent>.session-id`

Autopilot session scope defaults to root (`AGENTIC_AUTOPILOT_SESSION_SCOPE=root`).
If `signals.rootId` is missing, autopilot falls back to task-scoped session behavior.
Root-scoped pins are cleared only when closure emits `autopilotControl.branchDecision="close"`.

## Sandbox + network

The worker configures app-server turns with:

- sandbox policy: `workspaceWrite`
- writable roots: agent `workdir` + the resolved gitdir/common gitdir (for worktrees)
- network access: enabled by default (set `AGENTIC_CODEX_NETWORK_ACCESS=0` or `VALUA_CODEX_NETWORK_ACCESS=0` to disable)

Autopilot exception (default):
- `daddy-autopilot` uses `dangerFullAccess` sandbox policy by default.
- Set `AGENTIC_AUTOPILOT_DANGER_FULL_ACCESS=0` (or `VALUA_AUTOPILOT_DANGER_FULL_ACCESS=0`) to force `workspaceWrite` for autopilot too.

## Notes / current limitations

- The embedded app-server client auto-approves command/file-change approvals (equivalent to `--ask-for-approval never`).
- The client initializes with `capabilities.experimentalApi=true` so app-server review APIs are available.
- Dynamic tool-calls (`item/tool/call`) are not bridged by the client yet; if your workflow depends on custom dynamic tools, use the `exec` engine for now or extend `scripts/lib/codex-app-server-client.mjs`.

## Manual desync recovery (one-shot)

If a worker logs `state db missing rollout path for thread`, run a one-shot reset for affected agents.

Set environment-specific paths first:

```bash
AGENTIC_COCKPIT_ROOT="${AGENTIC_COCKPIT_ROOT:-$HOME/projects/agentic-cockpit}"
VALUA_PROJECT_ROOT="${VALUA_PROJECT_ROOT:-$HOME/projects/Valua}"
VALUA_BUS_ROOT="${VALUA_BUS_ROOT:-$HOME/.codex/valua/agent-bus}"
ROSTER_PATH="${AGENTIC_ROSTER_PATH:-$VALUA_PROJECT_ROOT/docs/agentic/agent-bus/ROSTER.json}"
```

1. Stop cockpit workers:

```bash
SESSION_NAME="$(
  node -e "const fs=require('fs');const p=process.argv[1];let s='agentic-cockpit';try{s=JSON.parse(fs.readFileSync(p,'utf8')).sessionName||s}catch{};process.stdout.write(String(s));" \
    "$ROSTER_PATH"
)"
tmux kill-session -t "$SESSION_NAME" 2>/dev/null || true
```

2. Reset affected agent state.

Reset all Valua agents in one command:

```bash
bash "$AGENTIC_COCKPIT_ROOT/scripts/agentic/reset-agent-codex-state.sh" \
  --bus-root "$VALUA_BUS_ROOT" \
  --agents "daddy,daddy-orchestrator,daddy-autopilot,frontend,backend,prediction,qa,infra,advisor-claude,advisor-gemini"
```

Reset a single agent (examples):

```bash
bash "$AGENTIC_COCKPIT_ROOT/scripts/agentic/reset-agent-codex-state.sh" \
  --bus-root "$VALUA_BUS_ROOT" \
  --agent daddy-autopilot

bash "$AGENTIC_COCKPIT_ROOT/scripts/agentic/reset-agent-codex-state.sh" \
  --bus-root "$VALUA_BUS_ROOT" \
  --agent frontend

bash "$AGENTIC_COCKPIT_ROOT/scripts/agentic/reset-agent-codex-state.sh" \
  --bus-root "$VALUA_BUS_ROOT" \
  --agent backend

bash "$AGENTIC_COCKPIT_ROOT/scripts/agentic/reset-agent-codex-state.sh" \
  --bus-root "$VALUA_BUS_ROOT" \
  --agent prediction

bash "$AGENTIC_COCKPIT_ROOT/scripts/agentic/reset-agent-codex-state.sh" \
  --bus-root "$VALUA_BUS_ROOT" \
  --agent qa

bash "$AGENTIC_COCKPIT_ROOT/scripts/agentic/reset-agent-codex-state.sh" \
  --bus-root "$VALUA_BUS_ROOT" \
  --agent infra

bash "$AGENTIC_COCKPIT_ROOT/scripts/agentic/reset-agent-codex-state.sh" \
  --bus-root "$VALUA_BUS_ROOT" \
  --agent daddy-orchestrator

bash "$AGENTIC_COCKPIT_ROOT/scripts/agentic/reset-agent-codex-state.sh" \
  --bus-root "$VALUA_BUS_ROOT" \
  --agent daddy

bash "$AGENTIC_COCKPIT_ROOT/scripts/agentic/reset-agent-codex-state.sh" \
  --bus-root "$VALUA_BUS_ROOT" \
  --agent advisor-claude

bash "$AGENTIC_COCKPIT_ROOT/scripts/agentic/reset-agent-codex-state.sh" \
  --bus-root "$VALUA_BUS_ROOT" \
  --agent advisor-gemini
```

3. Restart cockpit:

```bash
AGENTIC_AUTOPILOT_SKILLOPS_GATE=1 \
AGENTIC_AUTOPILOT_SKILLOPS_GATE_KINDS='USER_REQUEST,ORCHESTRATOR_UPDATE' \
bash "$AGENTIC_COCKPIT_ROOT/adapters/valua/run.sh" "$VALUA_PROJECT_ROOT"
```

This script only rotates runtime state under `busRoot/state` (pins + per-agent `codex-home`). It does not modify repo files or worktree code.
