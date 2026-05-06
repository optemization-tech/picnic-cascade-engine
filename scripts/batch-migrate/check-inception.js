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
 *   default / --format=human  — multi-line human summary on stdout (byte-identical
 *                                to pre-polish behavior)
 *   --format=status            — single-token status name on stdout
 *                                (Success / Failed / NoEntry / NoProductionStudy)
 *   --json / --format=json     — single JSON envelope on stdout; agent-friendly
 *
 * Exit codes:
 *   0 = Inception Success (or pre-existing study with no need for fresh run)
 *   1 = Inception Failed (Batch incomplete) — caller should run recovery
 *   2 = No Inception entry found, or Production Study not yet created
 *   3 = Usage error / config lookup error
 *   4 = Transient/inconclusive (network 5xx, timeout, ECONNRESET) — caller should
 *       retry the read, NOT trigger destructive recovery
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
// Error classification (R8). Distinguishes auth_error (401/403) from generic
// notion_api (other 4xx) so monitoring can detect credential issues vs filter
// bugs. Transient errors (5xx, network, timeout) trigger exit code 4 (R2).
// ──────────────────────────────────────────────────────────────────────────
function classifyError(err) {
  const message = String(err?.message || err || '');
  if (err?.status === 401 || err?.status === 403 || /\b401\b|\b403\b/.test(message)) {
    return 'auth_error';
  }
  if (err?.status >= 400 && err?.status < 500) return 'notion_api';
  if (/\b4\d\d\b/.test(message) && !/\b5\d\d\b/.test(message)) return 'notion_api';
  if (err?.name === 'TimeoutError' || /\bECONN(RESET|REFUSED|ABORTED)\b|\btimeout\b|\bnetwork\b|\b5\d\d\b/i.test(message)) {
    return 'transient';
  }
  return 'unknown';
}

function classifyExitCode(category) {
  return category === 'transient' ? 4 : 1;
}

