import { config } from './config.js';
import { createServer } from './server.js';
import { cascadeQueue } from './services/cascade-queue.js';

const app = createServer();

const server = app.listen(config.port, () => {
  console.log(`Cascade engine listening on port ${config.port}`);
  console.log(`Environment: ${config.nodeEnv}`);
  console.log(`Auth: ${process.env.WEBHOOK_SECRET ? 'enabled' : 'disabled (no WEBHOOK_SECRET)'}`);
  console.log(`Token pools: cascade=${config.notion.tokens.length}, provision=${config.notion.provisionTokens.length}, deletion=${config.notion.deletionTokens.length}`);
  console.log(`Endpoints:`);
  console.log(`  POST /webhook/date-cascade`);
  console.log(`  POST /webhook/status-rollup`);
  console.log(`  POST /webhook/inception`);
  console.log(`  POST /webhook/add-task-set`);
  console.log(`  POST /webhook/copy-blocks`);
  console.log(`  POST /webhook/deletion`);
  console.log(`  POST /webhook/undo-cascade`);
  console.log(`  GET  /health`);
});

// Graceful shutdown — drain in-flight cascade before exit
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, draining in-flight work...');
  server.close();
  try {
    await cascadeQueue.drain();
    console.log('Drain complete, exiting.');
  } catch (err) {
    console.error('Drain failed:', err);
  }
  process.exit(0);
});
