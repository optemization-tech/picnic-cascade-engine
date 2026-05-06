#!/usr/bin/env node
/**
 * Repair task body content for tasks where inception's copy-blocks step
 * skipped or failed for a small number of pages (≤ 10 by default).
 *
 * Two-phase invocation:
 *   (default) — diagnose only, read-only; lists tasks whose body is empty
 *     but whose Blueprint template has content, plus known-broken-skip +
 *     empty-template-skip categories for transparency.
 *   --apply — toggles study Import Mode, calls copyBlocks(idMapping) for the
 *     repair subset, writes one Activity Log entry, clears Import Mode.
 *
 * Pre-flight safety:
 *   - Aborts if [Do Not Edit] Import Mode is already true on the target study
 *     (mid-operation, or stuck from a prior SIGKILL).
 *   - Resolves and prints the study name; requires `[y/N]` confirmation.
 *     Skip with --yes for automation.
 *   - Per-mode hard gate: refuses --apply if more than --max tasks are flagged
 *     for repair (default 10).
 *
 * Skip-listed templates (BL-L16): `df123867-60c2-82fe-9c51-816ddf061fe9`
 * consistently fails copy-blocks with `body.children undefined`. Excluded
 * from repair list — operator manually pastes from the Blueprint page.
 *
 * Usage:
 *   node scripts/repair-task-blocks.js --study <pageId>
 *   node scripts/repair-task-blocks.js --study <pageId> --apply
 *   node scripts/repair-task-blocks.js --study <pageId> --apply --yes
 *
 * Exit codes:
 *   0 = success (diagnose printed, or apply completed)
 *   1 = error (Activity Log still written when possible)
 *   2 = nothing to repair (no empty-body tasks found)
 *   3 = usage / config error
 *
 * See docs/runbooks/missing-task-content.md for the operator decision tree.
 */

import readline from 'node:readline';
import { STUDY_TASKS_PROPS, STUDIES_PROPS, findById } from '../src/notion/property-names.js';
import { copyBlocks } from '../src/provisioning/copy-blocks.js';

// ──────────────────────────────────────────────────────────────────────────
// Known-broken templates (skip during repair). Update if BL-L16 root cause
// lands or if other templates surface the same body.children issue.
// ──────────────────────────────────────────────────────────────────────────
const KNOWN_BROKEN_TEMPLATE_IDS = new Set([
  'df123867-60c2-82fe-9c51-816ddf061fe9', // BL-L16
]);

const DEFAULT_MAX = 10;

// ──────────────────────────────────────────────────────────────────────────
// Arg parsing — matches scripts/batch-migrate/recover-inception.js shape.
// ──────────────────────────────────────────────────────────────────────────
function getArg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) {
    const eqMatch = process.argv.find((a) => a.startsWith(`--${name}=`));
    if (eqMatch) return eqMatch.split('=').slice(1).join('=');
    return fallback;
  }
  const next = process.argv[i + 1];
  if (next === undefined || next.startsWith('--')) return true;
  return next;
}

function getFlag(name) {
  return process.argv.indexOf(`--${name}`) !== -1
    || process.argv.some((a) => a === `--${name}=true`);
}

// ──────────────────────────────────────────────────────────────────────────
// Probe: does this Notion block have at least one child?
// Returns true if children exist, false if empty or error (caller decides).
// ──────────────────────────────────────────────────────────────────────────
async function hasAnyChildren(client, blockId) {
  // Probe failures (404, 400) propagate to the caller for explicit handling
  // — diagnose maps unprobeable templates to known-broken-skip when their id
  // is on the skip-list, else escalates as an unexpected error.
  const res = await client.request('GET', `/blocks/${blockId}/children?page_size=1`);
  return Array.isArray(res?.results) && res.results.length > 0;
}

