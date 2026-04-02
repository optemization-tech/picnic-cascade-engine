import { describe, it, expect } from 'vitest';
import { classify } from '../../src/engine/classify.js';

describe('classify', () => {
  // @behavior BEH-MODE-PUSH-RIGHT
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

  // @behavior BEH-MODE-PULL-LEFT
  // @behavior BEH-MODE-DRAG-RIGHT
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

  // @behavior BEH-MODE-PULL-RIGHT
  it('maps pull-right deltas correctly', () => {
    const result = classify(
      {
        taskId: 't1',
        taskName: 'Task 1',
        newStart: '2026-04-02',
        newEnd: '2026-04-02',
        refStart: '2026-04-01',
        refEnd: '2026-04-02',
        hasParent: false,
      },
      [],
      1,
      0,
    );

    expect(result.skip).toBe(false);
    expect(result.cascadeMode).toBe('pull-right');
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

  // @behavior BEH-PARENT-DIRECT-EDIT-BLOCK
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

  it('preserves start-only edit when stale refs would create false drag', () => {
    // User only pulled start left, but DB refEnd differs from webhook refEnd.
    // Without the fix, stale-ref correction would make endDelta non-zero,
    // triggering drag normalization and moving the end date.
    const result = classify(
      {
        taskId: 'task-a',
        taskName: 'Task A',
        newStart: '2026-04-01', // user pulled start left
        newEnd: '2026-04-04',   // user did NOT change end
        refStart: '2026-04-02', // webhook ref
        refEnd: '2026-04-04',   // webhook ref matches end (user didn't change it)
        hasParent: false,
      },
      [
        {
          id: 'task-a',
          refStart: '2026-04-03', // DB ref differs (stale)
          refEnd: '2026-04-05',   // DB refEnd differs from newEnd
        },
      ],
      -1, // startDelta: user moved start left
      0,  // endDelta: user did NOT change end
    );

    expect(result.staleRefCorrected).toBe(true);
    expect(result.startDelta).not.toBe(0); // start was recalculated against DB ref
    expect(result.endDelta).toBe(0);       // end must stay 0 — user didn't change it
    expect(result.cascadeMode).toBe('pull-left'); // start-only left, not drag
    expect(result.newEnd).toBe('2026-04-04'); // end date must NOT change
  });

  it('preserves end-only edit when stale refs would create false drag', () => {
    const result = classify(
      {
        taskId: 'task-a',
        taskName: 'Task A',
        newStart: '2026-04-06', // user did NOT change start (Monday)
        newEnd: '2026-04-09',   // user pushed end right (Thursday)
        refStart: '2026-04-06',
        refEnd: '2026-04-08',   // webhook ref (Wednesday)
        hasParent: false,
      },
      [
        {
          id: 'task-a',
          refStart: '2026-04-02', // DB refStart differs (Thursday prev week)
          refEnd: '2026-04-07',   // DB refEnd differs (Tuesday)
        },
      ],
      0,  // startDelta: user did NOT change start
      1,  // endDelta: user pushed end right
    );

    expect(result.staleRefCorrected).toBe(true);
    expect(result.startDelta).toBe(0);       // start must stay 0
    expect(result.endDelta).not.toBe(0);     // end was recalculated
    expect(result.cascadeMode).toBe('push-right'); // end-only right
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
