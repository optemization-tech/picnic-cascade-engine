/**
 * Workspace-wide duplicate sweep.
 *
 * Two modes:
 *   1. Historical cleanup (one-time, post-merge) — archives the handful of
 *      silent duplicates that accumulated before PR E2 shipped.
 *   2. Weekly scheduled sweep — catches stragglers that slipped past the
 *      per-run 45s grace window AND any future regressions. Safety net
 *      for the per-run sweep.
 *
 * Keep-rule (historical, no engine-tracked list available):
 *   Tri-state classification per duplicate group:
 *     - `wired`        — Parent Task / Blocked by / Blocking relation populated.
 *     - `root-unwired` — no relations, but all duplicates share the same empty
 *                        state (consistent root-level by design).
 *     - `true-unwired` — no relations AND the group is inconsistent (some wired,
 *                        others not) — orphans from failed wiring.
 *   Rules:
 *     1. If any duplicate is `wired` and others are not → keep wired, archive
 *        the unwired/orphaned ones.
 *     2. If all duplicates share the same state → fall back to earliest
 *        `created_time`. Ties within <100ms emit `tie_warning: true` so the
 *        operator sees the ambiguity in the dry-run report.
 *   - SKIP + flag pages with any of:
 *       - Non-empty comments (queried via the Comments API)
 *       - `last_edited_by` is not the engine bot
 *       - Non-default Status (anything other than "Backlog" / "Not started")
 *     Manual resolution required for flagged pages.
 *
 * Flags:
 *   --dry-run (default) — print the report, archive nothing.
 *   --archive          — actually archive after operator review. Requires a
 *                        deliberate confirmation step:
 *                          • Interactive (TTY): y/N prompt.
 *                          • Non-interactive  : must also pass `--yes`.
 *   --yes              — non-interactive confirmation for `--archive`.
 *   --study-id X       — scope to a single study (for debugging).
 *
 * Pattern mirrors scripts/migrate-relative-offsets.js — raw fetch + single
 * token, standalone of NotionClient's complexity.
 *
 * Usage:
 *   node scripts/sweep-all-studies.js                 # dry-run on all active studies
 *   node scripts/sweep-all-studies.js --archive       # execute after review (TTY prompt)
 *   node scripts/sweep-all-studies.js --archive --yes # non-interactive (cron)
 *   node scripts/sweep-all-studies.js --study-id abc  # scope to one study
 *
 * Env:
 *   NOTION_TOKEN_1          — Notion integration token
 *   STUDIES_DB_ID           — Studies database ID
 *   STUDY_TASKS_DB_ID       — Study Tasks database ID
 *   ENGINE_BOT_USER_ID      — (optional) Bot user ID for last_edited_by check.
 *                             If unset, the flag-check treats ALL non-bot
 *                             edits as flags (more conservative).
 */

import 'dotenv/config';
import { createInterface } from 'node:readline';

const TOKEN = process.env.NOTION_TOKEN_1;
const STUDIES_DB_ID = process.env.STUDIES_DB_ID;
const STUDY_TASKS_DB_ID = process.env.STUDY_TASKS_DB_ID;
const ENGINE_BOT_USER_ID = process.env.ENGINE_BOT_USER_ID || null;

// Default status values that indicate the page has not been manually touched.
const DEFAULT_STATUS_VALUES = new Set(['Backlog', 'Not started', 'To-do', '']);

// Tie threshold — two created_time stamps within this window are considered
// ambiguous for canonical selection.
const TIE_THRESHOLD_MS = 100;

const args = process.argv.slice(2);
const DRY_RUN = !args.includes('--archive');
const YES_FLAG = args.includes('--yes');
const STUDY_ID_ARG = (() => {
  const idx = args.indexOf('--study-id');
  if (idx === -1) return null;
  return args[idx + 1] || null;
})();

