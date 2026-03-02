import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import {
  acquireGlobalSemaphoreSlot,
  parseRetryAfterMs,
  readGlobalCooldown,
  writeGlobalCooldown,
} from '../lib/codex-limiter.mjs';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

test('parseRetryAfterMs: parses common forms', () => {
  assert.equal(parseRetryAfterMs('Please try again in 20ms.'), 20);
  assert.equal(parseRetryAfterMs('Please try again in 2s.'), 2000);
  assert.equal(parseRetryAfterMs('Retry-After: 1'), 1000);
  assert.equal(parseRetryAfterMs('nope'), null);
});

test('acquireGlobalSemaphoreSlot: blocks when full', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'valua-codex-limiter-test-'));
  const busRoot = path.join(tmp, 'bus');
  await fs.mkdir(path.join(busRoot, 'state'), { recursive: true });

  const slot1 = await acquireGlobalSemaphoreSlot({ busRoot, name: 'slot1', maxSlots: 1 });

  let acquired2 = false;
  const p2 = (async () => {
    const slot2 = await acquireGlobalSemaphoreSlot({ busRoot, name: 'slot2', maxSlots: 1 });
    acquired2 = true;
    await slot2.release();
  })();

  await sleep(50);
  assert.equal(acquired2, false);

  await slot1.release();

  await Promise.race([p2, sleep(1000).then(() => { throw new Error('timeout acquiring second slot'); })]);
  assert.equal(acquired2, true);
});

test('acquireGlobalSemaphoreSlot: clears dead-pid slot files', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'valua-codex-limiter-test-'));
  const busRoot = path.join(tmp, 'bus');
  const dir = path.join(busRoot, 'state', 'codex-global-semaphore');
  await fs.mkdir(dir, { recursive: true });

  // Simulate a leaked slot from a worker that died mid-task.
  const deadPid = process.pid + 10_000_000;
  await fs.writeFile(
    path.join(dir, 'slot-0.json'),
    JSON.stringify({ acquiredAt: new Date().toISOString(), pid: deadPid, name: 'dead' }) + '\n',
    'utf8',
  );

  const slot = await Promise.race([
    acquireGlobalSemaphoreSlot({ busRoot, name: 'live', maxSlots: 1, staleMs: 2 * 60 * 60 * 1000 }),
    sleep(1000).then(() => {
      throw new Error('timeout acquiring slot after dead-pid cleanup');
    }),
  ]);
  await slot.release();
});

test('cooldown file names are namespace-isolated', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'valua-codex-limiter-test-'));
  const busRoot = path.join(tmp, 'bus');
  await fs.mkdir(path.join(busRoot, 'state'), { recursive: true });

  const retryAtMs = Date.now() + 10_000;
  await writeGlobalCooldown({
    busRoot,
    retryAtMs,
    reason: 'opus throttle',
    sourceAgent: 'opus-consult',
    taskId: 't1',
    fileName: 'claude-code-rpm-cooldown.json',
  });

  const defaultCooldown = await readGlobalCooldown({ busRoot });
  const opusCooldown = await readGlobalCooldown({ busRoot, fileName: 'claude-code-rpm-cooldown.json' });

  assert.equal(defaultCooldown, null);
  assert.ok(opusCooldown && Number(opusCooldown.retryAtMs) === retryAtMs);
});

test('semaphore dirName isolates slot domains', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'valua-codex-limiter-test-'));
  const busRoot = path.join(tmp, 'bus');
  await fs.mkdir(path.join(busRoot, 'state'), { recursive: true });

  const slotCodex = await acquireGlobalSemaphoreSlot({
    busRoot,
    name: 'codex-slot',
    maxSlots: 1,
    dirName: 'codex-global-semaphore',
  });
  const slotOpus = await acquireGlobalSemaphoreSlot({
    busRoot,
    name: 'opus-slot',
    maxSlots: 1,
    dirName: 'opus-global-semaphore',
  });

  await slotCodex.release();
  await slotOpus.release();
});
