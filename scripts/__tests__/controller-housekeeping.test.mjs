import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import {
  buildControllerHousekeepingReplayTask,
  readControllerHousekeepingState,
  stageControllerHousekeepingSuspension,
} from '../lib/controller-housekeeping.mjs';

async function makeBusRoot(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function buildOpenedMeta({ id, rootId, title = 'blocked root', sourceAgent = '', sourceReferences = null } = {}) {
  return {
    id,
    to: ['daddy-autopilot'],
    from: 'daddy-orchestrator',
    priority: 'P1',
    title,
    signals: {
      kind: 'ORCHESTRATOR_UPDATE',
      phase: 'review-fix',
      rootId,
      parentId: 'parent-1',
      smoke: false,
    },
    references: {
      ...(sourceAgent ? { sourceAgent } : {}),
      ...(sourceReferences ? { sourceReferences } : {}),
    },
  };
}

test('controller-housekeeping: first suspension creates queued state and deterministic task contract', async () => {
  const busRoot = await makeBusRoot('agentic-controller-housekeeping-');
  const staged = await stageControllerHousekeepingSuspension({
    busRoot,
    agentName: 'daddy-autopilot',
    fingerprint: 'fp-1',
    branch: 'wip/root',
    headSha: 'abc1234',
    repoCommonGitDir: '/tmp/repo/.git',
    recoverableStatusPorcelain: '?? .codex/skill-ops/logs/2026-03/pending.md',
    openedMeta: buildOpenedMeta({
      id: 'task-1',
      rootId: 'root-1',
      sourceAgent: 'observer:pr',
      sourceReferences: { pr: { number: 123 } },
    }),
    openedBody: 'original body',
  });

  assert.equal(staged.action, 'queue');
  assert.equal(staged.taskMeta.signals.phase, 'controller-housekeeping');
  assert.equal(staged.taskMeta.signals.parentId, 'task-1');
  assert.equal(staged.taskMeta.references.controllerHousekeeping.fingerprint, 'fp-1');

  const persisted = await readControllerHousekeepingState({
    busRoot,
    agentName: 'daddy-autopilot',
    fingerprint: 'fp-1',
  });
  assert.equal(persisted.payload.status, 'queued');
  assert.equal(persisted.payload.generation, 1);
  assert.equal(persisted.payload.suspendedRoots.length, 1);
  assert.equal(persisted.payload.suspendedRoots[0].originalTaskId, 'task-1');
  assert.equal(persisted.payload.suspendedRoots[0].sourceAgent, 'observer:pr');
});

test('controller-housekeeping: same queued fingerprint appends suspended roots without queueing another task', async () => {
  const busRoot = await makeBusRoot('agentic-controller-housekeeping-reuse-');
  await stageControllerHousekeepingSuspension({
    busRoot,
    agentName: 'daddy-autopilot',
    fingerprint: 'fp-queued',
    branch: 'wip/root',
    headSha: 'abc1234',
    repoCommonGitDir: '/tmp/repo/.git',
    recoverableStatusPorcelain: 'M .codex/skills/cockpit-autopilot/SKILL.md',
    openedMeta: buildOpenedMeta({ id: 'task-1', rootId: 'root-1' }),
    openedBody: 'body-1',
  });

  const staged = await stageControllerHousekeepingSuspension({
    busRoot,
    agentName: 'daddy-autopilot',
    fingerprint: 'fp-queued',
    branch: 'wip/root',
    headSha: 'abc1234',
    repoCommonGitDir: '/tmp/repo/.git',
    recoverableStatusPorcelain: 'M .codex/skills/cockpit-autopilot/SKILL.md',
    openedMeta: buildOpenedMeta({ id: 'task-2', rootId: 'root-2' }),
    openedBody: 'body-2',
  });

  assert.equal(staged.action, 'reuse');
  assert.equal(staged.taskMeta, null);
  const persisted = await readControllerHousekeepingState({
    busRoot,
    agentName: 'daddy-autopilot',
    fingerprint: 'fp-queued',
  });
  assert.equal(persisted.payload.generation, 1);
  assert.equal(persisted.payload.suspendedRoots.length, 2);
  assert.equal(persisted.payload.suspendedRoots[1].originalTaskId, 'task-2');
});

test('controller-housekeeping: replay task preserves stored routing envelope and source references', async () => {
  const replay = buildControllerHousekeepingReplayTask({
    fingerprint: 'fp-replay',
    generation: 2,
    suspendedRoot: {
      originalTaskId: 'task-77',
      originalBody: 'body text',
      sourceAgent: 'observer:pr',
      sourceReferences: { pr: { number: 77 } },
      originalMeta: buildOpenedMeta({
        id: 'task-77',
        rootId: 'root-77',
        title: 'replay me',
        sourceAgent: 'observer:pr',
        sourceReferences: { pr: { number: 77 } },
      }),
    },
  });

  assert.equal(replay.id, 'controller_resume__task-77__fp-replay__g2');
  assert.equal(replay.meta.id, replay.id);
  assert.equal(replay.meta.to[0], 'daddy-autopilot');
  assert.equal(replay.meta.from, 'daddy-orchestrator');
  assert.equal(replay.meta.references.sourceAgent, 'observer:pr');
  assert.deepEqual(replay.meta.references.sourceReferences, { pr: { number: 77 } });
  assert.deepEqual(replay.meta.references.controllerHousekeeping, {
    fingerprint: 'fp-replay',
    generation: 2,
    resumedFromTaskId: 'task-77',
  });
  assert.equal(replay.body, 'body text');
});
