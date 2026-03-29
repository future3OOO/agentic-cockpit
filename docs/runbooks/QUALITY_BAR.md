# Quality Bar

## Production loop
1. Inspect the exact delta first (`git diff --stat`, then `git diff <base>...HEAD` or `git diff HEAD`).
2. Before editing, name the existing path you are extending, what you will delete or keep from growing, and which coupled surfaces can break.
3. Search for an existing path before adding helpers, wrappers, or abstractions.
4. Implement the smallest correct fix on the existing path first.
5. Verify root cause, not symptoms.
6. Apply the invariant-first review doctrine in `AGENTS.md` instead of patching to reviewer wording.
7. When review-driven heuristics change, verify neighboring valid behavior, not just the exact failing input.
8. Reject fixes that only satisfy reviewer wording while shrinking a valid operator/task contract.
9. Keep diff focused and reviewable.
10. Update coupled tests/docs/contracts in the same patch.
11. Run tests/checks relevant to changed files and behavior variants.
12. Record residual risks and rollback notes.

## Documentation quality
- Docstrings/comments should explain non-obvious intent and edge cases.
- Avoid obvious or redundant documentation.

## Exit criteria
- Acceptance criteria met.
- Verification commands executed and recorded.
- Quality review notes are concrete, not filler boilerplate; reuse/coupling notes name exact paths or surfaces.
- No unresolved critical blockers.
