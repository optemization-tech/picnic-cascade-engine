import express from 'express';
import { handleDateCascade } from './routes/date-cascade.js';
import { handleStatusRollup } from './routes/status-rollup.js';
import { handleInception } from './routes/inception.js';
import { handleAddTaskSet } from './routes/add-task-set.js';
import { handleCopyBlocks } from './routes/copy-blocks.js';
import { handleDeletion } from './routes/deletion.js';

export function createServer() {
  const app = express();

  // Parse JSON webhooks from Notion
  app.use(express.json({ limit: '1mb' }));

  // Request logging
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      console.log(`${new Date().toISOString()} ${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
    });
    next();
  });

  // Health check
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Cascade webhook endpoints (use cascade token pool)
  app.post('/webhook/date-cascade', handleDateCascade);
  app.post('/webhook/status-rollup', handleStatusRollup);

  // Provisioning webhook endpoints (use provision token pool)
  app.post('/webhook/inception', handleInception);
  app.post('/webhook/add-task-set', handleAddTaskSet);
  app.post('/webhook/copy-blocks', handleCopyBlocks);

  // Deletion webhook endpoint (use deletion token pool)
  app.post('/webhook/deletion', handleDeletion);

  return app;
}
