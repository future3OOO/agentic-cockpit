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

import childProcess from 'node:child_process';
import path from 'node:path';
import { parseWorkerCliValues } from './lib/worker-cli.mjs';
import {
  getRepoRoot,
  loadRoster,
  resolveBusRoot,
  ensureBusRoot,
  listInboxTasks,
  listInboxTaskIds,
  openTask,
  updateTask,
  closeTask,
  readReceipt,
  pickDaddyChatName,
  pickAutopilotName,
  makeId,
  deliverTask,
} from './lib/agentbus.mjs';

/**
 * Pauses execution for the requested number of milliseconds.
 */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Returns whether truthy env.
 */
function isTruthyEnv(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/**
 * Helper for trim to one line used by the cockpit workflow runtime.
 */
function trimToOneLine(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Helper for truncate text used by the cockpit workflow runtime.
 */
function truncateText(value, { maxLen }) {
  const s = String(value ?? '');
  const max = Math.max(1, Number(maxLen) || 1);
  if (s.length <= max) return s;
  return `${s.slice(0, max).trimEnd()}…`;
}

/**
 * Helper for safe id prefix used by the cockpit workflow runtime.
 */
function safeIdPrefix(value, fallback = 'orch_src') {
  const raw = String(value ?? '').trim();
  if (!raw) return fallback;
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^[_-]+/, '').slice(0, 80);
  return cleaned || fallback;
}

/**
 * Helper for parsing non-negative integers from metadata/env values.
 */
function parseNonNegativeInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < 0) return fallback;
  return Math.floor(n);
}

/**
 * Helper for tmux notify used by the cockpit workflow runtime.
 */
function tmuxNotify(message, target = null) {
  try {
    const args = target ? ['display-message', '-t', target, message] : ['display-message', message];
    childProcess.execFileSync('tmux', args, { stdio: 'ignore' });
  } catch {
    // ignore
  }
}

/**
 * Builds digest verbose used by workflow automation.
 */
function buildDigestVerbose({ kind, srcMeta, receipt }) {
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

/**
 * Builds digest compact used by workflow automation.
 */
function buildDigestCompact({ kind, srcMeta, receipt }) {
  const lines = [];
  const completedTaskId = srcMeta?.signals?.completedTaskId ?? null;
  const completedTaskKind = srcMeta?.signals?.completedTaskKind ?? null;
  const rootId = srcMeta?.signals?.rootId ?? null;

  lines.push(`kind: ${kind}`);
  lines.push(`from: ${srcMeta.from}`);
  if (srcMeta?.title) lines.push(`title: ${truncateText(trimToOneLine(srcMeta.title), { maxLen: 200 })}`);
  if (completedTaskId) lines.push(`task: ${completedTaskId}`);
  if (completedTaskKind) lines.push(`taskKind: ${completedTaskKind}`);
  if (rootId) lines.push(`rootId: ${rootId}`);
  if (receipt?.outcome) lines.push(`outcome: ${receipt.outcome}`);
  if (receipt?.commitSha) lines.push(`commitSha: ${receipt.commitSha}`);
  if (receipt?.note) lines.push(`note: ${truncateText(trimToOneLine(receipt.note), { maxLen: 800 })}`);

  const receiptPath = srcMeta?.references?.receiptPath ?? null;
  const processedPath = srcMeta?.references?.processedPath ?? null;
  if (receiptPath) lines.push(`receiptPath: ${receiptPath}`);
  if (processedPath) lines.push(`processedPath: ${processedPath}`);

  const extra = receipt?.receiptExtra ?? {};
  if (extra?.planMarkdown) lines.push(`planMarkdown: present (see receiptExtra.planMarkdown in receipt)`);

  return lines.join('\n') + '\n';
}

/**
 * Helper for next action for used by the cockpit workflow runtime.
 */
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
    if (receipt.commitSha) return 'Autopilot: run built-in /review on commitSha, then proceed (follow-ups/integrate/closeout).';
    return 'Autopilot: review receipt details and decide next steps.';
  }

  if (receipt.outcome === 'needs_review') return 'Autopilot: human review required; decide whether to re-run gates or revise.';
  if (receipt.outcome === 'blocked') return 'Autopilot: unblock (missing env, unclear spec, or external dependency).';
  if (receipt.outcome === 'failed') return 'Autopilot: triage failure; dispatch a fix task.';
  return 'Autopilot: review and act.';
}

/**
 * Builds review gate signals used by workflow automation.
 */
