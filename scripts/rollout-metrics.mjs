#!/usr/bin/env node
/**
 * Rollout metrics: summarize Codex token burn from ~/.codex/sessions/*/rollout-*.jsonl.
 *
 * This is intentionally "best effort": rollout schemas evolve. We only rely on:
 * - event_msg payload.type=token_count (info.total_token_usage.total_tokens)
 * - response_item payload.role=user containing our `--- TASK PACKET ---` marker
 */

import { parseArgs } from 'node:util';
import { promises as fs, createReadStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

function parseDateMs(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

function fmtInt(n) {
  const x = Number(n) || 0;
  return Math.round(x).toLocaleString('en-US');
}

function safeGet(obj, keys) {
  let cur = obj;
  for (const k of keys) {
    if (!cur || typeof cur !== 'object') return null;
    cur = cur[k];
  }
  return cur ?? null;
}

async function listRolloutFiles(rootDir) {
  /** @type {string[]} */
  const out = [];

  /** @type {Array<string>} */
  const stack = [rootDir];
  while (stack.length) {
    const dir = stack.pop();
    let ents = [];
    try {
      ents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of ents) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else if (ent.isFile() && ent.name.startsWith('rollout-') && ent.name.endsWith('.jsonl')) out.push(p);
    }
  }

  out.sort();
  return out;
}

function extractTaskPacketText(evt) {
  const role = safeGet(evt, ['payload', 'role']);
  if (role !== 'user') return null;
  const content = safeGet(evt, ['payload', 'content']);
  if (!Array.isArray(content)) return null;
  for (const item of content) {
    if (item && typeof item === 'object' && item.type === 'input_text' && typeof item.text === 'string') {
      if (item.text.includes('--- TASK PACKET ---')) return item.text;
    }
  }
  return null;
}

function parseAgentNameFromPrompt(text) {
  const m = String(text ?? '').match(/\bYou are the agent \"([^\"]+)\"/);
  return m && m[1] ? String(m[1]).trim() : null;
}

function parseTaskMetaFromPrompt(text) {
  const s = String(text ?? '');
  const idx = s.indexOf('--- TASK PACKET ---');
  if (idx === -1) return null;
  const tail = s.slice(idx);
  const m = tail.match(/---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n/);
  if (!m || !m[1]) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      'sessions-dir': { type: 'string' },
      since: { type: 'string' },
      until: { type: 'string' },
      'prompt-filter': { type: 'string' },
      limit: { type: 'string' },
    },
  });

  const sessionsDir = path.resolve(values['sessions-dir']?.trim() || path.join(os.homedir(), '.codex', 'sessions'));
  const sinceMs = parseDateMs(values.since) ?? 0;
  const untilMs = parseDateMs(values.until) ?? Date.now();
  const promptFilter = values['prompt-filter']?.trim() || '';
  const limit = Math.max(0, Number(values.limit) || 0);

  const filesAll = await listRolloutFiles(sessionsDir);
  const files = limit > 0 ? filesAll.slice(-limit) : filesAll;

  /** @type {Map<string, number>} */
  const totalsByAgent = new Map();
  /** @type {Map<string, Map<string, number>>} */
  const totalsByAgentKind = new Map();
  let grandTotal = 0;

  for (const filePath of files) {
    const rl = readline.createInterface({
      input: createReadStream(filePath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });

    let prevTotal = null;
    let curAgent = null;
    let curKind = 'UNKNOWN';

    for await (const line of rl) {
      const trimmed = String(line ?? '').trim();
      if (!trimmed) continue;
      let evt;
      try {
        evt = JSON.parse(trimmed);
      } catch {
        continue;
      }

      const ts = safeGet(evt, ['timestamp']);
      const tsMs = typeof ts === 'string' ? Date.parse(ts) : NaN;
      if (Number.isFinite(tsMs)) {
        if (tsMs < sinceMs) continue;
        if (tsMs > untilMs) continue;
      }

      if (evt?.type === 'response_item') {
        const text = extractTaskPacketText(evt);
        if (text) {
          if (promptFilter && !text.includes(promptFilter)) continue;
          const agent = parseAgentNameFromPrompt(text);
          const meta = parseTaskMetaFromPrompt(text);
          const kind = typeof meta?.signals?.kind === 'string' ? meta.signals.kind.trim() : 'UNKNOWN';
          if (agent) curAgent = agent;
          curKind = kind || 'UNKNOWN';
        }
        continue;
      }

      if (evt?.type === 'event_msg') {
        const ptype = safeGet(evt, ['payload', 'type']);
        if (ptype !== 'token_count') continue;
        const totalTokens = safeGet(evt, ['payload', 'info', 'total_token_usage', 'total_tokens']);
        if (!Number.isFinite(Number(totalTokens))) continue;
        const cur = Number(totalTokens);
        if (prevTotal == null) {
          prevTotal = cur;
          continue;
        }
        const delta = cur - prevTotal;
        prevTotal = cur;
        if (!Number.isFinite(delta) || delta <= 0) continue;
        if (!curAgent) continue;

        grandTotal += delta;
        totalsByAgent.set(curAgent, (totalsByAgent.get(curAgent) || 0) + delta);
        if (!totalsByAgentKind.has(curAgent)) totalsByAgentKind.set(curAgent, new Map());
        const kinds = totalsByAgentKind.get(curAgent);
        kinds.set(curKind, (kinds.get(curKind) || 0) + delta);
      }
    }
  }

  const agentsSorted = Array.from(totalsByAgent.entries()).sort((a, b) => b[1] - a[1]);

  process.stdout.write(`sessionsDir: ${sessionsDir}\n`);
  process.stdout.write(`window: ${new Date(sinceMs).toISOString()} .. ${new Date(untilMs).toISOString()}\n`);
  if (promptFilter) process.stdout.write(`promptFilter: ${promptFilter}\n`);
  process.stdout.write(`rolloutsScanned: ${files.length}\n`);
  process.stdout.write(`totalTokens: ${fmtInt(grandTotal)}\n\n`);

  for (const [agent, total] of agentsSorted) {
    process.stdout.write(`${agent}: ${fmtInt(total)}\n`);
    const kinds = totalsByAgentKind.get(agent);
    if (!kinds) continue;
    const kindsSorted = Array.from(kinds.entries()).sort((a, b) => b[1] - a[1]);
    for (const [kind, ktotal] of kindsSorted.slice(0, 8)) {
      process.stdout.write(`  ${kind}: ${fmtInt(ktotal)}\n`);
    }
    if (kindsSorted.length > 8) process.stdout.write(`  … (${kindsSorted.length - 8} more kinds)\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`ERROR: ${(err && err.stack) || String(err)}\n`);
  process.exit(1);
});
