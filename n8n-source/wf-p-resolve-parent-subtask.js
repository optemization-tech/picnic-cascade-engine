// ============================================================
// WF-P: Parent/Subtask Engine — Resolve Parent/Subtask Logic
// Case A: Parent edited -> shift subtasks + dep resolve + roll-up
// Case B: Subtask edited -> roll-up parent
// Incorporates Bug fixes #1-#6 from Phase 2C
// v1 2026-03-15
// ============================================================

const input = $input.first().json;
const sourceTaskId = input.sourceTaskId;
const sourceTaskName = input.sourceTaskName;
const newStart = input.newStart;
const newEnd = input.newEnd;
const parentTaskId = input.parentTaskId; // null for case-a, set for case-b
const parentMode = input.parentMode;     // 'case-a' or 'case-b'
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

function signedBDDelta(from, to) {
  if (!from || !to || from.getTime() === to.getTime()) return 0;
  const dir = to > from ? 1 : -1;
  let count = 0;
  const cursor = new Date(from);
  if (dir === 1) {
    while (cursor < to) {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      if (isBusinessDay(cursor)) count++;
    }
  } else {
    while (cursor > to) {
      cursor.setUTCDate(cursor.getUTCDate() - 1);
      if (isBusinessDay(cursor)) count++;
    }
  }
  return count * dir;
}

// Complete Freeze: Done/N/A tasks are invisible to shifts/dep resolution
// but INCLUDED in roll-up min/max.
const FROZEN_STATUSES = new Set(['Done', 'N/A']);
function isFrozen(task) {
  return FROZEN_STATUSES.has(task.status);
}

function noUpdates(reason) {
  return [{ json: { _noUpdates: true, _reason: reason } }];
}

// ============================================================
// BUILD TASK GRAPH
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
    blockingIds: (p['Blocking']?.relation || []).map(r => r.id),
    // Bug fix #2/#6: scan by parentId, don't trust relation arrays (25-item limit)
    parentId: (p['Parent Task']?.relation || [])[0]?.id || null
  };
}

const ts = new Date().toISOString().replace('T', ' ').substring(0, 16);
const updates = new Map();

// ============================================================
// CASE A: Parent edited -> shift subtasks + dep resolve + roll-up
// ============================================================

if (parentMode === 'case-a') {
  const sourceTask = taskById[sourceTaskId];
  if (!sourceTask) return noUpdates('Source parent task not found');

  // Bug fix #2/#6: Find subtasks by scanning parentId (not relation property)
  const subtaskIds = [];
  for (const [id, task] of Object.entries(taskById)) {
    if (task.parentId === sourceTaskId) subtaskIds.push(id);
  }

  if (subtaskIds.length === 0) return noUpdates('No subtasks found for parent');

  // Bug fix #6: Detect edit type via natural positions
  // Natural positions = current min/max of subtask dates (the roll-up baseline)
  let naturalStart = null;
  let naturalEnd = null;
  for (const stId of subtaskIds) {
    const st = taskById[stId];
    if (!st || !st.start || !st.end) continue;
    if (!naturalStart || st.start < naturalStart) naturalStart = st.start;
    if (!naturalEnd || st.end > naturalEnd) naturalEnd = st.end;
  }

  if (!naturalStart || !naturalEnd) return noUpdates('Subtasks have no dates');

  const newStartD = parseDate(newStart);
  const newEndD = parseDate(newEnd);

  // Detect edit type
  const startChanged = formatDate(naturalStart) !== newStart;
  const endChanged = formatDate(naturalEnd) !== newEnd;

  let delta = 0;
  if (startChanged && endChanged) {
    // Drag: use end delta
    delta = signedBDDelta(naturalEnd, newEndD);
  } else if (endChanged) {
    // End-only change
    delta = signedBDDelta(naturalEnd, newEndD);
  } else if (startChanged) {
    // Start-only change
    delta = signedBDDelta(naturalStart, newStartD);
  }
  // else: no change detected (roll-up will handle)

  if (delta !== 0) {
    // Step 1: Shift each subtask by delta (skip frozen)
    const shiftedIds = new Set();
    for (const stId of subtaskIds) {
      const st = taskById[stId];
      if (!st || !st.start || !st.end) continue;
      if (isFrozen(st)) continue; // Complete Freeze

      const ns = addBusinessDays(st.start, delta);
      const ne = addBusinessDays(st.end, delta);
      taskById[stId].start = ns;
      taskById[stId].end = ne;
      updates.set(stId, {
        taskId: stId,
        taskName: st.name,
        newStart: formatDate(ns),
        newEnd: formatDate(ne),
        newReferenceStartDate: formatDate(ns),
        newReferenceEndDate: formatDate(ne),
        _logEntry: '[' + ts + '] Parent shift: ' + (delta > 0 ? '+' : '') + delta + ' BD by parent ' + sourceTaskName
      });
      shiftedIds.add(stId);
    }

    // Step 2: Conflict-only dep resolution from shifted subtasks
    if (shiftedIds.size > 0) {
      const reachable = new Set();
      const stack = [...shiftedIds];
      while (stack.length > 0) {
        const cur = stack.pop();
        if (reachable.has(cur)) continue;
        reachable.add(cur);
        for (const bid of (taskById[cur]?.blockingIds || [])) {
          if (!reachable.has(bid) && taskById[bid]) stack.push(bid);
        }
      }

      // Topo sort
      const inDeg = {};
      for (const id of reachable) inDeg[id] = 0;
      for (const id of reachable) {
        for (const bid of (taskById[id]?.blockedByIds || [])) {
          if (reachable.has(bid)) inDeg[id]++;
        }
      }
      const queue = [];
      for (const id of reachable) { if (inDeg[id] === 0) queue.push(id); }
      const topoOrder = [];
      while (queue.length > 0) {
        const cur = queue.shift();
        topoOrder.push(cur);
        for (const bid of (taskById[cur]?.blockingIds || [])) {
          if (reachable.has(bid)) { inDeg[bid]--; if (inDeg[bid] === 0) queue.push(bid); }
        }
      }

      // Conflict-only push-right
      const effectiveEnds = {};
      for (const id of shiftedIds) {
        if (taskById[id]) effectiveEnds[id] = taskById[id].end;
      }
      for (const taskId of topoOrder) {
        if (shiftedIds.has(taskId)) continue;
        const task = taskById[taskId];
        if (!task || !task.start || !task.end) continue;
        if (isFrozen(task)) continue;

        let maxStart = task.start;
        for (const blockerId of task.blockedByIds) {
          const blocker = taskById[blockerId];
          if (!blocker) continue;
          if (isFrozen(blocker)) continue;
          const bEnd = effectiveEnds[blockerId] || blocker.end;
          if (!bEnd) continue;
          const cand = nextBusinessDay(bEnd);
          if (cand > maxStart) maxStart = cand;
        }
        if (maxStart > task.start) {
          const newTaskEnd = addBusinessDays(maxStart, task.duration - 1);
          effectiveEnds[taskId] = newTaskEnd;
          taskById[taskId].start = maxStart;
          taskById[taskId].end = newTaskEnd;
          updates.set(taskId, {
            taskId,
            taskName: task.name,
            newStart: formatDate(maxStart),
            newEnd: formatDate(newTaskEnd),
            newReferenceStartDate: formatDate(maxStart),
            newReferenceEndDate: formatDate(newTaskEnd),
            _logEntry: '[' + ts + '] Dep cascade from parent shift'
          });
        }
      }
    }
  }

  // Step 3: Roll-up — min/max of ALL subtasks (including frozen)
  let minS = null, maxE = null;
  for (const stId of subtaskIds) {
    const st = taskById[stId];
    if (!st || !st.start || !st.end) continue;
    if (!minS || st.start < minS) minS = st.start;
    if (!maxE || st.end > maxE) maxE = st.end;
  }
  if (minS && maxE) {
    updates.set(sourceTaskId, {
      taskId: sourceTaskId,
      taskName: sourceTaskName,
      newStart: formatDate(minS),
      newEnd: formatDate(maxE),
      newReferenceStartDate: formatDate(minS),
      newReferenceEndDate: formatDate(maxE),
      _isRollUp: true,
      _logEntry: '[' + ts + '] Case A roll-up: ' + formatDate(minS) + ' to ' + formatDate(maxE)
    });
  }
}

