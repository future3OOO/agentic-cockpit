#!/usr/bin/env node
/**
 * AgentBus CLI
 *
 * Key commands:
 *   node scripts/agent-bus.mjs init
 *   node scripts/agent-bus.mjs send <taskFile.md>
 *   node scripts/agent-bus.mjs send-text --to <agent>[,<agent>] --title "..." --body "..."
 *   node scripts/agent-bus.mjs open --agent <agent> --id <taskId>
 *   node scripts/agent-bus.mjs close --agent <agent> --id <taskId> --outcome done --note "..." --commit-sha <sha>
 *   node scripts/agent-bus.mjs status
 *   node scripts/agent-bus.mjs recent --limit 20
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  BUS_SCHEMA_VERSION,
  getRepoRoot,
  loadRoster,
  resolveBusRoot,
  ensureBusRoot,
  parseFrontmatter,
  validateTaskMeta,
  deliverTask,
  openTask,
  updateTask,
  closeTask,
  statusSummary,
  listInboxTasks,
  recentReceipts,
  makeId,
  isSafeId,
  suspiciousPolicy,
} from './lib/agentbus.mjs';

// Allow piping to tools like `head` without throwing noisy EPIPE stack traces.
process.stdout.on('error', (err) => {
  if (err && err.code === 'EPIPE') process.exit(0);
});

function usage(code = 0) {
  const msg = `
AgentBus (schema v${BUS_SCHEMA_VERSION})

Usage:
  node scripts/agent-bus.mjs <command> [options]

Commands:
  init
  status
  list         # alias for status
  recent
  send <taskFile.md>
  send-text --to <agent[,agent]> --title <title> [--body <text> | --body-file <path> | --body-stdin]
  update --agent <agent> --id <taskId> --append <text> [--append-file <path> | --append-stdin] [--update-from <name>]
         [--title <title>] [--priority <P?>] [--signals-json <json>] [--references-json <json>]
  open-tasks   # list tasks in new/seen/in_progress
  open --agent <agent> --id <taskId>
  close --agent <agent> --id <taskId> [--outcome <done|blocked|failed|needs_review|skipped>] [--note <text>] [--commit-sha <sha>]
        [--receipt-json <json>] [--receipt-file <path>] [--no-notify-orchestrator]

Global options:
  --bus-root <path>   (or env AGENTIC_BUS_DIR)
  --roster <path>     (default docs/agentic/agent-bus/ROSTER.json)

Environment:
  AGENTIC_SUSPICIOUS_POLICY = block|warn|allow (default: block)
`;
  process.stderr.write(msg.trimStart() + '\n');
  process.exit(code);
}

function parseGlobalArgs(argv) {
  /** @type {{ cmd: string|null, rest: string[], busRoot: string|null, roster: string|null, help: boolean }} */
  const out = { cmd: null, rest: [], busRoot: null, roster: null, help: false };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      out.help = true;
      continue;
    }
    if (a === '--bus-root') {
      const v = argv[i + 1];
      if (!v) throw new Error('--bus-root requires a value');
      out.busRoot = v;
      i += 1;
      continue;
    }
    if (a === '--roster') {
      const v = argv[i + 1];
      if (!v) throw new Error('--roster requires a value');
      out.roster = v;
      i += 1;
      continue;
    }

    if (!out.cmd && !String(a).startsWith('-')) {
      out.cmd = a;
      continue;
    }
    out.rest.push(a);
  }

  return out;
}

function parseToList(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.flatMap((x) => String(x).split(',')).map((s) => s.trim()).filter(Boolean);
  return String(v)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function preprocessDashPrefixedOptionValues(args, { stringOptions, knownOptions }) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    const token = String(args[i] ?? '');
    if (!token.startsWith('--') || token.includes('=')) {
      out.push(token);
      continue;
    }

    const name = token.slice(2);
    out.push(token);
    if (!stringOptions.has(name)) continue;

    const next = args[i + 1];
    if (typeof next !== 'string' || !next.startsWith('-')) continue;
    // Keep normal option parsing when the "value" is actually another known option.
    if (next.startsWith('--')) {
      const nextName = next.slice(2).split('=')[0];
      if (knownOptions.has(nextName)) continue;
    }

    out[out.length - 1] = `${token}=${next}`;
    i += 1;
  }
  return out;
}

async function readStdinText() {
  if (process.stdin.isTTY) return '';
  let out = '';
  for await (const chunk of process.stdin) out += String(chunk);
  return out;
}

