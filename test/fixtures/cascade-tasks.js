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

/**
 * Diamond upstream: root reachable via two paths from source.
 *
 *       Root (Mon-Tue)
 *      /             \
 *   Mid1 (Wed-Thu)  Mid2 (Wed-Thu)
 *      \             /
 *       Source (Fri-Mon)
 *
 * Root: Mar 30 (Mon) - Mar 31 (Tue)  [2 BD]
 * Mid1: Apr 01 (Wed) - Apr 02 (Thu)  [2 BD]  blocked by Root
 * Mid2: Apr 01 (Wed) - Apr 02 (Thu)  [2 BD]  blocked by Root
 * Source: Apr 03 (Fri) - Apr 06 (Mon) [2 BD]  blocked by Mid1 & Mid2
 *
 * Bug 2A.2: when source shifts +5 BD, root was double-shifted to +10 BD
 * because it was reachable from both Mid1 and Mid2.
 */
export function diamondUpstream() {
  return [
    task('root', 'Root', '2026-03-30', '2026-03-31', { blockingIds: ['mid1', 'mid2'] }),
    task('mid1', 'Mid1', '2026-04-01', '2026-04-02', { blockedByIds: ['root'], blockingIds: ['source'] }),
    task('mid2', 'Mid2', '2026-04-01', '2026-04-02', { blockedByIds: ['root'], blockingIds: ['source'] }),
    task('source', 'Source', '2026-04-03', '2026-04-06', { blockedByIds: ['mid1', 'mid2'] }),
  ];
}

/**
 * Fan-out from upstream: X fans out to B (source) and D.
 * B also blocks C downstream.
 *
 *       X (Mon-Tue)
 *      / \
 *     B   D
 *     |
 *     C
 *
 * X: Mar 30 (Mon) - Mar 31 (Tue)  [2 BD]  blocks B and D
 * B: Apr 01 (Wed) - Apr 02 (Thu)  [2 BD]  blocked by X, blocks C (SOURCE)
 * D: Apr 01 (Wed) - Apr 02 (Thu)  [2 BD]  blocked by X (NOT in B's chain)
 * C: Apr 03 (Fri) - Apr 06 (Mon)  [2 BD]  blocked by B
 *
 * Bug: when B pulls left, pullLeftUpstream shifts X left.
 * gapPreservingDownstream only BFS from B, so D is never shifted.
 */
export function fanOutFromUpstream() {
  return [
    task('x', 'Task X', '2026-03-30', '2026-03-31', { blockingIds: ['b', 'd'] }),
    task('b', 'Task B', '2026-04-01', '2026-04-02', { blockedByIds: ['x'], blockingIds: ['c'] }),
    task('d', 'Task D', '2026-04-01', '2026-04-02', { blockedByIds: ['x'] }),
    task('c', 'Task C', '2026-04-03', '2026-04-06', { blockedByIds: ['b'] }),
  ];
}

/**
 * Pre-existing constraint violation: B starts same day as A (should start after A ends).
 *
 * A: Mar 30 (Mon) - Mar 31 (Tue)  [2 BD]  blocks B
 * B: Mar 30 (Mon) - Mar 31 (Tue)  [2 BD]  blocked by A  (VIOLATION: should start Apr 01)
 * C: Apr 01 (Wed) - Apr 02 (Thu)  [2 BD]  blocked by B
 */
export function preExistingViolation() {
  return [
    task('a', 'Task A', '2026-03-30', '2026-03-31', { blockingIds: ['b'] }),
    task('b', 'Task B', '2026-03-30', '2026-03-31', { blockedByIds: ['a'], blockingIds: ['c'] }),
    task('c', 'Task C', '2026-04-01', '2026-04-02', { blockedByIds: ['b'] }),
  ];
}

/**
 * Transitive violations: B violates A, C violates B.
 *
 * A: Mar 30 (Mon) - Mar 31 (Tue)  [2 BD]  blocks B
 * B: Mar 30 (Mon) - Mar 31 (Tue)  [2 BD]  blocked by A  (VIOLATION)
 * C: Mar 30 (Mon) - Mar 31 (Tue)  [2 BD]  blocked by B  (VIOLATION)
 */
