/**
 * V2 create-tasks — creates study tasks from Blueprint V2 templates.
 *
 * Nearly identical to V1. The only behavioral difference is that V2 Blueprint
 * subtasks have no Blocking/Blocked by relations, so buildTaskBody automatically
 * skips dep wiring for them.
 *
 * Date computation is identical to V1 at inception time (anchor + global offset).
 * No stored offset properties are written to production tasks — the V2 cascade's
 * subtask fan-out computes offsets dynamically from current parent/subtask dates.
 */

import { addBusinessDays, formatDate, parseDate } from '../../utils/business-days.js';

// ── helpers (shared with V1) ──────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timestamp() {
  return new Date().toISOString().replace('T', ' ').substring(0, 16);
}

/**
 * Build a Notion page body for a single task.
 *
 * V2 changes from V1:
 *   - Reads Relative SDate Offset / Relative EDate Offset from Blueprint
 *   - Writes them to production subtasks (null-safe, only if present)
 */
function buildTaskBody(task, { anchorDate, studyPageId, studyTasksDbId, idMapping }) {
  const props = task.properties || {};
  const templateId = task._templateId;
  const taskName = task._taskName;

  // ── Date calculation (same as V1) ─────────────────────────────────────
  let startDateStr, endDateStr;

  if (task._overrideStartDate) {
    startDateStr = task._overrideStartDate;
    endDateStr = task._overrideEndDate || task._overrideStartDate;
  } else {
    const sDateOffset = props['SDate Offset']?.number;
    const eDateOffset = props['EDate Offset']?.number;

    if (sDateOffset == null || eDateOffset == null) {
      return null;
    }

    const startDate = addBusinessDays(anchorDate, sDateOffset);
    const endDate = addBusinessDays(anchorDate, eDateOffset);
    startDateStr = formatDate(startDate);
    endDateStr = formatDate(endDate);
  }

  // ── Inline dependency resolution (same as V1) ─────────────────────────
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

  // ── Inline parent resolution (same as V1) ─────────────────────────────
  const templateParentId = task._templateParentId;
  const resolvedParentId = templateParentId ? (idMapping[templateParentId] || null) : null;

  // ── Optional property extraction (same as V1) ─────────────────────────
  const assigneePeople = props['Owner']?.people || [];
  const ownerValue = assigneePeople.length > 0
    ? assigneePeople.map((p) => ({ object: 'user', id: p.id }))
    : [];
  const taskInstructionsRelation = props['Task Instructions']?.relation || [];
  const tags = props['Tags']?.multi_select || [];
  const milestone = props['Milestone']?.multi_select || [];
  const assigneeRole = props['Owner Role']?.select;
  const externalVisibility = props['External Visibility']?.select;
  const status = props['Status']?.status;

  // ── Log entry ─────────────────────────────────────────────────────────
  const logEntry = `[${timestamp()}] V2 Inception: created from Blueprint ${templateId.substring(0, 8)}, dates ${startDateStr}\u2192${endDateStr}`;

  // ── Page body (same as V1 + offset properties) ────────────────────────
  const pageBody = {
    parent: { database_id: studyTasksDbId },
    properties: {
      'Task Name': { title: [{ type: 'text', text: { content: taskName } }] },
      'Dates': { date: { start: startDateStr, end: endDateStr } },
      'Reference Start Date': { date: { start: startDateStr } },
      'Reference End Date': { date: { start: endDateStr } },
      'Study': { relation: [{ id: studyPageId }] },
      'Template Source ID': { rich_text: [{ type: 'text', text: { content: templateId } }] },
      'Automation Reporting': { rich_text: [{ type: 'text', text: { content: logEntry } }] },
    },
  };

  // Conditional properties (same as V1)
  if (status) { pageBody.properties['Status'] = { status: { name: status.name } }; }
  if (ownerValue.length > 0) { pageBody.properties['Owner'] = { people: ownerValue }; }
  if (tags.length > 0) { pageBody.properties['Tags'] = { multi_select: tags.map((t) => ({ name: t.name })) }; }
  if (milestone.length > 0) { pageBody.properties['Milestone'] = { multi_select: milestone.map((m) => ({ name: m.name })) }; }
  if (assigneeRole) { pageBody.properties['Owner Role'] = { select: { name: assigneeRole.name } }; }
  if (externalVisibility) { pageBody.properties['External Visibility'] = { select: { name: externalVisibility.name } }; }
  if (taskInstructionsRelation.length > 0) {
    pageBody.properties['Task Instructions'] = { relation: taskInstructionsRelation.map((r) => ({ id: r.id })) };
  }
  if (resolvedBlockedByIds.length > 0) {
    pageBody.properties['Blocked by'] = { relation: resolvedBlockedByIds.map((id) => ({ id })) };
  }
  if (resolvedParentId) {
    pageBody.properties['Parent Task'] = { relation: [{ id: resolvedParentId }] };
  }

  // Icon
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

// ── createBatch and accumulateIdMappings — reuse from V1 ────────────────

// These are pure utilities with no V1/V2 behavioral differences.
// Import and re-export from V1 would be ideal, but V1 doesn't export them.
// So we include them here (identical to V1).

async function createBatch(client, entries, { batchSize, interval = 1000, tracer } = {}) {
  batchSize = batchSize ?? client.optimalBatchSize;
  const created = [];

  for (let i = 0; i < entries.length; i += batchSize) {
    const batch = entries.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map((entry) => client.request('POST', '/pages', entry.pageBody, { tracer })),
    );
    created.push(...batchResults);
    if (i + batchSize < entries.length) await sleep(interval);
  }

  return created;
}

