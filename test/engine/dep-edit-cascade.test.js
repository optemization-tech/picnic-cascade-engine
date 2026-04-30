import { describe, expect, it } from 'vitest';

import { tightenSeedAndDownstream } from '../../src/engine/cascade.js';
import { runParentSubtask } from '../../src/engine/parent-subtask.js';
import { parseDate, countBDInclusive } from '../../src/utils/business-days.js';
import {
  fanIn,
  linearTightChain,
  task,
} from '../fixtures/cascade-tasks.js';
import { parentWithAccidentalDep } from '../fixtures/cross-chain-tasks.js';

// -----------------------------------------------------------
// Dep-edit-specific scenario fixtures. The generic `task()` builder
// is imported from cascade-tasks.js to avoid duplicating the helper
// (and its drift-prone signature) across test files.
// -----------------------------------------------------------

/**
 * Violation chain: A→B where A's end overlaps B's start.
 * A: Mar 30 - Apr 03 (5 BD)
 * B: Apr 01 - Apr 02 (2 BD)   ← starts during A
 *
 * Wiring A as blocker on B: nextBD(A.end=Apr 03) = Apr 06.
 * Expect B.newStart = Apr 06, subcase = 'violation'.
 */
function violationChain() {
  return [
    task('a', 'Task A', '2026-03-30', '2026-04-03', { blockingIds: ['b'] }),
    task('b', 'Task B', '2026-04-01', '2026-04-02', { blockedByIds: ['a'] }),
  ];
}

/**
 * Gap chain: A→B with a multi-BD gap.
 * A: Mar 30 - Mar 31 (2 BD)
 * B: Apr 13 - Apr 14 (2 BD)   ← starts ~8 BD after A ends
 *
 * Wiring A as blocker on B: nextBD(A.end=Mar 31) = Apr 01.
 * Expect B.newStart = Apr 01, subcase = 'gap'.
 */
function gapChain() {
  return [
    task('a', 'Task A', '2026-03-30', '2026-03-31', { blockingIds: ['b'] }),
    task('b', 'Task B', '2026-04-13', '2026-04-14', { blockedByIds: ['a'] }),
  ];
}

/**
 * Chain-wide violation: A → B → C, all wired. A's end overlaps B's start;
 * after B tightens, C must also re-tighten against B's new end.
 *
 * A: Mar 30 - Apr 03 (5 BD)
 * B: Apr 01 - Apr 02 (2 BD)   ← overlap with A
 * C: Apr 03 - Apr 06 (2 BD)   ← currently butt-to-butt after B
 *
 * Edit B's blocker (now wired A→B). Expect:
 *   B.newStart = Apr 06 (nextBD after A.end Apr 03)
 *   B.newEnd   = Apr 07 (preserves 2 BD duration)
 *   C.newStart = Apr 08 (nextBD after B.newEnd Apr 07)
 *   C.newEnd   = Apr 09 (preserves 2 BD duration)
 */
function chainWideViolation() {
  return [
    task('a', 'Task A', '2026-03-30', '2026-04-03', { blockingIds: ['b'] }),
    task('b', 'Task B', '2026-04-01', '2026-04-02', { blockedByIds: ['a'], blockingIds: ['c'] }),
    task('c', 'Task C', '2026-04-03', '2026-04-06', { blockedByIds: ['b'] }),
  ];
}

/**
 * Frozen-blocker fixture: B has two blockers — one frozen with later end,
 * one non-frozen with earlier end. Frozen blocker must be excluded from max().
 *
 * A_frozen: Apr 06 - Apr 10 (5 BD, Done) ← later end, but frozen
 * A_open:   Mar 30 - Apr 02 (4 BD)        ← earlier end, non-frozen
 * B:        Mar 31 - Apr 01 (2 BD)        ← starts before non-frozen blocker ends
 *
 * Expected: B.newStart = nextBD(A_open.end=Apr 02) = Apr 03 (Friday).
 * The frozen blocker's later end (Apr 10) is excluded.
 */
function frozenBlockerExcluded() {
  return [
    task('af', 'Task A frozen', '2026-04-06', '2026-04-10', { status: 'Done', blockingIds: ['b'] }),
    task('ao', 'Task A open', '2026-03-30', '2026-04-02', { blockingIds: ['b'] }),
    task('b', 'Task B', '2026-03-31', '2026-04-01', { blockedByIds: ['af', 'ao'] }),
  ];
}

