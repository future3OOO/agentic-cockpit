---
name: cockpit-skillops
description: "Run SkillOps (debrief -> distill -> lint) so cockpit skills continuously learn from real task outcomes."
version: 1.0.0
tags:
  - cockpit
  - skillops
---

# Cockpit SkillOps

## When to use
- After completing a meaningful task or slice.
- Before reporting final `outcome="done"` for autopilot tasks that require SkillOps evidence.

## Required sequence
1. `node scripts/skillops.mjs debrief --skills <skill-a,skill-b> --title "What changed"`
   Fast path when the learning is already clear:
   `node scripts/skillops.mjs debrief --skills <skill-a,skill-b> --skill-update "skill-a:1-line rule" --title "What changed"`
2. `node scripts/skillops.mjs distill`
3. `node scripts/skillops.mjs lint`

## Evidence contract
- Include all three commands in `testsToRun`.
- Include the debrief log markdown path in `artifacts` (under `.codex/skill-ops/logs/...`).
- Do not pretend a worker-side learned heuristic is durable until the controller integrates the resulting skill/runbook changes onto the real target branch.

## Learned heuristics (SkillOps)
<!-- SKILLOPS:LEARNED:BEGIN -->
<!-- SKILLOPS:LEARNED:END -->
