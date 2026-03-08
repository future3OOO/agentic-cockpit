# Code Review Checklist

- Scope is minimal and tied to the task.
- Reviewer comment or bug report was independently verified against current `HEAD`.
- Root cause is addressed rather than the nearest visible symptom.
- Upstream and downstream behavior were checked, not just the reported line.
- Existing valid operator/task phrasing was preserved or intentionally deprecated with docs/decision updates.
- Tests/checks cover:
  - the reported failure,
  - one adjacent valid input,
  - one adjacent false-positive input.
- Test fixtures were not rewritten merely to fit a narrower parser/contract.
- Security/privacy risks reviewed.
- Rollback path is clear.
- PR review loop is closed (threads/checks/actionable comments).
