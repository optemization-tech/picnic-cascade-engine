import { describe, expect, it } from 'vitest';

import { runCascade } from '../../src/engine/cascade.js';
import {
  parseDate,
  formatDate,
  addBusinessDays,
  signedBDDelta,
  countBDInclusive,
} from '../../src/utils/business-days.js';
import { task } from '../fixtures/cascade-tasks.js';
import {
  applyCascadeResult,
  makeFullStudyTaskGraphFixture,
  makeCascadeParams,
  getTaskByName,
  runFixtureScenario,
} from '../fixtures/full-study-task-graph.js';

function snapshotDates(tasks) {
  const snap = {};
  for (const t of tasks) {
    snap[t.id] = {
      start: t.start ? formatDate(t.start) : null,
      end: t.end ? formatDate(t.end) : null,
    };
  }
  return snap;
}

function applyResult(tasks, params, result) {
  const byId = new Map(tasks.map((t) => [t.id, { ...t }]));
  const source = byId.get(params.sourceTaskId);
  if (source) {
    source.start = parseDate(params.newStart);
    source.end = parseDate(params.newEnd);
  }
  for (const u of result.updates || []) {
    const t = byId.get(u.taskId);
    if (!t) continue;
    t.start = parseDate(u.newStart);
    t.end = parseDate(u.newEnd);
    t.duration = u.duration;
  }
  return [...byId.values()];
}

/**
 * Gapped downstream chain for round-trip tests.
 * Models the Sanofi topology:
 *   Source → A → B → C → D → [50 BD gap] → E → F
 *
 * Source: May 01 (Fri) - May 04 (Mon) [2 BD]
 * A:      May 05 (Tue) - May 06 (Wed) [2 BD]  tight after Source
 * B:      May 07 (Thu) - May 08 (Fri) [2 BD]  tight after A
 * C:      May 11 (Mon) - May 12 (Tue) [2 BD]  tight after B
 * D:      May 13 (Wed) - May 14 (Thu) [2 BD]  tight after C
 * E:      Jul 22 (Wed) - Jul 23 (Thu) [2 BD]  50 BD gap after D
 * F:      Jul 24 (Fri) - Jul 27 (Mon) [2 BD]  tight after E
 */
function gappedDownstreamChain() {
  return [
    task('source', 'TLF Delivery', '2026-05-01', '2026-05-04', { blockingIds: ['a'] }),
    task('a', 'Soft Lock', '2026-05-05', '2026-05-06', { blockedByIds: ['source'], blockingIds: ['b'] }),
    task('b', 'Delivery Wrap-Up', '2026-05-07', '2026-05-08', { blockedByIds: ['a'], blockingIds: ['c'] }),
    task('c', 'Hard Lock', '2026-05-11', '2026-05-12', { blockedByIds: ['b'], blockingIds: ['d'] }),
    task('d', 'Repeat Abstraction', '2026-05-13', '2026-05-14', { blockedByIds: ['c'], blockingIds: ['e'] }),
    task('e', 'Repeat QC', '2026-07-22', '2026-07-23', { blockedByIds: ['d'], blockingIds: ['f'] }),
    task('f', 'Data Delivery #2', '2026-07-24', '2026-07-27', { blockedByIds: ['e'] }),
  ];
}

