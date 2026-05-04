/**
 * create-tasks — creates study tasks from Blueprint templates in one parallel
 * pass, then leaves internal parent/dependency relations for a later patch
 * phase.
 *
 * Ported from n8n Code nodes in PH1 Inception WF-1: Create & Wire.
 *   "Build task bodies"       — date calculation, property mapping
 *   "Accumulate ID mappings"  — content-based join via Template Source ID
 */

import { addBusinessDays, formatDate, parseDate } from '../utils/business-days.js';
import { BLUEPRINT_PROPS, STUDY_TASKS_PROPS } from '../notion/property-names.js';

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * Timestamp for Automation Reporting log entries.
 * Format: "YYYY-MM-DD HH:MM" (matches original n8n node).
 */
function timestamp() {
  return new Date().toISOString().replace('T', ' ').substring(0, 16);
}

/**
 * Build a Notion page body for a single task.
 *
 * Returns null if the task should be skipped (null offsets).
 * Also returns relation-tracking metadata used for the later patch phase.
 *
 * Hot-loop reshape (per plan U2): the Blueprint task is read for ~9 properties.
 * Reshape `task.properties` into an id-keyed map once at function entry.
 *
 * Owner asymmetry: BLUEPRINT_PROPS.OWNER is the renamed `[Do Not Edit] Owner`;
 * STUDY_TASKS_PROPS.OWNER is the un-renamed `Owner`. Per-DB grouping in the
 * constants module makes the asymmetry obvious by construction — reads use
 * BLUEPRINT_PROPS, writes use STUDY_TASKS_PROPS.
 */
