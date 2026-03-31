// ============================================================
// WF-D: Unified Directional Cascade Engine — Resolve Cascade
// Handles: push-right, pull-left, pull-right, drag-right
// Input from Router via Execute Workflow trigger
// v1 2026-03-15
// ============================================================

const input = $input.first().json;
const sourceTaskId = input.sourceTaskId;
const sourceTaskName = input.sourceTaskName;
const newStart = input.newStart;
const newEnd = input.newEnd;
const refStart = input.refStart;
const refEnd = input.refEnd;
const startDelta = input.startDelta;   // signed BD delta
const endDelta = input.endDelta;       // signed BD delta
const cascadeMode = input.cascadeMode; // push-right | pull-left | pull-right | drag-right
const allTaskPages = input.results || [];

// ============================================================
// SHARED UTILITIES
// ============================================================

function parseDate(s) {
  return s ? new Date(s + 'T00:00:00Z') : null;
}

function formatDate(d) {
  return d.toISOString().split('T')[0];
}

function isBusinessDay(d) {
  const day = d.getUTCDay();
  return day !== 0 && day !== 6;
}

function nextBusinessDay(d) {
  const n = new Date(d);
  do { n.setUTCDate(n.getUTCDate() + 1); } while (!isBusinessDay(n));
  return n;
}

function prevBusinessDay(d) {
  const p = new Date(d);
  do { p.setUTCDate(p.getUTCDate() - 1); } while (!isBusinessDay(p));
  return p;
}

function addBusinessDays(d, count) {
  const c = new Date(d);
  if (count === 0) return c;
  let remaining = Math.abs(count);
  const dir = count > 0 ? 1 : -1;
  while (remaining > 0) {
    c.setUTCDate(c.getUTCDate() + dir);
    if (isBusinessDay(c)) remaining--;
  }
  return c;
}

function countBDInclusive(start, end) {
  if (!start || !end || end < start) return 1;
  let count = 0;
  const c = new Date(start);
  while (c <= end) {
    if (isBusinessDay(c)) count++;
    c.setUTCDate(c.getUTCDate() + 1);
  }
  return Math.max(count, 1);
}

// Complete Freeze: Done/N/A tasks are invisible to the cascade engine.
// They don't move during cascades AND are excluded as blockers.
const FROZEN_STATUSES = new Set(['Done', 'N/A']);
function isFrozen(task) {
  return FROZEN_STATUSES.has(task.status);
}

function noUpdates(reason) {
  return [{ json: { _noUpdates: true, _reason: reason } }];
}

// ============================================================
// BUILD TASK GRAPH (from raw Notion pages)
// ============================================================

const taskById = {};
for (const page of allTaskPages) {
  const id = page.id;
  const p = page.properties;
  const dStart = p['Dates']?.date?.start ? parseDate(p['Dates'].date.start) : null;
  const dEnd = p['Dates']?.date?.end ? parseDate(p['Dates'].date.end) : (dStart ? new Date(dStart) : null);

  taskById[id] = {
    id,
    name: p['Task Name']?.title?.[0]?.text?.content
      || p['Task Name']?.title?.[0]?.plain_text
      || id.substring(0, 8),
    start: dStart,
    end: dEnd,
    duration: (dStart && dEnd) ? countBDInclusive(dStart, dEnd) : 1,
    status: p['Status']?.status?.name || '',
    blockedByIds: (p['Blocked by']?.relation || []).map(r => r.id),
    blockingIds: (p['Blocking']?.relation || []).map(r => r.id)
  };
}

const sourceTask = taskById[sourceTaskId];
if (!sourceTask) {
  return noUpdates('Source task not found among study tasks');
}

// Patch source task with webhook dates (authoritative over eventual-consistency DB query)
sourceTask.start = parseDate(newStart);
sourceTask.end = parseDate(newEnd);

// ============================================================
// BUILDING BLOCKS — reusable algorithm functions
// ============================================================