function accumulateIdMappings(createdPages, entries, idMapping, depTracking, parentTracking) {
  const entryLookup = {};
  for (const entry of entries) {
    entryLookup[entry._templateId] = entry;
  }

  for (const created of createdPages) {
    const newId = created.id;
    let templateId = null;

    const tsid = created.properties?.['Template Source ID'];
    if (tsid?.rich_text?.[0]?.text?.content) {
      templateId = tsid.rich_text[0].text.content;
    } else if (tsid?.rich_text?.[0]?.plain_text) {
      templateId = tsid.rich_text[0].plain_text;
    }

    if (!templateId || !newId) continue;

    idMapping[templateId] = newId;

    const original = entryLookup[templateId];
    if (!original) continue;

    if (original._unresolvedBlockedByTemplateIds.length > 0) {
      depTracking.push({
        templateId,
        resolvedBlockedByIds: original._resolvedBlockedByIds,
        unresolvedBlockedByTemplateIds: original._unresolvedBlockedByTemplateIds,
      });
    }

    if (original._templateParentId && !original._resolvedParentId) {
      parentTracking.push({
        templateId,
        templateParentId: original._templateParentId,
      });
    }
  }
}

// ── main export ─────────────────────────────────────────────────────────

/**
 * V2 createStudyTasks — identical to V1 except buildTaskBody writes relative offsets.
 */
export async function createStudyTasks(client, levels, { studyPageId, contractSignDate, studyTasksDbId, existingIdMapping, tracer } = {}) {
  if (tracer) tracer.startPhase('createStudyTasks');

  const anchorDate = contractSignDate ? parseDate(contractSignDate) : new Date();
  const idMapping = { ...(existingIdMapping || {}) };
  const depTracking = [];
  const parentTracking = [];
  let totalCreated = 0;

  for (const { level, tasks } of levels) {
    const entries = [];
    for (const task of tasks) {
      const entry = buildTaskBody(task, {
        anchorDate,
        studyPageId,
        studyTasksDbId,
        idMapping,
      });
      if (entry) entries.push(entry);
    }

    if (entries.length === 0) continue;

    const createdPages = await createBatch(client, entries, { tracer });
    accumulateIdMappings(createdPages, entries, idMapping, depTracking, parentTracking);
    totalCreated += createdPages.length;
  }

  if (tracer) tracer.endPhase('createStudyTasks');

  return {
    idMapping,
    totalCreated,
    depTracking,
    parentTracking,
  };
}