function buildTaskBody(task, { anchorDate, studyPageId, studyTasksDbId, idMapping, extraTags = [] }) {
  const props = task.properties || {};
  const byId = Object.create(null);
  for (const value of Object.values(props)) {
    if (value && value.id) byId[value.id] = value;
  }

  const templateId = task._templateId;
  const taskName = task._taskName;

  // ── Date calculation ────────────────────────────────────────────────────
  let startDateStr, endDateStr;

  if (task._overrideStartDate) {
    // Repeat-delivery: copy dates from the latest delivery
    startDateStr = task._overrideStartDate;
    endDateStr = task._overrideEndDate || task._overrideStartDate;
  } else {
    const sDateOffset = byId[BLUEPRINT_PROPS.SDATE_OFFSET.id]?.number;
    const eDateOffset = byId[BLUEPRINT_PROPS.EDATE_OFFSET.id]?.number;

    if (sDateOffset == null || eDateOffset == null) {
      return null; // skip — missing offset
    }

    const startDate = addBusinessDays(anchorDate, sDateOffset);
    const endDate = addBusinessDays(anchorDate, eDateOffset);
    startDateStr = formatDate(startDate);
    endDateStr = formatDate(endDate);
  }

  // ── Dependency resolution ───────────────────────────────────────────────
  // Only relations already present in idMapping are written inline. This is
  // used for external existing tasks (for example add-task-set), while
  // relations between newly created blueprint tasks are patched afterward.
  const templateBlockedBy = task._templateBlockedBy || [];
  const resolvedBlockedByIds = [];
  const unresolvedBlockedByTemplateIds = [];

  for (const blockerTemplateId of templateBlockedBy) {
    const resolvedId = idMapping[blockerTemplateId];
    if (resolvedId) {
      resolvedBlockedByIds.push(resolvedId);
    } else {
      unresolvedBlockedByTemplateIds.push(blockerTemplateId);
    }
  }

  // ── Parent resolution ───────────────────────────────────────────────────
  const templateParentId = task._templateParentId;
  const resolvedParentId = templateParentId ? (idMapping[templateParentId] || null) : null;

  // ── Optional property extraction (Blueprint reads) ──────────────────────
  // Owner read uses BLUEPRINT_PROPS.OWNER (renamed) but write below uses
  // STUDY_TASKS_PROPS.OWNER (NOT renamed). Per-DB asymmetry — guarded by
  // construction via the per-DB constants groups.
  const assigneePeople = byId[BLUEPRINT_PROPS.OWNER.id]?.people || [];
  const ownerValue = assigneePeople.length > 0
    ? assigneePeople.map((p) => ({ object: 'user', id: p.id }))
    : [];
  // Task Instructions is intentionally out of the constants surface (per
  // plan scope: only renamed + engine-touched system fields). Kept name-keyed
  // here on both read and write because we don't depend on its rename
  // stability today; if it ever joins the constants surface, flip both.
  const taskInstructionsRelation = props['Task Instructions']?.relation || [];
  const tags = byId[BLUEPRINT_PROPS.TAGS.id]?.multi_select || [];
  const milestone = byId[BLUEPRINT_PROPS.MILESTONE.id]?.multi_select || [];
  const assigneeRole = byId[BLUEPRINT_PROPS.OWNER_ROLE.id]?.select;
  const externalVisibility = byId[BLUEPRINT_PROPS.EXTERNAL_VISIBILITY.id]?.select;
  // Status is not in BLUEPRINT_PROPS (Blueprint has no Status property), but
  // a task may carry one through some upstream merge. Defensively read from
  // the byId map using the STUDY_TASKS_PROPS.STATUS.id, which is the
  // identifier the reshape would use if Status appears in the source object.
  const status = byId[STUDY_TASKS_PROPS.STATUS.id]?.status;

  // ── Log entry ───────────────────────────────────────────────────────────
  const logEntry = `[${timestamp()}] Inception v4: created from Blueprint ${templateId.substring(0, 8)}, dates ${startDateStr}→${endDateStr}`;

  // ── Page body (with null stripping) — Study Tasks writes by .id ─────────
  // Writes are id-keyed against STUDY_TASKS_PROPS (the destination DB).
  const pageBody = {
    parent: { database_id: studyTasksDbId },
    properties: {
      [STUDY_TASKS_PROPS.TASK_NAME.id]: { title: [{ type: 'text', text: { content: taskName } }] },
      [STUDY_TASKS_PROPS.DATES.id]: { date: { start: startDateStr, end: endDateStr } },
      [STUDY_TASKS_PROPS.REF_START.id]: { date: { start: startDateStr } },
      [STUDY_TASKS_PROPS.REF_END.id]: { date: { start: endDateStr } },
      [STUDY_TASKS_PROPS.STUDY.id]: { relation: [{ id: studyPageId }] },
      [STUDY_TASKS_PROPS.TEMPLATE_SOURCE_ID.id]: { rich_text: [{ type: 'text', text: { content: templateId } }] },
      [STUDY_TASKS_PROPS.AUTOMATION_REPORTING.id]: { rich_text: [{ type: 'text', text: { content: logEntry } }] },
    },
  };

  // Conditional properties — only include if value exists (null stripping)
  if (status) { pageBody.properties[STUDY_TASKS_PROPS.STATUS.id] = { status: { name: status.name } }; }
  if (ownerValue.length > 0) { pageBody.properties[STUDY_TASKS_PROPS.OWNER.id] = { people: ownerValue }; }
  // Merge blueprint tags with caller-supplied extraTags (e.g., "Manual
  // Workstream / Item" on Additional TLF buttons). Dedup by name so a
  // blueprint tag coinciding with extraTags emits exactly once. No
  // post-create PATCH loop — merging happens at body-build time.
  const mergedTagNames = [...new Set([...tags.map((t) => t.name), ...extraTags])];
  if (mergedTagNames.length > 0) {
    pageBody.properties[STUDY_TASKS_PROPS.TAGS.id] = { multi_select: mergedTagNames.map((name) => ({ name })) };
  }
  if (milestone.length > 0) { pageBody.properties[STUDY_TASKS_PROPS.MILESTONE.id] = { multi_select: milestone.map((m) => ({ name: m.name })) }; }
  if (assigneeRole) { pageBody.properties[STUDY_TASKS_PROPS.OWNER_ROLE.id] = { select: { name: assigneeRole.name } }; }
  if (externalVisibility) { pageBody.properties[STUDY_TASKS_PROPS.EXTERNAL_VISIBILITY.id] = { select: { name: externalVisibility.name } }; }
  if (taskInstructionsRelation.length > 0) {
    // Task Instructions is not in the constants surface (see read note above).
    // Kept name-keyed until promoted to STUDY_TASKS_PROPS.
    pageBody.properties['Task Instructions'] = { relation: taskInstructionsRelation.map((r) => ({ id: r.id })) };
  }
  if (resolvedBlockedByIds.length > 0) {
    pageBody.properties[STUDY_TASKS_PROPS.BLOCKED_BY.id] = { relation: resolvedBlockedByIds.map((id) => ({ id })) };
  }
  if (resolvedParentId) {
    pageBody.properties[STUDY_TASKS_PROPS.PARENT_TASK.id] = { relation: [{ id: resolvedParentId }] };
  }

  // Icon (top-level, not inside properties)
  if (task._templateIcon) { pageBody.icon = task._templateIcon; }

  return {
    pageBody,
    _templateId: templateId,
    _taskName: taskName,
    _resolvedBlockedByIds: resolvedBlockedByIds,
    _unresolvedBlockedByTemplateIds: unresolvedBlockedByTemplateIds,
    _templateParentId: templateParentId,
    _resolvedParentId: resolvedParentId,
  };
}

