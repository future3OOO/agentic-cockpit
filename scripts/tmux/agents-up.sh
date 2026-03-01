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

AGENTIC_AUTOPILOT_SKILLOPS_GATE_DEFAULT="${VALUA_AUTOPILOT_SKILLOPS_GATE:-1}"
export AGENTIC_AUTOPILOT_SKILLOPS_GATE="${AGENTIC_AUTOPILOT_SKILLOPS_GATE:-$AGENTIC_AUTOPILOT_SKILLOPS_GATE_DEFAULT}"
export VALUA_AUTOPILOT_SKILLOPS_GATE="${VALUA_AUTOPILOT_SKILLOPS_GATE:-$AGENTIC_AUTOPILOT_SKILLOPS_GATE}"
AGENTIC_AUTOPILOT_SKILLOPS_GATE_KINDS_DEFAULT="${VALUA_AUTOPILOT_SKILLOPS_GATE_KINDS:-USER_REQUEST,ORCHESTRATOR_UPDATE}"
export AGENTIC_AUTOPILOT_SKILLOPS_GATE_KINDS="${AGENTIC_AUTOPILOT_SKILLOPS_GATE_KINDS:-$AGENTIC_AUTOPILOT_SKILLOPS_GATE_KINDS_DEFAULT}"
export VALUA_AUTOPILOT_SKILLOPS_GATE_KINDS="${VALUA_AUTOPILOT_SKILLOPS_GATE_KINDS:-$AGENTIC_AUTOPILOT_SKILLOPS_GATE_KINDS}"
AGENTIC_CODE_QUALITY_GATE_DEFAULT="${VALUA_CODE_QUALITY_GATE:-1}"
export AGENTIC_CODE_QUALITY_GATE="${AGENTIC_CODE_QUALITY_GATE:-$AGENTIC_CODE_QUALITY_GATE_DEFAULT}"
export VALUA_CODE_QUALITY_GATE="${VALUA_CODE_QUALITY_GATE:-$AGENTIC_CODE_QUALITY_GATE}"
AGENTIC_CODE_QUALITY_GATE_KINDS_DEFAULT="${VALUA_CODE_QUALITY_GATE_KINDS:-USER_REQUEST,ORCHESTRATOR_UPDATE,EXECUTE}"
export AGENTIC_CODE_QUALITY_GATE_KINDS="${AGENTIC_CODE_QUALITY_GATE_KINDS:-$AGENTIC_CODE_QUALITY_GATE_KINDS_DEFAULT}"
export VALUA_CODE_QUALITY_GATE_KINDS="${VALUA_CODE_QUALITY_GATE_KINDS:-$AGENTIC_CODE_QUALITY_GATE_KINDS}"
export AGENTIC_EXEC_PREFLIGHT_AUTOCLEAN_DIRTY="${AGENTIC_EXEC_PREFLIGHT_AUTOCLEAN_DIRTY:-1}"
export VALUA_EXEC_PREFLIGHT_AUTOCLEAN_DIRTY="${VALUA_EXEC_PREFLIGHT_AUTOCLEAN_DIRTY:-$AGENTIC_EXEC_PREFLIGHT_AUTOCLEAN_DIRTY}"
export AGENTIC_AUTOPILOT_OPUS_GATE="${AGENTIC_AUTOPILOT_OPUS_GATE:-${VALUA_AUTOPILOT_OPUS_GATE:-1}}"
export VALUA_AUTOPILOT_OPUS_GATE="${VALUA_AUTOPILOT_OPUS_GATE:-$AGENTIC_AUTOPILOT_OPUS_GATE}"
export AGENTIC_AUTOPILOT_OPUS_GATE_KINDS="${AGENTIC_AUTOPILOT_OPUS_GATE_KINDS:-${VALUA_AUTOPILOT_OPUS_GATE_KINDS:-USER_REQUEST,PLAN_REQUEST,ORCHESTRATOR_UPDATE,EXECUTE}}"
export VALUA_AUTOPILOT_OPUS_GATE_KINDS="${VALUA_AUTOPILOT_OPUS_GATE_KINDS:-$AGENTIC_AUTOPILOT_OPUS_GATE_KINDS}"
export AGENTIC_AUTOPILOT_OPUS_CONSULT_AGENT="${AGENTIC_AUTOPILOT_OPUS_CONSULT_AGENT:-${VALUA_AUTOPILOT_OPUS_CONSULT_AGENT:-opus-consult}}"
export VALUA_AUTOPILOT_OPUS_CONSULT_AGENT="${VALUA_AUTOPILOT_OPUS_CONSULT_AGENT:-$AGENTIC_AUTOPILOT_OPUS_CONSULT_AGENT}"
export AGENTIC_AUTOPILOT_OPUS_GATE_TIMEOUT_MS="${AGENTIC_AUTOPILOT_OPUS_GATE_TIMEOUT_MS:-${VALUA_AUTOPILOT_OPUS_GATE_TIMEOUT_MS:-3600000}}"
export VALUA_AUTOPILOT_OPUS_GATE_TIMEOUT_MS="${VALUA_AUTOPILOT_OPUS_GATE_TIMEOUT_MS:-$AGENTIC_AUTOPILOT_OPUS_GATE_TIMEOUT_MS}"
export AGENTIC_AUTOPILOT_OPUS_MAX_ROUNDS="${AGENTIC_AUTOPILOT_OPUS_MAX_ROUNDS:-${VALUA_AUTOPILOT_OPUS_MAX_ROUNDS:-200}}"
export VALUA_AUTOPILOT_OPUS_MAX_ROUNDS="${VALUA_AUTOPILOT_OPUS_MAX_ROUNDS:-$AGENTIC_AUTOPILOT_OPUS_MAX_ROUNDS}"
export AGENTIC_AUTOPILOT_OPUS_ENFORCE_PREEXEC_BARRIER="${AGENTIC_AUTOPILOT_OPUS_ENFORCE_PREEXEC_BARRIER:-${VALUA_AUTOPILOT_OPUS_ENFORCE_PREEXEC_BARRIER:-1}}"
export VALUA_AUTOPILOT_OPUS_ENFORCE_PREEXEC_BARRIER="${VALUA_AUTOPILOT_OPUS_ENFORCE_PREEXEC_BARRIER:-$AGENTIC_AUTOPILOT_OPUS_ENFORCE_PREEXEC_BARRIER}"
export AGENTIC_AUTOPILOT_OPUS_WARN_REQUIRES_ACK="${AGENTIC_AUTOPILOT_OPUS_WARN_REQUIRES_ACK:-${VALUA_AUTOPILOT_OPUS_WARN_REQUIRES_ACK:-0}}"
export VALUA_AUTOPILOT_OPUS_WARN_REQUIRES_ACK="${VALUA_AUTOPILOT_OPUS_WARN_REQUIRES_ACK:-$AGENTIC_AUTOPILOT_OPUS_WARN_REQUIRES_ACK}"
export AGENTIC_AUTOPILOT_OPUS_REQUIRE_DECISION_RATIONALE="${AGENTIC_AUTOPILOT_OPUS_REQUIRE_DECISION_RATIONALE:-${VALUA_AUTOPILOT_OPUS_REQUIRE_DECISION_RATIONALE:-1}}"
export VALUA_AUTOPILOT_OPUS_REQUIRE_DECISION_RATIONALE="${VALUA_AUTOPILOT_OPUS_REQUIRE_DECISION_RATIONALE:-$AGENTIC_AUTOPILOT_OPUS_REQUIRE_DECISION_RATIONALE}"
export AGENTIC_AUTOPILOT_OPUS_POST_REVIEW="${AGENTIC_AUTOPILOT_OPUS_POST_REVIEW:-${VALUA_AUTOPILOT_OPUS_POST_REVIEW:-1}}"
export VALUA_AUTOPILOT_OPUS_POST_REVIEW="${VALUA_AUTOPILOT_OPUS_POST_REVIEW:-$AGENTIC_AUTOPILOT_OPUS_POST_REVIEW}"
export AGENTIC_AUTOPILOT_OPUS_POST_REVIEW_KINDS="${AGENTIC_AUTOPILOT_OPUS_POST_REVIEW_KINDS:-${VALUA_AUTOPILOT_OPUS_POST_REVIEW_KINDS:-USER_REQUEST,PLAN_REQUEST,ORCHESTRATOR_UPDATE,EXECUTE}}"
export VALUA_AUTOPILOT_OPUS_POST_REVIEW_KINDS="${VALUA_AUTOPILOT_OPUS_POST_REVIEW_KINDS:-$AGENTIC_AUTOPILOT_OPUS_POST_REVIEW_KINDS}"
export AGENTIC_OPUS_CLAUDE_BIN="${AGENTIC_OPUS_CLAUDE_BIN:-${VALUA_OPUS_CLAUDE_BIN:-claude}}"
export VALUA_OPUS_CLAUDE_BIN="${VALUA_OPUS_CLAUDE_BIN:-$AGENTIC_OPUS_CLAUDE_BIN}"
export AGENTIC_OPUS_MODEL="${AGENTIC_OPUS_MODEL:-${VALUA_OPUS_MODEL:-claude-opus-4-6}}"
export VALUA_OPUS_MODEL="${VALUA_OPUS_MODEL:-$AGENTIC_OPUS_MODEL}"
export AGENTIC_OPUS_PROTOCOL_MODE="${AGENTIC_OPUS_PROTOCOL_MODE:-${VALUA_OPUS_PROTOCOL_MODE:-dual_pass}}"
export VALUA_OPUS_PROTOCOL_MODE="${VALUA_OPUS_PROTOCOL_MODE:-$AGENTIC_OPUS_PROTOCOL_MODE}"
export AGENTIC_OPUS_TIMEOUT_MS="${AGENTIC_OPUS_TIMEOUT_MS:-${VALUA_OPUS_TIMEOUT_MS:-3600000}}"
export VALUA_OPUS_TIMEOUT_MS="${VALUA_OPUS_TIMEOUT_MS:-$AGENTIC_OPUS_TIMEOUT_MS}"
export AGENTIC_OPUS_MAX_RETRIES="${AGENTIC_OPUS_MAX_RETRIES:-${VALUA_OPUS_MAX_RETRIES:-0}}"
export VALUA_OPUS_MAX_RETRIES="${VALUA_OPUS_MAX_RETRIES:-$AGENTIC_OPUS_MAX_RETRIES}"
export AGENTIC_OPUS_TOOLS="${AGENTIC_OPUS_TOOLS:-${VALUA_OPUS_TOOLS:-all}}"
export VALUA_OPUS_TOOLS="${VALUA_OPUS_TOOLS:-$AGENTIC_OPUS_TOOLS}"
export AGENTIC_OPUS_CWD_MODE="${AGENTIC_OPUS_CWD_MODE:-${VALUA_OPUS_CWD_MODE:-agent_worktree}}"
export VALUA_OPUS_CWD_MODE="${VALUA_OPUS_CWD_MODE:-$AGENTIC_OPUS_CWD_MODE}"
export AGENTIC_OPUS_CACHE="${AGENTIC_OPUS_CACHE:-${VALUA_OPUS_CACHE:-1}}"
export VALUA_OPUS_CACHE="${VALUA_OPUS_CACHE:-$AGENTIC_OPUS_CACHE}"
export AGENTIC_OPUS_GLOBAL_MAX_INFLIGHT="${AGENTIC_OPUS_GLOBAL_MAX_INFLIGHT:-${VALUA_OPUS_GLOBAL_MAX_INFLIGHT:-2}}"
export VALUA_OPUS_GLOBAL_MAX_INFLIGHT="${VALUA_OPUS_GLOBAL_MAX_INFLIGHT:-$AGENTIC_OPUS_GLOBAL_MAX_INFLIGHT}"
export AGENTIC_OPUS_STREAM="${AGENTIC_OPUS_STREAM:-${VALUA_OPUS_STREAM:-1}}"
export VALUA_OPUS_STREAM="${VALUA_OPUS_STREAM:-$AGENTIC_OPUS_STREAM}"
export AGENTIC_OPUS_STUB_BIN="${AGENTIC_OPUS_STUB_BIN:-${VALUA_OPUS_STUB_BIN:-}}"
export VALUA_OPUS_STUB_BIN="${VALUA_OPUS_STUB_BIN:-$AGENTIC_OPUS_STUB_BIN}"

