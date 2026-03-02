import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import childProcess from 'node:child_process';
import { ensureBusRoot } from '../lib/agentbus.mjs';

function buildHermeticBaseEnv() {
  // Strip ambient runtime toggles so each test controls the worker env explicitly.
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('AGENTIC_') || key.startsWith('VALUA_')) {
      delete env[key];
    }
  }
  return env;
}

const BASE_ENV = buildHermeticBaseEnv();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function spawnProcess(cmd, args, { cwd, env }) {
  return new Promise((resolve) => {
    const proc = childProcess.spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d.toString('utf8')));
    proc.stderr.on('data', (d) => (stderr += d.toString('utf8')));
    proc.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

async function writeExecutable(filePath, contents) {
  await fs.writeFile(filePath, contents, 'utf8');
  await fs.chmod(filePath, 0o755);
}

async function writeTask({ busRoot, agentName, taskId, meta, body }) {
  const inbox = path.join(busRoot, 'inbox', agentName, 'new');
  await fs.mkdir(inbox, { recursive: true });
  const p = path.join(inbox, `${taskId}.md`);
  const raw = `---\n${JSON.stringify(meta)}\n---\n\n${body}\n`;
  await fs.writeFile(p, raw, 'utf8');
  return p;
}

function runGit(cwd, args) {
  childProcess.execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
}

async function createTestGitWorkdir({
  rootDir,
  dirtyFilePath = '',
  dirtyFileContents = '',
}) {
  const workdir = path.join(rootDir, 'work');
  await fs.mkdir(workdir, { recursive: true });
  runGit(workdir, ['init']);
  runGit(workdir, ['config', 'user.email', 'test@example.com']);
  runGit(workdir, ['config', 'user.name', 'Test User']);
  await fs.writeFile(path.join(workdir, 'README.md'), 'seed\n', 'utf8');
  runGit(workdir, ['add', 'README.md']);
  runGit(workdir, ['commit', '-m', 'seed']);
  if (dirtyFilePath) {
    const abs = path.join(workdir, dirtyFilePath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, dirtyFileContents, 'utf8');
  }
  return workdir;
}

async function waitForPath(p, { timeoutMs = 5000, pollMs = 25 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await fs.stat(p);
      return true;
    } catch {
      // ignore
    }
    await sleep(pollMs);
  }
  return false;
}

