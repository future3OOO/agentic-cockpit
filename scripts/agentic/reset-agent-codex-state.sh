#!/usr/bin/env bash
set -euo pipefail

# One-shot operational repair for Codex internal rollout/thread index desync.
#
# This script intentionally does NOT touch any repo/worktree files.
# It only resets runtime state under AGENTIC_BUS_DIR:
# - clears per-agent bus pins/state
# - rotates per-agent codex-home backup
# - recreates fresh codex-home/<agent> directory
#
# Usage (recommended):
#   1) stop cockpit workers (tmux session down)
#   2) run this script for affected agents
#   3) start cockpit again

usage() {
  cat <<'EOF'
reset-agent-codex-state.sh

Usage:
  bash scripts/agentic/reset-agent-codex-state.sh --agent <name> [--agent <name>...]
  bash scripts/agentic/reset-agent-codex-state.sh --agents <csv>

Examples:
  bash scripts/agentic/reset-agent-codex-state.sh --agent daddy-autopilot
  bash scripts/agentic/reset-agent-codex-state.sh --agents "daddy-autopilot,frontend"

Env:
  AGENTIC_BUS_DIR / VALUA_AGENT_BUS_DIR / AGENT_BUS_DIR
    Bus root (default: $HOME/.agentic-cockpit/bus)

Notes:
  - Run with cockpit workers stopped for safe rotation.
  - If you must run while a worker lock exists, pass --force.
  - This clears live thread continuity for reset agents, but keeps a timestamped
    codex-home backup for forensic reference.
EOF
}

BUS_ROOT_DEFAULT="$HOME/.agentic-cockpit/bus"
BUS_ROOT="${AGENTIC_BUS_DIR:-${VALUA_AGENT_BUS_DIR:-${AGENT_BUS_DIR:-$BUS_ROOT_DEFAULT}}}"
FORCE=0

declare -a agents=()

append_agents_csv() {
  local csv="$1"
  IFS=',' read -r -a parts <<<"$csv"
  local p trimmed
  for p in "${parts[@]}"; do
    trimmed="$(echo "$p" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    [ -n "$trimmed" ] || continue
    agents+=("$trimmed")
  done
}

validate_agent_name() {
  local agent="$1"
  if [ -z "$agent" ] || ! [[ "$agent" =~ ^[A-Za-z0-9][A-Za-z0-9_-]*$ ]]; then
    echo "ERROR: invalid agent name '$agent' (allowed: [A-Za-z0-9][A-Za-z0-9_-]*)" >&2
    exit 2
  fi
}

while [ $# -gt 0 ]; do
  case "$1" in
    --agent)
      [ $# -ge 2 ] || { echo "ERROR: --agent requires a value" >&2; usage >&2; exit 2; }
      agents+=("$2")
      shift 2
      ;;
    --agents)
      [ $# -ge 2 ] || { echo "ERROR: --agents requires a CSV value" >&2; usage >&2; exit 2; }
      append_agents_csv "$2"
      shift 2
      ;;
    --bus-root)
      [ $# -ge 2 ] || { echo "ERROR: --bus-root requires a value" >&2; usage >&2; exit 2; }
      BUS_ROOT="$2"
      shift 2
      ;;
    --force)
      FORCE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unknown arg: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [ "${#agents[@]}" -eq 0 ]; then
  echo "ERROR: at least one agent is required via --agent or --agents" >&2
  usage >&2
  exit 2
fi

if [ ! -d "$BUS_ROOT" ]; then
  echo "ERROR: bus root does not exist: $BUS_ROOT" >&2
  exit 1
fi

STATE_DIR="$BUS_ROOT/state"
CODEX_HOME_ROOT="$STATE_DIR/codex-home"
LOCK_DIR="$STATE_DIR/worker-locks"

mkdir -p "$STATE_DIR" "$CODEX_HOME_ROOT"

is_pid_alive() {
  local pid="$1"
  if [ -z "$pid" ] || ! [[ "$pid" =~ ^[0-9]+$ ]]; then
    return 1
  fi
  if kill -0 "$pid" 2>/dev/null; then
    return 0
  fi
  return 1
}

assert_worker_not_running() {
  local agent="$1"
  local lock_path="$LOCK_DIR/$agent.lock.json"
  [ -f "$lock_path" ] || return 0
  local pid
  pid="$(grep -oE '"pid"[[:space:]]*:[[:space:]]*[0-9]+' "$lock_path" 2>/dev/null | grep -oE '[0-9]+' | head -n1 || true)"
  if [ -z "$pid" ]; then
    if [ "$FORCE" = "1" ]; then
      echo "WARN: lock exists for '$agent' but pid is unreadable; continuing due to --force." >&2
      return 0
    fi
    echo "ERROR: lock exists for agent '$agent' but pid is unreadable." >&2
    echo "Stop cockpit fully and re-run reset; use --force only if you intentionally bypass lock safety." >&2
    exit 1
  fi
  if is_pid_alive "$pid"; then
    if [ "$FORCE" = "1" ]; then
      echo "WARN: worker appears running for '$agent' (pid=$pid), continuing due to --force." >&2
      return 0
    fi
    echo "ERROR: worker appears running for agent '$agent' (pid=$pid)." >&2
    echo "Stop cockpit first (tmux kill-session -t <session>) then re-run reset." >&2
    echo "If you intentionally want to bypass lock checks, pass --force." >&2
    exit 1
  fi
}

safe_rotate_dir() {
  local src="$1"
  local base="$2"
  local dst="$base"
  local i=1
  while [ -e "$dst" ]; do
    dst="${base}-$i"
    i=$((i+1))
  done
  mv "$src" "$dst"
  echo "$dst"
}

TS="$(date -u +%Y%m%dT%H%M%SZ)"

echo "Resetting Codex state:"
echo "- busRoot: $BUS_ROOT"
echo "- timestamp: $TS"
echo "- force: $FORCE"
echo

for agent in "${agents[@]}"; do
  validate_agent_name "$agent"
  echo "== agent: $agent =="
  assert_worker_not_running "$agent"

  # 1) Clear bus-level pins/state
  rm -f "$STATE_DIR/$agent.session-id"
  rm -f "$STATE_DIR/$agent.prompt-bootstrap.json"
  rm -rf "$STATE_DIR/codex-root-sessions/$agent"
  rm -rf "$STATE_DIR/codex-task-sessions/$agent"
  echo "cleared pins/state under $STATE_DIR"

  # 2) Rotate codex-home for this agent (if present)
  home_dir="$CODEX_HOME_ROOT/$agent"
  if [ -d "$home_dir" ]; then
    rotated="$(safe_rotate_dir "$home_dir" "${home_dir}.reset-$TS")"
    echo "rotated codex-home backup: $rotated"
  else
    echo "no existing codex-home to rotate for $agent"
  fi

  # 3) Recreate empty codex-home dir (worker startup will re-provision auth/config links)
  mkdir -p "$home_dir"
  {
    echo "timestamp=$TS"
    echo "agent=$agent"
    echo "reason=manual_desync_repair"
  } >"$home_dir/.manual-reset-v1"
  echo "created fresh codex-home: $home_dir"
  echo
done

echo "Done."
echo "Next: restart cockpit so workers reinitialize clean thread state."
