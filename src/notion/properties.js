import { parseDate, countBDInclusive } from '../utils/business-days.js';
import { STUDY_TASKS_PROPS } from './property-names.js';

/**
 * Normalize Notion page object into flat task model used by engines.
 *
 * Hot-loop reshape (per plan U2): callers (queryStudyTasks → .map(normalizeTask),
 * batch cascade processing) call this for every task in a study (often N > 50,
 * sometimes 200+). To avoid repeated O(n) `findById` Object.values scans
 * across 12 property reads per task, reshape `notionPage.properties` once
 * into an id-keyed map and read by id from the map (O(1) per access).
 */
export function normalizeTask(notionPage) {
  const id = notionPage.id;
  const props = notionPage.properties || {};
  const byId = Object.create(null);
  for (const value of Object.values(props)) {
    if (value && value.id) byId[value.id] = value;
  }

  const datesProp = byId[STUDY_TASKS_PROPS.DATES.id];
  const titleArr = byId[STUDY_TASKS_PROPS.TASK_NAME.id]?.title || [];

  const startStr = datesProp?.date?.start || null;
  const endStr = datesProp?.date?.end || startStr;
  const start = parseDate(startStr);
  const end = parseDate(endStr);

  return {
    id,
    name: titleArr[0]?.text?.content
      || titleArr[0]?.plain_text
      || id.substring(0, 8),
    start,
    end,
    duration: (start && end) ? countBDInclusive(start, end) : 1,
    status: byId[STUDY_TASKS_PROPS.STATUS.id]?.status?.name || '',
    blockedByIds: (byId[STUDY_TASKS_PROPS.BLOCKED_BY.id]?.relation || []).map((r) => r.id),
    blockingIds: (byId[STUDY_TASKS_PROPS.BLOCKING.id]?.relation || []).map((r) => r.id),
    parentId: (byId[STUDY_TASKS_PROPS.PARENT_TASK.id]?.relation || [])[0]?.id || null,
    studyId: (byId[STUDY_TASKS_PROPS.STUDY.id]?.relation || [])[0]?.id || null,
    refStart: byId[STUDY_TASKS_PROPS.REF_START.id]?.date?.start || startStr,
    refEnd: byId[STUDY_TASKS_PROPS.REF_END.id]?.date?.start || endStr,
    importMode: byId[STUDY_TASKS_PROPS.IMPORT_MODE_ROLLUP.id]?.checkbox === true,
  };
}
