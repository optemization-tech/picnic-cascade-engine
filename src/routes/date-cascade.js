import { config } from '../config.js';
import { parseWebhookPayload, isImportMode, isFrozen } from '../gates/guards.js';
import { classify } from '../engine/classify.js';
import { runCascade } from '../engine/cascade.js';
import { runParentSubtask } from '../engine/parent-subtask.js';
import { enforceConstraints } from '../engine/constraints.js';
import { NotionClient } from '../notion/client.js';
import { queryStudyTasks } from '../notion/queries.js';
import { ActivityLogService } from '../services/activity-log.js';
import { CascadeTracer } from '../services/cascade-tracer.js';
import { cascadeQueue } from '../services/cascade-queue.js';
import { undoStore } from '../services/undo-store.js';

const notionClient = new NotionClient({ tokens: config.notion.tokens });
const activityLogService = new ActivityLogService({
  notionClient,
  activityLogDbId: config.notion.activityLogDbId,
});
const DIRECT_PARENT_WARNING = '⚠️ This task has subtasks — edit a subtask directly to shift dates and trigger cascading.';

function summarizeFailure(error) {
  return `Cascade failed: ${String(error?.message || error || 'Unknown error').slice(0, 180)}`;
}

function buildActivityDetails({ parsed, classified, patched, constrainedSource, cascadeResult, error, noActionReason, tracer }) {
  const diagnostics = cascadeResult?.diagnostics || {};
  const base = {
    parentMode: classified?.parentMode || null,
    movement: {
      updatedCount: patched?.updatedCount ?? 0,
      movedTaskIds: cascadeResult?.movedTaskIds || [],
      startDeltaBusinessDays: classified?.startDelta ?? parsed?.startDelta ?? null,
      endDeltaBusinessDays: classified?.endDelta ?? parsed?.endDelta ?? null,
    },
    sourceDates: {
      originalStart: parsed?.refStart || null,
      originalEnd: parsed?.refEnd || null,
      modifiedStart: constrainedSource?.newStart || parsed?.newStart || null,
      modifiedEnd: constrainedSource?.newEnd || parsed?.newEnd || null,
    },
    crossChain: {
      capHit: Boolean(diagnostics.capReached),
      residueCount: Array.isArray(diagnostics.unresolvedResidue) ? diagnostics.unresolvedResidue.length : 0,
      residueExamples: Array.isArray(diagnostics.unresolvedResidue)
        ? diagnostics.unresolvedResidue.slice(0, 5).map((taskId) => ({ taskId, reason: 'cap_unresolved' }))
        : [],
      clampedEdges: Array.isArray(diagnostics.clampedEdges) ? diagnostics.clampedEdges : [],
    },
    validation: {
      constraintFixCount: diagnostics.constraintFixCount || 0,
      constraintFixTaskIds: diagnostics.constraintFixTaskIds || [],
    },
    error: error
      ? {
        errorCode: error.code || null,
        errorMessage: String(error.message || error).slice(0, 400),
        phase: error.phase || 'date-cascade',
      }
      : { errorCode: null, errorMessage: null, phase: null },
    noActionReason: noActionReason || null,
    constrained: constrainedSource?.constrained ?? null,
    merged: constrainedSource?.merged ?? null,
  };
  if (tracer) Object.assign(base, tracer.toActivityLogDetails());
  return base;
}

