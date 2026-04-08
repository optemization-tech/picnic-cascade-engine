import {
  parseDate,
  formatDate,
  addBusinessDays,
  countBDInclusive,
  signedBDDelta,
} from '../utils/business-days.js';

const FROZEN_STATUSES = new Set(['Done', 'N/A']);

function isFrozen(task) {
  return FROZEN_STATUSES.has(task.status);
}

function collectConnectedTaskIds(seedIds, taskById) {
  const stack = [...seedIds];
  const connected = new Set();

  while (stack.length > 0) {
    const taskId = stack.pop();
    if (connected.has(taskId)) continue;
    connected.add(taskId);

    const task = taskById[taskId];
    if (!task) continue;

    for (const blockerId of (task.blockedByIds || [])) {
      if (!connected.has(blockerId) && taskById[blockerId]) stack.push(blockerId);
    }
    for (const dependentId of (task.blockingIds || [])) {
      if (!connected.has(dependentId) && taskById[dependentId]) stack.push(dependentId);
    }
  }

  return connected;
}

/**
 * Parent/Subtask resolver (pure-function port of WF-P Resolve Parent-Subtask).
 *
 * @param {Object} params
 * @param {string} params.sourceTaskId
 * @param {string} params.sourceTaskName
 * @param {string} params.newStart
 * @param {string} params.newEnd
 * @param {string|null} params.parentTaskId
 * @param {'case-a'|'case-b'|null} params.parentMode
 * @param {string[]} [params.movedTaskIds]
 * @param {Object} [params.movedTaskMap]
 * @param {Array} params.tasks
 * @returns {{ updates: Array, summary: string, parentMode: string|null, rollUpCount: number, rolledUpStart: string|null, rolledUpEnd: string|null }}
 */
