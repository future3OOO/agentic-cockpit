# Adapters

Adapters are thin launch/config helpers that make Agentic Cockpit work well with downstream projects.

Core concepts:
- **Cockpit root**: where this repo lives (scripts, workers, guardrails).
- **Project root**: the downstream repo you want agents to operate on.

All adapters ultimately set environment variables and run `scripts/tmux/cockpit.sh`.

## Common env vars
- `AGENTIC_PROJECT_ROOT` — downstream project root (defaults to current git root/cwd)
- `AGENTIC_ROSTER_PATH` — roster path (defaults to `$AGENTIC_PROJECT_ROOT/docs/agentic/agent-bus/ROSTER.json`)
- `AGENTIC_BUS_DIR` — bus root (defaults to `~/.agentic-cockpit/bus`)
- `AGENTIC_WORKTREES_DIR` — worktrees root (defaults to `~/.agentic-cockpit/worktrees`)

