/**
 * Deletion module — archives all study tasks for a given study.
 *
 * Uses raw PATCH /pages/{id} with { archived: true } since the standard
 * patchBatch() sends { properties: ... } which doesn't support archiving.
 */

export async function deleteStudyTasks(client, { studyTasksDbId, studyId, tracer }) {
  const filter = { property: 'Study', relation: { contains: studyId } };

  if (tracer) tracer.startPhase('query');
  const tasks = await client.queryDatabase(studyTasksDbId, filter, 100, { tracer });
  if (tracer) tracer.endPhase('query');

  if (tasks.length === 0) {
    return { archivedCount: 0 };
  }

  if (tracer) tracer.startPhase('archive');
  const archiveOps = tasks.map((t) =>
    client.request('PATCH', `/pages/${t.id}`, { archived: true }, { tracer }),
  );
  await Promise.all(archiveOps);
  if (tracer) tracer.endPhase('archive');

  return { archivedCount: tasks.length };
}
