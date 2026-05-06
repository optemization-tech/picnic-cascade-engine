#!/usr/bin/env node
/**
 * Recover from a silent partial-Inception failure (PR #98 detection).
 *
 * Implements the canonical procedure from
 * `docs/runbooks/inception-batch-incomplete.md`:
 *   1. Fire /webhook/deletion to archive all cascade Study Tasks for this study
 *   2. Poll until cascade Study Tasks count == 0
 *   3. Clear Match Confidence + Notion Task on Asana Exported Tasks rows
 *   4. Fire /webhook/inception
 *   5. Poll cascade Study Tasks count until stable (Inception complete)
 *   6. Verify Activity Log says Success
 *
 * After this returns success, the caller should re-fire the Migrator via:
 *   node scripts/batch-migrate/batch-migrate.js --study <key> --skip-create-study --skip-inception
 *
 * Usage:
 *   node scripts/batch-migrate/recover-inception.js --study <key>
 *   node scripts/batch-migrate/recover-inception.js --study <key> --json
 *
 * Output modes:
 *   default   — multi-step progress on stdout (byte-identical to pre-polish)
 *   --json    — single JSON envelope on stdout at end; progress on stderr
 *
 * Exit codes:
 *   0 = recovery complete; caller can re-fire Migrator
 *   1 = recovery failed (left in unsafe state — escalate)
 *   2 = nothing to recover (Inception was already Success)
 *   3 = usage / config error
 *   4 = transient/inconclusive (network 5xx, timeout) — caller should retry
 *
 * Manual-task guard (R4 / U5):
 *   Before /webhook/deletion fires, the script queries Study Tasks where
 *   Template Source ID is empty (PM-added manual tasks). If any are present,
 *   the script REFUSES with error.code: 'manual_tasks_present' and lists the
 *   manual task IDs. There is no override flag — operators coordinate with
 *   the PM, archive manually in Notion UI, then re-run. Per Q9 there is a
 *   small TOCTOU window between this check and the webhook fire; engine-side
 *   filter narrowing is the durable mitigation (deferred follow-up).
 */

import { findStudyConfig } from './config.js';

const ACTIVITY_LOG_DS = 'ba423867-60c2-82c3-8540-8737ba4f730d';
const EXPORTED_STUDIES_DS = 'cb785052-5633-48fe-a51d-797d033bece0';
const STUDY_TASKS_DS = 'eb823867-60c2-83a6-b067-07cd54089367';
const ASANA_TASKS_DS = '82ae00bc-5cad-4f48-bd35-3d4e216a6a4b';
const SCHEMA_VERSION = 1;

// Default polling parameters — tests override via deps.pollLimits.
const DEFAULT_POLL_LIMITS = {
  deletion: { maxIterations: 20, intervalMs: 15000 },
  reInception: { maxIterations: 24, intervalMs: 20000, stableTarget: 2, minTasksFloor: 100 },
  clearAudit: { batchSize: 10, throttleMs: 1100 },
  activityLogSettleMs: 5000,
};

// ──────────────────────────────────────────────────────────────────────────
// Arg parsing — same shape as scripts/repair-task-blocks.js.
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
// Error classification (R8). See check-inception.js for parallel logic.
// ──────────────────────────────────────────────────────────────────────────
function classifyError(err) {
  const message = String(err?.message || err || '');
  if (err?.status === 401 || err?.status === 403 || /\b401\b|\b403\b/.test(message)) {
    return 'auth_error';
  }
  if (err?.status >= 400 && err?.status < 500) return 'notion_api';
  if (/\b4\d\d\b/.test(message) && !/\b5\d\d\b/.test(message)) return 'notion_api';
  if (err?.code === 'cursor_exhausted') return 'cursor_exhausted';
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError'
    || /\bECONN(RESET|REFUSED|ABORTED)\b|\btimeout\b|\bnetwork\b|\b5\d\d\b|\bfetch failed\b/i.test(message)) {
    return 'transient';
  }
  return 'unknown';
}

