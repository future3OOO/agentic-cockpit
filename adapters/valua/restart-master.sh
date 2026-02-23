#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  bash adapters/valua/restart-master.sh /path/to/Valua [runtime-worktree]

Defaults:
  runtime-worktree: /tmp/valua-runtime-master
  reset state: off (set RESET_STATE=1 to rotate codex-home for all codex agents before start)

Examples:
  bash adapters/valua/restart-master.sh /home/prop_/projects/Valua
  RESET_STATE=1 bash adapters/valua/restart-master.sh /home/prop_/projects/Valua
EOF
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

VALUA_ROOT="${1:-}"
RUNTIME_ROOT="${2:-/tmp/valua-runtime-master}"
if [ -z "$VALUA_ROOT" ]; then
  usage >&2
  exit 2
fi

COCKPIT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUS_ROOT="${AGENTIC_BUS_DIR:-$HOME/.codex/valua/agent-bus}"
RESET_STATE="${RESET_STATE:-0}"
SKILLOPS_KINDS="${AGENTIC_AUTOPILOT_SKILLOPS_GATE_KINDS:-USER_REQUEST,ORCHESTRATOR_UPDATE}"

if ! git -C "$VALUA_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "ERROR: not a git repo: $VALUA_ROOT" >&2
  exit 1
fi

ROSTER_SOURCE="$VALUA_ROOT/docs/agentic/agent-bus/ROSTER.json"
SESSION_NAME="valua-cockpit"
if [ -f "$ROSTER_SOURCE" ]; then
  SESSION_NAME="$(
    node -e "const fs=require('fs');const p=process.argv[1];let s='valua-cockpit';try{s=JSON.parse(fs.readFileSync(p,'utf8')).sessionName||s}catch{};process.stdout.write(String(s));" \
      "$ROSTER_SOURCE"
  )"
fi

tmux kill-session -t "$SESSION_NAME" 2>/dev/null || true

git -C "$VALUA_ROOT" fetch origin master

if git -C "$VALUA_ROOT" worktree list --porcelain | sed -n 's/^worktree //p' | grep -Fxq "$RUNTIME_ROOT"; then
  git -C "$RUNTIME_ROOT" fetch origin master
  git -C "$RUNTIME_ROOT" checkout -B runtime/master origin/master
else
  if [ -e "$RUNTIME_ROOT" ]; then
    echo "ERROR: runtime path exists but is not a registered Valua worktree: $RUNTIME_ROOT" >&2
    echo "Remove it or choose a different runtime path." >&2
    exit 1
  fi
  git -C "$VALUA_ROOT" worktree add --force -B runtime/master "$RUNTIME_ROOT" origin/master
fi

git -C "$RUNTIME_ROOT" reset --hard origin/master
git -C "$RUNTIME_ROOT" clean -fd

ROSTER_PATH="$RUNTIME_ROOT/docs/agentic/agent-bus/ROSTER.json"
if [ ! -f "$ROSTER_PATH" ]; then
  echo "ERROR: missing roster in runtime worktree: $ROSTER_PATH" >&2
  exit 1
fi

if [ "$RESET_STATE" = "1" ]; then
  AGENTS_CSV="$(
    node -e "const fs=require('fs');const p=process.argv[1];let out='';try{const r=JSON.parse(fs.readFileSync(p,'utf8'));const agents=Array.isArray(r.agents)?r.agents:[];const names=agents.filter(a=>a&&a.name&&(a.kind==='codex-worker'||a.kind==='codex-chat')).map(a=>String(a.name).trim()).filter(Boolean);out=Array.from(new Set(names)).join(',')}catch(e){console.error('WARN: failed to parse roster for RESET_STATE agent list:',p,e&&e.message?e.message:String(e));}process.stdout.write(out);" \
      "$ROSTER_PATH"
  )"
  if [ -n "$AGENTS_CSV" ]; then
    echo "RESET_STATE=1: rotating codex state for agents: $AGENTS_CSV" >&2
    AGENTIC_BUS_DIR="$BUS_ROOT" bash "$COCKPIT_ROOT/scripts/agentic/reset-agent-codex-state.sh" \
      --bus-root "$BUS_ROOT" \
      --agents "$AGENTS_CSV"
  else
    echo "WARN: RESET_STATE=1 but no codex agents found in roster: $ROSTER_PATH" >&2
  fi
fi

AGENTIC_PROJECT_ROOT="$RUNTIME_ROOT" \
AGENTIC_BUS_DIR="$BUS_ROOT" \
AGENTIC_ROSTER_PATH="$ROSTER_PATH" \
VALUA_REPO_ROOT="$RUNTIME_ROOT" \
VALUA_AGENT_BUS_DIR="$BUS_ROOT" \
VALUA_AGENT_ROSTER_PATH="$ROSTER_PATH" \
AGENTIC_POLICY_SYNC_ON_START=1 \
VALUA_POLICY_SYNC_ON_START=1 \
AGENTIC_POLICY_SYNC_SOURCE_REF=origin/master \
VALUA_POLICY_SYNC_SOURCE_REF=origin/master \
AGENTIC_AUTOPILOT_SKILLOPS_GATE=1 \
AGENTIC_AUTOPILOT_SKILLOPS_GATE_KINDS="$SKILLOPS_KINDS" \
AGENTIC_TMUX_NO_ATTACH=1 \
VALUA_TMUX_NO_ATTACH=1 \
bash "$COCKPIT_ROOT/adapters/valua/run.sh" "$RUNTIME_ROOT"

tmux attach -t "$SESSION_NAME"
