#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  bash adapters/valua/restart-master.sh /path/to/Valua [runtime-worktree]

Defaults:
  runtime-worktree: /tmp/valua-runtime-master
  reset state: off (set RESET_STATE=1 to rotate codex-home for all codex agents before start)
  repin agent worktrees: on (set REPIN_WORKTREES=0 to skip)

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
REPIN_WORKTREES="${REPIN_WORKTREES:-1}"
SKILLOPS_KINDS="${AGENTIC_AUTOPILOT_SKILLOPS_GATE_KINDS:-USER_REQUEST,ORCHESTRATOR_UPDATE}"
WORKTREES_DIR="${AGENTIC_WORKTREES_DIR:-${VALUA_AGENT_WORKTREES_DIR:-$HOME/.codex/valua/worktrees/Valua}}"

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

if [ "${VALUA_AUTOPILOT_DEDICATED_WORKTREE:-1}" = "1" ]; then
  node - "$ROSTER_PATH" <<'NODE'
const fs = require('fs');
const rosterPath = process.argv[2];
const raw = fs.readFileSync(rosterPath, 'utf8');
let roster = null;
try {
  roster = JSON.parse(raw);
} catch (error) {
  process.stderr.write(
    `ERROR: invalid runtime roster JSON: ${rosterPath} (${error && error.message ? error.message : String(error)})\n`
  );
  process.exit(1);
}
const agents = Array.isArray(roster.agents) ? roster.agents : [];
const autopilot = agents.find(
  (agent) => agent && String(agent.name || '').trim() === 'daddy-autopilot'
);
if (!autopilot || String(autopilot.kind || '').trim() !== 'codex-worker') {
  process.stderr.write("ERROR: roster validation failed: missing codex-worker 'daddy-autopilot'\n");
  process.exit(1);
}
const desiredBranch = 'agent/daddy-autopilot';
const desiredWorkdir = '$VALUA_AGENT_WORKTREES_DIR/daddy-autopilot';
const actualBranch = String(autopilot.branch || '').trim();
const actualWorkdir = String(autopilot.workdir || '').trim();
if (actualBranch !== desiredBranch || actualWorkdir !== desiredWorkdir) {
  process.stderr.write(
    [
      'ERROR: roster validation failed for daddy-autopilot dedicated worktree wiring.',
      `expected branch:  ${desiredBranch}`,
      `actual branch:    ${actualBranch || '<empty>'}`,
      `expected workdir: ${desiredWorkdir}`,
      `actual workdir:   ${actualWorkdir || '<empty>'}`,
      'Fix docs/agentic/agent-bus/ROSTER.json in Valua source, or set VALUA_AUTOPILOT_DEDICATED_WORKTREE=0 for debug bypass.'
    ].join('\n') + '\n'
  );
  process.exit(1);
}
NODE
fi

if [ "$REPIN_WORKTREES" = "1" ]; then
  AGENTIC_WORKTREES_DIR="$WORKTREES_DIR" \
  VALUA_AGENT_WORKTREES_DIR="$WORKTREES_DIR" \
  AGENTIC_ROSTER_PATH="$ROSTER_PATH" \
  VALUA_AGENT_ROSTER_PATH="$ROSTER_PATH" \
  REPO_ROOT="$VALUA_ROOT" \
  bash "$COCKPIT_ROOT/scripts/agentic/setup-worktrees.sh" --roster "$ROSTER_PATH" --base origin/master >/dev/null

  node -e "
const fs=require('fs');
const path=require('path');
const roster=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
const root=process.argv[2];
const wt=process.argv[3];
const agents=Array.isArray(roster.agents)?roster.agents:[];
for (const a of agents){
  if(!a || (a.kind!=='codex-worker' && a.kind!=='codex-chat')) continue;
  const name=String(a.name||'').trim(); if(!name) continue;
  const branch=String(a.branch||('agent/'+name)).trim();
  let workdir=String(a.workdir||'').trim();
  if(!workdir || workdir==='\$REPO_ROOT' || workdir==='\$AGENTIC_PROJECT_ROOT' || workdir==='\$VALUA_REPO_ROOT'){
    workdir='\$AGENTIC_WORKTREES_DIR/'+name;
  }
  workdir=workdir
    .replaceAll('\$REPO_ROOT', root)
    .replaceAll('\$AGENTIC_PROJECT_ROOT', root)
    .replaceAll('\$VALUA_REPO_ROOT', root)
    .replaceAll('\$AGENTIC_WORKTREES_DIR', wt)
    .replaceAll('\$VALUA_AGENT_WORKTREES_DIR', wt)
    .replaceAll('\$HOME', process.env.HOME||'');
  process.stdout.write(name+'\\t'+branch+'\\t'+path.resolve(workdir)+'\\n');
}
" "$ROSTER_PATH" "$VALUA_ROOT" "$WORKTREES_DIR" | while IFS=$'\t' read -r agent_name branch workdir; do
    [ -n "${agent_name:-}" ] || continue
    if [ "$workdir" = "$VALUA_ROOT" ] || [ "$workdir" = "$RUNTIME_ROOT" ]; then
      continue
    fi
    if [ ! -e "$workdir/.git" ]; then
      echo "WARN: repin skipped $agent_name (not a git worktree): $workdir" >&2
      continue
    fi
    if ! git -C "$workdir" fetch origin master >/dev/null 2>&1; then
      echo "WARN: repin fetch failed for $agent_name ($workdir)" >&2
      continue
    fi
    if ! git -C "$workdir" reset --hard >/dev/null 2>&1; then
      echo "WARN: repin reset-before-checkout failed for $agent_name ($workdir)" >&2
      continue
    fi
    if ! git -C "$workdir" clean -fd >/dev/null 2>&1; then
      echo "WARN: repin clean-before-checkout failed for $agent_name ($workdir)" >&2
      continue
    fi
    if ! git -C "$workdir" checkout -B "$branch" origin/master >/dev/null 2>&1; then
      echo "WARN: repin checkout failed for $agent_name ($workdir) -> $branch" >&2
      continue
    fi
    if ! git -C "$workdir" reset --hard origin/master >/dev/null 2>&1; then
      echo "WARN: repin hard-sync failed for $agent_name ($workdir)" >&2
      continue
    fi
    if ! git -C "$workdir" clean -fd >/dev/null 2>&1; then
      echo "WARN: repin final clean failed for $agent_name ($workdir)" >&2
      continue
    fi
    echo "repin: $agent_name -> $branch @ origin/master" >&2
  done
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
