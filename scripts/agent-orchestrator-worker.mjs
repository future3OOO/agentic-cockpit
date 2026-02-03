#!/usr/bin/env node
/**
 * Orchestrator worker (forwarder).
 *
 * Purpose:
 *   The interactive "Daddy chat" pane is user-facing and cannot reliably consume bus events
 *   while the user is mid-conversation. This worker is a simple, deterministic bridge:
 *
 *   - It receives TASK_COMPLETE (and other alert) packets in its own inbox.
 *   - It reads referenced receipts/paths.
 *   - It forwards a compact, human-friendly digest into Daddy's inbox.
 *
 * This keeps the UX "natural language only" (no copy/paste), while allowing reliable async
 * task completion handling.
 */

import { parseArgs } from 'node:util';
import childProcess from 'node:child_process';
import path from 'node:path';
import {
  getRepoRoot,
  loadRoster,
  resolveBusRoot,
  ensureBusRoot,
  listInboxTaskIds,
  openTask,
  closeTask,
  readReceipt,
  pickDaddyChatName,
  pickAutopilotName,
  makeId,
  deliverTask,
} from './lib/agentbus.mjs';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function tmuxNotify(message, target = null) {
  try {
    const args = target ? ['display-message', '-t', target, message] : ['display-message', message];
    childProcess.execFileSync('tmux', args, { stdio: 'ignore' });
  } catch {
    // ignore
  }
}

function buildDigest({ kind, srcMeta, receipt }) {
  const lines = [];
  lines.push(`kind: ${kind}`);
  lines.push(`from: ${srcMeta.from}`);
  if (srcMeta?.title) lines.push(`title: ${srcMeta.title}`);
  if (srcMeta?.signals?.completedTaskId) lines.push(`task: ${srcMeta.signals.completedTaskId}`);
  if (srcMeta?.signals?.completedTaskKind) lines.push(`taskKind: ${srcMeta.signals.completedTaskKind}`);
  if (receipt?.outcome) lines.push(`outcome: ${receipt.outcome}`);
  if (receipt?.commitSha) lines.push(`commitSha: ${receipt.commitSha}`);
  if (receipt?.note) lines.push(`note: ${receipt.note}`);

  const extra = receipt?.receiptExtra ?? {};
  if (extra?.planMarkdown) {
    lines.push('');
    lines.push('--- plan ---');
    lines.push(extra.planMarkdown);
  }

  return lines.join('\n') + '\n';
}

function nextActionFor({ sourceKind, receipt, completedTaskKind }) {
  if (sourceKind === 'REVIEW_ACTION_REQUIRED') {
    return 'Autopilot: review source links; dispatch fixes; post “Fixed in <sha>… please re-check”.';
  }

  if (sourceKind !== 'TASK_COMPLETE') {
    return 'Autopilot: review and act.';
  }

  if (completedTaskKind === 'PLAN_REQUEST') {
    return 'Autopilot: review planMarkdown; approve or request revisions; do not EXECUTE until approved.';
  }

  if (!receipt) return 'Autopilot: receipt missing; open the source packet and investigate.';

  if (receipt.outcome === 'done') {
    if (receipt.commitSha) return 'Autopilot: review commitSha and proceed (integrate/review/closeout).';
    return 'Autopilot: review receipt details and decide next steps.';
  }

  if (receipt.outcome === 'needs_review') return 'Autopilot: human review required; decide whether to re-run gates or revise.';
  if (receipt.outcome === 'blocked') return 'Autopilot: unblock (missing env, unclear spec, or external dependency).';
  if (receipt.outcome === 'failed') return 'Autopilot: triage failure; dispatch a fix task.';
  return 'Autopilot: review and act.';
}

