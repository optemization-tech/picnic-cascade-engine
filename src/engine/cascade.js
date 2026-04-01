// ============================================================
// Cascade Engine — Directional Date Cascade
// Ported from WF-D: Resolve Cascade (n8n Code node)
// Handles: push-right, pull-left, pull-right, drag-right
// v7 2026-04-01: Meg-confirmed rules (pullRight shifts ALL upstream,
//   no adjacency/absorption; uniform delta downstream;
//   cross-chain frustration resolution for pull-left)
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
// Used by: pull-left (Pass 2)
// -----------------------------------------------------------
function gapPreservingDownstream(sourceId, sourceOldEnd, newEnd, updatesMap, taskById, extraSeedIds = []) {
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

  // BFS downstream from source + any shifted upstream tasks
  const seedExclusions = new Set([sourceId, ...extraSeedIds]);
  const downstream = new Set();
  const bfsQueue = [sourceId, ...extraSeedIds];
  while (bfsQueue.length > 0) {
    const tid = bfsQueue.shift();
    const t = taskById[tid];
    if (!t) continue;
    for (const depId of (t.blockingIds || [])) {
      if (!downstream.has(depId) && !seedExclusions.has(depId)) {
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
// resolveCrossChainFrustrations: fixed-point loop.
// After gapPreservingDownstream, some downstream tasks may have
// been clamped by cross-chain blockers (blockers not in the
// source's chain). This function shifts those blockers left,
// then re-runs gapPreservingDownstream until stable or cap.
// Meg-confirmed 2026-03-31: cascade propagates through all
// affected chains ("if those tasks also adjust").
// Used by: pull-left (after Pass 2)
// -----------------------------------------------------------
function resolveCrossChainFrustrations(
  sourceId, sourceOldEnd, sourceNewEnd,
  updatesMap, taskById, prePositions, maxRounds = 5, extraSeedIds = []
) {
  const oldEndD = parseDate(sourceOldEnd);
  const srcNewEnd = updatesMap[sourceId]
    ? parseDate(updatesMap[sourceId].newEnd) : parseDate(sourceNewEnd);
  if (!oldEndD || !srcNewEnd || srcNewEnd >= oldEndD) return;

  // Compute uniform BD delta (negative)
  let deltaBD = 0;
  const cur = new Date(srcNewEnd);
  while (cur < oldEndD) {
    cur.setUTCDate(cur.getUTCDate() + 1);
    if (isBusinessDay(cur)) deltaBD--;
  }
  if (deltaBD >= 0) return;

  // Collect downstream task IDs (BFS from source + shifted upstream)
  const seedExclusions = new Set([sourceId, ...extraSeedIds]);
  const downstream = new Set();
  const q = [sourceId, ...extraSeedIds];
  while (q.length > 0) {
    const tid = q.shift();
    for (const depId of (taskById[tid]?.blockingIds || [])) {
      if (!downstream.has(depId) && !seedExclusions.has(depId)) {
        downstream.add(depId);
        q.push(depId);
      }
    }
  }
  if (downstream.size === 0) return;

  for (let round = 0; round < maxRounds; round++) {
    let anyBlockerShifted = false;

    for (const tid of downstream) {
      const orig = prePositions[tid];
      if (!orig) continue;
      const task = taskById[tid];
      if (!task || isFrozen(task)) continue;

      const desiredStart = addBusinessDays(orig.start, deltaBD);
      if (task.start <= desiredStart) continue; // not frustrated

      // Skip if a frozen blocker prevents reaching desired position
      let frozenPrevents = false;
      for (const bid of (task.blockedByIds || [])) {
        const b = taskById[bid];
        if (b && b.end && isFrozen(b) && nextBusinessDay(b.end) > desiredStart) {
          frozenPrevents = true;
          break;
        }
      }
      if (frozenPrevents) continue;

      // Find limiting non-frozen blocker (latest constraint past desired)
      let limitId = null, latestC = null;
      for (const bid of (task.blockedByIds || [])) {
        const b = taskById[bid];
        if (!b || !b.end || isFrozen(b)) continue;
        const c = nextBusinessDay(b.end);
        if (c > desiredStart && (!latestC || c > latestC)) {
          limitId = bid;
          latestC = c;
        }
      }
      if (!limitId) continue;

      const blocker = taskById[limitId];
      const neededEnd = prevBusinessDay(desiredStart);
      if (neededEnd >= blocker.end) continue;

      // Shift the blocker left
      const newBStart = addBusinessDays(neededEnd, -(blocker.duration - 1));
      blocker.start = newBStart;
      blocker.end = neededEnd;
      updatesMap[limitId] = {
        taskId: limitId,
        taskName: blocker.name,
        newStart: formatDate(newBStart),
        newEnd: formatDate(neededEnd),
        duration: blocker.duration,
      };

      // Cascade through blocker's upstream chain (resolve conflicts the shift created)
      pullLeftUpstream(limitId, formatDate(newBStart), updatesMap, taskById);

      // Re-validate: blocker may have been clamped by its own immovable upstream
      let validStart = newBStart;
      for (const bbId of (blocker.blockedByIds || [])) {
        const bb = taskById[bbId];
        if (!bb) continue;
        const bbEnd = updatesMap[bbId] ? parseDate(updatesMap[bbId].newEnd) : bb.end;
        if (!bbEnd) continue;
        const minS = nextBusinessDay(bbEnd);
        if (minS > validStart) validStart = minS;
      }
      if (validStart > newBStart) {
        const validEnd = addBusinessDays(validStart, blocker.duration - 1);
        blocker.start = validStart;
        blocker.end = validEnd;
        updatesMap[limitId].newStart = formatDate(validStart);
        updatesMap[limitId].newEnd = formatDate(validEnd);
      }

      anyBlockerShifted = true;
    }

    if (!anyBlockerShifted) break;

    // Restore downstream positions to pre-cascade originals and re-run
    for (const tid of downstream) {
      const orig = prePositions[tid];
      if (!orig) continue;
      const t = taskById[tid];
      if (t) {
        t.start = new Date(orig.start);
        t.end = new Date(orig.end);
      }
      delete updatesMap[tid];
    }
    gapPreservingDownstream(sourceId, sourceOldEnd, sourceNewEnd, updatesMap, taskById, extraSeedIds);
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

    case 'pull-left': {
      const upstreamDiag = pullLeftUpstream(sourceTaskId, newStart, updatesMap, taskById);
      diagnostics.iterations = upstreamDiag.iterations;
      diagnostics.capReached = upstreamDiag.capReached;
      diagnostics.unresolvedResidue = upstreamDiag.unresolvedResidue;
      diagnostics.monotonicSafe = upstreamDiag.monotonicSafe;

      // Collect shifted upstream task IDs for fan-out propagation
      const shiftedUpstreamIds = Object.keys(updatesMap);

      // Save positions before gap-preserving pass (for cross-chain frustration detection)
      const prePositions = {};
      for (const id of Object.keys(taskById)) {
        const t = taskById[id];
        if (t && t.start && t.end) {
          prePositions[id] = { start: new Date(t.start), end: new Date(t.end) };
        }
      }

      gapPreservingDownstream(sourceTaskId, refEnd, newEnd, updatesMap, taskById, shiftedUpstreamIds);
      resolveCrossChainFrustrations(sourceTaskId, refEnd, newEnd, updatesMap, taskById, prePositions, 5, shiftedUpstreamIds);
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
