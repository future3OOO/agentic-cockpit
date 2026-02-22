# Valua adapter

This adapter runs Agentic Cockpit against a local Valua checkout.

It preserves Valua’s existing defaults where possible:
- bus root: `~/.codex/valua/agent-bus`
- worktrees: `~/.codex/valua/worktrees/Valua`

## Usage
```bash
bash adapters/valua/run.sh /path/to/Valua
```

Deterministic master runtime (recommended):
```bash
bash adapters/valua/restart-master.sh /path/to/Valua
```

## Copy-safe start/restart commands
Set roots once:

```bash
COCKPIT_ROOT="/path/to/agentic-cockpit"
VALUA_ROOT="/path/to/Valua"
SESSION_NAME="$(node -e "const fs=require('fs');const p=process.argv[1];let s='valua-cockpit';try{s=JSON.parse(fs.readFileSync(p,'utf8')).sessionName||s}catch{};process.stdout.write(String(s));" "$VALUA_ROOT/docs/agentic/agent-bus/ROSTER.json")"
```

Start/restart with adapter defaults (`run.sh` attaches automatically):

```bash
(tmux kill-session -t "$SESSION_NAME" 2>/dev/null || true) && \
bash "$COCKPIT_ROOT/adapters/valua/run.sh" "$VALUA_ROOT"
```

Start/restart from clean `origin/master` runtime worktree (recommended):

```bash
bash "$COCKPIT_ROOT/adapters/valua/restart-master.sh" "$VALUA_ROOT"
```

Enable SkillOps gate for both user and orchestrator updates:

```bash
(tmux kill-session -t "$SESSION_NAME" 2>/dev/null || true) && \
AGENTIC_AUTOPILOT_SKILLOPS_GATE=1 \
AGENTIC_AUTOPILOT_SKILLOPS_GATE_KINDS='USER_REQUEST,ORCHESTRATOR_UPDATE' \
bash "$COCKPIT_ROOT/adapters/valua/run.sh" "$VALUA_ROOT"
```

Enable SkillOps + autopilot guard overrides:

```bash
(tmux kill-session -t "$SESSION_NAME" 2>/dev/null || true) && \
AGENTIC_AUTOPILOT_SKILLOPS_GATE=1 \
AGENTIC_AUTOPILOT_SKILLOPS_GATE_KINDS='USER_REQUEST,ORCHESTRATOR_UPDATE' \
AGENTIC_AUTOPILOT_GUARD_ALLOW_PROTECTED_PUSH=1 \
AGENTIC_AUTOPILOT_GUARD_ALLOW_PR_MERGE=1 \
AGENTIC_AUTOPILOT_GUARD_ALLOW_FORCE_PUSH=1 \
bash "$COCKPIT_ROOT/adapters/valua/run.sh" "$VALUA_ROOT"
```

Notes:
- Guard overrides are opt-in (`0` by default).
- Keep `.../adapters/valua/run.sh` as one token; broken path wrapping will fail.
- If you want explicit attach as a separate step, set `AGENTIC_TMUX_NO_ATTACH=1` (or `VALUA_TMUX_NO_ATTACH=1`) and then run `tmux attach -t "$SESSION_NAME"`.

## Bootstrap (optional, fresh checkout only)
For a brand-new Valua checkout missing cockpit files, scaffold once:

```bash
node scripts/init-project.mjs --project /path/to/Valua
```

This seeds Valua-local:
- `docs/agentic/agent-bus/*`
- `docs/agentic/BLUEPRINT.md`
- `docs/runbooks/*`
- `.codex/skills/cockpit-*` baseline skills (plus verification skill)

Important:
- For an already-configured Valua repo, **do not run scaffold** in normal operation.
- The adapter uses Valua-local files directly; it does not auto-seed.
- `init-project` is only for bootstrapping missing files (it skips existing files unless `--force` is used).
- The adapter now fails fast if Valua roster is missing, to avoid accidental bundled fallback.

Optional env overrides:
- `AGENTIC_BUS_DIR`
- `AGENTIC_WORKTREES_DIR`
- `AGENTIC_PR_OBSERVER_MIN_PR` (default from adapter: `82`)
- `AGENTIC_POLICY_SYNC_ON_START` (default `1`, one-way root -> worktrees)
- `AGENTIC_CODE_QUALITY_GATE` (default `1`)
- `AGENTIC_CODE_QUALITY_GATE_KINDS` (default `USER_REQUEST,ORCHESTRATOR_UPDATE,EXECUTE,PLAN_REQUEST`)
- `AGENTIC_EXEC_PREFLIGHT_AUTOCLEAN_DIRTY` (default `1`)
- `RESET_STATE=1` with `adapters/valua/restart-master.sh` to rotate codex-home and clear pins for all codex agents before launch

Notes:
- The chat pane boot prompt defaults to `$valua-daddy-chat-io` (override via `VALUA_CODEX_CHAT_BOOT_PROMPT`).
- The PR observer is constrained to PR `>= 82` by default for Valua adapter launches; override only if you intentionally need older PRs scanned.
- Startup syncs policy files from project root into worker worktrees by default; dirty tracked files in worker worktrees are preserved.
