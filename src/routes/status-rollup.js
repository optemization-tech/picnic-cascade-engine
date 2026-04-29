import { config } from '../config.js';
import { parseWebhookPayload } from '../gates/guards.js';
import { computeStatusRollup } from '../engine/status-rollup.js';
import { cascadeClient as notionClient, commentClient } from '../notion/clients.js';
import { normalizeTask } from '../notion/properties.js';
import { ActivityLogService } from '../services/activity-log.js';
import { flightTracker } from '../services/flight-tracker.js';
import { STUDIES_PROPS, STUDY_TASKS_PROPS, findById } from '../notion/property-names.js';
// No StudyCommentService — status-rollup is a background child-triggered event, not user-facing.
const activityLogService = new ActivityLogService({
  notionClient: commentClient,
  activityLogDbId: config.notion.activityLogDbId,
});

function mapRollupStatusToNotion(status) {
  if (status === 'Not Started') return 'Not started';
  return status;
}

async function processStatusRollup(payload) {
  const startTime = Date.now();
  const parsed = parseWebhookPayload(payload);
  if (parsed.skip) return;

  // Fetch task and study in parallel (both are independent lookups)
  const [changedTaskPage, study] = await Promise.all([
    notionClient.getPage(parsed.taskId),
    parsed.studyId ? notionClient.getPage(parsed.studyId) : Promise.resolve(null),
  ]);

  const changedTask = normalizeTask(changedTaskPage);
  if (!changedTask.studyId) return;

  // Import Mode skip applies to both the parent-direct branch and the
  // subtask-triggered branch below. Studies DB stores it as a checkbox.
  const studyPage = study || await notionClient.getPage(changedTask.studyId);
  if (findById(studyPage, STUDIES_PROPS.IMPORT_MODE)?.checkbox === true) return;

  // Hot-loop reshape (per plan U2): the changed task page is read for
  // 2 properties below; reshape once.
  const changedById = Object.create(null);
  for (const value of Object.values(changedTaskPage?.properties || {})) {
    if (value && value.id) changedById[value.id] = value;
  }

  const hasSubtasks = (changedById[STUDY_TASKS_PROPS.SUBTASKS.id]?.relation || []).length > 0;

  // Branch 1: parent-direct status edit. When the edited task has its own
  // subtasks, compute its status from those children and snap back if the
  // manual value disagrees. Keeps parent in sync with subtasks both
  // directions (Meg-confirmed 2026-04-22).
  if (hasSubtasks) {
    // Bot-echo skip: the patch below emits a new "Status changes" webhook
    // with editedByBot=true. Without this skip, each parent-direct edit
    // amplifies into repeated reads even though the value is idempotent.
    if (parsed.editedByBot) return;

    // Fetch the edited task's own children.
    const childrenPages = await notionClient.queryDatabase(
      config.notion.studyTasksDbId,
      { property: STUDY_TASKS_PROPS.PARENT_TASK.id, relation: { contains: changedTask.id } },
      100,
    );

    // Stale-relation guard: if Subtask(s) relation claims children exist
    // but the query returns none (deleted pages), skip -- otherwise we
    // would silently snap a Done parent to Not Started based on stale data.
    if (childrenPages.length === 0) {
      console.log(JSON.stringify({
        event: 'status_rollup_stale_relation_skip',
        taskId: changedTask.id,
        taskName: changedTask.name,
        studyId: changedTask.studyId,
      }));
      return;
    }

    const children = childrenPages.map(normalizeTask);
    const desiredStatus = mapRollupStatusToNotion(computeStatusRollup(children));
    const currentStatus = changedById[STUDY_TASKS_PROPS.STATUS.id]?.status?.name || 'Not started';

    if (desiredStatus === currentStatus) return;

    await notionClient.patchPage(changedTask.id, {
      [STUDY_TASKS_PROPS.STATUS.id]: { status: { name: desiredStatus } },
    });

    await activityLogService.logTerminalEvent({
      workflow: 'Status Roll-Up',
      triggerType: 'Automation',
      cascadeMode: 'status-rollup',
      executionId: parsed?.executionId || null,
      timestamp: new Date().toISOString(),
      triggeredByUserId: parsed?.triggeredByUserId || null,
      editedByBot: parsed?.editedByBot || false,
      sourceTaskId: changedTask.id,
      sourceTaskName: changedTask.name,
      studyId: changedTask.studyId,
      status: 'success',
      summary: `Parent ${changedTask.name} status corrected: ${currentStatus} -> ${desiredStatus} (direct edit blocked)`,
      details: {
        parentId: changedTask.id,
        parentName: changedTask.name,
        oldStatus: currentStatus,
        newStatus: desiredStatus,
        subtaskCount: children.length,
        direction: 'parent-direct',
        timing: { totalMs: Date.now() - startTime },
      },
    });
    return;
  }

  // Branch 2: leaf subtask -> parent rollup (existing behavior).
  if (!changedTask.parentId) return;

  // Hot-loop reshape: parent-collection sweep reads 2 properties from `parent`.
  const [parent, siblingPages] = await Promise.all([
    notionClient.getPage(changedTask.parentId),
    notionClient.queryDatabase(
      config.notion.studyTasksDbId,
      { property: STUDY_TASKS_PROPS.PARENT_TASK.id, relation: { contains: changedTask.parentId } },
      100,
    ),
  ]);

  const parentById = Object.create(null);
  for (const value of Object.values(parent?.properties || {})) {
    if (value && value.id) parentById[value.id] = value;
  }
  const parentStatus = parentById[STUDY_TASKS_PROPS.STATUS.id]?.status?.name || 'Not started';
  const parentTitleArr = parentById[STUDY_TASKS_PROPS.TASK_NAME.id]?.title || [];
  const parentName = parentTitleArr[0]?.text?.content
    || parentTitleArr[0]?.plain_text
    || changedTask.parentId.substring(0, 8);

  const siblings = siblingPages.map(normalizeTask);
  const desiredStatus = mapRollupStatusToNotion(computeStatusRollup(siblings));

  if (desiredStatus === parentStatus) return;

  await notionClient.patchPage(changedTask.parentId, {
    [STUDY_TASKS_PROPS.STATUS.id]: { status: { name: desiredStatus } },
  });

  await activityLogService.logTerminalEvent({
    workflow: 'Status Roll-Up',
    triggerType: 'Automation',
    cascadeMode: 'status-rollup',
    executionId: parsed?.executionId || null,
    timestamp: new Date().toISOString(),
    triggeredByUserId: parsed?.triggeredByUserId || null,
    editedByBot: parsed?.editedByBot || false,
    sourceTaskId: changedTask.id,
    sourceTaskName: changedTask.name,
    studyId: changedTask.studyId,
    status: 'success',
    summary: `Parent ${parentName} status -> ${desiredStatus} (triggered by ${changedTask.name})`,
    details: {
      parentId: changedTask.parentId,
      parentName,
      oldStatus: parentStatus,
      newStatus: desiredStatus,
      subtaskCount: siblings.length,
      direction: 'subtask-triggered',
      timing: { totalMs: Date.now() - startTime },
    },
  });
}

export async function handleStatusRollup(req, res) {
  res.status(200).json({ ok: true });
  flightTracker.track(processStatusRollup(req.body).catch(async (error) => {
    console.error('[status-rollup] processing failed:', error);
    try {
      const parsed = parseWebhookPayload(req.body);
      // Task-scoped error reporting matches the date-cascade lifecycle
      // pattern (Unit 3) so PMs see per-task failure states. Falls back
      // to studyId only if taskId is unavailable.
      const targetId = parsed?.taskId || parsed?.studyId;
      if (targetId) {
        await notionClient.reportStatus(
          targetId,
          'error',
          `Status roll-up failed for ${parsed.taskName || 'task'}: ${String(error.message || error).slice(0, 200)}`,
        );
      }
    } catch (reportErr) {
      // Swallow nested reporting failures (e.g., task deleted -> 404)
      // but log them so the secondary failure is observable at scale.
      // The primary error was already console.error'd above.
      console.warn('[status-rollup] error reportStatus failed:', reportErr?.message || reportErr);
    }
  }), 'status-rollup');
}