async function notionRequest(method, path, body) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notion ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function queryAll(dbId, filter) {
  const results = [];
  let cursor;
  do {
    const body = { page_size: 100 };
    if (filter) body.filter = filter;
    if (cursor) body.start_cursor = cursor;
    const data = await notionRequest('POST', `/databases/${dbId}/query`, body);
    results.push(...data.results);
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return results;
}

export function extractTsid(page) {
  const rich = page.properties?.['Template Source ID']?.rich_text;
  if (!Array.isArray(rich) || rich.length === 0) return null;
  return rich[0].plain_text || rich[0].text?.content || null;
}

export function extractStatus(page) {
  // Status property — both "status" type and "select" type supported defensively.
  return (
    page.properties?.['Status']?.status?.name
    || page.properties?.['Status']?.select?.name
    || ''
  );
}

export function extractTaskName(page) {
  return (
    page.properties?.['Task Name']?.title?.[0]?.plain_text
    || page.properties?.['Task Name']?.title?.[0]?.text?.content
    || page.id
  );
}

function relationIsPopulated(page, propName) {
  const rel = page.properties?.[propName]?.relation;
  return Array.isArray(rel) && rel.length > 0;
}

export function hasParentRelation(page) {
  return relationIsPopulated(page, 'Parent Task');
}

/**
 * A page is `wired` if ANY of Parent Task / Blocked by / Blocking is populated.
 * The group-level distinction between `root-unwired` and `true-unwired` is
 * made by pickCanonical() based on whether the group is homogeneous or mixed.
 */
export function classifyPage(page) {
  const wired = relationIsPopulated(page, 'Parent Task')
    || relationIsPopulated(page, 'Blocked by')
    || relationIsPopulated(page, 'Blocking');
  return wired ? 'wired' : 'unwired';
}

async function pageHasComments(pageId) {
  try {
    const data = await notionRequest('GET', `/comments?block_id=${pageId}&page_size=1`);
    return (data.results || []).length > 0;
  } catch (err) {
    // Permission / 404 / auth — treat as "possibly has comments" (conservative; flag)
    console.warn(`  [warn] comments check failed for ${pageId}: ${err.message}`);
    return true;
  }
}

function computeFlags(page, hasCommentsFlag) {
  const flags = [];
  const lastEditedByType = page.last_edited_by?.type;
  const lastEditedById = page.last_edited_by?.id;
  if (hasCommentsFlag) flags.push('has_comments');
  if (lastEditedByType && lastEditedByType !== 'bot') flags.push('last_edited_by_human');
  if (ENGINE_BOT_USER_ID && lastEditedById && lastEditedById !== ENGINE_BOT_USER_ID) {
    flags.push('last_edited_by_other_bot');
  }
  const status = extractStatus(page);
  if (!DEFAULT_STATUS_VALUES.has(status)) flags.push(`status:${status}`);
  return flags;
}

/**
 * Pick the canonical page from a group of duplicates using the tri-state rule.
 * Returns { canonical, duplicates, groupState, tieWarnings }.
 *
 *   - groupState: 'mixed' (wired picked), 'all-wired', 'root-unwired'.
 *   - tieWarnings: Set of page IDs whose created_time falls within TIE_THRESHOLD_MS
 *                  of the canonical's created_time (ambiguous keep).
 *
 * NOTE: Without blueprint introspection, `root-unwired` and `true-unwired` are
 * indistinguishable at a single-group level — both have "all unwired". We treat
 * any "all unwired" group as root-unwired-by-consistency (consistent empty
 * state across the group implies a root-level TSID). `true-unwired` is
 * surfaced only when some duplicates are wired and others are not, indicating
 * partial wiring failure — in that case wired survivors win and the orphans
 * get archived (state: 'mixed').
 */
export function pickCanonical(pages) {
  if (!Array.isArray(pages) || pages.length === 0) {
    return { canonical: null, duplicates: [], groupState: 'empty', tieWarnings: new Set() };
  }

  const wired = pages.filter((p) => classifyPage(p) === 'wired');
  const unwired = pages.filter((p) => classifyPage(p) === 'unwired');

  let pool;
  let groupState;
  if (wired.length > 0 && unwired.length > 0) {
    // Rule 1: mixed — keep wired, archive orphans (true-unwired).
    pool = wired;
    groupState = 'mixed';
  } else if (wired.length > 0) {
    // All wired — tie-break by created_time.
    pool = wired;
    groupState = 'all-wired';
  } else {
    // All unwired. Without blueprint introspection, treat as root-unwired.
    pool = unwired;
    groupState = 'root-unwired';
  }

  // Earliest created_time wins within the pool.
  const canonical = pool.reduce((earliest, p) => {
    if (!earliest) return p;
    return new Date(p.created_time) < new Date(earliest.created_time) ? p : earliest;
  }, null);

  const canonicalMs = canonical ? new Date(canonical.created_time).getTime() : 0;
  const tieWarnings = new Set();
  // A tie exists when another page in the pool has a created_time within
  // TIE_THRESHOLD_MS of the canonical (ambiguous earliest). Applies only when
  // the pool has >1 member and we actually resolved by time (not mixed).
  if (pool.length > 1 && (groupState === 'all-wired' || groupState === 'root-unwired')) {
    for (const p of pool) {
      if (p.id === canonical.id) continue;
      const deltaMs = Math.abs(new Date(p.created_time).getTime() - canonicalMs);
      if (deltaMs < TIE_THRESHOLD_MS) {
        tieWarnings.add(p.id);
      }
    }
  }

  const duplicates = pages.filter((p) => p.id !== canonical.id);
  return { canonical, duplicates, groupState, tieWarnings };
}

async function processStudy(studyId, studyName, opts = {}) {
  console.log(`\n--- Study: ${studyName || '(unnamed)'} (${studyId}) ---`);
  const tasks = await queryAll(STUDY_TASKS_DB_ID, {
    property: 'Study',
    relation: { contains: studyId },
  });
  console.log(`  Tasks: ${tasks.length}`);

  const byTsid = new Map();
  for (const t of tasks) {
    const tsid = extractTsid(t);
    if (!tsid) continue;
    let bucket = byTsid.get(tsid);
    if (!bucket) {
      bucket = [];
      byTsid.set(tsid, bucket);
    }
    bucket.push(t);
  }

  const reportEntries = [];
  for (const [tsid, pagesForTsid] of byTsid) {
    if (pagesForTsid.length <= 1) continue;
    const { canonical, duplicates, groupState, tieWarnings } = pickCanonical(pagesForTsid);

    const duplicateDetails = [];
    for (const dup of duplicates) {
      const hasCommentsFlag = await pageHasComments(dup.id);
      const flags = computeFlags(dup, hasCommentsFlag);
      const tieWarning = tieWarnings.has(dup.id);
      duplicateDetails.push({
        pageId: dup.id,
        taskName: extractTaskName(dup),
        flags,
        archiveCandidate: flags.length === 0,
        tie_warning: tieWarning,
      });
    }

    reportEntries.push({
      studyId,
      studyName,
      tsid,
      canonicalId: canonical.id,
      canonicalName: extractTaskName(canonical),
      groupState,
      duplicates: duplicateDetails,
    });
  }

  return reportEntries;
}

async function fetchActiveStudies() {
  // "Active" definition — has any tasks OR status is not in archived state.
  // Conservative: return ALL studies in the DB, let processStudy skip empties.
  // An explicit filter can be added when the Studies DB schema solidifies.
  return queryAll(STUDIES_DB_ID);
}

/**
 * Prompt the user for y/N confirmation on a TTY. Resolves to true on y/yes.
 */
export function promptConfirmation(message, { input = process.stdin, output = process.stdout } = {}) {
  return new Promise((resolve) => {
    const rl = createInterface({ input, output });
    rl.question(message, (answer) => {
      rl.close();
      const normalized = (answer || '').trim().toLowerCase();
      resolve(normalized === 'y' || normalized === 'yes');
    });
  });
}

/**
 * Gate `--archive` execution behind a confirmation. Returns { proceed, reason }.
 *
 *   - Interactive (TTY): y/N prompt via readline.
 *   - Non-interactive : must pass --yes; otherwise abort with a clear error.
 */
export async function confirmArchive({
  totalCandidates,
  studiesWithDuplicates,
  isTty,
  yesFlag,
  promptFn = promptConfirmation,
  logFn = console.log,
  errorFn = console.error,
}) {
  const summary = `Ready to archive ${totalCandidates} duplicate pages across ${studiesWithDuplicates} studies. This operation is destructive. Continue? [y/N] `;

  if (!isTty) {
    if (!yesFlag) {
      errorFn('ERROR: --archive requires --yes for non-interactive use');
      return { proceed: false, reason: 'non_tty_missing_yes' };
    }
    logFn(`[confirm] --yes flag present, non-interactive approval granted (${totalCandidates} archives queued).`);
    return { proceed: true, reason: 'non_tty_yes_flag' };
  }

  // TTY path — interactive prompt.
  logFn(`\n${summary.trim()}`);
  const answer = await promptFn(summary);
  if (!answer) {
    logFn(`[confirm] operator declined — aborting without archive. (0 of ${totalCandidates} archives performed.)`);
    return { proceed: false, reason: 'tty_declined' };
  }
  logFn(`[confirm] operator approved — proceeding with ${totalCandidates} archives.`);
  return { proceed: true, reason: 'tty_approved' };
}

async function main() {
  console.log(`\n=== Workspace Duplicate Sweep ===`);
  console.log(`Mode: ${DRY_RUN ? 'DRY-RUN' : 'ARCHIVE'}`);
  console.log(`Scope: ${STUDY_ID_ARG ? `study=${STUDY_ID_ARG}` : 'all active studies'}`);
  console.log(`Engine bot user ID check: ${ENGINE_BOT_USER_ID ? 'enabled' : 'disabled (all non-bot edits flagged)'}`);

  let studies;
  if (STUDY_ID_ARG) {
    const page = await notionRequest('GET', `/pages/${STUDY_ID_ARG}`);
    studies = [page];
  } else {
    studies = await fetchActiveStudies();
    console.log(`Studies fetched: ${studies.length}`);
  }

  const fullReport = [];
  for (const study of studies) {
    const studyName = study.properties?.['Study Name (Internal)']?.title?.[0]?.plain_text
      || study.properties?.['Name']?.title?.[0]?.plain_text
      || null;
    try {
      const entries = await processStudy(study.id, studyName);
      fullReport.push(...entries);
    } catch (err) {
      console.error(`  [error] study ${study.id}: ${err.message}`);
    }
  }

  // Report
  console.log(`\n=== REPORT ===`);
  if (fullReport.length === 0) {
    console.log('No duplicates found. Workspace is clean.');
    return;
  }

  console.log(`Studies with duplicates: ${new Set(fullReport.map((e) => e.studyId)).size}`);
  console.log(`Total duplicate TSIDs: ${fullReport.length}`);
  const totalDuplicatePages = fullReport.reduce((s, e) => s + e.duplicates.length, 0);
  const totalCandidates = fullReport.reduce(
    (s, e) => s + e.duplicates.filter((d) => d.archiveCandidate).length,
    0,
  );
  const totalFlagged = totalDuplicatePages - totalCandidates;
  console.log(`Total duplicate pages: ${totalDuplicatePages}`);
  console.log(`  Archive candidates (no flags): ${totalCandidates}`);
  console.log(`  Flagged (manual resolution): ${totalFlagged}`);

  const studiesWithDuplicates = new Set(fullReport.map((e) => e.studyId)).size;

  for (const entry of fullReport) {
    console.log(`\n  [${entry.studyName || entry.studyId}] TSID ${entry.tsid} (state=${entry.groupState})`);
    console.log(`    Canonical: ${entry.canonicalName} (${entry.canonicalId})`);
    for (const d of entry.duplicates) {
      const prefix = d.archiveCandidate ? '    [archive]' : '    [FLAGGED]';
      const tie = d.tie_warning ? ' ⚠ TIE' : '';
      console.log(`${prefix} ${d.taskName} (${d.pageId})${d.flags.length > 0 ? ` flags=[${d.flags.join(', ')}]` : ''}${tie}`);
    }
  }

  // JSON report — easy to pipe to jq / import into a doc
  console.log(`\n=== JSON ===`);
  console.log(JSON.stringify(fullReport, null, 2));

  if (DRY_RUN) {
    console.log(`\n[dry-run] No archives performed. Re-run with --archive to execute.`);
    return;
  }

  // --archive mode: gate behind confirmation (TTY prompt or --yes).
  const isTty = Boolean(process.stdin.isTTY);
  const decision = await confirmArchive({
    totalCandidates,
    studiesWithDuplicates,
    isTty,
    yesFlag: YES_FLAG,
  });
  if (!decision.proceed) {
    process.exitCode = 1;
    return;
  }

  // --archive mode: archive candidates only. Flagged pages are NEVER archived
  // — they require manual resolution.
  console.log(`\n=== ARCHIVING (${totalCandidates} pages) ===`);
  let archived = 0;
  let failed = 0;
  const BATCH_INTERVAL_MS = 400; // ~2.5 req/s — under 3 req/s limit
  for (const entry of fullReport) {
    for (const d of entry.duplicates) {
      if (!d.archiveCandidate) continue;
      try {
        await notionRequest('PATCH', `/pages/${d.pageId}`, { archived: true });
        archived++;
        console.log(`  ✓ archived ${d.taskName} (${d.pageId})`);
      } catch (err) {
        failed++;
        console.error(`  ✗ failed to archive ${d.pageId}: ${err.message}`);
      }
      await new Promise((r) => setTimeout(r, BATCH_INTERVAL_MS));
    }
  }

  console.log(`\n=== DONE ===`);
  console.log(`Archived: ${archived}`);
  console.log(`Failed: ${failed}`);
  console.log(`Flagged (skipped): ${totalFlagged}`);
  if (totalFlagged > 0) {
    console.log(`\nFlagged duplicates require manual resolution. See JSON report above.`);
  }
}

// Only run main() when invoked as a script — importing this module (for tests)
// should not execute it or require env vars.
const invokedAsScript = (() => {
  try {
    const entry = process.argv[1] || '';
    return entry.endsWith('sweep-all-studies.js');
  } catch {
    return false;
  }
})();

if (invokedAsScript) {
  if (!TOKEN) {
    console.error('Missing NOTION_TOKEN_1 env var');
    process.exit(1);
  }
  if (!STUDIES_DB_ID || !STUDY_TASKS_DB_ID) {
    console.error('Missing STUDIES_DB_ID or STUDY_TASKS_DB_ID env var');
    process.exit(1);
  }
  main().catch((err) => {
    console.error('Sweep failed:', err);
    process.exit(1);
  });
}
