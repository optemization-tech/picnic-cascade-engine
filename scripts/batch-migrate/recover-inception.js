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
 *
 * Exit codes:
 *   0 = recovery complete; caller can re-fire Migrator
 *   1 = recovery failed (left in unsafe state — escalate)
 *   2 = nothing to recover (Inception was already Success)
 *   3 = usage / config error
 */

import { config as dotenvConfig } from 'dotenv';
dotenvConfig();

import { findStudyConfig } from './config.js';

const ACTIVITY_LOG_DS = 'ba423867-60c2-82c3-8540-8737ba4f730d';
const EXPORTED_STUDIES_DS = 'cb785052-5633-48fe-a51d-797d033bece0';
const STUDY_TASKS_DS = 'eb823867-60c2-83a6-b067-07cd54089367';
const ASANA_TASKS_DS = '82ae00bc-5cad-4f48-bd35-3d4e216a6a4b';
const ENGINE_URL = process.env.ENGINE_URL || 'https://picnic-cascade-engine-production.up.railway.app';
const TOKEN = process.env.NOTION_TOKEN_1;
const SECRET = process.env.WEBHOOK_SECRET;

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

const studyKey = getArg('study');
if (!studyKey) {
  console.error('Usage: node recover-inception.js --study <key>');
  process.exit(3);
}
if (!TOKEN) { console.error('NOTION_TOKEN_1 not set'); process.exit(3); }
if (!SECRET) { console.error('WEBHOOK_SECRET not set'); process.exit(3); }

const study = findStudyConfig(studyKey);
if (!study) { console.error(`Unknown study key: ${studyKey}`); process.exit(3); }

async function notion(path, body = null, method = null) {
  const opts = {
    method: method || (body ? 'POST' : 'GET'),
    headers: {
      'Authorization': `Bearer ${TOKEN}`,
      'Notion-Version': '2025-09-03',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`https://api.notion.com${path}`, opts);
  return res.json();
}

// See scripts/batch-migrate/notion.js queryDb for the canonical cursor-retry
// pattern. We don't import that helper because it targets the legacy
// /v1/databases/{id}/query endpoint at Notion-Version 2022-06-28; this script
// uses /v1/data_sources/{id}/query at Notion-Version 2025-09-03.
function isCursorInvalidation(j) {
  return j?.object === 'error'
    && j?.code === 'validation_error'
    && /cursor/i.test(j?.message || '');
}

async function queryAll(ds, filter, { maxAttempts = 3 } = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const all = [];
    let cursor = undefined;
    let cursorInvalidated = false;
    while (true) {
      const body = { filter, page_size: 100 };
      if (cursor) body.start_cursor = cursor;
      const j = await notion(`/v1/data_sources/${ds}/query`, body);
      if (isCursorInvalidation(j)) {
        // Cursor went stale mid-pagination (cascade was being mutated by another
        // process — exactly the GSK SLE BEACON failure mode). Restart from page 1.
        console.error(`[recover-inception] cursor invalidated after ${all.length} results (attempt ${attempt}/${maxAttempts}), retrying from scratch`);
        cursorInvalidated = true;
        break;
      }
      if (!j.results) throw new Error(`query error: ${JSON.stringify(j)}`);
      all.push(...j.results);
      if (!j.has_more) return all;
      cursor = j.next_cursor;
    }
    if (!cursorInvalidated) return all; // shouldn't happen — defensive
    // Cursor invalidated — outer loop continues to next attempt
  }
  const err = new Error(`cursor retries exhausted (${maxAttempts} attempts)`);
  err.code = 'cursor_exhausted';
  throw err;
}

async function patchPage(id, properties) {
  const r = await fetch(`https://api.notion.com/v1/pages/${id}`, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${TOKEN}`, 'Notion-Version': '2025-09-03', 'Content-Type': 'application/json' },
    body: JSON.stringify({ properties }),
  });
  if (!r.ok) throw new Error(`PATCH ${id} ${r.status}: ${await r.text()}`);
  return r.json();
}

async function fireWebhook(path, body) {
  const r = await fetch(`${ENGINE_URL}${path}`, {
    method: 'POST',
    headers: { 'X-Webhook-Secret': SECRET, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${path} ${r.status}: ${await r.text()}`);
  return r.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`\n=== Recover Inception: ${study.name} ===`);

// ─── Resolve identifiers ───────────────────────────────────────────────────
console.log('[0] Resolving identifiers');
const erows = await notion(`/v1/data_sources/${EXPORTED_STUDIES_DS}/query`, {
  filter: { property: 'Study Name', title: { equals: study.name } },
  page_size: 1,
});
const erow = erows.results?.[0];
if (!erow) { console.error(`No Exported Studies row for "${study.name}"`); process.exit(1); }
const exportedId = erow.id;
const prodId = erow.properties['Production Study']?.relation?.[0]?.id;
if (!prodId) { console.error('No Production Study wired yet — cannot recover'); process.exit(1); }
console.log(`  Exported row:     ${exportedId}`);
console.log(`  Production Study: ${prodId}`);

