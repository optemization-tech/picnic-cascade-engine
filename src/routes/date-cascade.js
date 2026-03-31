import { config } from '../config.js';
import { parseWebhookPayload, isSystemModified, isImportMode, isFrozen } from '../gates/guards.js';
import { classify } from '../engine/classify.js';
import { runCascade } from '../engine/cascade.js';
import { runParentSubtask } from '../engine/parent-subtask.js';
import { enforceConstraints } from '../engine/constraints.js';
import { NotionClient } from '../notion/client.js';
import { queryStudyTasks } from '../notion/queries.js';

const notionClient = new NotionClient({ tokens: config.notion.tokens });
const DIRECT_PARENT_WARNING = '⚠️ This task has subtasks — edit a subtask directly to shift dates and trigger cascading.';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fireActivityLog(payload) {
  if (!config.activityLogWebhookUrl) return;
  try {
    await fetch(config.activityLogWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    console.warn('[date-cascade] activity log failed:', error.message);
  }
}

async function clearSourceLmbsOnSkip(taskId) {
  if (!taskId) return;
  try {
    await notionClient.patchPage(taskId, {
      'Last Modified By System': { checkbox: false },
    });
  } catch (error) {
    console.warn('[date-cascade] failed clearing LMBS on skip:', error.message);
  }
}

async function applyError1SideEffects(studyId) {
  if (!studyId) return;
  await notionClient.request('PATCH', `/pages/${studyId}`, {
    properties: {
      'Import Mode': { checkbox: false },
      'Automation Reporting': {
        rich_text: [{
          type: 'text',
          text: { content: DIRECT_PARENT_WARNING },
          annotations: { bold: true, color: 'red' },
        }],
      },
    },
  });
}

function buildUpdateProperties(update, sourceTaskName, cascadeMode) {
  return {
    'Last Modified By System': { checkbox: true },
    'Dates': { date: { start: update.newStart, end: update.newEnd } },
    'Reference Start Date': { date: { start: update.newReferenceStartDate || update.newStart } },
    'Reference End Date': { date: { start: update.newReferenceEndDate || update.newEnd } },
    'Automation Reporting': {
      rich_text: [{
        type: 'text',
        text: {
          content: update._reportingMsg || `❇️ ${cascadeMode || 'cascade'}: dates shifted (triggered by ${sourceTaskName})`,
        },
        annotations: { color: 'green_background' },
      }],
    },
  };
}

async function processDateCascade(payload) {
  const parsed = parseWebhookPayload(payload);
  if (parsed.skip) return;

  if (isSystemModified(parsed)) {
    await clearSourceLmbsOnSkip(parsed.taskId);
    return;
  }
  if (isImportMode(parsed)) return;
  if (isFrozen(parsed)) return;
  if (!parsed.hasDates) return;
  if (!parsed.studyId) return;

  try {
    await notionClient.reportStatus(parsed.studyId, 'info', `Cascade started for ${parsed.taskName}...`);

    const allTasks = await queryStudyTasks(notionClient, config.notion.studyTasksDbId, parsed.studyId);
    const classified = classify(parsed, allTasks, parsed.startDelta, parsed.endDelta);
    if (classified.skip || !classified.cascadeMode) {
      if (classified.reason?.includes('Direct parent edit blocked')) {
        await applyError1SideEffects(parsed.studyId);
      } else {
        await notionClient.reportStatus(parsed.studyId, 'warning', classified.reason || 'No cascade mode determined');
      }
      return;
    }

    const cascadeResult = runCascade({
      sourceTaskId: classified.sourceTaskId,
      sourceTaskName: classified.sourceTaskName,
      newStart: classified.newStart,
      newEnd: classified.newEnd,
      refStart: classified.refStart,
      refEnd: classified.refEnd,
      startDelta: classified.startDelta,
      endDelta: classified.endDelta,
      cascadeMode: classified.cascadeMode,
      tasks: allTasks,
    });

    const parentResult = runParentSubtask({
      sourceTaskId: classified.sourceTaskId,
      sourceTaskName: classified.sourceTaskName,
      newStart: classified.newStart,
      newEnd: classified.newEnd,
      parentTaskId: classified.parentTaskId,
      parentMode: classified.parentMode,
      movedTaskIds: cascadeResult.movedTaskIds,
      movedTaskMap: cascadeResult.movedTaskMap,
      tasks: allTasks,
    });

    const constrainedSource = enforceConstraints({
      task: {
        taskId: classified.sourceTaskId,
        refStart: classified.refStart,
        refEnd: classified.refEnd,
        newStart: classified.newStart,
        newEnd: classified.newEnd,
      },
      cascadeResult,
      parentResult,
      allTasks,
    });

    const sourceRollUp = (parentResult.updates || []).find(
      (u) => u.taskId === classified.sourceTaskId && u._isRollUp,
    );

    const updatesByTaskId = new Map();
    for (const u of cascadeResult.updates || []) updatesByTaskId.set(u.taskId, { ...u });
    for (const u of parentResult.updates || []) updatesByTaskId.set(u.taskId, { ...u });

    // Source task must have latest constrained + merged dates.
    updatesByTaskId.set(classified.sourceTaskId, {
      taskId: classified.sourceTaskId,
      taskName: classified.sourceTaskName,
      newStart: constrainedSource.newStart,
      newEnd: constrainedSource.newEnd,
      newReferenceStartDate: constrainedSource.newStart,
      newReferenceEndDate: constrainedSource.newEnd,
      _isRollUp: Boolean(sourceRollUp),
      _reportingMsg: `❇️ ${classified.cascadeMode} cascade: dates shifted (triggered by ${classified.sourceTaskName})`,
    });

    const updates = Array.from(updatesByTaskId.values());
    if (updates.length === 0) {
      await notionClient.reportStatus(parsed.studyId, 'info', `No updates needed for ${parsed.taskName}`);
      return;
    }

    const patchPayload = updates.map((u) => ({
      taskId: u.taskId,
      properties: buildUpdateProperties(u, classified.sourceTaskName, classified.cascadeMode),
    }));
    const patched = await notionClient.patchBatch(patchPayload, { batchSize: 3, interval: 1000 });

    // Immediate unlock pass skips roll-up tasks (WF-P parity).
    await sleep(3000);
    const unlockPayload = updates
      .filter((u) => !u._isRollUp)
      .map((u) => ({
        taskId: u.taskId,
        properties: { 'Last Modified By System': { checkbox: false } },
      }));
    if (unlockPayload.length > 0) {
      await notionClient.patchBatch(unlockPayload, { batchSize: 3, interval: 1000 });
    }

    await notionClient.reportStatus(
      parsed.studyId,
      'success',
      `Cascade complete for ${parsed.taskName}: ${classified.cascadeMode} (${patched.updatedCount} task updates)`,
    );

    await fireActivityLog({
      workflow: 'Date Cascade',
      triggerType: 'Automation',
      cascadeMode: classified.cascadeMode,
      sourceTaskId: parsed.taskId,
      sourceTaskName: parsed.taskName,
      studyId: parsed.studyId,
      status: 'Success',
      summary: `${classified.cascadeMode}: ${parsed.taskName}`,
      details: {
        parentMode: classified.parentMode,
        startDelta: classified.startDelta,
        endDelta: classified.endDelta,
        constrained: constrainedSource.constrained,
        merged: constrainedSource.merged,
        updatedCount: patched.updatedCount,
      },
      triggeredByUserId: parsed.triggeredByUserId,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    await notionClient.reportStatus(
      parsed.studyId,
      'error',
      `Cascade failed for ${parsed.taskName || 'task'}: ${String(error.message || error).slice(0, 200)}`,
    );
    throw error;
  } finally {
    try {
      await notionClient.clearStudyLmbsFlags({
        studyTasksDbId: config.notion.studyTasksDbId,
        studyId: parsed.studyId,
      });
    } catch (cleanupError) {
      console.warn('[date-cascade] study-wide LMBS cleanup failed:', cleanupError.message);
    }
  }
}

export async function handleDateCascade(req, res) {
  res.status(200).json({ ok: true });
  void processDateCascade(req.body).catch((error) => {
    console.error('[date-cascade] processing failed:', error);
  });
}
