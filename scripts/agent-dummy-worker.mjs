#!/usr/bin/env node
/**
 * Dummy worker for smoke/tests.
 *
 * Reads tasks from inbox/<agent>/new, marks seen, then closes with a deterministic receipt.
 */

import { parseArgs } from 'node:util';
import crypto from 'node:crypto';
import {
  getRepoRoot,
  loadRoster,
  resolveBusRoot,
  ensureBusRoot,
  listInboxTaskIds,
  claimTask,
  closeTask,
} from './lib/agentbus.mjs';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const repoRoot = getRepoRoot();
  const { values } = parseArgs({
    allowPositionals: true,
    options: {
      agent: { type: 'string' },
      'bus-root': { type: 'string' },
      roster: { type: 'string' },
      once: { type: 'boolean' },
      'poll-ms': { type: 'string' },
    },
  });

  const rosterInfo = await loadRoster({ repoRoot, rosterPath: values.roster });
  const roster = rosterInfo.roster;

  const busRoot = resolveBusRoot({ busRoot: values['bus-root'], repoRoot });
  await ensureBusRoot(busRoot, roster);

  const agentName = values.agent?.trim();
  if (!agentName) throw new Error('--agent is required');

  const pollMs = values['poll-ms'] ? Math.max(50, Number(values['poll-ms'])) : 200;

  while (true) {
    const ids = await listInboxTaskIds({ busRoot, agentName, state: 'new' });
    for (const id of ids) {
      let opened = null;
      try {
        opened = await claimTask({ busRoot, agentName, taskId: id });
      } catch (err) {
        process.stderr.write(`WARN: dummy worker could not claim ${id}: ${(err && err.message) || String(err)}\n`);
        continue;
      }

      const echo = opened.body.trim().slice(0, 200);
      const fakeSha = crypto.randomBytes(4).toString('hex');

      await closeTask({
        busRoot,
        roster,
        agentName,
        taskId: id,
        outcome: 'done',
        note: `dummy completed: ${echo}`,
        commitSha: fakeSha,
        receiptExtra: { echoed: echo },
      });
    }

    if (values.once) break;
    await sleep(pollMs);
  }
}

main().catch((err) => {
  process.stderr.write(`ERROR: ${(err && err.stack) || String(err)}\n`);
  process.exit(1);
});
