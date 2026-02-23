# Agentic Cockpit (V2)

Agentic Cockpit is a file-backed multi-agent runtime built on:
- AgentBus task packets + receipts
- Codex workers (`exec` and `app-server` engines)
- tmux cockpit orchestration
- optional local dashboard (`http://127.0.0.1:3210` default)

## Canonical Documentation

Start here for deep implementation details:
- `docs/agentic/REFERENCE_INDEX.md`

Primary deep references:
- `docs/agentic/CONTROL_LOOP_AND_PACKET_FLOW.md`
- `docs/agentic/RUNTIME_FUNCTION_REFERENCE.md`
- `docs/agentic/VALUA_ADAPTER_RUNTIME.md`
- `docs/agentic/DECISIONS_AND_INCIDENTS_TIMELINE.md`

## Quick Start (Generic)

Requirements:
- Node.js >= 20
- `tmux`
- `codex` CLI authenticated

Start cockpit:
```bash
bash scripts/tmux/cockpit.sh up
```

Stop cockpit:
```bash
bash scripts/tmux/cockpit.sh down
```

Attach existing session:
```bash
bash scripts/tmux/cockpit.sh attach
```

## Valua Adapter Quick Start

Launch against local Valua repo:
```bash
bash adapters/valua/run.sh /path/to/Valua
```

Deterministic restart from clean `origin/master` runtime worktree:
```bash
bash adapters/valua/restart-master.sh /path/to/Valua
```

Deterministic restart + codex state rotation:
```bash
RESET_STATE=1 bash adapters/valua/restart-master.sh /path/to/Valua
```

Full adapter behavior and env matrix:
- `adapters/valua/README.md`
- `docs/agentic/VALUA_ADAPTER_RUNTIME.md`

## Dashboard

tmux startup autostarts dashboard by default.

Manual run:
```bash
npm run dashboard
```

Override port:
```bash
AGENTIC_DASHBOARD_PORT=3899 npm run dashboard
```

## Core CLI

Initialize bus:
```bash
node scripts/agent-bus.mjs init
```

Send task:
```bash
node scripts/agent-bus.mjs send-text --to autopilot --title "Do X" --body "..."
```

List open tasks:
```bash
node scripts/agent-bus.mjs open-tasks
```

Bus status:
```bash
node scripts/agent-bus.mjs status
```

## Runtime Defaults and Behavior

- Generic cockpit startup defaults are controlled by `scripts/tmux/agents-up.sh`.
- Valua adapter defaults are controlled by `adapters/valua/run.sh`.
- Deterministic Valua runtime restart/repin/reset is in `adapters/valua/restart-master.sh`.

Important defaults:
- PR observer autostart: enabled
- dashboard autostart: enabled
- code quality gate: enabled
- autopilot SkillOps gate: enabled in Valua adapter profile
- autopilot destructive guard overrides: disabled by default (opt-in)

## Worktrees and Policy Sync

Default worker isolation uses per-agent worktrees.

Policy sync behavior:
- one-way sync root -> worktrees on startup when enabled
- source ref can be pinned (Valua default: `origin/master`)

Detailed behavior:
- `scripts/agentic/setup-worktrees.sh`
- `scripts/agentic/sync-policy-to-worktrees.mjs`
- `docs/agentic/VALUA_ADAPTER_RUNTIME.md`

## Config Variables (Common)

Core:
- `AGENTIC_BUS_DIR`
- `AGENTIC_ROSTER_PATH`
- `AGENTIC_WORKTREES_DIR`

Engine:
- `AGENTIC_CODEX_ENGINE=exec|app-server`
- `AGENTIC_CODEX_WARM_START=0|1`
- `AGENTIC_CODEX_APP_SERVER_PERSIST=0|1`

Observer:
- `AGENTIC_PR_OBSERVER_AUTOSTART=0|1`
- `AGENTIC_PR_OBSERVER_POLL_MS`
- `AGENTIC_PR_OBSERVER_MAX_PRS`
- `AGENTIC_PR_OBSERVER_REPO`
- `AGENTIC_PR_OBSERVER_PRS`
- `AGENTIC_PR_OBSERVER_MIN_PR`
- `AGENTIC_PR_OBSERVER_COLD_START_MODE=baseline|replay`

Autopilot guard overrides (opt-in only):
- `AGENTIC_AUTOPILOT_GUARD_ALLOW_PROTECTED_PUSH=1`
- `AGENTIC_AUTOPILOT_GUARD_ALLOW_PR_MERGE=1`
- `AGENTIC_AUTOPILOT_GUARD_ALLOW_FORCE_PUSH=1`

Quality/SkillOps:
- `AGENTIC_CODE_QUALITY_GATE=0|1`
- `AGENTIC_CODE_QUALITY_GATE_KINDS=...`
- `AGENTIC_AUTOPILOT_SKILLOPS_GATE=0|1`
- `AGENTIC_AUTOPILOT_SKILLOPS_GATE_KINDS=...`

Valua back-compat aliases (`VALUA_*`) are supported where applicable.

## Downstream Bootstrap

Bootstrap a new project once:
```bash
node scripts/init-project.mjs --project /path/to/your-repo
```

Then run cockpit in that repo with its own roster/skills.

## Legacy Doc Consolidation

These files are now summary pointers (deep internals moved):
- `docs/agentic/BLUEPRINT.md`
- `docs/agentic/AUTOPILOT_RUNTIME_FLOW.md`
- `docs/agentic/CODEX_APP_SERVER.md`

## License

Apache-2.0 (`LICENSE`).
