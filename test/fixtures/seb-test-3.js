import { readFileSync } from 'node:fs';

import { parseDate, formatDate, addBusinessDays, signedBDDelta } from '../../src/utils/business-days.js';
import { findBlockerStartViolations } from '../../src/verify/blocker-starts.js';

const fixture = JSON.parse(
  readFileSync(new URL('./seb-test-3.json', import.meta.url), 'utf8'),
);

function cloneTask(task) {
  return {
    ...task,
    start: parseDate(task.start),
    end: parseDate(task.end),
    refStart: parseDate(task.refStart),
    refEnd: parseDate(task.refEnd),
    blockedByIds: [...(task.blockedByIds || [])],
    blockingIds: [...(task.blockingIds || [])],
  };
}

export function makeSebTest3Fixture() {
  return fixture.map(cloneTask);
}

export function getTaskByName(tasks, taskName) {
  const task = tasks.find((candidate) => candidate.name === taskName);
  if (!task) throw new Error(`Missing task in Seb test 3 fixture: ${taskName}`);
  return task;
}

export function makeShiftedWindow(task, { startDelta = 0, endDelta = 0 } = {}) {
  return {
    newStart: formatDate(addBusinessDays(task.start, startDelta)),
    newEnd: formatDate(addBusinessDays(task.end, endDelta)),
    startDelta,
    endDelta,
  };
}

export function makeCascadeParams(tasks, sourceTaskName, cascadeMode, deltas = {}) {
  const sourceTask = getTaskByName(tasks, sourceTaskName);
  const window = makeShiftedWindow(sourceTask, deltas);

  return {
    sourceTaskId: sourceTask.id,
    sourceTaskName: sourceTask.name,
    refStart: formatDate(sourceTask.start),
    refEnd: formatDate(sourceTask.end),
    cascadeMode,
    ...window,
  };
}

export function applyCascadeResult(tasks, params, result) {
  const byId = new Map(tasks.map((task) => [task.id, { ...task }]));
  const sourceTask = byId.get(params.sourceTaskId);

  if (!sourceTask) {
    throw new Error(`Missing source task in finalizer: ${params.sourceTaskId}`);
  }

  sourceTask.start = parseDate(params.newStart);
  sourceTask.end = parseDate(params.newEnd);

  for (const update of result.updates || []) {
    const task = byId.get(update.taskId);
    if (!task) continue;
    task.start = parseDate(update.newStart);
    task.end = parseDate(update.newEnd);
    task.duration = update.duration;
  }

  return [...byId.values()];
}

export function stripParentDependencyEdges(tasks) {
  const byId = new Map(tasks.map((task) => [task.id, { ...task, blockedByIds: [...(task.blockedByIds || [])], blockingIds: [...(task.blockingIds || [])] }]));
  const parentIds = new Set();

  for (const task of byId.values()) {
    if (task.parentId && byId.has(task.parentId)) parentIds.add(task.parentId);
  }

  for (const task of byId.values()) {
    if (parentIds.has(task.id)) {
      task.blockedByIds = [];
      task.blockingIds = [];
      continue;
    }

    task.blockedByIds = task.blockedByIds.filter((blockerId) => !parentIds.has(blockerId));
    task.blockingIds = task.blockingIds.filter((dependentId) => !parentIds.has(dependentId));
  }

  return [...byId.values()];
}

export function findFixtureGapViolations(tasks) {
  return findBlockerStartViolations(stripParentDependencyEdges(tasks));
}

export function runFixtureScenario(runCascade, sourceTaskName, cascadeMode, deltas = {}) {
  const tasks = makeSebTest3Fixture();
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
  };
}
