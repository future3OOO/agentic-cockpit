# Codex app-server engine (Agentic Cockpit)

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

## Output schema

For app-server turns, the worker passes `docs/agentic/agent-bus/CODEX_WORKER_OUTPUT.schema.json` as `outputSchema`, so the final assistant message must be a JSON object matching that schema (same contract as `codex exec --output-schema`).

## Thread/session persistence

- Per-task thread id is stored under:
  - `busRoot/state/codex-task-sessions/<agent>/<taskId>.json`
- Autopilot can also auto-pin a stable session id at:
  - `busRoot/state/<agent>.session-id`

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

1. Stop cockpit workers:

```bash
tmux kill-session -t valua-cockpit 2>/dev/null || true
```

2. Reset affected agent state.

Reset all Valua agents in one command:

```bash
bash /home/prop_/projects/agentic-cockpit/scripts/agentic/reset-agent-codex-state.sh \
  --bus-root /home/prop_/.codex/valua/agent-bus \
  --agents "daddy,daddy-orchestrator,daddy-autopilot,frontend,backend,prediction,qa,infra,advisor-claude,advisor-gemini"
```

Reset a single agent (examples):

```bash
bash /home/prop_/projects/agentic-cockpit/scripts/agentic/reset-agent-codex-state.sh \
  --bus-root /home/prop_/.codex/valua/agent-bus \
  --agent daddy-autopilot

bash /home/prop_/projects/agentic-cockpit/scripts/agentic/reset-agent-codex-state.sh \
  --bus-root /home/prop_/.codex/valua/agent-bus \
  --agent frontend

bash /home/prop_/projects/agentic-cockpit/scripts/agentic/reset-agent-codex-state.sh \
  --bus-root /home/prop_/.codex/valua/agent-bus \
  --agent backend

bash /home/prop_/projects/agentic-cockpit/scripts/agentic/reset-agent-codex-state.sh \
  --bus-root /home/prop_/.codex/valua/agent-bus \
  --agent prediction

bash /home/prop_/projects/agentic-cockpit/scripts/agentic/reset-agent-codex-state.sh \
  --bus-root /home/prop_/.codex/valua/agent-bus \
  --agent qa

bash /home/prop_/projects/agentic-cockpit/scripts/agentic/reset-agent-codex-state.sh \
  --bus-root /home/prop_/.codex/valua/agent-bus \
  --agent infra

bash /home/prop_/projects/agentic-cockpit/scripts/agentic/reset-agent-codex-state.sh \
  --bus-root /home/prop_/.codex/valua/agent-bus \
  --agent daddy-orchestrator

bash /home/prop_/projects/agentic-cockpit/scripts/agentic/reset-agent-codex-state.sh \
  --bus-root /home/prop_/.codex/valua/agent-bus \
  --agent daddy

bash /home/prop_/projects/agentic-cockpit/scripts/agentic/reset-agent-codex-state.sh \
  --bus-root /home/prop_/.codex/valua/agent-bus \
  --agent advisor-claude

bash /home/prop_/projects/agentic-cockpit/scripts/agentic/reset-agent-codex-state.sh \
  --bus-root /home/prop_/.codex/valua/agent-bus \
  --agent advisor-gemini
```

3. Restart cockpit:

```bash
AGENTIC_AUTOPILOT_SKILLOPS_GATE=1 \
AGENTIC_AUTOPILOT_SKILLOPS_GATE_KINDS='USER_REQUEST,ORCHESTRATOR_UPDATE' \
bash /home/prop_/projects/agentic-cockpit/adapters/valua/run.sh /home/prop_/projects/Valua
```

This script only rotates runtime state under `busRoot/state` (pins + per-agent `codex-home`). It does not modify repo files or worktree code.
