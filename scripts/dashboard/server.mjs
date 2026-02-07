#!/usr/bin/env node
/**
 * Agentic Cockpit local dashboard server (no build step).
 *
 * - Serves a small static UI
 * - Exposes a minimal JSON API for reading bus state and sending/updating tasks
 *
 * Default: http://127.0.0.1:3210
 */

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import { parseArgs } from 'node:util';
import childProcess from 'node:child_process';

import {
  getRepoRoot,
  loadRoster,
  resolveBusRoot,
  ensureBusRoot,
  statusSummary,
  rosterAgentNames,
  listInboxTasks,
  recentReceipts,
  openTask,
  deliverTask,
  updateTask,
  closeTask,
  makeId,
} from '../lib/agentbus.mjs';

export const DEFAULT_DASHBOARD_PORT = 3210;

export function parseDashboardPort(raw) {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_DASHBOARD_PORT;
  if (!Number.isInteger(parsed)) return DEFAULT_DASHBOARD_PORT;
  if (parsed < 1 || parsed > 65535) return DEFAULT_DASHBOARD_PORT;
  return parsed;
}

function writeJson(res, statusCode, obj) {
  const body = JSON.stringify(obj, null, 2) + '\n';
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function writeText(res, statusCode, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(statusCode, { 'content-type': contentType, 'cache-control': 'no-store' });
  res.end(text);
}

async function readBodyJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Invalid JSON body');
  }
}

function normalizeToArray(value) {
  if (Array.isArray(value)) return value.map((v) => String(v)).map((s) => s.trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

function safeString(value, { maxLen = 5000 } = {}) {
  const s = typeof value === 'string' ? value : value == null ? '' : String(value);
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen);
}

function nowIso() {
  return new Date().toISOString();
}

function isWsl() {
  return Boolean(
    process.env.WSL_INTEROP ||
      process.env.WSL_DISTRO_NAME ||
      String(process.env.WSLENV || '').includes('WSL'),
  );
}

function commandExists(cmd) {
  try {
    if (process.platform === 'win32') {
      const res = childProcess.spawnSync('where.exe', [cmd], { stdio: 'ignore' });
      return res.status === 0;
    }
    const safe = String(cmd).replaceAll("'", "'\\''");
    const res = childProcess.spawnSync('bash', ['-lc', `command -v '${safe}' >/dev/null 2>&1`], {
      stdio: 'ignore',
    });
    return res.status === 0;
  } catch {
    return false;
  }
}

function spawnDetachedSafe(cmd, args) {
  try {
    const proc = childProcess.spawn(cmd, args, { stdio: 'ignore', detached: true });
    proc.on('error', () => {
      // Swallow async spawn errors (e.g. ENOENT) so the dashboard server never crashes.
    });
    proc.unref();
    return true;
  } catch {
    return false;
  }
}

function openBrowserBestEffort(url) {
  try {
    if (isWsl()) {
      if (commandExists('wslview') && spawnDetachedSafe('wslview', [url])) return;
      if (commandExists('cmd.exe') && spawnDetachedSafe('cmd.exe', ['/c', 'start', '', url])) return;
      if (
        commandExists('powershell.exe') &&
        spawnDetachedSafe('powershell.exe', [
          '-NoProfile',
          '-Command',
          `Start-Process '${url.replaceAll("'", "''")}'`,
        ])
      )
        return;
      if (commandExists('explorer.exe') && spawnDetachedSafe('explorer.exe', [url])) return;
    }

    if (process.platform === 'darwin') {
      if (commandExists('open') && spawnDetachedSafe('open', [url])) return;
    }

    if (process.platform === 'linux') {
      if (commandExists('xdg-open')) spawnDetachedSafe('xdg-open', [url]);
    }
  } catch {
    // ignore
  }
}

function guessContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.js') return 'text/javascript; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.png') return 'image/png';
  return 'application/octet-stream';
}

