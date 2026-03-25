import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createTaskGitPreflightRuntimeError,
  TaskGitPreflightRuntimeError,
} from '../lib/worker-git-preflight.mjs';

test('worker-git-preflight: unexpected inner-preflight errors are wrapped as failed runtime errors', () => {
  const contract = { baseSha: 'abc1234', workBranch: 'slice/test' };
  const wrapped = createTaskGitPreflightRuntimeError({
    error: new Error('synthetic inner preflight fault'),
    cwd: '/tmp/example',
    taskKind: 'EXECUTE',
    contract,
  });

  assert.ok(wrapped instanceof TaskGitPreflightRuntimeError);
  assert.equal(wrapped.message, 'git preflight failed: synthetic inner preflight fault');
  assert.equal(wrapped.cwd, '/tmp/example');
  assert.equal(wrapped.taskKind, 'EXECUTE');
  assert.deepEqual(wrapped.contract, contract);
  assert.deepEqual(wrapped.details, { error: 'synthetic inner preflight fault' });
});
