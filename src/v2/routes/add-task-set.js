/**
 * V2 Add Task Set — Phase 3 button handler for V2 studies.
 *
 * Forked from V1 with these changes:
 *   - Uses V2 createStudyTasks (writes Relative SDate/EDate Offset on subtasks)
 *   - Uses V2 Blueprint DB ID
 *   - REMOVED: first-subtask unblocking (subtasks have no deps in V2)
 *   - REMOVED: TLF Draft unblocking (subtasks have no deps in V2)
 *   - MODIFIED: repeat-delivery subtask dates computed from copied parent start +
 *     relative offsets (V2 model) instead of name-matched from previous delivery
 *
 * Everything else is identical: button parsing, subtree filtering, delivery
 * numbering, task-set numbering, Import Mode lifecycle, copy-blocks firing.
 */

import { config } from '../../config.js';
import { NotionClient } from '../../notion/client.js';
import { ActivityLogService } from '../../services/activity-log.js';
import { CascadeTracer } from '../../services/cascade-tracer.js';
import { fetchBlueprint, filterBlueprintSubtree } from '../../provisioning/blueprint.js';
import { createStudyTasks } from '../provisioning/create-tasks.js';
import { wireRemainingRelations } from '../../provisioning/wire-relations.js';
import { parseDate, addBusinessDays, formatDate } from '../../utils/business-days.js';

const tokens = config.notion.provisionTokens.length > 0
  ? config.notion.provisionTokens
  : config.notion.tokens;

const notionClient = new NotionClient({ tokens });
const activityLogService = new ActivityLogService({
  notionClient,
  activityLogDbId: config.notion.activityLogDbId,
});

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

