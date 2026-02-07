#!/usr/bin/env node
/**
 * Rollout metrics: summarize Codex token burn from ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl.
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

function usage() {
  return (
    `Usage: node scripts/rollout-metrics.mjs [options]\n\n` +
    `Summarize Codex token usage from rollout JSONL files.\n\n` +
    `Options:\n` +
    `  --sessions-dir <path>   Root directory (default: ~/.codex/sessions)\n` +
    `  --since <date>          Inclusive window start (Date.parse()-compatible)\n` +
    `  --until <date>          Inclusive window end (default: now)\n` +
    `  --prompt-filter <text>  Only count prompts containing this substring\n` +
    `  --limit <n>             Only scan the most recent N rollout files\n` +
    `  -h, --help              Show this help\n`
  );
}

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

function parseTaskFrontmatterBlock(text) {
  const s = String(text ?? '');
  const idx = s.indexOf('--- TASK PACKET ---');
  if (idx === -1) return null;
  const tail = s.slice(idx);
  const m = tail.match(/---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n/);
  return m && m[1] ? String(m[1]) : null;
}

function extractMetaFields(frontmatterBlock) {
  const raw = String(frontmatterBlock ?? '').trim();
  if (!raw) return { kind: 'UNKNOWN', rootId: null, sourceKind: null, completedTaskKind: null };

  /** @type {any} */
  let meta = null;
  try {
    meta = JSON.parse(raw);
  } catch {
    meta = null;
  }

  const fromObj = (pathKeys) => safeGet(meta, pathKeys);

  const kindFromObj = typeof fromObj(['signals', 'kind']) === 'string' ? String(fromObj(['signals', 'kind'])).trim() : '';
  const rootFromObj =
    typeof fromObj(['signals', 'rootId']) === 'string' ? String(fromObj(['signals', 'rootId'])).trim() : '';
  const sourceFromObj =
    typeof fromObj(['signals', 'sourceKind']) === 'string' ? String(fromObj(['signals', 'sourceKind'])).trim() : '';
  const completedFromObj =
    typeof fromObj(['references', 'completedTaskKind']) === 'string'
      ? String(fromObj(['references', 'completedTaskKind'])).trim()
      : '';

  // Fallback regex extraction (handles YAML-like frontmatter or partial JSON dumps).
  const kindRe =
    kindFromObj ||
    (raw.match(/"signals"\s*:\s*\{[\s\S]{0,400}?"kind"\s*:\s*"([^"]+)"/)?.[1] ?? '') ||
    (raw.match(/^\s*kind:\s*([^\n#]+)/m)?.[1] ?? '') ||
    (raw.match(/"kind"\s*:\s*"([^"]+)"/)?.[1] ?? '');
  const rootRe =
    rootFromObj ||
    (raw.match(/"rootId"\s*:\s*"([^"]+)"/)?.[1] ?? '') ||
    (raw.match(/^\s*rootId:\s*([^\n#]+)/m)?.[1] ?? '');
  const sourceRe =
    sourceFromObj ||
    (raw.match(/"sourceKind"\s*:\s*"([^"]+)"/)?.[1] ?? '') ||
    (raw.match(/^\s*sourceKind:\s*([^\n#]+)/m)?.[1] ?? '');
  const completedRe =
    completedFromObj ||
    (raw.match(/"completedTaskKind"\s*:\s*"([^"]+)"/)?.[1] ?? '') ||
    (raw.match(/^\s*completedTaskKind:\s*([^\n#]+)/m)?.[1] ?? '');

  const kind = String(kindRe || '').trim() || 'UNKNOWN';
  const rootId = String(rootRe || '').trim() || null;
  const sourceKind = String(sourceRe || '').trim() || null;
  const completedTaskKind = String(completedRe || '').trim() || null;

  return { kind, rootId, sourceKind, completedTaskKind };
}

async function main() {
  const { values } = parseArgs({
    options: {
      'sessions-dir': { type: 'string' },
      since: { type: 'string' },
      until: { type: 'string' },
      'prompt-filter': { type: 'string' },
      limit: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help) {
    process.stdout.write(usage());
    return;
  }

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
  /** @type {Map<string, number>} */
  const invocationsByAgent = new Map();
  /** @type {Map<string, Map<string, number>>} */
  const invocationsByAgentKind = new Map();
  /** @type {Map<string, number>} */
  const totalsByRootId = new Map();
  /** @type {Map<string, number>} */
  const invocationsByRootId = new Map();
  /** @type {Map<string, number>} */
  const totalsByAutopilotSource = new Map();
  /** @type {Map<string, number>} */
  const invocationsByAutopilotSource = new Map();
  let grandTotal = 0;

  for (const filePath of files) {
    const rl = readline.createInterface({
      input: createReadStream(filePath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });

    let prevTotal = null;
    let curAgent = null;
    let curKind = 'UNKNOWN';
    let curRootId = null;
    let curSourceKind = null;
    let curCompletedTaskKind = null;

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
          const agent = parseAgentNameFromPrompt(text);
          if (promptFilter && !text.includes(promptFilter)) {
            // Avoid misattributing subsequent token_count deltas to the previous prompt.
            curAgent = null;
            curKind = 'UNKNOWN';
            curRootId = null;
            curSourceKind = null;
            curCompletedTaskKind = null;
            continue;
          }

          // If we can't parse an agent from the prompt, we must not keep the previous agent context.
          // Drop attribution until the next prompt that we can parse.
          curAgent = agent || null;
          const frontmatterBlock = parseTaskFrontmatterBlock(text);
          const fields = extractMetaFields(frontmatterBlock);
          const kind = fields.kind;
          curKind = kind || 'UNKNOWN';

          curRootId = fields.rootId;
          curSourceKind = fields.sourceKind;
          curCompletedTaskKind = fields.completedTaskKind;

          if (curAgent) {
            invocationsByAgent.set(curAgent, (invocationsByAgent.get(curAgent) || 0) + 1);
            if (!invocationsByAgentKind.has(curAgent)) invocationsByAgentKind.set(curAgent, new Map());
            const byKind = invocationsByAgentKind.get(curAgent);
            byKind.set(curKind, (byKind.get(curKind) || 0) + 1);
          }
          if (curRootId) {
            invocationsByRootId.set(curRootId, (invocationsByRootId.get(curRootId) || 0) + 1);
          }
          if (curKind === 'ORCHESTRATOR_UPDATE' && curSourceKind) {
            const k = `${curSourceKind}:${curCompletedTaskKind || '*'}`;
            invocationsByAutopilotSource.set(k, (invocationsByAutopilotSource.get(k) || 0) + 1);
          }
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

        if (curRootId) totalsByRootId.set(curRootId, (totalsByRootId.get(curRootId) || 0) + delta);
        if (curKind === 'ORCHESTRATOR_UPDATE' && curSourceKind) {
          const k = `${curSourceKind}:${curCompletedTaskKind || '*'}`;
          totalsByAutopilotSource.set(k, (totalsByAutopilotSource.get(k) || 0) + delta);
        }
      }
    }
  }

  const agentsSorted = Array.from(totalsByAgent.entries()).sort((a, b) => b[1] - a[1]);
  const rootsSorted = Array.from(totalsByRootId.entries()).sort((a, b) => b[1] - a[1]);
  const apSorted = Array.from(totalsByAutopilotSource.entries()).sort((a, b) => b[1] - a[1]);

  process.stdout.write(`sessionsDir: ${sessionsDir}\n`);
  process.stdout.write(`window: ${new Date(sinceMs).toISOString()} .. ${new Date(untilMs).toISOString()}\n`);
  if (promptFilter) process.stdout.write(`promptFilter: ${promptFilter}\n`);
  process.stdout.write(`rolloutsScanned: ${files.length}\n`);
  process.stdout.write(`totalTokens: ${fmtInt(grandTotal)}\n\n`);

  for (const [agent, total] of agentsSorted) {
    const inv = invocationsByAgent.get(agent) || 0;
    const avg = inv > 0 ? Math.round(total / inv) : 0;
    process.stdout.write(`${agent}: ${fmtInt(total)}  (invocations=${fmtInt(inv)} avg=${fmtInt(avg)})\n`);
    const kinds = totalsByAgentKind.get(agent);
    if (!kinds) continue;
    const kindsSorted = Array.from(kinds.entries()).sort((a, b) => b[1] - a[1]);
    const invKinds = invocationsByAgentKind.get(agent) || new Map();
    for (const [kind, ktotal] of kindsSorted.slice(0, 8)) {
      const kinv = invKinds.get(kind) || 0;
      const kavg = kinv > 0 ? Math.round(ktotal / kinv) : 0;
      process.stdout.write(`  ${kind}: ${fmtInt(ktotal)}  (n=${fmtInt(kinv)} avg=${fmtInt(kavg)})\n`);
    }
    if (kindsSorted.length > 8) process.stdout.write(`  … (${kindsSorted.length - 8} more kinds)\n`);
  }

  if (rootsSorted.length) {
    process.stdout.write(`\nTop rootIds by tokens:\n`);
    for (const [rootId, total] of rootsSorted.slice(0, 10)) {
      const inv = invocationsByRootId.get(rootId) || 0;
      const avg = inv > 0 ? Math.round(total / inv) : 0;
      process.stdout.write(`  ${rootId}: ${fmtInt(total)}  (n=${fmtInt(inv)} avg=${fmtInt(avg)})\n`);
    }
  }

  if (apSorted.length) {
    process.stdout.write(`\nTop ORCHESTRATOR_UPDATE sources by tokens:\n`);
    for (const [k, total] of apSorted.slice(0, 10)) {
      const inv = invocationsByAutopilotSource.get(k) || 0;
      const avg = inv > 0 ? Math.round(total / inv) : 0;
      process.stdout.write(`  ${k}: ${fmtInt(total)}  (n=${fmtInt(inv)} avg=${fmtInt(avg)})\n`);
    }
  }
}

main().catch((err) => {
  process.stderr.write(`ERROR: ${(err && err.stack) || String(err)}\n`);
  process.exit(1);
});
