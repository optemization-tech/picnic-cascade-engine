import { normalizeTask } from './properties.js';
import { STUDY_TASKS_PROPS } from './property-names.js';

/**
 * Query all tasks for a study and return normalized task objects.
 *
 * Filter clause uses property `.id` (D2b) — rename-immune.
 */
export async function queryStudyTasks(client, dbId, studyId, { tracer } = {}) {
  const filter = {
    property: STUDY_TASKS_PROPS.STUDY.id,
    relation: { contains: studyId },
  };
  const pages = await client.queryDatabase(dbId, filter, 100, { tracer });
  return pages.map(normalizeTask);
}