function buildReviewGateSignals({ kind, completedTaskKind, srcMeta, receipt, repoRoot }) {
  const sourceTaskId = srcMeta?.signals?.completedTaskId ?? srcMeta?.id ?? null;
  const sourceAgent = srcMeta?.from ?? null;
  const sourceKind = completedTaskKind || null;
  const commitSha = trimToOneLine(receipt?.commitSha ?? srcMeta?.references?.commitSha ?? null);
  const receiptPath = srcMeta?.references?.receiptPath ?? null;
  const receiptOutcome = trimToOneLine(receipt?.outcome).toLowerCase();

  // Review-gate only applies to successful EXECUTE completions that produced a reviewable commit.
  const reviewRequired =
    kind === 'TASK_COMPLETE' &&
    completedTaskKind === 'EXECUTE' &&
    receiptOutcome === 'done' &&
    Boolean(commitSha);
  if (!reviewRequired) {
    return {
      reviewRequired: false,
      reviewTarget: null,
      reviewPolicy: null,
    };
  }

  return {
    reviewRequired: true,
    reviewTarget: {
      sourceTaskId,
      sourceAgent,
      sourceKind,
      commitSha,
      receiptPath,
      receiptOutcome,
      repoRoot: repoRoot || null,
    },
    reviewPolicy: {
      mode: 'codex_builtin_review',
      mustUseBuiltInReview: true,
      requireEvidence: true,
      maxReviewRetries: 1,
    },
  };
}

/**
 * Finds an existing orchestrator update task for coalescing observer review packets.
 */
async function findCoalescibleObserverDigestTaskId({
  busRoot,
  targetAgent,
  sourceKind,
  rootId,
  sourceAgent,
}) {
  if (sourceKind !== 'REVIEW_ACTION_REQUIRED') return null;
  if (sourceAgent !== 'observer:pr') return null;
  const root = trimToOneLine(rootId);
  if (!root) return null;

  for (const state of ['in_progress', 'seen', 'new']) {
    const items = await listInboxTasks({ busRoot, agentName: targetAgent, state, limit: 200 });
    let best = null;
    for (const item of items) {
      const meta = item?.meta ?? {};
      if (meta?.from !== 'daddy-orchestrator') continue;
      if (meta?.signals?.kind !== 'ORCHESTRATOR_UPDATE') continue;
      if (meta?.signals?.sourceKind !== sourceKind) continue;
      if (trimToOneLine(meta?.signals?.rootId) !== root) continue;
      if (trimToOneLine(meta?.references?.sourceAgent) !== sourceAgent) continue;
      if (!best || item.mtimeMs > best.mtimeMs) best = item;
    }
    if (best) return best.taskId;
  }

  return null;
}

/**
 * Helper for forward digests used by the cockpit workflow runtime.
 */
