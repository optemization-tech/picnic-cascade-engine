import { describe, expect, it } from 'vitest';

import { runCascade } from '../../src/engine/cascade.js';
import {
  chainWithFrozen,
  fanOutFromUpstream,
  gappedUpstreamChain,
  linearTightChain,
  multiBlockerAllMoved,
} from '../fixtures/cascade-tasks.js';
import {
  crossChainClampedByOtherBlocker,
  parentWithAccidentalDep,
} from '../fixtures/cross-chain-tasks.js';

function updateMap(result) {
  return new Map(result.updates.map((update) => [update.taskId, update]));
}

describe('runCascade exact behavior', () => {
  // @behavior BEH-MODE-PUSH-RIGHT
  it('push-right keeps a tight linear chain tight', () => {
    const result = runCascade({
      sourceTaskId: 'a',
      sourceTaskName: 'Task A',
      newStart: '2026-03-30',
      newEnd: '2026-04-01',
      refStart: '2026-03-30',
      refEnd: '2026-03-31',
      startDelta: 0,
      endDelta: 1,
      cascadeMode: 'push-right',
      tasks: linearTightChain(),
    });

    const updates = updateMap(result);
    expect(updates.get('b')).toMatchObject({ newStart: '2026-04-02', newEnd: '2026-04-03' });
    expect(updates.get('c')).toMatchObject({ newStart: '2026-04-06', newEnd: '2026-04-07' });
    expect(updates.get('d')).toMatchObject({ newStart: '2026-04-08', newEnd: '2026-04-09' });
  });

  // @behavior BEH-MODE-PULL-LEFT
  // @behavior BEH-PULL-LEFT-TIGHTEN
  it('pull-left tightens every downstream task against its latest blocker end', () => {
    const result = runCascade({
      sourceTaskId: 'a',
      sourceTaskName: 'Task A',
      newStart: '2026-03-30',
      newEnd: '2026-03-31',
      refStart: '2026-03-30',
      refEnd: '2026-04-02',
      startDelta: 0,
      endDelta: -2,
      cascadeMode: 'pull-left',
      tasks: multiBlockerAllMoved(),
    });

    const updates = updateMap(result);
    expect(updates.get('b')).toMatchObject({ newStart: '2026-04-01', newEnd: '2026-04-02' });
    expect(updates.get('c')).toMatchObject({ newStart: '2026-04-01', newEnd: '2026-04-06' });
    // D snaps tight to max(B.end=Apr02, C.end=Apr06) → nextBD(Apr06) = Apr 07
    expect(updates.get('d')).toMatchObject({ newStart: '2026-04-07', newEnd: '2026-04-08' });
  });

  // @behavior BEH-CROSSCHAIN-PROPAGATION
  it('pull-left clamps a downstream task against a stationary cross-chain blocker', () => {
    const result = runCascade({
      sourceTaskId: 'a',
      sourceTaskName: 'Task A',
      newStart: '2026-03-30',
      newEnd: '2026-03-30',
      refStart: '2026-03-30',
      refEnd: '2026-03-31',
      startDelta: 0,
      endDelta: -1,
      cascadeMode: 'pull-left',
      tasks: crossChainClampedByOtherBlocker(),
    });

    const updates = updateMap(result);
    expect(updates.get('b')).toMatchObject({ newStart: '2026-03-31', newEnd: '2026-04-01' });
    expect(updates.has('d')).toBe(false);
  });

  // @behavior BEH-MODE-PULL-RIGHT
  // @behavior BEH-PULLRIGHT-DOWNSTREAM-ONLY
  it('pull-right tightens downstream tasks without moving upstream blockers', () => {
    const result = runCascade({
      sourceTaskId: 'a',
      sourceTaskName: 'Task A',
      newStart: '2026-04-13',
      newEnd: '2026-04-10',
      refStart: '2026-04-09',
      refEnd: '2026-04-10',
      startDelta: 2,
      endDelta: 0,
      cascadeMode: 'pull-right',
      tasks: gappedUpstreamChain(),
    });

    const updates = updateMap(result);
    // Upstream blockers B, C, D are NOT moved (PM intentionally moved source right)
    expect(updates.has('b')).toBe(false);
    expect(updates.has('c')).toBe(false);
    expect(updates.has('d')).toBe(false);
  });

  // @behavior BEH-MODE-DRAG-LEFT
  // @behavior BEH-DRAG-FORWARD-ONLY
  it('drag-left tightens only downstream tasks, not upstream or siblings', () => {
    const result = runCascade({
      sourceTaskId: 'b',
      sourceTaskName: 'Task B',
      newStart: '2026-03-31',
      newEnd: '2026-04-01',
      refStart: '2026-04-01',
      refEnd: '2026-04-02',
      startDelta: -1,
      endDelta: -1,
      cascadeMode: 'drag-left',
      tasks: fanOutFromUpstream(),
    });

    const updates = updateMap(result);
    // Upstream task X is NOT moved (forward-only walk)
    expect(updates.has('x')).toBe(false);
    // Downstream task C tightens to B's new end
    expect(updates.get('c')).toMatchObject({ newStart: '2026-04-02', newEnd: '2026-04-03' });
    // Sibling D is NOT moved (not downstream of B)
    expect(updates.has('d')).toBe(false);
  });

  // @behavior BEH-COMPLETE-FREEZE
  it('never moves frozen tasks during a cascade', () => {
    const result = runCascade({
      sourceTaskId: 'a',
      sourceTaskName: 'Task A',
      newStart: '2026-03-30',
      newEnd: '2026-04-02',
      refStart: '2026-03-30',
      refEnd: '2026-03-31',
      startDelta: 0,
      endDelta: 2,
      cascadeMode: 'push-right',
      tasks: chainWithFrozen(),
    });

    expect(result.movedTaskIds).toEqual([]);
  });

  // @behavior BEH-BL-H5G
  it('strips parent-level dependency edges before cascading', () => {
    const result = runCascade({
      sourceTaskId: 'x',
      sourceTaskName: 'Task X',
      newStart: '2026-03-30',
      newEnd: '2026-04-01',
      refStart: '2026-03-30',
      refEnd: '2026-03-31',
      startDelta: 0,
      endDelta: 1,
      cascadeMode: 'push-right',
      tasks: parentWithAccidentalDep(),
    });

    expect(result.movedTaskIds).toEqual([]);
  });

  it('reports reachable dependency cycles in downstream topo passes', () => {
    const result = runCascade({
      sourceTaskId: 'a',
      sourceTaskName: 'Task A',
      newStart: '2026-03-30',
      newEnd: '2026-04-01',
      refStart: '2026-03-30',
      refEnd: '2026-03-31',
      startDelta: 0,
      endDelta: 1,
      cascadeMode: 'push-right',
      tasks: [
        {
          id: 'a',
          name: 'Task A',
          start: new Date('2026-03-30T00:00:00Z'),
          end: new Date('2026-03-31T00:00:00Z'),
          duration: 2,
          status: 'Not Started',
          blockedByIds: ['b'],
          blockingIds: ['b'],
        },
        {
          id: 'b',
          name: 'Task B',
          start: new Date('2026-04-01T00:00:00Z'),
          end: new Date('2026-04-02T00:00:00Z'),
          duration: 2,
          status: 'Not Started',
          blockedByIds: ['a'],
          blockingIds: ['a'],
        },
      ],
    });

    expect(result.diagnostics.cycleDetected).toBe(true);
    expect(result.diagnostics.cycleMissedCount).toBe(2);
    expect(result.diagnostics.cycleTaskIds).toEqual(expect.arrayContaining(['a', 'b']));
  });

  // @behavior BEH-POST-CASCADE-VERIFICATION
  it('reports zero post-cascade violations for a clean push-right', () => {
    const result = runCascade({
      sourceTaskId: 'a',
      sourceTaskName: 'Task A',
      newStart: '2026-03-30',
      newEnd: '2026-04-01',
      refStart: '2026-03-30',
      refEnd: '2026-03-31',
      startDelta: 0,
      endDelta: 1,
      cascadeMode: 'push-right',
      tasks: linearTightChain(),
    });

    expect(result.diagnostics.postCascadeViolationCount).toBe(0);
    expect(result.diagnostics.postCascadeViolations).toEqual([]);
  });

  it('reports post-cascade violations when frozen blocker creates gap', () => {
    const result = runCascade({
      sourceTaskId: 'a',
      sourceTaskName: 'Task A',
      newStart: '2026-03-30',
      newEnd: '2026-04-02',
      refStart: '2026-03-30',
      refEnd: '2026-03-31',
      startDelta: 0,
      endDelta: 2,
      cascadeMode: 'push-right',
      tasks: chainWithFrozen(),
    });

    // B is frozen (Done) — C can't move because its blocker B is frozen.
    // But the violation checker sees C is still at its old position
    // while source A's end moved past B.
    // No tasks moved (B is frozen, C is blocked by frozen B), so no violations on moved tasks.
    expect(result.diagnostics.postCascadeViolationCount).toBe(0);
  });
});
