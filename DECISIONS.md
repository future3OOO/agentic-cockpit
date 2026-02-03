# Decisions (Agentic Cockpit)

This log records **explicit decisions** made for Agentic Cockpit so reviewers can quickly understand why the system works the way it does.

## 2026-02-03 — Cockpit V2 repository strategy
- Decision: Build Cockpit V2 as a **new standalone OSS repo** with an **adapter system**.
- Rationale: Keep Valua production work isolated; allow multiple downstream consumers; reduce coupling and confusion across PR stacks.
- Consequence: Valua becomes “adapter + consumer”, not the cockpit core.

## 2026-02-03 — Collaboration / agent-control requirement
- Decision: “Collaboration / agent-control” is a **hard requirement** for V2.
- Rationale: Operators must be able to inject updates mid-task deterministically, and agents must be able to message/coordinate with other agents without relying on brittle restarts.

## 2026-02-03 — Default license (provisional)
- Decision: Default to Apache-2.0 for OSS release.
- Rationale: Patent grant + permissive use is usually a safe default for infra tooling.
- Status: Can be changed early if you prefer MIT.

## 2026-02-03 — Execution engine direction
- Decision: Add a new “Codex app-server engine” while keeping `codex exec` as a fallback.
- Rationale: App-server enables true “interrupt/continue on same thread” semantics and structured streaming events, improving reliability and reducing loop/compaction issues.

## 2026-02-03 — Engine switch + schema contract
- Decision: Select the engine via `AGENTIC_CODEX_ENGINE` (or `VALUA_CODEX_ENGINE`), defaulting to `exec` for compatibility.
- Rationale: App-server is still experimental; keeping `exec` as default avoids surprising breakage for downstream repos while allowing opt-in.
- Decision: For app-server turns, pass `docs/agentic/agent-bus/CODEX_WORKER_OUTPUT.schema.json` as `outputSchema` to preserve the same “final JSON only” contract.
- Rationale: Keeps receipts/followUps handling identical across engines and makes failures deterministic when output is malformed.

## 2026-02-03 — Downstream project bootstrap
- Decision: Downstream repos can either:
  - commit a project-local roster + skills under `docs/agentic/agent-bus/` and `.codex/skills/`, or
  - run with the cockpit’s bundled defaults (fallback roster) for quick experiments.
- Rationale: New repos won’t have Valua’s directory layout; bootstrap must be one-command and safe.
- Implementation: `scripts/init-project.mjs` scaffolds the minimal files; tmux launchers and `loadRoster` fall back to the bundled roster when no project roster is configured.

## 2026-02-03 — Baseline verification skill
- Decision: Ship a default `code-change-verification` skill and include it in the bundled roster.
- Rationale: Require an explicit “run the checks” loop to reduce regressions and make review outputs more trustworthy.
- Implementation: `.codex/skills/code-change-verification/` with cross-platform helper scripts; copied into downstream repos by `scripts/init-project.mjs`.