async function forwardToDaddy({ busRoot, roster, fromAgent, srcMeta, receipt, digestBody }) {
  const daddyName = pickDaddyChatName(roster);
  const autopilotName = pickAutopilotName(roster);
  const forwardedId = makeId(`orch_${fromAgent}`);
  const kind = srcMeta?.signals?.kind ?? 'ORCHESTRATOR_EVENT';
  const completedTaskKind = srcMeta?.signals?.completedTaskKind ?? null;

  const to = [daddyName];
  // daddy-autopilot is the authoritative driver: it must see digests for completions and observer events
  // so the system keeps progressing without a human prompting the interactive Daddy chat.
  //
  // We suppress forwarding of ORCHESTRATOR_UPDATE completions to avoid feedback loops / inbox spam.
  const shouldForwardToAutopilot =
    Boolean(autopilotName) &&
    autopilotName !== daddyName &&
    fromAgent !== autopilotName &&
    (kind !== 'TASK_COMPLETE' || (completedTaskKind && completedTaskKind !== 'ORCHESTRATOR_UPDATE'));

  if (shouldForwardToAutopilot) to.push(autopilotName);

  const meta = {
    id: forwardedId,
    to,
    from: 'daddy-orchestrator',
    priority: srcMeta?.priority ?? 'P2',
    title: `[orchestrator] ${kind} from ${fromAgent}: ${srcMeta?.title ?? srcMeta?.signals?.completedTaskId ?? ''}`.trim(),
    signals: {
      kind: 'ORCHESTRATOR_UPDATE',
      sourceKind: kind,
      rootId: srcMeta?.signals?.rootId ?? srcMeta?.signals?.completedTaskId ?? srcMeta?.id ?? null,
      parentId: srcMeta?.signals?.parentId ?? null,
      phase: srcMeta?.signals?.phase ?? null,
      smoke: Boolean(srcMeta?.signals?.smoke),
      notifyOrchestrator: false,
    },
    references: {
      sourceAgent: fromAgent,
      sourceTaskId: srcMeta?.signals?.completedTaskId ?? srcMeta?.id ?? null,
      completedTaskKind,
      receiptPath: srcMeta?.references?.receiptPath ?? null,
      processedPath: srcMeta?.references?.processedPath ?? null,
      commitSha: receipt?.commitSha ?? srcMeta?.references?.commitSha ?? null,
      sourceReferences: srcMeta?.references ?? null,
    },
  };

  await deliverTask({ busRoot, meta, body: digestBody });

  return forwardedId;
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
    },
  });

  const rosterInfo = await loadRoster({ repoRoot, rosterPath: values.roster });
  const roster = rosterInfo.roster;

  const busRoot = resolveBusRoot({ busRoot: values['bus-root'], repoRoot });
  await ensureBusRoot(busRoot, roster);

  const agentName = (values.agent?.trim() || roster.orchestratorName || 'daddy-orchestrator').trim();
  const pollMs = values['poll-ms'] ? Math.max(50, Number(values['poll-ms'])) : 400;

  while (true) {
    const idsNew = await listInboxTaskIds({ busRoot, agentName, state: 'new' });
    const idsSeen = await listInboxTaskIds({ busRoot, agentName, state: 'seen' });
    const ids = Array.from(new Set([...idsNew, ...idsSeen]));
    for (const id of ids) {
      let opened = null;
      try {
        opened = await openTask({ busRoot, agentName, taskId: id, markSeen: true });
      } catch (err) {
        process.stderr.write(`WARN: orchestrator could not open ${id}: ${(err && err.message) || String(err)}\n`);
        continue;
      }

      const srcMeta = opened.meta;
      const kind = srcMeta?.signals?.kind ?? 'UNKNOWN';
      const completedTaskKind = srcMeta?.signals?.completedTaskKind ?? null;

      let receipt = null;
      if (srcMeta?.references?.receiptPath && typeof srcMeta.references.receiptPath === 'string') {
        const rel = srcMeta.references.receiptPath;
        // Determine agent folder for receipt: for TASK_COMPLETE, it's the fromAgent
        const fromAgent = srcMeta.from;
        const completedId = srcMeta?.signals?.completedTaskId ?? null;
        if (completedId) {
          try {
            receipt = await readReceipt({ busRoot, agentName: fromAgent, taskId: completedId });
          } catch {
            // fallback: try path directly if it was absolute/relative to busRoot
            try {
              const abs = path.isAbsolute(rel) ? rel : path.join(busRoot, rel);
              const raw = await (await import('node:fs/promises')).readFile(abs, 'utf8');
              receipt = JSON.parse(raw);
            } catch {
              receipt = null;
            }
          }
        }
      }

      const action = nextActionFor({ sourceKind: kind, receipt, completedTaskKind });
      const bodySuffix = opened.body?.trim() ? `\n--- source packet body ---\n${opened.body.trimEnd()}\n` : '';
      const digestBody = `${buildDigest({ kind, srcMeta, receipt })}\nnextAction: ${action}\n${bodySuffix}`;

      try {
        await forwardToDaddy({
          busRoot,
          roster,
          fromAgent: srcMeta.from,
          srcMeta,
          receipt,
          digestBody,
        });

        if (values['tmux-notify']) {
          tmuxNotify(`Orchestrator: forwarded ${kind} from ${srcMeta.from} (${id})`, values['tmux-target'] ?? null);
        }
      } catch (err) {
        process.stderr.write(`ERROR: failed to forward ${id} to daddy: ${(err && err.stack) || String(err)}\n`);
      } finally {
        // Close the orchestrator packet without generating a new TASK_COMPLETE (avoid recursion).
        try {
          await closeTask({
            busRoot,
            roster,
            agentName,
            taskId: id,
            outcome: 'done',
            note: `forwarded ${kind} from ${srcMeta.from} to daddy`,
            commitSha: '',
            receiptExtra: {},
            notifyOrchestrator: false,
          });
        } catch (err) {
          process.stderr.write(`WARN: failed to close orchestrator task ${id}: ${(err && err.message) || String(err)}\n`);
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
