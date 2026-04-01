import {
  parseDate,
  formatDate,
  signedBDDelta,
  countBDInclusive,
  addBusinessDays,
} from '../utils/business-days.js';

/**
 * Parse Notion webhook payload into a normalized task edit object.
 * Mirrors WF-R Fetch & Validate behavior (payload-first extraction).
 */
export function parseWebhookPayload(payload) {
  const body = payload?.body || payload || {};
  const data = body?.data || body;
  const executionId = body?.executionId || body?.details?.executionId || data?.executionId || null;
  const pageId = data?.id || null;
  const props = data?.properties || {};

  if (!pageId) {
    return { skip: true, reason: 'No page ID in webhook payload' };
  }
  if (!props || Object.keys(props).length === 0) {
    return { skip: true, reason: 'No properties in webhook payload' };
  }

  const dates = props['Dates']?.date || null;
  const hasDates = Boolean(dates?.start);
  const newStart = hasDates ? dates.start : null;
  let newEnd = hasDates ? (dates.end || dates.start) : null;

  const refStart = props['Reference Start Date']?.date?.start || newStart;
  const refEnd = props['Reference End Date']?.date?.start || newEnd;

  const taskName = props['Task Name']?.title?.[0]?.text?.content
    || props['Task Name']?.title?.[0]?.plain_text
    || props['Name']?.title?.[0]?.text?.content
    || props['Name']?.title?.[0]?.plain_text
    || pageId.substring(0, 8);

  const studyRel = props['Study']?.relation || [];
  const parentRel = props['Parent Task']?.relation || [];
  const subtaskRel = props['Subtask(s)']?.relation || [];

  const status = props['Status']?.status?.name || '';
  const lastModifiedBySystem = props['Last Modified By System']?.checkbox === true;

  // Import Mode can arrive as rollup boolean/array or direct checkbox.
  const importModeRollup = props['Import Mode']?.rollup;
  const importModeFromRollup = importModeRollup?.type === 'array'
    ? importModeRollup.array?.[0]?.checkbox === true
    : importModeRollup?.boolean === true;
  const importMode = importModeFromRollup || props['Import Mode']?.checkbox === true;

  let startDelta = 0;
  let endDelta = 0;

  if (hasDates && refStart && refEnd) {
    startDelta = signedBDDelta(parseDate(refStart), parseDate(newStart));
    endDelta = signedBDDelta(parseDate(refEnd), parseDate(newEnd));

    // Drag normalization from WF-R.
    if (startDelta !== 0 && endDelta !== 0 && Math.sign(startDelta) === Math.sign(endDelta)) {
      const originalDuration = countBDInclusive(parseDate(refStart), parseDate(refEnd));
      const correctedEnd = addBusinessDays(parseDate(newStart), originalDuration - 1);
      newEnd = formatDate(correctedEnd);
      endDelta = signedBDDelta(parseDate(refEnd), parseDate(newEnd));
    }
  }

  return {
    skip: false,
    reason: null,
    taskId: pageId,
    taskName,
    hasDates,
    newStart,
    newEnd,
    refStart,
    refEnd,
    startDelta,
    endDelta,
    status,
    lastModifiedBySystem,
    importMode,
    studyId: studyRel[0]?.id || null,
    parentTaskId: parentRel[0]?.id || null,
    hasParent: parentRel.length > 0,
    hasSubtasks: subtaskRel.length > 0,
    triggeredByUserId: data?.last_edited_by?.id || null,
    executionId,
    rawProperties: props,
  };
}

export function isSystemModified(task) {
  return task.lastModifiedBySystem === true;
}

export function isImportMode(task) {
  return task.importMode === true;
}

export function isFrozen(task) {
  return ['Done', 'N/A'].includes(task.status);
}
