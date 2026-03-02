# Valua adapter

This adapter runs Agentic Cockpit against a local Valua checkout.

It preserves Valua’s existing defaults where possible:
- bus root: `~/.codex/valua/agent-bus`
- worktrees: `~/.codex/valua/worktrees/Valua`

Deep runtime reference:
- `docs/agentic/VALUA_ADAPTER_RUNTIME.md`

## Usage
```bash
bash adapters/valua/run.sh /path/to/Valua
```

Deterministic master runtime (recommended):
```bash
bash adapters/valua/restart-master.sh /path/to/Valua
```
By default this also re-pins codex agent worktrees to `origin/master` before launch.
It also validates roster wiring so `daddy-autopilot` runs from `$VALUA_AGENT_WORKTREES_DIR/daddy-autopilot` (full symmetry with other codex workers) and fails fast on drift.
Set `REPIN_WORKTREES=0` only if you intentionally want to keep current per-agent branch state.

## Exact restart/reset commands
Use these exact commands from any directory:

```bash
COCKPIT_ROOT="/home/prop_/projects/agentic-cockpit"
VALUA_ROOT="/home/prop_/projects/Valua"
```

Normal restart (clean runtime + repin agent worktrees to `origin/master`):

```bash
bash "$COCKPIT_ROOT/adapters/valua/restart-master.sh" "$VALUA_ROOT"
```

Hard reset (same as above + rotate agent codex state pins/index):

```bash
RESET_STATE=1 bash "$COCKPIT_ROOT/adapters/valua/restart-master.sh" "$VALUA_ROOT"
```

Debug-only restart (keep current agent worktree branches, no repin):

```bash
REPIN_WORKTREES=0 bash "$COCKPIT_ROOT/adapters/valua/restart-master.sh" "$VALUA_ROOT"
```

Bypass dedicated autopilot roster validation (debug only, not recommended):

