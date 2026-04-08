import { describe, it, expect } from 'vitest';
import { runCascade } from '../../src/engine/cascade.js';
import { linearTightChain, linearGappedChain, fanIn, chainWithFrozen, gappedUpstreamChain, diamondUpstream, fanOutFromUpstream, preExistingViolation, transitiveViolations, multiBlockerStationary, multiBlockerAllMoved, multiBlockerTightStationary } from '../fixtures/cascade-tasks.js';
import { twoChainSharedTask, crossChainClampedByOtherBlocker, parentWithAccidentalDep } from '../fixtures/cross-chain-tasks.js';

describe('runCascade', () => {
  // @behavior BEH-MODE-PUSH-RIGHT
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

  // @behavior BEH-MODE-PULL-LEFT
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

  // @behavior BEH-MODE-PULL-RIGHT
  // @behavior BEH-MODE-DRAG-RIGHT
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

  // @behavior BEH-COMPLETE-FREEZE
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

    it('frozen upstream blocker does not move in pull-left propagation', () => {
      const tasks = chainWithFrozen();
      const result = runCascade({
        sourceTaskId: 'c',
        sourceTaskName: 'Task C',
        newStart: '2026-04-02',
        newEnd: '2026-04-03',
        refStart: '2026-04-03',
        refEnd: '2026-04-06',
        startDelta: -1,
        endDelta: -1,
        cascadeMode: 'pull-left',
        tasks,
      });

      const bUpdate = result.updates.find((u) => u.taskId === 'b');
      expect(bUpdate).toBeUndefined();
    });

    it('frozen upstream blocker does not move in pull-right propagation', () => {
      const tasks = chainWithFrozen();
      const result = runCascade({
        sourceTaskId: 'c',
        sourceTaskName: 'Task C',
        newStart: '2026-04-06',
        newEnd: '2026-04-07',
        refStart: '2026-04-03',
        refEnd: '2026-04-06',
        startDelta: 1,
        endDelta: 1,
        cascadeMode: 'drag-right',
        tasks,
      });

      const bUpdate = result.updates.find((u) => u.taskId === 'b');
      expect(bUpdate).toBeUndefined();
    });
  });

  // @behavior BEH-PULLRIGHT-ALL-UPSTREAM
  describe('pull-right: ALL upstream shift (gap-preserving)', () => {
    it('pull-right shifts ALL upstream blockers including those with gaps', () => {
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

      // B should be shifted by +1 BD (tight with A)
      const bUpdate = result.updates.find(u => u.taskId === 'b');
      expect(bUpdate).toBeDefined();
      expect(bUpdate.newStart).toBe('2026-04-08'); // Wed (was Tue)
      expect(bUpdate.newEnd).toBe('2026-04-09');   // Thu (was Wed)

      // C should be shifted by +1 BD (tight with B)
      const cUpdate = result.updates.find(u => u.taskId === 'c');
      expect(cUpdate).toBeDefined();
      expect(cUpdate.newStart).toBe('2026-04-06'); // Mon (was Fri)
      expect(cUpdate.newEnd).toBe('2026-04-07');   // Tue (was Mon)

      // D should ALSO be shifted by +1 BD (gap preserved, not skipped)
      const dUpdate = result.updates.find(u => u.taskId === 'd');
      expect(dUpdate).toBeDefined();
      expect(dUpdate.newStart).toBe('2026-03-31'); // Tue (was Mon)
      expect(dUpdate.newEnd).toBe('2026-04-01');   // Wed (was Tue)
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

      // All upstream tasks should shift by +1 BD
      const cUpdate = result.updates.find(u => u.taskId === 'c');
      expect(cUpdate).toBeDefined();
      expect(cUpdate.newStart).toBe('2026-04-06'); // Mon (was Fri)
      expect(cUpdate.newEnd).toBe('2026-04-07');   // Tue (was Mon)

      const bUpdate = result.updates.find(u => u.taskId === 'b');
      expect(bUpdate).toBeDefined();
      expect(bUpdate.newStart).toBe('2026-04-02'); // Thu (was Wed)
      expect(bUpdate.newEnd).toBe('2026-04-03');   // Fri (was Thu)

      const aUpdate = result.updates.find(u => u.taskId === 'a');
      expect(aUpdate).toBeDefined();
      expect(aUpdate.newStart).toBe('2026-03-31'); // Tue (was Mon)
      expect(aUpdate.newEnd).toBe('2026-04-01');   // Wed (was Tue)
    });

    it('pull-right preserves gap sizes between upstream tasks', () => {
      const tasks = gappedUpstreamChain();
      // A start moves right by 2 BD
      const result = runCascade({
        sourceTaskId: 'a',
        sourceTaskName: 'Task A',
        newStart: '2026-04-13', // Mon (was Thu Apr 09, +2 BD)
        newEnd: '2026-04-13',
        refStart: '2026-04-09',
        refEnd: '2026-04-10',
        startDelta: 2,
        endDelta: 0,
        cascadeMode: 'pull-right',
        tasks,
      });

      // All upstream shift by +2 BD
      const dUpdate = result.updates.find(u => u.taskId === 'd');
      expect(dUpdate).toBeDefined();
      expect(dUpdate.newStart).toBe('2026-04-01'); // Wed (was Mon Mar 30, +2 BD)
      expect(dUpdate.newEnd).toBe('2026-04-02');   // Thu (was Tue Mar 31, +2 BD)

      // Gap between D and C was 2 BD (Wed Apr 01, Thu Apr 02) — should still be 2 BD
      const cUpdate = result.updates.find(u => u.taskId === 'c');
      expect(cUpdate).toBeDefined();
      expect(cUpdate.newStart).toBe('2026-04-07'); // Tue (was Fri Apr 03, +2 BD)
      expect(cUpdate.newEnd).toBe('2026-04-08');   // Wed (was Mon Apr 06, +2 BD)
    });

    // @behavior BUG-2A2-DOUBLE-SHIFT
    it('pull-right does not double-shift root blocker reachable via multiple paths (bug 2A.2)', () => {
      const tasks = diamondUpstream();
      // Source start moves +5 BD: Fri Apr 3 → Fri Apr 10
      const result = runCascade({
        sourceTaskId: 'source',
        sourceTaskName: 'Source',
        newStart: '2026-04-10',
        newEnd: '2026-04-13',
        refStart: '2026-04-03',
        refEnd: '2026-04-06',
        startDelta: 5,
        endDelta: 5,
        cascadeMode: 'pull-right',
        tasks,
      });

      // Root should shift exactly +5 BD (Mon Mar 30 → Mon Apr 6)
      // Bug: was shifting +10 BD because root was visited from both mid1 and mid2
      const rootUpdate = result.updates.find(u => u.taskId === 'root');
      expect(rootUpdate).toBeDefined();
      expect(rootUpdate.newStart).toBe('2026-04-06'); // Mon (was Mon Mar 30, +5 BD)
      expect(rootUpdate.newEnd).toBe('2026-04-07');   // Tue (was Tue Mar 31, +5 BD)

      // Mid1 and Mid2 should also shift exactly +5 BD
      const mid1 = result.updates.find(u => u.taskId === 'mid1');
      expect(mid1).toBeDefined();
      expect(mid1.newStart).toBe('2026-04-08'); // Wed (was Wed Apr 1, +5 BD)
      expect(mid1.newEnd).toBe('2026-04-09');   // Thu (was Thu Apr 2, +5 BD)

      const mid2 = result.updates.find(u => u.taskId === 'mid2');
      expect(mid2).toBeDefined();
      expect(mid2.newStart).toBe('2026-04-08');
      expect(mid2.newEnd).toBe('2026-04-09');
    });

    it('drag-right shifts ALL gapped upstream blockers (not just tight)', () => {
      const tasks = gappedUpstreamChain();
      // A dragged right by 1 BD: start Thu→Fri, end Fri→Mon
      const result = runCascade({
        sourceTaskId: 'a',
        sourceTaskName: 'Task A',
        newStart: '2026-04-10', // Fri (was Thu)
        newEnd: '2026-04-13',   // Mon (was Fri)
        refStart: '2026-04-09',
        refEnd: '2026-04-10',
        startDelta: 1,
        endDelta: 1,
        cascadeMode: 'drag-right',
        tasks,
      });

      // Upstream: ALL shift by +1 BD (including D with gap)
      const dUpdate = result.updates.find(u => u.taskId === 'd');
      expect(dUpdate).toBeDefined();
      expect(dUpdate.newStart).toBe('2026-03-31'); // Tue (was Mon)
      expect(dUpdate.newEnd).toBe('2026-04-01');   // Wed (was Tue)

      const cUpdate = result.updates.find(u => u.taskId === 'c');
      expect(cUpdate).toBeDefined();

      const bUpdate = result.updates.find(u => u.taskId === 'b');
      expect(bUpdate).toBeDefined();
    });
  });

  // @behavior BEH-ENDLEFT-ALL-DOWNSTREAM
  describe('end-only-left: ALL downstream shift (gap-preserving)', () => {
    it('end-only-left shifts ALL downstream tasks by uniform delta', () => {
      const tasks = linearTightChain();
      // A end moves left by 1 BD: Tue Mar 31 → Mon Mar 30 (shrink to 1 BD)
      const result = runCascade({
        sourceTaskId: 'a',
        sourceTaskName: 'Task A',
        newStart: '2026-03-30',
        newEnd: '2026-03-30',   // was Mar 31
        refStart: '2026-03-30',
        refEnd: '2026-03-31',
        startDelta: 0,
        endDelta: -1,
        cascadeMode: 'pull-left',
        tasks,
      });

      // ALL downstream must move by -1 BD (uniform, gap-preserving)
      const bUpdate = result.updates.find(u => u.taskId === 'b');
      expect(bUpdate).toBeDefined();
      expect(bUpdate.newStart).toBe('2026-03-31'); // Tue (was Wed)
      expect(bUpdate.newEnd).toBe('2026-04-01');   // Wed (was Thu)

      const cUpdate = result.updates.find(u => u.taskId === 'c');
      expect(cUpdate).toBeDefined();
      expect(cUpdate.newStart).toBe('2026-04-02'); // Thu (was Fri)
      expect(cUpdate.newEnd).toBe('2026-04-03');   // Fri (was Mon)

      const dUpdate = result.updates.find(u => u.taskId === 'd');
      expect(dUpdate).toBeDefined();
      expect(dUpdate.newStart).toBe('2026-04-06'); // Mon (was Tue)
      expect(dUpdate.newEnd).toBe('2026-04-07');   // Tue (was Wed)
    });

    it('end-only-left preserves gaps in downstream chain', () => {
      const tasks = linearGappedChain();
      // A end moves left by 1 BD: Tue Mar 31 → Mon Mar 30
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
        tasks,
      });

      // B had 1 BD gap after A — gap should be preserved
      // B shifts -1 BD: Thu-Fri → Wed-Thu (Apr 01-02)
      const bUpdate = result.updates.find(u => u.taskId === 'b');
      expect(bUpdate).toBeDefined();
      expect(bUpdate.newStart).toBe('2026-04-01'); // Wed (was Thu)
      expect(bUpdate.newEnd).toBe('2026-04-02');   // Thu (was Fri)

      // C shifts -1 BD: Mon-Tue → Fri-Mon (Apr 03-06)
      const cUpdate = result.updates.find(u => u.taskId === 'c');
      expect(cUpdate).toBeDefined();
      expect(cUpdate.newStart).toBe('2026-04-03'); // Fri (was Mon)
      expect(cUpdate.newEnd).toBe('2026-04-06');   // Mon (was Tue)
    });
  });

  // @behavior BEH-CROSSCHAIN-PROPAGATION
  describe('cross-chain propagation', () => {
    it('end-only-left: shifts cross-chain blocker to propagate downstream cascade', () => {
      const tasks = twoChainSharedTask();
      // A end moves left by 1 BD: Tue Mar 31 → Mon Mar 30
      const result = runCascade({
        sourceTaskId: 'a',
        sourceTaskName: 'Task A',
        newStart: '2026-03-30',
        newEnd: '2026-03-30',   // was Mar 31, now Mar 30
        refStart: '2026-03-30',
        refEnd: '2026-03-31',
        startDelta: 0,
        endDelta: -1,
        cascadeMode: 'pull-left',
        tasks,
      });

      // X shifts left by 1 BD (cross-chain: unblocking B)
      // X: Mon Mar 30 - Wed Apr 01 → Fri Mar 27 - Tue Mar 31
      const xUpdate = result.updates.find(u => u.taskId === 'x');
      expect(xUpdate).toBeDefined();
      expect(xUpdate.newStart).toBe('2026-03-27'); // Fri (was Mon)
      expect(xUpdate.newEnd).toBe('2026-03-31');   // Tue (was Wed)

      // B shifts left by 1 BD (now unblocked by shifted X)
      // B: Thu Apr 02 - Fri Apr 03 → Wed Apr 01 - Thu Apr 02
      const bUpdate = result.updates.find(u => u.taskId === 'b');
      expect(bUpdate).toBeDefined();
      expect(bUpdate.newStart).toBe('2026-04-01'); // Wed (was Thu)
      expect(bUpdate.newEnd).toBe('2026-04-02');   // Thu (was Fri)

      // C shifts left by 1 BD (downstream of B)
      // C: Mon Apr 06 - Tue Apr 07 → Fri Apr 03 - Mon Apr 06
      const cUpdate = result.updates.find(u => u.taskId === 'c');
      expect(cUpdate).toBeDefined();
      expect(cUpdate.newStart).toBe('2026-04-03'); // Fri (was Mon)
      expect(cUpdate.newEnd).toBe('2026-04-06');   // Mon (was Tue)
    });

    it('end-only-left: shifts cross-chain blocker so clamped downstream task can move', () => {
      const tasks = crossChainClampedByOtherBlocker();
      // A end moves left by 1 BD: Tue Mar 31 → Mon Mar 30
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
        tasks,
      });

      // B shifts left by 1 BD: Wed-Thu → Tue-Wed (Mar 31 - Apr 01)
      const bUpdate = result.updates.find(u => u.taskId === 'b');
      expect(bUpdate).toBeDefined();
      expect(bUpdate.newStart).toBe('2026-03-31'); // Tue
      expect(bUpdate.newEnd).toBe('2026-04-01');   // Wed

      // C shifts left by 1 BD (cross-chain: unblocking D)
      // C: Wed Apr 01 - Fri Apr 03 → Tue Mar 31 - Thu Apr 02
      const cUpdate = result.updates.find(u => u.taskId === 'c');
      expect(cUpdate).toBeDefined();
      expect(cUpdate.newStart).toBe('2026-03-31'); // Tue (was Wed)
      expect(cUpdate.newEnd).toBe('2026-04-02');   // Thu (was Fri)

      // D shifts left by 1 BD (now unblocked by shifted C)
      // D: Mon Apr 06 - Tue Apr 07 → Fri Apr 03 - Mon Apr 06
      const dUpdate = result.updates.find(u => u.taskId === 'd');
      expect(dUpdate).toBeDefined();
      expect(dUpdate.newStart).toBe('2026-04-03'); // Fri (was Mon)
      expect(dUpdate.newEnd).toBe('2026-04-06');   // Mon (was Tue)
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

  // @behavior BEH-PULL-LEFT-FANOUT
  describe('pull-left fan-out: upstream shifts propagate to other downstream tasks', () => {
    it('shifts upstream task X other downstream D when source B pulls left', () => {
      const tasks = fanOutFromUpstream();
      // B: Apr 01-02. Pull-left: entire task moves left by 1 BD.
      // B becomes Mar 31 - Apr 01. startDelta=-1, endDelta=-1.
      // pullLeftUpstream: B.newStart=Mar 31. X.end=Mar 31. nextBD(Mar 31)=Apr 01 > Mar 31.
      // X must shift left so it finishes before B's new start.
      const result = runCascade({
        sourceTaskId: 'b',
        sourceTaskName: 'Task B',
        newStart: '2026-03-31',   // was Apr 01, now Mar 31
        newEnd: '2026-04-01',     // was Apr 02, now Apr 01
        refStart: '2026-04-01',
        refEnd: '2026-04-02',
        startDelta: -1,
        endDelta: -1,
        cascadeMode: 'pull-left',
        tasks,
      });

      // X should have been shifted left by pullLeftUpstream
      const xUpdate = result.updates.find(u => u.taskId === 'x');
      expect(xUpdate).toBeDefined();

      // D should also shift left (fan-out from X) — this is the Bug 1 fix
      const dUpdate = result.updates.find(u => u.taskId === 'd');
      expect(dUpdate).toBeDefined();
      // D's new start should be earlier than its original (Apr 01)
      expect(dUpdate.newStart < '2026-04-01').toBe(true);

      // C (downstream of B) should also shift
      const cUpdate = result.updates.find(u => u.taskId === 'c');
      expect(cUpdate).toBeDefined();
    });

    it('does not shift fan-out task if clamped by unshifted predecessor', () => {
      // D has two predecessors: X (shifted) and Q (unshifted, ends later).
      // D should stay put because Q's constraint prevents D from moving.
      const tasks = fanOutFromUpstream();
      // Add a second predecessor Q for D that ends later than X
      tasks.push({
        id: 'q',
        name: 'Task Q',
        start: new Date('2026-03-30T00:00:00Z'),
        end: new Date('2026-04-02T00:00:00Z'), // ends Thu Apr 02
        duration: 4,
        status: 'Not Started',
        blockedByIds: [],
        blockingIds: ['d'],
      });
      // Update D to also be blocked by Q
      const d = tasks.find(t => t.id === 'd');
      d.blockedByIds.push('q');

      const result = runCascade({
        sourceTaskId: 'b',
        sourceTaskName: 'Task B',
        newStart: '2026-04-01',
        newEnd: '2026-04-01',
        refStart: '2026-04-01',
        refEnd: '2026-04-02',
        startDelta: 0,
        endDelta: -1,
        cascadeMode: 'pull-left',
        tasks,
      });

      // D should NOT move earlier — Q (ends Apr 02) clamps D to start at nextBD(Apr 02) = Apr 03.
      // D's original start was Apr 01. Q's constraint means D cannot go earlier.
      // D may be pushed right by validation (to Apr 03) since it violates Q's constraint,
      // but it must NOT move left of its original position.
      const dUpdate = result.updates.find(u => u.taskId === 'd');
      if (dUpdate) {
        expect(dUpdate.newStart >= '2026-04-01').toBe(true);
      }
      // Also verify D is NOT in the movedTaskIds with a leftward shift
      const dInMoved = result.movedTaskMap['d'];
      if (dInMoved) {
        expect(dInMoved.newStart >= '2026-04-01').toBe(true);
      }
    });
  });

  // @behavior BEH-CONSTRAINT-VALIDATION
  describe('post-cascade constraint validation', () => {
    it('fixes pre-existing violation outside cascade chain', () => {
      const tasks = preExistingViolation();
      // Add an unrelated source task Z so A→B violation is NOT in the cascade's reachable set
      tasks.push({
        id: 'z', name: 'Task Z',
        start: new Date('2026-04-07T00:00:00Z'),
        end: new Date('2026-04-08T00:00:00Z'),
        duration: 2, status: 'Not Started',
        blockedByIds: [], blockingIds: [],
      });

      const result = runCascade({
        sourceTaskId: 'z',
        sourceTaskName: 'Task Z',
        newStart: '2026-04-07',
        newEnd: '2026-04-09', // push-right by 1 BD
        refStart: '2026-04-07',
        refEnd: '2026-04-08',
        startDelta: 0,
        endDelta: 1,
        cascadeMode: 'push-right',
        tasks,
      });

      // B should be fixed by validateConstraints (not by conflictOnlyDownstream)
      const bUpdate = result.updates.find(u => u.taskId === 'b');
      expect(bUpdate).toBeDefined();
      expect(bUpdate.newStart).toBe('2026-04-01');

      expect(result.diagnostics.constraintFixCount).toBeGreaterThan(0);
      expect(result.diagnostics.constraintFixTaskIds).toContain('b');
    });

    it('cascades through transitive violations', () => {
      const tasks = transitiveViolations();
      // Add unrelated source Z so A→B→C violations are fixed by validateConstraints
      tasks.push({
        id: 'z', name: 'Task Z',
        start: new Date('2026-04-07T00:00:00Z'),
        end: new Date('2026-04-08T00:00:00Z'),
        duration: 2, status: 'Not Started',
        blockedByIds: [], blockingIds: [],
      });

      const result = runCascade({
        sourceTaskId: 'z',
        sourceTaskName: 'Task Z',
        newStart: '2026-04-07',
        newEnd: '2026-04-09',
        refStart: '2026-04-07',
        refEnd: '2026-04-08',
        startDelta: 0,
        endDelta: 1,
        cascadeMode: 'push-right',
        tasks,
      });

      const bUpdate = result.updates.find(u => u.taskId === 'b');
      const cUpdate = result.updates.find(u => u.taskId === 'c');
      expect(bUpdate).toBeDefined();
      expect(cUpdate).toBeDefined();
      expect(bUpdate.newStart).toBe('2026-04-01'); // nextBD(Mar 31) = Apr 01
      expect(cUpdate.newStart).toBe('2026-04-03'); // B ends Apr 02 → nextBD = Apr 03
    });

    it('does not collapse gaps', () => {
      const tasks = linearGappedChain();
      // A: Mar 30-31, B: Apr 02-03 (1 BD gap), C: Apr 06-07
      // Push-right no-op — the gap should be preserved, B should NOT move
      const result = runCascade({
        sourceTaskId: 'a',
        sourceTaskName: 'Task A',
        newStart: '2026-03-30',
        newEnd: '2026-03-31',
        refStart: '2026-03-30',
        refEnd: '2026-03-31',
        startDelta: 0,
        endDelta: 0,
        cascadeMode: 'push-right',
        tasks,
      });

      // B has a gap after A — should NOT be collapsed
      const bUpdate = result.updates.find(u => u.taskId === 'b');
      expect(bUpdate).toBeUndefined(); // B should not be touched
      expect(result.diagnostics.constraintFixCount).toBe(0);
    });

    it('reports diagnostics for constraint fixes', () => {
      const tasks = preExistingViolation();
      tasks.push({
        id: 'z', name: 'Task Z',
        start: new Date('2026-04-07T00:00:00Z'),
        end: new Date('2026-04-08T00:00:00Z'),
        duration: 2, status: 'Not Started',
        blockedByIds: [], blockingIds: [],
      });

      const result = runCascade({
        sourceTaskId: 'z',
        sourceTaskName: 'Task Z',
        newStart: '2026-04-07',
        newEnd: '2026-04-09',
        refStart: '2026-04-07',
        refEnd: '2026-04-08',
        startDelta: 0,
        endDelta: 1,
        cascadeMode: 'push-right',
        tasks,
      });

      expect(typeof result.diagnostics.constraintFixCount).toBe('number');
      expect(Array.isArray(result.diagnostics.constraintFixTaskIds)).toBe(true);
      expect(result.diagnostics.constraintFixCount).toBeGreaterThan(0);
    });
  });

  // @behavior BEH-BL-H4g
  describe('BL-H4g: stationary blocker gap guard', () => {
    it('multi-blocker: stationary predecessor with gap prevents downstream shift', () => {
      const tasks = multiBlockerStationary();
      // A's end shrinks by 2 BD: Apr 02 → Mar 31
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
        tasks,
      });

      // B should shift left (only blocker is A, which is a seed)
      const bUpdate = result.updates.find(u => u.taskId === 'b');
      expect(bUpdate).toBeDefined();
      expect(bUpdate.newStart).toBe('2026-04-01');
      expect(bUpdate.newEnd).toBe('2026-04-02');

      // D should NOT move — C is stationary with a gap
      const dUpdate = result.updates.find(u => u.taskId === 'd');
      expect(dUpdate).toBeUndefined();
    });

    it('multi-blocker: all blockers moved allows downstream shift', () => {
      const tasks = multiBlockerAllMoved();
      // A's end shrinks by 2 BD: Apr 02 → Mar 31
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
        tasks,
      });

      // Both B and C should shift (both downstream of A)
      const bUpdate = result.updates.find(u => u.taskId === 'b');
      expect(bUpdate).toBeDefined();
      const cUpdate = result.updates.find(u => u.taskId === 'c');
      expect(cUpdate).toBeDefined();

      // D should also shift (all blockers moved)
      const dUpdate = result.updates.find(u => u.taskId === 'd');
      expect(dUpdate).toBeDefined();
    });

    it('multi-blocker: tight stationary blocker allows cross-chain resolution (no gap)', () => {
      const tasks = multiBlockerTightStationary();
      // A's end shrinks by 2 BD: Apr 02 → Mar 31
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
        tasks,
      });

      // B should shift left
      const bUpdate = result.updates.find(u => u.taskId === 'b');
      expect(bUpdate).toBeDefined();

      // D is tight with C (no gap) — gap guard does NOT skip.
      // Frustration resolver shifts C left to make room, then D moves.
      // This is correct cross-chain propagation behavior.
      const cUpdate = result.updates.find(u => u.taskId === 'c');
      expect(cUpdate).toBeDefined();
      const dUpdate = result.updates.find(u => u.taskId === 'd');
      expect(dUpdate).toBeDefined();
      expect(dUpdate.newStart).toBe('2026-04-07');
      expect(dUpdate.newEnd).toBe('2026-04-08');
    });
  });

  // @behavior BEH-BL-H5g
  describe('BL-H5g: ignore parent-level dependency edges', () => {
    it('parent-level dependency edges are ignored', () => {
      const tasks = parentWithAccidentalDep();
      // Push-right on X: end moves right by 2 BD
      const result = runCascade({
        sourceTaskId: 'x',
        sourceTaskName: 'Task X',
        newStart: '2026-03-30',
        newEnd: '2026-04-02',
        refStart: '2026-03-30',
        refEnd: '2026-03-31',
        startDelta: 0,
        endDelta: 2,
        cascadeMode: 'push-right',
        tasks,
      });

      // P's dep edges should have been stripped — X's push should NOT cascade to P, S1, or S2
      const pUpdate = result.updates.find(u => u.taskId === 'p');
      expect(pUpdate).toBeUndefined();
      const s1Update = result.updates.find(u => u.taskId === 's1');
      expect(s1Update).toBeUndefined();
      const s2Update = result.updates.find(u => u.taskId === 's2');
      expect(s2Update).toBeUndefined();
    });
  });
});
