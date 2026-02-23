# Runtime Function Reference

This is the function-level reference for Agentic Cockpit runtime code.

Scope:
- all runtime scripts in `scripts/**` (excluding tests)
- Valua adapter scripts in `adapters/valua/**`
- tmux launch/control scripts in `scripts/tmux/**`

Use with:
- `docs/agentic/CONTROL_LOOP_AND_PACKET_FLOW.md`
- `docs/agentic/VALUA_ADAPTER_RUNTIME.md`

## Runtime Entrypoints

| File | Entrypoint | Role |
| --- | --- | --- |
| `scripts/agent-bus.mjs` | `main()` | operator/API CLI for AgentBus operations |
| `scripts/agent-codex-worker.mjs` | `main()` | codex worker controller loop + closure gates |
| `scripts/agent-orchestrator-worker.mjs` | `main()` | deterministic digest forwarder/coalescer |
| `scripts/agent-listen.mjs` | `main()` | inbox listener for chat/inbox panes |
| `scripts/agent-dummy-worker.mjs` | `main()` | deterministic fake worker for smoke/testing |
| `scripts/observers/watch-pr.mjs` | `main()` | PR observer and REVIEW_ACTION_REQUIRED emitter |
| `scripts/dashboard/server.mjs` | `main()` | local dashboard HTTP+SSE server |
| `scripts/code-quality-gate.mjs` | `main()` | runtime quality gate checker |
| `scripts/skillops.mjs` | `main()` | skill debrief/distill/lint lifecycle |
| `scripts/skills-format.mjs` | `main()` | SKILL frontmatter formatter/checker |
| `scripts/validate-codex-skills.mjs` | `main()` | SKILL validator |
| `scripts/init-project.mjs` | `main()` | bootstrap cockpit files into downstream repo |
| `scripts/rollout-metrics.mjs` | `main()` | rollout JSONL telemetry summarizer |
| `scripts/continuity-ledger.mjs` | command switch | continuity ledger ensure/check |
| `scripts/agentic/sync-policy-to-worktrees.mjs` | `main()` | one-way root policy sync into worktrees |
| `adapters/valua/run.sh` | shell entrypoint | Valua adapter launch profile |
| `adapters/valua/restart-master.sh` | shell entrypoint | deterministic runtime master restart |
| `scripts/tmux/cockpit.sh` | shell entrypoint | tmux lifecycle wrapper |
| `scripts/tmux/agents-up.sh` | shell entrypoint | full cockpit startup wiring |
| `scripts/tmux/agents-down.sh` | shell entrypoint | tmux session shutdown |
| `scripts/agentic/setup-worktrees.sh` | shell entrypoint | per-agent worktree provisioning |
| `scripts/agentic/reset-agent-codex-state.sh` | shell entrypoint | codex state rotation/reset utility |
| `scripts/agentic/codex-chat-supervisor.sh` | shell entrypoint | resilient codex chat supervisor |
| `scripts/agentic/agent-listen-supervisor.sh` | shell entrypoint | resilient listener supervisor |
| `scripts/agentic/smoke-cockpit-codex.sh` | shell entrypoint | end-to-end cockpit smoke flow |

## Core Library: `scripts/lib/agentbus.mjs`

### Identity / path helpers
- `nowIso()`: canonical ISO timestamp for receipts/state entries.
- `makeId(prefix)`: deterministic-safe random id generator for packet ids.
- `isSafeId(id)`: filename-safe id validation.
- `getRepoRoot(cwd)`: git top-level discovery with cwd fallback.
- `getCockpitRoot()`: resolve cockpit root from script location.
- `defaultRosterPath(repoRoot)`: default roster path builder.
- `resolveRosterPath(...)`: choose roster path from explicit or default.
- `resolveBusRoot(...)`: choose bus root from args/env/default.
- `expandEnvVars(str, extra)`: expand env placeholders in roster paths.

### Roster + filesystem primitives
- `loadJson(filePath)`: JSON file loader.
- `loadRoster(...)`: roster parser + normalized agent map metadata.
- `ensureDir(p)`: mkdir -p primitive.
- `ensureAgentDirs(busRoot, agentName)`: create per-agent inbox/receipt/deadletter dirs.
- `ensureBusRoot(busRoot, roster)`: full bus dir scaffold.

### Packet parsing/rendering/validation
- `parseFrontmatter(markdown)`: split markdown into JSON meta + body.
- `renderTaskMarkdown(meta, body)`: write packet markdown format.
- `validateTaskMeta(meta)`: required fields/type enforcement.
- `detectSuspiciousText(text)`: suspicious command/text heuristics.
- `suspiciousPolicy()`: policy mode resolver (`block|warn|allow`).

