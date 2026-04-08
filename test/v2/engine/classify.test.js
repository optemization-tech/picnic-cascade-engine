import { describe, it, expect } from 'vitest';
import { classify } from '../../../src/v2/engine/classify.js';

describe('V2 classify', () => {
  const baseTask = {
    taskId: 'task-1',
    taskName: 'Test Task',
    newStart: '2027-03-10',
    newEnd: '2027-03-17',
    refStart: '2027-03-10',
    refEnd: '2027-03-15',
  };

  describe('cascade mode classification', () => {
    it('end-only right → push-right', () => {
      const result = classify(baseTask, [], 0, 2);
      expect(result.cascadeMode).toBe('push-right');
      expect(result.skip).toBe(false);
    });

    it('end-only left → pull-left', () => {
      const result = classify(baseTask, [], 0, -2);
      expect(result.cascadeMode).toBe('pull-left');
    });

    it('start-only left → start-left', () => {
      const result = classify(baseTask, [], -2, 0);
      expect(result.cascadeMode).toBe('start-left');
    });

    it('start-only right → pull-right', () => {
      const result = classify(baseTask, [], 2, 0);
      expect(result.cascadeMode).toBe('pull-right');
    });

    it('both positive → drag-right', () => {
      const result = classify(baseTask, [], 2, 2);
      expect(result.cascadeMode).toBe('drag-right');
    });

    it('both negative → drag-left', () => {
      const result = classify(baseTask, [], -2, -2);
      expect(result.cascadeMode).toBe('drag-left');
    });

    it('zero/zero → null mode', () => {
      const result = classify(baseTask, [], 0, 0);
      expect(result.cascadeMode).toBeNull();
    });
  });

  describe('no parent guard (V2 key difference)', () => {
    it('accepts push-right on parent task without blocking', () => {
      // In V1 this would return skip=true with "Direct parent edit blocked"
      const parentTask = { ...baseTask };
      const subtasks = [
        { id: 'sub-1', parentId: 'task-1', name: 'Sub 1' },
        { id: 'sub-2', parentId: 'task-1', name: 'Sub 2' },
      ];

      const result = classify(parentTask, subtasks, 0, 3);
      expect(result.skip).toBe(false);
      expect(result.cascadeMode).toBe('push-right');
    });

    it('accepts pull-right on parent task without blocking', () => {
      const parentTask = { ...baseTask };
      const subtasks = [
        { id: 'sub-1', parentId: 'task-1', name: 'Sub 1' },
      ];

      const result = classify(parentTask, subtasks, 3, 0);
      expect(result.skip).toBe(false);
      expect(result.cascadeMode).toBe('pull-right');
    });
  });

  describe('no parentMode in return', () => {
    it('does not include parentMode or parentTaskId', () => {
      const task = { ...baseTask, parentTaskId: 'parent-1', hasParent: true };
      const result = classify(task, [], 0, 2);
      expect(result).not.toHaveProperty('parentMode');
      expect(result).not.toHaveProperty('parentTaskId');
    });
  });

  describe('stale reference correction', () => {
    it('corrects deltas when DB refs differ from webhook refs', () => {
      const task = {
        ...baseTask,
        refStart: '2027-03-08', // webhook ref (stale)
        refEnd: '2027-03-13',   // webhook ref (stale)
      };

      const allTasks = [{
        id: 'task-1',
        refStart: '2027-03-10', // DB ref (current)
        refEnd: '2027-03-15',   // DB ref (current)
      }];

      // Webhook says startDelta=0, endDelta=2 based on stale refs
      const result = classify(task, allTasks, 0, 2);
      expect(result.staleRefCorrected).toBe(true);
      expect(result.refStart).toBe('2027-03-10');
      expect(result.refEnd).toBe('2027-03-15');
    });

    it('does not correct when DB refs match webhook refs', () => {
      const allTasks = [{
        id: 'task-1',
        refStart: '2027-03-10',
        refEnd: '2027-03-15',
      }];

      const result = classify(baseTask, allTasks, 0, 2);
      expect(result.staleRefCorrected).toBe(false);
    });
  });

  describe('return shape', () => {
    it('returns all expected fields', () => {
      const result = classify(baseTask, [], 0, 2);
      expect(result).toHaveProperty('skip');
      expect(result).toHaveProperty('reason');
      expect(result).toHaveProperty('sourceTaskId');
      expect(result).toHaveProperty('sourceTaskName');
      expect(result).toHaveProperty('newStart');
      expect(result).toHaveProperty('newEnd');
      expect(result).toHaveProperty('refStart');
      expect(result).toHaveProperty('refEnd');
      expect(result).toHaveProperty('startDelta');
      expect(result).toHaveProperty('endDelta');
      expect(result).toHaveProperty('cascadeMode');
      expect(result).toHaveProperty('staleRefCorrected');
    });
  });
});
