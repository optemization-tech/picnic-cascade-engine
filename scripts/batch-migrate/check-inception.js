#!/usr/bin/env node
/**
 * Check the Activity Log for the latest Inception entry on a given study.
 *
 * The orchestrator's "Inception complete: N tasks" line is just the count when
 * polling crossed the >=100 threshold, NOT the final count. PR #98 surfaces
 * silent-batch-abort partial failures in Activity Log via the "Batch
 * incomplete" body line. This script is the canonical post-orchestrator
 * verification step.
 *
 * Usage:
 *   node scripts/batch-migrate/check-inception.js --study <key>
 *   node scripts/batch-migrate/check-inception.js --study <key> --format=status
 *
 * Exit codes:
 *   0 = Inception Success (or pre-existing study with no need for fresh run)
 *   1 = Inception Failed (Batch incomplete) — caller should run recovery
 *   2 = No Inception entry found, or Production Study not yet created
 *   3 = Usage error / config lookup error
 */

import { config as dotenvConfig } from 'dotenv';
dotenvConfig();

import { findStudyConfig } from './config.js';

const ACTIVITY_LOG_DS = 'ba423867-60c2-82c3-8540-8737ba4f730d';
const EXPORTED_STUDIES_DS = 'cb785052-5633-48fe-a51d-797d033bece0';

function getArg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) {
    // --foo=bar form
    const eqMatch = process.argv.find((a) => a.startsWith(`--${name}=`));
    if (eqMatch) return eqMatch.split('=').slice(1).join('=');
    return fallback;
  }
  const next = process.argv[i + 1];
  if (next === undefined || next.startsWith('--')) return true;
  return next;
}

const studyKey = getArg('study');
const format = getArg('format') || 'human';
const TOKEN = process.env.NOTION_TOKEN_1;

if (!studyKey) {
  console.error('Usage: node check-inception.js --study <key> [--format=status|human]');
  process.exit(3);
}
if (!TOKEN) {
  console.error('NOTION_TOKEN_1 not set in env');
  process.exit(3);
}

const study = findStudyConfig(studyKey);
if (!study) {
  console.error(`Unknown study key: ${studyKey}`);
  process.exit(3);
}

async function notion(path, body = null) {
  const opts = {
    method: body ? 'POST' : 'GET',
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

const erows = await notion(`/v1/data_sources/${EXPORTED_STUDIES_DS}/query`, {
  filter: { property: 'Study Name', title: { equals: study.name } },
  page_size: 1,
});
const erow = erows.results?.[0];
if (!erow) {
  console.error(`No Exported Studies row found for "${study.name}"`);
  process.exit(2);
}
const exportedId = erow.id;
const prodId = erow.properties['Production Study']?.relation?.[0]?.id;
if (!prodId) {
  if (format === 'status') console.log('NoProductionStudy');
  else console.log(`No Production Study yet for "${study.name}" (Exported row: ${exportedId})`);
  process.exit(2);
}

const alres = await notion(`/v1/data_sources/${ACTIVITY_LOG_DS}/query`, {
  filter: { and: [
    { property: 'Study', relation: { contains: prodId } },
    { property: 'Workflow', select: { equals: 'Inception' } },
  ]},
  sorts: [{ property: 'Created time', direction: 'descending' }],
  page_size: 1,
});
const entry = alres.results?.[0];

if (!entry) {
  if (format === 'status') console.log('NoEntry');
  else console.log(`No Inception entry found for "${study.name}" (Production Study: ${prodId})`);
  process.exit(2);
}

const status = entry.properties['Status']?.select?.name || 'Unknown';
const summary = entry.properties['Summary']?.rich_text?.map((r) => r.plain_text).join('') || '';
const created = (entry.properties['Created time']?.created_time || entry.created_time || '').substring(0, 19);

if (format === 'status') {
  console.log(status);
} else {
  console.log(`Study:            ${study.name}`);
  console.log(`Exported row:     ${exportedId}`);
  console.log(`Production Study: ${prodId}`);
  console.log(`Inception entry:  [${created}Z] ${status}`);
  console.log(`Summary:          ${summary}`);
}

if (status === 'Success') process.exit(0);
if (status === 'Failed') process.exit(1);
process.exit(2);
