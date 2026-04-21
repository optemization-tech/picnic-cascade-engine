/**
 * Deletion module — archives all study tasks for a given study.
 *
 * Uses raw PATCH /pages/{id} with { archived: true } since the standard
 * patchPages() sends { properties: ... } which doesn't support archiving.
 *
 * Strategy: query-archive-repeat without cursor pagination. Archived tasks
 * disappear from query results, so we always fetch page 1 and repeat until
 * empty. This avoids cursor invalidation errors that occur when the database
 * changes between paginated requests.
 */

export async function deleteStudyTasks(client, { studyTasksDbId, studyId, tracer }) {
  const filter = { property: 'Study', relation: { contains: studyId } };
  let totalArchived = 0;

  while (true) {
    if (tracer) tracer.startPhase('query');
    const data = await client.request('POST', `/databases/${studyTasksDbId}/query`, {
      filter,
      page_size: 100,
    }, { tracer });
    if (tracer) tracer.endPhase('query');

    const tasks = data.results || [];
    if (tasks.length === 0) break;

    if (tracer) tracer.startPhase('archive');
    const archiveResults = await client.requestBatch(tasks.map((task) => ({
      method: 'PATCH',
      path: `/pages/${task.id}`,
      body: { archived: true },
    })), { tracer });
    if (tracer) tracer.endPhase('archive');

    // Archive is idempotent — any error in the batch indicates a persistent
    // failure (retries exhausted). Fail loudly so the caller sees it,
    // matching today's pre-narrow-retry behavior.
    const firstError = archiveResults.find((r) => r instanceof Error);
    if (firstError) throw firstError;

    // Count only slots that actually completed. Partial completion is
    // theoretically possible if the batch aborted mid-flight (it shouldn't
    // for idempotent paths, but count defensively).
    totalArchived += archiveResults.filter((r) => r !== undefined && !(r instanceof Error)).length;
    if (!data.has_more) break;
  }

  return { archivedCount: totalArchived };
}
