import crypto from 'crypto';

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || null;

function safeEqual(actual, expected) {
  const a = Buffer.from(actual || '', 'utf8');
  const b = Buffer.from(expected || '', 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function webhookAuth(req, res, next) {
  if (!WEBHOOK_SECRET) return next();
  if (safeEqual(req.headers['x-webhook-secret'], WEBHOOK_SECRET)) return next();
  res.status(401).json({ error: 'Unauthorized' });
}
