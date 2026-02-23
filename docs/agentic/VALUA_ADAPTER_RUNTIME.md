# Valua Adapter Runtime Contract

This is the authoritative behavior reference for launching Agentic Cockpit against Valua.

Primary scripts:
- `adapters/valua/run.sh`
- `adapters/valua/restart-master.sh`
- `scripts/tmux/cockpit.sh`
- `scripts/tmux/agents-up.sh`

## Adapter Goals

The adapter provides:
1. deterministic runtime wiring to Valua repo + roster
2. stable default bus/worktree paths under `~/.codex/valua`
3. app-server-first worker execution profile
4. controlled reset/repin path for runtime recovery

## `run.sh` Behavior

`adapters/valua/run.sh /path/to/Valua` performs:

1. Resolve `COCKPIT_ROOT`
2. Validate required positional project path
3. Set:
   - `AGENTIC_PROJECT_ROOT`
   - `AGENTIC_ROSTER_PATH` defaulting to `<project>/docs/agentic/agent-bus/ROSTER.json`
4. Fail fast if roster missing unless `VALUA_ALLOW_ROSTER_FALLBACK=1`
5. Set default bus/worktree roots:
   - `AGENTIC_BUS_DIR=~/.codex/valua/agent-bus`
   - `AGENTIC_WORKTREES_DIR=~/.codex/valua/worktrees/Valua`
6. Apply runtime defaults (engine/gates/guards/policy sync)
7. Launch tmux cockpit via `scripts/tmux/cockpit.sh up`

### Default Runtime Profile Applied by `run.sh`

Engine/session profile:
- `AGENTIC_CODEX_ENGINE=app-server`
- `AGENTIC_CODEX_APP_SERVER_PERSIST=1`
- `AGENTIC_CODEX_WARM_START=1`
- `AGENTIC_CODEX_HOME_MODE=agent`
- `AGENTIC_CODEX_ENGINE_STRICT=1`

Autopilot gates/profile:
- `AGENTIC_AUTOPILOT_CONTEXT_MODE=auto`
- `AGENTIC_AUTOPILOT_SKILL_PROFILE=controller`
- `AGENTIC_AUTOPILOT_EXEC_SKILLS=valua-exec-agent`
- `AGENTIC_AUTOPILOT_ENABLE_LANG_POLICIES=0`
- `AGENTIC_AUTOPILOT_DELEGATE_GATE=1`
- `AGENTIC_AUTOPILOT_SELF_REVIEW_GATE=1`
- `AGENTIC_AUTOPILOT_PROACTIVE_STATUS=1`
- `AGENTIC_AUTOPILOT_SESSION_SCOPE=root`
- `AGENTIC_AUTOPILOT_SESSION_ROTATE_TURNS=40`
- `AGENTIC_AUTOPILOT_SKILLOPS_GATE=1`
- `AGENTIC_AUTOPILOT_SKILLOPS_GATE_KINDS=USER_REQUEST,ORCHESTRATOR_UPDATE`
- guard overrides default off:
  - `AGENTIC_AUTOPILOT_GUARD_ALLOW_PROTECTED_PUSH=0`
  - `AGENTIC_AUTOPILOT_GUARD_ALLOW_PR_MERGE=0`
  - `AGENTIC_AUTOPILOT_GUARD_ALLOW_FORCE_PUSH=0`

Quality/runtime safety:
- `AGENTIC_CODE_QUALITY_GATE=1`
- `AGENTIC_CODE_QUALITY_GATE_KINDS=USER_REQUEST,ORCHESTRATOR_UPDATE,EXECUTE`
- `AGENTIC_STRICT_COMMIT_SCOPED_GATE=1`
- `AGENTIC_GATE_AUTOREMEDIATE_RETRIES=2`
- `AGENTIC_EXEC_PREFLIGHT_AUTOCLEAN_DIRTY=0`
- `AGENTIC_POLICY_SYNC_ON_START=1`
- `AGENTIC_POLICY_SYNC_SOURCE_REF=origin/master`

