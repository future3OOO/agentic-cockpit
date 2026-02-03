# Agentic Cockpit (V2)

Agentic Cockpit is an open-source, file-backed **AgentBus** + **Codex worker** runtime that can be driven from:

- a tmux cockpit (WSL/Linux-friendly), and
- a local dashboard (planned; read-only by default).

This repo is the **V2** track: it keeps the existing “`codex exec` per attempt” engine as a fallback while adding a new **Codex app-server** engine for cleaner mid-task updates (interrupt → continue the same thread), richer streaming, and better observability.

## Goals
- Deterministic orchestration: everything is auditable via the filesystem bus (tasks + receipts).
- Safe defaults: no secrets in git/logs; guardrails against accidental merges/protected pushes.
- Cross-platform: WSL/Linux first; Windows native optional.

## Quick start (tmux)
1. Ensure you have `node` (>= 20), `tmux`, and `codex` installed and authenticated.
2. Start the cockpit:
   - `bash scripts/tmux/cockpit.sh up`

The default bus root is under `~/.agentic-cockpit/bus` (configurable).

## Using on another project
Agentic Cockpit can drive *any* local repo as long as it has a roster + skills.

Recommended: scaffold the target repo once:

```bash
node /path/to/agentic-cockpit/scripts/init-project.mjs --project /path/to/your-repo
```

Then run the cockpit from inside that repo:

```bash
cd /path/to/your-repo
COCKPIT_ROOT=/path/to/agentic-cockpit bash $COCKPIT_ROOT/scripts/tmux/cockpit.sh up
```

If the repo does not yet have a roster, the tmux launcher will fall back to the cockpit’s bundled `docs/agentic/agent-bus/ROSTER.json` (with a warning).

## Core CLI
- Initialize a bus: `node scripts/agent-bus.mjs init`
- Send a task: `node scripts/agent-bus.mjs send-text --to autopilot --title "Do X" --body "..." `
- See status: `node scripts/agent-bus.mjs status`

## Configuration
This repo ships with a sample roster at `docs/agentic/agent-bus/ROSTER.json`.

The sample roster uses the built-in skills under `.codex/skills/` (autopilot/planning/execute/qa).

Key env vars (preferred):
- `AGENTIC_BUS_DIR` (bus root)
- `AGENTIC_ROSTER_PATH` (roster json path)
- `AGENTIC_CODEX_ENGINE` (`exec` | `app-server`)

Back-compat:
- `VALUA_AGENT_BUS_DIR`, `VALUA_AGENT_ROSTER_PATH` are still accepted for Valua downstreams.
- `VALUA_CODEX_ENGINE` is also accepted.

## Engines
By default, workers run the **exec engine** (`codex exec`) for maximum compatibility.

To enable the **app-server engine** (recommended for “update/interrupt” workflows):
- `export AGENTIC_CODEX_ENGINE=app-server`

Both engines support AgentBus task updates (`agent-bus update`). With app-server enabled, updates translate to `turn/interrupt` and then continue the **same thread**; with exec they restart the process and resume the session id when possible.

## License
Apache-2.0. See `LICENSE`.
