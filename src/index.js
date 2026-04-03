import { config } from './config.js';
import { createServer } from './server.js';

const app = createServer();

app.listen(config.port, () => {
  console.log(`Cascade engine listening on port ${config.port}`);
  console.log(`Environment: ${config.nodeEnv}`);
  console.log(`Token pools: cascade=${config.notion.tokens.length}, provision=${config.notion.provisionTokens.length}, deletion=${config.notion.deletionTokens.length}`);
  console.log(`Endpoints:`);
  console.log(`  POST /webhook/date-cascade`);
  console.log(`  POST /webhook/status-rollup`);
  console.log(`  POST /webhook/inception`);
  console.log(`  POST /webhook/add-task-set`);
  console.log(`  POST /webhook/copy-blocks`);
  console.log(`  POST /webhook/deletion`);
  console.log(`  GET  /health`);
});
