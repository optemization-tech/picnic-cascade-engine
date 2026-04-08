import { config } from '../../config.js';
import { parseWebhookPayload, isImportMode, isFrozen } from '../../gates/guards.js';
import { classify } from '../engine/classify.js';
import { runCascade } from '../../engine/cascade.js';
import { enforceConstraints } from '../../engine/constraints.js';
import { computeSubtaskUpdates } from '../engine/subtask-fanout.js';
import { NotionClient } from '../../notion/client.js';
import { queryStudyTasks } from '../../notion/queries.js';
import { ActivityLogService } from '../../services/activity-log.js';
import { CascadeTracer } from '../../services/cascade-tracer.js';
import { cascadeQueue } from '../../services/cascade-queue.js';

const notionClient = new NotionClient({ tokens: config.notion.tokens });
const activityLogService = new ActivityLogService({
  notionClient,
  activityLogDbId: config.notion.activityLogDbId,
});

function summarizeFailure(error) {
  return `V2 Cascade failed: ${String(error?.message || error || 'Unknown error').slice(0, 180)}`;
}

function buildActivityDetails({ parsed, classified, patched, constrainedSource, cascadeResult, subtaskUpdateCount, error, noActionReason, tracer }) {
  const diagnostics = cascadeResult?.diagnostics || {};
  const base = {
    parentMode: null, // V2: no parent mode
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
    subtaskFanout: {
      subtaskUpdateCount: subtaskUpdateCount || 0,
    },
    error: error
      ? {
        errorCode: error.code || null,
        errorMessage: String(error.message || error).slice(0, 400),
        phase: error.phase || 'v2-date-cascade',
      }
      : { errorCode: null, errorMessage: null, phase: null },
    noActionReason: noActionReason || null,
    constrained: constrainedSource?.constrained ?? null,
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
  subtaskUpdateCount,
  noActionReason,
  error,
  tracer,
}) {
  await activityLogService.logTerminalEvent({
    workflow: 'V2 Date Cascade',
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
      subtaskUpdateCount,
      noActionReason,
      error,
      tracer,
    }),
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
          content: update._reportingMsg || `❇️ V2 ${cascadeMode || 'cascade'}: dates shifted (triggered by ${sourceTaskName})`,
        },
        annotations: { color: 'green_background' },
      }],
    },
  };
}

