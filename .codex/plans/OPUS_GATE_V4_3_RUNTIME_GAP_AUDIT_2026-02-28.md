# OPUS Gate V4.3 Runtime Gap Audit (2026-02-28)

## Incident
- Runtime block observed in Valua cockpit:
  - `reasonCode=opus_prompt_assets_missing`
  - autopilot closed user task as `blocked` during required pre-exec consult.

## Verified root cause chain
1. `daddy-autopilot` correctly enforced pre-exec OPUS consult barrier.
2. `opus-consult` worker was invoked.
3. worker attempted to load prompt assets from project root only (`AGENTIC_PROJECT_ROOT/.codex/opus`).
4. Valua project runtime did not contain `.codex/opus/OPUS_INSTRUCTIONS.md` and `.codex/opus/OPUS_SKILLS.md`.
5. consult worker emitted block response (`opus_prompt_assets_missing`) and autopilot blocked the task.

## Missed implementation items (gaps)
1. Downstream runtime compatibility gap:
- V4.3 implementation added OPUS assets/schemas in cockpit repo, but did not ensure downstream project runtimes (Valua) always had equivalent assets.

2. Worker resolution rigidity gap:
- `agent-opus-consult-worker` treated prompt/schema locations as single-root assumptions, with no robust fallback chain.

3. Startup fail-fast gap:
- `adapters/valua/run.sh` did not validate OPUS consult prerequisites before launching tmux, allowing deferred runtime failure instead of immediate actionable startup error.

4. Roster integration gap (Valua project runtime):
- project-local roster in Valua lacked `opus-consult` codex-worker entry, while autopilot consult gate defaulted to `opus-consult`.

## Remediation plan (this patch set)
1. Add robust prompt/schema path resolution in `agent-opus-consult-worker`:
- support override envs
- support project-root + repo-root + cockpit-root fallback candidates
- produce deterministic blocked mapping when unresolved

2. Add adapter fail-fast preflight in `adapters/valua/run.sh`:
- if OPUS gate enabled, assert consult agent exists in roster
- assert required prompt/schema assets are resolvable via runtime search chain
- abort startup with explicit remediation instructions on failure

3. Add regression tests:
- worker fallback behavior when project root lacks assets but cockpit root has them
- adapter preflight behavior (OPUS enabled + missing consult wiring)

4. Runtime validation:
- confirm `opus-consult` worker pane runs in tmux
- confirm autopilot no longer blocks due to missing prompt assets

## Exit criteria
- No autopilot blocks with `opus_prompt_assets_missing` in normal Valua restart path.
- Startup fails fast (clear error) if OPUS consult prerequisites are broken.
- Full touched suite and full test suite remain green.
