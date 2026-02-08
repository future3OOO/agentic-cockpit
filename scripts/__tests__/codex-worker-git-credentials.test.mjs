import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import childProcess from 'node:child_process';

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

function parseGitConfigLog(raw) {
  const map = new Map();
  for (const line of String(raw || '').split('\n')) {
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    map.set(line.slice(0, idx), line.slice(idx + 1));
  }

  const countRaw = Number.parseInt(map.get('GIT_CONFIG_COUNT') || '0', 10);
  const count = Number.isFinite(countRaw) && countRaw > 0 ? countRaw : 0;
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    entries.push({
      key: map.get(`GIT_CONFIG_KEY_${i}`) || '',
      value: map.get(`GIT_CONFIG_VALUE_${i}`) || '',
    });
  }
  return entries;
}

function findCredentialStoreEntry(entries) {
  return entries.find(
    (entry) =>
      entry.key === 'credential.helper' &&
      typeof entry.value === 'string' &&
      entry.value.startsWith('store --file='),
  );
}

const DUMMY_CODEX_EXEC = [
  '#!/usr/bin/env bash',
  'set -euo pipefail',
  '',
  'env_log="${DUMMY_ENV_LOG:-}"',
  'if [[ -n "$env_log" ]]; then',
  '  {',
  '    echo "GIT_CONFIG_COUNT=${GIT_CONFIG_COUNT:-}"',
  '    i=0',
  '    while true; do',
  '      key_var="GIT_CONFIG_KEY_${i}"',
  '      val_var="GIT_CONFIG_VALUE_${i}"',
  '      key="${!key_var-}"',
  '      val="${!val_var-}"',
  '      if [[ -z "$key" && -z "$val" ]]; then break; fi',
  '      echo "${key_var}=${key}"',
  '      echo "${val_var}=${val}"',
  '      i=$((i+1))',
  '      if [[ "$i" -gt 32 ]]; then break; fi',
  '    done',
  '  } > "$env_log"',
  'fi',
  '',
  'cat >/dev/null',
  '',
  'echo "session id: session-exec-1" >&2',
  '',
  'out=""',
  'for ((i=1; i<=$#; i++)); do',
  '  arg="${!i}"',
  '  if [[ "$arg" == "-o" ]]; then j=$((i+1)); out="${!j}"; fi',
  'done',
  'if [[ -n "$out" ]]; then echo \'{"outcome":"done","note":"ok","commitSha":"","followUps":[]}\' > "$out"; fi',
  '',
].join('\n');

const DUMMY_CODEX_APP_SERVER = [
  '#!/usr/bin/env node',
  "import { createInterface } from 'node:readline';",
  "import { promises as fs } from 'node:fs';",
  '',
  "const args = process.argv.slice(2);",
  "if (args[0] !== 'app-server') {",
  "  process.stderr.write('dummy-codex: expected app-server\\n');",
  '  process.exit(2);',
  '}',
  '',
  "const envLog = process.env.DUMMY_ENV_LOG || '';",
  'if (envLog) {',
  "  let out = `GIT_CONFIG_COUNT=${process.env.GIT_CONFIG_COUNT || ''}\\n`;",
  '  for (let i = 0; i < 32; i += 1) {',
  '    const key = process.env[`GIT_CONFIG_KEY_${i}`] || "";',
  '    const value = process.env[`GIT_CONFIG_VALUE_${i}`] || "";',
  '    if (!key && !value) break;',
  '    out += `GIT_CONFIG_KEY_${i}=${key}\\n`;',
  '    out += `GIT_CONFIG_VALUE_${i}=${value}\\n`;',
  '  }',
  "  await fs.writeFile(envLog, out, 'utf8');",
  '}',
  '',
  'function send(obj) {',
  '  process.stdout.write(JSON.stringify(obj) + "\\n");',
  '}',
  '',
  "const threadId = 'thread-app-credentials';",
  "const rl = createInterface({ input: process.stdin });",
  'rl.on("line", (line) => {',
  '  let msg = null;',
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

test('codex-worker injects credential.helper override for exec engine', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-git-cred-exec-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const envLog = path.join(tmp, 'env.log');

  await writeExecutable(dummyCodex, DUMMY_CODEX_EXEC);

  const agentName = 'backend';
  const roster = {
    orchestratorName: 'daddy-orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'daddy-autopilot',
    agents: [
      {
        name: agentName,
        role: 'codex-worker',
        skills: [],
        workdir: '$REPO_ROOT',
        startCommand: `node scripts/agent-codex-worker.mjs --agent ${agentName}`,
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');

  await writeTask({
    busRoot,
    agentName,
    taskId: 't1',
    meta: { id: 't1', to: [agentName], from: 'daddy', priority: 'P2', title: 't1', signals: { kind: 'USER_REQUEST' } },
    body: 'do t1',
  });

  const env = {
    ...process.env,
    AGENTIC_CODEX_ENGINE: 'exec',
    GIT_CONFIG_COUNT: '0',
    DUMMY_ENV_LOG: envLog,
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_EXEC_TIMEOUT_MS: '3000',
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      agentName,
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

  const logged = await fs.readFile(envLog, 'utf8');
  const entries = parseGitConfigLog(logged);
  const credentialStore = findCredentialStoreEntry(entries);
  assert.ok(credentialStore, 'expected credential.helper=store --file=... in codex env');
  assert.match(credentialStore.value, /^store --file=.+\.codex-git-credentials$/);
});

test('codex-worker injects credential.helper override for app-server engine', async () => {
  const repoRoot = process.cwd();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-codex-git-cred-app-'));
  const busRoot = path.join(tmp, 'bus');
  const rosterPath = path.join(tmp, 'ROSTER.json');
  const dummyCodex = path.join(tmp, 'dummy-codex');
  const envLog = path.join(tmp, 'env.log');

  await writeExecutable(dummyCodex, DUMMY_CODEX_APP_SERVER);

  const agentName = 'backend';
  const roster = {
    orchestratorName: 'daddy-orchestrator',
    daddyChatName: 'daddy',
    autopilotName: 'daddy-autopilot',
    agents: [
      {
        name: agentName,
        role: 'codex-worker',
        skills: [],
        workdir: '$REPO_ROOT',
        startCommand: `node scripts/agent-codex-worker.mjs --agent ${agentName}`,
      },
    ],
  };
  await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');

  await writeTask({
    busRoot,
    agentName,
    taskId: 't1',
    meta: { id: 't1', to: [agentName], from: 'daddy', priority: 'P2', title: 't1', signals: { kind: 'USER_REQUEST' } },
    body: 'do t1',
  });

  const env = {
    ...process.env,
    AGENTIC_CODEX_ENGINE: 'app-server',
    GIT_CONFIG_COUNT: '0',
    DUMMY_ENV_LOG: envLog,
    VALUA_AGENT_BUS_DIR: busRoot,
    VALUA_CODEX_ENABLE_CHROME_DEVTOOLS: '0',
    VALUA_CODEX_EXEC_TIMEOUT_MS: '3000',
  };

  const run = await spawnProcess(
    'node',
    [
      'scripts/agent-codex-worker.mjs',
      '--agent',
      agentName,
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

  const logged = await fs.readFile(envLog, 'utf8');
  const entries = parseGitConfigLog(logged);
  const credentialStore = findCredentialStoreEntry(entries);
  assert.ok(credentialStore, 'expected credential.helper=store --file=... in app-server env');
  assert.match(credentialStore.value, /^store --file=.+\.codex-git-credentials$/);
});
