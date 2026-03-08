# Opus Advisory Coverage Plan + Acceptance Matrix (V1.1)

## 1. Purpose

This plan closes twelve production gaps:

1. Opus advisory items can be partially dispositioned while root closure still returns `done`.
2. Deferred Opus items can be dropped without tracked follow-up TARs/issues.
3. Autopilot pre-consult reasoning can be generic boilerplate instead of evidence-driven analysis.
4. Prompt/context injection can become oversized and repetitive, degrading decision quality.
5. Autopilot can produce a real commit, then self-block with `delegate_required`, which skips mandatory review and hides required follow-up dispatch.
6. Consult transport can be blocked by over-broad suspicious-text detection (for example benign `shutdown` wording in systemd readiness plans), leaving autopilot in long `in_progress` waits.
7. Agents can still produce duplicated, bloated implementations because downstream quality guidance is too abstract, especially for infra/config changes where copy-paste looks like the "existing pattern".
8. Critical downstream paths can lack repo-local blocking review rules, so reviewer bots catch symptoms (missing headers, missing branches) instead of the root cause (duplicated shared blocks / missing shared include patterns).
9. SkillOps can complete with empty `skill_updates` / blank decision record after a confirmed review pattern failure, so the system fails to learn from slop/duplication regressions.
10. Whole-stack quality coverage is incomplete: TypeScript, Python prediction code, DB/API paths, and infra/config changes do not yet share one explicit anti-slop/anti-bloat policy model.
11. Cockpit default scaffolding does not yet guarantee those quality expectations are baked in for new downstream repos by default.
12. AGENTS.md, CLAUDE.md, and Opus consultant instructions can still under-specify quality expectations or repeat too much policy text, which either weakens behavior or overloads context.

The target state is:

1. Advisory consult remains pass-through in advisory mode (no hard consult/disposition fail-closed behavior).
2. Deferred items are always tracked.
3. Merge/closure cannot silently bypass unresolved advisory work.
4. Pre/post consult remains enabled, but autopilot must think first and Opus must not become a substitute for controller reasoning.
5. Runtime context stays lean, deterministic, and high-signal.
6. No self-block-after-commit path remains for autopilot; unresolved delegation becomes `needs_review` with explicit follow-up ownership.
7. Advisory consult transport cannot deadlock on benign operational wording; terminal consult transport failures degrade immediately via synthetic advisory fallback.
8. Config files are treated as code: repeated shared blocks move to a single source of truth (snippet/include/helper/template) rather than being mirrored inline.
9. Critical downstream paths carry concrete repo-local `REVIEW.md` rules that review bots and humans can enforce as blocking policy.
10. Reviewer-confirmed pattern failures feed concrete, non-empty SkillOps learning back into the system before closure.
11. Whole-stack quality policy is explicit across TypeScript, Python, DB/API, and infra paths, with concise stack-specific rules instead of vague generic slogans.
12. Cockpit carries a default, reusable quality-policy baseline so adapter users inherit it on new projects without rebuilding the policy from scratch.
13. `AGENTS.md` remains canonical and concise, while `CLAUDE.md` and Opus consultant skills stay role-specific, pointer-based, and quality-aware without duplicating the full charter.

## 2. Gate Taxonomy (explicit)

1. Consult Availability Gate (hard consult gate):
   1. In `advisory` mode, consult auth/transport/schema/runtime failures must not hard-stop task execution.
   2. In explicit `gate` mode, fail-closed behavior remains allowed by configuration.
   3. In `advisory` mode, consult request transport blocks (including suspicious-policy false positives) must trigger immediate fallback, not long timeout wait.
   4. Suspicious-content screening must remain strict for destructive command patterns, but must not block benign planning text about service lifecycle (`READY/STOPPING`, shutdown-path narration).
2. Advisory Accountability Gate (soft closure gate):
   1. Advisory output is non-binding and must not block execution.
   2. If autopilot defers Opus-advised work, closure cannot return `done` without tracked follow-up evidence.
   3. Violation outcome is `needs_review`, not terminal `blocked`.
3. Core Runtime Safety Gates (non-Opus):
   1. Delegation/tiny-fix safety,
   2. commit-bearing review targeting,
   3. branch continuity/follow-up routing,
   4. skillops/code-quality safety checks where policy requires.
4. Implementation Quality Gate (slop/bloat prevention):
   1. Application code and config files (`nginx`, `systemd`, CI, deploy scripts) are all subject to the same anti-duplication and anti-bloat rules.
   2. Repeated shared blocks in touched files must be extracted to a single source of truth when a shared snippet/include/helper/template is viable.
   3. Repo-local `REVIEW.md` rules for touched critical paths are binding for agent closure and review interpretation.
   4. Confirmed review pattern failures require explicit SkillOps learning evidence; empty `skill_updates` / blank decision record is invalid.
5. Policy Propagation Gate (cockpit defaults):
   1. Cockpit-bundled policy surfaces (`AGENTS.md`, `CLAUDE.md`, bundled skills, `init-project`) must provide a reusable default quality baseline for new downstream repos.
   2. Downstream projects may extend stack-specific rules, but cockpit defaults must already express anti-slop/anti-bloat expectations across the common stacks (`TypeScript`, `Python`, DB/API, infra/config).
   3. Role overlays must stay concise and pointer-based; stack-specific examples belong in focused skills/review files, not repeated wholesale in every prompt surface.

## 2.1 Consult Phase Policy (retained)

1. Pre-exec consult remains enabled.
2. Post-review consult remains enabled.
3. Opus remains consultant-only; autopilot remains decision authority.
4. Advisory mode remains default unless gate mode is explicitly configured.

## 2.2 Consult Scope Policy (critical kinds)

1. Initial user task consult is mandatory:
   1. `USER_REQUEST` pre-exec consult remains always in scope.
2. Digest consult is not blanket:
   1. `ORCHESTRATOR_UPDATE` consult remains in scope only for commit/risk/closure-critical digests.
   2. Non-critical bookkeeping digests should not trigger full consult rounds.
3. Narrowing consult scope must never remove initial-task consult coverage.

## 2. Ownership Split

## Phase 1 (Autopilot): Valua repo behavior/prompt contract

