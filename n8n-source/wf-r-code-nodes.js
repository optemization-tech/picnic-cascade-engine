// ============================================================
// NODE: Fetch & Validate Task
// ============================================================
// ============================================================
// Fetch & Validate Task — reads from webhook payload (no GET)
// v3 2026-03-21: Import Mode check BEFORE LMBS
// v4 2026-03-23: Drag normalization
// ============================================================

const webhookData = $('Webhook').first().json;
const data = webhookData.body?.data;
const pageId = data?.id;
if (!pageId) return [{ json: { _skip: true, _reason: 'No page ID in webhook payload' } }];

const props = data.properties;
if (!props) return [{ json: { _skip: true, _reason: 'No properties in webhook payload' } }];

const token = $('Config').first().json.notionApiToken;

// Import Mode check FIRST — no API call, immediate skip during cascade
const importModeRollup = props['Import Mode']?.rollup;
const importMode = importModeRollup?.type === 'array'
  ? importModeRollup.array?.[0]?.checkbox === true
  : importModeRollup?.boolean === true;

if (importMode) {
  return [{ json: { _skip: true, _reason: 'Import Mode active — skipping cascade' } }];
}

// Anti-loop gate: read from payload, PATCH to clear if needed
if (props['Last Modified By System']?.checkbox === true) {
  await this.helpers.httpRequest({
    method: 'PATCH',
    url: `https://api.notion.com/v1/pages/${pageId}`,
    headers: { 'Authorization': `Bearer ${token}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
    body: JSON.stringify({ properties: { 'Last Modified By System': { checkbox: false } } })
  });
  return [{ json: { _skip: true, _reason: 'System-modified — anti-loop gate active (unlocked)' } }];
}

// Extract dates
const dates = props['Dates']?.date;
if (!dates || !dates.start) return [{ json: { _skip: true, _reason: 'No Dates property' } }];
let newStart = dates.start;
let newEnd = dates.end || dates.start;

// Reference dates
const refStart = props['Reference Start Date']?.date?.start || newStart;
const refEnd = props['Reference End Date']?.date?.start || newEnd;

// Complete Freeze at source
const statusName = props['Status']?.status?.name || '';
if (statusName === 'Done' || statusName === 'N/A') {
  return [{ json: { _skip: true, _reason: 'Source task frozen (Status: ' + statusName + ')' } }];
}

// Task name
const taskName = props['Task Name']?.title?.[0]?.text?.content
  || props['Task Name']?.title?.[0]?.plain_text
  || pageId.substring(0, 8);

// Study relation
const studyRel = props['Study']?.relation || [];
if (studyRel.length === 0) return [{ json: { _skip: true, _reason: 'No Study relation' } }];

// Parent/subtask relations
const parentId = (props['Parent Task']?.relation || [])[0]?.id || null;
const hasSubtasks = (props['Subtask(s)']?.relation || []).length > 0;

// Compute signed BD deltas
function parseDate(s) { return s ? new Date(s + 'T00:00:00Z') : null; }
function isBusinessDay(d) { const day = d.getUTCDay(); return day !== 0 && day !== 6; }
function signedBDDelta(fromStr, toStr) {
  const f = parseDate(fromStr);
  const t = parseDate(toStr);
  if (!f || !t || f.getTime() === t.getTime()) return 0;
  const dir = t > f ? 1 : -1;
  let count = 0;
  const cursor = new Date(f);
  if (dir === 1) {
    while (cursor < t) { cursor.setUTCDate(cursor.getUTCDate() + 1); if (isBusinessDay(cursor)) count++; }
  } else {
    while (cursor > t) { cursor.setUTCDate(cursor.getUTCDate() - 1); if (isBusinessDay(cursor)) count++; }
  }
  return count * dir;
}

function countBDInclusive(startD, endD) {
  if (!startD || !endD || endD < startD) return 1;
  let count = 0;
  const c = new Date(startD);
  while (c <= endD) {
    if (isBusinessDay(c)) count++;
    c.setUTCDate(c.getUTCDate() + 1);
  }
  return Math.max(count, 1);
}

function addBusinessDays(d, count) {
  const c = new Date(d);
  if (count === 0) return c;
  let remaining = Math.abs(count);
  const dir = count > 0 ? 1 : -1;
  while (remaining > 0) {
    c.setUTCDate(c.getUTCDate() + dir);
    if (isBusinessDay(c)) remaining--;
  }
  return c;
}

function formatDate(d) {
  return d.toISOString().split('T')[0];
}

let startDelta = signedBDDelta(refStart, newStart);
let endDelta = signedBDDelta(refEnd, newEnd);

// DRAG NORMALIZATION (v4)
if (startDelta !== 0 && endDelta !== 0 && Math.sign(startDelta) === Math.sign(endDelta)) {
  const originalDuration = countBDInclusive(parseDate(refStart), parseDate(refEnd));
  const correctedEnd = addBusinessDays(parseDate(newStart), originalDuration - 1);
  newEnd = formatDate(correctedEnd);
  endDelta = signedBDDelta(refEnd, newEnd);
}

return [{ json: {
  _skip: false,
  taskId: pageId,
  taskName,
  newStart, newEnd,
  refStart, refEnd,
  startDelta, endDelta,
  studyId: studyRel[0].id,
  parentTaskId: parentId,
  hasParent: !!parentId,
  hasSubtasks,
  importMode: false
}}];

// ============================================================
// NODE: Check Import Mode
// ============================================================
// Import Mode already checked from webhook payload in Fetch & Validate
// This node is a pass-through (no study GET needed)
const importMode = $('Fetch & Validate Task').first().json.importMode || false;
return [{ json: { importMode } }];

// ============================================================
// NODE: Fetch All Study Tasks
// ============================================================
const token = $('Config').first().json.notionApiToken;
const dbId = $('Config').first().json.studyTasksDbId;
const studyId = $('Fetch & Validate Task').first().json.studyId;
let allResults = [];
let hasMore = true;
let startCursor = undefined;
while (hasMore) {
  const body = { filter: { property: 'Study', relation: { contains: studyId } }, page_size: 100 };
  if (startCursor) body.start_cursor = startCursor;
  const resp = await this.helpers.httpRequest({
    method: 'POST',
    url: `https://api.notion.com/v1/databases/${dbId}/query`,
    headers: { 'Authorization': `Bearer ${token}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  allResults = allResults.concat(resp.results);
  hasMore = resp.has_more;
  startCursor = resp.next_cursor;
}
return [{ json: { results: allResults } }];

// ============================================================
// NODE: Classify & Build Dispatch
// ============================================================
// --- BD helper functions (Error 3 fix) ---
function parseDate(s) { return s ? new Date(s + 'T00:00:00Z') : null; }
function formatDate(d) { return d.toISOString().split('T')[0]; }
function isBusinessDay(d) { const day = d.getUTCDay(); return day !== 0 && day !== 6; }
function signedBDDelta(fromStr, toStr) {
  const f = parseDate(fromStr); const t = parseDate(toStr);
  if (!f || !t || f.getTime() === t.getTime()) return 0;
  const dir = t > f ? 1 : -1; let count = 0; const cursor = new Date(f);
  if (dir === 1) { while (cursor < t) { cursor.setUTCDate(cursor.getUTCDate() + 1); if (isBusinessDay(cursor)) count++; } }
  else { while (cursor > t) { cursor.setUTCDate(cursor.getUTCDate() - 1); if (isBusinessDay(cursor)) count++; } }
  return count * dir;
}
function countBDInclusive(startD, endD) { if (!startD || !endD || endD < startD) return 1; let count = 0; const c = new Date(startD); while (c <= endD) { if (isBusinessDay(c)) count++; c.setUTCDate(c.getUTCDate() + 1); } return Math.max(count, 1); }
function addBusinessDays(d, count) { const c = new Date(d); if (count === 0) return c; let remaining = Math.abs(count); const dir = count > 0 ? 1 : -1; while (remaining > 0) { c.setUTCDate(c.getUTCDate() + dir); if (isBusinessDay(c)) remaining--; } return c; }

const v = $('Fetch & Validate Task').first().json;
const results = $('Fetch All Study Tasks').first().json.results;
const config = {
  notionApiToken: $('Config').first().json.notionApiToken,
  studyTasksDbId: $('Config').first().json.studyTasksDbId,
  studiesDbId: $('Config').first().json.studiesDbId
};

let cascadeMode = null;
if (v.startDelta === 0 && v.endDelta > 0) cascadeMode = 'push-right';
else if (v.startDelta === 0 && v.endDelta < 0) cascadeMode = 'pull-left';
else if (v.startDelta < 0 && v.endDelta === 0) cascadeMode = 'pull-left';
else if (v.startDelta > 0 && v.endDelta === 0) cascadeMode = 'pull-right';
else if (v.startDelta > 0 && v.endDelta > 0) cascadeMode = 'drag-right';
else if (v.startDelta < 0 && v.endDelta < 0) cascadeMode = 'pull-left';

const hasSubtasksFromGraph = results.some(page => {
  const parentRel = page.properties['Parent Task']?.relation || [];
  return parentRel.some(r => r.id === v.taskId);
});

let parentMode = null;
if (hasSubtasksFromGraph) parentMode = 'case-a';
else if (v.hasParent) parentMode = 'case-b';

// Error 1 fix (expanded BL-R15): Block push-right AND pull-right on TOP-LEVEL parent tasks.
// !v.hasParent prevents false-positive blocking of mid-hierarchy tasks.
if ((cascadeMode === 'push-right' || cascadeMode === 'pull-right') && hasSubtasksFromGraph && !v.hasParent) {
  try {
    const studyId = v.studyId;
    if (studyId) {
      await this.helpers.httpRequest({
        method: 'PATCH',
        url: `https://api.notion.com/v1/pages/${studyId}`,
        headers: { 'Authorization': `Bearer ${config.notionApiToken}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
        body: JSON.stringify({ properties: { 'Import Mode': { checkbox: false }, 'Automation Reporting': { rich_text: [{ text: { content: '\u26a0\ufe0f This task has subtasks \u2014 edit a subtask directly to shift dates and trigger cascading.' }, annotations: { bold: true, color: 'red' } }] } } })
      });
    }
  } catch (e) {}
  return [{ json: { _skip: true, _reason: 'Direct parent edit blocked \u2014 edit subtasks directly', sourceTaskId: v.taskId, sourceTaskName: v.taskName, cascadeMode: null, parentMode: null } }];
}

let startDelta = v.startDelta;
let endDelta = v.endDelta;
let newEnd = v.newEnd;
let refStart = v.refStart;
let refEnd = v.refEnd;
let _staleRefCorrected = false;

const dbSourceTask = results.find(page => page.id === v.taskId);
if (dbSourceTask) {
  const dbRefStart = dbSourceTask.properties['Reference Start Date']?.date?.start;
  const dbRefEnd = dbSourceTask.properties['Reference End Date']?.date?.start;
  if (dbRefStart && dbRefEnd && (dbRefStart !== v.refStart || dbRefEnd !== v.refEnd)) {
    refStart = dbRefStart; refEnd = dbRefEnd;
    startDelta = signedBDDelta(dbRefStart, v.newStart);
    endDelta = signedBDDelta(dbRefEnd, v.newEnd);
    if (startDelta !== 0 && endDelta !== 0 && Math.sign(startDelta) === Math.sign(endDelta)) {
      const origDur = countBDInclusive(parseDate(dbRefStart), parseDate(dbRefEnd));
      const correctedEnd = addBusinessDays(parseDate(v.newStart), origDur - 1);
      newEnd = formatDate(correctedEnd); endDelta = signedBDDelta(dbRefEnd, newEnd);
    }
    cascadeMode = null;
    if (startDelta === 0 && endDelta > 0) cascadeMode = 'push-right';
    else if (startDelta === 0 && endDelta < 0) cascadeMode = 'pull-left';
    else if (startDelta < 0 && endDelta === 0) cascadeMode = 'pull-left';
    else if (startDelta > 0 && endDelta === 0) cascadeMode = 'pull-right';
    else if (startDelta > 0 && endDelta > 0) cascadeMode = 'drag-right';
    else if (startDelta < 0 && endDelta < 0) cascadeMode = 'pull-left';
    _staleRefCorrected = true;
  }
}

return [{ json: { sourceTaskId: v.taskId, sourceTaskName: v.taskName, newStart: v.newStart, newEnd, refStart, refEnd, startDelta, endDelta, cascadeMode, parentTaskId: v.parentTaskId, parentMode, _staleRefCorrected, results, config } }];

// ============================================================
// NODE: Restore Data
// ============================================================
// Restore Classify data + collect WF-D moved task details for WF-P
const c = $('Classify & Build Dispatch').first().json;

// Collect ALL WF-D output items (one per moved task)
const wfDItems = $('Execute WF-D').all() || [];
const movedTaskIds = [];
const movedTaskMap = {}; // taskId -> { newStart, newEnd }

for (const item of wfDItems) {
  const d = item.json || {};
  if (d.taskId) {
    movedTaskIds.push(d.taskId);
    movedTaskMap[d.taskId] = { newStart: d.newStart, newEnd: d.newEnd };
  }
}

// Fallback: if items didn't have individual taskIds, use the summary from first item
if (movedTaskIds.length === 0) {
  const firstItem = wfDItems[0]?.json || {};
  if (firstItem.movedTaskIds) {
    movedTaskIds.push(...firstItem.movedTaskIds);
  }
  if (firstItem.movedTaskMap) {
    Object.assign(movedTaskMap, firstItem.movedTaskMap);
  }
}

return [{ json: { ...c, movedTaskIds, movedTaskMap } }];

// ============================================================
// NODE: Log Test Results
// ============================================================
// Universal Activity Log — Date Cascade (with duration)
// v1
const fetchData = $('Fetch & Validate Task').first().json || {};
const classifyData = $('Classify & Build Dispatch').first().json || {};

// Skip if this was an anti-loop skip (no cascade mode determined)
const cascadeMode = classifyData.cascadeMode || fetchData.cascadeMode;
if (!cascadeMode) {
  return [{json: $input.first().json}]; // pass through without logging
}

const taskName = fetchData.taskName || 'unknown';
const taskId = fetchData.taskId || null;
const startDelta = classifyData.startDelta || 0;
const endDelta = classifyData.endDelta || 0;
const studyName = fetchData.studyName || null;
const triggeredByUserId = $('Webhook').first().json.body?.data?.last_edited_by?.id || null;

// Compute duration
const startTime = new Date($execution.startedAt || new Date()).getTime();
const endTime = Date.now();
const durationMs = endTime - startTime;
const durationSec = Math.round(durationMs / 1000);
const durationMin = (durationSec / 60).toFixed(1);
const durationStr = durationSec >= 60 ? `${durationMin} min` : `${durationSec}s`;

const token = $('Config').first().json.notionApiToken;

const payload = {
  workflow: 'Date Cascade',
  triggerType: 'Automation',
  cascadeMode: cascadeMode,
  sourceTaskId: taskId,
  sourceTaskName: taskName,
  studyId: fetchData.studyId || null,
  studyName: studyName,
  status: 'Success',
  summary: `${cascadeMode}: ${taskName} \u2014 ${startDelta} start delta, ${endDelta} end delta`,
  details: {
    cascadeMode: cascadeMode,
    parentMode: classifyData.parentMode,
    startDelta: startDelta,
    endDelta: endDelta,
    originalStart: fetchData.refStart,
    originalEnd: fetchData.refEnd,
    modifiedStart: fetchData.newStart,
    modifiedEnd: fetchData.newEnd
  },
  originalStart: fetchData.refStart || null,
  originalEnd: fetchData.refEnd || null,
  modifiedStart: fetchData.newStart || null,
  modifiedEnd: fetchData.newEnd || null,
  duration: durationStr,
  durationSeconds: durationSec,
  triggeredByUserId,
  executionId: $execution.id,
  timestamp: new Date().toISOString()
};

try {
  await this.helpers.httpRequest({
    method: 'POST',
    url: 'https://primary-production-022b.up.railway.app/webhook/picnic-test-log',
    headers: { 'Content-Type': 'application/json' },
    body: payload
  });
} catch (e) { /* silent */ }

return [{json: $input.first().json}];

// ============================================================
// NODE: Cleanup LMBS
// ============================================================
// Batch-clear LMBS on all study tasks after cascade
// These PATCHes only change a checkbox (not Dates), so they
// don't trigger the "When Dates changes" Notion automation.
const token = $('Config').first().json.notionApiToken;
const dbId = $('Config').first().json.studyTasksDbId;
const studyId = $('Fetch & Validate Task').first().json.studyId;

// Query tasks with LMBS=true for this study
let tasksToClean = [];
let hasMore = true;
let cursor = undefined;
while (hasMore) {
  const body = {
    filter: {
      and: [
        { property: 'Study', relation: { contains: studyId } },
        { property: 'Last Modified By System', checkbox: { equals: true } }
      ]
    },
    page_size: 100
  };
  if (cursor) body.start_cursor = cursor;
  const resp = await this.helpers.httpRequest({
    method: 'POST',
    url: `https://api.notion.com/v1/databases/${dbId}/query`,
    headers: { 'Authorization': `Bearer ${token}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  tasksToClean = tasksToClean.concat(resp.results.map(r => r.id));
  hasMore = resp.has_more;
  cursor = resp.next_cursor;
}

// Batch clear LMBS (10 concurrent, 500ms between batches)
const BATCH = 3;
for (let i = 0; i < tasksToClean.length; i += BATCH) {
  const batch = tasksToClean.slice(i, i + BATCH);
  await Promise.all(batch.map(id =>
    this.helpers.httpRequest({
      method: 'PATCH',
      url: `https://api.notion.com/v1/pages/${id}`,
      headers: { 'Authorization': `Bearer ${token}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
      body: JSON.stringify({ properties: { 'Last Modified By System': { checkbox: false } } })
    })
  ));
  if (i + BATCH < tasksToClean.length) await new Promise(r => setTimeout(r, 1000));
}

return [{ json: { ...($input.first().json), lmbsCleaned: tasksToClean.length } }];

// ============================================================
// NODE: Report Error
// ============================================================
// PATCH study Automation Reporting with error message
const token = $('Config').first().json.notionApiToken;
const studyId = $('Fetch & Validate Task').first().json.studyId;
const taskName = $('Fetch & Validate Task').first().json.taskName || 'unknown';

// Collect error info from whichever node errored
const errorInfo = $input.first().json;
const errorMsg = errorInfo.error?.message || errorInfo.message || 'Unknown error';

const reportBody = {
  properties: {
    'Automation Reporting': {
      rich_text: [{
        text: { content: `\u274c Cascade failed for ${taskName}: ${errorMsg.substring(0, 200)}. The date change may not have cascaded to downstream tasks. Try editing the date again, or contact support if the issue persists.` },
        annotations: { bold: true, color: 'red_background' }
      }]
    }
  }
};

try {
  await this.helpers.httpRequest({
    method: 'PATCH',
    url: `https://api.notion.com/v1/pages/${studyId}`,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json'
    },
    body: reportBody
  });
} catch (e) { /* silent - don't let reporting failure block Import Mode cleanup */ }

return [{ json: $input.first().json }];

// ============================================================
// NODE: Report Start
// ============================================================
// PATCH study Automation Reporting with cascade started message
const token = $('Config').first().json.notionApiToken;
const studyId = $('Fetch & Validate Task').first().json.studyId;
const taskName = $('Fetch & Validate Task').first().json.taskName || 'unknown';

const reportBody = {
  properties: {
    'Automation Reporting': {
      rich_text: [{
        text: { content: `\ud83c\udd95 Cascade started for ${taskName}... Do not edit this study's tasks or press other buttons until complete.` },
        annotations: { color: 'blue_background' }
      }]
    }
  }
};

try {
  await this.helpers.httpRequest({
    method: 'PATCH',
    url: `https://api.notion.com/v1/pages/${studyId}`,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json'
    },
    body: reportBody
  });
} catch (e) { /* silent */ }

return [{ json: $input.first().json }];

// ============================================================
// NODE: Report Complete
// ============================================================
// Skip success message if cascade was rejected (Error 1 block)
const classifyOutput = $('Classify & Build Dispatch').first().json;
if (classifyOutput._skip) {
  return $input.all(); // Pass through without overwriting Automation Reporting
}

// PATCH study Automation Reporting with cascade complete message
const token = $('Config').first().json.notionApiToken;
const studyId = $('Fetch & Validate Task').first().json.studyId;
const taskName = $('Fetch & Validate Task').first().json.taskName || 'unknown';
const classifyData = $('Classify & Build Dispatch').first().json || {};
const cascadeMode = classifyData.cascadeMode || 'cascade';
const parentMode = classifyData.parentMode || '';

// Build summary from upstream execution results
const wfDOutput = $('Execute WF-D').first().json || {};
const wfPOutput = $('Execute WF-P').first().json || {};
const parts = [];
if (wfDOutput.taskId) parts.push(cascadeMode);
if (wfPOutput.taskId) parts.push(parentMode === 'case-a' ? 'subtask shift' : 'roll-up');
const summary = parts.length > 0 ? parts.join(' + ') : cascadeMode;

const reportBody = {
  properties: {
    'Automation Reporting': {
      rich_text: [{
        text: { content: `\u2747\ufe0f Cascade complete for ${taskName}: ${summary}` },
        annotations: { bold: true, color: 'green_background' }
      }]
    }
  }
};

try {
  await this.helpers.httpRequest({
    method: 'PATCH',
    url: `https://api.notion.com/v1/pages/${studyId}`,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json'
    },
    body: reportBody
  });
} catch (e) { /* silent */ }

return [{ json: $input.first().json }];

// ============================================================
// NODE: Enforce Constraints
// ============================================================
// ============================================================
// Enforce Constraints — snap source task to minimum valid
// position when user's dates violate blocker constraints.
// v1 2026-03-23: Fix Bug #21 — prevents full revert to ref
// v2 2026-03-23: Fix Bug #24 — merge WF-P roll-up dates so
//   Update Source Ref doesn't overwrite the roll-up result
// v3 2026-03-27: Fix BL-H1d/e — for case-a, use roll-up dates
//   directly instead of min/max merge. Weekend parent dates from
//   user drag must not persist; roll-up = BD-normalized truth.
// ============================================================

const v = $('Fetch & Validate Task').first().json;
const restore = $('Restore Data').first().json;
const allTaskPages = restore.results || [];
const movedTaskMap = restore.movedTaskMap || {};

// Read WF-P output — Execute WF-P returns Format Output's item
const wfpOutput = $('Execute WF-P').first().json;
const rolledUpStart = wfpOutput.rolledUpStart || null;
const rolledUpEnd = wfpOutput.rolledUpEnd || null;
const parentMode = wfpOutput.parentMode || '';

// BD arithmetic
function parseDate(s) { return s ? new Date(s + 'T00:00:00Z') : null; }
function formatDate(d) { return d.toISOString().split('T')[0]; }
function isBusinessDay(d) { const day = d.getUTCDay(); return day !== 0 && day !== 6; }
function nextBusinessDay(d) {
  const n = new Date(d);
  do { n.setUTCDate(n.getUTCDate() + 1); } while (!isBusinessDay(n));
  return n;
}
function addBusinessDays(d, count) {
  const c = new Date(d);
  if (count === 0) return c;
  let remaining = Math.abs(count);
  const dir = count > 0 ? 1 : -1;
  while (remaining > 0) {
    c.setUTCDate(c.getUTCDate() + dir);
    if (isBusinessDay(c)) remaining--;
  }
  return c;
}
function countBDInclusive(start, end) {
  if (!start || !end || end < start) return 1;
  let count = 0;
  const c = new Date(start);
  while (c <= end) {
    if (isBusinessDay(c)) count++;
    c.setUTCDate(c.getUTCDate() + 1);
  }
  return Math.max(count, 1);
}

let newStart = v.newStart;
let newEnd = v.newEnd;
let constrained = false;

// Build taskById from study tasks
const taskById = {};
for (const page of allTaskPages) {
  const id = page.id;
  const p = page.properties;
  const dStart = p['Dates']?.date?.start || null;
  const dEnd = p['Dates']?.date?.end || dStart;
  taskById[id] = {
    id,
    start: dStart,
    end: dEnd,
    blockedByIds: (p['Blocked by']?.relation || []).map(r => r.id),
    blockingIds: (p['Blocking']?.relation || []).map(r => r.id),
    status: p['Status']?.status?.name || ''
  };
}

const sourceTask = taskById[v.taskId];
if (sourceTask) {
  const blockerIds = sourceTask.blockedByIds || [];

  if (blockerIds.length > 0) {
    // Compute earliestAllowedStart from all blockers
    let earliestAllowed = null;

    for (const blockerId of blockerIds) {
      // Use moved position from WF-D if blocker was shifted
      let blockerEnd = null;
      if (movedTaskMap[blockerId]) {
        blockerEnd = parseDate(movedTaskMap[blockerId].newEnd);
      } else if (taskById[blockerId]) {
        blockerEnd = parseDate(taskById[blockerId].end);
      }
      if (!blockerEnd) continue;

      // Skip frozen blockers (Done/N/A) — they don't constrain
      const blockerStatus = taskById[blockerId]?.status || '';
      if (blockerStatus === 'Done' || blockerStatus === 'N/A') continue;

      const candidate = nextBusinessDay(blockerEnd);
      if (!earliestAllowed || candidate > earliestAllowed) {
        earliestAllowed = candidate;
      }
    }

    // If source start violates constraint, snap to minimum valid
    if (earliestAllowed) {
      const currentStart = parseDate(newStart);
      if (currentStart < earliestAllowed) {
        newStart = formatDate(earliestAllowed);
        // Preserve BD duration
        const originalDuration = countBDInclusive(
          parseDate(v.refStart), parseDate(v.refEnd)
        );
        const correctedEnd = addBusinessDays(earliestAllowed, originalDuration - 1);
        newEnd = formatDate(correctedEnd);
        constrained = true;
      }
    }
  }
}

// ============================================================
// BL-H1d/e fix: Apply WF-P roll-up dates for case-a
// When WF-P performed a case-a roll-up, the parent's dates
// must be the BD-normalized subtask range (min start, max end).
// The user's drag may have landed on a weekend — the roll-up
// is the authoritative source of truth. Use it directly.
//
// For non-case-a (case-b or no parent mode), rolledUpStart/End
// will be null (Format Output only sets them for case-a where
// taskId === sourceTaskId), so this block is skipped.
// ============================================================

let merged = false;
if (rolledUpStart && rolledUpEnd) {
  // Case-a: use roll-up dates directly — they are BD-normalized
  // and represent the actual min/max of shifted subtask dates.
  // Do NOT merge with user dates via min/max — that preserves
  // weekend dates from the user's drag (BL-H1d root cause).
  newStart = rolledUpStart;
  newEnd = rolledUpEnd;
  merged = true;
}

let _log = '';
if (constrained && merged) {
  _log = 'Constraint enforced + case-a roll-up applied: ' + newStart + ' to ' + newEnd;
} else if (constrained) {
  _log = 'Constraint enforced: snapped start to ' + newStart + ' (min valid after blocker)';
} else if (merged) {
  _log = 'Case-a roll-up applied: parent normalized to ' + newStart + ' to ' + newEnd + ' (BD-normalized subtask range)';
} else {
  _log = 'No constraint violation, no roll-up — using user dates as-is';
}

return [{ json: {
  taskId: v.taskId,
  newStart,
  newEnd,
  constrained,
  merged,
  _log
}}];

