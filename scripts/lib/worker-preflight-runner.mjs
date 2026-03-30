import {
  buildPreflightTaskFingerprint,
  buildPreflightTurnPrompt,
  captureTrackedSnapshot,
  normalizePreflightPlan,
  validatePreflightExecutionUnlock,
  validatePreflightSubmission,
} from './worker-preflight.mjs';
import { runPreflightCodexTurn } from './worker-preflight-turn.mjs';

export async function runWriterPreflightPhase({
  fs,
  outputPath,
  agentName,
  taskId,
  taskCwd,
  repoRoot,
  schemaPath,
  codexBin,
  guardEnv,
  codexHomeEnv,
  autopilotDangerFullAccess,
  openedPath,
  openedMeta,
  taskMarkdown,
  taskStatMtimeMs,
  taskKindNow,
  taskPhase,
  taskTitle,
  preflightBaseHead,
  preflightWorkBranch,
  isAutopilot,
  skillsSelected,
  includeSkills,
  contextBlock,
  preflightRetryReason,
  seedPlan,
  resumeSessionId,
  lastCodexThreadId,
  busRoot,
  roster,
  writePane,
  runCodexAppServer,
  writeTaskSession,
  firstPreflightReasonCode,
  createTurnError,
}) {
  let approvedPlan = null;
  let approvedPlanHash = '';
  let approvedTaskFingerprint = '';
  let approvedTrackedSnapshot = null;
  let retryReason = preflightRetryReason || '';
  let gateEvidence = { required: true, approved: false, noWritePass: null, planHash: null, driftDetected: false, reasonCode: null };
  let nextResumeSessionId = resumeSessionId || null;
  let nextLastCodexThreadId = lastCodexThreadId || null;
  let workingSeedPlan = seedPlan;
  let lastPreflightThreadId = resumeSessionId || null;

  for (let preflightAttempt = 1; preflightAttempt <= 3; preflightAttempt += 1) {
    const trackedSnapshot = captureTrackedSnapshot({ cwd: taskCwd });
    const taskFingerprint = buildPreflightTaskFingerprint({
      taskKind: taskKindNow,
      taskPhase,
      taskTitle,
      taskBody: taskMarkdown,
      taskMeta: openedMeta,
      baseHead: preflightBaseHead,
      workBranch: preflightWorkBranch,
    });
    const preflightPrompt = buildPreflightTurnPrompt({
      agentName,
      skillsSelected,
      includeSkills,
      taskKind: taskKindNow,
      isAutopilot,
      contextBlock,
      taskMarkdown,
      retryReason,
      seedPlan: workingSeedPlan,
    });
    const preflightTurn = await runPreflightCodexTurn({
      fs,
      outputPath,
      agentName,
      taskId,
      busRoot,
      writePane,
      writeTaskSession,
      runCodexAppServer,
      createTurnError,
      logLine: `[worker] ${agentName} preflight attempt=${preflightAttempt}${lastPreflightThreadId ? ` resume=${lastPreflightThreadId}` : ''}\n`,
      label: 'preflight',
      prompt: preflightPrompt,
      codexBin,
      repoRoot,
      taskCwd,
      schemaPath,
      guardEnv,
      codexHomeEnv,
      autopilotDangerFullAccess,
      openedPath,
      taskStatMtimeMs,
      resumeSessionId: lastPreflightThreadId,
    });
    lastPreflightThreadId = preflightTurn.resumeSessionId;
    nextResumeSessionId = preflightTurn.resumeSessionId;
    nextLastCodexThreadId = preflightTurn.lastCodexThreadId;

    const submission = validatePreflightSubmission({
      preflightPlan: preflightTurn.parsed?.preflightPlan,
      taskKind: taskKindNow,
      taskPhase,
      taskTitle,
      taskBody: taskMarkdown,
      baseHead: preflightBaseHead,
      workBranch: preflightWorkBranch,
    });
    if (!submission.ok) {
      gateEvidence.reasonCode = firstPreflightReasonCode(submission.errors) || 'submission_invalid';
      retryReason = submission.errors.join('; ');
      workingSeedPlan = normalizePreflightPlan(preflightTurn.parsed?.preflightPlan) || workingSeedPlan;
      if (preflightAttempt < 3) continue;
      throw createTurnError(`preflight submission failed: ${submission.errors.join('; ')}`, {
        exitCode: 1, stderrTail: submission.errors.join('; '), stdoutTail: preflightTurn.raw.slice(-16_000), threadId: preflightTurn.threadId || null,
      });
    }

    let candidatePlan = submission.normalizedPlan;
    let candidatePlanHash = submission.planHash;

    const unlockValidation = await validatePreflightExecutionUnlock({
      repoRoot: taskCwd,
      approvedPlan: candidatePlan,
      trackedSnapshot,
      baseRef: preflightBaseHead,
    });
    if (!unlockValidation.ok) {
      const mutationDetected = unlockValidation.errors.includes('unlock_preflight_mutation_detected');
      gateEvidence.noWritePass = unlockValidation.evidence?.noWritePass ?? null;
      gateEvidence.reasonCode = firstPreflightReasonCode(unlockValidation.errors) || 'unlock_failed';
      retryReason = unlockValidation.errors.join('; ');
      workingSeedPlan = candidatePlan;
      if (!mutationDetected && preflightAttempt < 3) continue;
      throw createTurnError(`preflight execution unlock failed: ${unlockValidation.errors.join('; ')}`, {
        exitCode: 1, stderrTail: unlockValidation.errors.join('; '), stdoutTail: JSON.stringify(candidatePlan), threadId: lastPreflightThreadId || null,
      });
    }

    approvedPlan = candidatePlan;
    approvedPlanHash = candidatePlanHash;
    approvedTaskFingerprint = taskFingerprint;
    approvedTrackedSnapshot = trackedSnapshot;
    gateEvidence = {
      required: true, approved: true, noWritePass: unlockValidation.evidence?.noWritePass ?? true,
      planHash: candidatePlanHash, driftDetected: false, reasonCode: null,
    };
    const persistedTaskSessionPath = await writeTaskSession({
      busRoot,
      agentName,
      taskId,
      threadId: lastPreflightThreadId || nextResumeSessionId || nextLastCodexThreadId || '',
      extra: {
        preflight: {
          approvedPlan: candidatePlan,
          planHash: candidatePlanHash,
          taskFingerprint,
          trackedSnapshot,
        },
      },
    });
    if (!persistedTaskSessionPath) {
      writePane(`[worker] ${agentName} warning: approved preflight session state not persisted (missing threadId)\n`);
    }
    retryReason = '';
    break;
  }

  return {
    approvedPlan, approvedPlanHash, preflightRetryReason: retryReason,
    approvedTaskFingerprint,
    approvedTrackedSnapshot,
    preflightGateEvidence: gateEvidence, resumeSessionId: nextResumeSessionId, lastCodexThreadId: nextLastCodexThreadId,
  };
}