const DUMMY_APP_SERVER = [
  '#!/usr/bin/env node',
  "import { createInterface } from 'node:readline';",
  "import { promises as fs } from 'node:fs';",
  '',
  "process.on('SIGTERM', () => process.exit(0));",
  "process.on('SIGINT', () => process.exit(0));",
  '',
  "const args = process.argv.slice(2);",
  "if (args[0] !== 'app-server') {",
  "  process.stderr.write('dummy-codex: expected app-server\\n');",
  '  process.exit(2);',
  '}',
  '',
  "const mode = process.env.DUMMY_MODE || 'basic';",
  "const countFile = process.env.COUNT_FILE || '';",
  "const reviewCountFile = process.env.REVIEW_COUNT_FILE || '';",
  "const reviewTargetSha = process.env.REVIEW_TARGET_SHA || 'abc123';",
  "const reviewScope = process.env.REVIEW_SCOPE || 'commit';",
  "const reviewCommitsRaw = process.env.REVIEWED_COMMITS || '';",
  "const reviewCommits = reviewCommitsRaw.split(',').map((s) => s.trim()).filter(Boolean);",
  "const reviewDelayMs = Math.max(0, Number(process.env.REVIEW_DELAY_MS || '0') || 0);",
  "const started1 = process.env.STARTED1 || '';",
  "const threadId = process.env.THREAD_ID || 'thread-app';",
  '',
  'async function bumpCount() {',
  '  if (!countFile) return 0;',
  '  let n = 0;',
  '  try { n = Number(await fs.readFile(countFile, \"utf8\")); } catch {}',
  '  n = Number.isFinite(n) ? n : 0;',
  '  n += 1;',
  '  await fs.writeFile(countFile, String(n), \"utf8\");',
  '  return n;',
  '}',
  '',
  'async function bumpReviewCount() {',
  '  if (!reviewCountFile) return 0;',
  '  let n = 0;',
  '  try { n = Number(await fs.readFile(reviewCountFile, "utf8")); } catch {}',
  '  n = Number.isFinite(n) ? n : 0;',
  '  n += 1;',
  '  await fs.writeFile(reviewCountFile, String(n), "utf8");',
  '  return n;',
  '}',
  '',
  'function send(obj) {',
  '  process.stdout.write(JSON.stringify(obj) + \"\\n\");',
  '}',
  '',
  'let startedWritten = false;',
  'let currentTurnId = null;',
  'let pendingInterrupted = new Set();',
  '',
  'const rl = createInterface({ input: process.stdin });',
  'rl.on(\"line\", async (line) => {',
  '  let msg;',
  '  try { msg = JSON.parse(line); } catch { return; }',
  '',
  '  if (msg && msg.id != null && msg.method === \"initialize\") {',
  '    send({ id: msg.id, result: {} });',
  '    return;',
  '  }',
  '',
  '  if (msg && msg.method === \"initialized\") {',
  '    return;',
  '  }',
  '',
  '  if (msg && msg.id != null && msg.method === \"thread/start\") {',
  '    send({ id: msg.id, result: { thread: { id: threadId } } });',
  '    return;',
  '  }',
  '',
  '  if (msg && msg.id != null && msg.method === \"thread/resume\") {',
  '    const t = msg?.params?.threadId || threadId;',
  '    send({ id: msg.id, result: { thread: { id: t } } });',
  '    return;',
  '  }',
  '',
  '  if (msg && msg.id != null && msg.method === \"turn/interrupt\") {',
  '    pendingInterrupted.add(String(msg?.params?.turnId || \"\"));',
  '    send({ id: msg.id, result: {} });',
  '    return;',
  '  }',
  '',
  '  if (msg && msg.id != null && msg.method === \"review/start\") {',
  '    await bumpReviewCount();',
  '    const turnId = `review-${Date.now()}`;',
  '    send({ id: msg.id, result: { turn: { id: turnId, status: \"inProgress\", items: [] } } });',
  '    send({ method: \"turn/started\", params: { threadId, turn: { id: turnId, status: \"inProgress\", items: [] } } });',
  '    send({ method: \"item/started\", params: { threadId, turnId, item: { id: `item-enter-${turnId}`, type: \"enteredReviewMode\" } } });',
  '    send({ method: \"item/agentMessage/delta\", params: { threadId, turnId, itemId: `review-msg-${turnId}`, delta: \"Built-in review findings\" } });',
  '    send({ method: \"item/completed\", params: { threadId, turnId, item: { id: `review-msg-${turnId}`, type: \"agentMessage\", text: \"Built-in review findings\" } } });',
  '    if (reviewDelayMs > 0) {',
  '      await new Promise((resolve) => setTimeout(resolve, reviewDelayMs));',
  '    }',
  '    send({ method: \"item/completed\", params: { threadId, turnId, item: { id: `item-exit-${turnId}`, type: \"exitedReviewMode\", review: \"Built-in review findings\" } } });',
  '    send({ method: \"turn/completed\", params: { threadId, turn: { id: turnId, status: \"completed\", items: [] } } });',
  '    return;',
  '  }',
  '',
  '  if (msg && msg.id != null && msg.method === \"turn/start\") {',
  '    await bumpCount();',
  '    const prompt = String(msg?.params?.input?.[0]?.text || \"\");',
  '    currentTurnId = `turn-${Date.now()}`;',
  '    send({ id: msg.id, result: { turn: { id: currentTurnId, status: \"inProgress\", items: [] } } });',
  '    send({ method: \"turn/started\", params: { threadId, turn: { id: currentTurnId, status: \"inProgress\", items: [] } } });',
  '',
  '    if (!startedWritten && started1) {',
  '      startedWritten = true;',
  '      await fs.writeFile(started1, \"\", \"utf8\");',
  '    }',
  '',
  '    if (mode === \"update\" && !prompt.includes(\"SENTINEL_UPDATE\")) {',
  '      // Wait for interrupt; worker should detect task file update and call turn/interrupt.',
  '      const interval = setInterval(() => {',
  '        if (!pendingInterrupted.has(currentTurnId)) return;',
  '        clearInterval(interval);',
  '        send({ method: \"turn/completed\", params: { threadId, turn: { id: currentTurnId, status: \"interrupted\", items: [] } } });',
  '      }, 20);',
  '      interval.unref?.();',
  '      return;',
  '    }',
  '',
  '    const note = prompt.includes(\"SENTINEL_UPDATE\") ? \"saw-update\" : \"ok\";',
  '    let payload = { outcome: \"done\", note, commitSha: \"\", followUps: [] };',
  '    if (mode === \"merge-commit-missing-local\") {',
  '      payload = {',
  '        outcome: \"done\",',
  '        note: process.env.MERGE_NOTE || \"Merged PR112 on master.\",',
  '        commitSha: process.env.MERGE_COMMIT_SHA || \"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",',
  '        followUps: []',
  '      };',
  '    }',
  '    if (mode === \"skillops-ok\") {',
  '      payload = {',
  '        outcome: \"done\",',
  '        note: \"skillops evidence recorded\",',
  '        commitSha: \"\",',
  '        planMarkdown: \"\",',
  '        filesToChange: [],',
  '        testsToRun: [',
  '          \"node scripts/skillops.mjs debrief --skills cockpit-autopilot --title \\\"autopilot debrief\\\"\",',
  '          \"node scripts/skillops.mjs distill\",',
  '          \"node scripts/skillops.mjs lint\"',
  '        ],',
  '        artifacts: [\".codex/skill-ops/logs/2026/02/skillops-proof.md\"],',
  '        riskNotes: \"\",',
  '        rollbackPlan: \"\",',
  '        followUps: [],',
  '        review: null',
  '      };',
  '    }',
  '    if (mode === \"skillops-missing\") {',
  '      payload = {',
  '        outcome: \"done\",',
  '        note: \"missing skillops evidence\",',
  '        commitSha: \"\",',
  '        planMarkdown: \"\",',
  '        filesToChange: [],',
  '        testsToRun: [],',
  '        artifacts: [],',
  '        riskNotes: \"\",',
  '        rollbackPlan: \"\",',
  '        followUps: [],',
  '        review: null',
  '      };',
  '    }',
  '    if (mode === \"quality-ok\") {',
  '      payload = {',
  '        outcome: \"done\",',
  '        note: \"quality evidence recorded\",',
  '        commitSha: \"\",',
  '        planMarkdown: \"\",',
  '        filesToChange: [],',
  '        testsToRun: [',
  '          \"node scripts/code-quality-gate.mjs check --task-kind USER_REQUEST\"',
  '        ],',
  '        artifacts: [\".codex/quality/logs/quality-proof.md\"],',
  '        qualityReview: {',
  '          summary: \"hardRules: all passed; script gate run\",',
  '          legacyDebtWarnings: 0,',
  '          hardRuleChecks: {',
  '            codeVolume: \"diff trimmed; no additive-only bloat\",',
  '            noDuplication: \"reused existing path; no duplicate blocks added\",',
  '            shortestPath: \"removed extra hops; direct flow kept\",',
  '            cleanup: \"startup/pre/post cleanup paths verified\",',
  '            anticipateConsequences: \"runtime script change covered by tests\",',
  '            simplicity: \"minimal implementation; no extra wrappers\"',
  '          }',
  '        },',
  '        riskNotes: \"\",',
  '        rollbackPlan: \"\",',
  '        followUps: [],',
  '        review: null',
  '      };',
  '    }',
  '    if (mode === \"quality-script-only\") {',
  '      payload = {',
  '        outcome: \"done\",',
  '        note: \"script run without explicit quality activation\",',
  '        commitSha: \"\",',
  '        planMarkdown: \"\",',
  '        filesToChange: [],',
  '        testsToRun: [',
  '          \"node scripts/code-quality-gate.mjs check --task-kind USER_REQUEST\"',
  '        ],',
  '        artifacts: [\".codex/quality/logs/quality-proof.md\"],',
  '        riskNotes: \"\",',
  '        rollbackPlan: \"\",',
  '        followUps: [],',
  '        review: null',
  '      };',
  '    }',
  '    if (mode === \"quality-missing\") {',
  '      payload = {',
  '        outcome: \"done\",',
  '        note: \"missing quality evidence\",',
  '        commitSha: \"\",',
  '        planMarkdown: \"\",',
  '        filesToChange: [],',
  '        testsToRun: [],',
  '        artifacts: [],',
  '        riskNotes: \"\",',
  '        rollbackPlan: \"\",',
  '        followUps: [],',
  '        review: null',
  '      };',
  '    }',
  '    if (mode === \"followup-execute\") {',
  '      payload = {',
  '        outcome: \"done\",',
  '        note: \"followup dispatched\",',
  '        commitSha: \"\",',
  '        planMarkdown: \"\",',
  '        filesToChange: [],',
  '        testsToRun: [],',
  '        artifacts: [],',
  '        riskNotes: \"\",',
  '        rollbackPlan: \"\",',
  '        followUps: [',
  '          {',
  '            to: [\"frontend\"],',
  '            title: \"execute child\",',
  '            body: \"implement child task\",',
  '            signals: { kind: \"EXECUTE\", phase: \"execute\", rootId: \"root1\", parentId: \"t1\", smoke: false }',
  '          }',
  '        ],',
  '        review: null',
  '      };',
  '    }',
  '    if (mode === \"followup-blocked-mixed\") {',
  '      payload = {',
  '        outcome: \"blocked\",',
  '        note: \"blocked with mixed followups\",',
  '        commitSha: \"\",',
  '        planMarkdown: \"\",',
  '        filesToChange: [],',
  '        testsToRun: [],',
  '        artifacts: [],',
  '        riskNotes: \"\",',
  '        rollbackPlan: \"\",',
  '        followUps: [',
  '          {',
  '            to: [\"daddy\"],',
  '            title: \"status unblock\",',
  '            body: \"run guarded master push\",',
  '            signals: { kind: \"STATUS\", phase: \"execute\", rootId: \"root1\", parentId: \"t1\", smoke: false }',
  '          },',
  '          {',
  '            to: [\"frontend\"],',
  '            title: \"execute child\",',
  '            body: \"should be suppressed while blocked\",',
  '            signals: { kind: \"EXECUTE\", phase: \"execute\", rootId: \"root1\", parentId: \"t1\", smoke: false }',
  '          }',
  '        ],',
  '        review: null',
  '      };',
  '    }',
  '    if (mode === \"review-gate\") {',
  '      payload = {',
  '        outcome: \"done\",',
  '        note: \"review gate satisfied\",',
  '        commitSha: \"\",',
  '        planMarkdown: \"\",',
  '        filesToChange: [],',
  '        testsToRun: [],',
  '        artifacts: [],',
  '        riskNotes: \"\",',
  '        rollbackPlan: \"\",',
  '        followUps: [],',
  '        review: {',
  '          ran: true,',
  '          method: \"built_in_review\",',
  '          targetCommitSha: reviewTargetSha,',
  '          scope: reviewScope,',
  '          reviewedCommits: reviewCommits.length ? reviewCommits : [reviewTargetSha],',
  '          summary: \"No blocking findings.\",',
  '          findingsCount: 0,',
  '          verdict: \"pass\",',
  '          evidence: {',
  '            artifactPath: \"artifacts/autopilot/reviews/t1.md\",',
  '            sectionsPresent: [\"findings\", \"severity\", \"file_refs\", \"actions\"]',
  '          }',
  '        }',
  '      };',
  '    }',
  '    if (mode === \"review-gate-retry\") {',
  '      if (prompt.includes(\"RETRY REQUIREMENT\")) {',
  '        payload = {',
  '          outcome: \"done\",',
  '          note: \"review gate retry satisfied\",',
  '          commitSha: \"\",',
  '          planMarkdown: \"\",',
  '          filesToChange: [],',
  '          testsToRun: [],',
  '          artifacts: [],',
  '          riskNotes: \"\",',
  '          rollbackPlan: \"\",',
  '          followUps: [],',
  '          review: {',
  '            ran: true,',
  '            method: \"built_in_review\",',
  '            targetCommitSha: reviewTargetSha,',
  '            scope: reviewScope,',
  '            reviewedCommits: reviewCommits.length ? reviewCommits : [reviewTargetSha],',
  '            summary: \"Retry passed.\",',
  '            findingsCount: 0,',
  '            verdict: \"pass\",',
  '            evidence: {',
  '              artifactPath: \"artifacts/autopilot/reviews/t1.retry.md\",',
  '              sectionsPresent: [\"findings\", \"severity\", \"file_refs\", \"actions\"]',
  '            }',
  '          }',
  '        };',
  '      } else {',
  '        payload = {',
  '          outcome: \"done\",',
  '          note: \"missing review on first pass\",',
  '          commitSha: \"\",',
  '          followUps: [],',
  '          review: null',
  '        };',
  '      }',
  '    }',
  '    const text = JSON.stringify(payload);',
  '    send({ method: \"item/agentMessage/delta\", params: { delta: text, itemId: \"am1\", threadId, turnId: currentTurnId } });',
  '    send({ method: \"item/completed\", params: { threadId, turnId: currentTurnId, item: { id: \"am1\", type: \"agentMessage\", text } } });',
  '    send({ method: \"turn/completed\", params: { threadId, turn: { id: currentTurnId, status: \"completed\", items: [] } } });',
  '    return;',
  '  }',
  '});',
  '',
].join('\n');

