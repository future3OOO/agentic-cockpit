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

# Safety: Valua adapter should use Valua's project-local roster by default.
# Do not silently fall back to the cockpit bundled roster unless explicitly allowed.
if [ ! -f "$AGENTIC_ROSTER_PATH" ]; then
  if [ "${VALUA_ALLOW_ROSTER_FALLBACK:-0}" = "1" ]; then
    echo "WARN: missing Valua roster at $AGENTIC_ROSTER_PATH; fallback is allowed by VALUA_ALLOW_ROSTER_FALLBACK=1" >&2
  else
    echo "ERROR: missing Valua roster at $AGENTIC_ROSTER_PATH" >&2
    echo "Refusing to start adapter with bundled fallback to avoid cross-project drift." >&2
    echo "If this is a brand-new checkout, scaffold once: node scripts/init-project.mjs --project \"$PROJECT_ROOT\"" >&2
    echo "Or explicitly allow fallback: VALUA_ALLOW_ROSTER_FALLBACK=1 bash adapters/valua/run.sh \"$PROJECT_ROOT\"" >&2
    exit 1
  fi
fi

# Keep Valua’s existing bus/worktree locations by default (operator can override).
export AGENTIC_BUS_DIR="${AGENTIC_BUS_DIR:-$HOME/.codex/valua/agent-bus}"
export AGENTIC_WORKTREES_DIR="${AGENTIC_WORKTREES_DIR:-$HOME/.codex/valua/worktrees/Valua}"

# Valua defaults: keep workers warm and cheap.
export AGENTIC_CODEX_ENGINE="${AGENTIC_CODEX_ENGINE:-app-server}"
export AGENTIC_CODEX_APP_SERVER_PERSIST="${AGENTIC_CODEX_APP_SERVER_PERSIST:-1}"
export AGENTIC_CODEX_WARM_START="${AGENTIC_CODEX_WARM_START:-1}"
export AGENTIC_AUTOPILOT_CONTEXT_MODE="${AGENTIC_AUTOPILOT_CONTEXT_MODE:-auto}"
export AGENTIC_AUTOPILOT_SKILLOPS_GATE="${AGENTIC_AUTOPILOT_SKILLOPS_GATE:-1}"
export AGENTIC_AUTOPILOT_SKILLOPS_GATE_KINDS="${AGENTIC_AUTOPILOT_SKILLOPS_GATE_KINDS:-USER_REQUEST}"
export AGENTIC_AUTOPILOT_GUARD_ALLOW_PROTECTED_PUSH="${AGENTIC_AUTOPILOT_GUARD_ALLOW_PROTECTED_PUSH:-1}"
export AGENTIC_AUTOPILOT_GUARD_ALLOW_PR_MERGE="${AGENTIC_AUTOPILOT_GUARD_ALLOW_PR_MERGE:-1}"
export AGENTIC_AUTOPILOT_GUARD_ALLOW_FORCE_PUSH="${AGENTIC_AUTOPILOT_GUARD_ALLOW_FORCE_PUSH:-1}"
export AGENTIC_CODE_QUALITY_GATE="${AGENTIC_CODE_QUALITY_GATE:-1}"
export AGENTIC_CODE_QUALITY_GATE_KINDS="${AGENTIC_CODE_QUALITY_GATE_KINDS:-USER_REQUEST,ORCHESTRATOR_UPDATE,EXECUTE,PLAN_REQUEST}"
export AGENTIC_EXEC_PREFLIGHT_AUTOCLEAN_DIRTY="${AGENTIC_EXEC_PREFLIGHT_AUTOCLEAN_DIRTY:-1}"
export AGENTIC_POLICY_SYNC_ON_START="${AGENTIC_POLICY_SYNC_ON_START:-0}"
export VALUA_AUTOPILOT_SKILLOPS_GATE="${VALUA_AUTOPILOT_SKILLOPS_GATE:-$AGENTIC_AUTOPILOT_SKILLOPS_GATE}"
export VALUA_AUTOPILOT_SKILLOPS_GATE_KINDS="${VALUA_AUTOPILOT_SKILLOPS_GATE_KINDS:-$AGENTIC_AUTOPILOT_SKILLOPS_GATE_KINDS}"
export VALUA_AUTOPILOT_GUARD_ALLOW_PROTECTED_PUSH="${VALUA_AUTOPILOT_GUARD_ALLOW_PROTECTED_PUSH:-$AGENTIC_AUTOPILOT_GUARD_ALLOW_PROTECTED_PUSH}"
export VALUA_AUTOPILOT_GUARD_ALLOW_PR_MERGE="${VALUA_AUTOPILOT_GUARD_ALLOW_PR_MERGE:-$AGENTIC_AUTOPILOT_GUARD_ALLOW_PR_MERGE}"
export VALUA_AUTOPILOT_GUARD_ALLOW_FORCE_PUSH="${VALUA_AUTOPILOT_GUARD_ALLOW_FORCE_PUSH:-$AGENTIC_AUTOPILOT_GUARD_ALLOW_FORCE_PUSH}"
export VALUA_CODE_QUALITY_GATE="${VALUA_CODE_QUALITY_GATE:-$AGENTIC_CODE_QUALITY_GATE}"
export VALUA_CODE_QUALITY_GATE_KINDS="${VALUA_CODE_QUALITY_GATE_KINDS:-$AGENTIC_CODE_QUALITY_GATE_KINDS}"
export VALUA_EXEC_PREFLIGHT_AUTOCLEAN_DIRTY="${VALUA_EXEC_PREFLIGHT_AUTOCLEAN_DIRTY:-$AGENTIC_EXEC_PREFLIGHT_AUTOCLEAN_DIRTY}"
export VALUA_POLICY_SYNC_ON_START="${VALUA_POLICY_SYNC_ON_START:-$AGENTIC_POLICY_SYNC_ON_START}"

# Orchestrator digests: compact to autopilot by default (human digest optional/compact).
export AGENTIC_ORCH_AUTOPILOT_DIGEST_MODE="${AGENTIC_ORCH_AUTOPILOT_DIGEST_MODE:-compact}"
export AGENTIC_ORCH_FORWARD_TO_DADDY="${AGENTIC_ORCH_FORWARD_TO_DADDY:-0}"
export AGENTIC_ORCH_DADDY_DIGEST_MODE="${AGENTIC_ORCH_DADDY_DIGEST_MODE:-compact}"

# Reduce Codex rollout/index reconciliation noise by isolating Codex state per agent.
export AGENTIC_CODEX_HOME_MODE="${AGENTIC_CODEX_HOME_MODE:-agent}"

# In adapter mode, Codex runs with cwd=$PROJECT_ROOT, so skills should come from the Valua repo
# (e.g. `.codex/skills/valua-daddy-chat-io`). Default the interactive chat boot prompt accordingly.
export VALUA_CODEX_CHAT_BOOT_PROMPT="${VALUA_CODEX_CHAT_BOOT_PROMPT:-\$valua-daddy-chat-io}"

# Valua-specific observer policy: only monitor active PR range.
# This prevents older legacy PR threads from re-entering the automation loop.
export AGENTIC_PR_OBSERVER_MIN_PR="${AGENTIC_PR_OBSERVER_MIN_PR:-82}"

exec bash "$COCKPIT_ROOT/scripts/tmux/cockpit.sh" up
