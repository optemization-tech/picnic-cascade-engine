import { config } from '../config.js';
import { NotionClient } from '../notion/client.js';
import { ActivityLogService } from '../services/activity-log.js';
import { CascadeTracer } from '../services/cascade-tracer.js';
import { fetchBlueprint, buildTaskTree } from '../provisioning/blueprint.js';
import { createStudyTasks } from '../provisioning/create-tasks.js';
import { wireRemainingRelations } from '../provisioning/wire-relations.js';

const tokens = config.notion.provisionTokens.length > 0
  ? config.notion.provisionTokens
  : config.notion.tokens;
const notionClient = new NotionClient({ tokens });
const activityLogService = new ActivityLogService({
  notionClient,
  activityLogDbId: config.notion.activityLogDbId,
});

async function processInception(body) {
  const studyPageId = body?.data?.id || body?.studyPageId;
  if (!studyPageId) {
    console.warn('[inception] no studyPageId in payload, skipping');
    return;
  }

  const tracer = new CascadeTracer();
  tracer.set('workflow', 'Inception');
  tracer.set('study_id', studyPageId);

  let studyPage;

  try {
    // Enable Import Mode — blocks date-cascade from firing during bulk creation
    tracer.startPhase('enableImportMode');
    await notionClient.request('PATCH', `/pages/${studyPageId}`, {
      properties: { 'Import Mode': { checkbox: true } },
    }, { tracer });
    tracer.endPhase('enableImportMode');

    // Report kicked off
    await notionClient.reportStatus(studyPageId, 'info', 'Inception started...', { tracer });

    // Fetch study details to get Contract Sign Date
    tracer.startPhase('fetchStudy');
    studyPage = await notionClient.getPage(studyPageId);
    tracer.endPhase('fetchStudy');

    const contractSignDate = studyPage.properties?.['Contract Sign Date']?.date?.start
      || new Date().toISOString().split('T')[0];

    // Guard against double-inception: check for existing tasks
    tracer.startPhase('doubleInceptionCheck');
    const existingTasks = await notionClient.queryDatabase(
      config.notion.studyTasksDbId,
      { property: 'Study', relation: { contains: studyPageId } },
      1,
      { tracer },
    );
    tracer.endPhase('doubleInceptionCheck');

    if (existingTasks.length > 0) {
      await notionClient.reportStatus(studyPageId, 'error', 'Study already has tasks — aborting inception', { tracer });
      await activityLogService.logTerminalEvent({
        workflow: 'Inception',
        status: 'failed',
        triggerType: 'Automation',
        studyId: studyPageId,
        summary: 'Study already has tasks — double-inception blocked',
      });
      return;
    }

    // Fetch blueprint
    tracer.startPhase('fetchBlueprint');
    const blueprintTasks = await fetchBlueprint(notionClient, config.notion.blueprintDbId, { tracer });
    tracer.endPhase('fetchBlueprint');

    if (!blueprintTasks || blueprintTasks.length === 0) {
      await notionClient.reportStatus(studyPageId, 'error', 'No blueprint tasks found', { tracer });
      await activityLogService.logTerminalEvent({
        workflow: 'Inception',
        status: 'failed',
        triggerType: 'Automation',
        studyId: studyPageId,
        summary: 'No blueprint tasks found',
      });
      return;
    }

    // Build task tree (BFS + topo sort)
    const levels = buildTaskTree(blueprintTasks);

    // Create tasks level by level
    const createResult = await createStudyTasks(notionClient, levels, {
      studyPageId,
      contractSignDate,
      blueprintDbId: config.notion.blueprintDbId,
      studyTasksDbId: config.notion.studyTasksDbId,
      tracer,
    });

    // Report progress
    await notionClient.reportStatus(
      studyPageId,
      'info',
      `Tasks created: ${createResult.totalCreated}. Wiring relations...`,
      { tracer },
    );

    // Wire remaining relations (cross-level parents + deps that couldn't resolve inline)
    const wireResult = await wireRemainingRelations(notionClient, {
      idMapping: createResult.idMapping,
      depTracking: createResult.depTracking,
      parentTracking: createResult.parentTracking,
      tracer,
    });

    // Disable Import Mode before copy-blocks
    tracer.startPhase('disableImportMode');
    await notionClient.request('PATCH', `/pages/${studyPageId}`, {
      properties: { 'Import Mode': { checkbox: false } },
    }, { tracer });
    tracer.endPhase('disableImportMode');

    // Fire copy-blocks (self-POST, fire-and-forget)
    const studyName = studyPage.properties?.['Study Name (Internal)']?.title?.[0]?.text?.content || 'Unknown Study';
    const selfUrl = `http://localhost:${config.port}/webhook/copy-blocks`;
    fetch(selfUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        idMapping: createResult.idMapping,
        studyPageId,
        studyName,
      }),
    }).catch(err => console.warn('[inception] copy-blocks fire-and-forget failed:', err.message));

    // Log to activity log
    await activityLogService.logTerminalEvent({
      workflow: 'Inception',
      status: 'success',
      triggerType: 'Automation',
      executionId: tracer.cascadeId,
      timestamp: new Date().toISOString(),
      cascadeMode: 'N/A',
      studyId: studyPageId,
      summary: `Inception complete: ${createResult.totalCreated} tasks created, ${wireResult.parentsPatchedCount} parents wired, ${wireResult.depsPatchedCount} deps wired`,
      details: {
        totalCreated: createResult.totalCreated,
        parentsPatchedCount: wireResult.parentsPatchedCount,
        depsPatchedCount: wireResult.depsPatchedCount,
        ...(tracer.toActivityLogDetails()),
      },
    });

    // Report success
    await notionClient.reportStatus(
      studyPageId,
      'success',
      `Inception complete: ${createResult.totalCreated} tasks created, ${wireResult.parentsPatchedCount} parents wired, ${wireResult.depsPatchedCount} deps wired`,
      { tracer },
    );

    console.log(tracer.toConsoleLog());
  } catch (error) {
    console.error('[inception] processing failed:', error);
    console.log(tracer.toConsoleLog());

    try {
      await notionClient.reportStatus(
        studyPageId,
        'error',
        `Inception failed: ${String(error.message || error).slice(0, 200)}`,
        { tracer },
      );
    } catch { /* don't mask original error */ }

    try {
      await activityLogService.logTerminalEvent({
        workflow: 'Inception',
        status: 'failed',
        triggerType: 'Automation',
        studyId: studyPageId,
        summary: `Inception failed: ${String(error.message || error).slice(0, 180)}`,
      });
    } catch { /* don't mask original error */ }

    throw error;
  } finally {
    // Critical: always disable Import Mode — leaving it on blocks all cascades
    try {
      await notionClient.request('PATCH', `/pages/${studyPageId}`, {
        properties: { 'Import Mode': { checkbox: false } },
      }, { tracer });
    } catch (cleanupError) {
      console.warn('[inception] failed to disable Import Mode in finally:', cleanupError.message);
    }
  }
}

export async function handleInception(req, res) {
  res.status(200).json({ ok: true });
  void processInception(req.body).catch(err => console.error('[inception] unhandled:', err));
}