### Packet write/delivery
- `writeTaskFile(...)`: atomic packet write into target inbox state.
- `deliverTask(...)`: fanout delivery to `to[]` recipients.

### Agent name selectors
- `pickOrchestratorName(roster)`: pick orchestrator name from roster/default.
- `pickDaddyChatName(roster)`: pick daddy chat name.
- `pickAutopilotName(roster)`: pick autopilot name.
- `rosterAgentNames(roster)`: normalized agent-name set.

### Packet state transitions
- `listInboxTaskIds(...)`: list ids under a specific inbox state.
- `findTaskPath(...)`: locate packet path across known inbox states.
- `moveTask(...)`: atomic file move between inbox states.
- `openTask(...)`: open packet and optionally move `new -> seen`.
- `updateTask(...)`: append update block to packet body/frontmatter.
- `claimTask(...)`: move packet into `in_progress` for worker execution.

### Receipt + closure
- `writeReceipt(...)`: receipt write with task metadata snapshot.
- `closeTask(...)`: finalize packet to `processed`, emit receipt, optional notify.
- `readReceipt(...)`: read a single receipt.
- `statusSummary(...)`: per-agent queue counts.
- `listInboxTasks(...)`: inspect packets with metadata for state/agent.
- `recentReceipts(...)`: most-recent receipts query.

## CLI Layer: `scripts/agent-bus.mjs`

- `usage()`: CLI contract text.
- `parseGlobalArgs(argv)`: command/global flag split.
- `parseToList(v)`: normalize `--to` list parsing.
- `assertKnownAgents(...)`: fail-closed on unknown recipient/agent names.
- `main()`: command dispatcher (`init/status/recent/open-tasks/send/update/open/close`).

`main()` is thin by design; it delegates all data mutation to `scripts/lib/agentbus.mjs`.

## Orchestrator: `scripts/agent-orchestrator-worker.mjs`

### Runtime helpers
- `sleep(ms)`: poll pacing.
- `isTruthyEnv(value)`: env bool parser.
- `trimToOneLine(value)`: digest-safe one-line sanitization.
- `truncateText(value, {maxLen})`: bounded digest payloads.
- `safeIdPrefix(value, fallback)`: safe id segment builder.
- `parseNonNegativeInt(value, fallback)`: numeric env/meta parsing.
- `tmuxNotify(message, target)`: optional pane notification.

### Digest builders
- `buildDigestVerbose(...)`: full digest body.
- `buildDigestCompact(...)`: compact digest body.
- `nextActionFor(...)`: deterministic recommended next-action note.

### Review gate derivation
- `buildReviewGateSignals(...)`: attaches review gate metadata only for reviewable successful EXECUTE completions.

### Coalescing + forwarding
- `findCoalescibleObserverDigestTaskId(...)`: find existing digest packet to update rather than duplicate.
- `forwardDigests(...)`: build and emit ORCHESTRATOR_UPDATE packets to autopilot and optional daddy.
- `main()`: orchestrator worker loop (claim packet, read receipt refs, forward, close source).

## Worker Core: `scripts/agent-codex-worker.mjs`

This file is the runtime nucleus. The functions are grouped below by execution phase.

### A) Utility and error types
- `sleep(ms)`: loop pacing/backoff waits.
- `writePane(text)`: stderr/pane-safe write.
- `CodexExecError`: normalized exec engine failure wrapper.
- `CodexExecTimeoutError`: structured timeout failure wrapper.
- `CodexExecSupersededError`: structured interruption/superseded wrapper.
- `parsePositiveInt(raw)`: safe integer parser.
- `formatDurationMs(ms)`: duration formatter for error text.
- `isTruthyEnv(value)`: env bool parse.
- `parseBooleanEnv(value, defaultValue)`: strict env bool parse.

### B) Codex process/env prep
- `resolveDefaultCodexBin()`: locate codex binary (sibling/path fallback).
- `createGitCredentialStoreEnv(...)`: ephemeral git credential store setup + cleanup.
- `isSandboxPermissionErrorText(value)`: classify sandbox-permission failures.
- `getCodexExecTimeoutMs(env)`: resolve worker timeout contract.
- `fileExists(p)`: async existence probe.
- `parseCodexSessionIdFromText(text)`: parse thread/session ids from output.
- `trimToOneLine(value)`: output sanitization.
- `truncateText(value, {maxLen})`: bounded snippets.
- `summarizeCommandName(value)`: compact command naming.
- `formatCodexJsonEvent(evt)`: app-server event to readable line.
- `maybeSendStatusToDaddy(...)`: optional status follow-up into daddy inbox.

