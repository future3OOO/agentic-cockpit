# PR Review Closure Gate

This gate prevents "premature resolve" mistakes in PR review threads.

Use this policy for all cockpit-driven PR workflows.

## Required sequence

1. Push the fix commit.
2. Reply on the relevant review thread with:
   - commit SHA
   - brief change summary
   - explicit re-check request
3. Wait for re-check to complete (bot rerun and/or reviewer response).
4. Resolve only after validation:
   - reviewer/bot confirms addressed, or
   - rerun is clean with no equivalent unresolved finding.

For human reviewer threads, prefer reviewer-owned resolution unless they explicitly ask you to resolve.

## Why this exists

`Resolve` only changes thread state. It does not prove the fix is correct.

## Minimum verification checklist

- Unresolved review threads count is zero.
- PR checks are green.
- No actionable PR conversation comments remain.

## Handy commands

Show unresolved review threads (authoritative):

```bash
gh api graphql -F owner='<owner>' -F repo='<repo>' -F number='<pr>' -f query='
query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$number){
      reviewThreads(first:100){
        nodes{
          id
          isResolved
          isOutdated
          path
          line
          comments(last:1){ nodes { author { login } url body } }
        }
      }
    }
  }
}' 
```

Quick PR state/check snapshot:

```bash
gh pr view <pr> --json reviewDecision,statusCheckRollup,mergeStateStatus,url
```
