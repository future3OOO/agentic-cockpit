#!/usr/bin/env node
/**
 * AgentBus listener.
 *
 * Watches inbox/<agent>/new for tasks, prints a compact header, and moves them to /seen.
 *
 * Autopaste is intentionally OFF by default. This is designed for "inbox pane" usage.
 */

import { parseArgs } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import {
  getRepoRoot,
  loadRoster,
  resolveBusRoot,
  ensureBusRoot,
  listInboxTaskIds,
  openTask,
} from './lib/agentbus.mjs';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function tmuxNotify(message, target = null) {
  try {
    const args = target ? ['display-message', '-t', target, message] : ['display-message', message];
    childProcess.execFileSync('tmux', args, { stdio: 'ignore' });
  } catch {
    // ignore (not in tmux)
  }
}

function printTaskHeader({ agentName, meta, filePath }) {
  const kind = meta?.signals?.kind ? ` kind=${meta.signals.kind}` : '';
  const from = meta?.from ? ` from=${meta.from}` : '';
  process.stdout.write(
    `\n=== NEW for ${agentName} ===\n` +
      `id: ${meta.id}\n` +
      `title: ${meta.title}${kind}${from}\n` +
      `priority: ${meta.priority}\n` +
      `path: ${filePath}\n`
  );
}

async function main() {
  const repoRoot = getRepoRoot();
  const { values } = parseArgs({
    allowPositionals: true,
    options: {
      agent: { type: 'string' },
      'bus-root': { type: 'string' },
      roster: { type: 'string' },
      'poll-ms': { type: 'string' },
      once: { type: 'boolean' },
      'tmux-notify': { type: 'boolean' },
      'tmux-target': { type: 'string' },
      'print-body': { type: 'boolean' },
    },
  });

  const agentName = values.agent?.trim();
  if (!agentName) throw new Error('--agent is required');

  const rosterInfo = await loadRoster({ repoRoot, rosterPath: values.roster });
  const busRoot = resolveBusRoot({ busRoot: values['bus-root'], repoRoot });
  await ensureBusRoot(busRoot, rosterInfo.roster);

  const pollMs = values['poll-ms'] ? Math.max(50, Number(values['poll-ms'])) : 500;

  while (true) {
    const ids = await listInboxTaskIds({ busRoot, agentName, state: 'new' });
    for (const id of ids) {
      try {
        const opened = await openTask({ busRoot, agentName, taskId: id, markSeen: true });
        printTaskHeader({ agentName, meta: opened.meta, filePath: opened.path });
        if (values['print-body']) {
          process.stdout.write('\n' + opened.body + '\n');
        }

        if (values['tmux-notify']) {
          const msg = `AgentBus: NEW ${agentName} ${opened.meta.id} — ${opened.meta.title}`;
          tmuxNotify(msg, values['tmux-target'] ?? null);
        }
      } catch (err) {
        process.stderr.write(`WARN: failed to open task ${id}: ${(err && err.message) || String(err)}\n`);
        // deadletter it
        try {
          const newPath = path.join(busRoot, 'inbox', agentName, 'new', `${id}.md`);
          const dl = path.join(busRoot, 'deadletter', agentName, `${id}.md`);
          await fs.rename(newPath, dl);
        } catch {
          // ignore
        }
      }
    }

    if (values.once) break;
    await sleep(pollMs);
  }
}

main().catch((err) => {
  process.stderr.write(`ERROR: ${(err && err.stack) || String(err)}\n`);
  process.exit(1);
});
