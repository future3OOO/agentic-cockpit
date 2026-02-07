#!/usr/bin/env bash
set -euo pipefail

# Starts the Agentic Cockpit (tmux).
#
# The user types ONLY in the operator chat pane.
# All other panes are automated workers/listeners.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COCKPIT_ROOT="${COCKPIT_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"

invoke_cwd="$(pwd -P)"
project_guess="$invoke_cwd"
if project_guess_raw="$(git -C "$invoke_cwd" rev-parse --show-toplevel 2>/dev/null)"; then
  project_guess="$project_guess_raw"
fi

PROJECT_ROOT="${AGENTIC_PROJECT_ROOT:-${REPO_ROOT:-$project_guess}}"
export AGENTIC_PROJECT_ROOT="$PROJECT_ROOT"

ROSTER_PATH_DEFAULT="$PROJECT_ROOT/docs/agentic/agent-bus/ROSTER.json"
ROSTER_PATH="${AGENTIC_ROSTER_PATH:-${VALUA_AGENT_ROSTER_PATH:-${ROSTER_PATH:-$ROSTER_PATH_DEFAULT}}}"
ROSTER_FALLBACK="$COCKPIT_ROOT/docs/agentic/agent-bus/ROSTER.json"
if [ ! -f "$ROSTER_PATH" ]; then
  echo "WARN: roster not found at $ROSTER_PATH; falling back to cockpit default: $ROSTER_FALLBACK" >&2
  ROSTER_PATH="$ROSTER_FALLBACK"
fi
export AGENTIC_ROSTER_PATH="$ROSTER_PATH"
export VALUA_AGENT_ROSTER_PATH="${VALUA_AGENT_ROSTER_PATH:-$ROSTER_PATH}"

BUS_ROOT_DEFAULT="$HOME/.agentic-cockpit/bus"
BUS_ROOT="${AGENTIC_BUS_DIR:-${VALUA_AGENT_BUS_DIR:-${AGENT_BUS_DIR:-$BUS_ROOT_DEFAULT}}}"
export AGENTIC_BUS_DIR="$BUS_ROOT"
export VALUA_AGENT_BUS_DIR="${VALUA_AGENT_BUS_DIR:-$AGENTIC_BUS_DIR}"

WORKTREES_DIR_DEFAULT="$HOME/.agentic-cockpit/worktrees"
export AGENTIC_WORKTREES_DIR="${AGENTIC_WORKTREES_DIR:-$WORKTREES_DIR_DEFAULT}"
export VALUA_AGENT_WORKTREES_DIR="${VALUA_AGENT_WORKTREES_DIR:-$AGENTIC_WORKTREES_DIR}"

# Codex exec watchdog: cockpit tasks can legitimately take hours (staging/prod debugging, PR review closure).
# Default to 12h unless the operator overrides it.
export AGENTIC_CODEX_EXEC_TIMEOUT_MS="${AGENTIC_CODEX_EXEC_TIMEOUT_MS:-43200000}"
export VALUA_CODEX_EXEC_TIMEOUT_MS="${VALUA_CODEX_EXEC_TIMEOUT_MS:-$AGENTIC_CODEX_EXEC_TIMEOUT_MS}"

# Extract core names from roster via node (avoid jq dependency).
SESSION_NAME="$(node -p "require('${ROSTER_PATH}').sessionName || 'agentic-cockpit'")"
DADDY_NAME="$(node -p "require('${ROSTER_PATH}').daddyChatName || 'daddy'")"
ORCH_NAME="$(node -p "require('${ROSTER_PATH}').orchestratorName || 'daddy-orchestrator'")"
AUTOPILOT_NAME="$(node -p "require('${ROSTER_PATH}').autopilotName || 'daddy-autopilot'")"

# Ensure tmux ergonomics (mouse, border titles, etc) are enabled even when the tmux server is shared.
tmux source-file "$COCKPIT_ROOT/scripts/tmux/agents.conf" 2>/dev/null || true

# Hard guard: prevent cross-session env leakage from a shared tmux server.
# Agentic Cockpit must never set AGENTIC_* or VALUA_REPO_ROOT globally, since those can silently
# redirect other projects' workers to run in the wrong repo.
tmux set-environment -gu VALUA_REPO_ROOT 2>/dev/null || true
tmux set-environment -gu REPO_ROOT 2>/dev/null || true
if tmux show-environment -g 2>/dev/null | while IFS= read -r line; do
  case "$line" in
    AGENTIC_*=*) tmux set-environment -gu "${line%%=*}" 2>/dev/null || true ;;
  esac
