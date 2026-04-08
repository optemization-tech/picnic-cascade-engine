import { describe, it, expect } from 'vitest';
import { runCascade } from '../../src/engine/cascade.js';
import { parseDate, countBDInclusive, nextBusinessDay } from '../../src/utils/business-days.js';

function makeTask(id, name, start, end, { blockedByIds = [], blockingIds = [], status = 'Not Started' } = {}) {
  const s = parseDate(start);
  const e = parseDate(end);
  return {
    id,
    name,
    start: s,
    end: e,
    duration: countBDInclusive(s, e),
    blockedByIds,
    blockingIds,
    status,
  };
}

function applyUpdates(tasks, updates) {
  const byId = new Map(tasks.map((t) => [t.id, { ...t }]));
  for (const update of updates) {
    const t = byId.get(update.taskId);
    if (!t) continue;
    t.start = parseDate(update.newStart);
    t.end = parseDate(update.newEnd);
  }
  return [...byId.values()];
}

// @behavior BEH-CROSSCHAIN-FIXEDPOINT
describe('runCascade fixed-point and safety diagnostics', () => {
  it('resolves cross-chain conflicts to a fixed point in one execution', () => {
    const tasks = [
      makeTask('a', 'A', '2026-03-30', '2026-03-31', { blockingIds: ['c'] }),
      makeTask('b', 'B', '2026-03-30', '2026-04-02', { blockingIds: ['c'] }),
      makeTask('c', 'C', '2026-04-03', '2026-04-06', { blockedByIds: ['a', 'b'], blockingIds: ['d'] }),
      makeTask('d', 'D', '2026-04-07', '2026-04-08', { blockedByIds: ['c'] }),
    ];

    const result = runCascade({
      sourceTaskId: 'a',
      sourceTaskName: 'A',
      newStart: '2026-03-30',
      newEnd: '2026-04-03',
      refStart: '2026-03-30',
      refEnd: '2026-03-31',
      startDelta: 0,
      endDelta: 3,
      cascadeMode: 'push-right',
      tasks,
    });

    const finalTasks = applyUpdates(tasks, result.updates);
    const finalById = new Map(finalTasks.map((t) => [t.id, t]));
    for (const task of finalTasks) {
      for (const blockerId of task.blockedByIds) {
        const blocker = finalById.get(blockerId);
        expect(task.start >= nextBusinessDay(blocker.end)).toBe(true);
      }
    }
  });

  // @behavior BEH-SAFETY-CAP
  // @behavior BEH-RESIDUE-REPORTING
  it('reports residue when start-left iterative pass hits safety cap', () => {
    const tasks = [
      makeTask('a', 'A', '2026-04-01', '2026-04-02', { blockedByIds: ['c'], blockingIds: ['b'] }),
      makeTask('b', 'B', '2026-04-03', '2026-04-04', { blockedByIds: ['a'], blockingIds: ['c'] }),
      makeTask('c', 'C', '2026-04-07', '2026-04-08', { blockedByIds: ['b'], blockingIds: ['a'] }),
    ];

    const result = runCascade({
      sourceTaskId: 'a',
      sourceTaskName: 'A',
      newStart: '2026-03-31',
      newEnd: '2026-04-02',
      refStart: '2026-04-01',
      refEnd: '2026-04-02',
      startDelta: -1,
      endDelta: 0,
      cascadeMode: 'start-left',
      tasks,
    });

    expect(result.diagnostics.capReached).toBe(true);
    expect(result.diagnostics.unresolvedResidue.length).toBeGreaterThan(0);
  });

  // @behavior BEH-MONOTONIC-SAFETY
  it('maintains monotonic directional movement per mode', () => {
    const tasks = [
      makeTask('a', 'A', '2026-03-30', '2026-03-31', { blockingIds: ['b'] }),
      makeTask('b', 'B', '2026-04-01', '2026-04-02', { blockedByIds: ['a'], blockingIds: ['c'] }),
      makeTask('c', 'C', '2026-04-03', '2026-04-06', { blockedByIds: ['b'] }),
    ];
    const byId = new Map(tasks.map((t) => [t.id, t]));

    const startLeft = runCascade({
      sourceTaskId: 'c',
      sourceTaskName: 'C',
      newStart: '2026-04-02',
      newEnd: '2026-04-06',
      refStart: '2026-04-03',
      refEnd: '2026-04-06',
      startDelta: -1,
      endDelta: 0,
      cascadeMode: 'start-left',
      tasks,
    });

    for (const update of startLeft.updates) {
      const orig = byId.get(update.taskId);
      expect(parseDate(update.newStart) <= orig.start).toBe(true);
      expect(parseDate(update.newEnd) <= orig.end).toBe(true);
    }
    expect(startLeft.diagnostics.monotonicSafe).toBe(true);
  });
});