// -----------------------------------------------------------
// conflictOnlyDownstream: push downstream tasks right when
// their start violates nextBD(blocker.newEnd).
// Used by: push-right, pull-right, drag-right (Pass 2)
// Seeds: set of task IDs whose ends have changed
// -----------------------------------------------------------
function conflictOnlyDownstream(seedTaskIds, updatesMap) {
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

    if (!latestConstraint) continue;
    if (task.start >= latestConstraint) continue; // no conflict

    const newTaskStart = latestConstraint;
    const newTaskEnd = addBusinessDays(newTaskStart, task.duration - 1);
    effectiveEnds[taskId] = newTaskEnd;

    updatesMap[taskId] = {
      taskId,
      taskName: task.name,
      newStart: formatDate(newTaskStart),
      newEnd: formatDate(newTaskEnd),
      duration: task.duration
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
function pullLeftUpstream(sourceId, updatesMap) {
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
              duration: blocker.duration
            };
            queue.push(blockerId);
          }
        }
      }
    }
  }
}

// -----------------------------------------------------------
// gapPreservingDownstream: pull downstream tasks earlier
// while preserving original gaps between blocker.end and
// dependent.start. Mirrors Phase 2A's gap-preservation but
// pulls left instead of pushing right.
// Used by: pull-left (Pass 2)
// -----------------------------------------------------------
function gapPreservingDownstream(sourceId, sourceOldEnd, updatesMap) {
  // Step 1: Find reachable downstream tasks
  const reachable = new Set();
  const dfsStack = [sourceId];
  while (dfsStack.length > 0) {
    const cur = dfsStack.pop();
    if (reachable.has(cur)) continue;
    reachable.add(cur);
    for (const bid of (taskById[cur]?.blockingIds || [])) {
      if (!reachable.has(bid) && taskById[bid]) dfsStack.push(bid);
    }
  }

  if (reachable.size <= 1) return;

  // Step 2: Pre-compute original gaps (BEFORE any cascade)
  const originalGaps = {};
  for (const taskId of reachable) {
    if (taskId === sourceId) continue;
    const task = taskById[taskId];
    if (!task || !task.start) continue;
    for (const blockerId of task.blockedByIds) {
      if (!taskById[blockerId]) continue;
      // Source: use ORIGINAL end (before PM's edit)
      // Others: use current end (before cascade)
      const blockerOrigEnd = (blockerId === sourceId)
        ? parseDate(sourceOldEnd)
        : taskById[blockerId].end;
      if (!blockerOrigEnd) continue;
      const nbd = nextBusinessDay(blockerOrigEnd);
      let gap = 0;
      if (nbd <= task.start) {
        gap = countBDInclusive(nbd, task.start) - 1;
      }
      originalGaps[`${blockerId}->${taskId}`] = Math.max(gap, 0);
    }
  }

  // Step 3: Topological sort (Kahn's)
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

  // Step 4: Build effective ends from source + upstream pass results
  const effectiveEnds = {};
  effectiveEnds[sourceId] = parseDate(newEnd);
  for (const [tid, upd] of Object.entries(updatesMap)) {
    effectiveEnds[tid] = parseDate(upd.newEnd);
  }

  // Step 5: Process in topo order — pull left with gap preservation
  for (const taskId of topoOrder) {
    if (taskId === sourceId) continue;
    const task = taskById[taskId];
    if (!task || !task.start || !task.end) continue;
    if (isFrozen(task)) continue;

    let latestConstrainedStart = null;
    for (const blockerId of task.blockedByIds) {
      let blockerNewEnd = null;
      if (effectiveEnds[blockerId] !== undefined) {
        blockerNewEnd = effectiveEnds[blockerId];
      } else if (updatesMap[blockerId]) {
        blockerNewEnd = parseDate(updatesMap[blockerId].newEnd);
      } else if (taskById[blockerId]) {
        // Blocker not in reachable set or not moved — skip if frozen
        if (isFrozen(taskById[blockerId])) continue;
        blockerNewEnd = taskById[blockerId].end;
      }
      if (!blockerNewEnd) continue;

      const gap = originalGaps[`${blockerId}->${taskId}`] || 0;
      const candidateStart = addBusinessDays(nextBusinessDay(blockerNewEnd), gap);

      // Fan-in: take the LATEST constraint (most conservative)
      if (!latestConstrainedStart || candidateStart > latestConstrainedStart) {
        latestConstrainedStart = candidateStart;
      }
    }

    // Only pull left — never push right (that's push-right's job)
    if (latestConstrainedStart && latestConstrainedStart < task.start) {
      const taskNewEnd = addBusinessDays(latestConstrainedStart, task.duration - 1);
      effectiveEnds[taskId] = taskNewEnd;

      // Merge: take earlier date if conflict with upstream pass
      const existing = updatesMap[taskId];
      if (!existing || taskNewEnd < parseDate(existing.newEnd)) {
        updatesMap[taskId] = {
          taskId,
          taskName: task.name,
          newStart: formatDate(latestConstrainedStart),
          newEnd: formatDate(taskNewEnd),
          duration: task.duration
        };
      }
    } else {
      // Task doesn't move — propagate current end for further downstream
      effectiveEnds[taskId] = task.end;
    }
  }
}

