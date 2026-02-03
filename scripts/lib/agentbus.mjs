#!/usr/bin/env node
/**
 * Shared AgentBus utilities used by:
 *  - scripts/agent-bus.mjs (CLI)
 *  - scripts/agent-listen.mjs (listener)
 *  - scripts/agent-codex-worker.mjs (worker)
 *  - scripts/agent-orchestrator-worker.mjs (orchestrator forwarder)
 *
 * This module intentionally keeps the bus protocol file-backed and transparent:
 * tasks are Markdown packets with JSON frontmatter, stored under:
 *   <busRoot>/inbox/<agent>/{new,seen,processed}/<taskId>.md
 * receipts are JSON stored under:
 *   <busRoot>/receipts/<agent>/<taskId>.json
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import childProcess from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const BUS_SCHEMA_VERSION = 2;

export function nowIso() {
  return new Date().toISOString();
}

export function makeId(prefix = 'task') {
  const ts = new Date().toISOString().replace(/[-:.]/g, '').replace('T', 'T').replace('Z', 'Z');
  const rand = crypto.randomBytes(3).toString('hex');
  return `${prefix}_${ts}_${rand}`;
}

export function isSafeId(id) {
  // Keep filenames predictable and safe. Allow dot/underscore/dash, but no spaces.
  return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/.test(id);
}

export function getRepoRoot(cwd = process.cwd()) {
  const envRoot =
    process.env.AGENTIC_PROJECT_ROOT ||
    process.env.AGENTIC_REPO_ROOT ||
    process.env.VALUA_REPO_ROOT ||
    process.env.REPO_ROOT;
  if (envRoot && envRoot.trim()) return path.resolve(envRoot.trim());

  try {
    const out = childProcess
      .execSync('git rev-parse --show-toplevel', { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString('utf8')
      .trim();
    if (out) return out;
  } catch {
    // ignore
  }
  return path.resolve(cwd);
}

export function getCockpitRoot() {
  const thisFile = fileURLToPath(import.meta.url);
  // scripts/lib/agentbus.mjs -> repo root
  return path.resolve(path.dirname(thisFile), '..', '..');
}

export function defaultRosterPath(repoRoot) {
  return path.join(repoRoot, 'docs', 'agentic', 'agent-bus', 'ROSTER.json');
}

export async function loadJson(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

export function resolveRosterPath({ repoRoot, rosterPath }) {
  const fromArg = rosterPath && rosterPath.trim() ? rosterPath.trim() : null;
  const fromEnv =
    (process.env.AGENTIC_ROSTER_PATH && process.env.AGENTIC_ROSTER_PATH.trim()) ||
    (process.env.VALUA_AGENT_ROSTER_PATH && process.env.VALUA_AGENT_ROSTER_PATH.trim()) ||
    (process.env.ROSTER_PATH && process.env.ROSTER_PATH.trim()) ||
    null;
  return path.resolve(fromArg || fromEnv || defaultRosterPath(repoRoot));
}

export async function loadRoster({ repoRoot, rosterPath }) {
  let rp = resolveRosterPath({ repoRoot, rosterPath });
  let roster;
  try {
    roster = await loadJson(rp);
  } catch (err) {
    const override =
      Boolean(rosterPath && rosterPath.trim()) ||
      Boolean(process.env.AGENTIC_ROSTER_PATH && process.env.AGENTIC_ROSTER_PATH.trim()) ||
      Boolean(process.env.VALUA_AGENT_ROSTER_PATH && process.env.VALUA_AGENT_ROSTER_PATH.trim()) ||
      Boolean(process.env.ROSTER_PATH && process.env.ROSTER_PATH.trim());

    // If the caller didn't explicitly provide a roster, fall back to the cockpit's bundled roster.
    if (!override && err && err.code === 'ENOENT') {
      const fallback = defaultRosterPath(getCockpitRoot());
      roster = await loadJson(fallback);
      // Continue with the bundled roster but keep the return shape consistent.
      rp = fallback;
    } else {
      throw err;
    }
  }

  if (!roster || typeof roster !== 'object') {
    throw new Error(`ROSTER.json must be an object (got ${typeof roster})`);
  }
  if (!Array.isArray(roster.agents)) {
    throw new Error('ROSTER.json missing required "agents" array');
  }
  const agents = roster.agents.map((a) => a?.name).filter(Boolean);
  if (agents.length === 0) {
    throw new Error('ROSTER.json has no agents with a "name"');
  }

  const agentNames = new Set(agents);
  if (typeof roster?.orchestratorName === 'string' && roster.orchestratorName.trim()) {
    agentNames.add(roster.orchestratorName.trim());
  }
  if (typeof roster?.daddyChatName === 'string' && roster.daddyChatName.trim()) {
    agentNames.add(roster.daddyChatName.trim());
  }
  if (typeof roster?.autopilotName === 'string' && roster.autopilotName.trim()) {
    agentNames.add(roster.autopilotName.trim());
  }
  agentNames.add('daddy');

  return {
    path: rp,
    roster,
    agentNames,
  };
}

export function resolveBusRoot({ busRoot, repoRoot }) {
  const fromArg = busRoot && busRoot.trim() ? busRoot.trim() : null;
  const fromEnv =
    (process.env.AGENTIC_BUS_DIR && process.env.AGENTIC_BUS_DIR.trim()) ||
    (process.env.VALUA_AGENT_BUS_DIR && process.env.VALUA_AGENT_BUS_DIR.trim()) ||
    (process.env.AGENT_BUS_DIR && process.env.AGENT_BUS_DIR.trim()) ||
    null;

  const resolved = fromArg || fromEnv;
  if (resolved) return path.resolve(resolved);

  // Default location is user-scoped.
  return path.join(os.homedir(), '.agentic-cockpit', 'bus');
}

export function expandEnvVars(str, extra = {}) {
  if (typeof str !== 'string') return str;
  const vars = { ...process.env, ...extra };
  return str.replace(/\$([A-Z0-9_]+)/gi, (_, name) => (vars[name] ?? `$${name}`));
}

export async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

export async function ensureAgentDirs(busRoot, agentName) {
  const agentInbox = path.join(busRoot, 'inbox', agentName);
  await ensureDir(path.join(agentInbox, 'new'));
  await ensureDir(path.join(agentInbox, 'seen'));
  await ensureDir(path.join(agentInbox, 'in_progress'));
  await ensureDir(path.join(agentInbox, 'processed'));
  await ensureDir(path.join(busRoot, 'receipts', agentName));
  await ensureDir(path.join(busRoot, 'deadletter', agentName));
  await ensureDir(path.join(busRoot, 'artifacts', agentName));
}

export async function ensureBusRoot(busRoot, roster) {
  await ensureDir(busRoot);
  await ensureDir(path.join(busRoot, 'inbox'));
  await ensureDir(path.join(busRoot, 'receipts'));
  await ensureDir(path.join(busRoot, 'deadletter'));
  await ensureDir(path.join(busRoot, 'artifacts'));
  await ensureDir(path.join(busRoot, 'state'));

  const names = roster?.agents?.map((a) => a.name).filter(Boolean) ?? [];
  for (const name of names) await ensureAgentDirs(busRoot, name);

  // Also ensure orchestrator & daddy names if present
  const extra = new Set();
  if (typeof roster?.orchestratorName === 'string') extra.add(roster.orchestratorName);
  if (typeof roster?.daddyChatName === 'string') extra.add(roster.daddyChatName);
  if (typeof roster?.autopilotName === 'string') extra.add(roster.autopilotName);
  for (const name of extra) await ensureAgentDirs(busRoot, name);

  // Also ensure "daddy" is always present for backwards compatibility
  await ensureAgentDirs(busRoot, 'daddy');
}

export function parseFrontmatter(markdown) {
  // Expect JSON frontmatter between --- lines.
  // Returns { meta, body }. If no frontmatter, meta=null.
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/m.exec(markdown);
  if (!m) return { meta: null, body: markdown };
  let meta = null;
  try {
    meta = JSON.parse(m[1]);
  } catch (err) {
    throw new Error(`Invalid JSON frontmatter: ${(err && err.message) || String(err)}`);
  }
  return { meta, body: m[2] ?? '' };
}

export function renderTaskMarkdown(meta, body) {
  const json = JSON.stringify(meta, null, 2);
  const b = body ?? '';
  return `---\n${json}\n---\n\n${b.endsWith('\n') ? b : `${b}\n`}`;
}

export function validateTaskMeta(meta) {
  if (!meta || typeof meta !== 'object') throw new Error('Task frontmatter must be an object');
  const required = ['id', 'to', 'from', 'priority', 'title'];
  for (const k of required) {
    if (!(k in meta)) throw new Error(`Task frontmatter missing required field "${k}"`);
  }

  if (!isSafeId(meta.id)) throw new Error(`Invalid task id "${meta.id}"`);
  if (!Array.isArray(meta.to) || meta.to.some((x) => typeof x !== 'string' || !x.trim())) {
    throw new Error('Task field "to" must be a non-empty array of agent names');
  }
  if (typeof meta.from !== 'string' || !meta.from.trim()) throw new Error('Task "from" must be a string');
  if (typeof meta.priority !== 'string' || !meta.priority.trim()) throw new Error('Task "priority" must be a string');
  if (typeof meta.title !== 'string' || !meta.title.trim()) throw new Error('Task "title" must be a string');
  if (meta.signals && typeof meta.signals !== 'object') throw new Error('Task "signals" must be an object if provided');
  if (meta.references && typeof meta.references !== 'object') throw new Error('Task "references" must be an object if provided');
}

export function detectSuspiciousText(text) {
  const t = String(text ?? '');
  const hits = [];

  const patterns = [
    { re: /\brm\s+-rf\s+\/(\s|$)/i, why: 'rm -rf /' },
    { re: /\bmkfs(\.| )/i, why: 'mkfs' },
    { re: /\bdd\s+if=/i, why: 'dd if=' },
    { re: /\bshutdown\b|\breboot\b/i, why: 'shutdown/reboot' },
    { re: /\b:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:\b/i, why: 'fork bomb' },
  ];

  for (const { re, why } of patterns) {
    if (re.test(t)) hits.push(why);
  }
  return hits;
}

export function suspiciousPolicy() {
  // block | warn | allow
  const raw =
    process.env.AGENTIC_SUSPICIOUS_POLICY ||
    process.env.VALUA_AGENTBUS_SUSPICIOUS_POLICY ||
    process.env.AGENTBUS_SUSPICIOUS_POLICY ||
    (process.env.AGENTBUS_ALLOW_SUSPICIOUS === '1' ||
    process.env.AGENTBUS_ALLOW_SUSPICIOUS === 'true'
      ? 'allow'
      : null) ||
    'block';
  const v = String(raw).toLowerCase().trim();
  if (v === 'allow' || v === 'warn' || v === 'block') return v;
  return 'block';
}

export async function writeTaskFile({ busRoot, agentName, taskId, markdown }) {
  const dir = path.join(busRoot, 'inbox', agentName, 'new');
  await ensureDir(dir);

  // Ensure unique filename.
  let fileName = `${taskId}.md`;
  let outPath = path.join(dir, fileName);

  for (let i = 0; i < 50; i += 1) {
    try {
      await fs.access(outPath);
      // Exists -> try another
      const suffix = crypto.randomBytes(2).toString('hex');
      fileName = `${taskId}__${suffix}.md`;
      outPath = path.join(dir, fileName);
    } catch {
      break;
    }
  }

  const tmp = `${outPath}.tmp.${crypto.randomBytes(4).toString('hex')}`;
  await fs.writeFile(tmp, markdown, 'utf8');
  await fs.rename(tmp, outPath);
  return outPath;
}

export async function deliverTask({ busRoot, meta, body }) {
  validateTaskMeta(meta);
  const markdown = renderTaskMarkdown(meta, body);

  const hits = detectSuspiciousText(markdown);
  const policy = suspiciousPolicy();
  if (hits.length && policy === 'block') {
    throw new Error(
      `Blocked suspicious task content (${hits.join(', ')}). ` +
        `Set AGENTIC_SUSPICIOUS_POLICY=warn or =allow to override.`
    );
  }

  const paths = [];
  for (const to of meta.to) {
    const p = await writeTaskFile({ busRoot, agentName: to, taskId: meta.id, markdown });
    paths.push(p);
  }

  return { markdown, paths, suspiciousHits: hits, suspiciousPolicy: policy };
}

export function pickOrchestratorName(roster) {
  return (
    (typeof roster?.orchestratorName === 'string' && roster.orchestratorName.trim()) ||
    'orchestrator'
  );
}

export function pickDaddyChatName(roster) {
  return (typeof roster?.daddyChatName === 'string' && roster.daddyChatName.trim()) || 'daddy';
}

export function pickAutopilotName(roster) {
  return (typeof roster?.autopilotName === 'string' && roster.autopilotName.trim()) || 'autopilot';
}

export function rosterAgentNames(roster) {
  const names = new Set();
  const agents = roster?.agents?.map((a) => a?.name).filter(Boolean) ?? [];
  for (const name of agents) names.add(String(name));

  const extras = [
    typeof roster?.orchestratorName === 'string' ? roster.orchestratorName.trim() : '',
    typeof roster?.daddyChatName === 'string' ? roster.daddyChatName.trim() : '',
    typeof roster?.autopilotName === 'string' ? roster.autopilotName.trim() : '',
    'daddy',
  ];
  for (const name of extras) {
    const trimmed = String(name || '').trim();
    if (trimmed) names.add(trimmed);
  }

  return Array.from(names).sort();
}

export async function listInboxTaskIds({ busRoot, agentName, state }) {
  const dir = path.join(busRoot, 'inbox', agentName, state);
  try {
    const files = await fs.readdir(dir);
    return files
      .filter((f) => f.endsWith('.md'))
      .sort()
      .map((f) => f.replace(/\.md$/, ''));
  } catch {
    return [];
  }
}

export async function findTaskPath({ busRoot, agentName, taskId }) {
  const states = ['new', 'seen', 'in_progress', 'processed'];
  for (const state of states) {
    const dir = path.join(busRoot, 'inbox', agentName, state);
    const candidate = path.join(dir, `${taskId}.md`);
    try {
      await fs.access(candidate);
      return { state, path: candidate };
    } catch {
      // try suffix matches
      try {
        const files = await fs.readdir(dir);
        const match = files.find((f) => f === `${taskId}.md` || f.startsWith(`${taskId}__`));
        if (match) return { state, path: path.join(dir, match) };
      } catch {
        // ignore
      }
    }
  }
  return null;
}

export async function moveTask({ fromPath, toPath }) {
  await ensureDir(path.dirname(toPath));
  await fs.rename(fromPath, toPath);
}

export async function openTask({ busRoot, agentName, taskId, markSeen = true }) {
  const found = await findTaskPath({ busRoot, agentName, taskId });
  if (!found) throw new Error(`Task not found: agent=${agentName} id=${taskId}`);

  const raw = await fs.readFile(found.path, 'utf8');
  const { meta, body } = parseFrontmatter(raw);
  if (!meta) throw new Error(`Task ${taskId} has no JSON frontmatter`);

  if (markSeen && found.state === 'new') {
    const toPath = path.join(busRoot, 'inbox', agentName, 'seen', path.basename(found.path));
    await moveTask({ fromPath: found.path, toPath });
    try {
      const now = new Date();
      await fs.utimes(toPath, now, now);
    } catch {
      // ignore
    }
    return { meta, body, markdown: raw, state: 'seen', path: toPath };
  }

  return { meta, body, markdown: raw, state: found.state, path: found.path };
}

function normalizeUpdateBody(value) {
  const raw = typeof value === 'string' ? value : '';
  const trimmed = raw.trim();
  return trimmed ? trimmed : null;
}

function formatTaskUpdateBlock({ at, from, body }) {
  const bodyText = normalizeUpdateBody(body);
  if (!bodyText) return null;
  const by = typeof from === 'string' && from.trim() ? from.trim() : 'unknown';
  const ts = typeof at === 'string' && at.trim() ? at.trim() : nowIso();
  return `\n\n---\n\n### Update (${ts}) from ${by}\n\n${bodyText}\n`;
}

/**
 * Update an existing task in-place by appending a timestamped update block and/or
 * patching frontmatter fields. Intended for mid-flight clarifications without creating
 * a new task id.
 *
 * This does NOT allow updating processed tasks (create a new task instead).
 */
