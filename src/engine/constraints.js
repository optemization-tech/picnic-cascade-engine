import {
  parseDate,
  formatDate,
  isBusinessDay,
  nextBusinessDay,
  addBusinessDays,
  countBDInclusive,
} from '../utils/business-days.js';

/**
 * Enforce blocker constraints on the source task and merge case-a roll-up dates.
 * Ported from WF-R Enforce Constraints (pure-function adaptation).
 */
export function enforceConstraints({ task, cascadeResult, parentResult, allTasks }) {
  const movedTaskMap = cascadeResult?.movedTaskMap || {};
  const parentMode = parentResult?.parentMode || null;
  const rolledUpStart = parentResult?.rolledUpStart || null;
  const rolledUpEnd = parentResult?.rolledUpEnd || null;

  let newStart = task.newStart;
  let newEnd = task.newEnd;
  let constrained = false;
  let merged = false;

  const taskById = {};
  for (const row of allTasks || []) {
    const start = row.start instanceof Date ? row.start : parseDate(row.start);
    const endRaw = row.end ?? row.start;
    const end = endRaw instanceof Date ? endRaw : parseDate(endRaw);
    taskById[row.id] = {
      ...row,
      start,
      end,
      blockedByIds: row.blockedByIds || [],
      status: row.status || '',
    };
  }

  const sourceTask = taskById[task.taskId];
  if (sourceTask) {
    const blockerIds = sourceTask.blockedByIds || [];

    if (blockerIds.length > 0) {
      let earliestAllowed = null;
      for (const blockerId of blockerIds) {
        let blockerEnd = null;
        if (movedTaskMap[blockerId]) blockerEnd = parseDate(movedTaskMap[blockerId].newEnd);
        else if (taskById[blockerId]) blockerEnd = taskById[blockerId].end;
        if (!blockerEnd) continue;

        const blockerStatus = taskById[blockerId]?.status || '';
        if (blockerStatus === 'Done' || blockerStatus === 'N/A') continue;

        const candidate = nextBusinessDay(blockerEnd);
        if (!earliestAllowed || candidate > earliestAllowed) earliestAllowed = candidate;
      }

      if (earliestAllowed) {
        const currentStart = parseDate(newStart);
        if (currentStart < earliestAllowed) {
          newStart = formatDate(earliestAllowed);
          const originalDuration = countBDInclusive(parseDate(task.refStart), parseDate(task.refEnd));
          const correctedEnd = addBusinessDays(earliestAllowed, originalDuration - 1);
          newEnd = formatDate(correctedEnd);
          constrained = true;
        }
      }
    }
  }

  // BL-H1d/e: case-a roll-up dates are authoritative.
  if (parentMode === 'case-a' && rolledUpStart && rolledUpEnd) {
    newStart = rolledUpStart;
    newEnd = rolledUpEnd;
    merged = true;
  }

  // Weekend snap safety net.
  const ns = parseDate(newStart);
  const ne = parseDate(newEnd);
  if (ns && !isBusinessDay(ns)) {
    const snapped = nextBusinessDay(ns);
    const duration = countBDInclusive(ns, ne);
    newStart = formatDate(snapped);
    newEnd = formatDate(addBusinessDays(snapped, duration - 1));
  }

  let log = '';
  if (constrained && merged) log = `Constraint enforced + case-a roll-up applied: ${newStart} to ${newEnd}`;
  else if (constrained) log = `Constraint enforced: snapped start to ${newStart} (min valid after blocker)`;
  else if (merged) log = `Case-a roll-up applied: parent normalized to ${newStart} to ${newEnd}`;
  else log = 'No constraint violation, no roll-up - using user dates as-is';

  return {
    taskId: task.taskId,
    newStart,
    newEnd,
    constrained,
    merged,
    _log: log,
  };
}
