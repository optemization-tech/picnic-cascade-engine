import { config } from '../config.js';
import { parseWebhookPayload, isImportMode, isFrozen } from '../gates/guards.js';
import { classify } from '../engine/classify.js';
import { runCascade } from '../engine/cascade.js';
import { runParentSubtask } from '../engine/parent-subtask.js';
import { buildReportingText } from '../utils/reporting.js';
import { STUDIES_PROPS, STUDY_TASKS_PROPS } from '../notion/property-names.js';
import {
  addBusinessDays,
  countBDInclusive,
  formatDate,
  isBusinessDay,
  nextBusinessDay,
  parseDate,
  signedBDDelta,
} from '../utils/business-days.js';
import { cascadeClient as notionClient, commentClient } from '../notion/clients.js';
import { queryStudyTasks } from '../notion/queries.js';
import { ActivityLogService } from '../services/activity-log.js';
import { StudyCommentService } from '../services/study-comment.js';
import { CascadeTracer } from '../services/cascade-tracer.js';
import { cascadeQueue } from '../services/cascade-queue.js';
import { undoStore } from '../services/undo-store.js';
const activityLogService = new ActivityLogService({
  notionClient: commentClient,
  activityLogDbId: config.notion.activityLogDbId,
});
const studyCommentService = new StudyCommentService({ notionClient: commentClient });
const DIRECT_PARENT_WARNING = '⚠️ This task has subtasks — edit a subtask directly to shift dates and trigger cascading.';
const DIRECT_PARENT_REVERT_WARNING = 'Parent date edit reverted — edit a subtask directly to shift dates and trigger cascading.';

function summarizeFailure(error) {
  return `Date cascade failed: ${String(error?.message || error || 'Unknown error').slice(0, 180)}`;
}

function normalizeWeekendSourceDates(parsed) {
  if (!parsed?.hasDates || !parsed.newStart || !parsed.newEnd) return parsed;
  // Defensive idempotency guard: if a prior call already snapped this
  // parsed object, return it unchanged so a double-invocation path (handler
  // + processDateCascade both normalize) never double-snaps.
  if (parsed.weekendSnapped) return parsed;

  const start = parseDate(parsed.newStart);
  const end = parseDate(parsed.newEnd);
  if (!start || !end || isBusinessDay(start)) return parsed;

  const snappedStart = nextBusinessDay(start);
  const duration = countBDInclusive(start, end);
  const snappedEnd = addBusinessDays(snappedStart, duration - 1);
  const newStart = formatDate(snappedStart);
  const newEnd = formatDate(snappedEnd);

  return {
    ...parsed,
    newStart,
    newEnd,
    startDelta: parsed.refStart ? signedBDDelta(parsed.refStart, newStart) : parsed.startDelta,
    endDelta: parsed.refEnd ? signedBDDelta(parsed.refEnd, newEnd) : parsed.endDelta,
    weekendSnapped: true,
  };
}

function buildActivityDetails({ parsed, classified, patched, sourceFinal, cascadeResult, error, noActionReason, tracer }) {
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
      modifiedStart: sourceFinal?.newStart || parsed?.newStart || null,
      modifiedEnd: sourceFinal?.newEnd || parsed?.newEnd || null,
    },
    crossChain: {
      capHit: Boolean(diagnostics.capReached),
      residueCount: Array.isArray(diagnostics.unresolvedResidue) ? diagnostics.unresolvedResidue.length : 0,
      residueExamples: Array.isArray(diagnostics.unresolvedResidue)
        ? diagnostics.unresolvedResidue.slice(0, 5).map((taskId) => ({ taskId, reason: 'cap_unresolved' }))
        : [],
      clampedEdges: Array.isArray(diagnostics.clampedEdges) ? diagnostics.clampedEdges : [],
    },
    error: error
      ? {
        errorCode: error.code || null,
        errorMessage: String(error.message || error).slice(0, 400),
        phase: error.phase || 'date-cascade',
      }
      : { errorCode: null, errorMessage: null, phase: null },
    noActionReason: noActionReason || null,
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
  sourceFinal,
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
    editedByBot: parsed?.editedByBot || false,
    summary,
    details: buildActivityDetails({
      parsed,
      classified,
      patched,
      sourceFinal,
      cascadeResult,
      noActionReason,
      error,
      tracer,
    }),
  });
}