const DUMMY_APP_SERVER_START_COUNT = [
  '#!/usr/bin/env node',
  "import { createInterface } from 'node:readline';",
  "import { promises as fs } from 'node:fs';",
  '',
  "process.on('SIGTERM', () => process.exit(0));",
  "process.on('SIGINT', () => process.exit(0));",
  '',
  "const args = process.argv.slice(2);",
  "if (args[0] !== 'app-server') {",
  "  process.stderr.write('dummy-codex: expected app-server\\n');",
  '  process.exit(2);',
  '}',
  '',
  "const startCountFile = process.env.SERVER_START_COUNT_FILE || '';",
  "const resumeCountFile = process.env.RESUME_COUNT_FILE || '';",
  "const threadId = process.env.THREAD_ID || 'thread-app';",
  '',
  'async function bumpStartCount() {',
  '  if (!startCountFile) return;',
  '  let n = 0;',
  '  try { n = Number(await fs.readFile(startCountFile, \"utf8\")); } catch {}',
  '  n = Number.isFinite(n) ? n : 0;',
  '  n += 1;',
  '  await fs.writeFile(startCountFile, String(n), \"utf8\");',
  '}',
  '',
  'async function bumpResumeCount() {',
  '  if (!resumeCountFile) return;',
  '  let n = 0;',
  '  try { n = Number(await fs.readFile(resumeCountFile, \"utf8\")); } catch {}',
  '  n = Number.isFinite(n) ? n : 0;',
  '  n += 1;',
  '  await fs.writeFile(resumeCountFile, String(n), \"utf8\");',
  '}',
  '',
  'await bumpStartCount();',
  '',
  'function send(obj) {',
  '  process.stdout.write(JSON.stringify(obj) + \"\\n\");',
  '}',
  '',
  'let currentTurnId = null;',
  'const rl = createInterface({ input: process.stdin });',
  'rl.on(\"line\", async (line) => {',
  '  let msg;',
  '  try { msg = JSON.parse(line); } catch { return; }',
  '',
  '  if (msg && msg.id != null && msg.method === \"initialize\") {',
  '    send({ id: msg.id, result: {} });',
  '    return;',
  '  }',
  '',
  '  if (msg && msg.method === \"initialized\") {',
  '    return;',
  '  }',
  '',
  '  if (msg && msg.id != null && msg.method === \"thread/start\") {',
  '    send({ id: msg.id, result: { thread: { id: threadId } } });',
  '    return;',
  '  }',
  '',
  '  if (msg && msg.id != null && msg.method === \"thread/resume\") {',
  '    await bumpResumeCount();',
  '    const t = msg?.params?.threadId || threadId;',
  '    send({ id: msg.id, result: { thread: { id: t } } });',
  '    return;',
  '  }',
  '',
  '  if (msg && msg.id != null && msg.method === \"turn/start\") {',
  '    currentTurnId = `turn-${Date.now()}`;',
  '    send({ id: msg.id, result: { turn: { id: currentTurnId, status: \"inProgress\", items: [] } } });',
  '    send({ method: \"turn/started\", params: { threadId, turn: { id: currentTurnId, status: \"inProgress\", items: [] } } });',
  '',
  '    const payload = { outcome: \"done\", note: \"ok\", commitSha: \"\", followUps: [] };',
  '    const text = JSON.stringify(payload);',
  '    send({ method: \"item/agentMessage/delta\", params: { delta: text, itemId: \"am1\", threadId, turnId: currentTurnId } });',
  '    send({ method: \"item/completed\", params: { threadId, turnId: currentTurnId, item: { id: \"am1\", type: \"agentMessage\", text } } });',
  '    send({ method: \"turn/completed\", params: { threadId, turn: { id: currentTurnId, status: \"completed\", items: [] } } });',
  '    return;',
  '  }',
  '});',
  '',
].join('\n');

const DUMMY_APP_SERVER_CAPTURE_POLICY = [
  '#!/usr/bin/env node',
  "import { createInterface } from 'node:readline';",
  "import { promises as fs } from 'node:fs';",
  '',
  "process.on('SIGTERM', () => process.exit(0));",
  "process.on('SIGINT', () => process.exit(0));",
  '',
  "const args = process.argv.slice(2);",
  "if (args[0] !== 'app-server') {",
  "  process.stderr.write('dummy-codex: expected app-server\\n');",
  '  process.exit(2);',
  '}',
  '',
  "const policyFile = process.env.POLICY_FILE || '';",
  "const threadId = process.env.THREAD_ID || 'thread-app';",
  '',
  'function send(obj) {',
  '  process.stdout.write(JSON.stringify(obj) + "\\n");',
  '}',
  '',
  "const rl = createInterface({ input: process.stdin });",
  'rl.on("line", async (line) => {',
  '  let msg;',
  '  try { msg = JSON.parse(line); } catch { return; }',
  '',
  '  if (msg && msg.id != null && msg.method === "initialize") {',
  '    send({ id: msg.id, result: {} });',
  '    return;',
  '  }',
  '  if (msg && msg.method === "initialized") return;',
  '',
  '  if (msg && msg.id != null && msg.method === "thread/start") {',
  '    send({ id: msg.id, result: { thread: { id: threadId } } });',
  '    return;',
  '  }',
  '  if (msg && msg.id != null && msg.method === "thread/resume") {',
  '    const t = msg?.params?.threadId || threadId;',
  '    send({ id: msg.id, result: { thread: { id: t } } });',
  '    return;',
  '  }',
  '',
  '  if (msg && msg.id != null && msg.method === "turn/start") {',
  '    const turnId = "turn-1";',
  '    if (policyFile) {',
  "      await fs.writeFile(policyFile, JSON.stringify(msg?.params?.sandboxPolicy ?? null), 'utf8');",
  '    }',
  '    send({ id: msg.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });',
  '    send({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress", items: [] } } });',
  '    const payload = { outcome: "done", note: "ok", commitSha: "", followUps: [] };',
  '    const text = JSON.stringify(payload);',
  '    send({ method: "item/agentMessage/delta", params: { delta: text, itemId: "am1", threadId, turnId } });',
  '    send({ method: "item/completed", params: { threadId, turnId, item: { id: "am1", type: "agentMessage", text } } });',
  '    send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [] } } });',
  '    return;',
  '  }',
  '});',
  '',
].join('\n');

test('agent-codex-worker: app-server engine completes a task', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-basic-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);

  const roster = {
    orchestratorName: 'daddy-orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'daddy-autopilot',
    agents: [
      {
        name: 'backend',
        role: 'codex-worker',
        skills: [],
        workdir: '$REPO_ROOT',
        startCommand: 'node scripts/agent-codex-worker.mjs --agent backend',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');
  await ensureBusRoot(busRoot, roster);

  await writeTask({
    busRoot,
    agentName: 'backend',
    taskId: 't1',
    meta: { id: 't1', to: ['backend'], from: 'daddy', priority: 'P2', title: 't1', signals: { kind: 'USER_REQUEST' } },
    body: 'do t1',
  });

  const env = {
    ...BASE_ENV,
    AGENTIC_CODEX_ENGINE: 'app-server',
    AGENTIC_AUTOPILOT_DELEGATE_GATE: '0',
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_EXEC_TIMEOUT_MS: '2000',
    DUMMY_MODE: 'basic',
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'backend',
      '--bus-root',
      busRoot,
      '--roster',
      rosterPath,
      '--once',
      '--poll-ms',
      '10',
      '--codex-bin',
      dummyCodex,
    ],
    { cwd: repoRoot, env },
  );
  assert.equal(run.code, 0, run.stderr || run.stdout);

  const receiptPath = path.join(busRoot, 'receipts', 'backend', 't1.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(receipt.outcome, 'done');
  assert.match(receipt.note, /\bok\b/);
});

test('agent-codex-worker: merge-like done outcome does not fail when commit object is not local yet', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-merge-sha-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const workdir = await createTestGitWorkdir({ rootDir: tmp });

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);

  const roster = {
    orchestratorName: 'daddy-orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'daddy-autopilot',
    agents: [
      {
        name: 'backend',
        role: 'codex-worker',
        skills: [],
        workdir,
        startCommand: 'node scripts/agent-codex-worker.mjs --agent backend',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');
  await ensureBusRoot(busRoot, roster);

  await writeTask({
    busRoot,
    agentName: 'backend',
    taskId: 't1',
    meta: { id: 't1', to: ['backend'], from: 'daddy', priority: 'P2', title: 'merge completion', signals: { kind: 'USER_REQUEST' } },
    body: 'merge completion task',
  });

  const env = {
    ...BASE_ENV,
    AGENTIC_CODEX_ENGINE: 'app-server',
    AGENTIC_AUTOPILOT_DELEGATE_GATE: '0',
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_EXEC_TIMEOUT_MS: '2000',
    DUMMY_MODE: 'merge-commit-missing-local',
    MERGE_COMMIT_SHA: 'ffffffffffffffffffffffffffffffffffffffff',
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'backend',
      '--bus-root',
      busRoot,
      '--roster',
      rosterPath,
      '--once',
      '--poll-ms',
      '10',
      '--codex-bin',
      dummyCodex,
    ],
    { cwd: repoRoot, env },
  );
  assert.equal(run.code, 0, run.stderr || run.stdout);

  const receiptPath = path.join(busRoot, 'receipts', 'backend', 't1.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(receipt.outcome, 'done');
  assert.match(receipt.note, /Merged PR112 on master\./);
});

test('daddy-autopilot: EXECUTE followUp synthesizes references.git and references.integration', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-followup-contract-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);

  const roster = {
    orchestratorName: 'orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'autopilot',
    agents: [
      {
        name: 'autopilot',
        role: 'autopilot-worker',
        skills: [],
        workdir: '$REPO_ROOT',
        startCommand: 'node scripts/agent-codex-worker.mjs --agent autopilot',
      },
      { name: 'frontend', role: 'codex-worker', skills: [], workdir: '$REPO_ROOT' },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');
  await ensureBusRoot(busRoot, roster);

  await writeTask({
    busRoot,
    agentName: 'autopilot',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['autopilot'],
      from: 'daddy',
      priority: 'P2',
      title: 'dispatch execute followup',
      signals: { kind: 'USER_REQUEST', rootId: 'root1' },
      references: {},
    },
    body: 'dispatch execute followup',
  });

  const env = {
    ...BASE_ENV,
    AGENTIC_CODEX_ENGINE: 'app-server',
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_EXEC_TIMEOUT_MS: '5000',
    DUMMY_MODE: 'followup-execute',
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'autopilot',
      '--bus-root',
      busRoot,
      '--roster',
      rosterPath,
      '--once',
      '--poll-ms',
      '10',
      '--codex-bin',
      dummyCodex,
    ],
    { cwd: repoRoot, env },
  );
  assert.equal(run.code, 0, run.stderr || run.stdout);

  const frontendNewDir = path.join(busRoot, 'inbox', 'frontend', 'new');
  const files = await fs.readdir(frontendNewDir);
  assert.ok(files.length >= 1, 'expected execute followup in frontend inbox');
  const raw = await fs.readFile(path.join(frontendNewDir, files[0]), 'utf8');
  const parts = raw.match(/^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/);
  assert.ok(parts, 'expected packet frontmatter');
  const meta = JSON.parse(parts[1]);
  const refs = meta.references || {};
  const git = refs.git || {};
  const integration = refs.integration || {};

  assert.equal(meta.signals.kind, 'EXECUTE');
  assert.equal(typeof git.baseSha, 'string');
  assert.ok(git.baseSha.length >= 6);
  assert.equal(git.integrationBranch, 'slice/root1');
  assert.equal(git.workBranch, 'wip/frontend/root1/main');
  assert.equal(integration.requiredIntegrationBranch, 'slice/root1');
  assert.equal(integration.integrationMode, 'autopilot_integrates');
});

