import { config } from '../config.js';
import { provisionClient as notionClient, commentClient } from '../notion/clients.js';
import { copyBlocks } from '../provisioning/copy-blocks.js';
import { ActivityLogService } from '../services/activity-log.js';
import { StudyCommentService } from '../services/study-comment.js';
import { flightTracker } from '../services/flight-tracker.js';
import { CascadeTracer } from '../services/cascade-tracer.js';
import { fetchBlueprint, buildTaskTree, filterBlueprintSubtree } from '../provisioning/blueprint.js';
import { createStudyTasks } from '../provisioning/create-tasks.js';
import { wireRemainingRelations } from '../provisioning/wire-relations.js';
const activityLogService = new ActivityLogService({
  notionClient: commentClient,
  activityLogDbId: config.notion.activityLogDbId,
});
const studyCommentService = new StudyCommentService({ notionClient: commentClient });

/**
 * For repeat-delivery buttons, scan existing production tasks for the max
 * delivery number and return nextNum. Returns 1 if no existing deliveries found.
 */
function resolveNextDeliveryNumber(existingTasks) {
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

/**
 * For non-repeat-delivery buttons, count how many production tasks already
 * exist with the same Template Source ID as each level-0 parent. Each parent
 * gets its own number: TLF might be #3 while CSR is #2 if CSR has fewer
 * existing instances. Returns a Map of templateId → nextNum.
 *
 * Uses the already-fetched existingTasks array (from dep resolution) rather
 * than a separate query — both query the same DB with the same filter.
 */
function resolveTaskSetNumbers(existingTasks = [], filteredLevels) {
  const numbers = new Map();
  if (filteredLevels.length === 0 || filteredLevels[0].tasks.length === 0) return numbers;

  // Build a count of existing production tasks per Template Source ID
  const tsidCounts = {};
  for (const page of existingTasks) {
    const tsid =
      page.properties?.['Template Source ID']?.rich_text?.[0]?.plain_text ||
      page.properties?.['Template Source ID']?.rich_text?.[0]?.text?.content;
    if (tsid) tsidCounts[tsid] = (tsidCounts[tsid] || 0) + 1;
  }

  // Each level-0 parent gets its own next number
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

  // source.user_id is the actual button clicker; data.last_edited_by is whoever last edited the page.
  const triggeredByUserId = body.source?.user_id || body.data?.last_edited_by?.id || null;
  const editedByBot = !body.source?.user_id && body.data?.last_edited_by?.type === 'bot';

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
  let studyName;

  try {
    // Enable Import Mode (may already be ON — the Notion button automation
    // sets Import Mode = true BEFORE sending the webhook, so it's expected
    // to be active when we arrive here. We just ensure it stays on.)
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

    const fetchBlueprintAndExistingPromise = (async () => {
      tracer.startPhase('fetchBlueprintAndExisting');
      try {
        return await Promise.all([
          fetchBlueprint(notionClient, config.notion.blueprintDbId, { tracer }),
          notionClient.queryDatabase(
            config.notion.studyTasksDbId,
            { property: 'Study', relation: { contains: studyPageId } },
            100,
            { tracer },
          ),
        ]);
      } finally {
        tracer.endPhase('fetchBlueprintAndExisting');
      }
    })();

    const [, fetchedStudyPage, [blueprintTasksRaw, existingTasksRaw]] = await Promise.all([
      notionClient.reportStatus(
        studyPageId,
        'info',
        `Add Task Set started (${buttonType})...`,
        { tracer },
      ),
      fetchStudyPromise,
      fetchBlueprintAndExistingPromise,
    ]);
    studyPage = fetchedStudyPage;
    const blueprintTasks = blueprintTasksRaw || [];
    const existingTasks = existingTasksRaw || [];

    const contractSignDate = studyPage.properties?.['Contract Sign Date']?.date?.start
      || new Date().toISOString().split('T')[0];
    studyName = studyPage.properties?.['Study Name (Internal)']?.title?.[0]?.text?.content || 'Unknown Study';

    if (!blueprintTasks || blueprintTasks.length === 0) {
      await Promise.all([
        notionClient.reportStatus(studyPageId, 'error', 'No blueprint tasks found', { tracer }),
        activityLogService.logTerminalEvent({
          workflow: 'Add Task Set',
          status: 'failed',
          triggerType: 'Automation',
          triggeredByUserId,
          editedByBot,
          sourceTaskName: `${studyName} (${buttonType})`,
          studyId: studyPageId,
          summary: 'No blueprint tasks found',
        }),
        studyCommentService.postComment({
          workflow: 'Add Task Set',
          status: 'failed',
          studyId: studyPageId,
          sourceTaskName: `${studyName} (${buttonType})`,
          triggeredByUserId,
          editedByBot,
          summary: 'No blueprint tasks found',
        }).catch(() => {}),
      ]);
      return;
    }

    // Filter blueprint subtree based on parent task names
    tracer.startPhase('filterSubtree');
    const filteredLevels = filterBlueprintSubtree(blueprintTasks, parentTaskNames);
    tracer.endPhase('filterSubtree');

    if (filteredLevels.length === 0) {
      await Promise.all([
        notionClient.reportStatus(
          studyPageId,
          'error',
          `No matching blueprint tasks found for: ${parentTaskNames.join(', ')}`,
          { tracer },
        ),
        activityLogService.logTerminalEvent({
          workflow: 'Add Task Set',
          status: 'failed',
          triggerType: 'Automation',
          triggeredByUserId,
          editedByBot,
          sourceTaskName: `${studyName} (${buttonType})`,
          studyId: studyPageId,
          summary: `No matching blueprint subtree for: ${parentTaskNames.join(', ')}`,
        }),
        studyCommentService.postComment({
          workflow: 'Add Task Set',
          status: 'failed',
          studyId: studyPageId,
          sourceTaskName: `${studyName} (${buttonType})`,
          triggeredByUserId,
          editedByBot,
          summary: `No matching blueprint subtree for: ${parentTaskNames.join(', ')}`,
        }).catch(() => {}),
      ]);
      return;
    }

    // Set numbering for repeat-delivery
    let nextNum = null;
    if (isRepeatDelivery) {
      tracer.startPhase('resolveDeliveryNumber');
      nextNum = resolveNextDeliveryNumber(existingTasks);
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

    // Build templateId -> productionId mapping from existing tasks
    const existingIdMapping = {};
    for (const page of existingTasks) {
      const tsid = page.properties?.['Template Source ID']?.rich_text?.[0]?.plain_text
        || page.properties?.['Template Source ID']?.rich_text?.[0]?.text?.content;
      if (tsid && page.id) {
        existingIdMapping[tsid] = page.id;
      }
    }

    // Strip current subtree's template IDs from existingIdMapping so that
    // intra-set deps (e.g., Draft TLF → Internal Review within TLF #2) stay
    // unresolved during task creation and get wired to the NEW batch's tasks
    // by wireRemainingRelations, instead of pointing to inception's originals.
    const internalTemplateIds = new Set();
    for (const { tasks } of filteredLevels) {
      for (const task of tasks) internalTemplateIds.add(task._templateId);
    }
    for (const tid of internalTemplateIds) {
      delete existingIdMapping[tid];
    }
    tracer.set('external_deps_resolved', Object.keys(existingIdMapping).length);
    tracer.set('internal_template_ids_excluded', internalTemplateIds.size);

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

    // ── Post-create task set numbering ───────────────────────────────────
    // Uses pre-creation existingTasks (fetched above in fetchBlueprintAndExisting)
    // — only the count of tasks that existed before this operation matters.
    // count + 1 = next number. Per-study FIFO queue prevents concurrent
    // add-task-set operations, so the pre-creation count is authoritative.
    if (!isRepeatDelivery && parentTaskNames.length > 0) {
      tracer.startPhase('applyTaskSetNumbering');

      const numberMap = resolveTaskSetNumbers(existingTasks, filteredLevels);

      // PATCH-rename each parent page
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

    // Fire copy-blocks only for newly created tasks (exclude pre-existing ones).
    // Template IDs (keys) repeat across operations — filter by production IDs (values).
    const existingProductionIds = new Set(Object.values(existingIdMapping));
    const newIdMapping = {};
    for (const [templateId, productionId] of Object.entries(createResult.idMapping)) {
      if (!existingProductionIds.has(productionId)) {
        newIdMapping[templateId] = productionId;
      }
    }

    const successSummary = `Add Task Set complete (${buttonType}): ${createResult.totalCreated} tasks created, ${wireResult.parentsPatchedCount} parents wired, ${wireResult.depsPatchedCount} deps wired`;
    const commentSummary = `${buttonType} tasks added — ${createResult.totalCreated} tasks created`;

    await Promise.all([
      (async () => {
        tracer.startPhase('disableImportMode');
        try {
          return await notionClient.request('PATCH', `/pages/${studyPageId}`, {
            properties: { 'Import Mode': { checkbox: false } },
          }, { tracer });
        } finally {
          tracer.endPhase('disableImportMode');
        }
      })(),
      activityLogService.logTerminalEvent({
        workflow: 'Add Task Set',
        status: 'success',
        triggerType: 'Automation',
        triggeredByUserId,
        editedByBot,
        executionId: tracer.cascadeId,
        timestamp: new Date().toISOString(),
        cascadeMode: 'N/A',
        sourceTaskName: `${studyName} (${buttonType})`,
        studyId: studyPageId,
        summary: successSummary,
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
      }),
      notionClient.reportStatus(
        studyPageId,
        'success',
        `Add Task Set complete (${buttonType}): ${createResult.totalCreated} tasks created`,
        { tracer },
      ),
    ]);

    // Fire copy-blocks independently — don't block Import Mode disable or activity logging
    void copyBlocks(notionClient, newIdMapping, {
      studyPageId,
      studyName,
      tracer,
    }).catch(err => console.warn('[add-task-set] copy-blocks failed:', err.message));

    console.log(tracer.toConsoleLog());
  } catch (error) {
    console.error('[add-task-set] processing failed:', error);
    console.log(tracer.toConsoleLog());

    try {
      await Promise.all([
        notionClient.reportStatus(
          studyPageId,
          'error',
          `Add Task Set failed: ${String(error.message || error).slice(0, 200)}`,
          { tracer },
        ),
        activityLogService.logTerminalEvent({
          workflow: 'Add Task Set',
          status: 'failed',
          triggerType: 'Automation',
          triggeredByUserId,
          editedByBot,
          executionId: tracer.cascadeId,
          timestamp: new Date().toISOString(),
          cascadeMode: 'N/A',
          sourceTaskName: studyName ? `${studyName} (${buttonType})` : buttonType,
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
        }),
        studyCommentService.postComment({
          workflow: 'Add Task Set',
          status: 'failed',
          studyId: studyPageId,
          sourceTaskName: studyName ? `${studyName} (${buttonType})` : buttonType,
          triggeredByUserId,
          editedByBot,
          summary: `Failed to add ${buttonType} tasks: ${String(error.message || error).slice(0, 180)}`,
        }).catch(() => {}),
      ]);
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

// Per-study serialization — prevents concurrent add-task-set operations
// from racing on Notion's eventually-consistent database queries, which
// causes duplicate numbering (e.g., two "TLF #2" instead of #2 and #3).
const _studyLocks = new Map();

function withStudyLock(studyId, fn) {
  const prev = _studyLocks.get(studyId) || Promise.resolve();
  const next = prev.then(() => fn(), () => fn());
  _studyLocks.set(studyId, next);
  // Clean up lock entry; .catch suppresses the floating rejection since the
  // caller handles errors via the returned `next` promise.
  next.finally(() => {
    if (_studyLocks.get(studyId) === next) _studyLocks.delete(studyId);
  }).catch(() => {});
  return next;
}

export async function handleAddTaskSet(req, res) {
  res.status(200).json({ ok: true });
  const studyPageId = req.body?.data?.id || req.body?.studyPageId;
  const run = studyPageId
    ? withStudyLock(studyPageId, () => processAddTaskSet(req))
    : processAddTaskSet(req);
  flightTracker.track(
    run.catch(err => console.error('[add-task-set] unhandled:', err)),
    'add-task-set',
  );
}

// Exposed for test cleanup
export function _resetStudyLocks() { _studyLocks.clear(); }