Observer baseline:
- `AGENTIC_PR_OBSERVER_MIN_PR=82`

Valua compatibility variables are mirrored (`VALUA_*`) from these defaults.

## `restart-master.sh` Behavior

`adapters/valua/restart-master.sh /path/to/Valua [runtime-worktree]` performs deterministic relaunch from `origin/master`.

Default runtime worktree path:
- `/tmp/valua-runtime-master`

Steps:
1. Kill tmux session derived from roster `sessionName`
2. `git fetch origin master` in source repo
3. Ensure runtime worktree exists at runtime path on branch `runtime/master`
4. Hard reset runtime worktree to `origin/master`
5. Clean untracked files in runtime worktree
6. Validate runtime roster exists
7. Validate runtime roster (default) for autopilot dedicated worktree wiring:
   - branch: `agent/daddy-autopilot`
   - workdir: `$VALUA_AGENT_WORKTREES_DIR/daddy-autopilot`
8. Repin codex agent worktrees to `origin/master` (default `REPIN_WORKTREES=1`)
9. Optional rotate codex runtime state (`RESET_STATE=1`)
10. Launch adapter against runtime worktree with no-auto-attach, then attach

### `restart-master.sh` Switches

- `RESET_STATE=1`
  - rotates codex state for all roster codex agents
  - clears pin/index/runtime home state under bus root only

- `REPIN_WORKTREES=0`
  - skip repinning per-agent worktrees
  - useful only for debugging intentionally divergent branches

- `VALUA_AUTOPILOT_DEDICATED_WORKTREE=0`
  - disable runtime roster autopilot dedicated worktree validation
  - not recommended for normal operation

## Runtime Paths Used by Adapter

Default path model:
- bus: `~/.codex/valua/agent-bus`
- worker worktrees: `~/.codex/valua/worktrees/Valua/<agent>`
- deterministic runtime checkout for `restart-master`: `/tmp/valua-runtime-master`

This split is intentional:
- source repo can stay dirty/active for development
- runtime can be clean and pinned to `origin/master`

## Why Runtime Can Start from `/tmp`

`restart-master.sh` intentionally runs cockpit from an isolated runtime worktree to avoid:
- local branch drift
- dirty source checkout side effects
- policy/skill sync contamination from uncommitted root changes

The runtime checkout is a real git worktree, not an ad-hoc copy.

## Command Matrix

Normal adapter restart:
```bash
bash adapters/valua/run.sh /path/to/Valua
```

Deterministic runtime restart (recommended):
```bash
bash adapters/valua/restart-master.sh /path/to/Valua
```

Deterministic restart + state rotation:
```bash
RESET_STATE=1 bash adapters/valua/restart-master.sh /path/to/Valua
```

Deterministic restart without repin:
```bash
REPIN_WORKTREES=0 bash adapters/valua/restart-master.sh /path/to/Valua
```

## Known Failure Modes and Meaning

1. `missing Valua roster ...`
- Cause: project-local roster absent
- Behavior: adapter fails closed (unless fallback explicitly allowed)

2. `runtime path exists but is not a registered Valua worktree`
- Cause: runtime path occupied by non-worktree directory
- Behavior: restart aborts; path must be cleaned or changed

3. `local changes would be overwritten by checkout`
- Cause: target checkout/worktree is dirty where checkout/reset needs clean state
- Behavior: command fails until reset/clean or isolated runtime path used

4. observer sees comments but no task emitted
- Cause class: actionable filter + watermark advancement behavior in observer
- Not an adapter failure; observer logic behavior

## Operator Guidance

Use `restart-master.sh` as the default operational restart command for Valua.

Use plain `run.sh` when you intentionally want to run against a specific existing checkout state.

When debugging strange branch/worktree drift, capture:
- runtime `AGENTIC_PROJECT_ROOT`
- runtime `AGENTIC_ROSTER_PATH`
- current branch/SHA for each worker worktree
- adapter env overrides currently set
