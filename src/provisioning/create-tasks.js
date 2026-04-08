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
 */
function buildTaskBody(task, { anchorDate, studyPageId, studyTasksDbId, idMapping }) {
  const props = task.properties || {};
  const templateId = task._templateId;
  const taskName = task._taskName;

  // ── Date calculation ────────────────────────────────────────────────────
  let startDateStr, endDateStr;

  if (task._overrideStartDate) {
    // Repeat-delivery: copy dates from the latest delivery
    startDateStr = task._overrideStartDate;
    endDateStr = task._overrideEndDate || task._overrideStartDate;
  } else {
    const sDateOffset = props['SDate Offset']?.number;
    const eDateOffset = props['EDate Offset']?.number;

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

  // ── Optional property extraction ────────────────────────────────────────
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

  // ── Log entry ───────────────────────────────────────────────────────────
  const logEntry = `[${timestamp()}] Inception v4: created from Blueprint ${templateId.substring(0, 8)}, dates ${startDateStr}\u2192${endDateStr}`;

  // ── Page body (with null stripping) ─────────────────────────────────────
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

  // Conditional properties — only include if value exists (null stripping)
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

    // Content-based join: extract Template Source ID from the created page
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
 * @param {{ studyPageId: string, contractSignDate: string, blueprintDbId: string, studyTasksDbId: string, existingIdMapping?: object, tracer?: import('../services/cascade-tracer.js').CascadeTracer }} options
 * @returns {Promise<{ idMapping: object, totalCreated: number, depTracking: object[], parentTracking: object[] }>}
 */
export async function createStudyTasks(client, levels, { studyPageId, contractSignDate, studyTasksDbId, existingIdMapping, tracer } = {}) {
  if (tracer) tracer.startPhase('createStudyTasks');

  const anchorDate = contractSignDate ? parseDate(contractSignDate) : new Date();
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
    });
    if (entry) entries.push(entry);
  }

  let totalCreated = 0;
  if (entries.length > 0) {
    const createdPages = await createBatch(client, entries, { tracer });
    accumulateIdMappings(createdPages, entries, idMapping, depTracking, parentTracking);
    totalCreated = createdPages.length;
  }

  if (tracer) tracer.endPhase('createStudyTasks');

  return {
    idMapping,
    totalCreated,
    depTracking,
    parentTracking,
  };
}