### C) Session/persistence state IO
- `readTaskSession(...)` / `writeTaskSession(...)` / `deleteTaskSession(...)`: per-task thread persistence.
- `safeStateBasename(key)`: safe state filename helper.
- `readRootSession(...)` / `writeRootSession(...)`: root workflow thread pinning.
- `readPromptBootstrap(...)` / `writePromptBootstrap(...)`: bootstrap marker state.
- `writeJsonAtomic(filePath, value)`: atomic state writes.

### D) Engine execution paths
- `runCodexExec(...)`: `codex exec` process orchestration and output capture.
- `buildAppServerKey(...)`: shared app-server key derivation.
- `getSharedAppServerClient(...)`: singleton app-server client acquisition.
- `stopSharedAppServerClient()`: client shutdown/cleanup.
- `runCodexAppServer(...)`: app-server turn orchestration, interrupt/update path, event capture.
- `waitForGlobalCooldown(...)`: limiter backoff wait.

### E) Artifact materialization
- `resolveReviewArtifactPath(...)`: safe bus-relative review artifact path normalization.
- `buildReviewArtifactMarkdown(...)`: review artifact document renderer.
- `materializeReviewArtifact(...)`: write review artifact to bus artifacts path.
- `buildPreflightCleanArtifactMarkdown(...)`: preflight clean artifact renderer.
- `materializePreflightCleanArtifact(...)`: write preflight artifact.

### F) Codex home / process safety
- `normalizeCodexHomeMode(value)`: codex-home mode parser.
- `ensureCodexHome(...)`: per-agent codex-home provisioning/copy.
- `clearAgentPinnedSessions(...)`: remove pinned session ids.
- `isPidAlive(pid)`: process liveness check.
- `acquireAgentWorkerLock(...)`: per-agent single-writer lock.

### G) Skill selection + hashing
- `normalizeSkillName(name)`: skill token normalize.
- `isPlanningSkill(name)`: planning skill classifier.
- `isExecSkill(name)`: exec skill classifier.
- `selectSkills(...)`: task-kind-aware skill subset selection.
- `computeSkillsHash(...)`: selected-skill content hash for bootstrap checks.

### H) Review/quality gate derivation
- `readStringField(value)`: defensive string coercion.
- `normalizeCommitShaList(values)`: commit list normalization.
- `deriveReviewGate(...)`: derive mandatory review gate for task.
- `isExplicitReviewRequestText(value)`: explicit review intent detector.
- `extractCommitShaFromText(value)`: pull commit sha candidate from task body.
- `extractPrNumberFromText(value)`: pull PR number candidate from task body.
- `inferUserRequestedReviewGate(...)`: infer review gate from user request text.
- `deriveSkillOpsGate(...)`: infer SkillOps gate for current task kind.
- `deriveCodeQualityGate(...)`: infer code-quality gate for task kind.
- `deriveObserverDrainGate(...)`: infer observer-drain gate for root.
- `validateObserverDrainGate(...)`: enforce sibling observer queue-drain constraints.

### I) Prompt block builders
- `buildReviewGatePromptBlock(...)`: review gate instructions section.
- `reviewGatePrimeKey(reviewGate)`: stable key for review dedupe/priming.
- `buildSkillOpsGatePromptBlock(...)`: SkillOps instructions section.
- `buildCodeQualityGatePromptBlock(...)`: code quality instructions section.
- `buildObserverDrainGatePromptBlock(...)`: observer-drain instructions section.
- `buildPrompt(...)`: final prompt assembly for codex turn.

### J) Output evidence validation
- `hasNestedCodexCliUsage(value)`: reject recursive codex invocations.
- `validateAutopilotReviewOutput(...)`: strict review output/evidence validation.
- `normalizeTestsToRunCommands(value)`: normalize tests evidence list.
- `normalizeArtifactPaths(value)`: normalize artifact list.
- `isSkillOpsLogPath(value)`: validate SkillOps log path shape.
- `canResolveArtifactPath(...)`: check artifact path resolvability.
- `validateAutopilotSkillOpsEvidence(...)`: enforce SkillOps evidence contract.
- `runCodeQualityGateCheck(...)`: execute deterministic quality gate checker.
- `validateCodeQualityReviewEvidence(...)`: enforce hard-rule evidence keys.