function assertKnownAgents(agentNames, targets, { label }) {
  const unknown = targets.filter((t) => !agentNames.has(t));
  if (unknown.length === 0) return;
  const known = Array.from(agentNames).sort();
  throw new Error(
    `Unknown ${label}: ${unknown.join(', ')}. ` +
      `Known agents: ${known.join(', ')}`,
  );
}

async function main() {
  const repoRoot = getRepoRoot();

  const global = parseGlobalArgs(process.argv.slice(2));
  if (global.help) usage(0);

  let cmd = global.cmd;
  if (!cmd) usage(1);

  const rosterInfo = await loadRoster({ repoRoot, rosterPath: global.roster });
  const busRoot = resolveBusRoot({ busRoot: global.busRoot, repoRoot });

  // Ensure structure for every command (cheap, idempotent).
  await ensureBusRoot(busRoot, rosterInfo.roster);

  if (cmd === 'list') cmd = 'status';

  if (cmd === 'init') {
    process.stdout.write(`OK: initialized AgentBus at ${busRoot}\n`);
    return;
  }

  if (cmd === 'status') {
    const rows = await statusSummary({ busRoot, roster: rosterInfo.roster });
    const maxAgentLen = Math.max(...rows.map((r) => r.agent.length), 5);
    process.stdout.write(`AgentBus status @ ${busRoot}\n`);
    for (const r of rows) {
      const pad = r.agent.padEnd(maxAgentLen, ' ');
      process.stdout.write(
        `  ${pad}  new=${r.new}  seen=${r.seen}  in_progress=${r.in_progress}  processed=${r.processed}\n`,
      );
    }
    return;
  }

  if (cmd === 'recent') {
    const { values: v2 } = parseArgs({
      allowPositionals: true,
      args: global.rest,
      options: {
        agent: { type: 'string' },
        limit: { type: 'string' },
        format: { type: 'string' },
      },
    });

    const limit = v2.limit ? Math.max(1, Math.min(200, Number(v2.limit))) : 20;
    const receipts = await recentReceipts({ busRoot, agentName: v2.agent ?? null, limit });
    const format = (v2.format || '').trim() || 'json';
    if (format === 'lines') {
      for (const r of receipts) {
        const title = r?.task?.title ? String(r.task.title) : '';
        const closedAt = r?.closedAt ? String(r.closedAt) : '';
        const agent = r?.agent ? String(r.agent) : '';
        const outcome = r?.outcome ? String(r.outcome) : '';
        const taskId = r?.taskId ? String(r.taskId) : '';
        process.stdout.write(`${closedAt} ${agent} ${outcome} ${taskId}${title ? ` — ${title}` : ''}\n`);
      }
      return;
    }
    if (format !== 'json') throw new Error(`recent: unknown --format ${JSON.stringify(format)} (expected: json|lines)`);
    process.stdout.write(JSON.stringify(receipts, null, 2) + '\n');
    return;
  }

  if (cmd === 'open-tasks') {
    const { values: v2 } = parseArgs({
      allowPositionals: true,
      args: global.rest,
      options: {
        agent: { type: 'string' },
        'root-id': { type: 'string' },
        limit: { type: 'string' },
        format: { type: 'string' },
      },
    });

    const agentFilter = v2.agent?.trim() || null;
    const rootIdFilter = v2['root-id']?.trim() || null;
    const limit = v2.limit ? Math.max(1, Math.min(500, Number(v2.limit))) : 200;

    /** @type {string[]} */
    const agents = agentFilter ? [agentFilter] : Array.from(rosterInfo.agentNames).sort();
    if (agentFilter) {
      assertKnownAgents(rosterInfo.agentNames, agents, { label: '--agent' });
    }

    const states = ['new', 'seen', 'in_progress'];
    /** @type {any[]} */
    const tasks = [];
    for (const agent of agents) {
      for (const state of states) {
        const items = await listInboxTasks({ busRoot, agentName: agent, state, limit });
        for (const it of items) {
          const meta = it.meta ?? {};
          if (rootIdFilter && meta?.signals?.rootId !== rootIdFilter) continue;
          tasks.push({
            agent,
            state,
            id: meta.id ?? it.taskId,
            title: meta.title ?? '',
            from: meta.from ?? '',
            priority: meta.priority ?? '',
            kind: meta?.signals?.kind ?? null,
            phase: meta?.signals?.phase ?? null,
            rootId: meta?.signals?.rootId ?? null,
            parentId: meta?.signals?.parentId ?? null,
            mtimeMs: it.mtimeMs ?? null,
          });
        }
      }
    }

    tasks.sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0));
    const format = (v2.format || '').trim() || 'json';
    const top = tasks.slice(0, limit);
    if (format === 'lines') {
      for (const t of top) {
        const kind = t.kind ?? 'UNKNOWN';
        const phase = t.phase ? `/${t.phase}` : '';
        const from = t.from ? ` from=${t.from}` : '';
        process.stdout.write(
          `[${t.state}] ${t.agent} ${t.priority} ${kind}${phase} ${t.id}${from} — ${t.title}\n`,
        );
      }
      return;
    }
    if (format !== 'json')
      throw new Error(`open-tasks: unknown --format ${JSON.stringify(format)} (expected: json|lines)`);
    process.stdout.write(JSON.stringify(top, null, 2) + '\n');
    return;
  }

  if (cmd === 'send') {
    const taskFile = global.rest[0];
    if (!taskFile) throw new Error('send requires <taskFile.md>');

    const raw = await fs.readFile(taskFile, 'utf8');
    const { meta, body } = parseFrontmatter(raw);
    if (!meta) throw new Error('Task file missing JSON frontmatter');
    validateTaskMeta(meta);
    assertKnownAgents(rosterInfo.agentNames, meta.to, { label: 'task targets' });

    const delivered = await deliverTask({ busRoot, meta, body });
    if (delivered.suspiciousHits.length && suspiciousPolicy() === 'warn') {
      process.stderr.write(`WARN: suspicious patterns detected: ${delivered.suspiciousHits.join(', ')}\n`);
    }
    process.stdout.write(JSON.stringify({ ok: true, paths: delivered.paths }, null, 2) + '\n');
    return;
  }

  if (cmd === 'send-text') {
    const sendTextOptionNames = [
      'to',
      'title',
      'from',
      'priority',
      'id',
      'body',
      'body-file',
      'body-stdin',
      'kind',
      'phase',
      'root-id',
      'parent-id',
      'signals-json',
      'references-json',
      'smoke',
    ];
    const sendTextStringOptionNames = new Set(
      sendTextOptionNames.filter((name) => name !== 'body-stdin' && name !== 'smoke'),
    );
    const sendTextKnownOptions = new Set(sendTextOptionNames);
    const sendTextArgs = preprocessDashPrefixedOptionValues(global.rest, {
      stringOptions: sendTextStringOptionNames,
      knownOptions: sendTextKnownOptions,
    });

    const { values: v2 } = parseArgs({
      allowPositionals: true,
      args: sendTextArgs,
      options: {
        to: { type: 'string' },
        title: { type: 'string' },
        from: { type: 'string' },
        priority: { type: 'string' },
        id: { type: 'string' },
        body: { type: 'string' },
        'body-file': { type: 'string' },
        'body-stdin': { type: 'boolean' },
        kind: { type: 'string' },
        phase: { type: 'string' },
        'root-id': { type: 'string' },
        'parent-id': { type: 'string' },
        'signals-json': { type: 'string' },
        'references-json': { type: 'string' },
        smoke: { type: 'boolean' },
      },
    });

    const to = parseToList(v2.to);
    if (to.length === 0) throw new Error('send-text requires --to <agent[,agent]>');
    assertKnownAgents(rosterInfo.agentNames, to, { label: '--to targets' });
    const title = v2.title?.trim();
    if (!title) throw new Error('send-text requires --title');

    const id = v2.id?.trim() || makeId('msg');
    if (!isSafeId(id)) throw new Error(`Invalid id "${id}"`);

    const from = (v2.from?.trim() || 'daddy').trim();
    const priority = (v2.priority?.trim() || 'P2').trim();

    const bodySourceCount = Number(Boolean(v2.body)) + Number(Boolean(v2['body-file'])) + Number(Boolean(v2['body-stdin']));
    if (bodySourceCount > 1) {
      throw new Error('send-text accepts only one of --body, --body-file, --body-stdin');
    }

    let body = v2.body ?? '';
    if (v2['body-file']) body = await fs.readFile(v2['body-file'], 'utf8');
    if (v2['body-stdin']) body = await readStdinText();

    let signals = {};
    if (v2.kind) signals.kind = String(v2.kind).trim();
    if (v2.phase) signals.phase = String(v2.phase).trim();
    if (v2['root-id']) signals.rootId = String(v2['root-id']).trim();
    if (v2['parent-id']) signals.parentId = String(v2['parent-id']).trim();
    if (v2.smoke) signals.smoke = true;

    if (v2['signals-json']) {
      try {
        signals = { ...signals, ...JSON.parse(v2['signals-json']) };
      } catch (err) {
        throw new Error(`Invalid --signals-json: ${(err && err.message) || String(err)}`);
      }
    }

    // Normalize common signal fields so matching/filtering doesn't break on whitespace.
    if (typeof signals.kind === 'string') signals.kind = signals.kind.trim();
    if (typeof signals.phase === 'string') signals.phase = signals.phase.trim();
    if (typeof signals.rootId === 'string') signals.rootId = signals.rootId.trim();
    if (typeof signals.parentId === 'string') signals.parentId = signals.parentId.trim();

    // Threading defaults:
    // - rootId defaults to the packet id so autopilot context snapshots can filter by workflow.
    // - parentId defaults to rootId for non-USER_REQUEST packets (best-effort when no explicit parent exists).
    if (typeof signals.rootId !== 'string' || !signals.rootId.trim()) signals.rootId = id;
    const kind = typeof signals.kind === 'string' ? signals.kind.trim() : '';
    if (kind && kind !== 'USER_REQUEST') {
      if (typeof signals.parentId !== 'string' || !signals.parentId.trim()) signals.parentId = signals.rootId;
    }

    let references = {};
    if (v2['references-json']) {
      try {
        references = JSON.parse(v2['references-json']);
      } catch (err) {
        throw new Error(`Invalid --references-json: ${(err && err.message) || String(err)}`);
      }
    }

    const meta = {
      id,
      to,
      from,
      priority,
      title,
      signals,
      references,
    };

    const delivered = await deliverTask({ busRoot, meta, body });
    if (delivered.suspiciousHits.length && suspiciousPolicy() === 'warn') {
      process.stderr.write(`WARN: suspicious patterns detected: ${delivered.suspiciousHits.join(', ')}\n`);
    }
    process.stdout.write(JSON.stringify({ ok: true, id, paths: delivered.paths }, null, 2) + '\n');
    return;
  }

  if (cmd === 'update') {
    const updateOptionNames = [
      'agent',
      'id',
      'append',
      'append-file',
      'append-stdin',
      'update-from',
      'title',
      'priority',
      'signals-json',
      'references-json',
    ];
    const updateStringOptionNames = new Set(
      updateOptionNames.filter((name) => name !== 'append-stdin'),
    );
    const updateKnownOptions = new Set(updateOptionNames);
    const updateArgs = preprocessDashPrefixedOptionValues(global.rest, {
      stringOptions: updateStringOptionNames,
      knownOptions: updateKnownOptions,
    });

    const { values: v2 } = parseArgs({
      allowPositionals: true,
      args: updateArgs,
      options: {
        agent: { type: 'string' },
        id: { type: 'string' },
        append: { type: 'string' },
        'append-file': { type: 'string' },
        'append-stdin': { type: 'boolean' },
        'update-from': { type: 'string' },
        title: { type: 'string' },
        priority: { type: 'string' },
        'signals-json': { type: 'string' },
        'references-json': { type: 'string' },
      },
    });

    const agent = v2.agent?.trim();
    const id = v2.id?.trim();
    if (!agent) throw new Error('update requires --agent');
    if (!id) throw new Error('update requires --id');
    if (!isSafeId(id)) throw new Error(`Invalid id "${id}"`);
    assertKnownAgents(rosterInfo.agentNames, [agent], { label: '--agent' });

    const updateFrom = (v2['update-from'] || 'daddy').trim() || 'daddy';
    const title = v2.title?.trim() || null;
    const priority = v2.priority?.trim() || null;

    const appendSourceCount =
      Number(Boolean(v2.append)) + Number(Boolean(v2['append-file'])) + Number(Boolean(v2['append-stdin']));
    if (appendSourceCount > 1) {
      throw new Error('update accepts only one of --append, --append-file, --append-stdin');
    }

    let appendBody = v2.append ?? '';
    if (v2['append-file']) {
      const extra = await fs.readFile(v2['append-file'], 'utf8');
      appendBody = appendBody ? `${appendBody}\n\n${extra}` : extra;
    }
    if (v2['append-stdin']) {
      const extra = await readStdinText();
      appendBody = appendBody ? `${appendBody}\n\n${extra}` : extra;
    }

    /** @type {Record<string, any>|null} */
    let signalsPatch = null;
    if (v2['signals-json']) {
      try {
        const parsed = JSON.parse(v2['signals-json']);
        if (!parsed || typeof parsed !== 'object') throw new Error('signals-json must be an object');
        signalsPatch = parsed;
      } catch (err) {
        throw new Error(`Invalid --signals-json: ${(err && err.message) || String(err)}`);
      }
    }

    /** @type {Record<string, any>|null} */
    let referencesPatch = null;
    if (v2['references-json']) {
      try {
        const parsed = JSON.parse(v2['references-json']);
        if (!parsed || typeof parsed !== 'object') throw new Error('references-json must be an object');
        referencesPatch = parsed;
      } catch (err) {
        throw new Error(`Invalid --references-json: ${(err && err.message) || String(err)}`);
      }
    }

    if (
      !appendBody.trim() &&
      !title &&
      !priority &&
      !signalsPatch &&
      !referencesPatch
    ) {
      throw new Error('update requires at least one change (--append/--append-file/--title/--priority/--signals-json/--references-json)');
    }

    const res = await updateTask({
      busRoot,
      agentName: agent,
      taskId: id,
      updateFrom,
      appendBody,
      title,
      priority,
      signalsPatch,
      referencesPatch,
    });

    if (res.suspiciousHits.length && res.suspiciousPolicy === 'warn') {
      process.stderr.write(`WARN: suspicious patterns detected: ${res.suspiciousHits.join(', ')}\n`);
    }

    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          state: res.state,
          path: res.path,
        },
        null,
        2,
      ) + '\n',
    );
    return;
  }

  if (cmd === 'open') {
    const { values: v2 } = parseArgs({
      allowPositionals: true,
      args: global.rest,
      options: {
        agent: { type: 'string' },
        id: { type: 'string' },
        'no-mark-seen': { type: 'boolean' },
      },
    });
    const agent = v2.agent?.trim();
    const id = v2.id?.trim();
    if (!agent) throw new Error('open requires --agent');
    if (!id) throw new Error('open requires --id');
    assertKnownAgents(rosterInfo.agentNames, [agent], { label: '--agent' });

    const opened = await openTask({ busRoot, agentName: agent, taskId: id, markSeen: !v2['no-mark-seen'] });
    process.stdout.write(opened.markdown);
    return;
  }

  if (cmd === 'close') {
    const { values: v2 } = parseArgs({
      allowPositionals: true,
      args: global.rest,
      options: {
        agent: { type: 'string' },
        id: { type: 'string' },
        outcome: { type: 'string' },
        note: { type: 'string' },
        'commit-sha': { type: 'string' },
        'receipt-json': { type: 'string' },
        'receipt-file': { type: 'string' },
        'no-notify-orchestrator': { type: 'boolean' },
      },
    });

    const agent = v2.agent?.trim();
    const id = v2.id?.trim();
    if (!agent) throw new Error('close requires --agent');
    if (!id) throw new Error('close requires --id');
    assertKnownAgents(rosterInfo.agentNames, [agent], { label: '--agent' });

    let receiptExtra = {};
    if (v2['receipt-json']) {
      try {
        receiptExtra = JSON.parse(v2['receipt-json']);
      } catch (err) {
        throw new Error(`Invalid --receipt-json: ${(err && err.message) || String(err)}`);
      }
    }
    if (v2['receipt-file']) {
      const raw = await fs.readFile(v2['receipt-file'], 'utf8');
      try {
        receiptExtra = JSON.parse(raw);
      } catch (err) {
        throw new Error(`Invalid JSON in --receipt-file: ${(err && err.message) || String(err)}`);
      }
    }

    const res = await closeTask({
      busRoot,
      roster: rosterInfo.roster,
      agentName: agent,
      taskId: id,
      outcome: v2.outcome?.trim() || 'done',
      note: v2.note ?? '',
      commitSha: v2['commit-sha']?.trim() || '',
      receiptExtra,
      notifyOrchestrator: !v2['no-notify-orchestrator'],
    });

    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          receiptPath: res.receiptPath,
          processedPath: res.processedPath,
          completionPath: res.completionPath,
        },
        null,
        2
      ) + '\n'
    );
    return;
  }

  usage(1);
}

main().catch((err) => {
  process.stderr.write(`ERROR: ${(err && err.stack) || String(err)}\n`);
  process.exit(1);
});