async function forwardDigests({ busRoot, roster, fromAgent, srcMeta, receipt, digestCompact, digestVerbose, repoRoot }) {
  const daddyName = pickDaddyChatName(roster);
  const autopilotName = pickAutopilotName(roster);
  const kind = srcMeta?.signals?.kind ?? 'ORCHESTRATOR_EVENT';
  const completedTaskKind = srcMeta?.signals?.completedTaskKind ?? null;
  const receiptOutcome = trimToOneLine(receipt?.outcome ?? '').toLowerCase();
  const reviewGate = buildReviewGateSignals({ kind, completedTaskKind, srcMeta, receipt, repoRoot });

  // Default behavior:
  // - Send a compact digest to autopilot (controller) so follow-ups can be dispatched cheaply.
  // - Daddy forwarding is optional and disabled by default (human mailbox only, not automation-critical).
  //   Operators can enable it when they want asynchronous visibility in the inbox pane.
  //
  // We suppress forwarding of ORCHESTRATOR_UPDATE completions to autopilot to avoid feedback loops.
  // Exception: allow one controlled self-remediation forward when autopilot itself closed an
  // ORCHESTRATOR_UPDATE as non-done (needs_review/blocked/failed).
  const forwardToDaddyEnabled = isTruthyEnv(
    process.env.AGENTIC_ORCH_FORWARD_TO_DADDY ?? process.env.VALUA_ORCH_FORWARD_TO_DADDY ?? '0',
  );
  const daddyDigestMode = String(
    process.env.AGENTIC_ORCH_DADDY_DIGEST_MODE ?? process.env.VALUA_ORCH_DADDY_DIGEST_MODE ?? 'compact',
  )
    .trim()
    .toLowerCase();
  const autopilotDigestMode = String(
    process.env.AGENTIC_ORCH_AUTOPILOT_DIGEST_MODE ??
      process.env.VALUA_ORCH_AUTOPILOT_DIGEST_MODE ??
      'compact',
  )
    .trim()
    .toLowerCase();

  const isTaskComplete = kind === 'TASK_COMPLETE';
  const isOrchestratorUpdateCompletion = isTaskComplete && completedTaskKind === 'ORCHESTRATOR_UPDATE';
  const nonDoneSelfRemediationOutcome =
    receiptOutcome === 'needs_review' || receiptOutcome === 'blocked' || receiptOutcome === 'failed';
  const maxSelfRemediationDepth = parseNonNegativeInt(
    process.env.AGENTIC_ORCH_AUTOPILOT_SELF_REMEDIATION_MAX_DEPTH ??
      process.env.VALUA_ORCH_AUTOPILOT_SELF_REMEDIATION_MAX_DEPTH ??
      '1',
    1,
  );
  const sourceSelfRemediationDepth = parseNonNegativeInt(srcMeta?.references?.orchestratorSelfRemediateDepth, 0);
  const priorSelfRemediationDepth = Math.max(
    sourceSelfRemediationDepth,
    parseNonNegativeInt(receipt?.task?.references?.orchestratorSelfRemediateDepth, 0),
  );
  const allowAutopilotSelfRemediationForward =
    Boolean(autopilotName) &&
    autopilotName !== daddyName &&
    fromAgent === autopilotName &&
    isOrchestratorUpdateCompletion &&
    nonDoneSelfRemediationOutcome &&
    priorSelfRemediationDepth < maxSelfRemediationDepth;

  const shouldForwardToAutopilot =
    allowAutopilotSelfRemediationForward ||
    (Boolean(autopilotName) &&
      autopilotName !== daddyName &&
      fromAgent !== autopilotName &&
      // Avoid loops: don't forward completions of ORCHESTRATOR_UPDATE back to the controller.
      //
      // Note: `completedTaskKind` can be null for older/manual packets; treat those as forwardable
      // rather than silently dropping follow-up opportunities.
      (!isTaskComplete || !isOrchestratorUpdateCompletion));

  const forwardedIds = [];
  const errors = [];

  const titleBase = `[orchestrator] ${kind} from ${fromAgent}: ${srcMeta?.title ?? srcMeta?.signals?.completedTaskId ?? ''}`.trim();
  const rootIdValue = srcMeta?.signals?.rootId ?? srcMeta?.signals?.completedTaskId ?? srcMeta?.id ?? null;
  const parentIdValue = srcMeta?.signals?.parentId ?? null;
  const propagatedSelfRemediationDepth = allowAutopilotSelfRemediationForward
    ? priorSelfRemediationDepth + 1
    : sourceSelfRemediationDepth;

  /** @type {Array<{ to: string[], title: string, body: string }>} */
  const targets = [];
  if (forwardToDaddyEnabled && daddyName) {
    const daddyBody = daddyDigestMode === 'compact' ? digestCompact : digestVerbose;
    targets.push({ to: [daddyName], title: titleBase, body: daddyBody });
  }
  if (shouldForwardToAutopilot && autopilotName) {
    const apBody = autopilotDigestMode === 'verbose' ? digestVerbose : digestCompact;
    targets.push({ to: [autopilotName], title: titleBase, body: apBody });
  }

  for (const t of targets) {
    try {
      const targetAgent = t.to[0];
      const coalescedTaskId = targetAgent
        ? await findCoalescibleObserverDigestTaskId({
            busRoot,
            targetAgent,
            sourceKind: kind,
            rootId: rootIdValue,
            sourceAgent: fromAgent,
          })
        : null;

      if (coalescedTaskId && targetAgent) {
        const sourceTaskId = srcMeta?.signals?.completedTaskId ?? srcMeta?.id ?? null;
        const sourceTitle = srcMeta?.title ? trimToOneLine(srcMeta.title) : null;
        const updateLines = [
          '[coalesced orchestrator digest]',
          sourceTaskId ? `- sourceTaskId: ${sourceTaskId}` : null,
          sourceTitle ? `- sourceTitle: ${sourceTitle}` : null,
          srcMeta?.references?.receiptPath ? `- sourceReceiptPath: ${srcMeta.references.receiptPath}` : null,
          '',
          t.body,
        ].filter(Boolean);

        const referencesPatch = {
          sourceAgent: fromAgent,
          sourceTaskId,
          completedTaskKind,
          receiptPath: srcMeta?.references?.receiptPath ?? null,
          processedPath: srcMeta?.references?.processedPath ?? null,
          receiptOutcome: receipt?.outcome ?? null,
          commitSha: receipt?.commitSha ?? srcMeta?.references?.commitSha ?? null,
          ...(propagatedSelfRemediationDepth > 0
            ? { orchestratorSelfRemediateDepth: propagatedSelfRemediationDepth }
            : {}),
          sourceReferences: srcMeta?.references ?? null,
        };

        await updateTask({
          busRoot,
          agentName: targetAgent,
          taskId: coalescedTaskId,
          updateFrom: 'daddy-orchestrator',
          appendBody: updateLines.join('\n'),
          signalsPatch: {
            phase: srcMeta?.signals?.phase ?? null,
            smoke: Boolean(srcMeta?.signals?.smoke),
            reviewRequired: reviewGate.reviewRequired,
            reviewTarget: reviewGate.reviewTarget,
            reviewPolicy: reviewGate.reviewPolicy,
            rootId: rootIdValue,
            parentId: parentIdValue,
            sourceKind: kind,
          },
          referencesPatch,
        });
        forwardedIds.push(coalescedTaskId);
        continue;
      }

      const forwardedId = makeId(`orch_${safeIdPrefix(fromAgent)}`);
      const meta = {
        id: forwardedId,
        to: t.to,
        from: 'daddy-orchestrator',
        priority: srcMeta?.priority ?? 'P2',
        title: t.title,
        signals: {
          kind: 'ORCHESTRATOR_UPDATE',
          sourceKind: kind,
          reviewRequired: reviewGate.reviewRequired,
          reviewTarget: reviewGate.reviewTarget,
          reviewPolicy: reviewGate.reviewPolicy,
          rootId: rootIdValue,
          parentId: parentIdValue,
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
          receiptOutcome: receipt?.outcome ?? null,
          commitSha: receipt?.commitSha ?? srcMeta?.references?.commitSha ?? null,
          ...(propagatedSelfRemediationDepth > 0
            ? { orchestratorSelfRemediateDepth: propagatedSelfRemediationDepth }
            : {}),
          sourceReferences: srcMeta?.references ?? null,
        },
      };

      await deliverTask({ busRoot, meta, body: t.body });
      forwardedIds.push(forwardedId);
    } catch (err) {
      errors.push((err && err.message) || String(err));
    }
  }

  return { forwardedIds, errors };
}

