import { promises as fs } from 'node:fs';
import childProcess from 'node:child_process';

function readString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function tailText(value, maxLen = 12000) {
  const text = String(value || '');
  if (text.length <= maxLen) return text;
  return text.slice(-maxLen);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitedText(text) {
  const t = String(text || '').toLowerCase();
  return (
    t.includes('rate limit') ||
    t.includes('too many requests') ||
    t.includes('retry-after') ||
    /\b429\b/.test(t)
  );
}

function isTransientText(text) {
  const t = String(text || '').toLowerCase();
  return (
    t.includes('temporar') ||
    t.includes('econnreset') ||
    t.includes('eai_again') ||
    t.includes('enotfound') ||
    t.includes('timed out') ||
    t.includes('timeout') ||
    t.includes('network error') ||
    t.includes('connection reset')
  );
}

function isNotAuthenticatedText(text) {
  const t = String(text || '').toLowerCase();
  return (
    t.includes('not authenticated') ||
    t.includes('not logged in') ||
    t.includes('please login') ||
    t.includes('claude auth login')
  );
}

function isRefusalText(text) {
  const t = String(text || '').toLowerCase();
  return t.includes('cannot comply') || t.includes('i cannot help') || t.includes('refus');
}

export class OpusClientError extends Error {
  constructor(message, {
    reasonCode,
    transient = false,
    rateLimited = false,
    stdout = '',
    stderr = '',
    timeoutMs = 0,
    stage = '',
  } = {}) {
    super(message);
    this.name = 'OpusClientError';
    this.reasonCode = reasonCode || 'opus_transient';
    this.transient = Boolean(transient);
    this.rateLimited = Boolean(rateLimited);
    this.stdout = tailText(stdout, 12000);
    this.stderr = tailText(stderr, 12000);
    this.timeoutMs = Number(timeoutMs) || 0;
    this.stage = readString(stage);
  }
}

async function runProcess({
  bin,
  args,
  stdinText,
  cwd,
  env,
  timeoutMs,
  onStdout = null,
  onStderr = null,
}) {
  return await new Promise((resolve, reject) => {
    const child = childProcess.spawn(bin, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let killTimer = null;

    const finalize = ({ exitCode, signal }) => {
      if (settled) return;
      settled = true;
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
      resolve({ exitCode, signal, timedOut, stdout, stderr });
    };

    child.stdout.on('data', (chunk) => {
      const text = String(chunk || '');
      stdout += text;
      if (stdout.length > 256_000) stdout = stdout.slice(-256_000);
      if (typeof onStdout === 'function') {
        try {
          onStdout(text);
        } catch (err) {
          process.stderr.write(`[opus-client] onStdout observer error: ${(err && err.message) || String(err)}\n`);
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      const text = String(chunk || '');
      stderr += text;
      if (stderr.length > 256_000) stderr = stderr.slice(-256_000);
      if (typeof onStderr === 'function') {
        try {
          onStderr(text);
        } catch (err) {
          process.stderr.write(`[opus-client] onStderr observer error: ${(err && err.message) || String(err)}\n`);
        }
      }
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
      reject(err);
    });

    child.on('close', (code, signal) => finalize({ exitCode: code ?? 1, signal }));

    if (stdinText) child.stdin.write(String(stdinText));
    child.stdin.end();

    const timeout = Math.max(1, Number(timeoutMs) || 3_600_000);
    killTimer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
      setTimeout(() => {
        if (settled) return;
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }, 2_000).unref?.();
    }, timeout);
    killTimer.unref?.();
  });
}

function parseStructuredOutput(stdoutText) {
  const text = String(stdoutText || '').trim();
  if (!text) {
    throw new OpusClientError('claude output empty', {
      reasonCode: 'opus_schema_invalid',
      transient: true,
      stdout: stdoutText,
    });
  }

  const tryJsonParse = (raw) => {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };

  let parsed = tryJsonParse(text);
  if (!parsed) {
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      parsed = tryJsonParse(lines[i]);
      if (parsed) break;
    }
  }
  if (!parsed) {
    throw new OpusClientError('claude output is not valid JSON', {
      reasonCode: 'opus_schema_invalid',
      transient: true,
      stdout: stdoutText,
    });
  }

  const structured =
    parsed?.structured_output ??
    parsed?.result?.structured_output ??
    parsed?.output?.structured_output ??
    null;

  if (structured && typeof structured === 'object' && !Array.isArray(structured)) {
    return structured;
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof parsed.verdict === 'string') {
    return parsed;
  }

  throw new OpusClientError('claude output missing structured_output object', {
    reasonCode: 'opus_schema_invalid',
    transient: true,
    stdout: stdoutText,
  });
}

function parseFreeformOutput(stdoutText) {
  const text = String(stdoutText || '').trim();
  if (!text) {
    throw new OpusClientError('claude freeform output empty', {
      reasonCode: 'opus_schema_invalid',
      transient: true,
      stdout: stdoutText,
      stage: 'freeform',
    });
  }
  return text;
}

function summarizeForStrictPass(value, maxLen = 4000) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}...`;
}

function normalizeProtocolMode(value) {
  const raw = readString(value).toLowerCase();
  if (raw === 'strict_only') return 'strict_only';
  return 'dual_pass';
}

export function sanitizeProviderSchemaForClaude(inputSchema) {
  if (!isPlainObject(inputSchema)) {
    throw new OpusClientError('provider schema root must be an object', {
      reasonCode: 'opus_schema_invalid',
      transient: false,
    });
  }
  const schema = { ...inputSchema };
  const removedTopLevelCombinators = [];
  for (const key of ['oneOf', 'allOf', 'anyOf']) {
    if (Object.prototype.hasOwnProperty.call(schema, key)) {
      delete schema[key];
      removedTopLevelCombinators.push(key);
    }
  }
  return {
    schema,
    removedTopLevelCombinators,
  };
}

function classifyConsultFailure({ message, combined, stdout, stderr, timeoutMs, stage }) {
  if (isNotAuthenticatedText(combined)) {
    return new OpusClientError('claude is not authenticated', {
      reasonCode: 'opus_claude_not_authenticated',
      transient: false,
      stdout,
      stderr,
      stage,
    });
  }
  if (isRateLimitedText(combined)) {
    return new OpusClientError('claude consult rate limited', {
      reasonCode: 'opus_rate_limited',
      transient: true,
      rateLimited: true,
      stdout,
      stderr,
      stage,
    });
  }
  if (isRefusalText(combined)) {
    return new OpusClientError('claude consult refusal', {
      reasonCode: 'opus_refusal',
      transient: false,
      stdout,
      stderr,
      stage,
    });
  }
  const transient = isTransientText(combined);
  return new OpusClientError(message, {
    reasonCode: transient ? 'opus_transient' : 'opus_schema_invalid',
    transient,
    stdout,
    stderr,
    timeoutMs,
    stage,
  });
}

function buildConsultArgs({
  model,
  tools,
  addDirs,
  systemPromptPath,
  query,
  schemaOneLine = '',
}) {
  const args = [
    '-p',
    '--model',
    readString(model) || 'claude-opus-4-6',
    '--system-prompt-file',
    systemPromptPath,
  ];
  if (schemaOneLine) {
    args.push('--output-format', 'json', '--json-schema', schemaOneLine);
  }
  const toolsArg = readString(tools);
  if (toolsArg) {
    args.push('--tools', toolsArg);
  }
  const dirList = Array.isArray(addDirs)
    ? Array.from(new Set(addDirs.map((dir) => readString(dir)).filter(Boolean)))
    : [];
  for (const dir of dirList) args.push('--add-dir', dir);
  args.push('--no-session-persistence', query);
  return args;
}

async function executeConsultStage({
  stage,
  bin,
  args,
  stdinText,
  cwd,
  env,
  timeoutMs,
  retryBudget,
  parseOutput,
  onStdout,
  onStderr,
  emitEvent,
}) {
  const maxAttempts = retryBudget + 1;
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      emitEvent({ type: 'attempt_start', stage, attempt, maxAttempts });
      const startedAt = Date.now();
      const res = await runProcess({
        bin,
        args,
        stdinText,
        cwd,
        env,
        timeoutMs,
        onStdout,
        onStderr,
      });

      if (res.timedOut) {
        throw new OpusClientError(`claude ${stage} consult timed out after ${timeoutMs}ms`, {
          reasonCode: 'opus_timeout',
          transient: true,
          stdout: res.stdout,
          stderr: res.stderr,
          timeoutMs,
          stage,
        });
      }

      const combined = `${res.stdout}\n${res.stderr}`;
      if (res.exitCode !== 0) {
        throw classifyConsultFailure({
          message: `claude ${stage} consult failed`,
          combined,
          stdout: res.stdout,
          stderr: res.stderr,
          timeoutMs,
          stage,
        });
      }

      const parsed = parseOutput(res.stdout);
      emitEvent({
        type: 'attempt_success',
        stage,
        attempt,
        maxAttempts,
        stdoutBytes: String(res.stdout || '').length,
        stderrBytes: String(res.stderr || '').length,
      });
      return {
        stage,
        attempts: attempt,
        durationMs: Math.max(0, Date.now() - startedAt),
        parsed,
        stdout: res.stdout,
        stderr: res.stderr,
      };
    } catch (err) {
      const normalized =
        err instanceof OpusClientError
          ? err
          : new OpusClientError((err && err.message) || String(err), {
              reasonCode: 'opus_transient',
              transient: true,
              stage,
            });
      if (!normalized.stage) normalized.stage = stage;
      lastError = normalized;
      const shouldRetry = normalized.transient && attempt <= retryBudget;
      emitEvent({
        type: shouldRetry ? 'attempt_retry' : 'attempt_failed',
        stage,
        attempt,
        maxAttempts,
        reasonCode: normalized.reasonCode,
        transient: normalized.transient,
        rateLimited: normalized.rateLimited,
      });
      if (!shouldRetry) break;
      const backoffMs = Math.min(1000 * attempt, 5000);
      emitEvent({ type: 'attempt_backoff', stage, attempt, maxAttempts, backoffMs });
      await sleep(backoffMs);
    }
  }

  throw (
    lastError ||
    new OpusClientError('claude consult failed', {
      reasonCode: 'opus_transient',
      transient: true,
      stage,
    })
  );
}

export async function checkClaudeAuth({ claudeBin = 'claude', cwd = process.cwd(), env = process.env, timeoutMs = 15000 } = {}) {
  const res = await runProcess({
    bin: claudeBin,
    args: ['auth', 'status'],
    stdinText: '',
    cwd,
    env,
    timeoutMs,
  });
  const combined = `${res.stdout}\n${res.stderr}`;
  if (res.timedOut) {
    return { ok: false, reasonCode: 'opus_timeout', stdout: res.stdout, stderr: res.stderr };
  }
  if (res.exitCode !== 0 || isNotAuthenticatedText(combined)) {
    return { ok: false, reasonCode: 'opus_claude_not_authenticated', stdout: res.stdout, stderr: res.stderr };
  }
  return { ok: true, reasonCode: '', stdout: res.stdout, stderr: res.stderr };
}

export async function runOpusConsultCli({
  requestPayload,
  providerSchemaPath,
  systemPromptPath,
  freeformSystemPromptPath = '',
  protocolMode = 'dual_pass',
  claudeBin = 'claude',
  stubBin = '',
  model = 'claude-opus-4-6',
  timeoutMs = 3_600_000,
  maxRetries = 2,
  tools = null,
  addDirs = [],
  cwd = process.cwd(),
  env = process.env,
  onStdout = null,
  onStderr = null,
  onEvent = null,
}) {
  const emitEvent = (event) => {
    if (typeof onEvent !== 'function' || !event || typeof event !== 'object') return;
    try {
      onEvent(event);
    } catch {
      // do not allow telemetry observers to break consult execution
    }
  };

  const schemaRaw = await fs.readFile(providerSchemaPath, 'utf8');
  let providerSchemaParsed = null;
  try {
    providerSchemaParsed = JSON.parse(schemaRaw);
  } catch (err) {
    throw new OpusClientError('provider schema is not valid JSON', {
      reasonCode: 'opus_schema_invalid',
      transient: false,
      stderr: (err && err.message) || String(err),
    });
  }
  const {
    schema: providerSchemaForClaude,
    removedTopLevelCombinators,
  } = sanitizeProviderSchemaForClaude(providerSchemaParsed);
  if (removedTopLevelCombinators.length > 0) {
    emitEvent({
      type: 'schema_sanitized',
      removedTopLevelCombinators,
    });
  }
  const schemaOneLine = JSON.stringify(providerSchemaForClaude);
  const bin = readString(stubBin) || readString(claudeBin) || 'claude';

  const retryBudget = Math.max(0, Number(maxRetries) || 0);
  const normalizedProtocolMode = normalizeProtocolMode(protocolMode);
  const freeformPromptPath = readString(freeformSystemPromptPath) || systemPromptPath;

  const strictQuery = 'Process the consult request in stdin. Return ONLY structured_output.';
  const strictArgs = buildConsultArgs({
    model,
    tools,
    addDirs,
    systemPromptPath,
    query: strictQuery,
    schemaOneLine,
  });

  /** @type {null | {stage:string,attempts:number,durationMs:number,parsed:any,stdout:string,stderr:string}} */
  let freeformStage = null;
  /** @type {any} */
  let strictRequestPayload = requestPayload;

  if (normalizedProtocolMode === 'dual_pass') {
    emitEvent({ type: 'stage_start', stage: 'freeform' });
    const freeformQuery =
      'Analyze the consult request in stdin and return concise markdown guidance only (no JSON).';
    const freeformArgs = buildConsultArgs({
      model,
      tools,
      addDirs,
      systemPromptPath: freeformPromptPath,
      query: freeformQuery,
      schemaOneLine: '',
    });
    freeformStage = await executeConsultStage({
      stage: 'freeform',
      bin,
      args: freeformArgs,
      stdinText: JSON.stringify(requestPayload),
      cwd,
      env,
      timeoutMs,
      retryBudget,
      parseOutput: parseFreeformOutput,
      onStdout,
      onStderr,
      emitEvent,
    });
    emitEvent({
      type: 'stage_done',
      stage: 'freeform',
      durationMs: freeformStage.durationMs,
      attempts: freeformStage.attempts,
    });
    const freeformText = String(freeformStage.parsed || '');
    strictRequestPayload = {
      ...(requestPayload && typeof requestPayload === 'object' ? requestPayload : {}),
      freeform_consult_text: tailText(freeformText, 8_000),
      freeform_consult_summary: summarizeForStrictPass(freeformText, 2000),
      freeform_consult_meta: {
        chars: freeformText.length,
        attempts: freeformStage.attempts,
        durationMs: freeformStage.durationMs,
      },
    };
  }

  emitEvent({ type: 'stage_start', stage: 'strict' });
  const strictStage = await executeConsultStage({
    stage: 'strict',
    bin,
    args: strictArgs,
    stdinText: JSON.stringify(strictRequestPayload),
    cwd,
    env,
    timeoutMs,
    retryBudget,
    parseOutput: parseStructuredOutput,
    onStdout,
    onStderr,
    emitEvent,
  });
  emitEvent({
    type: 'stage_done',
    stage: 'strict',
    durationMs: strictStage.durationMs,
    attempts: strictStage.attempts,
  });

  const freeformText = String(freeformStage?.parsed || '');
  return {
    protocolMode: normalizedProtocolMode,
    attempts: strictStage.attempts,
    structuredOutput: strictStage.parsed,
    rawStdout: tailText(strictStage.stdout, 32_000),
    rawStderr: tailText(strictStage.stderr, 12_000),
    freeform:
      normalizedProtocolMode === 'dual_pass'
        ? {
            text: tailText(freeformText, 8_000),
            summary: summarizeForStrictPass(freeformText, 2000),
            chars: freeformText.length,
            attempts: Number(freeformStage?.attempts || 0),
            durationMs: Number(freeformStage?.durationMs || 0),
          }
        : null,
    strict: {
      attempts: strictStage.attempts,
      durationMs: strictStage.durationMs,
      stdoutBytes: String(strictStage.stdout || '').length,
      stderrBytes: String(strictStage.stderr || '').length,
    },
  };
}
