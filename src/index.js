import { config } from './config.js';
import { createServer } from './server.js';

const app = createServer();

app.listen(config.port, () => {
  console.log(`Cascade engine listening on port ${config.port}`);
  console.log(`Environment: ${config.nodeEnv}`);
  console.log(`Notion tokens: ${config.notion.tokens.length}`);
  console.log(`Endpoints:`);
  console.log(`  POST /webhook/date-cascade`);
  console.log(`  POST /webhook/status-rollup`);
  console.log(`  GET  /health`);
});
