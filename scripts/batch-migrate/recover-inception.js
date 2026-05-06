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
 *   default   — multi-step progress lines on stdout (unchanged from before
 *               agent-readiness polish)
 *   --json    — single JSON object on stdout at end; progress on stderr
 *
 * Exit codes:
 *   0 = recovery complete; caller can re-fire Migrator
 *   1 = recovery failed (left in unsafe state — escalate)
 *   2 = nothing to recover (Inception was already Success)
 *   3 = usage / config error
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
// Default fetch wrappers. Tests inject mocks via deps.
// ──────────────────────────────────────────────────────────────────────────
function makeDefaultNotionFetch(token) {
  return async function notionFetch(method, path, body = null) {
    const opts = {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Notion-Version': '2025-09-03',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`https://api.notion.com${path}`, opts);
    // Page PATCH returns non-OK with body — surface text for clearer errors.
    if (method === 'PATCH' && !res.ok) {
      throw new Error(`PATCH ${path} ${res.status}: ${await res.text()}`);
    }
    return res.json();
  };
}

function makeDefaultFireWebhook(engineUrl, secret) {
  return async function fireWebhook(path, body) {
    const r = await fetch(`${engineUrl}${path}`, {
      method: 'POST',
      headers: { 'X-Webhook-Secret': secret, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`${path} ${r.status}: ${await r.text()}`);
    return r.json();
  };
}

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const noopProgress = () => {};

// ──────────────────────────────────────────────────────────────────────────
// Helper: paginated Notion data-source query.
// ──────────────────────────────────────────────────────────────────────────
async function queryAll(notionFetch, ds, filter) {
  const all = []; let cursor = undefined;
  while (true) {
    const body = { filter, page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const j = await notionFetch('POST', `/v1/data_sources/${ds}/query`, body);
    if (!j.results) throw new Error(`query error: ${JSON.stringify(j)}`);
    all.push(...j.results);
    if (!j.has_more) break;
    cursor = j.next_cursor;
  }
  return all;
}

// ──────────────────────────────────────────────────────────────────────────
// Stage 1: fire deletion webhook + poll cascade until 0.
// ──────────────────────────────────────────────────────────────────────────
export async function fireDeletionAndPoll({ prodId, deps }) {
  const { notionFetch, fireWebhook, sleep = realSleep, onProgress = noopProgress, pollLimits = DEFAULT_POLL_LIMITS } = deps;
  const limits = pollLimits.deletion;

  await fireWebhook('/webhook/deletion', { data: { id: prodId } });
  onProgress({ type: 'deletion-fired' });

  let tasksAtStart = null;
  for (let i = 1; i <= limits.maxIterations; i++) {
    await sleep(limits.intervalMs);
    const all = await queryAll(notionFetch, STUDY_TASKS_DS, { property: 'Study', relation: { contains: prodId } });
    if (tasksAtStart === null) tasksAtStart = all.length;
    onProgress({ type: 'deletion-poll', iteration: i, count: all.length });
    if (all.length === 0) {
      return {
        name: 'deletion',
        status: 'ok',
        tasksArchivedAtStart: tasksAtStart,
        pollIterations: i,
      };
    }
    if (i === limits.maxIterations) {
      return {
        name: 'deletion',
        status: 'failed',
        tasksArchivedAtStart: tasksAtStart,
        pollIterations: i,
        error: { code: 'deletion_timeout', message: `deletion timed out (>${limits.maxIterations * limits.intervalMs / 60000}min)` },
      };
    }
  }
  // unreachable — loop above always returns
  return { name: 'deletion', status: 'failed', error: { code: 'deletion_unknown', message: 'loop fell through' } };
}

// ──────────────────────────────────────────────────────────────────────────
// Stage 2: clear Match Confidence + Notion Task on Asana Exported Tasks rows.
// ──────────────────────────────────────────────────────────────────────────
export async function clearAuditRows({ exportedId, deps }) {
  const { notionFetch, sleep = realSleep, onProgress = noopProgress, pollLimits = DEFAULT_POLL_LIMITS } = deps;
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
    await notionFetch('PATCH', `/v1/pages/${row.id}`, {
      properties: {
        'Match Confidence': { select: null },
        'Notion Task': { relation: [] },
      },
    });
    patched++;
    onProgress({ type: 'clear-audit-progress', patched, total: dirty.length });
    if (patched % cfg.batchSize === 0) {
      await sleep(cfg.throttleMs);
    }
  }
  return {
    name: 'clearAudit',
    status: 'ok',
    rowsScanned: dirty.length,
    rowsCleared: patched,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Stage 3: fire inception + poll until stable + verify Activity Log Success.
// ──────────────────────────────────────────────────────────────────────────
export async function reInceptionAndVerify({ prodId, deps }) {
  const { notionFetch, fireWebhook, sleep = realSleep, onProgress = noopProgress, pollLimits = DEFAULT_POLL_LIMITS } = deps;
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
        study: studyKey,
        ok: false,
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
        study: studyKey,
        studyName: study.name,
        ok: false,
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
        study: studyKey,
        studyName: study.name,
        exportedRowId: exportedId,
        productionStudyId: null,
        ok: false,
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

  // ─── Stage 1: deletion ────────────────────────────────────────────────
  const deletion = await fireDeletionAndPoll({ prodId, deps });
  if (deletion.status !== 'ok') {
    return {
      exitCode: 1,
      result: {
        schemaVersion: SCHEMA_VERSION,
        study: studyKey,
        studyName: study.name,
        exportedRowId: exportedId,
        productionStudyId: prodId,
        ok: false,
        error: deletion.error,
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
        study: studyKey,
        studyName: study.name,
        exportedRowId: exportedId,
        productionStudyId: prodId,
        ok: false,
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
        study: studyKey,
        studyName: study.name,
        exportedRowId: exportedId,
        productionStudyId: prodId,
        ok: false,
        error: reInception.error,
        stages: [deletion, clearAudit, reInception],
      },
    };
  }

  return {
    exitCode: 0,
    result: {
      schemaVersion: SCHEMA_VERSION,
      study: studyKey,
      studyName: study.name,
      exportedRowId: exportedId,
      productionStudyId: prodId,
      stages: [deletion, clearAudit, reInception],
      ready: `Migrator can be re-fired with --skip-create-study --skip-inception`,
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
  // In default mode: progress → stdout (matches current behavior).
  const progressStream = jsonMode ? process.stderr : process.stdout;
  const writeLine = (s) => progressStream.write(s + '\n');
  const writeRaw = (s) => progressStream.write(s);

  const failUsage = (code, message) => {
    if (jsonMode) {
      process.stdout.write(JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        ok: false,
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

  // Human-mode progress callback — translates structured events to the same
  // line shape as the pre-polish script. JSON-mode mirror routes to stderr.
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
        writeLine('\n[1] Fire /webhook/deletion');
        break;
      case 'deletion-fired':
        writeLine('  ✓ accepted');
        writeLine('\n[2] Poll cascade Study Tasks until 0');
        break;
      case 'deletion-poll':
        writeLine(`  poll ${evt.iteration}: ${evt.count} tasks`);
        break;
      case 'clear-audit-scan':
        writeLine('\n[3] Clear Match Confidence + Notion Task on Asana Exported Tasks rows');
        writeLine(`  rows to clear: ${evt.rows}`);
        break;
      case 'clear-audit-progress':
        // Final tick prints with newline; intermediate ticks use \r overwrite.
        if (evt.patched === evt.total) {
          writeRaw(`    ${evt.patched}/${evt.total}\n`);
        } else if (evt.patched % 10 === 0) {
          writeRaw(`    ${evt.patched}/${evt.total}\r`);
        }
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

  const { exitCode, result } = await run({ studyKey, deps });

  if (jsonMode) {
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exit(exitCode);
  }

  // Default-mode tail messages mirror the pre-polish script.
  if (result.alreadySuccess) {
    console.log(`  Most recent Inception is already Success — no recovery needed`);
  } else if (result.ok === false) {
    console.error(`  ⚠ ${result.error?.message || 'recovery failed'}`);
    if (result.error?.code === 'inception_not_success') {
      console.error('  DO NOT re-fire Migrator yet. Investigate.');
    }
  } else {
    console.log('\n✓ Recovery complete. Now re-fire Migrator with:');
    console.log(`  node scripts/batch-migrate/batch-migrate.js --study ${studyKey} --skip-create-study --skip-inception`);
  }
  process.exit(exitCode);
}