export function transitiveViolations() {
  return [
    task('a', 'Task A', '2026-03-30', '2026-03-31', { blockingIds: ['b'] }),
    task('b', 'Task B', '2026-03-30', '2026-03-31', { blockedByIds: ['a'], blockingIds: ['c'] }),
    task('c', 'Task C', '2026-03-30', '2026-03-31', { blockedByIds: ['b'] }),
  ];
}

/**
 * Multi-blocker with stationary predecessor (BL-H4g):
 *
 *     A → B → D
 *     C ------→ D  (C is NOT in A's chain)
 *
 * A: Mar 30 (Mon) - Apr 02 (Thu)  [4 BD]
 * B: Apr 03 (Fri) - Apr 06 (Mon)  [2 BD]  tight after A
 * C: Apr 03 (Fri) - Apr 08 (Wed)  [4 BD]  independent chain
 * D: Apr 10 (Fri) - Apr 13 (Mon)  [2 BD]  blocked by B and C, gap after C
 *
 * When A's end shrinks by 2 BD (pull-left):
 * - B shifts left by 2 BD (only blocker is A, which is a seed)
 * - D has stationary blocker C with gap (D.start Apr 10 > nextBD(C.end Apr 08) = Apr 09) → held
 */
export function multiBlockerStationary() {
  return [
    task('a', 'Task A', '2026-03-30', '2026-04-02', { blockingIds: ['b'] }),
    task('b', 'Task B', '2026-04-03', '2026-04-06', { blockedByIds: ['a'], blockingIds: ['d'] }),
    task('c', 'Task C', '2026-04-03', '2026-04-08', { blockingIds: ['d'] }),
    task('d', 'Task D', '2026-04-10', '2026-04-13', { blockedByIds: ['b', 'c'] }),
  ];
}

/**
 * Multi-blocker, all moved (BL-H4g control):
 * Same as multiBlockerStationary but C is upstream of A,
 * so C gets shifted by the cascade too.
 *
 *     A → B → D
 *     A → C → D
 *
 * A: Mar 30 (Mon) - Apr 02 (Thu)  [4 BD]
 * B: Apr 03 (Fri) - Apr 06 (Mon)  [2 BD]  tight after A
 * C: Apr 03 (Fri) - Apr 08 (Wed)  [4 BD]  also downstream of A
 * D: Apr 10 (Fri) - Apr 13 (Mon)  [2 BD]  blocked by B and C, gap after C
 *
 * When A's end shrinks by 2 BD (pull-left):
 * - Both B and C shift (both are downstream of source A)
 * - D can move because ALL blockers moved
 */
export function multiBlockerAllMoved() {
  return [
    task('a', 'Task A', '2026-03-30', '2026-04-02', { blockingIds: ['b', 'c'] }),
    task('b', 'Task B', '2026-04-03', '2026-04-06', { blockedByIds: ['a'], blockingIds: ['d'] }),
    task('c', 'Task C', '2026-04-03', '2026-04-08', { blockedByIds: ['a'], blockingIds: ['d'] }),
    task('d', 'Task D', '2026-04-10', '2026-04-13', { blockedByIds: ['b', 'c'] }),
  ];
}

/**
 * Multi-blocker, tight with stationary (BL-H4g control):
 * D is tight with stationary blocker C (no gap).
 * Clamp + frustration resolver should handle this normally.
 *
 *     A → B → D
 *     C ------→ D  (C is NOT in A's chain, D tight with C)
 *
 * A: Mar 30 (Mon) - Apr 02 (Thu)  [4 BD]
 * B: Apr 03 (Fri) - Apr 06 (Mon)  [2 BD]  tight after A
 * C: Apr 03 (Fri) - Apr 08 (Wed)  [4 BD]  independent chain
 * D: Apr 09 (Thu) - Apr 10 (Fri)  [2 BD]  blocked by B and C, TIGHT with C
 */
export function multiBlockerTightStationary() {
  return [
    task('a', 'Task A', '2026-03-30', '2026-04-02', { blockingIds: ['b'] }),
    task('b', 'Task B', '2026-04-03', '2026-04-06', { blockedByIds: ['a'], blockingIds: ['d'] }),
    task('c', 'Task C', '2026-04-03', '2026-04-08', { blockingIds: ['d'] }),
    task('d', 'Task D', '2026-04-09', '2026-04-10', { blockedByIds: ['b', 'c'] }),
  ];
}
