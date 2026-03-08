# PR Review Loop

## Rule
Do not mark work complete while actionable reviewer feedback is open.

## Before fixing a review comment
1. Reproduce the issue on current `HEAD`.
2. State the behavior invariant first if parser/selector/routing/guard logic is involved.
3. Decide whether it is:
- real bug
- hardening concern
- nit/doc-only
- stale/wrong
4. Check whether the proposed fix would break valid operator/task phrasing or packet shapes.
5. Only then implement and reply.

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