Owner: `daddy-autopilot`
Primary repo: `Valua`
Commit target: fresh Valua implementation branch cut from a clean current upstream integration branch (`origin/master` in the current Valua runtime) and opened as a new PR
Baseline rule: do not reuse stale local Valua branches with gone upstreams or dirty runtime state for Phase 1 work

Required files:

1. `.codex/skills/valua-daddy-autopilot/SKILL.md`
2. `.codex/skills/valua-opus-consult/SKILL.md`
3. `CLAUDE.md`
4. `AGENTS.md`
5. `.codex/skills/valua-architecture-daddy/SKILL.md`
6. `.codex/skills/valua-code-quality-gate/SKILL.md`
7. `.codex/skills/valua-ts-quality-policy/SKILL.md`
8. `.codex/skills/valua-py-quality-policy/SKILL.md`
9. `.codex/skills/valua-quality-core/SKILL.md`
10. `deploy/nginx/REVIEW.md`
11. `deploy/nginx/snippets/security-headers.conf`

Phase 1 scope:

1. Require explicit handling of Opus-advised work before merge/closure (act, skip with rationale, or defer with tracking).
2. Require tracked follow-up evidence for all `deferred` advisory dispositions.
3. Clarify authority split: Opus advises, autopilot decides and dispatches.
4. Standardize advisory note format for deterministic auditability (without hard parser gating in advisory mode).
5. Add explicit autopilot-first reasoning requirement before consult request dispatch:
   1. summarize concrete evidence from receipts/diffs/tests,
   2. state candidate actions,
   3. state chosen working hypothesis and uncertainties for Opus to challenge.
6. Reduce policy duplication in injected role docs:
   1. keep `AGENTS.md` canonical and concise,
   2. keep `CLAUDE.md` and skill overlays role-specific without repeating full charter text.
7. Clarify consult-content policy in Valua docs/skills:
   1. systemd readiness/lifecycle wording in plans (for example `READY=1`, `STOPPING=1`, shutdown-path notes) is normal advisory context,
   2. these terms must not be treated as unsafe intent by controller/operator policy.
8. Add concrete file-type quality rules to Valua skills:
   1. config files (`nginx`, `systemd`, CI, deploy scripts) are code and must follow the same anti-duplication / anti-bloat rules as application code,
   2. "match the existing copy-paste pattern" is not valid when a single shared source of truth is viable.
9. Standardize critical Nginx shared-block policy in Valua:
   1. repeated security-header directives move to `deploy/nginx/snippets/security-headers.conf`,
   2. any governed `location` block that defines `add_header` must use the shared include rather than inline mirroring,
   3. critical infra examples in skills must state this as a requirement, not an optional pattern.
10. Add repo-local blocking review rules for critical infra paths:
   1. create `deploy/nginx/REVIEW.md`,
   2. make duplicated shared header blocks and missing required includes explicit blocking findings for review bots and humans.
11. Strengthen SkillOps feedback for review pattern failures:
   1. reviewer-confirmed duplication/slop findings require non-empty `skill_updates`,
   2. the decision record must be filled before distill/closure,
   3. the learned rule must be concrete, path/domain specific, and testable.
12. Extend downstream quality policy across the whole stack:
   1. strengthen `valua-ts-quality-policy` for UI/API/service code anti-bloat, shared-helper reuse, and bounded hot-path behavior,
   2. strengthen `valua-py-quality-policy` for prediction/model code, boundary validation, exception hygiene, and duplication control,
   3. strengthen `valua-quality-core` / `valua-code-quality-gate` so shared anti-slop rules apply consistently across stack-specific skills.
13. Apply quality expectations to role overlays without bloating prompt context:
   1. `AGENTS.md` stays canonical and concise,
   2. `CLAUDE.md` and `valua-opus-consult` explicitly reinforce evidence-driven, minimal, non-duplicative recommendations,
   3. stack-specific examples stay in focused quality skills / `REVIEW.md`, not repeated in full across every overlay.

## Phase 2 (Cockpit): runtime enforcement

Owner: Codex (this agent)
Primary repo: `agentic-cockpit`
Commit target: fresh cockpit implementation PR branch cut from current `main`
Baseline rule: Phase 2 starts from `/home/prop_/projects/agentic-cockpit` on current `main`; do not implement from the old PR24 worktree
Landing rule: all Phase 2 runtime/tests/perf commits land in `agentic-cockpit` repo only (never in Valua repo).

Required files:

1. `scripts/agent-codex-worker.mjs`
2. `scripts/lib/agentbus.mjs`
3. `scripts/lib/opus-consult-gate.mjs`
4. `scripts/agent-opus-consult-worker.mjs`
5. `scripts/agent-orchestrator-worker.mjs`
6. `AGENTS.md`
7. `CLAUDE.md`
8. `.codex/skills/cockpit-code-quality-gate/SKILL.md`
9. `.codex/skills/cockpit-opus-consult/SKILL.md`
10. `scripts/init-project.mjs`
11. `scripts/__tests__/codex-worker-autopilot-context.test.mjs`
12. `scripts/__tests__/codex-worker-app-server.test.mjs`
13. `scripts/__tests__/codex-worker-opus-gate.test.mjs`
14. `scripts/__tests__/codex-worker-output-schema.test.mjs`
15. `scripts/__tests__/agent-bus.test.mjs`
16. `scripts/__tests__/opus-consult-worker.test.mjs`
17. `scripts/__tests__/orchestrator-worker.test.mjs`
18. Optional focused new test file if needed for advisory accountability clarity

Coupled docs/surfaces that must update in the same PR when touched:

1. `docs/agentic/RUNTIME_FUNCTION_REFERENCE.md`
2. `docs/agentic/CONTROL_LOOP_AND_PACKET_FLOW.md`
3. `docs/agentic/agent-bus/PROTOCOL.md`
4. `DECISIONS.md`
5. `docs/agentic/DECISIONS_AND_INCIDENTS_TIMELINE.md`

Phase 2 scope:

