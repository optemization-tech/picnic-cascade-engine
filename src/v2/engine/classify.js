import {
  parseDate,
  formatDate,
  signedBDDelta,
  countBDInclusive,
  addBusinessDays,
} from '../../utils/business-days.js';

function computeCascadeMode(startDelta, endDelta) {
  if (startDelta === 0 && endDelta > 0) return 'push-right';
  if (startDelta === 0 && endDelta < 0) return 'pull-left';
  if (startDelta < 0 && endDelta === 0) return 'pull-left';
  if (startDelta > 0 && endDelta === 0) return 'pull-right';
  if (startDelta > 0 && endDelta > 0) return 'drag-right';
  if (startDelta < 0 && endDelta < 0) return 'pull-left';
  return null;
}

/**
 * V2 Classify — parent-level-only mode classification.
 *
 * Changes from V1:
 * - No Error 1 parent guard (parents ARE the cascade targets)
 * - No parentMode/parentTaskId (no case-a/case-b logic)
 * - Same cascade mode matrix and stale-ref correction
 */
export function classify(task, allTasks = [], startDeltaInput, endDeltaInput) {
  const sourceTaskId = task.taskId || task.id;
  const sourceTaskName = task.taskName || task.name || sourceTaskId;
  const newStart = task.newStart;
  let newEnd = task.newEnd;
  let refStart = task.refStart;
  let refEnd = task.refEnd;

  let startDelta = startDeltaInput;
  let endDelta = endDeltaInput;
  let cascadeMode = computeCascadeMode(startDelta, endDelta);

  // Stale reference correction: if DB refs differ from webhook refs, recompute deltas/mode.
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
    staleRefCorrected,
  };
}
