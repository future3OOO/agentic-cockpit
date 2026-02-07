# Agentic Workflow Visuals

These Mermaid diagrams reflect the current cockpit runtime (tmux + AgentBus + workers) and are intended for quick onboarding.

## Runtime Topology

```mermaid
flowchart LR
  User[Operator] --> Chat[Daddy Chat\ninteractive codex chat]
  Chat -->|USER_REQUEST| Bus[(AgentBus)]
  Bus -->|inbox/daddy-autopilot| Auto[Daddy Autopilot]

  subgraph Workers[Exec workers]
    FE[frontend]
    BE[backend]
    QA[qa]
    INF[infra]
    PR[prediction]
  end

  Auto -->|PLAN_REQUEST / EXECUTE / REVIEW followUps| Bus
  Bus -->|dispatch to worker inbox| FE
  Bus -->|dispatch to worker inbox| BE
  Bus -->|dispatch to worker inbox| QA
  Bus -->|dispatch to worker inbox| INF
  Bus -->|dispatch to worker inbox| PR

  FE -->|close + receipt| Bus
  BE -->|close + receipt| Bus
  QA -->|close + receipt| Bus
  INF -->|close + receipt| Bus
  PR -->|close + receipt| Bus

  Bus -->|TASK_COMPLETE| Orch[Orchestrator]
  Orch -->|ORCHESTRATOR_UPDATE\ncompact (default)| Bus
  Bus -->|inbox/daddy-autopilot| Auto

  Orch -->|optional human digest\n(default off)| Bus
  Bus -->|inbox/daddy| Inbox[Daddy Inbox Listener]
  Inbox -->|human prompts for update| Chat
```

## Plan → Execute → Review Loop

```mermaid
sequenceDiagram
  participant U as User
  participant C as Daddy Chat
  participant B as AgentBus
  participant A as Autopilot
  participant W as Worker Agent (frontend/backend/qa/infra/prediction)
  participant O as Orchestrator

  U->>C: "Implement X"
  C->>B: USER_REQUEST
  B->>A: deliver USER_REQUEST
  A->>B: send PLAN_REQUEST followUp
  B->>W: deliver PLAN_REQUEST
  W->>B: close + planMarkdown
  B->>O: auto-send TASK_COMPLETE
  O->>B: send ORCHESTRATOR_UPDATE
  B->>A: deliver ORCHESTRATOR_UPDATE
  A->>B: send EXECUTE followUp
  B->>W: deliver EXECUTE
  W->>B: close + commitSha
  B->>O: auto-send TASK_COMPLETE
  O->>B: send ORCHESTRATOR_UPDATE
  B->>A: deliver ORCHESTRATOR_UPDATE
  A->>B: send followUps (review/closeout)
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
