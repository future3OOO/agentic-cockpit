# Quality Bar

## Production loop
1. Implement smallest correct fix.
2. Verify root cause, not symptoms.
3. Verify neighboring valid behavior, not just the exact failing input.
4. Reject fixes that only satisfy reviewer wording while shrinking a valid operator/task contract.
5. Keep diff focused and reviewable.
6. Run tests/checks relevant to changed files and behavior variants.
7. Record residual risks and rollback notes.

## Documentation quality
- Docstrings/comments should explain non-obvious intent and edge cases.
- Avoid obvious or redundant documentation.

## Exit criteria
- Acceptance criteria met.
- Verification commands executed and recorded.
- No unresolved critical blockers.
