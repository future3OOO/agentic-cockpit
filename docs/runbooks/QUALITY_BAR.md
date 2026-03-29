# Quality Bar

## Production loop
1. Inspect the exact delta first (`git diff --stat`, then `git diff <base>...HEAD` or `git diff HEAD`).
2. Search for an existing path before adding helpers, wrappers, or abstractions.
3. Implement the smallest correct fix.
4. Verify root cause, not symptoms.
5. Apply the invariant-first review doctrine in `AGENTS.md` instead of patching to reviewer wording.
6. When review-driven heuristics change, verify neighboring valid behavior, not just the exact failing input.
7. Reject fixes that only satisfy reviewer wording while shrinking a valid operator/task contract.
8. Keep diff focused and reviewable.
9. Update coupled tests/docs/contracts in the same patch.
10. Run tests/checks relevant to changed files and behavior variants.
11. Record residual risks and rollback notes.

## Documentation quality
- Docstrings/comments should explain non-obvious intent and edge cases.
- Avoid obvious or redundant documentation.

## Exit criteria
- Acceptance criteria met.
- Verification commands executed and recorded.
- Quality review notes are concrete, not filler boilerplate.
- No unresolved critical blockers.