async function applyError1SideEffects({ studyId, sourceTaskId, refStart, refEnd, tracer }) {
  const ops = [];

  if (studyId) {
    ops.push(notionClient.request('PATCH', `/pages/${studyId}`, {
      properties: {
        [STUDIES_PROPS.IMPORT_MODE.id]: { checkbox: false },
        [STUDIES_PROPS.AUTOMATION_REPORTING.id]: {
          rich_text: [{
            type: 'text',
            text: { content: DIRECT_PARENT_WARNING },
            annotations: { bold: true, color: 'red' },
          }],
        },
      },
    }, { tracer }));
  }

  if (sourceTaskId && refStart && refEnd) {
    ops.push(notionClient.patchPage(sourceTaskId, {
      [STUDY_TASKS_PROPS.DATES.id]: { date: { start: refStart, end: refEnd } },
      [STUDY_TASKS_PROPS.REF_START.id]: { date: { start: refStart } },
      [STUDY_TASKS_PROPS.REF_END.id]: { date: { start: refEnd } },
      [STUDY_TASKS_PROPS.AUTOMATION_REPORTING.id]: {
        rich_text: buildReportingText('warning', DIRECT_PARENT_REVERT_WARNING),
      },
    }, { tracer }));
  }

  if (ops.length === 0) return;
  await Promise.all(ops);
}

