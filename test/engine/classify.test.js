import { describe, it, expect } from 'vitest';
import { classify } from '../../src/engine/classify.js';

describe('classify', () => {
  it('maps push-right deltas correctly', () => {
    const result = classify(
      {
        taskId: 't1',
        taskName: 'Task 1',
        newStart: '2026-04-01',
        newEnd: '2026-04-03',
        refStart: '2026-04-01',
        refEnd: '2026-04-02',
        hasParent: false,
      },
      [],
      0,
      1,
    );

    expect(result.skip).toBe(false);
    expect(result.cascadeMode).toBe('push-right');
  });

  it('maps pull-left and drag-right deltas correctly', () => {
    const pullLeft = classify(
      {
        taskId: 't1',
        taskName: 'Task 1',
        newStart: '2026-04-01',
        newEnd: '2026-04-01',
        refStart: '2026-04-01',
        refEnd: '2026-04-03',
        hasParent: false,
      },
      [],
      0,
      -2,
    );
    expect(pullLeft.cascadeMode).toBe('pull-left');

    const dragRight = classify(
      {
        taskId: 't1',
        taskName: 'Task 1',
        newStart: '2026-04-02',
        newEnd: '2026-04-03',
        refStart: '2026-04-01',
        refEnd: '2026-04-02',
        hasParent: false,
      },
      [],
      1,
      1,
    );
    expect(dragRight.cascadeMode).toBe('drag-right');
  });

  it('sets case-a when source has subtasks in graph', () => {
    const result = classify(
      {
        taskId: 'parent',
        taskName: 'Parent',
        newStart: '2026-04-01',
        newEnd: '2026-04-01',
        refStart: '2026-04-01',
        refEnd: '2026-04-02',
        hasParent: false,
      },
      [
        { id: 'child-1', parentId: 'parent' },
        { id: 'child-2', parentId: 'parent' },
      ],
      0,
      -1,
    );

    expect(result.parentMode).toBe('case-a');
  });

  it('sets case-b when source has parent and no subtasks', () => {
    const result = classify(
      {
        taskId: 'child',
        taskName: 'Child',
        newStart: '2026-04-01',
        newEnd: '2026-04-03',
        refStart: '2026-04-01',
        refEnd: '2026-04-02',
        hasParent: true,
        parentTaskId: 'parent',
      },
      [],
      0,
      1,
    );

    expect(result.parentMode).toBe('case-b');
  });

  it('blocks direct right-shift edits on top-level parent tasks', () => {
    const result = classify(
      {
        taskId: 'parent',
        taskName: 'Parent',
        newStart: '2026-04-01',
        newEnd: '2026-04-03',
        refStart: '2026-04-01',
        refEnd: '2026-04-02',
        hasParent: false,
      },
      [{ id: 'child', parentId: 'parent' }],
      0,
      1,
    );

    expect(result.skip).toBe(true);
    expect(result.cascadeMode).toBeNull();
    expect(result.parentMode).toBeNull();
    expect(result.reason).toContain('Direct parent edit blocked');
  });

  it('corrects stale reference dates from DB snapshot', () => {
    const result = classify(
      {
        taskId: 'task-a',
        taskName: 'Task A',
        newStart: '2026-04-02',
        newEnd: '2026-04-03',
        refStart: '2026-04-01',
        refEnd: '2026-04-02',
        hasParent: false,
      },
      [
        {
          id: 'task-a',
          refStart: '2026-03-31',
          refEnd: '2026-04-01',
        },
      ],
      1,
      1,
    );

    expect(result.staleRefCorrected).toBe(true);
    expect(result.refStart).toBe('2026-03-31');
    expect(result.refEnd).toBe('2026-04-01');
    expect(result.startDelta).toBe(2);
    expect(result.endDelta).toBe(2);
    expect(result.cascadeMode).toBe('drag-right');
  });
});