export async function updateTask({
  busRoot,
  agentName,
  taskId,
  updateFrom = 'daddy',
  appendBody = '',
  title = null,
  priority = null,
  signalsPatch = null,
  referencesPatch = null,
}) {
  const found = await findTaskPath({ busRoot, agentName, taskId });
  if (!found) throw new Error(`Task not found: agent=${agentName} id=${taskId}`);
  if (found.state === 'processed') {
    throw new Error(`Refusing to update processed task: agent=${agentName} id=${taskId}`);
  }

  const raw = await fs.readFile(found.path, 'utf8');
  const { meta, body } = parseFrontmatter(raw);
  if (!meta) throw new Error(`Task ${taskId} has no JSON frontmatter`);

  validateTaskMeta(meta);

  if (typeof title === 'string' && title.trim()) meta.title = title.trim();
  if (typeof priority === 'string' && priority.trim()) meta.priority = priority.trim();

  if (signalsPatch && typeof signalsPatch === 'object') {
    const current = meta.signals && typeof meta.signals === 'object' ? meta.signals : {};
    const merged = { ...current, ...signalsPatch };
    if (typeof merged.kind === 'string') merged.kind = merged.kind.trim();
    if (typeof merged.phase === 'string') merged.phase = merged.phase.trim();
    if (typeof merged.rootId === 'string') merged.rootId = merged.rootId.trim();
    if (typeof merged.parentId === 'string') merged.parentId = merged.parentId.trim();
    meta.signals = merged;
  }

  if (referencesPatch && typeof referencesPatch === 'object') {
    const current = meta.references && typeof meta.references === 'object' ? meta.references : {};
    meta.references = { ...current, ...referencesPatch };
  }

  const updateBlock = formatTaskUpdateBlock({ at: nowIso(), from: updateFrom, body: appendBody });
  const nextBody = updateBlock ? `${String(body ?? '').replace(/\s*$/, '')}${updateBlock}` : body ?? '';

  const markdown = renderTaskMarkdown(meta, nextBody);

  const hits = detectSuspiciousText(markdown);
  const policy = suspiciousPolicy();
  if (hits.length && policy === 'block') {
    throw new Error(
      `Blocked suspicious updated task content (${hits.join(', ')}). ` +
        `Set AGENTIC_SUSPICIOUS_POLICY=warn or =allow to override.`,
    );
  }

  const tmp = `${found.path}.tmp.${crypto.randomBytes(4).toString('hex')}`;
  await fs.writeFile(tmp, markdown, 'utf8');
  await fs.rename(tmp, found.path);
  try {
    const now = new Date();
    await fs.utimes(found.path, now, now);
  } catch {
    // ignore
  }

  return {
    state: found.state,
    path: found.path,
    suspiciousHits: hits,
    suspiciousPolicy: policy,
  };
}