### K) Follow-up dispatch and status context
- `normalizeToArray(value)`: defensive array normalization.
- `isStatusFollowUp(followUp)`: status-followup classifier.
- `safeExecText(...)` / `safeExecOk(...)`: shell probes for context checks.
- `readDeployJsonSummaryCached(url, {cwd})`: deploy summary lookup with cache.
- `readTextFileIfExists(filePath, {maxBytes})`: bounded file read helper.
- `writeAgentStateFile(...)`: persist lightweight worker state snapshot.
- `inboxHasTaskId(...)` / `isTaskInInboxStates(...)`: queue presence checks.
- `buildBasicContextBlock(...)`: baseline task context.
- `buildGitContractBlock(...)`: git contract context rendering.
- `buildReceiptGitExtra(...)`: git metadata for receiptExtra.
- `readRequiredIntegrationBranch(taskMeta)`: required integration branch extraction.
- `buildAutopilotContextBlock(...)`: rich autopilot runtime context.
- `buildAutopilotContextBlockThin(...)`: reduced autopilot context mode.

### L) Engine/session mode and follow-up git wiring
- `normalizeResumeSessionId(value)`: session id normalization.
- `normalizeCodexEngine(value)`: engine parser.
- `normalizeAutopilotContextMode(value)`: context mode parser.
- `readSessionIdFile(...)` / `writeSessionIdFile(...)`: stable session-id state.
- `isPlainObject(value)`: guard helper.
- `normalizeBranchToken(value)` / `normalizeRootIdForBranch(value)`: branch-safe tokens.
- `normalizeShaCandidate(value)` / `normalizeBranchRefText(value)`: git ref sanitization.
- `parseRemoteBranchRef(value)`: remote branch token parser.
- `readPrNumberCandidate(values)`: PR number extraction.
- `resolveIntegrationBranchForFollowUp(...)`: choose integration branch for follow-up.
- `resolveBaseShaForFollowUp(...)`: choose base sha for follow-up git contract.
- `buildDefaultWorkBranch(...)`: default follow-up work branch naming.
- `dispatchFollowUps(...)`: emit follow-up packets with resolved git references.

### M) Worker main loop
- `main()`: end-to-end worker lifecycle:
  - resolve runtime config/env
  - poll + claim packet
  - run task git preflight
  - build gates/prompt/context
  - run codex engine
  - validate output and evidence
  - emit follow-ups/status
  - close receipt with proper outcome

## Observer: `scripts/observers/watch-pr.mjs`

### Parsing and mode helpers
- `parsePrList(raw)`: explicit PR list parser.
- `resolveObserverProjectRoot(cliValue)`: repo root resolution.
- `parseMinPrNumber(value)`: min PR parser.
- `filterPrNumbersByMinimum(...)`: PR range filter.
- `normalizeColdStartMode(value)`: `baseline|replay` normalizer.
- `isUninitializedObserverState(state)`: first-run detector.

### Repo/comment classifiers
- `parseRepoNameWithOwnerFromRemoteUrl(remoteUrl)`: remote URL parser.
- `isBotLogin(login)`: bot account classifier.
- `isActionableComment(body)`: actionable keyword filter.
- `routeByPath(filePath)`: path-to-agent routing helper.

### GitHub API wrappers
- `safeExecText(...)`, `resolveTokenFromGh()`, `resolveRepoFromGh()`, `resolveRepoFromGit(...)`.
- `ghGraphQL(...)`: GraphQL query wrapper.
- `ghRestJson(...)`: REST query wrapper.
- `listOpenPrNumbers(...)`: list open PRs.
- `listIssueComments(...)`: list issue comments with paging.
- `readUnresolvedThreads(...)`: list unresolved review threads with paging.

### State/task builders
- `loadState(statePath)` / `saveState(statePath, state)`: observer watermark state persistence.
- `buildThreadTask(...)`: unresolved-thread task payload.
- `buildCommentTask(...)`: actionable-comment task payload.
- `emitTask(...)`: AgentBus task emit wrapper.
- `scanPr(...)`: single-PR scan and emission pipeline.
- `main()`: polling loop.

## Dashboard Server: `scripts/dashboard/server.mjs`

- `parseDashboardPort(raw)`: bounded port parser.
- `writeJson(...)` / `writeText(...)`: response writers.
- `readBodyJson(req)`: request body parser.
- `normalizeToArray(value)` / `safeString(...)`: payload sanitizers.
- `nowIso()`: timestamp helper.
- `isWsl()`: WSL environment probe.
- `commandExists(cmd)` / `spawnDetachedSafe(...)`: process invocation safety.
- `openBrowserBestEffort(url)`: best-effort auto-open.
- `guessContentType(filePath)` / `serveStatic(...)`: static file serving.
- `buildSnapshot(...)`: aggregate bus/roster state for dashboard.
- `createDashboardServer(...)`: HTTP route registration + SSE wiring.
- `main()`: launch server entrypoint.

