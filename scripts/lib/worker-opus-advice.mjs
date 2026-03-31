import { validateOpusConsultResponsePayload } from './opus-consult-schema.mjs';
import { readStringField } from './worker-code-quality-state.mjs';

const OPUS_REASON_CODES = new Set([
  'opus_consult_pass',
  'opus_consult_warn',
  'opus_human_input_required',
  'opus_consult_iterate',
  'opus_consult_block',
  'opus_schema_invalid',
  'opus_timeout',
  'opus_claude_not_authenticated',
  'opus_rate_limited',
  'opus_refusal',
  'opus_transient',
]);

export function normalizeOpusReasonCode(value, fallback = 'opus_transient') {
  const reason = readStringField(value);
  if (OPUS_REASON_CODES.has(reason)) return reason;
  return fallback;
}

export function buildOpusAdvisoryFallbackPayload({
  consultId,
  round,
  reasonCode,
  rationale,
  suggestedPlan = [],
}) {
  const safeConsultId = readStringField(consultId) || 'consult_missing';
  const safeRound = Math.max(1, Math.min(200, Number(round) || 1));
  const safeReason = normalizeOpusReasonCode(reasonCode, 'opus_transient');
  const safeRationale =
    readStringField(rationale) || 'Advisory consult fallback applied due to runtime consult failure.';
  const planItems = Array.isArray(suggestedPlan)
    ? suggestedPlan.map((entry) => readStringField(entry)).filter(Boolean).slice(0, 24)
    : [];
  const normalizedPlan = planItems.length
    ? planItems
    : ['Proceed with autopilot decision and record Opus fallback diagnostics.'];
  const payload = {
    version: 'v1',
    consultId: safeConsultId,
    round: safeRound,
    final: true,
    verdict: safeReason === 'opus_consult_pass' ? 'pass' : 'warn',
    rationale: safeRationale.length >= 20 ? safeRationale : `${safeRationale} (fallback advisory)`,
    suggested_plan: normalizedPlan,
    alternatives: [],
    challenge_points: [],
    code_suggestions: [],
    required_questions: [],
    required_actions: [],
    retry_prompt_patch: '',
    unresolved_critical_questions: [],
    reasonCode: safeReason,
  };
  const validated = validateOpusConsultResponsePayload(payload);
  return validated.ok
    ? validated.value
    : {
        ...payload,
        reasonCode: 'opus_transient',
        suggested_plan: ['Proceed with autopilot decision and inspect consult logs.'],
      };
}

export function formatOpusCodeSuggestion(entry) {
  const targetPath = readStringField(entry?.target_path);
  const changeType = readStringField(entry?.change_type);
  const suggestion = readStringField(entry?.suggestion);
  return [targetPath ? `${targetPath}` : '', changeType ? `[${changeType}]` : '', suggestion]
    .filter(Boolean)
    .join(' ')
    .slice(0, 400);
}

function buildOpusAdviceItems(responsePayload, { maxItems = 12 } = {}) {
  const items = [];
  const requiredActions = Array.isArray(responsePayload?.required_actions)
    ? responsePayload.required_actions
    : [];
  const codeSuggestions = Array.isArray(responsePayload?.code_suggestions)
    ? responsePayload.code_suggestions
    : [];
  const challengePoints = Array.isArray(responsePayload?.challenge_points)
    ? responsePayload.challenge_points
    : [];
  const suggestedPlan = Array.isArray(responsePayload?.suggested_plan)
    ? responsePayload.suggested_plan
    : [];

  for (const entry of requiredActions) {
    const text = readStringField(entry);
    if (!text) continue;
    items.push({ id: '', category: 'action', text });
    if (items.length >= maxItems) break;
  }
  if (items.length < maxItems) {
    for (const entry of codeSuggestions) {
      const text = formatOpusCodeSuggestion(entry);
      if (!text) continue;
      items.push({ id: '', category: 'code', text: text.slice(0, 800) });
      if (items.length >= maxItems) break;
    }
  }
  if (items.length < maxItems) {
    for (const entry of challengePoints) {
      const text = readStringField(entry);
      if (!text) continue;
      items.push({ id: '', category: 'risk', text });
      if (items.length >= maxItems) break;
    }
  }
  if (items.length < maxItems) {
    for (const entry of suggestedPlan) {
      const text = readStringField(entry);
      if (!text) continue;
      items.push({ id: '', category: 'plan', text });
      if (items.length >= maxItems) break;
    }
  }
  return items.map((item, index) => ({ ...item, id: `OPUS-${index + 1}` }));
}

