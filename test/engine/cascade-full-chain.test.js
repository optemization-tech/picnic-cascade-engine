import { describe, expect, it } from 'vitest';

import { nextBusinessDay, formatDate, signedBDDelta } from '../../src/utils/business-days.js';
import { runCascade } from '../../src/engine/cascade.js';
import {
  applyCascadeResult,
  findFixtureGapViolations,
  getTaskByName,
  makeCascadeParams,
  makeFullStudyTaskGraphFixture,
  runFixtureScenario,
} from '../fixtures/full-study-task-graph.js';

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
