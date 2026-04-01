// Test fixtures for cascade engine
// All dates are UTC, tasks are pre-parsed objects

import { parseDate, countBDInclusive } from '../../src/utils/business-days.js';

/**
 * Helper to build a task with sensible defaults.
 */
function task(id, name, start, end, { status = 'Not Started', blockedByIds = [], blockingIds = [] } = {}) {
  const s = parseDate(start);
  const e = parseDate(end);
  return {
    id,
    name,
    start: s,
    end: e,
    duration: (s && e) ? countBDInclusive(s, e) : 1,
    status,
    blockedByIds,
    blockingIds,
  };
}

/**
 * Linear 4-task chain (tight, no gaps):
 * A (Mon-Tue) → B (Wed-Thu) → C (Fri-Mon) → D (Tue-Wed)
 *
 * Week of 2026-03-30:
 * A: Mar 30 (Mon) - Mar 31 (Tue)  [2 BD]
 * B: Apr 01 (Wed) - Apr 02 (Thu)  [2 BD]
 * C: Apr 03 (Fri) - Apr 06 (Mon)  [2 BD]
 * D: Apr 07 (Tue) - Apr 08 (Wed)  [2 BD]
 */
export function linearTightChain() {
  return [
    task('a', 'Task A', '2026-03-30', '2026-03-31', { blockingIds: ['b'] }),
    task('b', 'Task B', '2026-04-01', '2026-04-02', { blockedByIds: ['a'], blockingIds: ['c'] }),
    task('c', 'Task C', '2026-04-03', '2026-04-06', { blockedByIds: ['b'], blockingIds: ['d'] }),
    task('d', 'Task D', '2026-04-07', '2026-04-08', { blockedByIds: ['c'] }),
  ];
}

/**
 * Linear 3-task chain with a 1 BD gap between A and B:
 * A (Mon-Tue) → [1 BD gap] → B (Thu-Fri) → C (Mon-Tue)
 *
 * A: Mar 30 (Mon) - Mar 31 (Tue)  [2 BD]
 * B: Apr 02 (Thu) - Apr 03 (Fri)  [2 BD]  (gap: Wed Apr 01)
 * C: Apr 06 (Mon) - Apr 07 (Tue)  [2 BD]
 */
export function linearGappedChain() {
  return [
    task('a', 'Task A', '2026-03-30', '2026-03-31', { blockingIds: ['b'] }),
    task('b', 'Task B', '2026-04-02', '2026-04-03', { blockedByIds: ['a'], blockingIds: ['c'] }),
    task('c', 'Task C', '2026-04-06', '2026-04-07', { blockedByIds: ['b'] }),
  ];
}

/**
 * Fan-in: two blockers (A, B) → C
 * A: Mar 30 (Mon) - Mar 31 (Tue)  [2 BD]
 * B: Mar 30 (Mon) - Apr 02 (Thu)  [4 BD]
 * C: Apr 03 (Fri) - Apr 06 (Mon)  [2 BD]  (starts after both A and B)
 */
export function fanIn() {
  return [
    task('a', 'Task A', '2026-03-30', '2026-03-31', { blockingIds: ['c'] }),
    task('b', 'Task B', '2026-03-30', '2026-04-02', { blockingIds: ['c'] }),
    task('c', 'Task C', '2026-04-03', '2026-04-06', { blockedByIds: ['a', 'b'] }),
  ];
}

/**
 * Chain with a frozen task:
 * A (Mon-Tue) → B (Wed-Thu, Done) → C (Fri-Mon)
 */
export function chainWithFrozen() {
  return [
    task('a', 'Task A', '2026-03-30', '2026-03-31', { blockingIds: ['b'] }),
    task('b', 'Task B', '2026-04-01', '2026-04-02', { status: 'Done', blockedByIds: ['a'], blockingIds: ['c'] }),
    task('c', 'Task C', '2026-04-03', '2026-04-06', { blockedByIds: ['b'] }),
  ];
}

/**
 * Gapped upstream chain for pull-right tests.
 * D → [gap] → C → B → A (tight chain except D→C has a gap)
 *
 * D: Mar 30 (Mon) - Mar 31 (Tue)  [2 BD]
 * C: Apr 03 (Fri) - Apr 06 (Mon)  [2 BD]   (2 BD gap after D: Wed, Thu)
 * B: Apr 07 (Tue) - Apr 08 (Wed)  [2 BD]   (tight after C)
 * A: Apr 09 (Thu) - Apr 10 (Fri)  [2 BD]   (tight after B)
 *
 * Deps: D blocks C, C blocks B, B blocks A
 * When A's start moves right, pullRightUpstream should shift ALL
 * upstream blockers by the same delta (gap-preserving), including D.
 */
export function gappedUpstreamChain() {
  return [
    task('d', 'Task D', '2026-03-30', '2026-03-31', { blockingIds: ['c'] }),
    task('c', 'Task C', '2026-04-03', '2026-04-06', { blockedByIds: ['d'], blockingIds: ['b'] }),
    task('b', 'Task B', '2026-04-07', '2026-04-08', { blockedByIds: ['c'], blockingIds: ['a'] }),
    task('a', 'Task A', '2026-04-09', '2026-04-10', { blockedByIds: ['b'] }),
  ];
}