1. Modularize consult runtime first:
   1. extract consult consumer/wait/fallback/sender-validation paths from `scripts/agent-codex-worker.mjs` into `scripts/lib/opus-consult-gate.mjs` before behavior deltas,
   2. keep this extraction mechanical (no behavior change) as the first cockpit commit in Phase 2.
   3. Implementation note (module boundary): extract and preserve top-level exports for:
      `deriveOpusConsultGate`, `buildOpusConsultRequestPayload`, `dispatchOpusConsultRequest`, `emitSyntheticOpusConsultResponse`, `waitForOpusConsultResponse`, `runOpusConsultPhase`, `buildOpusAdviceItems`, `buildOpusConsultAdvice`, `normalizeOpusReasonCode`, `buildOpusAdvisoryFallbackPayload`, `readOpusConsultResolution`, `writeFirstOpusConsultResolution`.
2. Keep advisory consult pass-through in advisory mode (no hard disposition parser gate).
3. Enforce tracked follow-up for deferred Opus-advised work.
4. Keep advisory mode non-blocking in principle, but block `done` closure on deferred-tracking violations (`needs_review` outcome).
5. Emit deterministic telemetry for consult results and deferred-tracking decisions.
6. Enforce autopilot-first consult request quality:
   1. pre-consult payload must carry a non-generic hypothesis summary,
   2. autopilot question/context message must be evidence-based and non-null on merge/remediation-critical kinds.
7. Add prompt-context budgeting and dedup in worker injection path:
   1. avoid re-injecting full charter and full skill corpus each turn,
   2. inject compact context snapshot + focused references,
   3. emit context-size telemetry for postmortem and regression tests.
8. Restore review coverage for commit-bearing execute completions regardless receipt success state:
   1. if `completedTaskKind=EXECUTE` and `commitSha` is present, review target signals must still be emitted,
   2. autopilot must not skip built-in review only because source receipt outcome is `blocked|needs_review|failed`.
9. Fix runtime advisory telemetry bug:
   1. remove placeholder disposition telemetry that implies enforced ack coverage where no parser gate exists,
   2. keep telemetry aligned with actual enforcement (deferred tracking + follow-up evidence).
10. Remove over-broad hot-path skillops blocking from digest loops:
   1. keep SkillOps evidence where policy requires it,
   2. avoid requiring debrief/distill/lint on every non-critical `ORCHESTRATOR_UPDATE`.
11. Fix stale integration-branch inheritance for delegated EXECUTE follow-ups:
   1. do not reuse unrelated legacy `references.git.integrationBranch` from prior roots/workstreams,
   2. ensure integration branch resolution is root/workstream-consistent and deterministic per active PR root,
   3. prevent PR106 branch leakage into PR114 follow-ups.
12. Remove self-block-after-commit behavior on `USER_REQUEST`:
   1. if autopilot produced a real `commitSha` with source changes, runtime must not hard-stop as `blocked` only from delegation ordering,
   2. unresolved delegation must transition to `needs_review` with explicit required next action.
13. Ensure update/supersede continuity for advisory coverage:
   1. when a task update arrives mid-turn, required Opus IDs must be recomputed from the latest consult state,
   2. update-introduced deferred items cannot be dropped by stale pre-update note state.
14. Fix consult transport false-positive blocking:
   1. narrow suspicious-text detection so benign lifecycle wording does not hard-block OPUS consult packets,
   2. retain hard blocking for genuinely destructive payload patterns.
   3. Implementation note (body-only screening path): run `detectSuspiciousText(body)` before `renderTaskMarkdown(...)`; do not run suspicious screening on fully rendered markdown/frontmatter.
15. Add immediate terminal consult fallback in advisory mode:
   1. if consult request yields terminal blocked/failed before any `OPUS_CONSULT_RESPONSE`, synthesize advisory fallback immediately,
   2. do not wait full consult timeout window in this path.
16. Make fallback loop-safe:
   1. synthetic advisory fallback emission must not be re-blocked by the same suspicious-text filter,
   2. fallback path must be deterministic and non-recursive.
17. Add runtime observability for consult transport terminals:
   1. explicit reason code + telemetry when request transport was blocked pre-response,
   2. include fallback source (`synthetic`) and parent consult linkage.
18. Add non-blocking advisory disposition telemetry:
   1. best-effort parse `OPUS_DISPOSITIONS` lines for observability only,
   2. emit telemetry fields (`requiredCount`, `acknowledgedCount`, `missingCount`, `parseStatus`, `parseErrorCount`) for audit/postmortem,
   3. parse errors or malformed lines must never be a standalone hard gate in advisory mode.
19. Optimize consult response waiting path for performance:
   1. replace unconditional full-inbox polling loop with event-assisted wait (`fs.watch` or equivalent) plus bounded fallback polling,
   2. keep deterministic timeout semantics and cancellation behavior,
   3. avoid high-frequency full inbox scans during steady-state idle waits.
   4. Implementation note: use `fs.watch` (not `fs.watchFile`) on consult inbox state dirs; on watcher signal run one bounded poll cycle, plus fallback poll at 2-5s for platforms where watcher delivery is unreliable.
20. Add startup config coherence warnings (non-blocking):
   1. emit explicit warnings for contradictory mode/barrier/protocol combinations (for example advisory + enforced barrier, gate + freeform-only if semantics conflict),
   2. do not block startup; warnings are for operator correctness and postmortem clarity.
21. Optimize AgentBus context-build I/O hot path:
   1. optimize `recentReceipts` so it does not stat+read+parse every candidate receipt before top-N selection,
   2. optimize `statusSummary` to avoid sequential per-agent/per-state directory scans (parallelize and/or short TTL cache),
   3. avoid duplicate inbox scans in a single turn by reusing already-collected inbox snapshots where possible.
   4. Implementation note: preferred baseline is `fs.readdir(..., { withFileTypes: true })` + bounded candidate parsing; optional advanced path is append-only `receipt-index.json` updated atomically by `closeTask`.
22. Fix suspicious-screening precision in `scripts/lib/agentbus.mjs`:
   1. replace bare lifecycle-word blocking (`shutdown`, `reboot`) with context-aware dangerous command detection,
   2. run suspicious screening against task body text only (exclude JSON frontmatter serialization),
   3. retain hard blocking for clearly destructive command signatures.
   4. Implementation note (pattern shape): treat `shutdown`/`reboot` as dangerous in command contexts (for example with `sudo`, `systemctl`, shell operators, or explicit flags); bare prose uses (for example `graceful shutdown sequence`) must pass.
