# Opus Advisory Simplification Plan V4.11 (Canonical, Production-Ready)

## Scope Boundary For This Consolidation Task
- This task consolidates and hardens plan text only.
- Runtime code changes, adapter code changes, and policy implementation changes are out of scope for this task.

## Canonical Source Of Truth
- Authoritative plan path: `/home/prop_/projects/.worktrees/agentic-cockpit-opus-gate-v4-3/.codex/plans/OPUS_ADVISORY_SIMPLIFICATION_PLAN_V4.11.md`.
- Duplicate policy: any non-canonical V4.11 plan copy must be removed or replaced with a one-line pointer to this path.

## Objective
Harden V4.11 into implementation-safe, zero-ambiguity execution guidance while preserving advisory fail-open behavior and gate fail-closed behavior.

## Locked Constraints
1. `AGENTIC_OPUS_CONSULT_MODE=advisory` stays non-blocking.
2. `AGENTIC_OPUS_CONSULT_MODE=gate` stays strict and fail-closed.
3. Two-phase ownership stays split: Valua policy first, Cockpit runtime second.
4. Smallest-correct delta only: no parser overengineering, no redundant validators, no fake-green shortcuts.

## Decision Authority And Critical Evaluation
- `daddy-autopilot` is the final decision authority for planning, dispatch, review, and closure.
- `opus-consult` is consultant-only and never dispatches execution.
- Autopilot must critically evaluate Opus rationale against receipts, diffs, tests, and runtime state before acting.
- Advisory mode must not become checklist theater; each disposition must include concrete reasoning.

## Canonical Commit Targets

### Phase 1 Target (Valua policy/docs)
- Primary repo path (canonical): `/home/prop_/projects/Valua`
- Secondary execution context (runtime worktree only): `/home/prop_/.codex/valua/worktrees/Valua/daddy-autopilot`
- Base branch: `origin/master`
- Work branch: `fix/opus-consult-advisory-alignment-v4-11`
- PR target: `master` in `future3OOO/Valua_P`

### Phase 2 Target (Cockpit runtime PR24)
- Primary repo path (canonical): `/home/prop_/projects/agentic-cockpit`
- Secondary execution context (task worktree): `/home/prop_/projects/.worktrees/agentic-cockpit-opus-gate-v4-3`
- Base branch: `origin/main`
- Work branch: `feat/opus-gate-v4-3-implementation`
- PR target: `main` in `future3OOO/agentic-cockpit` via PR24

## Phase 1 - Valua-Owned Policy Alignment

### Exact File Scope
Allowed edits are limited to:
- `.codex/skills/valua-daddy-autopilot/SKILL.md`
- `.codex/skills/valua-opus-consult/SKILL.md`
- `AGENTS.md`
- `CLAUDE.md`
- `docs/agentic/BLUEPRINT.md`
- `docs/agentic/agent-bus/PROTOCOL.md`
- `docs/agentic/AUTOPILOT_RUNTIME_FLOW.md`

No other Valua paths are in scope for Phase 1.

### Required Outcomes
1. Advisory contract text is explicit: fail-open advisory and fail-closed gate mode.
2. Autopilot authority and Opus consultant-only boundary are explicit.
3. Advisory disposition behavior is stated as non-blocking in advisory mode.
4. Phase 1 does not modify cockpit runtime scripts.

### Deterministic Verification Commands (Run Exactly)

```bash
cd /home/prop_/projects/Valua
git diff --name-only origin/master...HEAD
rg -n "advisory|gate|final authority|consultant|critically evaluate|checklist theater|OPUS_DISPOSITIONS" \
  .codex/skills/valua-daddy-autopilot/SKILL.md \
  .codex/skills/valua-opus-consult/SKILL.md \
  AGENTS.md CLAUDE.md docs/agentic/BLUEPRINT.md docs/agentic/agent-bus/PROTOCOL.md docs/agentic/AUTOPILOT_RUNTIME_FLOW.md
node scripts/skillops.mjs debrief --skills valua-daddy-autopilot,valua-opus-consult,valua-quality-core,valua-code-quality-gate,valua-agentbus,valua-skillops --title "V4.11 Phase 1 Valua policy alignment"
node scripts/skillops.mjs distill
node scripts/skillops.mjs lint
node "/home/prop_/projects/.worktrees/agentic-cockpit-opus-gate-v4-3/scripts/code-quality-gate.mjs" check --task-kind EXECUTE
```

### Phase 1 Handoff Criteria
- Phase 1 PR is merged to Valua `master`.
- Phase 1 files contain explicit authority and advisory/gate semantics.
- Phase 1 verification command set above is green.
- Cockpit Phase 2 branch records the merge base and decision references from Phase 1.

