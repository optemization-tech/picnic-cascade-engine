import {
  parseDate,
  formatDate,
  signedBDDelta,
  countBDInclusive,
  addBusinessDays,
} from '../utils/business-days.js';
import { STUDY_TASKS_PROPS, findById } from '../notion/property-names.js';

/**
 * Parse Notion webhook payload into a normalized task edit object.
 * Mirrors WF-R Fetch & Validate behavior (payload-first extraction).
 *
 * Webhook `properties` arrives in the same shape as a page response —
 * name-keyed at the top level, with each value carrying an `.id` field
 * that is rename-stable. We pick by id (D2b read pattern) so the parser
 * survives Notion property renames.
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

  // Fake "page" wrapper so findById's `page.properties` access shape works.
  const page = { properties: props };

  const dates = findById(page, STUDY_TASKS_PROPS.DATES)?.date || null;
  const hasDates = Boolean(dates?.start);
  const newStart = hasDates ? dates.start : null;
  let newEnd = hasDates ? (dates.end || dates.start) : null;

  const refStart = findById(page, STUDY_TASKS_PROPS.REF_START)?.date?.start || newStart;
  const refEnd = findById(page, STUDY_TASKS_PROPS.REF_END)?.date?.start || newEnd;

  const titleArr = findById(page, STUDY_TASKS_PROPS.TASK_NAME)?.title || [];
  const taskName = titleArr[0]?.text?.content
    || titleArr[0]?.plain_text
    || pageId.substring(0, 8);

  const studyRel = findById(page, STUDY_TASKS_PROPS.STUDY)?.relation || [];
  const parentRel = findById(page, STUDY_TASKS_PROPS.PARENT_TASK)?.relation || [];
  const subtaskRel = findById(page, STUDY_TASKS_PROPS.SUBTASKS)?.relation || [];

  const status = findById(page, STUDY_TASKS_PROPS.STATUS)?.status?.name || '';
  // Import Mode can arrive as rollup boolean/array or direct checkbox.
  const importModeProp = findById(page, STUDY_TASKS_PROPS.IMPORT_MODE_ROLLUP);
  const importModeRollup = importModeProp?.rollup;
  const importModeFromRollup = importModeRollup?.type === 'array'
    ? importModeRollup.array?.[0]?.checkbox === true
    : importModeRollup?.boolean === true;
  const importMode = importModeFromRollup || importModeProp?.checkbox === true;

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
    importMode,
    studyId: studyRel[0]?.id || null,
    parentTaskId: parentRel[0]?.id || null,
    hasParent: parentRel.length > 0,
    hasSubtasks: subtaskRel.length > 0,
    triggeredByUserId: data?.last_edited_by?.id || null,
    editedByBot: data?.last_edited_by?.type === 'bot',
    executionId,
    rawProperties: props,
  };
}

export function isImportMode(task) {
  return task.importMode === true;
}

export function isFrozen(task) {
  return ['Done', 'N/A'].includes(task.status);
}