function buildUpdateProperties(update, sourceTaskName, cascadeMode) {
  return {
    [STUDY_TASKS_PROPS.DATES.id]: { date: { start: update.newStart, end: update.newEnd } },
    [STUDY_TASKS_PROPS.REF_START.id]: { date: { start: update.newReferenceStartDate || update.newStart } },
    [STUDY_TASKS_PROPS.REF_END.id]: { date: { start: update.newReferenceEndDate || update.newEnd } },
    [STUDY_TASKS_PROPS.AUTOMATION_REPORTING.id]: {
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
  const rawParsed = parseWebhookPayload(payload);
  const parsed = normalizeWeekendSourceDates(rawParsed);
  if (parsed.skip) return;

  // Defense-in-depth: drop bot-authored payloads before any work. The
  // cascade-queue front-door gate already filters these for queue-fed
  // paths; this in-handler check protects direct-call paths and matches
  // processDepEdit:129's symmetric guard. Without this, a bot-authored
  // payload with non-zero delta and Import Mode=false (very plausible —
  // Import Mode flips off as soon as inception's finally block runs while
  // backlogged Notion webhooks are still flushing) would bypass both
  // zero_delta_skip and import_mode_skip and run a real cascade.
  // Plan: docs/plans/2026-05-06-002-fix-cascade-queue-bot-author-gate-plan.md (U1 step 4).
  if (parsed.editedByBot === true) {
    console.log(JSON.stringify({
      event: 'date_cascade_bot_skip',
      taskId: parsed.taskId,
      taskName: parsed.taskName,
      studyId: parsed.studyId,
    }));
    return;
  }

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
  // NOTE: isFrozen check moved AFTER classify below. Error 1 (direct parent
  // edit) must fire for frozen parents too -- previously the frozen guard
  // here short-circuited the revert flow, leaving PMs with silently-applied
  // date edits on Done parents. See plan
  // docs/plans/2026-04-22-001-fix-meg-apr21-feedback-plan.md Unit 2.
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
    // "Cascade started" reportStatus is deferred until AFTER classify +
    // frozen check. Error 1 paths should see "queued" -> revert-warn with
    // no misleading "started" in between. Frozen leaves should log
    // no_action with no user-visible reportStatus for this run.

    tracer.startPhase('query');
    const allTasks = await queryStudyTasks(notionClient, config.notion.studyTasksDbId, parsed.studyId, { tracer });
    tracer.endPhase('query');
    tracer.set('study_task_count', allTasks.length);

    // Safety guard: if queryStudyTasks returns empty (stale studyId,
    // racing deletion, or malformed webhook), classify would compute
    // hasSubtasksFromGraph=false and Error 1 would not fire for what is
    // actually a top-level parent edit. Short-circuit with a no_action
    // log instead of silently accepting the edit.
    if (allTasks.length === 0) {
      console.log(JSON.stringify({
        event: 'empty_study_tasks_skip',
        cascadeId: tracer.cascadeId,
        taskName: parsed.taskName,
        taskId: parsed.taskId,
        studyId: parsed.studyId,
      }));
      // Clear the "Cascade queued" banner on the task so the PM doesn't
      // see a stuck pre-state. Fire-and-forget + swallow so reportStatus
      // failures never mask the real no_action log.
      notionClient
        .reportStatus(
          parsed.taskId,
          'warning',
          `No action: no tasks found for this study (stale data or racing deletion?)`,
          { tracer },
        )
        .catch((err) => {
          console.warn('[date-cascade] empty-study reportStatus dropped:', err?.message || err);
        });
      await logTerminalEvent({
        parsed,
        status: 'no_action',
        summary: `No action: no tasks found for study (stale studyId or racing deletion?)`,
        noActionReason: 'empty_study_tasks',
        tracer,
      });
      return;
    }

    // Snapshot pre-cascade dates for undo capability.
    // allTasks has current dates for all downstream tasks (only source has changed).
    // normalizeTask returns Date objects for start/end; we flatten to 'YYYY-MM-DD' strings here
    // so the undo manifest is uniformly string-typed and safe to sort/send to Notion.
    const preSnapshot = new Map();
    for (const t of allTasks) {
      preSnapshot.set(t.id, {
        start: t.start ? formatDate(t.start) : null,
        end: t.end ? formatDate(t.end) : null,
        refStart: t.refStart,
        refEnd: t.refEnd,
      });
    }
    // Source task's pre-edit dates come from webhook payload (allTasks already has the new edit).
    // parsed.refStart/refEnd are already 'YYYY-MM-DD' strings — no conversion needed.
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
        await applyError1SideEffects({
          studyId: parsed.studyId,
          sourceTaskId: classified.sourceTaskId || parsed.taskId,
          refStart: classified.refStart || parsed.refStart,
          refEnd: classified.refEnd || parsed.refEnd,
          tracer,
        });
      } else {
        await notionClient.reportStatus(parsed.taskId, 'warning', classified.reason || 'No cascade mode determined', { tracer });
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

    // Frozen check runs AFTER classify so Error 1 (direct parent edit
    // revert) fires regardless of the parent's Done/N/A status. For
    // non-Error-1 paths (leaves, middle-parent case-a), a frozen source
    // still short-circuits without cascading.
    if (isFrozen(parsed)) {
      console.log(tracer.toConsoleLog());
      await logTerminalEvent({
        parsed,
        classified,
        status: 'no_action',
        summary: `No action: ${parsed.taskName || 'task'} is in a frozen status`,
        noActionReason: 'frozen_status',
        tracer,
      });
      return;
    }

    // Now safe to announce "Cascade started" -- we know the cascade will
    // actually run (not Error 1, not frozen-leaf). Written to the TASK's
    // Automation Reporting (Unit 3) so multi-task cascades in the same
    // study don't overwrite each other's lifecycle states.
    await notionClient.reportStatus(parsed.taskId, 'info', `Cascade started for ${parsed.taskName}...`, { tracer });

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

    tracer.startPhase('merge');
    const sourceFinal = {
      taskId: classified.sourceTaskId,
      newStart: classified.newStart,
      newEnd: classified.newEnd,
    };
    const sourceRollUp = (parentResult.updates || []).find(
      (u) => u.taskId === classified.sourceTaskId && u._isRollUp,
    );

    const updatesByTaskId = new Map();
    for (const u of cascadeResult.updates || []) updatesByTaskId.set(u.taskId, { ...u });
    for (const u of parentResult.updates || []) updatesByTaskId.set(u.taskId, { ...u });

    // Source task keeps the user's edited dates; no post-cascade source clamp runs.
    updatesByTaskId.set(classified.sourceTaskId, {
      taskId: classified.sourceTaskId,
      taskName: classified.sourceTaskName,
      newStart: sourceFinal.newStart,
      newEnd: sourceFinal.newEnd,
      newReferenceStartDate: sourceFinal.newStart,
      newReferenceEndDate: sourceFinal.newEnd,
      _isRollUp: Boolean(sourceRollUp),
      _reportingMsg: `❇️ ${classified.cascadeMode} cascade: dates shifted (triggered by ${classified.sourceTaskName})`,
    });

    const updates = Array.from(updatesByTaskId.values());
    // Sort by ascending start date so top-of-timeline tasks patch first
    updates.sort((a, b) => (a.newStart || '').localeCompare(b.newStart || ''));
    tracer.endPhase('merge');

    if (updates.length === 0) {
      tracer.set('update_count', 0);
      console.log(tracer.toConsoleLog());
      await Promise.all([
        notionClient.reportStatus(parsed.taskId, 'info', `No updates needed for ${parsed.taskName}`, { tracer }),
        logTerminalEvent({
          parsed,
          classified,
          status: 'no_action',
          summary: `No action: no updates needed for ${parsed.taskName}`,
          patched: { updatedCount: 0 },
          sourceFinal,
          cascadeResult,
          noActionReason: 'zero_updates',
          tracer,
        }),
      ]);
      return;
    }

    const patchPayload = updates.map((u) => ({
      taskId: u.taskId,
      properties: buildUpdateProperties(u, classified.sourceTaskName, classified.cascadeMode),
    }));

    tracer.startPhase('patchUpdates');
    const patched = await notionClient.patchPages(patchPayload, { tracer });
    tracer.endPhase('patchUpdates');

    const capReached = Boolean(cascadeResult?.diagnostics?.capReached);
    const residueCount = Array.isArray(cascadeResult?.diagnostics?.unresolvedResidue)
      ? cascadeResult.diagnostics.unresolvedResidue.length
      : 0;

    tracer.set('update_count', patched.updatedCount);
    console.log(tracer.toConsoleLog());

    tracer.startPhase('reportComplete');
    tracer.startPhase('logTerminal');
    await Promise.all([
      (async () => {
        try {
          await notionClient.reportStatus(
            parsed.taskId,
            'success',
            `Cascade complete for ${parsed.taskName}: ${classified.cascadeMode} (${patched.updatedCount} task updates)`,
            { tracer },
          );
        } finally {
          tracer.endPhase('reportComplete');
        }
      })(),
      (async () => {
        try {
          await logTerminalEvent({
            parsed,
            classified,
            status: capReached ? 'failed' : 'success',
            summary: capReached
              ? `Cascade unresolved after safety cap for ${parsed.taskName} (${residueCount} residue task(s))`
              : `${classified.cascadeMode}: ${parsed.taskName} (${patched.updatedCount} updates)`,
            patched,
            sourceFinal,
            cascadeResult,
            noActionReason: null,
            tracer,
          });
        } finally {
          tracer.endPhase('logTerminal');
        }
      })(),
    ]);

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
      await Promise.all([
        notionClient.reportStatus(
          parsed.taskId,
          'error',
          `Cascade failed for ${parsed.taskName || 'task'}: ${String(error.message || error).slice(0, 200)}`,
          { tracer },
        ),
        logTerminalEvent({
          parsed,
          status: 'failed',
          summary: summarizeFailure(error),
          noActionReason: null,
          error,
          tracer,
        }),
        studyCommentService.postComment({
          workflow: 'Date Cascade',
          status: 'failed',
          studyId: parsed.studyId,
          sourceTaskName: parsed.taskName || 'Unknown',
          triggeredByUserId: parsed.triggeredByUserId,
          editedByBot: parsed.editedByBot,
          summary: summarizeFailure(error),
        }).catch(() => {}),
      ]);
    } catch { /* don't mask original error */ }
    throw error;
  }
}