test('daddy-autopilot: blocked outcome dispatches both STATUS and EXECUTE followUps', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-followup-blocked-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);

  const roster = {
    orchestratorName: 'orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'autopilot',
    agents: [
      {
        name: 'autopilot',
        role: 'autopilot-worker',
        skills: [],
        workdir: '$REPO_ROOT',
        startCommand: 'node scripts/agent-codex-worker.mjs --agent autopilot',
      },
      { name: 'frontend', role: 'codex-worker', skills: [], workdir: '$REPO_ROOT' },
      { name: 'daddy', role: 'chat-io', skills: [], workdir: '$REPO_ROOT' },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');
  await ensureBusRoot(busRoot, roster);

  await writeTask({
    busRoot,
    agentName: 'autopilot',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['autopilot'],
      from: 'daddy',
      priority: 'P2',
      title: 'blocked mixed followups',
      signals: { kind: 'USER_REQUEST', rootId: 'root1' },
      references: {},
    },
    body: 'dispatch blocked mixed followups',
  });

  const env = {
    ...BASE_ENV,
    AGENTIC_CODEX_ENGINE: 'app-server',
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_EXEC_TIMEOUT_MS: '5000',
    DUMMY_MODE: 'followup-blocked-mixed',
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'autopilot',
      '--bus-root',
      busRoot,
      '--roster',
      rosterPath,
      '--once',
      '--poll-ms',
      '10',
      '--codex-bin',
      dummyCodex,
    ],
    { cwd: repoRoot, env },
  );
  assert.equal(run.code, 0, run.stderr || run.stdout);

  const receiptPath = path.join(busRoot, 'receipts', 'autopilot', 't1.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(receipt.outcome, 'blocked');
  assert.equal(Array.isArray(receipt.receiptExtra.dispatchedFollowUps), true);
  assert.equal(receipt.receiptExtra.dispatchedFollowUps.length, 2);
  assert.deepEqual(
    receipt.receiptExtra.dispatchedFollowUps.map((fu) => fu.kind).sort(),
    ['EXECUTE', 'STATUS'],
  );

  const daddyNewDir = path.join(busRoot, 'inbox', 'daddy', 'new');
  const daddyPackets = await fs.readdir(daddyNewDir);
  assert.ok(daddyPackets.length >= 1, 'expected STATUS follow-up in daddy inbox');

  const frontendNewDir = path.join(busRoot, 'inbox', 'frontend', 'new');
  const frontendPackets = await fs.readdir(frontendNewDir);
  assert.ok(frontendPackets.length >= 1, 'expected EXECUTE follow-up in frontend inbox');
});

test('non-autopilot: blocked outcome suppresses non-STATUS followUps', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-followup-blocked-worker-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);

  const roster = {
    orchestratorName: 'orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'autopilot',
    agents: [
      { name: 'autopilot', role: 'autopilot-worker', skills: [], workdir: '$REPO_ROOT' },
      { name: 'frontend', role: 'codex-worker', skills: [], workdir: '$REPO_ROOT' },
      { name: 'daddy', role: 'chat-io', skills: [], workdir: '$REPO_ROOT' },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');
  await ensureBusRoot(busRoot, roster);

  await writeTask({
    busRoot,
    agentName: 'frontend',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['frontend'],
      from: 'daddy',
      priority: 'P2',
      title: 'blocked mixed followups',
      signals: { kind: 'EXECUTE', rootId: 'root1' },
      references: {},
    },
    body: 'dispatch blocked mixed followups',
  });

  const env = {
    ...BASE_ENV,
    AGENTIC_CODEX_ENGINE: 'app-server',
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_EXEC_TIMEOUT_MS: '5000',
    DUMMY_MODE: 'followup-blocked-mixed',
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'frontend',
      '--bus-root',
      busRoot,
      '--roster',
      rosterPath,
      '--once',
      '--poll-ms',
      '10',
      '--codex-bin',
      dummyCodex,
    ],
    { cwd: repoRoot, env },
  );
  assert.equal(run.code, 0, run.stderr || run.stdout);

  const receiptPath = path.join(busRoot, 'receipts', 'frontend', 't1.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(receipt.outcome, 'blocked');
  assert.equal(receipt.receiptExtra.followUpsSuppressed, true);
  assert.equal(receipt.receiptExtra.followUpsSuppressedReason, 'blocked_outcome_non_autopilot');
  assert.equal(receipt.receiptExtra.followUpsSuppressedCount, 1);
  assert.equal(Array.isArray(receipt.receiptExtra.dispatchedFollowUps), true);
  assert.equal(receipt.receiptExtra.dispatchedFollowUps.length, 1);
  assert.equal(receipt.receiptExtra.dispatchedFollowUps[0].kind, 'STATUS');

  const daddyNewDir = path.join(busRoot, 'inbox', 'daddy', 'new');
  const daddyPackets = await fs.readdir(daddyNewDir);
  assert.ok(daddyPackets.length >= 1, 'expected STATUS follow-up in daddy inbox');

  const frontendNewDir = path.join(busRoot, 'inbox', 'frontend', 'new');
  let frontendPackets = [];
  try {
    frontendPackets = await fs.readdir(frontendNewDir);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  assert.equal(frontendPackets.length, 0, 'non-autopilot blocked EXECUTE follow-up must be suppressed');
});

test('daddy-autopilot: skillops gate blocks done closure when evidence is missing', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-skillops-missing-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);

  const roster = {
    orchestratorName: 'orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'autopilot',
    agents: [
      {
        name: 'autopilot',
        role: 'autopilot-worker',
        skills: [],
        workdir: '$REPO_ROOT',
        startCommand: 'node scripts/agent-codex-worker.mjs --agent autopilot',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');

  await writeTask({
    busRoot,
    agentName: 'autopilot',
    taskId: 't1',
    meta: { id: 't1', to: ['autopilot'], from: 'daddy', priority: 'P2', title: 't1', signals: { kind: 'USER_REQUEST' } },
    body: 'do t1',
  });

  const env = {
    ...BASE_ENV,
    AGENTIC_CODEX_ENGINE: 'app-server',
    AGENTIC_AUTOPILOT_DELEGATE_GATE: '0',
    AGENTIC_AUTOPILOT_SKILLOPS_GATE: '1',
    AGENTIC_AUTOPILOT_SKILLOPS_GATE_KINDS: 'USER_REQUEST',
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_EXEC_TIMEOUT_MS: '2000',
    DUMMY_MODE: 'skillops-missing',
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'autopilot',
      '--bus-root',
      busRoot,
      '--roster',
      rosterPath,
      '--once',
      '--poll-ms',
      '10',
      '--codex-bin',
      dummyCodex,
    ],
    { cwd: repoRoot, env },
  );
  assert.equal(run.code, 0, run.stderr || run.stdout);

  const receiptPath = path.join(busRoot, 'receipts', 'autopilot', 't1.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(receipt.outcome, 'blocked');
  assert.match(receipt.note, /skillops gate failed/i);
  assert.equal(receipt.receiptExtra.runtimeGuard.skillOpsGate.required, true);
  assert.equal(receipt.receiptExtra.runtimeGuard.skillOpsGate.commandChecks.debrief, false);
});

test('daddy-autopilot: skillops gate accepts done closure when evidence is present', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-skillops-ok-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const workdir = await createTestGitWorkdir({ rootDir: tmp });

  await fs.mkdir(path.join(workdir, '.codex', 'skill-ops', 'logs', '2026', '02'), { recursive: true });
  await fs.writeFile(
    path.join(workdir, '.codex', 'skill-ops', 'logs', '2026', '02', 'skillops-proof.md'),
    '# proof\n',
    'utf8',
  );

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);

  const roster = {
    orchestratorName: 'orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'autopilot',
    agents: [
      {
        name: 'autopilot',
        role: 'autopilot-worker',
        skills: [],
        workdir,
        startCommand: 'node scripts/agent-codex-worker.mjs --agent autopilot',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');

  await writeTask({
    busRoot,
    agentName: 'autopilot',
    taskId: 't1',
    meta: { id: 't1', to: ['autopilot'], from: 'daddy', priority: 'P2', title: 't1', signals: { kind: 'USER_REQUEST' } },
    body: 'do t1',
  });

  const env = {
    ...BASE_ENV,
    AGENTIC_CODEX_ENGINE: 'app-server',
    AGENTIC_AUTOPILOT_DELEGATE_GATE: '0',
    AGENTIC_AUTOPILOT_SKILLOPS_GATE: '1',
    AGENTIC_AUTOPILOT_SKILLOPS_GATE_KINDS: 'USER_REQUEST',
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_EXEC_TIMEOUT_MS: '2000',
    DUMMY_MODE: 'skillops-ok',
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'autopilot',
      '--bus-root',
      busRoot,
      '--roster',
      rosterPath,
      '--once',
      '--poll-ms',
      '10',
      '--codex-bin',
      dummyCodex,
    ],
    { cwd: repoRoot, env },
  );
  assert.equal(run.code, 0, run.stderr || run.stdout);

  const receiptPath = path.join(busRoot, 'receipts', 'autopilot', 't1.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(receipt.outcome, 'done');
  assert.equal(receipt.receiptExtra.runtimeGuard.skillOpsGate.required, true);
  assert.equal(receipt.receiptExtra.runtimeGuard.skillOpsGate.commandChecks.debrief, true);
  assert.equal(receipt.receiptExtra.runtimeGuard.skillOpsGate.logArtifactExists, true);
});

async function runCodeQualityGateScenario({ mode, dirtyFilePath, dirtyFileContents }) {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), `agentic-codex-app-server-${mode}-`));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const workdir = await createTestGitWorkdir({
    rootDir: tmp,
    dirtyFilePath,
    dirtyFileContents,
  });
  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);
  const roster = {
    orchestratorName: 'orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'autopilot',
    agents: [
      {
        name: 'autopilot',
        role: 'autopilot-worker',
        skills: [],
        workdir,
        startCommand: 'node scripts/agent-codex-worker.mjs --agent autopilot',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');

  await writeTask({
    busRoot,
    agentName: 'autopilot',
    taskId: 't1',
    meta: { id: 't1', to: ['autopilot'], from: 'daddy', priority: 'P2', title: 't1', signals: { kind: 'USER_REQUEST' } },
    body: 'do t1',
  });
  const env = {
    ...BASE_ENV,
    COCKPIT_ROOT: repoRoot,
    AGENTIC_CODEX_ENGINE: 'app-server',
    AGENTIC_CODE_QUALITY_GATE: '1',
    AGENTIC_CODE_QUALITY_GATE_KINDS: 'USER_REQUEST',
    AGENTIC_AUTOPILOT_DELEGATE_GATE: '0',
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_EXEC_TIMEOUT_MS: '2000',
    DUMMY_MODE: mode,
  };
  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'autopilot',
      '--bus-root',
      busRoot,
      '--roster',
      rosterPath,
      '--once',
      '--poll-ms',
      '10',
      '--codex-bin',
      dummyCodex,
    ],
    { cwd: repoRoot, env },
  );
  assert.equal(run.code, 0, run.stderr || run.stdout);
  const receiptPath = path.join(busRoot, 'receipts', 'autopilot', 't1.json');
  return JSON.parse(await fs.readFile(receiptPath, 'utf8'));
}

