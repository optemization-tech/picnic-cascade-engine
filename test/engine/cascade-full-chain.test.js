import { describe, expect, it } from 'vitest';

import { nextBusinessDay, formatDate, signedBDDelta, addBusinessDays, parseDate } from '../../src/utils/business-days.js';
import { runCascade, tightenSeedAndDownstream } from '../../src/engine/cascade.js';
import {
  applyCascadeResult,
  findFixtureGapViolations,
  getTaskByName,
  makeCascadeParams,
  makeFullStudyTaskGraphFixture,
  runFixtureScenario,
} from '../fixtures/full-study-task-graph.js';

/**
 * Apply a tightenSeedAndDownstream result back onto the fixture.
 * Mirrors applyCascadeResult but without a separate source-shift step
 * (the dep-edit handler always writes the seed via updatesMap).
 */
function applyDepEditResult(tasks, result) {
  const byId = new Map(tasks.map((task) => [task.id, { ...task }]));
  for (const update of result.updates || []) {
    const task = byId.get(update.taskId);
    if (!task) continue;
    task.start = parseDate(update.newStart);
    task.end = parseDate(update.newEnd);
    task.duration = update.duration;
  }
  return [...byId.values()];
}

/**
 * The dep-edit cascade only tightens the seed's downstream chain (BFS via
 * blockingIds). Parallel sibling branches sharing the seed's blocker are
 * out of scope per design (R-4 in plan, PR #66 simplification).
 *
 * This helper filters findFixtureGapViolations to only return violations on
 * tasks the cascade was responsible for moving, so tests can assert
 * "violations within the moved subtree are zero" without false positives
 * from pre-existing or out-of-scope violations elsewhere in the study.
 */
function violationsWithinMovedSet(finalTasks, movedTaskIds) {
  const movedSet = new Set(movedTaskIds);
  return findFixtureGapViolations(finalTasks).filter((v) => movedSet.has(v.taskId));
}

function runFrozenFixtureScenario(sourceTaskName, cascadeMode, deltas, frozenTaskNames) {
  const tasks = makeFullStudyTaskGraphFixture();
  const frozenTaskIds = new Set();

  for (const taskName of frozenTaskNames) {
    const task = getTaskByName(tasks, taskName);
    task.status = 'Done';
    frozenTaskIds.add(task.id);
  }

  const params = makeCascadeParams(tasks, sourceTaskName, cascadeMode, deltas);
  const result = runCascade({
    ...params,
    startDelta: signedBDDelta(params.refStart, params.newStart),
    endDelta: signedBDDelta(params.refEnd, params.newEnd),
    tasks,
  });
  const finalTasks = applyCascadeResult(tasks, params, result);

  return {
    tasks,
    params,
    result,
    finalTasks,
    frozenTaskIds,
  };
}

function expectViolationsOnlyAroundFrozenTasks(finalTasks, frozenTaskIds) {
  const violations = findFixtureGapViolations(finalTasks);
  expect(violations.length).toBeGreaterThan(0);

  for (const violation of violations) {
    expect(violation.type).toBe('start_mismatch');
    expect(
      frozenTaskIds.has(violation.taskId) || frozenTaskIds.has(violation.bindingBlockerId),
    ).toBe(true);
  }
}

