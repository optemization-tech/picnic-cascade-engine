import { config as dotenvConfig } from 'dotenv';
import { parseDate, formatDate, addBusinessDays } from '../src/utils/business-days.js';

dotenvConfig();

function getArg(name, fallback = null) {
  const flag = `--${name}`;
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

function usageAndExit(message = '') {
  if (message) console.error(message);
  console.error('Usage: npm run benchmark -- --study-id <id> --task-id <pageId> --delta <BD> [--url <endpoint>] [--token <token>] [--timeout <ms>]');
  console.error('  --delta: signed integer business days (e.g. 3, -2)');
  console.error('  --url: webhook base URL (default: http://localhost:3000)');
  console.error('  --timeout: max ms to poll for completion (default: 120000)');
  process.exit(1);
}

const NOTION_BASE = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

const studyId = getArg('study-id');
const taskId = getArg('task-id');
const deltaStr = getArg('delta');
const baseUrl = getArg('url', 'http://localhost:3000');
const token = getArg('token', process.env.NOTION_TOKEN_1);
const timeoutMs = Number(getArg('timeout', '120000'));
const activityLogDbId = process.env.ACTIVITY_LOG_DB_ID;

if (!studyId) usageAndExit('Missing required --study-id');
if (!taskId) usageAndExit('Missing required --task-id');
if (!deltaStr) usageAndExit('Missing required --delta');
if (!token) usageAndExit('Missing Notion token (use --token or set NOTION_TOKEN_1)');
if (!activityLogDbId) usageAndExit('Missing ACTIVITY_LOG_DB_ID in .env');

const delta = Number.parseInt(deltaStr, 10);
if (Number.isNaN(delta) || delta === 0) usageAndExit('--delta must be a non-zero integer');

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
    console.error(`Notion ${method} ${path} failed: ${resp.status} ${resp.statusText}`);
    console.error(text);
    process.exit(1);
  }
  return JSON.parse(text);
}

// Step 1: Fetch the task
console.log(`Fetching task ${taskId}...`);
const page = await notionRequest('GET', `/pages/${taskId}`);

const dates = page.properties?.['Dates']?.date;
if (!dates?.start) {
  console.error('Task has no Dates property');
  process.exit(1);
}

const currentStart = dates.start;
const currentEnd = dates.end || dates.start;
const taskName = page.properties?.['Task Name']?.title?.[0]?.plain_text
  || page.properties?.['Name']?.title?.[0]?.plain_text
  || taskId.substring(0, 8);

console.log(`Task: ${taskName}`);
console.log(`Current dates: ${currentStart} → ${currentEnd}`);

// Step 2: Compute new dates
const newStart = formatDate(addBusinessDays(parseDate(currentStart), delta));
const newEnd = formatDate(addBusinessDays(parseDate(currentEnd), delta));
console.log(`New dates:     ${newStart} → ${newEnd} (delta: ${delta > 0 ? '+' : ''}${delta} BD)`);

// Step 3: PATCH the task dates (this triggers the Notion automation → webhook → engine)
const startTs = Date.now();
console.log(`\nPatching task dates...`);
await notionRequest('PATCH', `/pages/${taskId}`, {
  properties: {
    'Dates': { date: { start: newStart, end: newEnd } },
  },
});
console.log('Task patched. Waiting for cascade to complete...');

// Step 4: Poll Activity Log for completion
const pollInterval = 3000;
const pollStart = Date.now();
let found = null;

while (Date.now() - pollStart < timeoutMs) {
  await new Promise((r) => setTimeout(r, pollInterval));

  const elapsed = Math.round((Date.now() - startTs) / 1000);
  process.stdout.write(`  Polling... (${elapsed}s elapsed)\r`);

  const results = await notionRequest('POST', `/databases/${activityLogDbId}/query`, {
    filter: {
      and: [
        { property: 'Study Tasks', relation: { contains: taskId } },
        { property: 'Timestamp', date: { on_or_after: new Date(startTs - 5000).toISOString() } },
        {
          or: [
            { property: 'Status', status: { equals: 'Success' } },
            { property: 'Status', status: { equals: 'Failed' } },
            { property: 'Status', status: { equals: 'No Action' } },
          ],
        },
      ],
    },
    sorts: [{ property: 'Timestamp', direction: 'descending' }],
    page_size: 1,
  });

  if (results.results?.length > 0) {
    found = results.results[0];
    break;
  }
}

const totalElapsed = Date.now() - startTs;
console.log(''); // clear the polling line

if (!found) {
  console.error(`\nTimeout: no Activity Log entry found after ${timeoutMs / 1000}s`);
  process.exit(1);
}

// Step 5: Extract timing from the Activity Log entry
const status = found.properties?.['Status']?.status?.name || 'Unknown';
const mode = found.properties?.['Cascade Mode']?.select?.name || 'N/A';
const summary = found.properties?.['Summary']?.rich_text?.[0]?.plain_text || '';

// Read page body for the details JSON block
const blocks = await notionRequest('GET', `/blocks/${found.id}/children?page_size=100`);
let detailsJson = null;
for (const block of blocks.results || []) {
  if (block.type === 'code' && block.code?.language === 'json') {
    try {
      detailsJson = JSON.parse(block.code.rich_text?.[0]?.plain_text || '{}');
    } catch { /* ignore parse errors */ }
  }
}

// Step 6: Report
console.log('=== Benchmark Report ===');
console.log(`Task:     ${taskName} (${taskId.substring(0, 8)})`);
console.log(`Delta:    ${delta > 0 ? '+' : ''}${delta} BD`);
console.log(`Mode:     ${mode}`);
console.log(`Status:   ${status}`);
console.log(`Summary:  ${summary}`);
console.log(`Wall time: ${totalElapsed}ms (${Math.round(totalElapsed / 1000)}s)`);

if (detailsJson?.timing) {
  const t = detailsJson.timing;
  console.log(`\nEngine timing: ${t.totalMs}ms`);
  if (t.phases) {
    console.log('Phases:');
    const order = ['query', 'classify', 'cascade', 'parentSubtask', 'constraints', 'merge', 'patchUpdates', 'sleep', 'patchUnlock', 'reportComplete', 'logTerminal', 'cleanup'];
    for (const phase of order) {
      if (t.phases[phase] != null) {
        console.log(`  ${phase.padEnd(16)} ${t.phases[phase]}ms`);
      }
    }
  }
}

if (detailsJson?.movement) {
  console.log(`\nUpdates: ${detailsJson.movement.updatedCount}`);
  console.log(`Moved tasks: ${detailsJson.movement.movedTaskIds?.length || 0}`);
}

if (detailsJson?.retryStats?.count > 0) {
  console.log(`\nAPI retries: ${detailsJson.retryStats.count} (${detailsJson.retryStats.totalBackoffMs}ms backoff)`);
}

if (detailsJson?.webhookStats?.lmbsSkipsObserved > 0) {
  console.log(`LMBS skips observed: ${detailsJson.webhookStats.lmbsSkipsObserved}`);
}

process.exit(status === 'Success' ? 0 : 1);
