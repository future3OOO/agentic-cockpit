# Agentic Workflow Visuals

These diagrams reflect the cockpit implementation in:
- `scripts/tmux/agents-up.sh`
- `scripts/lib/agentbus.mjs`
- `scripts/agent-orchestrator-worker.mjs`

Legend:
- Solid edges: default runtime behavior.
- Dashed edges: optional or project-defined behavior.

## Runtime Topology (Implemented)

```mermaid
flowchart TB
  User["User"] --> DaddyChat["Daddy Chat"]
  DaddyChat -->|USER_REQUEST| Bus["AgentBus"]
  Bus --> Validator["Packet validator"]
  Validator -->|valid| Bus
  Validator -->|invalid| Deadletter["Deadletter queue"]

  subgraph Control["Control plane"]
    Autopilot["Daddy Autopilot"]
    Orchestrator["Orchestrator"]
    DaddyInbox["Daddy Inbox listener"]
  end

  subgraph BundledWorkers["Bundled worker agents"]
    Frontend["frontend worker"]
    QA["qa worker"]
  end

  subgraph ProjectWorkers["Project workers optional"]
    ExtraWorkers["backend infra prediction custom workers"]
  end

  Bus -->|deliver| Autopilot
  Autopilot -->|followUps PLAN EXECUTE REVIEW| Bus

  Bus -->|dispatch| Frontend
  Bus -->|dispatch| QA
  Bus -. project roster .-> ExtraWorkers

  Frontend -->|close + receipt| Bus
  QA -->|close + receipt| Bus
  ExtraWorkers -. close + receipt .-> Bus

  Bus -->|auto TASK_COMPLETE| Orchestrator
  Orchestrator -->|ORCHESTRATOR_UPDATE| Bus
  Bus -->|deliver update| Autopilot

  Orchestrator -. optional digest default off .-> Bus
  Bus -. inbox daddy .-> DaddyInbox
  DaddyInbox -. shown when user requests status .-> DaddyChat
```

## Bundled Roster Agents

```mermaid
flowchart LR
  Roster["Bundled ROSTER.json"] --> Daddy["daddy codex-chat"]
  Roster --> Orch["orchestrator node-worker"]
  Roster --> Auto["autopilot codex-worker"]
  Roster --> FE["frontend codex-worker"]
  Roster --> QA["qa codex-worker"]
```

## Plan Execute Review Courier Loop (Implemented)

```mermaid
sequenceDiagram
  participant U as User
  participant C as Daddy Chat
  participant B as AgentBus
  participant A as Daddy Autopilot
  participant F as frontend worker
  participant O as Orchestrator

  U->>C: Implement X
  C->>B: USER_REQUEST
  B->>A: deliver
  A->>B: PLAN_REQUEST followUp
  B->>F: dispatch PLAN_REQUEST
  F->>B: close + receipt
  B->>O: TASK_COMPLETE auto-generated
  O->>B: ORCHESTRATOR_UPDATE
  B->>A: deliver update
  A->>B: EXECUTE or REVIEW followUp
```

## Project Extension Loop (Optional)

```mermaid
flowchart LR
  AP["Daddy Autopilot"] -->|followUps| Bus["AgentBus"]
  Bus -->|dispatch| W["Worker set from project roster"]
  W -->|commit push PR tasks| GH["GitHub PR"]
  GH --> Gate["PR closure gate"]

  GH --> RB["Review bots and humans"]
  RB -->|review feedback| GH
  Gate -->|pass| Stage["staging verification"]
  Stage -->|promote| Prod["main tag production"]
  Gate -->|fail review fixes required| AP
  Gate -->|fail waiting for resolution| GH

  GH -. observed or manually bridged .-> OBS["External observer or manual alert producer"]
  OBS -. REVIEW_ACTION_REQUIRED and similar .-> Bus

  AP -. optional integration strategy .-> Slice["slice rootId branch"]
  Slice -. optional stage-first release policy .-> GH
```

## Notes

- Bundled roster contains `daddy`, `orchestrator`, `autopilot`, `frontend`, `qa`.
- Additional worker agents are added by project-local roster configuration.
- Advisor panes are optional via `AGENTIC_TMUX_AUTOSTART_ADVISORS`.
- Observer processes are not auto-started by default tmux launcher; observer packets can still enter the bus.
- PR review threads follow a strict closure gate: reply with fix + ask re-check first, then resolve only after verified clean rerun/acknowledgement (`docs/agentic/PR_REVIEW_CLOSURE.md`).
