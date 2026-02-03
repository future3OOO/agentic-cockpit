#!/usr/bin/env bash
set -euo pipefail

# End-to-end smoke for the AgentBus + tmux cockpit + Codex worker mode.
#
# What it proves:
# - A task packet is sent to the bus
# - The Codex worker consumes it (no manual prompt)
# - The worker closes the task (processed + receipt)
# - The orchestrator receives a Task complete packet
# - The orchestrator forwards a digest to Daddy inbox
#
# Safe by default:
# - Uses an isolated tmux session (does not touch "valua-agents")
# - Uses an isolated bus root under $HOME (not /tmp)
# - Keeps the smoke tmux session by default when run interactively (so it never
#   destroys an in-progress cockpit). Set `VALUA_SMOKE_KEEP_SESSION=0` to clean
#   up automatically.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux not found. Install first: sudo apt-get install -y tmux" >&2
  exit 1
fi

if ! command -v codex >/dev/null 2>&1; then
  echo "codex CLI not found on PATH." >&2
  exit 1
fi

if ! codex login status >/dev/null 2>&1; then
  echo "codex is not logged in. Run: codex login" >&2
  exit 1
fi

ts="$(date -u +%Y%m%dT%H%M%SZ)"
SESSION_DEFAULT="valua-agents-smoke-$ts"
SESSION="${VALUA_TMUX_SESSION:-$SESSION_DEFAULT}"

# Refuse to run the smoke inside the real cockpit session. This is the "never
# destroy user state" safety belt.
if [ "$SESSION" = "valua-agents" ] && [ "${VALUA_SMOKE_ALLOW_MAIN_SESSION:-0}" != "1" ]; then
  echo "Refusing to run smoke in SESSION=valua-agents (this would restart/kill your real cockpit)." >&2
  echo "Use the default (isolated) session name, or set VALUA_TMUX_SESSION=valua-agents-smoke-<ts>." >&2
  echo "Override (not recommended): VALUA_SMOKE_ALLOW_MAIN_SESSION=1" >&2
  exit 1
fi

# Keep the smoke session by default (never destroy user state unless explicitly
# requested). Set `VALUA_SMOKE_KEEP_SESSION=0` to auto-clean up.
KEEP_SESSION="${VALUA_SMOKE_KEEP_SESSION:-1}"
if [ "$KEEP_SESSION" != "0" ] && [ "$KEEP_SESSION" != "1" ]; then
  KEEP_SESSION="1"
fi
# Smoke uses an isolated bus root by default so it doesn't interfere with the
# "real" bus under $HOME/.codex/valua/agent-bus.
#
# Some environments (e.g. sandboxed runners) may not allow writes under $HOME.
# In that case we fall back to `/tmp` (ephemeral but usable for a smoke run).
BUS_ROOT_DEFAULT="$HOME/.codex/valua/agent-bus-smoke-$ts"
BUS_ROOT_FALLBACK="/tmp/valua-agent-bus-smoke-$ts"
BUS_ROOT="${VALUA_SMOKE_BUS_ROOT:-$BUS_ROOT_DEFAULT}"
USED_FALLBACK_BUS_ROOT="0"
if ! mkdir -p "$BUS_ROOT" >/dev/null 2>&1; then
  BUS_ROOT="$BUS_ROOT_FALLBACK"
  USED_FALLBACK_BUS_ROOT="1"
  mkdir -p "$BUS_ROOT" >/dev/null
  echo "WARNING: Could not create bus root under \$HOME; using fallback: $BUS_ROOT" >&2
fi

SMOKE_OUT_DIR_DEFAULT="$REPO_ROOT/.codex/agent-bus/smoke"
SMOKE_OUT_DIR_FALLBACK="/tmp/valua-agentic-smoke"
SMOKE_OUT_DIR="$SMOKE_OUT_DIR_DEFAULT"
if [ "$USED_FALLBACK_BUS_ROOT" = "1" ]; then
  SMOKE_OUT_DIR="$SMOKE_OUT_DIR_FALLBACK"
  mkdir -p "$SMOKE_OUT_DIR" >/dev/null
fi