test('code-quality gate blocks done closure after bounded retry when qualityReview evidence is missing', async () => {
  const receipt = await runCodeQualityGateScenario({
    mode: 'quality-missing',
    dirtyFilePath: 'src/escape.js',
    dirtyFileContents: '/* eslint-disable */\nexport const value = 1;\n',
  });
  assert.equal(receipt.outcome, 'blocked');
  assert.match(receipt.note, /code quality gate failed/i);
  assert.equal(receipt.receiptExtra.runtimeGuard.codeQualityGate.required, true);
  assert.equal(receipt.receiptExtra.runtimeGuard.codeQualityGate.executed, true);
  assert.equal(receipt.receiptExtra.runtimeGuard.codeQualityGate.exitCode, 0);
  assert.equal(receipt.receiptExtra.runtimeGuard.codeQualityGate.retryCount, 1);
  assert.equal(receipt.receiptExtra.runtimeGuard.codeQualityGate.autoRemediationStopReason, 'unchanged_evidence');
  assert.match(
    String((receipt.receiptExtra.runtimeGuard.codeQualityGate.errors || []).join(' ')),
    /qualityReview evidence is required/i,
  );
});

test('code-quality gate accepts done closure when runtime check passes', async () => {
  const receipt = await runCodeQualityGateScenario({
    mode: 'quality-ok',
    dirtyFilePath: 'src/clean.js',
    dirtyFileContents: 'export const value = 1;\n',
  });
  assert.equal(receipt.outcome, 'done');
  assert.equal(receipt.receiptExtra.runtimeGuard.codeQualityGate.required, true);
  assert.equal(receipt.receiptExtra.runtimeGuard.codeQualityGate.executed, true);
  assert.equal(receipt.receiptExtra.runtimeGuard.codeQualityGate.exitCode, 0);
  assert.match(
    String(receipt.receiptExtra.runtimeGuard.codeQualityGate.artifactPath || ''),
    /\.codex\/quality\/logs\//,
  );
  assert.equal(receipt.receiptExtra.runtimeGuard.codeQualityReview.present, true);
  assert.equal(
    receipt.receiptExtra.runtimeGuard.codeQualityReview.hardRuleChecks.codeVolume,
    true,
  );
});

test('code-quality gate rejects done closure when explicit qualityReview evidence is missing', async () => {
  const receipt = await runCodeQualityGateScenario({
    mode: 'quality-script-only',
    dirtyFilePath: 'src/clean.js',
    dirtyFileContents: 'export const value = 1;\n',
  });
  assert.equal(receipt.outcome, 'blocked');
  assert.equal(receipt.receiptExtra.runtimeGuard.codeQualityGate.exitCode, 0);
  assert.equal(receipt.receiptExtra.runtimeGuard.codeQualityReview.present, false);
  assert.match(
    String((receipt.receiptExtra.runtimeGuard.codeQualityGate.errors || []).join(' ')),
    /qualityReview evidence is required/i,
  );
});

test('daddy-autopilot: observer drain gate blocks ready closure until sibling digests drain', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-observer-drain-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);

  const roster = {
    orchestratorName: 'orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'autopilot',
    agents: [
      {
        name: 'autopilot',
        role: 'autopilot-worker',
        skills: [],
        workdir: '$REPO_ROOT',
        startCommand: 'node scripts/agent-codex-worker.mjs --agent autopilot',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');
  await ensureBusRoot(busRoot, roster);

  const taskMetaBase = {
    to: ['autopilot'],
    from: 'daddy-orchestrator',
    priority: 'P1',
    signals: {
      kind: 'ORCHESTRATOR_UPDATE',
      sourceKind: 'REVIEW_ACTION_REQUIRED',
      rootId: 'PR104',
      phase: 'review-fix',
    },
    references: {},
  };

  await writeTask({
    busRoot,
    agentName: 'autopilot',
    taskId: 't1',
    meta: {
      ...taskMetaBase,
      id: 't1',
      title: 'review digest A',
    },
    body: 'digest A',
  });
  await writeTask({
    busRoot,
    agentName: 'autopilot',
    taskId: 't2',
    meta: {
      ...taskMetaBase,
      id: 't2',
      title: 'review digest B',
    },
    body: 'digest B',
  });

  const env = {
    ...BASE_ENV,
    AGENTIC_CODEX_ENGINE: 'app-server',
    AGENTIC_AUTOPILOT_OBSERVER_DRAIN_GATE: '1',
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_EXEC_TIMEOUT_MS: '4000',
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'autopilot',
      '--bus-root',
      busRoot,
      '--roster',
      rosterPath,
      '--once',
      '--poll-ms',
      '10',
      '--codex-bin',
      dummyCodex,
    ],
    { cwd: repoRoot, env },
  );
  assert.equal(run.code, 0, run.stderr || run.stdout);

  const receiptT1Path = path.join(busRoot, 'receipts', 'autopilot', 't1.json');
  const receiptT2Path = path.join(busRoot, 'receipts', 'autopilot', 't2.json');
  const receiptT1 = JSON.parse(await fs.readFile(receiptT1Path, 'utf8'));
  const receiptT2 = JSON.parse(await fs.readFile(receiptT2Path, 'utf8'));
  const receiptsById = { t1: receiptT1, t2: receiptT2 };
  const blockedEntry = Object.entries(receiptsById).find(([, r]) => r?.outcome === 'blocked');
  const doneEntry = Object.entries(receiptsById).find(([, r]) => r?.outcome === 'done');
  assert.ok(blockedEntry && doneEntry, 'expected one blocked and one done receipt');

  const [blockedId, blockedReceipt] = blockedEntry;
  const [doneId, doneReceipt] = doneEntry;
  assert.notEqual(blockedId, doneId);

  assert.match(String(blockedReceipt.note || ''), /observer drain gate failed/i);
  assert.equal(blockedReceipt.receiptExtra.runtimeGuard.observerDrainGate.required, true);
  assert.equal(blockedReceipt.receiptExtra.runtimeGuard.observerDrainGate.pendingCount, 1);
  assert.deepEqual(blockedReceipt.receiptExtra.runtimeGuard.observerDrainGate.pendingTaskIds, [doneId]);

  assert.equal(doneReceipt.receiptExtra.runtimeGuard.observerDrainGate.required, true);
  assert.equal(doneReceipt.receiptExtra.runtimeGuard.observerDrainGate.pendingCount, 0);
});

