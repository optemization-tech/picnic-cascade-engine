/**
 * V2 Inception — creates a study from Blueprint V2 (parent-level deps only).
 *
 * Forked from V1 inception with these changes:
 *   - Uses V2 createStudyTasks (writes Relative SDate/EDate Offset on subtasks)
 *   - Uses V2 Blueprint DB ID (config.notion.blueprintV2DbId)
 *   - Activity log workflow: 'V2 Inception'
 *
 * Everything else is identical: Import Mode lifecycle, double-inception guard,
 * copy-blocks firing, error handling, finally block.
 */

import { config } from '../../config.js';
import { NotionClient } from '../../notion/client.js';
import { ActivityLogService } from '../../services/activity-log.js';
import { CascadeTracer } from '../../services/cascade-tracer.js';
import { fetchBlueprint, buildTaskTree } from '../../provisioning/blueprint.js';
import { createStudyTasks } from '../provisioning/create-tasks.js';
import { wireRemainingRelations } from '../../provisioning/wire-relations.js';

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
    console.warn('[v2-inception] no studyPageId in payload, skipping');
    return;
  }

  const tracer = new CascadeTracer();
  tracer.set('workflow', 'V2 Inception');
  tracer.set('study_id', studyPageId);
  tracer.set('engine_version', 'v2');

  let studyPage;

  try {
    // Enable Import Mode
    tracer.startPhase('enableImportMode');
    await notionClient.request('PATCH', `/pages/${studyPageId}`, {
      properties: { 'Import Mode': { checkbox: true } },
    }, { tracer });
    tracer.endPhase('enableImportMode');

    await notionClient.reportStatus(studyPageId, 'info', 'V2 Inception started...', { tracer });

    // Fetch study details
    tracer.startPhase('fetchStudy');
    studyPage = await notionClient.getPage(studyPageId);
    tracer.endPhase('fetchStudy');

    const contractSignDate = studyPage.properties?.['Contract Sign Date']?.date?.start
      || new Date().toISOString().split('T')[0];

    // Double-inception guard
    tracer.startPhase('doubleInceptionCheck');
    const existingTasks = await notionClient.queryDatabase(
      config.notion.studyTasksDbId,
      { property: 'Study', relation: { contains: studyPageId } },
      1,
      { tracer },
    );
    tracer.endPhase('doubleInceptionCheck');

    if (existingTasks.length > 0) {
      await notionClient.reportStatus(studyPageId, 'error', 'Study already has tasks — aborting V2 inception', { tracer });
      await activityLogService.logTerminalEvent({
        workflow: 'V2 Inception',
        status: 'failed',
        triggerType: 'Automation',
        studyId: studyPageId,
        summary: 'Study already has tasks — double-inception blocked',
      });
      return;
    }

    // Fetch V2 Blueprint
    const blueprintDbId = config.notion.blueprintV2DbId || config.notion.blueprintDbId;
    tracer.startPhase('fetchBlueprint');
    const blueprintTasks = await fetchBlueprint(notionClient, blueprintDbId, { tracer });
    tracer.endPhase('fetchBlueprint');

    if (!blueprintTasks || blueprintTasks.length === 0) {
      await notionClient.reportStatus(studyPageId, 'error', 'No V2 blueprint tasks found', { tracer });
      await activityLogService.logTerminalEvent({
        workflow: 'V2 Inception',
        status: 'failed',
        triggerType: 'Automation',
        studyId: studyPageId,
        summary: 'No V2 blueprint tasks found',
      });
      return;
    }

    // Build task tree (BFS + topo sort — shared with V1)
    const levels = buildTaskTree(blueprintTasks);

    // Create tasks level by level (V2 — writes relative offsets on subtasks)
    const createResult = await createStudyTasks(notionClient, levels, {
      studyPageId,
      contractSignDate,
      studyTasksDbId: config.notion.studyTasksDbId,
      tracer,
    });

    await notionClient.reportStatus(
      studyPageId,
      'info',
      `V2 Tasks created: ${createResult.totalCreated}. Wiring relations...`,
      { tracer },
    );

    // Wire remaining relations (shared with V1 — handles parent + dep patches)
    const wireResult = await wireRemainingRelations(notionClient, {
      idMapping: createResult.idMapping,
      depTracking: createResult.depTracking,
      parentTracking: createResult.parentTracking,
      tracer,
    });

    // Disable Import Mode
    tracer.startPhase('disableImportMode');
    await notionClient.request('PATCH', `/pages/${studyPageId}`, {
      properties: { 'Import Mode': { checkbox: false } },
    }, { tracer });
    tracer.endPhase('disableImportMode');

    // Fire copy-blocks (same as V1 — fire-and-forget)
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
    }).catch(err => console.warn('[v2-inception] copy-blocks fire-and-forget failed:', err.message));

    // Activity log
    await activityLogService.logTerminalEvent({
      workflow: 'V2 Inception',
      status: 'success',
      triggerType: 'Automation',
      executionId: tracer.cascadeId,
      timestamp: new Date().toISOString(),
      cascadeMode: 'N/A',
      studyId: studyPageId,
      summary: `V2 Inception complete: ${createResult.totalCreated} tasks created, ${wireResult.parentsPatchedCount} parents wired, ${wireResult.depsPatchedCount} deps wired`,
      details: {
        totalCreated: createResult.totalCreated,
        parentsPatchedCount: wireResult.parentsPatchedCount,
        depsPatchedCount: wireResult.depsPatchedCount,
        ...(tracer.toActivityLogDetails()),
      },
    });

    await notionClient.reportStatus(
      studyPageId,
      'success',
      `V2 Inception complete: ${createResult.totalCreated} tasks created, ${wireResult.parentsPatchedCount} parents wired, ${wireResult.depsPatchedCount} deps wired`,
      { tracer },
    );

    console.log(tracer.toConsoleLog());
  } catch (error) {
    console.error('[v2-inception] processing failed:', error);
    console.log(tracer.toConsoleLog());

    try {
      await notionClient.reportStatus(
        studyPageId,
        'error',
        `V2 Inception failed: ${String(error.message || error).slice(0, 200)}`,
        { tracer },
      );
    } catch { /* don't mask original error */ }

    try {
      await activityLogService.logTerminalEvent({
        workflow: 'V2 Inception',
        status: 'failed',
        triggerType: 'Automation',
        studyId: studyPageId,
        summary: `V2 Inception failed: ${String(error.message || error).slice(0, 180)}`,
      });
    } catch { /* don't mask original error */ }

    throw error;
  } finally {
    try {
      await notionClient.request('PATCH', `/pages/${studyPageId}`, {
        properties: { 'Import Mode': { checkbox: false } },
      }, { tracer });
    } catch (cleanupError) {
      console.warn('[v2-inception] failed to disable Import Mode in finally:', cleanupError.message);
    }
    try {
      await notionClient.clearStudyLmbsFlags({
        studyTasksDbId: config.notion.studyTasksDbId,
        studyId: studyPageId,
        tracer,
      });
    } catch (cleanupError) {
      console.warn('[v2-inception] study-wide LMBS cleanup failed:', cleanupError.message);
    }
  }
}

export async function handleInception(req, res) {
  res.status(200).json({ ok: true });
  void processInception(req.body).catch(err => console.error('[v2-inception] unhandled:', err));
}