/**
 * Create pages in parallel using the client's per-token worker queue.
 *
 * @param {import('../notion/client.js').NotionClient} client
 * @param {object[]} entries - array of { pageBody, _templateId, ... } from buildTaskBody
 * @param {{ tracer?: object }} options
 * @returns {Promise<object[]>} created Notion page objects
 */
async function createBatch(client, entries, { tracer } = {}) {
  return client.createPages(entries.map((entry) => entry.pageBody), {
    tracer,
    workersPerToken: 5,
  });
}

/**
 * Accumulate ID mappings via content-based join (Template Source ID).
 *
 * Matches each created page back to the original entry by reading the
 * Template Source ID property from the created page response.
 */
function accumulateIdMappings(createdPages, entries, idMapping, depTracking, parentTracking) {
  // Build a lookup from templateId -> original entry metadata
  const entryLookup = {};
  for (const entry of entries) {
    entryLookup[entry._templateId] = entry;
  }

  for (const created of createdPages) {
    const newId = created.id;
    let templateId = null;

    // Content-based join: extract Template Source ID from the created page.
    // Reshape into id-keyed map so the lookup is rename-immune.
    const createdById = Object.create(null);
    for (const value of Object.values(created.properties || {})) {
      if (value && value.id) createdById[value.id] = value;
    }
    const tsid = createdById[STUDY_TASKS_PROPS.TEMPLATE_SOURCE_ID.id];
    if (tsid?.rich_text?.[0]?.text?.content) {
      templateId = tsid.rich_text[0].text.content;
    } else if (tsid?.rich_text?.[0]?.plain_text) {
      templateId = tsid.rich_text[0].plain_text;
    }

    if (!templateId || !newId) continue;

    idMapping[templateId] = newId;

    const original = entryLookup[templateId];
    if (!original) continue;

    // Track unresolved deps for post-loop patching (WF-2)
    if (original._unresolvedBlockedByTemplateIds.length > 0) {
      depTracking.push({
        templateId,
        resolvedBlockedByIds: original._resolvedBlockedByIds,
        unresolvedBlockedByTemplateIds: original._unresolvedBlockedByTemplateIds,
      });
    }

    // Track unresolved parents only (resolved parents were already set inline)
    if (original._templateParentId && !original._resolvedParentId) {
      parentTracking.push({
        templateId,
        templateParentId: original._templateParentId,
      });
    }
  }
}

// ── main export ────────────────────────────────────────────────────────────

/**
 * Create study tasks from Blueprint templates in one parallel pass.
 *
 * @param {import('../notion/client.js').NotionClient} client
 * @param {Array<{ level: number, tasks: object[], isLastLevel: boolean }>} levels - from buildTaskTree()
 * @param {{ studyPageId: string, contractSignDate: string, blueprintDbId: string, studyTasksDbId: string, existingIdMapping?: object, extraTags?: string[], tracer?: import('../services/cascade-tracer.js').CascadeTracer }} options
 * @returns {Promise<{ idMapping: object, totalCreated: number, depTracking: object[], parentTracking: object[] }>}
 */
