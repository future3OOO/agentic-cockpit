# Quality Bar

## Production loop
1. Implement smallest correct fix.
2. Verify root cause, not symptoms.
3. Apply the invariant-first review doctrine in `AGENTS.md` instead of patching to reviewer wording.
4. When review-driven heuristics change, verify neighboring valid behavior, not just the exact failing input.
5. Reject fixes that only satisfy reviewer wording while shrinking a valid operator/task contract.
6. Keep diff focused and reviewable.
7. Run tests/checks relevant to changed files and behavior variants.
8. Record residual risks and rollback notes.

## Documentation quality
- Docstrings/comments should explain non-obvious intent and edge cases.
- Avoid obvious or redundant documentation.

## Exit criteria
- Acceptance criteria met.
- Verification commands executed and recorded.
- No unresolved critical blockers.
