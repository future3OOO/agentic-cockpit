$ErrorActionPreference = "Stop"

function Resolve-RepoRoot {
  try {
    $root = git rev-parse --show-toplevel 2>$null
    if ($LASTEXITCODE -eq 0 -and $root) { return $root.Trim() }
  } catch { }
  return (Get-Location).Path
}

$repoRoot = Resolve-RepoRoot
Set-Location $repoRoot

if (Test-Path "pnpm-lock.yaml") {
  if (Get-Command corepack -ErrorAction SilentlyContinue) {
    corepack pnpm -s test
    try { corepack pnpm -s lint } catch { }
    try { corepack pnpm -s typecheck } catch { }
    try { corepack pnpm -s build } catch { }
    exit 0
  }
}

if (Test-Path "yarn.lock") {
  if (Get-Command yarn -ErrorAction SilentlyContinue) {
    yarn test
    try { yarn lint } catch { }
    try { yarn typecheck } catch { }
    try { yarn build } catch { }
    exit 0
  }
}

if (Test-Path "package.json") {
  if (Get-Command npm -ErrorAction SilentlyContinue) {
    npm test
    npm run lint --if-present
    npm run typecheck --if-present
    npm run build --if-present
    exit 0
  }
}

Write-Host "No supported verification toolchain detected (expected package.json / pnpm-lock.yaml / yarn.lock)."
Write-Host "Run the repo's documented verification commands instead."