23. Add worker-local caching/refactor for repeated immutable reads:
   1. cache `computeSkillsHash` across turns (invalidate on policy sync / skill file change),
   2. merge duplicated autopilot context builders into one parameterized implementation for consistent budget enforcement,
   3. cache opus consult prompt/skill asset resolution at startup in `agent-opus-consult-worker.mjs` with deterministic refresh policy.
24. Tighten runtime implementation-quality expectations for execution tasks:
   1. config files are code and anti-duplication rules apply equally to `nginx`, `systemd`, CI, and deploy scripts,
   2. when touched files repeat a shared block, quality review must prefer extraction to a snippet/include/helper/template over mirrored inline copies,
   3. review evidence for critical infra/config changes must explicitly mention the shared source of truth used.
25. Surface repo-local review policy into agent closure:
   1. when a touched path has a repo-local `REVIEW.md`, autopilot/executor must treat it as binding review policy,
   2. reviewer-flagged violations of those rules must close as `needs_review` until fixed.
26. Strengthen SkillOps enforcement for reviewer-found pattern failures:
   1. if a task goes through a duplication/slop/bloat review loop, closure evidence must include non-empty `skill_updates` and completed decision record,
   2. empty learning evidence after a confirmed pattern failure is invalid closure evidence.
27. Bake default full-stack quality policy into cockpit for all downstream repos:
   1. strengthen cockpit-bundled quality skills so they speak concretely to common stacks (`TypeScript`, `Python`, DB/API, infra/config),
   2. update cockpit `AGENTS.md`, `CLAUDE.md`, and `cockpit-opus-consult` so quality expectations are explicit but concise,
   3. update `scripts/init-project.mjs` so new downstream repos inherit the strengthened default policy surfaces rather than an under-specified baseline.
28. Keep quality guidance high-signal and non-duplicative across overlays:
   1. `AGENTS.md` stays the canonical shared charter,
   2. `CLAUDE.md` and consultant skills point to the canonical charter and add only role-specific quality behavior,
   3. stack-specific concrete examples live in focused quality-policy skills or `REVIEW.md` files.

## 3. Gate Contract (normative)

1. In advisory mode, consult output is non-blocking and pass-through by default.
2. IDs must never be synthesized from freeform bullet lists.
3. Allowed advisory handling states: `acted|skipped|deferred`.
4. `deferred` requires tracking evidence:
   1. follow-up task id, or
   2. issue URL, or
   3. receipt path.
5. Pre-merge flow must not silently ignore deferred high-signal advisory work.
6. Root closure must fail soft (`needs_review`) when deferred advisory has no tracking evidence.
7. Violations return `needs_review` with explicit reason code.
8. Pre/post consult phases both remain active where gate config requires them.
9. `OPUS_DISPOSITIONS` is encouraged as audit text but is not a hard parser gate in advisory mode.
10. Consult request quality contract:
   1. `autopilotHypothesis.summary` must include task-specific evidence and intended action rationale.
   2. Generic boilerplate summaries are invalid for merge/remediation-critical tasks.
   3. `autopilotMessage` must carry specific uncertainties/questions when seeking consult challenge.
11. Prompt context contract:
   1. Runtime must inject compact, non-duplicative policy context.
   2. Full charter/skills text should not be re-injected per turn when unchanged.
   3. Context budget telemetry must be emitted for autopilot turns.
   4. Worker-owned telemetry fields are mandatory (`contextBudgetClass`, prompt/context byte or character metrics, dedupe ratio/counters).
   5. Provider token counters (`inputTokens`, `cachedTokens`) are optional: emit when available, never fail-close when unavailable.
12. Commit-bearing review contract:
   1. review-gate targeting must be based on commit-bearing execute completions, not only `receiptOutcome=done`.
   2. built-in review must run before closeout when commit evidence exists for the active root flow.
13. Follow-up branch contract:
   1. `EXECUTE` follow-ups must resolve integration branch from current root context first.
   2. stale parent/source references from unrelated roots must not override current-root branch routing.
14. Self-commit closure contract:
   1. if `taskKind=USER_REQUEST` and `commitSha` exists with source changes, `delegate_required` must not be emitted as terminal `blocked`,
   2. runtime outcome must be `needs_review` until delegation proof exists (valid tiny-fix path or explicit follow-up dispatch evidence),
   3. commit-bearing review targeting must still be emitted for closeout.
15. Update assimilation contract:
   1. task supersede/update must preserve latest advisory obligations for the active root,
   2. closure cannot regress to pre-update advisory coverage once a newer consult response exists.
16. Consult transport safety contract:
   1. benign planning vocabulary in consult payloads must not trigger hard suspicious-policy block,
   2. destructive command signatures still fail closed.
17. Advisory terminal-handling contract:
   1. consult request terminal `blocked|failed` without response packet must degrade immediately via synthetic fallback,
   2. advisory mode must not sit in long timeout wait for this condition.
18. Fallback recursion contract:
   1. synthetic fallback dispatch must be immune to self-reblocking by suspicious policy,
   2. exactly one fallback emission per failed consult round.
19. Non-blocking disposition telemetry contract:
   1. runtime may collect best-effort parse telemetry from advisory notes,
   2. parse/format errors do not emit terminal parser reason codes in advisory mode,
   3. enforcement remains deferred-tracking based (`deferred` without evidence => `needs_review`).
20. Context-path efficiency contract:
   1. context assembly must avoid repeated full receipt/inbox scans in the same turn when equivalent snapshots are already available,
   2. hot-path context reads must remain bounded for large receipt histories.
21. Suspicious-screening precision contract:
   1. lifecycle planning narration (`shutdown sequence`, `graceful reboot`, `STOPPING=1`) must not be blocked by itself,
   2. blocking must target dangerous executable command intent, not benign prose terms,
   3. screening must evaluate message body content, not full rendered markdown frontmatter.
22. Worker cache contract:
   1. immutable/rarely-changing policy and skill artifacts should be cached per worker lifetime with explicit invalidation points,
   2. cache use must not change runtime semantics.