// ─── Pre-check: is recovery actually needed? ───────────────────────────────
const alres = await notion(`/v1/data_sources/${ACTIVITY_LOG_DS}/query`, {
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
  console.log(`  Most recent Inception is already Success — no recovery needed`);
  process.exit(2);
}
console.log(`  Most recent Inception: ${lastStatus} (recovery proceeding)`);

// ─── Step 1: fire deletion ─────────────────────────────────────────────────
console.log('\n[1] Fire /webhook/deletion');
await fireWebhook('/webhook/deletion', { data: { id: prodId } });
console.log('  ✓ accepted');

// ─── Step 2: poll cascade until 0 ──────────────────────────────────────────
console.log('\n[2] Poll cascade Study Tasks until 0');
for (let i = 1; i <= 20; i++) {
  await sleep(15000);
  const all = await queryAll(STUDY_TASKS_DS, { property: 'Study', relation: { contains: prodId } });
  console.log(`  poll ${i}: ${all.length} tasks`);
  if (all.length === 0) break;
  if (i === 20) { console.error('  deletion timed out (>5min)'); process.exit(1); }
}

// ─── Step 3: clear Match Confidence + Notion Task on Asana Exported Tasks ─
console.log('\n[3] Clear Match Confidence + Notion Task on Asana Exported Tasks rows');
const dirty = await queryAll(ASANA_TASKS_DS, { and: [
  { property: 'Study', relation: { contains: exportedId } },
  { or: [
    { property: 'Match Confidence', select: { is_not_empty: true } },
    { property: 'Notion Task', relation: { is_not_empty: true } },
  ]},
]});
console.log(`  rows to clear: ${dirty.length}`);
let patched = 0;
for (const row of dirty) {
  await patchPage(row.id, {
    'Match Confidence': { select: null },
    'Notion Task': { relation: [] },
  });
  patched++;
  if (patched % 10 === 0) {
    process.stdout.write(`    ${patched}/${dirty.length}\r`);
    await sleep(1100);
  }
}
process.stdout.write(`    ${patched}/${dirty.length}\n`);

// ─── Step 4: fire Inception ────────────────────────────────────────────────
console.log('\n[4] Fire /webhook/inception');
await fireWebhook('/webhook/inception', { data: { id: prodId } });
console.log('  ✓ accepted');

// ─── Step 5: poll cascade until stable ─────────────────────────────────────
console.log('\n[5] Poll cascade Study Tasks until stable (target ~202)');
let prev = 0;
let stable = 0;
for (let i = 1; i <= 24; i++) {
  await sleep(20000);
  const all = await queryAll(STUDY_TASKS_DS, { and: [
    { property: 'Study', relation: { contains: prodId } },
    { property: '[Do Not Edit] Template Source ID', rich_text: { is_not_empty: true } },
  ]});
  console.log(`  poll ${i}: ${all.length} tasks`);
  if (all.length === prev && all.length > 100) {
    stable++;
    if (stable >= 2) break;
  } else {
    stable = 0;
  }
  prev = all.length;
  if (i === 24) { console.error('  Inception timed out (>8min) without stabilizing'); process.exit(1); }
}

// ─── Step 6: verify Activity Log says Success ──────────────────────────────
console.log('\n[6] Verify Inception Success in Activity Log');
await sleep(5000); // give the engine a moment to write the AL entry
const alres2 = await notion(`/v1/data_sources/${ACTIVITY_LOG_DS}/query`, {
  filter: { and: [
    { property: 'Study', relation: { contains: prodId } },
    { property: 'Workflow', select: { equals: 'Inception' } },
  ]},
  sorts: [{ property: 'Created time', direction: 'descending' }],
  page_size: 1,
});
const fresh = alres2.results?.[0];
const freshStatus = fresh?.properties['Status']?.select?.name;
const freshSummary = fresh?.properties['Summary']?.rich_text?.map((r) => r.plain_text).join('') || '';
console.log(`  ${freshStatus}: ${freshSummary}`);

if (freshStatus !== 'Success') {
  console.error('  ⚠ Inception did not report Success — DO NOT re-fire Migrator yet. Investigate.');
  process.exit(1);
}

console.log('\n✓ Recovery complete. Now re-fire Migrator with:');
console.log(`  node scripts/batch-migrate/batch-migrate.js --study ${studyKey} --skip-create-study --skip-inception`);
process.exit(0);