# Extract core names from roster via node (avoid jq dependency).
SESSION_NAME="$(node -p "require('${ROSTER_PATH}').sessionName || 'agentic-cockpit'")"
DADDY_NAME="$(node -p "require('${ROSTER_PATH}').daddyChatName || 'daddy'")"
ORCH_NAME="$(node -p "require('${ROSTER_PATH}').orchestratorName || 'daddy-orchestrator'")"
AUTOPILOT_NAME="$(node -p "require('${ROSTER_PATH}').autopilotName || 'daddy-autopilot'")"

tmux_apply_ergonomics() {
  # Ensure tmux ergonomics (mouse, border titles, etc) are enabled even when the tmux server is shared.
  # `tmux start-server` is required because `source-file` is a no-op when no server exists yet.
  tmux start-server >/dev/null 2>&1 || true
  tmux source-file "$COCKPIT_ROOT/scripts/tmux/agents.conf" 2>/dev/null || true
  tmux set -g mouse on >/dev/null 2>&1 || true
}

tmux_apply_ergonomics

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

SESSION_ENV_PASSTHROUGH=(
  AGENTIC_CODEX_BIN
  VALUA_CODEX_BIN
  AGENTIC_CODEX_ENGINE
  VALUA_CODEX_ENGINE
  AGENTIC_CODEX_APP_SERVER_PERSIST
  VALUA_CODEX_APP_SERVER_PERSIST
  AGENTIC_CODEX_APP_SERVER_RESUME_PERSISTED
  VALUA_CODEX_APP_SERVER_RESUME_PERSISTED
  AGENTIC_CODEX_WARM_START
  VALUA_CODEX_WARM_START
  AGENTIC_CODEX_HOME_MODE
  VALUA_CODEX_HOME_MODE
  AGENTIC_CODEX_NETWORK_ACCESS
  VALUA_CODEX_NETWORK_ACCESS
  AGENTIC_AUTOPILOT_CONTEXT_MODE
  VALUA_AUTOPILOT_CONTEXT_MODE
  AGENTIC_AUTOPILOT_DANGER_FULL_ACCESS
  VALUA_AUTOPILOT_DANGER_FULL_ACCESS
  AGENTIC_AUTOPILOT_SKILLOPS_GATE
  VALUA_AUTOPILOT_SKILLOPS_GATE
  AGENTIC_AUTOPILOT_SKILLOPS_GATE_KINDS
  VALUA_AUTOPILOT_SKILLOPS_GATE_KINDS
  AGENTIC_CODE_QUALITY_GATE
  VALUA_CODE_QUALITY_GATE
  AGENTIC_CODE_QUALITY_GATE_KINDS
  VALUA_CODE_QUALITY_GATE_KINDS
  AGENTIC_EXEC_PREFLIGHT_AUTOCLEAN_DIRTY
  VALUA_EXEC_PREFLIGHT_AUTOCLEAN_DIRTY
  AGENTIC_AUTOPILOT_OPUS_GATE
  VALUA_AUTOPILOT_OPUS_GATE
  AGENTIC_AUTOPILOT_OPUS_GATE_KINDS
  VALUA_AUTOPILOT_OPUS_GATE_KINDS
  AGENTIC_AUTOPILOT_OPUS_CONSULT_AGENT
  VALUA_AUTOPILOT_OPUS_CONSULT_AGENT
  AGENTIC_AUTOPILOT_OPUS_GATE_TIMEOUT_MS
  VALUA_AUTOPILOT_OPUS_GATE_TIMEOUT_MS
  AGENTIC_AUTOPILOT_OPUS_MAX_ROUNDS
  VALUA_AUTOPILOT_OPUS_MAX_ROUNDS
  AGENTIC_AUTOPILOT_OPUS_ENFORCE_PREEXEC_BARRIER
  VALUA_AUTOPILOT_OPUS_ENFORCE_PREEXEC_BARRIER
  AGENTIC_AUTOPILOT_OPUS_WARN_REQUIRES_ACK
  VALUA_AUTOPILOT_OPUS_WARN_REQUIRES_ACK
  AGENTIC_AUTOPILOT_OPUS_REQUIRE_DECISION_RATIONALE
  VALUA_AUTOPILOT_OPUS_REQUIRE_DECISION_RATIONALE
  AGENTIC_AUTOPILOT_OPUS_POST_REVIEW
  VALUA_AUTOPILOT_OPUS_POST_REVIEW
  AGENTIC_AUTOPILOT_OPUS_POST_REVIEW_KINDS
  VALUA_AUTOPILOT_OPUS_POST_REVIEW_KINDS
  AGENTIC_OPUS_CLAUDE_BIN
  VALUA_OPUS_CLAUDE_BIN
  AGENTIC_OPUS_MODEL
  VALUA_OPUS_MODEL
  AGENTIC_OPUS_PROTOCOL_MODE
  VALUA_OPUS_PROTOCOL_MODE
  AGENTIC_OPUS_TIMEOUT_MS
  VALUA_OPUS_TIMEOUT_MS
  AGENTIC_OPUS_MAX_RETRIES
  VALUA_OPUS_MAX_RETRIES
  AGENTIC_OPUS_TOOLS
  VALUA_OPUS_TOOLS
  AGENTIC_OPUS_CWD_MODE
  VALUA_OPUS_CWD_MODE
  AGENTIC_OPUS_CACHE
  VALUA_OPUS_CACHE
  AGENTIC_OPUS_GLOBAL_MAX_INFLIGHT
  VALUA_OPUS_GLOBAL_MAX_INFLIGHT
  AGENTIC_OPUS_STREAM
  VALUA_OPUS_STREAM
  AGENTIC_OPUS_STUB_BIN
  VALUA_OPUS_STUB_BIN
  AGENTIC_ORCH_AUTOPILOT_DIGEST_MODE
  VALUA_ORCH_AUTOPILOT_DIGEST_MODE
  AGENTIC_ORCH_FORWARD_TO_DADDY
  VALUA_ORCH_FORWARD_TO_DADDY
  AGENTIC_ORCH_DADDY_DIGEST_MODE
  VALUA_ORCH_DADDY_DIGEST_MODE
)

