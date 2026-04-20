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
  // @behavior BEH-ENDLEFT-ALL-DOWNSTREAM
  it('pull-left shifts every downstream task by the same negative delta when all blockers move', () => {
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
    expect(updates.get('d')).toMatchObject({ newStart: '2026-04-08', newEnd: '2026-04-09' });
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
  // @behavior BEH-PULLRIGHT-ALL-UPSTREAM
  it('pull-right shifts every reachable upstream blocker once even across gaps', () => {
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
    expect(updates.get('b')).toMatchObject({ newStart: '2026-04-09', newEnd: '2026-04-10' });
    expect(updates.get('c')).toMatchObject({ newStart: '2026-04-07', newEnd: '2026-04-08' });
    expect(updates.get('d')).toMatchObject({ newStart: '2026-04-01', newEnd: '2026-04-02' });
  });

  // @behavior BEH-MODE-DRAG-LEFT
  // @behavior BEH-DRAG-LEFT-FANOUT
  it('drag-left translates every reachable task in a dependency fan-out', () => {
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
    expect(updates.get('x')).toMatchObject({ newStart: '2026-03-27', newEnd: '2026-03-30' });
    expect(updates.get('c')).toMatchObject({ newStart: '2026-04-02', newEnd: '2026-04-03' });
    expect(updates.get('d')).toMatchObject({ newStart: '2026-03-31', newEnd: '2026-04-01' });
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
});
