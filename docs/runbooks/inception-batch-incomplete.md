# Runbook: Inception batch incomplete

**When this fires.** The Activity Log shows an `Inception` entry with status `Failed` and a body line:

> Batch incomplete: created X of Y (Z failed transient, W not attempted — runParallel abort).

**What it means.** A `runParallel` worker hit a non-idempotent unsafe Notion error (typically a 5xx or post-send timeout on `POST /pages`) and aborted the batch. Some Study Tasks landed (`X created`); others were rejected mid-flight (`Z failed transient` — duplicate-suspect, may have written server-side) or never picked up before the abort signal (`W not attempted`). The study is in a partial state: parents may exist without their child tasks, dependency relations may be missing.

The double-inception guard (`src/routes/inception.js:54-67`) blocks a re-run while any Study Tasks exist for this study. Recovery is operator-driven: archive the partial tasks, then re-trigger inception. **Do not bypass the guard.**

## Step 1 — Identify the partial Study Tasks

Open the Study Tasks DB in Notion. Filter:

- `Study` relation contains the failed study's page ID, AND
- `[Do Not Edit] Template Source ID` is not empty.

The result is the full set of tasks the partial inception created. The count should match the failure entry's `created` field. If it does not match, stop and escalate — the partial state may include earlier tasks from a different operation.

## Step 2 — Archive the partial tasks

Two paths.

**A. Notion UI (fastest for ≤ ~150 tasks).** Multi-select the filtered rows, right-click → `Delete` (Notion's "Delete" archives the page; it is recoverable from Trash for 30 days). Confirm the count matches before clicking.

**B. Scripted bulk-archive (for larger sets, or if UI multi-select gets slow).** From a checkout of the engine repo:

```bash
node scripts/archive-partial-study-tasks.js <studyPageId>
```

If that script doesn't exist yet, the inline equivalent — paste in a scratch file, run with `node`:

```js
// archive-study-tasks.js
import 'dotenv/config';
import { provisionClient } from './src/notion/clients.js';
import { config } from './src/config.js';
import { STUDY_TASKS_PROPS as ST } from './src/notion/property-names.js';

const studyPageId = process.argv[2];
if (!studyPageId) throw new Error('Usage: node archive-study-tasks.js <studyPageId>');

const filter = { property: ST.STUDY.id, relation: { contains: studyPageId } };
const tasks = await provisionClient.queryDatabase(config.notion.studyTasksDbId, filter, 1000);
console.log(`Found ${tasks.length} tasks for study ${studyPageId}`);

for (const task of tasks) {
  await provisionClient.request('PATCH', `/pages/${task.id}`, { archived: true });
  console.log(`archived ${task.id}`);
}
```

Run with `NOTION_PROVISION_TOKEN_1` set in `.env` (or `NOTION_TOKEN_1` if no provisioning pool is configured). The provisioning client respects rate limits via the existing token-pool retry logic.

## Step 3 — Confirm the precondition

Before re-triggering, confirm the double-inception guard sees the study as fresh:

- Re-query Study Tasks with the same filter as Step 1.
- The `[Do Not Edit] Template Source ID is not empty` count should be `0`.
- The page-level Trash should hold the archived tasks (in case you need to recover any).

If any partial tasks remain (e.g., archive failed mid-loop on a single task), repeat Step 2 for the survivors.

## Step 4 — Re-run inception

Click the inception button on the study page. The next Activity Log entry should be a clean `success` with `totalCreated` matching the blueprint count.

If the re-run fails the same way, escalate — repeated `runParallel` aborts on the same study suggest a Notion brownout or a blueprint condition the engine doesn't yet handle. Capture the failure entry's `executionId` and the relevant Railway log range when escalating.

## Safety notes

- This runbook restores the precondition the existing guard reads. It does not bypass the guard at the source-code level. The guard exists to prevent duplicate Study Tasks from a double-click; an operator-driven cleanup-then-rerun preserves that property.
- The `failedUnsafe` bucket (workers that rejected mid-write) is duplicate-suspect — Notion may have created a page server-side that the engine never recorded. Archiving everything in `[Do Not Edit] Template Source ID is not empty` covers both buckets, including any server-side duplicates that landed without a client-side ack.
- Background: this Activity Log signal was added 2026-05-04 alongside the silent-batch-abort fix (`docs/plans/2026-05-04-001-fix-inception-silent-batch-abort-plan.md`, `BEH-INCEPTION-BATCH-INCOMPLETE`). Before that change, partial inceptions reported `status: success` and required engine-team intervention to detect.