tmux_set_session_env_if_present() {
  local key="$1"
  local value="${!key-}"
  if [ -n "$value" ]; then
    tmux set-environment -t "$SESSION_NAME" "$key" "$value" 2>/dev/null || true
  else
    tmux set-environment -t "$SESSION_NAME" -u "$key" 2>/dev/null || true
  fi
}

tmux_set_session_env() {
  tmux set-environment -t "$SESSION_NAME" COCKPIT_ROOT "$COCKPIT_ROOT" 2>/dev/null || true
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

  local key
  for key in "${SESSION_ENV_PASSTHROUGH[@]}"; do
    tmux_set_session_env_if_present "$key"
  done
}

# If a tmux session already exists, refresh its environment so newly-started panes/workers inherit
# the latest cockpit settings (e.g. long exec timeout). Keep these session-scoped to avoid leaks.
tmux_set_session_env

HARD_RESET="${AGENTIC_TMUX_HARD_RESET:-${VALUA_TMUX_HARD_RESET:-0}}"
RESET_ENV_PREFIX=""
if [ "$HARD_RESET" = "1" ]; then
  RESET_ENV_PREFIX="AGENTIC_CODEX_RESET_SESSIONS=1 VALUA_CODEX_RESET_SESSIONS=1"
fi

PR_OBSERVER_AUTOSTART="${AGENTIC_PR_OBSERVER_AUTOSTART:-${VALUA_PR_OBSERVER_AUTOSTART:-1}}"
PR_OBSERVER_POLL_MS="${AGENTIC_PR_OBSERVER_POLL_MS:-${VALUA_PR_OBSERVER_POLL_MS:-60000}}"
PR_OBSERVER_MAX_PRS="${AGENTIC_PR_OBSERVER_MAX_PRS:-${VALUA_PR_OBSERVER_MAX_PRS:-30}}"
PR_OBSERVER_REPO="${AGENTIC_PR_OBSERVER_REPO:-${VALUA_PR_OBSERVER_REPO:-}}"
PR_OBSERVER_PRS="${AGENTIC_PR_OBSERVER_PRS:-${VALUA_PR_OBSERVER_PRS:-}}"
PR_OBSERVER_MIN_PR="${AGENTIC_PR_OBSERVER_MIN_PR:-${VALUA_PR_OBSERVER_MIN_PR:-}}"
PR_OBSERVER_COLD_START_MODE="${AGENTIC_PR_OBSERVER_COLD_START_MODE:-${VALUA_PR_OBSERVER_COLD_START_MODE:-baseline}}"

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
  # Resolve cockpit-root token eagerly so worker startup doesn't depend on pane env.
  cmd="${cmd//\$\{COCKPIT_ROOT\}/$COCKPIT_ROOT}"
  cmd="${cmd//\$COCKPIT_ROOT/$COCKPIT_ROOT}"
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
  if [ -f "$COCKPIT_ROOT/scripts/agentic/setup-worktrees.sh" ]; then
    (cd "$PROJECT_ROOT" && bash "$COCKPIT_ROOT/scripts/agentic/setup-worktrees.sh" --roster "$ROSTER_PATH" >/dev/null)
  fi
}

