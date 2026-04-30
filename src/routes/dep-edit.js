import { config } from '../config.js';
import { parseWebhookPayload } from '../gates/guards.js';
import { tightenSeedAndDownstream } from '../engine/cascade.js';
import { runParentSubtask } from '../engine/parent-subtask.js';
import { cascadeClient as notionClient, commentClient } from '../notion/clients.js';
import { queryStudyTasks } from '../notion/queries.js';
import { ActivityLogService } from '../services/activity-log.js';
import { StudyCommentService } from '../services/study-comment.js';
import { cascadeQueue } from '../services/cascade-queue.js';
import { STUDY_TASKS_PROPS } from '../notion/property-names.js';

const activityLogService = new ActivityLogService({
  notionClient: commentClient,
  activityLogDbId: config.notion.activityLogDbId,
});
const studyCommentService = new StudyCommentService({ notionClient: commentClient });

function summarizeFailure(error) {
  return `Dep edit cascade failed: ${String(error?.message || error || 'Unknown error').slice(0, 180)}`;
}

function buildActivityDetails({ parsed, result, parentResult, error, noActionReason }) {
  // Surface seed-task pre/post dates by finding the seed update inside the result.
  // Falls back to webhook payload's refStart/refEnd for the originals (which the
  // payload-first parser populates before the cascade computes anything).
  const seedUpdate = result?.updates?.find?.((u) => u.taskId === parsed?.taskId);
  const leafCount = result?.updates?.length ?? 0;
  const parentCount = parentResult?.rollUpCount ?? parentResult?.updates?.length ?? 0;
  return {
    // Standard shape consumed by ActivityLogService.detailLines() — populating these
    // keys makes the rendered bullet section non-empty in the Notion Activity Log
    // entry. Dep-edit doesn't have caps/residue, so crossChain stays zeroed.
    movement: {
      // updatedCount sums leaf cascade + parent rollup so the rendered bullet
      // matches the total rows that were patched.
      updatedCount: leafCount + parentCount,
      movedTaskIds: result?.movedTaskIds || [],
    },
    sourceDates: {
      originalStart: parsed?.refStart || null,
      originalEnd: parsed?.refEnd || null,
      modifiedStart: seedUpdate?.newStart || null,
      modifiedEnd: seedUpdate?.newEnd || null,
    },
    crossChain: {
      capHit: false,
      residueCount: 0,
      residueExamples: [],
      clampedEdges: [],
    },
    error: error
      ? {
        errorCode: error.code || null,
        errorMessage: String(error.message || error).slice(0, 400),
        phase: error.phase || 'dep-edit',
      }
      : { errorCode: null, errorMessage: null, phase: null },
    noActionReason: noActionReason || null,

    // Dep-edit-specific fields. These live at the top level of details (not under
    // a sub-object) so they appear in the raw JSON dump for forensics. detailLines()
    // doesn't read them today; if PMs want subcase visible in bullets, lift them
    // into detailLines() centrally.
    subcase: result?.subcase || null,
    reason: result?.reason || null,
    downstreamCount: result?.downstreamCount ?? 0,
    rollUpCount: parentCount,
    rollUpTaskIds: (parentResult?.updates || []).map((u) => u.taskId),
    cycleDetected: Boolean(result?.diagnostics?.cycleDetected),
    cycleTaskIds: result?.diagnostics?.cycleTaskIds || [],
  };
}

async function logTerminalEvent({ parsed, status, summary, result, parentResult, noActionReason, error }) {
  await activityLogService.logTerminalEvent({
    workflow: 'Dep Edit Cascade',
    status,
    triggerType: 'Automation',
    executionId: parsed?.executionId || null,
    timestamp: new Date().toISOString(),
    cascadeMode: 'dep-edit',
    sourceTaskId: parsed?.taskId || null,
    sourceTaskName: parsed?.taskName || null,
    studyId: parsed?.studyId || null,
    triggeredByUserId: parsed?.triggeredByUserId || null,
    editedByBot: parsed?.editedByBot || false,
    summary,
    details: buildActivityDetails({ parsed, result, parentResult, noActionReason, error }),
  });
}

function buildUpdateProperties(update, sourceTaskName, subcase) {
  // Roll-up rows from runParentSubtask carry _reportingMsg ("❇️ Roll-up: dates set
  // to ..."). Leaf rows from tightenSeedAndDownstream don't, so they fall back to
  // the dep-edit-flavored phrasing. Mirrors date-cascade.js:180.
  const content = update._reportingMsg
    || `❇️ dep-edit ${subcase}: dates shifted (triggered by ${sourceTaskName})`;
  return {
    [STUDY_TASKS_PROPS.DATES.id]: { date: { start: update.newStart, end: update.newEnd } },
    [STUDY_TASKS_PROPS.REF_START.id]: { date: { start: update.newStart } },
    [STUDY_TASKS_PROPS.REF_END.id]: { date: { start: update.newEnd } },
    [STUDY_TASKS_PROPS.AUTOMATION_REPORTING.id]: {
      rich_text: [{
        type: 'text',
        text: { content },
        annotations: { color: 'green_background' },
      }],
    },
  };
}