done; then :; fi

tmux_set_session_env() {
  tmux set-environment -t "$SESSION_NAME" AGENTIC_BUS_DIR "$BUS_ROOT" 2>/dev/null || true
  tmux set-environment -t "$SESSION_NAME" AGENTIC_ROSTER_PATH "$ROSTER_PATH" 2>/dev/null || true
  tmux set-environment -t "$SESSION_NAME" AGENTIC_WORKTREES_DIR "$AGENTIC_WORKTREES_DIR" 2>/dev/null || true
  tmux set-environment -t "$SESSION_NAME" AGENTIC_CODEX_EXEC_TIMEOUT_MS "$AGENTIC_CODEX_EXEC_TIMEOUT_MS" 2>/dev/null || true
  tmux set-environment -t "$SESSION_NAME" AGENTIC_PROJECT_ROOT "$PROJECT_ROOT" 2>/dev/null || true

  # Valua compatibility for downstream consumers (session-scoped).
  tmux set-environment -t "$SESSION_NAME" VALUA_AGENT_BUS_DIR "$BUS_ROOT" 2>/dev/null || true
  tmux set-environment -t "$SESSION_NAME" VALUA_AGENT_ROSTER_PATH "$ROSTER_PATH" 2>/dev/null || true
  tmux set-environment -t "$SESSION_NAME" VALUA_AGENT_WORKTREES_DIR "$VALUA_AGENT_WORKTREES_DIR" 2>/dev/null || true
  tmux set-environment -t "$SESSION_NAME" VALUA_CODEX_EXEC_TIMEOUT_MS "$VALUA_CODEX_EXEC_TIMEOUT_MS" 2>/dev/null || true
  tmux set-environment -t "$SESSION_NAME" VALUA_REPO_ROOT "$PROJECT_ROOT" 2>/dev/null || true
}

# If a tmux session already exists, refresh its environment so newly-started panes/workers inherit
# the latest cockpit settings (e.g. long exec timeout). Keep these session-scoped to avoid leaks.
tmux_set_session_env

HARD_RESET="${AGENTIC_TMUX_HARD_RESET:-${VALUA_TMUX_HARD_RESET:-0}}"
RESET_ENV_PREFIX=""
if [ "$HARD_RESET" = "1" ]; then
  RESET_ENV_PREFIX="AGENTIC_CODEX_RESET_SESSIONS=1 VALUA_CODEX_RESET_SESSIONS=1"
fi

expand_roster_vars() {
  local s="$1"
  s="${s//\$REPO_ROOT/$PROJECT_ROOT}"
  s="${s//\$AGENTIC_WORKTREES_DIR/$AGENTIC_WORKTREES_DIR}"
  s="${s//\$VALUA_AGENT_WORKTREES_DIR/$VALUA_AGENT_WORKTREES_DIR}"
  s="${s//\$HOME/$HOME}"
  printf '%s' "$s"
}

agent_field() {
  local agent="$1"
  local field="$2"
  node -e '
    const rosterPath = process.argv[1];
    const agentName = process.argv[2];
    const fieldName = process.argv[3];
    const r = require(rosterPath);
    const a = (r.agents || []).find((x) => x && x.name === agentName);
    const v = a && a[fieldName];
    process.stdout.write(v == null ? "" : String(v));
  ' "$ROSTER_PATH" "$agent" "$field"
}

agent_workdir() {
  local agent="$1"
  local raw
  raw="$(agent_field "$agent" "workdir")"
  local kind
  kind="$(agent_field "$agent" "kind")"

  # Prefer per-agent worktrees for codex-worker agents by default.
  # This keeps each agent isolated on its own branch and avoids clobbering the operator's worktree.
  local worktrees_disabled="${AGENTIC_WORKTREES_DISABLE:-${VALUA_AGENT_WORKTREES_DISABLE:-0}}"
  if [ "$worktrees_disabled" != "1" ] && [ "$kind" = "codex-worker" ]; then
    # Legacy rosters set workdir=$REPO_ROOT; treat that as "use worktree".
    if [ -z "$raw" ] || [ "$(expand_roster_vars "$raw")" = "$PROJECT_ROOT" ]; then
      printf '%s' "$AGENTIC_WORKTREES_DIR/$agent"
      return 0
    fi
  fi

  if [ -z "$raw" ]; then
    printf '%s' "$PROJECT_ROOT"
    return 0
  fi

  expand_roster_vars "$raw"
}

