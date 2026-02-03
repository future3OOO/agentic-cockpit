---
name: code-change-verification
description: "Mandatory verification checklist for code changes: run the repo's standard format/lint/typecheck/test stack before marking work complete."
version: 1.0.0
tags:
  - verification
  - quality
  - cockpit
---

# Code Change Verification

## Purpose

Do **not** mark an execution task as complete until the repo’s verification stack has passed.

This skill is intended to reduce regressions by making “run the checks” the default behavior for
agents when they change runtime code, tests, build config, or deployment scripts.

## When to run

Run the full stack when you touch:
- Runtime code
- Auth/billing flows
- Build/test tooling
- CI scripts, lint config, or typecheck config

You may skip the full stack for:
- Docs-only changes
- Comments-only changes
- Formatting-only changes that do not affect runtime behavior

If unsure, **run it**.

## What to run (policy)

1) First, follow any repo-local requirements (e.g. `AGENTS.md`, runbooks).
2) Then run the repo’s standard verification commands (format → lint → typecheck → tests/build).
3) If anything fails: fix the issue and re-run the full stack.

## This repository (agentic-cockpit)

Run:
- `npm test`

Optional (if configured in the future):
- `npm run lint`

## Helper scripts (recommended)

- macOS/Linux: `bash .codex/skills/code-change-verification/scripts/run.sh`
- Windows: `powershell -ExecutionPolicy Bypass -File .codex/skills/code-change-verification/scripts/run.ps1`

If the script cannot detect a supported toolchain, fall back to the repo’s documented commands and
report what you ran in `testsToRun`.

