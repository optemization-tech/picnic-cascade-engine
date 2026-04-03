import { config } from '../config.js';
import { NotionClient } from '../notion/client.js';
import { nukeStudyTasks } from '../provisioning/nuke.js';
import { ActivityLogService } from '../services/activity-log.js';
import { CascadeTracer } from '../services/cascade-tracer.js';

const tokens = config.notion.nukeTokens.length > 0
  ? config.notion.nukeTokens
  : config.notion.tokens;

const notionClient = new NotionClient({ tokens });
const activityLogService = new ActivityLogService({
  notionClient,
  activityLogDbId: config.notion.activityLogDbId,
});

async function processNuke(body) {
  const studyId = body.studyId || body.data?.id;
  if (!studyId) {
    console.error('[nuke] missing studyId in payload');
    return;
  }

  const tracer = new CascadeTracer();
  tracer.set('study_id', studyId);
  tracer.set('workflow', 'nuke');

  try {
    await notionClient.reportStatus(studyId, 'info', 'Nuke started — archiving all study tasks...', { tracer });

    const result = await nukeStudyTasks(notionClient, {
      studyTasksDbId: config.notion.studyTasksDbId,
      studyId,
      tracer,
    });

    tracer.set('archived_count', result.archivedCount);
    console.log(tracer.toConsoleLog());

    await activityLogService.logTerminalEvent({
      workflow: 'Nuke',
      status: 'success',
      triggerType: 'Manual',
      executionId: tracer.cascadeId,
      timestamp: new Date().toISOString(),
      cascadeMode: 'N/A',
      studyId,
      summary: `Nuke complete: archived ${result.archivedCount} task(s)`,
      details: {
        archivedCount: result.archivedCount,
        ...(tracer.toActivityLogDetails()),
      },
    });

    await notionClient.reportStatus(
      studyId,
      'success',
      `Nuke complete: archived ${result.archivedCount} task(s)`,
      { tracer },
    );
  } catch (error) {
    console.error('[nuke] processing failed:', error);
    console.log(tracer.toConsoleLog());

    try {
      await notionClient.reportStatus(
        studyId,
        'error',
        `Nuke failed: ${String(error.message || error).slice(0, 200)}`,
        { tracer },
      );
    } catch { /* don't mask original error */ }

    try {
      await activityLogService.logTerminalEvent({
        workflow: 'Nuke',
        status: 'failed',
        triggerType: 'Manual',
        executionId: tracer.cascadeId,
        timestamp: new Date().toISOString(),
        cascadeMode: 'N/A',
        studyId,
        summary: `Nuke failed: ${String(error.message || error).slice(0, 180)}`,
        details: {
          error: {
            errorCode: error.code || null,
            errorMessage: String(error.message || error).slice(0, 400),
            phase: 'nuke',
          },
          ...(tracer.toActivityLogDetails()),
        },
      });
    } catch { /* don't mask original error */ }
  }
}

export async function handleNuke(req, res) {
  res.status(200).json({ ok: true });
  void processNuke(req.body).catch((error) => {
    console.error('[nuke] unhandled processing error:', error);
  });
}
