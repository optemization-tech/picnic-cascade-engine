import { parseDate, countBDInclusive } from '../../src/utils/business-days.js';
import { task } from './cascade-tasks.js';

/**
 * Two chains sharing a common task B:
 *
 * Chain 1: A → B → C
 * Chain 2: X → B (B also blocked by X)
 *
 * A: Mar 30 (Mon) - Mar 31 (Tue)  [2 BD]
 * X: Mar 30 (Mon) - Apr 01 (Wed)  [3 BD]
 * B: Apr 02 (Thu) - Apr 03 (Fri)  [2 BD]  (blocked by A and X)
 * C: Apr 06 (Mon) - Apr 07 (Tue)  [2 BD]
 *
 * When A's end moves left (pull-left), downstream shift pulls B earlier.
 * But B is also blocked by X. If B's shifted position violates X's constraint,
 * B gets clamped. The gap between A and B should still shrink as much as allowed.
 *
 * Cross-chain scenario: if B CAN move earlier (X allows it), then C should also
 * move earlier (uniform shift propagates through the chain).
 */
export function twoChainSharedTask() {
  return [
    task('a', 'Task A', '2026-03-30', '2026-03-31', { blockingIds: ['b'] }),
    task('x', 'Task X', '2026-03-30', '2026-04-01', { blockingIds: ['b'] }),
    task('b', 'Task B', '2026-04-02', '2026-04-03', { blockedByIds: ['a', 'x'], blockingIds: ['c'] }),
    task('c', 'Task C', '2026-04-06', '2026-04-07', { blockedByIds: ['b'] }),
  ];
}

/**
 * Cross-chain with uniform shift creating a violation:
 *
 * Chain 1: A → B → D
 * Chain 2: C → D (D also blocked by C)
 *
 * A: Mar 30 (Mon) - Mar 31 (Tue)  [2 BD]
 * B: Apr 01 (Wed) - Apr 02 (Thu)  [2 BD]
 * C: Apr 01 (Wed) - Apr 03 (Fri)  [3 BD]
 * D: Apr 06 (Mon) - Apr 07 (Tue)  [2 BD]  (blocked by B and C)
 *
 * When A's end moves left by 1 BD (end-only-left):
 * - gapPreservingDownstream shifts B left by 1 BD → B: Tue-Wed (Mar 31 - Apr 01)
 * - B's end changes → D is downstream of B
 * - D is also blocked by C (ends Fri Apr 03), so D's start must be >= Mon Apr 06
 * - Uniform shift would put D at Thu Apr 03, but C blocks → clamped to Mon Apr 06
 * - D doesn't actually move (clamped by cross-chain blocker C)
 *
 * This is a case where cross-chain propagation is NOT needed because the
 * cross-chain blocker (C) didn't move and the clamp is correct.
 */
export function crossChainClampedByOtherBlocker() {
  return [
    task('a', 'Task A', '2026-03-30', '2026-03-31', { blockingIds: ['b'] }),
    task('b', 'Task B', '2026-04-01', '2026-04-02', { blockedByIds: ['a'], blockingIds: ['d'] }),
    task('c', 'Task C', '2026-04-01', '2026-04-03', { blockingIds: ['d'] }),
    task('d', 'Task D', '2026-04-06', '2026-04-07', { blockedByIds: ['b', 'c'] }),
  ];
}

/**
 * Parent with accidental dependency (BL-H5g):
 *
 * X → P (accidental parent-level dep)
 * P has subtasks S1 → S2
 *
 * X: Mar 30 (Mon) - Mar 31 (Tue)  [2 BD]  blocks P (accidental)
 * P: Apr 01 (Wed) - Apr 07 (Tue)  [5 BD]  parent, blocked by X (accidental)
 * S1: Apr 01 (Wed) - Apr 02 (Thu) [2 BD]  subtask of P
 * S2: Apr 03 (Fri) - Apr 04 (Fri) [1 BD]  subtask of P, blocked by S1
 *
 * Push-right on X should NOT cascade through P to S1/S2.
 * P's dep edges should be stripped because P has subtasks.
 */
export function parentWithAccidentalDep() {
  const s = parseDate;
  const c = countBDInclusive;
  return [
    task('x', 'Task X', '2026-03-30', '2026-03-31', { blockingIds: ['p'] }),
    {
      id: 'p', name: 'Parent P', start: s('2026-04-01'), end: s('2026-04-07'),
      duration: c(s('2026-04-01'), s('2026-04-07')),
      status: 'Not Started', blockedByIds: ['x'], blockingIds: [],
    },
    {
      id: 's1', name: 'Subtask S1', start: s('2026-04-01'), end: s('2026-04-02'),
      duration: c(s('2026-04-01'), s('2026-04-02')),
      status: 'Not Started', blockedByIds: [], blockingIds: ['s2'],
      parentId: 'p',
    },
    {
      id: 's2', name: 'Subtask S2', start: s('2026-04-03'), end: s('2026-04-03'),
      duration: 1,
      status: 'Not Started', blockedByIds: ['s1'], blockingIds: [],
      parentId: 'p',
    },
  ];
}
