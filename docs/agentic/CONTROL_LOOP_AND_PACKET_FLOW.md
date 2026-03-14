# Control Loop and Packet Flow

This is the implementation-aligned loop for AgentBus, orchestrator, autopilot, workers, observers, and dashboard APIs.
Primary code lives in `scripts/lib/agentbus.mjs`, `scripts/agent-bus.mjs`, `scripts/agent-orchestrator-worker.mjs`, `scripts/agent-codex-worker.mjs`, `scripts/observers/watch-pr.mjs`, and `scripts/dashboard/server.mjs`.

## High-Level Topology

```mermaid
flowchart TB
  User --> DaddyChat
  DaddyChat -->|USER_REQUEST| AgentBus
  AgentBus -->|deliver| Autopilot
  Autopilot -->|OPUS_CONSULT_REQUEST| AgentBus
  AgentBus --> OpusConsult
  OpusConsult -->|OPUS_CONSULT_RESPONSE| AgentBus
  AgentBus --> Autopilot
  Autopilot -->|followUps PLAN/EXECUTE/REVIEW| AgentBus
  AgentBus --> Worker
  Worker -->|TASK_COMPLETE + receipt| AgentBus
  AgentBus --> Orchestrator
  Orchestrator -->|ORCHESTRATOR_UPDATE| AgentBus
  AgentBus --> Autopilot
  GitHub -->|review threads/comments| Observer
  Observer -->|REVIEW_ACTION_REQUIRED| AgentBus
```

## AgentBus Data Model

Bus layout and packet semantics live in `docs/agentic/agent-bus/PROTOCOL.md`.
The runtime operations are still the same:
- write/validate: `validateTaskMeta`, `writeTaskFile`, `deliverTask`
- open/update/claim: `openTask`, `updateTask`, `claimTask`
- close/receipt/status: `closeTask`, `writeReceipt`, `listInboxTasks`, `statusSummary`, `recentReceipts`

## Task Lifecycle

State transition model:
1. Packet created in `new`
2. Listener/worker open moves to `seen`
3. Worker claims to `in_progress`
4. Worker closes to `processed`
5. Receipt written in `receipts/<agent>`
6. Optional `TASK_COMPLETE` auto-notify sent to orchestrator

Failure-safe behavior:
- suspicious content policy (`block|warn|allow`) is enforced before packet emission
- `update` rejects updates to already `processed` packets

## Packet Kinds and Semantics

Common `signals.kind` values:
- `USER_REQUEST`: user-originated work request
- `PLAN_REQUEST`: plan-only generation request
- `EXECUTE`: implementation work request
- `TASK_COMPLETE`: completion notice emitted by close path
- `ORCHESTRATOR_UPDATE`: digest packet from orchestrator
- `REVIEW_ACTION_REQUIRED`: observer alert from PR feedback
- `OPUS_CONSULT_REQUEST`: autopilot consult request to `opus-consult`
- `OPUS_CONSULT_RESPONSE`: consult response returned to autopilot

Operational rule:
- `TASK_COMPLETE` and `ORCHESTRATOR_UPDATE` are control-plane signals; they are not direct proof that PR review closure is complete.

## Orchestrator Behavior

Implemented in `scripts/agent-orchestrator-worker.mjs`.

Core responsibilities:
1. Consume orchestrator inbox packets
2. Parse `TASK_COMPLETE` and observer alerts
3. Build compact/verbose digest
4. Forward digest to autopilot
5. Optionally forward digest to daddy chat inbox
6. Coalesce duplicate observer digests for same PR root

Review-gate signal derivation:
- `buildReviewGateSignals` only enables review gate when:
  - source packet kind is `TASK_COMPLETE`
  - completed task kind is `EXECUTE`
  - receipt outcome is `done`
  - receipt has reviewable `commitSha`

That prevents non-reviewable/failed completions from incorrectly entering mandatory review mode.

## Worker Behavior (Codex Worker)

Implemented in `scripts/agent-codex-worker.mjs`.

Primary loop:
1. poll inbox for task ids
2. open + claim
3. construct prompt/context/gates
4. execute via persistent `codex app-server`
5. parse output (model output + consult gate outputs)
6. validate quality/review/evidence gates
7. dispatch follow-ups
8. close task with receipt