export function buildOpusConsultAdvice({ mode, phaseResult, phase }) {
  if (!phaseResult || typeof phaseResult !== 'object') {
    return {
      consulted: false,
      phase,
      mode,
      severity: 'none',
      reasonCode: null,
      summary: '',
      items: [],
      consultId: '',
      round: 0,
      responseTaskId: '',
    };
  }
  const response =
    phaseResult.finalResponse && typeof phaseResult.finalResponse === 'object'
      ? phaseResult.finalResponse
      : null;
  const isSynthetic = phaseResult.finalResponseRuntime?.synthetic === true;
  const reasonCode = readStringField(phaseResult.reasonCode || response?.reasonCode) || null;
  const summary = readStringField(response?.rationale || phaseResult.note || '');
  const items = response && !isSynthetic ? buildOpusAdviceItems(response) : [];
  const responseVerdict = readStringField(response?.verdict);
  const gateMode = readStringField(mode).toLowerCase() === 'gate';
  const severity = !phaseResult.ok
    ? (gateMode ? 'block' : 'warn')
    : responseVerdict === 'block'
      ? (gateMode ? 'block' : 'warn')
      : responseVerdict === 'warn'
        ? 'warn'
        : 'pass';
  return {
    consulted: true,
    phase,
    mode,
    severity,
    reasonCode,
    summary,
    items,
    consultId: readStringField(phaseResult.consultId),
    round: Number(phaseResult.roundsUsed) || Number(response?.round) || 0,
    responseTaskId: readStringField(phaseResult.finalResponseTaskId),
  };
}

export function readOpusRationaleLine(note) {
  const lines = String(note || '').split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^Opus rationale:\s*(.+?)\s*$/);
    if (match?.[1]) return match[1].trim();
  }
  return '';
}

export function parseOpusDispositionLines(note) {
  const entries = [];
  const parseErrors = [];
  for (const rawLine of String(note || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!/^(?:[-*]\s*)?Opus disposition\b/i.test(line)) continue;
    const match = line.match(
      /^(?:[-*]\s*)?Opus disposition\s+(OPUS-\d+)\s*:\s*(accept|reject|defer)(?:\s*-\s*(.+))?$/i,
    );
    if (!match) {
      parseErrors.push(`invalid_opus_disposition_line:${line}`);
      continue;
    }
    entries.push({
      id: match[1].toUpperCase(),
      decision: match[2].toLowerCase(),
      rationale: readStringField(match[3]),
    });
  }
  return {
    entries,
    parseErrors,
  };
}

export function opusAdviceItemSuggestsDelegation(item) {
  const text = readStringField(item?.text).toLowerCase();
  return /\bdelegat(?:e|ion)\b|\bdispatch\b/.test(text);
}

export function opusDispositionHasLocalJustification(rationale) {
  const text = readStringField(rationale).toLowerCase();
  return text.length >= 12 && /\blocal\b|\bnarrower\b|\bsafer\b|\bscope\b/.test(text);
}

export function buildOpusConsultPromptBlock({
  isAutopilot,
  preExecAdvice = null,
  requireDisposition = false,
}) {
  if (!isAutopilot) return '';
  const currentPreExecLines = [];
  if (preExecAdvice?.consulted) {
    currentPreExecLines.push(`Current Opus pre-exec advisory for this turn:`);
    currentPreExecLines.push(
      `- severity=${readStringField(preExecAdvice?.severity) || 'none'} reasonCode=${readStringField(preExecAdvice?.reasonCode) || 'none'}`,
    );
    const summary = readStringField(preExecAdvice?.summary);
    if (summary) currentPreExecLines.push(`- summary: ${summary.slice(0, 360)}`);
    const items = Array.isArray(preExecAdvice?.items) ? preExecAdvice.items.slice(0, 12) : [];
    for (const item of items) {
      const itemId = readStringField(item?.id);
      const category = readStringField(item?.category) || 'note';
      const text = readStringField(item?.text).slice(0, 260);
      if (!itemId || !text) continue;
      currentPreExecLines.push(`- ${itemId} [${category}] ${text}`);
    }
  }
  return (
    `OPUS ADVISORY HANDLING:\n` +
    `- When context includes "Opus consult advisory (focusRootId)", review the full advisory summary first.\n` +
    `- Treat OPUS-* items as consultant suggestions only; they are non-binding.\n` +
    `- If you act, defer, or reject suggestions, explain your reasoning clearly in note.\n` +
    `- Opus advice is advisory; autopilot remains decision authority.\n` +
    `- Never let advisory parsing/formatting details block progress in advisory mode.\n` +
    (currentPreExecLines.length ? `${currentPreExecLines.join('\n')}\n` : '') +
    (requireDisposition
      ? `- For every current Opus pre-exec item above, include one note line exactly like:\n` +
        `  Opus disposition OPUS-N: accept|reject|defer - <reason>\n` +
        `- Missing Opus disposition lines block done for controller code-writing turns.\n` +
        `- If Opus pushes delegation and you still edit locally, the reason must say why local execution is narrower or safer than dispatch.\n`
      : '') +
    `\n`
  );
}
