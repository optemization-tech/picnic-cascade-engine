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
 *   node scripts/batch-migrate/check-inception.js --study <key> --json
 *
 * Output modes:
 *   default / --format=human  — multi-line human summary on stdout (unchanged
 *                                from before agent-readiness polish)
 *   --format=status            — single-token status name on stdout
 *                                (Success / Failed / NoEntry / NoProductionStudy)
 *   --json / --format=json     — single JSON object on stdout; progress (if
 *                                any) on stderr; agent-friendly
 *
 * Exit codes:
 *   0 = Inception Success (or pre-existing study with no need for fresh run)
 *   1 = Inception Failed (Batch incomplete) — caller should run recovery
 *   2 = No Inception entry found, or Production Study not yet created
 *   3 = Usage error / config lookup error
 */

import { findStudyConfig } from './config.js';

const ACTIVITY_LOG_DS = 'ba423867-60c2-82c3-8540-8737ba4f730d';
const EXPORTED_STUDIES_DS = 'cb785052-5633-48fe-a51d-797d033bece0';
const SCHEMA_VERSION = 1;

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
// Default fetch wrapper — `notionFetch(method, path, body?)` returns parsed
// JSON. Tests inject a mock keyed on (method, path).
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
    return res.json();
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Pure run() — never calls process.exit / console.log. Returns:
//   { exitCode, result } where result is the JSON-serializable shape.
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

  const { notionFetch } = deps;

  const erows = await notionFetch('POST', `/v1/data_sources/${EXPORTED_STUDIES_DS}/query`, {
    filter: { property: 'Study Name', title: { equals: study.name } },
    page_size: 1,
  });
  const erow = erows.results?.[0];
  if (!erow) {
    return {
      exitCode: 2,
      result: {
        schemaVersion: SCHEMA_VERSION,
        study: studyKey,
        studyName: study.name,
        exportedRowId: null,
        productionStudyId: null,
        inceptionStatus: null,
        inceptionSummary: null,
        createdTime: null,
        state: 'no-exported-row',
      },
    };
  }
  const exportedId = erow.id;
  const prodId = erow.properties['Production Study']?.relation?.[0]?.id || null;

  if (!prodId) {
    return {
      exitCode: 2,
      result: {
        schemaVersion: SCHEMA_VERSION,
        study: studyKey,
        studyName: study.name,
        exportedRowId: exportedId,
        productionStudyId: null,
        inceptionStatus: null,
        inceptionSummary: null,
        createdTime: null,
        state: 'no-production-study',
      },
    };
  }

  const alres = await notionFetch('POST', `/v1/data_sources/${ACTIVITY_LOG_DS}/query`, {
    filter: { and: [
      { property: 'Study', relation: { contains: prodId } },
      { property: 'Workflow', select: { equals: 'Inception' } },
    ]},
    sorts: [{ property: 'Created time', direction: 'descending' }],
    page_size: 1,
  });
  const entry = alres.results?.[0];

  if (!entry) {
    return {
      exitCode: 2,
      result: {
        schemaVersion: SCHEMA_VERSION,
        study: studyKey,
        studyName: study.name,
        exportedRowId: exportedId,
        productionStudyId: prodId,
        inceptionStatus: null,
        inceptionSummary: null,
        createdTime: null,
        state: 'no-entry',
      },
    };
  }

  const status = entry.properties['Status']?.select?.name || 'Unknown';
  const summary = entry.properties['Summary']?.rich_text?.map((r) => r.plain_text).join('') || '';
  const created = (entry.properties['Created time']?.created_time || entry.created_time || '').substring(0, 19);

  // Map status to exit code + state token. Known values: Success, Failed.
  // Anything else (Unknown, In Progress, etc.) maps to exit 2 + 'other'.
  let exitCode;
  let state;
  if (status === 'Success') { exitCode = 0; state = 'success'; }
  else if (status === 'Failed') { exitCode = 1; state = 'failed'; }
  else { exitCode = 2; state = 'other'; }

  return {
    exitCode,
    result: {
      schemaVersion: SCHEMA_VERSION,
      study: studyKey,
      studyName: study.name,
      exportedRowId: exportedId,
      productionStudyId: prodId,
      inceptionStatus: status,
      inceptionSummary: summary,
      createdTime: created ? `${created}Z` : null,
      state,
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Main — only runs when invoked directly via node, not on import.
// ──────────────────────────────────────────────────────────────────────────
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  await runMain();
}

async function runMain() {
  // Lazy CLI-only imports so tests don't pull dotenv.
  await import('dotenv/config');

  const studyKey = getArg('study');
  const jsonFlag = getFlag('json');
  const formatArg = getArg('format');
  const format = jsonFlag ? 'json' : (formatArg || 'human');
  const TOKEN = process.env.NOTION_TOKEN_1;

  if (!studyKey) {
    if (format === 'json') {
      process.stdout.write(JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        ok: false,
        error: { code: 'usage', message: '--study is required' },
      }) + '\n');
    } else {
      console.error('Usage: node check-inception.js --study <key> [--format=status|human|json] [--json]');
    }
    process.exit(3);
  }
  if (!TOKEN) {
    if (format === 'json') {
      process.stdout.write(JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        ok: false,
        error: { code: 'config', message: 'NOTION_TOKEN_1 not set in env' },
      }) + '\n');
    } else {
      console.error('NOTION_TOKEN_1 not set in env');
    }
    process.exit(3);
  }

  const deps = { notionFetch: makeDefaultNotionFetch(TOKEN) };
  const { exitCode, result } = await run({ studyKey, deps });

  if (format === 'json') {
    process.stdout.write(JSON.stringify(result) + '\n');
  } else if (format === 'status') {
    // Backwards-compatible single-token output. NoProductionStudy / NoEntry are
    // the existing tokens; map state → token.
    const tokenByState = {
      'success': result.inceptionStatus || 'Success',
      'failed': result.inceptionStatus || 'Failed',
      'other': result.inceptionStatus || 'Unknown',
      'no-entry': 'NoEntry',
      'no-exported-row': 'NoExportedRow',
      'no-production-study': 'NoProductionStudy',
    };
    console.log(tokenByState[result.state] || result.state);
  } else {
    // Human format — mirrors prior behavior. Errors went to console.error before;
    // keep that, but the success/info path stays on stdout.
    if (result.state === 'no-exported-row') {
      console.error(`No Exported Studies row found for "${result.studyName}"`);
    } else if (result.state === 'no-production-study') {
      console.log(`No Production Study yet for "${result.studyName}" (Exported row: ${result.exportedRowId})`);
    } else if (result.state === 'no-entry') {
      console.log(`No Inception entry found for "${result.studyName}" (Production Study: ${result.productionStudyId})`);
    } else {
      console.log(`Study:            ${result.studyName}`);
      console.log(`Exported row:     ${result.exportedRowId}`);
      console.log(`Production Study: ${result.productionStudyId}`);
      console.log(`Inception entry:  [${result.createdTime}] ${result.inceptionStatus}`);
      console.log(`Summary:          ${result.inceptionSummary}`);
    }
  }

  process.exit(exitCode);
}
