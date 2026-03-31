import { readStringField } from './worker-code-quality-state.mjs';
import { buildOpusConsultAdvice, formatOpusCodeSuggestion } from './worker-opus-advice.mjs';
import { normalizePreflightPlan } from './worker-preflight-submission.mjs';

function normalizeStrings(value, { maxItems = 24, maxLength = 800 } = {}) {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((entry) => readStringField(entry).slice(0, maxLength))
        .filter(Boolean),
    ),
  ).slice(0, maxItems);
}

function buildNoRevisionResult(approvedPlan) {
  return {
    needsRevision: false,
    requiredQuestions: [],
    seedPlan: normalizePreflightPlan(approvedPlan),
    retryReason: '',
  };
}

export function buildPreExecConsultCandidateOutput({
  approvedPlan,
  approvedPlanHash,
}) {
  const normalizedPlan = normalizePreflightPlan(approvedPlan);
  const touchpoints = Array.isArray(normalizedPlan?.touchpoints) ? normalizedPlan.touchpoints : [];
  return {
    outcome: 'done',
    note:
      touchpoints.length > 0
        ? `Approved writer preflight pending Opus challenge for ${touchpoints.join(', ')}`
        : 'Approved writer preflight pending Opus challenge.',
    commitSha: '',
    followUps: [],
    preflightPlan: normalizedPlan,
    runtimeGuard: {
      preflightGate: {
        required: true,
        approved: true,
        noWritePass: true,
        planHash: readStringField(approvedPlanHash) || null,
        driftDetected: false,
        reasonCode: null,
      },
    },
  };
}

export function derivePreExecConsultRevision({
  approvedPlan,
  phaseResult,
}) {
  if (phaseResult?.ok !== true) {
    return buildNoRevisionResult(approvedPlan);
  }
  const response =
    phaseResult?.finalResponse && typeof phaseResult.finalResponse === 'object'
      ? phaseResult.finalResponse
      : null;
  if (!response) {
    return buildNoRevisionResult(approvedPlan);
  }

  const requiredQuestions = normalizeStrings([
    ...(Array.isArray(response?.required_questions) ? response.required_questions : []),
    ...(Array.isArray(response?.unresolved_critical_questions)
      ? response.unresolved_critical_questions
      : []),
  ]);
  const requiredActions = normalizeStrings(response?.required_actions, { maxLength: 400 });
  const challengePoints = normalizeStrings(response?.challenge_points, { maxLength: 400 });
  const suggestedPlan = normalizeStrings(response?.suggested_plan, { maxLength: 400 });
  const codeSuggestions = normalizeStrings(response?.code_suggestions?.map(formatOpusCodeSuggestion) || [], {
    maxLength: 400,
  });
  const verdict = readStringField(response?.verdict).toLowerCase();
  const reasonCode = readStringField(phaseResult?.reasonCode || response?.reasonCode);
  const rationale = readStringField(response?.rationale || phaseResult?.note);
  const hasSubstantiveFeedback = Boolean(
    requiredQuestions.length ||
      requiredActions.length ||
      challengePoints.length ||
      suggestedPlan.length ||
      codeSuggestions.length
  );
  const needsRevision = hasSubstantiveFeedback;
  if (!needsRevision) {
    return {
      ...buildNoRevisionResult(approvedPlan),
      requiredQuestions,
    };
  }

  const mergedPlan = normalizePreflightPlan({
    ...approvedPlan,
    openQuestions: [
      ...(Array.isArray(approvedPlan?.openQuestions) ? approvedPlan.openQuestions : []),
      ...requiredQuestions,
    ],
  });
  const retryLines = [];
  const header = readStringField(reasonCode || verdict || 'opus_consult_feedback');
  if (rationale) {
    retryLines.push(`OPUS pre-exec consult feedback (${header}): ${rationale}`);
  } else {
    retryLines.push(`OPUS pre-exec consult feedback (${header}) must be addressed before execution.`);
  }
  if (requiredQuestions.length) {
    retryLines.push(`Resolve required questions before execution: ${requiredQuestions.join(' | ')}`);
  }
  if (requiredActions.length) {
    retryLines.push(`Required actions: ${requiredActions.join(' | ')}`);
  }
  if (challengePoints.length) {
    retryLines.push(`Challenge points: ${challengePoints.join(' | ')}`);
  }
  if (codeSuggestions.length) {
    retryLines.push(`Code suggestions to account for: ${codeSuggestions.join(' | ')}`);
  }
  if (suggestedPlan.length) {
    retryLines.push(`Suggested plan updates: ${suggestedPlan.join(' | ')}`);
  }

  return {
    needsRevision: true,
    requiredQuestions,
    seedPlan: mergedPlan,
    retryReason: retryLines.join('\n'),
  };
}

function buildDefaultPreExecDecision(phaseResult) {
  return phaseResult?.decision ?? {
    acceptedSuggestions: [],
    rejectedSuggestions: [],
    rejectionRationale: '',
  };
}

