# Valua Cockpit Exec Budget: Waste Routes + Fix Plan

Date: 2026-02-07

This doc is an evidence-backed investigation into why Valua cockpit work is consuming a disproportionate amount of **Codex Exec** (tokens + RPM), and what we changed (and still need to change) to reduce it without hiding real errors.

## Evidence (From Rollout JSONL)

We measure token burn from Codex rollouts under `~/.codex/sessions/**/rollout-*.jsonl`.

Command used (last ~48h window):

```bash
cd /home/prop_/projects/agentic-cockpit
node scripts/rollout-metrics.mjs --since 2026-02-06 --until 2026-02-08
```

### Key Observations (2026-02-06..2026-02-08)

1. **Autopilot is a major consumer.**
   - `daddy-autopilot` burned **303,323,485 tokens** across **130 invocations** (avg ~2.33M tokens per invocation).
   - Of that, `ORCHESTRATOR_UPDATE` alone was **212,106,508 tokens** across **101 invocations**.

2. **Most `ORCHESTRATOR_UPDATE` token burn is from task completion digests.**
   - Top sources by tokens:
     - `TASK_COMPLETE:EXECUTE`: **204,870,505 tokens** (87 invocations)
     - `TASK_COMPLETE:STATUS`: **14,862,595 tokens** (16 invocations)

3. **There appear to be two autopilots running.**
   - Separate agent name `autopilot` also burned **37,433,353 tokens** (11 invocations, all `ORCHESTRATOR_UPDATE`).
   - This strongly suggests two different rosters/cockpits were running concurrently, duplicating controller work.

4. **Exec agents also burn heavily on real work (not just orchestration).**
   - `frontend EXECUTE`: **236,390,117 tokens** (24 invocations; avg ~9.85M)
   - `qa EXECUTE`: **191,799,620 tokens** (26 invocations; avg ~7.38M)
   - `infra EXECUTE`: **96,863,316 tokens** (36 invocations; avg ~2.69M)

### Top 10 “Waste Routes” (By Tokens)

Routes are grouped as `(agent, signals.kind)`:

1. `frontend / EXECUTE`: 236,390,117 tokens (n=24)
2. `daddy-autopilot / ORCHESTRATOR_UPDATE`: 212,106,508 tokens (n=101)
3. `qa / EXECUTE`: 191,799,620 tokens (n=26)
4. `infra / EXECUTE`: 96,863,316 tokens (n=36)
5. `daddy-autopilot / USER_REQUEST`: 83,899,241 tokens (n=22)
6. `autopilot / ORCHESTRATOR_UPDATE`: 37,433,353 tokens (n=11) [duplicate autopilot]
7. `qa / STATUS`: 17,582,951 tokens (n=9)
8. `infra / STATUS`: 5,879,227 tokens (n=3)
9. `daddy-autopilot / REVIEW_ACTION_REQUIRED`: 5,427,966 tokens (n=2)
10. `frontend / STATUS`: 4,074,654 tokens (n=3)

## Root Cause Summary (Why This Happens)

### A) “Orchestrator update burn” is actually **Autopilot Exec burn**
The orchestrator itself is mostly file I/O (digest generation + packet delivery).

The expensive part is that every `ORCHESTRATOR_UPDATE` packet wakes **`daddy-autopilot`**, which then runs **a Codex Exec** to decide follow-ups, often with:
- a large context snapshot (open tasks + receipts),
- skill invocation boilerplate,
- cold-started or frequently restarted session/thread state.

### B) Duplicate controller workers
Seeing both `daddy-autopilot` and `autopilot` in the rollouts implies multiple controllers active. Even if each is “correct” in isolation, it doubles the “digest → Exec” tax.

### C) Cold-start overhead (skills + context + state index)
Even when a digest is informational, the worker can still pay the full prompt cost unless:
- sessions/threads are reused (“warm start”),
- skill invocations are skipped when already loaded,
- context is thinned for controller digests,
- Codex internal state is isolated to avoid scanning ancient thread indexes.

## Implemented Fixes (In `agentic-cockpit` PR #2)

These changes are already implemented in `agentic-cockpit` (branch `feat/valua-warmstart-thin-digests`, PR #2):

1. **Warm-start prompt bootstrap**: skips `$skill` invocations when resuming the same thread with the same skills set.
2. **Root-scoped session reuse**: pins a thread per `(agent, rootId)` to keep multi-step workflows warm.
3. **Thin autopilot context on warm-resumed digests**: `AGENTIC_AUTOPILOT_CONTEXT_MODE=auto` uses thin context for warm `ORCHESTRATOR_UPDATE`.
4. **Compact orchestrator digests to autopilot**: reduces prompt size for controller updates.
5. **Persistent Codex app-server per agent**: avoids repeated process cold-starts (`AGENTIC_CODEX_ENGINE=app-server` + persist).
6. **Optional autopilot digest fast-path (zero-token)**: allowlist-based skip of Codex for specific digest sources.
7. **CODEX_HOME isolation mode**: reduces cross-project state/index pollution and mitigates rollout index spam.

## Remaining Work / Next Steps (No-Regression Order)

1. **Enforce “one controller” per cockpit**
   - Ensure only one roster/controller is running for Valua. Eliminate any legacy `autopilot` worker if Valua uses `daddy-autopilot`.

2. **Enable fast-path safely**
   - Start with narrow allowlist entries that do not require controller reasoning.
   - Example initial allowlist candidates (evaluate with Daddy):
     - `TASK_COMPLETE:STATUS`
     - `TASK_COMPLETE:TASK_COMPLETE`
   - Avoid fast-pathing `TASK_COMPLETE:EXECUTE` until we add a receipt-aware fast-path (reads receipt + decides if action is needed).

3. **Measure again after rollout**
   - Re-run `scripts/rollout-metrics.mjs` after the new cockpit version has been active for a day.
   - Success criteria:
     - `daddy-autopilot / ORCHESTRATOR_UPDATE` token totals and invocation counts drop materially.
     - average tokens per `ORCHESTRATOR_UPDATE` decreases (thin context + warm start).

4. **Document the Valua adapter settings**
   - Make the “Valua recommended env” explicit so Valua gets cockpit benefits without regressions.

