#!/usr/bin/env bash
set -euo pipefail

# Codex interactive supervisor for tmux panes.
#
# Goal: if Codex disconnects (e.g., OpenAI RPM limit / stream disconnect), automatically
# restart so the human doesn't have to relaunch the cockpit.
#
# Behavior:
# - Start a fresh interactive Codex session with a deterministic boot prompt (default: `$cockpit-daddy-chat-io`).
# - On non-zero exit: wait, then start a fresh session again (no `resume --last`).
# - On zero exit: assume the user intentionally quit; do not restart unless forced.
#
# Tunables:
# - AGENTIC_CODEX_CHAT_RESTART_DELAY_MS (default: 10000)
# - AGENTIC_CODEX_CHAT_ALWAYS_RESTART=1 (restart even after exit 0)
# - AGENTIC_CODEX_CHAT_BOOT_PROMPT (default: $cockpit-daddy-chat-io)
#
# Valua compatibility:
# - VALUA_CODEX_CHAT_RESTART_DELAY_MS
# - VALUA_CODEX_CHAT_ALWAYS_RESTART
# - VALUA_CODEX_CHAT_BOOT_PROMPT
#
# This script is intentionally minimal and does not paste anything into the chat input buffer; it uses
# Codex's initial [PROMPT] argument instead.

delay_ms="${AGENTIC_CODEX_CHAT_RESTART_DELAY_MS:-${VALUA_CODEX_CHAT_RESTART_DELAY_MS:-10000}}"
if ! [[ "$delay_ms" =~ ^[0-9]+$ ]]; then delay_ms="10000"; fi
delay_s="$(awk "BEGIN { printf \"%.3f\", ${delay_ms}/1000 }")"

always_restart="${AGENTIC_CODEX_CHAT_ALWAYS_RESTART:-${VALUA_CODEX_CHAT_ALWAYS_RESTART:-0}}"
boot_prompt="${AGENTIC_CODEX_CHAT_BOOT_PROMPT:-${VALUA_CODEX_CHAT_BOOT_PROMPT:-\$cockpit-daddy-chat-io}}"
path_guard="${AGENTIC_CODEX_CHAT_PATH_GUARD:-${VALUA_CODEX_CHAT_PATH_GUARD:-1}}"

bus_root="${AGENTIC_BUS_DIR:-${VALUA_AGENT_BUS_DIR:-$HOME/.agentic-cockpit/bus}}"
network_access="${AGENTIC_CODEX_NETWORK_ACCESS:-${VALUA_CODEX_NETWORK_ACCESS:-1}}"
if [[ "$network_access" == "0" ]]; then
  network_access="false"
else
  network_access="true"
fi

git_dir=""
git_common_dir=""
if git_dir_raw="$(git rev-parse --git-dir 2>/dev/null)"; then
  git_dir="$(cd "$git_dir_raw" 2>/dev/null && pwd -P || true)"
fi
if git_common_raw="$(git rev-parse --git-common-dir 2>/dev/null)"; then
  git_common_dir="$(cd "$git_common_raw" 2>/dev/null && pwd -P || true)"
fi

base_args=(
  --ask-for-approval never
  --sandbox workspace-write
  --config "sandbox_workspace_write.network_access=${network_access}"
  --no-alt-screen
)

# DADDY CHAT must be able to write AgentBus packets (bus_root) and support git worktrees.
base_args+=(--add-dir "$bus_root")
if [[ -n "$git_dir" ]]; then
  base_args+=(--add-dir "$git_dir")
fi
if [[ -n "$git_common_dir" && "$git_common_dir" != "$git_dir" ]]; then
  base_args+=(--add-dir "$git_common_dir")
fi

attempt=0
while true; do
  exit_code=0
  prompt="$boot_prompt"
  if [[ "$path_guard" == "1" ]]; then
    prompt="${prompt}"$'\n\n'"Pathing rule: when using patch/edit tools, use workspace-relative paths only (for example .codex/CONTINUITY.md). Do not use absolute /home/... paths."
    prompt="${prompt}"$'\n'"For continuity-ledger updates, do not use apply_patch. Use shell/script-based edits with workspace-relative paths."
  fi
  codex "${base_args[@]}" "$prompt" || exit_code=$?

  if [[ "$exit_code" -eq 0 && "$always_restart" != "1" ]]; then
    exit 0
  fi

  attempt=$((attempt + 1))
  echo "codex exited (code=$exit_code); restarting in ${delay_s}s…" >&2
  sleep "$delay_s"
done
