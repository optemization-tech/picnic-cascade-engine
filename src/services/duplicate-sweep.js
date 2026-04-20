import { config } from '../config.js';

/**
 * Post-flight duplicate sweep.
 *
 * After a provisioning run (inception or add-task-set), a silent duplicate can
 * exist in the study if Notion's internal retries or an ambiguous error
 * classification re-sent a create-page call that actually succeeded the first
 * time. This sweep is the safety net:
 *
 *   1. Wait `config.sweepGraceMs` (default 45s) for Notion's query index to
 *      catch up with recent writes — the consistency experiment (2026-04-16)
 *      observed a max visibility lag of 15.4s.
 *   2. Query all tasks in the study via a single `Study contains X` filter.
 *   3. Group tasks by `Template Source ID` (rich_text property).
 *   4. For each TSID this run created, archive any extras whose page IDs are
 *      not in the engine's own `trackedIds` (derived from createStudyTasks'
 *      idMapping return).
 *
 * Runs under `withStudyLock` coverage (extended by PR E0), so no other
 * add-task-set / inception on the same study can race this sweep. Different
 * studies run in parallel unchanged.
 *
 * Sweep failure is non-fatal — the run's creates already succeeded; cleanup is
 * best-effort. Errors are recorded on the tracer (via recordSweepQueryFailed /
 * recordSweepArchiveFailed) and never thrown to the caller.
 *
 * See `docs/ENGINE-BEHAVIOR-REFERENCE.md` §11 Duplicate Prevention for the
 * three-layer architecture (PR E0 shared lock + PR E1 path-based narrow retry
 * + PR E2 sweep + weekly cadence).
 */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractTsid(page) {
  const rich = page.properties?.['Template Source ID']?.rich_text;
  if (!Array.isArray(rich) || rich.length === 0) return null;
  return rich[0].plain_text || rich[0].text?.content || null;
}

/**
 * @param {object} args
 * @param {string} args.studyPageId - The study page ID (relation filter target).
 * @param {Set<string>} args.trackedIds - Page IDs the engine just created (canonical).
 * @param {Array<string>} args.tsids - Template Source IDs this run covered.
 * @param {object} args.tracer - CascadeTracer instance.
 * @param {object} args.notionClient - NotionClient instance (injected for testability).
 * @param {string} args.studyTasksDbId - The Study Tasks database ID.
 * @param {number} [args.graceMs] - Override for the grace delay; defaults to config.sweepGraceMs.
 *   Tests pass 0 to skip the wait.
 */
export async function run({
  studyPageId,
  trackedIds,
  tsids,
  tracer,
  notionClient,
  studyTasksDbId,
  graceMs,
}) {
  if (!Array.isArray(tsids) || tsids.length === 0) {
    // Nothing this run created — nothing to sweep. Common on guarded early returns
    // (empty blueprint, double-inception, etc.), though callers shouldn't reach
    // this path in those cases.
    return;
  }

  const delay = typeof graceMs === 'number' ? graceMs : config.sweepGraceMs;

  try {
    if (tracer) tracer.startPhase('sweepGrace');
    if (delay > 0) await sleep(delay);
    if (tracer) tracer.endPhase('sweepGrace');

    if (tracer) tracer.startPhase('sweepQuery');
    let allStudyTasks;
    try {
      allStudyTasks = await notionClient.queryDatabase(
        studyTasksDbId,
        { property: 'Study', relation: { contains: studyPageId } },
        100,
        { tracer },
      );
    } finally {
      if (tracer) tracer.endPhase('sweepQuery');
    }

    // Group by TSID
    const byTsid = new Map();
    for (const page of allStudyTasks) {
      const tsid = extractTsid(page);
      if (!tsid) continue;
      let bucket = byTsid.get(tsid);
      if (!bucket) {
        bucket = [];
        byTsid.set(tsid, bucket);
      }
      bucket.push(page);
    }

    const tsidSet = new Set(tsids);
    const trackedSet = trackedIds instanceof Set ? trackedIds : new Set(trackedIds || []);

    if (tracer) tracer.startPhase('sweepArchive');
    try {
      for (const [tsid, tasks] of byTsid) {
        if (!tsidSet.has(tsid)) continue; // Not this run's TSID; skip (weekly sweep handles stragglers)
        if (tasks.length <= 1) continue; // No duplicates for this TSID

        for (const task of tasks) {
          if (trackedSet.has(task.id)) continue; // Canonical — keep
          try {
            await notionClient.archivePage(task.id, { tracer });
            if (tracer) {
              tracer.recordSweepArchived({ tsid, pageId: task.id });
            }
            console.log(JSON.stringify({
              event: 'sweep_archived',
              studyPageId,
              tsid,
              pageId: task.id,
            }));
          } catch (err) {
            if (tracer) {
              tracer.recordSweepArchiveFailed({ tsid, pageId: task.id, error: err });
            }
            console.warn(JSON.stringify({
              event: 'sweep_archive_failed',
              studyPageId,
              tsid,
              pageId: task.id,
              error: String(err?.message || err).slice(0, 200),
            }));
          }
        }
      }
    } finally {
      if (tracer) tracer.endPhase('sweepArchive');
    }
  } catch (err) {
    // Top-level failure (typically the query). Swallow — sweep is best-effort.
    if (tracer) tracer.recordSweepQueryFailed(err);
    console.warn(JSON.stringify({
      event: 'sweep_query_failed',
      studyPageId,
      error: String(err?.message || err).slice(0, 200),
    }));
  }
}
