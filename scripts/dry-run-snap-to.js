import { config as dotenvConfig } from 'dotenv';
import { parseDate, formatDate, nextBusinessDay, countBDInclusive, addBusinessDays } from '../src/utils/business-days.js';

dotenvConfig();

const NOTION_BASE = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';
const token = process.env.NOTION_TOKEN_1;
const dbId = process.env.STUDY_TASKS_DB_ID;

if (!token || !dbId) {
  console.error('Missing NOTION_TOKEN_1 or STUDY_TASKS_DB_ID in .env');
  process.exit(1);
}

async function notionRequest(method, path, body) {
  const resp = await fetch(`${NOTION_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  if (!resp.ok) {
    console.error(`Notion ${method} ${path}: ${resp.status}`);
    console.error(text.slice(0, 300));
    return null;
  }
  return JSON.parse(text);
}

// Fetch ALL tasks from the Study Tasks DB (paginated)
async function fetchAllTasks() {
  const tasks = [];
  let cursor = undefined;
  let page = 0;
  while (true) {
    page++;
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const result = await notionRequest('POST', `/databases/${dbId}/query`, body);
    if (!result) break;
    tasks.push(...result.results);
    console.error(`  Page ${page}: ${result.results.length} tasks (${tasks.length} total)`);
    if (!result.has_more) break;
    cursor = result.next_cursor;
  }
  return tasks;
}

function normalize(page) {
  const p = page.properties || {};
  const startStr = p['Dates']?.date?.start || null;
  const endStr = p['Dates']?.date?.end || startStr;
  const start = parseDate(startStr);
  const end = parseDate(endStr);
  return {
    id: page.id,
    name: p['Task Name']?.title?.[0]?.plain_text || p['Name']?.title?.[0]?.plain_text || page.id.substring(0, 8),
    start,
    end,
    startStr,
    endStr,
    duration: (start && end) ? countBDInclusive(start, end) : 1,
    status: p['Status']?.status?.name || '',
    blockedByIds: (p['Blocked by']?.relation || []).map(r => r.id),
    blockingIds: (p['Blocking']?.relation || []).map(r => r.id),
    parentId: (p['Parent Task']?.relation || [])[0]?.id || null,
    studyId: (p['Study']?.relation || [])[0]?.id || null,
  };
}

// ========== ANALYSIS ==========

console.error('\n=== Snap-To Dry Run Analysis ===\n');
console.error('Fetching all tasks from Study Tasks DB...');
const rawPages = await fetchAllTasks();
const allTasks = rawPages.map(normalize);
const taskMap = new Map(allTasks.map(t => [t.id, t]));

console.error(`\nTotal tasks: ${allTasks.length}`);

// ---- STAT 1: Dependency graph stats ----
const withPredecessors = allTasks.filter(t => t.blockedByIds.length > 0);
const withSuccessors = allTasks.filter(t => t.blockingIds.length > 0);
const withMultiplePreds = allTasks.filter(t => t.blockedByIds.length > 1);
const withParent = allTasks.filter(t => t.parentId);
const parents = allTasks.filter(t => allTasks.some(c => c.parentId === t.id));
const withDates = allTasks.filter(t => t.start && t.end);
const frozen = allTasks.filter(t => t.status === 'Done' || t.status === 'N/A');

// Study grouping
const studies = new Map();
for (const t of allTasks) {
  const sid = t.studyId || 'no-study';
  if (!studies.has(sid)) studies.set(sid, []);
  studies.get(sid).push(t);
}

console.log('\n========================================');
console.log('  DEPENDENCY GRAPH STATISTICS');
console.log('========================================');
console.log(`Total tasks:           ${allTasks.length}`);
console.log(`Tasks with dates:      ${withDates.length}`);
console.log(`Tasks with preds:      ${withPredecessors.length} (${Math.round(100*withPredecessors.length/allTasks.length)}%)`);
console.log(`Tasks with 2+ preds:   ${withMultiplePreds.length}`);
console.log(`Tasks with successors: ${withSuccessors.length}`);
console.log(`Parent tasks:          ${parents.length}`);
console.log(`Subtasks:              ${withParent.length}`);
console.log(`Frozen (Done/N/A):     ${frozen.length}`);
console.log(`Studies:               ${studies.size}`);
for (const [sid, tasks] of studies) {
  const name = sid === 'no-study' ? '(no study)' : sid.substring(0, 8);
  console.log(`  ${name}: ${tasks.length} tasks`);
}

// Max predecessor counts
const predCounts = withPredecessors.map(t => t.blockedByIds.length).sort((a, b) => b - a);
if (predCounts.length > 0) {
  console.log(`\nMax predecessors:      ${predCounts[0]}`);
  console.log(`Avg predecessors:      ${(predCounts.reduce((a,b)=>a+b,0)/predCounts.length).toFixed(1)}`);
}

// Chain depth via BFS
function maxChainDepth(tasks, taskMap) {
  const depths = new Map();
  // Process in topological order
  const inDegree = new Map();
  for (const t of tasks) inDegree.set(t.id, t.blockedByIds.filter(id => taskMap.has(id)).length);
  const queue = [];
  for (const t of tasks) {
    if (inDegree.get(t.id) === 0) {
      queue.push(t.id);
      depths.set(t.id, 0);
    }
  }
  let maxD = 0;
  while (queue.length > 0) {
    const id = queue.shift();
    const task = taskMap.get(id);
    const d = depths.get(id);
    for (const succId of task.blockingIds) {
      if (!taskMap.has(succId)) continue;
      const newD = d + 1;
      if (!depths.has(succId) || depths.get(succId) < newD) {
        depths.set(succId, newD);
      }
      inDegree.set(succId, inDegree.get(succId) - 1);
      if (inDegree.get(succId) === 0) {
        queue.push(succId);
        maxD = Math.max(maxD, depths.get(succId));
      }
    }
  }
  // Check for cycles
  const processed = depths.size;
  const unprocessed = tasks.length - processed;
  return { maxD, unprocessed };
}

const { maxD, unprocessed } = maxChainDepth(allTasks, taskMap);
console.log(`Max chain depth:       ${maxD}`);
if (unprocessed > 0) {
  console.log(`⚠️  CYCLES DETECTED:    ${unprocessed} tasks in cycles`);
}

// ---- STAT 2: Gap analysis ----
console.log('\n========================================');
console.log('  GAP ANALYSIS');
console.log('========================================');

const gaps = [];
for (const task of withPredecessors) {
  if (!task.start) continue;
  for (const predId of task.blockedByIds) {
    const pred = taskMap.get(predId);
    if (!pred || !pred.end) continue;
    const expectedStart = nextBusinessDay(pred.end);
    const gapBD = Math.round((task.start - expectedStart) / (1000 * 60 * 60 * 24));
    // Approximate BD gap (not exact, but close enough for analysis)
    if (gapBD !== 0) {
      gaps.push({
        taskName: task.name,
        taskId: task.id.substring(0, 8),
        predName: pred.name,
        predId: pred.id.substring(0, 8),
        predEnd: pred.endStr,
        taskStart: task.startStr,
        gapDays: gapBD,
      });
    }
  }
}

const positiveGaps = gaps.filter(g => g.gapDays > 0);
const negativeGaps = gaps.filter(g => g.gapDays < 0);
const zeroGaps = withPredecessors.length * 1 - gaps.length; // approximate

console.log(`Predecessor links:     ${withPredecessors.reduce((s, t) => s + t.blockedByIds.length, 0)}`);
console.log(`Zero-gap (tight):      ${withPredecessors.reduce((s, t) => s + t.blockedByIds.length, 0) - gaps.length}`);
console.log(`Positive gaps (buffer): ${positiveGaps.length}`);
console.log(`Negative gaps (overlap): ${negativeGaps.length}`);

if (positiveGaps.length > 0) {
  console.log('\nAll positive gaps (task would snap earlier):');
  positiveGaps.sort((a, b) => b.gapDays - a.gapDays);
  for (const g of positiveGaps) {
    console.log(`  ${g.taskName} (${g.taskId})  ←  ${g.predName} (${g.predId})`);
    console.log(`    pred ends: ${g.predEnd}, task starts: ${g.taskStart}, gap: ${g.gapDays} days`);
  }
}

if (negativeGaps.length > 0) {
  console.log('\nAll negative gaps (task overlaps predecessor):');
  negativeGaps.sort((a, b) => a.gapDays - b.gapDays);
  for (const g of negativeGaps) {
    console.log(`  ${g.taskName} (${g.taskId})  ←  ${g.predName} (${g.predId})`);
    console.log(`    pred ends: ${g.predEnd}, task starts: ${g.taskStart}, overlap: ${Math.abs(g.gapDays)} days`);
  }
}

// ---- STAT 3: Snap-to simulation ----
console.log('\n========================================');
console.log('  SNAP-TO SIMULATION');
console.log('========================================');
console.log('Computing what would happen if every successor snapped to nextBD(max(predecessor ends))...\n');

const wouldMove = [];
for (const task of withPredecessors) {
  if (!task.start) continue;
  if (task.status === 'Done' || task.status === 'N/A') continue; // frozen

  // Find most constraining predecessor
  let latestPredEnd = null;
  let bindingPred = null;
  for (const predId of task.blockedByIds) {
    const pred = taskMap.get(predId);
    if (!pred || !pred.end) continue;
    if (pred.status === 'Done' || pred.status === 'N/A') continue; // skip frozen
    if (!latestPredEnd || pred.end > latestPredEnd) {
      latestPredEnd = pred.end;
      bindingPred = pred;
    }
  }
  if (!latestPredEnd) continue;

  const computedStart = nextBusinessDay(latestPredEnd);
  const currentStart = task.start;

  // Compare
  if (computedStart.getTime() !== currentStart.getTime()) {
    const delta = Math.round((computedStart - currentStart) / (1000 * 60 * 60 * 24));
    wouldMove.push({
      taskName: task.name,
      taskId: task.id.substring(0, 8),
      currentStart: task.startStr,
      computedStart: formatDate(computedStart),
      deltaDays: delta,
      bindingPred: bindingPred.name,
      bindingPredEnd: bindingPred.endStr,
    });
  }
}

console.log(`Tasks that would move: ${wouldMove.length} of ${withPredecessors.filter(t => t.start).length} with predecessors`);
console.log(`Tasks that stay put:   ${withPredecessors.filter(t => t.start).length - wouldMove.length}`);

const wouldMoveEarlier = wouldMove.filter(m => m.deltaDays < 0);
const wouldMoveLater = wouldMove.filter(m => m.deltaDays > 0);

console.log(`Would move earlier:    ${wouldMoveEarlier.length}`);
console.log(`Would move later:      ${wouldMoveLater.length}`);

if (wouldMoveEarlier.length > 0) {
  console.log('\n--- Tasks that would SNAP EARLIER (gap collapse) ---');
  wouldMoveEarlier.sort((a, b) => a.deltaDays - b.deltaDays);
  for (const m of wouldMoveEarlier) {
    console.log(`  ${m.taskName} (${m.taskId})`);
    console.log(`    ${m.currentStart} → ${m.computedStart}  (${m.deltaDays} days, binding pred: ${m.bindingPred} ends ${m.bindingPredEnd})`);
  }
}

if (wouldMoveLater.length > 0) {
  console.log('\n--- Tasks that would MOVE LATER (predecessor constraint) ---');
  wouldMoveLater.sort((a, b) => b.deltaDays - a.deltaDays);
  for (const m of wouldMoveLater) {
    console.log(`  ${m.taskName} (${m.taskId})`);
    console.log(`    ${m.currentStart} → ${m.computedStart}  (+${m.deltaDays} days, binding pred: ${m.bindingPred} ends ${m.bindingPredEnd})`);
  }
}

// ---- STAT 4: Blocked By relation clearing test (read-only) ----
console.log('\n========================================');
console.log('  RELATION CLEARING FEASIBILITY');
console.log('========================================');

// Just verify the property structure — don't modify anything
if (withPredecessors.length > 0) {
  const sample = withPredecessors[0];
  const raw = rawPages.find(p => p.id === sample.id);
  const blockedByRaw = raw?.properties?.['Blocked by'];
  console.log(`Property type: ${blockedByRaw?.type}`);
  console.log(`Sample relation value: ${JSON.stringify(blockedByRaw?.relation?.slice(0, 2))}`);
  console.log(`\nTo clear, PATCH body would be:`);
  console.log(`  { "properties": { "Blocked by": { "relation": [] } } }`);
  console.log(`\n⚠️  NOT executed — read-only analysis. Run manually to verify.`);
}

console.log('\n========================================');
console.log('  DONE');
console.log('========================================');
