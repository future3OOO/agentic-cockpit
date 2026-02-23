# Agentic Cockpit (V2)

Agentic Cockpit is an open-source, file-backed **AgentBus** + **Codex worker** runtime that can be driven from:

- a tmux cockpit (WSL/Linux-friendly), and
- a local dashboard (WSL/Windows-friendly).

This repo is the **V2** track: it keeps the existing “`codex exec` per attempt” engine as a fallback while adding a new **Codex app-server** engine for cleaner mid-task updates (interrupt → continue the same thread), richer streaming, and better observability.

## Canonical Deep References
- `docs/agentic/REFERENCE_INDEX.md` (entrypoint)
- `docs/agentic/CONTROL_LOOP_AND_PACKET_FLOW.md`
- `docs/agentic/RUNTIME_FUNCTION_REFERENCE.md`
- `docs/agentic/VALUA_ADAPTER_RUNTIME.md`
- `docs/agentic/DECISIONS_AND_INCIDENTS_TIMELINE.md`

## Goals
- Deterministic orchestration: everything is auditable via the filesystem bus (tasks + receipts).
- Safe defaults: no secrets in git/logs; guardrails against accidental merges/protected pushes.
- Cross-platform: WSL/Linux first; Windows native optional.

## Workflow Visuals

Implementation-accurate architecture:

```mermaid
flowchart TB
  User["User"] --> DaddyChat["Daddy Chat"]
  DaddyChat -->|USER_REQUEST| Bus["AgentBus"]
  Bus --> Validator["Packet validator"]
  Validator -->|valid| Bus
  Validator -->|invalid| Deadletter["Deadletter queue"]

  subgraph ControlPlane["Control plane"]
    Autopilot["Daddy Autopilot"]
    Orchestrator["Orchestrator"]
    DaddyInbox["Daddy Inbox listener"]
  end

  subgraph Observers["Background observers"]
    PrObserver["PR observer"]
  end

  subgraph BundledWorkers["Bundled worker agents"]
    Frontend["frontend worker"]
    QA["qa worker"]
  end

  GitHub["GitHub PR reviews"]

  subgraph ProjectWorkers["Project-defined worker agents optional"]
    Extra["backend infra prediction custom workers"]
  end

  Bus -->|deliver| Autopilot
  Autopilot -->|PLAN EXECUTE REVIEW followUps| Bus
  Autopilot -->|commits and PR updates| GitHub
  GitHub -->|new review feedback| PrObserver
  PrObserver -->|REVIEW_ACTION_REQUIRED| Bus

  Bus -->|dispatch| Frontend
  Bus -->|dispatch| QA
  Bus -. project roster .-> Extra

  Frontend -->|close + receipt| Bus
  QA -->|close + receipt| Bus
  Extra -. close + receipt .-> Bus

  Bus -->|auto TASK_COMPLETE| Orchestrator
  Orchestrator -->|ORCHESTRATOR_UPDATE| Bus
  Bus -->|deliver update| Autopilot

  Orchestrator -. optional digest default off .-> Bus
  Bus -. inbox daddy .-> DaddyInbox
  DaddyInbox -. shown when user requests status .-> DaddyChat
```

Detailed diagrams are in `docs/agentic/WORKFLOW_VISUALS.md`, including the full worktree -> slice PR -> GitHub reviewer loop.
Review-thread closure discipline is documented in `docs/agentic/PR_REVIEW_CLOSURE.md`.

## Quick start (tmux)
1. Ensure you have `node` (>= 20), `tmux`, and `codex` installed and authenticated.
   `jq` is optional (scripts avoid requiring it).
2. Start the cockpit:
   - `bash scripts/tmux/cockpit.sh up`

The default bus root is under `~/.agentic-cockpit/bus` (configurable).

## Valua start/restart commands (copy-safe)
Set roots once per shell:

```bash
COCKPIT_ROOT="/path/to/agentic-cockpit"
VALUA_ROOT="/path/to/Valua"
SESSION_NAME="$(node -e "const fs=require('fs');const p=process.argv[1];let s='valua-cockpit';try{s=JSON.parse(fs.readFileSync(p,'utf8')).sessionName||s}catch{};process.stdout.write(String(s));" "$VALUA_ROOT/docs/agentic/agent-bus/ROSTER.json")"
```

Start/restart (adapter defaults; `run.sh` attaches automatically):

```bash
(tmux kill-session -t "$SESSION_NAME" 2>/dev/null || true) && \
bash "$COCKPIT_ROOT/adapters/valua/run.sh" "$VALUA_ROOT"
```

Start/restart with SkillOps gate on both user + orchestrator updates:

```bash
(tmux kill-session -t "$SESSION_NAME" 2>/dev/null || true) && \
AGENTIC_AUTOPILOT_SKILLOPS_GATE=1 \
AGENTIC_AUTOPILOT_SKILLOPS_GATE_KINDS='USER_REQUEST,ORCHESTRATOR_UPDATE' \
bash "$COCKPIT_ROOT/adapters/valua/run.sh" "$VALUA_ROOT"
```

Start/restart with SkillOps + autopilot guard overrides enabled (protected push / PR merge / force push):

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
- Guard overrides default to `0` (opt-in). Set to `1` only when you intentionally want autopilot to perform those operations.
- Keep `run.sh` as one path token (`.../adapters/valua/run.sh`); splitting at `/adapters/valua/` then `run.sh` will fail.
- For explicit two-step attach, use `AGENTIC_TMUX_NO_ATTACH=1` (or `VALUA_TMUX_NO_ATTACH=1`) and then `tmux attach -t "$SESSION_NAME"`.

## Local dashboard (default port 3210)
The tmux cockpit auto-starts a lightweight local web UI (no build step) on `http://127.0.0.1:3210`.

You can also run it manually:

```bash
npm run dashboard
```

This UI can:
- view bus status + inbox + receipts
- send new tasks
- append updates to in-flight tasks (equivalent to `agent-bus update`)
- cancel queued tasks (marks `skipped` and writes a receipt)

WSL note: open `http://localhost:3210` from your Windows browser while the server runs inside WSL.
If your system can’t auto-open a browser from WSL, the dashboard still prints the URL in the tmux `dashboard` window.

Override the default port when needed:

```bash
AGENTIC_DASHBOARD_PORT=3899 npm run dashboard
```

## Using on another project
Agentic Cockpit can drive *any* local repo as long as it has a roster + skills.

Recommended: scaffold the target repo once:

```bash
node /path/to/agentic-cockpit/scripts/init-project.mjs --project /path/to/your-repo
```

This bootstrap copies:
- `docs/agentic/agent-bus/*`
- `docs/agentic/BLUEPRINT.md`
- `docs/runbooks/*`
- `.codex/skills/cockpit-*` and `.codex/skills/code-change-verification`

Then run the cockpit from inside that repo:

```bash
cd /path/to/your-repo
bash /path/to/agentic-cockpit/scripts/tmux/cockpit.sh up
```

If the repo does not yet have a roster, the tmux launcher will fall back to the cockpit’s bundled `docs/agentic/agent-bus/ROSTER.json` (with a warning).

Tip: avoid `COCKPIT_ROOT=/path ... bash $COCKPIT_ROOT/...` in one line (your shell expands `$COCKPIT_ROOT` before that env assignment applies).

The tmux cockpit auto-starts the dashboard by default. To disable:

```bash
AGENTIC_DASHBOARD_AUTOSTART=0 bash /path/to/agentic-cockpit/scripts/tmux/cockpit.sh up
```

The tmux cockpit also auto-starts a PR observer by default (routes unresolved review feedback to the orchestrator/autopilot loop):