test('daddy-autopilot: app-server review gate triggers built-in review/start', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-review-gate-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const reviewCountFile = path.join(tmp, 'review-count.txt');

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);

  const roster = {
    orchestratorName: 'orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'autopilot',
    agents: [
      {
        name: 'autopilot',
        role: 'autopilot-worker',
        skills: [],
        workdir: '$REPO_ROOT',
        startCommand: 'node scripts/agent-codex-worker.mjs --agent autopilot',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');
  await ensureBusRoot(busRoot, roster);

  await writeTask({
    busRoot,
    agentName: 'autopilot',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['autopilot'],
      from: 'daddy-orchestrator',
      priority: 'P2',
      title: 'review gate',
      signals: {
        kind: 'ORCHESTRATOR_UPDATE',
        sourceKind: 'TASK_COMPLETE',
        reviewRequired: true,
        reviewTarget: {
          sourceTaskId: 'exec-1',
          sourceAgent: 'frontend',
          sourceKind: 'EXECUTE',
          commitSha: 'abc123',
          receiptPath: 'receipts/frontend/exec-1.json',
          repoRoot,
        },
      },
      references: {
        completedTaskKind: 'EXECUTE',
        commitSha: 'abc123',
        receiptPath: 'receipts/frontend/exec-1.json',
      },
    },
    body: 'review completion and decide',
  });

  const env = {
    ...BASE_ENV,
    AGENTIC_CODEX_ENGINE: 'app-server',
    AGENTIC_AUTOPILOT_DELEGATE_GATE: '0',
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_EXEC_TIMEOUT_MS: '5000',
    DUMMY_MODE: 'review-gate',
    REVIEW_COUNT_FILE: reviewCountFile,
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'autopilot',
      '--bus-root',
      busRoot,
      '--roster',
      rosterPath,
      '--once',
      '--poll-ms',
      '10',
      '--codex-bin',
      dummyCodex,
    ],
    { cwd: repoRoot, env },
  );
  assert.equal(run.code, 0, run.stderr || run.stdout);
  assert.match(run.stderr, /\[codex\] review.entered/);
  assert.match(run.stderr, /\[codex\] review.exited/);
  assert.match(run.stderr, /\[codex\] review.completed status=completed/);

  const reviewCalls = Number(await fs.readFile(reviewCountFile, 'utf8'));
  assert.equal(reviewCalls, 1);

  const receiptPath = path.join(busRoot, 'receipts', 'autopilot', 't1.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(receipt.outcome, 'done');
  assert.equal(receipt.receiptExtra.review.method, 'built_in_review');
  assert.equal(receipt.receiptExtra.review.targetCommitSha, 'abc123');
  assert.equal(receipt.receiptExtra.reviewArtifactPath, 'artifacts/autopilot/reviews/t1.md');
});

test('daddy-autopilot: explicit USER_REQUEST review prompt triggers built-in review/start', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-user-review-gate-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const reviewCountFile = path.join(tmp, 'review-count.txt');

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);

  const roster = {
    orchestratorName: 'orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'autopilot',
    agents: [
      {
        name: 'autopilot',
        role: 'autopilot-worker',
        skills: [],
        workdir: '$REPO_ROOT',
        startCommand: 'node scripts/agent-codex-worker.mjs --agent autopilot',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');
  await ensureBusRoot(busRoot, roster);

  await writeTask({
    busRoot,
    agentName: 'autopilot',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['autopilot'],
      from: 'daddy',
      priority: 'P2',
      title: 'real review start',
      signals: { kind: 'USER_REQUEST' },
      references: {},
    },
    body: 'Tell the autopilot to run a real /review review/start now.',
  });

  const env = {
    ...BASE_ENV,
    AGENTIC_CODEX_ENGINE: 'app-server',
    AGENTIC_AUTOPILOT_DELEGATE_GATE: '0',
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_EXEC_TIMEOUT_MS: '5000',
    DUMMY_MODE: 'review-gate',
    REVIEW_COUNT_FILE: reviewCountFile,
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'autopilot',
      '--bus-root',
      busRoot,
      '--roster',
      rosterPath,
      '--once',
      '--poll-ms',
      '10',
      '--codex-bin',
      dummyCodex,
    ],
    { cwd: repoRoot, env },
  );
  assert.equal(run.code, 0, run.stderr || run.stdout);
  assert.match(run.stderr, /\[codex\] review.entered/);
  assert.match(run.stderr, /\[codex\] review.exited/);
  assert.match(run.stderr, /\[codex\] review.completed status=completed/);

  const reviewCalls = Number(await fs.readFile(reviewCountFile, 'utf8'));
  assert.equal(reviewCalls, 1);

  const receiptPath = path.join(busRoot, 'receipts', 'autopilot', 't1.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(receipt.outcome, 'done');
  assert.equal(receipt.receiptExtra.review.method, 'built_in_review');
});

test('daddy-autopilot: USER_REQUEST PR review runs built-in review/start for every PR commit', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-user-pr-review-scope-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const dummyGh = path.join(tmp, 'gh');
  const reviewCountFile = path.join(tmp, 'review-count.txt');
  const commitA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const commitB = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);
  await writeExecutable(
    dummyGh,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [ "${1:-}" = "pr" ] && [ "${2:-}" = "view" ] && [ "${4:-}" = "--json" ] && [ "${5:-}" = "commits" ]; then',
      `  printf '%s\\n' '${commitA}' '${commitB}'`,
      '  exit 0',
      'fi',
      'if [ "${1:-}" = "pr" ] && [ "${2:-}" = "view" ] && [ "${4:-}" = "--json" ] && [ "${5:-}" = "headRefOid" ]; then',
      `  printf '%s\\n' '${commitB}'`,
      '  exit 0',
      'fi',
      'echo "unexpected gh args: $*" >&2',
      'exit 1',
    ].join('\n'),
  );

  const roster = {
    orchestratorName: 'orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'autopilot',
    agents: [
      {
        name: 'autopilot',
        role: 'autopilot-worker',
        skills: [],
        workdir: '$REPO_ROOT',
        startCommand: 'node scripts/agent-codex-worker.mjs --agent autopilot',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');
  await ensureBusRoot(busRoot, roster);

  await writeTask({
    busRoot,
    agentName: 'autopilot',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['autopilot'],
      from: 'daddy',
      priority: 'P2',
      title: 'PR94 real review start',
      signals: { kind: 'USER_REQUEST' },
      references: {},
    },
    body: 'Tell the autopilot to run a real /review review/start on PR94.',
  });

  const env = {
    ...BASE_ENV,
    PATH: `${tmp}:${BASE_ENV.PATH || ''}`,
    AGENTIC_CODEX_ENGINE: 'app-server',
    AGENTIC_AUTOPILOT_DELEGATE_GATE: '0',
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_EXEC_TIMEOUT_MS: '5000',
    DUMMY_MODE: 'review-gate',
    REVIEW_TARGET_SHA: commitB,
    REVIEW_SCOPE: 'pr',
    REVIEWED_COMMITS: `${commitA},${commitB}`,
    REVIEW_COUNT_FILE: reviewCountFile,
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'autopilot',
      '--bus-root',
      busRoot,
      '--roster',
      rosterPath,
      '--once',
      '--poll-ms',
      '10',
      '--codex-bin',
      dummyCodex,
    ],
    { cwd: repoRoot, env },
  );
  assert.equal(run.code, 0, run.stderr || run.stdout);
  assert.match(run.stderr, /\[codex\] review.completed status=completed/);

  const reviewCalls = Number(await fs.readFile(reviewCountFile, 'utf8'));
  assert.equal(reviewCalls, 2);

  const receiptPath = path.join(busRoot, 'receipts', 'autopilot', 't1.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(receipt.outcome, 'done');
  assert.equal(receipt.receiptExtra.review.method, 'built_in_review');
  assert.equal(receipt.receiptExtra.review.scope, 'pr');
  assert.deepEqual(receipt.receiptExtra.review.reviewedCommits, [commitA, commitB]);
  assert.equal(receipt.receiptExtra.review.targetCommitSha, commitB);
});

test('daddy-autopilot: USER_REQUEST PR review fails when PR commit targets cannot be resolved', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-user-pr-review-unresolved-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const dummyGh = path.join(tmp, 'gh');
  const reviewCountFile = path.join(tmp, 'review-count.txt');

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);
  await writeExecutable(
    dummyGh,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [ "${1:-}" = "pr" ] && [ "${2:-}" = "view" ]; then',
      '  echo "simulated gh failure" >&2',
      '  exit 1',
      'fi',
      'echo "unexpected gh args: $*" >&2',
      'exit 1',
    ].join('\n'),
  );

  const roster = {
    orchestratorName: 'orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'autopilot',
    agents: [
      {
        name: 'autopilot',
        role: 'autopilot-worker',
        skills: [],
        workdir: '$REPO_ROOT',
        startCommand: 'node scripts/agent-codex-worker.mjs --agent autopilot',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');
  await ensureBusRoot(busRoot, roster);

  await writeTask({
    busRoot,
    agentName: 'autopilot',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['autopilot'],
      from: 'daddy',
      priority: 'P2',
      title: 'PR94 real review start',
      signals: { kind: 'USER_REQUEST' },
      references: {},
    },
    body: 'Tell the autopilot to run a real /review review/start on PR94.',
  });

  const env = {
    ...BASE_ENV,
    PATH: `${tmp}:${BASE_ENV.PATH || ''}`,
    AGENTIC_CODEX_ENGINE: 'app-server',
    AGENTIC_AUTOPILOT_DELEGATE_GATE: '0',
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_EXEC_TIMEOUT_MS: '5000',
    DUMMY_MODE: 'review-gate',
    REVIEW_COUNT_FILE: reviewCountFile,
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'autopilot',
      '--bus-root',
      busRoot,
      '--roster',
      rosterPath,
      '--once',
      '--poll-ms',
      '10',
      '--codex-bin',
      dummyCodex,
    ],
    { cwd: repoRoot, env },
  );
  assert.equal(run.code, 0, run.stderr || run.stdout);

  const receiptPath = path.join(busRoot, 'receipts', 'autopilot', 't1.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(receipt.outcome, 'failed');
  assert.match(
    String(receipt.note || ''),
    /explicit review target resolution failed|commit targets could not be resolved/i,
  );

  const reviewCountExists = await waitForPath(reviewCountFile, { timeoutMs: 250, pollMs: 25 });
  assert.equal(reviewCountExists, false);
});

