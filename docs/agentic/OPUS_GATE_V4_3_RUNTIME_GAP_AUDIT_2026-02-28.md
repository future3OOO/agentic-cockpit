# OPUS Gate V4.3 Runtime Gap Audit (2026-02-28)

## Incident
- Runtime block observed in Valua cockpit:
  - `reasonCode=opus_prompt_assets_missing` (historical pre-V4.4 reason code; superseded by `opus_schema_invalid`)
  - autopilot closed user task as `blocked` during required pre-exec consult.

## Verified root cause chain
1. `daddy-autopilot` correctly enforced pre-exec OPUS consult barrier.
2. `opus-consult` worker was invoked.
3. worker attempted to load prompt assets from project root only (`AGENTIC_PROJECT_ROOT/.codex/opus`).
4. Valua project runtime did not contain `.codex/opus/OPUS_INSTRUCTIONS.md` and `.codex/opus/OPUS_SKILLS.md` (historical pre-V4.4 prompt model).
5. consult worker emitted block response (`opus_prompt_assets_missing`) and autopilot blocked the task.

## Missed implementation items (gaps)
1. Downstream runtime compatibility gap.
- V4.3 implementation added OPUS assets/schemas in cockpit repo, but did not guarantee downstream runtime projects always had equivalent assets.

2. Worker resolution rigidity gap.
- `agent-opus-consult-worker` treated prompt/schema locations as single-root assumptions, with no robust fallback chain.

3. Startup fail-fast gap.
- `adapters/valua/run.sh` did not validate OPUS consult prerequisites before launching tmux, allowing deferred runtime failure instead of immediate startup error.

4. Roster integration gap (Valua runtime).
- Project-local Valua roster lacked `opus-consult` codex-worker entry while autopilot consult gate defaulted to `opus-consult`.

## Remediation in this patch set
1. Worker fallback hardening.
- `agent-opus-consult-worker` now resolves prompt/schema assets through explicit candidate chains:
  - override env path
  - project root
  - worker repo root
  - cockpit root
- Missing provider schema now fails deterministically as `opus_schema_invalid`.
- Receipt metadata now records resolved `promptDir` and `providerSchemaPath`.

2. Adapter startup preflight.
- `adapters/valua/run.sh` now fail-fast checks OPUS consult wiring when OPUS gates are enabled:
  - consult agent exists and is `kind=codex-worker`
  - prompt assets are resolvable
  - provider schema is resolvable
- Launch aborts with explicit remediation instructions if preflight fails.

3. Regression test coverage.
- Added worker regression test for missing project assets with cockpit fallback.
- Existing OPUS gate tests continue to validate barrier behavior and schema protocol paths.

4. Runtime validation evidence.
- After restart on patched branch, direct live consult probe completed with:
  - `outcome=done`
  - `reasonCode=PROBE_OK` (from stubbed probe output contract)
  - `promptDir=/home/prop_/projects/.worktrees/agentic-cockpit-opus-gate-v4-3/.codex/opus`
  - `providerSchemaPath=/home/prop_/projects/.worktrees/agentic-cockpit-opus-gate-v4-3/docs/agentic/agent-bus/OPUS_CONSULT.provider.schema.json`
- This verifies the previously failing path (`opus_prompt_assets_missing`) is resolved in live runtime.

## Runtime outcome target
- No deferred `opus_prompt_assets_missing` blocks during normal Valua startup path.
- Broken OPUS wiring fails at launch with a direct actionable error.
