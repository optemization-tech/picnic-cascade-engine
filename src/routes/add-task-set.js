import { config } from '../config.js';
import { NotionClient } from '../notion/client.js';
import { ActivityLogService } from '../services/activity-log.js';
import { CascadeTracer } from '../services/cascade-tracer.js';
import { fetchBlueprint, buildTaskTree, filterBlueprintSubtree } from '../provisioning/blueprint.js';
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

/**
 * For repeat-delivery buttons, scan existing production tasks for the max
 * delivery number and return nextNum. Returns 1 if no existing deliveries found.
 */
async function resolveNextDeliveryNumber(studyPageId, tracer) {
  const existingTasks = await notionClient.queryDatabase(
    config.notion.studyTasksDbId,
    { property: 'Study', relation: { contains: studyPageId } },
    100,
    { tracer },
  );

  let maxNum = 0;
  const pattern = /Data Delivery #(\d+)/;

  for (const page of existingTasks) {
    const name =
      page.properties?.['Task Name']?.title?.[0]?.text?.content ||
      page.properties?.['Task Name']?.title?.[0]?.plain_text ||
      '';
    const match = name.match(pattern);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num > maxNum) maxNum = num;
    }
  }

  return maxNum + 1;
}

/**
 * Substitute `#\d+` delivery number placeholders in blueprint task names
 * with the actual next delivery number.
 */
