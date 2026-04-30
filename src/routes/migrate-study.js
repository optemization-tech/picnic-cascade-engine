import { provisionClient as notionClient, commentClient } from '../notion/clients.js';
import { StudyCommentService } from '../services/study-comment.js';
import { CascadeTracer } from '../services/cascade-tracer.js';
import { flightTracker } from '../services/flight-tracker.js';
import { withStudyLock } from '../services/study-lock.js';
import { runMigrateStudyPipeline } from '../migration/migrate-study-service.js';

const studyCommentService = new StudyCommentService({ notionClient: commentClient });

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

  await runMigrateStudyPipeline(body, notionClient, {
    tracer,
    studyCommentService,
    triggeredByUserId,
    editedByBot,
    studyNameFallback: null,
  });

  console.log(tracer.toConsoleLog());
}

export async function handleMigrateStudy(req, res) {
  res.status(200).json({ ok: true });
  const exportedStudyPageId = req.body?.data?.id || req.body?.exportedStudyPageId || req.body?.studyPageId;
  if (!exportedStudyPageId) {
    console.warn('[migrate-study] missing exportedStudyPageId on webhook; running unlocked');
  }
  // Lock by the Exported Studies row id (the actual unique trigger). The
  // pipeline still resolves Production Study from there for reporting +
  // Import Mode toggle.
  const run = exportedStudyPageId
    ? withStudyLock(exportedStudyPageId, () => processMigrateStudy(req.body))
    : processMigrateStudy(req.body);
  flightTracker.track(
    run.catch((err) => console.error('[migrate-study] unhandled:', err)),
    'migrate-study',
  );
}