describe('cascade round-trip property', () => {
  it('drag-right +N then drag-left -N restores all tasks (simple tight chain)', () => {
    const delta = 12;
    const tasks = gappedDownstreamChain();
    const original = snapshotDates(tasks);

    // Pass 1: drag-right
    const r1 = runCascade({
      sourceTaskId: 'source',
      sourceTaskName: 'TLF Delivery',
      newStart: formatDate(addBusinessDays(tasks[0].start, delta)),
      newEnd: formatDate(addBusinessDays(tasks[0].end, delta)),
      refStart: formatDate(tasks[0].start),
      refEnd: formatDate(tasks[0].end),
      startDelta: delta,
      endDelta: delta,
      cascadeMode: 'drag-right',
      tasks,
    });

    expect(r1.updates.length).toBeGreaterThan(0);

    // Apply drag-right result
    const midTasks = applyResult(tasks, {
      sourceTaskId: 'source',
      newStart: formatDate(addBusinessDays(parseDate(original.source.start), delta)),
      newEnd: formatDate(addBusinessDays(parseDate(original.source.end), delta)),
    }, r1);

    // Pass 2: drag-left (correction)
    const newSourceStart = formatDate(addBusinessDays(parseDate(original.source.start), delta));
    const newSourceEnd = formatDate(addBusinessDays(parseDate(original.source.end), delta));
    const r2 = runCascade({
      sourceTaskId: 'source',
      sourceTaskName: 'TLF Delivery',
      newStart: original.source.start,
      newEnd: original.source.end,
      refStart: newSourceStart,
      refEnd: newSourceEnd,
      startDelta: -delta,
      endDelta: -delta,
      cascadeMode: 'drag-left',
      tasks: midTasks,
    });

    expect(r2.updates.length).toBeGreaterThan(0);

    const finalTasks = applyResult(midTasks, {
      sourceTaskId: 'source',
      newStart: original.source.start,
      newEnd: original.source.end,
    }, r2);

    // Every task should be back to its original position
    const restored = snapshotDates(finalTasks);
    for (const t of finalTasks) {
      expect(restored[t.id]).toEqual(original[t.id]);
    }
  });

  it('drag-right +N then drag-left -N restores all tasks (chain with 50 BD gap)', () => {
    const delta = 12;
    const tasks = gappedDownstreamChain();
    const original = snapshotDates(tasks);

    // Verify the gap exists: E starts 50 BD after D ends
    const d = tasks.find((t) => t.id === 'd');
    const e = tasks.find((t) => t.id === 'e');
    const gap = signedBDDelta(d.end, e.start);
    expect(gap).toBeGreaterThan(10);

    // Pass 1: drag-right
    const r1 = runCascade({
      sourceTaskId: 'source',
      sourceTaskName: 'TLF Delivery',
      newStart: formatDate(addBusinessDays(tasks[0].start, delta)),
      newEnd: formatDate(addBusinessDays(tasks[0].end, delta)),
      refStart: formatDate(tasks[0].start),
      refEnd: formatDate(tasks[0].end),
      startDelta: delta,
      endDelta: delta,
      cascadeMode: 'drag-right',
      tasks,
    });

    const midTasks = applyResult(tasks, {
      sourceTaskId: 'source',
      newStart: formatDate(addBusinessDays(parseDate(original.source.start), delta)),
      newEnd: formatDate(addBusinessDays(parseDate(original.source.end), delta)),
    }, r1);

    // Verify gap is preserved after drag-right
    const midD = midTasks.find((t) => t.id === 'd');
    const midE = midTasks.find((t) => t.id === 'e');
    expect(signedBDDelta(midD.end, midE.start)).toBe(gap);

    // Pass 2: drag-left
    const newSourceStart = formatDate(addBusinessDays(parseDate(original.source.start), delta));
    const newSourceEnd = formatDate(addBusinessDays(parseDate(original.source.end), delta));
    const r2 = runCascade({
      sourceTaskId: 'source',
      sourceTaskName: 'TLF Delivery',
      newStart: original.source.start,
      newEnd: original.source.end,
      refStart: newSourceStart,
      refEnd: newSourceEnd,
      startDelta: -delta,
      endDelta: -delta,
      cascadeMode: 'drag-left',
      tasks: midTasks,
    });

    const finalTasks = applyResult(midTasks, {
      sourceTaskId: 'source',
      newStart: original.source.start,
      newEnd: original.source.end,
    }, r2);

    const restored = snapshotDates(finalTasks);
    for (const t of finalTasks) {
      expect(restored[t.id]).toEqual(original[t.id]);
    }
  });

  it('start-left (misclassified drag) collapses gaps — characterization of pre-fix failure', () => {
    const delta = 12;
    const tasks = gappedDownstreamChain();
    const original = snapshotDates(tasks);

    // Pass 1: drag-right (correct classification)
    const r1 = runCascade({
      sourceTaskId: 'source',
      sourceTaskName: 'TLF Delivery',
      newStart: formatDate(addBusinessDays(tasks[0].start, delta)),
      newEnd: formatDate(addBusinessDays(tasks[0].end, delta)),
      refStart: formatDate(tasks[0].start),
      refEnd: formatDate(tasks[0].end),
      startDelta: delta,
      endDelta: delta,
      cascadeMode: 'drag-right',
      tasks,
    });

    const midTasks = applyResult(tasks, {
      sourceTaskId: 'source',
      newStart: formatDate(addBusinessDays(parseDate(original.source.start), delta)),
      newEnd: formatDate(addBusinessDays(parseDate(original.source.end), delta)),
    }, r1);

    // Pass 2: simulate stale-ref misclassification.
    // The drag-left SHOULD be drag-left with delta -12, but stale refs
    // cause classify to produce start-left (startDelta < 0, endDelta = 0).
    // This triggers pullLeftUpstream + tightenDownstreamFromSeed instead
    // of shiftConnectedComponent.
    const r2 = runCascade({
      sourceTaskId: 'source',
      sourceTaskName: 'TLF Delivery',
      newStart: original.source.start,
      newEnd: original.source.end,
      refStart: formatDate(addBusinessDays(parseDate(original.source.start), delta)),
      refEnd: formatDate(addBusinessDays(parseDate(original.source.end), delta)),
      startDelta: -delta,
      endDelta: 0,
      cascadeMode: 'start-left',
      tasks: midTasks,
    });

    const finalTasks = applyResult(midTasks, {
      sourceTaskId: 'source',
      newStart: original.source.start,
      newEnd: original.source.end,
    }, r2);

    // With start-left instead of drag-left, tightenDownstreamFromSeed
    // collapses the 50 BD gap between D and E, destroying the round-trip.
    const restored = snapshotDates(finalTasks);
    const eOriginal = original.e;
    const eRestored = restored.e;
    const fOriginal = original.f;
    const fRestored = restored.f;

    // INTENTIONAL .not.toBe(): this test documents the BROKEN outcome when
    // classify misclassifies drag-left as start-left (the bug the guard fixes).
    // The fix is verified in classify.test.js; this characterizes the damage.
    expect(eRestored.start).not.toBe(eOriginal.start);
    expect(fRestored.start).not.toBe(fOriginal.start);
  });

  it('drag-right +12 then drag-left -12 on full 200-task fixture', () => {
    const delta = 12;
    const tasks = makeFullStudyTaskGraphFixture();
    const original = snapshotDates(tasks);

    const sourceTaskName = 'Draft Protocol (v0.1)';
    const params1 = makeCascadeParams(tasks, sourceTaskName, 'drag-right', {
      startDelta: delta,
      endDelta: delta,
    });
    const r1 = runCascade({
      ...params1,
      startDelta: signedBDDelta(params1.refStart, params1.newStart),
      endDelta: signedBDDelta(params1.refEnd, params1.newEnd),
      tasks,
    });

    expect(r1.updates.length).toBeGreaterThan(0);
    const midTasks = applyCascadeResult(tasks, params1, r1);

    // Pass 2: drag-left correction
    const params2 = makeCascadeParams(midTasks, sourceTaskName, 'drag-left', {
      startDelta: -delta,
      endDelta: -delta,
    });
    const r2 = runCascade({
      ...params2,
      startDelta: signedBDDelta(params2.refStart, params2.newStart),
      endDelta: signedBDDelta(params2.refEnd, params2.newEnd),
      tasks: midTasks,
    });

    expect(r2.updates.length).toBeGreaterThan(0);
    const finalTasks = applyCascadeResult(midTasks, params2, r2);

    const restored = snapshotDates(finalTasks);
    let mismatches = 0;
    for (const t of finalTasks) {
      if (restored[t.id].start !== original[t.id].start ||
          restored[t.id].end !== original[t.id].end) {
        mismatches++;
      }
    }
    expect(mismatches).toBe(0);
  });
});
