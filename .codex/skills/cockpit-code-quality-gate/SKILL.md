---
name: cockpit-code-quality-gate
description: "Production code quality gate for cockpit workers: strict anti-bloat policy, fail-closed verification, and deterministic cleanup."
version: 1.2.0
tags:
  - cockpit
  - quality
  - cleanup
---

# Cockpit Code Quality Gate

## When to use
- Any task that intends to return `outcome="done"` for `USER_REQUEST`, `ORCHESTRATOR_UPDATE`, or `EXECUTE`.

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
- No env-based or implicit code-quality gate bypasses. Audited branch-diff exceptions are allowed only via `docs/agentic/CODE_QUALITY_EXCEPTIONS.json` and must stay PR-scoped.

## Execution protocol

### 1) Before editing
- Inspect the exact target delta first: `git diff --stat`, then `git diff <base>...HEAD` when a base ref exists or `git diff HEAD` otherwise.
- Search for an existing path before adding any helper, wrapper, branch, or abstraction. Use `rg` in the touched subsystem and extend the existing path in place unless that would clearly increase complexity.
- Trace coupled surfaces before touching runtime behavior:
  - tests
  - runtime references
  - runbooks
  - decision records
  - downstream readers of the changed shape/contract
- Do not start editing until you can name all three:
  - the existing path you are extending,
  - what code/comment/helper you expect to delete or keep from growing,
  - which coupled surfaces can break.
- If you cannot name all three, keep investigating. Do not write code, tests, docs, or scaffolding yet.
- Reject new abstraction unless it deletes more complexity than it adds.

### 2) While editing
- Implement the smallest direct fix.
- Default to editing one existing path first. Do not create a new helper or data shape until the in-place path is proven worse.
- Delete dead code, stale comments, and transitional scaffolding in the same patch.
- Update coupled docs/tests/contracts in the same patch, not as later cleanup.
- Do not narrow valid behavior just to satisfy reviewer wording or a brittle heuristic.
- If a fix adds a new branch, helper, or data shape, prove why an existing path could not be extended.

### 3) Before claiming `done`
- Self-review the patch through these lenses:
  - `reuse`: what existing path did you reuse or extend?
  - `quality`: what bloat, duplication, fake-green behavior, or dead code did you remove or avoid?
  - `dependency impact`: what upstream/downstream consumers and coupled surfaces did you verify?
- Run: `node scripts/code-quality-gate.mjs check --task-kind <KIND>`
- Runtime enforcement is authoritative and fail-closed.
- When runtime scripts change, include matching `scripts/__tests__` updates in the same delta.
- Skill-file edits must pass skill validators (`validate-codex-skills` and `skills-format --check`) when available.
- Provide minimal closure evidence only:
  - include `qualityReview.summary` as one line,
  - include `qualityReview.legacyDebtWarnings=<count>` (non-blocking; must be acknowledged),
  - include all `qualityReview.hardRuleChecks` keys with one concise line each:
    `codeVolume,noDuplication,shortestPath,cleanup,anticipateConsequences,simplicity`,
  - set `qualityReview.hardRuleChecks.noDuplication=reuse=<existing path|none: local-only>`,
  - set `qualityReview.hardRuleChecks.anticipateConsequences=coupled=<verified surfaces|none: local-only>`,
  - do not paste full gate reports/logs in task notes.

## Banned quality-review bullshit
- Do not use filler like `ok`, `passed`, `looks good`, `minimal change`, or `quality checks passed`.
- Do not repeat the same boilerplate across all hard-rule notes.
- Do not claim `reused existing path` or `checked runtime impacts` without naming the path or coupled surface.
- Use `none: local-only` only when the rule truly had no external coupling.
- Do not leave defects introduced by the same patch as follow-up work.

## Composition rule
- Keep this skill as a gate contract.
- Keep language-specific rules in dedicated skills (TS/Python policy skills).
- Keep learning lifecycle in SkillOps skills.

## Learned heuristics (SkillOps)
<!-- SKILLOPS:LEARNED:BEGIN -->
<!-- SKILLOPS:LEARNED:END -->
