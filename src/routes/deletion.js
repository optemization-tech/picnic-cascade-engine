import { config } from '../config.js';
import { deletionClient as notionClient } from '../notion/clients.js';
import { deleteStudyTasks } from '../provisioning/deletion.js';
import { ActivityLogService } from '../services/activity-log.js';
import { CascadeTracer } from '../services/cascade-tracer.js';
const activityLogService = new ActivityLogService({
  notionClient,
  activityLogDbId: config.notion.activityLogDbId,
});

async function processDeletion(body) {
  const studyId = body.studyId || body.data?.id;
  if (!studyId) {
    console.error('[deletion] missing studyId in payload');
    return;
  }

  const tracer = new CascadeTracer();
  tracer.set('study_id', studyId);
  tracer.set('workflow', 'deletion');

  try {
    await notionClient.reportStatus(studyId, 'info', 'Deletion started — archiving all study tasks...', { tracer });

    const result = await deleteStudyTasks(notionClient, {
      studyTasksDbId: config.notion.studyTasksDbId,
      studyId,
      tracer,
    });

    tracer.set('archived_count', result.archivedCount);
    console.log(tracer.toConsoleLog());

    await Promise.all([
      activityLogService.logTerminalEvent({
        workflow: 'Deletion',
        status: 'success',
        triggerType: 'Manual',
        executionId: tracer.cascadeId,
        timestamp: new Date().toISOString(),
        cascadeMode: 'N/A',
        studyId,
        summary: `Deletion complete: archived ${result.archivedCount} task(s)`,
        details: {
          archivedCount: result.archivedCount,
          ...(tracer.toActivityLogDetails()),
        },
      }),
      notionClient.reportStatus(
        studyId,
        'success',
        `Deletion complete: archived ${result.archivedCount} task(s)`,
        { tracer },
      ),
    ]);
  } catch (error) {
    console.error('[deletion] processing failed:', error);
    console.log(tracer.toConsoleLog());

    try {
      await Promise.all([
        notionClient.reportStatus(
          studyId,
          'error',
          `Deletion failed: ${String(error.message || error).slice(0, 200)}`,
          { tracer },
        ),
        activityLogService.logTerminalEvent({
          workflow: 'Deletion',
          status: 'failed',
          triggerType: 'Manual',
          executionId: tracer.cascadeId,
          timestamp: new Date().toISOString(),
          cascadeMode: 'N/A',
          studyId,
          summary: `Deletion failed: ${String(error.message || error).slice(0, 180)}`,
          details: {
            error: {
              errorCode: error.code || null,
              errorMessage: String(error.message || error).slice(0, 400),
              phase: 'deletion',
            },
            ...(tracer.toActivityLogDetails()),
          },
        }),
      ]);
    } catch { /* don't mask original error */ }
  }
}

export async function handleDeletion(req, res) {
  res.status(200).json({ ok: true });
  void processDeletion(req.body).catch((error) => {
    console.error('[deletion] unhandled processing error:', error);
  });
}