```bash
AGENTIC_PR_OBSERVER_AUTOSTART=0 bash /path/to/agentic-cockpit/scripts/tmux/cockpit.sh up
```

Cold-start behavior defaults to baseline seeding (no retro task flood from old unresolved threads/comments):

```bash
AGENTIC_PR_OBSERVER_COLD_START_MODE=baseline
```

Set `AGENTIC_PR_OBSERVER_PRS=123` to monitor only a specific PR instead of all open PRs.
Set `AGENTIC_PR_OBSERVER_MIN_PR=82` to ignore older open PR numbers.

## Worktrees (default)
By default, **codex-worker** agents run in per-agent git worktrees under:
- `~/.agentic-cockpit/worktrees/<agent>`

This isolates agents from each other and from the operator’s working tree.

To disable worktrees (run agents in the current repo checkout):

```bash
AGENTIC_WORKTREES_DISABLE=1 bash /path/to/agentic-cockpit/scripts/tmux/cockpit.sh up
```

### Policy/Skills Sync (one-way)
On cockpit startup/restart, policy files are synced **one-way** from project root into agent worktrees:
- `AGENTS.md`
- `.codex/README.md`
- `.codex/skills/**`
- `docs/runbooks/**`
- `docs/agentic/BLUEPRINT.md`
- `docs/agentic/agent-bus/ROSTER.json`

This keeps worktree skills/runbooks fresh without copying anything back into the project root.

Controls:
- `AGENTIC_POLICY_SYNC_ON_START=0` to disable
- `AGENTIC_POLICY_SYNC_VERBOSE=1` for per-file dirty-skip warnings

To control what new agent branches are based on:
- `AGENTIC_WORKTREES_BASE_REF` (default: `origin/HEAD` if present, else `HEAD`)

## Git Contract (recommended)
For deterministic basing + resumable follow-ups, include `references.git` in code-changing tasks (see `docs/agentic/agent-bus/PROTOCOL.md`).

Workers will use `references.git.workBranch` (and `baseSha` when creating the branch) to ensure they are on the correct branch **before** Codex runs.

To require `baseSha` + `workBranch` for `signals.kind=EXECUTE` tasks:

```bash
AGENTIC_ENFORCE_TASK_GIT_REF=1 bash scripts/tmux/cockpit.sh up
```

## Core CLI
- Initialize a bus: `node scripts/agent-bus.mjs init`
- Send a task: `node scripts/agent-bus.mjs send-text --to autopilot --title "Do X" --body "..." `
- See status: `node scripts/agent-bus.mjs status`

## Configuration
This repo ships with a sample roster at `docs/agentic/agent-bus/ROSTER.json`.

The sample roster uses the built-in skills under `.codex/skills/` (autopilot/planning/execute/qa).

Key env vars (preferred):
- `AGENTIC_BUS_DIR` (bus root)
- `AGENTIC_ROSTER_PATH` (roster json path)
- `AGENTIC_CODEX_ENGINE` (`exec` | `app-server`; core default is `exec` unless an adapter overrides it)
- `AGENTIC_CODEX_ENGINE_STRICT` (autopilot strict-mode guard; keep `1` in adapter runs)
- `AGENTIC_AUTOPILOT_DELEGATE_GATE` (`0|1`, default `1`)
- `AGENTIC_AUTOPILOT_SELF_REVIEW_GATE` (`0|1`, default `1`)
- `AGENTIC_AUTOPILOT_SESSION_SCOPE` (`task|root`, default `root` for autopilot)
- `AGENTIC_AUTOPILOT_SESSION_ROTATE_TURNS` (default `40`)
- `AGENTIC_STRICT_COMMIT_SCOPED_GATE` (`0|1`, default `1` for autopilot adapter profile)
- `AGENTIC_GATE_AUTOREMEDIATE_RETRIES` (bounded gate auto-remediation retries, default `2`)
- `AGENTIC_PR_OBSERVER_AUTOSTART` (`0|1`, default `1`)
- `AGENTIC_PR_OBSERVER_POLL_MS` (default `60000`)
- `AGENTIC_PR_OBSERVER_MAX_PRS` (default `30`)
- `AGENTIC_PR_OBSERVER_REPO` (`owner/repo`, optional override)
- `AGENTIC_PR_OBSERVER_PRS` (comma-separated PR ids, optional override)
- `AGENTIC_PR_OBSERVER_MIN_PR` (minimum PR number, inclusive)
- `AGENTIC_PR_OBSERVER_COLD_START_MODE` (`baseline|replay`, default `baseline`)

