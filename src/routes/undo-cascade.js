import { config } from '../config.js';
import { cascadeClient as notionClient } from '../notion/clients.js';
import { ActivityLogService } from '../services/activity-log.js';
import { StudyCommentService } from '../services/study-comment.js';
import { undoStore } from '../services/undo-store.js';
import { cascadeQueue } from '../services/cascade-queue.js';
const activityLogService = new ActivityLogService({
  notionClient,
  activityLogDbId: config.notion.activityLogDbId,
});
const studyCommentService = new StudyCommentService({ notionClient });

async function processUndoCascade(payload) {
  const startTime = Date.now();
  console.log('[undo-cascade] raw payload:', JSON.stringify(payload).slice(0, 500));
  const studyId = payload?.data?.studyId || payload?.studyId || payload?.data?.id || payload?.source?.id;
  if (!studyId) {
    console.warn('[undo-cascade] no studyId in payload, skipping');
    return;
  }

  // Button automation payloads include last_edited_by — the user who clicked.
  const triggeredByUserId = payload?.data?.last_edited_by?.id || payload?.source?.last_edited_by?.id || null;
  const editedByBot = (payload?.data?.last_edited_by?.type || payload?.source?.last_edited_by?.type) === 'bot';

  const entry = undoStore.peek(studyId);
  if (!entry) {
    await notionClient.reportStatus(studyId, 'warning', 'No recent cascade to undo (expired or already undone)');
    await activityLogService.logTerminalEvent({
      workflow: 'Undo Cascade',
      status: 'no_action',
      triggerType: 'Manual',
      triggeredByUserId,
      editedByBot,
      studyId,
      summary: 'Undo requested but no recent cascade available',
      details: { noActionReason: 'no_undo_available' },
    });
    try {
      await studyCommentService.postComment({
        workflow: 'Undo Cascade',
        status: 'no_action',
        forceComment: true,
        studyId,
        sourceTaskName: 'N/A',
        triggeredByUserId,
        editedByBot,
        summary: 'No recent cascade to undo (expired or already undone)',
      });
    } catch { /* comment failure must not break route */ }
    // Disable Import Mode even on the no-op path — the Notion button automation
    // sets it ON before firing the webhook regardless of whether an undo entry exists.
    try {
      await notionClient.request('PATCH', `/pages/${studyId}`, {
        properties: { 'Import Mode': { checkbox: false } },
      });
    } catch { /* best-effort — startup sweep will catch it */ }
    return;
  }

  const { manifest, cascadeId, sourceTaskName, cascadeMode } = entry;
  const taskIds = Object.keys(manifest);

  try {
    await notionClient.reportStatus(studyId, 'info', `Undoing cascade for ${sourceTaskName}...`);

    // Restore old dates + reference in one pass.
    // Echo webhooks will have zero delta (dates match reference) and be skipped.
    const restorePayload = taskIds.map((taskId) => ({
      taskId,
      properties: {
        'Dates': { date: { start: manifest[taskId].oldStart, end: manifest[taskId].oldEnd } },
        'Reference Start Date': { date: { start: manifest[taskId].oldStart } },
        'Reference End Date': { date: { start: manifest[taskId].oldEnd } },
        'Automation Reporting': {
          rich_text: [{
            type: 'text',
            text: { content: `↩️ Undo: dates restored (reverting ${cascadeMode} cascade)` },
            annotations: { color: 'yellow_background' },
          }],
        },
      },
    }));
    // Sort by ascending start date so top-of-timeline tasks restore first.
    // String() coercion is defense-in-depth: if a non-string ever sneaks into the manifest
    // (see 2026-04-13 incident: Date objects threw .localeCompare), the sort degrades gracefully.
    const startKey = (p) => String(p.properties['Dates'].date.start ?? '');
    restorePayload.sort((a, b) => startKey(a).localeCompare(startKey(b)));
    await notionClient.patchPages(restorePayload);

    // Only consume the undo entry after successful restore.
    // If patchPages fails mid-batch, the entry stays available for retry.
    undoStore.pop(studyId);

    // Disable Import Mode — the Notion button automation sets it ON before firing the webhook.
    // Without this, subsequent user edits hit import_mode_skip. (2026-04-14 prod incident)
    await notionClient.request('PATCH', `/pages/${studyId}`, {
      properties: { 'Import Mode': { checkbox: false } },
    });

    await notionClient.reportStatus(
      studyId,
      'success',
      `Undo complete: restored ${taskIds.length} tasks to pre-cascade dates`,
    );

    await activityLogService.logTerminalEvent({
      workflow: 'Undo Cascade',
      status: 'success',
      triggerType: 'Manual',
      triggeredByUserId,
      editedByBot,
      sourceTaskId: entry.sourceTaskId || null,
      sourceTaskName,
      cascadeMode,
      studyId,
      summary: `Undo: ${cascadeMode} cascade for ${sourceTaskName} reversed (${taskIds.length} tasks restored)`,
      details: {
        undoCascadeId: cascadeId,
        restoredCount: taskIds.length,
        cascadeMode,
        sourceTaskName,
        timing: { totalMs: Date.now() - startTime },
      },
    });
    try {
      await studyCommentService.postComment({
        workflow: 'Undo Cascade',
        status: 'success',
        studyId,
        sourceTaskName,
        triggeredByUserId,
        editedByBot,
        summary: `Undo complete: restored ${taskIds.length} ${taskIds.length === 1 ? 'task' : 'tasks'} to pre-cascade dates`,
      });
    } catch { /* comment failure must not break route */ }
  } catch (error) {
    console.error('[undo-cascade] processing failed:', error);
    try {
      await notionClient.reportStatus(
        studyId,
        'error',
        `Undo failed: ${String(error.message || error).slice(0, 200)}`,
      );
    } catch { /* don't mask original error */ }
    try {
      await activityLogService.logTerminalEvent({
        workflow: 'Undo Cascade',
        status: 'failed',
        triggerType: 'Manual',
        triggeredByUserId,
        editedByBot,
        sourceTaskId: entry.sourceTaskId || null,
        sourceTaskName,
        cascadeMode,
        studyId,
        summary: `Undo failed: ${String(error.message || error).slice(0, 180)}`,
        details: { timing: { totalMs: Date.now() - startTime } },
      });
    } catch { /* don't mask original error */ }
    try {
      await studyCommentService.postComment({
        workflow: 'Undo Cascade',
        status: 'failed',
        studyId,
        sourceTaskName,
        triggeredByUserId,
        editedByBot,
        summary: `Undo failed: ${String(error.message || error).slice(0, 180)}`,
      });
    } catch { /* comment failure must not mask original error */ }
    throw error;
  } finally {
    // Critical: always disable Import Mode — leaving it on blocks all cascades.
    // Matches the pattern in inception.js and add-task-set.js.
    try {
      await notionClient.request('PATCH', `/pages/${studyId}`, {
        properties: { 'Import Mode': { checkbox: false } },
      });
    } catch (cleanupError) {
      console.warn('[undo-cascade] failed to disable Import Mode in finally:', cleanupError.message);
    }
  }
}

function parseUndoPayload(payload) {
  const studyId = payload?.data?.studyId || payload?.studyId || payload?.data?.id || payload?.source?.id;
  return { skip: false, taskId: '__undo__', studyId };
}

export async function handleUndoCascade(req, res) {
  res.status(200).json({ ok: true });
  cascadeQueue.enqueue(req.body, parseUndoPayload, processUndoCascade);
}
