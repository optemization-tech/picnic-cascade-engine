import { normalizeTask } from './properties.js';

/**
 * Query all tasks for a study and return normalized task objects.
 */
export async function queryStudyTasks(client, dbId, studyId) {
  const filter = {
    property: 'Study',
    relation: { contains: studyId },
  };
  const pages = await client.queryDatabase(dbId, filter, 100);
  return pages.map(normalizeTask);
}
