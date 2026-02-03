# Agentic Cockpit — Agents Charter (OSS)

This repo is production-grade orchestration tooling. Ship review-ready code only.

## Non-negotiables
- No secrets in git, issues, logs, or receipts.
- Keep diffs small and testable; fix root cause.
- Do not add “TODO” placeholders.
- Run `node --test` before claiming done.

## Repo conventions
- Keep `.codex/CONTINUITY.md` up to date for long-running work.
- Record explicit decisions in `DECISIONS.md`.
- Skills live in `.codex/skills/<skill>/SKILL.md` and must include YAML frontmatter (`name`, `description`).

## Safety
- Guardrails in `scripts/agentic/guard-bin/` must remain enabled by default.
- No PR merges from workers; leave merges to human review/CI policy.

