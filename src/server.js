import express from 'express';
import { handleDateCascade } from './routes/date-cascade.js';
import { handleStatusRollup } from './routes/status-rollup.js';

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

  // Webhook endpoints
  app.post('/webhook/date-cascade', handleDateCascade);
  app.post('/webhook/status-rollup', handleStatusRollup);

  return app;
}
