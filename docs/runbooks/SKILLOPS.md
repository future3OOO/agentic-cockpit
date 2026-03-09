# SkillOps

## Intent
Continuously improve skill instructions based on real execution outcomes.

## Basic cycle
1. Capture what changed and what failed.
2. Distill reusable rules into skills/runbooks.
3. Keep instructions concise and operational.
4. Prefer stable policy in runbooks, tactical guidance in skill files.
5. Treat worker-side SkillOps edits as branch-local until the controller promotes them onto the real integration/PR branch.

## CLI
- `node scripts/skillops.mjs debrief --skills <skill-a,skill-b> --title "What changed"`
- Fast path when the learning is already obvious:
  - `node scripts/skillops.mjs debrief --skills <skill-a,skill-b> --skill-update "skill-a:1-line rule" --title "What changed"`
- `node scripts/skillops.mjs distill`
- `node scripts/skillops.mjs lint`

## Ownership
- Workers may capture learnings during execution.
- The controller/autopilot owns durable curation:
  - decide whether a learned rule is stable enough to promote,
  - integrate shared skill/runbook edits onto the active PR/integration branch,
  - avoid leaving branch-local SkillOps churn as fake project memory.
