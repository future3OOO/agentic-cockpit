# Worktrees and Branching

## Goals
- Isolate agents to avoid index/working-tree collisions.
- Keep branch lineage auditable.

## Defaults
- One stable worktree per agent.
- Reuse agent branches for follow-ups in the same workflow.

## Rules
- Do not run two worktrees on the same branch at once.
- Use root-scoped branch naming for traceability.
- Avoid destructive git operations in active worktrees.