function buildPreExecGateEvidence({ gate, phaseResult, status }) {
  return {
    enabled: true,
    required: true,
    phase: 'pre_exec',
    consultAgent: gate.consultAgent,
    consultMode: readStringField(gate?.consultMode) || 'advisory',
    protocolMode:
      readStringField(phaseResult?.protocolMode) ||
      readStringField(gate?.protocolMode) ||
      'freeform_only',
    consultId: readStringField(phaseResult?.consultId) || null,
    roundsUsed: Number(phaseResult?.roundsUsed) || 0,
    verdict: readStringField(phaseResult?.finalResponse?.verdict) || null,
    reasonCode: readStringField(phaseResult?.reasonCode) || null,
    status,
  };
}

export async function runApprovedPreExecConsultPhase({
  approvedPlan,
  approvedPlanHash,
  preExecConsultCached,
  gate,
  busRoot,
  roster,
  agentName,
  openedMeta,
  taskMarkdown,
  taskKind,
  existingConsultAdvice,
  runOpusConsultPhase,
  runWriterPreflightPhase,
  writerPreflightArgs,
}) {
  const consultMode = readStringField(gate?.consultMode) || 'advisory';
  const barrier = {
    locked: false,
    consultId: '',
    roundsUsed: 0,
    unlockReason: '',
  };
  let phaseResult = preExecConsultCached;
  if (!phaseResult) {
    phaseResult = await runOpusConsultPhase({
      busRoot,
      roster,
      agentName,
      openedMeta,
      taskMarkdown,
      taskKind,
      gate,
      phase: 'pre_exec',
      candidateOutput: buildPreExecConsultCandidateOutput({
        approvedPlan,
        approvedPlanHash,
      }),
    });
  }
  barrier.consultId = readStringField(phaseResult?.consultId);
  barrier.roundsUsed = Number(phaseResult?.roundsUsed) || 0;

  const verdict = readStringField(phaseResult?.finalResponse?.verdict).toLowerCase();
  const consultStatus = !phaseResult?.ok || verdict === 'warn' || verdict === 'block' ? 'warn' : 'pass';
  const consultAdvice = {
    ...(existingConsultAdvice && typeof existingConsultAdvice === 'object' ? existingConsultAdvice : {}),
    mode: consultMode,
    preExec: buildOpusConsultAdvice({
      mode: consultMode,
      phaseResult,
      phase: 'pre_exec',
    }),
  };
  let nextApprovedPlan = approvedPlan;
  let nextApprovedPlanHash = approvedPlanHash;
  let nextPreflightRetryReason = writerPreflightArgs.preflightRetryReason || '';
  let nextPreflightGateEvidence = writerPreflightArgs.preflightGateEvidence || null;
  let nextResumeSessionId = writerPreflightArgs.resumeSessionId;
  let nextLastCodexThreadId = writerPreflightArgs.lastCodexThreadId;
  const consultRevision = derivePreExecConsultRevision({
    approvedPlan,
    phaseResult,
  });
  if (consultRevision.needsRevision) {
    const revisedPreflightPhase = await runWriterPreflightPhase({
      ...writerPreflightArgs,
      preflightRetryReason: consultRevision.retryReason,
      seedPlan: consultRevision.seedPlan,
    });
    nextApprovedPlan = revisedPreflightPhase.approvedPlan;
    nextApprovedPlanHash = revisedPreflightPhase.approvedPlanHash;
    nextPreflightRetryReason = revisedPreflightPhase.preflightRetryReason;
    nextPreflightGateEvidence = revisedPreflightPhase.preflightGateEvidence;
    nextResumeSessionId = revisedPreflightPhase.resumeSessionId;
    nextLastCodexThreadId = revisedPreflightPhase.lastCodexThreadId;
    barrier.unlockReason = 'opus_pre_exec_consult_revised_preflight';
  } else if (!phaseResult?.ok) {
    const reasonCode = readStringField(phaseResult?.reasonCode) || 'opus_transient';
    barrier.unlockReason = `pre_exec_fail_open:${reasonCode}`;
  } else if (consultStatus === 'warn') {
    barrier.unlockReason = 'opus_pre_exec_consult_warn_non_blocking';
  }
  if (!barrier.unlockReason) {
    barrier.unlockReason = 'opus_pre_exec_consult_finalized';
  }

  return {
    phaseResult,
    barrier,
    transcript: {
      consulted: true,
      ...phaseResult,
    },
    gateEvidence: buildPreExecGateEvidence({
      gate,
      phaseResult,
      status: consultStatus,
    }),
    preExecDecision: buildDefaultPreExecDecision(phaseResult),
    consultAdvice,
    approvedPlan: nextApprovedPlan,
    approvedPlanHash: nextApprovedPlanHash,
    preflightRetryReason: nextPreflightRetryReason,
    preflightGateEvidence: nextPreflightGateEvidence,
    resumeSessionId: nextResumeSessionId,
    lastCodexThreadId: nextLastCodexThreadId,
  };
}
