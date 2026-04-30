import { provisionClient as notionClient, commentClient } from '../notion/clients.js';
import { MIGRATED_STUDIES_PROP } from '../migration/constants.js';
import { relationIds } from '../migration/extract.js';
import { StudyCommentService } from '../services/study-comment.js';
import { CascadeTracer } from '../services/cascade-tracer.js';
import { flightTracker } from '../services/flight-tracker.js';
import { withStudyLock } from '../services/study-lock.js';
import { runMigrateStudyPipeline } from '../migration/migrate-study-service.js';

const studyCommentService = new StudyCommentService({ notionClient: commentClient });

/**
 * Match Inception / add-task-set: `withStudyLock` keys the Production Study page id.
 * Prefetch the Exported Studies row once so we serialize migrate vs inception on the same study.
 * Falls back to the exported row id when relation is not exactly 1 or prefetch fails.
 */
export async function resolveMigrateStudyLockId(notion, exportedStudyPageId) {
  try {
    const page = await notion.getPage(exportedStudyPageId);
    const prodIds = relationIds(page.properties, MIGRATED_STUDIES_PROP.PRODUCTION_STUDY);
    if (prodIds.length === 1) return prodIds[0];
  } catch (err) {
    console.warn('[migrate-study] lock-key prefetch failed; falling back to exported row id:', err.message);
  }
  return exportedStudyPageId;
}

async function processMigrateStudy(body) {
  const exportedStudyPageId = body?.data?.id || body?.exportedStudyPageId || body?.studyPageId;
  if (!exportedStudyPageId) {
    console.warn('[migrate-study] no exportedStudyPageId in payload, skipping');
    return;
  }
  const triggeredByUserId = body?.source?.user_id || body?.data?.last_edited_by?.id || null;
  const editedByBot = !body?.source?.user_id && body?.data?.last_edited_by?.type === 'bot';

  const tracer = new CascadeTracer();
  tracer.set('workflow', 'Migrate Study');
  tracer.set('exported_study_id', exportedStudyPageId);

  try {
    await runMigrateStudyPipeline(body, notionClient, {
      tracer,
      studyCommentService,
      triggeredByUserId,
      editedByBot,
      studyNameFallback: null,
    });
  } finally {
    // Emit on both success and failure so post-mortem debugging has the same
    // diagnostic surface either way. CascadeTracer.toConsoleLog returns
    // JSON.stringify of a fixed plain-object shape with no circular refs,
    // so it cannot throw under the current tracer contract.
    console.log(tracer.toConsoleLog());
  }
}

export async function handleMigrateStudy(req, res) {
  res.status(200).json({ ok: true });
  const exportedStudyPageId = req.body?.data?.id || req.body?.exportedStudyPageId || req.body?.studyPageId;
  if (!exportedStudyPageId) {
    console.warn('[migrate-study] missing exportedStudyPageId on webhook; running unlocked');
  }
  const run = exportedStudyPageId
    ? resolveMigrateStudyLockId(notionClient, exportedStudyPageId).then((lockId) =>
        withStudyLock(lockId, () => processMigrateStudy(req.body)),
      )
    : processMigrateStudy(req.body);
  flightTracker.track(
    run.catch((err) => console.error('[migrate-study] unhandled:', err)),
    'migrate-study',
  );
}
