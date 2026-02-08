# Valua -> Cockpit Baseline Mapping

This document tracks how Valua-specific governance has been generalized into cockpit defaults so other projects can bootstrap with similar discipline.

## Scope
- Source baseline: `Valua` roster skills + runbooks.
- Target baseline: generic cockpit bootstrap (`scripts/init-project.mjs`).

## Skills mapping

| Valua skill | Generic cockpit equivalent |
| --- | --- |
| `valua-agentbus` | `cockpit-agentbus` |
| `valua-continuity-ledger` | `cockpit-continuity-ledger` |
| `valua-pr-review-closure-gate` | `cockpit-pr-review-closure-gate` |
| `valua-daddy-orchestrator` | `cockpit-orchestrator` |
| `valua-daddy-autopilot` | `cockpit-autopilot` (+ closure/continuity/agentbus skills in roster) |
| `valua-exec-agent` | `cockpit-exec-agent` |
| `valua-planning` | `cockpit-planning` |
| `valua-frontend-agent` / `valua-backend-agent` / `valua-prediction-agent` | project-specific; intentionally not bundled in generic cockpit |
| `valua-skillops` / `valua-daddy-curation` | represented as runbook policy (no Valua-only script coupling in generic cockpit) |

## Runbooks mapping

| Valua runbook | Generic cockpit baseline |
| --- | --- |
| `PR_REVIEW_LOOP.md` | `docs/runbooks/PR_REVIEW_LOOP.md` |
| `QUALITY_BAR.md` | `docs/runbooks/QUALITY_BAR.md` |
| `CODE_REVIEW_CHECKLIST.md` | `docs/runbooks/CODE_REVIEW_CHECKLIST.md` |
| `TMUX.md` | `docs/runbooks/TMUX.md` |
| `WORKTREES_AND_BRANCHING.md` | `docs/runbooks/WORKTREES_AND_BRANCHING.md` |
| `SKILLOPS.md` | `docs/runbooks/SKILLOPS.md` |
| Deployment/security/staging docs | remain project-specific and should be authored in downstream repos |

## Bootstrap behavior

`node scripts/init-project.mjs --project <repo>` now copies:
- `docs/agentic/agent-bus/*`
- `docs/agentic/BLUEPRINT.md`
- `docs/runbooks/*`
- `.codex/skills/cockpit-*` and `.codex/skills/code-change-verification`

## Guardrails

- Generic cockpit does not ship Valua deployment internals.
- Downstream projects must add domain-specific agent skills (backend APIs, infra, model pipelines).
- Review closure gate remains mandatory across all projects.
