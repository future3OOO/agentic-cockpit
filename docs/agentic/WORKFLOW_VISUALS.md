# Agentic Workflow Visuals

These diagrams separate what cockpit runtime implements directly vs project-specific optional flows.

- Solid edges: implemented runtime behavior in `scripts/tmux/agents-up.sh`, `scripts/lib/agentbus.mjs`, and `scripts/agent-orchestrator-worker.mjs`.
- Dashed edges: optional flows driven by roster/skills or external producers.

## Runtime Topology (Implemented)

```mermaid
flowchart LR
  User["User"] --> Chat["Daddy Chat"]
  Chat -->|USER_REQUEST| Bus["AgentBus"]
  Bus --> Validator["Packet validator"]
  Validator -->|valid| Bus
  Validator -->|invalid deadletter| Bus

  Bus -->|deliver| Auto["Autopilot worker"]
  Auto -->|followUps PLAN EXECUTE REVIEW| Bus
  Bus -->|dispatch| Workers["Workers from roster kind codex-worker"]

  Workers -->|close and receipt| Bus
  Bus -->|auto TASK_COMPLETE| Orch["Orchestrator worker"]
  Orch -->|ORCHESTRATOR_UPDATE| Bus
  Bus -->|deliver update| Auto

  Orch -. optional digest default off .-> Bus
  Bus -. inbox daddy .-> Inbox["Daddy Inbox listener"]
  Inbox -. user asks status .-> Chat
```

## Plan Execute Review Courier Loop (Implemented)

```mermaid
sequenceDiagram
  participant U as User
  participant C as Daddy Chat
  participant B as AgentBus
  participant A as Autopilot
  participant W as Worker from roster
  participant O as Orchestrator

  U->>C: Implement X
  C->>B: USER_REQUEST
  B->>A: deliver
  A->>B: followUp PLAN_REQUEST
  B->>W: dispatch
  W->>B: close + receipt
  B->>O: TASK_COMPLETE auto-generated
  O->>B: ORCHESTRATOR_UPDATE
  B->>A: deliver update
  A->>B: followUp EXECUTE or REVIEW
```

## Project Extension Loop (Optional)

```mermaid
flowchart LR
  AP["Autopilot"] -->|followUps| Bus["AgentBus"]
  Bus -->|dispatch| W["Workers"]
  W -->|commit push PR tasks| GH["GitHub PR"]

  GH --> RB["Review bots and humans"]
  RB -->|review feedback| GH
  GH -. observed or manually bridged .-> OBS["External observer or manual alert producer"]
  OBS -. REVIEW_ACTION_REQUIRED and similar .-> Bus

  AP -. optional integration strategy .-> Slice["slice rootId branch"]
  Slice -. optional stage-first release policy .-> Stage["staging verify deploy json"]
  Stage -. optional tag-based promotion .-> Prod["main tag production"]
```

## Roster Reality Notes

- Bundled roster currently includes `daddy`, `orchestrator`, `autopilot`, `qa`, and `frontend`.
- Additional workers like backend/infra/prediction appear only when a project roster defines them.
- Advisor panes are optional tmux windows controlled by `AGENTIC_TMUX_AUTOSTART_ADVISORS`.
- Observer processes are not auto-started by default tmux launcher; observer events can still enter via packets.