/**
 * Frozen downstream skipped: A→B→C with C frozen.
 * Edit B's blocker (violation). B tightens; C must NOT be in updatesMap.
 *
 * A: Mar 30 - Apr 03 (5 BD) — overlaps B
 * B: Apr 01 - Apr 02 (2 BD)
 * C: Apr 03 - Apr 06 (2 BD, Done)
 */
function frozenDownstream() {
  return [
    task('a', 'Task A', '2026-03-30', '2026-04-03', { blockingIds: ['b'] }),
    task('b', 'Task B', '2026-04-01', '2026-04-02', { blockedByIds: ['a'], blockingIds: ['c'] }),
    task('c', 'Task C', '2026-04-03', '2026-04-06', { status: 'Done', blockedByIds: ['b'] }),
  ];
}

/**
 * Cycle: A→B→C→A. Notion's UI prevents this via dual-sync, but the helper
 * must return gracefully if the underlying data is malformed.
 *
 * B starts with a gap from A (forces seed tightening to actually fire),
 * so tightenDownstreamFromSeed gets called and exercises cycle detection
 * during the downstream BFS.
 */
function cycleChain() {
  return [
    task('a', 'Task A', '2026-03-30', '2026-04-03', { blockedByIds: ['c'], blockingIds: ['b'] }),
    task('b', 'Task B', '2026-04-13', '2026-04-14', { blockedByIds: ['a'], blockingIds: ['c'] }),
    task('c', 'Task C', '2026-04-15', '2026-04-16', { blockedByIds: ['b'], blockingIds: ['a'] }),
  ];
}

/**
 * Meg Apr 24 Test 1 fixture: Reiterate Draft (7/14–7/27) wired as blocker
 * for Initial Internal Review & Revisions (start 7/14).
 *
 * Reiterate Draft: 2026-07-14 (Tue) - 2026-07-27 (Mon)  [10 BD]
 * IIR & Revisions: 2026-07-14 (Tue) - 2026-07-15 (Wed)  [2 BD]
 *
 * Wiring Reiterate Draft as IIR's blocker. nextBD(7/27 Mon) = 7/28 Tue.
 * Expect IIR.newStart = 2026-07-28 (Tue), IIR.newEnd = 2026-07-29 (Wed).
 *
 * Anchors test suite to original bug report (pulse-log/04.24/001).
 */
function megApr24Test1() {
  return [
    task('reiterate-draft', 'Reiterate Draft', '2026-07-14', '2026-07-27', { blockingIds: ['iir'] }),
    task('iir', 'Initial Internal Review & Revisions of Draft Patient Materials', '2026-07-14', '2026-07-15', { blockedByIds: ['reiterate-draft'] }),
  ];
}

// -----------------------------------------------------------
// Tests
// -----------------------------------------------------------