## Phase 2 - Cockpit Runtime Alignment (PR24)

### Exact File Scope (Runtime + Coupled Docs Only)
Runtime files:
- `scripts/agent-codex-worker.mjs`
- `scripts/agent-opus-consult-worker.mjs`

Runtime tests:
- `scripts/__tests__/codex-worker-opus-gate.test.mjs`
- `scripts/__tests__/opus-consult-worker.test.mjs`
- `scripts/__tests__/opus-consult-protocol.test.mjs`
- `scripts/__tests__/codex-worker-autopilot-context.test.mjs`

Coupled docs:
- `AGENTS.md`
- `README.md`
- `DECISIONS.md`
- `docs/agentic/AUTOPILOT_RUNTIME_FLOW.md`
- `docs/agentic/BLUEPRINT.md`
- `docs/agentic/agent-bus/PROTOCOL.md`
- `docs/agentic/RUNTIME_FUNCTION_REFERENCE.md`

Adapter decision (locked):
- No adapter file changes are required in this plan.
- Explicitly excluded: `adapters/valua/run.sh`, `scripts/tmux/agents-up.sh`, `docs/agentic/VALUA_ADAPTER_RUNTIME.md`.

### Required Outcomes
1. Advisory disposition enforcement path is non-gating in advisory mode.
2. Gate-mode strict behavior remains unchanged.
3. Advisory response handling stays direct; no extra parser or normalization layers are introduced.
4. Runtime telemetry and audit signals remain intact.

### Deterministic Verification Commands (Run Exactly)

```bash
cd /home/prop_/projects/.worktrees/agentic-cockpit-opus-gate-v4-3
git diff --name-only origin/main...HEAD
node --test scripts/__tests__/codex-worker-opus-gate.test.mjs scripts/__tests__/opus-consult-worker.test.mjs scripts/__tests__/opus-consult-protocol.test.mjs scripts/__tests__/codex-worker-autopilot-context.test.mjs
AGENTIC_OPUS_CONSULT_MODE=advisory AGENTIC_OPUS_PROTOCOL_MODE=freeform_only node --test scripts/__tests__/codex-worker-opus-gate.test.mjs
AGENTIC_OPUS_CONSULT_MODE=gate AGENTIC_OPUS_PROTOCOL_MODE=freeform_only node --test scripts/__tests__/codex-worker-opus-gate.test.mjs
node "/home/prop_/projects/.worktrees/agentic-cockpit-opus-gate-v4-3/scripts/code-quality-gate.mjs" check --task-kind EXECUTE
```

### Phase 2 Acceptance Criteria
- PR24 is merged to cockpit `main`.
- Phase 2 verification command set above is green.
- One real root task validates consult -> autopilot decision -> receipt closure end-to-end after runtime restart.

## Sequencing Policy
Chosen policy is Valua first, Cockpit second. Phase 1 lands first because it sets authoritative policy semantics and decision contracts for implementers. Transition guard: during the Phase 1-only window, runtime behavior remains controlled by existing cockpit code, operators keep `AGENTIC_OPUS_CONSULT_MODE=advisory`, and no gate-mode rollout changes are allowed until PR24 is merged and runtime is restarted.

## Implementation-Safe Acceptance And Rollback Triggers
Acceptance criteria:
- A single canonical V4.11 plan path is in force.
- Phase 1 and Phase 2 command blocks are deterministic and complete.
- Adapter scope is explicitly locked with exact excluded files.
- Authority and advisory/gate semantics are explicit with no conditional placeholders.

Rollback triggers:
- Advisory retry churn regression.
- Gate strictness regression.
- Consult response parsing instability.
- Unresolved review findings.

## Rollback Plan
1. Roll back Phase 2 first: revert PR24 runtime changes, restart cockpit runtime, rerun Phase 2 verification commands.
2. Roll back Phase 1 second: revert Valua Phase 1 PR, rerun Phase 1 verification commands.
3. Confirm restored baseline behavior in both advisory and gate modes.

## Changes Vs Previous Draft
- Unified V4.11 to one authoritative canonical path in the cockpit worktree.
- Consolidated the newer production-ready content into canonical and removed older-path drift.
- Added an explicit top-level scope boundary stating this task is plan consolidation only.
- Standardized canonical primary/secondary ownership paths for both phases.
- Locked adapter scope to explicit no-change with exact excluded adapter files.
- Kept deterministic Phase 1 and Phase 2 command blocks with explicit acceptance and rollback triggers.
- Trimmed Phase 1 SkillOps verification to the directly relevant skill set.
