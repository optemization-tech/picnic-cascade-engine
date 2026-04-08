import express from 'express';
import { handleDateCascade } from './routes/date-cascade.js';
import { handleStatusRollup } from './routes/status-rollup.js';
import { handleInception } from './routes/inception.js';
import { handleAddTaskSet } from './routes/add-task-set.js';
import { handleCopyBlocks } from './routes/copy-blocks.js';
import { handleDeletion } from './routes/deletion.js';
import { handleUndoCascade } from './routes/undo-cascade.js';
import { handleDateCascade as handleDateCascadeV2 } from './v2/routes/date-cascade.js';
import { handleInception as handleInceptionV2 } from './v2/routes/inception.js';
import { handleAddTaskSet as handleAddTaskSetV2 } from './v2/routes/add-task-set.js';
import { config } from './config.js';
import { createWebhookAuthMiddleware } from './middleware/webhook-auth.js';

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

  app.use('/webhook', createWebhookAuthMiddleware({ webhookSecret: config.webhookSecret }));

  // Cascade webhook endpoints (use cascade token pool)
  app.post('/webhook/date-cascade', handleDateCascade);
  app.post('/webhook/status-rollup', handleStatusRollup);

  // Provisioning webhook endpoints (use provision token pool)
  app.post('/webhook/inception', handleInception);
  app.post('/webhook/add-task-set', handleAddTaskSet);
  app.post('/webhook/copy-blocks', handleCopyBlocks);

  // Undo cascade (uses cascade token pool)
  app.post('/webhook/undo-cascade', handleUndoCascade);

  // Deletion webhook endpoint (use deletion token pool)
  app.post('/webhook/deletion', handleDeletion);

  // V2 endpoints (parent-level-only, top-down subtask fan-out)
  app.post('/webhook/v2/date-cascade', handleDateCascadeV2);
  app.post('/webhook/v2/inception', handleInceptionV2);
  app.post('/webhook/v2/add-task-set', handleAddTaskSetV2);

  return app;
}