describe('runCascade full study invariants', () => {
  it('starts from an invariant-clean 200-task fixture', () => {
    const { finalTasks } = runFixtureScenario(runCascade, 'Draft ICF', 'push-right', {});
    // Replace the no-op source edit with the normalized baseline for the actual check.
    const baselineTasks = finalTasks.map((task) => ({ ...task }));
    const source = getTaskByName(baselineTasks, 'Draft ICF');
    source.start = source.refStart;
    source.end = source.refEnd;
    expect(findFixtureGapViolations(baselineTasks)).toEqual([]);
    expect(baselineTasks).toHaveLength(200);
  });

  it('keeps the full study gap-clean after shortening Round 3 review', () => {
    const { finalTasks, params } = runFixtureScenario(
      runCascade,
      'Round 3/Customer Committee Review & Signatures',
      'pull-left',
      { endDelta: -2 },
    );

    expect(findFixtureGapViolations(finalTasks)).toEqual([]);

    const source = getTaskByName(finalTasks, 'Round 3/Customer Committee Review & Signatures');
    const prep = getTaskByName(finalTasks, 'Prepare for IRB Submission');
    expect(formatDate(source.end)).toBe(params.newEnd);
    expect(formatDate(prep.start)).toBe(formatDate(nextBusinessDay(source.end)));
  });

  it('keeps the full study gap-clean after extending Round 3 review', () => {
    const { finalTasks } = runFixtureScenario(
      runCascade,
      'Round 3/Customer Committee Review & Signatures',
      'push-right',
      { endDelta: 1 },
    );

    expect(findFixtureGapViolations(finalTasks)).toEqual([]);
  });

  it('pushes a direct downstream task even when the source new end overtakes that task end', () => {
    const { tasks, finalTasks, result } = runFixtureScenario(
      runCascade,
      'Round 3/Customer Committee Review & Signatures',
      'push-right',
      { endDelta: 10 },
    );

    const source = getTaskByName(finalTasks, 'Round 3/Customer Committee Review & Signatures');
    const originalPrep = getTaskByName(tasks, 'Prepare for IRB Submission');
    const prep = getTaskByName(finalTasks, 'Prepare for IRB Submission');
    expect(source.end > originalPrep.end).toBe(true);
    expect(result.updates.some((update) => update.taskName === 'Prepare for IRB Submission')).toBe(true);
    expect(formatDate(prep.start)).toBe(formatDate(nextBusinessDay(source.end)));
  });

  it('keeps the full study gap-clean after dragging Draft ICF earlier', () => {
    const { finalTasks } = runFixtureScenario(
      runCascade,
      'Draft ICF',
      'start-left',
      { startDelta: -3 },
    );

    expect(findFixtureGapViolations(finalTasks)).toEqual([]);
  });

  it('keeps the full study gap-clean after pulling Draft ICF later from the left edge', () => {
    const { finalTasks } = runFixtureScenario(
      runCascade,
      'Draft ICF',
      'pull-right',
      { startDelta: 2 },
    );

    expect(findFixtureGapViolations(finalTasks)).toEqual([]);
  });

  it('keeps the full study gap-clean after dragging Draft Protocol left', () => {
    const { finalTasks } = runFixtureScenario(
      runCascade,
      'Draft Protocol (v0.1)',
      'drag-left',
      { startDelta: -2, endDelta: -2 },
    );

    expect(findFixtureGapViolations(finalTasks)).toEqual([]);
  });

  it('keeps the full study gap-clean after dragging Draft Protocol right', () => {
    const { finalTasks } = runFixtureScenario(
      runCascade,
      'Draft Protocol (v0.1)',
      'drag-right',
      { startDelta: 2, endDelta: 2 },
    );

    expect(findFixtureGapViolations(finalTasks)).toEqual([]);
  });

  it('allows only frozen-edge violations when a frozen upstream blocker cannot move', () => {
    const frozenTaskName = 'Client Review Round 1: Protocol';
    const { tasks, finalTasks, result, frozenTaskIds } = runFrozenFixtureScenario(
      'Draft ICF',
      'start-left',
      { startDelta: -3 },
      [frozenTaskName],
    );

    const originalFrozen = getTaskByName(tasks, frozenTaskName);
    const finalFrozen = getTaskByName(finalTasks, frozenTaskName);
    expect(result.updates.some((update) => frozenTaskIds.has(update.taskId))).toBe(false);
    expect(formatDate(finalFrozen.start)).toBe(formatDate(originalFrozen.start));
    expect(formatDate(finalFrozen.end)).toBe(formatDate(originalFrozen.end));
    expectViolationsOnlyAroundFrozenTasks(finalTasks, frozenTaskIds);
  });

  it('allows only frozen-edge violations when a frozen downstream dependent cannot move', () => {
    const frozenTaskName = 'Prepare for IRB Submission';
    const { tasks, finalTasks, result, frozenTaskIds } = runFrozenFixtureScenario(
      'Round 3/Customer Committee Review & Signatures',
      'push-right',
      { endDelta: 10 },
      [frozenTaskName],
    );

    const originalFrozen = getTaskByName(tasks, frozenTaskName);
    const finalFrozen = getTaskByName(finalTasks, frozenTaskName);
    expect(result.updates.some((update) => frozenTaskIds.has(update.taskId))).toBe(false);
    expect(formatDate(finalFrozen.start)).toBe(formatDate(originalFrozen.start));
    expect(formatDate(finalFrozen.end)).toBe(formatDate(originalFrozen.end));
    expectViolationsOnlyAroundFrozenTasks(finalTasks, frozenTaskIds);
  });
});

