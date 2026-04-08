import { config } from '../config.js';
import { provisionClient as notionClient } from '../notion/clients.js';
import { copyBlocks } from '../provisioning/copy-blocks.js';
import { ActivityLogService } from '../services/activity-log.js';
import { CascadeTracer } from '../services/cascade-tracer.js';
const activityLogService = new ActivityLogService({
  notionClient,
  activityLogDbId: config.notion.activityLogDbId,
});

async function processCopyBlocks(body) {
  const { idMapping, studyPageId, studyName } = body || {};

  if (!idMapping || typeof idMapping !== 'object' || Object.keys(idMapping).length === 0) {
    console.warn('[copy-blocks] missing or empty idMapping in payload, skipping');
    return;
  }

  const tracer = new CascadeTracer();
  tracer.set('workflow', 'Copy Blocks');
  tracer.set('study_id', studyPageId);
  tracer.set('study_name', studyName);
  tracer.set('mapping_count', Object.keys(idMapping).length);

  try {
    if (studyPageId) {
      await notionClient.reportStatus(studyPageId, 'info', 'Copying content blocks...', { tracer });
    }

    tracer.startPhase('copyBlocks');
    const result = await copyBlocks(notionClient, idMapping, {
      studyPageId,
      studyName,
      tracer,
    });
    tracer.endPhase('copyBlocks');

    tracer.set('blocks_written', result.blocksWrittenCount);
    tracer.set('pages_processed', result.pagesProcessed);
    tracer.set('pages_skipped', result.pagesSkipped);
    console.log(tracer.toConsoleLog());

    await activityLogService.logTerminalEvent({
      workflow: 'Copy Blocks',
      status: 'success',
      triggerType: 'Automation',
      executionId: tracer.cascadeId,
      timestamp: new Date().toISOString(),
      cascadeMode: 'N/A',
      studyId: studyPageId || null,
      summary: `Copy blocks complete: ${result.pagesProcessed} pages processed, ${result.blocksWrittenCount} blocks written, ${result.pagesSkipped} skipped`,
      details: {
        blocksWrittenCount: result.blocksWrittenCount,
        pagesProcessed: result.pagesProcessed,
        pagesSkipped: result.pagesSkipped,
        ...(tracer.toActivityLogDetails()),
      },
    });

    if (studyPageId) {
      await notionClient.reportStatus(
        studyPageId,
        'success',
        `Content blocks copied: ${result.pagesProcessed} pages, ${result.blocksWrittenCount} blocks`,
        { tracer },
      );
    }
  } catch (error) {
    console.error('[copy-blocks] processing failed:', error);
    console.log(tracer.toConsoleLog());

    try {
      if (studyPageId) {
        await notionClient.reportStatus(
          studyPageId,
          'error',
          `Copy blocks failed: ${String(error.message || error).slice(0, 200)}`,
          { tracer },
        );
      }
    } catch { /* don't mask original error */ }

    try {
      await activityLogService.logTerminalEvent({
        workflow: 'Copy Blocks',
        status: 'failed',
        triggerType: 'Automation',
        executionId: tracer.cascadeId,
        timestamp: new Date().toISOString(),
        cascadeMode: 'N/A',
        studyId: studyPageId || null,
        summary: `Copy blocks failed: ${String(error.message || error).slice(0, 180)}`,
        details: {
          error: {
            errorCode: error.code || null,
            errorMessage: String(error.message || error).slice(0, 400),
            phase: 'copy-blocks',
          },
          ...(tracer.toActivityLogDetails()),
        },
      });
    } catch { /* don't mask original error */ }
  }
}

export async function handleCopyBlocks(req, res) {
  res.status(200).json({ ok: true });
  void processCopyBlocks(req.body).catch(err => console.error('[copy-blocks] unhandled:', err));
}