23. Implementation quality contract:
   1. config files (`nginx`, `systemd`, CI, deploy scripts) are code and subject to the same no-duplication/no-bloat rules as application code,
   2. repeated touched blocks must be extracted to a shared snippet/include/helper/template when a single source of truth is viable,
   3. "matching the existing duplicated pattern" is not valid justification.
24. Review policy contract:
   1. repo-local `REVIEW.md` for touched critical paths is binding for human/bot review and agent closure,
   2. missing required shared include/snippet or duplicated governed shared blocks must resolve as `needs_review`.
25. SkillOps learning contract:
   1. reviewer-confirmed pattern failures (duplication, slop, bloat) require non-empty `skill_updates` and completed decision record before final closure,
   2. learned heuristics must be concrete, testable, and path/domain specific,
   3. empty learning evidence after a confirmed pattern failure is invalid.
26. Whole-stack quality contract:
   1. TypeScript, Python, DB/API, and infra/config paths all require concrete anti-duplication and anti-bloat rules,
   2. the quality bar is "most efficient maintainable implementation", not "matches the existing local pattern",
   3. hot-path and persistence-layer changes require boundedness/performance reasoning, not just syntactic correctness.
27. Policy propagation contract:
   1. cockpit defaults must already carry the baseline quality policy for new downstream repos,
   2. `init-project` / bundled skills must propagate that baseline without requiring downstream rediscovery,
   3. downstream repos may tighten rules further, but cockpit must not start from a weak generic baseline.
28. Overlay concision contract:
   1. `AGENTS.md` is canonical,
   2. `CLAUDE.md` and Opus consultant skills must reinforce quality expectations without repeating the full charter,
   3. concise, pointer-based overlays are required to avoid context bloat.

## 4. Reason Code Set (closed)

1. `opus_deferred_untracked`
2. `opus_preconsult_hypothesis_generic`
3. `autopilot_consult_context_missing`
4. `prompt_context_budget_exceeded`
5. `review_target_missing_for_commit`
6. `self_block_after_commit`
7. `stale_integration_branch_inherited`
8. `advisory_update_regression`
9. `opus_request_blocked_by_suspicious_policy`
10. `opus_consult_terminal_without_response`
11. `implementation_duplicate_shared_block`
12. `review_rule_violation`
13. `skillops_learning_missing_after_pattern_failure`
14. `quality_bloat_regression`
15. `stack_quality_rule_violation`
16. `quality_policy_not_bootstrapped`
17. `overlay_policy_gap`

## 5. Acceptance Matrix

## 5.1 Runtime advisory accountability coverage

| ID | Phase | Scenario | Expected |
|---|---|---|---|
| AT-01 | pre_exec | advisory consult returns `pass|warn|block` recommendation | execution continues in advisory mode |
| AT-02 | pre_exec | consult auth/schema/transport failure | no hard-stop; advisory-safe continuation with telemetry |
| AT-03 | pre_exec | deferred advisory work with no tracking evidence | `needs_review`, `opus_deferred_untracked` |
| AT-04 | pre_exec | deferred advisory work with follow-up task id | Pass |
| AT-05 | pre_exec | deferred advisory work with issue URL | Pass |
| AT-06 | pre_exec | freeform has 12 bullets, structured `items[]` has 3 IDs | no synthetic ID expansion |
| AT-07 | post_review | deferred item remains untracked | `needs_review` (no `done`) |
| AT-08 | closure | telemetry consistency check | receipt fields match gate decision |

## 5.2 Follow-up tracking

| ID | Scenario | Expected |
|---|---|---|
| FT-01 | Infra advisory deferred | TAR/issue evidence required before `done` |
| FT-02 | QA advisory deferred | TAR/issue evidence required before `done` |
| FT-03 | Deferred item later resolved | Resolution references completion receipt/task id |
| FT-04 | Deferred item has no tracking artifact | Forced `needs_review` |

## 5.3 Merge + resync interaction

| ID | Scenario | Expected |
|---|---|---|
| RS-01 | Merge succeeds and advisory gates pass | post-merge resync telemetry present |
| RS-02 | Merge succeeds but post-review coverage fails | merge may exist, root cannot close `done` |
| RS-03 | No merge performed | no post-merge resync trigger |
| RS-04 | EXECUTE receipt is `blocked` but contains commitSha | review target still emitted; autopilot review required before closeout |
| RS-05 | USER_REQUEST produced commitSha + delegation unresolved | `needs_review` (not terminal `blocked`), `self_block_after_commit`, explicit follow-up required |
| RS-06 | post-merge resync lock file exists from dead pid | stale lock reclaimed/ignored deterministically; resync proceeds once without double-run |

## 5.4 Prompt/behavior

| ID | Scenario | Expected |
|---|---|---|
| PB-01 | Opus suggests specialist routing | Autopilot dispatches or explicitly skips/defer+rationale |
| PB-02 | Opus suggestion exceeds consultant authority | Autopilot remains dispatch authority |
| PB-03 | High-risk advisory appears | Must be addressed (act/skip/defer+tracking) before merge/closure |
| PB-04 | Non-blocking cleanup advisory | Can defer only with tracking evidence |
| PB-05 | Initial USER_REQUEST arrives | pre-exec consult always runs (critical-scope retained) |
| PB-06 | Non-critical ORCHESTRATOR_UPDATE digest | consult skipped by scope policy |

## 5.5 Autopilot-first consult quality

| ID | Scenario | Expected |
|---|---|---|
| AQ-01 | pre-exec consult request on merge/remediation task uses generic hypothesis text only | `needs_review`, `opus_preconsult_hypothesis_generic` |
| AQ-02 | pre-exec consult request includes evidence-backed hypothesis + explicit alternatives | Pass |
| AQ-03 | consult request omits autopilot uncertainty/challenge prompt where required | `needs_review`, `autopilot_consult_context_missing` |
| AQ-04 | consult request includes concrete uncertainty list and targeted ask to Opus | Pass |
| AQ-05 | initial USER_REQUEST consult omitted by scope narrowing | Fail (policy violation) |

## 5.6 Prompt-context efficiency

