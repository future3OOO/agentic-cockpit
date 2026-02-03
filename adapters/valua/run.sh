#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COCKPIT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

PROJECT_ROOT="${1:-}"
if [ -z "$PROJECT_ROOT" ]; then
  echo "Usage: bash adapters/valua/run.sh /path/to/Valua" >&2
  exit 1
fi

export COCKPIT_ROOT="$COCKPIT_ROOT"
export AGENTIC_PROJECT_ROOT="$PROJECT_ROOT"
export AGENTIC_ROSTER_PATH="${AGENTIC_ROSTER_PATH:-$PROJECT_ROOT/docs/agentic/agent-bus/ROSTER.json}"

# Keep Valua’s existing bus/worktree locations by default (operator can override).
export AGENTIC_BUS_DIR="${AGENTIC_BUS_DIR:-$HOME/.codex/valua/agent-bus}"
export AGENTIC_WORKTREES_DIR="${AGENTIC_WORKTREES_DIR:-$HOME/.codex/valua/worktrees/Valua}"

# In adapter mode, Codex runs with cwd=$PROJECT_ROOT, so skills should come from the Valua repo
# (e.g. `.codex/skills/valua-daddy-chat-io`). Default the interactive chat boot prompt accordingly.
export VALUA_CODEX_CHAT_BOOT_PROMPT="${VALUA_CODEX_CHAT_BOOT_PROMPT:-\$valua-daddy-chat-io}"

exec bash "$COCKPIT_ROOT/scripts/tmux/cockpit.sh" up
