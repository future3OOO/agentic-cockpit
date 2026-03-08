# Agentic Cockpit Control Interface V2 Blueprint (Decision-Complete)

## 1. Summary
This V2 spec upgrades `http://localhost:3210` from a task inbox UI into a full local control plane for AgentBus + adapters, with production-grade observability and editing controls.

Primary outcomes:
1. Real-time visibility of agent activity and file edits (in-progress + committed).
2. Repo/worktree explorer with safe file editing (skills first-class).
3. Per-task skill injection controls in packet composition.
4. Controlled execution of cockpit/adapter operations (restart, git ops) from UI.
5. Strong defaults for local trusted use with deterministic, testable behavior.

## 2. Final Architecture Decisions
1. **Runtime language**: Node.js (existing stack), no Go rewrite in V2.
2. **UI delivery model**: local web app on localhost (keep current model).
3. **Realtime transport**: SSE for server-to-client events, HTTP POST for commands.
4. **Desktop packaging**: deferred to Phase 6; V2 backend remains unchanged so it can be wrapped later (Tauri/Electron) without protocol rewrite.
5. **Trust model**: single-user trusted local host; bind to `127.0.0.1` by default.
6. **Scope owner model**: adapter project is runtime owner; cockpit remains tooling runtime. UI must surface both explicitly.

## 3. Scope and Non-Scope
### In scope
1. Cockpit dashboard backend and frontend expansion.
2. File browser/editor across cockpit + adapter project roots.
3. Live change telemetry across agent worktrees.
4. Packet-time skill override composition and runtime application.
5. Operator controls for restart and git actions through typed APIs.
6. Full docs update (`README`, `AGENTS.md`, `DECISIONS.md`, runtime docs).

### Out of scope
1. Rewriting workers/bus into Go.
2. Introducing remote multi-user auth in V2.
3. Replacing existing tmux launcher architecture.
4. Replacing AgentBus packet contract globally; only additive fields are allowed.

## 4. Production Constraints and Defaults
1. Default host: `127.0.0.1`.
2. Default port: `3210`.
3. Read roots: cockpit root, adapter project root, configured agent workdirs.
4. Write roots default: cockpit root + adapter project root only.
5. Agent workdirs are read-only by default to avoid dirty-worktree regressions.
6. Optional write enable for workdirs via env: `AGENTIC_DASHBOARD_ALLOW_WORKTREE_WRITES=1`.
7. File write size hard limit: 2 MB per save request.
8. Binary file editing blocked; read-only hex preview optional.
9. SSE event retention ring: 2000 events; reconnect support via `Last-Event-ID`.
10. Real-time propagation target: median < 1.5s, p95 < 3s.

## 5. Public API and Interface Changes (Additive)
All existing routes remain backward-compatible.

### 5.1 New API: Realtime Stream
1. `GET /api/events`
2. Response type: `text/event-stream`
3. Query:
- `since=<eventId>` optional replay anchor.
- `types=comma,list` optional filter.
4. Event envelope schema:
```json
{
  "eventId": "evt_20260302T...",
  "ts": "2026-03-02T12:34:56.789Z",
  "type": "snapshot|task|receipt|worker_state|repo_change|file_change|control_job",
  "source": {
    "agent": "frontend",
    "repoId": "valua",
    "workdir": "/path",
    "rootId": "msg_..."
  },
  "payload": {}
}
```

### 5.2 New API: Repository Discovery
1. `GET /api/repos`
2. Returns deterministic repo/worktree registry used by UI:
```json
{
  "repos": [
    { "id": "cockpit", "root": "/.../agentic-cockpit", "mode": "rw" },
    { "id": "project", "root": "/.../Valua", "mode": "rw" },
    { "id": "worktree:frontend", "root": "/.../worktrees/.../frontend", "mode": "ro" }
  ]
}
```

### 5.3 New API: Tree and File
1. `GET /api/repos/:repoId/tree?path=<rel>&depth=1`
2. `GET /api/repos/:repoId/file?path=<rel>`
3. `PUT /api/repos/:repoId/file`
4. Write request:
```json
{
  "path": ".codex/skills/valua-daddy-autopilot/SKILL.md",
  "content": "...",
  "etag": "sha256:...",
  "newline": "preserve"
}
```
5. Write response:
```json
{
  "ok": true,
  "path": "...",
  "etag": "sha256:new",
  "bytes": 1234,
  "changed": true
}
```

### 5.4 New API: Git/Change Views
1. `GET /api/changes/live`
2. `GET /api/changes/history?limit=100&rootId=<optional>`
3. `GET /api/repos/:repoId/diff?path=<rel>&base=HEAD`
4. Live payload includes in-progress + committed mapping by agent/worktree.

