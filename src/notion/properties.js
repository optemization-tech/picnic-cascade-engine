import { parseDate, countBDInclusive } from '../utils/business-days.js';

/**
 * Normalize Notion page object into flat task model used by engines.
 */
export function normalizeTask(notionPage) {
  const id = notionPage.id;
  const p = notionPage.properties || {};

  const startStr = p['Dates']?.date?.start || null;
  const endStr = p['Dates']?.date?.end || startStr;
  const start = parseDate(startStr);
  const end = parseDate(endStr);

  return {
    id,
    name: p['Task Name']?.title?.[0]?.text?.content
      || p['Task Name']?.title?.[0]?.plain_text
      || p['Name']?.title?.[0]?.text?.content
      || p['Name']?.title?.[0]?.plain_text
      || id.substring(0, 8),
    start,
    end,
    duration: (start && end) ? countBDInclusive(start, end) : 1,
    status: p['Status']?.status?.name || '',
    blockedByIds: (p['Blocked by']?.relation || []).map((r) => r.id),
    blockingIds: (p['Blocking']?.relation || []).map((r) => r.id),
    parentId: (p['Parent Task']?.relation || [])[0]?.id || null,
    studyId: (p['Study']?.relation || [])[0]?.id || null,
    refStart: p['Reference Start Date']?.date?.start || startStr,
    refEnd: p['Reference End Date']?.date?.start || endStr,
    importMode: p['Import Mode']?.checkbox === true,
  };
}