/**
 * CLI entrypoint for this script.
 */
async function main() {
  const repoRoot = getRepoRoot();
  const values = parseWorkerCliValues();

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
      const digestCompact = `${buildDigestCompact({ kind, srcMeta, receipt })}\nnextAction: ${action}\n`;
      const digestVerbose = `${buildDigestVerbose({ kind, srcMeta, receipt })}\nnextAction: ${action}\n${bodySuffix}`;

      let forward = { forwardedIds: [], errors: [] };
      try {
        forward = await forwardDigests({
          busRoot,
          roster,
          fromAgent: srcMeta.from,
          srcMeta,
          receipt,
          digestCompact,
          digestVerbose,
          repoRoot,
        });

        if (forward.errors.length) {
          process.stderr.write(
            `WARN: orchestrator digest forwarding errors for ${id}: ${forward.errors.join('; ')}\n`,
          );
        }

        if (values['tmux-notify']) {
          tmuxNotify(
            `Orchestrator: forwarded ${kind} from ${srcMeta.from} (${id})` +
              (forward.errors.length ? ` (errors=${forward.errors.length})` : ''),
            values['tmux-target'] ?? null,
          );
        }
      } catch (err) {
        forward.errors.push((err && err.message) || String(err));
        process.stderr.write(`ERROR: failed to forward ${id}: ${(err && err.stack) || String(err)}\n`);
      } finally {
        // Close the orchestrator packet without generating a new TASK_COMPLETE (avoid recursion).
        try {
          await closeTask({
            busRoot,
            roster,
            agentName,
            taskId: id,
            outcome: forward.errors.length ? 'needs_review' : 'done',
            note: forward.errors.length
              ? `digest forwarding errors (forwarded=${forward.forwardedIds.length} failed=${forward.errors.length})`
              : `forwarded ${kind} from ${srcMeta.from}`,
            commitSha: '',
            receiptExtra: {
              forwardedIds: forward.forwardedIds,
              forwardingErrors: forward.errors,
            },
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
