import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCommentTask,
  buildThreadTask,
  parsePrList,
  resolveObserverProjectRoot,
  isActionableComment,
  routeByPath,
  parseRepoNameWithOwnerFromRemoteUrl,
  parseMinPrNumber,
  filterPrNumbersByMinimum,
  normalizeColdStartMode,
  isUninitializedObserverState,
} from '../observers/watch-pr.mjs';
import { hashActionableCommentBody } from '../lib/review-fix-comment.mjs';

test('parsePrList keeps only positive integer PR numbers', () => {
  assert.deepEqual(parsePrList('1,2, abc, 0, -3, 4.2, 5'), [1, 2, 5]);
});

test('resolveObserverProjectRoot prefers AGENTIC_PROJECT_ROOT over cwd repo root', () => {
  const prev = process.env.AGENTIC_PROJECT_ROOT;
  try {
    process.env.AGENTIC_PROJECT_ROOT = '/tmp/valua-project';
    assert.equal(resolveObserverProjectRoot(''), '/tmp/valua-project');
  } finally {
    if (prev == null) delete process.env.AGENTIC_PROJECT_ROOT;
    else process.env.AGENTIC_PROJECT_ROOT = prev;
  }
});

test('parseRepoNameWithOwnerFromRemoteUrl supports github https and ssh remotes', () => {
  assert.equal(parseRepoNameWithOwnerFromRemoteUrl('https://github.com/future3OOO/agentic-cockpit.git'), 'future3OOO/agentic-cockpit');
  assert.equal(parseRepoNameWithOwnerFromRemoteUrl('git@github.com:future3OOO/agentic-cockpit.git'), 'future3OOO/agentic-cockpit');
  assert.equal(parseRepoNameWithOwnerFromRemoteUrl('ssh://git@github.com/future3OOO/agentic-cockpit.git'), 'future3OOO/agentic-cockpit');
  assert.equal(parseRepoNameWithOwnerFromRemoteUrl('https://gitlab.com/future3OOO/agentic-cockpit.git'), '');
});

test('routeByPath routes known domains to matching workers', () => {
  assert.equal(routeByPath('React/src/app.tsx'), 'frontend');
  assert.equal(routeByPath('databasepl/backend/main.py'), 'backend');
  assert.equal(routeByPath('rental_prediction/model.py'), 'prediction');
  assert.equal(routeByPath('README.md'), null);
});

test('isActionableComment matches review-fix language', () => {
  assert.equal(isActionableComment('CI failing: tests failing on main'), true);
  assert.equal(isActionableComment('Looks good to me, thanks!'), false);
});

test('buildThreadTask stamps PR head and latest comment freshness metadata', () => {
  const meta = buildThreadTask({
    orchestratorName: 'daddy-orchestrator',
    owner: 'future3OOO',
    repo: 'agentic-cockpit',
    prNumber: 121,
    prHeadRefOid: '0123456789abcdef0123456789abcdef01234567',
    prHeadRefName: 'slice/pr121',
    thread: {
      id: 'THREAD_123',
      path: 'scripts/agent-codex-worker.mjs',
      line: 7028,
      comments: {
        nodes: [
          {
            id: 'COMMENT_456',
            author: { login: 'greptile[bot]' },
            url: 'https://example.test/thread/123',
            createdAt: '2026-03-14T02:00:00Z',
            updatedAt: '2026-03-14T02:05:00Z',
          },
        ],
      },
    },
  });
  assert.equal(meta.references.pr.headRefOid, '0123456789abcdef0123456789abcdef01234567');
  assert.equal(meta.references.pr.headRefName, 'slice/pr121');
  assert.equal(meta.references.thread.lastCommentId, 'COMMENT_456');
  assert.equal(meta.references.thread.lastCommentCreatedAt, '2026-03-14T02:00:00Z');
  assert.equal(meta.references.thread.lastCommentUpdatedAt, '2026-03-14T02:05:00Z');
});

test('buildCommentTask stamps PR head and shared actionable body hash metadata', () => {
  const body = 'CI failing: tests failing on main';
  const meta = buildCommentTask({
    orchestratorName: 'daddy-orchestrator',
    owner: 'future3OOO',
    repo: 'agentic-cockpit',
    prNumber: 121,
    prHeadRefOid: '89abcdef0123456789abcdef0123456789abcdef',
    prHeadRefName: 'slice/pr121',
    comment: {
      id: 12345,
      body,
      html_url: 'https://example.test/comment/12345',
      updated_at: '2026-03-14T02:00:00Z',
      user: { login: 'coderabbitai' },
    },
  });
  assert.equal(meta.references.pr.headRefOid, '89abcdef0123456789abcdef0123456789abcdef');
  assert.equal(meta.references.pr.headRefName, 'slice/pr121');
  assert.equal(meta.references.comment.updatedAt, '2026-03-14T02:00:00Z');
  assert.equal(meta.references.comment.bodyHash, hashActionableCommentBody(body));
});

test('parseMinPrNumber returns only valid positive integer floor', () => {
  assert.equal(parseMinPrNumber(undefined), null);
  assert.equal(parseMinPrNumber(''), null);
  assert.equal(parseMinPrNumber('abc'), null);
  assert.equal(parseMinPrNumber('0'), null);
  assert.equal(parseMinPrNumber('81'), 81);
});

test('filterPrNumbersByMinimum filters legacy PR numbers', () => {
  assert.deepEqual(filterPrNumbersByMinimum([80, 81, 82, 100], 82), [82, 100]);
  assert.deepEqual(filterPrNumbersByMinimum([80, 81], null), [80, 81]);
});

test('normalizeColdStartMode defaults to baseline except replay', () => {
  assert.equal(normalizeColdStartMode(undefined), 'baseline');
  assert.equal(normalizeColdStartMode('baseline'), 'baseline');
  assert.equal(normalizeColdStartMode('replay'), 'replay');
  assert.equal(normalizeColdStartMode('anything-else'), 'baseline');
});

test('isUninitializedObserverState detects first-run observer state', () => {
  assert.equal(
    isUninitializedObserverState({ lastSeenIssueCommentId: 0, seenReviewThreadIds: [], lastScanAt: null }),
    true,
  );
  assert.equal(
    isUninitializedObserverState({ lastSeenIssueCommentId: 25, seenReviewThreadIds: [], lastScanAt: null }),
    false,
  );
  assert.equal(
    isUninitializedObserverState({ lastSeenIssueCommentId: 0, seenReviewThreadIds: ['x'], lastScanAt: null }),
    false,
  );
  assert.equal(
    isUninitializedObserverState({ lastSeenIssueCommentId: 0, seenReviewThreadIds: [], lastScanAt: '2026-02-08T00:00:00Z' }),
    false,
  );
});
