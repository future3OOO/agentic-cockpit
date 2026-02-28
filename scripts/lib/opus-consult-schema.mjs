const OPUS_PHASES = new Set(['pre_exec', 'post_review']);
const OPUS_VERDICTS = new Set(['pass', 'warn', 'block']);
const OPUS_CHANGE_TYPES = new Set(['edit', 'add', 'delete', 'refactor', 'test']);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function readNullableString(value) {
  if (value == null) return null;
  const s = readString(value);
  return s || null;
}

function readInteger(value, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  if (i < min || i > max) return null;
  return i;
}

function normalizeStringArray(value, { maxItems = 24, maxLen = 1000 } = {}) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, maxItems)
    .map((entry) => readString(entry).slice(0, maxLen))
    .filter(Boolean);
}

function validateConsultId(value) {
  const id = readString(value);
  if (!id) return '';
  if (id.length > 160) return '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(id)) return '';
  return id;
}

function makeResult(errors, value) {
  return {
    ok: errors.length === 0,
    errors,
    value,
  };
}

function validateCommonSignals(meta, expectedKind, errors) {
  const signals = isPlainObject(meta?.signals) ? meta.signals : {};
  const kind = readString(signals.kind);
  if (kind !== expectedKind) {
    errors.push(`signals.kind must be ${expectedKind}`);
  }
  const phase = readString(signals.phase);
  if (!OPUS_PHASES.has(phase)) {
    errors.push('signals.phase must be pre_exec or post_review');
  }
  if (signals.notifyOrchestrator !== false) {
    errors.push('signals.notifyOrchestrator must be false');
  }
  return {
    kind,
    phase,
    rootId: readNullableString(signals.rootId),
    parentId: readNullableString(signals.parentId),
    smoke: Boolean(signals.smoke),
  };
}

export function extractOpusPayload(meta) {
  const references = isPlainObject(meta?.references) ? meta.references : {};
  return isPlainObject(references.opus) ? references.opus : null;
}