function applyDeliveryNumbering(filteredLevels, nextNum) {
  for (const { tasks } of filteredLevels) {
    for (const task of tasks) {
      task._taskName = task._taskName.replace(/#\d+/g, `#${nextNum}`);
    }
  }
}

function resolveTaskSetNumbers(existingTasks, filteredLevels) {
  const numbers = new Map();
  if (filteredLevels.length === 0 || filteredLevels[0].tasks.length === 0) return numbers;

  const tsidCounts = {};
  for (const page of existingTasks) {
    const tsid =
      page.properties?.['Template Source ID']?.rich_text?.[0]?.plain_text ||
      page.properties?.['Template Source ID']?.rich_text?.[0]?.text?.content;
    if (tsid) tsidCounts[tsid] = (tsidCounts[tsid] || 0) + 1;
  }

  for (const task of filteredLevels[0].tasks) {
    const count = tsidCounts[task._templateId] || 0;
    numbers.set(task._templateId, count + 1);
  }

  return numbers;
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
    console.warn('[v2-add-task-set] no studyPageId in payload, skipping');
    return;
  }
  if (!buttonType) {
    console.warn('[v2-add-task-set] no buttonType in headers, skipping');
    return;
  }

  const isRepeatDelivery = buttonType === 'repeat-delivery';

  const tracer = new CascadeTracer();
  tracer.set('workflow', 'V2 Add Task Set');
  tracer.set('study_id', studyPageId);
  tracer.set('button_type', buttonType);
  tracer.set('parent_task_names', parentTaskNames.join(', '));
  tracer.set('is_repeat_delivery', isRepeatDelivery);
  tracer.set('engine_version', 'v2');

  let studyPage;
  try {
    tracer.startPhase('enableImportMode');
    await notionClient.request('PATCH', `/pages/${studyPageId}`, {
      properties: { 'Import Mode': { checkbox: true } },
    }, { tracer });
    tracer.endPhase('enableImportMode');

    await notionClient.reportStatus(
      studyPageId,
      'info',
      `V2 Add Task Set started (${buttonType})...`,
      { tracer },
    );

    tracer.startPhase('fetchStudy');
    studyPage = await notionClient.getPage(studyPageId);
    tracer.endPhase('fetchStudy');

    const contractSignDate = studyPage.properties?.['Contract Sign Date']?.date?.start
      || new Date().toISOString().split('T')[0];
    const studyName = studyPage.properties?.['Study Name (Internal)']?.title?.[0]?.text?.content || 'Unknown Study';

    // Fetch V2 blueprint + existing tasks in parallel
    const blueprintDbId = config.notion.blueprintV2DbId || config.notion.blueprintDbId;
    tracer.startPhase('fetchBlueprintAndExisting');
    const [blueprintTasks, existingTasks] = await Promise.all([
      fetchBlueprint(notionClient, blueprintDbId, { tracer }),
      notionClient.queryDatabase(
        config.notion.studyTasksDbId,
        { property: 'Study', relation: { contains: studyPageId } },
        100,
        { tracer },
      ),
    ]);
    tracer.endPhase('fetchBlueprintAndExisting');

    if (!blueprintTasks || blueprintTasks.length === 0) {
      await notionClient.reportStatus(studyPageId, 'error', 'No V2 blueprint tasks found', { tracer });
      await activityLogService.logTerminalEvent({
        workflow: 'V2 Add Task Set',
        status: 'failed',
        triggerType: 'Automation',
        studyId: studyPageId,
        summary: 'No V2 blueprint tasks found',
      });
      return;
    }

    tracer.startPhase('filterSubtree');
    const filteredLevels = filterBlueprintSubtree(blueprintTasks, parentTaskNames);
    tracer.endPhase('filterSubtree');

    if (filteredLevels.length === 0) {
      await notionClient.reportStatus(
        studyPageId,
        'error',
        `No matching V2 blueprint tasks found for: ${parentTaskNames.join(', ')}`,
        { tracer },
      );
      await activityLogService.logTerminalEvent({
        workflow: 'V2 Add Task Set',
        status: 'failed',
        triggerType: 'Automation',
        studyId: studyPageId,
        summary: `No matching V2 blueprint subtree for: ${parentTaskNames.join(', ')}`,
      });
      return;
    }

    // Delivery numbering (same as V1)
    let nextNum = null;
    if (isRepeatDelivery) {
      tracer.startPhase('resolveDeliveryNumber');
      nextNum = await resolveNextDeliveryNumber(studyPageId, tracer);
      tracer.endPhase('resolveDeliveryNumber');
      tracer.set('next_delivery_num', nextNum);
      applyDeliveryNumbering(filteredLevels, nextNum);
    }

    // V2: NO first-subtask unblocking — subtasks have no deps
    // V2: NO TLF Draft unblocking — subtasks have no deps

    // Build existing ID mapping (same as V1)
    const existingIdMapping = {};
    for (const page of existingTasks) {
      const tsid = page.properties?.['Template Source ID']?.rich_text?.[0]?.plain_text
        || page.properties?.['Template Source ID']?.rich_text?.[0]?.text?.content;
      if (tsid && page.id) {
        existingIdMapping[tsid] = page.id;
      }
    }

    // Strip internal template IDs (same as V1)
    const internalTemplateIds = new Set();
    for (const { tasks } of filteredLevels) {
      for (const task of tasks) internalTemplateIds.add(task._templateId);
    }
    for (const tid of internalTemplateIds) {
      delete existingIdMapping[tid];
    }
    tracer.set('external_deps_resolved', Object.keys(existingIdMapping).length);
    tracer.set('internal_template_ids_excluded', internalTemplateIds.size);

    // ── Repeat-delivery date copying (V2 — parent dates + offset-derived subtask dates) ──
    if (isRepeatDelivery) {
      const maxNum = nextNum - 1;
      const deliveryPattern = new RegExp(`Data Delivery #${maxNum}`);

      // Find the parent task for the latest delivery
      let latestDeliveryParentId = null;
      let latestParentDates = null;
      for (const page of existingTasks) {
        const name = page.properties?.['Task Name']?.title?.[0]?.plain_text || '';
        if (deliveryPattern.test(name) && name.includes('Activities')) {
          latestDeliveryParentId = page.id;
          const dates = page.properties?.['Dates']?.date;
          if (dates?.start) {
            latestParentDates = { start: dates.start, end: dates.end };
          }
          break;
        }
      }

      if (latestParentDates) {
        let overrideCount = 0;
        const copiedParentStart = parseDate(latestParentDates.start);

        for (const { tasks } of filteredLevels) {
          for (const task of tasks) {
            const isParent = task._taskName.includes('Activities') && task._taskName.includes('Data Delivery');
            if (isParent) {
              // Parent: copy dates directly from latest delivery parent
              task._overrideStartDate = latestParentDates.start;
              task._overrideEndDate = latestParentDates.end;
              overrideCount++;
            } else if (copiedParentStart) {
              // V2: Subtask dates from copied parent start + relative offsets
              const relSoff = task.properties?.['Relative SDate Offset']?.number;
              const relEoff = task.properties?.['Relative EDate Offset']?.number;
              if (relSoff != null && relEoff != null) {
                task._overrideStartDate = formatDate(addBusinessDays(copiedParentStart, relSoff));
                task._overrideEndDate = formatDate(addBusinessDays(copiedParentStart, relEoff));
                overrideCount++;
              }
            }
          }
        }
        tracer.set('date_overrides_applied', overrideCount);
        tracer.set('latest_delivery_matched', `#${maxNum}`);
      }
    }

    // Create tasks (V2 — writes relative offsets on subtasks)
    const createResult = await createStudyTasks(notionClient, filteredLevels, {
      studyPageId,
      contractSignDate,
      studyTasksDbId: config.notion.studyTasksDbId,
      existingIdMapping,
      tracer,
    });

    await notionClient.reportStatus(
      studyPageId,
      'info',
      `V2 Tasks created: ${createResult.totalCreated}. Wiring relations...`,
      { tracer },
    );

    // Wire remaining relations (shared — handles parent deps)
    const wireResult = await wireRemainingRelations(notionClient, {
      idMapping: createResult.idMapping,
      depTracking: createResult.depTracking,
      parentTracking: createResult.parentTracking,
      tracer,
    });

    // Post-create task set numbering (same as V1)
    if (!isRepeatDelivery && parentTaskNames.length > 0) {
      tracer.startPhase('applyTaskSetNumbering');

      const freshTasks = await notionClient.queryDatabase(
        config.notion.studyTasksDbId,
        { property: 'Study', relation: { contains: studyPageId } },
        100,
        { tracer },
      );

      const numberMap = resolveTaskSetNumbers(freshTasks, filteredLevels);

      const renames = [];
      for (const task of filteredLevels[0]?.tasks || []) {
        const productionId = createResult.idMapping[task._templateId];
        const num = numberMap.get(task._templateId);
        if (productionId && num) {
          renames.push({
            taskId: productionId,
            properties: {
              'Task Name': { title: [{ type: 'text', text: { content: `${task._taskName} #${num}` } }] },
            },
          });
        }
      }
      if (renames.length > 0) {
        await notionClient.patchPages(renames, { tracer });
      }
      tracer.set('task_set_numbers', JSON.stringify(Object.fromEntries(numberMap)));
      tracer.endPhase('applyTaskSetNumbering');
    }

    // Disable Import Mode
    tracer.startPhase('disableImportMode');
    await notionClient.request('PATCH', `/pages/${studyPageId}`, {
      properties: { 'Import Mode': { checkbox: false } },
    }, { tracer });
    tracer.endPhase('disableImportMode');

    // Fire copy-blocks (only newly created tasks)
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
      headers: {
        'Content-Type': 'application/json',
        ...(config.webhookSecret ? { 'X-Webhook-Secret': config.webhookSecret } : {}),
      },
      body: JSON.stringify({
        idMapping: newIdMapping,
        studyPageId,
        studyName,
      }),
    }).catch(err => console.warn('[v2-add-task-set] copy-blocks fire-and-forget failed:', err.message));

    // Activity log
    await activityLogService.logTerminalEvent({
      workflow: 'V2 Add Task Set',
      status: 'success',
      triggerType: 'Automation',
      executionId: tracer.cascadeId,
      timestamp: new Date().toISOString(),
      cascadeMode: 'N/A',
      studyId: studyPageId,
      summary: `V2 Add Task Set complete (${buttonType}): ${createResult.totalCreated} tasks created, ${wireResult.parentsPatchedCount} parents wired, ${wireResult.depsPatchedCount} deps wired`,
      details: {
        buttonType,
        parentTaskNames,
        isRepeatDelivery,
        totalCreated: createResult.totalCreated,
        parentsPatchedCount: wireResult.parentsPatchedCount,
        depsPatchedCount: wireResult.depsPatchedCount,
        ...(tracer.toActivityLogDetails()),
      },
    });

    await notionClient.reportStatus(
      studyPageId,
      'success',
      `V2 Add Task Set complete (${buttonType}): ${createResult.totalCreated} tasks created`,
      { tracer },
    );

    console.log(tracer.toConsoleLog());
  } catch (error) {
    console.error('[v2-add-task-set] processing failed:', error);
    console.log(tracer.toConsoleLog());

    try {
      await notionClient.reportStatus(
        studyPageId,
        'error',
        `V2 Add Task Set failed: ${String(error.message || error).slice(0, 200)}`,
        { tracer },
      );
    } catch { /* don't mask original error */ }

    try {
      await activityLogService.logTerminalEvent({
        workflow: 'V2 Add Task Set',
        status: 'failed',
        triggerType: 'Automation',
        executionId: tracer.cascadeId,
        timestamp: new Date().toISOString(),
        cascadeMode: 'N/A',
        studyId: studyPageId,
        summary: `V2 Add Task Set failed: ${String(error.message || error).slice(0, 180)}`,
        details: {
          buttonType,
          error: {
            errorCode: error.code || null,
            errorMessage: String(error.message || error).slice(0, 400),
            phase: 'v2-add-task-set',
          },
          ...(tracer.toActivityLogDetails()),
        },
      });
    } catch { /* don't mask original error */ }

    throw error;
  } finally {
    try {
      await notionClient.request('PATCH', `/pages/${studyPageId}`, {
        properties: { 'Import Mode': { checkbox: false } },
      }, { tracer });
    } catch (cleanupError) {
      console.warn('[v2-add-task-set] failed to disable Import Mode in finally:', cleanupError.message);
    }
  }
}

export async function handleAddTaskSet(req, res) {
  res.status(200).json({ ok: true });
  void processAddTaskSet(req).catch(err => console.error('[v2-add-task-set] unhandled:', err));
}