export async function claimTask({ busRoot, agentName, taskId }) {
  // We only allow claiming tasks that are not already processed or in progress.
  const found = await findTaskPath({ busRoot, agentName, taskId });
  if (!found) throw new Error(`Task not found: agent=${agentName} id=${taskId}`);
  if (found.state === 'processed') throw new Error(`Task already processed: agent=${agentName} id=${taskId}`);
  if (found.state === 'in_progress') throw new Error(`Task already in_progress: agent=${agentName} id=${taskId}`);

  const toPath = path.join(busRoot, 'inbox', agentName, 'in_progress', path.basename(found.path));
  await moveTask({ fromPath: found.path, toPath });
  try {
    const now = new Date();
    await fs.utimes(toPath, now, now);
  } catch {
    // ignore
  }

  const raw = await fs.readFile(toPath, 'utf8');
  const { meta, body } = parseFrontmatter(raw);
  if (!meta) throw new Error(`Task ${taskId} has no JSON frontmatter`);

  return { meta, body, markdown: raw, state: 'in_progress', path: toPath };
}

export async function writeReceipt({ busRoot, agentName, taskId, taskMeta, receipt }) {
  await ensureAgentDirs(busRoot, agentName);
  const receiptPath = path.join(busRoot, 'receipts', agentName, `${taskId}.json`);
  const payload = {
    schemaVersion: BUS_SCHEMA_VERSION,
    taskId,
    agent: agentName,
    closedAt: nowIso(),
    ...receipt,
    task: taskMeta,
  };
  try {
    await fs.writeFile(receiptPath, JSON.stringify(payload, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    return { receiptPath, created: true };
  } catch (err) {
    if (err && err.code === 'EEXIST') return { receiptPath, created: false };
    throw err;
  }
}

export async function closeTask({
  busRoot,
  roster,
  agentName,
  taskId,
  outcome = 'done',
  note = '',
  commitSha = '',
  receiptExtra = {},
  notifyOrchestrator = true,
}) {
  const opened = await openTask({ busRoot, agentName, taskId, markSeen: false });
  const fileName = path.basename(opened.path);

  // Ensure in processed/
  let currentPath = opened.path;
  if (opened.state !== 'processed') {
    const dest = path.join(busRoot, 'inbox', agentName, 'processed', fileName);
    await moveTask({ fromPath: opened.path, toPath: dest });
    currentPath = dest;
  }

  const receiptWrite = await writeReceipt({
    busRoot,
    agentName,
    taskId,
    taskMeta: opened.meta,
    receipt: {
      outcome,
      note,
      commitSha,
      receiptExtra,
      references: {
        processedPath: path.relative(busRoot, currentPath),
      },
    },
  });
  const receiptPath = receiptWrite.receiptPath;

  let completionPath = null;

  // Notify orchestrator (not daddy chat) for robust inbox processing.
  if (notifyOrchestrator && receiptWrite.created) {
    const orchestratorName = pickOrchestratorName(roster);

    // Avoid loops: orchestrator shouldn't notify itself about its own closes.
    if (orchestratorName && orchestratorName !== agentName) {
      const completionId = makeId(`${taskId}__complete__${agentName}`);
      const completionMeta = {
        id: completionId,
        to: [orchestratorName],
        from: agentName,
        priority: opened.meta.priority ?? 'P2',
        title: `TASK_COMPLETE: ${opened.meta.title}`,
        signals: {
          kind: 'TASK_COMPLETE',
          completedTaskId: taskId,
          completedBy: agentName,
          completedTaskKind: opened.meta?.signals?.kind ?? null,
          phase: opened.meta?.signals?.phase ?? null,
          rootId: opened.meta?.signals?.rootId ?? taskId,
          parentId: opened.meta?.signals?.parentId ?? null,
          smoke: Boolean(opened.meta?.signals?.smoke),
        },
        references: {
          receiptPath: path.relative(busRoot, receiptPath),
          processedPath: path.relative(busRoot, currentPath),
          commitSha,
        },
      };

      const completionBody =
        `Auto-generated completion notice.\n\n` +
        `- agent: ${agentName}\n` +
        `- task: ${taskId}\n` +
        `- outcome: ${outcome}\n` +
        (commitSha ? `- commitSha: ${commitSha}\n` : '') +
        (note ? `\n${note}\n` : '');

      const delivered = await deliverTask({
        busRoot,
        meta: completionMeta,
        body: completionBody,
      });
      completionPath = delivered.paths[0] ?? null;
    }
  }

  return { receiptPath, processedPath: currentPath, completionPath };
}

export async function readReceipt({ busRoot, agentName, taskId }) {
  const p = path.join(busRoot, 'receipts', agentName, `${taskId}.json`);
  const raw = await fs.readFile(p, 'utf8');
  return JSON.parse(raw);
}

export async function statusSummary({ busRoot, roster }) {
  const unique = rosterAgentNames(roster);
  const rows = [];
  for (const name of unique) {
    const counts = {
      new: (await listInboxTaskIds({ busRoot, agentName: name, state: 'new' })).length,
      seen: (await listInboxTaskIds({ busRoot, agentName: name, state: 'seen' })).length,
      in_progress: (await listInboxTaskIds({ busRoot, agentName: name, state: 'in_progress' })).length,
      processed: (await listInboxTaskIds({ busRoot, agentName: name, state: 'processed' })).length,
    };
    rows.push({ agent: name, ...counts });
  }
  return rows;
}

export async function listInboxTasks({ busRoot, agentName, state, limit = 100 }) {
  const dir = path.join(busRoot, 'inbox', agentName, state);
  /** @type {{ taskId: string, path: string, mtimeMs: number, meta: any }[]} */
  const out = [];

  let files = [];
  try {
    files = await fs.readdir(dir);
  } catch {
    return out;
  }

  const max = Math.max(1, Math.min(1000, Number(limit) || 100));
  const selected = files
    .filter((f) => f.endsWith('.md'))
    .sort()
    .slice(0, max);

  for (const f of selected) {
    const p = path.join(dir, f);
    try {
      const st = await fs.stat(p);
      const raw = await fs.readFile(p, 'utf8');
      const { meta } = parseFrontmatter(raw);
      out.push({
        taskId: f.replace(/\.md$/, ''),
        path: p,
        mtimeMs: st.mtimeMs,
        meta,
      });
    } catch {
      // ignore
    }
  }

  return out;
}

export async function recentReceipts({ busRoot, agentName = null, limit = 20 }) {
  const base = path.join(busRoot, 'receipts');
  const agents = agentName ? [agentName] : await fs.readdir(base).catch(() => []);
  const receipts = [];
  for (const a of agents) {
    const dir = path.join(base, a);
    let files = [];
    try {
      files = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const f of files.filter((x) => x.endsWith('.json'))) {
      const p = path.join(dir, f);
      try {
        const st = await fs.stat(p);
        receipts.push({ agent: a, file: f, path: p, mtimeMs: st.mtimeMs });
      } catch {
        // ignore
      }
    }
  }
  receipts.sort((x, y) => y.mtimeMs - x.mtimeMs);
  const top = receipts.slice(0, limit);

  const out = [];
  for (const r of top) {
    try {
      const payload = JSON.parse(await fs.readFile(r.path, 'utf8'));
      out.push(payload);
    } catch {
      // ignore
    }
  }
  return out;
}
