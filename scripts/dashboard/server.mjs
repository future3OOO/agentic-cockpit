#!/usr/bin/env node
/**
 * Agentic Cockpit local dashboard server (no build step).
 *
 * - Serves a small static UI
 * - Exposes a minimal JSON API for reading bus state and sending/updating tasks
 *
 * Default: http://127.0.0.1:3000
 */

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import { parseArgs } from 'node:util';

import {
  getRepoRoot,
  loadRoster,
  resolveBusRoot,
  ensureBusRoot,
  statusSummary,
  listInboxTasks,
  recentReceipts,
  openTask,
  deliverTask,
  updateTask,
  makeId,
} from '../lib/agentbus.mjs';

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
  const agents = roster?.agents?.map((a) => a?.name).filter(Boolean) ?? [];
  const uniqueAgents = Array.from(new Set(agents));

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
  const listenPortRaw = port ?? process.env.AGENTIC_DASHBOARD_PORT ?? '3000';
  const parsedPort = Number(listenPortRaw);
  const listenPort = Number.isFinite(parsedPort) ? parsedPort : 3000;

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

  process.stderr.write(
    `Dashboard running: http://${started.host}:${started.port}\n` +
      `  busRoot: ${started.busRoot}\n` +
      `  roster: ${started.rosterPath}\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(((err && err.stack) || String(err)) + '\n');
    process.exitCode = 1;
  });
}
