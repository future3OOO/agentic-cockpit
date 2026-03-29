import { readStringField } from './worker-code-quality-state.mjs';

function parseBooleanSetting(value, defaultValue) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return Boolean(defaultValue);
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') return true;
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false;
  return Boolean(defaultValue);
}

function parseCsvSetting(value) {
  return String(value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseAutoEnabled(rawValue, fallback) {
  const raw = String(rawValue ?? '').trim().toLowerCase();
  if (!raw || raw === 'auto') return fallback;
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') return true;
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false;
  return fallback;
}

export function deriveOpusConsultGate({ isAutopilot, taskKind, roster, env = process.env }) {
  const kind = readStringField(taskKind).toUpperCase();
  const consultAgent = readStringField(
    env.AGENTIC_AUTOPILOT_OPUS_CONSULT_AGENT ??
      env.VALUA_AUTOPILOT_OPUS_CONSULT_AGENT ??
      'opus-consult',
  );
  const consultAgentExists = Boolean(
    consultAgent &&
      Array.isArray(roster?.agents) &&
      roster.agents.some((agent) => readStringField(agent?.name) === consultAgent),
  );

  const legacyPreExecRaw = readStringField(
    env.AGENTIC_AUTOPILOT_OPUS_GATE ?? env.VALUA_AUTOPILOT_OPUS_GATE ?? '',
  );
  const legacyPostReviewRaw = readStringField(
    env.AGENTIC_AUTOPILOT_OPUS_POST_REVIEW ?? env.VALUA_AUTOPILOT_OPUS_POST_REVIEW ?? '',
  );
  const legacyBarrierRaw = readStringField(
    env.AGENTIC_AUTOPILOT_OPUS_ENFORCE_PREEXEC_BARRIER ??
      env.VALUA_AUTOPILOT_OPUS_ENFORCE_PREEXEC_BARRIER ??
      '',
  );
  const modeRaw = readStringField(
    env.AGENTIC_OPUS_CONSULT_MODE ?? env.VALUA_OPUS_CONSULT_MODE ?? '',
  ).toLowerCase();
  const explicitGateMode = modeRaw === 'gate' || modeRaw === 'strict';
  const legacyPreExecEnabled = parseAutoEnabled(
    legacyPreExecRaw || 'auto',
    explicitGateMode ? true : consultAgentExists,
  );
  const legacyPostReviewEnabled = parseAutoEnabled(
    legacyPostReviewRaw || 'auto',
    explicitGateMode ? true : consultAgentExists,
  );
  const legacyBarrierEnabled = legacyBarrierRaw ? parseBooleanSetting(legacyBarrierRaw, true) : false;

  let consultMode = 'advisory';
  let modeSource = 'default';
  if (modeRaw === 'off' || modeRaw === 'disabled' || modeRaw === 'false' || modeRaw === '0') {
    consultMode = 'off';
    modeSource = 'explicit';
  } else if (modeRaw === 'gate' || modeRaw === 'strict') {
    consultMode = 'gate';
    modeSource = 'explicit';
  } else if (modeRaw === 'advisory' || modeRaw === 'warn' || modeRaw === 'advice') {
    consultMode = 'advisory';
    modeSource = 'explicit';
  } else if (legacyPreExecRaw || legacyPostReviewRaw || legacyBarrierRaw) {
    if (!legacyPreExecEnabled && !legacyPostReviewEnabled) {
      consultMode = 'off';
    } else if (legacyBarrierEnabled) {
      consultMode = 'gate';
    } else {
      consultMode = 'advisory';
    }
    modeSource = 'legacy';
  }

  const preExecEnabled = consultMode !== 'off' && legacyPreExecEnabled;
  const postReviewEnabled = consultMode !== 'off' && legacyPostReviewEnabled;
  const preExecKinds = parseCsvSetting(
    env.AGENTIC_AUTOPILOT_OPUS_GATE_KINDS ??
      env.VALUA_AUTOPILOT_OPUS_GATE_KINDS ??
      'USER_REQUEST,PLAN_REQUEST,ORCHESTRATOR_UPDATE,EXECUTE',
  ).map((entry) => entry.toUpperCase());
  const postReviewKinds = parseCsvSetting(
    env.AGENTIC_AUTOPILOT_OPUS_POST_REVIEW_KINDS ??
      env.VALUA_AUTOPILOT_OPUS_POST_REVIEW_KINDS ??
      'USER_REQUEST,PLAN_REQUEST,ORCHESTRATOR_UPDATE,EXECUTE',
  ).map((entry) => entry.toUpperCase());

  const configuredGateTimeoutMs = Math.max(
    1_000,
    Number(
      env.AGENTIC_AUTOPILOT_OPUS_GATE_TIMEOUT_MS ??
        env.VALUA_AUTOPILOT_OPUS_GATE_TIMEOUT_MS ??
        '3600000',
    ) || 3_600_000,
  );
  const opusTimeoutMs = Math.max(
    1_000,
    Number(
      env.AGENTIC_OPUS_TIMEOUT_MS ??
        env.VALUA_OPUS_TIMEOUT_MS ??
        '3600000',
    ) || 3_600_000,
  );
  const opusMaxRetries = Math.max(
    0,
    Number(
      env.AGENTIC_OPUS_MAX_RETRIES ??
        env.VALUA_OPUS_MAX_RETRIES ??
        '0',
    ) || 0,
  );
  const opusProtocolModeRaw = readStringField(
    env.AGENTIC_OPUS_PROTOCOL_MODE ??
      env.VALUA_OPUS_PROTOCOL_MODE ??
      (consultMode === 'gate' ? 'dual_pass' : 'freeform_only'),
  ).toLowerCase();
  const protocolMode = (
    opusProtocolModeRaw === 'strict_only' ||
    opusProtocolModeRaw === 'dual_pass' ||
    opusProtocolModeRaw === 'freeform_only'
  )
    ? opusProtocolModeRaw
    : (consultMode === 'gate' ? 'dual_pass' : 'freeform_only');
  const stagesPerRound = protocolMode === 'dual_pass' ? 2 : 1;
  let retryBackoffBudgetMs = 0;
  for (let attempt = 1; attempt <= opusMaxRetries; attempt += 1) {
    retryBackoffBudgetMs += Math.min(1000 * attempt, 5000);
  }
  const consultRuntimeBudgetMs =
    opusTimeoutMs * (opusMaxRetries + 1) * stagesPerRound +
    retryBackoffBudgetMs * stagesPerRound +
    5_000;
  const gateTimeoutMs = Math.max(configuredGateTimeoutMs, consultRuntimeBudgetMs);
  const configuredMaxRounds = Math.max(
    1,
    Number(
      env.AGENTIC_AUTOPILOT_OPUS_MAX_ROUNDS ??
        env.VALUA_AUTOPILOT_OPUS_MAX_ROUNDS ??
        '200',
    ) || 200,
  );
  const maxRounds = consultMode === 'advisory' ? 1 : configuredMaxRounds;
  const enforcePreExecBarrier = consultMode === 'gate' && parseBooleanSetting(
    env.AGENTIC_AUTOPILOT_OPUS_ENFORCE_PREEXEC_BARRIER ??
      env.VALUA_AUTOPILOT_OPUS_ENFORCE_PREEXEC_BARRIER ??
      '1',
    true,
  );
  const warnRequiresAck = consultMode === 'gate' && parseBooleanSetting(
    env.AGENTIC_AUTOPILOT_OPUS_WARN_REQUIRES_ACK ??
      env.VALUA_AUTOPILOT_OPUS_WARN_REQUIRES_ACK ??
      '0',
    false,
  );
  const requireDecisionRationale = consultMode === 'gate' && parseBooleanSetting(
    env.AGENTIC_AUTOPILOT_OPUS_REQUIRE_DECISION_RATIONALE ??
      env.VALUA_AUTOPILOT_OPUS_REQUIRE_DECISION_RATIONALE ??
      '1',
    true,
  );

  return {
    taskKind: kind,
    consultAgent,
    consultAgentExists,
    consultMode,
    consultModeSource: modeSource,
    preExecEnabled: Boolean(preExecEnabled),
    postReviewEnabled: Boolean(postReviewEnabled),
    preExecRequired: Boolean(isAutopilot && preExecEnabled && kind && preExecKinds.includes(kind)),
    postReviewRequired: Boolean(isAutopilot && postReviewEnabled && kind && postReviewKinds.includes(kind)),
    preExecKinds,
    postReviewKinds,
    gateTimeoutMs,
    protocolMode,
    stagesPerRound,
    maxRounds,
    enforcePreExecBarrier,
    warnRequiresAck,
    requireDecisionRationale,
  };
}