describe('tightenSeedAndDownstream', () => {
  describe('happy paths', () => {
    // @behavior BEH-DEP-EDIT-VIOLATION
    it('classifies a single-chain violation and pushes seed right', () => {
      const result = tightenSeedAndDownstream({ seedTaskId: 'b', tasks: violationChain() });
      expect(result.subcase).toBe('violation');
      const update = result.updates.find((u) => u.taskId === 'b');
      expect(update).toMatchObject({ newStart: '2026-04-06', newEnd: '2026-04-07' });
    });

    // @behavior BEH-DEP-EDIT-GAP
    it('classifies a single-chain gap and pulls seed left', () => {
      const result = tightenSeedAndDownstream({ seedTaskId: 'b', tasks: gapChain() });
      expect(result.subcase).toBe('gap');
      const update = result.updates.find((u) => u.taskId === 'b');
      expect(update).toMatchObject({ newStart: '2026-04-01', newEnd: '2026-04-02' });
    });

    // @behavior BEH-DEP-EDIT-CHAIN-WIDE
    it('propagates tightening through the full downstream chain (violation)', () => {
      const result = tightenSeedAndDownstream({ seedTaskId: 'b', tasks: chainWideViolation() });
      expect(result.subcase).toBe('violation');

      const updates = new Map(result.updates.map((u) => [u.taskId, u]));
      expect(updates.get('b')).toMatchObject({ newStart: '2026-04-06', newEnd: '2026-04-07' });
      expect(updates.get('c')).toMatchObject({ newStart: '2026-04-08', newEnd: '2026-04-09' });
      expect(result.downstreamCount).toBe(1); // C is downstream
    });

    // @behavior BEH-DEP-EDIT-FAN-IN
    it('takes max(blocker.end) when seed has multiple blockers', () => {
      // fanIn: A end=Mar 31, B end=Apr 02, C starts Apr 03 (already tight against B)
      // Bump B's end to Apr 06 in-fixture to create a violation through the latest blocker
      const tasks = fanIn();
      tasks.find((t) => t.id === 'b').end = parseDate('2026-04-06');
      tasks.find((t) => t.id === 'b').duration = countBDInclusive(parseDate('2026-03-30'), parseDate('2026-04-06'));

      const result = tightenSeedAndDownstream({ seedTaskId: 'c', tasks });
      expect(result.subcase).toBe('violation');
      // nextBD(Apr 06 Mon) = Apr 07 Tue
      const update = result.updates.find((u) => u.taskId === 'c');
      expect(update).toMatchObject({ newStart: '2026-04-07', newEnd: '2026-04-08' });
    });
  });

  describe('no-op paths', () => {
    // @behavior BEH-DEP-EDIT-NOOP-ALREADY-TIGHT
    it('returns no-op when seed is already tight against its blockers', () => {
      // linearTightChain has A end=Mar 31, B start=Apr 01 (=nextBD)
      const result = tightenSeedAndDownstream({ seedTaskId: 'b', tasks: linearTightChain() });
      expect(result.subcase).toBe('no-op');
      expect(result.reason).toBe('already-tight');
      expect(result.updates).toEqual([]);
    });

    // @behavior BEH-DEP-EDIT-NOOP-NO-EFFECTIVE-BLOCKERS
    it('returns no-op when seed has no blockers (last one removed)', () => {
      const tasks = [task('b', 'Task B', '2026-04-01', '2026-04-02', { blockedByIds: [] })];
      const result = tightenSeedAndDownstream({ seedTaskId: 'b', tasks });
      expect(result.subcase).toBe('no-op');
      expect(result.reason).toBe('no-effective-blockers');
      expect(result.updates).toEqual([]);
    });

    // @behavior BEH-DEP-EDIT-NOOP-NO-EFFECTIVE-BLOCKERS
    it('returns no-op when all blockers are frozen', () => {
      const tasks = [
        task('a1', 'A1 frozen', '2026-03-30', '2026-04-03', { status: 'Done', blockingIds: ['b'] }),
        task('a2', 'A2 frozen', '2026-04-06', '2026-04-10', { status: 'N/A', blockingIds: ['b'] }),
        task('b', 'Task B', '2026-04-01', '2026-04-02', { blockedByIds: ['a1', 'a2'] }),
      ];
      const result = tightenSeedAndDownstream({ seedTaskId: 'b', tasks });
      expect(result.subcase).toBe('no-op');
      expect(result.reason).toBe('no-effective-blockers');
    });

    // @behavior BEH-DEP-EDIT-NOOP-SEED-FROZEN
    it('returns no-op when seed itself is frozen', () => {
      const tasks = [
        task('a', 'Task A', '2026-03-30', '2026-04-03', { blockingIds: ['b'] }),
        task('b', 'Task B', '2026-04-01', '2026-04-02', { status: 'Done', blockedByIds: ['a'] }),
      ];
      const result = tightenSeedAndDownstream({ seedTaskId: 'b', tasks });
      expect(result.subcase).toBe('no-op');
      expect(result.reason).toBe('seed-frozen');
    });

    // @behavior BEH-DEP-EDIT-NOOP-SEED-NOT-FOUND
    it('returns no-op when seed task is not in the study tasks list', () => {
      const result = tightenSeedAndDownstream({ seedTaskId: 'missing', tasks: linearTightChain() });
      expect(result.subcase).toBe('no-op');
      expect(result.reason).toBe('seed-not-found');
    });

    // @behavior BEH-DEP-EDIT-NOOP-SEED-NO-DATES
    it('returns no-op when seed has no dates (start or end is null)', () => {
      // task() with undefined start/end produces null Date objects.
      const tasks = [
        task('a', 'Task A', '2026-03-30', '2026-04-03', { blockingIds: ['b'] }),
        task('b', 'Task B', undefined, undefined, { blockedByIds: ['a'] }),
      ];
      const result = tightenSeedAndDownstream({ seedTaskId: 'b', tasks });
      expect(result.subcase).toBe('no-op');
      expect(result.reason).toBe('seed-no-dates');
    });

    // @behavior BEH-DEP-EDIT-NOOP-NO-EFFECTIVE-BLOCKERS
    it('returns no-op when all blockers reference missing task IDs (stale dual-sync)', () => {
      const tasks = [
        task('b', 'Task B', '2026-04-01', '2026-04-02', { blockedByIds: ['ghost-1', 'ghost-2'] }),
      ];
      const result = tightenSeedAndDownstream({ seedTaskId: 'b', tasks });
      expect(result.subcase).toBe('no-op');
      expect(result.reason).toBe('no-effective-blockers');
    });

    // @behavior BEH-DEP-EDIT-NOOP-NO-EFFECTIVE-BLOCKERS
    it('returns no-op when single blocker has no end date', () => {
      const tasks = [
        task('a', 'Task A', '2026-03-30', undefined, { blockingIds: ['b'] }),
        task('b', 'Task B', '2026-04-01', '2026-04-02', { blockedByIds: ['a'] }),
      ];
      const result = tightenSeedAndDownstream({ seedTaskId: 'b', tasks });
      expect(result.subcase).toBe('no-op');
      expect(result.reason).toBe('no-effective-blockers');
    });
  });

  describe('mixed blocker scenarios (defensive)', () => {
    // @behavior BEH-DEP-EDIT-MIXED-BLOCKERS-STALE
    it('uses only valid blockers when mixed valid + stale blocker IDs are present', () => {
      const tasks = [
        task('a', 'Task A', '2026-03-30', '2026-04-03', { blockingIds: ['b'] }),
        task('b', 'Task B', '2026-04-01', '2026-04-02', { blockedByIds: ['a', 'ghost-stale'] }),
      ];
      const result = tightenSeedAndDownstream({ seedTaskId: 'b', tasks });
      // Should compute against A only; A.end=Apr 03 → newStart=Apr 06 → violation
      expect(result.subcase).toBe('violation');
      const update = result.updates.find((u) => u.taskId === 'b');
      expect(update).toMatchObject({ newStart: '2026-04-06', newEnd: '2026-04-07' });
    });

    // @behavior BEH-DEP-EDIT-MIXED-BLOCKERS-NO-END
    it('uses only blockers with end dates when one blocker has no end', () => {
      const tasks = [
        task('a1', 'A1 has end', '2026-03-30', '2026-04-03', { blockingIds: ['b'] }),
        task('a2', 'A2 missing end', '2026-04-13', undefined, { blockingIds: ['b'] }),
        task('b', 'Task B', '2026-04-01', '2026-04-02', { blockedByIds: ['a1', 'a2'] }),
      ];
      const result = tightenSeedAndDownstream({ seedTaskId: 'b', tasks });
      // Should ignore A2 (no end), compute against A1 only
      expect(result.subcase).toBe('violation');
      const update = result.updates.find((u) => u.taskId === 'b');
      expect(update).toMatchObject({ newStart: '2026-04-06', newEnd: '2026-04-07' });
    });
  });

  describe('frozen handling', () => {
    // @behavior BEH-DEP-EDIT-FROZEN-BLOCKER-EXCLUDED
    it('excludes frozen blockers from the max(blocker.end) computation', () => {
      const result = tightenSeedAndDownstream({ seedTaskId: 'b', tasks: frozenBlockerExcluded() });
      // Should tighten against A_open (end Apr 02), not A_frozen (end Apr 10)
      expect(result.subcase).toBe('violation');
      const update = result.updates.find((u) => u.taskId === 'b');
      // nextBD(Apr 02 Thu) = Apr 03 Fri
      expect(update).toMatchObject({ newStart: '2026-04-03', newEnd: '2026-04-06' });
    });

    // @behavior BEH-DEP-EDIT-FROZEN-DOWNSTREAM-SKIPPED
    it('skips frozen downstream tasks during chain-wide tightening', () => {
      const result = tightenSeedAndDownstream({ seedTaskId: 'b', tasks: frozenDownstream() });
      expect(result.subcase).toBe('violation');
      const updates = new Map(result.updates.map((u) => [u.taskId, u]));
      expect(updates.has('b')).toBe(true);
      expect(updates.has('c')).toBe(false); // C is frozen, skipped
    });
  });

  describe('parent-task gating (D6 / BL-H5g)', () => {
    // @behavior BEH-DEP-EDIT-PARENT-SEED-EXCLUDED
    it('returns no-op when seed is a parent task', () => {
      // parentWithAccidentalDep: P is parent of S1, S2 with blockedByIds=['x']
      const result = tightenSeedAndDownstream({ seedTaskId: 'p', tasks: parentWithAccidentalDep() });
      expect(result.subcase).toBe('no-op');
      expect(result.reason).toBe('parent-task');
      expect(result.updates).toEqual([]);
    });

    // @behavior BEH-DEP-EDIT-PARENT-BLOCKER-STRIPPED
    it('strips parent-task blockers from leaf seed (mirrors BL-H5g)', () => {
      // S2 (subtask of P) has blockedByIds=['s1'] (sibling). Build a fixture
      // where S2 also lists P as a blocker — that edge should be stripped,
      // leaving only the S1 constraint.
      const baseTasks = parentWithAccidentalDep();
      const s2 = baseTasks.find((t) => t.id === 's2');
      // Pretend the user accidentally wired P as a blocker on S2 too
      s2.blockedByIds = ['s1', 'p'];
      // After stripping, only s1 (Apr 01-02) constrains s2.
      // s2 currently starts Apr 03 = nextBD(Apr 02) = already tight.
      const result = tightenSeedAndDownstream({ seedTaskId: 's2', tasks: baseTasks });
      // P's end is Apr 07 — IF parent stripping failed, s2 would push to Apr 08.
      // With stripping, s2 stays put (already tight against s1).
      expect(result.subcase).toBe('no-op');
      expect(result.reason).toBe('already-tight');
    });
  });

  describe('cycle handling', () => {
    // @behavior BEH-DEP-EDIT-CYCLE-DIAGNOSTICS
    it('returns gracefully with cycle diagnostics when graph has a cycle', () => {
      const result = tightenSeedAndDownstream({ seedTaskId: 'b', tasks: cycleChain() });
      // Helper should not throw. It either returns no-op (if it bails on cycle
      // detection upstream) or attempts tightening with cycleDetected=true.
      expect(result).toBeDefined();
      if (result.subcase !== 'no-op') {
        expect(result.diagnostics?.cycleDetected).toBe(true);
      }
    });
  });

  describe('integration — Meg Apr 24 Test 1', () => {
    // @behavior BEH-DEP-EDIT-MEG-APR24-T1
    it('reproduces the worked example: Reiterate Draft → IIR snaps to 7/28', () => {
      const result = tightenSeedAndDownstream({ seedTaskId: 'iir', tasks: megApr24Test1() });
      expect(result.subcase).toBe('violation');
      const update = result.updates.find((u) => u.taskId === 'iir');
      expect(update).toMatchObject({ newStart: '2026-07-28', newEnd: '2026-07-29' });
    });
  });

  // -----------------------------------------------------------
  // Parent rollup integration: tightenSeedAndDownstream + runParentSubtask
  // composed exactly like the dep-edit route does. Reproduces Meg Apr 30 with
  // real helpers (no mocks) — the only test that exercises the seed-with-
  // parentId case end-to-end.
  // -----------------------------------------------------------
  describe('integration — parent rollup after dep-edit (Meg Apr 30)', () => {
    /**
     * Manual task-set fixture mirroring Meg's repro: TLF parent + 4 subtasks
     * in a tight intra-set chain, plus an external Data Delivery task placed
     * after the TLF window. Wiring Data Delivery as Blocked by Draft v1 TLF
     * shifts the whole TLF subtree forward, and the parent should roll up.
     */
    function manualTlfWithDelivery() {
      return [
        // External blocker (e.g., Data Delivery #3) — placed AFTER the TLF window
        task('delivery', 'Data Delivery #3', '2026-05-01', '2026-05-05'),
        // Parent TLF — originally aligned to its subtasks (Apr 06 - Apr 17)
        task('tlf-3', 'TLF #3', '2026-04-06', '2026-04-17'),
        // Subtasks of TLF #3 in a tight intra-set chain
        task('draft-v1', 'Draft v1 TLF', '2026-04-06', '2026-04-09', {
          parentId: 'tlf-3',
          blockingIds: ['internal-review'],
        }),
        task('internal-review', 'Internal Review & Revisions', '2026-04-10', '2026-04-13', {
          parentId: 'tlf-3',
          blockedByIds: ['draft-v1'],
          blockingIds: ['client-review'],
        }),
        task('client-review', 'Client Review Round 1', '2026-04-14', '2026-04-15', {
          parentId: 'tlf-3',
          blockedByIds: ['internal-review'],
          blockingIds: ['final'],
        }),
        task('final', 'TLF Delivery', '2026-04-16', '2026-04-17', {
          parentId: 'tlf-3',
          blockedByIds: ['client-review'],
        }),
      ];
    }

    // @behavior BEH-DEP-EDIT-PARENT-ROLLUP-INTEGRATION
    it('rolls up the parent task to span the shifted subtask range (Meg Apr 30 repro)', () => {
      const tasks = manualTlfWithDelivery();
      // Wire delivery as a blocker on Draft v1 TLF (the user-initiated edit)
      tasks.find((t) => t.id === 'draft-v1').blockedByIds = ['delivery'];

      // Step 1: leaf cascade (what dep-edit's tightenSeedAndDownstream does)
      const cascadeResult = tightenSeedAndDownstream({
        seedTaskId: 'draft-v1',
        tasks,
      });
      expect(cascadeResult.subcase).toBe('violation');

      // Subtasks of TLF #3 should all shift forward.
      // delivery.end = May 05 (Tue) → nextBD = May 06 (Wed).
      const draftUpdate = cascadeResult.updates.find((u) => u.taskId === 'draft-v1');
      expect(draftUpdate).toMatchObject({ newStart: '2026-05-06' });

      // Step 2: parent rollup (what the route fix adds)
      const parentResult = runParentSubtask({
        sourceTaskId: 'draft-v1',
        sourceTaskName: 'Draft v1 TLF',
        newStart: cascadeResult.movedTaskMap['draft-v1'].newStart,
        newEnd: cascadeResult.movedTaskMap['draft-v1'].newEnd,
        parentTaskId: null,
        parentMode: null,
        movedTaskIds: cascadeResult.movedTaskIds,
        movedTaskMap: cascadeResult.movedTaskMap,
        tasks, // pass the original tasks; runParentSubtask re-applies movedTaskMap itself
      });

      // Parent TLF #3 should roll up to span min(child starts) / max(child ends)
      const parentUpdate = parentResult.updates.find((u) => u.taskId === 'tlf-3');
      expect(parentUpdate).toBeDefined();
      expect(parentUpdate._isRollUp).toBe(true);

      // Parent dates differ from the original Apr 06 — Apr 17
      expect(parentUpdate.newStart).not.toBe('2026-04-06');
      expect(parentUpdate.newEnd).not.toBe('2026-04-17');

      // Specifically, parent's new start = min of moved subtasks (draft-v1.newStart = May 06)
      expect(parentUpdate.newStart).toBe(draftUpdate.newStart);
    });

    // @behavior BEH-DEP-EDIT-PARENT-ROLLUP-NO-PARENT
    it('emits no parent updates when the seed has no parent (top-level leaf)', () => {
      // linearTightChain has no parentId on any task — pure top-level chain
      const tasks = linearTightChain();
      // Push a's end forward to create a violation when b is the seed
      const a = tasks.find((t) => t.id === 'a');
      a.end = parseDate('2026-04-10');
      a.duration = countBDInclusive(a.start, a.end);

      const cascadeResult = tightenSeedAndDownstream({ seedTaskId: 'b', tasks });
      // If still tight after the fixture mutation, skip — not what this test is verifying
      if (cascadeResult.subcase === 'no-op') return;

      const parentResult = runParentSubtask({
        sourceTaskId: 'b',
        sourceTaskName: 'B',
        newStart: cascadeResult.movedTaskMap['b']?.newStart || null,
        newEnd: cascadeResult.movedTaskMap['b']?.newEnd || null,
        parentTaskId: null,
        parentMode: null,
        movedTaskIds: cascadeResult.movedTaskIds,
        movedTaskMap: cascadeResult.movedTaskMap,
        tasks,
      });

      // No tasks have parents → no rollup updates emitted
      expect(parentResult.updates).toEqual([]);
    });
  });
});
