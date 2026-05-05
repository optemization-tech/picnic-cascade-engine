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

**B. Scripted bulk-archive (for larger sets, or if UI multi-select gets slow).** Paste into a scratch file at the engine repo root and run with `node`:

```js
// archive-study-tasks.js — run from the engine repo root.
import 'dotenv/config';
import { provisionClient } from './src/notion/clients.js';
import { config } from './src/config.js';
import { STUDY_TASKS_PROPS as ST } from './src/notion/property-names.js';

const studyPageId = process.argv[2];
if (!studyPageId) throw new Error('Usage: node archive-study-tasks.js <studyPageId>');

// Filter mirrors the runbook Step 1 query: only engine-provisioned
// tasks (Template Source ID is not empty) — leaves PM-added manual
// tasks alone. queryDatabase paginates internally; default page size
// 100 (Notion's max) is sufficient.
const filter = {
  and: [
    { property: ST.STUDY.id, relation: { contains: studyPageId } },
    { property: ST.TEMPLATE_SOURCE_ID.id, rich_text: { is_not_empty: true } },
  ],
};
const tasks = await provisionClient.queryDatabase(config.notion.studyTasksDbId, filter);
console.log(`Found ${tasks.length} tasks for study ${studyPageId}`);

for (const task of tasks) {
  await provisionClient.request('PATCH', `/pages/${task.id}`, { archived: true });
  console.log(`archived ${task.id}`);
}
```

Run with `NOTION_PROVISION_TOKEN_1` set in `.env` (or `NOTION_TOKEN_1` if no provisioning pool is configured). The provisioning client respects rate limits via the existing token-pool retry logic.

## Step 3 — Confirm the precondition

Before re-triggering, confirm the double-inception guard sees the study as fresh.

The guard at `src/routes/inception.js:54-67` queries by `Study.relation contains <studyPageId>` only — it does **not** filter by `[Do Not Edit] Template Source ID`. That filter is unique to this runbook (it exists so we leave PM-added manual tasks alone). Two checks:

- Run the Step 1 filter (`Study.relation contains <studyPageId> AND [Do Not Edit] Template Source ID is not empty`) — the count should be `0`. Confirms the engine-provisioned partial tasks are gone.
- Run the broader guard filter (`Study.relation contains <studyPageId>` only). If this count is also `0`, you're clear — re-trigger inception.
- If the broader filter returns rows that the narrower filter does not, those are PM-added manual tasks (no Template Source ID). The double-inception guard will block re-run while they exist. Either:
  1. Coordinate with the PM to temporarily archive their manual tasks, run inception, then restore them. Or
  2. Escalate to the engine team — a one-off override of the guard is safer than running with mixed state.

The page-level Trash holds the archived tasks for 30 days if anything needs to be recovered.

If any partial tasks remain (e.g., archive failed mid-loop on a single task), repeat Step 2 for the survivors.

## Step 4 — Re-run inception

Click the inception button on the study page. The next Activity Log entry should be a clean `success` with `totalCreated` matching the blueprint count.

If the re-run fails the same way, escalate — repeated `runParallel` aborts on the same study suggest a Notion brownout or a blueprint condition the engine doesn't yet handle. Capture the failure entry's `executionId` and the relevant Railway log range when escalating.

## Safety notes

- This runbook restores the precondition the existing guard reads. It does not bypass the guard at the source-code level. The guard exists to prevent duplicate Study Tasks from a double-click; an operator-driven cleanup-then-rerun preserves that property.
- The `failedUnsafe` bucket (workers that rejected mid-write) is duplicate-suspect — Notion may have created a page server-side that the engine never recorded. Archiving everything in `[Do Not Edit] Template Source ID is not empty` covers both buckets, including any server-side duplicates that landed without a client-side ack.
- Background: this Activity Log signal was added 2026-05-04 alongside the silent-batch-abort fix (`docs/plans/2026-05-04-001-fix-inception-silent-batch-abort-plan.md`, `BEH-INCEPTION-BATCH-INCOMPLETE`). Before that change, partial inceptions reported `status: success` and required engine-team intervention to detect.
