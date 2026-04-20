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
 *   - Prefer pages that are fully wired (Parent Task / Blocked by / Blocking
 *     relations populated). "Fully wired" is implementation-approximate —
 *     we use "has Parent Task relation OR is root-level by template" as a
 *     proxy. See NOTE below.
 *   - Fall back to earliest `created_time`.
 *   - SKIP + flag pages with any of:
 *       - Non-empty comments (queried via the Comments API)
 *       - `last_edited_by` is not the engine bot
 *       - Non-default Status (anything other than "Backlog" / "Not started")
 *     Manual resolution required for flagged pages.
 *
 * Flags:
 *   --dry-run (default) — print the report, archive nothing.
 *   --archive          — actually archive after operator review.
 *   --study-id X       — scope to a single study (for debugging).
 *
 * Pattern mirrors scripts/migrate-relative-offsets.js — raw fetch + single
 * token, standalone of NotionClient's complexity.
 *
 * Usage:
 *   node scripts/sweep-all-studies.js                 # dry-run on all active studies
 *   node scripts/sweep-all-studies.js --archive       # execute after review
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

const TOKEN = process.env.NOTION_TOKEN_1;
const STUDIES_DB_ID = process.env.STUDIES_DB_ID;
const STUDY_TASKS_DB_ID = process.env.STUDY_TASKS_DB_ID;
const ENGINE_BOT_USER_ID = process.env.ENGINE_BOT_USER_ID || null;

// Default status values that indicate the page has not been manually touched.
const DEFAULT_STATUS_VALUES = new Set(['Backlog', 'Not started', 'To-do', '']);

if (!TOKEN) {
  console.error('Missing NOTION_TOKEN_1 env var');
  process.exit(1);
}
if (!STUDIES_DB_ID || !STUDY_TASKS_DB_ID) {
  console.error('Missing STUDIES_DB_ID or STUDY_TASKS_DB_ID env var');
  process.exit(1);
}

const args = process.argv.slice(2);
const DRY_RUN = !args.includes('--archive');
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

function extractTsid(page) {
  const rich = page.properties?.['Template Source ID']?.rich_text;
  if (!Array.isArray(rich) || rich.length === 0) return null;
  return rich[0].plain_text || rich[0].text?.content || null;
}

function extractStatus(page) {
  // Status property — both "status" type and "select" type supported defensively.
  return (
    page.properties?.['Status']?.status?.name
    || page.properties?.['Status']?.select?.name
    || ''
  );
}

function extractTaskName(page) {
  return (
    page.properties?.['Task Name']?.title?.[0]?.plain_text
    || page.properties?.['Task Name']?.title?.[0]?.text?.content
    || page.id
  );
}

function hasParentRelation(page) {
  const rel = page.properties?.['Parent Task']?.relation;
  return Array.isArray(rel) && rel.length > 0;
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

function pickCanonical(pages) {
  // Prefer a page with a Parent Task relation (fully wired).
  const wired = pages.filter(hasParentRelation);
  const pool = wired.length > 0 ? wired : pages;
  // Within pool, earliest created_time wins.
  return pool.reduce((earliest, p) => {
    if (!earliest) return p;
    return new Date(p.created_time) < new Date(earliest.created_time) ? p : earliest;
  }, null);
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
    const canonical = pickCanonical(pagesForTsid);
    const duplicates = pagesForTsid.filter((p) => p.id !== canonical.id);

    const duplicateDetails = [];
    for (const dup of duplicates) {
      const hasCommentsFlag = await pageHasComments(dup.id);
      const flags = computeFlags(dup, hasCommentsFlag);
      duplicateDetails.push({
        pageId: dup.id,
        taskName: extractTaskName(dup),
        flags,
        archiveCandidate: flags.length === 0,
      });
    }

    reportEntries.push({
      studyId,
      studyName,
      tsid,
      canonicalId: canonical.id,
      canonicalName: extractTaskName(canonical),
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

  for (const entry of fullReport) {
    console.log(`\n  [${entry.studyName || entry.studyId}] TSID ${entry.tsid}`);
    console.log(`    Canonical: ${entry.canonicalName} (${entry.canonicalId})`);
    for (const d of entry.duplicates) {
      const prefix = d.archiveCandidate ? '    [archive]' : '    [FLAGGED]';
      console.log(`${prefix} ${d.taskName} (${d.pageId})${d.flags.length > 0 ? ` flags=[${d.flags.join(', ')}]` : ''}`);
    }
  }

  // JSON report — easy to pipe to jq / import into a doc
  console.log(`\n=== JSON ===`);
  console.log(JSON.stringify(fullReport, null, 2));

  if (DRY_RUN) {
    console.log(`\n[dry-run] No archives performed. Re-run with --archive to execute.`);
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

main().catch((err) => {
  console.error('Sweep failed:', err);
  process.exit(1);
});