// ──────────────────────────────────────────────────────────────────────────
// Default fetch wrapper — `notionFetch(method, path, body?)` returns parsed
// JSON. Includes retry-with-backoff + AbortSignal.timeout (R16/R17).
//
// Retry layer lives INSIDE makeDefaultNotionFetch (Q7) so all callers benefit
// from a single source of retry logic. Tests inject a non-retrying mock.
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
          // Retryable: 5xx
          await new Promise((r) => setTimeout(r, retryBaseMs * (attempt + 1)));
          continue;
        }
        if (res.status === 401 || res.status === 403) {
          const err = new Error(`auth error: ${res.status} ${await res.text().catch(() => '')}`);
          err.status = res.status;
          throw err;
        }
        return res.json();
      } catch (err) {
        lastErr = err;
        // AbortError (timeout) and network errors are retryable
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
        ok: false,
        study: studyKey,
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
        ok: false,
        study: studyKey,
        studyName: study.name,
        exportedRowId: null,
        productionStudyId: null,
        inceptionStatus: null,
        inceptionSummary: null,
        createdTime: null,
        state: 'no_exported_row',
        error: { code: 'no_exported_row', message: `No Exported Studies row found for "${study.name}"` },
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
        ok: true,
        study: studyKey,
        studyName: study.name,
        exportedRowId: exportedId,
        productionStudyId: null,
        inceptionStatus: null,
        inceptionSummary: null,
        createdTime: null,
        state: 'no_production_study',
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
        ok: true,
        study: studyKey,
        studyName: study.name,
        exportedRowId: exportedId,
        productionStudyId: prodId,
        inceptionStatus: null,
        inceptionSummary: null,
        createdTime: null,
        state: 'no_entry',
      },
    };
  }

  const status = entry.properties['Status']?.select?.name || 'Unknown';
  const summary = entry.properties['Summary']?.rich_text?.map((r) => r.plain_text).join('') || '';
  const created = (entry.properties['Created time']?.created_time || entry.created_time || '').substring(0, 19);

  // R5: state enum is exhaustive — In Progress / Unknown / Cancelled get
  // distinct snake_case tokens. compose-envelope's outcome derivation honors
  // the distinction (in-flight states map to `inconclusive` when orch is clean,
  // `failed` when orch failed — see R18 / Q5 conditional rule).
  let exitCode;
  let state;
  if (status === 'Success') { exitCode = 0; state = 'success'; }
  else if (status === 'Failed') { exitCode = 1; state = 'failed'; }
  else if (status === 'In Progress') { exitCode = 2; state = 'in_progress'; }
  else if (status === 'Cancelled') { exitCode = 2; state = 'cancelled'; }
  else { exitCode = 2; state = 'unknown'; } // includes 'Unknown' and any other Notion-emitted token

  return {
    exitCode,
    result: {
      schemaVersion: SCHEMA_VERSION,
      ok: true,
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
  await import('dotenv/config');

  const studyKey = getArg('study');
  const jsonFlag = getFlag('json');
  const formatArg = getArg('format');
  const format = jsonFlag ? 'json' : (formatArg || 'human');
  const TOKEN = process.env.NOTION_TOKEN_1;

  const failUsage = (code, message) => {
    if (format === 'json') {
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

  if (!studyKey) {
    failUsage('usage', 'Usage: node check-inception.js --study <key> [--format=status|human|json] [--json]');
  }
  if (!TOKEN) {
    failUsage('config', 'NOTION_TOKEN_1 not set in env');
  }

  const deps = { notionFetch: makeDefaultNotionFetch(TOKEN) };

  let exitCode, result;
  try {
    ({ exitCode, result } = await run({ studyKey, deps }));
  } catch (err) {
    // R3: uncaught throws → JSON envelope, never silent. Routed by classifyError.
    const code = classifyError(err);
    const envelope = {
      schemaVersion: SCHEMA_VERSION,
      ok: false,
      study: studyKey,
      error: { code, message: String(err?.message || err).slice(0, 400) },
    };
    if (format === 'json') {
      process.stdout.write(JSON.stringify(envelope) + '\n');
    } else {
      console.error(`[fatal] ${code}: ${envelope.error.message}`);
    }
    process.exit(classifyExitCode(code));
  }

  if (format === 'json') {
    process.stdout.write(JSON.stringify(result) + '\n');
  } else if (format === 'status') {
    // Backwards-compatible single-token output. Tokens map snake_case state
    // to human-readable surface; --format=status output is preserved verbatim
    // even though internal state tokens were renamed.
    const tokenByState = {
      'success': result.inceptionStatus || 'Success',
      'failed': result.inceptionStatus || 'Failed',
      'in_progress': result.inceptionStatus || 'InProgress',
      'unknown': result.inceptionStatus || 'Unknown',
      'cancelled': result.inceptionStatus || 'Cancelled',
      'no_entry': 'NoEntry',
      'no_exported_row': 'NoExportedRow',
      'no_production_study': 'NoProductionStudy',
    };
    if (result.state === 'no_exported_row') {
      console.error(result.error?.message || `No Exported Studies row found for "${result.studyName}"`);
    } else {
      console.log(tokenByState[result.state] || result.state);
    }
  } else {
    // Human format — preserves prior byte-identical output for the success path.
    if (result.state === 'no_exported_row') {
      console.error(result.error?.message || `No Exported Studies row found for "${result.studyName}"`);
    } else if (result.state === 'no_production_study') {
      console.log(`No Production Study yet for "${result.studyName}" (Exported row: ${result.exportedRowId})`);
    } else if (result.state === 'no_entry') {
      console.log(`No Inception entry found for "${result.studyName}" (Production Study: ${result.productionStudyId})`);
    } else {
      console.log(`Study:            ${result.studyName}`);
      console.log(`Exported row:     ${result.exportedRowId}`);
      console.log(`Production Study: ${result.productionStudyId}`);
      console.log(`Inception entry:  [${result.createdTime || 'Z'}] ${result.inceptionStatus}`);
      console.log(`Summary:          ${result.inceptionSummary}`);
    }
  }

  process.exit(exitCode);
}
