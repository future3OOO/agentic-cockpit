---
{"id":"<UTC_TIMESTAMP>__<slug>",
 "to":["frontend"],
 "from":"daddy",
 "priority":"P1",
 "title":"<short title>",
 "constraints":["SSR-safe","no secrets"],
 "quality_gates":["pnpm typecheck","pnpm test"],
 "acceptance":["<observable outcome>"],
 "references":{
   "git":{
     "baseBranch":"main",
     "baseSha":"<sha>",
     "workBranch":"wip/frontend/<rootId>",
     "integrationBranch":"slice/<rootId>"
   }
 }}
---

# Task: <title>

## Context
- <why this exists>

## Steps
1) <step>

## Deliverables
- PR commit(s)
- Tests run
- Receipt note (sha/links)