test('daddy-autopilot: USER_REQUEST PR review interrupts and restarts when task is updated mid-review', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-user-pr-review-update-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const dummyGh = path.join(tmp, 'gh');
  const reviewCountFile = path.join(tmp, 'review-count.txt');
  const commitA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const commitB = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);
  await writeExecutable(
    dummyGh,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [ "${1:-}" = "pr" ] && [ "${2:-}" = "view" ] && [ "${4:-}" = "--json" ] && [ "${5:-}" = "commits" ]; then',
      `  printf '%s\\n' '${commitA}' '${commitB}'`,
      '  exit 0',
      'fi',
      'if [ "${1:-}" = "pr" ] && [ "${2:-}" = "view" ] && [ "${4:-}" = "--json" ] && [ "${5:-}" = "headRefOid" ]; then',
      `  printf '%s\\n' '${commitB}'`,
      '  exit 0',
      'fi',
      'echo "unexpected gh args: $*" >&2',
      'exit 1',
    ].join('\n'),
  );

  const roster = {
    orchestratorName: 'orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'autopilot',
    agents: [
      {
        name: 'autopilot',
        role: 'autopilot-worker',
        skills: [],
        workdir: '$REPO_ROOT',
        startCommand: 'node scripts/agent-codex-worker.mjs --agent autopilot',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');
  await ensureBusRoot(busRoot, roster);

  await writeTask({
    busRoot,
    agentName: 'autopilot',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['autopilot'],
      from: 'daddy',
      priority: 'P2',
      title: 'PR94 real review start',
      signals: { kind: 'USER_REQUEST' },
      references: {},
    },
    body: 'Tell the autopilot to run a real /review review/start on PR94.',
  });

  const env = {
    ...BASE_ENV,
    PATH: `${tmp}:${BASE_ENV.PATH || ''}`,
    AGENTIC_CODEX_ENGINE: 'app-server',
    AGENTIC_AUTOPILOT_DELEGATE_GATE: '0',
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_EXEC_TIMEOUT_MS: '10000',
    VALUA_CODEX_TASK_UPDATE_POLL_MS: '50',
    DUMMY_MODE: 'review-gate',
    REVIEW_DELAY_MS: '1200',
    REVIEW_TARGET_SHA: commitB,
    REVIEW_SCOPE: 'pr',
    REVIEWED_COMMITS: `${commitA},${commitB}`,
    REVIEW_COUNT_FILE: reviewCountFile,
  };

  const runPromise = spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'autopilot',
      '--bus-root',
      busRoot,
      '--roster',
      rosterPath,
      '--once',
      '--poll-ms',
      '10',
      '--codex-bin',
      dummyCodex,
    ],
    { cwd: repoRoot, env },
  );

  const inProgressPath = path.join(busRoot, 'inbox', 'autopilot', 'in_progress', 't1.md');
  assert.equal(await waitForPath(inProgressPath, { timeoutMs: 4000, pollMs: 25 }), true);
  {
    const start = Date.now();
    let ready = false;
    while (Date.now() - start < 5000) {
      try {
        const n = Number(await fs.readFile(reviewCountFile, 'utf8'));
        if (Number.isFinite(n) && n >= 1) {
          ready = true;
          break;
        }
      } catch {
        // ignore until file appears
      }
      await sleep(25);
    }
    assert.equal(ready, true);
  }
  await fs.appendFile(inProgressPath, '\n\nSENTINEL_UPDATE\ninterrupt now\n', 'utf8');

  const run = await runPromise;
  assert.equal(run.code, 0, run.stderr || run.stdout);
  assert.match(run.stderr, /task updated; restarting codex exec/);

  const receiptPath = path.join(busRoot, 'receipts', 'autopilot', 't1.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(receipt.outcome, 'done');
  const reviewCount = Number(await fs.readFile(reviewCountFile, 'utf8'));
  assert.ok(Number.isFinite(reviewCount) && reviewCount >= 2, `expected review count >= 2, got ${reviewCount}`);
});

