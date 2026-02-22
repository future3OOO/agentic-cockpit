---
name: cockpit-code-quality-gate
description: "Thin production quality gate: enforce anti-bloat discipline, deterministic cleanup evidence, and skill frontmatter checks before closure."
version: 1.0.0
tags:
  - cockpit
  - quality
  - cleanup
---

# Cockpit Code Quality Gate

## When to use
- Any task that returns `outcome="done"` across `USER_REQUEST`, `ORCHESTRATOR_UPDATE`, `EXECUTE`, or `PLAN_REQUEST`.

## Non-negotiables
- Prefer the smallest correct change. Remove dead code instead of layering wrappers.
- Do not duplicate logic when a shared path already exists.
- Keep data flow minimal: remove unnecessary hops, shells, and retries.
- Handle real boundary failures, not internal "just in case" noise.

## Cleanup contract
- Ensure temporary artifacts are cleaned up at startup, before new work, and after completion.
- If cleanup cannot be performed safely, return `needs_review`/`blocked` with exact reason.

## Required evidence before `done`
- Run: `node scripts/code-quality-gate.mjs check --task-kind <KIND>`
- Runtime enforcement is authoritative. The worker runs this gate and blocks `outcome="done"` on failure.
- Generated report files under `.codex/quality/logs/` are for audit and are optional to include in model output.

## Composition rule
- Use this skill as a thin gate only.
- Keep language-specific constraints in dedicated skills (TS/Python quality policies), and learning flow in SkillOps skills.

## Learned heuristics (SkillOps)
<!-- SKILLOPS:LEARNED:BEGIN -->
<!-- SKILLOPS:LEARNED:END -->
