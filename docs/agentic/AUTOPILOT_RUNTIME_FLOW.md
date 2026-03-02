# Daddy Autopilot Runtime Flow (Implementation-Aligned)

This document captures the runtime controller loop used by cockpit mode, especially for the Valua adapter pattern.

It is implementation-aligned with:
- `scripts/agent-orchestrator-worker.mjs`
- `scripts/agent-codex-worker.mjs`
- `docs/agentic/agent-bus/PROTOCOL.md`
- project-local autopilot/chat skills (for example Valua `.codex/skills/**`)

## Runtime Flow

```mermaid
flowchart LR
  U[User] --> DC[Daddy Chat IO]
  DC -- USER_REQUEST --> AB[(AgentBus)]
  AB --> AP[Daddy Autopilot]

  AP -- followUp PLAN_REQUEST or EXECUTE --> AB
  AB --> WK[Worker Agent]
  WK -- TASK_COMPLETE plus receipt --> AB
  AB --> OR[Daddy Orchestrator]
  OR -- ORCHESTRATOR_UPDATE --> AB
  AB --> AP

  AP --> RG{Review gate required}
  RG -- no --> OC{Opus consult required}
  RG -- yes --> RS[Run built-in review start]
  RS --> OC
  OC -- no --> ACT[Process digest and decide next action]
  OC -- advisory warn/pass --> ACT
  OC -- gate block --> BLOCK[Outcome blocked or needs_review and corrective followUps]

  ACT --> IG{Integration preflight applicable}
  IG -- no blocked_scope_mismatch or conflict --> BLOCK[Outcome blocked or needs_review and corrective followUps]
  IG -- yes integrated --> PR[PR CI and reviewer loop]

  PR --> HC{Hard closure blockers present}
  HC -- yes --> BLOCK
  HC -- no --> ST[Deploy exact integrated head SHA to staging and smoke]

  ST --> PA{Explicit approval for prod deploy}
  PA -- yes --> PD[Deploy to production and smoke]
  PD --> DONE[Outcome done]
  PA -- no --> WAIT[Outcome needs_review awaiting prod approval]

  BLOCK --> AP
  WAIT --> AP
```

## Behavioral Notes

- Review gate applies to successful `TASK_COMPLETE:EXECUTE` digests with a reviewable `commitSha`.
- Opus consult behavior is mode-driven: `advisory` is non-blocking consultant input, `gate` can block on consult failure.
- Integration preflight runs before closure and can block on scope mismatch/conflict.
- Hard closure blocks include unresolved review findings/threads and missing deploy verification evidence.
- Production deploy remains gated by explicit human approval.
