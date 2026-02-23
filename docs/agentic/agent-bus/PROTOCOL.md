# AgentBus Protocol

This repository uses a **file-backed AgentBus** so multiple agents (and a user-facing "Daddy" chat) can coordinate work without copy/paste.

The bus is designed for *transparency* and *auditability*:

- Every task is a Markdown "packet" with JSON frontmatter.
- Every completion produces a JSON receipt.
- No hidden state; everything is plain files on disk.

## Bus layout

Bus root: `${AGENTIC_BUS_DIR:-$HOME/.agentic-cockpit/bus}` (Valua compatibility: `VALUA_AGENT_BUS_DIR`)

```
agent-bus/
  inbox/<agent>/
    new/        # unread tasks
    seen/       # acknowledged (opened by a listener/worker)
    in_progress/ # claimed by a worker (actively being processed)
    processed/  # closed tasks
  receipts/<agent>/
    <taskId>.json
  artifacts/<agent>/
    <taskId>.*   # optional worker artifacts (Codex output, logs)
  state/
    <agent>.json # optional agent state snapshots (best-effort; for continuity/ops)
  deadletter/<agent>/
```

Notes:
- `agent-listen` moves packets from `new/` → `seen/` (acknowledged for humans).
- Execution workers claim packets by moving them into `in_progress/` while they run, then close them into `processed/` with a receipt.

## Task packet format

A task packet is a Markdown file named `<taskId>.md` with JSON frontmatter:

```md
---
{
  "id": "msg_20260125T123000Z_ab12cd",
  "to": ["frontend"],
  "from": "daddy",
  "priority": "P2",
  "title": "Plan: implement X",
  "signals": {
    "kind": "PLAN_REQUEST",
    "phase": "plan",
    "rootId": "root_...",
    "parentId": null,
    "smoke": false
  },
  "references": {
    "contextPath": "docs/..."
  }
}
---

Task body (freeform Markdown)
```

### Required frontmatter fields

- `id` — safe filename id (letters/digits + `._-`)
- `to` — array of agent names
- `from` — sender agent name
- `priority` — human priority label (e.g. `P0..P3`)
- `title` — short subject line

### Signals

`signals` is an optional object used for workflow automation.

Canonical values:

- `signals.kind`:
  - `USER_REQUEST` — user request routed through Daddy
  - `PLAN_REQUEST` — ask an agent to produce a plan only
  - `PLAN_RESPONSE` — plan returned (often via receiptExtra.planMarkdown)
  - `EXECUTE` — perform the work and commit/push
  - `TASK_COMPLETE` — auto-generated completion notice
  - `REVIEW_ACTION_REQUIRED` — observer alert for unresolved PR feedback
  - `ORCHESTRATOR_UPDATE` — orchestrator digest to Daddy

- `signals.phase` (optional): a lightweight state-machine hint. Common values:
  - `plan` | `revise-plan`
  - `execute`
  - `review` | `review-fix`
  - `notify`
  - `closeout`

- `signals.rootId`: a stable id that ties together a full multi-step workflow.
- `signals.parentId`: the immediate parent packet id (threading).

## Git Contract (recommended)

To prevent “stale branch” regressions and make follow-ups resumable, code-changing tasks should include a canonical git contract under `references.git`.

### `references.git` fields

- `baseBranch` (string, optional): human label for where the work is based (e.g. `main`, `production`, `slice/<rootId>`).
- `baseSha` (string, recommended; **required for branch creation**): commit SHA to base new work from.
- `workBranch` (string, recommended): branch the agent should work on (create-once, then reuse on follow-ups), e.g. `wip/<agent>/<rootId>/<workstream>`.
- `integrationBranch` (string, optional): branch where the controller will integrate work (often `slice/<rootId>`).
- `expectedDeploy` (object, optional): provenance hint for deploy-driven workflows (keep it secret-free).

Example:

```json
"references": {
  "git": {
    "baseBranch": "slice/msg_20260201T205611836Z_d60be2",
    "baseSha": "448ad18fe3d80b02401b239d238d5019708b6faf",
    "workBranch": "wip/frontend/msg_20260131T215351165Z_16fc70/main",
    "integrationBranch": "slice/msg_20260131T215351165Z_16fc70"
  }
}
```

### Worker behavior (V2)

If `references.git.workBranch` is present, `agent-codex-worker` will try to ensure the workdir is on that branch **before** starting Codex:

- If `workBranch` exists: `git checkout <workBranch>`
- If missing: `git checkout -b <workBranch> <baseSha>` (requires `baseSha`)
- If switching branches would discard local changes (dirty tree): task is closed `blocked` with a recovery note.

For autopilot-dispatched `EXECUTE` follow-ups, runtime may normalize branch identity to:
- `wip/<targetAgent>/<rootId>/<workstream>` (default workstream: `main`).

Optional enforcement:
- Set `AGENTIC_ENFORCE_TASK_GIT_REF=1` (Valua compatibility: `VALUA_AGENT_ENFORCE_TASK_GIT_REF=1`) to require `baseSha` + `workBranch` for `signals.kind=EXECUTE`.

## Receipts

Closing a task creates a receipt JSON file:

`receipts/<agent>/<taskId>.json`

Receipts include:

- `outcome` — `done | needs_review | blocked | failed | skipped`
- `note` — short summary for humans
- `commitSha` — if work was committed
- `receiptExtra` — structured data (plans, file lists, tests run, etc.)
- `task` — original task frontmatter (for traceability)

## Completion notifications

When any worker closes a task, AgentBus automatically sends a `TASK_COMPLETE` packet **to the configured orchestrator**.

The orchestrator name is defined in:

`docs/agentic/agent-bus/ROSTER.json` → `orchestratorName`

This prevents the user-facing Daddy chat from missing completions while the user is mid-conversation.

The orchestrator (a small deterministic worker) always forwards digests to autopilot and can optionally forward digests to Daddy's inbox.
By default Daddy forwarding is disabled (`AGENTIC_ORCH_FORWARD_TO_DADDY=0`); when enabled, Daddy digest mode defaults to compact (`AGENTIC_ORCH_DADDY_DIGEST_MODE=compact`).
Autopilot digest mode defaults to compact (`AGENTIC_ORCH_AUTOPILOT_DIGEST_MODE=compact`).

### Autopilot (optional)

If `ROSTER.json` defines `autopilotName` (fallback default: `autopilot`), the orchestrator also forwards digests (completions + observer events) to the autopilot inbox as `ORCHESTRATOR_UPDATE`.

The autopilot runs as a background Codex worker and emits `followUps[]` in its worker output; the Codex worker runtime dispatches those follow-ups onto AgentBus automatically.

Orchestrator digests set `signals.notifyOrchestrator=false` so closing digest packets does not create `TASK_COMPLETE` feedback loops.

For `TASK_COMPLETE` digests sourced from worker `EXECUTE` tasks, orchestrator marks:
- `signals.reviewRequired=true`
- `signals.reviewTarget={sourceTaskId,sourceAgent,sourceKind,commitSha,receiptPath,repoRoot}`
- `signals.reviewPolicy={mode:"codex_builtin_review",mustUseBuiltInReview:true,requireEvidence:true,maxReviewRetries:1}`

Autopilot must satisfy this review gate before closure decisions:
- run built-in `/review`
- emit structured `review` evidence in worker output
- dispatch corrective `followUps` when verdict is `changes_requested`

The tmux launcher (`scripts/tmux/agents-up.sh`) auto-starts `scripts/observers/watch-pr.mjs` by default. That observer turns unresolved PR review feedback into `REVIEW_ACTION_REQUIRED` packets for the orchestrator/autopilot loop. Default cold start mode is `baseline`, which seeds state without replaying old backlog on first run. You can constrain monitored PR range with `AGENTIC_PR_OBSERVER_MIN_PR`.

## PR review closure policy (required)

When a task involves fixing PR feedback:

1) Push a fix commit first.
2) Reply on the thread with the commit SHA and a short "what changed".
3) Ask reviewer/bot to re-check.
4) Keep the thread open while verification is pending.
5) Resolve the thread only after one of:
   - explicit reviewer/bot acknowledgement, or
   - a completed rerun/check cycle with no equivalent unresolved finding.

Notes:
- Thread resolution is a state toggle, not proof of correctness.
- `TASK_COMPLETE` / `ORCHESTRATOR_UPDATE` packets do not imply review closure.
- For human reviewer threads, prefer reviewer-owned resolution unless explicitly delegated.

## CLI

Common commands:

- Initialize bus directories:

```bash
node scripts/agent-bus.mjs init
```

- Send a packet from a Markdown file:

```bash
node scripts/agent-bus.mjs send path/to/task.md
```

- Send a packet from the CLI (no copy/paste for the user; Daddy uses this internally):

```bash
node scripts/agent-bus.mjs send-text \
  --to frontend \
  --title "Plan: implement X" \
  --kind PLAN_REQUEST \
  --phase plan \
  --body "Please produce a plan using $valua-planning."
```

- Open a packet:

```bash
node scripts/agent-bus.mjs open --agent frontend --id <taskId>
```

- List currently open tasks (across new/seen/in_progress):

```bash
node scripts/agent-bus.mjs open-tasks
node scripts/agent-bus.mjs open-tasks --agent frontend
node scripts/agent-bus.mjs open-tasks --root-id <rootId>
```

- Close a packet:

```bash
node scripts/agent-bus.mjs close --agent frontend --id <taskId> --outcome done --note "..." --commit-sha <sha>
```

## Updating an in-flight task (no new task id)

If you need to add clarification to a task that is already `seen` or `in_progress`, use `update` to append a timestamped update block **without creating a new packet id**:

```bash
node scripts/agent-bus.mjs update \
  --agent frontend \
  --id <taskId> \
  --append "Extra context / correction goes here."
```

Notes:
- `update` refuses to modify `processed/` tasks; create a new task instead.
- Updates are still guarded by the suspicious-text policy (`VALUA_AGENTBUS_SUSPICIOUS_POLICY`).

## Security knobs

AgentBus has a basic "suspicious text" detector to protect against accidental destructive commands in packets.

Configure via:

`VALUA_AGENTBUS_SUSPICIOUS_POLICY=block|warn|allow` (default: `block`)

Legacy override (development only):

`AGENTBUS_ALLOW_SUSPICIOUS=1` (equivalent to `allow`)

This affects `send` and `send-text`.