sync_policy_to_worktrees() {
  local sync_on_start="${AGENTIC_POLICY_SYNC_ON_START:-${VALUA_POLICY_SYNC_ON_START:-0}}"
  if [ "$sync_on_start" = "0" ]; then
    return 0
  fi
  if [ "${AGENTIC_WORKTREES_DISABLE:-${VALUA_AGENT_WORKTREES_DISABLE:-0}}" = "1" ]; then
    return 0
  fi

  local script="$COCKPIT_ROOT/scripts/agentic/sync-policy-to-worktrees.mjs"
  if [ ! -f "$script" ]; then
    return 0
  fi

  local verbose="${AGENTIC_POLICY_SYNC_VERBOSE:-${VALUA_POLICY_SYNC_VERBOSE:-0}}"
  local source_ref="${AGENTIC_POLICY_SYNC_SOURCE_REF:-${VALUA_POLICY_SYNC_SOURCE_REF:-}}"
  local extra_flags=()
  if [ "$verbose" = "1" ]; then
    extra_flags+=(--verbose)
  fi

  local source_ref_flag=()
  if [ -n "$source_ref" ]; then
    source_ref_flag=(--source-ref "$source_ref")
  fi

  if ! node "$script" \
      --repo-root "$PROJECT_ROOT" \
      --worktrees-dir "$AGENTIC_WORKTREES_DIR" \
      --roster "$ROSTER_PATH" \
      "${source_ref_flag[@]}" \
      "${extra_flags[@]}"; then
    echo "WARN: policy sync to worktrees failed; continuing startup." >&2
  fi
}