export async function createStudyTasks(client, levels, { studyPageId, contractSignDate, studyTasksDbId, existingIdMapping, extraTags = [], tracer } = {}) {
  if (tracer) tracer.startPhase('createStudyTasks');

  // Defense in depth — callers (inception, add-task-set) should have already
  // aborted on empty Contract Sign Date, but refuse to anchor against
  // undefined/null here so future misbehaving callers fail loud instead of
  // silently computing NaN dates (parseDate(null) returns null without
  // throwing, so guard truthiness FIRST, parse SECOND).
  if (!contractSignDate) {
    throw new Error('createStudyTasks: contractSignDate is required');
  }
  const anchorDate = parseDate(contractSignDate);
  const idMapping = { ...(existingIdMapping || {}) };
  const depTracking = [];
  const parentTracking = [];
  const tasks = (levels || []).flatMap(({ tasks: levelTasks = [] }) => levelTasks);
  const entries = [];

  for (const task of tasks) {
    const entry = buildTaskBody(task, {
      anchorDate,
      studyPageId,
      studyTasksDbId,
      idMapping,
      extraTags,
    });
    if (entry) entries.push(entry);
  }

  let totalCreated = 0;
  try {
    if (entries.length > 0) {
      const createdPages = await createBatch(client, entries, { tracer });
      // runParallel returns a mixed array. Partition into three buckets:
      //   - successes: real page objects
      //   - failedUnsafe: Error instances (worker rejected this slot,
      //     typically narrow-retry suppression on a non-idempotent unsafe
      //     error — the slot may or may not have written server-side)
      //   - notAttempted: undefined (worker never picked up this slot
      //     because the batch aborted before reaching it)
      let failedUnsafe = 0;
      let notAttempted = 0;
      const successes = [];
      for (const slot of createdPages) {
        if (slot instanceof Error) {
          failedUnsafe += 1;
        } else if (slot === undefined) {
          notAttempted += 1;
        } else if (slot && typeof slot === 'object' && slot.id) {
          successes.push(slot);
        } else {
          // Bucket invariant guard. runParallel's contract is "page object
          // | Error | undefined" per src/notion/client.js:153-201. Any
          // other slot shape means runParallel evolved and this caller's
          // partition is undercounting — fail loud rather than silently
          // recreating the invisibility this fix is designed to prevent.
          throw new Error(
            `runParallel contract drift: createPages returned an unrecognized slot shape (${typeof slot}). Update create-tasks.js partition logic.`,
          );
        }
      }
      accumulateIdMappings(successes, entries, idMapping, depTracking, parentTracking);
      totalCreated = successes.length;

      if (failedUnsafe > 0 || notAttempted > 0) {
        const attempted = entries.length;
        if (tracer && typeof tracer.recordBatchOutcome === 'function') {
          tracer.recordBatchOutcome({ attempted, created: totalCreated, failedUnsafe, notAttempted });
        }
        // Operator-facing summary; ≤180 chars to fit inception.js:291
        // slicing. The runbook reference gives the on-call a concrete
        // next step; archiving the partial tasks restores the
        // double-inception precondition so a re-run can succeed cleanly.
        const msg = `Inception batch incomplete: created ${totalCreated}/${attempted} (${failedUnsafe} failed transient, ${notAttempted} not attempted). Archive partial tasks and re-run (see runbook).`;
        throw Object.assign(new Error(msg), {
          kind: 'batch-aborted',
          attempted,
          created: totalCreated,
          failedUnsafe,
          notAttempted,
          idMapping,
        });
      }
    }
  } finally {
    // Always close the phase, even on the throw path. Without this, the
    // failure-path Activity Log entry silently drops timing.phases
    // .createStudyTasks — exactly where post-mortem diagnosis needs it.
    if (tracer) tracer.endPhase('createStudyTasks');
  }

  return {
    idMapping,
    totalCreated,
    depTracking,
    parentTracking,
  };
}
