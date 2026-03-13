import childProcess from 'node:child_process';

/**
 * Executes a command and returns trimmed stdout or null on failure.
 */
export function safeExecText(cmd, args, { cwd, timeoutMs = 0 } = {}) {
  try {
    const raw = childProcess.execFileSync(cmd, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(Number.isFinite(timeoutMs) && timeoutMs > 0 ? { timeout: Math.max(1, Math.floor(timeoutMs)) } : {}),
    });
    return String(raw ?? '').trim() || null;
  } catch {
    return null;
  }
}
