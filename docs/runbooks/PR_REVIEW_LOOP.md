# PR Review Loop

## Rule
Do not mark work complete while actionable reviewer feedback is open.

## Before fixing a review comment
1. Apply the canonical review-comment doctrine in `AGENTS.md` on current `HEAD`.
2. Decide whether it is:
- real bug
- hardening concern
- nit/doc-only
- stale/wrong
3. Check whether the proposed fix would break valid operator/task phrasing or packet shapes.
4. Only then implement and reply.

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
