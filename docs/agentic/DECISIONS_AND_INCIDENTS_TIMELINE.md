# Decisions and Incidents Timeline

This timeline is an operational index for why the runtime behaves as it does today.

Source inputs:
- `DECISIONS.md`
- implemented behavior in `scripts/**` and `adapters/**`

## 2026-02-03 — V2 Architecture Direction

Decision class:
- keep cockpit core in standalone OSS repo
- downstream projects consume via adapter + roster/skills

Impact:
- cockpit runtime logic remains centralized in this repo
- project-specific behavior is controlled by roster/skills/env defaults

## 2026-02-03 — Engine Dual-Path (`exec` + `app-server`)

Decision class:
- retain `codex exec` compatibility path
- add `codex app-server` for persistent thread and interrupt handling

Impact:
- adapters can default to app-server while generic startup can remain compatibility-first
- output schema contract maintained across both engines

## 2026-02-03 — Per-Agent Worktree Isolation by Default

Decision class:
- codex workers should not share operator checkout

Impact:
- reduced branch/file clobbering between agents
- explicit repin/reset operations became necessary for deterministic recovery

## 2026-02-03 — Git Contract Preflight

Decision class:
- task-level `references.git` contract controls branch base and target

Impact:
- worker preflight can block deterministically on mismatched/dirty branch state
- follow-ups can be resumed on stable work branches

## 2026-02-07 — Dashboard Default Port Shift to 3210

Decision class:
- avoid common local `3000` collisions

Impact:
- tmux/dashboard startup is less collision-prone in active web dev environments

## 2026-02-17 — Rollout-Path STDERR Handling Policy

Decision class:
- do not fatalize or auto-repair on Codex rollout-path stderr lines alone

Reason:
- those stderr lines can appear even when rollout files exist
- fatal wrappers and aggressive auto-repair caused unnecessary retries/churn

Required behavior retained:
- per-agent single-writer lock
- strict resume precedence
- keep review gate enforcement intact

## Incident Class: Observer "Seen but Not Emitted" for PR Comments

Symptom:
- `state/pr-observer/*.json` watermark advances for issue comment id
- no corresponding `PR<id>__ISSUE_COMMENT__<commentId>` packet/receipt in bus

Current root-cause class:
- observer actionable filter may classify comment as non-actionable
- observer still advances `lastSeenIssueCommentId` to cycle max id

Operational consequence:
- non-emitted comment id is not replayed automatically in baseline mode

Current state:
- this behavior is still present and should be treated as known runtime constraint

## Incident Class: Runtime Worktree / Branch Drift

Symptom:
- autopilot/agents running from unexpected branch or stale local checkout
- behavior appears inconsistent after merges

Root-cause class:
- launch path ambiguity between source checkout and runtime worktree
- stale or dirty local checkout reused unintentionally

Mitigation path:
- deterministic restart via `adapters/valua/restart-master.sh`
- optional `RESET_STATE=1` for codex runtime state rotation
- default repin to `origin/master`

## Incident Class: Non-Deterministic Worker Preflight Blocks

Symptom:
- workers repeatedly blocked on dirty tree/preflight mismatch
- autopilot receives completion/blocked churn with little progress

Root-cause class:
- expected deterministic branch sync collides with local uncommitted work

Mitigation path:
- keep `AGENTIC_EXEC_PREFLIGHT_AUTOCLEAN_DIRTY=1` where acceptable
- run deterministic repin/restart path when queues are blocked by preflight

## Incident Class: Overloaded/Drifting Documentation

Symptom:
- runtime details spread across README + multiple agentic docs
- conflicting or stale operator instructions

Mitigation path (this change):
- authoritative split references:
  - `docs/agentic/REFERENCE_INDEX.md`
  - `docs/agentic/CONTROL_LOOP_AND_PACKET_FLOW.md`
  - `docs/agentic/RUNTIME_FUNCTION_REFERENCE.md`
  - `docs/agentic/VALUA_ADAPTER_RUNTIME.md`

## Ongoing Operating Rules

1. Treat code as source-of-truth; docs must follow implementation.
2. Prefer deterministic restart paths over manual ad-hoc resets.
3. Keep guard overrides opt-in.
4. Keep completion gating fail-closed for quality/review critical paths.
5. Record future behavior-changing decisions in `DECISIONS.md` and summarize here.