export async function handleDateCascade(req, res) {
  res.status(200).json({ ok: true });

  // Post "Cascade queued" immediately so the PM gets click feedback before
  // the 5s debounce fires. Writes to the TASK's Automation Reporting field
  // (not the study's) so multi-task cascades in the same study don't
  // overwrite each other's queued/started/complete states. Fire-and-forget;
  // parse errors or Notion failures must never block the enqueue below.
  //
  // Filter: skip the queued status for payloads that will not produce a
  // cascade -- zero-delta echoes, Import Mode events, bot-echo webhooks,
  // malformed payloads. This keeps the task's Reporting field silent when
  // the engine has nothing to do.
  try {
    const rawParsed = parseWebhookPayload(req.body);
    // Match processDateCascade's weekend-snap behavior so a Fri->Sat edit
    // (raw delta 0, snapped delta 1) doesn't silently suppress the queued
    // message while the cascade actually runs.
    const parsed = normalizeWeekendSourceDates(rawParsed);
    const hasNonZeroDelta = parsed
      && typeof parsed.startDelta === 'number'
      && typeof parsed.endDelta === 'number'
      && (parsed.startDelta !== 0 || parsed.endDelta !== 0);
    // Also mirror the frozen-status skip so frozen leaves don't see a
    // permanent "queued" banner with no follow-up (processDateCascade's
    // post-classify isFrozen check returns no_action without writing any
    // lifecycle message back to the task).
    const shouldPostQueued = parsed
      && !parsed.skip
      && parsed.taskId
      && parsed.studyId // without studyId, processDateCascade returns
                        // on the missing_study guard with no follow-up
                        // reportStatus -- would leave "Cascade queued"
                        // stuck on the task's Automation Reporting.
      && hasNonZeroDelta
      && !isImportMode(parsed)
      && !parsed.editedByBot
      && !isFrozen(parsed);
    if (shouldPostQueued) {
      notionClient
        .reportStatus(
          parsed.taskId,
          'info',
          `Cascade queued for ${parsed.taskName || 'task'} — starting in ~5s...`,
        )
        .catch((err) => {
          console.warn('[date-cascade] queued reportStatus dropped:', err?.message || err);
        });
    }
  } catch (err) {
    // Swallow parse errors; webhook must always succeed. Log for visibility.
    console.warn('[date-cascade] queued preflight parse error:', err?.message || err);
  }

  cascadeQueue.enqueue(req.body, parseWebhookPayload, processDateCascade);
}
