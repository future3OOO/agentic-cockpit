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

## Output contract
Return **only** JSON matching the worker output schema.
- Put the plan in `planMarkdown` as a numbered list.
- Leave `commitSha` empty.
- Populate `testsToRun` with the commands the executor should run.
