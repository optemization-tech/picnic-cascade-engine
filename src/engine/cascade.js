// ============================================================
// Cascade Engine — Directional Date Cascade
// Ported from WF-D: Resolve Cascade (n8n Code node)
// Handles: push-right, pull-left, pull-right, drag-right
// v5 2026-03-30: matches live n8n code (pullRight adjacency,
//   uniform delta downstream, effectiveEnds propagation)
// ============================================================

import {
  parseDate,
  formatDate,
  isBusinessDay,
  nextBusinessDay,
  prevBusinessDay,
  addBusinessDays,
  countBDInclusive,
} from '../utils/business-days.js';

const FROZEN_STATUSES = new Set(['Done', 'N/A']);

function isFrozen(task) {
  return FROZEN_STATUSES.has(task.status);
}

// -----------------------------------------------------------
// conflictOnlyDownstream: push downstream tasks right when
// their start violates nextBD(blocker.newEnd).
// Used by: push-right, pull-right, drag-right (Pass 2)
// Seeds: set of task IDs whose ends have changed
// -----------------------------------------------------------
function conflictOnlyDownstream(seedTaskIds, updatesMap, taskById) {
  // Step 1: Find all tasks reachable downstream from seeds via Blocking edges
  const reachable = new Set();
  const dfsStack = [...seedTaskIds];
  while (dfsStack.length > 0) {
    const cur = dfsStack.pop();
    if (reachable.has(cur)) continue;
    reachable.add(cur);
    for (const bid of (taskById[cur]?.blockingIds || [])) {
      if (!reachable.has(bid) && taskById[bid]) dfsStack.push(bid);
    }
  }

  if (reachable.size <= seedTaskIds.size) return; // no downstream tasks

  // Step 2: Topological sort (Kahn's algorithm)
  const inDegree = {};
  for (const id of reachable) { inDegree[id] = 0; }
  for (const id of reachable) {
    const task = taskById[id];
    if (!task) continue;
    for (const bid of task.blockedByIds) {
      if (reachable.has(bid)) inDegree[id]++;
    }
  }
  const topoQueue = [];
  for (const id of reachable) {
    if (inDegree[id] === 0) topoQueue.push(id);
  }
  const topoOrder = [];
  while (topoQueue.length > 0) {
    const cur = topoQueue.shift();
    topoOrder.push(cur);
    for (const bid of (taskById[cur]?.blockingIds || [])) {
      if (reachable.has(bid)) {
        inDegree[bid]--;
        if (inDegree[bid] === 0) topoQueue.push(bid);
      }
    }
  }

  // Step 3: Build effective ends map from seeds + prior updates
  const effectiveEnds = {};
  for (const sid of seedTaskIds) {
    const t = taskById[sid];
    if (updatesMap[sid]) {
      effectiveEnds[sid] = parseDate(updatesMap[sid].newEnd);
    } else if (t) {
      effectiveEnds[sid] = t.end;
    }
  }

  // Step 4: Process in topo order — conflict-only push-right
  for (const taskId of topoOrder) {
    if (seedTaskIds.has(taskId)) continue;
    const task = taskById[taskId];
    if (!task || !task.start || !task.end) continue;
    if (isFrozen(task)) continue;

    let latestConstraint = null;
    for (const blockerId of task.blockedByIds) {
      const blocker = taskById[blockerId];
      if (!blocker) continue;
      if (isFrozen(blocker)) continue;
      if (effectiveEnds[blockerId] === undefined) continue;

      const candidateStart = nextBusinessDay(effectiveEnds[blockerId]);
      if (!latestConstraint || candidateStart > latestConstraint) {
        latestConstraint = candidateStart;
      }
    }

    if (!latestConstraint) { effectiveEnds[taskId] = task.end; continue; }
    if (task.start >= latestConstraint) { effectiveEnds[taskId] = task.end; continue; }

    const newTaskStart = latestConstraint;
    const newTaskEnd = addBusinessDays(newTaskStart, task.duration - 1);
    effectiveEnds[taskId] = newTaskEnd;

    updatesMap[taskId] = {
      taskId,
      taskName: task.name,
      newStart: formatDate(newTaskStart),
      newEnd: formatDate(newTaskEnd),
      duration: task.duration,
    };
  }
}

