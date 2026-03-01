#!/usr/bin/env node

import { parseWorkerCliValues } from './lib/worker-cli.mjs';
import {
  getRepoRoot,
  getCockpitRoot,
  loadRoster,
  resolveBusRoot,
  ensureBusRoot,
  listInboxTaskIds,
  openTask,
  claimTask,
  closeTask,
  deliverTask,
  makeId,
} from './lib/agentbus.mjs';
import {
  validateOpusConsultRequestMeta,
  validateOpusConsultResponsePayload,
  extractOpusPayload,
  makeOpusBlockPayload,
} from './lib/opus-consult-schema.mjs';
import { checkClaudeAuth, OpusClientError, runOpusConsultCli } from './lib/opus-client.mjs';
import {
  acquireGlobalSemaphoreSlot,
  readGlobalCooldown,
  writeGlobalCooldown,
} from './lib/codex-limiter.mjs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseBooleanEnv(value, fallback) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') return true;
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false;
  return fallback;
}

function parsePositiveIntEnv(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function readEnv(env, key, legacyKey, fallback = '') {
  const v = readString(env[key]) || readString(env[legacyKey]);
  return v || fallback;
}

function writePane(text) {
  process.stderr.write(String(text || ''));
}

function createPrefixedChunkWriter(prefix) {
  let carry = '';
  return {
    write(chunk) {
      const text = String(chunk || '');
      if (!text) return;
      const combined = carry + text;
      const lines = combined.split(/\r?\n/);
      carry = lines.pop() || '';
      for (const line of lines) {
        writePane(`${prefix}${line}\n`);
      }
    },
    flush() {
      if (!carry) return;
      writePane(`${prefix}${carry}\n`);
      carry = '';
    },
  };
}

function startProgressHeartbeat({ intervalMs, onTick }) {
  if (typeof onTick !== 'function') return () => {};
  const periodMs = Math.max(1000, parsePositiveIntEnv(intervalMs, 5000));
  const timer = setInterval(() => {
    try {
      onTick();
    } catch {
      // never let telemetry logging break consult execution
    }
  }, periodMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

function formatConsultEventMessage({ consultId, round, maxRounds, event }) {
  const prefix = `[opus-consult] consult telemetry consultId=${consultId} round=${round}/${maxRounds}`;
  if (!event || typeof event !== 'object') return `${prefix} event=unknown`;
  const stage = readString(event.stage);
  const stageSuffix = stage ? ` stage=${stage}` : '';
  if (event.type === 'attempt_start') {
    return `${prefix} event=attempt_start attempt=${event.attempt}/${event.maxAttempts}${stageSuffix}`;
  }
  if (event.type === 'schema_sanitized') {
    const removed = Array.isArray(event.removedTopLevelCombinators)
      ? event.removedTopLevelCombinators.filter(Boolean).join(',')
      : '';
    return `${prefix} event=schema_sanitized removedTopLevelCombinators=${removed || 'none'}`;
  }
  if (event.type === 'stage_start') {
    return `${prefix} event=stage_start${stageSuffix}`;
  }
  if (event.type === 'stage_done') {
    return `${prefix} event=stage_done${stageSuffix} attempts=${event.attempts || 0} durationMs=${event.durationMs || 0}`;
  }
  if (event.type === 'attempt_success') {
    return `${prefix} event=attempt_success attempt=${event.attempt}/${event.maxAttempts}${stageSuffix} stdoutBytes=${event.stdoutBytes || 0} stderrBytes=${event.stderrBytes || 0}`;
  }
  if (event.type === 'attempt_backoff') {
    return `${prefix} event=attempt_backoff attempt=${event.attempt}/${event.maxAttempts}${stageSuffix} backoffMs=${event.backoffMs || 0}`;
  }
  if (event.type === 'attempt_retry' || event.type === 'attempt_failed') {
    return `${prefix} event=${event.type} attempt=${event.attempt}/${event.maxAttempts}${stageSuffix} reasonCode=${event.reasonCode || 'unknown'} transient=${event.transient ? 'true' : 'false'}`;
  }
  return `${prefix} event=${readString(event.type) || 'unknown'}${stageSuffix}`;
}

async function fileExists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function waitForOpusCooldown({ busRoot }) {
  while (true) {
    const cooldown = await readGlobalCooldown({ busRoot, fileName: 'claude-code-rpm-cooldown.json' });
    if (!cooldown?.retryAtMs) return;
    const waitMs = Math.max(0, Number(cooldown.retryAtMs) - Date.now());
    if (waitMs <= 0) return;
    await sleep(Math.min(waitMs, 1_000));
  }
}

function uniquePaths(paths) {
  const out = [];
  const seen = new Set();
  for (const raw of paths) {
    const resolved = readString(raw) ? path.resolve(readString(raw)) : '';
    if (!resolved || seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

function normalizeSkillName(value) {
  const raw = readString(value).replace(/^\$/, '');
  if (!raw) return '';
  if (!/^[A-Za-z0-9._-]+$/.test(raw)) return '';
  return raw;
}

function buildSkillRootCandidates({ projectRoot, repoRoot, cockpitRoot }) {
  return uniquePaths([
    path.join(projectRoot, '.codex', 'skills'),
    path.join(projectRoot, '.claude', 'skills'),
    path.join(repoRoot, '.codex', 'skills'),
    path.join(repoRoot, '.claude', 'skills'),
    path.join(cockpitRoot, '.codex', 'skills'),
    path.join(cockpitRoot, '.claude', 'skills'),
  ]);
}

function buildPromptDirCandidates({ promptDirOverride, projectRoot, repoRoot, cockpitRoot }) {
  return uniquePaths([
    promptDirOverride,
    path.join(projectRoot, '.codex', 'opus'),
    path.join(repoRoot, '.codex', 'opus'),
    path.join(cockpitRoot, '.codex', 'opus'),
  ]);
}

async function resolvePromptAssets({ promptDirOverride, projectRoot, repoRoot, cockpitRoot }) {
  const promptDirs = buildPromptDirCandidates({ promptDirOverride, projectRoot, repoRoot, cockpitRoot });
  for (const promptDir of promptDirs) {
    const instructionsPath = path.join(promptDir, 'OPUS_INSTRUCTIONS.md');
    if (await fileExists(instructionsPath)) {
      return {
        promptDir,
        instructionsPath,
        candidates: promptDirs,
      };
    }
  }
  throw new OpusClientError('Opus prompt assets missing', {
    reasonCode: 'opus_schema_invalid',
    transient: false,
    stderr: `searched prompt dirs: ${promptDirs.join(', ')}`,
  });
}

async function resolveSkillFilePath({ skillName, skillRoots }) {
  for (const root of skillRoots) {
    const candidate = path.join(root, skillName, 'SKILL.md');
    if (await fileExists(candidate)) return candidate;
  }
  return '';
}

async function resolveAgentSkillAssets({ roster, agentName, projectRoot, repoRoot, cockpitRoot }) {
  const agents = Array.isArray(roster?.agents) ? roster.agents : [];
  const agentCfg = agents.find((agent) => readString(agent?.name) === agentName) || null;
  if (!agentCfg) {
    throw new OpusClientError(`Opus agent "${agentName}" missing from roster`, {
      reasonCode: 'opus_schema_invalid',
      transient: false,
    });
  }
  const skillNames = Array.from(
    new Set(
      (Array.isArray(agentCfg.skills) ? agentCfg.skills : [])
        .map((entry) => normalizeSkillName(entry))
        .filter(Boolean),
    ),
  );
  if (!skillNames.length) {
    throw new OpusClientError(`Opus agent "${agentName}" has no configured skills`, {
      reasonCode: 'opus_schema_invalid',
      transient: false,
    });
  }
  const skillRoots = buildSkillRootCandidates({ projectRoot, repoRoot, cockpitRoot });
  const missing = [];
  const docs = [];
  for (const skillName of skillNames) {
    const skillPath = await resolveSkillFilePath({ skillName, skillRoots });
    if (!skillPath) {
      missing.push(skillName);
      continue;
    }
    const content = await fs.readFile(skillPath, 'utf8');
    docs.push({
      name: skillName,
      path: skillPath,
      content,
    });
  }
  if (missing.length > 0) {
    throw new OpusClientError('Opus skill assets missing', {
      reasonCode: 'opus_schema_invalid',
      transient: false,
      stderr: `missing skills: ${missing.join(', ')}; searched roots: ${skillRoots.join(', ')}`,
    });
  }
  return {
    skillNames,
    docs,
    roots: skillRoots,
  };
}

function normalizeProtocolMode(value) {
  const raw = readString(value).toLowerCase();
  if (raw === 'strict_only') return 'strict_only';
  return 'dual_pass';
}

function clipText(value, maxLen = 2000) {
  const text = readString(value);
  if (!text) return '';
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}...`;
}

function buildStageContract({ stage }) {
  if (stage === 'freeform') {
    return [
      '## Stage Contract (Authoritative)',
      '- stage: freeform_consult',
      '- Return concise markdown analysis only (no JSON).',
      '- Challenge assumptions and produce concrete execution guidance.',
      '- Do not emit insufficient-context outcomes.',
      '- Do not dispatch AgentBus tasks directly.',
      '- This stage contract overrides conflicting guidance in loaded docs.',
      '',
    ];
  }
  return [
    '## Stage Contract (Authoritative)',
    '- stage: strict_contract',
    '- Return ONLY schema-compliant structured_output JSON payload.',
    '- If human input is needed: reasonCode=opus_human_input_required + required_questions[].',
    '- If another consult round is needed: reasonCode=opus_consult_iterate + final=false.',
    '- Do not emit insufficient-context outcomes.',
    '- Do not dispatch AgentBus tasks directly.',
    '- This stage contract overrides conflicting guidance in loaded docs.',
    '',
  ];
}

function composeSystemPrompt({
  stage,
  instructions,
  skillAssets,
  busRoot,
  agentName,
  projectRoot,
  repoRoot,
  cockpitRoot,
}) {
  const skillSections = skillAssets.docs
    .map((doc) => [`### ${doc.name}`, `source: ${doc.path}`, doc.content, ''].join('\n'))
    .join('\n');
  return [
    'You are the opus-consult worker for Agentic Cockpit.',
    'You are the lead consultant to daddy-autopilot.',
    'You have full repository/runtime access through enabled tools.',
    '',
    ...buildStageContract({ stage }),
    '## Runtime Context',
    `- agent_name: ${agentName}`,
    `- bus_root: ${busRoot}`,
    `- project_root: ${projectRoot}`,
    `- repo_root: ${repoRoot}`,
    `- cockpit_root: ${cockpitRoot}`,
    `- loaded_skills: ${skillAssets.skillNames.join(', ')}`,
    '',
    '## Instructions',
    instructions,
    '',
    '## Skills',
    skillSections,
    '',
  ].join('\n');
}

async function buildSystemPromptFiles({
  roster,
  promptDirOverride,
  projectRoot,
  repoRoot,
  cockpitRoot,
  busRoot,
  agentName,
  tmpDir,
  protocolMode,
}) {
  const resolved = await resolvePromptAssets({ promptDirOverride, projectRoot, repoRoot, cockpitRoot });
  const instructions = await fs.readFile(resolved.instructionsPath, 'utf8');
  const skillAssets = await resolveAgentSkillAssets({
    roster,
    agentName,
    projectRoot,
    repoRoot,
    cockpitRoot,
  });
  await fs.mkdir(tmpDir, { recursive: true });
  const nonce = `${process.pid}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const strictPromptPath = path.join(tmpDir, `opus-system-prompt-strict-${nonce}.txt`);
  await fs.writeFile(
    strictPromptPath,
    composeSystemPrompt({
      stage: 'strict',
      instructions,
      skillAssets,
      busRoot,
      agentName,
      projectRoot,
      repoRoot,
      cockpitRoot,
    }),
    'utf8',
  );

  let freeformPromptPath = '';
  if (protocolMode === 'dual_pass') {
    freeformPromptPath = path.join(tmpDir, `opus-system-prompt-freeform-${nonce}.txt`);
    await fs.writeFile(
      freeformPromptPath,
      composeSystemPrompt({
        stage: 'freeform',
        instructions,
        skillAssets,
        busRoot,
        agentName,
        projectRoot,
        repoRoot,
        cockpitRoot,
      }),
      'utf8',
    );
  }
  return {
    strictPromptPath,
    freeformPromptPath,
    promptDir: resolved.promptDir,
    candidates: resolved.candidates,
    skillNames: skillAssets.skillNames,
    skillRoots: skillAssets.roots,
  };
}

async function resolveProviderSchemaPath({ explicitPath, projectRoot, repoRoot, cockpitRoot }) {
  const candidates = uniquePaths([
    explicitPath,
    path.join(projectRoot, 'docs', 'agentic', 'agent-bus', 'OPUS_CONSULT.provider.schema.json'),
    path.join(repoRoot, 'docs', 'agentic', 'agent-bus', 'OPUS_CONSULT.provider.schema.json'),
    path.join(cockpitRoot, 'docs', 'agentic', 'agent-bus', 'OPUS_CONSULT.provider.schema.json'),
  ]);
  for (const candidate of candidates) {
    if (await fileExists(candidate)) return { path: candidate, candidates };
  }
  throw new OpusClientError('Opus provider schema missing', {
    reasonCode: 'opus_schema_invalid',
    transient: false,
    stderr: `searched provider schemas: ${candidates.join(', ')}`,
  });
}

function buildResponseBody({ verdict, reasonCode, rationale }) {
  return [
    `Opus consult response generated.`,
    '',
    `- verdict: ${verdict}`,
    `- reasonCode: ${reasonCode}`,
    '',
    rationale,
    '',
  ].join('\n');
}

function normalizeConsultResponsePayload(rawPayload) {
  if (!isPlainObject(rawPayload)) {
    return {
      payload: rawPayload,
      repairs: [],
    };
  }
  const payload = { ...rawPayload };
  const repairs = [];
  if (readString(payload.verdict) === 'block' && payload.final !== true) {
    payload.final = true;
    repairs.push('coerced block verdict final=true');
  }
  return {
    payload,
    repairs,
  };
}

async function deliverConsultResponse({
  busRoot,
  agentName,
  opened,
  responsePayload,
  responseRuntime = null,
}) {
  const rootId = readString(opened?.meta?.signals?.rootId) || readString(opened?.meta?.id) || makeId('root');
  const toAgent = readString(opened?.meta?.from);
  if (!toAgent) throw new Error('consult request missing sender agent in meta.from');

  const phase = readString(opened?.meta?.signals?.phase) || 'pre_exec';
  const priority = readString(opened?.meta?.priority) || 'P2';
  const parentId = readString(opened?.meta?.id) || rootId;
  const smoke = Boolean(opened?.meta?.signals?.smoke);

  const taskId = makeId('msg');
  const title = `OPUS_CONSULT_RESPONSE: ${readString(opened?.meta?.title) || parentId}`;
  const body = buildResponseBody({
    verdict: readString(responsePayload?.verdict) || 'block',
    reasonCode: readString(responsePayload?.reasonCode) || 'opus_transient',
    rationale: readString(responsePayload?.rationale) || 'Opus consult did not provide rationale.',
  });

  const meta = {
    id: taskId,
    to: [toAgent],
    from: agentName,
    priority,
    title,
    signals: {
      kind: 'OPUS_CONSULT_RESPONSE',
      phase,
      rootId,
      parentId,
      smoke,
      notifyOrchestrator: false,
    },
    references: {
      opus: responsePayload,
      ...(isPlainObject(responseRuntime) ? { opusRuntime: responseRuntime } : {}),
      consultRequestId: parentId,
    },
  };

  const delivered = await deliverTask({ busRoot, meta, body });
  return {
    responseTaskId: taskId,
    responseTaskPath: delivered.paths[0] || null,
  };
}

async function main() {
  const values = parseWorkerCliValues();
  const agentName = readString(values.agent);
  if (!agentName) throw new Error('--agent is required');

  const repoRoot = getRepoRoot();
  const rosterInfo = await loadRoster({ repoRoot, rosterPath: values.roster });
  const busRoot = resolveBusRoot({ busRoot: values['bus-root'], repoRoot });
  await ensureBusRoot(busRoot, rosterInfo.roster);

  const pollMs = Math.max(100, Number(values['poll-ms'] || 1000) || 1000);
  const once = Boolean(values.once);

  const env = process.env;
  const cockpitRoot = path.resolve(readEnv(env, 'COCKPIT_ROOT', '', getCockpitRoot()) || getCockpitRoot());
  const projectRoot = path.resolve(
    readEnv(env, 'AGENTIC_PROJECT_ROOT', 'VALUA_REPO_ROOT', repoRoot) || repoRoot,
  );
  const promptDirOverride = readEnv(env, 'AGENTIC_OPUS_PROMPT_DIR', 'VALUA_OPUS_PROMPT_DIR', '');
  const providerSchemaOverride = readEnv(
    env,
    'AGENTIC_OPUS_PROVIDER_SCHEMA_PATH',
    'VALUA_OPUS_PROVIDER_SCHEMA_PATH',
    '',
  );
  const claudeBin = readEnv(env, 'AGENTIC_OPUS_CLAUDE_BIN', 'VALUA_OPUS_CLAUDE_BIN', 'claude');
  const stubBin = readEnv(env, 'AGENTIC_OPUS_STUB_BIN', 'VALUA_OPUS_STUB_BIN', '');
  const model = readEnv(env, 'AGENTIC_OPUS_MODEL', 'VALUA_OPUS_MODEL', 'claude-opus-4-6');
  const protocolMode = normalizeProtocolMode(
    readEnv(env, 'AGENTIC_OPUS_PROTOCOL_MODE', 'VALUA_OPUS_PROTOCOL_MODE', 'dual_pass'),
  );
  const toolsMode = readEnv(env, 'AGENTIC_OPUS_TOOLS', 'VALUA_OPUS_TOOLS', 'all').toLowerCase();
  const toolsValue = toolsMode === 'none' || toolsMode === 'off' || toolsMode === 'disabled'
    ? null
    : (toolsMode === 'all' || toolsMode === 'default' || !toolsMode ? 'default' : toolsMode);
  const cwdMode = readEnv(env, 'AGENTIC_OPUS_CWD_MODE', 'VALUA_OPUS_CWD_MODE', 'agent_worktree').toLowerCase();
  const timeoutMs = Math.max(1000, Number(readEnv(env, 'AGENTIC_OPUS_TIMEOUT_MS', 'VALUA_OPUS_TIMEOUT_MS', '3600000')) || 3600000);
  const maxRetries = Math.max(0, Number(readEnv(env, 'AGENTIC_OPUS_MAX_RETRIES', 'VALUA_OPUS_MAX_RETRIES', '0')) || 0);
  const globalMaxInflight = Math.max(1, Number(readEnv(env, 'AGENTIC_OPUS_GLOBAL_MAX_INFLIGHT', 'VALUA_OPUS_GLOBAL_MAX_INFLIGHT', '2')) || 2);
  const authCheckEnabled = parseBooleanEnv(readEnv(env, 'AGENTIC_OPUS_AUTH_CHECK', 'VALUA_OPUS_AUTH_CHECK', '1'), true);
  const streamEnabled = parseBooleanEnv(readEnv(env, 'AGENTIC_OPUS_STREAM', 'VALUA_OPUS_STREAM', '1'), true);
  const heartbeatMs = Math.max(
    1000,
    parsePositiveIntEnv(
      readEnv(env, 'AGENTIC_OPUS_PROGRESS_HEARTBEAT_MS', 'VALUA_OPUS_PROGRESS_HEARTBEAT_MS', '5000'),
      5000,
    ),
  );
  const cooldownMs = Math.max(1000, Number(readEnv(env, 'AGENTIC_OPUS_RATE_LIMIT_COOLDOWN_MS', 'VALUA_OPUS_RATE_LIMIT_COOLDOWN_MS', '10000')) || 10000);

  let lastAuthCheckAtMs = 0;
  let lastAuthResult = { ok: true, reasonCode: '' };

  writePane(
    `[opus-consult] worker online agent=${agentName} model=${model} protocol=${protocolMode} stream=${streamEnabled ? 'on' : 'off'} cwdMode=${cwdMode} tools=${toolsMode} projectRoot=${projectRoot}\n`,
  );

  while (true) {
    const idsInProgress = await listInboxTaskIds({ busRoot, agentName, state: 'in_progress' });
    const idsNew = await listInboxTaskIds({ busRoot, agentName, state: 'new' });
    const idsSeen = await listInboxTaskIds({ busRoot, agentName, state: 'seen' });
    const inProgressSet = new Set(idsInProgress);
    const ids = Array.from(new Set([...idsInProgress, ...idsNew, ...idsSeen]));

    for (const id of ids) {
      let opened = null;
      try {
        opened = inProgressSet.has(id)
          ? await openTask({ busRoot, agentName, taskId: id, markSeen: false })
          : await claimTask({ busRoot, agentName, taskId: id });
      } catch (err) {
        writePane(`WARN: could not claim task ${id}: ${(err && err.message) || String(err)}\n`);
        continue;
      }

      const kind = readString(opened?.meta?.signals?.kind);
      let outcome = 'done';
      let note = '';
      let receiptExtra = {};
      writePane(`[opus-consult] task claimed id=${id} kind=${kind || 'unknown'}\n`);

      try {
        if (kind !== 'OPUS_CONSULT_REQUEST') {
          outcome = 'blocked';
          note = `unsupported kind for opus-consult worker: ${kind || 'unknown'}`;
          receiptExtra = {
            reasonCode: 'opus_consult_protocol_invalid',
          };
        } else {
          const requestValidation = validateOpusConsultRequestMeta(opened.meta);
          const rawPayload = extractOpusPayload(opened.meta) || {};
          if (!requestValidation.ok || !requestValidation.value?.payload) {
            const fallbackPayload = makeOpusBlockPayload({
              consultId: rawPayload.consultId,
              round: rawPayload.round,
              reasonCode: 'opus_schema_invalid',
              rationale: `Consult request schema invalid: ${requestValidation.errors.join('; ')}`,
              requiredActions: ['Fix consult request payload/schema and retry.'],
            });
            await deliverConsultResponse({
              busRoot,
              agentName,
              opened,
              responsePayload: fallbackPayload,
            });
            outcome = 'blocked';
            note = 'consult request schema invalid';
            receiptExtra = {
              reasonCode: 'opus_schema_invalid',
              errors: requestValidation.errors,
            };
          } else {
            let skipConsultExecution = false;
            if (!stubBin && authCheckEnabled) {
              const now = Date.now();
              if (now - lastAuthCheckAtMs > 60_000 || !lastAuthResult.ok) {
                lastAuthCheckAtMs = now;
                lastAuthResult = await checkClaudeAuth({ claudeBin, cwd: projectRoot, env, timeoutMs: 15_000 });
              }
              if (!lastAuthResult.ok) {
                const blocked = makeOpusBlockPayload({
                  consultId: requestValidation.value.payload.consultId,
                  round: requestValidation.value.payload.round,
                  reasonCode: 'opus_claude_not_authenticated',
                  rationale:
                    'Claude Code CLI is not authenticated. Run `claude auth login` and confirm Opus model access.',
                  requiredActions: ['Run `claude auth login` and retry consult.'],
                });
                await deliverConsultResponse({
                  busRoot,
                  agentName,
                  opened,
                  responsePayload: blocked,
                });
                outcome = 'blocked';
                note = 'claude auth unavailable';
                receiptExtra = {
                  reasonCode: 'opus_claude_not_authenticated',
                  auth: {
                    stdout: String(lastAuthResult.stdout || '').slice(-2000),
                    stderr: String(lastAuthResult.stderr || '').slice(-2000),
                  },
                };
                skipConsultExecution = true;
              }
            }

            if (!skipConsultExecution) {
              await waitForOpusCooldown({ busRoot });
              const slot = await acquireGlobalSemaphoreSlot({
                busRoot,
                name: `${agentName}:${id}`,
                maxSlots: globalMaxInflight,
                dirName: 'opus-global-semaphore',
              });

              let strictPromptPath = '';
              let freeformPromptPath = '';
              let promptDir = '';
              let providerSchemaPath = '';
              const stdoutStream = createPrefixedChunkWriter('[opus-consult][claude stdout] ');
              const stderrStream = createPrefixedChunkWriter('[opus-consult][claude stderr] ');
              let stopHeartbeat = () => {};
              try {
                const providerSchemaResolved = await resolveProviderSchemaPath({
                  explicitPath: providerSchemaOverride,
                  projectRoot,
                  repoRoot,
                  cockpitRoot,
                });
                providerSchemaPath = providerSchemaResolved.path;
                const tmpDir = path.join(busRoot, 'state', 'opus-consult-tmp', agentName);
                const promptInfo = await buildSystemPromptFiles({
                  roster: rosterInfo.roster,
                  promptDirOverride,
                  projectRoot,
                  repoRoot,
                  cockpitRoot,
                  busRoot,
                  agentName,
                  tmpDir,
                  protocolMode,
                });
                strictPromptPath = promptInfo.strictPromptPath;
                freeformPromptPath = promptInfo.freeformPromptPath || '';
                promptDir = promptInfo.promptDir;
                const requestPayload = requestValidation.value.payload;
                const consultStartedAtMs = Date.now();
                let stdoutBytes = 0;
                let stderrBytes = 0;
                let stdoutChunks = 0;
                let stderrChunks = 0;
                let schemaSanitizedTopLevelCombinators = [];
                writePane(
                  `[opus-consult] consult start consultId=${requestPayload.consultId} phase=${requestPayload.mode} round=${requestPayload.round}/${requestPayload.maxRounds}\n`,
                );
                stopHeartbeat = startProgressHeartbeat({
                  intervalMs: heartbeatMs,
                  onTick: () => {
                    const elapsedSec = Math.max(0, Math.floor((Date.now() - consultStartedAtMs) / 1000));
                    writePane(
                      `[opus-consult] consult heartbeat consultId=${requestPayload.consultId} round=${requestPayload.round}/${requestPayload.maxRounds} elapsed=${elapsedSec}s stdoutChunks=${stdoutChunks} stderrChunks=${stderrChunks} stdoutBytes=${stdoutBytes} stderrBytes=${stderrBytes}\n`,
                    );
                  },
                });
                const handleStdout = (chunk) => {
                  const text = String(chunk || '');
                  if (!text) return;
                  stdoutChunks += 1;
                  stdoutBytes += text.length;
                  if (streamEnabled) stdoutStream.write(text);
                };
                const handleStderr = (chunk) => {
                  const text = String(chunk || '');
                  if (!text) return;
                  stderrChunks += 1;
                  stderrBytes += text.length;
                  if (streamEnabled) stderrStream.write(text);
                };
                const consult = await runOpusConsultCli({
                  requestPayload,
                  providerSchemaPath,
                  systemPromptPath: strictPromptPath,
                  freeformSystemPromptPath: freeformPromptPath,
                  protocolMode,
                  claudeBin,
                  stubBin,
                  model,
                  timeoutMs,
                  maxRetries,
                  tools: toolsValue,
                  cwd: cwdMode === 'project_root' ? projectRoot : repoRoot,
                  addDirs: uniquePaths([projectRoot, repoRoot, cockpitRoot, busRoot]),
                  env,
                  onStdout: handleStdout,
                  onStderr: handleStderr,
                  onEvent: (event) => {
                    if (
                      event?.type === 'schema_sanitized' &&
                      Array.isArray(event.removedTopLevelCombinators)
                    ) {
                      schemaSanitizedTopLevelCombinators = event.removedTopLevelCombinators
                        .map((entry) => readString(entry))
                        .filter(Boolean)
                        .slice(0, 8);
                    }
                    writePane(`${formatConsultEventMessage({
                      consultId: requestPayload.consultId,
                      round: requestPayload.round,
                      maxRounds: requestPayload.maxRounds,
                      event,
                    })}\n`);
                  },
                });

                const freeformSummary = clipText(consult?.freeform?.summary, 2000) || null;
                const freeformText = readString(consult?.freeform?.text);
                const responseRuntime = {
                  protocolMode: readString(consult?.protocolMode) || protocolMode,
                  freeformSummary,
                  freeformChars: Number(consult?.freeform?.chars || 0) || 0,
                  freeformHash: freeformText
                    ? crypto.createHash('sha256').update(freeformText).digest('hex').slice(0, 16)
                    : null,
                  freeformAttempts: Number(consult?.freeform?.attempts || 0) || 0,
                  strictAttempts: Number(consult?.strict?.attempts || consult?.attempts || 0) || 0,
                  stageDurationsMs: {
                    freeform: Number(consult?.freeform?.durationMs || 0) || 0,
                    strict: Number(consult?.strict?.durationMs || 0) || 0,
                  },
                  schemaSanitizedTopLevelCombinators,
                };

                const normalized = normalizeConsultResponsePayload(consult.structuredOutput);
                const responseValidation = validateOpusConsultResponsePayload(normalized.payload);
                const finalPayload = responseValidation.ok
                  ? responseValidation.value
                  : makeOpusBlockPayload({
                      consultId: requestValidation.value.payload.consultId,
                      round: requestValidation.value.payload.round,
                      reasonCode: 'opus_schema_invalid',
                      rationale: `Consult response schema invalid: ${responseValidation.errors.join('; ')}`,
                      requiredActions: ['Fix consult response format and retry.'],
                    });

                const delivered = await deliverConsultResponse({
                  busRoot,
                  agentName,
                  opened,
                  responsePayload: finalPayload,
                  responseRuntime,
                });

                outcome = finalPayload.verdict === 'block' ? 'blocked' : 'done';
                note = `consult response emitted verdict=${finalPayload.verdict}`;
                writePane(
                  `[opus-consult] consult done consultId=${readString(finalPayload.consultId)} verdict=${readString(finalPayload.verdict)} reasonCode=${readString(finalPayload.reasonCode)}\n`,
                );
                receiptExtra = {
                  reasonCode: readString(finalPayload.reasonCode),
                  consultId: readString(finalPayload.consultId),
                  round: Number(finalPayload.round) || 1,
                  verdict: readString(finalPayload.verdict),
                  responseTaskId: delivered.responseTaskId,
                  responseTaskPath: delivered.responseTaskPath,
                  protocolMode: responseRuntime.protocolMode,
                  freeformSummary: responseRuntime.freeformSummary,
                  freeformChars: responseRuntime.freeformChars,
                  freeformHash: responseRuntime.freeformHash,
                  freeformAttempts: responseRuntime.freeformAttempts,
                  strictAttempts: responseRuntime.strictAttempts,
                  stageDurationsMs: responseRuntime.stageDurationsMs,
                  providerSchemaSanitizedTopLevelCombinators:
                    responseRuntime.schemaSanitizedTopLevelCombinators || [],
                  promptDir: promptDir || null,
                  providerSchemaPath: providerSchemaPath || null,
                  skillsLoaded: promptInfo.skillNames || [],
                  skillRoots: promptInfo.skillRoots || [],
                  validationRepairs: normalized.repairs,
                  validationErrors: responseValidation.ok ? [] : responseValidation.errors,
                };
              } catch (err) {
                const normalized = err instanceof OpusClientError
                  ? err
                  : new OpusClientError((err && err.message) || String(err), {
                      reasonCode: 'opus_transient',
                      transient: true,
                    });

                if (normalized.reasonCode === 'opus_rate_limited') {
                  await writeGlobalCooldown({
                    busRoot,
                    retryAtMs: Date.now() + cooldownMs,
                    reason: normalized.message,
                    sourceAgent: agentName,
                    taskId: id,
                    fileName: 'claude-code-rpm-cooldown.json',
                  });
                }

                const fallbackPayload = makeOpusBlockPayload({
                  consultId: requestValidation.value.payload.consultId,
                  round: requestValidation.value.payload.round,
                  reasonCode: normalized.reasonCode,
                  rationale: `Consult execution failed: ${normalized.message}`,
                  requiredActions: ['Review consult worker logs and retry consult.'],
                });
                const delivered = await deliverConsultResponse({
                  busRoot,
                  agentName,
                  opened,
                  responsePayload: fallbackPayload,
                  responseRuntime: {
                    protocolMode,
                    failureStage: readString(normalized.stage) || null,
                  },
                });

                outcome = 'blocked';
                note = `consult failed: ${normalized.reasonCode}`;
                receiptExtra = {
                  reasonCode: normalized.reasonCode,
                  responseTaskId: delivered.responseTaskId,
                  responseTaskPath: delivered.responseTaskPath,
                  protocolMode,
                  failureStage: readString(normalized.stage) || null,
                  promptDir: promptDir || null,
                  providerSchemaPath: providerSchemaPath || null,
                  stdoutTail: String(normalized.stdout || '').slice(-4000),
                  stderrTail: String(normalized.stderr || '').slice(-4000),
                };
              } finally {
                stopHeartbeat();
                if (streamEnabled) {
                  stdoutStream.flush();
                  stderrStream.flush();
                }
                try {
                  if (strictPromptPath) await fs.rm(strictPromptPath, { force: true });
                  if (freeformPromptPath) await fs.rm(freeformPromptPath, { force: true });
                } catch {
                  // ignore prompt cleanup failures
                }
                await slot.release();
              }
            }
          }
        }
      } catch (err) {
        if (err != null) {
          outcome = 'blocked';
          note = `consult worker failed: ${(err && err.message) || String(err)}`;
          receiptExtra = {
            reasonCode: 'opus_transient',
            error: note,
          };
        }
      }

      await closeTask({
        busRoot,
        roster: rosterInfo.roster,
        agentName,
        taskId: id,
        outcome,
        note,
        commitSha: '',
        receiptExtra,
        notifyOrchestrator: false,
      });
    }

    if (once) break;
    await sleep(pollMs);
  }
}

main().catch((err) => {
  writePane(`ERROR: ${(err && err.stack) || String(err)}\n`);
  process.exit(1);
});