async function processDepEdit(payload) {
  const parsed = parseWebhookPayload(payload);
  if (parsed.skip) return;

  // Hoisted so the catch-block's logTerminalEvent can include cascade context
  // when patchPages throws AFTER tightenSeedAndDownstream has computed updates.
  // Without this, failure rows show subcase: null / movedTaskIds: [] even though
  // the cascade actually computed work the patch failed to apply.
  let result = null;
  // Same pattern for parentResult so failure rows preserve rollup context computed
  // before patchPages threw. Note: date-cascade does NOT thread parentResult through
  // its catch block today — this is a dep-edit-specific improvement, not a mirror.
  let parentResult = null;

  // Defense-in-depth guards. The Notion automation should filter these out
  // (D5/D6 in the plan), but route-level checks ensure correctness even if
  // the automation is misconfigured.
  if (parsed.editedByBot) {
    console.log(JSON.stringify({
      event: 'dep_edit_bot_skip',
      taskId: parsed.taskId,
      taskName: parsed.taskName,
      studyId: parsed.studyId,
    }));
    return;
  }
  if (!parsed.hasDates) {
    console.log(JSON.stringify({
      event: 'dep_edit_no_dates_skip',
      taskId: parsed.taskId,
      taskName: parsed.taskName,
      studyId: parsed.studyId,
    }));
    return;
  }
  if (parsed.hasSubtasks) {
    console.log(JSON.stringify({
      event: 'dep_edit_parent_task_skip',
      taskId: parsed.taskId,
      taskName: parsed.taskName,
      studyId: parsed.studyId,
    }));
    return;
  }
  if (!parsed.studyId) {
    console.log(JSON.stringify({
      event: 'dep_edit_missing_study_skip',
      taskId: parsed.taskId,
      taskName: parsed.taskName,
    }));
    return;
  }

  try {
    const allTasks = await queryStudyTasks(notionClient, config.notion.studyTasksDbId, parsed.studyId);
    if (allTasks.length === 0) {
      console.log(JSON.stringify({
        event: 'dep_edit_empty_study_skip',
        taskId: parsed.taskId,
        taskName: parsed.taskName,
        studyId: parsed.studyId,
      }));
      return;
    }

    result = tightenSeedAndDownstream({ seedTaskId: parsed.taskId, tasks: allTasks });

    if (result.subcase === 'no-op') {
      // Silent no-op (matches status-rollup's silent-when-idempotent pattern).
      // Avoids Activity Log noise for: already-tight chains, frozen seeds,
      // seeds with no effective blockers, parent-task seeds that bypassed
      // the Notion filter, etc.
      console.log(JSON.stringify({
        event: 'dep_edit_noop',
        taskId: parsed.taskId,
        taskName: parsed.taskName,
        studyId: parsed.studyId,
        reason: result.reason,
      }));
      return;
    }

    if (result.updates.length === 0) {
      // Defensive: subcase was violation/gap but no updates produced.
      // Shouldn't happen but log if it does.
      await logTerminalEvent({
        parsed,
        status: 'no_action',
        summary: `dep-edit ${result.subcase}: no updates produced`,
        result,
        noActionReason: 'zero_updates',
      });
      return;
    }

    // Roll up parents of moved subtasks. The dep-edit seed is always a leaf
    // (parent-task seeds short-circuit upstream at the hasSubtasks guard), so
    // parentMode=null skips runParentSubtask's case-a/case-b sections and runs
    // only the §5.4 "Cascade Roll-Up" pass: for each moved task, recompute its
    // parent's dates as min(child starts) / max(child ends). Mirrors the
    // date-cascade.js pipeline so manually-inserted task sets see the same
    // parent alignment after a Blocked-by edit as they would after a date drag.
    const seedMoved = result.movedTaskMap?.[parsed.taskId];
    parentResult = runParentSubtask({
      sourceTaskId: parsed.taskId,
      sourceTaskName: parsed.taskName,
      newStart: seedMoved?.newStart || null,
      newEnd: seedMoved?.newEnd || null,
      parentTaskId: null,
      parentMode: null,
      movedTaskIds: result.movedTaskIds || [],
      movedTaskMap: result.movedTaskMap || {},
      tasks: allTasks,
    });

    // Merge leaf + parent updates. Match date-cascade.js:391-393's order: leaf
    // updates first, parent updates second. Collisions cannot occur in practice
    // because parents are stripped from the cascade graph (cascade.js:528-538),
    // so result.updates never contains a parent ID. Order is documentation of
    // intent (parents-after-leaves matches the pipeline), not load-bearing.
    const updatesByTaskId = new Map();
    for (const u of result.updates) updatesByTaskId.set(u.taskId, u);
    for (const u of parentResult.updates || []) updatesByTaskId.set(u.taskId, u);
    const mergedUpdates = Array.from(updatesByTaskId.values());

    const patchPayload = mergedUpdates.map((u) => ({
      taskId: u.taskId,
      properties: buildUpdateProperties(u, parsed.taskName, result.subcase),
    }));

    const patched = await notionClient.patchPages(patchPayload);

    const rollUpCount = parentResult.rollUpCount ?? (parentResult.updates || []).length;
    const rollUpSuffix = rollUpCount > 0
      ? `, ${rollUpCount} parent roll-up${rollUpCount === 1 ? '' : 's'}`
      : '';
    await logTerminalEvent({
      parsed,
      status: 'success',
      summary: `dep-edit ${result.subcase}: ${parsed.taskName} (${patched.updatedCount} updates, +${result.downstreamCount} downstream${rollUpSuffix})`,
      result,
      parentResult,
    });
  } catch (error) {
    console.error('[dep-edit] processing failed:', error);
    try {
      await Promise.all([
        logTerminalEvent({
          parsed,
          status: 'failed',
          summary: summarizeFailure(error),
          result,         // hoisted above the try; preserves cascade context if patchPages threw post-compute
          parentResult,   // hoisted above the try; preserves rollup context too
          error,
        }),
        studyCommentService.postComment({
          workflow: 'Dep Edit Cascade',
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

export async function handleDepEdit(req, res) {
  res.status(200).json({ ok: true });
  cascadeQueue.enqueue(req.body, parseWebhookPayload, processDepEdit);
}