TASK_ID="${TASK_ID:-${ts}__codex-worker-smoke}"
TASK_FRONTEND="${TASK_ID}__frontend"
TASK_BACKEND="${TASK_ID}__backend"
TASK_FILE_FRONTEND="/tmp/${TASK_FRONTEND}.md"
TASK_FILE_BACKEND="/tmp/${TASK_BACKEND}.md"
ROSTER_BASE="$REPO_ROOT/docs/agentic/agent-bus/ROSTER.json"
ROSTER_SMOKE="/tmp/ROSTER.smoke.${TASK_ID}.json"

cleanup() {
  if [ "$KEEP_SESSION" = "1" ]; then
    echo "NOTE: leaving smoke tmux session running (VALUA_SMOKE_KEEP_SESSION=1):" >&2
    echo "  session: $SESSION" >&2
    echo "  bus:     $BUS_ROOT" >&2
    echo "To stop it: tmux kill-session -t \"$SESSION\"" >&2
    return 0
  fi
  tmux kill-session -t "$SESSION" >/dev/null 2>&1 || true
  rm -f "$ROSTER_SMOKE" "$TASK_FILE_FRONTEND" "$TASK_FILE_BACKEND" >/dev/null 2>&1 || true
  rm -f "$SMOKE_OUT_DIR/${TASK_FRONTEND}_pong.txt" "$SMOKE_OUT_DIR/${TASK_BACKEND}_pong.txt" >/dev/null 2>&1 || true
}
trap cleanup EXIT

cd "$REPO_ROOT"

export VALUA_AGENT_BUS_DIR="$BUS_ROOT"
export VALUA_AGENT_ROSTER_PATH="$ROSTER_SMOKE"
export VALUA_AGENT_WORKTREES_DISABLE="1"
export VALUA_TMUX_AUTOSTART_ADVISORS="0"
export VALUA_TMUX_NO_ATTACH="1"
# Keep smoke fast and deterministic (no "xhigh" wandering).
export VALUA_CODEX_EXEC_CONFIG="${VALUA_CODEX_EXEC_CONFIG:-model_reasoning_effort=\"low\"}"

echo "Smoke session: $SESSION"
echo "Bus root:      $BUS_ROOT"
echo "Task id:       $TASK_ID (multi-agent)"
echo

# Create a roster overlay:
# - Set the smoke tmux sessionName.
# - Force worker workdirs to $REPO_ROOT so the smoke never creates git worktrees/branches.
node -e 'const fs=require("fs"); const [basePath,outPath,sessionName]=process.argv.slice(1); const roster=JSON.parse(fs.readFileSync(basePath,"utf8")); roster.sessionName=sessionName; if(Array.isArray(roster.agents)){ for(const agent of roster.agents){ if(!agent||typeof agent!=="object") continue; if(agent.kind==="codex-worker"){ agent.workdir="$REPO_ROOT"; delete agent.branch; } } } fs.writeFileSync(outPath, JSON.stringify(roster,null,2)+"\n","utf8");' "$ROSTER_BASE" "$ROSTER_SMOKE" "$SESSION"

ORCH_NAME="$(node -e "const fs=require('fs');const r=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));process.stdout.write(String(r.orchestratorName||'daddy-orchestrator'));" "$ROSTER_SMOKE")"
DADDY_NAME="$(node -e "const fs=require('fs');const r=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));process.stdout.write(String(r.daddyChatName||'daddy'));" "$ROSTER_SMOKE")"

# Start a fresh smoke cockpit without touching any existing "real" cockpit.
SESSION="$SESSION" bash scripts/tmux/cockpit.sh up >/dev/null

cat >"$TASK_FILE_FRONTEND" <<EOF
---
{"id":"$TASK_FRONTEND","to":["frontend"],"from":"daddy","priority":"P3","signals":{"smoke":true},"title":"Smoke: frontend worker creates pong file"}
---
# Task: Smoke (Codex worker)