// ──────────────────────────────────────────────────────────────────────────
// Confirmation prompt — fires unless --yes is set.
// ──────────────────────────────────────────────────────────────────────────
async function confirm(promptText) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(promptText, (answer) => {
      rl.close();
      const a = String(answer || '').trim().toLowerCase();
      resolve(a === 'y' || a === 'yes');
    });
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Diagnose: classify each task into present-ok, missing-body, or one of
// the skip categories.
// ──────────────────────────────────────────────────────────────────────────
export async function diagnose({ client, studyPageId, studyTasksDbId, knownBrokenTemplateIds = KNOWN_BROKEN_TEMPLATE_IDS }) {
  const filter = {
    and: [
      { property: STUDY_TASKS_PROPS.STUDY.id, relation: { contains: studyPageId } },
      { property: STUDY_TASKS_PROPS.TEMPLATE_SOURCE_ID.id, rich_text: { is_not_empty: true } },
    ],
  };
  const tasks = await client.queryDatabase(studyTasksDbId, filter);

  const repairList = []; // { taskId, templateId, taskName }
  const knownBrokenSkips = []; // { taskId, templateId, taskName }
  const emptyTemplateSkips = []; // { taskId, templateId, taskName }
  const probeErrors = []; // { taskId, templateId, taskName, error }
  let presentOk = 0;

  for (const task of tasks) {
    const taskName = findById(task, STUDY_TASKS_PROPS.TASK_NAME)?.title?.[0]?.plain_text || '(no name)';
    const templateId = findById(task, STUDY_TASKS_PROPS.TEMPLATE_SOURCE_ID)?.rich_text?.[0]?.plain_text;
    if (!templateId) continue; // shouldn't happen given filter, defensive

    let taskHasContent;
    try {
      taskHasContent = await hasAnyChildren(client, task.id);
    } catch (err) {
      probeErrors.push({ taskId: task.id, templateId, taskName, error: String(err?.message || err).slice(0, 200) });
      continue;
    }
    if (taskHasContent) {
      presentOk++;
      continue;
    }

    if (knownBrokenTemplateIds.has(templateId)) {
      knownBrokenSkips.push({ taskId: task.id, templateId, taskName });
      continue;
    }

    let templateHasContent;
    try {
      templateHasContent = await hasAnyChildren(client, templateId);
    } catch (err) {
      probeErrors.push({ taskId: task.id, templateId, taskName, error: String(err?.message || err).slice(0, 200) });
      continue;
    }

    if (!templateHasContent) {
      emptyTemplateSkips.push({ taskId: task.id, templateId, taskName });
      continue;
    }

    repairList.push({ taskId: task.id, templateId, taskName });
  }

  return {
    totals: {
      tasksFound: tasks.length,
      presentOk,
      missingBody: repairList.length,
      knownBrokenSkip: knownBrokenSkips.length,
      emptyTemplateSkip: emptyTemplateSkips.length,
      probeErrors: probeErrors.length,
    },
    repairList,
    knownBrokenSkips,
    emptyTemplateSkips,
    probeErrors,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Apply: toggle Import Mode, call copyBlocks for the repair subset, clear
// Import Mode in finally, write Activity Log entry.
// ──────────────────────────────────────────────────────────────────────────
export async function apply({ client, studyPageId, studyName, repairList, activityLogService, executionId, copyBlocksFn = copyBlocks }) {
  // importModeArm: only attempt the OFF PATCH in finally if the ON PATCH succeeded.
  // Mirrors src/migration/migrate-study-service.js sentinel pattern.
  let importModeArm = false;
  let copyResult = null;
  let runError = null;
  let cleanupError = null;
  let alResult = null;

  try {
    await client.request('PATCH', `/pages/${studyPageId}`, {
      properties: { [STUDIES_PROPS.IMPORT_MODE.id]: { checkbox: true } },
    });
    importModeArm = true;

    // copyBlocks idMapping is `Record<templateId, productionId>` — duplicates would
    // collapse via last-write-wins. Group repairList by templateId so duplicates
    // (e.g., Repeat-Delivery clones sharing one Blueprint template) are each repaired
    // via a separate copyBlocks call. For ≤10 tasks this is fine; we lose the
    // synced-block cache reuse across calls, but the cache is per-call to begin with.
    const taskIdsByTemplateId = new Map();
    for (const { taskId, templateId } of repairList) {
      if (!taskIdsByTemplateId.has(templateId)) taskIdsByTemplateId.set(templateId, []);
      taskIdsByTemplateId.get(templateId).push(taskId);
    }

    const aggregate = { blocksWrittenCount: 0, pagesProcessed: 0, pagesSkipped: 0 };
    for (const [templateId, taskIds] of taskIdsByTemplateId) {
      for (const taskId of taskIds) {
        const result = await copyBlocksFn(client, { [templateId]: taskId }, { studyPageId, studyName });
        aggregate.blocksWrittenCount += result?.blocksWrittenCount ?? 0;
        aggregate.pagesProcessed += result?.pagesProcessed ?? 0;
        aggregate.pagesSkipped += result?.pagesSkipped ?? 0;
      }
    }
    copyResult = aggregate;
  } catch (err) {
    runError = err;
    console.error('[repair-task-blocks] copyBlocks threw:', err?.message || err);
  } finally {
    if (importModeArm) {
      try {
        await client.request('PATCH', `/pages/${studyPageId}`, {
          properties: { [STUDIES_PROPS.IMPORT_MODE.id]: { checkbox: false } },
        });
      } catch (err) {
        cleanupError = err;
        console.error('[repair-task-blocks] failed to clear Import Mode (study left STUCK):', err?.message || err);
      }
    }
  }

  // Status honesty: any non-clean outcome (copyBlocks throw, finally PATCH-off
  // failure, or pagesSkipped > 0 with copyBlocks no-throw) is `failed`. Operators
  // running --apply on a small list expect every page to land; partial outcome
  // must be visible as failure so they don't move on.
  const pagesSkipped = copyResult?.pagesSkipped ?? 0;
  const partialFailure = !runError && pagesSkipped > 0;
  const status = (runError || cleanupError || partialFailure) ? 'failed' : 'success';

  const summary = runError
    ? `Manual block repair failed: ${String(runError.message || runError).slice(0, 180)}`
    : cleanupError
      ? `Manual block repair completed but Import Mode clear failed (study STUCK at TRUE): ${String(cleanupError.message || cleanupError).slice(0, 120)}`
      : partialFailure
        ? `Manual block repair partial: ${copyResult?.pagesProcessed ?? 0} of ${repairList.length} pages succeeded, ${pagesSkipped} skipped (see copy_blocks_page_error logs for per-page reasons)`
        : `Manual block repair: ${copyResult?.pagesProcessed ?? 0} pages processed, ${copyResult?.blocksWrittenCount ?? 0} blocks written (all ${repairList.length} attempted succeeded)`;

  alResult = await activityLogService.logTerminalEvent({
    workflow: 'Copy Blocks',
    status,
    triggerType: 'Manual',
    executionId,
    timestamp: new Date().toISOString(),
    cascadeMode: 'N/A',
    sourceTaskName: studyName || null,
    studyId: studyPageId,
    summary,
    details: {
      blocksWrittenCount: copyResult?.blocksWrittenCount ?? 0,
      pagesProcessed: copyResult?.pagesProcessed ?? 0,
      pagesSkipped,
      attempted: repairList.length,
      attemptedTaskIds: repairList.map((r) => r.taskId),
      script: 'repair-task-blocks',
      ...(runError ? {
        error: {
          errorMessage: String(runError.message || runError).slice(0, 400),
          phase: 'copyBlocks',
        },
      } : {}),
      ...(cleanupError ? {
        cleanupError: {
          errorMessage: String(cleanupError.message || cleanupError).slice(0, 400),
          phase: 'importModeClearOff',
          impact: 'study left with Import Mode = true; manual reset required',
        },
      } : {}),
    },
  });

  return { copyResult, runError, cleanupError, partialFailure, alResult };
}

// ──────────────────────────────────────────────────────────────────────────
// Main — only runs when this file is invoked directly via node, not when
// imported by tests.
// ──────────────────────────────────────────────────────────────────────────
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  await runMain();
}
// Importers (e.g. test files) stop here; tests use the exported diagnose/apply
// functions and never invoke runMain — runMain owns CLI side effects (process.exit,
// stdin prompt, env loading) that should never fire from a unit test.

async function runMain() {
// Lazy CLI-only imports so tests don't pull dotenv / live config.
await import('dotenv/config');
const { provisionClient } = await import('../src/notion/clients.js');
const { config } = await import('../src/config.js');
const { ActivityLogService } = await import('../src/services/activity-log.js');

const studyPageId = getArg('study');
const applyFlag = getFlag('apply');
const yesFlag = getFlag('yes');
const maxArg = getArg('max', String(DEFAULT_MAX));
const max = parseInt(typeof maxArg === 'string' ? maxArg : String(DEFAULT_MAX), 10);

// getArg returns boolean `true` if the flag has no value (e.g. `--study --apply` —
// the next arg is itself a flag). Reject both missing and non-string values so the
// usage error fires here instead of downstream "Study page not found" against
// `/pages/true`.
if (!studyPageId || typeof studyPageId !== 'string') {
  console.error('Usage: --study requires a value (the Study page ID).');
  console.error('       node scripts/repair-task-blocks.js --study <pageId> [--apply] [--max <n>] [--yes]');
  process.exit(3);
}
if (!Number.isFinite(max) || max <= 0) {
  console.error(`Invalid --max value: ${max}`);
  process.exit(3);
}
if (!config.notion.studyTasksDbId || !config.notion.studiesDbId) {
  console.error('STUDY_TASKS_DB_ID and STUDIES_DB_ID must be set in env');
  process.exit(3);
}

const executionId = `repair-task-blocks-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

console.log(`\n=== Repair Task Blocks (${applyFlag ? 'APPLY' : 'DIAGNOSE-ONLY'}) ===`);
console.log(`Study: ${studyPageId}`);
console.log(`Max per run: ${max}`);
console.log(`Execution ID: ${executionId}\n`);

// Pre-flight: fetch study, verify it's a Studies-DB page, check Import Mode, resolve name
let studyPage;
try {
  studyPage = await provisionClient.request('GET', `/pages/${studyPageId}`);
} catch (err) {
  console.error(`Study page not found: ${err?.message || err}`);
  process.exit(3);
}

// Workspace-scoped bot tokens resolve any page the integration can see — including
// Study Tasks, Blueprint, and unrelated pages. Reject anything not in the Studies DB
// before any further work so a UUID typo doesn't silently land on the wrong page.
const studyParentDb = studyPage?.parent?.database_id;
// Notion API returns parent.database_id without dashes, but property-names IDs
// can be either format depending on source — normalize both sides for comparison.
const normalize = (id) => String(id || '').replace(/-/g, '').toLowerCase();
if (!studyParentDb || normalize(studyParentDb) !== normalize(config.notion.studiesDbId)) {
  console.error(`[abort] --study target is not a Studies-DB page.`);
  console.error(`  Page parent.database_id: ${studyParentDb || '(unknown)'}`);
  console.error(`  Expected Studies DB:     ${config.notion.studiesDbId}`);
  console.error(`  This script only operates on Studies; pass a Study page ID, not a Task or Blueprint page.`);
  process.exit(3);
}

const studyName = findById(studyPage, STUDIES_PROPS.STUDY_NAME)?.title?.[0]?.plain_text || '(no name)';
const importModeOn = findById(studyPage, STUDIES_PROPS.IMPORT_MODE)?.checkbox === true;

if (importModeOn) {
  console.error(`[abort] Study "${studyName}" has [Do Not Edit] Import Mode = true.`);
  console.error('  Either (a) another inception/migrate/add-task-set is in progress (wait + retry),');
  console.error('  or (b) a prior run was killed (SIGKILL/OOM) and Import Mode is stuck.');
  console.error('  See docs/runbooks/missing-task-content.md "Stuck Import Mode" section.');
  process.exit(1);
}

console.log(`Study name: ${studyName}\n`);

// Diagnose
console.log('[1] Diagnosing...');
const result = await diagnose({ client: provisionClient, studyPageId, studyTasksDbId: config.notion.studyTasksDbId });

console.log(`\nDiagnose results:`);
console.log(`  Tasks scanned (Template Source ID set):  ${result.totals.tasksFound}`);
console.log(`  Present (body has content):              ${result.totals.presentOk}`);
console.log(`  Missing body, repair candidate:          ${result.totals.missingBody}`);
console.log(`  Known-broken skip (BL-L16):              ${result.totals.knownBrokenSkip}`);
console.log(`  Empty-template skip (legitimate):        ${result.totals.emptyTemplateSkip}`);
console.log(`  Probe errors (investigate):              ${result.totals.probeErrors}`);

if (result.repairList.length > 0) {
  console.log(`\nRepair list (${result.repairList.length}):`);
  for (const r of result.repairList) {
    console.log(`  - ${r.taskName} (${r.taskId}) ← template ${r.templateId}`);
  }
}
if (result.knownBrokenSkips.length > 0) {
  console.log(`\nKnown-broken skips (${result.knownBrokenSkips.length}):`);
  for (const r of result.knownBrokenSkips) {
    console.log(`  - ${r.taskName} (${r.taskId}) — template ${r.templateId} (BL-L16: manually paste from Blueprint)`);
  }
}
if (result.probeErrors.length > 0) {
  console.log(`\nProbe errors (${result.probeErrors.length}):`);
  for (const r of result.probeErrors) {
    console.log(`  - ${r.taskName} (${r.taskId}) — template ${r.templateId} — ${r.error}`);
  }
}

if (result.repairList.length === 0) {
  console.log('\nNothing to repair.');
  process.exit(2);
}

if (!applyFlag) {
  console.log('\nDiagnose-only mode. Re-run with --apply to repair.');
  process.exit(0);
}

// Gate
if (result.repairList.length > max) {
  console.error(`\n[abort] ${result.repairList.length} tasks need repair, exceeding --max ${max}.`);
  console.error('  This is intentional safety: large failure rates suggest a systemic issue.');
  console.error('  Options:');
  console.error('    (a) Investigate the Activity Log + Railway logs for inception failures.');
  console.error('    (b) Archive partial tasks per docs/runbooks/inception-batch-incomplete.md');
  console.error('         + manual /webhook/inception re-fire.');
  console.error('    (c) Override --max only with engineering review.');
  process.exit(1);
}

// Confirmation prompt
if (!yesFlag) {
  if (!process.stdin.isTTY) {
    console.error(`\n[abort] --apply requires interactive confirmation but stdin is not a TTY.`);
    console.error('  Pass --yes to skip the prompt for non-interactive use (cron, CI, agents).');
    process.exit(3);
  }
  console.log(`\nAbout to repair ${result.repairList.length} task body(ies) on study "${studyName}".`);
  console.log(`This will toggle Import Mode, call copyBlocks, and write an Activity Log entry.`);
  const ok = await confirm('Continue? [y/N] ');
  if (!ok) {
    console.log('Aborted.');
    process.exit(1);
  }
}

// Apply
console.log('\n[2] Applying...');
const activityLogService = new ActivityLogService({
  notionClient: provisionClient,
  activityLogDbId: config.notion.activityLogDbId,
});
const { copyResult, runError, cleanupError, partialFailure, alResult } = await apply({
  client: provisionClient,
  studyPageId,
  studyName,
  repairList: result.repairList,
  activityLogService,
  executionId,
});

const pagesProcessed = copyResult?.pagesProcessed ?? 0;
const pagesSkipped = copyResult?.pagesSkipped ?? 0;
const blocksWritten = copyResult?.blocksWrittenCount ?? 0;
const alLogged = alResult?.logged === true;

if (runError || cleanupError || partialFailure) {
  console.error(`\nRepair did NOT complete cleanly:`);
  console.error(`  Pages processed:       ${pagesProcessed} of ${result.repairList.length}`);
  console.error(`  Blocks written:        ${blocksWritten}`);
  console.error(`  Pages skipped:         ${pagesSkipped}`);
  if (runError) {
    console.error(`  copyBlocks error:      ${runError?.message || runError}`);
  }
  if (cleanupError) {
    console.error(`  Import Mode clear:     FAILED — study left at Import Mode = true`);
    console.error(`                         ${cleanupError?.message || cleanupError}`);
    console.error(`                         Manually clear via Notion UI before re-running.`);
  }
  if (partialFailure) {
    console.error(`  Per-page reasons:      see 'copy_blocks_page_error' lines in stdout above`);
  }
  if (alLogged) {
    console.error(`  Activity Log entry:    written (Workflow: Copy Blocks, Status: Failed)\n`);
  } else {
    console.error(`  Activity Log entry:    FAILED to write — ${alResult?.reason || 'unknown'}`);
    console.error(`                         Audit trail incomplete; check Railway logs.\n`);
  }
  process.exit(1);
}

console.log(`\nRepair complete:`);
console.log(`  Pages processed:       ${pagesProcessed}`);
console.log(`  Blocks written:        ${blocksWritten}`);
console.log(`  Pages skipped:         ${pagesSkipped}`);
if (alLogged) {
  console.log(`  Activity Log entry:    written (Workflow: Copy Blocks, Status: Success)\n`);
} else {
  console.log(`  Activity Log entry:    FAILED to write — ${alResult?.reason || 'unknown'}\n`);
  console.log(`                         (repair itself succeeded; audit trail is incomplete)`);
}

process.exit(0);
}
