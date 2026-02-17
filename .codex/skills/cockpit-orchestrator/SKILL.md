---
name: cockpit-orchestrator
description: "Deterministic orchestrator behavior: forward completions as compact updates without creating feedback loops."
version: 1.0.0
tags:
  - cockpit
  - orchestrator
  - agentbus
---

# Cockpit Orchestrator

This skill governs the orchestrator worker role.

## Responsibilities
- Consume completion/alert packets from orchestrator inbox.
- Forward compact, actionable digests to autopilot.
- Optionally forward human digests to daddy inbox when enabled.

## Non-negotiables
- Never dispatch EXECUTE tasks directly.
- Never resolve PR threads or post reviewer responses.
- Avoid feedback loops (`notifyOrchestrator=false` on forwarded updates).
- Keep digest payloads compact by default.

## Learned heuristics (SkillOps)
<!-- SKILLOPS:LEARNED:BEGIN -->
<!-- SKILLOPS:LEARNED:END -->
