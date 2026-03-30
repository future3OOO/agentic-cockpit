import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readStringField } from './worker-preflight-shared.mjs';

const PRELOADED_WORKER_OUTPUT_SCHEMA = JSON.parse(
  readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'docs',
      'agentic',
      'agent-bus',
      'CODEX_WORKER_OUTPUT.schema.json',
    ),
    'utf8',
  ),
);
const preflightPlanSchema = PRELOADED_WORKER_OUTPUT_SCHEMA?.properties?.preflightPlan;
if (!preflightPlanSchema || typeof preflightPlanSchema !== 'object' || Array.isArray(preflightPlanSchema)) {
  throw new Error('CODEX_WORKER_OUTPUT.schema.json missing properties.preflightPlan');
}
const PREFLIGHT_PLAN_SCHEMA = JSON.parse(JSON.stringify(preflightPlanSchema));

export function buildPreflightPromptBlock({
  required,
  approvedPlan = null,
  planHash = '',
}) {
  if (!required) return '';
  const approvedSummary = approvedPlan
    ? [
        `Approved plan hash: ${planHash || '(missing)'}`,
        `Approved touchpoints: ${approvedPlan.touchpoints.join(', ') || '(none)'}`,
        `Approved update surfaces: ${approvedPlan.coupledSurfaces.filter((value) => value.startsWith('update:')).join(', ') || '(none)'}`,
        `Verification-only surfaces: ${approvedPlan.coupledSurfaces.filter((value) => value.startsWith('verify:')).join(', ') || '(none)'}`,
        `Approved modularityPlan: ${approvedPlan.modularityPlan || '(missing)'}`,
      ].join('\n')
    : 'No preflight has been approved yet.';
  return (
    `MANDATORY PREFLIGHT CONTRACT:\n` +
    `- You must not make tracked-file edits before runtime approves preflight.\n` +
    `- Keep execution inside approved touchpoints and declared update: surfaces only.\n` +
    `- verify: surfaces are verification-only and must not be edited.\n` +
    `- Keep preflightPlan in final output equal to the approved plan.\n` +
    `${approvedSummary}\n` +
    `\n`
  );
}

export function buildPreflightTurnPrompt({
  agentName,
  skillsSelected,
  includeSkills,
  taskKind,
  isAutopilot,
  contextBlock,
  taskMarkdown,
  retryReason = '',
  seedPlan = null,
}) {
  const invocations =
    includeSkills && Array.isArray(skillsSelected) && skillsSelected.length
      ? `${skillsSelected.map((skill) => `$${skill}`).join('\n')}\n\n`
      : '';
  const seededPlanText = seedPlan
    ? `Current working preflight seed (revise it if needed):\n${JSON.stringify(seedPlan, null, 2)}\n\n`
    : '';
  const retryText = retryReason ? `RETRY REQUIREMENT:\n${retryReason}\n\n` : '';
  const controllerText = isAutopilot
    ? `AUTOPILOT PREFLIGHT:\n- Challenge whether dispatch is safer than local execution before you touch code.\n- If you still plan local edits, chosenApproach and modularityPlan must justify it.\n\n`
    : '';
  return (
    `${invocations}` +
    (contextBlock ? `${contextBlock}\n\n` : '') +
    `You are the agent "${agentName}" running inside Agentic Cockpit.\n\n` +
    `This is a MANDATORY no-write preflight turn for task kind ${readStringField(taskKind) || 'UNKNOWN'}.\n` +
    `Do not make tracked-file edits in this turn. Investigate reuse, scope, coupling, and modularity first.\n` +
    `${controllerText}` +
    `${retryText}` +
    `${seededPlanText}` +
    `Return ONLY JSON shaped as {"preflightPlan":{...}} with these fields:\n` +
    `- goal\n` +
    `- reusePath\n` +
    `- modularityPlan\n` +
    `- chosenApproach\n` +
    `- rejectedApproaches[] as {approach,reason}\n` +
    `- touchpoints[]\n` +
    `- coupledSurfaces[] using verify: or update: prefixes\n` +
    `- riskChecks[]\n` +
    `- openQuestions[]\n` +
    `If anything remains unresolved, put it in openQuestions instead of bluffing.\n\n` +
    `--- TASK PACKET ---\n${taskMarkdown}\n`
  );
}

export function getPreflightOutputSchema() {
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    additionalProperties: false,
    required: ['preflightPlan'],
    properties: {
      preflightPlan: JSON.parse(JSON.stringify(PREFLIGHT_PLAN_SCHEMA)),
    },
  };
}