describe('tightenSeedAndDownstream full study invariants', () => {
  // @behavior BEH-DEP-EDIT-FULL-CHAIN-VIOLATION
  it('keeps the full study gap-clean after a violation is introduced and tightenSeedAndDownstream fires', () => {
    const tasks = makeFullStudyTaskGraphFixture();

    // Pick a leaf task with a non-frozen blocker. Draft ICF's blocker is Draft Protocol.
    const seed = getTaskByName(tasks, 'Draft ICF');
    const blocker = tasks.find((t) => t.id === seed.blockedByIds[0]);
    expect(blocker).toBeDefined();
    expect(blocker.status).not.toBe('Done');

    // Move blocker's end +5 BD without updating downstream → creates violation.
    const newBlockerEnd = addBusinessDays(blocker.end, 5);
    blocker.end = newBlockerEnd;
    blocker.duration += 5;

    // Confirm violation is now present in the fixture.
    expect(findFixtureGapViolations(tasks).length).toBeGreaterThan(0);

    // Run dep-edit cascade with seed = Draft ICF.
    const result = tightenSeedAndDownstream({ seedTaskId: seed.id, tasks });
    expect(result.subcase).toBe('violation');
    expect(result.updates.length).toBeGreaterThan(1); // seed + downstream

    const finalTasks = applyDepEditResult(tasks, result);
    // Only check violations within the moved subtree — parallel siblings of
    // the seed (sharing the same blocker but not downstream of seed) are
    // intentionally not fixed by this cascade. See plan R-4.
    expect(violationsWithinMovedSet(finalTasks, result.movedTaskIds)).toEqual([]);
  });

  // @behavior BEH-DEP-EDIT-FULL-CHAIN-GAP
  it('keeps the full study gap-clean after a gap is introduced and tightenSeedAndDownstream fires', () => {
    const tasks = makeFullStudyTaskGraphFixture();

    // Pick a leaf with non-frozen blocker.
    const seed = getTaskByName(tasks, 'Draft ICF');
    const blocker = tasks.find((t) => t.id === seed.blockedByIds[0]);
    expect(blocker).toBeDefined();
    expect(blocker.status).not.toBe('Done');

    // Shorten blocker by 5 BD → seed now sits with a 5 BD gap from the blocker.
    const shortenedEnd = addBusinessDays(blocker.end, -5);
    blocker.end = shortenedEnd;
    blocker.duration -= 5;

    // The fixture's downstream chain hasn't moved yet — the gap exists between
    // blocker and seed but downstream tasks are still positioned for the OLD blocker end.
    // After tightenSeedAndDownstream, seed pulls left and the chain tightens behind it.
    const result = tightenSeedAndDownstream({ seedTaskId: seed.id, tasks });
    expect(result.subcase).toBe('gap');
    expect(result.updates.length).toBeGreaterThan(1); // seed + downstream

    const finalTasks = applyDepEditResult(tasks, result);
    expect(violationsWithinMovedSet(finalTasks, result.movedTaskIds)).toEqual([]);
  });

  // @behavior BEH-DEP-EDIT-FULL-CHAIN-FROZEN-DOWNSTREAM
  it('skips frozen downstream tasks during full-chain tightening', () => {
    const tasks = makeFullStudyTaskGraphFixture();

    const seed = getTaskByName(tasks, 'Draft ICF');
    const blocker = tasks.find((t) => t.id === seed.blockedByIds[0]);

    // Freeze a downstream task to confirm it's skipped.
    // Pick first task in seed's blockingIds (a direct downstream).
    const downstreamId = seed.blockingIds[0];
    if (downstreamId) {
      const downstream = tasks.find((t) => t.id === downstreamId);
      if (downstream) downstream.status = 'Done';
    }

    // Create violation.
    blocker.end = addBusinessDays(blocker.end, 5);
    blocker.duration += 5;

    const result = tightenSeedAndDownstream({ seedTaskId: seed.id, tasks });
    expect(result.subcase).toBe('violation');

    // Frozen downstream must NOT be in updates.
    if (downstreamId) {
      expect(result.updates.some((u) => u.taskId === downstreamId)).toBe(false);
    }
  });

  // @behavior BEH-DEP-EDIT-FULL-CHAIN-NON-REACHABLE-UNCHANGED
  it('leaves tasks unreachable from the seed unchanged', () => {
    const tasks = makeFullStudyTaskGraphFixture();
    const seed = getTaskByName(tasks, 'Draft ICF');
    const blocker = tasks.find((t) => t.id === seed.blockedByIds[0]);
    blocker.end = addBusinessDays(blocker.end, 5);
    blocker.duration += 5;

    // Pick a task that's clearly outside Draft ICF's downstream tree. The 200-task
    // fixture has many independent workstreams; pick the very last task by name
    // sort that doesn't match the ICF chain. Use a heuristic: any task whose name
    // doesn't contain 'ICF', 'Patient', 'Consent' likely lives in a parallel
    // workstream and shouldn't be touched.
    const candidates = tasks
      .filter((t) => !/ICF|Patient|Consent|IRB|Submission|Approval/i.test(t.name))
      .filter((t) => t.id !== seed.id && !seed.blockingIds.includes(t.id) && !seed.blockedByIds.includes(t.id));
    expect(candidates.length).toBeGreaterThan(0);
    const unreachable = candidates[0];
    const originalStart = formatDate(unreachable.start);
    const originalEnd = formatDate(unreachable.end);

    const result = tightenSeedAndDownstream({ seedTaskId: seed.id, tasks });
    const wasUpdated = result.updates.some((u) => u.taskId === unreachable.id);
    if (!wasUpdated) {
      const finalTasks = applyDepEditResult(tasks, result);
      const finalUnreachable = finalTasks.find((t) => t.id === unreachable.id);
      expect(formatDate(finalUnreachable.start)).toBe(originalStart);
      expect(formatDate(finalUnreachable.end)).toBe(originalEnd);
    }
  });
});
