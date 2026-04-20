import { NotionClient } from '../src/notion/client.js';
import { queryStudyTasks } from '../src/notion/queries.js';
import { findBlockerStartViolations, extractStudyPageId } from '../src/verify/blocker-starts.js';

const STUDIES_DB_ID = 'cad23867-60c2-836f-a27d-0131c25b6dcd';
const STUDY_TASKS_DB_ID = '40f23867-60c2-830e-aad6-8159ca69a8d6';

function collectShellTokens() {
  const tokens = [];
  if (process.env.NOTION_TOKEN) tokens.push(process.env.NOTION_TOKEN);
  for (let i = 1; i <= 10; i++) {
    const token = process.env[`NOTION_TOKEN_${i}`];
    if (token) tokens.push(token);
  }
  return [...new Set(tokens)];
}

function usageAndExit(message = '') {
  if (message) console.error(message);
  console.error('Usage: node scripts/check-study-blocker-starts.js <study-url-or-page-id>');
  process.exit(1);
}

const studyRef = process.argv[2];
if (!studyRef) usageAndExit('Missing study URL or page ID');

const studyPageId = extractStudyPageId(studyRef);
if (!studyPageId) usageAndExit(`Could not parse study page ID from: ${studyRef}`);

const tokens = collectShellTokens();
if (tokens.length === 0) usageAndExit('Missing NOTION_TOKEN / NOTION_TOKEN_* env vars in the current shell');

const client = new NotionClient({ tokens });

function getTitleFromProperties(properties = {}) {
  const titleProp = Object.values(properties).find((prop) => prop?.type === 'title');
  return (titleProp?.title || []).map((chunk) => chunk.plain_text || '').join('').trim();
}

async function resolveStudyContext(exactStudyPageId) {
  let studyName = exactStudyPageId;
  try {
    const studyPage = await client.getPage(exactStudyPageId);
    const parentDbId = studyPage?.parent?.database_id || '';
    if (parentDbId && parentDbId.replaceAll('-', '').toLowerCase() !== STUDIES_DB_ID.replaceAll('-', '').toLowerCase()) {
      console.error(`Warning: study page ${exactStudyPageId} is not in configured Studies Database ${STUDIES_DB_ID}`);
    }
    const title = getTitleFromProperties(studyPage.properties);
    if (title) studyName = title;
  } catch {}

  const tasks = await queryStudyTasks(client, STUDY_TASKS_DB_ID, exactStudyPageId);

  return {
    studyPageId: exactStudyPageId,
    studyName,
    tasks,
  };
}

const {
  studyPageId: resolvedStudyPageId,
  studyName,
  tasks,
} = await resolveStudyContext(studyPageId);

console.error(`Checking blocker-start invariant for study ${studyName} (${resolvedStudyPageId})...`);
const violations = findBlockerStartViolations(tasks);
const tasksWithBlockers = tasks.filter((task) => (task.blockedByIds || []).length > 0).length;

console.log(`Study: ${studyName}`);
console.log(`Study ID: ${resolvedStudyPageId}`);
console.log(`Tasks scanned: ${tasks.length}`);
console.log(`Tasks with blockers: ${tasksWithBlockers}`);

if (violations.length === 0) {
  console.log('Result: PASS');
  process.exit(0);
}

console.log(`Result: FAIL (${violations.length} violation${violations.length === 1 ? '' : 's'})`);

for (const violation of violations) {
  if (violation.type === 'start_mismatch') {
    console.log(
      `- [start_mismatch] ${violation.taskName} (${violation.taskId}): actual ${violation.actualStart}, expected ${violation.expectedStart} from ${violation.bindingBlockerName} (${violation.bindingBlockerId}) ending ${violation.bindingBlockerEnd}`,
    );
    continue;
  }
  if (violation.type === 'missing_task_start') {
    console.log(`- [missing_task_start] ${violation.taskName} (${violation.taskId}) has blockers but no start date`);
    continue;
  }
  if (violation.type === 'missing_blocker') {
    console.log(`- [missing_blocker] ${violation.taskName} (${violation.taskId}) references missing blocker(s): ${violation.missingBlockerIds.join(', ')}`);
    continue;
  }
  if (violation.type === 'missing_blocker_end') {
    const detail = violation.blockersMissingEnd
      .map((blocker) => `${blocker.blockerName} (${blocker.blockerId})`)
      .join(', ');
    console.log(`- [missing_blocker_end] ${violation.taskName} (${violation.taskId}) has blocker(s) without end dates: ${detail}`);
  }
}

process.exit(1);