Back-compat:
- `VALUA_AGENT_BUS_DIR`, `VALUA_AGENT_ROSTER_PATH` are still accepted for Valua downstreams.
- `VALUA_CODEX_ENGINE` is also accepted.

## Reducing Exec Burn (Recommended)
These controls exist to reduce token/RPM burn while keeping the filesystem bus as the source of truth.

- Warm start (thread reuse + skip skill re-invocation):
  - `AGENTIC_CODEX_WARM_START=1`
  - Reset pins: `AGENTIC_CODEX_RESET_SESSIONS=1` (or set `AGENTIC_TMUX_HARD_RESET=1` for tmux startup)
- Autopilot context sizing:
  - `AGENTIC_AUTOPILOT_CONTEXT_MODE=full|thin|auto`
  - Default is `auto` when warm start is enabled (thin context only for warm-resumed `ORCHESTRATOR_UPDATE`).
- Compact orchestrator → autopilot digests:
  - `AGENTIC_ORCH_AUTOPILOT_DIGEST_MODE=compact|verbose` (default: compact)
- Optional orchestrator → Daddy digests (operator visibility only):
  - `AGENTIC_ORCH_FORWARD_TO_DADDY=0|1` (default: `0`)
  - `AGENTIC_ORCH_DADDY_DIGEST_MODE=compact|verbose` (default: compact)
- Optional autopilot digest fast-path (zero-token) for allowlisted `ORCHESTRATOR_UPDATE` sources:
  - `AGENTIC_AUTOPILOT_DIGEST_FASTPATH=1`
  - `AGENTIC_AUTOPILOT_DIGEST_FASTPATH_ALLOWLIST="TASK_COMPLETE:STATUS,..."` (default: empty; safe rollout requires care)
- Isolate Codex internal state/index (mitigates cross-project “rollout path missing” spam):
  - `AGENTIC_CODEX_HOME_MODE=agent|cockpit`

## Engines
Engine defaults depend on how cockpit is launched:

- Direct cockpit launch (`bash scripts/tmux/cockpit.sh up`): workers default to **exec** (`codex exec`) for maximum compatibility.
- Valua adapter launch (`adapters/valua/run.sh`): defaults to **app-server** with strict autopilot gate profile (`delegate/self-review/session-scope/commit-scope` defaults enabled).

To enable the **app-server engine** (recommended for “update/interrupt” workflows):
- `export AGENTIC_CODEX_ENGINE=app-server`

Both engines support AgentBus task updates (`agent-bus update`). With app-server enabled, updates translate to `turn/interrupt` and then continue the **same thread**; with exec they restart the process and resume the session id when possible.

Autopilot sandbox policy:
- By default, `daddy-autopilot` runs with `danger-full-access` sandbox in both engines (needed for deploy/test workflows that touch paths outside repo roots).
- Set `AGENTIC_AUTOPILOT_DANGER_FULL_ACCESS=0` (or `VALUA_AUTOPILOT_DANGER_FULL_ACCESS=0`) to force autopilot back to `workspace-write`.

## Metrics (Rollouts)
To quantify token burn by agent/kind from `~/.codex/sessions/**/rollout-*.jsonl`:

```bash
node scripts/rollout-metrics.mjs --help
```

## License
Apache-2.0. See `LICENSE`.
