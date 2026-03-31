# Agentic Cockpit Blueprint

This blueprint defines the baseline architecture for a cockpit-driven project.

## Core roles
- `daddy`: human I/O front-end.
- `orchestrator`: deterministic completion/alert forwarder.
- `autopilot`: controller that dispatches follow-ups.
- worker agents: execution specialists (frontend/backend/qa/etc).

## Control loop
1. User request enters via Daddy Chat and is queued to AgentBus.
2. Autopilot triages and emits PLAN/EXECUTE/REVIEW follow-ups.
3. Workers close tasks with receipts.
4. Orchestrator forwards compact updates to autopilot.
5. Autopilot iterates until acceptance criteria are met.

Implementation-aligned runtime diagram:
- `docs/agentic/AUTOPILOT_RUNTIME_FLOW.md`

## Governance gates
- Review closure gate: no done state while PR feedback is still actionable.
- Writer preflight gate: preflight-required code turns must finish no-write preflight before tracked edits start.
- Review-fix freshness gate: observer-driven review-fix work must still match live PR/thread/comment state before autopilot spends a turn on it; stale work closes `skipped`.
- Verification gate: changed code must pass project checks.
- Continuity gate: maintain `.codex/CONTINUITY.md` for compact-safe state.
- Opus consult gate mode is explicit: `advisory` is non-blocking consultant input, `gate` is fail-closed enforcement.
- SkillOps gate is two-stage:
  - evidence gate: `debrief -> distill -> lint`
  - durable handoff gate: empty logs retire locally; non-empty learnings queue one runtime-owned promotion lane from the portable v4 plan (`sourceLogs[]`, `targets[]`, `items[]`)
  - queued SkillOps logs are non-blocking local evidence until runtime marks them processed
- Controller-housekeeping gate is runtime-owned:
  - only pure controller-owned recoverable cross-root dirt routes here
  - runtime suspends the blocked task, moves focus to a synthetic housekeeping root, and replays the stored task snapshot only after verified cleanup
  - raw SkillOps planning for housekeeping runs in a clean scratch worktree at `HEAD`, and queued logs remain retained non-blocking evidence

## Branching model
- Root workflow branch: `slice/<rootId>`.
- Per-agent work branch: `wip/<agent>/<rootId>` or project equivalent.
- SkillOps promotion branch: `skillops/<controllerAgent>/<rootId>` from the repo default branch, executed in a shared curation worktree.
- Protected branch merges remain human approved.
