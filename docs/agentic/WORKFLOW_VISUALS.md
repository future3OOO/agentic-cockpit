# Agentic Workflow Visuals

These Mermaid diagrams reflect the current cockpit runtime (tmux + AgentBus + workers) and are intended for quick onboarding.

## Runtime Topology

```mermaid
flowchart LR
  User[Operator] --> Chat[Daddy Chat\ninteractive codex chat]
  Chat -->|USER_REQUEST| Bus[(AgentBus)]
  Bus -->|new/seen/in_progress| Workers[Exec Workers\nfrontend/backend/qa/infra/prediction]
  Workers -->|receipt + TASK_COMPLETE| Orch[Orchestrator]
  Orch -->|ORCHESTRATOR_UPDATE\ncompact by default| Auto[Autopilot]
  Orch -->|ORCHESTRATOR_UPDATE\noptional (disabled by default)| Inbox[Daddy Inbox Listener]
  Auto -->|followUps| Bus
  Inbox --> Chat
```

## Plan → Execute → Review Loop

```mermaid
sequenceDiagram
  participant U as User
  participant C as Daddy Chat
  participant B as AgentBus
  participant A as Autopilot
  participant W as Worker Agent
  participant O as Orchestrator

  U->>C: "Implement X"
  C->>B: USER_REQUEST
  B->>A: task in inbox
  A->>B: PLAN_REQUEST -> worker
  B->>W: plan task
  W->>B: close + planMarkdown
  B->>O: TASK_COMPLETE
  O->>A: ORCHESTRATOR_UPDATE
  A->>B: EXECUTE -> worker
  B->>W: execute task
  W->>B: close + commitSha
  B->>O: TASK_COMPLETE
  O->>A: ORCHESTRATOR_UPDATE
  A->>B: followUps (review/closeout)
```

## Token Burn Control Path

```mermaid
flowchart TD
  Start[Worker receives task] --> Engine{AGENTIC_CODEX_ENGINE}
  Engine -->|exec| Exec[codex exec]
  Engine -->|app-server| App[codex app-server turn/start]
  App --> Warm{AGENTIC_CODEX_WARM_START=1?}
  Warm -->|yes| Thin[Thin context on warm ORCHESTRATOR_UPDATE\nAGENTIC_AUTOPILOT_CONTEXT_MODE=auto]
  Warm -->|no| Full[Full context]
  Thin --> Digest{Digest source allowlisted?}
  Digest -->|yes + fastpath| Skip[No model run for digest]
  Digest -->|no| Run[Normal model run]
  Full --> Run
  Exec --> Run
```