// -----------------------------------------------------------
// pullRightUpstream: BFS upstream via Blocked by edges.
// When a task's start moves right, push its blockers right
// by the same delta. Then cascade downstream on conflict.
// Used by: pull-right, drag-right (Pass 1)
// -----------------------------------------------------------
function pullRightUpstream(sourceId, deltaBD, updatesMap) {
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

      const effStart = updatesMap[blockerId]
        ? parseDate(updatesMap[blockerId].newStart)
        : blocker.start;
      const effEnd = updatesMap[blockerId]
        ? parseDate(updatesMap[blockerId].newEnd)
        : blocker.end;

      const newBlockerStart = addBusinessDays(effStart, deltaBD);
      const newBlockerEnd = addBusinessDays(effEnd, deltaBD);

      // Take the most aggressive (latest/rightmost) push
      const existing = updatesMap[blockerId];
      if (!existing || newBlockerEnd > parseDate(existing.newEnd)) {
        updatesMap[blockerId] = {
          taskId: blockerId,
          taskName: blocker.name,
          newStart: formatDate(newBlockerStart),
          newEnd: formatDate(newBlockerEnd),
          duration: blocker.duration
        };
        queue.push(blockerId);
      }
    }
  }
}

// ============================================================
// MODE DISPATCH
// ============================================================

const updatesMap = {};

switch (cascadeMode) {
  case 'push-right': {
    // End moved right -> push downstream on conflict only
    const seeds = new Set([sourceTaskId]);
    conflictOnlyDownstream(seeds, updatesMap);
    break;
  }

  case 'pull-left': {
    // End moved left -> pull upstream blockers earlier (gap collapse),
    // then pull downstream dependents earlier (gap preservation)
    pullLeftUpstream(sourceTaskId, updatesMap);
    gapPreservingDownstream(sourceTaskId, refEnd, updatesMap);
    break;
  }

  case 'pull-right':
  case 'drag-right': {
    // Start moved right -> push upstream blockers right by delta,
    // then push downstream on conflict
    pullRightUpstream(sourceTaskId, startDelta, updatesMap);
    // Downstream: seeds = source + all upstream-moved tasks
    const seeds = new Set([sourceTaskId]);
    for (const tid of Object.keys(updatesMap)) { seeds.add(tid); }
    conflictOnlyDownstream(seeds, updatesMap);
    break;
  }

  default:
    return noUpdates('Unknown cascadeMode: ' + cascadeMode);
}

// ============================================================
// OUTPUT
// ============================================================

const updates = Object.values(updatesMap);
if (updates.length === 0) {
  return noUpdates('No tasks needed updating (' + cascadeMode + ')');
}

const now = new Date();
const ts = now.toISOString().replace('T', ' ').substring(0, 16);

return updates.map(u => ({
  json: {
    taskId: u.taskId,
    taskName: u.taskName,
    newStart: u.newStart,
    newEnd: u.newEnd,
    newReferenceStartDate: u.newStart,
    newReferenceEndDate: u.newEnd,
    duration: u.duration,
    _reportingMsg: '❇️ ' + cascadeMode + ' cascade: dates shifted (triggered by ' + sourceTaskName + ')',
    _logEntry: '[' + ts + '] ' + cascadeMode + ': ' + u.taskName + ' -> ' + u.newStart + ' to ' + u.newEnd
  }
}));
