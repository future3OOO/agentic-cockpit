---
name: cockpit-pr-review-closure-gate
description: "Hard gate for PR feedback loops: fix, ask re-check, then resolve only after verified closure."
version: 1.0.0
tags:
  - cockpit
  - pr
  - review
  - governance
---

# Cockpit PR Review Closure Gate

Use this skill when processing review feedback from bots or humans.

## Gate
- Do not claim done while actionable PR feedback remains open.
- Do not resolve review threads immediately after pushing a fix.
- Do not appease reviewers with thread-by-thread wording hacks, curve-fit patches, or fake-green fixture rewrites.

## Before fixing a review comment
1. Apply the canonical review-comment doctrine in `AGENTS.md` on current `HEAD`.
2. Classify the comment:
- real bug
- hardening concern
- nit/doc-only
- stale/wrong
3. Check whether the proposed fix would break valid operator/task phrasing or packet shapes nearby.
4. Only then patch and reply.

## Required sequence
1. Push fix commit.
2. Reply with commit SHA and precise change summary.
3. Ask reviewer/bot to re-check.
4. Keep thread open while verification is pending.
5. Resolve only after acknowledgement or clean rerun with no equivalent unresolved finding.

## Verification checklist
- Unresolved review threads count is zero.
- PR checks are green.
- No actionable PR conversation comments remain.

## Merge completion note contract
- When you actually merge a PR, the task completion `note` must include a canonical merge line:
  - `Merged PR<NUMBER> (<PR_URL>) on <ISO_TIMESTAMP> via merge commit <COMMIT_SHA>.`
- If merge was requested but not performed, state it explicitly in `note` (for example: `PR<NUMBER> not merged`).

## Learned heuristics (SkillOps)
<!-- SKILLOPS:LEARNED:BEGIN -->
<!-- SKILLOPS:LEARNED:END -->