// -----------------------------------------------------------
// pullLeftUpstream: BFS upstream via Blocked by edges.
// When a task moves earlier, pull its blockers earlier
// to resolve conflicts. Gaps collapse to 0.
// Uses Bellman-Ford relaxation (re-queue on improvement).
// Used by: pull-left (Pass 1)
// -----------------------------------------------------------
function pullLeftUpstream(sourceId, newStart, updatesMap, taskById) {
  const queue = [sourceId];
  const processedWith = new Map(); // taskId -> effectiveStart string
  let iterations = 0;
  const MAX_ITER = 2000;

  while (queue.length > 0 && iterations < MAX_ITER) {
    iterations++;
    const currentId = queue.shift();
    const current = taskById[currentId];
    if (!current) continue;

    const effectiveStart = updatesMap[currentId]
      ? updatesMap[currentId].newStart
      : (currentId === sourceId ? newStart : formatDate(current.start));

    // Bellman-Ford: skip if already processed with same or better start
    if (processedWith.has(currentId) && processedWith.get(currentId) <= effectiveStart) continue;
    processedWith.set(currentId, effectiveStart);

    const effectiveStartD = parseDate(effectiveStart);
    if (!effectiveStartD) continue;

    for (const blockerId of current.blockedByIds) {
      const blocker = taskById[blockerId];
      if (!blocker || !blocker.end) continue;
      if (isFrozen(blocker)) continue;

      const blockerEffEnd = updatesMap[blockerId]
        ? parseDate(updatesMap[blockerId].newEnd)
        : blocker.end;

      // Conflict: blocker finishes too late for current task
      const nbd = nextBusinessDay(blockerEffEnd);
      if (nbd > effectiveStartD) {
        const newBlockerEnd = prevBusinessDay(effectiveStartD);
        if (newBlockerEnd < blockerEffEnd) {
          const newBlockerStart = addBusinessDays(newBlockerEnd, -(blocker.duration - 1));

          // Take most aggressive (earliest) pull
          const existing = updatesMap[blockerId];
          if (!existing || newBlockerEnd < parseDate(existing.newEnd)) {
            updatesMap[blockerId] = {
              taskId: blockerId,
              taskName: blocker.name,
              newStart: formatDate(newBlockerStart),
              newEnd: formatDate(newBlockerEnd),
              duration: blocker.duration,
            };
            queue.push(blockerId);
          }
        }
      }
    }
  }
}

// -----------------------------------------------------------
// gapPreservingDownstream (v3): uniform delta shift.
// Computes a single negative BD delta from the source end
// change and shifts ALL downstream tasks by that same delta,
// clamped to blocker constraints.
// Used by: pull-left (Pass 2)
// -----------------------------------------------------------
function gapPreservingDownstream(sourceId, sourceOldEnd, newEnd, updatesMap, taskById) {
  const sourceTask = taskById[sourceId];
  if (!sourceTask) return;

  const oldEndD = parseDate(sourceOldEnd);
  const newEndFromUpdates = updatesMap[sourceId]
    ? parseDate(updatesMap[sourceId].newEnd) : null;
  const sourceNewEndD = newEndFromUpdates || (sourceTask.end ? sourceTask.end : oldEndD);
  if (!oldEndD || !sourceNewEndD || sourceNewEndD >= oldEndD) return;

  // Compute uniform BD delta (negative)
  let deltaBD = 0;
  if (sourceNewEndD < oldEndD) {
    const cursor = new Date(sourceNewEndD);
    while (cursor < oldEndD) {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      if (isBusinessDay(cursor)) deltaBD--;
    }
  }
  if (deltaBD >= 0) return;

  // BFS downstream from source
  const downstream = new Set();
  const bfsQueue = [sourceId];
  while (bfsQueue.length > 0) {
    const tid = bfsQueue.shift();
    const t = taskById[tid];
    if (!t) continue;
    for (const depId of (t.blockingIds || [])) {
      if (!downstream.has(depId) && depId !== sourceId) {
        downstream.add(depId);
        bfsQueue.push(depId);
      }
    }
  }
  if (downstream.size === 0) return;

  // Topological sort (Kahn's)
  const inDegree = {};
  for (const tid of downstream) { inDegree[tid] = 0; }
  for (const tid of downstream) {
    const t = taskById[tid];
    if (!t) continue;
    for (const blockerId of (t.blockedByIds || [])) {
      if (downstream.has(blockerId)) {
        inDegree[tid] = (inDegree[tid] || 0) + 1;
      }
    }
  }
  const sorted = [];
  const topoQ = [];
  for (const tid of downstream) {
    if ((inDegree[tid] || 0) === 0) topoQ.push(tid);
  }
  while (topoQ.length > 0) {
    const tid = topoQ.shift();
    sorted.push(tid);
    const t = taskById[tid];
    if (!t) continue;
    for (const depId of (t.blockingIds || [])) {
      if (downstream.has(depId)) {
        inDegree[depId]--;
        if (inDegree[depId] === 0) topoQ.push(depId);
      }
    }
  }

  // Shift each downstream task by deltaBD, clamped to blocker constraints
  for (const tid of sorted) {
    const t = taskById[tid];
    if (!t || !t.start || !t.end) continue;
    if (isFrozen(t)) continue;

    const shiftedStart = addBusinessDays(t.start, deltaBD);

    // Compute earliest allowed start from blocker constraints
    let earliestAllowed = null;
    for (const blockerId of (t.blockedByIds || [])) {
      let blockerEnd = null;
      if (updatesMap[blockerId]) {
        blockerEnd = parseDate(updatesMap[blockerId].newEnd);
      } else if (taskById[blockerId]) {
        blockerEnd = taskById[blockerId].end;
      }
      if (!blockerEnd) continue;
      if (taskById[blockerId] && isFrozen(taskById[blockerId])) continue;
      const candidate = nextBusinessDay(blockerEnd);
      if (!earliestAllowed || candidate > earliestAllowed) earliestAllowed = candidate;
    }

    let newStartD = shiftedStart;
    if (earliestAllowed && earliestAllowed > shiftedStart) newStartD = earliestAllowed;
    if (newStartD >= t.start) continue; // only pull left

    const origDuration = countBDInclusive(t.start, t.end);
    const newEndD = addBusinessDays(newStartD, origDuration - 1);

    // Mutate taskById so subsequent downstream tasks see updated positions
    taskById[tid].start = newStartD;
    taskById[tid].end = newEndD;

    updatesMap[tid] = {
      taskId: tid,
      taskName: t.name,
      newStart: formatDate(newStartD),
      newEnd: formatDate(newEndD),
      duration: origDuration,
    };
  }
}

