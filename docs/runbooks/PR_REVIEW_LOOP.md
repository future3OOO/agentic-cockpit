# PR Review Loop

## Rule
Do not mark work complete while actionable reviewer feedback is open.

## Required closure sequence
1. Push fix commit.
2. Reply with commit SHA + what changed.
3. Ask reviewer/bot to re-check.
4. Keep thread open while re-check is pending.
5. Resolve only after reviewer acknowledgement or a clean rerun with no equivalent unresolved finding.

## What to verify
- Unresolved review threads are zero (GraphQL authoritative source).
- PR checks are green.
- PR conversation has no unresolved actionable requests.
