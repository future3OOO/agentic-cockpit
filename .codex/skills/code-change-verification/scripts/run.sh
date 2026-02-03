#!/usr/bin/env bash
set -euo pipefail

repo_root="$(pwd -P)"
if repo_root_raw="$(git -C "$repo_root" rev-parse --show-toplevel 2>/dev/null)"; then
  repo_root="$repo_root_raw"
fi

cd "$repo_root"

if [ -f "pnpm-lock.yaml" ] && command -v corepack >/dev/null 2>&1; then
  corepack pnpm -s test
  corepack pnpm -s lint || true
  corepack pnpm -s typecheck || true
  corepack pnpm -s build || true
  exit 0
fi

if [ -f "yarn.lock" ] && command -v yarn >/dev/null 2>&1; then
  yarn test
  yarn lint || true
  yarn typecheck || true
  yarn build || true
  exit 0
fi

if [ -f "package.json" ] && command -v npm >/dev/null 2>&1; then
  npm test
  npm run lint --if-present
  npm run typecheck --if-present
  npm run build --if-present
  exit 0
fi

echo "No supported verification toolchain detected (expected package.json / pnpm-lock.yaml / yarn.lock)."
echo "Run the repo's documented verification commands instead."