Create a file at \`${SMOKE_OUT_DIR}/${TASK_FRONTEND}_pong.txt\` with contents \`pong\` and a trailing newline.

Do not commit anything.
EOF

cat >"$TASK_FILE_BACKEND" <<EOF
---
{"id":"$TASK_BACKEND","to":["backend"],"from":"daddy","priority":"P3","signals":{"smoke":true},"title":"Smoke: backend worker creates pong file"}
---
# Task: Smoke (Codex worker)

Create a file at \`${SMOKE_OUT_DIR}/${TASK_BACKEND}_pong.txt\` with contents \`pong\` and a trailing newline.

Do not commit anything.
EOF

node scripts/agent-bus.mjs send "$TASK_FILE_FRONTEND" >/dev/null
node scripts/agent-bus.mjs send "$TASK_FILE_BACKEND" >/dev/null

echo "Queued task. Waiting for completion…"

processed_frontend_glob="$BUS_ROOT/inbox/frontend/processed/${TASK_FRONTEND}"'*.md'
receipt_frontend="$BUS_ROOT/receipts/frontend/${TASK_FRONTEND}.json"
smoke_out_frontend="$SMOKE_OUT_DIR/${TASK_FRONTEND}_pong.txt"

processed_backend_glob="$BUS_ROOT/inbox/backend/processed/${TASK_BACKEND}"'*.md'
receipt_backend="$BUS_ROOT/receipts/backend/${TASK_BACKEND}.json"
smoke_out_backend="$SMOKE_OUT_DIR/${TASK_BACKEND}_pong.txt"

has_glob() {
  compgen -G "$1" >/dev/null 2>&1
}

has_orchestrator_receipt_for_completed_task() {
  node -e "
    const fs=require('fs');const path=require('path');
    const [busRoot,orchName,completedTaskId]=process.argv.slice(1);
    const dir=path.join(busRoot,'receipts',orchName);
    let ok=false;
    try{
      for(const f of fs.readdirSync(dir)){
        if(!f.endsWith('.json')) continue;
        const r=JSON.parse(fs.readFileSync(path.join(dir,f),'utf8'));
        const sig=r?.task?.signals;
        if(sig?.kind==='TASK_COMPLETE' && sig?.completedTaskId===completedTaskId){ ok=true; break; }
      }
    }catch{}
    process.exit(ok?0:1);
  " "$BUS_ROOT" "$ORCH_NAME" "$1"
}

has_daddy_digest_for_completed_task() {
  node -e "
    const fs=require('fs');const path=require('path');
    const [busRoot,daddyName,completedTaskId]=process.argv.slice(1);
    const dirs=[path.join(busRoot,'inbox',daddyName,'new'),path.join(busRoot,'inbox',daddyName,'seen')];
    function parseMeta(raw){
      const m=/^---\\s*\\n([\\s\\S]*?)\\n---/m.exec(raw);
      if(!m) return null;
      try{ return JSON.parse(m[1]); }catch{ return null; }
    }
    let ok=false;
    for(const dir of dirs){
      try{
        for(const f of fs.readdirSync(dir)){
          if(!f.endsWith('.md')) continue;
          const raw=fs.readFileSync(path.join(dir,f),'utf8');
          const meta=parseMeta(raw);
          if(meta?.signals?.kind!=='ORCHESTRATOR_UPDATE') continue;
          if(meta?.references?.sourceTaskId===completedTaskId){ ok=true; break; }
        }
      }catch{}
      if(ok) break;
    }
    process.exit(ok?0:1);
  " "$BUS_ROOT" "$DADDY_NAME" "$1"
}

timeout_secs="${VALUA_SMOKE_TIMEOUT_SECS:-900}"
deadline="$((SECONDS + timeout_secs))"
while (( SECONDS < deadline )); do
  if has_glob "$processed_frontend_glob" \
    && [[ -f "$receipt_frontend" && -f "$smoke_out_frontend" ]] \
    && has_orchestrator_receipt_for_completed_task "$TASK_FRONTEND" \
    && has_daddy_digest_for_completed_task "$TASK_FRONTEND" \
    && has_glob "$processed_backend_glob" \
    && [[ -f "$receipt_backend" && -f "$smoke_out_backend" ]] \
    && has_orchestrator_receipt_for_completed_task "$TASK_BACKEND" \
    && has_daddy_digest_for_completed_task "$TASK_BACKEND"; then
    break
  fi
  sleep 2
done

if ! has_glob "$processed_frontend_glob"; then
  echo "FAIL: processed task not found: $processed_frontend_glob" >&2
  exit 1
fi
if [[ ! -f "$receipt_frontend" ]]; then
  echo "FAIL: receipt not found: $receipt_frontend" >&2
  exit 1
fi
if [[ ! -f "$smoke_out_frontend" ]]; then
  echo "FAIL: smoke output not found: $smoke_out_frontend" >&2
  exit 1
fi
if ! has_orchestrator_receipt_for_completed_task "$TASK_FRONTEND"; then
  echo "FAIL: orchestrator did not process completion packet for: $TASK_FRONTEND" >&2
  exit 1
fi
if ! has_daddy_digest_for_completed_task "$TASK_FRONTEND"; then
  echo "FAIL: orchestrator did not forward digest to daddy for: $TASK_FRONTEND" >&2
  exit 1
fi

if ! has_glob "$processed_backend_glob"; then
  echo "FAIL: processed task not found: $processed_backend_glob" >&2
  exit 1
fi
if [[ ! -f "$receipt_backend" ]]; then
  echo "FAIL: receipt not found: $receipt_backend" >&2
  exit 1
fi
if [[ ! -f "$smoke_out_backend" ]]; then
  echo "FAIL: smoke output not found: $smoke_out_backend" >&2
  exit 1
fi
if ! has_orchestrator_receipt_for_completed_task "$TASK_BACKEND"; then
  echo "FAIL: orchestrator did not process completion packet for: $TASK_BACKEND" >&2
  exit 1
fi
if ! has_daddy_digest_for_completed_task "$TASK_BACKEND"; then
  echo "FAIL: orchestrator did not forward digest to daddy for: $TASK_BACKEND" >&2
  exit 1
fi

for receipt in "$receipt_frontend" "$receipt_backend"; do
  outcome="$(node -e "const fs=require('fs');const r=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));process.stdout.write(String(r.outcome||''));" "$receipt")"
  note="$(node -e "const fs=require('fs');const r=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));process.stdout.write(String(r.note||''));" "$receipt")"
  commitSha="$(node -e "const fs=require('fs');const r=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));process.stdout.write(String(r.commitSha||''));" "$receipt")"

  if [[ "$outcome" != "done" ]]; then
    echo "FAIL: worker outcome is not done: outcome=$outcome note=$note receipt=$receipt" >&2
    exit 1
  fi
  if [[ -n "$commitSha" ]]; then
    echo "FAIL: smoke task committed unexpectedly: commitSha=$commitSha receipt=$receipt" >&2
    exit 1
  fi
done

printf 'pong\n' | diff -q - "$smoke_out_frontend" >/dev/null || { echo "FAIL: unexpected pong contents: $smoke_out_frontend" >&2; exit 1; }
printf 'pong\n' | diff -q - "$smoke_out_backend" >/dev/null || { echo "FAIL: unexpected pong contents: $smoke_out_backend" >&2; exit 1; }

echo "PASS: task processed + receipt + orchestrator processed completion + digest forwarded"
echo

echo "** Bus counts **"
node scripts/agent-bus.mjs status
echo

echo "** Recent **"
node scripts/agent-bus.mjs recent --limit 12
echo

echo "** tmux excerpts (last 30 lines) **"
for who in frontend backend; do
  pane_id="$(tmux list-panes -t "$SESSION:agents" -F "#{pane_id}\t#{pane_title}" 2>/dev/null | awk -F $'\\t' -v who="$who" '$2==who{print $1; exit}')"
  if [[ -z "$pane_id" ]]; then
    echo "--- $who: pane not found (unexpected) ---"
    continue
  fi
  echo "--- agents/$who ---"
  tmux capture-pane -pt "$pane_id" -S -30 2>/dev/null || true
  echo
done

for who in "DADDY INBOX" "ORCHESTRATOR" "BUS STATUS"; do
  pane_id="$(tmux list-panes -t "$SESSION:cockpit" -F "#{pane_id}\t#{pane_title}" 2>/dev/null | awk -F $'\\t' -v who="$who" '$2==who{print $1; exit}')"
  if [[ -z "$pane_id" ]]; then
    echo "--- cockpit/$who: pane not found (unexpected) ---"
    continue
  fi
  echo "--- cockpit/$who ---"
  tmux capture-pane -pt "$pane_id" -S -30 2>/dev/null || true
  echo
done

echo "Done."
