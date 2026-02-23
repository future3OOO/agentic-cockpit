# Valua Adapter

This adapter runs Agentic Cockpit against a Valua checkout with Valua-specific defaults.

Authoritative deep reference:
- `docs/agentic/VALUA_ADAPTER_RUNTIME.md`

## Core Commands

Normal adapter launch:
```bash
bash adapters/valua/run.sh /path/to/Valua
```

Deterministic restart from clean `origin/master` runtime worktree:
```bash
bash adapters/valua/restart-master.sh /path/to/Valua
```

Deterministic restart + codex state rotation:
```bash
RESET_STATE=1 bash adapters/valua/restart-master.sh /path/to/Valua
```

Restart without repinning worker worktrees (debug-only):
```bash
REPIN_WORKTREES=0 bash adapters/valua/restart-master.sh /path/to/Valua
```

## What `run.sh` Sets by Default

- bus root: `~/.codex/valua/agent-bus`
- worker worktrees: `~/.codex/valua/worktrees/Valua`
- engine: `app-server`
- warm start + persistent app-server: enabled
- SkillOps gate (autopilot): enabled
- code quality gate: enabled
- destructive autopilot guard overrides: disabled (opt-in)
- policy sync on start: enabled
- policy sync source ref: `origin/master`
- observer min PR: `82`

## What `restart-master.sh` Adds

In addition to adapter defaults, it:
- creates/updates runtime worktree (default `/tmp/valua-runtime-master`) at `origin/master`
- hard-resets and cleans runtime checkout
- optionally repins all codex agent worktrees to `origin/master` (default on)
- optionally rotates codex runtime state when `RESET_STATE=1`
- patches runtime roster (default) to force dedicated autopilot worktree path

## Safety Notes

1. Adapter fails closed if Valua roster is missing, unless explicit fallback is enabled:
```bash
VALUA_ALLOW_ROSTER_FALLBACK=1 bash adapters/valua/run.sh /path/to/Valua
```

2. Guard overrides are opt-in and should only be enabled intentionally:
```bash
AGENTIC_AUTOPILOT_GUARD_ALLOW_PROTECTED_PUSH=1
AGENTIC_AUTOPILOT_GUARD_ALLOW_PR_MERGE=1
AGENTIC_AUTOPILOT_GUARD_ALLOW_FORCE_PUSH=1
```

3. Keep `run.sh` path as a single token (`.../adapters/valua/run.sh`); broken shell wrapping can call directory paths incorrectly.

## Fresh Bootstrap (Only if Missing Project Files)

```bash
node scripts/init-project.mjs --project /path/to/Valua
```

Do not run bootstrap as part of normal restart operations.
