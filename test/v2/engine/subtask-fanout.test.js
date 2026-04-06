import { describe, it, expect } from 'vitest';
import { computeSubtaskUpdates } from '../../../src/v2/engine/subtask-fanout.js';

describe('computeSubtaskUpdates (dynamic offset computation)', () => {
  it('computes subtask dates from parent current→new start shift', () => {
    const allTasks = [
      // Parent currently at Mar 3, moving to Mar 10 (+5 BD)
      { id: 'parent-1', parentId: null, start: new Date('2027-03-03T00:00:00Z'), end: new Date('2027-04-14T00:00:00Z') },
      // Subtask currently 5 BD after parent start (Mar 10), 15 BD after (Mar 24)
      { id: 'sub-1', parentId: 'parent-1', name: 'Sub 1', start: new Date('2027-03-10T00:00:00Z'), end: new Date('2027-03-24T00:00:00Z') },
      // Subtask starting same day as parent (offset 0)
      { id: 'sub-2', parentId: 'parent-1', name: 'Sub 2', start: new Date('2027-03-03T00:00:00Z'), end: new Date('2027-03-17T00:00:00Z') },
    ];

    const result = computeSubtaskUpdates({
      movedParentIds: ['parent-1'],
      movedParentMap: {
        'parent-1': { newStart: '2027-03-10', newEnd: '2027-04-21' },
      },
      allTasks,
    });

    expect(result.updates).toHaveLength(2);

    const sub1 = result.updates.find((u) => u.taskId === 'sub-1');
    // Sub-1 was 5 BD after parent → new start = Mar 10 + 5 BD = Mar 17
    expect(sub1.newStart).toBe('2027-03-17');
    // Sub-1 end was 15 BD after parent → new end = Mar 10 + 15 BD = Mar 31
    expect(sub1.newEnd).toBe('2027-03-31');

    const sub2 = result.updates.find((u) => u.taskId === 'sub-2');
    // Sub-2 was at offset 0 → stays at parent start = Mar 10
    expect(sub2.newStart).toBe('2027-03-10');
    // Sub-2 end was 10 BD after parent → Mar 10 + 10 BD = Mar 24
    expect(sub2.newEnd).toBe('2027-03-24');
  });

  it('returns empty updates for parent with no subtasks', () => {
    const allTasks = [
      { id: 'parent-1', parentId: null, start: new Date('2027-03-03T00:00:00Z'), end: new Date('2027-04-14T00:00:00Z') },
    ];

    const result = computeSubtaskUpdates({
      movedParentIds: ['parent-1'],
      movedParentMap: {
        'parent-1': { newStart: '2027-03-10', newEnd: '2027-04-21' },
      },
      allTasks,
    });

    expect(result.updates).toHaveLength(0);
  });

  it('skips subtasks with null dates', () => {
    const allTasks = [
      { id: 'parent-1', parentId: null, start: new Date('2027-03-03T00:00:00Z'), end: new Date('2027-04-14T00:00:00Z') },
      { id: 'sub-1', parentId: 'parent-1', name: 'Sub 1', start: null, end: null },
      { id: 'sub-2', parentId: 'parent-1', name: 'Sub 2', start: new Date('2027-03-05T00:00:00Z'), end: new Date('2027-03-12T00:00:00Z') },
    ];

    const result = computeSubtaskUpdates({
      movedParentIds: ['parent-1'],
      movedParentMap: {
        'parent-1': { newStart: '2027-03-10', newEnd: '2027-04-21' },
      },
      allTasks,
    });

    expect(result.updates).toHaveLength(1);
    expect(result.updates[0].taskId).toBe('sub-2');
  });

  it('handles multiple moved parents', () => {
    const allTasks = [
      { id: 'p1', parentId: null, start: new Date('2027-03-03T00:00:00Z'), end: new Date('2027-03-17T00:00:00Z') },
      { id: 'p2', parentId: null, start: new Date('2027-04-01T00:00:00Z'), end: new Date('2027-04-10T00:00:00Z') },
      { id: 's1', parentId: 'p1', name: 'S1', start: new Date('2027-03-03T00:00:00Z'), end: new Date('2027-03-10T00:00:00Z') },
      { id: 's2', parentId: 'p2', name: 'S2', start: new Date('2027-04-03T00:00:00Z'), end: new Date('2027-04-10T00:00:00Z') },
      { id: 's3', parentId: 'p2', name: 'S3', start: new Date('2027-04-01T00:00:00Z'), end: new Date('2027-04-07T00:00:00Z') },
    ];

    const result = computeSubtaskUpdates({
      movedParentIds: ['p1', 'p2'],
      movedParentMap: {
        p1: { newStart: '2027-03-10', newEnd: '2027-03-24' },
        p2: { newStart: '2027-04-08', newEnd: '2027-04-17' },
      },
      allTasks,
    });

    expect(result.updates).toHaveLength(3);
    expect(result.updates.find((u) => u.taskId === 's1')).toBeDefined();
    expect(result.updates.find((u) => u.taskId === 's2')).toBeDefined();
    expect(result.updates.find((u) => u.taskId === 's3')).toBeDefined();
  });

  it('preserves relative position across weekend boundaries', () => {
    const allTasks = [
      // Parent at Friday Mar 5
      { id: 'parent-1', parentId: null, start: new Date('2027-03-05T00:00:00Z'), end: new Date('2027-03-19T00:00:00Z') },
      // Sub-1 at Monday Mar 8 (1 BD after parent)
      { id: 'sub-1', parentId: 'parent-1', name: 'Sub 1', start: new Date('2027-03-08T00:00:00Z'), end: new Date('2027-03-15T00:00:00Z') },
    ];

    // Parent moves to Monday Mar 15
    const result = computeSubtaskUpdates({
      movedParentIds: ['parent-1'],
      movedParentMap: {
        'parent-1': { newStart: '2027-03-15', newEnd: '2027-03-29' },
      },
      allTasks,
    });

    expect(result.updates).toHaveLength(1);
    // Sub was 1 BD after parent → Mar 15 + 1 BD = Mar 16 (Tue)
    expect(result.updates[0].newStart).toBe('2027-03-16');
  });

  it('does not include parent tasks in updates', () => {
    const allTasks = [
      { id: 'parent-1', parentId: null, start: new Date('2027-03-03T00:00:00Z'), end: new Date('2027-04-14T00:00:00Z') },
      { id: 'sub-1', parentId: 'parent-1', name: 'Sub 1', start: new Date('2027-03-03T00:00:00Z'), end: new Date('2027-03-10T00:00:00Z') },
    ];

    const result = computeSubtaskUpdates({
      movedParentIds: ['parent-1'],
      movedParentMap: {
        'parent-1': { newStart: '2027-03-10', newEnd: '2027-04-21' },
      },
      allTasks,
    });

    expect(result.updates).toHaveLength(1);
    expect(result.updates[0].taskId).toBe('sub-1');
  });

  it('ignores subtasks whose parent was not moved', () => {
    const allTasks = [
      { id: 'p1', parentId: null, start: new Date('2027-03-03T00:00:00Z'), end: new Date('2027-03-17T00:00:00Z') },
      { id: 'p2', parentId: null, start: new Date('2027-04-01T00:00:00Z'), end: new Date('2027-04-10T00:00:00Z') },
      { id: 's1', parentId: 'p1', name: 'S1', start: new Date('2027-03-03T00:00:00Z'), end: new Date('2027-03-10T00:00:00Z') },
      { id: 's2', parentId: 'p2', name: 'S2', start: new Date('2027-04-01T00:00:00Z'), end: new Date('2027-04-07T00:00:00Z') },
    ];

    const result = computeSubtaskUpdates({
      movedParentIds: ['p1'],
      movedParentMap: {
        p1: { newStart: '2027-03-10', newEnd: '2027-03-24' },
      },
      allTasks,
    });

    expect(result.updates).toHaveLength(1);
    expect(result.updates[0].taskId).toBe('s1');
  });

  it('handles string dates in allTasks (from normalizeTask)', () => {
    const allTasks = [
      { id: 'parent-1', parentId: null, start: '2027-03-03', end: '2027-04-14' },
      { id: 'sub-1', parentId: 'parent-1', name: 'Sub 1', start: '2027-03-10', end: '2027-03-24' },
    ];

    const result = computeSubtaskUpdates({
      movedParentIds: ['parent-1'],
      movedParentMap: {
        'parent-1': { newStart: '2027-03-10', newEnd: '2027-04-21' },
      },
      allTasks,
    });

    expect(result.updates).toHaveLength(1);
    // Sub was 5 BD after parent → Mar 10 + 5 BD = Mar 17
    expect(result.updates[0].newStart).toBe('2027-03-17');
  });
});