| ID | Scenario | Expected |
|---|---|---|
| CX-01 | repeated turns inject full AGENTS + full skills corpus unchanged | Fail budget, `prompt_context_budget_exceeded` |
| CX-02 | repeated turns inject compact snapshot + stable references only | Pass |
| CX-03 | worker-owned context telemetry fields emitted (`contextBudgetClass`, prompt/context size metrics, dedupe metrics) | Pass |
| CX-03b | provider token counters unavailable from app-server (`inputTokens`, `cachedTokens`) | non-blocking; telemetry remains valid with null/omitted provider token fields |
| CX-04 | high-context root remains decision-stable after compaction-focused injection | Pass |

## 5.7 Review + SkillOps gate correctness

| ID | Scenario | Expected |
|---|---|---|
| RG-01 | TASK_COMPLETE from EXECUTE has commitSha and outcome=`done` | review gate required |
| RG-02 | TASK_COMPLETE from EXECUTE has commitSha and outcome=`blocked` | review gate still required |
| RG-03 | TASK_COMPLETE from EXECUTE has no commitSha | review gate not required |
| RG-04 | USER_REQUEST result has source-changing commitSha but delegation incomplete | review target emitted + closure held in `needs_review` |
| RG-05 | commit-bearing completion reaches closeout path but review target is absent | `needs_review`, `review_target_missing_for_commit` |
| SG-01 | non-critical ORCHESTRATOR_UPDATE digest | no forced debrief/distill/lint triplet |
| SG-02 | required SkillOps scope task | SkillOps evidence contract enforced |

## 5.9 Follow-up routing correctness

| ID | Scenario | Expected |
|---|---|---|
| FR-01 | PR114 digest emits EXECUTE follow-up after prior PR106 root history exists | integration branch resolves to PR114 branch, not PR106 branch |
| FR-02 | parent/source references contain stale integration branch from different root | stale branch ignored for current root/workstream |
| FR-03 | commit-bearing blocked execute digest (current root) | autopilot can slice/integrate commit onto correct PR branch deterministically |
| FR-04 | stale inherited integration branch reaches enforcement path | `needs_review`, `stale_integration_branch_inherited` |

## 5.8 Advisory telemetry regression guard

| ID | Scenario | Expected |
|---|---|---|
| DG-01 | advisory consult present | telemetry reflects actual consult outcome (no fake enforced-ack fields) |
| DG-02 | advisory mode with no OPUS_DISPOSITIONS block | no parser-driven retry/error loop |
| DG-03 | deferred advisory with follow-up evidence | telemetry marks tracking satisfied |

## 5.10 Update/supersede continuity

| ID | Scenario | Expected |
|---|---|---|
| UP-01 | Mid-turn USER_REQUEST update adds new advisory obligations | latest consult IDs become required set; no stale carry-over loss |
| UP-02 | Pre-update note dispositioned subset only; update introduces deferred item | closure held until deferred item is tracked |
| UP-03 | Supersede arrives after first commit in same root | runtime re-evaluates obligations against latest update/consult state before closeout |
| UP-04 | closeout path uses pre-update advisory state despite newer consult/update evidence | `needs_review`, `advisory_update_regression` |

## 5.11 Consult transport deadlock prevention

| ID | Scenario | Expected |
|---|---|---|
| CT-01 | consult payload contains benign lifecycle wording (`READY=1`, `STOPPING=1`, shutdown-path narrative) | no suspicious transport block |
| CT-02 | consult payload contains destructive signature (`rm -rf /`, `mkfs`, fork bomb) | hard blocked by suspicious policy |
| CT-03 | consult request task closes `blocked|failed` before response packet in advisory mode | immediate synthetic fallback; no long timeout wait |
| CT-04 | synthetic fallback emitted after transport terminal | parent autopilot flow progresses; consult round marked synthetic |
| CT-05 | fallback payload passes transport filter | no recursive fallback block/retry loop |
| CT-06 | consult transport terminal telemetry | `opus_request_blocked_by_suspicious_policy` or `opus_consult_terminal_without_response` captured |
| CT-07 | steady-state consult wait with no new packets | event-assisted wait path avoids high-frequency full-inbox scan while preserving timeout correctness |

## 5.12 Non-blocking disposition telemetry

| ID | Scenario | Expected |
|---|---|---|
| NT-01 | valid `OPUS_DISPOSITIONS` block present | telemetry counts align (`required/acknowledged/missing`) |
| NT-02 | malformed `OPUS_DISPOSITIONS` lines | `parseStatus=partial_or_invalid`, no parser fail-close |
| NT-03 | no `OPUS_DISPOSITIONS` block in advisory mode | no parser-driven retry loop; deferred-tracking rules still apply |
| NT-04 | advisory parse mismatch but all deferred items tracked | closure path unaffected by parser-only mismatch |

## 5.13 Runtime performance and screening

| ID | Scenario | Expected |
|---|---|---|
| PF-01 | `recentReceipts` with large history (for example 250+ candidate receipts) | bounded reads/parses; no full-candidate parse for top-N retrieval |
| PF-02 | `statusSummary` across full roster | directory scans execute in parallel and/or from short-lived cache |
| PF-03 | single autopilot turn with prior inbox scan available | context builder reuses snapshot and avoids duplicate full inbox scan |
| PF-04 | consult payload/body contains benign lifecycle wording (`shutdown sequence`, `graceful reboot`, `STOPPING=1`) | no suspicious-policy hard block |
| PF-05 | payload/body contains destructive command signature (`rm -rf /`, `mkfs`, fork bomb) | hard blocked by suspicious policy |
| PF-06 | suspicious term appears only in frontmatter metadata | no block (body-only screening) |
| PF-07 | repeated turns with unchanged skills/policy files | `computeSkillsHash` reused from cache with deterministic invalidation |
| PF-08 | thin vs full autopilot context mode | shared parameterized builder path with mode-specific limits only |
| PF-09 | opus consult worker handles multiple tasks in same process | prompt/skill asset resolution is cached; no repeated fallback-chain FS lookup each task |

## 5.14 Implementation quality and anti-slop enforcement