// -----------------------------------------------------------
// pullRightUpstream (v5): BFS upstream via Blocked by edges.
// When a task's start moves right, push its blockers right
// by the same delta — but only if they were ADJACENT (tight).
// Blockers with a pre-existing gap are skipped.
// v4: gap-absorption check (maxAllowedEnd from downstream deps)
// v5: adjacency check uses ORIGINAL positions
// Used by: pull-right, drag-right (Pass 1)
// -----------------------------------------------------------
function pullRightUpstream(sourceId, refStart, deltaBD, updatesMap, taskById) {
  const queue = [sourceId];
  const visited = new Set();

  while (queue.length > 0) {
    const currentId = queue.shift();
    if (visited.has(currentId)) continue;
    visited.add(currentId);

    const current = taskById[currentId];
    if (!current) continue;

    // v5: Use ORIGINAL start for adjacency check — tight chains maintain adjacency
    const currentOrigStart = (currentId === sourceId)
      ? parseDate(refStart) : current.start;

    for (const blockerId of current.blockedByIds) {
      if (visited.has(blockerId)) continue;
      const blocker = taskById[blockerId];
      if (!blocker || !blocker.start || !blocker.end) continue;
      if (isFrozen(blocker)) continue;

      const effStart = updatesMap[blockerId]
        ? parseDate(updatesMap[blockerId].newStart)
        : blocker.start;
      const effEnd = updatesMap[blockerId]
        ? parseDate(updatesMap[blockerId].newEnd)
        : blocker.end;

      // v5: ADJACENCY CHECK — skip if blocker had PRE-EXISTING gap before edit
      // nextBD(blocker.end) < currentOrigStart = gap existed = skip
      // nextBD(blocker.end) >= currentOrigStart = was tight/adjacent = shift
      if (currentOrigStart) {
        const nextBDAfterBlocker = nextBusinessDay(blocker.end);
        if (nextBDAfterBlocker < currentOrigStart) continue;
      }

      const tentativeStart = addBusinessDays(effStart, deltaBD);
      const tentativeEnd = addBusinessDays(effEnd, deltaBD);

      // v4: Gap absorption — check if shift would push past downstream deps
      let maxAllowedEnd = null;
      for (const depId of blocker.blockingIds) {
        const dep = taskById[depId];
        if (!dep || !dep.start) continue;
        if (isFrozen(dep)) continue;
        const depStart = updatesMap[depId]
          ? parseDate(updatesMap[depId].newStart) : dep.start;
        const limit = prevBusinessDay(depStart);
        if (!maxAllowedEnd || limit < maxAllowedEnd) maxAllowedEnd = limit;
      }

      let finalStart, finalEnd;
      if (maxAllowedEnd && tentativeEnd > maxAllowedEnd) {
        finalEnd = maxAllowedEnd;
        finalStart = addBusinessDays(finalEnd, -(blocker.duration - 1));
        if (finalEnd <= effEnd) continue; // no actual movement
      } else {
        finalStart = tentativeStart;
        finalEnd = tentativeEnd;
      }

      const existing = updatesMap[blockerId];
      if (!existing || finalEnd > parseDate(existing.newEnd)) {
        updatesMap[blockerId] = {
          taskId: blockerId,
          taskName: blocker.name,
          newStart: formatDate(finalStart),
          newEnd: formatDate(finalEnd),
          duration: blocker.duration,
        };
        queue.push(blockerId);
      }
    }
  }
}

