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
    // Enable Import Mode (may already be ON — the Notion button automation
    // sets Import Mode = true BEFORE sending the webhook, so it's expected
    // to be active when we arrive here. We just ensure it stays on.)
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
    tracer.startPhase('fetchStudy');
    studyPage = await notionClient.getPage(studyPageId);
    tracer.endPhase('fetchStudy');

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
    let nextNum = null;
    if (isRepeatDelivery) {
      tracer.startPhase('resolveDeliveryNumber');
      nextNum = await resolveNextDeliveryNumber(studyPageId, tracer);
      tracer.endPhase('resolveDeliveryNumber');
      tracer.set('next_delivery_num', nextNum);
      applyDeliveryNumbering(filteredLevels, nextNum);
    }

    // ── First-subtask unblocking ──────────────────────────────────────────
    // Collect all template IDs in the filtered set (internal deps)
    const internalIds = new Set();
    for (const { tasks } of filteredLevels) {
      for (const task of tasks) internalIds.add(task._templateId);
    }

    // For each root parent (level 0), find children at level 1 whose blockers
    // are all external (not in the filtered set). The first such child gets
    // its _templateBlockedBy cleared so it's immediately actionable.
    if (filteredLevels.length >= 2) {
      const rootIds = new Set(filteredLevels[0].tasks.map((t) => t._templateId));
      for (const task of filteredLevels[1]?.tasks || []) {
        if (!rootIds.has(task._templateParentId)) continue;
        const internalBlockers = (task._templateBlockedBy || []).filter((id) => internalIds.has(id));
        if (internalBlockers.length === 0) {
          task._templateBlockedBy = [];
        }
      }
    }

    // For TLF buttons, clear Blocked by on Draft TLF tasks
    if (isTlfButton) {
      for (const { tasks } of filteredLevels) {
        for (const task of tasks) {
          if (task._taskName.toLowerCase().includes('draft') && task._taskName.toLowerCase().includes('tlf')) {
            task._templateBlockedBy = [];
          }
        }
      }
    }

    // ── External dependency resolution ────────────────────────────────────
    // Query existing production tasks to resolve deps on already-created tasks
    tracer.startPhase('resolveExternalDeps');
    const existingTasks = await notionClient.queryDatabase(
      config.notion.studyTasksDbId,
      { property: 'Study', relation: { contains: studyPageId } },
      100,
      { tracer },
    );
    tracer.endPhase('resolveExternalDeps');

    // Build templateId -> productionId mapping from existing tasks
    const existingIdMapping = {};
    for (const page of existingTasks) {
      const tsid = page.properties?.['Template Source ID']?.rich_text?.[0]?.plain_text
        || page.properties?.['Template Source ID']?.rich_text?.[0]?.text?.content;
      if (tsid && page.id) {
        existingIdMapping[tsid] = page.id;
      }
    }
    tracer.set('external_deps_resolved', Object.keys(existingIdMapping).length);

    // ── Repeat-delivery date copying ─────────────────────────────────────
    // Copy dates from the latest delivery's tasks so each new delivery
    // inherits the previous one's dates (which may have been manually adjusted).
    // The blueprint has separate delivery subtrees (#1-#9) with unique template
    // IDs, so we can't match by template ID. Instead, find the latest delivery's
    // parent, collect its children's dates by task name, and match by name.
    if (isRepeatDelivery) {
      const maxNum = nextNum - 1; // nextNum was resolved earlier
      const deliveryPattern = new RegExp(`Data Delivery #${maxNum}`);

      // Find the parent task for the latest delivery
      let latestDeliveryParentId = null;
      for (const page of existingTasks) {
        const name = page.properties?.['Task Name']?.title?.[0]?.plain_text || '';
        if (deliveryPattern.test(name) && name.includes('Activities')) {
          latestDeliveryParentId = page.id;
          break;
        }
      }

      if (latestDeliveryParentId) {
        // Collect children of that parent and map by task name → dates
        const latestDates = {};
        for (const page of existingTasks) {
          const parentRel = page.properties?.['Parent Task']?.relation || [];
          if (parentRel.some((r) => r.id === latestDeliveryParentId)) {
            const name = page.properties?.['Task Name']?.title?.[0]?.plain_text || '';
            const dates = page.properties?.['Dates']?.date;
            if (name && dates?.start) {
              latestDates[name.trim()] = { start: dates.start, end: dates.end };
            }
          }
        }

        // Also grab the parent's own dates
        for (const page of existingTasks) {
          if (page.id === latestDeliveryParentId) {
            const dates = page.properties?.['Dates']?.date;
            if (dates?.start) {
              latestDates['__parent__'] = { start: dates.start, end: dates.end };
            }
            break;
          }
        }

        // Apply date overrides — match by task name (after delivery renumbering)
        let overrideCount = 0;
        for (const { tasks } of filteredLevels) {
          for (const task of tasks) {
            // Strip delivery number from name for matching (e.g., "Data Delivery #10 Activities" → match parent)
            const isParent = task._taskName.includes('Activities') && task._taskName.includes('Data Delivery');
            if (isParent && latestDates['__parent__']) {
              task._overrideStartDate = latestDates['__parent__'].start;
              task._overrideEndDate = latestDates['__parent__'].end;
              overrideCount++;
            } else {
              const override = latestDates[task._taskName.trim()];
              if (override) {
                task._overrideStartDate = override.start;
                task._overrideEndDate = override.end;
                overrideCount++;
              }
            }
          }
        }
        tracer.set('date_overrides_applied', overrideCount);
        tracer.set('latest_delivery_matched', `#${maxNum}`);
      }
    }

    // Create tasks level by level (seed idMapping with existing production tasks)
    const createResult = await createStudyTasks(notionClient, filteredLevels, {
      studyPageId,
      contractSignDate,
      studyTasksDbId: config.notion.studyTasksDbId,
      existingIdMapping,
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

    // Fire copy-blocks only for newly created tasks (exclude pre-existing ones).
    // Template IDs (keys) repeat across operations — filter by production IDs (values).
    const existingProductionIds = new Set(Object.values(existingIdMapping));
    const newIdMapping = {};
    for (const [templateId, productionId] of Object.entries(createResult.idMapping)) {
      if (!existingProductionIds.has(productionId)) {
        newIdMapping[templateId] = productionId;
      }
    }

    const selfUrl = `http://localhost:${config.port}/webhook/copy-blocks`;
    fetch(selfUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        idMapping: newIdMapping,
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
