// ============================================================
// Cascade Engine — Directional Date Cascade
// Ported from WF-D: Resolve Cascade (n8n Code node)
// Handles: push-right, pull-left, start-left, pull-right, drag-left, drag-right
// v8 2026-04-08: split leftward edit modes and treat drags as whole-graph translation
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

function collectConnectedTaskIds(seedIds, taskById) {
  const queue = Array.isArray(seedIds) ? [...seedIds] : [seedIds];
  const connected = new Set();

  while (queue.length > 0) {
    const taskId = queue.shift();
    if (connected.has(taskId)) continue;
    connected.add(taskId);

    const task = taskById[taskId];
    if (!task) continue;

    for (const blockerId of (task.blockedByIds || [])) {
      if (!connected.has(blockerId) && taskById[blockerId]) queue.push(blockerId);
    }
    for (const dependentId of (task.blockingIds || [])) {
      if (!connected.has(dependentId) && taskById[dependentId]) queue.push(dependentId);
    }
  }

  return connected;
}

function shiftConnectedComponent(seedIds, deltaBD, updatesMap, taskById, excludedIds = []) {
  if (!deltaBD) return;

  const excluded = new Set(excludedIds);
  const connected = collectConnectedTaskIds(seedIds, taskById);

  for (const taskId of connected) {
    if (excluded.has(taskId)) continue;

    const task = taskById[taskId];
    if (!task || !task.start || !task.end) continue;
    if (isFrozen(task)) continue;

    const newStart = addBusinessDays(task.start, deltaBD);
    const newEnd = addBusinessDays(task.end, deltaBD);
    task.start = newStart;
    task.end = newEnd;

    updatesMap[taskId] = {
      taskId,
      taskName: task.name,
      newStart: formatDate(newStart),
      newEnd: formatDate(newEnd),
      duration: task.duration,
    };
  }
}

// -----------------------------------------------------------
// conflictOnlyDownstream: push downstream tasks right when
// their start violates nextBD(blocker.newEnd).
// Used by: push-right
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
// Used by: start-left
// -----------------------------------------------------------
function pullLeftUpstream(sourceId, newStart, updatesMap, taskById) {
  const queue = [sourceId];
  const processedWith = new Map(); // taskId -> effectiveStart string
  let iterations = 0;
  const MAX_ITER = 2000;
  let monotonicSafe = true;

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
          } else if (existing && newBlockerEnd > parseDate(existing.newEnd)) {
            monotonicSafe = false;
          }
        }
      }
    }
  }

  const capReached = iterations >= MAX_ITER && queue.length > 0;
  return {
    iterations,
    capReached,
    unresolvedResidue: capReached ? [...new Set(queue)] : [],
    monotonicSafe,
  };
}

