# Worktrees and Branching

## Goals
- Isolate agents to avoid index/working-tree collisions.
- Keep branch lineage auditable.

## Defaults
- One stable worktree per agent.
- Reuse agent branches for follow-ups in the same workflow.
- Idle worker worktrees should be repinned back to their roster branch after root closure; stale non-roster branches are runtime reclaim targets, not permanent parking spots.

## Rules
- Do not run two worktrees on the same branch at once.
- Use root-scoped branch naming for traceability.
- Avoid destructive git operations in active worktrees.
