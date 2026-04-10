import {
  parseDate,
  formatDate,
  signedBDDelta,
  countBDInclusive,
  addBusinessDays,
} from '../utils/business-days.js';

function computeCascadeMode(startDelta, endDelta) {
  if (startDelta === 0 && endDelta > 0) return 'push-right';
  if (startDelta === 0 && endDelta < 0) return 'pull-left';
  if (startDelta < 0 && endDelta === 0) return 'start-left';
  if (startDelta > 0 && endDelta === 0) return 'pull-right';
  if (startDelta > 0 && endDelta > 0) return 'drag-right';
  if (startDelta < 0 && endDelta < 0) return 'drag-left';
  return null;
}

/**
 * Classify date edit into cascade/parent modes.
 * Pure-function port of WF-R "Classify & Build Dispatch" (minus Notion side effects).
 *
 * @param {Object} task
 * @param {Array} allTasks
 * @param {number} startDeltaInput
 * @param {number} endDeltaInput
 * @returns {{
 *   skip: boolean,
 *   reason: string|null,
 *   sourceTaskId: string,
 *   sourceTaskName: string,
 *   newStart: string,
 *   newEnd: string,
 *   refStart: string,
 *   refEnd: string,
 *   startDelta: number,
 *   endDelta: number,
 *   cascadeMode: string|null,
 *   parentTaskId: string|null,
 *   parentMode: string|null,
 *   staleRefCorrected: boolean
 * }}
 */
export function classify(task, allTasks = [], startDeltaInput, endDeltaInput) {
  const sourceTaskId = task.taskId || task.id;
  const sourceTaskName = task.taskName || task.name || sourceTaskId;
  const newStart = task.newStart;
  let newEnd = task.newEnd;
  let refStart = task.refStart;
  let refEnd = task.refEnd;
  const hasParent = task.hasParent ?? Boolean(task.parentTaskId || task.parentId);
  const parentTaskId = task.parentTaskId || task.parentId || null;

  let startDelta = startDeltaInput;
  let endDelta = endDeltaInput;
  let cascadeMode = computeCascadeMode(startDelta, endDelta);

  const hasSubtasksFromGraph = allTasks.some((row) => row?.parentId === sourceTaskId);

  let parentMode = null;
  if (hasSubtasksFromGraph) parentMode = 'case-a';
  else if (hasParent) parentMode = 'case-b';

  // Error 1 guard: top-level parent tasks cannot be date-edited directly.
  // The route will revert the edited parent back to its reference dates.
  if (hasSubtasksFromGraph && !hasParent && (startDelta !== 0 || endDelta !== 0)) {
    return {
      skip: true,
      reason: 'Direct parent edit blocked - edit subtasks directly',
      sourceTaskId,
      sourceTaskName,
      newStart,
      newEnd,
      refStart,
      refEnd,
      startDelta,
      endDelta,
      cascadeMode: null,
      parentTaskId,
      parentMode: null,
      staleRefCorrected: false,
    };
  }

  // Stale reference correction: if DB refs differ from webhook refs, recompute deltas/mode.
  // Preserve which dates the user actually changed (webhook deltas) so stale refs
  // don't turn a start-only edit into a drag.
  let staleRefCorrected = false;
  const dbSourceTask = allTasks.find((row) => (row.id || row.taskId) === sourceTaskId);

  let dbRefStart = null;
  let dbRefEnd = null;
  if (dbSourceTask) {
    dbRefStart = dbSourceTask.refStart || null;
    dbRefEnd = dbSourceTask.refEnd || null;
  }

  if (dbRefStart && dbRefEnd && (dbRefStart !== refStart || dbRefEnd !== refEnd)) {
    const webhookStartDelta = startDelta;
    const webhookEndDelta = endDelta;
    refStart = dbRefStart;
    refEnd = dbRefEnd;

    // Only recalculate deltas for dates the user actually changed.
    // Without this guard, stale refs can make a zero delta non-zero,
    // turning a start-only or end-only edit into a drag.
    startDelta = webhookStartDelta !== 0
      ? signedBDDelta(parseDate(dbRefStart), parseDate(newStart))
      : 0;
    endDelta = webhookEndDelta !== 0
      ? signedBDDelta(parseDate(dbRefEnd), parseDate(newEnd))
      : 0;

    // Drag normalization after stale-ref correction.
    if (startDelta !== 0 && endDelta !== 0 && Math.sign(startDelta) === Math.sign(endDelta)) {
      const originalDuration = countBDInclusive(parseDate(dbRefStart), parseDate(dbRefEnd));
      const correctedEnd = addBusinessDays(parseDate(newStart), originalDuration - 1);
      newEnd = formatDate(correctedEnd);
      endDelta = signedBDDelta(parseDate(dbRefEnd), parseDate(newEnd));
    }

    cascadeMode = computeCascadeMode(startDelta, endDelta);
    staleRefCorrected = true;
  }

  return {
    skip: false,
    reason: null,
    sourceTaskId,
    sourceTaskName,
    newStart,
    newEnd,
    refStart,
    refEnd,
    startDelta,
    endDelta,
    cascadeMode,
    parentTaskId,
    parentMode,
    staleRefCorrected,
  };
}