// -----------------------------------------------------------
// gapPreservingDownstream (v3): uniform delta shift.
// Computes a single negative BD delta from the source end
// change and shifts ALL downstream tasks by that same delta,
// clamped to blocker constraints.
// Used by: pull-left
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
// tightenDownstreamFromSeed: tight-schedule downstream pass.
// BFS downstream from a seed set, topologically sorts the
// reachable non-frozen set, and for each task assigns
//   newStart = nextBD(max(non-frozen blocker effective end))
// with duration preserved from taskById. Unlike
// conflictOnlyDownstream, there is no early-out: every
// reachable non-frozen task tightens against its blockers.
// Frozen downstream tasks are skipped (don't move). Frozen
// blockers are excluded from the constraint calculation.
// Mutates updatesMap in place; does NOT mutate taskById.
// Used by: start-left
// -----------------------------------------------------------
function tightenDownstreamFromSeed(seedTaskIds, updatesMap, taskById) {
  // Step 1: BFS reachable set downstream from seeds via Blocking edges
  const reachable = new Set();
  const dfsStack = [];
  for (const sid of seedTaskIds) {
    if (taskById[sid]) dfsStack.push(sid);
  }
  while (dfsStack.length > 0) {
    const cur = dfsStack.pop();
    if (reachable.has(cur)) continue;
    reachable.add(cur);
    for (const bid of (taskById[cur]?.blockingIds || [])) {
      if (!reachable.has(bid) && taskById[bid]) dfsStack.push(bid);
    }
  }

  if (reachable.size === 0) return;

  // Step 2: Topological sort (Kahn's algorithm) over the reachable set
  const inDegree = {};
  for (const id of reachable) { inDegree[id] = 0; }
  for (const id of reachable) {
    const task = taskById[id];
    if (!task) continue;
    for (const bid of (task.blockedByIds || [])) {
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

  // Step 3: Process in topo order — tighten against effective blocker ends.
  // Seeds themselves are skipped (their updates were authored by upstream pass).
  for (const taskId of topoOrder) {
    if (seedTaskIds.has(taskId)) continue;
    const task = taskById[taskId];
    if (!task || !task.start || !task.end) continue;
    if (isFrozen(task)) continue;

    let effectiveBlockerEnd = null;
    for (const blockerId of (task.blockedByIds || [])) {
      const blocker = taskById[blockerId];
      if (!blocker) continue;
      if (isFrozen(blocker)) continue;

      // Read blocker end from updatesMap if present, else from original taskById
      // (bug 2A.2 pattern: don't trust running state; consult snapshot+overlay).
      const blockerEnd = updatesMap[blockerId]
        ? parseDate(updatesMap[blockerId].newEnd)
        : blocker.end;
      if (!blockerEnd) continue;

      if (!effectiveBlockerEnd || blockerEnd > effectiveBlockerEnd) {
        effectiveBlockerEnd = blockerEnd;
      }
    }

    if (!effectiveBlockerEnd) continue;

    const newStart = nextBusinessDay(effectiveBlockerEnd);
    // Duration preserved from pre-cascade task state (same pattern as
    // gapPreservingDownstream:346). Do NOT read duration from updatesMap.
    const duration = countBDInclusive(task.start, task.end);
    const newEnd = addBusinessDays(newStart, duration - 1);

    updatesMap[taskId] = {
      taskId,
      taskName: task.name,
      newStart: formatDate(newStart),
      newEnd: formatDate(newEnd),
      duration,
    };
  }
}

// -----------------------------------------------------------
// pullRightUpstream (v6): BFS upstream via Blocked by edges.
// When a task's start moves right, shift ALL upstream blockers
// right by the same delta unconditionally (gap-preserving).
// Meg-confirmed 2026-03-31: no adjacency check, no gap absorption.
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

    for (const blockerId of current.blockedByIds) {
      if (visited.has(blockerId)) continue;
      const blocker = taskById[blockerId];
      if (!blocker || !blocker.start || !blocker.end) continue;
      if (isFrozen(blocker)) continue;

      // Always shift from ORIGINAL dates — deltaBD is constant for all
      // upstream blockers. Using updatesMap dates caused double-shifting
      // when a blocker was reachable via multiple paths (bug 2A.2).
      const finalStart = addBusinessDays(blocker.start, deltaBD);
      const finalEnd = addBusinessDays(blocker.end, deltaBD);

      if (!updatesMap[blockerId]) {
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

// -----------------------------------------------------------
// validateConstraints: post-cascade safety net.
// Topological sort over ALL tasks. For each task with
// predecessors, verify start >= nextBD(max(predecessor ends)).
// Fixes violations only — does NOT collapse gaps.
// -----------------------------------------------------------
function validateConstraints(updatesMap, taskById) {
  const allIds = Object.keys(taskById);
  const fixedTaskIds = [];

  // Topological sort (Kahn's)
  const inDegree = {};
  for (const id of allIds) inDegree[id] = 0;
  for (const id of allIds) {
    const t = taskById[id];
    if (!t) continue;
    for (const bid of (t.blockedByIds || [])) {
      if (taskById[bid]) inDegree[id]++;
    }
  }
  const queue = [];
  for (const id of allIds) {
    if (inDegree[id] === 0) queue.push(id);
  }
  const sorted = [];
  while (queue.length > 0) {
    const cur = queue.shift();
    sorted.push(cur);
    for (const depId of (taskById[cur]?.blockingIds || [])) {
      if (inDegree[depId] !== undefined) {
        inDegree[depId]--;
        if (inDegree[depId] === 0) queue.push(depId);
      }
    }
  }

  // Detect cycles: if topo sort is incomplete, some tasks are in cycles
  const cycleDetected = sorted.length < allIds.length;

  // Process in topo order: fix violations only
  for (const taskId of sorted) {
    const task = taskById[taskId];
    if (!task || !task.start || !task.end) continue;
    if (isFrozen(task)) continue;
    if ((task.blockedByIds || []).length === 0) continue;

    let earliestAllowed = null;
    for (const blockerId of task.blockedByIds) {
      const blocker = taskById[blockerId];
      if (!blocker) continue;
      if (isFrozen(blocker)) continue;
      const blockerEnd = updatesMap[blockerId]
        ? parseDate(updatesMap[blockerId].newEnd)
        : blocker.end;
      if (!blockerEnd) continue;
      const candidate = nextBusinessDay(blockerEnd);
      if (!earliestAllowed || candidate > earliestAllowed) earliestAllowed = candidate;
    }
    if (!earliestAllowed) continue;

    const effectiveStart = updatesMap[taskId]
      ? parseDate(updatesMap[taskId].newStart)
      : task.start;
    if (effectiveStart >= earliestAllowed) continue;

    // Violation — snap forward
    const duration = updatesMap[taskId]?.duration || task.duration || 1;
    const newEnd = addBusinessDays(earliestAllowed, duration - 1);

    updatesMap[taskId] = {
      taskId,
      taskName: task.name,
      newStart: formatDate(earliestAllowed),
      newEnd: formatDate(newEnd),
      duration,
    };
    // Mutate taskById so downstream tasks in topo order see corrected position
    taskById[taskId].start = earliestAllowed;
    taskById[taskId].end = newEnd;

    fixedTaskIds.push(taskId);
  }

  return {
    fixedCount: fixedTaskIds.length,
    fixedTaskIds,
    cycleDetected,
    sortedCount: sorted.length,
    totalCount: allIds.length,
  };
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
 * @param {string} params.cascadeMode - push-right | pull-left | start-left | pull-right | drag-left | drag-right
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

  // BL-H5g: Ignore parent-level dependency edges.
  // Parent tasks (those with subtasks) should not participate
  // in dependency-driven cascading.
  const parentIds = new Set();
  for (const t of tasks) {
    if (t.parentId && taskById[t.parentId]) {
      parentIds.add(t.parentId);
    }
  }
  if (parentIds.size > 0) {
    for (const id of Object.keys(taskById)) {
      const t = taskById[id];
      if (parentIds.has(id)) {
        t.blockedByIds = [];
        t.blockingIds = [];
      } else {
        t.blockedByIds = (t.blockedByIds || []).filter(bid => !parentIds.has(bid));
        t.blockingIds = (t.blockingIds || []).filter(bid => !parentIds.has(bid));
      }
    }
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
  const diagnostics = {
    iterations: 0,
    capReached: false,
    unresolvedResidue: [],
    monotonicSafe: true,
  };

  switch (cascadeMode) {
    case 'push-right': {
      const seeds = new Set([sourceTaskId]);
      conflictOnlyDownstream(seeds, updatesMap, taskById);
      break;
    }

    case 'start-left': {
      const upstreamDiag = pullLeftUpstream(sourceTaskId, newStart, updatesMap, taskById);
      diagnostics.iterations = upstreamDiag.iterations;
      diagnostics.capReached = upstreamDiag.capReached;
      diagnostics.unresolvedResidue = upstreamDiag.unresolvedResidue;
      diagnostics.monotonicSafe = upstreamDiag.monotonicSafe;

      // R2β-1/R2β-2: tighten downstream siblings reachable from the source
      // or any upstream-moved task. Without this pass, a downstream sibling
      // sharing a blocker with the source was never touched (Meg Apr 16 bug β).
      const seedIds = new Set([sourceTaskId, ...Object.keys(updatesMap)]);
      tightenDownstreamFromSeed(seedIds, updatesMap, taskById);
      break;
    }

    case 'pull-left': {
      gapPreservingDownstream(sourceTaskId, refEnd, newEnd, updatesMap, taskById);
      break;
    }

    case 'pull-right': {
      pullRightUpstream(sourceTaskId, refStart, startDelta, updatesMap, taskById);
      break;
    }

    case 'drag-left':
    case 'drag-right': {
      shiftConnectedComponent(sourceTaskId, startDelta, updatesMap, taskById, [sourceTaskId]);
      break;
    }

    default:
      return { updates: [], movedTaskMap: {}, movedTaskIds: [], summary: `Unknown cascadeMode: ${cascadeMode}` };
  }

  // Post-cascade constraint validation — catches pre-existing violations
  // and any edge cases the mode-specific passes missed
  const validationResult = validateConstraints(updatesMap, taskById);
  diagnostics.constraintFixCount = validationResult.fixedCount;
  diagnostics.constraintFixTaskIds = validationResult.fixedTaskIds;
  if (validationResult.cycleDetected) {
    diagnostics.cycleDetected = true;
    diagnostics.cycleMissedCount = validationResult.totalCount - validationResult.sortedCount;
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

  return { updates, movedTaskMap, movedTaskIds, summary, diagnostics };
}
