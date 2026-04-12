import { config } from '../config.js';
import { parseWebhookPayload } from '../gates/guards.js';
import { computeStatusRollup } from '../engine/status-rollup.js';
import { cascadeClient as notionClient } from '../notion/clients.js';
import { normalizeTask } from '../notion/properties.js';
import { ActivityLogService } from '../services/activity-log.js';
import { flightTracker } from '../services/flight-tracker.js';
const activityLogService = new ActivityLogService({
  notionClient,
  activityLogDbId: config.notion.activityLogDbId,
});

function mapRollupStatusToNotion(status) {
  if (status === 'Not Started') return 'Not started';
  return status;
}

async function processStatusRollup(payload) {
  const parsed = parseWebhookPayload(payload);
  if (parsed.skip) return;

  // Fetch task and study in parallel (both are independent lookups)
  const [changedTaskPage, study] = await Promise.all([
    notionClient.getPage(parsed.taskId),
    parsed.studyId ? notionClient.getPage(parsed.studyId) : Promise.resolve(null),
  ]);

  const changedTask = normalizeTask(changedTaskPage);
  if (!changedTask.parentId || !changedTask.studyId) return;
  const hasSubtasks = (changedTaskPage?.properties?.['Subtask(s)']?.relation || []).length > 0;
  if (hasSubtasks) return;

  // Use pre-fetched study, or fetch if studyId wasn't in the parsed payload
  const studyPage = study || await notionClient.getPage(changedTask.studyId);
  if (studyPage?.properties?.['Import Mode']?.checkbox === true) return;

  const [parent, siblingPages] = await Promise.all([
    notionClient.getPage(changedTask.parentId),
    notionClient.queryDatabase(
      config.notion.studyTasksDbId,
      { property: 'Parent Task', relation: { contains: changedTask.parentId } },
      100,
    ),
  ]);

  const parentStatus = parent?.properties?.['Status']?.status?.name || 'Not started';
  const parentName = parent?.properties?.['Task Name']?.title?.[0]?.text?.content
    || parent?.properties?.['Task Name']?.title?.[0]?.plain_text
    || changedTask.parentId.substring(0, 8);

  const siblings = siblingPages.map(normalizeTask);
  const desiredStatus = mapRollupStatusToNotion(computeStatusRollup(siblings));

  if (desiredStatus === parentStatus) return;

  await notionClient.patchPage(changedTask.parentId, {
    'Status': { status: { name: desiredStatus } },
  });

  await activityLogService.logTerminalEvent({
    workflow: 'Status Roll-Up',
    triggerType: 'Automation',
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
    },
  });
}

export async function handleStatusRollup(req, res) {
  res.status(200).json({ ok: true });
  flightTracker.track(processStatusRollup(req.body).catch(async (error) => {
    console.error('[status-rollup] processing failed:', error);
    try {
      const parsed = parseWebhookPayload(req.body);
      if (parsed.studyId) {
        await notionClient.reportStatus(
          parsed.studyId,
          'error',
          `Status roll-up failed for ${parsed.taskName || 'task'}: ${String(error.message || error).slice(0, 200)}`,
        );
      }
    } catch {
      // Swallow nested reporting failures.
    }
  }), 'status-rollup');
}