async function logTerminalEvent({
  parsed,
  classified,
  status,
  summary,
  patched,
  constrainedSource,
  cascadeResult,
  noActionReason,
  error,
  tracer,
}) {
  await activityLogService.logTerminalEvent({
    workflow: 'Date Cascade',
    status,
    triggerType: 'Automation',
    executionId: parsed?.executionId || null,
    timestamp: new Date().toISOString(),
    cascadeMode: classified?.cascadeMode || 'N/A',
    sourceTaskId: parsed?.taskId || null,
    sourceTaskName: parsed?.taskName || null,
    studyId: parsed?.studyId || null,
    triggeredByUserId: parsed?.triggeredByUserId || null,
    summary,
    details: buildActivityDetails({
      parsed,
      classified,
      patched,
      constrainedSource,
      cascadeResult,
      noActionReason,
      error,
      tracer,
    }),
  });
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

  const tracer = new CascadeTracer(parsed.executionId);
  tracer.set('task_name', parsed.taskName);
  tracer.set('task_id', parsed.taskId);
  tracer.set('study_id', parsed.studyId);

  if (parsed.startDelta === 0 && parsed.endDelta === 0) {
    console.log(JSON.stringify({ event: 'zero_delta_skip', cascadeId: tracer.cascadeId, taskName: parsed.taskName, taskId: parsed.taskId }));
    return;
  }
  if (isImportMode(parsed)) {
    tracer.count('import_mode_skip');
    console.log(JSON.stringify({ event: 'import_mode_skip', cascadeId: tracer.cascadeId, taskName: parsed.taskName, taskId: parsed.taskId }));
    return;
  }
  if (isFrozen(parsed)) {
    await logTerminalEvent({
      parsed,
      status: 'no_action',
      summary: `No action: ${parsed.taskName || 'task'} is in a frozen status`,
      noActionReason: 'frozen_status',
      tracer,
    });
    return;
  }
  if (!parsed.hasDates) {
    await logTerminalEvent({
      parsed,
      status: 'no_action',
      summary: `No action: ${parsed.taskName || 'task'} has no dates`,
      noActionReason: 'missing_dates',
      tracer,
    });
    return;
  }
  if (!parsed.studyId) {
    await logTerminalEvent({
      parsed,
      status: 'no_action',
      summary: `No action: ${parsed.taskName || 'task'} is missing Study relation`,
      noActionReason: 'missing_study',
      tracer,
    });
    return;
  }

  try {
    await notionClient.reportStatus(parsed.studyId, 'info', `Cascade started for ${parsed.taskName}...`, { tracer });

    tracer.startPhase('query');
    const allTasks = await queryStudyTasks(notionClient, config.notion.studyTasksDbId, parsed.studyId, { tracer });
    tracer.endPhase('query');
    tracer.set('study_task_count', allTasks.length);

    // Snapshot pre-cascade dates for undo capability.
    // allTasks has current dates for all downstream tasks (only source has changed).
    const preSnapshot = new Map();
    for (const t of allTasks) {
      preSnapshot.set(t.id, { start: t.start, end: t.end, refStart: t.refStart, refEnd: t.refEnd });
    }
    // Source task's pre-edit dates come from webhook payload (allTasks already has the new edit)
    preSnapshot.set(parsed.taskId, {
      start: parsed.refStart, end: parsed.refEnd,
      refStart: parsed.refStart, refEnd: parsed.refEnd,
    });

    tracer.startPhase('classify');
    const classified = classify(parsed, allTasks, parsed.startDelta, parsed.endDelta);
    tracer.endPhase('classify');
    tracer.set('cascade_mode', classified.cascadeMode);

    if (classified.skip || !classified.cascadeMode) {
      if (classified.reason?.includes('Direct parent edit blocked')) {
        await applyError1SideEffects(parsed.studyId);
      } else {
        await notionClient.reportStatus(parsed.studyId, 'warning', classified.reason || 'No cascade mode determined', { tracer });
      }
      console.log(tracer.toConsoleLog());
      await logTerminalEvent({
        parsed,
        classified,
        status: 'no_action',
        summary: `No action: ${classified.reason || 'No cascade mode determined'}`,
        noActionReason: classified.reason || 'no_cascade_mode',
        tracer,
      });
      return;
    }

    tracer.startPhase('cascade');
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
    tracer.endPhase('cascade');

    tracer.startPhase('parentSubtask');
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
    tracer.endPhase('parentSubtask');

    tracer.startPhase('constraints');
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
    tracer.endPhase('constraints');

    tracer.startPhase('merge');
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
    tracer.endPhase('merge');

    if (updates.length === 0) {
      await notionClient.reportStatus(parsed.studyId, 'info', `No updates needed for ${parsed.taskName}`, { tracer });
      tracer.set('update_count', 0);
      console.log(tracer.toConsoleLog());
      await logTerminalEvent({
        parsed,
        classified,
        status: 'no_action',
        summary: `No action: no updates needed for ${parsed.taskName}`,
        patched: { updatedCount: 0 },
        constrainedSource,
        cascadeResult,
        noActionReason: 'zero_updates',
        tracer,
      });
      return;
    }

    const patchPayload = updates.map((u) => ({
      taskId: u.taskId,
      properties: buildUpdateProperties(u, classified.sourceTaskName, classified.cascadeMode),
    }));

    tracer.startPhase('patchUpdates');
    const patched = await notionClient.patchBatch(patchPayload, { tracer });
    tracer.endPhase('patchUpdates');

    tracer.startPhase('reportComplete');
    await notionClient.reportStatus(
      parsed.studyId,
      'success',
      `Cascade complete for ${parsed.taskName}: ${classified.cascadeMode} (${patched.updatedCount} task updates)`,
      { tracer },
    );
    tracer.endPhase('reportComplete');

    const capReached = Boolean(cascadeResult?.diagnostics?.capReached);
    const residueCount = Array.isArray(cascadeResult?.diagnostics?.unresolvedResidue)
      ? cascadeResult.diagnostics.unresolvedResidue.length
      : 0;

    tracer.set('update_count', patched.updatedCount);
    console.log(tracer.toConsoleLog());

    tracer.startPhase('logTerminal');
    await logTerminalEvent({
      parsed,
      classified,
      status: capReached ? 'failed' : 'success',
      summary: capReached
        ? `Cascade unresolved after safety cap for ${parsed.taskName} (${residueCount} residue task(s))`
        : `${classified.cascadeMode}: ${parsed.taskName} (${patched.updatedCount} updates)`,
      patched,
      constrainedSource,
      cascadeResult,
      noActionReason: null,
      tracer,
    });
    tracer.endPhase('logTerminal');

    // Save undo manifest — only for successful cascades that actually moved tasks
    if (!capReached && updates.length > 0) {
      const undoManifest = {};
      for (const u of updates) {
        const pre = preSnapshot.get(u.taskId);
        if (pre) {
          undoManifest[u.taskId] = {
            oldStart: pre.start,
            oldEnd: pre.end,
            newStart: u.newStart,
            newEnd: u.newEnd,
          };
        }
      }
      undoStore.save(parsed.studyId, {
        cascadeId: tracer.cascadeId,
        sourceTaskId: classified.sourceTaskId,
        sourceTaskName: classified.sourceTaskName,
        cascadeMode: classified.cascadeMode,
        manifest: undoManifest,
      });
    }
  } catch (error) {
    console.log(tracer.toConsoleLog());
    try {
      await notionClient.reportStatus(
        parsed.studyId,
        'error',
        `Cascade failed for ${parsed.taskName || 'task'}: ${String(error.message || error).slice(0, 200)}`,
        { tracer },
      );
    } catch { /* don't mask original error */ }
    try {
      await logTerminalEvent({
        parsed,
        status: 'failed',
        summary: summarizeFailure(error),
        noActionReason: null,
        error,
        tracer,
      });
    } catch { /* don't mask original error */ }
    throw error;
  }
}

export async function handleDateCascade(req, res) {
  res.status(200).json({ ok: true });
  cascadeQueue.enqueue(req.body, parseWebhookPayload, processDateCascade);
}