### 5.5 New API: Skills Catalog + Injection Preview
1. `GET /api/skills?agent=<name>`
2. `POST /api/task/preview` to preview final packet frontmatter/body before send.
3. `GET /api/agent/:agent/injection-preview?rootId=<optional>` returns what runtime will inject:
- active skills
- context snapshot summary
- relevant protocol overlays

### 5.6 Extended API: Task Send (Additive Contract)
Extend `POST /api/task/send` with optional:
```json
{
  "references": {
    "runtimeOverrides": {
      "skills": {
        "mode": "replace|append|subtract",
        "items": ["code-quality", "valua-daddy-autopilot"],
        "strict": true
      }
    }
  }
}
```
No other existing fields are changed.

### 5.7 New API: Control Jobs
1. `POST /api/control/run`
2. Request:
```json
{
  "op": "restart_cockpit|git_fetch|git_checkout|git_commit|git_push|git_merge",
  "repoId": "project",
  "args": { "branch": "master", "message": "..." }
}
```
3. `GET /api/control/jobs/:id`
4. Control job progress is emitted on SSE (`type=control_job`).

## 6. Runtime Behavior Changes
### 6.1 Dashboard backend (`scripts/dashboard/server.mjs`)
1. Add SSE endpoint and event fanout.
2. Add repo registry resolution from roster/env.
3. Add tree/file/diff/changes/control routes.
4. Keep legacy polling endpoints unchanged.
5. Fix docs/code mismatch by implementing real SSE behavior that docs already describe.

### 6.2 New backend modules
1. `scripts/dashboard/lib/repos.mjs` path resolution, allowlist checks, symlink escape prevention.
2. `scripts/dashboard/lib/file-ops.mjs` read/write/etag/binary detection/atomic save.
3. `scripts/dashboard/lib/change-monitor.mjs` near-real-time detector.
4. `scripts/dashboard/lib/event-bus.mjs` in-memory ring buffer + SSE replay.
5. `scripts/dashboard/lib/control-jobs.mjs` typed async job runner and state.

### 6.3 Real-time edit detection strategy
1. No recursive `fs.watch` dependency as primary mechanism.
2. Per-workdir monitor loop every 1s:
- run `git status --porcelain -z`
- compare digest against previous sample
- emit `repo_change` when changed
3. On demand file-level view:
- UI requests file content/diff only for selected files.
4. This provides stable near-real-time across Linux/WSL without watcher edge-case drift.

### 6.4 Worker skill override application (`scripts/agent-codex-worker.mjs`)
1. Add deterministic resolution step:
- baseline skills from roster/profile.
- apply packet `references.runtimeOverrides.skills`.
2. Mode semantics:
- `replace`: final = override items.
- `append`: final = baseline + new unique items.
- `subtract`: final = baseline - items.
3. Validation:
- unknown skill in `strict=true` => task blocked with explicit reason.
- unknown skill in `strict=false` => ignored with warning in receipt.
4. Write applied skill list into receipt metadata for audit (`receiptExtra.appliedSkills`).

## 7. UI V2 Feature Set
### 7.1 New panes
1. **Realtime Activity**: stream of task/receipt/worker/repo/file events.
2. **Repo Explorer**: multi-root tree (cockpit, project, worktrees).
3. **Editor**: file view/edit/save with etag conflict handling.
4. **Changes**: in-progress + committed file changes by agent/root.
5. **Task Composer V2**: packet preview + skill injection controls.
6. **Control Panel**: restart and git operations with job status.

### 7.2 UX defaults
1. Auto-reconnect SSE with backoff.
2. Fallback to 10s snapshot polling on stream failure.
3. Dirty editor indicator and conflict banner.
4. Confirmation dialog for destructive control ops (`git_merge`, force checkout/reset only if later added).

## 8. Data Flow (Critical Scenarios)
### 8.1 Agent edits file in worktree
1. Monitor detects `git status` delta.
2. SSE emits `repo_change`.
3. UI updates changed-files panel.
4. User clicks file; UI fetches file/diff on demand.
5. If task closes with commit, `receipt` event links commit files to root/task history.

### 8.2 User injects skills and sends task
1. UI selects target agent and skill override mode/items.
2. `/api/task/preview` confirms final packet and override payload.
3. `/api/task/send` enqueues packet with `references.runtimeOverrides`.
4. Worker resolves final skills and records `receiptExtra.appliedSkills`.
5. UI shows applied skill set in task detail and receipt.

### 8.3 User edits `SKILL.md`
1. UI opens skill file under allowed root.
2. Save uses `PUT /api/repos/:repoId/file` with etag.
3. Server writes atomically and emits `file_change`.
4. UI refreshes skill catalog for affected agents.

