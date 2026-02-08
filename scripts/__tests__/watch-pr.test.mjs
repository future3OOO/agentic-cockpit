import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parsePrList,
  isActionableComment,
  routeByPath,
  parseRepoNameWithOwnerFromRemoteUrl,
  normalizeColdStartMode,
  isUninitializedObserverState,
} from '../observers/watch-pr.mjs';

test('parsePrList keeps only positive integer PR numbers', () => {
  assert.deepEqual(parsePrList('1,2, abc, 0, -3, 4.2, 5'), [1, 2, 5]);
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
