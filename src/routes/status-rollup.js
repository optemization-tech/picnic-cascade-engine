import { config } from '../config.js';
import { parseWebhookPayload, isSystemModified } from '../gates/guards.js';
import { computeStatusRollup } from '../engine/status-rollup.js';
import { NotionClient } from '../notion/client.js';
import { normalizeTask } from '../notion/properties.js';

const notionClient = new NotionClient({ tokens: config.notion.tokens });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mapRollupStatusToNotion(status) {
  if (status === 'Not Started') return 'Not started';
  return status;
}

async function processStatusRollup(payload) {
  const parsed = parseWebhookPayload(payload);
  if (parsed.skip) return;
  if (isSystemModified(parsed)) return;

  // Fetch changed task to ensure parent/study are current.
  const changedTaskPage = await notionClient.getPage(parsed.taskId);
  const changedTask = normalizeTask(changedTaskPage);
  if (!changedTask.parentId || !changedTask.studyId) return;
  if (changedTask.lastModifiedBySystem) return;

  const study = await notionClient.getPage(changedTask.studyId);
  if (study?.properties?.['Import Mode']?.checkbox === true) return;

  const parent = await notionClient.getPage(changedTask.parentId);
  const parentStatus = parent?.properties?.['Status']?.status?.name || 'Not started';
  const parentName = parent?.properties?.['Task Name']?.title?.[0]?.text?.content
    || parent?.properties?.['Task Name']?.title?.[0]?.plain_text
    || changedTask.parentId.substring(0, 8);

  const siblingPages = await notionClient.queryDatabase(
    config.notion.studyTasksDbId,
    { property: 'Parent Task', relation: { contains: changedTask.parentId } },
    100,
  );
  const siblings = siblingPages.map(normalizeTask);
  const desiredStatus = mapRollupStatusToNotion(computeStatusRollup(siblings));

  if (desiredStatus === parentStatus) return;

  await notionClient.patchPage(changedTask.parentId, {
    'Status': { status: { name: desiredStatus } },
    'Last Modified By System': { checkbox: true },
  });

  await sleep(3000);
  await notionClient.patchPage(changedTask.parentId, {
    'Last Modified By System': { checkbox: false },
  });

  if (config.activityLogWebhookUrl) {
    try {
      await fetch(config.activityLogWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workflow: 'Status Roll-Up',
          triggerType: 'Automation',
          sourceTaskId: changedTask.id,
          sourceTaskName: changedTask.name,
          studyId: changedTask.studyId,
          status: 'Success',
          summary: `Parent ${parentName} status -> ${desiredStatus} (triggered by ${changedTask.name})`,
          details: {
            parentId: changedTask.parentId,
            parentName,
            oldStatus: parentStatus,
            newStatus: desiredStatus,
            subtaskCount: siblings.length,
          },
          triggeredByUserId: parsed.triggeredByUserId,
          timestamp: new Date().toISOString(),
        }),
      });
    } catch (error) {
      console.warn('[status-rollup] activity log failed:', error.message);
    }
  }
}

export async function handleStatusRollup(req, res) {
  res.status(200).json({ ok: true });
  void processStatusRollup(req.body).catch(async (error) => {
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
  });
}
