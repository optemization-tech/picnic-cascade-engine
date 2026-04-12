import crypto from 'node:crypto';

function safeEqual(actual, expected) {
  const a = Buffer.from(actual || '', 'utf8');
  const b = Buffer.from(expected || '', 'utf8');
  const maxLen = Math.max(a.length, b.length);
  const pa = Buffer.alloc(maxLen);
  const pb = Buffer.alloc(maxLen);
  a.copy(pa);
  b.copy(pb);
  return a.length === b.length && crypto.timingSafeEqual(pa, pb);
}

export function webhookAuth(req, res, next) {
  const secret = process.env.WEBHOOK_SECRET || null;
  if (!secret) return next();
  if (safeEqual(req.headers['x-webhook-secret'], secret)) return next();
  res.status(401).json({ error: 'Unauthorized' });
}