agent_start_command() {
  local agent="$1"
  local cmd
  cmd="$(agent_field "$agent" "startCommand")"
  # Always run the latest cockpit worker runtime from this repo root, even when an agent's workdir
  # points at a different worktree/branch. This prevents stale per-agent worktrees from pinning an
  # older `scripts/agent-codex-worker.mjs` (e.g. workspace-write without
  # `sandbox_workspace_write.network_access=true`), which can look like “network disabled” and/or
  # hide streaming output.
  if [[ "$cmd" == node\ scripts/* ]]; then
    local tail="${cmd#node scripts/}"
    local script="${tail%% *}"
    local rest=""
    if [[ "$tail" != "$script" ]]; then rest="${tail#"$script"}"; fi
    cmd="node '$COCKPIT_ROOT/scripts/$script'$rest"
  fi
  if [[ "$cmd" == bash\ scripts/* ]]; then
    local tail="${cmd#bash scripts/}"
    local script="${tail%% *}"
    local rest=""
    if [[ "$tail" != "$script" ]]; then rest="${tail#"$script"}"; fi
    cmd="bash '$COCKPIT_ROOT/scripts/$script'$rest"
  fi
  printf '%s' "$cmd"
}

ensure_worktrees() {
  if [ "${AGENTIC_WORKTREES_DISABLE:-${VALUA_AGENT_WORKTREES_DISABLE:-0}}" = "1" ]; then
    return 0
  fi
  if ! git -C "$PROJECT_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "WARN: $PROJECT_ROOT is not a git repo; skipping worktree setup." >&2
    return 0
  fi
  if [ -x "$COCKPIT_ROOT/scripts/agentic/setup-worktrees.sh" ]; then
    (cd "$PROJECT_ROOT" && bash "$COCKPIT_ROOT/scripts/agentic/setup-worktrees.sh" --roster "$ROSTER_PATH" >/dev/null)
  fi
}

# Ensure per-agent worktrees exist (idempotent; no-op if disabled).
ensure_worktrees

# Initialize bus directories.
(
  cd "$COCKPIT_ROOT"
  AGENTIC_BUS_DIR="$BUS_ROOT" node "$COCKPIT_ROOT/scripts/agent-bus.mjs" init --bus-root "$BUS_ROOT" --roster "$ROSTER_PATH" >/dev/null
)

if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  echo "tmux session already exists: $SESSION_NAME"
  # Idempotent autostart: ensure dashboard window exists when re-running `up`.
  DASHBOARD_AUTOSTART="${AGENTIC_DASHBOARD_AUTOSTART:-${VALUA_DASHBOARD_AUTOSTART:-1}}"
  if [ "$DASHBOARD_AUTOSTART" != "0" ]; then
    if ! tmux list-windows -t "$SESSION_NAME" -F '#{window_name}' 2>/dev/null | grep -qx 'dashboard'; then
      tmux new-window -t "$SESSION_NAME" -n dashboard -c "$PROJECT_ROOT" 2>/dev/null || true
      tmux select-pane -t "$SESSION_NAME:dashboard.0" -T "DASHBOARD"
      tmux send-keys -t "$SESSION_NAME:dashboard.0" \
        "cd '$PROJECT_ROOT' && export AGENTIC_PROJECT_ROOT='$PROJECT_ROOT' && export AGENTIC_BUS_DIR='$BUS_ROOT' && export AGENTIC_ROSTER_PATH='$ROSTER_PATH' && export VALUA_REPO_ROOT='$PROJECT_ROOT' && export VALUA_AGENT_BUS_DIR='$BUS_ROOT' && export VALUA_AGENT_ROSTER_PATH='$ROSTER_PATH' && export AGENTIC_DASHBOARD_AUTO_OPEN='${AGENTIC_DASHBOARD_AUTO_OPEN:-1}' && node '$COCKPIT_ROOT/scripts/dashboard/server.mjs'" C-m
    fi
  fi
else
  tmux new-session -d -s "$SESSION_NAME" -n cockpit -c "$PROJECT_ROOT"
  tmux_set_session_env

  # Layout: left = Daddy Chat; right = Inbox + Orchestrator + Autopilot + Bus Status
  tmux split-window -h -t "$SESSION_NAME:cockpit" -l 35% -c "$PROJECT_ROOT"
  tmux split-window -v -t "$SESSION_NAME:cockpit.1" -l 33% -c "$PROJECT_ROOT"
  tmux split-window -v -t "$SESSION_NAME:cockpit.2" -l 50% -c "$PROJECT_ROOT"
  tmux split-window -v -t "$SESSION_NAME:cockpit.3" -l 50% -c "$PROJECT_ROOT"

  # Titles
  tmux select-pane -t "$SESSION_NAME:cockpit.0" -T "OPERATOR CHAT"
  tmux select-pane -t "$SESSION_NAME:cockpit.1" -T "DADDY INBOX"
  tmux select-pane -t "$SESSION_NAME:cockpit.2" -T "ORCHESTRATOR"
  tmux select-pane -t "$SESSION_NAME:cockpit.3" -T "DADDY AUTOPILOT"
  tmux select-pane -t "$SESSION_NAME:cockpit.4" -T "BUS STATUS"

  # Start Daddy Chat (Codex interactive) and activate the control-panel skill.
  daddy_workdir="$(agent_workdir "$DADDY_NAME")"
  daddy_cmd="$(agent_start_command "$DADDY_NAME")"
  tmux send-keys -t "$SESSION_NAME:cockpit.0" \
    "cd '$daddy_workdir' && export AGENTIC_PROJECT_ROOT='$PROJECT_ROOT' && export AGENTIC_BUS_DIR='$BUS_ROOT' && export AGENTIC_ROSTER_PATH='$ROSTER_PATH' && export VALUA_REPO_ROOT='$PROJECT_ROOT' && export VALUA_AGENT_BUS_DIR='$BUS_ROOT' && export VALUA_AGENT_ROSTER_PATH='$ROSTER_PATH' && $daddy_cmd" C-m
  # Boot skill is provided as the Codex initial prompt by `scripts/agentic/codex-chat-supervisor.sh`.

  # Start Daddy inbox listener (prints any packets delivered to Daddy).
  tmux send-keys -t "$SESSION_NAME:cockpit.1" \
    "cd '$COCKPIT_ROOT' && export AGENTIC_PROJECT_ROOT='$PROJECT_ROOT' && export AGENTIC_BUS_DIR='$BUS_ROOT' && export AGENTIC_ROSTER_PATH='$ROSTER_PATH' && export VALUA_REPO_ROOT='$PROJECT_ROOT' && export VALUA_AGENT_BUS_DIR='$BUS_ROOT' && export VALUA_AGENT_ROSTER_PATH='$ROSTER_PATH' && bash scripts/agentic/agent-listen-supervisor.sh --agent '$DADDY_NAME' --tmux-notify --tmux-target '$SESSION_NAME:cockpit.0'" C-m

  # Start orchestrator worker (forwards TASK_COMPLETE digests to Daddy).
  orch_workdir="$(agent_workdir "$ORCH_NAME")"
  orch_cmd="$(agent_start_command "$ORCH_NAME")"
  tmux send-keys -t "$SESSION_NAME:cockpit.2" \
    "cd '$orch_workdir' && export AGENTIC_PROJECT_ROOT='$PROJECT_ROOT' && export AGENTIC_BUS_DIR='$BUS_ROOT' && export AGENTIC_ROSTER_PATH='$ROSTER_PATH' && export VALUA_REPO_ROOT='$PROJECT_ROOT' && export VALUA_AGENT_BUS_DIR='$BUS_ROOT' && export VALUA_AGENT_ROSTER_PATH='$ROSTER_PATH' && ${RESET_ENV_PREFIX} $orch_cmd --tmux-target '$SESSION_NAME:cockpit.0'" C-m

  # Start autopilot worker (consumes ORCHESTRATOR_UPDATE digests and dispatches followUps).
  autopilot_workdir="$(agent_workdir "$AUTOPILOT_NAME")"
  autopilot_cmd="$(agent_start_command "$AUTOPILOT_NAME")"
  tmux send-keys -t "$SESSION_NAME:cockpit.3" \
    "cd '$autopilot_workdir' && export AGENTIC_PROJECT_ROOT='$PROJECT_ROOT' && export AGENTIC_BUS_DIR='$BUS_ROOT' && export AGENTIC_ROSTER_PATH='$ROSTER_PATH' && export VALUA_REPO_ROOT='$PROJECT_ROOT' && export VALUA_AGENT_BUS_DIR='$BUS_ROOT' && export VALUA_AGENT_ROSTER_PATH='$ROSTER_PATH' && export AGENTIC_AUTOPILOT_INCLUDE_DEPLOY_JSON=1 && export VALUA_AUTOPILOT_INCLUDE_DEPLOY_JSON=1 && ${RESET_ENV_PREFIX} $autopilot_cmd" C-m

# Start bus status loop.
  tmux send-keys -t "$SESSION_NAME:cockpit.4" \
    "cd '$COCKPIT_ROOT' && export AGENTIC_PROJECT_ROOT='$PROJECT_ROOT' && export AGENTIC_BUS_DIR='$BUS_ROOT' && export AGENTIC_ROSTER_PATH='$ROSTER_PATH' && export VALUA_REPO_ROOT='$PROJECT_ROOT' && export VALUA_AGENT_BUS_DIR='$BUS_ROOT' && export VALUA_AGENT_ROSTER_PATH='$ROSTER_PATH' && while true; do clear; node '$COCKPIT_ROOT/scripts/agent-bus.mjs' status --bus-root '$BUS_ROOT' --roster '$ROSTER_PATH'; echo; node '$COCKPIT_ROOT/scripts/agent-bus.mjs' open-tasks --limit 30 --format lines --bus-root '$BUS_ROOT' --roster '$ROSTER_PATH'; echo; node '$COCKPIT_ROOT/scripts/agent-bus.mjs' recent --limit 10 --format lines --bus-root '$BUS_ROOT' --roster '$ROSTER_PATH'; sleep 2; done" C-m

  # Local dashboard (web UI). Starts automatically unless disabled.
  DASHBOARD_AUTOSTART="${AGENTIC_DASHBOARD_AUTOSTART:-${VALUA_DASHBOARD_AUTOSTART:-1}}"
  if [ "$DASHBOARD_AUTOSTART" != "0" ]; then
    tmux new-window -t "$SESSION_NAME" -n dashboard -c "$PROJECT_ROOT" 2>/dev/null || true
    tmux select-pane -t "$SESSION_NAME:dashboard.0" -T "DASHBOARD"
    tmux send-keys -t "$SESSION_NAME:dashboard.0" \
      "cd '$PROJECT_ROOT' && export AGENTIC_PROJECT_ROOT='$PROJECT_ROOT' && export AGENTIC_BUS_DIR='$BUS_ROOT' && export AGENTIC_ROSTER_PATH='$ROSTER_PATH' && export VALUA_REPO_ROOT='$PROJECT_ROOT' && export VALUA_AGENT_BUS_DIR='$BUS_ROOT' && export VALUA_AGENT_ROSTER_PATH='$ROSTER_PATH' && export AGENTIC_DASHBOARD_AUTO_OPEN='${AGENTIC_DASHBOARD_AUTO_OPEN:-1}' && node '$COCKPIT_ROOT/scripts/dashboard/server.mjs'" C-m
  fi

  # Workers window (Codex exec workers)
  tmux new-window -t "$SESSION_NAME" -n agents -c "$PROJECT_ROOT"

  WORKER_NAMES="$(node -e "
    const r=require('${ROSTER_PATH}');
    const omit=new Set([r.daddyChatName||'daddy', r.orchestratorName||'daddy-orchestrator', r.autopilotName||'daddy-autopilot']);
    const workers=(r.agents||[]).filter(a=>a.kind==='codex-worker' && !omit.has(a.name)).map(a=>a.name);
    console.log(workers.join('\n'));
  ")"

  i=0
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    workdir="$(agent_workdir "$name")"
    cmd="$(agent_start_command "$name")"
    if [ "$i" -eq 0 ]; then
      tmux select-pane -t "$SESSION_NAME:agents.0" -T "$name"
      tmux send-keys -t "$SESSION_NAME:agents.0" \
        "cd '$workdir' && export AGENTIC_BUS_DIR='$BUS_ROOT' && export AGENTIC_ROSTER_PATH='$ROSTER_PATH' && export VALUA_AGENT_BUS_DIR='$BUS_ROOT' && export VALUA_AGENT_ROSTER_PATH='$ROSTER_PATH' && ${RESET_ENV_PREFIX} $cmd" C-m
    else
      if tmux split-window -t "$SESSION_NAME:agents" -c "$workdir" >/dev/null 2>&1; then
        pane_index="$(tmux display-message -p -t "$SESSION_NAME:agents" '#{pane_index}')"
        tmux select-pane -t "$SESSION_NAME:agents.$pane_index" -T "$name"
        tmux send-keys -t "$SESSION_NAME:agents.$pane_index" \
          "cd '$workdir' && export AGENTIC_BUS_DIR='$BUS_ROOT' && export AGENTIC_ROSTER_PATH='$ROSTER_PATH' && export VALUA_AGENT_BUS_DIR='$BUS_ROOT' && export VALUA_AGENT_ROSTER_PATH='$ROSTER_PATH' && ${RESET_ENV_PREFIX} $cmd" C-m
      else
        # Fallback for very small terminals: start additional workers in their own windows.
        tmux new-window -t "$SESSION_NAME" -n "$name" -c "$workdir"
        tmux select-pane -t "$SESSION_NAME:$name.0" -T "$name"
        tmux send-keys -t "$SESSION_NAME:$name.0" \
          "cd '$workdir' && export AGENTIC_BUS_DIR='$BUS_ROOT' && export AGENTIC_ROSTER_PATH='$ROSTER_PATH' && export VALUA_AGENT_BUS_DIR='$BUS_ROOT' && export VALUA_AGENT_ROSTER_PATH='$ROSTER_PATH' && ${RESET_ENV_PREFIX} $cmd" C-m
      fi
    fi
    i=$((i+1))
  done <<<"$WORKER_NAMES"

  tmux select-layout -t "$SESSION_NAME:agents" tiled

  # Advisors window (optional)
  AUTOSTART_ADVISORS="${AGENTIC_TMUX_AUTOSTART_ADVISORS:-${VALUA_TMUX_AUTOSTART_ADVISORS:-1}}"
  if [ "$AUTOSTART_ADVISORS" != "0" ]; then
    tmux new-window -t "$SESSION_NAME" -n advisors -c "$PROJECT_ROOT"
  fi
  ADVISOR_NAMES="$(node -e "
    const r=require('${ROSTER_PATH}');
    const adv=(r.agents||[]).filter(a=>a.kind==='advisor').map(a=>a.name);
    console.log(adv.join('\n'));
  ")"

  if [ "$AUTOSTART_ADVISORS" != "0" ]; then
    j=0
    while IFS= read -r name; do
      [ -n "$name" ] || continue
      cmd="$(agent_start_command "$name")"
      if [ -z "$cmd" ]; then
        continue
      fi
      workdir="$(agent_workdir "$name")"

      if [ "$j" -eq 0 ]; then
        tmux select-pane -t "$SESSION_NAME:advisors.0" -T "$name"
        tmux send-keys -t "$SESSION_NAME:advisors.0" "cd '$workdir' && $cmd" C-m
      else
        tmux split-window -t "$SESSION_NAME:advisors" -c "$workdir"
        pane_index="$(tmux display-message -p -t "$SESSION_NAME:advisors" '#{pane_index}')"
        tmux select-pane -t "$SESSION_NAME:advisors.$pane_index" -T "$name"
        tmux send-keys -t "$SESSION_NAME:advisors.$pane_index" "cd '$workdir' && $cmd" C-m
      fi
      j=$((j+1))
    done <<<"$ADVISOR_NAMES"
    tmux select-layout -t "$SESSION_NAME:advisors" tiled
  fi

  # Focus cockpit by default.
  tmux select-window -t "$SESSION_NAME:cockpit"
  tmux select-pane -t "$SESSION_NAME:cockpit.0"
fi

if [ "${AGENTIC_TMUX_NO_ATTACH:-${VALUA_TMUX_NO_ATTACH:-0}}" = "1" ]; then
  echo "VALUA_TMUX_NO_ATTACH=1; not attaching."
else
  exec tmux attach -t "$SESSION_NAME"
fi
