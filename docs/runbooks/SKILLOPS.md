# SkillOps

## Intent
Continuously improve skill instructions based on real execution outcomes.

## Basic cycle
1. Capture what changed and what failed.
2. Distill reusable rules into skills/runbooks.
3. Keep instructions concise and operational.
4. Prefer stable policy in runbooks, tactical guidance in skill files.

## CLI
- `node scripts/skillops.mjs debrief --skills <skill-a,skill-b> --title "What changed"`
- `node scripts/skillops.mjs distill`
- `node scripts/skillops.mjs lint`