function classifyExitCode(category) {
  return category === 'transient' ? 4 : 1;
}

// ──────────────────────────────────────────────────────────────────────────
// Default fetch wrapper — retry + timeout (R16/R17). Tests inject a non-
// retrying mock via deps.notionFetch.
// ──────────────────────────────────────────────────────────────────────────
function makeDefaultNotionFetch(token, { maxRetries = 2, retryBaseMs = 5000, timeoutMs = 30000 } = {}) {
  return async function notionFetch(method, path, body = null) {
    let lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const opts = {
          method,
          headers: {
            'Authorization': `Bearer ${token}`,
            'Notion-Version': '2025-09-03',
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          signal: AbortSignal.timeout(timeoutMs),
        };
        if (body) opts.body = JSON.stringify(body);
        const res = await fetch(`https://api.notion.com${path}`, opts);
        if (res.status >= 500 && attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, retryBaseMs * (attempt + 1)));
          continue;
        }
        if (res.status === 401 || res.status === 403) {
          const err = new Error(`auth error: ${res.status} ${await res.text().catch(() => '')}`);
          err.status = res.status;
          throw err;
        }
        // PATCH errors surface text for clearer diagnostics
        if (method === 'PATCH' && !res.ok) {
          const txt = await res.text().catch(() => '');
          throw new Error(`PATCH ${path} ${res.status}: ${txt}`);
        }
        return res.json();
      } catch (err) {
        lastErr = err;
        const transient = err?.name === 'TimeoutError' || err?.name === 'AbortError'
          || /ECONN(RESET|REFUSED|ABORTED)|fetch failed|network/i.test(String(err?.message || ''));
        if (transient && attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, retryBaseMs * (attempt + 1)));
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  };
}