## Quality + Skill Tooling Runtime

## `scripts/code-quality-gate.mjs`
- Implements deterministic check suite used by worker gate.
- Core flow: parse diff/paths, detect escapes/temp artifacts/duplication/diff balance, optional runtime script-tests requirement, optional skill validators, emit JSON report.
- Entrypoints:
  - `check(...)`: full gate execution pipeline.
  - `main()`: CLI command parser + check invocation.

## `scripts/skillops.mjs`
- Manages debrief logs and learned skill distillation.
- Core commands:
  - `cmdDebrief(...)`: write debrief log
  - `cmdDistill(...)`: distill log learnings into skills
  - `cmdLint(...)`: validate skill/learned-block structure
- `main()`: command router.

## `scripts/skills-format.mjs`
- Canonical SKILL frontmatter ordering/format.
- `main()` supports check/fix behavior based on flags.

## `scripts/validate-codex-skills.mjs`
- Strict SKILL file validation (frontmatter structure/order).
- `main()` reads skill files and exits non-zero on invalid format.

## Operational Utility Scripts

## `scripts/init-project.mjs`
- Bootstrap cockpit docs/skills into downstream project.
- `copyFileSafe` only overwrites with explicit force behavior.

## `scripts/rollout-metrics.mjs`
- Parse rollout JSONL files and produce token/usage metrics slices.

## `scripts/continuity-ledger.mjs`
- Ensure/check `.codex/CONTINUITY.md` structure and size constraints.

## `scripts/agent-listen.mjs`
- Lightweight listener that opens new packets into seen and prints compact headers.

## `scripts/agent-dummy-worker.mjs`
- Deterministic fake worker used for local smoke/integration tests.

## Library Modules

## `scripts/lib/task-git.mjs`
- `readTaskGitContract(meta)`: parse and normalize `references.git` contract.
- `getGitSnapshot({cwd})`: baseline git status/branch snapshot.
- `ensureTaskGitContract(...)`: enforce/create/switch to required work branch and base.

## `scripts/lib/commit-verify.mjs`
- `verifyCommitShaOnAllowedRemotes(...)`: verify commit exists on required integration remote/branch constraints.

## `scripts/lib/codex-limiter.mjs`
- Rate-limit detection and global cooldown/semaphore across workers.
- Exports:
  - `isOpenAIRateLimitText`
  - `isStreamDisconnectedText`
  - `parseRetryAfterMs`
  - `computeBackoffMs`
  - `readGlobalCooldown`
  - `writeGlobalCooldown`
  - `acquireGlobalSemaphoreSlot`

## `scripts/lib/codex-app-server-client.mjs`
- app-server request/response bridge used by worker app-server engine.
- handles request ids, approval policy, event stream normalization.

## `scripts/lib/worker-cli.mjs`
- shared worker CLI option parsing for listener/worker scripts.

## `scripts/lib/skill-frontmatter.mjs`
- frontmatter helper utilities used by skill validators/formatters.

## Shell Runtime Scripts (Behavior)

## tmux lifecycle
- `scripts/tmux/cockpit.sh`: top-level command router (`up/down/restart/attach/status`).
- `scripts/tmux/agents-up.sh`: full cockpit startup (env, session panes, observer/dashboard windows, workers/listeners).
- `scripts/tmux/agents-down.sh`: kill resolved session.

## agentic utilities
- `scripts/agentic/setup-worktrees.sh`: idempotent per-agent worktree create/sync scaffolding.
- `scripts/agentic/sync-policy-to-worktrees.mjs`: one-way policy sync root -> worktrees.
- `scripts/agentic/reset-agent-codex-state.sh`: rotate pin/index/codex-home for selected agents.
- `scripts/agentic/codex-chat-supervisor.sh`: resilient chat restart loop.
- `scripts/agentic/agent-listen-supervisor.sh`: resilient listener restart loop.
- `scripts/agentic/smoke-cockpit-codex.sh`: end-to-end smoke harness.

## Valua adapter
- `adapters/valua/run.sh`: profile launcher with Valua defaults.
- `adapters/valua/restart-master.sh`: deterministic runtime worktree repin/reset launcher.

## Change-Safety Checklist for Runtime Edits

When changing any runtime function in this document:
1. update related docs in this file and `CONTROL_LOOP_AND_PACKET_FLOW.md`
2. ensure command examples in README + adapter docs still match implementation
3. run relevant tests for touched modules (at minimum module-local tests)
4. if behavior changes, record decision/update in `DECISIONS.md` and summarize in `DECISIONS_AND_INCIDENTS_TIMELINE.md`
