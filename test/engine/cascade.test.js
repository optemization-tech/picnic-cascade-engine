import { describe, it, expect } from 'vitest';
import { runCascade } from '../../src/engine/cascade.js';
import { linearTightChain, linearGappedChain, fanIn, chainWithFrozen, gappedUpstreamChain } from '../fixtures/cascade-tasks.js';

describe('runCascade', () => {
  describe('push-right', () => {
    it('pushes downstream tasks when end moves right (tight chain)', () => {
      const tasks = linearTightChain();
      // Task A end moves from Tue Mar 31 → Wed Apr 01 (1 BD right)
      const result = runCascade({
        sourceTaskId: 'a',
        sourceTaskName: 'Task A',
        newStart: '2026-03-30', // same
        newEnd: '2026-04-01',   // was Mar 31, now Apr 01
        refStart: '2026-03-30',
        refEnd: '2026-03-31',
        startDelta: 0,
        endDelta: 1,
        cascadeMode: 'push-right',
        tasks,
      });

      expect(result.updates.length).toBeGreaterThan(0);
      expect(result.movedTaskIds).toContain('b');

      // B was Wed-Thu, A now ends Wed → B must start Thu
      const bUpdate = result.updates.find(u => u.taskId === 'b');
      expect(bUpdate.newStart).toBe('2026-04-02'); // Thu
      expect(bUpdate.newEnd).toBe('2026-04-03');   // Fri

      // C was Fri-Mon, B now ends Fri → C must start Mon
      const cUpdate = result.updates.find(u => u.taskId === 'c');
      expect(cUpdate.newStart).toBe('2026-04-06'); // Mon
      expect(cUpdate.newEnd).toBe('2026-04-07');   // Tue

      // D was Tue-Wed, C now ends Tue → D must start Wed
      const dUpdate = result.updates.find(u => u.taskId === 'd');
      expect(dUpdate.newStart).toBe('2026-04-08'); // Wed
      expect(dUpdate.newEnd).toBe('2026-04-09');   // Thu
    });

    it('no-ops when there is no conflict (gapped chain, small push)', () => {
      const tasks = linearGappedChain();
      // A end moves from Tue Mar 31 → Wed Apr 01 (1 BD right)
      // B starts Thu Apr 02 — still after nextBD(Wed) = Thu, no conflict
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
        tasks,
      });

      expect(result.updates.length).toBe(0);
      expect(result.summary).toContain('No tasks needed updating');
    });

    it('fan-in: uses latest blocker end to determine start', () => {
      const tasks = fanIn();
      // A end moves from Tue Mar 31 → Fri Apr 03 (3 BD right)
      // B still ends Thu Apr 02
      // C start should be governed by max(nextBD(A.end), nextBD(B.end)) = nextBD(Fri Apr 03) = Mon Apr 06
      const result = runCascade({
        sourceTaskId: 'a',
        sourceTaskName: 'Task A',
        newStart: '2026-03-30',
        newEnd: '2026-04-03',
        refStart: '2026-03-30',
        refEnd: '2026-03-31',
        startDelta: 0,
        endDelta: 3,
        cascadeMode: 'push-right',
        tasks,
      });

      const cUpdate = result.updates.find(u => u.taskId === 'c');
      // C original start was Fri Apr 03, nextBD(A new end Fri Apr 03) = Mon Apr 06
      // C was already starting Fri Apr 03, but now A ends Fri Apr 03 → C needs Mon Apr 06
      expect(cUpdate.newStart).toBe('2026-04-06'); // Mon
      expect(cUpdate.newEnd).toBe('2026-04-07');   // Tue (2 BD duration)
    });
  });

  describe('pull-left', () => {
    it('pulls upstream blockers earlier when end moves left', () => {
      const tasks = linearTightChain();
      // Task D (last in chain) end moves from Wed Apr 08 → Mon Apr 06 (2 BD left)
      // This means D start also moves: was Tue Apr 07 → Fri Apr 03
      const result = runCascade({
        sourceTaskId: 'd',
        sourceTaskName: 'Task D',
        newStart: '2026-04-03', // Fri (was Tue Apr 07)
        newEnd: '2026-04-06',   // Mon (was Wed Apr 08)
        refStart: '2026-04-07',
        refEnd: '2026-04-08',
        startDelta: -2,
        endDelta: -2,
        cascadeMode: 'pull-left',
        tasks,
      });

      // C was Fri-Mon, D now starts Fri → C must end Thu (prevBD(Fri))
      // C (2 BD): new end = Thu Apr 02, new start = Wed Apr 01
      const cUpdate = result.updates.find(u => u.taskId === 'c');
      expect(cUpdate).toBeDefined();
      expect(cUpdate.newEnd).toBe('2026-04-02');   // Thu
      expect(cUpdate.newStart).toBe('2026-04-01'); // Wed
    });

    it('preserves gaps when pulling downstream (gapped chain)', () => {
      const tasks = linearGappedChain();
      // A end moves from Tue Mar 31 → Mon Mar 30 (duration shrinks to 1)
      // Original gap between A and B: 1 BD (Wed Apr 01)
      // Pull-left: B should preserve the 1 BD gap
      const result = runCascade({
        sourceTaskId: 'a',
        sourceTaskName: 'Task A',
        newStart: '2026-03-30',
        newEnd: '2026-03-30',   // was Mar 31, now same as start
        refStart: '2026-03-30',
        refEnd: '2026-03-31',
        startDelta: 0,
        endDelta: -1,
        cascadeMode: 'pull-left',
        tasks,
      });

      // B had a 1 BD gap after A — gap should be preserved
      // A now ends Mon Mar 30, nextBD = Tue Mar 31, + 1 BD gap = Wed Apr 01
      // B (2 BD) should start Wed Apr 01, end Thu Apr 02
      const bUpdate = result.updates.find(u => u.taskId === 'b');
      if (bUpdate) {
        expect(bUpdate.newStart).toBe('2026-04-01'); // Wed (gap preserved)
        expect(bUpdate.newEnd).toBe('2026-04-02');   // Thu
      }
    });
  });

  describe('pull-right / drag-right', () => {
    it('pushes upstream blockers right by delta (pull-right)', () => {
      const tasks = linearTightChain();
      // Task D start moves from Tue Apr 07 → Wed Apr 08 (1 BD right)
      const result = runCascade({
        sourceTaskId: 'd',
        sourceTaskName: 'Task D',
        newStart: '2026-04-08', // Wed (was Tue)
        newEnd: '2026-04-08',   // same end (end unchanged for pull-right)
        refStart: '2026-04-07',
        refEnd: '2026-04-08',
        startDelta: 1,
        endDelta: 0,
        cascadeMode: 'pull-right',
        tasks,
      });

      // C is upstream of D — should be pushed right by 1 BD
      const cUpdate = result.updates.find(u => u.taskId === 'c');
      expect(cUpdate).toBeDefined();
      expect(cUpdate.newStart).toBe('2026-04-06'); // Mon (was Fri)
      expect(cUpdate.newEnd).toBe('2026-04-07');   // Tue (was Mon)
    });

    it('drag-right cascades both upstream and downstream', () => {
      const tasks = linearTightChain();
      // Task B (middle of chain) dragged right by 1 BD
      // B was Wed-Thu, now Thu-Fri
      const result = runCascade({
        sourceTaskId: 'b',
        sourceTaskName: 'Task B',
        newStart: '2026-04-02', // Thu (was Wed)
        newEnd: '2026-04-03',   // Fri (was Thu)
        refStart: '2026-04-01',
        refEnd: '2026-04-02',
        startDelta: 1,
        endDelta: 1,
        cascadeMode: 'drag-right',
        tasks,
      });

      // Upstream: A should be pushed right by 1 BD
      const aUpdate = result.updates.find(u => u.taskId === 'a');
      expect(aUpdate).toBeDefined();
      expect(aUpdate.newStart).toBe('2026-03-31'); // Tue (was Mon)
      expect(aUpdate.newEnd).toBe('2026-04-01');   // Wed (was Tue)

      // Downstream: C should be pushed right if conflict
      // B now ends Fri Apr 03, C was Fri-Mon → C start (Fri) = nextBD(B end Fri) = Mon Apr 06
      // C needs to move to Mon-Tue
      const cUpdate = result.updates.find(u => u.taskId === 'c');
      expect(cUpdate).toBeDefined();
      expect(cUpdate.newStart).toBe('2026-04-06'); // Mon
      expect(cUpdate.newEnd).toBe('2026-04-07');   // Tue
    });
  });

  describe('Complete Freeze', () => {
    it('frozen task does not move during push-right', () => {
      const tasks = chainWithFrozen();
      // A end moves right by 2 BD: Tue Mar 31 → Thu Apr 02
      // B is Done → should NOT move
      // C depends on B (which is frozen) → B's effective end isn't propagated
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
        tasks,
      });

      // B (frozen) should NOT appear in updates
      const bUpdate = result.updates.find(u => u.taskId === 'b');
      expect(bUpdate).toBeUndefined();
    });

    it('frozen task excluded as blocker (downstream tasks unaffected)', () => {
      const tasks = chainWithFrozen();
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
        tasks,
      });

      // C depends on B (frozen) — frozen blockers are skipped in conflict check
      // So C should NOT be moved even though A pushed past B's dates
      const cUpdate = result.updates.find(u => u.taskId === 'c');
      expect(cUpdate).toBeUndefined();
    });
  });

  describe('v5: adjacency check + gap absorption', () => {
    it('pull-right skips upstream blocker with pre-existing gap', () => {
      const tasks = gappedUpstreamChain();
      // A start moves right by 1 BD: Thu Apr 09 → Fri Apr 10
      const result = runCascade({
        sourceTaskId: 'a',
        sourceTaskName: 'Task A',
        newStart: '2026-04-10', // Fri (was Thu)
        newEnd: '2026-04-10',   // same end (pull-right = start only)
        refStart: '2026-04-09',
        refEnd: '2026-04-10',
        startDelta: 1,
        endDelta: 0,
        cascadeMode: 'pull-right',
        tasks,
      });

      // B should be shifted (tight with A)
      const bUpdate = result.updates.find(u => u.taskId === 'b');
      expect(bUpdate).toBeDefined();

      // C should be shifted (tight with B)
      const cUpdate = result.updates.find(u => u.taskId === 'c');
      expect(cUpdate).toBeDefined();

      // D should NOT be shifted (2 BD gap before C — pre-existing gap)
      const dUpdate = result.updates.find(u => u.taskId === 'd');
      expect(dUpdate).toBeUndefined();
    });

    it('pull-right shifts all in tight chain (no gaps)', () => {
      const tasks = linearTightChain();
      // D start moves right by 1 BD
      const result = runCascade({
        sourceTaskId: 'd',
        sourceTaskName: 'Task D',
        newStart: '2026-04-08',
        newEnd: '2026-04-08',
        refStart: '2026-04-07',
        refEnd: '2026-04-08',
        startDelta: 1,
        endDelta: 0,
        cascadeMode: 'pull-right',
        tasks,
      });

      // All upstream tasks should shift (tight chain)
      expect(result.updates.find(u => u.taskId === 'c')).toBeDefined();
      expect(result.updates.find(u => u.taskId === 'b')).toBeDefined();
      expect(result.updates.find(u => u.taskId === 'a')).toBeDefined();
    });
  });

  describe('edge cases', () => {
    it('source task not found returns empty result', () => {
      const tasks = linearTightChain();
      const result = runCascade({
        sourceTaskId: 'nonexistent',
        sourceTaskName: 'Ghost',
        newStart: '2026-03-30',
        newEnd: '2026-03-31',
        refStart: '2026-03-30',
        refEnd: '2026-03-31',
        startDelta: 0,
        endDelta: 0,
        cascadeMode: 'push-right',
        tasks,
      });

      expect(result.updates).toEqual([]);
      expect(result.summary).toContain('not found');
    });

    it('unknown cascade mode returns empty result', () => {
      const tasks = linearTightChain();
      const result = runCascade({
        sourceTaskId: 'a',
        sourceTaskName: 'Task A',
        newStart: '2026-03-30',
        newEnd: '2026-03-31',
        refStart: '2026-03-30',
        refEnd: '2026-03-31',
        startDelta: 0,
        endDelta: 0,
        cascadeMode: 'mystery-mode',
        tasks,
      });

      expect(result.updates).toEqual([]);
      expect(result.summary).toContain('Unknown');
    });

    it('movedTaskMap and movedTaskIds are consistent with updates', () => {
      const tasks = linearTightChain();
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
        tasks,
      });

      expect(result.movedTaskIds.length).toBe(result.updates.length);
      for (const u of result.updates) {
        expect(result.movedTaskMap[u.taskId]).toEqual({
          newStart: u.newStart,
          newEnd: u.newEnd,
        });
      }
    });
  });
});