// ============================================================
// CASE B: Subtask edited -> roll-up parent
// ============================================================

if (parentMode === 'case-b') {
  if (!parentTaskId) return noUpdates('No parentTaskId for case-b');

  // Bug fix #3: Patch source subtask with webhook dates (eventual consistency fix)
  if (taskById[sourceTaskId]) {
    taskById[sourceTaskId].start = parseDate(newStart);
    taskById[sourceTaskId].end = parseDate(newEnd);
  }

  // Bug fix #2: Find siblings by scanning parentId (not relation property)
  const siblingIds = [];
  for (const [id, task] of Object.entries(taskById)) {
    if (task.parentId === parentTaskId) siblingIds.push(id);
  }

  if (siblingIds.length === 0) return noUpdates('No siblings found for parent');

  // Roll-up: min/max of ALL siblings (including frozen)
  let minS = null, maxE = null;
  for (const sibId of siblingIds) {
    const sib = taskById[sibId];
    if (!sib || !sib.start || !sib.end) continue;
    if (!minS || sib.start < minS) minS = sib.start;
    if (!maxE || sib.end > maxE) maxE = sib.end;
  }

  if (!minS || !maxE) return noUpdates('Siblings have no dates');

  const parent = taskById[parentTaskId];
  const parentName = parent ? parent.name : parentTaskId.substring(0, 8);

  // Only update if dates actually changed
  const changed = !parent || !parent.start || !parent.end
    || formatDate(minS) !== formatDate(parent.start)
    || formatDate(maxE) !== formatDate(parent.end);

  if (changed) {
    updates.set(parentTaskId, {
      taskId: parentTaskId,
      taskName: parentName,
      newStart: formatDate(minS),
      newEnd: formatDate(maxE),
      newReferenceStartDate: formatDate(minS),
      newReferenceEndDate: formatDate(maxE),
      _isRollUp: true,
      _logEntry: '[' + ts + '] Case B roll-up from ' + sourceTaskName + ': ' + formatDate(minS) + ' to ' + formatDate(maxE)
    });
  }
}

// ============================================================
// OUTPUT
// ============================================================

if (updates.size === 0) {
  return noUpdates('No parent/subtask updates needed (' + parentMode + ')');
}

return Array.from(updates.values()).map(u => ({
  json: {
    ...u,
    _reportingMsg: u._isRollUp
      ? '❇️ Roll-up: dates set to ' + u.newStart + ' \u2014 ' + u.newEnd
      : '❇️ Parent shift: dates moved (triggered by ' + sourceTaskName + ')'
  }
}));
