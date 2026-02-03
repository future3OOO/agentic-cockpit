# Codex app-server engine (Agentic Cockpit)

Agentic Cockpit supports two Codex execution engines:

- **`exec`** (default): runs `codex exec` per attempt.
- **`app-server`**: runs `codex app-server` and drives turns via JSONL requests (supports true mid-turn interrupts).

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

## Notes / current limitations

- The embedded app-server client auto-approves command/file-change approvals (equivalent to `--ask-for-approval never`).
- Dynamic tool-calls (`item/tool/call`) are not bridged by the client yet; if your workflow depends on custom dynamic tools, use the `exec` engine for now or extend `scripts/lib/codex-app-server-client.mjs`.