## 9. Safety and Failure Modes
1. Path traversal or symlink escape attempt => HTTP 400/403, audited event.
2. Etag mismatch on save => HTTP 409 with server version metadata.
3. Binary file save attempt => HTTP 415.
4. Monitor command failure (`git` unavailable) => stream warning event, no crash.
5. Control job failure => deterministic error payload with stdout/stderr capture.
6. SSE backpressure => bounded queue per client, drop oldest with explicit overflow event.
7. Unknown control op => HTTP 400.
8. Unknown repoId => HTTP 404.

## 10. Test Plan
### 10.1 Unit tests
1. Repo allowlist path resolution rejects traversal and symlink escape.
2. File ops etag conflict behavior.
3. Binary detection and size limits.
4. Skill override resolver (`replace|append|subtract`, strict vs non-strict).
5. Event ring replay order and `Last-Event-ID` resume behavior.

### 10.2 Integration tests
1. SSE emits task, receipt, and repo change events in deterministic order.
2. Live changes endpoint reflects in-progress and committed updates correctly.
3. File edit persists and event stream notifies subscribers.
4. Control jobs run typed git operations and persist job status.
5. Backward compatibility for existing snapshot/send/update/cancel endpoints.

### 10.3 End-to-end tests
1. Compose task with skill override, send, verify applied skills in receipt.
2. Edit skill file from UI and verify catalog refresh.
3. Observe agent worktree change in UI within SLA.
4. Run restart control op and verify dashboard recovers stream.

### 10.4 Performance tests
1. 8+ monitored workdirs, 10k+ files each, monitor loop p95 < 3s.
2. SSE with 3 concurrent clients stays stable for 60m.
3. API latencies: p95 under 300ms for tree/file metadata operations.

## 11. Documentation Plan (Required)
Update all of these in the same implementation cycle:
1. `README.md`:
- dashboard capabilities
- new API surface
- restart/control usage
- trust model and safety limits
2. `AGENTS.md`:
- operator workflow expectations for V2 UI usage
- skill injection policy and precedence
3. `DECISIONS.md`:
- Node+SSE decision
- desktop packaging deferred decision
- trusted-local security model
4. `docs/agentic/CONTROL_LOOP_AND_PACKET_FLOW.md`:
- accurate SSE implementation details
5. `docs/agentic/RUNTIME_FUNCTION_REFERENCE.md`:
- new dashboard module function list
6. `docs/runbooks/TMUX.md`:
- updated dashboard interaction and control job behavior

## 12. Implementation Phases
### Phase A: Core Realtime Foundation
1. SSE event bus.
2. change monitor loop.
3. stream UI panel.
4. tests for event delivery/reconnect.

### Phase B: Repo Explorer + Editor
1. repo registry API.
2. tree/file endpoints.
3. editor with etag save.
4. tests for path safety and conflicts.

### Phase C: Skill Injection + Preview
1. send payload extension.
2. worker override resolution.
3. preview endpoint.
4. applied skill telemetry in receipts.
5. tests for strict/non-strict behavior.

### Phase D: Control Jobs
1. typed control API.
2. async job store + SSE updates.
3. restart + git op support.
4. failure handling tests.

### Phase E: Documentation + Hardening
1. docs alignment.
2. telemetry and performance tuning.
3. final acceptance validation.

## 13. Acceptance Criteria
1. Operator can view cockpit root, adapter project root, and agent worktrees in one UI.
2. Operator can edit skills/files safely from UI with conflict detection.
3. Operator can see near-real-time file change telemetry by agent/worktree.
4. Operator can send tasks with per-task skill injection and preview payload before send.
5. Worker applies overrides deterministically and records applied skills in receipts.
6. Operator can execute restart/git controls from UI and observe deterministic job outcomes.
7. Legacy dashboard behavior continues to work for existing routes.
8. Docs fully match runtime behavior; no “SSE documented but not implemented” mismatch remains.

## 14. Explicit Assumptions and Defaults
1. Local single-user trusted environment remains valid for V2.
2. Cockpit and adapter project are both locally accessible on disk.
3. Git CLI is available in runtime environment.
4. Skill identifiers map to installed/available skill catalog entries.
5. Desktop app packaging is a follow-up and does not change V2 API contracts.

## 15. Branch Baseline and Compatibility Policy
1. Implementation baseline (authoritative):
- repo/worktree: `/home/prop_/projects/.worktrees/agentic-cockpit-opus-gate-v4-3`
- branch: `feat/opus-gate-v4-3-implementation`
- head at plan save time: `a3efe87c600f455305476f41d34b5b03194911db`
2. Compatibility policy for V2 delivery:
- branch-first implementation against the baseline branch above.
- no dual-compat guard code for `main` in V2 scope.
- backport/port-to-main is a separate follow-up phase.
3. Runtime targeting:
- cockpit runtime for this implementation runs from the baseline worktree branch.
- adapter project remains runtime owner for project-side policies and roster context.
