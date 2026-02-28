import { promises as fs } from 'node:fs';
import childProcess from 'node:child_process';

function readString(value) {
  return typeof value === 'string' ? value.trim() : '';
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
  constructor(message, { reasonCode, transient = false, rateLimited = false, stdout = '', stderr = '', timeoutMs = 0 } = {}) {
    super(message);
    this.name = 'OpusClientError';
    this.reasonCode = reasonCode || 'opus_transient';
    this.transient = Boolean(transient);
    this.rateLimited = Boolean(rateLimited);
    this.stdout = tailText(stdout, 12000);
    this.stderr = tailText(stderr, 12000);
    this.timeoutMs = Number(timeoutMs) || 0;
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
        } catch {
          // ignore observer errors; never break consult execution
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
        } catch {
          // ignore observer errors; never break consult execution
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

    const timeout = Math.max(1, Number(timeoutMs) || 45_000);
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
      reasonCode: 'opus_invalid_json',
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
      reasonCode: 'opus_invalid_json',
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
  claudeBin = 'claude',
  stubBin = '',
  model = 'claude-opus-4-6',
  timeoutMs = 45_000,
  maxRetries = 2,
  cwd = process.cwd(),
  env = process.env,
  onStdout = null,
  onStderr = null,
}) {
  const schemaRaw = await fs.readFile(providerSchemaPath, 'utf8');
  const schemaOneLine = JSON.stringify(JSON.parse(schemaRaw));
  const query = 'Process the consult request in stdin. Return ONLY structured_output.';
  const stdinText = JSON.stringify(requestPayload);
  const bin = readString(stubBin) || readString(claudeBin) || 'claude';

  const args = [
    '-p',
    '--model',
    readString(model) || 'claude-opus-4-6',
    '--output-format',
    'json',
    '--json-schema',
    schemaOneLine,
    '--system-prompt-file',
    systemPromptPath,
    '--tools',
    '',
    '--disable-slash-commands',
    '--no-session-persistence',
    query,
  ];

  const retryBudget = Math.max(0, Number(maxRetries) || 0);
  let lastError = null;
  for (let attempt = 1; attempt <= retryBudget + 1; attempt += 1) {
    try {
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

      const combined = `${res.stdout}\n${res.stderr}`;
      if (res.timedOut) {
        throw new OpusClientError(`claude consult timed out after ${timeoutMs}ms`, {
          reasonCode: 'opus_timeout',
          transient: true,
          stdout: res.stdout,
          stderr: res.stderr,
          timeoutMs,
        });
      }

      if (res.exitCode !== 0) {
        const rateLimited = isRateLimitedText(combined);
        if (isNotAuthenticatedText(combined)) {
          throw new OpusClientError('claude is not authenticated', {
            reasonCode: 'opus_claude_not_authenticated',
            transient: false,
            stdout: res.stdout,
            stderr: res.stderr,
          });
        }
        if (rateLimited) {
          throw new OpusClientError('claude consult rate limited', {
            reasonCode: 'opus_rate_limited',
            transient: true,
            rateLimited: true,
            stdout: res.stdout,
            stderr: res.stderr,
          });
        }
        if (isRefusalText(combined)) {
          throw new OpusClientError('claude consult refusal', {
            reasonCode: 'opus_refusal',
            transient: false,
            stdout: res.stdout,
            stderr: res.stderr,
          });
        }
        throw new OpusClientError('claude consult failed', {
          reasonCode: isTransientText(combined) ? 'opus_transient' : 'opus_transient',
          transient: true,
          stdout: res.stdout,
          stderr: res.stderr,
        });
      }

      const structuredOutput = parseStructuredOutput(res.stdout);
      return {
        attempts: attempt,
        structuredOutput,
        rawStdout: tailText(res.stdout, 32_000),
        rawStderr: tailText(res.stderr, 12_000),
      };
    } catch (err) {
      const normalized =
        err instanceof OpusClientError
          ? err
          : new OpusClientError((err && err.message) || String(err), {
              reasonCode: 'opus_transient',
              transient: true,
            });
      lastError = normalized;
      const shouldRetry = normalized.transient && attempt <= retryBudget;
      if (!shouldRetry) break;
      const backoffMs = Math.min(1000 * attempt, 5000);
      await sleep(backoffMs);
    }
  }

  throw (
    lastError ||
    new OpusClientError('claude consult failed', {
      reasonCode: 'opus_transient',
      transient: true,
    })
  );
}
