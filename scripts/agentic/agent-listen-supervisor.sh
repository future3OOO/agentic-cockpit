#!/usr/bin/env bash
set -u -o pipefail

# Supervisor for `scripts/agent-listen.mjs`.
#
# Keeps the "DADDY INBOX" pane alive even if the listener exits unexpectedly.
# (We intentionally do not auto-restart Codex workers here.)

trap 'exit 0' INT TERM

REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$REPO_ROOT"

while true; do
  node scripts/agent-listen.mjs "$@" || true
  sleep 0.25
done

