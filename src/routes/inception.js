import { config } from '../config.js';
import { provisionClient as notionClient, commentClient } from '../notion/clients.js';
import { ActivityLogService } from '../services/activity-log.js';
import { StudyCommentService } from '../services/study-comment.js';
import { CascadeTracer } from '../services/cascade-tracer.js';
import { fetchBlueprint, buildTaskTree } from '../provisioning/blueprint.js';
import { createStudyTasks } from '../provisioning/create-tasks.js';
import { wireRemainingRelations } from '../provisioning/wire-relations.js';
import { copyBlocks, prefetchTemplateBlocks } from '../provisioning/copy-blocks.js';
import { flightTracker } from '../services/flight-tracker.js';
const activityLogService = new ActivityLogService({
  notionClient: commentClient,
  activityLogDbId: config.notion.activityLogDbId,
});
const studyCommentService = new StudyCommentService({ notionClient: commentClient });

async function processInception(body) {
  const studyPageId = body?.data?.id || body?.studyPageId;
  if (!studyPageId) {
    console.warn('[inception] no studyPageId in payload, skipping');
    return;
  }

  // source.user_id is the actual button clicker; data.last_edited_by is whoever last edited the page.
  const triggeredByUserId = body?.source?.user_id || body?.data?.last_edited_by?.id || null;
  const editedByBot = !body?.source?.user_id && body?.data?.last_edited_by?.type === 'bot';

  const tracer = new CascadeTracer();
  tracer.set('workflow', 'Inception');
  tracer.set('study_id', studyPageId);

  let studyPage;
  let studyName;

  try {
    // Enable Import Mode — blocks date-cascade from firing during bulk creation
    tracer.startPhase('enableImportMode');
    await notionClient.request('PATCH', `/pages/${studyPageId}`, {
      properties: { 'Import Mode': { checkbox: true } },
    }, { tracer });
    tracer.endPhase('enableImportMode');

    const fetchStudyPromise = (async () => {
      tracer.startPhase('fetchStudy');
      try {
        return await notionClient.getPage(studyPageId);
      } finally {
        tracer.endPhase('fetchStudy');
      }
    })();

    const existingTasksPromise = (async () => {
      tracer.startPhase('doubleInceptionCheck');
      try {
        return await notionClient.queryDatabase(
          config.notion.studyTasksDbId,
          { property: 'Study', relation: { contains: studyPageId } },
          1,
          { tracer },
        );
      } finally {
        tracer.endPhase('doubleInceptionCheck');
      }
    })();

    const [, fetchedStudyPage, existingTasks] = await Promise.all([
      notionClient.reportStatus(studyPageId, 'info', 'Inception started...', { tracer }),
      fetchStudyPromise,
      existingTasksPromise,
    ]);
    studyPage = fetchedStudyPage;

    studyName = studyPage.properties?.['Study Name (Internal)']?.title?.[0]?.text?.content || 'Unknown Study';
    const contractSignDate = studyPage.properties?.['Contract Sign Date']?.date?.start || null;

    // Fail-loud on empty Contract Sign Date — no silent "today" fallback.
    // Silent anchoring produces wrong dates across the whole study; post a
    // comment (via the existing Promise.all trio) and abort. Import Mode
    // reset happens in the `finally` block.
    if (!contractSignDate) {
      const emptyDateSummary = 'Cannot activate — Contract Sign Date is empty. Please set it on the study page and try again.';
      await Promise.all([
        notionClient.reportStatus(studyPageId, 'error', emptyDateSummary, { tracer }),
        activityLogService.logTerminalEvent({
          workflow: 'Inception',
          status: 'failed',
          triggerType: 'Automation',
          triggeredByUserId,
          editedByBot,
          sourceTaskName: studyName,
          studyId: studyPageId,
          summary: emptyDateSummary,
        }),
        studyCommentService.postComment({
          workflow: 'Inception',
          status: 'failed',
          studyId: studyPageId,
          sourceTaskName: studyName,
          triggeredByUserId,
          editedByBot,
          summary: emptyDateSummary,
        }).catch(() => {}),
      ]);
      return;
    }

    if (existingTasks.length > 0) {
      await Promise.all([
        notionClient.reportStatus(studyPageId, 'error', 'Study already has tasks — aborting inception', { tracer }),
        activityLogService.logTerminalEvent({
          workflow: 'Inception',
          status: 'failed',
          triggerType: 'Automation',
          triggeredByUserId,
          editedByBot,
          sourceTaskName: studyName,
          studyId: studyPageId,
          summary: 'Study already has tasks — double-inception blocked',
        }),
        studyCommentService.postComment({
          workflow: 'Inception',
          status: 'failed',
          studyId: studyPageId,
          sourceTaskName: studyName,
          triggeredByUserId,
          editedByBot,
          summary: 'Study already has tasks — double-inception blocked',
        }).catch(() => {}),
      ]);
      return;
    }

    // Fetch blueprint
    tracer.startPhase('fetchBlueprint');
    const blueprintTasks = await fetchBlueprint(notionClient, config.notion.blueprintDbId, { tracer });
    tracer.endPhase('fetchBlueprint');

    if (!blueprintTasks || blueprintTasks.length === 0) {
      await Promise.all([
        notionClient.reportStatus(studyPageId, 'error', 'No blueprint tasks found', { tracer }),
        activityLogService.logTerminalEvent({
          workflow: 'Inception',
          status: 'failed',
          triggerType: 'Automation',
          triggeredByUserId,
          editedByBot,
          sourceTaskName: studyName,
          studyId: studyPageId,
          summary: 'No blueprint tasks found',
        }),
        studyCommentService.postComment({
          workflow: 'Inception',
          status: 'failed',
          studyId: studyPageId,
          sourceTaskName: studyName,
          triggeredByUserId,
          editedByBot,
          summary: 'No blueprint tasks found',
        }).catch(() => {}),
      ]);
      return;
    }

    const blockPrefetchPromise = prefetchTemplateBlocks(
      notionClient,
      blueprintTasks.map((task) => task.id),
      { tracer, workersPerToken: 3 },
    );

    // Build task tree (used for task parsing/subtree structure only)
    const levels = buildTaskTree(blueprintTasks);

    const [createResult, preparedBlocksByTemplate] = await Promise.all([
      createStudyTasks(notionClient, levels, {
        studyPageId,
        contractSignDate,
        blueprintDbId: config.notion.blueprintDbId,
        studyTasksDbId: config.notion.studyTasksDbId,
        tracer,
      }),
      blockPrefetchPromise,
    ]);

    const [wireResult] = await Promise.all([
      wireRemainingRelations(notionClient, {
        idMapping: createResult.idMapping,
        depTracking: createResult.depTracking,
        parentTracking: createResult.parentTracking,
        tracer,
      }),
      notionClient.reportStatus(
        studyPageId,
        'info',
        `Tasks created: ${createResult.totalCreated}. Wiring relations...`,
        { tracer },
      ),
    ]);

    const completionMessage = `Inception complete: ${createResult.totalCreated} tasks created, ${wireResult.parentsPatchedCount} parents wired, ${wireResult.depsPatchedCount} deps wired`;
    const commentSummary = `Study setup complete — ${createResult.totalCreated} tasks created`;

    const disableImportModePromise = (async () => {
      tracer.startPhase('disableImportMode');
      try {
        return await notionClient.request('PATCH', `/pages/${studyPageId}`, {
          properties: { 'Import Mode': { checkbox: false } },
        }, { tracer });
      } finally {
        tracer.endPhase('disableImportMode');
      }
    })();

    const [, , copyResult] = await Promise.all([
      disableImportModePromise,
      notionClient.reportStatus(studyPageId, 'success', completionMessage, { tracer }),
      copyBlocks(notionClient, createResult.idMapping, {
        studyPageId,
        studyName,
        preparedBlocksByTemplate,
        concurrency: 10,
        workersPerToken: 10,
        tracer,
      }),
    ]);

    await Promise.all([
      activityLogService.logTerminalEvent({
        workflow: 'Inception',
        status: 'success',
        triggerType: 'Automation',
        triggeredByUserId,
        editedByBot,
        executionId: tracer.cascadeId,
        timestamp: new Date().toISOString(),
        cascadeMode: 'N/A',
        sourceTaskName: studyName,
        studyId: studyPageId,
        summary: completionMessage,
        details: {
          totalCreated: createResult.totalCreated,
          parentsPatchedCount: wireResult.parentsPatchedCount,
          depsPatchedCount: wireResult.depsPatchedCount,
          blocksWrittenCount: copyResult.blocksWrittenCount,
          pagesProcessed: copyResult.pagesProcessed,
          pagesSkipped: copyResult.pagesSkipped,
          ...(tracer.toActivityLogDetails()),
        },
      }),
      notionClient.reportStatus(
        studyPageId,
        'success',
        `Content blocks copied: ${copyResult.pagesProcessed} pages, ${copyResult.blocksWrittenCount} blocks`,
        { tracer },
      ),
    ]);

    console.log(tracer.toConsoleLog());
  } catch (error) {
    console.error('[inception] processing failed:', error);
    console.log(tracer.toConsoleLog());

    try {
      await Promise.all([
        notionClient.reportStatus(
          studyPageId,
          'error',
          `Inception failed: ${String(error.message || error).slice(0, 200)}`,
          { tracer },
        ),
        activityLogService.logTerminalEvent({
          workflow: 'Inception',
          status: 'failed',
          triggerType: 'Automation',
          triggeredByUserId,
          editedByBot,
          executionId: tracer.cascadeId,
          sourceTaskName: studyName || null,
          studyId: studyPageId,
          summary: `Inception failed: ${String(error.message || error).slice(0, 180)}`,
          details: { ...(tracer.toActivityLogDetails()) },
        }),
        studyCommentService.postComment({
          workflow: 'Inception',
          status: 'failed',
          studyId: studyPageId,
          sourceTaskName: studyName || null,
          triggeredByUserId,
          editedByBot,
          summary: `Study setup failed: ${String(error.message || error).slice(0, 180)}`,
        }).catch(() => {}),
      ]);
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
  flightTracker.track(processInception(req.body).catch(err => console.error('[inception] unhandled:', err)), 'inception');
}