// ============================================================
// MAIN EXPORT
// ============================================================

/**
 * Run the directional cascade algorithm.
 *
 * @param {Object} params
 * @param {string} params.sourceTaskId
 * @param {string} params.sourceTaskName
 * @param {string} params.newStart - YYYY-MM-DD
 * @param {string} params.newEnd - YYYY-MM-DD
 * @param {string} params.refStart - YYYY-MM-DD (previous start)
 * @param {string} params.refEnd - YYYY-MM-DD (previous end)
 * @param {number} params.startDelta - signed BD delta
 * @param {number} params.endDelta - signed BD delta
 * @param {string} params.cascadeMode - push-right | pull-left | pull-right | drag-right
 * @param {Array} params.tasks - pre-parsed task objects: { id, name, start, end, duration, status, blockedByIds, blockingIds }
 *                                start/end are Date objects (or null), duration is number
 * @returns {{ updates: Array, movedTaskMap: Object, movedTaskIds: string[], summary: string }}
 */
export function runCascade({
  sourceTaskId, sourceTaskName, newStart, newEnd,
  refStart, refEnd, startDelta, endDelta, cascadeMode, tasks,
}) {
  // Build taskById lookup
  const taskById = {};
  for (const task of tasks) {
    taskById[task.id] = { ...task };
  }

  const sourceTask = taskById[sourceTaskId];
  if (!sourceTask) {
    return { updates: [], movedTaskMap: {}, movedTaskIds: [], summary: 'Source task not found among study tasks' };
  }

  // Patch source task with webhook dates (authoritative over eventual-consistency DB query)
  sourceTask.start = parseDate(newStart);
  sourceTask.end = parseDate(newEnd);

  // Mode dispatch
  const updatesMap = {};

  switch (cascadeMode) {
    case 'push-right': {
      const seeds = new Set([sourceTaskId]);
      conflictOnlyDownstream(seeds, updatesMap, taskById);
      break;
    }

    case 'pull-left': {
      pullLeftUpstream(sourceTaskId, newStart, updatesMap, taskById);
      gapPreservingDownstream(sourceTaskId, refEnd, newEnd, updatesMap, taskById);
      break;
    }

    case 'pull-right':
    case 'drag-right': {
      pullRightUpstream(sourceTaskId, refStart, startDelta, updatesMap, taskById);
      const seeds = new Set([sourceTaskId]);
      for (const tid of Object.keys(updatesMap)) { seeds.add(tid); }
      conflictOnlyDownstream(seeds, updatesMap, taskById);
      break;
    }

    default:
      return { updates: [], movedTaskMap: {}, movedTaskIds: [], summary: `Unknown cascadeMode: ${cascadeMode}` };
  }

  // Build output
  const updates = Object.values(updatesMap);
  const movedTaskMap = {};
  for (const u of updates) {
    movedTaskMap[u.taskId] = { newStart: u.newStart, newEnd: u.newEnd };
  }
  const movedTaskIds = Object.keys(movedTaskMap);

  const summary = updates.length === 0
    ? `No tasks needed updating (${cascadeMode})`
    : `${cascadeMode} cascade: ${updates.length} task(s) shifted (triggered by ${sourceTaskName})`;

  return { updates, movedTaskMap, movedTaskIds, summary };
}
