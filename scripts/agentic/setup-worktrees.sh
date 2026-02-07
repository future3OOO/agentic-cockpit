#!/usr/bin/env bash
set -euo pipefail

# Idempotently creates per-agent worktrees defined in the AgentBus roster.
#
# Reads:
#   docs/agentic/agent-bus/ROSTER.json
# Uses agent entries that include:
#   - kind: "codex-worker"
#   - branch: "agent/<name>" (optional; defaults to "agent/<name>")
#   - workdir: "$AGENTIC_WORKTREES_DIR/<name>" (optional; defaults to that path)
#
# This script never deletes worktrees or branches.

REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"

ROSTER_DEFAULT="$REPO_ROOT/docs/agentic/agent-bus/ROSTER.json"
ROSTER_PATH="${AGENTIC_ROSTER_PATH:-${VALUA_AGENT_ROSTER_PATH:-${ROSTER_PATH:-$ROSTER_DEFAULT}}}"

WORKTREES_DIR_DEFAULT="$HOME/.agentic-cockpit/worktrees"
export AGENTIC_WORKTREES_DIR="${AGENTIC_WORKTREES_DIR:-$WORKTREES_DIR_DEFAULT}"
export VALUA_AGENT_WORKTREES_DIR="${VALUA_AGENT_WORKTREES_DIR:-$AGENTIC_WORKTREES_DIR}"

BASE_REF="${AGENTIC_WORKTREES_BASE_REF:-${VALUA_AGENT_WORKTREES_BASE_REF:-HEAD}}"

if [ "$BASE_REF" = "HEAD" ]; then
  # Prefer the locally known origin default branch if present (no network required).
  if origin_head="$(git symbolic-ref -q refs/remotes/origin/HEAD 2>/dev/null)"; then
    if [ -n "$origin_head" ]; then
      BASE_REF="${origin_head#refs/remotes/}"
    fi
  fi
fi

usage() {
  cat <<EOF
setup-worktrees.sh

Usage:
  bash scripts/agentic/setup-worktrees.sh [--roster <path>] [--base <ref>]

Env:
  AGENTIC_ROSTER_PATH        Override roster path (default: $ROSTER_DEFAULT)
  AGENTIC_WORKTREES_DIR      Worktrees root (default: $WORKTREES_DIR_DEFAULT)
  AGENTIC_WORKTREES_BASE_REF Git ref for new branches (default: origin/HEAD → main/master → HEAD)

Valua compatibility:
  VALUA_AGENT_ROSTER_PATH
  VALUA_AGENT_WORKTREES_DIR
  VALUA_AGENT_WORKTREES_BASE_REF
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --roster)
      ROSTER_PATH="$2"
      shift 2
      ;;
    --base)
      BASE_REF="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

cd "$REPO_ROOT"

expand_roster_vars() {
  local s="$1"
  s="${s//\$REPO_ROOT/$REPO_ROOT}"
  s="${s//\$AGENTIC_WORKTREES_DIR/$AGENTIC_WORKTREES_DIR}"
  s="${s//\$VALUA_AGENT_WORKTREES_DIR/$VALUA_AGENT_WORKTREES_DIR}"
  s="${s//\$HOME/$HOME}"
  printf '%s' "$s"
}

ensure_parent_dir() {
  local p="$1"
  mkdir -p "$(dirname "$p")"
}

branch_exists() {
  git show-ref --verify --quiet "refs/heads/$1"
}

worktree_path_in_use() {
  local p="$1"
  git worktree list --porcelain | awk -v p="$p" '$1=="worktree"{print $2}' | grep -Fxq "$p"
}

worktree_for_branch() {
  local b="$1"
  git worktree list --porcelain | awk -v b="$b" '
    $1=="worktree"{p=$2}
    $1=="branch"{gsub(/^refs\/heads\//,"",$2); if($2==b){print p}}
  '
}

echo "Worktrees:"
echo "- repoRoot:   $REPO_ROOT"
echo "- roster:     $ROSTER_PATH"
echo "- worktrees:  $AGENTIC_WORKTREES_DIR"
echo "- baseRef:    $BASE_REF"
echo

node -e '
  const fs = require("fs");
  const roster = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const agents = Array.isArray(roster.agents) ? roster.agents : [];
  for (const a of agents) {
    if (!a || a.kind !== "codex-worker") continue;
    const name = String(a.name || "").trim();
    if (!name) continue;

    const branchRaw = String(a.branch || "").trim();
    const branch = branchRaw || ("agent/" + name);

    const workdirRaw = String(a.workdir || "").trim();
    const legacyRootWorkdir =
      workdirRaw === "$REPO_ROOT" || workdirRaw === "$AGENTIC_PROJECT_ROOT" || workdirRaw === "$VALUA_REPO_ROOT";
    const workdir = !workdirRaw || legacyRootWorkdir ? ("$AGENTIC_WORKTREES_DIR/" + name) : workdirRaw;

    process.stdout.write([name, branch, workdir].join("\t") + "\n");
  }
' "$ROSTER_PATH" | while IFS=$'\t' read -r name branch workdir_raw; do
  [ -n "$name" ] || continue
  workdir="$(expand_roster_vars "$workdir_raw")"

  # If the workdir is the current repo root, don't try to create a worktree.
  if [ "$workdir" = "$REPO_ROOT" ]; then
    echo "- skip $name (workdir is REPO_ROOT)"
    continue
  fi

  # If this path is already a worktree, leave it alone.
  if worktree_path_in_use "$workdir"; then
    echo "- ok $name (worktree exists): $workdir"
    continue
  fi

  existing_path="$(worktree_for_branch "$branch" || true)"
  if [ -n "$existing_path" ]; then
    echo "- skip $name (branch already checked out): $branch @ $existing_path" >&2
    continue
  fi

  ensure_parent_dir "$workdir"

  if branch_exists "$branch"; then
    echo "- add worktree $name: $workdir (branch: $branch)"
    git worktree add "$workdir" "$branch"
  else
    echo "- add worktree $name: $workdir (new branch: $branch from $BASE_REF)"
    git worktree add -b "$branch" "$workdir" "$BASE_REF"
  fi
done
