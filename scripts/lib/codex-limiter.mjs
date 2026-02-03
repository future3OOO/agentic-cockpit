import { promises as fs } from 'node:fs';
import path from 'node:path';

function normalizeText(value) {
  return String(value ?? '').replace(/\r\n/g, '\n');
}

function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return false;
  try {
    // Signal 0 performs a permission/existence check without sending a real signal.
    process.kill(n, 0);
    return true;
  } catch (err) {
    // ESRCH: pid does not exist. EINVAL: invalid signal/pid.
    if (err && (err.code === 'ESRCH' || err.code === 'EINVAL')) return false;
    // EPERM (or anything else): treat as alive to avoid deleting a live slot.
    return true;
  }
}

export function isOpenAIRateLimitText(text) {
  const t = normalizeText(text).toLowerCase();
  return (
    t.includes('rate limit reached') ||
    t.includes('requests per min') ||
    t.includes('requests per minute') ||
    t.includes('too many requests') ||
    /\b429\b/.test(t)
  );
}

export function isStreamDisconnectedText(text) {
  const t = normalizeText(text).toLowerCase();
  return t.includes('stream disconnected before completion');
}

export function parseRetryAfterMs(text) {
  const t = normalizeText(text);

  // Common OpenAI phrasing (observed):
  // "Please try again in 20ms."
  // "Please try again in 2s."
  {
    const m = /try again in\s+(\d+(?:\.\d+)?)\s*(ms|s)\b/i.exec(t);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n >= 0) return m[2].toLowerCase() === 's' ? Math.ceil(n * 1000) : Math.ceil(n);
    }
  }

  // Retry-After header text (seconds).
  {
    const m = /retry-after\s*:\s*(\d+(?:\.\d+)?)/i.exec(t);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n >= 0) return Math.ceil(n * 1000);
    }
  }

  return null;
}

export function computeBackoffMs(attempt, { baseMs = 250, maxMs = 30_000, jitterMs = 250 } = {}) {
  const a = Math.max(1, Number(attempt) || 1);
  const pow = Math.min(16, a - 1);
  const exp = Math.min(maxMs, baseMs * Math.pow(2, pow));
  const jitter = Math.floor(Math.random() * Math.max(0, jitterMs));
  return Math.min(maxMs, exp + jitter);
}

export async function readGlobalCooldown({ busRoot }) {
  const p = path.join(busRoot, 'state', 'openai-rpm-cooldown.json');
  try {
    const raw = await fs.readFile(p, 'utf8');
    const parsed = JSON.parse(raw);
    const retryAtMs = typeof parsed?.retryAtMs === 'number' ? parsed.retryAtMs : null;
    if (!retryAtMs || !Number.isFinite(retryAtMs)) return null;
    return { path: p, retryAtMs, payload: parsed };
  } catch {
    return null;
  }
}

export async function writeGlobalCooldown({ busRoot, retryAtMs, reason, sourceAgent, taskId }) {
  const dir = path.join(busRoot, 'state');
  await fs.mkdir(dir, { recursive: true });
  const p = path.join(dir, 'openai-rpm-cooldown.json');
  const tmp = `${p}.tmp.${Math.random().toString(16).slice(2)}`;

  const existing = await readGlobalCooldown({ busRoot });
  const currentRetryAtMs = existing?.retryAtMs ?? null;
  if (currentRetryAtMs && currentRetryAtMs >= retryAtMs) return p;

  const payload = {
    updatedAt: new Date().toISOString(),
    retryAtMs,
    retryAtIso: new Date(retryAtMs).toISOString(),
    reason: String(reason || '').slice(0, 500),
    sourceAgent: String(sourceAgent || ''),
    taskId: String(taskId || ''),
  };

  await fs.writeFile(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, p);
  return p;
}

export async function acquireGlobalSemaphoreSlot({
  busRoot,
  name,
  maxSlots,
  staleMs = 2 * 60 * 60 * 1000,
}) {
  const slots = Math.max(1, Number(maxSlots) || 1);
  const dir = path.join(busRoot, 'state', 'codex-global-semaphore');
  await fs.mkdir(dir, { recursive: true });

  async function cleanupStale() {
    let files = [];
    try {
      files = await fs.readdir(dir);
    } catch {
      return;
    }
    const now = Date.now();
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const p = path.join(dir, f);
      try {
        const st = await fs.stat(p);
        const ageMs = now - st.mtimeMs;
        if (ageMs < 0) continue;

        // Fast path: if the owning pid is gone, release immediately (avoid multi-hour stalls).
        let pid = null;
        try {
          const raw = await fs.readFile(p, 'utf8');
          const parsed = JSON.parse(raw);
          pid = typeof parsed?.pid === 'number' ? parsed.pid : Number(parsed?.pid);
        } catch {
          pid = null;
        }
        if (pid && !isPidAlive(pid)) {
          await fs.unlink(p);
          continue;
        }

        if (ageMs < staleMs) continue;
        await fs.unlink(p);
      } catch {
        // ignore
      }
    }
  }

  while (true) {
    await cleanupStale();

    for (let i = 0; i < slots; i += 1) {
      const p = path.join(dir, `slot-${i}.json`);
      try {
        const fh = await fs.open(p, 'wx');
        try {
          await fh.writeFile(
            JSON.stringify({ acquiredAt: new Date().toISOString(), pid: process.pid, name: String(name || '') }) + '\n',
            'utf8',
          );
        } finally {
          await fh.close();
        }
        return {
          slotPath: p,
          release: async () => {
            try {
              await fs.unlink(p);
            } catch {
              // ignore
            }
          },
        };
      } catch (err) {
        if (err && err.code === 'EEXIST') continue;
        // Unexpected FS error; don't spin.
        throw err;
      }
    }

    await new Promise((r) => setTimeout(r, 200));
  }
}
