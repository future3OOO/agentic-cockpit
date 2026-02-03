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

The orchestrator (a small deterministic worker) forwards compact digests to Daddy's inbox.

### Autopilot (optional)

If `ROSTER.json` defines `autopilotName` (default: `daddy-autopilot`), the orchestrator also forwards digests (completions + observer events) to the autopilot inbox as `ORCHESTRATOR_UPDATE`.

The autopilot runs as a background Codex worker and emits `followUps[]` in its worker output; the Codex worker runtime dispatches those follow-ups onto AgentBus automatically.

Orchestrator digests set `signals.notifyOrchestrator=false` so closing digest packets does not create `TASK_COMPLETE` feedback loops.

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
