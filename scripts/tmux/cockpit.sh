#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COCKPIT_ROOT_DEFAULT="$(cd "$SCRIPT_DIR/../.." && pwd)"
COCKPIT_ROOT="${COCKPIT_ROOT:-$COCKPIT_ROOT_DEFAULT}"

invoke_cwd="$(pwd -P)"
project_guess="$invoke_cwd"
if project_guess_raw="$(git -C "$invoke_cwd" rev-parse --show-toplevel 2>/dev/null)"; then
  project_guess="$project_guess_raw"
fi

PROJECT_ROOT="${AGENTIC_PROJECT_ROOT:-${REPO_ROOT:-$project_guess}}"
export AGENTIC_PROJECT_ROOT="$PROJECT_ROOT"

ROSTER_DEFAULT="$PROJECT_ROOT/docs/agentic/agent-bus/ROSTER.json"
ROSTER_PATH="${AGENTIC_ROSTER_PATH:-${VALUA_AGENT_ROSTER_PATH:-$ROSTER_DEFAULT}}"
ROSTER_FALLBACK="$COCKPIT_ROOT/docs/agentic/agent-bus/ROSTER.json"
if [ ! -f "$ROSTER_PATH" ]; then
  echo "WARN: roster not found at $ROSTER_PATH; falling back to cockpit default: $ROSTER_FALLBACK" >&2
  ROSTER_PATH="$ROSTER_FALLBACK"
fi
export AGENTIC_ROSTER_PATH="$ROSTER_PATH"
export VALUA_AGENT_ROSTER_PATH="${VALUA_AGENT_ROSTER_PATH:-$ROSTER_PATH}"

BUS_ROOT_DEFAULT="$HOME/.agentic-cockpit/bus"
export AGENTIC_BUS_DIR="${AGENTIC_BUS_DIR:-$BUS_ROOT_DEFAULT}"
export VALUA_AGENT_BUS_DIR="${VALUA_AGENT_BUS_DIR:-$AGENTIC_BUS_DIR}"
WORKTREES_DIR_DEFAULT="$HOME/.agentic-cockpit/worktrees"
export AGENTIC_WORKTREES_DIR="${AGENTIC_WORKTREES_DIR:-$WORKTREES_DIR_DEFAULT}"
export VALUA_AGENT_WORKTREES_DIR="${VALUA_AGENT_WORKTREES_DIR:-$AGENTIC_WORKTREES_DIR}"

cmd="${1:-help}"

session_from_roster() {
  if command -v node >/dev/null 2>&1 && [ -f "$ROSTER_PATH" ]; then
    node -e "const fs=require('fs');const r=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));process.stdout.write(String(r.sessionName||'agentic-cockpit'));" "$ROSTER_PATH"
    return 0
  fi
  echo "agentic-cockpit"
}

SESSION="${SESSION:-$(session_from_roster)}"

usage() {
  cat <<EOF
Agentic Cockpit (tmux)

Usage:
  bash scripts/tmux/cockpit.sh up
  bash scripts/tmux/cockpit.sh down
  bash scripts/tmux/cockpit.sh reset      # hard kill the tmux session
  bash scripts/tmux/cockpit.sh restart
  bash scripts/tmux/cockpit.sh attach
  bash scripts/tmux/cockpit.sh status

Env:
  AGENTIC_PROJECT_ROOT       (default: current git root or cwd)
  AGENTIC_BUS_DIR               (default: $BUS_ROOT_DEFAULT)
  AGENTIC_ROSTER_PATH           (default: $ROSTER_DEFAULT)
  AGENTIC_WORKTREES_DIR         (default: $WORKTREES_DIR_DEFAULT)
  AGENTIC_WORKTREES_DISABLE     0|1 (default: 0)
  AGENTIC_POLICY_SYNC_ON_START  0|1 (default: 1; one-way project-root -> worktrees)
  AGENTIC_POLICY_SYNC_VERBOSE   0|1 (default: 0)
  AGENTIC_TMUX_AUTOSTART_ADVISORS 0|1 (default: 1)
  AGENTIC_PR_OBSERVER_AUTOSTART 0|1 (default: 1)
  AGENTIC_PR_OBSERVER_POLL_MS   (default: 60000)
  AGENTIC_PR_OBSERVER_MAX_PRS   (default: 30)
  AGENTIC_PR_OBSERVER_REPO      owner/repo (optional override)
  AGENTIC_PR_OBSERVER_PRS       comma-separated PR list (optional)
  AGENTIC_PR_OBSERVER_MIN_PR    minimum PR number inclusive (optional)
  AGENTIC_PR_OBSERVER_COLD_START_MODE baseline|replay (default: baseline)
  AGENTIC_TMUX_NO_ATTACH        0|1 (default: 0)

Valua compatibility:
  VALUA_AGENT_BUS_DIR, VALUA_AGENT_ROSTER_PATH, VALUA_AGENT_WORKTREES_DIR
EOF
}

cd "$COCKPIT_ROOT"

case "$cmd" in
  up)
    exec bash "$COCKPIT_ROOT/scripts/tmux/agents-up.sh"
    ;;
  down)
    exec bash "$COCKPIT_ROOT/scripts/tmux/agents-down.sh"
    ;;
  reset)
    exec bash "$COCKPIT_ROOT/scripts/tmux/agents-down.sh"
    ;;
  restart)
    echo "NOTE: restart kills the tmux session ($SESSION) and will reset any interactive tools (e.g. claude)." >&2
    bash "$COCKPIT_ROOT/scripts/tmux/agents-down.sh" || true
    exec bash "$COCKPIT_ROOT/scripts/tmux/agents-up.sh"
    ;;
  attach)
    if [ -n "${TMUX:-}" ]; then
      exec tmux switch-client -t "$SESSION"
    fi
    exec tmux attach -t "$SESSION"
    ;;
  status)
    tmux list-sessions 2>/dev/null || true
    echo
    echo "Expected session: $SESSION"
    ;;
  help|-h|--help)
    usage
    ;;
  *)
    echo "Unknown command: $cmd" >&2
    usage >&2
    exit 1
    ;;
esac