```bash
VALUA_AUTOPILOT_DEDICATED_WORKTREE=0 bash "$COCKPIT_ROOT/adapters/valua/restart-master.sh" "$VALUA_ROOT"
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
- `AGENTIC_POLICY_SYNC_SOURCE_REF` (default `origin/master`, source policy files from clean git ref)
- `AGENTIC_AUTOPILOT_DELEGATE_GATE` (default `1`): enforce delegate-first closure for autopilot `USER_REQUEST` code changes.
- `AGENTIC_AUTOPILOT_SELF_REVIEW_GATE` (default `1`): require self-review gate checks before autopilot closure.
- `AGENTIC_AUTOPILOT_PROACTIVE_STATUS` (default `1`): emit proactive autopilot root-status updates.
- `AGENTIC_AUTOPILOT_POST_MERGE_RESYNC` (default `1`): after autopilot merge-completion tasks, resync project `master` and agent worktrees to `origin/master`.
- `AGENTIC_AUTOPILOT_SKILL_PROFILE` (default `controller`): select autopilot skill profile.
- `AGENTIC_AUTOPILOT_EXEC_SKILLS` (default `valua-exec-agent`): exec skill allowlist for autopilot delegation.
- `AGENTIC_AUTOPILOT_ENABLE_LANG_POLICIES` (default `0`): enable per-language quality policy skills.
- `AGENTIC_AUTOPILOT_SESSION_SCOPE` (default `root`): set autopilot session continuity scope (`root` or `task`).
- `AGENTIC_AUTOPILOT_SESSION_ROTATE_TURNS` (default `40`): rotate root-scoped sessions after N turns.
- `AGENTIC_CODE_QUALITY_GATE` (default `1`): enable runtime code-quality gate checks.
- `AGENTIC_CODE_QUALITY_GATE_KINDS` (default `USER_REQUEST,ORCHESTRATOR_UPDATE,EXECUTE`): task kinds requiring code-quality gate.
- `AGENTIC_STRICT_COMMIT_SCOPED_GATE` (default `1`): enforce commit-scoped quality gate behavior when commit evidence is present.
- `AGENTIC_GATE_AUTOREMEDIATE_RETRIES` (default `2`): max auto-remediation retries for recoverable gate failures.
- `AGENTIC_EXEC_PREFLIGHT_AUTOCLEAN_DIRTY` (default `0`): auto-clean dirty deterministic execute worktrees before run.
- `AGENTIC_CODEX_ENGINE_STRICT` (default `1`): enforce strict engine policy for autopilot worker mode.
- OPUS consult defaults:
  - `AGENTIC_OPUS_CONSULT_MODE` / `VALUA_OPUS_CONSULT_MODE` (default `advisory`)
  - `AGENTIC_OPUS_PROTOCOL_MODE` / `VALUA_OPUS_PROTOCOL_MODE` (default `freeform_only`)
  - `AGENTIC_AUTOPILOT_OPUS_GATE` / `VALUA_AUTOPILOT_OPUS_GATE` (default `auto`)
  - `AGENTIC_AUTOPILOT_OPUS_GATE_KINDS` / `VALUA_AUTOPILOT_OPUS_GATE_KINDS` (default `USER_REQUEST,PLAN_REQUEST,ORCHESTRATOR_UPDATE,EXECUTE`)
  - `AGENTIC_AUTOPILOT_OPUS_POST_REVIEW` / `VALUA_AUTOPILOT_OPUS_POST_REVIEW` (default `auto`)
  - `AGENTIC_AUTOPILOT_OPUS_POST_REVIEW_KINDS` / `VALUA_AUTOPILOT_OPUS_POST_REVIEW_KINDS` (default `USER_REQUEST,PLAN_REQUEST,ORCHESTRATOR_UPDATE,EXECUTE`)
  - `AGENTIC_AUTOPILOT_OPUS_CONSULT_AGENT` / `VALUA_AUTOPILOT_OPUS_CONSULT_AGENT` (default `opus-consult`)
  - `AGENTIC_AUTOPILOT_OPUS_GATE_TIMEOUT_MS` / `VALUA_AUTOPILOT_OPUS_GATE_TIMEOUT_MS` (default `3600000`)
  - `AGENTIC_AUTOPILOT_OPUS_MAX_ROUNDS` / `VALUA_AUTOPILOT_OPUS_MAX_ROUNDS` (default `200`)
  - `AGENTIC_OPUS_CLAUDE_BIN` / `VALUA_OPUS_CLAUDE_BIN`, `AGENTIC_OPUS_MODEL` / `VALUA_OPUS_MODEL`
  - `AGENTIC_OPUS_TIMEOUT_MS` / `VALUA_OPUS_TIMEOUT_MS`, `AGENTIC_OPUS_MAX_RETRIES` / `VALUA_OPUS_MAX_RETRIES`
  - `AGENTIC_OPUS_TOOLS` / `VALUA_OPUS_TOOLS`, `AGENTIC_OPUS_CWD_MODE` / `VALUA_OPUS_CWD_MODE`, `AGENTIC_OPUS_STREAM` / `VALUA_OPUS_STREAM`
- `RESET_STATE=1` with `adapters/valua/restart-master.sh` to rotate codex-home and clear pins for all codex agents before launch
- `REPIN_WORKTREES=1` with `adapters/valua/restart-master.sh` (default) to hard-repin codex agent worktrees to `origin/master`
- `VALUA_AUTOPILOT_DEDICATED_WORKTREE=1` with `adapters/valua/restart-master.sh` (default) to enforce dedicated autopilot roster wiring (`branch` + `workdir`) and fail fast on drift

Notes:
- The chat pane boot prompt defaults to `$valua-daddy-chat-io` (override via `VALUA_CODEX_CHAT_BOOT_PROMPT`).
- The PR observer is constrained to PR `>= 82` by default for Valua adapter launches; override only if you intentionally need older PRs scanned.
- Startup syncs policy files from `AGENTIC_POLICY_SYNC_SOURCE_REF` into worker worktrees by default; dirty tracked files in worker worktrees are preserved.
- If no source ref is set, sync reads from the working tree and now fails closed when source policy files are dirty.
