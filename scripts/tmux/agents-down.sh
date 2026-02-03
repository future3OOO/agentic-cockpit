#!/usr/bin/env bash
set -euo pipefail

invoke_cwd="$(pwd -P)"
project_guess="$invoke_cwd"
if project_guess_raw="$(git -C "$invoke_cwd" rev-parse --show-toplevel 2>/dev/null)"; then
  project_guess="$project_guess_raw"
fi

PROJECT_ROOT="${AGENTIC_PROJECT_ROOT:-${REPO_ROOT:-$project_guess}}"
ROSTER_PATH_DEFAULT="$PROJECT_ROOT/docs/agentic/agent-bus/ROSTER.json"
ROSTER_PATH="${AGENTIC_ROSTER_PATH:-${VALUA_AGENT_ROSTER_PATH:-${ROSTER_PATH:-$ROSTER_PATH_DEFAULT}}}"
SESSION_NAME="$(node -p "require('${ROSTER_PATH}').sessionName || 'agentic-cockpit'")"

if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  tmux kill-session -t "$SESSION_NAME"
  echo "Killed tmux session: $SESSION_NAME"
else
  echo "No tmux session: $SESSION_NAME"
fi
