import { describe, it, expect } from 'vitest';
import { enforceConstraints } from '../../src/engine/constraints.js';
import { parseDate } from '../../src/utils/business-days.js';

describe('enforceConstraints', () => {
  it('snaps source right when blocker constraint violated', () => {
    const result = enforceConstraints({
      task: {
        taskId: 'source',
        refStart: '2026-04-01',
        refEnd: '2026-04-02',
        newStart: '2026-04-01',
        newEnd: '2026-04-02',
      },
      cascadeResult: {
        movedTaskMap: {
          blocker: { newStart: '2026-04-02', newEnd: '2026-04-03' }, // Fri
        },
      },
      parentResult: {},
      allTasks: [
        {
          id: 'source',
          start: parseDate('2026-04-01'),
          end: parseDate('2026-04-02'),
          blockedByIds: ['blocker'],
          status: 'Not Started',
        },
        {
          id: 'blocker',
          start: parseDate('2026-04-02'),
          end: parseDate('2026-04-03'),
          blockedByIds: [],
          status: 'Not Started',
        },
      ],
    });

    expect(result.constrained).toBe(true);
    expect(result.newStart).toBe('2026-04-06'); // next BD after Fri
    expect(result.newEnd).toBe('2026-04-07');
  });

  it('uses case-a roll-up as authoritative output', () => {
    const result = enforceConstraints({
      task: {
        taskId: 'parent',
        refStart: '2026-04-01',
        refEnd: '2026-04-03',
        newStart: '2026-04-04',
        newEnd: '2026-04-07',
      },
      cascadeResult: { movedTaskMap: {} },
      parentResult: {
        parentMode: 'case-a',
        rolledUpStart: '2026-04-01',
        rolledUpEnd: '2026-04-03',
      },
      allTasks: [],
    });

    expect(result.merged).toBe(true);
    expect(result.newStart).toBe('2026-04-01');
    expect(result.newEnd).toBe('2026-04-03');
  });
});
