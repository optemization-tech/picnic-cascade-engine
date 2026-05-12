import { config } from './config.js';
import { createServer } from './server.js';
import { cascadeQueue } from './services/cascade-queue.js';
import { flightTracker } from './services/flight-tracker.js';
import { NotionClient } from './notion/client.js';
import { sweepStuckImportMode } from './startup/import-mode-sweep.js';
import { registerBotIds } from './startup/register-bot-ids.js';

const app = createServer();

const server = app.listen(config.port, () => {
  console.log(`Cascade engine listening on port ${config.port}`);
  console.log(`Environment: ${config.nodeEnv}`);
  console.log(`Auth: ${process.env.WEBHOOK_SECRET ? 'enabled' : 'disabled (no WEBHOOK_SECRET)'}`);
  console.log(`Token pools: cascade=${config.notion.tokens.length}, provision=${config.notion.provisionTokens.length}, deletion=${config.notion.deletionTokens.length}, comment=${config.notion.commentTokens.length}${config.notion.commentTokens.length === 0 ? ' (fallback to cascade)' : ''}`);
  console.log(`Endpoints:`);
  console.log(`  POST /webhook/date-cascade`);
  console.log(`  POST /webhook/status-rollup`);
  console.log(`  POST /webhook/inception`);
  console.log(`  POST /webhook/add-task-set`);
  console.log(`  POST /webhook/copy-blocks`);
  console.log(`  POST /webhook/deletion`);
  console.log(`  POST /webhook/undo-cascade`);
  console.log(`  GET  /health`);

  // Startup boot sequence — runs async, server accepts webhooks immediately.
  (async () => {
    // Resolve bot user IDs for all token pools so classifyWebhookActor can
    // fall back to the KNOWN_BOT_IDS allowlist when source.type is absent.
    // Pass mentionUserIds so any permanent registration failure surfaces an
    // alert payload that log-aggregators can render @-mentions from.
    await registerBotIds(
      [...new Set([
        ...config.notion.tokens,
        ...config.notion.provisionTokens,
        ...config.notion.deletionTokens,
        ...config.notion.commentTokens,
      ])],
      { mentionUserIds: config.comment.errorMentionIds },
    );

    // Clear stuck Import Mode from studies left ON by prior crashes/OOM/SIGKILL.
    const sweepTokens = config.notion.provisionTokens.length > 0
      ? config.notion.provisionTokens
      : config.notion.tokens;
    const sweepClient = new NotionClient({ tokens: sweepTokens });
    await sweepStuckImportMode(sweepClient, config.notion.studiesDbId);
  })().catch((err) => console.error(JSON.stringify({ event: 'boot_sequence_error', error: err.message })));
});

// Graceful shutdown — drain in-flight cascade before exit
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received, draining in-flight work...`);
  server.close();
  try {
    await Promise.all([cascadeQueue.drain(), flightTracker.drain(8000)]);
    console.log('[shutdown] Drain complete, exiting.');
  } catch (err) {
    console.error('[shutdown] Drain failed:', err);
  }
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
