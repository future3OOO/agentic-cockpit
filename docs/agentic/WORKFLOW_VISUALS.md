# Agentic Workflow Visuals

These Mermaid diagrams reflect the full cockpit workflow used in production style operation.

## Full System Architecture

```mermaid
flowchart LR
  subgraph Inputs["Inputs and external signals"]
    User["User"]
    Reviewers["GitHub reviewers and bots<br/>CodeRabbit Copilot Greptile Human"]
    Github["GitHub PR and commits"]
    CI["CI and checks"]
  end

  subgraph Context["Guardrails and slow memory"]
    Charter["AGENTS and runbooks"]
    Decisions["DECISIONS and deploy provenance"]
    Continuity["CONTINUITY ledger"]
    Skills["Skills and SkillOps outputs"]
  end

  subgraph Spine["Coordination spine"]
    Bus["AgentBus"]
    Validator["Packet validator and deadletter"]
  end

  subgraph Control["Control plane"]
    Chat["Daddy Chat"]
    Inbox["Daddy Inbox listener"]
    Auto["Daddy Autopilot"]
    Orch["Orchestrator"]
  end

  subgraph Exec["Execution plane worktrees"]
    FE["Frontend agent worktree"]
    BE["Backend agent worktree"]
    Pred["Prediction agent worktree"]
    QA["QA agent worktree"]
    Infra["Infra agent worktree"]
    Claude["Advisor Claude design only"]
    Gemini["Advisor Gemini design only"]
  end

  subgraph Observe["Background observers"]
    ObsPR["PR observer unresolved threads and conversation"]
    ObsCI["CI observer checks rollup"]
    ObsGit["Git observer commits and branch drift"]
    ObsBus["Bus observer queue and deadletters"]
    ObsDeploy["Deploy observer staging and prod deploy json"]
    ObsDigest["Observer digest summary links only"]
  end

  subgraph Release["Integration and release"]
    Slice["Slice branch scoped by rootId"]
    PR["Slice pull request"]
    Stage["Staging verification and deploy json parity"]
    Prod["Merge to main then tag and deploy"]
    Gate["PR closure gate no unresolved review feedback"]
  end

  subgraph Learn["Learning and curation"]
    SkillOps["SkillOps debrief distill lint"]
    Curate["Daddy curation dedupe and promote"]
  end

  User --> Chat
  Chat -->|USER_REQUEST| Bus
  Bus --> Validator
  Validator -->|valid| Bus
  Validator -->|invalid deadletter| Bus

  Bus -->|deliver| Auto
  Auto -->|PLAN EXECUTE REVIEW followUps| Bus

  Bus -->|dispatch| FE
  Bus -->|dispatch| BE
  Bus -->|dispatch| Pred
  Bus -->|dispatch| QA
  Bus -->|dispatch| Infra
  Bus -->|design task| Claude
  Bus -->|design task| Gemini

  FE -->|close receipt| Bus
  BE -->|close receipt| Bus
  Pred -->|close receipt| Bus
  QA -->|close receipt| Bus
  Infra -->|close receipt| Bus

  Bus -->|TASK_COMPLETE| Orch
  Orch -->|ORCHESTRATOR_UPDATE| Bus
  Bus -->|deliver update| Auto
  Orch -->|optional digest default off| Bus
  Bus -->|deliver| Inbox
  Inbox -->|user asks status| Chat

  Auto -->|accept commits and integrate| Slice
  Slice --> PR
  PR --> Gate
  Gate -->|pass| Stage
  Stage --> Prod

  Reviewers --> Gate
  Github --> ObsPR
  Github --> ObsGit
  CI --> ObsCI
  Bus --> ObsBus
  Stage --> ObsDeploy
  Prod --> ObsDeploy
  ObsPR --> ObsDigest
  ObsCI --> ObsDigest
  ObsGit --> ObsDigest
  ObsBus --> ObsDigest
  ObsDeploy --> ObsDigest
  ObsDigest -->|summary links| Bus
  Bus -->|observer update| Auto

  Prod --> Decisions
  Prod --> Continuity
  Prod --> SkillOps
  SkillOps --> Curate
  Curate --> Skills
  Curate --> Charter

  Charter -.-> Chat
  Charter -.-> Auto
  Decisions -.-> Auto
  Continuity -.-> Auto
  Skills -.-> Auto
```

## Plan → Execute → Review Loop

```mermaid
sequenceDiagram
  participant U as User
  participant C as Daddy Chat
  participant B as AgentBus
  participant A as Daddy Autopilot
  participant W as Worker agent frontend backend qa infra prediction
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
  A->>B: send REVIEW or CLOSEOUT followUps
```

## Worktree PR And Reviewer Closure Loop

```mermaid
flowchart LR
  AP["Autopilot"] -->|dispatch EXECUTE| Bus["AgentBus"]

  subgraph WT["Agent worktrees"]
    FEW["frontend branch and worktree"]
    BEW["backend branch and worktree"]
    QAW["qa branch and worktree"]
    INFW["infra branch and worktree"]
    PRW["prediction branch and worktree"]
  end

  Bus --> FEW
  Bus --> BEW
  Bus --> QAW
  Bus --> INFW
  Bus --> PRW

  FEW -->|commit push receipt| Bus
  BEW -->|commit push receipt| Bus
  QAW -->|commit push receipt| Bus
  INFW -->|commit push receipt| Bus
  PRW -->|commit push receipt| Bus

  Bus -->|TASK_COMPLETE| Orch["Orchestrator"]
  Orch -->|ORCHESTRATOR_UPDATE| Bus
  Bus --> AP

  AP -->|integrate accepted commits| Slice["slice branch rootId"]
  Slice --> PR["GitHub PR"]

  PR --> CR["CodeRabbit"]
  PR --> CP["Copilot reviewer"]
  PR --> GR["Greptile"]
  PR --> HR["Human reviewer"]
  CR -->|threads comments| PR
  CP -->|comments| PR
  GR -->|comments| PR
  HR -->|threads approvals| PR

  PR -->|feedback task source| Bus
  Bus --> Orch
  Orch -->|ORCHESTRATOR_UPDATE| Bus
  Bus --> AP
  AP -->|review fix EXECUTE followUps| Bus
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

Notes:
- Worktrees are default and isolate each worker branch under `AGENTIC_WORKTREES_DIR/<agent>`.
- Orchestrator is a courier lane from `TASK_COMPLETE` and observer alerts into `ORCHESTRATOR_UPDATE`.
- Autopilot is the controller that dispatches tasks, integrates accepted commits, and drives review closure.
- Review bots and human reviewers feed signals into the same closure loop and are not execution workers.
