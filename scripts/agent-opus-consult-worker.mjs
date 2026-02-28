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
    const skillsPath = path.join(promptDir, 'OPUS_SKILLS.md');
    if ((await fileExists(instructionsPath)) && (await fileExists(skillsPath))) {
      return {
        promptDir,
        instructionsPath,
        skillsPath,
        candidates: promptDirs,
      };
    }
  }
  throw new OpusClientError('Opus prompt assets missing', {
    reasonCode: 'opus_prompt_assets_missing',
    transient: false,
    stderr: `searched prompt dirs: ${promptDirs.join(', ')}`,
  });
}

async function buildSystemPromptFile({ promptDirOverride, projectRoot, repoRoot, cockpitRoot, tmpDir }) {
  const resolved = await resolvePromptAssets({ promptDirOverride, projectRoot, repoRoot, cockpitRoot });
  const [instructions, skills] = await Promise.all([
    fs.readFile(resolved.instructionsPath, 'utf8'),
    fs.readFile(resolved.skillsPath, 'utf8'),
  ]);

  const combined = [
    'You are the opus-consult worker for Agentic Cockpit.',
    'You are advisory-only: never mutate code or run tools.',
    'Return only schema-compliant structured_output.',
    '',
    '## Instructions',
    instructions,
    '',
    '## Skills',
    skills,
    '',
  ].join('\n');

  await fs.mkdir(tmpDir, { recursive: true });
  const outPath = path.join(tmpDir, `opus-system-prompt-${process.pid}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.txt`);
  await fs.writeFile(outPath, combined, 'utf8');
  return {
    filePath: outPath,
    promptDir: resolved.promptDir,
    candidates: resolved.candidates,
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
  const timeoutMs = Math.max(1000, Number(readEnv(env, 'AGENTIC_OPUS_TIMEOUT_MS', 'VALUA_OPUS_TIMEOUT_MS', '45000')) || 45000);
  const maxRetries = Math.max(0, Number(readEnv(env, 'AGENTIC_OPUS_MAX_RETRIES', 'VALUA_OPUS_MAX_RETRIES', '0')) || 0);
  const globalMaxInflight = Math.max(1, Number(readEnv(env, 'AGENTIC_OPUS_GLOBAL_MAX_INFLIGHT', 'VALUA_OPUS_GLOBAL_MAX_INFLIGHT', '2')) || 2);
  const authCheckEnabled = parseBooleanEnv(readEnv(env, 'AGENTIC_OPUS_AUTH_CHECK', 'VALUA_OPUS_AUTH_CHECK', '1'), true);
  const streamEnabled = parseBooleanEnv(readEnv(env, 'AGENTIC_OPUS_STREAM', 'VALUA_OPUS_STREAM', '1'), true);
  const cooldownMs = Math.max(1000, Number(readEnv(env, 'AGENTIC_OPUS_RATE_LIMIT_COOLDOWN_MS', 'VALUA_OPUS_RATE_LIMIT_COOLDOWN_MS', '10000')) || 10000);

  let lastAuthCheckAtMs = 0;
  let lastAuthResult = { ok: true, reasonCode: '' };

  writePane(
    `[opus-consult] worker online agent=${agentName} model=${model} stream=${streamEnabled ? 'on' : 'off'} projectRoot=${projectRoot}\n`,
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

              let promptPath = null;
              let promptDir = '';
              let providerSchemaPath = '';
              const stdoutStream = createPrefixedChunkWriter('[opus-consult][claude stdout] ');
              const stderrStream = createPrefixedChunkWriter('[opus-consult][claude stderr] ');
              try {
                const providerSchemaResolved = await resolveProviderSchemaPath({
                  explicitPath: providerSchemaOverride,
                  projectRoot,
                  repoRoot,
                  cockpitRoot,
                });
                providerSchemaPath = providerSchemaResolved.path;
                const tmpDir = path.join(busRoot, 'state', 'opus-consult-tmp', agentName);
                const promptInfo = await buildSystemPromptFile({
                  promptDirOverride,
                  projectRoot,
                  repoRoot,
                  cockpitRoot,
                  tmpDir,
                });
                promptPath = promptInfo.filePath;
                promptDir = promptInfo.promptDir;
                const requestPayload = requestValidation.value.payload;
                writePane(
                  `[opus-consult] consult start consultId=${requestPayload.consultId} phase=${requestPayload.mode} round=${requestPayload.round}/${requestPayload.maxRounds}\n`,
                );
                const consult = await runOpusConsultCli({
                  requestPayload,
                  providerSchemaPath,
                  systemPromptPath: promptPath,
                  claudeBin,
                  stubBin,
                  model,
                  timeoutMs,
                  maxRetries,
                  cwd: projectRoot,
                  env,
                  onStdout: streamEnabled ? (chunk) => stdoutStream.write(chunk) : null,
                  onStderr: streamEnabled ? (chunk) => stderrStream.write(chunk) : null,
                });

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
                  promptDir: promptDir || null,
                  providerSchemaPath: providerSchemaPath || null,
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
                });

                outcome = 'blocked';
                note = `consult failed: ${normalized.reasonCode}`;
                receiptExtra = {
                  reasonCode: normalized.reasonCode,
                  responseTaskId: delivered.responseTaskId,
                  responseTaskPath: delivered.responseTaskPath,
                  promptDir: promptDir || null,
                  providerSchemaPath: providerSchemaPath || null,
                  stdoutTail: String(normalized.stdout || '').slice(-4000),
                  stderrTail: String(normalized.stderr || '').slice(-4000),
                };
              } finally {
                if (streamEnabled) {
                  stdoutStream.flush();
                  stderrStream.flush();
                }
                try {
                  if (promptPath) await fs.rm(promptPath, { force: true });
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
