import { parseDate, formatDate, addBusinessDays, signedBDDelta } from '../../utils/business-days.js';

/**
 * Compute new subtask dates after parent-level cascade.
 *
 * For each moved parent, computes the relative offset of each subtask
 * from the parent's CURRENT (pre-edit) start date, then applies that
 * offset to the parent's NEW start date.
 *
 *   relativeSoff = signedBDDelta(parent.currentStart, subtask.currentStart)
 *   relativeEoff = signedBDDelta(parent.currentStart, subtask.currentEnd)
 *   subtask.newStart = addBusinessDays(parent.newStart, relativeSoff)
 *   subtask.newEnd   = addBusinessDays(parent.newStart, relativeEoff)
 *
 * No stored offset properties needed — offsets are computed dynamically.
 * Pure function — no Notion API calls.
 *
 * @param {Object} params
 * @param {string[]} params.movedParentIds - IDs of parents whose dates changed
 * @param {Object} params.movedParentMap - { parentId: { newStart, newEnd } }
 * @param {Object[]} params.allTasks - Full task list (parents + subtasks) with current dates
 * @returns {{ updates: Array<{ taskId, taskName, newStart, newEnd }> }}
 */
export function computeSubtaskUpdates({ movedParentIds, movedParentMap, allTasks }) {
  const updates = [];

  // Build task lookup for finding parent's current dates
  const taskById = {};
  for (const t of allTasks) {
    taskById[t.id] = t;
  }

  for (const parentId of movedParentIds) {
    const parentDates = movedParentMap[parentId];
    if (!parentDates?.newStart) continue;

    const parentNewStart = parseDate(parentDates.newStart);
    if (!parentNewStart) continue;

    // Get parent's current (pre-edit) start date from the task graph
    const parent = taskById[parentId];
    const parentCurrentStart = parent?.start instanceof Date
      ? parent.start
      : parseDate(parent?.start);
    if (!parentCurrentStart) continue;

    const subtasks = allTasks.filter((t) => t.parentId === parentId);

    for (const sub of subtasks) {
      const subCurrentStart = sub.start instanceof Date ? sub.start : parseDate(sub.start);
      const subCurrentEnd = sub.end instanceof Date ? sub.end : parseDate(sub.end);
      if (!subCurrentStart || !subCurrentEnd) continue;

      // Compute relative offset from parent's current start to subtask's current dates
      const relativeSoff = signedBDDelta(parentCurrentStart, subCurrentStart);
      const relativeEoff = signedBDDelta(parentCurrentStart, subCurrentEnd);

      // Apply offset to parent's new start
      const newStart = formatDate(addBusinessDays(parentNewStart, relativeSoff));
      const newEnd = formatDate(addBusinessDays(parentNewStart, relativeEoff));

      updates.push({
        taskId: sub.id,
        taskName: sub.name || sub.id,
        newStart,
        newEnd,
      });
    }
  }

  return { updates };
}