export function validateOpusConsultRequestPayload(payload) {
  const errors = [];
  if (!isPlainObject(payload)) {
    return makeResult(['references.opus must be an object'], null);
  }

  const version = readString(payload.version);
  if (version !== 'v1') errors.push('version must be v1');

  const consultId = validateConsultId(payload.consultId);
  if (!consultId) errors.push('consultId missing/invalid');

  const round = readInteger(payload.round, { min: 1, max: 8 });
  if (round == null) errors.push('round must be integer 1..8');

  const maxRounds = readInteger(payload.maxRounds, { min: 1, max: 8 });
  if (maxRounds == null) errors.push('maxRounds must be integer 1..8');
  if (round != null && maxRounds != null && round > maxRounds) {
    errors.push('round cannot exceed maxRounds');
  }

  const mode = readString(payload.mode);
  if (!OPUS_PHASES.has(mode)) errors.push('mode must be pre_exec or post_review');

  const hypothesisRaw = isPlainObject(payload.autopilotHypothesis) ? payload.autopilotHypothesis : null;
  if (!hypothesisRaw) errors.push('autopilotHypothesis must be an object');
  const autopilotHypothesis = {
    summary: readString(hypothesisRaw?.summary).slice(0, 2000),
    intendedActions: normalizeStringArray(hypothesisRaw?.intendedActions, { maxItems: 24, maxLen: 500 }),
    proposedDispatches: [],
  };
  if (!autopilotHypothesis.summary) errors.push('autopilotHypothesis.summary is required');

  const proposedDispatchesRaw = Array.isArray(hypothesisRaw?.proposedDispatches)
    ? hypothesisRaw.proposedDispatches
    : [];
  for (let i = 0; i < Math.min(24, proposedDispatchesRaw.length); i += 1) {
    const item = proposedDispatchesRaw[i];
    if (!isPlainObject(item)) {
      errors.push(`autopilotHypothesis.proposedDispatches[${i}] must be object`);
      continue;
    }
    const to = normalizeStringArray(item.to, { maxItems: 8, maxLen: 120 });
    const kind = readString(item.kind).slice(0, 120);
    const phase = readString(item.phase).slice(0, 120);
    const title = readString(item.title).slice(0, 280);
    const reason = readString(item.reason).slice(0, 1200);
    if (!to.length) errors.push(`autopilotHypothesis.proposedDispatches[${i}].to is required`);
    if (!kind) errors.push(`autopilotHypothesis.proposedDispatches[${i}].kind is required`);
    if (!phase) errors.push(`autopilotHypothesis.proposedDispatches[${i}].phase is required`);
    if (!title) errors.push(`autopilotHypothesis.proposedDispatches[${i}].title is required`);
    if (!reason) errors.push(`autopilotHypothesis.proposedDispatches[${i}].reason is required`);
    autopilotHypothesis.proposedDispatches.push({ to, kind, phase, title, reason });
  }

  const autopilotMessage = readNullableString(payload.autopilotMessage);
  const priorRoundSummary = readNullableString(payload.priorRoundSummary);

  const taskContextRaw = isPlainObject(payload.taskContext) ? payload.taskContext : null;
  if (!taskContextRaw) errors.push('taskContext must be an object');
  const taskContext = {
    taskId: readString(taskContextRaw?.taskId).slice(0, 240),
    taskKind: readString(taskContextRaw?.taskKind).slice(0, 120),
    title: readString(taskContextRaw?.title).slice(0, 500),
    bodySummary: readString(taskContextRaw?.bodySummary).slice(0, 8000),
    rootId: readNullableString(taskContextRaw?.rootId),
    parentId: readNullableString(taskContextRaw?.parentId),
    sourceKind: readNullableString(taskContextRaw?.sourceKind),
    smoke: Boolean(taskContextRaw?.smoke),
    referencesSummary: readString(taskContextRaw?.referencesSummary).slice(0, 8000),
  };
  if (!taskContext.taskId) errors.push('taskContext.taskId is required');
  if (!taskContext.taskKind) errors.push('taskContext.taskKind is required');
  if (!taskContext.title) errors.push('taskContext.title is required');

  const questions = normalizeStringArray(payload.questions, { maxItems: 24, maxLen: 800 });

  return makeResult(errors, {
    version: 'v1',
    consultId,
    round,
    maxRounds,
    mode,
    autopilotHypothesis,
    autopilotMessage,
    taskContext,
    priorRoundSummary,
    questions,
  });
}

export function validateOpusConsultResponsePayload(payload) {
  const errors = [];
  if (!isPlainObject(payload)) {
    return makeResult(['references.opus must be an object'], null);
  }

  const version = readString(payload.version);
  if (version !== 'v1') errors.push('version must be v1');

  const consultId = validateConsultId(payload.consultId);
  if (!consultId) errors.push('consultId missing/invalid');

  const round = readInteger(payload.round, { min: 1, max: 8 });
  if (round == null) errors.push('round must be integer 1..8');

  const final = payload.final === true;
  const verdict = readString(payload.verdict);
  if (!OPUS_VERDICTS.has(verdict)) errors.push('verdict must be pass|warn|block');

  const rationale = readString(payload.rationale).slice(0, 12000);
  if (rationale.length < 20) errors.push('rationale must be at least 20 chars');

  const suggested_plan = normalizeStringArray(payload.suggested_plan, { maxItems: 24, maxLen: 1000 });
  if (!suggested_plan.length) errors.push('suggested_plan must contain at least one entry');

  const alternatives = normalizeStringArray(payload.alternatives, { maxItems: 24, maxLen: 1000 });
  const challenge_points = normalizeStringArray(payload.challenge_points, { maxItems: 24, maxLen: 1000 });
  const required_questions = normalizeStringArray(payload.required_questions, { maxItems: 24, maxLen: 800 });
  const required_actions = normalizeStringArray(payload.required_actions, { maxItems: 24, maxLen: 800 });
  const unresolved_critical_questions = normalizeStringArray(payload.unresolved_critical_questions, {
    maxItems: 24,
    maxLen: 800,
  });
  const retry_prompt_patch = readString(payload.retry_prompt_patch).slice(0, 8000);

  const code_suggestions = [];
  const codeSuggestionsRaw = Array.isArray(payload.code_suggestions) ? payload.code_suggestions : [];
  for (let i = 0; i < Math.min(24, codeSuggestionsRaw.length); i += 1) {
    const item = codeSuggestionsRaw[i];
    if (!isPlainObject(item)) {
      errors.push(`code_suggestions[${i}] must be object`);
      continue;
    }
    const target_path = readString(item.target_path).slice(0, 400);
    const change_type = readString(item.change_type);
    const suggestion = readString(item.suggestion).slice(0, 4000);
    if (!target_path) errors.push(`code_suggestions[${i}].target_path is required`);
    if (!OPUS_CHANGE_TYPES.has(change_type)) {
      errors.push(`code_suggestions[${i}].change_type invalid`);
    }
    if (!suggestion) errors.push(`code_suggestions[${i}].suggestion is required`);
    code_suggestions.push({ target_path, change_type, suggestion });
  }

  const reasonCode = readString(payload.reasonCode).slice(0, 160);
  if (!reasonCode) errors.push('reasonCode is required');

  if (verdict === 'block') {
    if (!final) errors.push('block verdict must set final=true');
    if (!required_actions.length) errors.push('block verdict requires required_actions');
    if (!retry_prompt_patch) errors.push('block verdict requires retry_prompt_patch');
  }
  if (verdict === 'warn' && !required_questions.length) {
    errors.push('warn verdict requires required_questions');
  }
  if (!final && verdict !== 'block' && !required_questions.length && !unresolved_critical_questions.length) {
    errors.push('non-final response requires unresolved questions');
  }

  return makeResult(errors, {
    version: 'v1',
    consultId,
    round,
    final,
    verdict,
    rationale,
    suggested_plan,
    alternatives,
    challenge_points,
    code_suggestions,
    required_questions,
    required_actions,
    retry_prompt_patch,
    unresolved_critical_questions,
    reasonCode,
  });
}