test('daddy-autopilot: app-server review gate retry does not rerun review/start for same commit', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-review-gate-retry-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const reviewCountFile = path.join(tmp, 'review-count.txt');
  const countFile = path.join(tmp, 'turn-count.txt');

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);

  const roster = {
    orchestratorName: 'orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'autopilot',
    agents: [
      {
        name: 'autopilot',
        role: 'autopilot-worker',
        skills: [],
        workdir: '$REPO_ROOT',
        startCommand: 'node scripts/agent-codex-worker.mjs --agent autopilot',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');
  await ensureBusRoot(busRoot, roster);

  await writeTask({
    busRoot,
    agentName: 'autopilot',
    taskId: 't1',
    meta: {
      id: 't1',
      to: ['autopilot'],
      from: 'daddy-orchestrator',
      priority: 'P2',
      title: 'review gate retry',
      signals: {
        kind: 'ORCHESTRATOR_UPDATE',
        sourceKind: 'TASK_COMPLETE',
        reviewRequired: true,
        reviewTarget: {
          sourceTaskId: 'exec-1',
          sourceAgent: 'frontend',
          sourceKind: 'EXECUTE',
          commitSha: 'abc123',
          receiptPath: 'receipts/frontend/exec-1.json',
          repoRoot,
        },
      },
      references: {
        completedTaskKind: 'EXECUTE',
        commitSha: 'abc123',
        receiptPath: 'receipts/frontend/exec-1.json',
      },
    },
    body: 'review completion and decide',
  });

  const env = {
    ...BASE_ENV,
    AGENTIC_CODEX_ENGINE: 'app-server',
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_EXEC_TIMEOUT_MS: '5000',
    DUMMY_MODE: 'review-gate-retry',
    REVIEW_COUNT_FILE: reviewCountFile,
    COUNT_FILE: countFile,
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'autopilot',
      '--bus-root',
      busRoot,
      '--roster',
      rosterPath,
      '--once',
      '--poll-ms',
      '10',
      '--codex-bin',
      dummyCodex,
    ],
    { cwd: repoRoot, env },
  );
  assert.equal(run.code, 0, run.stderr || run.stdout);
  assert.match(run.stderr, /review gate retry:/);

  const reviewCalls = Number(await fs.readFile(reviewCountFile, 'utf8'));
  assert.equal(reviewCalls, 1);
  const turnCalls = Number(await fs.readFile(countFile, 'utf8'));
  assert.equal(turnCalls, 2);

  const receiptPath = path.join(busRoot, 'receipts', 'autopilot', 't1.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(receipt.outcome, 'done');
  assert.equal(receipt.receiptExtra.review.summary, 'Retry passed.');
  assert.equal(receipt.receiptExtra.reviewArtifactPath, 'artifacts/autopilot/reviews/t1.retry.md');
});

test('agent-codex-worker: exits duplicate worker when lock is already held', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-lock-held-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);

  const roster = {
    orchestratorName: 'daddy-orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'daddy-autopilot',
    agents: [
      {
        name: 'backend',
        role: 'codex-worker',
        skills: [],
        workdir: '$REPO_ROOT',
        startCommand: 'node scripts/agent-codex-worker.mjs --agent backend',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');

  await writeTask({
    busRoot,
    agentName: 'backend',
    taskId: 't1',
    meta: { id: 't1', to: ['backend'], from: 'daddy', priority: 'P2', title: 't1', signals: { kind: 'USER_REQUEST' } },
    body: 'do t1',
  });

  const lockDir = path.join(busRoot, 'state', 'worker-locks');
  await fs.mkdir(lockDir, { recursive: true });
  await fs.writeFile(
    path.join(lockDir, 'backend.lock.json'),
    JSON.stringify({ agent: 'backend', pid: process.pid, acquiredAt: new Date().toISOString(), token: 'held' }) + '\n',
    'utf8',
  );

  const env = {
    ...BASE_ENV,
    AGENTIC_CODEX_ENGINE: 'app-server',
    AGENTIC_CODEX_HOME_MODE: 'agent',
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_EXEC_TIMEOUT_MS: '3000',
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'backend',
      '--bus-root',
      busRoot,
      '--roster',
      rosterPath,
      '--once',
      '--poll-ms',
      '10',
      '--codex-bin',
      dummyCodex,
    ],
    { cwd: repoRoot, env },
  );
  assert.equal(run.code, 0, run.stderr || run.stdout);
  assert.match(run.stderr, /already running; exiting duplicate worker/);

  const receiptPath = path.join(busRoot, 'receipts', 'backend', 't1.json');
  await assert.rejects(fs.stat(receiptPath));
  const codexHomePath = path.join(busRoot, 'state', 'codex-home', 'backend');
  await assert.rejects(fs.stat(codexHomePath));
});

test('agent-codex-worker: fresh corrupted lock is treated as held (no takeover)', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-lock-corrupt-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);

  const roster = {
    orchestratorName: 'daddy-orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'daddy-autopilot',
    agents: [
      {
        name: 'backend',
        role: 'codex-worker',
        skills: [],
        workdir: '$REPO_ROOT',
        startCommand: 'node scripts/agent-codex-worker.mjs --agent backend',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');

  await writeTask({
    busRoot,
    agentName: 'backend',
    taskId: 't1',
    meta: { id: 't1', to: ['backend'], from: 'daddy', priority: 'P2', title: 't1', signals: { kind: 'USER_REQUEST' } },
    body: 'do t1',
  });

  const lockDir = path.join(busRoot, 'state', 'worker-locks');
  await fs.mkdir(lockDir, { recursive: true });
  const lockPath = path.join(lockDir, 'backend.lock.json');
  await fs.writeFile(lockPath, '{', 'utf8');

  const env = {
    ...BASE_ENV,
    AGENTIC_CODEX_ENGINE: 'app-server',
    AGENTIC_CODEX_HOME_MODE: 'agent',
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_EXEC_TIMEOUT_MS: '3000',
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'backend',
      '--bus-root',
      busRoot,
      '--roster',
      rosterPath,
      '--once',
      '--poll-ms',
      '10',
      '--codex-bin',
      dummyCodex,
    ],
    { cwd: repoRoot, env },
  );
  assert.equal(run.code, 0, run.stderr || run.stdout);
  assert.match(run.stderr, /already running; exiting duplicate worker/);

  assert.equal(await fs.readFile(lockPath, 'utf8'), '{');
  const receiptPath = path.join(busRoot, 'receipts', 'backend', 't1.json');
  await assert.rejects(fs.stat(receiptPath));
  const codexHomePath = path.join(busRoot, 'state', 'codex-home', 'backend');
  await assert.rejects(fs.stat(codexHomePath));
});

test('agent-codex-worker: app-server engine restarts when task is updated', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-update-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const countFile = path.join(tmp, 'count.txt');
  const started1 = path.join(tmp, 'attempt1.started');

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER);

  const roster = {
    orchestratorName: 'daddy-orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'daddy-autopilot',
    agents: [
      {
        name: 'backend',
        role: 'codex-worker',
        skills: [],
        workdir: '$REPO_ROOT',
        startCommand: 'node scripts/agent-codex-worker.mjs --agent backend',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');

  await writeTask({
    busRoot,
    agentName: 'backend',
    taskId: 't1',
    meta: { id: 't1', to: ['backend'], from: 'daddy', priority: 'P2', title: 't1', signals: { kind: 'USER_REQUEST' } },
    body: 'do t1',
  });

  const env = {
    ...BASE_ENV,
    AGENTIC_CODEX_ENGINE: 'app-server',
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_EXEC_TIMEOUT_MS: '5000',
    VALUA_CODEX_TASK_UPDATE_POLL_MS: '50',
    DUMMY_MODE: 'update',
    COUNT_FILE: countFile,
    STARTED1: started1,
  };

  const runPromise = spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'backend',
      '--bus-root',
      busRoot,
      '--roster',
      rosterPath,
      '--once',
      '--poll-ms',
      '10',
      '--codex-bin',
      dummyCodex,
    ],
    { cwd: repoRoot, env },
  );

  assert.equal(await waitForPath(started1, { timeoutMs: 4000, pollMs: 25 }), true);
  const inProgressPath = path.join(busRoot, 'inbox', 'backend', 'in_progress', 't1.md');
  assert.equal(await waitForPath(inProgressPath, { timeoutMs: 4000, pollMs: 25 }), true);
  await fs.appendFile(inProgressPath, '\n\nSENTINEL_UPDATE\n', 'utf8');

  const run = await runPromise;
  assert.equal(run.code, 0, run.stderr || run.stdout);

  const receiptPath = path.join(busRoot, 'receipts', 'backend', 't1.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(receipt.outcome, 'done');
  assert.match(receipt.note, /\bsaw-update\b/);

  const invoked = Number(await fs.readFile(countFile, 'utf8'));
  assert.equal(invoked, 2);
});

test('AGENTIC_CODEX_APP_SERVER_PERSIST=false disables persistence (accepts common falsy strings)', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-persist-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const startCountFile = path.join(tmp, 'server-start-count.txt');

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER_START_COUNT);

  const roster = {
    orchestratorName: 'daddy-orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'daddy-autopilot',
    agents: [
      {
        name: 'backend',
        role: 'codex-worker',
        skills: [],
        workdir: '$REPO_ROOT',
        startCommand: 'node scripts/agent-codex-worker.mjs --agent backend',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');

  await writeTask({
    busRoot,
    agentName: 'backend',
    taskId: 't1',
    meta: { id: 't1', to: ['backend'], from: 'daddy', priority: 'P2', title: 't1', signals: { kind: 'USER_REQUEST' } },
    body: 'do t1',
  });
  await writeTask({
    busRoot,
    agentName: 'backend',
    taskId: 't2',
    meta: { id: 't2', to: ['backend'], from: 'daddy', priority: 'P2', title: 't2', signals: { kind: 'USER_REQUEST' } },
    body: 'do t2',
  });

  const env = {
    ...BASE_ENV,
    AGENTIC_CODEX_ENGINE: 'app-server',
    AGENTIC_CODEX_APP_SERVER_PERSIST: 'false',
    SERVER_START_COUNT_FILE: startCountFile,
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_EXEC_TIMEOUT_MS: '5000',
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'backend',
      '--bus-root',
      busRoot,
      '--roster',
      rosterPath,
      '--once',
      '--poll-ms',
      '10',
      '--codex-bin',
      dummyCodex,
    ],
    { cwd: repoRoot, env },
  );
  assert.equal(run.code, 0, run.stderr || run.stdout);

  const startCount = Number((await fs.readFile(startCountFile, 'utf8')).trim() || '0');
  assert.equal(startCount, 2, `expected 2 app-server starts when persist=false, got ${startCount}`);
});

test('app-server persistence resumes persisted thread only when explicitly enabled', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-resume-reuse-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const resumeCountFile = path.join(tmp, 'resume-count.txt');

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER_START_COUNT);

  const roster = {
    orchestratorName: 'daddy-orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'daddy-autopilot',
    agents: [
      {
        name: 'backend',
        role: 'codex-worker',
        skills: [],
        workdir: '$REPO_ROOT',
        startCommand: 'node scripts/agent-codex-worker.mjs --agent backend',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');

  await writeTask({
    busRoot,
    agentName: 'backend',
    taskId: 't1',
    meta: { id: 't1', to: ['backend'], from: 'daddy', priority: 'P2', title: 't1', signals: { kind: 'USER_REQUEST' } },
    body: 'do t1',
  });
  await writeTask({
    busRoot,
    agentName: 'backend',
    taskId: 't2',
    meta: { id: 't2', to: ['backend'], from: 'daddy', priority: 'P2', title: 't2', signals: { kind: 'USER_REQUEST' } },
    body: 'do t2',
  });
  await fs.mkdir(path.join(busRoot, 'state'), { recursive: true });
  await fs.writeFile(path.join(busRoot, 'state', 'backend.session-id'), 'thread-app\n', 'utf8');

  const env = {
    ...BASE_ENV,
    AGENTIC_CODEX_ENGINE: 'app-server',
    AGENTIC_CODEX_APP_SERVER_PERSIST: '1',
    AGENTIC_CODEX_APP_SERVER_RESUME_PERSISTED: '1',
    RESUME_COUNT_FILE: resumeCountFile,
    THREAD_ID: 'thread-app',
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_GLOBAL_MAX_INFLIGHT: '1',
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_EXEC_TIMEOUT_MS: '3000',
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'backend',
      '--bus-root',
      busRoot,
      '--roster',
      rosterPath,
      '--once',
      '--poll-ms',
      '10',
      '--codex-bin',
      dummyCodex,
    ],
    { cwd: repoRoot, env },
  );
  assert.equal(run.code, 0, run.stderr || run.stdout);

  const resumeCount = Number((await fs.readFile(resumeCountFile, 'utf8')).trim() || '0');
  assert.equal(
    resumeCount,
    2,
    `expected thread/resume to be called per task when persisted resume is enabled, got ${resumeCount}`,
  );
});

test('daddy-autopilot: app-server uses dangerFullAccess sandbox policy by default', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-app-server-autopilot-policy-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const policyFile = path.join(tmp, 'policy.json');

  await writeExecutable(dummyCodex, DUMMY_APP_SERVER_CAPTURE_POLICY);

  const roster = {
    orchestratorName: 'daddy-orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'daddy-autopilot',
    agents: [
      {
        name: 'daddy-autopilot',
        role: 'autopilot-worker',
        skills: [],
        workdir: '$REPO_ROOT',
        startCommand: 'node scripts/agent-codex-worker.mjs --agent daddy-autopilot',
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');

  await writeTask({
    busRoot,
    agentName: 'daddy-autopilot',
    taskId: 't1',
    meta: { id: 't1', to: ['daddy-autopilot'], from: 'daddy', priority: 'P2', title: 't1', signals: { kind: 'USER_REQUEST' } },
    body: 'do t1',
  });

  const env = {
    ...BASE_ENV,
    AGENTIC_CODEX_ENGINE: 'app-server',
    POLICY_FILE: policyFile,
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_EXEC_TIMEOUT_MS: '3000',
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      'daddy-autopilot',
      '--bus-root',
      busRoot,
      '--roster',
      rosterPath,
      '--once',
      '--poll-ms',
      '10',
      '--codex-bin',
      dummyCodex,
    ],
    { cwd: repoRoot, env },
  );
  assert.equal(run.code, 0, run.stderr || run.stdout);

  const policy = JSON.parse(await fs.readFile(policyFile, 'utf8'));
  assert.equal(policy?.type, 'dangerFullAccess');
  assert.equal(Object.prototype.hasOwnProperty.call(policy ?? {}, 'writableRoots'), false);
});