| ID | Scenario | Expected |
|---|---|---|
| IQ-01 | critical infra/config change duplicates a shared directive/header block across touched files or locations | `needs_review`, `implementation_duplicate_shared_block` |
| IQ-02 | governed Nginx `location` block defines `add_header` but omits required shared security-header include | `needs_review`, `review_rule_violation` |
| IQ-03 | critical infra/config change uses a shared snippet/include/template as the single source of truth | Pass |
| IQ-04 | touched critical path contains repo-local `REVIEW.md` rules | agent/reviewer treats those rules as binding |
| IQ-05 | reviewer flags duplication/slop pattern and closure evidence has empty `skill_updates` or blank decision record | `needs_review`, `skillops_learning_missing_after_pattern_failure` |
| IQ-06 | reviewer flags duplication/slop pattern and SkillOps records a concrete path-specific rule | Pass |
| IQ-07 | application code repeats helper/object-shape logic where an existing shared path is viable | `needs_review`, `quality_bloat_regression` |
| IQ-08 | hot-path change adds redundant scans / repeated work without bounded shared path or before/after evidence | `needs_review`, `quality_bloat_regression` |

## 5.15 Whole-stack quality coverage and policy propagation

| ID | Scenario | Expected |
|---|---|---|
| SQ-01 | TypeScript/API/UI/service change repeats logic where an existing shared path is viable | `needs_review`, `stack_quality_rule_violation` |
| SQ-02 | Python prediction/model change uses duplicated transforms or poor exception hygiene instead of a clean shared path | `needs_review`, `stack_quality_rule_violation` |
| SQ-03 | DB/API hot path changes without bounded query/performance reasoning | `needs_review`, `quality_bloat_regression` |
| SQ-04 | critical stack-specific quality surfaces exist in downstream repo (`ts`, `py`, infra/review`) and are aligned with shared quality core | Pass |
| SQ-05 | cockpit bundled defaults (`AGENTS.md`, `CLAUDE.md`, bundled skills, `init-project`) propagate baseline quality policy to a fresh downstream repo | Pass |
| SQ-06 | fresh downstream scaffold lacks baseline quality-policy propagation from cockpit | `needs_review`, `quality_policy_not_bootstrapped` |
| SQ-07 | consultant/overlay surfaces restate the full charter verbatim instead of staying concise and role-specific | `needs_review`, `overlay_policy_gap` |
| SQ-08 | consultant/overlay surfaces are concise, pointer-based, and still reinforce evidence-driven, efficient implementation quality | Pass |

## 6. Execution Order

1. Slice 0 (baseline capture only, no behavior change): reproduce the current consult transport failures and performance hotspots on current `main` under the default suspicious policy (`block`); record CT/PF baseline evidence for advisory transport, consult wait polling, `recentReceipts`, `statusSummary`, and duplicate inbox scans. No temporary `allow` override is permitted.
2. Slice 1 (Phase 1 / Valua contract + full-stack quality policy): cut a fresh Valua implementation branch from a clean upstream integration branch, implement Valua prompt/skill policy updates, add critical-path review rules, add shared-source-of-truth policy for repeated Nginx security headers, strengthen TS/Python/quality-core policy surfaces, keep AGENTS/CLAUDE/Opus overlays concise, and open Valua PR.
3. Baseline reset for Phase 2: cut a fresh cockpit implementation branch from current `main` in `/home/prop_/projects/agentic-cockpit`; do not use the old PR24 worktree.
4. Slice 2 (mechanical extraction only): extract consult runtime logic into `scripts/lib/opus-consult-gate.mjs` with zero behavior delta.
5. Slice 3 (wait-path performance): implement event-assisted consult wait (`fs.watch`) with bounded fallback poll and timeout parity (`CT-07`).
6. Slice 4 (consult deadlock fix): implement suspicious-screening precision + immediate advisory terminal fallback + loop-safe synthetic fallback (`CT-01..CT-06`, `PF-04..PF-06`).
7. Slice 5 (advisory accountability behavior): implement deferred-tracking enforcement, no synthetic ID expansion, and update/supersede obligation carry-forward (`AT-*`, `FT-*`, `UP-*`, `NT-*`).
8. Slice 6 (review/delegation/routing correctness): enforce commit-bearing review targeting, `needs_review` on self-commit delegation gaps, and root-correct integration branch routing (`RG-*`, `RS-04/05`, `FR-*`).
9. Slice 7 (context/perf hot path): optimize `recentReceipts`, `statusSummary`, duplicate inbox scans, `computeSkillsHash` cache, context-builder unification, and opus prompt/skill asset cache (`PF-01..PF-03`, `PF-07..PF-09`, `CX-*`).
10. Slice 8 (telemetry + startup coherence + quality closure hardening): align advisory telemetry with actual enforcement, add warning-only startup coherence checks, surface repo-local review rules into closure, require SkillOps learning evidence for confirmed pattern failures, and keep overlay guidance concise (`DG-*`, `NT-*`, `IQ-*`, `SQ-07/08`).
11. Slice 9 (cockpit default policy propagation): strengthen cockpit bundled quality/consult overlays and `init-project` so new downstream repos inherit the baseline quality policy by default (`SQ-05/06`).
12. Slice 10 (full verification): run full acceptance matrix in both repos and run live smoke on one merge-readiness flow + one deferred-follow-up flow.

## 6.1 Detailed Scope Retention (no scope removed)

The slice model is orchestration-only. It does not remove any Phase 2 scope item.
To avoid ambiguity, retained scope is listed by slice in chronological order:

1. Slice 0 (baseline capture only):
   1. capture current advisory transport failure evidence without changing runtime policy,
   2. capture before-state metrics/evidence for consult wait and context-build hot paths,
   3. do not use `AGENTIC_SUSPICIOUS_POLICY=allow` or equivalent as an implementation crutch.
2. Slice 2 (mechanical extraction):
   1. extract consult consumer/wait/fallback/sender-validation logic into `scripts/lib/opus-consult-gate.mjs`,
   2. keep behavior parity and test parity.
3. Slice 3 (wait-path performance):
   1. implement event-assisted wait (`fs.watch`) + bounded fallback polling,
   2. preserve timeout semantics.
4. Slice 4 (consult deadlock fix):
   1. patch suspicious screening precision (context-aware command patterns),
   2. move screening to body-only path (exclude rendered frontmatter),
   3. add advisory terminal fallback when consult request ends `blocked|failed` pre-response,
   4. ensure fallback is loop-safe (no recursive self-block).
5. Slice 5 (advisory accountability behavior):
   1. enforce deferred-tracking closure rules,
   2. keep advisory mode pass-through (no hard parser gate),
   3. keep no-synthetic-ID rule for freeform text,
   4. patch update/supersede advisory carry-forward logic,
   5. add non-blocking advisory disposition telemetry foundations (`NT-*`).
6. Slice 6 (review/delegation/routing correctness):
   1. restore commit-bearing review targeting for execute completions even when source receipt is `blocked|needs_review|failed`,
   2. patch self-block-after-commit ordering so unresolved delegation yields `needs_review` (not terminal `blocked`),
   3. patch integration-branch resolution to prevent stale cross-root inheritance.
7. Slice 7 (context/perf hot path):
   1. optimize `recentReceipts`, `statusSummary`, and duplicate inbox scan reuse,
   2. add `computeSkillsHash` cache with deterministic invalidation,
   3. unify full/thin context builders into one parameterized path and fold consult-advice context assembly into that shared path,
   4. cache opus prompt/skill asset resolution,
   5. baseline context budget telemetry.
8. Slice 8 (telemetry + startup coherence + quality closure hardening):
   1. remove placeholder advisory telemetry implying hard parser enforcement,
   2. align telemetry to actual enforcement path,
   3. add warning-only startup coherence checks for contradictory config combinations,
   4. surface repo-local `REVIEW.md` rules into closure/review interpretation for touched critical paths,
   5. enforce non-empty SkillOps learning evidence when a task closes through a confirmed duplication/slop review loop.
9. Slice 9 (cockpit default policy propagation):
   1. strengthen cockpit-bundled quality-policy and consultant surfaces for common stacks (`TypeScript`, `Python`, DB/API, infra/config),
   2. update cockpit `AGENTS.md`, `CLAUDE.md`, and `cockpit-opus-consult` to be concise, canonical/pointer-based, and quality-aware,
   3. update `scripts/init-project.mjs` so fresh downstream repos inherit that default baseline.
10. Slice 10 (verification):
   1. run consult transport deadlock matrix (`CT-*`) with readiness/shutdown wording payloads,
   2. run full acceptance matrix in both repos,
   3. validate one live merge-readiness flow and one deferred-follow-up flow,
   4. compare hot-path behavior against Slice 0 baseline evidence to confirm improvement without semantic drift,
   5. verify cockpit default bootstrap on a fresh downstream scaffold (`SQ-*`) as part of acceptance.

## 7. Definition of Done

1. Advisory consult failures in advisory mode can no longer hard-block execution.
2. Untracked deferred advisory can no longer return `done`.
3. No synthetic required IDs from freeform text.
4. Receipts expose deterministic advisory gate telemetry.
5. Pre-consult autopilot hypothesis is evidence-driven (non-boilerplate) on merge/remediation flows.
6. Live run demonstrates proper follow-up dispatch/traceability.
7. Prompt context telemetry and budget controls show reduced repeated policy injection.
8. Commit-bearing execute completions cannot bypass review due source receipt outcome classification.
9. Initial USER_REQUEST consult remains mandatory while digest consult noise is reduced.
10. Delegated execute follow-ups cannot inherit stale integration branch refs from unrelated prior roots.
11. Autopilot no longer ends in terminal `blocked` after producing a real commit solely from delegation ordering (`needs_review` + explicit next action instead).
12. Mid-task updates cannot silently drop new advisory obligations introduced after the first attempt.
13. Advisory consult can no longer deadlock on benign readiness/shutdown vocabulary in plan text.
14. Advisory consult request terminal failures degrade immediately via synthetic fallback without waiting full timeout.
15. Advisory disposition parse/format drift is observable via telemetry without reintroducing parser fail-close behavior.
16. Consult runtime logic is extracted from `scripts/agent-codex-worker.mjs` into `scripts/lib/opus-consult-gate.mjs` with parity tests.
17. Consult wait-path no longer depends on high-frequency full-inbox scanning during steady-state idle waits.
18. Contradictory consult-mode startup configs are surfaced with deterministic warnings.
19. Context-build hot path no longer performs avoidable full receipt/inbox rescans per turn.
20. Suspicious screening no longer blocks benign lifecycle wording and no longer inspects frontmatter metadata text.
21. Worker-local cache/refactor improvements reduce repeated per-turn filesystem reads without behavior drift.
22. No temporary suspicious-policy `allow` override is required to keep advisory consult transport functional during rollout.
23. Performance-sensitive slices include before/after evidence against Slice 0 baseline for consult wait and context-build hot paths.
24. Critical infra/config changes no longer land duplicated shared blocks when a single-source-of-truth snippet/include/helper is viable.
25. Repo-local critical-path review rules are in place and actually govern agent closure/review behavior.
26. Confirmed review pattern failures can no longer close with empty SkillOps learning evidence.
27. Whole-stack quality rules now cover TypeScript, Python, DB/API, and infra/config changes with concrete, non-abstract guidance.
28. Cockpit bundled defaults propagate that quality baseline into fresh downstream repos without manual rediscovery.
29. `AGENTS.md`, `CLAUDE.md`, and Opus consultant guidance remain concise, role-specific, and quality-aware without duplicating the full charter.

## 8. Handoff Notes

1. Autopilot executes Phase 1 in Valua PR.
2. Phase 1 must start from a fresh clean Valua branch; do not reuse stale local branches with gone upstreams.
3. Codex executes Phase 2 in a fresh `agentic-cockpit` PR branch cut from current `main`.
4. Cockpit Phase 2 includes default policy propagation work so these quality guarantees apply beyond Valua.
5. Both sides must verify against this same matrix ID set (`AT-*`, `FT-*`, `RS-*`, `PB-*`, `AQ-*`, `CX-*`, `RG-*`, `SG-*`, `FR-*`, `UP-*`, `CT-*`, `NT-*`, `PF-*`, `IQ-*`, `SQ-*`).