# Ensure per-agent worktrees exist (idempotent; no-op if disabled).
ensure_worktrees
# Keep policy/skills canonical from project root -> worktrees on every startup/restart.
sync_policy_to_worktrees

# Initialize bus directories.
(
  cd "$COCKPIT_ROOT"
  AGENTIC_BUS_DIR="$BUS_ROOT" node "$COCKPIT_ROOT/scripts/agent-bus.mjs" init --bus-root "$BUS_ROOT" --roster "$ROSTER_PATH" >/dev/null
)

start_pr_observer_window() {
  if [ "$PR_OBSERVER_AUTOSTART" = "0" ]; then
    return 0
  fi

  if tmux list-windows -t "$SESSION_NAME" -F '#{window_name}' 2>/dev/null | grep -qx 'observer'; then
    return 0
  fi

  tmux new-window -t "$SESSION_NAME" -n observer -c "$PROJECT_ROOT" 2>/dev/null || true
  tmux select-pane -t "$SESSION_NAME:observer.0" -T "PR OBSERVER"
  tmux send-keys -t "$SESSION_NAME:observer.0" \
    "cd '$COCKPIT_ROOT' && export AGENTIC_PROJECT_ROOT='$PROJECT_ROOT' && export AGENTIC_BUS_DIR='$BUS_ROOT' && export AGENTIC_ROSTER_PATH='$ROSTER_PATH' && export AGENTIC_PR_OBSERVER_REPO='$PR_OBSERVER_REPO' && export AGENTIC_PR_OBSERVER_PRS='$PR_OBSERVER_PRS' && export AGENTIC_PR_OBSERVER_MIN_PR='$PR_OBSERVER_MIN_PR' && export AGENTIC_PR_OBSERVER_COLD_START_MODE='$PR_OBSERVER_COLD_START_MODE' && export VALUA_REPO_ROOT='$PROJECT_ROOT' && export VALUA_AGENT_BUS_DIR='$BUS_ROOT' && export VALUA_AGENT_ROSTER_PATH='$ROSTER_PATH' && export VALUA_PR_OBSERVER_REPO='$PR_OBSERVER_REPO' && export VALUA_PR_OBSERVER_PRS='$PR_OBSERVER_PRS' && export VALUA_PR_OBSERVER_MIN_PR='$PR_OBSERVER_MIN_PR' && export VALUA_PR_OBSERVER_COLD_START_MODE='$PR_OBSERVER_COLD_START_MODE' && node '$COCKPIT_ROOT/scripts/observers/watch-pr.mjs' --project-root '$PROJECT_ROOT' --agent '$ORCH_NAME' --poll-ms '$PR_OBSERVER_POLL_MS' --max-prs '$PR_OBSERVER_MAX_PRS'" C-m
}