export function runParentSubtask({
  sourceTaskId,
  sourceTaskName,
  newStart,
  newEnd,
  parentTaskId,
  parentMode,
  movedTaskIds = [],
  movedTaskMap = {},
  tasks = [],
}) {
  const taskById = {};
  for (const task of tasks) {
    const start = task.start instanceof Date ? task.start : parseDate(task.start);
    const endRaw = task.end ?? task.start;
    const end = endRaw instanceof Date ? endRaw : parseDate(endRaw);

    taskById[task.id] = {
      ...task,
      start,
      end,
      duration: task.duration || countBDInclusive(start, end),
      blockedByIds: task.blockedByIds || [],
      blockingIds: task.blockingIds || [],
      parentId: task.parentId || null,
      status: task.status || '',
      name: task.name || task.id,
    };
  }

  // Apply cascade-moved dates to in-memory graph BEFORE roll-up computations.
  // Without this, Case B roll-up would use stale pre-cascade sibling dates.
  for (const [tid, newDates] of Object.entries(movedTaskMap || {})) {
    if (taskById[tid] && newDates?.newStart && newDates?.newEnd) {
      taskById[tid].start = parseDate(newDates.newStart);
      taskById[tid].end = parseDate(newDates.newEnd);
    }
  }

  const ts = new Date().toISOString().replace('T', ' ').substring(0, 16);
  const updates = new Map();

  // ----------------------------------------------------------
  // CASE A: Parent edited -> shift subtasks + dep resolve + roll-up
  // ----------------------------------------------------------
  if (parentMode === 'case-a') {
    const sourceTask = taskById[sourceTaskId];
    if (!sourceTask) {
      return {
        updates: [],
        summary: 'Source parent task not found',
        parentMode,
        rollUpCount: 0,
        rolledUpStart: null,
        rolledUpEnd: null,
      };
    }

    const subtaskIds = [];
    for (const [id, task] of Object.entries(taskById)) {
      if (task.parentId === sourceTaskId) subtaskIds.push(id);
    }

    if (subtaskIds.length === 0) {
      return {
        updates: [],
        summary: 'No subtasks found for parent',
        parentMode,
        rollUpCount: 0,
        rolledUpStart: null,
        rolledUpEnd: null,
      };
    }

    let naturalStart = null;
    let naturalEnd = null;
    for (const stId of subtaskIds) {
      const st = taskById[stId];
      if (!st || !st.start || !st.end) continue;
      if (!naturalStart || st.start < naturalStart) naturalStart = st.start;
      if (!naturalEnd || st.end > naturalEnd) naturalEnd = st.end;
    }

    if (!naturalStart || !naturalEnd) {
      return {
        updates: [],
        summary: 'Subtasks have no dates',
        parentMode,
        rollUpCount: 0,
        rolledUpStart: null,
        rolledUpEnd: null,
      };
    }

    const newStartD = parseDate(newStart);
    const newEndD = parseDate(newEnd);
    const startChanged = formatDate(naturalStart) !== newStart;
    const endChanged = formatDate(naturalEnd) !== newEnd;

    let delta = 0;
    if (startChanged && endChanged) delta = signedBDDelta(naturalEnd, newEndD);
    else if (endChanged) delta = signedBDDelta(naturalEnd, newEndD);
    else if (startChanged) delta = signedBDDelta(naturalStart, newStartD);

    if (delta !== 0) {
      const shiftedIds = new Set();
      for (const stId of subtaskIds) {
        const st = taskById[stId];
        if (!st || !st.start || !st.end) continue;
        if (isFrozen(st)) continue;

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
          _logEntry: `[${ts}] Parent shift: ${delta > 0 ? '+' : ''}${delta} BD by parent ${sourceTaskName}`,
        });
        shiftedIds.add(stId);
      }

      if (shiftedIds.size > 0) {
        const connected = collectConnectedTaskIds([...shiftedIds], taskById);
        for (const taskId of connected) {
          if (shiftedIds.has(taskId) || taskId === sourceTaskId) continue;
          const task = taskById[taskId];
          if (!task || !task.start || !task.end) continue;
          if (isFrozen(task)) continue;

          const ns = addBusinessDays(task.start, delta);
          const ne = addBusinessDays(task.end, delta);
          taskById[taskId].start = ns;
          taskById[taskId].end = ne;
          updates.set(taskId, {
            taskId,
            taskName: task.name,
            newStart: formatDate(ns),
            newEnd: formatDate(ne),
            newReferenceStartDate: formatDate(ns),
            newReferenceEndDate: formatDate(ne),
            _logEntry: `[${ts}] Connected cascade from parent shift`,
          });
        }
      }
    }

    let minS = null;
    let maxE = null;
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
        _logEntry: `[${ts}] Case A roll-up: ${formatDate(minS)} to ${formatDate(maxE)}`,
      });
    }
  }

  // ----------------------------------------------------------
  // CASE B: Subtask edited -> roll-up parent
  // ----------------------------------------------------------
  if (parentMode === 'case-b') {
    if (!parentTaskId) {
      return {
        updates: [],
        summary: 'No parentTaskId for case-b',
        parentMode,
        rollUpCount: 0,
        rolledUpStart: null,
        rolledUpEnd: null,
      };
    }

    if (taskById[sourceTaskId]) {
      taskById[sourceTaskId].start = parseDate(newStart);
      taskById[sourceTaskId].end = parseDate(newEnd);
    }

    const siblingIds = [];
    for (const [id, task] of Object.entries(taskById)) {
      if (task.parentId === parentTaskId) siblingIds.push(id);
    }
    if (siblingIds.length === 0) {
      return {
        updates: [],
        summary: 'No siblings found for parent',
        parentMode,
        rollUpCount: 0,
        rolledUpStart: null,
        rolledUpEnd: null,
      };
    }

    let minS = null;
    let maxE = null;
    for (const sibId of siblingIds) {
      const sib = taskById[sibId];
      if (!sib || !sib.start || !sib.end) continue;
      if (!minS || sib.start < minS) minS = sib.start;
      if (!maxE || sib.end > maxE) maxE = sib.end;
    }
    if (!minS || !maxE) {
      return {
        updates: [],
        summary: 'Siblings have no dates',
        parentMode,
        rollUpCount: 0,
        rolledUpStart: null,
        rolledUpEnd: null,
      };
    }

    const parent = taskById[parentTaskId];
    const parentName = parent ? parent.name : parentTaskId.substring(0, 8);
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
        _logEntry: `[${ts}] Case B roll-up from ${sourceTaskName}: ${formatDate(minS)} to ${formatDate(maxE)}`,
      });
    }
  }

  // ----------------------------------------------------------
  // Cascade roll-up: parents of tasks moved by WF-D
  // ----------------------------------------------------------
  // (movedTaskMap already applied to taskById at function entry)

  if ((movedTaskIds || []).length > 0) {
    const affectedParentIds = new Set();
    for (const movedId of movedTaskIds) {
      const task = taskById[movedId];
      if (!task || !task.parentId) continue;
      if (task.parentId === sourceTaskId) continue;
      if (parentMode === 'case-b' && task.parentId === parentTaskId) continue;
      affectedParentIds.add(task.parentId);
    }

    for (const pid of affectedParentIds) {
      const childIds = [];
      for (const [id, task] of Object.entries(taskById)) {
        if (task.parentId === pid) childIds.push(id);
      }
      if (childIds.length === 0) continue;

      let minS = null;
      let maxE = null;
      for (const cid of childIds) {
        const child = taskById[cid];
        if (!child || !child.start || !child.end) continue;
        if (!minS || child.start < minS) minS = child.start;
        if (!maxE || child.end > maxE) maxE = child.end;
      }
      if (!minS || !maxE) continue;

      const parent = taskById[pid];
      const parentName = parent ? parent.name : pid.substring(0, 8);
      const changed = !parent || !parent.start || !parent.end
        || formatDate(minS) !== formatDate(parent.start)
        || formatDate(maxE) !== formatDate(parent.end);

      if (changed && !updates.has(pid)) {
        updates.set(pid, {
          taskId: pid,
          taskName: parentName,
          newStart: formatDate(minS),
          newEnd: formatDate(maxE),
          newReferenceStartDate: formatDate(minS),
          newReferenceEndDate: formatDate(maxE),
          _isRollUp: true,
          _logEntry: `[${ts}] Cascade roll-up: ${formatDate(minS)} to ${formatDate(maxE)}`,
        });
      }
    }
  }

  const updateList = Array.from(updates.values()).map((u) => ({
    ...u,
    _reportingMsg: u._isRollUp
      ? `❇️ Roll-up: dates set to ${u.newStart} — ${u.newEnd}`
      : `❇️ Parent shift: dates moved (triggered by ${sourceTaskName})`,
  }));

  if (updateList.length === 0) {
    return {
      updates: [],
      summary: `No parent/subtask updates needed (${parentMode})`,
      parentMode,
      rollUpCount: 0,
      rolledUpStart: null,
      rolledUpEnd: null,
    };
  }

  const sourceRollUp = updateList.find((u) => u._isRollUp && u.taskId === sourceTaskId);
  const rollUpCount = updateList.filter((u) => u._isRollUp).length;
  return {
    updates: updateList,
    summary: `${updateList.length} task(s) updated (${parentMode})`,
    parentMode,
    rollUpCount,
    rolledUpStart: sourceRollUp?.newStart || null,
    rolledUpEnd: sourceRollUp?.newEnd || null,
  };
}
