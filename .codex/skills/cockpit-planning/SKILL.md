---
name: cockpit-planning
description: "Planning-only skill: produce a dependency-aware plan and acceptance criteria; do not commit."
version: 1.0.0
tags:
  - cockpit
  - planning
---

# Cockpit Planning

You are producing a plan for an Agentic Cockpit task.

## Rules
- Planning tasks must not make commits.
- Be explicit about acceptance criteria, sequencing, and validation commands.
- Keep the plan small and testable (few steps, clear checkpoints).
- If the plan will lead to `EXECUTE` work, include a “Git Contract” note (base sha + work branch naming) so the controller can dispatch deterministically.
- Planning is upstream quality work, not paperwork. If the plan shapes cockpit runtime code, worker behavior, routing, cleanup, or contracts, apply `cockpit-code-quality-gate` and `code-quality` during planning.
- That means the plan must be written against production-quality constraints from the start:
  - smallest correct path
  - no duplicate logic
  - deterministic cleanup
  - fail-closed behavior
  - coupled downstream docs/tests/contracts updated in the same implementation slice
- This applies both in explicit planning mode and when you are planning inside an execution turn before editing code.

## Output contract
Return **only** JSON matching the worker output schema.
- Put the plan in `planMarkdown` as a numbered list.
- Leave `commitSha` empty.
- Populate `testsToRun` with the commands the executor should run.
- If runtime code is in scope, the plan must include the specific verification and quality-gate commands the executor will run.

## Learned heuristics (SkillOps)
<!-- SKILLOPS:LEARNED:BEGIN -->
<!-- SKILLOPS:LEARNED:END -->