async function serveStatic({ reqPath, res, staticRoot }) {
  const rel = reqPath === '/' ? 'index.html' : reqPath.replace(/^\/+/, '');
  const safeRel = rel.replace(/\\/g, '/');
  const target = path.join(staticRoot, safeRel);
  const resolved = path.resolve(target);
  if (!resolved.startsWith(path.resolve(staticRoot) + path.sep)) {
    writeText(res, 400, 'Bad path');
    return;
  }

  try {
    const data = await fs.readFile(resolved);
    res.writeHead(200, {
      'content-type': guessContentType(resolved),
      'cache-control': 'no-store',
    });
    res.end(data);
  } catch {
    writeText(res, 404, 'Not found');
  }
}

async function buildSnapshot({ busRoot, roster, rosterPath }) {
  const uniqueAgents = rosterAgentNames(roster);
  const agentInfo = {};
  const rosterAgents = Array.isArray(roster?.agents) ? roster.agents : [];
  for (const a of rosterAgents) {
    const name = typeof a?.name === 'string' ? a.name.trim() : '';
    if (!name) continue;
    agentInfo[name] = {
      role: typeof a?.role === 'string' && a.role.trim() ? a.role.trim() : null,
      kind: typeof a?.kind === 'string' && a.kind.trim() ? a.kind.trim() : null,
      skills: Array.isArray(a?.skills) ? a.skills.map((s) => String(s)).filter(Boolean) : [],
    };
  }
  for (const name of uniqueAgents) {
    if (!agentInfo[name]) agentInfo[name] = { role: null, kind: null, skills: [] };
  }

  const summary = await statusSummary({ busRoot, roster });

  const inbox = {};
  const states = ['new', 'seen', 'in_progress'];
  for (const agentName of uniqueAgents) {
    inbox[agentName] = {};
    for (const state of states) {
      const tasks = await listInboxTasks({ busRoot, agentName, state, limit: 50 });
      inbox[agentName][state] = tasks.map((t) => ({
        taskId: t.taskId,
        path: path.relative(busRoot, t.path),
        mtimeMs: t.mtimeMs,
        meta: t.meta,
      }));
    }
  }

  const receipts = await recentReceipts({ busRoot, agentName: null, limit: 25 });

  return {
    nowIso: nowIso(),
    busRoot,
    rosterPath,
    roster: {
      schemaVersion: roster?.schemaVersion ?? null,
      sessionName: roster?.sessionName ?? null,
      orchestratorName: roster?.orchestratorName ?? null,
      daddyChatName: roster?.daddyChatName ?? null,
      autopilotName: roster?.autopilotName ?? null,
      agents: uniqueAgents,
      agentInfo,
    },
    statusSummary: summary,
    inbox,
    recentReceipts: receipts,
  };
}