export function validateOpusConsultRequestMeta(meta) {
  const errors = [];
  if (!isPlainObject(meta)) {
    return makeResult(['task meta must be object'], null);
  }
  const signals = validateCommonSignals(meta, 'OPUS_CONSULT_REQUEST', errors);
  const payloadValidation = validateOpusConsultRequestPayload(extractOpusPayload(meta));
  errors.push(...payloadValidation.errors);
  if (signals.phase && payloadValidation.value?.mode && signals.phase !== payloadValidation.value.mode) {
    errors.push('signals.phase must match references.opus.mode');
  }
  return makeResult(errors, {
    signals,
    payload: payloadValidation.value,
  });
}

export function validateOpusConsultResponseMeta(meta) {
  const errors = [];
  if (!isPlainObject(meta)) {
    return makeResult(['task meta must be object'], null);
  }
  const signals = validateCommonSignals(meta, 'OPUS_CONSULT_RESPONSE', errors);
  const payloadValidation = validateOpusConsultResponsePayload(extractOpusPayload(meta));
  errors.push(...payloadValidation.errors);
  return makeResult(errors, {
    signals,
    payload: payloadValidation.value,
  });
}

export function makeOpusBlockPayload({ consultId, round, reasonCode, rationale, requiredActions = [] }) {
  const safeConsultId = validateConsultId(consultId) || 'invalid_consult';
  const safeRound = readInteger(round, { min: 1, max: 8 }) || 1;
  const safeReason = readString(reasonCode) || 'opus_transient';
  const safeRationale = readString(rationale) || 'Opus consult worker blocked before producing a valid consult response.';
  const actions = normalizeStringArray(requiredActions, { maxItems: 24, maxLen: 800 });
  const fallbackActions = actions.length ? actions : ['Review consult worker logs and retry.'];
  return {
    version: 'v1',
    consultId: safeConsultId,
    round: safeRound,
    final: true,
    verdict: 'block',
    rationale: safeRationale,
    suggested_plan: ['Stabilize consult preconditions and retry.'],
    alternatives: [],
    challenge_points: [],
    code_suggestions: [],
    required_questions: [],
    required_actions: fallbackActions,
    retry_prompt_patch: `Address reasonCode=${safeReason} then re-run consult.`,
    unresolved_critical_questions: [],
    reasonCode: safeReason,
  };
}
