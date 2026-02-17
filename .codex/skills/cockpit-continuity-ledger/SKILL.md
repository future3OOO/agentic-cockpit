---
name: cockpit-continuity-ledger
description: "Maintain a compact continuity ledger so long-running workflows survive session compaction and restarts."
version: 1.0.0
tags:
  - cockpit
  - continuity
  - operations
---

# Cockpit Continuity Ledger

Maintain `.codex/CONTINUITY.md` as the compact source of truth for ongoing work.

## Required behavior
- Initialize once: `node scripts/continuity-ledger.mjs init`.
- Validate when needed: `node scripts/continuity-ledger.mjs check`.
- Trim when too long: `node scripts/continuity-ledger.mjs trim`.
- Pathing rule: when editing with patch tools, use workspace-relative `.codex/CONTINUITY.md` (never absolute `/home/...` paths).

## Content quality
- Keep entries factual and short.
- Keep the file secret-free.
- Mark uncertainty as `UNCONFIRMED`.
- Update at start/end of meaningful slices and when Goal/Now/Next changes.

## Learned heuristics (SkillOps)
<!-- SKILLOPS:LEARNED:BEGIN -->
<!-- SKILLOPS:LEARNED:END -->