if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  echo "tmux session already exists: $SESSION_NAME"
  tmux_apply_ergonomics
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
  start_pr_observer_window
else
  tmux new-session -d -s "$SESSION_NAME" -n cockpit -c "$PROJECT_ROOT"
  tmux_apply_ergonomics
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
  start_pr_observer_window

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
        "cd '$workdir' && export AGENTIC_PROJECT_ROOT='$PROJECT_ROOT' && export AGENTIC_BUS_DIR='$BUS_ROOT' && export AGENTIC_ROSTER_PATH='$ROSTER_PATH' && export VALUA_REPO_ROOT='$PROJECT_ROOT' && export VALUA_AGENT_BUS_DIR='$BUS_ROOT' && export VALUA_AGENT_ROSTER_PATH='$ROSTER_PATH' && ${RESET_ENV_PREFIX} $cmd" C-m
    else
      if tmux split-window -t "$SESSION_NAME:agents" -c "$workdir" >/dev/null 2>&1; then
        pane_index="$(tmux display-message -p -t "$SESSION_NAME:agents" '#{pane_index}')"
        tmux select-pane -t "$SESSION_NAME:agents.$pane_index" -T "$name"
        tmux send-keys -t "$SESSION_NAME:agents.$pane_index" \
          "cd '$workdir' && export AGENTIC_PROJECT_ROOT='$PROJECT_ROOT' && export AGENTIC_BUS_DIR='$BUS_ROOT' && export AGENTIC_ROSTER_PATH='$ROSTER_PATH' && export VALUA_REPO_ROOT='$PROJECT_ROOT' && export VALUA_AGENT_BUS_DIR='$BUS_ROOT' && export VALUA_AGENT_ROSTER_PATH='$ROSTER_PATH' && ${RESET_ENV_PREFIX} $cmd" C-m
      else
        # Fallback for very small terminals: start additional workers in their own windows.
        tmux new-window -t "$SESSION_NAME" -n "$name" -c "$workdir"
        tmux select-pane -t "$SESSION_NAME:$name.0" -T "$name"
        tmux send-keys -t "$SESSION_NAME:$name.0" \
          "cd '$workdir' && export AGENTIC_PROJECT_ROOT='$PROJECT_ROOT' && export AGENTIC_BUS_DIR='$BUS_ROOT' && export AGENTIC_ROSTER_PATH='$ROSTER_PATH' && export VALUA_REPO_ROOT='$PROJECT_ROOT' && export VALUA_AGENT_BUS_DIR='$BUS_ROOT' && export VALUA_AGENT_ROSTER_PATH='$ROSTER_PATH' && ${RESET_ENV_PREFIX} $cmd" C-m
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