Critical gates in runtime:
- review-fix freshness preflight for observer-driven `phase=review-fix` and freshness-carrying `phase=blocked-recovery` turns; this runs before Opus consult and digest fast-path side effects
- built-in review gate (for review-required digests and explicit review requests)
- SkillOps gate (configurable by task kind)
- code-quality gate (configurable by task kind)
- observer-drain gate (ensures no sibling unresolved observer packets for same root when required)
- task git preflight contract (`references.git` checks and branch alignment)
- Opus pre-exec consult gate (can block execution before Codex turn)
- Opus post-review consult gate (can block `done` closure after output validation)

Key safety mechanics:
- per-agent single-writer lock to avoid duplicate worker concurrency
- app-server session/thread persistence under bus `state/`
- preflight dirty-worktree handling (auto-clean policy toggles)
- freshness lookup failures remain fail-open and are recorded as warning evidence instead of fabricating stale state

Opus consult semantics:
- default protocol mode is freeform-only (`AGENTIC_OPUS_PROTOCOL_MODE=freeform_only`):
  - freeform analysis stage only (runtime synthesizes advisory payload for autopilot gate handling)
- optional dual-pass mode (`AGENTIC_OPUS_PROTOCOL_MODE=dual_pass`):
  - freeform analysis stage (stream-visible markdown)
  - strict contract stage (schema-validated response payload)
- rollback mode: `AGENTIC_OPUS_PROTOCOL_MODE=strict_only`
- consult rounds continue only when Opus explicitly returns `reasonCode=opus_consult_iterate` with `final=false`
- `reasonCode=opus_human_input_required` blocks task progression and surfaces required questions for user input
- insufficient-context reason codes are rejected by consult schema/runtime validation

## Observer Behavior

Implemented in `scripts/observers/watch-pr.mjs`.

Per cycle:
1. list open PRs (optionally filtered by explicit list and min PR)
2. query unresolved review threads
3. query issue comments
4. emit task packets for new unresolved threads
5. emit comment-based tasks when comment text passes actionable filters
6. persist observer watermark state (`lastSeenIssueCommentId`, seen thread ids)

Freshness snapshot emitted on review-fix tasks:
- `references.pr.headRefOid`
- `references.pr.headRefName`
- thread packets: `references.thread.lastCommentId`, `references.thread.lastCommentCreatedAt`, `references.thread.lastCommentUpdatedAt`
- actionable comment packets: `references.comment.updatedAt`, `references.comment.bodyHash`

Runtime consequence:
- orchestrator forwards that source payload unchanged under `references.sourceReferences`
- observer re-emits same-id review-fix work when freshness changed since `lastScanAt`
- worker revalidates freshness before git preflight, Codex, or blocked-recovery planning
- stale review-fix work closes `skipped`, not `blocked`

Current caveat:
- comment watermark still advances to max seen id each cycle, so a non-actionable classification can suppress future emission for that comment id

## Dashboard API Integration

Implemented in `scripts/dashboard/server.mjs`.

API responsibilities:
- snapshot status view of bus + roster
- send/update/cancel task operations
- SSE event stream for UI updates

Important: dashboard APIs call the same AgentBus runtime functions; there is no separate state authority.

## Valua Adapter Integration

Adapter bootstrap wires defaults and runtime mode:
- `adapters/valua/run.sh`: default env profile (app-server, gates, policy sync, bus/worktrees)
- `adapters/valua/restart-master.sh`: deterministic runtime worktree reset/repin/reset-state flow

Full adapter mechanics are in `docs/agentic/VALUA_ADAPTER_RUNTIME.md`.

## Completion and Closure Contracts

A task is only done when all required gates for that task kind pass and closure evidence is present.

Autopilot-specific closure constraints:
- do not treat observer+review feedback as complete until review-action queue is drained for the root
- do not claim merge-readiness solely from thread resolution toggles without required verification path

## Practical Debugging Checklist

When behavior looks wrong:
1. `node scripts/agent-bus.mjs open-tasks --root-id <ROOT>`
2. `node scripts/agent-bus.mjs recent --limit 50`
3. inspect `state/pr-observer/*.json`
4. inspect tmux panes
5. verify roster/workdirs/env (`AGENTIC_*`, `VALUA_*`)
