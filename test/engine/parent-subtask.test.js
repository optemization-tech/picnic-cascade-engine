import { describe, it, expect } from 'vitest';
import { runParentSubtask } from '../../src/engine/parent-subtask.js';
import { parseDate, countBDInclusive } from '../../src/utils/business-days.js';

function task(id, name, start, end, {
  status = 'Not Started',
  blockedByIds = [],
  blockingIds = [],
  parentId = null,
} = {}) {
  const s = parseDate(start);
  const e = parseDate(end);
  return {
    id,
    name,
    start: s,
    end: e,
    duration: countBDInclusive(s, e),
    status,
    blockedByIds,
    blockingIds,
    parentId,
  };
}

describe('runParentSubtask', () => {
  it('case-a shifts subtasks, resolves downstream deps, and rolls up parent', () => {
    const tasks = [
      task('p', 'Parent', '2026-03-30', '2026-04-02'),
      task('c1', 'Child 1', '2026-03-30', '2026-03-31', { parentId: 'p', blockingIds: ['d'] }),
      task('c2', 'Child 2', '2026-04-01', '2026-04-02', { parentId: 'p' }),
      task('d', 'Downstream', '2026-04-01', '2026-04-02', { blockedByIds: ['c1'] }),
    ];

    const result = runParentSubtask({
      sourceTaskId: 'p',
      sourceTaskName: 'Parent',
      newStart: '2026-03-30',
      newEnd: '2026-04-03',
      parentTaskId: null,
      parentMode: 'case-a',
      tasks,
    });

    const c1 = result.updates.find((u) => u.taskId === 'c1');
    const c2 = result.updates.find((u) => u.taskId === 'c2');
    const d = result.updates.find((u) => u.taskId === 'd');
    const p = result.updates.find((u) => u.taskId === 'p');

    expect(c1?.newStart).toBe('2026-03-31');
    expect(c1?.newEnd).toBe('2026-04-01');
    expect(c2?.newStart).toBe('2026-04-02');
    expect(c2?.newEnd).toBe('2026-04-03');
    expect(d?.newStart).toBe('2026-04-02');
    expect(d?.newEnd).toBe('2026-04-03');
    expect(p?.newStart).toBe('2026-03-31');
    expect(p?.newEnd).toBe('2026-04-03');
    expect(result.rolledUpStart).toBe('2026-03-31');
    expect(result.rolledUpEnd).toBe('2026-04-03');
  });

  it('case-a left shift drags connected dependencies with the subtree', () => {
    const tasks = [
      task('p', 'Parent', '2026-03-30', '2026-04-02'),
      task('s1', 'Sub 1', '2026-03-30', '2026-03-31', { parentId: 'p' }),
      task('s2', 'Sub 2', '2026-04-01', '2026-04-02', { parentId: 'p', blockingIds: ['d'] }),
      task('d', 'Downstream', '2026-04-03', '2026-04-06', { blockedByIds: ['s2'] }),
    ];

    const result = runParentSubtask({
      sourceTaskId: 'p',
      sourceTaskName: 'Parent',
      newStart: '2026-03-27',
      newEnd: '2026-04-01',
      parentTaskId: null,
      parentMode: 'case-a',
      tasks,
    });

    const s2 = result.updates.find((u) => u.taskId === 's2');
    const d = result.updates.find((u) => u.taskId === 'd');
    const p = result.updates.find((u) => u.taskId === 'p');

    expect(s2?.newStart).toBe('2026-03-31');
    expect(s2?.newEnd).toBe('2026-04-01');
    expect(d?.newStart).toBe('2026-04-02');
    expect(d?.newEnd).toBe('2026-04-03');
    expect(p?.newStart).toBe('2026-03-27');
    expect(p?.newEnd).toBe('2026-04-01');
  });

  it('case-b rolls up parent after subtask edit', () => {
    const tasks = [
      task('p', 'Parent', '2026-03-30', '2026-04-02'),
      task('c1', 'Child 1', '2026-03-30', '2026-03-31', { parentId: 'p' }),
      task('c2', 'Child 2', '2026-04-01', '2026-04-02', { parentId: 'p' }),
    ];

    const result = runParentSubtask({
      sourceTaskId: 'c1',
      sourceTaskName: 'Child 1',
      newStart: '2026-03-31',
      newEnd: '2026-04-01',
      parentTaskId: 'p',
      parentMode: 'case-b',
      tasks,
    });

    const parentUpdate = result.updates.find((u) => u.taskId === 'p');
    expect(parentUpdate).toBeDefined();
    expect(parentUpdate.newStart).toBe('2026-03-31');
    expect(parentUpdate.newEnd).toBe('2026-04-02');
    expect(parentUpdate._isRollUp).toBe(true);
  });

  it('rolls up affected parents from movedTaskIds/movedTaskMap', () => {
    const tasks = [
      task('q', 'Parent Q', '2026-03-30', '2026-04-02'),
      task('x1', 'X1', '2026-03-30', '2026-03-31', { parentId: 'q' }),
      task('x2', 'X2', '2026-04-01', '2026-04-02', { parentId: 'q' }),
    ];

    const result = runParentSubtask({
      sourceTaskId: 'source',
      sourceTaskName: 'Source',
      newStart: '2026-04-01',
      newEnd: '2026-04-01',
      parentTaskId: null,
      parentMode: null,
      movedTaskIds: ['x1'],
      movedTaskMap: {
        x1: { newStart: '2026-04-03', newEnd: '2026-04-06' },
      },
      tasks,
    });

    const q = result.updates.find((u) => u.taskId === 'q');
    expect(q).toBeDefined();
    expect(q.newStart).toBe('2026-04-01');
    expect(q.newEnd).toBe('2026-04-06');
    expect(q._isRollUp).toBe(true);
  });
});