function makeDefaultFireWebhook(engineUrl, secret, { timeoutMs = 30000 } = {}) {
  return async function fireWebhook(path, body) {
    const r = await fetch(`${engineUrl}${path}`, {
      method: 'POST',
      headers: { 'X-Webhook-Secret': secret, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) {
      const err = new Error(`${path} ${r.status}: ${await r.text().catch(() => '')}`);
      err.status = r.status;
      throw err;
    }
    return r.json();
  };
}

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const noopProgress = () => {};

// ──────────────────────────────────────────────────────────────────────────
// queryAll — paginated Notion data-source query with cursor-invalidation
// retry (R11/U7). See scripts/batch-migrate/notion.js queryDb for the
// canonical pattern. We don't import that helper because it targets the
// legacy /v1/databases/{id}/query endpoint at Notion-Version 2022-06-28;
// this script uses /v1/data_sources/{id}/query at 2025-09-03.
// ──────────────────────────────────────────────────────────────────────────
function isCursorInvalidation(j) {
  return j?.object === 'error'
    && j?.code === 'validation_error'
    && /cursor/i.test(j?.message || '');
}

export async function queryAll(notionFetch, ds, filter, { maxAttempts = 3, onProgress = noopProgress } = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const all = [];
    let cursor = undefined;
    let cursorInvalidated = false;
    while (true) {
      const body = { filter, page_size: 100 };
      if (cursor) body.start_cursor = cursor;
      const j = await notionFetch('POST', `/v1/data_sources/${ds}/query`, body);
      if (isCursorInvalidation(j)) {
        onProgress({ type: 'cursor-invalidated', attempt, resultsBeforeInvalidation: all.length });
        cursorInvalidated = true;
        break;
      }
      if (!j.results) throw new Error(`query error: ${JSON.stringify(j)}`);
      all.push(...j.results);
      if (!j.has_more) return all;
      cursor = j.next_cursor;
    }
    if (!cursorInvalidated) return all;
  }
  const err = new Error(`cursor retries exhausted (${maxAttempts} attempts)`);
  err.code = 'cursor_exhausted';
  throw err;
}

// ──────────────────────────────────────────────────────────────────────────
// Stage 1: fire /webhook/deletion + poll cascade until 0.
// Includes manual-task pre-flight guard (R4/U5).
// ──────────────────────────────────────────────────────────────────────────
export async function fireDeletionAndPoll({ prodId, deps }) {
  const {
    notionFetch, fireWebhook, sleep = realSleep,
    onProgress = noopProgress, pollLimits = DEFAULT_POLL_LIMITS,
  } = deps;
  const limits = pollLimits.deletion;

  // ─── Manual-task guard (R4/U5) ──────────────────────────────────────────
  // Before the destructive webhook fires, query for PM-added manual tasks
  // (Study Tasks where Template Source ID is empty). If any present, refuse
  // with structured failure — operator must coordinate with PM and archive
  // in Notion UI before re-running. There is no override flag (Q1=A).
  // TOCTOU race acknowledged (Q9): a PM can add a manual task between this
  // check and the webhook fire below. Engine-side filter narrowing is the
  // durable mitigation (deferred follow-up).
  let manualTasks;
  try {
    manualTasks = await queryAll(notionFetch, STUDY_TASKS_DS, {
      and: [
        { property: 'Study', relation: { contains: prodId } },
        { property: '[Do Not Edit] Template Source ID', rich_text: { is_empty: true } },
      ],
    });
  } catch (err) {
    return {
      name: 'deletion',
      status: 'failed',
      tasksArchivedAtStart: null,
      pollIterations: 0,
      error: { code: classifyError(err), message: `manual-task pre-flight query failed: ${err?.message || err}` },
    };
  }
  if (manualTasks.length > 0) {
    onProgress({ type: 'manual-tasks-detected', count: manualTasks.length });
    const ids = manualTasks.map((t) => t.id);
    return {
      name: 'deletion',
      status: 'failed',
      tasksArchivedAtStart: null,
      pollIterations: 0,
      manualTaskIds: ids,
      error: {
        code: 'manual_tasks_present',
        message: `${manualTasks.length} manual Study Tasks present (Template Source ID empty); archive in Notion UI before re-running. IDs: ${ids.slice(0, 5).join(', ')}${ids.length > 5 ? ` (+${ids.length - 5} more)` : ''}`,
      },
    };
  }

  // ─── Fire deletion webhook + poll ──────────────────────────────────────
  await fireWebhook('/webhook/deletion', { data: { id: prodId } });
  onProgress({ type: 'deletion-fired' });

  let tasksAtStart = null;
  for (let i = 1; i <= limits.maxIterations; i++) {
    await sleep(limits.intervalMs);
    const all = await queryAll(notionFetch, STUDY_TASKS_DS, { property: 'Study', relation: { contains: prodId } });
    if (tasksAtStart === null) tasksAtStart = all.length;
    onProgress({ type: 'deletion-poll', iteration: i, count: all.length });
    if (all.length === 0) {
      return { name: 'deletion', status: 'ok', tasksArchivedAtStart: tasksAtStart, pollIterations: i };
    }
    if (i === limits.maxIterations) {
      return {
        name: 'deletion', status: 'failed',
        tasksArchivedAtStart: tasksAtStart, pollIterations: i,
        error: { code: 'deletion_timeout', message: `deletion timed out (>${limits.maxIterations * limits.intervalMs / 60000}min)` },
      };
    }
  }
  return { name: 'deletion', status: 'failed', error: { code: 'deletion_unknown', message: 'loop fell through' } };
}

// ──────────────────────────────────────────────────────────────────────────
// Stage 2: clear Match Confidence + Notion Task on Asana Exported Tasks.
// Aborts on first PATCH failure after fetch-layer retries are exhausted (Q6).
// Recovery is all-or-nothing; partial cleanup misleads the next step.
// ──────────────────────────────────────────────────────────────────────────
export async function clearAuditRows({ exportedId, deps }) {
  const {
    notionFetch, sleep = realSleep,
    onProgress = noopProgress, pollLimits = DEFAULT_POLL_LIMITS,
  } = deps;
  const cfg = pollLimits.clearAudit;

  const dirty = await queryAll(notionFetch, ASANA_TASKS_DS, { and: [
    { property: 'Study', relation: { contains: exportedId } },
    { or: [
      { property: 'Match Confidence', select: { is_not_empty: true } },
      { property: 'Notion Task', relation: { is_not_empty: true } },
    ]},
  ]});
  onProgress({ type: 'clear-audit-scan', rows: dirty.length });

  let patched = 0;
  for (const row of dirty) {
    try {
      await notionFetch('PATCH', `/v1/pages/${row.id}`, {
        properties: {
          'Match Confidence': { select: null },
          'Notion Task': { relation: [] },
        },
      });
    } catch (err) {
      // Q6 abort: stop on first error after fetch-layer retries fail.
      // Operator fixes the failing row manually and re-runs.
      onProgress({ type: 'clear-audit-error', rowId: row.id, message: err?.message || String(err) });
      return {
        name: 'clearAudit',
        status: 'failed',
        rowsScanned: dirty.length,
        rowsCleared: patched,
        error: {
          code: 'patch_failed',
          rowId: row.id,
          message: `PATCH failed on row ${row.id} after fetch-layer retries: ${err?.message || err}`,
        },
      };
    }
    patched++;
    onProgress({ type: 'clear-audit-progress', patched, total: dirty.length });
    if (patched % cfg.batchSize === 0) {
      await sleep(cfg.throttleMs);
    }
  }
  return { name: 'clearAudit', status: 'ok', rowsScanned: dirty.length, rowsCleared: patched };
}

// ──────────────────────────────────────────────────────────────────────────
// Stage 3: fire /webhook/inception, poll until stable, verify Activity Log.
// ──────────────────────────────────────────────────────────────────────────
export async function reInceptionAndVerify({ prodId, deps }) {
  const {
    notionFetch, fireWebhook, sleep = realSleep,
    onProgress = noopProgress, pollLimits = DEFAULT_POLL_LIMITS,
  } = deps;
  const limits = pollLimits.reInception;

  await fireWebhook('/webhook/inception', { data: { id: prodId } });
  onProgress({ type: 'inception-fired' });

  let prev = 0;
  let stable = 0;
  let stabilizedAt = null;
  let finalCount = 0;

  for (let i = 1; i <= limits.maxIterations; i++) {
    await sleep(limits.intervalMs);
    const all = await queryAll(notionFetch, STUDY_TASKS_DS, { and: [
      { property: 'Study', relation: { contains: prodId } },
      { property: '[Do Not Edit] Template Source ID', rich_text: { is_not_empty: true } },
    ]});
    finalCount = all.length;
    onProgress({ type: 'inception-poll', iteration: i, count: all.length });
    if (all.length === prev && all.length > limits.minTasksFloor) {
      stable++;
      if (stable >= limits.stableTarget) {
        stabilizedAt = i;
        break;
      }
    } else {
      stable = 0;
    }
    prev = all.length;
    if (i === limits.maxIterations) {
      return {
        name: 'reInception',
        status: 'failed',
        cascadeCount: finalCount,
        pollIterations: i,
        stabilizedAt: null,
        activityLogStatus: null,
        activityLogSummary: null,
        error: { code: 'inception_timeout', message: `Inception timed out (>${limits.maxIterations * limits.intervalMs / 60000}min) without stabilizing` },
      };
    }
  }

  await sleep(pollLimits.activityLogSettleMs);
  const alres = await notionFetch('POST', `/v1/data_sources/${ACTIVITY_LOG_DS}/query`, {
    filter: { and: [
      { property: 'Study', relation: { contains: prodId } },
      { property: 'Workflow', select: { equals: 'Inception' } },
    ]},
    sorts: [{ property: 'Created time', direction: 'descending' }],
    page_size: 1,
  });
  const fresh = alres.results?.[0];
  const freshStatus = fresh?.properties['Status']?.select?.name || null;
  const freshSummary = fresh?.properties['Summary']?.rich_text?.map((r) => r.plain_text).join('') || '';
  onProgress({ type: 'activity-log', status: freshStatus, summary: freshSummary });

  if (freshStatus !== 'Success') {
    return {
      name: 'reInception',
      status: 'failed',
      cascadeCount: finalCount,
      pollIterations: stabilizedAt,
      stabilizedAt,
      activityLogStatus: freshStatus,
      activityLogSummary: freshSummary,
      error: { code: 'inception_not_success', message: `Inception did not report Success (got: ${freshStatus || 'no entry'})` },
    };
  }

  return {
    name: 'reInception',
    status: 'ok',
    cascadeCount: finalCount,
    pollIterations: stabilizedAt,
    stabilizedAt,
    activityLogStatus: freshStatus,
    activityLogSummary: freshSummary,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Pure run() — orchestrates the 3 stages. Returns { exitCode, result }.
// ──────────────────────────────────────────────────────────────────────────
export async function run({ studyKey, deps }) {
  const study = findStudyConfig(studyKey);
  if (!study) {
    return {
      exitCode: 3,
      result: {
        schemaVersion: SCHEMA_VERSION,
        ok: false,
        study: studyKey,
        error: { code: 'unknown_study', message: `Unknown study key: ${studyKey}` },
      },
    };
  }

  const { notionFetch, onProgress = noopProgress } = deps;

  // ─── Resolve identifiers ──────────────────────────────────────────────
  onProgress({ type: 'resolve-start' });
  const erows = await notionFetch('POST', `/v1/data_sources/${EXPORTED_STUDIES_DS}/query`, {
    filter: { property: 'Study Name', title: { equals: study.name } },
    page_size: 1,
  });
  const erow = erows.results?.[0];
  if (!erow) {
    return {
      exitCode: 1,
      result: {
        schemaVersion: SCHEMA_VERSION,
        ok: false,
        study: studyKey,
        studyName: study.name,
        error: { code: 'no_exported_row', message: `No Exported Studies row for "${study.name}"` },
      },
    };
  }
  const exportedId = erow.id;
  const prodId = erow.properties['Production Study']?.relation?.[0]?.id;
  if (!prodId) {
    return {
      exitCode: 1,
      result: {
        schemaVersion: SCHEMA_VERSION,
        ok: false,
        study: studyKey,
        studyName: study.name,
        exportedRowId: exportedId,
        productionStudyId: null,
        error: { code: 'no_production_study', message: 'No Production Study wired yet — cannot recover' },
      },
    };
  }
  onProgress({ type: 'resolve-done', exportedId, prodId });

  // ─── Pre-check: skip if last Inception is already Success ─────────────
  const alres = await notionFetch('POST', `/v1/data_sources/${ACTIVITY_LOG_DS}/query`, {
    filter: { and: [
      { property: 'Study', relation: { contains: prodId } },
      { property: 'Workflow', select: { equals: 'Inception' } },
    ]},
    sorts: [{ property: 'Created time', direction: 'descending' }],
    page_size: 1,
  });
  const lastInception = alres.results?.[0];
  const lastStatus = lastInception?.properties['Status']?.select?.name;
  if (lastStatus === 'Success') {
    return {
      exitCode: 2,
      result: {
        schemaVersion: SCHEMA_VERSION,
        ok: true,
        study: studyKey,
        studyName: study.name,
        exportedRowId: exportedId,
        productionStudyId: prodId,
        alreadySuccess: true,
        state: 'already-success',
      },
    };
  }
  onProgress({ type: 'pre-check', lastStatus });

  // ─── Stage 1: deletion (with manual-task guard) ───────────────────────
  const deletion = await fireDeletionAndPoll({ prodId, deps });
  if (deletion.status !== 'ok') {
    return {
      exitCode: 1,
      result: {
        schemaVersion: SCHEMA_VERSION,
        ok: false,
        study: studyKey,
        studyName: study.name,
        exportedRowId: exportedId,
        productionStudyId: prodId,
        error: deletion.error,
        manualTaskIds: deletion.manualTaskIds, // surfaces when manual_tasks_present
        stages: [deletion],
      },
    };
  }

  // ─── Stage 2: clear audit ─────────────────────────────────────────────
  const clearAudit = await clearAuditRows({ exportedId, deps });
  if (clearAudit.status !== 'ok') {
    return {
      exitCode: 1,
      result: {
        schemaVersion: SCHEMA_VERSION,
        ok: false,
        study: studyKey,
        studyName: study.name,
        exportedRowId: exportedId,
        productionStudyId: prodId,
        error: clearAudit.error,
        stages: [deletion, clearAudit],
      },
    };
  }

  // ─── Stage 3: re-inception + verify ───────────────────────────────────
  const reInception = await reInceptionAndVerify({ prodId, deps });
  if (reInception.status !== 'ok') {
    return {
      exitCode: 1,
      result: {
        schemaVersion: SCHEMA_VERSION,
        ok: false,
        study: studyKey,
        studyName: study.name,
        exportedRowId: exportedId,
        productionStudyId: prodId,
        error: reInception.error,
        stages: [deletion, clearAudit, reInception],
      },
    };
  }

  return {
    exitCode: 0,
    result: {
      schemaVersion: SCHEMA_VERSION,
      ok: true,
      study: studyKey,
      studyName: study.name,
      exportedRowId: exportedId,
      productionStudyId: prodId,
      stages: [deletion, clearAudit, reInception],
      ready: 'Migrator can be re-fired with --skip-create-study --skip-inception',
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Main — only runs when invoked directly via node.
// ──────────────────────────────────────────────────────────────────────────
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  await runMain();
}

async function runMain() {
  await import('dotenv/config');

  const studyKey = getArg('study');
  const jsonMode = getFlag('json') || getArg('format') === 'json';
  const TOKEN = process.env.NOTION_TOKEN_1;
  const SECRET = process.env.WEBHOOK_SECRET;
  const ENGINE_URL = process.env.ENGINE_URL || 'https://picnic-cascade-engine-production.up.railway.app';

  // In JSON mode: progress + warnings → stderr; final JSON → stdout.
  // In default mode: progress → stdout (matches pre-polish behavior).
  const progressStream = jsonMode ? process.stderr : process.stdout;
  const writeLine = (s) => progressStream.write(s + '\n');
  const writeRaw = (s) => progressStream.write(s);

  const failUsage = (code, message) => {
    if (jsonMode) {
      process.stdout.write(JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        ok: false,
        study: studyKey || null,
        error: { code, message },
      }) + '\n');
    } else {
      console.error(message);
    }
    process.exit(3);
  };

  if (!studyKey) failUsage('usage', 'Usage: node recover-inception.js --study <key> [--json]');
  if (!TOKEN) failUsage('config', 'NOTION_TOKEN_1 not set');
  if (!SECRET) failUsage('config', 'WEBHOOK_SECRET not set');

  const study = findStudyConfig(studyKey);
  if (!study) failUsage('unknown_study', `Unknown study key: ${studyKey}`);

  // Human-mode progress callback. JSON mode routes to stderr.
  const onProgress = (evt) => {
    switch (evt.type) {
      case 'resolve-start':
        writeLine(`\n=== Recover Inception: ${study.name} ===`);
        writeLine('[0] Resolving identifiers');
        break;
      case 'resolve-done':
        writeLine(`  Exported row:     ${evt.exportedId}`);
        writeLine(`  Production Study: ${evt.prodId}`);
        break;
      case 'pre-check':
        writeLine(`  Most recent Inception: ${evt.lastStatus} (recovery proceeding)`);
        writeLine('\n[1] Manual-task pre-flight + Fire /webhook/deletion');
        break;
      case 'manual-tasks-detected':
        writeLine(`  ⚠ ${evt.count} manual Study Tasks present — refusing to fire deletion`);
        break;
      case 'deletion-fired':
        writeLine('  ✓ accepted');
        writeLine('\n[2] Poll cascade Study Tasks until 0');
        break;
      case 'deletion-poll':
        writeLine(`  poll ${evt.iteration}: ${evt.count} tasks`);
        break;
      case 'cursor-invalidated':
        // Cursor retry happens — surface as stderr always (parity with U7 commit)
        process.stderr.write(`[recover-inception] cursor invalidated after ${evt.resultsBeforeInvalidation} results (attempt ${evt.attempt}), retrying from scratch\n`);
        break;
      case 'clear-audit-scan':
        writeLine('\n[3] Clear Match Confidence + Notion Task on Asana Exported Tasks rows');
        writeLine(`  rows to clear: ${evt.rows}`);
        break;
      case 'clear-audit-progress':
        if (evt.patched === evt.total) {
          writeRaw(`    ${evt.patched}/${evt.total}\n`);
        } else if (evt.patched % 10 === 0) {
          writeRaw(`    ${evt.patched}/${evt.total}\r`);
        }
        break;
      case 'clear-audit-error':
        writeLine(`\n  ✗ PATCH failed on row ${evt.rowId}: ${evt.message}`);
        writeLine('  Aborting clearAudit (recovery is all-or-nothing).');
        break;
      case 'inception-fired':
        writeLine('\n[4] Fire /webhook/inception');
        writeLine('  ✓ accepted');
        writeLine('\n[5] Poll cascade Study Tasks until stable (target ~202)');
        break;
      case 'inception-poll':
        writeLine(`  poll ${evt.iteration}: ${evt.count} tasks`);
        break;
      case 'activity-log':
        writeLine('\n[6] Verify Inception Success in Activity Log');
        writeLine(`  ${evt.status}: ${evt.summary}`);
        break;
    }
  };

  const deps = {
    notionFetch: makeDefaultNotionFetch(TOKEN),
    fireWebhook: makeDefaultFireWebhook(ENGINE_URL, SECRET),
    sleep: realSleep,
    onProgress,
  };

  let exitCode, result;
  try {
    ({ exitCode, result } = await run({ studyKey, deps }));
  } catch (err) {
    // R3: uncaught throws → JSON envelope, never silent.
    const code = classifyError(err);
    const envelope = {
      schemaVersion: SCHEMA_VERSION,
      ok: false,
      study: studyKey,
      error: { code, message: String(err?.message || err).slice(0, 400) },
    };
    if (jsonMode) {
      process.stdout.write(JSON.stringify(envelope) + '\n');
    } else {
      console.error(`[fatal] ${code}: ${envelope.error.message}`);
    }
    process.exit(classifyExitCode(code));
  }

  if (jsonMode) {
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exit(exitCode);
  }

  // Default-mode tail messages — preserve pre-polish behavior.
  if (result.alreadySuccess) {
    console.log('  Most recent Inception is already Success — no recovery needed');
  } else if (result.ok === false) {
    console.error(`  ⚠ ${result.error?.message || 'recovery failed'}`);
    if (result.error?.code === 'inception_not_success') {
      console.error('  DO NOT re-fire Migrator yet. Investigate.');
    } else if (result.error?.code === 'manual_tasks_present') {
      console.error('  Coordinate with the PM, archive the manual tasks in Notion UI, then re-run.');
    }
  } else {
    console.log('\n✓ Recovery complete. Now re-fire Migrator with:');
    console.log(`  node scripts/batch-migrate/batch-migrate.js --study ${studyKey} --skip-create-study --skip-inception`);
  }
  process.exit(exitCode);
}