function applyDeliveryNumbering(filteredLevels, nextNum) {
  for (const { tasks } of filteredLevels) {
    for (const task of tasks) {
      task._taskName = task._taskName.replace(/#\d+/g, `#${nextNum}`);
    }
  }
}

async function processAddTaskSet(req) {
  const body = req.body || {};
  const headers = req.headers || {};

  const buttonType = headers['x-button-type'] || null;
  const parentTaskNamesRaw = headers['x-parent-task-names'] || '';
  const parentTaskNames = parentTaskNamesRaw
    ? parentTaskNamesRaw.split(',').map(s => s.trim()).filter(Boolean)
    : [];
  const studyPageId = body.data?.id || body.studyPageId;

  if (!studyPageId) {
    console.warn('[add-task-set] no studyPageId in payload, skipping');
    return;
  }
  if (!buttonType) {
    console.warn('[add-task-set] no buttonType in headers, skipping');
    return;
  }

  const isTlfButton = buttonType.includes('tlf');
  const isRepeatDelivery = buttonType === 'repeat-delivery';

  const tracer = new CascadeTracer();
  tracer.set('workflow', 'Add Task Set');
  tracer.set('study_id', studyPageId);
  tracer.set('button_type', buttonType);
  tracer.set('parent_task_names', parentTaskNames.join(', '));
  tracer.set('is_tlf', isTlfButton);
  tracer.set('is_repeat_delivery', isRepeatDelivery);

  let studyPage;

  try {
    // Import Mode guard — reject if already active (concurrent operation)
    tracer.startPhase('importModeCheck');
    studyPage = await notionClient.getPage(studyPageId);
    tracer.endPhase('importModeCheck');

    const importModeActive = studyPage.properties?.['Import Mode']?.checkbox === true;
    if (importModeActive) {
      await notionClient.reportStatus(
        studyPageId,
        'error',
        'Add Task Set blocked: Import Mode already active (concurrent operation in progress)',
        { tracer },
      );
      await activityLogService.logTerminalEvent({
        workflow: 'Add Task Set',
        status: 'failed',
        triggerType: 'Automation',
        executionId: tracer.cascadeId,
        timestamp: new Date().toISOString(),
        cascadeMode: 'N/A',
        studyId: studyPageId,
        summary: 'Add Task Set blocked: concurrent Import Mode',
      });
      return;
    }

    // Enable Import Mode
    tracer.startPhase('enableImportMode');
    await notionClient.request('PATCH', `/pages/${studyPageId}`, {
      properties: { 'Import Mode': { checkbox: true } },
    }, { tracer });
    tracer.endPhase('enableImportMode');

    // Report kicked off
    await notionClient.reportStatus(
      studyPageId,
      'info',
      `Add Task Set started (${buttonType})...`,
      { tracer },
    );

    // Fetch study details for contract sign date and study name
    const contractSignDate = studyPage.properties?.['Contract Sign Date']?.date?.start
      || new Date().toISOString().split('T')[0];
    const studyName = studyPage.properties?.['Study Name (Internal)']?.title?.[0]?.text?.content || 'Unknown Study';

    // Fetch blueprint
    tracer.startPhase('fetchBlueprint');
    const blueprintTasks = await fetchBlueprint(notionClient, config.notion.blueprintDbId, { tracer });
    tracer.endPhase('fetchBlueprint');

    if (!blueprintTasks || blueprintTasks.length === 0) {
      await notionClient.reportStatus(studyPageId, 'error', 'No blueprint tasks found', { tracer });
      await activityLogService.logTerminalEvent({
        workflow: 'Add Task Set',
        status: 'failed',
        triggerType: 'Automation',
        studyId: studyPageId,
        summary: 'No blueprint tasks found',
      });
      return;
    }

    // Filter blueprint subtree based on parent task names
    tracer.startPhase('filterSubtree');
    const filteredLevels = filterBlueprintSubtree(blueprintTasks, parentTaskNames);
    tracer.endPhase('filterSubtree');

    if (filteredLevels.length === 0) {
      await notionClient.reportStatus(
        studyPageId,
        'error',
        `No matching blueprint tasks found for: ${parentTaskNames.join(', ')}`,
        { tracer },
      );
      await activityLogService.logTerminalEvent({
        workflow: 'Add Task Set',
        status: 'failed',
        triggerType: 'Automation',
        studyId: studyPageId,
        summary: `No matching blueprint subtree for: ${parentTaskNames.join(', ')}`,
      });
      return;
    }

    // Set numbering for repeat-delivery
    if (isRepeatDelivery) {
      tracer.startPhase('resolveDeliveryNumber');
      const nextNum = await resolveNextDeliveryNumber(studyPageId, tracer);
      tracer.endPhase('resolveDeliveryNumber');
      tracer.set('next_delivery_num', nextNum);
      applyDeliveryNumbering(filteredLevels, nextNum);
    }

    // TODO: First-subtask unblocking — for each root parent in the filtered set,
    // find the first child with no internal blockers and clear _templateBlockedBy
    // so createStudyTasks doesn't set the Blocked by relation. Also for TLF buttons,
    // clear Blocked by on Draft TLF tasks.

    // TODO: External dependency resolution — query existing production tasks,
    // build templateId -> productionId mapping for tasks that already exist,
    // pass to createStudyTasks so external deps resolve correctly.

    // Create tasks level by level
    const createResult = await createStudyTasks(notionClient, filteredLevels, {
      studyPageId,
      contractSignDate,
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

    // Wire remaining relations
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

    // Fire copy-blocks (self-POST, fire-and-forget)
    const selfUrl = `http://localhost:${config.port}/webhook/copy-blocks`;
    fetch(selfUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        idMapping: createResult.idMapping,
        studyPageId,
        studyName,
      }),
    }).catch(err => console.warn('[add-task-set] copy-blocks fire-and-forget failed:', err.message));

    // Log to activity log
    await activityLogService.logTerminalEvent({
      workflow: 'Add Task Set',
      status: 'success',
      triggerType: 'Automation',
      executionId: tracer.cascadeId,
      timestamp: new Date().toISOString(),
      cascadeMode: 'N/A',
      studyId: studyPageId,
      summary: `Add Task Set complete (${buttonType}): ${createResult.totalCreated} tasks created, ${wireResult.parentsPatchedCount} parents wired, ${wireResult.depsPatchedCount} deps wired`,
      details: {
        buttonType,
        parentTaskNames,
        isTlfButton,
        isRepeatDelivery,
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
      `Add Task Set complete (${buttonType}): ${createResult.totalCreated} tasks created`,
      { tracer },
    );

    console.log(tracer.toConsoleLog());
  } catch (error) {
    console.error('[add-task-set] processing failed:', error);
    console.log(tracer.toConsoleLog());

    try {
      await notionClient.reportStatus(
        studyPageId,
        'error',
        `Add Task Set failed: ${String(error.message || error).slice(0, 200)}`,
        { tracer },
      );
    } catch { /* don't mask original error */ }

    try {
      await activityLogService.logTerminalEvent({
        workflow: 'Add Task Set',
        status: 'failed',
        triggerType: 'Automation',
        executionId: tracer.cascadeId,
        timestamp: new Date().toISOString(),
        cascadeMode: 'N/A',
        studyId: studyPageId,
        summary: `Add Task Set failed: ${String(error.message || error).slice(0, 180)}`,
        details: {
          buttonType,
          error: {
            errorCode: error.code || null,
            errorMessage: String(error.message || error).slice(0, 400),
            phase: 'add-task-set',
          },
          ...(tracer.toActivityLogDetails()),
        },
      });
    } catch { /* don't mask original error */ }

    throw error;
  } finally {
    // Critical: always disable Import Mode
    try {
      await notionClient.request('PATCH', `/pages/${studyPageId}`, {
        properties: { 'Import Mode': { checkbox: false } },
      }, { tracer });
    } catch (cleanupError) {
      console.warn('[add-task-set] failed to disable Import Mode in finally:', cleanupError.message);
    }
  }
}

export async function handleAddTaskSet(req, res) {
  res.status(200).json({ ok: true });
  void processAddTaskSet(req).catch(err => console.error('[add-task-set] unhandled:', err));
}
