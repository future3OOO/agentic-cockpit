---
name: cockpit-code-quality-gate
description: "Production code quality gate for cockpit workers: strict anti-bloat policy, fail-closed verification, and deterministic cleanup."
version: 1.1.0
tags:
  - cockpit
  - quality
  - cleanup
---

# Cockpit Code Quality Gate

## When to use
- Any task that intends to return `outcome="done"` for `USER_REQUEST`, `ORCHESTRATOR_UPDATE`, `EXECUTE`, or `PLAN_REQUEST`.

## Hard rules

### 1) Code volume
- Every line must earn its place.
- Prefer deletion over wrappers.
- No one-off helper/wrapper functions for single-use operations.
- No premature abstraction; small direct duplication is acceptable until it is clearly shared.
- Remove unused code fully; do not leave `_unused` placeholders or "removed" comments.

### 2) No duplication
- Before adding a new function, check for an existing path that already solves the requirement.
- If two code paths perform the same operation, consolidate into one shared path.
- Keep shared operations centralized instead of spreading equivalent variants across modules.

### 3) Shortest path
- Keep data flow direct; remove unnecessary hops/transforms/retries.
- Every network, file, and process step must be justified.
- If a step can be removed without behavior loss, remove it.

### 4) Cleanup (zero tolerance)
- Cleanup must exist at startup, pre-task, and post-task.
- Temporary artifacts (local/remote) must not remain after completion.
- Partial failure/interruption cleanup paths are mandatory.
- If cleanup cannot be completed safely, return `blocked`/`needs_review` with exact blocker.

### 5) Anticipate consequences
- Trace downstream consumers before changing limits/contracts/data-shapes.
- Update all impacted consumers in the same change.
- Verify full flow before closure; no partial/local-only closure for cross-boundary changes.

### 6) Simplicity
- Choose minimal correct implementations over verbose patterns.
- Avoid redundant comments, noisy scaffolding, and unnecessary type/abstraction overhead.
- Production quality means small, correct, and maintainable.

## Banned fake-green patterns
- No blanket suppressions to silence tooling (`eslint-disable`, `@ts-ignore`, `# type: ignore`) unless explicitly justified and scoped.
- No exit-code swallowing in verification paths (`|| true` and equivalent).
- No broad empty catch/pass patterns that hide failure (`catch {}`, `.catch(() => {})`, `except: pass`).

## Required evidence before `done`
- Run: `node scripts/code-quality-gate.mjs check --task-kind <KIND>`
- Runtime enforcement is authoritative and fail-closed.
- When runtime scripts change, include matching `scripts/__tests__` updates in the same delta.
- Skill-file edits must pass skill validators (`validate-codex-skills` and `skills-format --check`) when available.
- Provide minimal closure evidence only:
  - include a single-line hard-rule summary (`codeVolume,noDuplication,shortestPath,cleanup,anticipateConsequences,simplicity`),
  - do not paste full gate reports/logs in task notes.

## Composition rule
- Keep this skill as a gate contract.
- Keep language-specific rules in dedicated skills (TS/Python policy skills).
- Keep learning lifecycle in SkillOps skills.

## Learned heuristics (SkillOps)
<!-- SKILLOPS:LEARNED:BEGIN -->
<!-- SKILLOPS:LEARNED:END -->