async function processDateCascade(payload) {
  // Phase 1: Parse & Guard
  const parsed = parseWebhookPayload(payload);
  if (parsed.skip) return;

  const tracer = new CascadeTracer(parsed.executionId);
  tracer.set('task_name', parsed.taskName);
  tracer.set('task_id', parsed.taskId);
  tracer.set('study_id', parsed.studyId);
  tracer.set('engine_version', 'v2');

  if (parsed.startDelta === 0 && parsed.endDelta === 0) {
    console.log(JSON.stringify({ event: 'v2_zero_delta_skip', cascadeId: tracer.cascadeId, taskName: parsed.taskName, taskId: parsed.taskId }));
    return;
  }
  if (isImportMode(parsed)) {
    tracer.count('import_mode_skip');
    console.log(JSON.stringify({ event: 'v2_import_mode_skip', cascadeId: tracer.cascadeId, taskName: parsed.taskName, taskId: parsed.taskId }));
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
    await notionClient.reportStatus(parsed.studyId, 'info', `V2 Cascade started for ${parsed.taskName}...`, { tracer });

    // Phase 2: Query all tasks, filter to parents for cascade
    tracer.startPhase('query');
    const allTasks = await queryStudyTasks(notionClient, config.notion.studyTasksDbId, parsed.studyId, { tracer });
    tracer.endPhase('query');
    tracer.set('study_task_count', allTasks.length);

    const parentTasks = allTasks.filter((t) => !t.parentId);
    tracer.set('parent_task_count', parentTasks.length);

    // Phase 3: Classify (V2 — no parent guard, no parentMode)
    tracer.startPhase('classify');
    const classified = classify(parsed, parentTasks, parsed.startDelta, parsed.endDelta);
    tracer.endPhase('classify');
    tracer.set('cascade_mode', classified.cascadeMode);

    if (classified.skip || !classified.cascadeMode) {
      await notionClient.reportStatus(parsed.studyId, 'warning', classified.reason || 'No cascade mode determined', { tracer });
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

    // Phase 4: Cascade on parent-only graph (shared runCascade)
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
      tasks: parentTasks,
    });
    tracer.endPhase('cascade');

    // Phase 5: Constraints on source (no case-a merge — parentResult=null)
    // Runs BEFORE fan-out so subtask dates use the constrained source start.
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
      parentResult: null,
      allTasks: parentTasks,
    });
    tracer.endPhase('constraints');

    // Phase 6: Subtask fan-out (V2 — replaces runParentSubtask)
    // Uses constrained source dates so subtasks align with final parent position.
    tracer.startPhase('subtaskFanout');
    const allMovedParentIds = [classified.sourceTaskId, ...cascadeResult.movedTaskIds];
    const subtaskResult = computeSubtaskUpdates({
      movedParentIds: allMovedParentIds,
      movedParentMap: {
        [classified.sourceTaskId]: { newStart: constrainedSource.newStart, newEnd: constrainedSource.newEnd },
        ...cascadeResult.movedTaskMap,
      },
      allTasks,
    });
    tracer.endPhase('subtaskFanout');
    tracer.set('subtask_update_count', subtaskResult.updates.length);

    // Phase 7: Merge parent cascade + subtask fan-out updates
    tracer.startPhase('merge');
    const updatesByTaskId = new Map();

    // Cascade updates (moved parent tasks)
    for (const u of cascadeResult.updates || []) updatesByTaskId.set(u.taskId, { ...u });

    // Source task with constrained dates
    updatesByTaskId.set(classified.sourceTaskId, {
      taskId: classified.sourceTaskId,
      taskName: classified.sourceTaskName,
      newStart: constrainedSource.newStart,
      newEnd: constrainedSource.newEnd,
      newReferenceStartDate: constrainedSource.newStart,
      newReferenceEndDate: constrainedSource.newEnd,
      _reportingMsg: `❇️ V2 ${classified.cascadeMode} cascade: dates shifted (triggered by ${classified.sourceTaskName})`,
    });

    // Subtask fan-out updates
    for (const u of subtaskResult.updates) {
      updatesByTaskId.set(u.taskId, {
        ...u,
        newReferenceStartDate: u.newStart,
        newReferenceEndDate: u.newEnd,
        _reportingMsg: `❇️ V2 subtask update: dates recomputed from parent (triggered by ${classified.sourceTaskName})`,
      });
    }

    const updates = Array.from(updatesByTaskId.values());
    // Sort by ascending start date so top-of-timeline tasks patch first
    updates.sort((a, b) => (a.newStart || '').localeCompare(b.newStart || ''));
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
        subtaskUpdateCount: 0,
        noActionReason: 'zero_updates',
        tracer,
      });
      return;
    }

    // Phase 8: Patch all updates (parents + subtasks)
    const patchPayload = updates.map((u) => ({
      taskId: u.taskId,
      properties: buildUpdateProperties(u, classified.sourceTaskName, classified.cascadeMode),
    }));

    tracer.startPhase('patchUpdates');
    const patched = await notionClient.patchPages(patchPayload, { tracer });
    tracer.endPhase('patchUpdates');

    // Phase 9: Report + Log
    tracer.startPhase('reportComplete');
    await notionClient.reportStatus(
      parsed.studyId,
      'success',
      `V2 Cascade complete for ${parsed.taskName}: ${classified.cascadeMode} (${patched.updatedCount} updates, ${subtaskResult.updates.length} subtasks recomputed)`,
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
        ? `V2 Cascade unresolved after safety cap for ${parsed.taskName} (${residueCount} residue task(s))`
        : `V2 ${classified.cascadeMode}: ${parsed.taskName} (${patched.updatedCount} updates, ${subtaskResult.updates.length} subtasks)`,
      patched,
      constrainedSource,
      cascadeResult,
      subtaskUpdateCount: subtaskResult.updates.length,
      noActionReason: null,
      tracer,
    });
    tracer.endPhase('logTerminal');
  } catch (error) {
    console.log(tracer.toConsoleLog());
    try {
      await notionClient.reportStatus(
        parsed.studyId,
        'error',
        `V2 Cascade failed for ${parsed.taskName || 'task'}: ${String(error.message || error).slice(0, 200)}`,
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
