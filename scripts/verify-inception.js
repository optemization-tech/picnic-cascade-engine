/**
 * Verify inception output — checks every task for a study.
 *
 * Usage: node scripts/verify-inception.js <studyPageId>
 */

import 'dotenv/config';
import { NotionClient } from '../src/notion/client.js';
import { STUDY_TASKS_PROPS, findById } from '../src/notion/property-names.js';

const studyPageId = process.argv[2];
if (!studyPageId) {
  console.error('Usage: node scripts/verify-inception.js <studyPageId>');
  process.exit(1);
}

const tokens = [];
for (let i = 1; i <= 10; i++) {
  const t = process.env[`NOTION_PROVISION_TOKEN_${i}`] || process.env[`NOTION_TOKEN_${i}`];
  if (t) tokens.push(t);
}
if (tokens.length === 0) {
  console.error('No tokens found');
  process.exit(1);
}

const client = new NotionClient({ tokens });
const studyTasksDbId = process.env.STUDY_TASKS_DB_ID;

// 1. Query ALL tasks for this study (paginated)
console.log(`\nQuerying all tasks for study ${studyPageId}...`);
const allTasks = await client.queryDatabase(
  studyTasksDbId,
  { property: STUDY_TASKS_PROPS.STUDY.id, relation: { contains: studyPageId } },
  100,
);

console.log(`\nTotal tasks found: ${allTasks.length}\n`);

// 2. Validate each task
const issues = [];
let noDateCount = 0;
let noTemplateIdCount = 0;
let noParentCount = 0;
let hasBlockedByCount = 0;
let hasBlockingCount = 0;
let hasContentCount = 0;
const ownerRoles = {};
const tagNames = {};
const earliestDate = { date: '9999-99-99', task: '' };
const latestDate = { date: '0000-00-00', task: '' };

for (const task of allTasks) {
  const name = findById(task, STUDY_TASKS_PROPS.TASK_NAME)?.title?.[0]?.plain_text || '(no name)';
  const id = task.id;

  // Dates
  const dates = findById(task, STUDY_TASKS_PROPS.DATES)?.date;
  const startDate = dates?.start;
  const endDate = dates?.end;
  if (!startDate) {
    issues.push(`[NO START DATE] ${name} (${id})`);
    noDateCount++;
  } else {
    if (startDate < earliestDate.date) { earliestDate.date = startDate; earliestDate.task = name; }
    if (startDate > latestDate.date) { latestDate.date = startDate; latestDate.task = name; }
  }
  if (!endDate) {
    issues.push(`[NO END DATE] ${name} (${id})`);
  }

  // Reference dates should match
  const refStart = findById(task, STUDY_TASKS_PROPS.REF_START)?.date?.start;
  const refEnd = findById(task, STUDY_TASKS_PROPS.REF_END)?.date?.start;
  if (refStart && startDate && refStart !== startDate) {
    issues.push(`[REF START MISMATCH] ${name}: ref=${refStart} actual=${startDate}`);
  }
  if (refEnd && endDate && refEnd !== endDate) {
    issues.push(`[REF END MISMATCH] ${name}: ref=${refEnd} actual=${endDate}`);
  }

  // Template Source ID
  const templateId = findById(task, STUDY_TASKS_PROPS.TEMPLATE_SOURCE_ID)?.rich_text?.[0]?.plain_text;
  if (!templateId) {
    issues.push(`[NO TEMPLATE ID] ${name} (${id})`);
    noTemplateIdCount++;
  }

  // Study relation
  const studyRel = findById(task, STUDY_TASKS_PROPS.STUDY)?.relation;
  if (!studyRel || studyRel.length === 0 || studyRel[0].id !== studyPageId) {
    issues.push(`[WRONG STUDY] ${name} (${id})`);
  }

  // Parent task (count, don't flag — root tasks have no parent)
  const parentRel = findById(task, STUDY_TASKS_PROPS.PARENT_TASK)?.relation;
  if (parentRel && parentRel.length > 0) noParentCount++;

  // Blocked by / Blocking
  const blockedBy = findById(task, STUDY_TASKS_PROPS.BLOCKED_BY)?.relation || [];
  const blocking = findById(task, STUDY_TASKS_PROPS.BLOCKING)?.relation || [];
  if (blockedBy.length > 0) hasBlockedByCount++;
  if (blocking.length > 0) hasBlockingCount++;

  // LMBS flag
  const lmbs = findById(task, STUDY_TASKS_PROPS.LMBS)?.checkbox;
  if (lmbs !== true) {
    issues.push(`[LMBS NOT SET] ${name} (${id})`);
  }

  // Owner Role
  const role = findById(task, STUDY_TASKS_PROPS.OWNER_ROLE)?.select?.name;
  if (role) ownerRoles[role] = (ownerRoles[role] || 0) + 1;

  // Tags
  const tags = findById(task, STUDY_TASKS_PROPS.TAGS)?.multi_select || [];
  for (const tag of tags) {
    tagNames[tag.name] = (tagNames[tag.name] || 0) + 1;
  }

  // Status
  const status = findById(task, STUDY_TASKS_PROPS.STATUS)?.status?.name;
  if (status !== 'Not started') {
    issues.push(`[UNEXPECTED STATUS] ${name}: ${status}`);
  }
}

// 3. Check content blocks (sample 20 random tasks)
console.log('Checking content blocks on 20 random tasks...');
const sample = allTasks.sort(() => Math.random() - 0.5).slice(0, 20);
for (const task of sample) {
  const name = findById(task, STUDY_TASKS_PROPS.TASK_NAME)?.title?.[0]?.plain_text || '(no name)';
  try {
    const blocks = await client.request('GET', `/blocks/${task.id}/children?page_size=1`);
    if (blocks.results && blocks.results.length > 0) {
      hasContentCount++;
    }
  } catch {
    // skip
  }
}

// 4. Report
console.log('═══════════════════════════════════════════');
console.log('  INCEPTION VERIFICATION REPORT');
console.log('═══════════════════════════════════════════\n');

console.log(`Total tasks:          ${allTasks.length}`);
console.log(`Tasks with parent:    ${noParentCount} / ${allTasks.length}`);
console.log(`Tasks with Blocked by:${hasBlockedByCount} / ${allTasks.length}`);
console.log(`Tasks with Blocking:  ${hasBlockingCount} / ${allTasks.length}`);
console.log(`Date range:           ${earliestDate.date} (${earliestDate.task})`);
console.log(`                   →  ${latestDate.date} (${latestDate.task})`);
console.log(`Content blocks:       ${hasContentCount}/20 sampled tasks have blocks\n`);

console.log('Owner Roles:');
for (const [role, count] of Object.entries(ownerRoles).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${role}: ${count}`);
}

console.log('\nTags:');
for (const [tag, count] of Object.entries(tagNames).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${tag}: ${count}`);
}

if (issues.length === 0) {
  console.log('\n✅ ALL CHECKS PASSED — zero issues found.\n');
} else {
  console.log(`\n⚠️  ${issues.length} ISSUES FOUND:\n`);
  for (const issue of issues) {
    console.log(`  ${issue}`);
  }
}