export async function createDashboardServer({ host, port, busRoot, rosterPath } = {}) {
  const repoRoot = getRepoRoot(process.cwd());
  const loaded = await loadRoster({ repoRoot, rosterPath: rosterPath || null });
  const roster = loaded.roster;
  const resolvedRosterPath = loaded.path;
  const resolvedBusRoot = resolveBusRoot({ busRoot: busRoot || null, repoRoot });

  await ensureBusRoot(resolvedBusRoot, roster);

  const serverDir = path.dirname(fileURLToPath(import.meta.url));
  const staticRoot = path.join(serverDir, 'public');

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const pathname = url.pathname || '/';

      // API
      if (pathname === '/api/snapshot' && req.method === 'GET') {
        const snap = await buildSnapshot({ busRoot: resolvedBusRoot, roster, rosterPath: resolvedRosterPath });
        writeJson(res, 200, snap);
        return;
      }

      if (pathname === '/api/task/open' && req.method === 'GET') {
        const agentName = safeString(url.searchParams.get('agent') || '');
        const taskId = safeString(url.searchParams.get('id') || '');
        if (!agentName || !taskId) {
          writeJson(res, 400, { ok: false, error: 'Missing agent or id' });
          return;
        }
        const opened = await openTask({ busRoot: resolvedBusRoot, agentName, taskId, markSeen: false });
        writeJson(res, 200, {
          ok: true,
          agent: agentName,
          taskId,
          state: opened.state,
          path: path.relative(resolvedBusRoot, opened.path),
          meta: opened.meta,
          body: opened.body,
          markdown: opened.markdown,
        });
        return;
      }

      if (pathname === '/api/task/send' && req.method === 'POST') {
        const body = await readBodyJson(req);
        if (!body || typeof body !== 'object') {
          writeJson(res, 400, { ok: false, error: 'Missing JSON body' });
          return;
        }

        const to = normalizeToArray(body.to);
        const from = safeString(body.from || 'daddy', { maxLen: 200 });
        const priority = safeString(body.priority || 'P2', { maxLen: 10 });
        const title = safeString(body.title || '', { maxLen: 300 });
        const textBody = safeString(body.body || '', { maxLen: 200_000 });
        const kind = safeString(body.kind || 'USER_REQUEST', { maxLen: 50 });
        const phase = body.phase == null ? null : safeString(body.phase, { maxLen: 50 });
        const smoke = Boolean(body.smoke);

        if (!to.length) {
          writeJson(res, 400, { ok: false, error: 'Missing "to"' });
          return;
        }
        if (!title.trim()) {
          writeJson(res, 400, { ok: false, error: 'Missing "title"' });
          return;
        }

        const id = safeString(body.id || '', { maxLen: 300 }) || makeId('msg');
        const rootId = safeString(body.rootId || '', { maxLen: 300 }) || id;
        const parentId =
          safeString(body.parentId || '', { maxLen: 300 }) ||
          (kind && kind !== 'USER_REQUEST' ? rootId : rootId);

        const meta = {
          id,
          to,
          from,
          priority,
          title,
          signals: {
            kind,
            phase,
            rootId,
            parentId,
            smoke,
          },
          references: body.references && typeof body.references === 'object' ? body.references : {},
        };

        const delivered = await deliverTask({ busRoot: resolvedBusRoot, meta, body: textBody });
        writeJson(res, 200, {
          ok: true,
          id,
          paths: delivered.paths.map((p) => path.relative(resolvedBusRoot, p)),
          suspiciousHits: delivered.suspiciousHits,
          suspiciousPolicy: delivered.suspiciousPolicy,
        });
        return;
      }

      if (pathname === '/api/task/update' && req.method === 'POST') {
        const body = await readBodyJson(req);
        if (!body || typeof body !== 'object') {
          writeJson(res, 400, { ok: false, error: 'Missing JSON body' });
          return;
        }

        const agentName = safeString(body.agent || body.agentName || '', { maxLen: 200 });
        const taskId = safeString(body.id || body.taskId || '', { maxLen: 300 });
        const appendBody = safeString(body.append || body.appendBody || '', { maxLen: 200_000 });
        const updateFrom = safeString(body.updateFrom || 'daddy', { maxLen: 200 });
        const title = body.title == null ? null : safeString(body.title, { maxLen: 300 });
        const priority = body.priority == null ? null : safeString(body.priority, { maxLen: 10 });

        if (!agentName || !taskId) {
          writeJson(res, 400, { ok: false, error: 'Missing agentName or taskId' });
          return;
        }
        if (!appendBody.trim() && !title && !priority) {
          writeJson(res, 400, { ok: false, error: 'Nothing to update (append/title/priority)' });
          return;
        }

        const updated = await updateTask({
          busRoot: resolvedBusRoot,
          agentName,
          taskId,
          updateFrom,
          appendBody,
          title,
          priority,
        });
        writeJson(res, 200, {
          ok: true,
          agent: agentName,
          taskId,
          path: path.relative(resolvedBusRoot, updated.path),
        });
        return;
      }

      if (pathname === '/api/task/cancel' && req.method === 'POST') {
        const body = await readBodyJson(req);
        if (!body || typeof body !== 'object') {
          writeJson(res, 400, { ok: false, error: 'Missing JSON body' });
          return;
        }

        const agentName = safeString(body.agent || body.agentName || '', { maxLen: 200 });
        const taskId = safeString(body.id || body.taskId || '', { maxLen: 300 });
        const canceledBy = safeString(body.canceledBy || body.updateFrom || body.from || 'dashboard', {
          maxLen: 200,
        });
        const reason = body.reason == null ? '' : safeString(body.reason, { maxLen: 2000 });
        const notifyOrchestrator = Boolean(body.notifyOrchestrator);
        const allRecipients = Boolean(body.allRecipients);

        if (!agentName || !taskId) {
          writeJson(res, 400, { ok: false, error: 'Missing agentName or taskId' });
          return;
        }

        let targetAgents = [agentName];
        if (allRecipients) {
          const opened = await openTask({ busRoot: resolvedBusRoot, agentName, taskId, markSeen: false });
          const to = Array.isArray(opened.meta?.to) ? opened.meta.to.map((x) => String(x)) : [];
          targetAgents = Array.from(new Set(to)).filter(Boolean);
          if (!targetAgents.length) targetAgents = [agentName];
        }

        const note = `Canceled by ${canceledBy}${reason && reason.trim() ? `: ${reason.trim()}` : ''}`;
        const results = [];
        for (const target of targetAgents) {
          try {
            const closed = await closeTask({
              busRoot: resolvedBusRoot,
              roster,
              agentName: target,
              taskId,
              outcome: 'skipped',
              note,
              commitSha: '',
              receiptExtra: {
                canceledBy,
                reason: reason && reason.trim() ? reason.trim() : null,
                scope: allRecipients ? 'allRecipients' : 'agentOnly',
              },
              notifyOrchestrator,
            });
            results.push({
              agent: target,
              receiptPath: path.relative(resolvedBusRoot, closed.receiptPath),
              processedPath: path.relative(resolvedBusRoot, closed.processedPath),
            });
          } catch (err) {
            results.push({ agent: target, error: (err && err.message) || String(err) });
          }
        }

        writeJson(res, 200, { ok: true, taskId, results });
        return;
      }

      if (pathname.startsWith('/api/') && req.method === 'GET') {
        writeJson(res, 404, { ok: false, error: 'Unknown API route' });
        return;
      }

      // Static UI
      await serveStatic({ reqPath: pathname, res, staticRoot });
    } catch (err) {
      writeJson(res, 500, { ok: false, error: (err && err.message) || String(err) });
    }
  });

  const listenHost = host || process.env.AGENTIC_DASHBOARD_HOST || '127.0.0.1';
  const listenPortRaw = port ?? process.env.AGENTIC_DASHBOARD_PORT ?? String(DEFAULT_DASHBOARD_PORT);
  const listenPort = parseDashboardPort(listenPortRaw);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPort, listenHost, () => resolve());
  });

  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr && typeof addr.port === 'number' ? addr.port : listenPort;

  return {
    server,
    host: listenHost,
    port: actualPort,
    busRoot: resolvedBusRoot,
    rosterPath: resolvedRosterPath,
  };
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      host: { type: 'string' },
      port: { type: 'string' },
      'bus-root': { type: 'string' },
      roster: { type: 'string' },
    },
  });

  const started = await createDashboardServer({
    host: values.host || null,
    port: values.port || null,
    busRoot: values['bus-root'] || null,
    rosterPath: values.roster || null,
  });

  const baseUrl = `http://${started.host === '127.0.0.1' ? 'localhost' : started.host}:${started.port}`;
  const autoOpenRaw = String(process.env.AGENTIC_DASHBOARD_AUTO_OPEN || '').trim().toLowerCase();
  const autoOpen = autoOpenRaw === '1' || autoOpenRaw === 'true' || autoOpenRaw === 'yes';

  process.stderr.write(
    `Dashboard running: ${baseUrl}\n` +
      `  busRoot: ${started.busRoot}\n` +
      `  roster: ${started.rosterPath}\n`,
  );

  if (autoOpen) openBrowserBestEffort(baseUrl);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(((err && err.stack) || String(err)) + '\n');
    process.exitCode = 1;
  });
}
