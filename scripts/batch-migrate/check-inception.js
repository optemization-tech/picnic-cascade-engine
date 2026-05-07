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
 *   --format=status            — single-token status name on stdout. Tokens:
 *                                Success / Failed / NoEntry / NoProductionStudy /
 *                                NoExportedRow / InProgress / Cancelled / Unknown.
 *                                (PR B added the in-flight tokens; legacy callers
 *                                of Success / Failed / NoEntry / NoProductionStudy
 *                                continue to work unchanged.)
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
//
// Code review fixes applied:
//   #4: 401/403 detection uses err.status only — regex on message text false-
//       positives on 5xx with substring like "request id e4f7-401-abcd".
//   #7: AbortError added (Node throws AbortError on AbortSignal.timeout
//       in some versions, TimeoutError in others).
// ──────────────────────────────────────────────────────────────────────────
function classifyError(err) {
  const message = String(err?.message || err || '');
  // Auth errors: rely on err.status (set by the fetch wrapper); do NOT
  // pattern-match on message text.
  if (err?.status === 401 || err?.status === 403) return 'auth_error';
  // Other 4xx: notion_api (filter / payload / rate-limit issue).
  if (err?.status >= 400 && err?.status < 500) return 'notion_api';
  // cursor_exhausted is preserved if the caller stamped err.code (R11).
  if (err?.code === 'cursor_exhausted') return 'cursor_exhausted';
  // Transient: timeouts (TimeoutError or AbortError per Node version),
  // network errors. err.status >= 500 also goes here.
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return 'transient';
  if (err?.status >= 500) return 'transient';
  if (/\bECONN(RESET|REFUSED|ABORTED)\b|\bnetwork\b|\bfetch failed\b/i.test(message)) {
    return 'transient';
  }
  return 'unknown';
}

function classifyExitCode(category) {
  // Both `transient` and `cursor_exhausted` are retry-eligible (genuinely
  // transient failures). Caller should retry the read, NOT escalate to
  // destructive recovery. Code review #6, P1.
  return (category === 'transient' || category === 'cursor_exhausted') ? 4 : 1;
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
        // Retryable status codes: 5xx (server) AND 429 (rate limit).
        // (Code review #8, P1 — sibling notion.js retries 429 with retry-after honor.)
        if ((res.status >= 500 || res.status === 429) && attempt < maxRetries) {
          // Honor Retry-After header when present; cap at 30s. Default to
          // exponential backoff. (Code review #8.)
          const retryAfter = parseInt(res.headers.get('retry-after') || '', 10);
          const sleepMs = Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter * 1000, 30000)
            : retryBaseMs * (attempt + 1);
          await new Promise((r) => setTimeout(r, sleepMs));
          continue;
        }
        // Auth errors: throw with err.status set so classifyError keys off the
        // numeric status, not message regex (code review #4).
        if (res.status === 401 || res.status === 403) {
          const err = new Error(`auth error: ${res.status} ${await res.text().catch(() => '')}`);
          err.status = res.status;
          throw err;
        }
        // Final-attempt 5xx/429 (retry budget exhausted): throw with err.status
        // so classifyError sees it as transient instead of falling through to
        // res.json() and returning the error body unthrown. Code review #3, P1.
        if (res.status >= 500 || res.status === 429) {
          const err = new Error(`${method} ${path} ${res.status}: retry budget exhausted`);
          err.status = res.status;
          throw err;
        }
        // Other 4xx: throw with status for classifyError to route as notion_api.
        if (res.status >= 400) {
          const txt = await res.text().catch(() => '');
          const err = new Error(`${method} ${path} ${res.status}: ${txt}`);
          err.status = res.status;
          throw err;
        }
        return res.json();
      } catch (err) {
        lastErr = err;
        // Transient = network error (TimeoutError/AbortError or ECONN*) OR
        // a stamped 5xx/429 status from the throw above.
        const transient = err?.name === 'TimeoutError' || err?.name === 'AbortError'
          || err?.status >= 500 || err?.status === 429
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

  // Code review #18: getArg returns boolean `true` when the flag has no value
  // (e.g., `--study --json`). Reject both missing and non-string values so the
  // usage error fires here instead of downstream "Unknown study key: true".
  if (!studyKey || typeof studyKey !== 'string') {
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
    // Code review #2 (P1): emit `state: 'inconclusive'` on transient errors so
    // compose-envelope's deriveOutcome can map to outcome=`inconclusive` (and
    // exit code 2) instead of falling through to `failed` (exit 1). Without
    // this, the destructive-cascade-on-transient (R2) is bypassed at the
    // envelope layer.
    const state = (code === 'transient' || code === 'cursor_exhausted')
      ? 'inconclusive'
      : null;
    const envelope = {
      schemaVersion: SCHEMA_VERSION,
      ok: false,
      study: studyKey,
      error: { code, message: String(err?.message || err).slice(0, 400) },
      ...(state ? { state } : {}),
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
